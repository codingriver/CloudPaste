import { ValidationError } from "../../../../http/errors.js";
const DEFAULT_BATCH_OBJECT_LIMIT = 10;
const MAX_BATCH_OBJECT_LIMIT = 100;
const WORKERS_COPY_PHASE_SAFE_OBJECT_LIMIT = 20;
function isDirectoryPathHint(path) {
  return typeof path === "string" && path.endsWith("/");
}
function clampChunkSize(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_BATCH_OBJECT_LIMIT;
  return Math.min(Math.max(Math.floor(numeric), 1), MAX_BATCH_OBJECT_LIMIT);
}
function getEffectiveCopyPhaseChunkSize(configuredSize, activeDirectory) {
  const configured = Math.max(1, Math.floor(Number(configuredSize) || DEFAULT_BATCH_OBJECT_LIMIT));
  const limitHits = Math.max(0, Math.floor(Number(activeDirectory?.invocationLimitReachedCount || 0)));
  let effective = Math.min(configured, WORKERS_COPY_PHASE_SAFE_OBJECT_LIMIT);
  for (let i = 0; i < limitHits; i += 1) {
    effective = Math.max(1, Math.floor(effective / 2));
  }
  return Math.max(1, effective);
}
function ensureItemResults(payload, stats) {
  const current = Array.isArray(stats.itemResults) ? stats.itemResults : [];
  return payload.items.map((item, index) => ({
    kind: "move",
    sourcePath: item.sourcePath,
    targetPath: item.targetPath,
    isDirectory: current[index]?.isDirectory ?? item.isDirectory ?? isDirectoryPathHint(item.sourcePath) ?? isDirectoryPathHint(item.targetPath),
    status: current[index]?.status || "pending",
    error: current[index]?.error,
    message: current[index]?.message,
    meta: current[index]?.meta
  }));
}
function appendLimited(existing, next, limit = 20) {
  return [...Array.isArray(existing) ? existing : [], ...Array.isArray(next) ? next : []].slice(0, limit);
}
function buildOperationProgress(active, chunkSize, currentIndex, phase) {
  const processedObjects = Number(active.processed || 0);
  const batchSize = Math.max(1, Number(chunkSize || 1));
  return {
    mode: "directory_move",
    phase,
    currentItemIndex: currentIndex,
    totalObjects: Math.max(Number(active.totalObjects || 0), processedObjects),
    processedObjects,
    successObjects: Number(active.success || 0) + Number(active.deduped || 0),
    failedObjects: Number(active.failed || 0),
    skippedObjects: Number(active.skipped || 0),
    dedupedObjects: Number(active.deduped || 0),
    batchSize,
    currentBatch: processedObjects > 0 ? Math.ceil(processedObjects / batchSize) : 1,
    lastCompletedKey: active.lastCompletedKey || null,
    invocationLimitReachedCount: Number(active.invocationLimitReachedCount || 0)
  };
}
async function resolveChunkSize(fileSystem, payload) {
  if (payload.options?.maxDirectoryMoveObjects !== void 0) {
    return clampChunkSize(payload.options.maxDirectoryMoveObjects);
  }
  const db = fileSystem?.mountManager?.db;
  if (db && typeof db.prepare === "function") {
    for (const key of ["batch_operation_chunk_size", "copy_directory_chunk_size"]) {
      try {
        const row = await db.prepare("SELECT value FROM system_settings WHERE key = ?").bind(key).first();
        if (row?.value !== void 0 && row?.value !== null) return clampChunkSize(row.value);
      } catch (error) {
        console.warn(`[MoveTaskHandler] \u8BFB\u53D6 ${key} \u8BBE\u7F6E\u5931\u8D25\uFF0C\u7EE7\u7EED\u4F7F\u7528\u9ED8\u8BA4\u503C`, error);
      }
    }
  }
  return DEFAULT_BATCH_OBJECT_LIMIT;
}
function sameMountAndDriver(sourceCtx, targetCtx) {
  return sourceCtx?.mount?.id === targetCtx?.mount?.id && sourceCtx?.driver?.getType?.() === targetCtx?.driver?.getType?.();
}
function normalizeForParent(path) {
  const normalized = String(path || "").replace(/\/+/g, "/");
  if (!normalized || normalized === "/") return "/";
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}
function parentPathOf(path) {
  const normalized = normalizeForParent(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}
function sameDirectory(sourcePath, targetPath) {
  return parentPathOf(sourcePath) === parentPathOf(targetPath);
}
class MoveTaskHandler {
  taskType = "move";
  async validate(payload) {
    if (!payload?.items || !Array.isArray(payload.items)) {
      throw new ValidationError("items \u5FC5\u987B\u662F\u6570\u7EC4");
    }
    if (payload.items.length === 0) {
      throw new ValidationError("items \u4E0D\u80FD\u4E3A\u7A7A");
    }
    for (let i = 0; i < payload.items.length; i += 1) {
      const item = payload.items[i];
      if (!item?.sourcePath || typeof item.sourcePath !== "string") {
        throw new ValidationError(`items[${i}].sourcePath \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
      }
      if (!item?.targetPath || typeof item.targetPath !== "string") {
        throw new ValidationError(`items[${i}].targetPath \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
      }
    }
  }
  async executeChunk(job, context) {
    const payload = job.payload;
    const fileSystem = context.getFileSystem();
    const chunkSize = await resolveChunkSize(fileSystem, payload);
    const currentStats = context.getStats ? await context.getStats(job.jobId) : job.stats;
    const itemResults = ensureItemResults(payload, currentStats);
    const checkpoint = currentStats.moveCheckpoint || {};
    if (!checkpoint.initialized) {
      await context.updateProgress(job.jobId, {
        totalItems: Math.max(Number(currentStats.totalItems || 0), payload.items.length),
        itemResults,
        moveCheckpoint: { currentIndex: 0, phase: "copy", startAfter: null, activeDirectory: null, initialized: true }
      });
      return { done: false, message: "move checkpoint initialized" };
    }
    let currentIndex = Number(checkpoint.currentIndex || 0);
    while (currentIndex < payload.items.length && ["success", "failed", "skipped"].includes(itemResults[currentIndex]?.status || "")) {
      currentIndex += 1;
    }
    if (currentIndex >= payload.items.length || await context.isCancelled(job.jobId)) {
      return { done: true, message: "move completed" };
    }
    const item = payload.items[currentIndex];
    const phase = checkpoint.phase || "copy";
    const baseSuccess = Number(currentStats.successCount || 0);
    const baseFailed = Number(currentStats.failedCount || 0);
    const baseSkipped = Number(currentStats.skippedCount || 0);
    const baseProcessed = Number(currentStats.processedItems || 0);
    itemResults[currentIndex].status = "processing";
    try {
      const sourceCtx = await fileSystem.mountManager.getDriverByPath(item.sourcePath, job.userId, job.userType);
      const targetCtx = await fileSystem.mountManager.getDriverByPath(item.targetPath, job.userId, job.userType);
      const canChunkDirectory = isDirectoryPathHint(item.sourcePath) && isDirectoryPathHint(item.targetPath) && sameMountAndDriver(sourceCtx, targetCtx) && typeof sourceCtx?.driver?.copyDirectoryChunk === "function" && typeof sourceCtx?.driver?.deleteDirectoryChunk === "function";
      if (canChunkDirectory) {
        const activeDirectory = checkpoint.activeDirectory || {
          phase,
          success: 0,
          failed: 0,
          skipped: 0,
          deduped: 0,
          processed: 0,
          failedItems: [],
          invocationLimitReachedCount: 0,
          lastCompletedKey: null
        };
        if (phase === "copy") {
          const effectiveCopyChunkSize = getEffectiveCopyPhaseChunkSize(chunkSize, activeDirectory);
          const chunkResult2 = await sourceCtx.driver.copyDirectoryChunk(sourceCtx.subPath, targetCtx.subPath, {
            mount: sourceCtx.mount,
            sourceSubPath: sourceCtx.subPath,
            targetSubPath: targetCtx.subPath,
            sourcePath: item.sourcePath,
            targetPath: item.targetPath,
            db: fileSystem.mountManager?.db,
            userIdOrInfo: job.userId,
            userType: job.userType,
            skipExisting: payload.options?.skipExisting === true,
            startAfter: checkpoint.startAfter || null,
            maxObjects: effectiveCopyChunkSize,
            resumeMode: true
          });
          const nextDirectory2 = {
            ...activeDirectory,
            phase: "copy",
            success: Number(activeDirectory.success || 0) + Number(chunkResult2?.success || 0),
            failed: Number(activeDirectory.failed || 0) + Number(chunkResult2?.failed || 0),
            skipped: Number(activeDirectory.skipped || 0) + Number(chunkResult2?.skipped || 0),
            deduped: Number(activeDirectory.deduped || 0) + Number(chunkResult2?.deduped || 0),
            processed: Number(activeDirectory.processed || 0) + Number(chunkResult2?.processed || 0),
            totalObjects: Math.max(
              Number(activeDirectory.totalObjects || 0),
              Number(activeDirectory.processed || 0) + Number(chunkResult2?.processed || 0) + (chunkResult2?.done ? 0 : effectiveCopyChunkSize)
            ),
            failedItems: appendLimited(activeDirectory.failedItems, chunkResult2?.failedItems),
            invocationLimitReachedCount: Number(activeDirectory.invocationLimitReachedCount || 0) + (chunkResult2?.invocationLimitReached === true ? 1 : 0),
            lastCompletedKey: chunkResult2?.lastCompletedKey || activeDirectory.lastCompletedKey || null,
            batchSize: effectiveCopyChunkSize
          };
          itemResults[currentIndex].message = chunkResult2?.done ? `\u79FB\u52A8\u590D\u5236\u9636\u6BB5\u5B8C\u6210\uFF1A\u6210\u529F ${nextDirectory2.success}\uFF0C\u5931\u8D25 ${nextDirectory2.failed}` : `\u79FB\u52A8\u590D\u5236\u9636\u6BB5\u8FDB\u884C\u4E2D\uFF1A\u6210\u529F ${nextDirectory2.success}\uFF0C\u5931\u8D25 ${nextDirectory2.failed}`;
          itemResults[currentIndex].meta = { ...itemResults[currentIndex].meta || {}, moveDetails: nextDirectory2 };
          if (chunkResult2?.done) {
            if (nextDirectory2.failed > 0) {
              itemResults[currentIndex].status = "failed";
              itemResults[currentIndex].error = `\u79FB\u52A8\u590D\u5236\u9636\u6BB5\u5B58\u5728 ${nextDirectory2.failed} \u4E2A\u5931\u8D25\u9879\uFF0C\u5DF2\u505C\u6B62\u5220\u9664\u6E90\u76EE\u5F55`;
              await context.updateProgress(job.jobId, {
                processedItems: baseProcessed + 1,
                successCount: baseSuccess,
                failedCount: baseFailed + nextDirectory2.failed,
                skippedCount: baseSkipped,
                itemResults,
                operationProgress: { ...buildOperationProgress(nextDirectory2, effectiveCopyChunkSize, currentIndex, "copy"), totalObjects: nextDirectory2.processed },
                moveCheckpoint: { currentIndex: currentIndex + 1, phase: "copy", startAfter: null, activeDirectory: null, initialized: true }
              });
              return { done: currentIndex + 1 >= payload.items.length, message: "move copy phase failed" };
            }
            await context.updateProgress(job.jobId, {
              operationProgress: { ...buildOperationProgress(nextDirectory2, effectiveCopyChunkSize, currentIndex, "copy"), totalObjects: nextDirectory2.processed },
              itemResults,
              moveCheckpoint: { currentIndex, phase: "delete", startAfter: null, activeDirectory: null, initialized: true }
            });
            return { done: false, message: "move entering delete phase" };
          }
          await context.updateProgress(job.jobId, {
            totalItems: Math.max(Number(currentStats.totalItems || payload.items.length), payload.items.length),
            successCount: baseSuccess + Number(chunkResult2?.success || 0) + Number(chunkResult2?.deduped || 0),
            failedCount: baseFailed + Number(chunkResult2?.failed || 0),
            skippedCount: baseSkipped + Number(chunkResult2?.skipped || 0),
            itemResults,
            operationProgress: buildOperationProgress(nextDirectory2, effectiveCopyChunkSize, currentIndex, "copy"),
            moveCheckpoint: {
              currentIndex,
              phase: "copy",
              startAfter: chunkResult2?.lastCompletedKey || chunkResult2?.nextStartAfter || checkpoint.startAfter || null,
              activeDirectory: nextDirectory2,
              initialized: true
            }
          });
          return { done: false, message: "move copy chunk", invocationLimitReached: chunkResult2?.invocationLimitReached === true };
        }
        const deleteActive = checkpoint.activeDirectory || {
          phase: "delete",
          success: 0,
          failed: 0,
          skipped: 0,
          processed: 0,
          failedItems: [],
          invocationLimitReachedCount: 0,
          lastCompletedKey: null
        };
        const chunkResult = await sourceCtx.driver.deleteDirectoryChunk(sourceCtx.subPath, {
          mount: sourceCtx.mount,
          subPath: sourceCtx.subPath,
          path: item.sourcePath,
          db: fileSystem.mountManager?.db,
          userIdOrInfo: job.userId,
          userType: job.userType,
          startAfter: checkpoint.startAfter || null,
          maxObjects: chunkSize
        });
        const nextDirectory = {
          ...deleteActive,
          phase: "delete",
          success: Number(deleteActive.success || 0) + Number(chunkResult?.success || 0),
          failed: Number(deleteActive.failed || 0) + Number(chunkResult?.failed || 0),
          skipped: Number(deleteActive.skipped || 0) + Number(chunkResult?.skipped || 0),
          processed: Number(deleteActive.processed || 0) + Number(chunkResult?.processed || 0),
          totalObjects: Math.max(
            Number(deleteActive.totalObjects || 0),
            Number(deleteActive.processed || 0) + Number(chunkResult?.processed || 0) + (chunkResult?.done ? 0 : chunkSize)
          ),
          failedItems: appendLimited(deleteActive.failedItems, chunkResult?.failedItems),
          invocationLimitReachedCount: Number(deleteActive.invocationLimitReachedCount || 0) + (chunkResult?.invocationLimitReached === true ? 1 : 0),
          lastCompletedKey: chunkResult?.lastCompletedKey || deleteActive.lastCompletedKey || null,
          batchSize: chunkSize
        };
        itemResults[currentIndex].message = chunkResult?.done ? `\u79FB\u52A8\u5220\u9664\u6E90\u9636\u6BB5\u5B8C\u6210\uFF1A\u6210\u529F ${nextDirectory.success}\uFF0C\u5931\u8D25 ${nextDirectory.failed}` : `\u79FB\u52A8\u5220\u9664\u6E90\u9636\u6BB5\u8FDB\u884C\u4E2D\uFF1A\u6210\u529F ${nextDirectory.success}\uFF0C\u5931\u8D25 ${nextDirectory.failed}`;
        itemResults[currentIndex].meta = { ...itemResults[currentIndex].meta || {}, moveDeleteDetails: nextDirectory };
        if (chunkResult?.done) {
          const itemFailed = nextDirectory.failed > 0;
          itemResults[currentIndex].status = itemFailed ? "failed" : "success";
          if (itemFailed) itemResults[currentIndex].error = `\u79FB\u52A8\u5220\u9664\u6E90\u9636\u6BB5\u5B58\u5728 ${nextDirectory.failed} \u4E2A\u5931\u8D25\u9879`;
          try {
            fileSystem.emitCacheInvalidation?.({ mount: sourceCtx.mount, paths: [item.sourcePath, item.targetPath], reason: "rename" });
          } catch (error) {
            console.warn("[MoveTaskHandler] \u76EE\u5F55\u7F13\u5B58\u5931\u6548\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF09", error);
          }
          await context.updateProgress(job.jobId, {
            processedItems: baseProcessed + 1,
            successCount: baseSuccess + (itemFailed ? 0 : 1),
            failedCount: baseFailed + (itemFailed ? nextDirectory.failed : 0),
            skippedCount: baseSkipped,
            itemResults,
            operationProgress: { ...buildOperationProgress(nextDirectory, chunkSize, currentIndex, "delete"), totalObjects: nextDirectory.processed },
            moveCheckpoint: { currentIndex: currentIndex + 1, phase: "copy", startAfter: null, activeDirectory: null, initialized: true }
          });
          return { done: currentIndex + 1 >= payload.items.length, message: "directory moved" };
        }
        await context.updateProgress(job.jobId, {
          itemResults,
          operationProgress: buildOperationProgress(nextDirectory, chunkSize, currentIndex, "delete"),
          moveCheckpoint: {
            currentIndex,
            phase: "delete",
            startAfter: chunkResult?.lastCompletedKey || chunkResult?.nextStartAfter || checkpoint.startAfter || null,
            activeDirectory: nextDirectory,
            initialized: true
          }
        });
        return { done: false, message: "move delete chunk", invocationLimitReached: chunkResult?.invocationLimitReached === true };
      }
      if (sameDirectory(item.sourcePath, item.targetPath)) {
        await fileSystem.renameItem(item.sourcePath, item.targetPath, job.userId, job.userType);
      } else {
        const copyResult = await fileSystem.copyItem(item.sourcePath, item.targetPath, job.userId, job.userType, {
          skipExisting: payload.options?.skipExisting === true
        });
        if (copyResult?.status === "skipped") {
          itemResults[currentIndex].status = "skipped";
          itemResults[currentIndex].message = copyResult?.reason || copyResult?.message || "\u76EE\u6807\u5DF2\u5B58\u5728\uFF0C\u5DF2\u8DF3\u8FC7";
          await context.updateProgress(job.jobId, {
            processedItems: baseProcessed + 1,
            successCount: baseSuccess,
            failedCount: baseFailed,
            skippedCount: baseSkipped + 1,
            itemResults,
            moveCheckpoint: { currentIndex: currentIndex + 1, phase: "copy", startAfter: null, activeDirectory: null, initialized: true }
          });
          return { done: currentIndex + 1 >= payload.items.length, message: "item skipped" };
        }
        if (copyResult?.status === "failed") {
          throw new Error(copyResult?.message || "\u79FB\u52A8\u590D\u5236\u9636\u6BB5\u5931\u8D25");
        }
        const deleteResult = await fileSystem.batchRemoveItems([item.sourcePath], job.userId, job.userType);
        if (Number(deleteResult?.success || 0) < 1) {
          const failed = Array.isArray(deleteResult?.failed) ? deleteResult.failed[0] : null;
          throw new Error(failed?.error || failed?.message || "\u79FB\u52A8\u5220\u9664\u6E90\u6587\u4EF6\u5931\u8D25");
        }
      }
      itemResults[currentIndex].status = "success";
      itemResults[currentIndex].message = "\u79FB\u52A8\u6210\u529F";
      await context.updateProgress(job.jobId, {
        processedItems: baseProcessed + 1,
        successCount: baseSuccess + 1,
        failedCount: baseFailed,
        skippedCount: baseSkipped,
        itemResults,
        moveCheckpoint: { currentIndex: currentIndex + 1, phase: "copy", startAfter: null, activeDirectory: null, initialized: true }
      });
      return { done: currentIndex + 1 >= payload.items.length, message: "item moved" };
    } catch (error) {
      itemResults[currentIndex].status = "failed";
      itemResults[currentIndex].error = `${error?.message || String(error || "\u79FB\u52A8\u5931\u8D25")} [\u4E0D\u53EF\u91CD\u8BD5\u9519\u8BEF]`;
      await context.updateProgress(job.jobId, {
        processedItems: baseProcessed + 1,
        successCount: baseSuccess,
        failedCount: baseFailed + 1,
        skippedCount: baseSkipped,
        itemResults,
        moveCheckpoint: { currentIndex: currentIndex + 1, phase: "copy", startAfter: null, activeDirectory: null, initialized: true }
      });
      return { done: currentIndex + 1 >= payload.items.length, message: "item failed" };
    }
  }
  async execute(job, context) {
    for (; ; ) {
      const result = await this.executeChunk(job, context);
      if (result.done) break;
    }
  }
  createStatsTemplate(payload) {
    const movePayload = payload;
    return {
      totalItems: movePayload.items.length,
      processedItems: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      itemResults: movePayload.items.map((item) => ({
        kind: "move",
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
        isDirectory: item.isDirectory ?? isDirectoryPathHint(item.sourcePath) ?? isDirectoryPathHint(item.targetPath),
        status: "pending"
      }))
    };
  }
}
export {
  MoveTaskHandler
};

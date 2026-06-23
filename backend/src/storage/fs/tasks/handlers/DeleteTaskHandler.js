import { ValidationError } from "../../../../http/errors.js";
const DEFAULT_DELETE_OBJECT_LIMIT = 1e3;
const MAX_DELETE_OBJECT_LIMIT = 1e3;
function isDirectoryPathHint(path) {
  return typeof path === "string" && path.endsWith("/");
}
function clampChunkSize(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_DELETE_OBJECT_LIMIT;
  }
  return Math.min(Math.max(Math.floor(numeric), 1), MAX_DELETE_OBJECT_LIMIT);
}
function ensureItemResults(payload, stats) {
  const current = Array.isArray(stats.itemResults) ? stats.itemResults : [];
  return payload.paths.map((path, index) => ({
    kind: "delete",
    label: path,
    sourcePath: path,
    isDirectory: current[index]?.isDirectory ?? isDirectoryPathHint(path),
    status: current[index]?.status || "pending",
    error: current[index]?.error,
    message: current[index]?.message,
    meta: current[index]?.meta
  }));
}
function appendLimited(existing, next, limit = 20) {
  return [...Array.isArray(existing) ? existing : [], ...Array.isArray(next) ? next : []].slice(0, limit);
}
function buildOperationProgress(active, chunkSize, currentIndex, mode = "directory_delete") {
  const processedObjects = Number(active.processed || 0);
  const batchSize = Math.max(1, Number(chunkSize || 1));
  return {
    mode,
    currentItemIndex: currentIndex,
    totalObjects: Math.max(Number(active.totalObjects || 0), processedObjects),
    processedObjects,
    successObjects: Number(active.success || 0),
    failedObjects: Number(active.failed || 0),
    skippedObjects: Number(active.skipped || 0),
    batchSize,
    currentBatch: processedObjects > 0 ? Math.ceil(processedObjects / batchSize) : 1,
    lastCompletedKey: active.lastCompletedKey || null,
    invocationLimitReachedCount: Number(active.invocationLimitReachedCount || 0)
  };
}
async function resolveChunkSize(fileSystem, payload) {
  if (payload.options?.maxDirectoryDeleteObjects !== void 0) {
    return clampChunkSize(payload.options.maxDirectoryDeleteObjects);
  }
  const db = fileSystem?.mountManager?.db;
  if (db && typeof db.prepare === "function") {
    try {
      const row = await db.prepare("SELECT value FROM system_settings WHERE key = ?").bind("delete_directory_chunk_size").first();
      if (row?.value !== void 0 && row?.value !== null) {
        return clampChunkSize(row.value);
      }
    } catch (error) {
      console.warn("[DeleteTaskHandler] \u8BFB\u53D6 delete_directory_chunk_size \u8BBE\u7F6E\u5931\u8D25\uFF0C\u4F7F\u7528\u9ED8\u8BA4\u503C", error);
    }
  }
  return DEFAULT_DELETE_OBJECT_LIMIT;
}
class DeleteTaskHandler {
  taskType = "delete";
  async validate(payload) {
    if (!payload?.paths || !Array.isArray(payload.paths)) {
      throw new ValidationError("paths \u5FC5\u987B\u662F\u6570\u7EC4");
    }
    if (payload.paths.length === 0) {
      throw new ValidationError("paths \u4E0D\u80FD\u4E3A\u7A7A");
    }
    for (let i = 0; i < payload.paths.length; i += 1) {
      if (!payload.paths[i] || typeof payload.paths[i] !== "string") {
        throw new ValidationError(`paths[${i}] \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
      }
    }
  }
  async executeChunk(job, context) {
    const payload = job.payload;
    const fileSystem = context.getFileSystem();
    const chunkSize = await resolveChunkSize(fileSystem, payload);
    const currentStats = context.getStats ? await context.getStats(job.jobId) : job.stats;
    const itemResults = ensureItemResults(payload, currentStats);
    const checkpoint = currentStats.deleteCheckpoint || {};
    if (!checkpoint.initialized) {
      await context.updateProgress(job.jobId, {
        totalItems: Math.max(Number(currentStats.totalItems || 0), payload.paths.length),
        itemResults,
        deleteCheckpoint: { currentIndex: 0, startAfter: null, activeDirectory: null, initialized: true }
      });
      return { done: false, message: "delete checkpoint initialized" };
    }
    let currentIndex = Number(checkpoint.currentIndex || 0);
    while (currentIndex < payload.paths.length && ["success", "failed", "skipped"].includes(itemResults[currentIndex]?.status || "")) {
      currentIndex += 1;
    }
    if (currentIndex >= payload.paths.length || await context.isCancelled(job.jobId)) {
      return { done: true, message: "delete completed" };
    }
    const path = payload.paths[currentIndex];
    const baseSuccess = Number(currentStats.successCount || 0);
    const baseFailed = Number(currentStats.failedCount || 0);
    const baseSkipped = Number(currentStats.skippedCount || 0);
    const baseProcessed = Number(currentStats.processedItems || 0);
    itemResults[currentIndex].status = "processing";
    try {
      const pathCtx = await fileSystem.mountManager.getDriverByPath(path, job.userId, job.userType);
      const canChunkDirectory = isDirectoryPathHint(path) && typeof pathCtx?.driver?.deleteDirectoryChunk === "function";
      if (canChunkDirectory) {
        const activeDirectory = checkpoint.activeDirectory || {
          success: 0,
          failed: 0,
          skipped: 0,
          processed: 0,
          failedItems: [],
          invocationLimitReachedCount: 0,
          lastCompletedKey: null,
          lastError: null
        };
        const chunkResult = await pathCtx.driver.deleteDirectoryChunk(pathCtx.subPath, {
          mount: pathCtx.mount,
          subPath: pathCtx.subPath,
          path,
          db: fileSystem.mountManager?.db,
          userIdOrInfo: job.userId,
          userType: job.userType,
          startAfter: checkpoint.startAfter || null,
          maxObjects: chunkSize
        });
        const nextDirectory = {
          success: Number(activeDirectory.success || 0) + Number(chunkResult?.success || 0),
          failed: Number(activeDirectory.failed || 0) + Number(chunkResult?.failed || 0),
          skipped: Number(activeDirectory.skipped || 0) + Number(chunkResult?.skipped || 0),
          processed: Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0),
          totalObjects: Math.max(
            Number(activeDirectory.totalObjects || 0),
            Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0) + (chunkResult?.done ? 0 : chunkSize)
          ),
          failedItems: appendLimited(activeDirectory.failedItems, chunkResult?.failedItems),
          invocationLimitReachedCount: Number(activeDirectory.invocationLimitReachedCount || 0) + (chunkResult?.invocationLimitReached === true ? 1 : 0),
          lastCompletedKey: chunkResult?.lastCompletedKey || activeDirectory.lastCompletedKey || null,
          lastError: chunkResult?.lastError || activeDirectory.lastError || null,
          batchSize: chunkSize,
          currentBatch: Math.max(1, Math.ceil((Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0)) / Math.max(1, chunkSize)))
        };
        itemResults[currentIndex].message = chunkResult?.done ? `\u76EE\u5F55\u5220\u9664\u5B8C\u6210\uFF1A\u6210\u529F ${nextDirectory.success}\uFF0C\u5931\u8D25 ${nextDirectory.failed}\uFF0C\u8DF3\u8FC7 ${nextDirectory.skipped}` : `\u76EE\u5F55\u5220\u9664\u8FDB\u884C\u4E2D\uFF1A\u6210\u529F ${nextDirectory.success}\uFF0C\u5931\u8D25 ${nextDirectory.failed}\uFF0C\u8DF3\u8FC7 ${nextDirectory.skipped}`;
        itemResults[currentIndex].meta = {
          ...itemResults[currentIndex].meta || {},
          deleteDetails: nextDirectory
        };
        const operationProgress = buildOperationProgress(nextDirectory, chunkSize, currentIndex);
        const nextTotalItems = Math.max(Number(currentStats.totalItems || payload.paths.length), payload.paths.length);
        if (chunkResult?.done) {
          const itemFailed = nextDirectory.failed > 0;
          itemResults[currentIndex].status = itemFailed ? "failed" : chunkResult?.skippedRoot ? "skipped" : "success";
          if (itemFailed) {
            itemResults[currentIndex].error = `\u76EE\u5F55\u5220\u9664\u5B58\u5728 ${nextDirectory.failed} \u4E2A\u5931\u8D25\u9879`;
          }
          try {
            fileSystem.emitCacheInvalidation?.({ mount: pathCtx.mount, paths: [path], reason: "batch-remove" });
          } catch (error) {
            console.warn("[DeleteTaskHandler] \u76EE\u5F55\u7F13\u5B58\u5931\u6548\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF09", error);
          }
          await context.updateProgress(job.jobId, {
            totalItems: nextTotalItems,
            processedItems: baseProcessed + 1,
            successCount: baseSuccess + Number(chunkResult?.success || 0),
            failedCount: baseFailed + Number(chunkResult?.failed || 0),
            skippedCount: baseSkipped + Number(chunkResult?.skipped || 0),
            operationProgress: { ...operationProgress, totalObjects: nextDirectory.processed },
            itemResults,
            deleteCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true }
          });
          return { done: currentIndex + 1 >= payload.paths.length, message: "directory item deleted" };
        }
        await context.updateProgress(job.jobId, {
          totalItems: nextTotalItems,
          processedItems: baseProcessed,
          successCount: baseSuccess + Number(chunkResult?.success || 0),
          failedCount: baseFailed + Number(chunkResult?.failed || 0),
          skippedCount: baseSkipped + Number(chunkResult?.skipped || 0),
          operationProgress,
          itemResults,
          deleteCheckpoint: {
            currentIndex,
            startAfter: chunkResult?.lastCompletedKey || chunkResult?.nextStartAfter || checkpoint.startAfter || null,
            activeDirectory: nextDirectory,
            initialized: true
          }
        });
        return {
          done: false,
          message: "directory chunk deleted",
          invocationLimitReached: chunkResult?.invocationLimitReached === true
        };
      }
      const result = await fileSystem.batchRemoveItems([path], job.userId, job.userType);
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      if (failed.length > 0) {
        itemResults[currentIndex].status = "failed";
        itemResults[currentIndex].error = failed[0]?.error || "\u5220\u9664\u5931\u8D25";
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + 1,
          successCount: baseSuccess,
          failedCount: baseFailed + 1,
          skippedCount: baseSkipped,
          itemResults,
          deleteCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true }
        });
      } else {
        itemResults[currentIndex].status = "success";
        itemResults[currentIndex].message = "\u5220\u9664\u6210\u529F";
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + 1,
          successCount: baseSuccess + 1,
          failedCount: baseFailed,
          skippedCount: baseSkipped,
          itemResults,
          deleteCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true }
        });
      }
      return { done: currentIndex + 1 >= payload.paths.length, message: "item deleted" };
    } catch (error) {
      itemResults[currentIndex].status = "failed";
      itemResults[currentIndex].error = `${error?.message || String(error || "\u5220\u9664\u5931\u8D25")} [\u4E0D\u53EF\u91CD\u8BD5\u9519\u8BEF]`;
      await context.updateProgress(job.jobId, {
        processedItems: baseProcessed + 1,
        successCount: baseSuccess,
        failedCount: baseFailed + 1,
        skippedCount: baseSkipped,
        itemResults,
        deleteCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true }
      });
      return { done: currentIndex + 1 >= payload.paths.length, message: "item failed" };
    }
  }
  async execute(job, context) {
    for (; ; ) {
      const result = await this.executeChunk(job, context);
      if (result.done) break;
    }
  }
  createStatsTemplate(payload) {
    const deletePayload = payload;
    return {
      totalItems: deletePayload.paths.length,
      processedItems: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      itemResults: deletePayload.paths.map((path) => ({
        kind: "delete",
        label: path,
        sourcePath: path,
        isDirectory: isDirectoryPathHint(path),
        status: "pending"
      }))
    };
  }
}
export {
  DeleteTaskHandler
};

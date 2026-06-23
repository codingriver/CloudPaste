import { ValidationError } from "../../../../http/errors.js";
import { invalidateFsCache } from "../../../../cache/invalidation.js";
import { FsSearchIndexStore } from "../../search/FsSearchIndexStore.js";
import { isRetryableError, calculateBackoffDelay, sleep, formatRetryLog, DEFAULT_RETRY_POLICY } from "../utils/retryUtils.js";
const MAX_PROGRESS_UPDATES_PER_ITEM = 5;
const DEFAULT_PROGRESS_BYTES_STEP = 5 * 1024 * 1024;
const DOCKER_PROGRESS_INTERVAL_MS = 500;
const PRESCAN_CONCURRENCY_WORKERS = 6;
const PRESCAN_CONCURRENCY_DOCKER = 10;
const WORKERS_DIRECTORY_COPY_OBJECT_LIMIT = 10;
const MAX_WORKERS_DIRECTORY_COPY_OBJECT_LIMIT = 100;
const MAX_WORKERS_CROSS_MOUNT_DIRECTORY_COPY_OBJECT_LIMIT = 15;
function isDirectoryPathHint(path) {
  return typeof path === "string" && path.endsWith("/");
}
function ensureCopyItemResults(payload, stats) {
  const current = Array.isArray(stats.itemResults) ? stats.itemResults : [];
  return payload.items.map((item, index) => ({
    sourcePath: item.sourcePath,
    targetPath: item.targetPath,
    isDirectory: current[index]?.isDirectory ?? item.isDirectory ?? isDirectoryPathHint(item.sourcePath) ?? isDirectoryPathHint(item.targetPath),
    status: current[index]?.status || "pending",
    fileSize: current[index]?.fileSize || 0,
    bytesTransferred: current[index]?.bytesTransferred || 0,
    retryCount: current[index]?.retryCount,
    error: current[index]?.error,
    message: current[index]?.message,
    meta: current[index]?.meta
  }));
}
function appendLimitedFailedItems(existing, next, limit = 20) {
  return [...Array.isArray(existing) ? existing : [], ...Array.isArray(next) ? next : []].slice(0, limit);
}
function summarizeTaskError(error) {
  const message = error?.message || String(error || "\u672A\u77E5\u9519\u8BEF");
  const cause = error?.details?.cause || error?.cause?.message || error?.cause || void 0;
  const stack = typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 2).join(" | ") : void 0;
  return {
    message,
    cause: cause ? String(cause) : void 0,
    stack
  };
}
function clampDirectoryCopyChunkSize(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return WORKERS_DIRECTORY_COPY_OBJECT_LIMIT;
  }
  return Math.min(Math.max(Math.floor(numeric), 1), MAX_WORKERS_DIRECTORY_COPY_OBJECT_LIMIT);
}
function getEffectiveDirectoryCopyChunkSize(configuredSize, activeDirectory) {
  const configured = Math.max(1, Math.floor(Number(configuredSize) || WORKERS_DIRECTORY_COPY_OBJECT_LIMIT));
  const limitHits = Math.max(0, Math.floor(Number(activeDirectory?.invocationLimitReachedCount || 0)));
  let effective = configured;
  for (let i = 0; i < limitHits; i += 1) {
    effective = Math.max(1, Math.floor(effective / 2));
  }
  return Math.max(1, effective);
}
function getEffectiveCrossMountDirectoryCopyChunkSize(configuredSize, activeDirectory) {
  const configured = Math.min(
    Math.max(1, Math.floor(Number(configuredSize) || WORKERS_DIRECTORY_COPY_OBJECT_LIMIT)),
    MAX_WORKERS_CROSS_MOUNT_DIRECTORY_COPY_OBJECT_LIMIT
  );
  const limitHits = Math.max(0, Math.floor(Number(activeDirectory?.invocationLimitReachedCount || 0)));
  let effective = configured;
  for (let i = 0; i < limitHits; i += 1) {
    effective = Math.max(1, Math.floor(effective / 2));
  }
  return Math.max(1, effective);
}
function buildDirectoryProgress(activeDirectory, chunkSize, currentIndex) {
  const processedObjects = Number(activeDirectory.processed || 0);
  const batchSize = Math.max(1, Number(chunkSize || 1));
  const currentBatch = processedObjects > 0 ? Math.ceil(processedObjects / batchSize) : 1;
  const knownTotal = Number(activeDirectory.totalObjects || activeDirectory.countedObjects || 0);
  const estimatedTotal = Math.max(knownTotal, processedObjects);
  return {
    mode: "directory_copy",
    phase: activeDirectory.phase || "copy",
    currentItemIndex: currentIndex,
    totalObjects: estimatedTotal,
    processedObjects,
    countedObjects: Number(activeDirectory.countedObjects || 0),
    successObjects: Number(activeDirectory.success || 0) + Number(activeDirectory.deduped || 0),
    failedObjects: Number(activeDirectory.failed || 0),
    skippedObjects: Number(activeDirectory.skipped || 0),
    dedupedObjects: Number(activeDirectory.deduped || 0),
    batchSize,
    currentBatch,
    lastCompletedKey: activeDirectory.lastCompletedKey || null,
    invocationLimitReachedCount: Number(activeDirectory.invocationLimitReachedCount || 0)
  };
}
function subtractActiveDirectoryStats(base, activeDirectory) {
  if (!activeDirectory || activeDirectory.mode !== "cross_mount_directory") {
    return {
      processedItems: Number(base.processedItems || 0),
      successCount: Number(base.successCount || 0),
      failedCount: Number(base.failedCount || 0),
      skippedCount: Number(base.skippedCount || 0)
    };
  }
  return {
    processedItems: Math.max(0, Number(base.processedItems || 0) - Number(activeDirectory.processed || 0)),
    successCount: Math.max(0, Number(base.successCount || 0) - Number(activeDirectory.success || 0)),
    failedCount: Math.max(0, Number(base.failedCount || 0) - Number(activeDirectory.failed || 0)),
    skippedCount: Math.max(0, Number(base.skippedCount || 0) - Number(activeDirectory.skipped || 0))
  };
}
function isInvocationLimitError(error) {
  const message = String(error?.message || error?.details?.cause || error?.cause?.message || error || "");
  return /too many subrequests|subrequest|invocation/i.test(message);
}
function getCopyResultErrorMessage(result) {
  return String(result?.message || result?.error || result?.details?.cause || result?.cause || "");
}
function normalizeDirectoryPath(path) {
  const raw = String(path || "/").replace(/\/+/g, "/");
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}
function joinDirectoryPath(base, relative) {
  const normalizedBase = normalizeDirectoryPath(base);
  const cleanRelative = String(relative || "").replace(/^\/+/, "");
  return `${normalizedBase}${cleanRelative}`.replace(/\/+/g, "/");
}
async function executeCrossMountDirectoryChunk(params) {
  const { fileSystem, item, job, userId, userType, options } = params;
  const sourceBase = normalizeDirectoryPath(item.sourcePath);
  const targetBase = normalizeDirectoryPath(item.targetPath);
  const active = params.activeDirectory?.mode === "cross_mount_directory" ? { ...params.activeDirectory } : {
    mode: "cross_mount_directory",
    sourceBase,
    targetBase,
    stack: [sourceBase],
    currentDir: null,
    entries: [],
    entryIndex: 0,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    failedItems: [],
    invocationLimitReachedCount: 0,
    lastError: null
  };
  const maxEntries = getEffectiveCrossMountDirectoryCopyChunkSize(params.configuredChunkSize, active);
  active.batchSize = maxEntries;
  let processedThisRun = 0;
  while (processedThisRun < maxEntries) {
    if (!active.currentDir) {
      const nextDir = Array.isArray(active.stack) ? active.stack.pop() : null;
      if (!nextDir) {
        return { done: true, activeDirectory: active, maxEntries };
      }
      active.currentDir = normalizeDirectoryPath(nextDir);
      active.entryIndex = 0;
      const relativeDir = active.currentDir.startsWith(sourceBase) ? active.currentDir.slice(sourceBase.length) : "";
      const targetDir = joinDirectoryPath(targetBase, relativeDir);
      try {
        await fileSystem.createDirectory(targetDir, userId, userType);
      } catch (error) {
        if (isInvocationLimitError(error)) {
          active.lastError = error?.message || String(error);
          active.invocationLimitReachedCount = Number(active.invocationLimitReachedCount || 0) + 1;
          return { done: false, activeDirectory: active, maxEntries, invocationLimitReached: true };
        }
        active.failed += 1;
        active.processed += 1;
        active.failedItems = appendLimitedFailedItems(active.failedItems, [{ source: active.currentDir, target: targetDir, message: error?.message || "\u521B\u5EFA\u76EE\u6807\u76EE\u5F55\u5931\u8D25" }]);
        active.currentDir = null;
        processedThisRun += 1;
        continue;
      }
      try {
        const dirResult = await fileSystem.listDirectory(active.currentDir, userId, userType, { refresh: true });
        active.entries = Array.isArray(dirResult?.items) ? dirResult.items : [];
      } catch (error) {
        if (isInvocationLimitError(error)) {
          active.lastError = error?.message || String(error);
          active.invocationLimitReachedCount = Number(active.invocationLimitReachedCount || 0) + 1;
          return { done: false, activeDirectory: active, maxEntries, invocationLimitReached: true };
        }
        active.failed += 1;
        active.processed += 1;
        active.failedItems = appendLimitedFailedItems(active.failedItems, [{ source: active.currentDir, target: targetDir, message: error?.message || "\u5217\u51FA\u76EE\u5F55\u5931\u8D25" }]);
        active.currentDir = null;
        active.entries = [];
        processedThisRun += 1;
        continue;
      }
    }
    const entries = Array.isArray(active.entries) ? active.entries : [];
    if (active.entryIndex >= entries.length) {
      active.currentDir = null;
      active.entries = [];
      active.entryIndex = 0;
      continue;
    }
    const entry = entries[active.entryIndex];
    if (!entry?.path) {
      active.entryIndex += 1;
      continue;
    }
    const entryPath = entry.isDirectory ? normalizeDirectoryPath(entry.path) : String(entry.path);
    if (!entryPath.startsWith(sourceBase)) {
      active.entryIndex += 1;
      continue;
    }
    const relativePath = entryPath.slice(sourceBase.length);
    const targetPath = entry.isDirectory ? joinDirectoryPath(targetBase, relativePath) : `${targetBase}${relativePath}`.replace(/\/+/g, "/");
    if (entry.isDirectory) {
      active.stack = Array.isArray(active.stack) ? active.stack : [];
      active.stack.push(entryPath);
      active.entryIndex += 1;
      continue;
    }
    try {
      const result = await fileSystem.copyItem(entryPath, targetPath, userId, userType, {
        ...options,
        maxDirectoryCopyObjects: maxEntries
      });
      if (result?.status === "skipped" || result?.skipped === true) {
        active.skipped += 1;
      } else if (result?.status === "failed") {
        const resultMessage = getCopyResultErrorMessage(result);
        if (isInvocationLimitError(resultMessage)) {
          active.lastError = resultMessage || "Worker invocation limit reached";
          active.invocationLimitReachedCount = Number(active.invocationLimitReachedCount || 0) + 1;
          return { done: false, activeDirectory: active, maxEntries, invocationLimitReached: true };
        }
        active.failed += 1;
        active.failedItems = appendLimitedFailedItems(active.failedItems, [{ source: entryPath, target: targetPath, message: resultMessage || "\u590D\u5236\u5931\u8D25" }]);
      } else {
        active.success += 1;
      }
      active.processed += 1;
      active.entryIndex += 1;
      processedThisRun += 1;
    } catch (error) {
      if (isInvocationLimitError(error)) {
        active.lastError = error?.message || error?.details?.cause || String(error);
        active.invocationLimitReachedCount = Number(active.invocationLimitReachedCount || 0) + 1;
        return { done: false, activeDirectory: active, maxEntries, invocationLimitReached: true };
      }
      active.failed += 1;
      active.processed += 1;
      active.failedItems = appendLimitedFailedItems(active.failedItems, [{ source: entryPath, target: targetPath, message: error?.details?.cause || error?.message || "\u590D\u5236\u5931\u8D25" }]);
      active.entryIndex += 1;
      processedThisRun += 1;
    }
  }
  return { done: false, activeDirectory: active, maxEntries };
}
async function resolveDirectoryCopyChunkSize(fileSystem, payload) {
  if (payload.options?.maxDirectoryCopyObjects !== void 0) {
    return clampDirectoryCopyChunkSize(payload.options.maxDirectoryCopyObjects);
  }
  const db = fileSystem?.mountManager?.db;
  if (db && typeof db.prepare === "function") {
    try {
      const row = await db.prepare("SELECT value FROM system_settings WHERE key = ?").bind("copy_directory_chunk_size").first();
      return clampDirectoryCopyChunkSize(row?.value);
    } catch (error) {
      console.warn("[CopyTaskHandler] \u8BFB\u53D6 copy_directory_chunk_size \u8BBE\u7F6E\u5931\u8D25\uFF0C\u4F7F\u7528\u9ED8\u8BA4\u503C", error);
    }
  }
  return WORKERS_DIRECTORY_COPY_OBJECT_LIMIT;
}
class CopyTaskHandler {
  taskType = "copy";
  /** 验证复制任务载荷 - items 非空数组且每项包含 sourcePath 和 targetPath */
  async validate(payload) {
    if (!payload.items || !Array.isArray(payload.items)) {
      throw new ValidationError("items \u5FC5\u987B\u662F\u6570\u7EC4");
    }
    if (payload.items.length === 0) {
      throw new ValidationError("items \u4E0D\u80FD\u4E3A\u7A7A");
    }
    for (let i = 0; i < payload.items.length; i++) {
      const item = payload.items[i];
      if (!item.sourcePath || typeof item.sourcePath !== "string") {
        throw new ValidationError(`items[${i}].sourcePath \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
      }
      if (!item.targetPath || typeof item.targetPath !== "string") {
        throw new ValidationError(`items[${i}].targetPath \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
      }
    }
  }
  async executeChunk(job, context) {
    const payload = job.payload;
    const fileSystem = context.getFileSystem();
    const directoryCopyChunkSize = await resolveDirectoryCopyChunkSize(fileSystem, payload);
    const currentStats = context.getStats ? await context.getStats(job.jobId) : job.stats;
    const itemResults = ensureCopyItemResults(payload, currentStats);
    const checkpoint = currentStats.copyCheckpoint || {};
    if (!checkpoint.initialized) {
      await context.updateProgress(job.jobId, {
        totalItems: Math.max(Number(currentStats.totalItems || 0), payload.items.length),
        itemResults,
        copyCheckpoint: {
          currentIndex: 0,
          startAfter: null,
          countContinuationToken: null,
          phase: "count",
          activeDirectory: null,
          initialized: true
        }
      });
      return { done: false, message: "copy checkpoint initialized" };
    }
    let currentIndex = Number(checkpoint.currentIndex || 0);
    while (currentIndex < payload.items.length && itemResults[currentIndex]?.status && ["success", "failed", "skipped"].includes(itemResults[currentIndex].status)) {
      currentIndex++;
    }
    if (currentIndex >= payload.items.length) {
      return { done: true, message: "copy completed" };
    }
    if (await context.isCancelled(job.jobId)) {
      return { done: true, message: "copy cancelled" };
    }
    const item = payload.items[currentIndex];
    itemResults[currentIndex].status = "processing";
    const baseSuccess = Number(currentStats.successCount || 0);
    const baseFailed = Number(currentStats.failedCount || 0);
    const baseSkipped = Number(currentStats.skippedCount || 0);
    const baseProcessed = Number(currentStats.processedItems || 0);
    try {
      const sourceCtx = await fileSystem.mountManager.getDriverByPath(item.sourcePath, job.userId, job.userType);
      const targetCtx = await fileSystem.mountManager.getDriverByPath(item.targetPath, job.userId, job.userType);
      const sameMount = sourceCtx?.mount?.id === targetCtx?.mount?.id;
      const sameDriverType = sourceCtx?.driver?.getType?.() === targetCtx?.driver?.getType?.();
      const canChunkDirectory = isDirectoryPathHint(item.sourcePath) && isDirectoryPathHint(item.targetPath) && sameMount && sameDriverType && typeof sourceCtx?.driver?.copyDirectoryChunk === "function";
      const canChunkCrossMountDirectory = isDirectoryPathHint(item.sourcePath) && isDirectoryPathHint(item.targetPath) && !sameMount;
      if (canChunkDirectory) {
        const activeDirectory = checkpoint.activeDirectory || {
          phase: "count",
          success: 0,
          failed: 0,
          skipped: 0,
          deduped: 0,
          processed: 0,
          countedObjects: 0,
          totalObjects: 0,
          failedItems: [],
          invocationLimitReachedCount: 0,
          lastCompletedKey: null,
          lastError: null
        };
        const maxObjects = getEffectiveDirectoryCopyChunkSize(directoryCopyChunkSize, activeDirectory);
        console.log(
          `[CopyTaskHandler] executeChunk directory item job=${job.jobId} index=${currentIndex} source=${item.sourcePath} target=${item.targetPath} configuredMaxObjects=${directoryCopyChunkSize} effectiveMaxObjects=${maxObjects} startAfter=${checkpoint.startAfter || "null"}`
        );
        const phase = checkpoint.phase || activeDirectory.phase || "count";
        const canCountDirectory = typeof sourceCtx?.driver?.countDirectoryChunk === "function";
        if (phase === "count" && canCountDirectory) {
          const countResult = await sourceCtx.driver.countDirectoryChunk(sourceCtx.subPath, {
            mount: sourceCtx.mount,
            subPath: sourceCtx.subPath,
            path: item.sourcePath,
            sourcePath: item.sourcePath,
            db: fileSystem.mountManager?.db,
            userIdOrInfo: job.userId,
            userType: job.userType,
            continuationToken: checkpoint.countContinuationToken || null,
            maxPages: 5
          });
          const countedObjects = Number(activeDirectory.countedObjects || 0) + Number(countResult?.count || 0);
          const nextDirectory2 = {
            ...activeDirectory,
            phase: countResult?.done ? "copy" : "count",
            countedObjects,
            totalObjects: countedObjects,
            countPages: Number(activeDirectory.countPages || 0) + Number(countResult?.pages || 0),
            invocationLimitReachedCount: Number(activeDirectory.invocationLimitReachedCount || 0) + (countResult?.invocationLimitReached === true ? 1 : 0),
            lastError: countResult?.lastError || activeDirectory.lastError || null,
            errorCause: countResult?.errorCause || activeDirectory.errorCause || null,
            batchSize: maxObjects
          };
          itemResults[currentIndex].message = countResult?.done ? `\u76EE\u5F55\u5BF9\u8C61\u7EDF\u8BA1\u5B8C\u6210\uFF1A\u5171 ${countedObjects} \u4E2A\u5BF9\u8C61` : `\u76EE\u5F55\u5BF9\u8C61\u7EDF\u8BA1\u4E2D\uFF1A\u5DF2\u7EDF\u8BA1 ${countedObjects} \u4E2A\u5BF9\u8C61`;
          itemResults[currentIndex].meta = {
            ...itemResults[currentIndex].meta || {},
            copyDetails: nextDirectory2
          };
          await context.updateProgress(job.jobId, {
            totalItems: Math.max(Number(currentStats.totalItems || payload.items.length), payload.items.length - 1 + countedObjects),
            processedItems: baseProcessed,
            directoryProgress: buildDirectoryProgress(nextDirectory2, maxObjects, currentIndex),
            itemResults,
            copyCheckpoint: {
              currentIndex,
              startAfter: null,
              countContinuationToken: countResult?.done ? null : countResult?.nextContinuationToken || checkpoint.countContinuationToken || null,
              phase: countResult?.done ? "copy" : "count",
              activeDirectory: countResult?.done ? { ...nextDirectory2, phase: "copy", processed: 0, success: 0, failed: 0, skipped: 0, deduped: 0, failedItems: [], lastCompletedKey: null } : nextDirectory2,
              initialized: true
            }
          });
          return {
            done: false,
            message: countResult?.done ? "directory count completed" : "directory count chunk",
            invocationLimitReached: countResult?.invocationLimitReached === true
          };
        }
        const chunkResult = await sourceCtx.driver.copyDirectoryChunk(sourceCtx.subPath, targetCtx.subPath, {
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
          maxObjects,
          resumeMode: true
        });
        console.log(
          `[CopyTaskHandler] executeChunk directory result job=${job.jobId} index=${currentIndex} done=${chunkResult?.done === true} success=${Number(chunkResult?.success || 0)} skipped=${Number(chunkResult?.skipped || 0)} deduped=${Number(chunkResult?.deduped || 0)} failed=${Number(chunkResult?.failed || 0)} processed=${Number(chunkResult?.processed || 0)} nextStartAfter=${chunkResult?.nextStartAfter || "null"} lastCompletedKey=${chunkResult?.lastCompletedKey || "null"} invocationLimitReached=${chunkResult?.invocationLimitReached === true} errorCause=${chunkResult?.errorCause || "null"}`
        );
        const nextDirectory = {
          phase: "copy",
          success: Number(activeDirectory.success || 0) + Number(chunkResult?.success || 0),
          failed: Number(activeDirectory.failed || 0) + Number(chunkResult?.failed || 0),
          skipped: Number(activeDirectory.skipped || 0) + Number(chunkResult?.skipped || 0),
          deduped: Number(activeDirectory.deduped || 0) + Number(chunkResult?.deduped || 0),
          processed: Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0),
          countedObjects: Number(activeDirectory.countedObjects || activeDirectory.totalObjects || 0),
          totalObjects: Number(activeDirectory.totalObjects || activeDirectory.countedObjects || 0) > 0 ? Number(activeDirectory.totalObjects || activeDirectory.countedObjects || 0) : Math.max(
            Number(activeDirectory.totalObjects || 0),
            Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0) + (chunkResult?.done ? 0 : maxObjects)
          ),
          failedItems: appendLimitedFailedItems(activeDirectory.failedItems, chunkResult?.failedItems),
          invocationLimitReachedCount: Number(activeDirectory.invocationLimitReachedCount || 0) + (chunkResult?.invocationLimitReached === true ? 1 : 0),
          lastCompletedKey: chunkResult?.lastCompletedKey || activeDirectory.lastCompletedKey || null,
          lastError: chunkResult?.lastError || activeDirectory.lastError || null,
          errorCause: chunkResult?.errorCause || activeDirectory.errorCause || null,
          batchSize: maxObjects,
          currentBatch: Math.max(1, Math.ceil((Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0)) / Math.max(1, maxObjects)))
        };
        const directoryProgress = buildDirectoryProgress(nextDirectory, maxObjects, currentIndex);
        const nextTotalItems = Math.max(Number(currentStats.totalItems || payload.items.length), payload.items.length - 1 + nextDirectory.totalObjects);
        itemResults[currentIndex].message = chunkResult?.done ? `\u76EE\u5F55\u590D\u5236\u5B8C\u6210\uFF1A\u6210\u529F ${nextDirectory.success}\uFF0C\u5931\u8D25 ${nextDirectory.failed}\uFF0C\u8DF3\u8FC7 ${nextDirectory.skipped}\uFF0C\u5DF2\u5B58\u5728 ${nextDirectory.deduped}` : `\u76EE\u5F55\u590D\u5236\u8FDB\u884C\u4E2D\uFF1A\u6210\u529F ${nextDirectory.success}\uFF0C\u5931\u8D25 ${nextDirectory.failed}\uFF0C\u8DF3\u8FC7 ${nextDirectory.skipped}\uFF0C\u5DF2\u5B58\u5728 ${nextDirectory.deduped}`;
        itemResults[currentIndex].meta = {
          ...itemResults[currentIndex].meta || {},
          copyDetails: nextDirectory
        };
        if (chunkResult?.done) {
          const itemFailed = nextDirectory.failed > 0;
          itemResults[currentIndex].status = itemFailed ? "failed" : chunkResult?.skippedRoot ? "skipped" : "success";
          if (itemFailed) {
            itemResults[currentIndex].error = `\u76EE\u5F55\u590D\u5236\u5B58\u5728 ${nextDirectory.failed} \u4E2A\u5931\u8D25\u9879`;
          }
          await context.updateProgress(job.jobId, {
            totalItems: nextTotalItems,
            processedItems: baseProcessed + 1,
            successCount: baseSuccess + Number(chunkResult?.success || 0) + Number(chunkResult?.deduped || 0),
            failedCount: baseFailed + Number(chunkResult?.failed || 0),
            skippedCount: baseSkipped + Number(chunkResult?.skipped || 0),
            directoryProgress: {
              ...directoryProgress,
              totalObjects: Number(nextDirectory.totalObjects || nextDirectory.countedObjects || nextDirectory.processed),
              currentBatch: Math.max(1, Math.ceil(nextDirectory.processed / Math.max(1, maxObjects)))
            },
            itemResults,
            copyCheckpoint: {
              currentIndex: currentIndex + 1,
              startAfter: null,
              countContinuationToken: null,
              phase: "count",
              activeDirectory: null,
              initialized: true
            }
          });
          return { done: currentIndex + 1 >= payload.items.length, message: "directory item completed" };
        }
        await context.updateProgress(job.jobId, {
          totalItems: nextTotalItems,
          processedItems: baseProcessed,
          successCount: baseSuccess + Number(chunkResult?.success || 0) + Number(chunkResult?.deduped || 0),
          failedCount: baseFailed + Number(chunkResult?.failed || 0),
          skippedCount: baseSkipped + Number(chunkResult?.skipped || 0),
          directoryProgress,
          itemResults,
          copyCheckpoint: {
            currentIndex,
            startAfter: chunkResult?.lastCompletedKey || chunkResult?.nextStartAfter || checkpoint.startAfter || null,
            countContinuationToken: null,
            phase: "copy",
            activeDirectory: nextDirectory,
            initialized: true
          }
        });
        return {
          done: false,
          message: "directory chunk copied",
          invocationLimitReached: chunkResult?.invocationLimitReached === true
        };
      }
      if (canChunkCrossMountDirectory) {
        const activeDirectory = checkpoint.activeDirectory || null;
        const baseBeforeCurrentDirectory = subtractActiveDirectoryStats(currentStats, activeDirectory);
        const chunkResult = await executeCrossMountDirectoryChunk({
          fileSystem,
          item,
          job,
          userId: job.userId,
          userType: job.userType,
          activeDirectory,
          configuredChunkSize: directoryCopyChunkSize,
          options: payload.options
        });
        const nextDirectory = chunkResult.activeDirectory || {};
        const maxObjects = Number(chunkResult.maxEntries || 1);
        const directoryProgress = buildDirectoryProgress(nextDirectory, maxObjects, currentIndex);
        const observedTotal = Math.max(
          Number(currentStats.totalItems || payload.items.length),
          payload.items.length - 1 + Number(nextDirectory.processed || 0) + (chunkResult.done ? 0 : maxObjects)
        );
        itemResults[currentIndex].message = chunkResult.done ? `\u8DE8\u5B58\u50A8\u76EE\u5F55\u590D\u5236\u5B8C\u6210\uFF1A\u6210\u529F ${Number(nextDirectory.success || 0)}\uFF0C\u5931\u8D25 ${Number(nextDirectory.failed || 0)}\uFF0C\u8DF3\u8FC7 ${Number(nextDirectory.skipped || 0)}` : `\u8DE8\u5B58\u50A8\u76EE\u5F55\u590D\u5236\u8FDB\u884C\u4E2D\uFF1A\u6210\u529F ${Number(nextDirectory.success || 0)}\uFF0C\u5931\u8D25 ${Number(nextDirectory.failed || 0)}\uFF0C\u8DF3\u8FC7 ${Number(nextDirectory.skipped || 0)}`;
        itemResults[currentIndex].meta = {
          ...itemResults[currentIndex].meta || {},
          copyDetails: {
            ...nextDirectory,
            failedItems: Array.isArray(nextDirectory.failedItems) ? nextDirectory.failedItems.slice(0, 20) : []
          }
        };
        if (chunkResult.done) {
          const detailSuccess = Number(nextDirectory.success || 0);
          const detailFailed = Number(nextDirectory.failed || 0);
          const detailSkipped = Number(nextDirectory.skipped || 0);
          itemResults[currentIndex].status = detailFailed > 0 ? "failed" : "success";
          const firstFailedItem = Array.isArray(nextDirectory.failedItems) ? nextDirectory.failedItems[0] : null;
          itemResults[currentIndex].error = detailFailed > 0 ? firstFailedItem?.message || `\u8DE8\u5B58\u50A8\u76EE\u5F55\u590D\u5236\u5B58\u5728 ${detailFailed} \u4E2A\u5931\u8D25\u9879` : void 0;
          await context.updateProgress(job.jobId, {
            processedItems: baseBeforeCurrentDirectory.processedItems + Math.max(1, detailSuccess + detailFailed + detailSkipped),
            totalItems: Math.max(observedTotal, payload.items.length - 1 + detailSuccess + detailFailed + detailSkipped),
            successCount: baseBeforeCurrentDirectory.successCount + detailSuccess,
            failedCount: baseBeforeCurrentDirectory.failedCount + detailFailed,
            skippedCount: baseBeforeCurrentDirectory.skippedCount + detailSkipped,
            directoryProgress: {
              ...directoryProgress,
              totalObjects: Number(nextDirectory.processed || 0)
            },
            itemResults,
            copyCheckpoint: {
              currentIndex: currentIndex + 1,
              startAfter: null,
              countContinuationToken: null,
              phase: "count",
              activeDirectory: null,
              initialized: true
            }
          });
          return { done: currentIndex + 1 >= payload.items.length, message: "cross mount directory item completed" };
        }
        await context.updateProgress(job.jobId, {
          processedItems: baseBeforeCurrentDirectory.processedItems + Number(nextDirectory.processed || 0),
          totalItems: observedTotal,
          successCount: baseBeforeCurrentDirectory.successCount + Number(nextDirectory.success || 0),
          failedCount: baseBeforeCurrentDirectory.failedCount + Number(nextDirectory.failed || 0),
          skippedCount: baseBeforeCurrentDirectory.skippedCount + Number(nextDirectory.skipped || 0),
          directoryProgress,
          itemResults,
          copyCheckpoint: {
            currentIndex,
            startAfter: null,
            countContinuationToken: null,
            phase: "copy",
            activeDirectory: nextDirectory,
            initialized: true
          }
        });
        return {
          done: false,
          message: "cross mount directory chunk copied",
          invocationLimitReached: chunkResult.invocationLimitReached === true
        };
      }
      const copyResult = await fileSystem.copyItem(item.sourcePath, item.targetPath, job.userId, job.userType, {
        ...payload.options,
        maxDirectoryCopyObjects: directoryCopyChunkSize
      });
      const resultStatus = copyResult?.status || "success";
      if (resultStatus === "skipped" || copyResult?.skipped === true) {
        itemResults[currentIndex].status = "skipped";
        itemResults[currentIndex].message = copyResult?.message || "\u5DF2\u8DF3\u8FC7";
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + 1,
          successCount: baseSuccess,
          failedCount: baseFailed,
          skippedCount: baseSkipped + 1,
          itemResults,
          copyCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true }
        });
      } else if (resultStatus === "failed") {
        const details = copyResult?.stats || {};
        const detailSuccess = Number(details?.success || 0);
        const detailFailed = Number(details?.failed || 0);
        const detailSkipped = Number(details?.skipped || 0);
        const failedItems = Array.isArray(copyResult?.details) ? copyResult.details : [];
        const firstFailure = failedItems[0]?.message || failedItems[0]?.error || null;
        itemResults[currentIndex].status = "failed";
        itemResults[currentIndex].error = firstFailure || copyResult?.message || copyResult?.error || "\u590D\u5236\u5931\u8D25";
        itemResults[currentIndex].meta = {
          ...itemResults[currentIndex].meta || {},
          copyDetails: {
            ...details,
            failedItems: failedItems.slice(0, 20)
          }
        };
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + Math.max(1, detailSuccess + detailFailed + detailSkipped),
          totalItems: Math.max(Number(currentStats.totalItems || payload.items.length), payload.items.length - 1 + detailSuccess + detailFailed + detailSkipped),
          successCount: baseSuccess + detailSuccess,
          failedCount: baseFailed + Math.max(1, detailFailed),
          skippedCount: baseSkipped + detailSkipped,
          itemResults,
          copyCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true }
        });
      } else if (resultStatus === "partial") {
        const details = copyResult?.stats || copyResult?.details || {};
        const detailSuccess = Number(details?.success || 0);
        const detailFailed = Number(details?.failed || 0);
        const detailSkipped = Number(details?.skipped || 0);
        const failedItems = Array.isArray(copyResult?.details) ? copyResult.details : [];
        itemResults[currentIndex].status = detailFailed > 0 ? "failed" : "success";
        itemResults[currentIndex].message = copyResult?.message || "\u90E8\u5206\u5B8C\u6210";
        itemResults[currentIndex].error = detailFailed > 0 ? failedItems[0]?.message || `\u590D\u5236\u5B58\u5728 ${detailFailed} \u4E2A\u5931\u8D25\u9879` : void 0;
        itemResults[currentIndex].meta = {
          ...itemResults[currentIndex].meta || {},
          copyDetails: {
            ...details,
            failedItems: failedItems.slice(0, 20)
          }
        };
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + detailSuccess + detailFailed + detailSkipped,
          totalItems: Math.max(Number(currentStats.totalItems || payload.items.length), payload.items.length - 1 + detailSuccess + detailFailed + detailSkipped),
          successCount: baseSuccess + detailSuccess,
          failedCount: baseFailed + detailFailed,
          skippedCount: baseSkipped + detailSkipped,
          itemResults,
          copyCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true }
        });
      } else {
        itemResults[currentIndex].status = "success";
        itemResults[currentIndex].message = copyResult?.message || "\u590D\u5236\u6210\u529F";
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + 1,
          successCount: baseSuccess + 1,
          failedCount: baseFailed,
          skippedCount: baseSkipped,
          itemResults,
          copyCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true }
        });
      }
      return { done: currentIndex + 1 >= payload.items.length, message: "file item copied" };
    } catch (error) {
      console.error(
        `[CopyTaskHandler] executeChunk failed job=${job.jobId} index=${currentIndex} source=${item.sourcePath} target=${item.targetPath}`,
        error
      );
      const canRetry = isRetryableError(error);
      if (canRetry) {
        throw error;
      }
      const errorSummary = summarizeTaskError(error);
      const causeText = errorSummary.cause && errorSummary.cause !== errorSummary.message ? `\uFF1B\u539F\u56E0\uFF1A${errorSummary.cause}` : "";
      itemResults[currentIndex].status = "failed";
      itemResults[currentIndex].error = `${errorSummary.message}${causeText} [\u4E0D\u53EF\u91CD\u8BD5\u9519\u8BEF]`;
      itemResults[currentIndex].meta = {
        ...itemResults[currentIndex].meta || {},
        lastError: errorSummary
      };
      await context.updateProgress(job.jobId, {
        processedItems: baseProcessed + 1,
        successCount: baseSuccess,
        failedCount: baseFailed + 1,
        skippedCount: baseSkipped,
        itemResults,
        copyCheckpoint: {
          currentIndex: currentIndex + 1,
          startAfter: null,
          activeDirectory: null,
          initialized: true
        }
      });
      return { done: currentIndex + 1 >= payload.items.length, message: "item failed" };
    }
  }
  /** 执行复制任务 - 预扫描文件大小 → 逐项复制 + 支持重试和取消 */
  async execute(job, context) {
    const payload = job.payload;
    const fileSystem = context.getFileSystem();
    const env = typeof context.getEnv === "function" ? context.getEnv() : null;
    const isWorkersEnv = !!env && (Object.prototype.hasOwnProperty.call(env, "DB") || Object.prototype.hasOwnProperty.call(env, "JOB_WORKFLOW"));
    const resolvedDirectoryCopyChunkSize = await resolveDirectoryCopyChunkSize(fileSystem, payload);
    const directoryCopyObjectLimit = isWorkersEnv ? resolvedDirectoryCopyChunkSize : payload.options?.maxDirectoryCopyObjects;
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let totalBytesTransferred = 0;
    let totalItemsObserved = payload.items.length;
    console.log(`[CopyTaskHandler] \u5F00\u59CB\u6267\u884C\u4F5C\u4E1A ${job.jobId}, \u5171 ${payload.items.length} \u9879`);
    const prescanConcurrency = isWorkersEnv ? PRESCAN_CONCURRENCY_WORKERS : PRESCAN_CONCURRENCY_DOCKER;
    const fileSizes = new Array(payload.items.length).fill(0);
    for (let batchStart = 0; batchStart < payload.items.length; batchStart += prescanConcurrency) {
      const batchEnd = Math.min(batchStart + prescanConcurrency, payload.items.length);
      const batchPromises = [];
      for (let i = batchStart; i < batchEnd; i++) {
        const item = payload.items[i];
        if (item.sourcePath.endsWith("/")) {
          continue;
        }
        const scanPromise = (async () => {
          try {
            const fileInfo = await fileSystem.getFileInfo(item.sourcePath, job.userId, job.userType);
            fileSizes[i] = fileInfo?.size || 0;
          } catch (error) {
            console.warn(`[CopyTaskHandler] \u65E0\u6CD5\u83B7\u53D6\u6587\u4EF6\u5927\u5C0F: ${item.sourcePath}`, error);
          }
        })();
        batchPromises.push(scanPromise);
      }
      await Promise.all(batchPromises);
    }
    const totalBytes = fileSizes.reduce((sum, size) => sum + size, 0);
    const itemResults = payload.items.map((item, index) => ({
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
      status: "pending",
      fileSize: fileSizes[index]
    }));
    await context.updateProgress(job.jobId, { totalBytes, itemResults });
    console.log(`[CopyTaskHandler] \u9884\u626B\u63CF\u5B8C\u6210\uFF0C\u603B\u5927\u5C0F: ${totalBytes} \u5B57\u8282`);
    const retryPolicy = payload.options?.retryPolicy || DEFAULT_RETRY_POLICY;
    console.log(`[CopyTaskHandler] \u91CD\u8BD5\u7B56\u7565: limit=${retryPolicy.limit}, delay=${retryPolicy.delay}ms, backoff=${retryPolicy.backoff}`);
    const lastReportedBytesPerItem = new Array(payload.items.length).fill(0);
    const progressStepPerItem = fileSizes.map((size) => {
      if (!size || size <= 0) {
        return DEFAULT_PROGRESS_BYTES_STEP;
      }
      const step = Math.ceil(size / MAX_PROGRESS_UPDATES_PER_ITEM);
      return Math.max(step, DEFAULT_PROGRESS_BYTES_STEP);
    });
    let lastDockerProgressTime = 0;
    const userMaxConcurrency = payload.options?.maxConcurrency;
    let jobConcurrency = Number(userMaxConcurrency);
    if (!Number.isFinite(jobConcurrency) || jobConcurrency <= 0) {
      jobConcurrency = 2;
    }
    jobConcurrency = Math.min(Math.max(jobConcurrency, 1), 32);
    console.log(`[CopyTaskHandler] \u4F5C\u4E1A\u5185\u590D\u5236\u5E76\u53D1\u6570: ${jobConcurrency} (isWorkersEnv=${isWorkersEnv})`);
    const processItem = async (i) => {
      const item = payload.items[i];
      if (await context.isCancelled(job.jobId)) {
        console.log(`[CopyTaskHandler] \u4F5C\u4E1A ${job.jobId} \u5DF2\u53D6\u6D88, \u8DF3\u8FC7\u5269\u4F59\u9879 (\u5F53\u524D\u7D22\u5F15 ${i + 1}/${payload.items.length})`);
        return;
      }
      let lastError = null;
      let fileSuccess = false;
      let fileSkipped = false;
      let filePartial = false;
      let fileSuccessIncrement = 1;
      let currentFileBytes = 0;
      for (let attempt = 0; attempt <= retryPolicy.limit; attempt++) {
        if (attempt > 0) {
          const delay = calculateBackoffDelay(attempt, retryPolicy);
          console.log(`[CopyTaskHandler] ${formatRetryLog(attempt, retryPolicy.limit, delay, item.sourcePath, lastError?.message)}`);
          itemResults[i].status = "retrying";
          itemResults[i].retryCount = attempt;
          itemResults[i].lastRetryAt = Date.now();
          await context.updateProgress(job.jobId, { itemResults });
          await sleep(delay);
          if (await context.isCancelled(job.jobId)) {
            console.log(`[CopyTaskHandler] \u4F5C\u4E1A ${job.jobId} \u5728\u91CD\u8BD5\u7B49\u5F85\u671F\u95F4\u88AB\u53D6\u6D88`);
            return;
          }
        }
        itemResults[i].status = attempt > 0 ? "retrying" : "processing";
        currentFileBytes = 0;
        try {
          const copyResult = await fileSystem.copyItem(item.sourcePath, item.targetPath, job.userId, job.userType, {
            ...payload.options,
            maxDirectoryCopyObjects: directoryCopyObjectLimit,
            onProgress: (bytesTransferred) => {
              currentFileBytes = bytesTransferred;
              itemResults[i].bytesTransferred = bytesTransferred;
              const absoluteBytes = totalBytesTransferred + currentFileBytes;
              if (!isWorkersEnv) {
                const now = Date.now();
                if (now - lastDockerProgressTime >= DOCKER_PROGRESS_INTERVAL_MS) {
                  lastDockerProgressTime = now;
                  context.updateProgress(job.jobId, {
                    bytesTransferred: absoluteBytes,
                    itemResults
                  }).catch(() => {
                  });
                }
                return;
              }
              const lastReported = lastReportedBytesPerItem[i];
              const step = progressStepPerItem[i];
              if (absoluteBytes - lastReported >= step) {
                lastReportedBytesPerItem[i] = absoluteBytes;
                context.updateProgress(job.jobId, {
                  bytesTransferred: absoluteBytes,
                  itemResults
                }).catch(() => {
                });
              }
            }
          });
          const resultStatus = copyResult?.status || "success";
          const isSkipped = resultStatus === "skipped" || copyResult?.skipped === true;
          const copyDetails = copyResult?.details || null;
          const detailSuccess = Number(copyDetails?.success || 0);
          const detailFailed = Number(copyDetails?.failed || 0);
          const detailSkipped = Number(copyDetails?.skipped || 0);
          const detailTotal = Number(copyDetails?.total || detailSuccess + detailFailed + detailSkipped || 0);
          if (isSkipped) {
            fileSkipped = true;
            const skipReason = copyResult?.message || copyResult?.error || (payload.options?.skipExisting ? "\u76EE\u6807\u5DF2\u5B58\u5728\uFF0C\u5DF2\u6309\u201C\u8DF3\u8FC7\u5DF2\u5B58\u5728\u6587\u4EF6\u201D\u8BBE\u7F6E\u8DF3\u8FC7" : "\u5DF2\u8DF3\u8FC7");
            itemResults[i].message = String(skipReason);
          } else if (resultStatus === "failed") {
            const reason = copyResult?.message || copyResult?.error || "\u590D\u5236\u5931\u8D25";
            throw new Error(reason);
          } else if (resultStatus === "partial") {
            const summary = copyResult?.message || `\u90E8\u5206\u5B8C\u6210\uFF1A\u6210\u529F ${detailSuccess}\uFF0C\u5931\u8D25 ${detailFailed}\uFF0C\u8DF3\u8FC7 ${detailSkipped}`;
            itemResults[i].message = String(summary);
            itemResults[i].error = detailFailed > 0 ? `\u9012\u5F52\u590D\u5236\u5B58\u5728 ${detailFailed} \u4E2A\u5931\u8D25\u9879` : void 0;
            itemResults[i].bytesTransferred = copyResult?.contentLength || currentFileBytes || 0;
            itemResults[i].meta = {
              ...itemResults[i].meta || {},
              copyDetails
            };
            if (detailTotal > 0) {
              totalItemsObserved += Math.max(0, detailTotal - 1);
            }
            totalBytesTransferred += copyResult?.contentLength || currentFileBytes || 0;
            fileSuccess = detailSuccess > 0 || detailSkipped > 0;
            filePartial = true;
            if (detailFailed > 0) {
              failedCount += detailFailed;
            }
            if (detailSkipped > 0) {
              skippedCount += detailSkipped;
            }
            fileSuccessIncrement = Math.max(0, detailSuccess);
          } else {
            const fileBytes = copyResult?.contentLength || currentFileBytes || 0;
            totalBytesTransferred += fileBytes;
            itemResults[i].bytesTransferred = fileBytes;
            fileSuccess = true;
          }
          itemResults[i].retryCount = attempt;
          break;
        } catch (error) {
          lastError = error;
          const canRetry = isRetryableError(error);
          const hasMoreRetries = attempt < retryPolicy.limit;
          if (!canRetry || !hasMoreRetries) {
            const retryInfo = attempt > 0 ? ` (\u5DF2\u91CD\u8BD5 ${attempt}/${retryPolicy.limit} \u6B21)` : "";
            const retryableInfo = !canRetry ? " [\u4E0D\u53EF\u91CD\u8BD5\u9519\u8BEF]" : "";
            const causeInfo = error?.details?.cause && error.details.cause !== error.message ? `\uFF1B\u539F\u56E0\uFF1A${error.details.cause}` : "";
            itemResults[i].status = "failed";
            itemResults[i].error = `${error.message || String(error)}${causeInfo}${retryInfo}${retryableInfo}`;
            itemResults[i].retryCount = attempt;
            console.error(
              `[CopyTaskHandler] \u590D\u5236\u6700\u7EC8\u5931\u8D25 [${i + 1}/${payload.items.length}]${retryInfo}${retryableInfo} ${item.sourcePath} \u2192 ${item.targetPath}: ${error.message || error}`
            );
            break;
          }
          console.warn(
            `[CopyTaskHandler] \u590D\u5236\u5931\u8D25 [${i + 1}/${payload.items.length}] (\u5C1D\u8BD5 ${attempt + 1}/${retryPolicy.limit + 1}) ${item.sourcePath}: ${error.message || error} [\u5C06\u91CD\u8BD5]`
          );
        }
      }
      if (fileSkipped) {
        itemResults[i].status = "skipped";
        itemResults[i].bytesTransferred = 0;
        skippedCount++;
      } else if (filePartial) {
        itemResults[i].status = "failed";
        successCount += fileSuccessIncrement;
      } else if (fileSuccess) {
        itemResults[i].status = "success";
        successCount += fileSuccessIncrement;
        const retryCount = itemResults[i].retryCount;
        if (retryCount !== void 0 && retryCount > 0) {
          console.log(`[CopyTaskHandler] \u2713 \u590D\u5236\u6210\u529F (\u7ECF ${retryCount} \u6B21\u91CD\u8BD5) ${item.sourcePath}`);
        }
      } else {
        failedCount++;
      }
      await context.updateProgress(job.jobId, {
        processedItems: successCount + failedCount + skippedCount,
        totalItems: totalItemsObserved,
        successCount,
        failedCount,
        skippedCount,
        bytesTransferred: totalBytesTransferred,
        itemResults
      });
    };
    for (let batchStart = 0; batchStart < payload.items.length; batchStart += jobConcurrency) {
      if (await context.isCancelled(job.jobId)) {
        console.log(`[CopyTaskHandler] \u4F5C\u4E1A ${job.jobId} \u5DF2\u53D6\u6D88, \u505C\u6B62\u542F\u52A8\u65B0\u7684\u590D\u5236\u6279\u6B21 (\u5DF2\u5904\u7406 ~${batchStart}/${payload.items.length} \u9879)`);
        break;
      }
      const batchEnd = Math.min(batchStart + jobConcurrency, payload.items.length);
      const batchPromises = [];
      for (let i = batchStart; i < batchEnd; i++) {
        batchPromises.push(processItem(i));
      }
      await Promise.all(batchPromises);
    }
    console.log(`[CopyTaskHandler] \u4F5C\u4E1A ${job.jobId} \u6267\u884C\u5B8C\u6210: \u6210\u529F ${successCount}, \u5931\u8D25 ${failedCount}, \u8DF3\u8FC7 ${skippedCount}, \u4F20\u8F93 ${totalBytesTransferred} \u5B57\u8282`);
    if (successCount > 0) {
      try {
        const mountDirPaths = /* @__PURE__ */ new Map();
        const mountFallback = /* @__PURE__ */ new Set();
        const dirtyTargetPathsByMount = /* @__PURE__ */ new Map();
        const indexStore = (() => {
          const db = fileSystem.mountManager?.db ?? null;
          return db ? new FsSearchIndexStore(db) : null;
        })();
        const toParentDir = (subPath) => {
          const raw = subPath ? String(subPath) : "/";
          const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
          const collapsed = withLeading.replace(/\/{2,}/g, "/");
          if (collapsed === "/") return "/";
          const normalized = collapsed.replace(/\/+$/, "");
          const lastSlash = normalized.lastIndexOf("/");
          if (lastSlash <= 0) return "/";
          return normalized.slice(0, lastSlash) || "/";
        };
        for (const item of itemResults) {
          if (item?.status !== "success") continue;
          if (!item?.targetPath) continue;
          const resolved = await fileSystem.mountManager.getDriverByPath(item.targetPath, job.userId, job.userType);
          const mountId = resolved?.mount?.id || null;
          const subPath = resolved?.subPath || null;
          if (!mountId) continue;
          if (!dirtyTargetPathsByMount.has(mountId)) {
            dirtyTargetPathsByMount.set(mountId, []);
          }
          dirtyTargetPathsByMount.get(mountId)?.push(String(item.targetPath));
          if (!subPath) {
            mountFallback.add(mountId);
            continue;
          }
          const isDirectoryHint = item.targetPath.endsWith("/");
          const dirPath = isDirectoryHint ? subPath : toParentDir(subPath);
          if (!mountDirPaths.has(mountId)) {
            mountDirPaths.set(mountId, /* @__PURE__ */ new Set());
          }
          mountDirPaths.get(mountId)?.add(dirPath);
        }
        const MAX_PATHS_PER_MOUNT = 200;
        const mountsToLog = [];
        for (const [mountId, dirPathSet] of mountDirPaths.entries()) {
          if (mountFallback.has(mountId)) {
            invalidateFsCache({ mountId, reason: "copy-job", db: fileSystem.mountManager?.db ?? null });
            mountsToLog.push(`${mountId}(mount)`);
            continue;
          }
          const dirPaths = Array.from(dirPathSet);
          if (dirPaths.length === 0) continue;
          if (dirPaths.length > MAX_PATHS_PER_MOUNT) {
            invalidateFsCache({ mountId, reason: "copy-job", db: fileSystem.mountManager?.db ?? null });
            mountsToLog.push(`${mountId}(mount,paths=${dirPaths.length})`);
            continue;
          }
          invalidateFsCache({ mountId, paths: dirPaths, reason: "copy-job", db: fileSystem.mountManager?.db ?? null });
          mountsToLog.push(`${mountId}(paths=${dirPaths.length})`);
        }
        for (const mountId of mountFallback) {
          if (mountDirPaths.has(mountId)) continue;
          invalidateFsCache({ mountId, reason: "copy-job", db: fileSystem.mountManager?.db ?? null });
          mountsToLog.push(`${mountId}(mount)`);
        }
        if (mountsToLog.length > 0) {
          console.log(`[CopyTaskHandler] \u5DF2\u89E6\u53D1\u76EE\u5F55\u7F13\u5B58\u5931\u6548: ${mountsToLog.join(", ")}`);
        }
        if (indexStore && dirtyTargetPathsByMount.size > 0) {
          const MAX_DIRTY_OPS_PER_MOUNT = 200;
          const ensureDirPath = (p) => {
            const raw = typeof p === "string" && p ? p : "/";
            const trimmed = raw.replace(/\/+$/g, "");
            if (!trimmed || trimmed === "/") return "/";
            return `${trimmed}/`;
          };
          const parentDirPath = (p) => {
            const raw = typeof p === "string" && p ? p : "/";
            const trimmed = raw.replace(/\/+$/g, "");
            if (!trimmed || trimmed === "/") return "/";
            const idx = trimmed.lastIndexOf("/");
            if (idx <= 0) return "/";
            return ensureDirPath(trimmed.slice(0, idx) || "/");
          };
          const toDirtyDirectory = (p) => p.endsWith("/") ? ensureDirPath(p) : parentDirPath(p);
          const commonDirPrefix = (dirs) => {
            const list = Array.isArray(dirs) ? dirs.filter(Boolean) : [];
            if (list.length === 0) return "/";
            const toSegs = (dir) => String(dir || "/").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
            let prefix = toSegs(list[0]);
            for (let i = 1; i < list.length; i++) {
              const segs = toSegs(list[i]);
              const next = [];
              const len = Math.min(prefix.length, segs.length);
              for (let j = 0; j < len; j++) {
                if (prefix[j] !== segs[j]) break;
                next.push(prefix[j]);
              }
              prefix = next;
              if (prefix.length === 0) break;
            }
            if (prefix.length === 0) return "/";
            return `/${prefix.join("/")}/`;
          };
          for (const [mountId, paths] of dirtyTargetPathsByMount.entries()) {
            const unique = Array.from(new Set((paths || []).filter(Boolean)));
            if (unique.length === 0) continue;
            try {
              if (unique.length > MAX_DIRTY_OPS_PER_MOUNT) {
                const dirPrefix = commonDirPrefix(unique.map(toDirtyDirectory));
                await indexStore.upsertDirty({ mountId: String(mountId), fsPath: dirPrefix, op: "upsert" });
              } else {
                for (const p of unique) {
                  await indexStore.upsertDirty({ mountId: String(mountId), fsPath: String(p), op: "upsert" });
                }
              }
            } catch (err) {
              const errMessage = err instanceof Error ? err.message : String(err);
              console.warn("[CopyTaskHandler] upsertDirty \u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF09", errMessage);
            }
          }
        }
      } catch (error) {
        console.warn("[CopyTaskHandler] \u76EE\u5F55\u7F13\u5B58\u5931\u6548\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF09", error);
      }
    }
  }
  /** 创建统计模板 - 初始化所有项状态为 pending */
  createStatsTemplate(payload) {
    const copyPayload = payload;
    const itemResults = copyPayload.items.map((item) => ({
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
      isDirectory: item.isDirectory ?? isDirectoryPathHint(item.sourcePath) ?? isDirectoryPathHint(item.targetPath),
      status: "pending"
    }));
    return {
      totalItems: copyPayload.items.length,
      processedItems: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      bytesTransferred: 0,
      itemResults
    };
  }
}
export {
  CopyTaskHandler
};

// cSpell:words retryable
import type { TaskHandler, InternalJob, ExecutionContext } from "../TaskHandler.js";
import type { TaskStats, CopyTaskPayload, ItemResult, RetryPolicy } from "../types.js";
import { ValidationError } from "../../../../http/errors.js";
import { invalidateFsCache } from "../../../../cache/invalidation.js";
import { FsSearchIndexStore } from "../../search/FsSearchIndexStore.js";
import { isRetryableError, calculateBackoffDelay, sleep, formatRetryLog, DEFAULT_RETRY_POLICY } from "../utils/retryUtils.js";

// 进度上报节流：限制单个文件的进度写入次数，避免在 Workers Free 计划下触发 50 次子请求上限
const MAX_PROGRESS_UPDATES_PER_ITEM = 5;
const DEFAULT_PROGRESS_BYTES_STEP = 5 * 1024 * 1024;

// Docker 环境进度节流：按时间间隔限制进度上报频率，减少数据库写入压力
const DOCKER_PROGRESS_INTERVAL_MS = 500;

// 预扫描并发数：
// - Workers: 6 个并发连接是每次 invocation 独立的配额
// - Docker: 无硬限制
const PRESCAN_CONCURRENCY_WORKERS = 6;
const PRESCAN_CONCURRENCY_DOCKER = 10;

// Workers 单次 invocation 的子请求数量有限。目录复制在同存储 S3/R2 下会对每个对象发起 CopyObject。
// 首次按配置值执行；如果驱动捕捉到 invocation/subrequest 限制，后续续跑会自动减半降档。
const WORKERS_DIRECTORY_COPY_OBJECT_LIMIT = 10;
const MAX_WORKERS_DIRECTORY_COPY_OBJECT_LIMIT = 100;

function isDirectoryPathHint(path: string | undefined): boolean {
  return typeof path === "string" && path.endsWith("/");
}

function ensureCopyItemResults(payload: CopyTaskPayload, stats: TaskStats): ItemResult[] {
  const current = Array.isArray(stats.itemResults) ? stats.itemResults : [];
  return payload.items.map((item, index) => ({
    sourcePath: item.sourcePath,
    targetPath: item.targetPath,
    status: current[index]?.status || "pending",
    fileSize: current[index]?.fileSize || 0,
    bytesTransferred: current[index]?.bytesTransferred || 0,
    retryCount: current[index]?.retryCount,
    error: current[index]?.error,
    message: current[index]?.message,
    meta: current[index]?.meta,
  }));
}

function appendLimitedFailedItems(existing: any[] | undefined, next: any[] | undefined, limit = 20): any[] {
  return [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(next) ? next : [])].slice(0, limit);
}

function summarizeTaskError(error: any): { message: string; cause?: string; stack?: string } {
  const message = error?.message || String(error || "未知错误");
  const cause = error?.details?.cause || error?.cause?.message || error?.cause || undefined;
  const stack = typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 2).join(" | ") : undefined;
  return {
    message,
    cause: cause ? String(cause) : undefined,
    stack,
  };
}

function clampDirectoryCopyChunkSize(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return WORKERS_DIRECTORY_COPY_OBJECT_LIMIT;
  }
  return Math.min(Math.max(Math.floor(numeric), 1), MAX_WORKERS_DIRECTORY_COPY_OBJECT_LIMIT);
}

function getEffectiveDirectoryCopyChunkSize(configuredSize: number, activeDirectory?: Record<string, any> | null): number {
  const configured = Math.max(1, Math.floor(Number(configuredSize) || WORKERS_DIRECTORY_COPY_OBJECT_LIMIT));
  const limitHits = Math.max(0, Math.floor(Number(activeDirectory?.invocationLimitReachedCount || 0)));
  let effective = configured;

  for (let i = 0; i < limitHits; i += 1) {
    effective = Math.max(1, Math.floor(effective / 2));
  }

  return Math.max(1, effective);
}

function buildDirectoryProgress(activeDirectory: Record<string, any>, chunkSize: number, currentIndex: number) {
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
    invocationLimitReachedCount: Number(activeDirectory.invocationLimitReachedCount || 0),
  };
}

function isInvocationLimitError(error: any): boolean {
  const message = String(error?.message || error?.details?.cause || error?.cause?.message || error || "");
  return /too many subrequests|subrequest|invocation/i.test(message);
}

function normalizeDirectoryPath(path: string): string {
  const raw = String(path || "/").replace(/\/+/g, "/");
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}

function joinDirectoryPath(base: string, relative: string): string {
  const normalizedBase = normalizeDirectoryPath(base);
  const cleanRelative = String(relative || "").replace(/^\/+/, "");
  return `${normalizedBase}${cleanRelative}`.replace(/\/+/g, "/");
}

async function executeCrossMountDirectoryChunk(params: {
  fileSystem: any;
  item: any;
  job: InternalJob;
  userId: any;
  userType: any;
  activeDirectory: Record<string, any> | null | undefined;
  configuredChunkSize: number;
  options: Record<string, any> | undefined;
}) {
  const { fileSystem, item, job, userId, userType, options } = params;
  const sourceBase = normalizeDirectoryPath(item.sourcePath);
  const targetBase = normalizeDirectoryPath(item.targetPath);
  const configured = Math.max(1, Math.floor(Number(params.configuredChunkSize || 1)));
  // 跨存储单文件复制通常至少包含读取、写入和元数据更新，多对象同 invocation 风险很高。
  const maxEntries = Math.max(1, Math.min(configured, 3));
  const active = params.activeDirectory?.mode === "cross_mount_directory"
    ? { ...params.activeDirectory }
    : {
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
        lastError: null,
      };

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
      } catch (error: any) {
        if (isInvocationLimitError(error)) {
          active.lastError = error?.message || String(error);
          return { done: false, activeDirectory: active, maxEntries, invocationLimitReached: true };
        }
        active.failed += 1;
        active.processed += 1;
        active.failedItems = appendLimitedFailedItems(active.failedItems, [{ source: active.currentDir, target: targetDir, message: error?.message || "创建目标目录失败" }]);
        active.currentDir = null;
        processedThisRun += 1;
        continue;
      }

      try {
        const dirResult = await fileSystem.listDirectory(active.currentDir, userId, userType, { refresh: true });
        active.entries = Array.isArray(dirResult?.items) ? dirResult.items : [];
      } catch (error: any) {
        if (isInvocationLimitError(error)) {
          active.lastError = error?.message || String(error);
          return { done: false, activeDirectory: active, maxEntries, invocationLimitReached: true };
        }
        active.failed += 1;
        active.processed += 1;
        active.failedItems = appendLimitedFailedItems(active.failedItems, [{ source: active.currentDir, target: targetDir, message: error?.message || "列出目录失败" }]);
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
        maxDirectoryCopyObjects: 1,
      });
      if (result?.status === "skipped" || result?.skipped === true) {
        active.skipped += 1;
      } else if (result?.status === "failed") {
        active.failed += 1;
        active.failedItems = appendLimitedFailedItems(active.failedItems, [{ source: entryPath, target: targetPath, message: result?.message || result?.error || "复制失败" }]);
      } else {
        active.success += 1;
      }
      active.processed += 1;
      active.entryIndex += 1;
      processedThisRun += 1;
    } catch (error: any) {
      if (isInvocationLimitError(error)) {
        active.lastError = error?.message || error?.details?.cause || String(error);
        return { done: false, activeDirectory: active, maxEntries, invocationLimitReached: true };
      }
      active.failed += 1;
      active.processed += 1;
      active.failedItems = appendLimitedFailedItems(active.failedItems, [{ source: entryPath, target: targetPath, message: error?.details?.cause || error?.message || "复制失败" }]);
      active.entryIndex += 1;
      processedThisRun += 1;
    }
  }

  return { done: false, activeDirectory: active, maxEntries };
}

async function resolveDirectoryCopyChunkSize(fileSystem: any, payload: CopyTaskPayload): Promise<number> {
  if (payload.options?.maxDirectoryCopyObjects !== undefined) {
    return clampDirectoryCopyChunkSize(payload.options.maxDirectoryCopyObjects);
  }

  const db = fileSystem?.mountManager?.db;
  if (db && typeof db.prepare === "function") {
    try {
      const row = await db
        .prepare("SELECT value FROM system_settings WHERE key = ?")
        .bind("copy_directory_chunk_size")
        .first();
      return clampDirectoryCopyChunkSize(row?.value);
    } catch (error) {
      console.warn("[CopyTaskHandler] 读取 copy_directory_chunk_size 设置失败，使用默认值", error);
    }
  }

  return WORKERS_DIRECTORY_COPY_OBJECT_LIMIT;
}

/**
 * 复制任务处理器 - 支持同存储原子复制和跨存储流式复制
 * - 同存储: 驱动层原子复制 (S3 自动使用 CopyObject API)
 * - 跨存储: 后端流式复制 + 字节级进度监控
 */
export class CopyTaskHandler implements TaskHandler {
  readonly taskType = "copy";

  /** 验证复制任务载荷 - items 非空数组且每项包含 sourcePath 和 targetPath */
  async validate(payload: any): Promise<void> {
    // 检查items字段存在且为数组
    if (!payload.items || !Array.isArray(payload.items)) {
      throw new ValidationError("items 必须是数组");
    }

    // 检查items非空
    if (payload.items.length === 0) {
      throw new ValidationError("items 不能为空");
    }

    // 验证每个item的结构
    for (let i = 0; i < payload.items.length; i++) {
      const item = payload.items[i];

      if (!item.sourcePath || typeof item.sourcePath !== "string") {
        throw new ValidationError(`items[${i}].sourcePath 必须是非空字符串`);
      }

      if (!item.targetPath || typeof item.targetPath !== "string") {
        throw new ValidationError(`items[${i}].targetPath 必须是非空字符串`);
      }
    }
  }

  async executeChunk(job: InternalJob, context: ExecutionContext) {
    const payload = job.payload as CopyTaskPayload;
    const fileSystem = context.getFileSystem();
    const directoryCopyChunkSize = await resolveDirectoryCopyChunkSize(fileSystem, payload);
    const currentStats = context.getStats ? await context.getStats(job.jobId) : job.stats;
    const itemResults = ensureCopyItemResults(payload, currentStats);
    const checkpoint = (currentStats.copyCheckpoint || {}) as {
      currentIndex?: number;
      startAfter?: string | null;
      countContinuationToken?: string | null;
      phase?: "count" | "copy";
      activeDirectory?: Record<string, any> | null;
      initialized?: boolean;
    };

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
          initialized: true,
        },
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
      const canChunkDirectory =
        isDirectoryPathHint(item.sourcePath) &&
        isDirectoryPathHint(item.targetPath) &&
        sameMount &&
        sameDriverType &&
        typeof sourceCtx?.driver?.copyDirectoryChunk === "function";
      const canChunkCrossMountDirectory =
        isDirectoryPathHint(item.sourcePath) &&
        isDirectoryPathHint(item.targetPath) &&
        !sameMount;

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
          lastError: null,
        };
        const maxObjects = getEffectiveDirectoryCopyChunkSize(directoryCopyChunkSize, activeDirectory);
        console.log(
          `[CopyTaskHandler] executeChunk directory item job=${job.jobId} index=${currentIndex} ` +
            `source=${item.sourcePath} target=${item.targetPath} configuredMaxObjects=${directoryCopyChunkSize} ` +
            `effectiveMaxObjects=${maxObjects} ` +
            `startAfter=${checkpoint.startAfter || "null"}`
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
            maxPages: 5,
          });

          const countedObjects = Number(activeDirectory.countedObjects || 0) + Number(countResult?.count || 0);
          const nextDirectory = {
            ...activeDirectory,
            phase: countResult?.done ? "copy" : "count",
            countedObjects,
            totalObjects: countedObjects,
            countPages: Number(activeDirectory.countPages || 0) + Number(countResult?.pages || 0),
            invocationLimitReachedCount:
              Number(activeDirectory.invocationLimitReachedCount || 0) + (countResult?.invocationLimitReached === true ? 1 : 0),
            lastError: countResult?.lastError || activeDirectory.lastError || null,
            errorCause: countResult?.errorCause || activeDirectory.errorCause || null,
            batchSize: maxObjects,
          };

          itemResults[currentIndex].message = countResult?.done
            ? `目录对象统计完成：共 ${countedObjects} 个对象`
            : `目录对象统计中：已统计 ${countedObjects} 个对象`;
          itemResults[currentIndex].meta = {
            ...(itemResults[currentIndex].meta || {}),
            copyDetails: nextDirectory,
          };

          await context.updateProgress(job.jobId, {
            totalItems: Math.max(Number(currentStats.totalItems || payload.items.length), payload.items.length - 1 + countedObjects),
            processedItems: baseProcessed,
            directoryProgress: buildDirectoryProgress(nextDirectory, maxObjects, currentIndex),
            itemResults,
            copyCheckpoint: {
              currentIndex,
              startAfter: null,
              countContinuationToken: countResult?.done ? null : (countResult?.nextContinuationToken || checkpoint.countContinuationToken || null),
              phase: countResult?.done ? "copy" : "count",
              activeDirectory: countResult?.done
                ? { ...nextDirectory, phase: "copy", processed: 0, success: 0, failed: 0, skipped: 0, deduped: 0, failedItems: [], lastCompletedKey: null }
                : nextDirectory,
              initialized: true,
            },
          });

          return {
            done: false,
            message: countResult?.done ? "directory count completed" : "directory count chunk",
            invocationLimitReached: countResult?.invocationLimitReached === true,
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
          resumeMode: true,
        });

        console.log(
          `[CopyTaskHandler] executeChunk directory result job=${job.jobId} index=${currentIndex} ` +
            `done=${chunkResult?.done === true} success=${Number(chunkResult?.success || 0)} ` +
            `skipped=${Number(chunkResult?.skipped || 0)} deduped=${Number(chunkResult?.deduped || 0)} ` +
            `failed=${Number(chunkResult?.failed || 0)} processed=${Number(chunkResult?.processed || 0)} ` +
            `nextStartAfter=${chunkResult?.nextStartAfter || "null"} lastCompletedKey=${chunkResult?.lastCompletedKey || "null"} ` +
            `invocationLimitReached=${chunkResult?.invocationLimitReached === true} errorCause=${chunkResult?.errorCause || "null"}`
        );

        const nextDirectory = {
          phase: "copy",
          success: Number(activeDirectory.success || 0) + Number(chunkResult?.success || 0),
          failed: Number(activeDirectory.failed || 0) + Number(chunkResult?.failed || 0),
          skipped: Number(activeDirectory.skipped || 0) + Number(chunkResult?.skipped || 0),
          deduped: Number(activeDirectory.deduped || 0) + Number(chunkResult?.deduped || 0),
          processed: Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0),
          countedObjects: Number(activeDirectory.countedObjects || activeDirectory.totalObjects || 0),
          totalObjects: Number(activeDirectory.totalObjects || activeDirectory.countedObjects || 0) > 0
            ? Number(activeDirectory.totalObjects || activeDirectory.countedObjects || 0)
            : Math.max(
                Number(activeDirectory.totalObjects || 0),
                Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0) + (chunkResult?.done ? 0 : maxObjects),
              ),
          failedItems: appendLimitedFailedItems(activeDirectory.failedItems, chunkResult?.failedItems),
          invocationLimitReachedCount:
            Number(activeDirectory.invocationLimitReachedCount || 0) + (chunkResult?.invocationLimitReached === true ? 1 : 0),
          lastCompletedKey: chunkResult?.lastCompletedKey || activeDirectory.lastCompletedKey || null,
          lastError: chunkResult?.lastError || activeDirectory.lastError || null,
          errorCause: chunkResult?.errorCause || activeDirectory.errorCause || null,
          batchSize: maxObjects,
          currentBatch: Math.max(1, Math.ceil((Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0)) / Math.max(1, maxObjects))),
        };
        const directoryProgress = buildDirectoryProgress(nextDirectory, maxObjects, currentIndex);

        const nextTotalItems = Math.max(Number(currentStats.totalItems || payload.items.length), payload.items.length - 1 + nextDirectory.totalObjects);

        itemResults[currentIndex].message = chunkResult?.done
          ? `目录复制完成：成功 ${nextDirectory.success}，失败 ${nextDirectory.failed}，跳过 ${nextDirectory.skipped}，已存在 ${nextDirectory.deduped}`
          : `目录复制进行中：成功 ${nextDirectory.success}，失败 ${nextDirectory.failed}，跳过 ${nextDirectory.skipped}，已存在 ${nextDirectory.deduped}`;
        itemResults[currentIndex].meta = {
          ...(itemResults[currentIndex].meta || {}),
          copyDetails: nextDirectory,
        };

        if (chunkResult?.done) {
          const itemFailed = nextDirectory.failed > 0;
          itemResults[currentIndex].status = itemFailed ? "failed" : (chunkResult?.skippedRoot ? "skipped" : "success");
          if (itemFailed) {
            itemResults[currentIndex].error = `目录复制存在 ${nextDirectory.failed} 个失败项`;
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
              currentBatch: Math.max(1, Math.ceil(nextDirectory.processed / Math.max(1, maxObjects))),
            },
            itemResults,
            copyCheckpoint: {
              currentIndex: currentIndex + 1,
              startAfter: null,
              countContinuationToken: null,
              phase: "count",
              activeDirectory: null,
              initialized: true,
            },
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
            initialized: true,
          },
        });

        return {
          done: false,
          message: "directory chunk copied",
          invocationLimitReached: chunkResult?.invocationLimitReached === true,
        };
      }

      if (canChunkCrossMountDirectory) {
        const activeDirectory = checkpoint.activeDirectory || null;
        const chunkResult = await executeCrossMountDirectoryChunk({
          fileSystem,
          item,
          job,
          userId: job.userId,
          userType: job.userType,
          activeDirectory,
          configuredChunkSize: directoryCopyChunkSize,
          options: payload.options,
        });
        const nextDirectory = chunkResult.activeDirectory || {};
        const maxObjects = Number(chunkResult.maxEntries || 1);
        const directoryProgress = buildDirectoryProgress(nextDirectory, maxObjects, currentIndex);
        const observedTotal = Math.max(
          Number(currentStats.totalItems || payload.items.length),
          payload.items.length - 1 + Number(nextDirectory.processed || 0) + (chunkResult.done ? 0 : maxObjects),
        );

        itemResults[currentIndex].message = chunkResult.done
          ? `跨存储目录复制完成：成功 ${Number(nextDirectory.success || 0)}，失败 ${Number(nextDirectory.failed || 0)}，跳过 ${Number(nextDirectory.skipped || 0)}`
          : `跨存储目录复制进行中：成功 ${Number(nextDirectory.success || 0)}，失败 ${Number(nextDirectory.failed || 0)}，跳过 ${Number(nextDirectory.skipped || 0)}`;
        itemResults[currentIndex].meta = {
          ...(itemResults[currentIndex].meta || {}),
          copyDetails: {
            ...nextDirectory,
            failedItems: Array.isArray(nextDirectory.failedItems) ? nextDirectory.failedItems.slice(0, 20) : [],
          },
        };

        if (chunkResult.done) {
          const detailSuccess = Number(nextDirectory.success || 0);
          const detailFailed = Number(nextDirectory.failed || 0);
          const detailSkipped = Number(nextDirectory.skipped || 0);
          itemResults[currentIndex].status = detailFailed > 0 ? "failed" : "success";
          itemResults[currentIndex].error = detailFailed > 0 ? nextDirectory.failedItems?.[0]?.message || `跨存储目录复制存在 ${detailFailed} 个失败项` : undefined;

          await context.updateProgress(job.jobId, {
            processedItems: baseProcessed + Math.max(1, detailSuccess + detailFailed + detailSkipped),
            totalItems: Math.max(observedTotal, payload.items.length - 1 + detailSuccess + detailFailed + detailSkipped),
            successCount: baseSuccess + detailSuccess,
            failedCount: baseFailed + detailFailed,
            skippedCount: baseSkipped + detailSkipped,
            directoryProgress: {
              ...directoryProgress,
              totalObjects: Number(nextDirectory.processed || 0),
            },
            itemResults,
            copyCheckpoint: {
              currentIndex: currentIndex + 1,
              startAfter: null,
              countContinuationToken: null,
              phase: "count",
              activeDirectory: null,
              initialized: true,
            },
          });

          return { done: currentIndex + 1 >= payload.items.length, message: "cross mount directory item completed" };
        }

        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + Number(nextDirectory.processed || 0),
          totalItems: observedTotal,
          successCount: baseSuccess + Number(nextDirectory.success || 0),
          failedCount: baseFailed + Number(nextDirectory.failed || 0),
          skippedCount: baseSkipped + Number(nextDirectory.skipped || 0),
          directoryProgress,
          itemResults,
          copyCheckpoint: {
            currentIndex,
            startAfter: null,
            countContinuationToken: null,
            phase: "copy",
            activeDirectory: nextDirectory,
            initialized: true,
          },
        });

        return {
          done: false,
          message: "cross mount directory chunk copied",
          invocationLimitReached: chunkResult.invocationLimitReached === true,
        };
      }

      const copyResult = await fileSystem.copyItem(item.sourcePath, item.targetPath, job.userId, job.userType, {
        ...payload.options,
        maxDirectoryCopyObjects: directoryCopyChunkSize,
      });

      const resultStatus = (copyResult?.status as string) || "success";
      if (resultStatus === "skipped" || copyResult?.skipped === true) {
        itemResults[currentIndex].status = "skipped";
        itemResults[currentIndex].message = copyResult?.message || "已跳过";
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + 1,
          successCount: baseSuccess,
          failedCount: baseFailed,
          skippedCount: baseSkipped + 1,
          itemResults,
          copyCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true },
        });
      } else if (resultStatus === "failed") {
        const details = copyResult?.stats || {};
        const detailSuccess = Number(details?.success || 0);
        const detailFailed = Number(details?.failed || 0);
        const detailSkipped = Number(details?.skipped || 0);
        const failedItems = Array.isArray(copyResult?.details) ? copyResult.details : [];
        const firstFailure = failedItems[0]?.message || failedItems[0]?.error || null;
        itemResults[currentIndex].status = "failed";
        itemResults[currentIndex].error = firstFailure || copyResult?.message || copyResult?.error || "复制失败";
        itemResults[currentIndex].meta = {
          ...(itemResults[currentIndex].meta || {}),
          copyDetails: {
            ...details,
            failedItems: failedItems.slice(0, 20),
          },
        };
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + Math.max(1, detailSuccess + detailFailed + detailSkipped),
          totalItems: Math.max(Number(currentStats.totalItems || payload.items.length), payload.items.length - 1 + detailSuccess + detailFailed + detailSkipped),
          successCount: baseSuccess + detailSuccess,
          failedCount: baseFailed + Math.max(1, detailFailed),
          skippedCount: baseSkipped + detailSkipped,
          itemResults,
          copyCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true },
        });
      } else if (resultStatus === "partial") {
        const details = copyResult?.stats || copyResult?.details || {};
        const detailSuccess = Number(details?.success || 0);
        const detailFailed = Number(details?.failed || 0);
        const detailSkipped = Number(details?.skipped || 0);
        const failedItems = Array.isArray(copyResult?.details) ? copyResult.details : [];
        itemResults[currentIndex].status = detailFailed > 0 ? "failed" : "success";
        itemResults[currentIndex].message = copyResult?.message || "部分完成";
        itemResults[currentIndex].error = detailFailed > 0 ? failedItems[0]?.message || `复制存在 ${detailFailed} 个失败项` : undefined;
        itemResults[currentIndex].meta = {
          ...(itemResults[currentIndex].meta || {}),
          copyDetails: {
            ...details,
            failedItems: failedItems.slice(0, 20),
          },
        };
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + detailSuccess + detailFailed + detailSkipped,
          totalItems: Math.max(Number(currentStats.totalItems || payload.items.length), payload.items.length - 1 + detailSuccess + detailFailed + detailSkipped),
          successCount: baseSuccess + detailSuccess,
          failedCount: baseFailed + detailFailed,
          skippedCount: baseSkipped + detailSkipped,
          itemResults,
          copyCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true },
        });
      } else {
        itemResults[currentIndex].status = "success";
        itemResults[currentIndex].message = copyResult?.message || "复制成功";
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + 1,
          successCount: baseSuccess + 1,
          failedCount: baseFailed,
          skippedCount: baseSkipped,
          itemResults,
          copyCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true },
        });
      }

      return { done: currentIndex + 1 >= payload.items.length, message: "file item copied" };
    } catch (error: any) {
      console.error(
        `[CopyTaskHandler] executeChunk failed job=${job.jobId} index=${currentIndex} ` +
          `source=${item.sourcePath} target=${item.targetPath}`,
        error
      );
      const canRetry = isRetryableError(error);
      if (canRetry) {
        throw error;
      }

      const errorSummary = summarizeTaskError(error);
      const causeText = errorSummary.cause && errorSummary.cause !== errorSummary.message ? `；原因：${errorSummary.cause}` : "";
      itemResults[currentIndex].status = "failed";
      itemResults[currentIndex].error = `${errorSummary.message}${causeText} [不可重试错误]`;
      itemResults[currentIndex].meta = {
        ...(itemResults[currentIndex].meta || {}),
        lastError: errorSummary,
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
          initialized: true,
        },
      });
      return { done: currentIndex + 1 >= payload.items.length, message: "item failed" };
    }
  }

  /** 执行复制任务 - 预扫描文件大小 → 逐项复制 + 支持重试和取消 */
  async execute(job: InternalJob, context: ExecutionContext): Promise<void> {
    const payload = job.payload as CopyTaskPayload;
    const fileSystem = context.getFileSystem();

    // 通过 ExecutionContext 获取运行时环境，用于区分 Cloudflare Workers (D1/Workflows) 与本地 SQLite (Docker/Node)
    // 只有在 Workers 环境下才开启进度上报节流，Docker 部署仍保持细粒度进度反馈
    const env = typeof context.getEnv === "function" ? context.getEnv() : null;
    const isWorkersEnv = !!env && (Object.prototype.hasOwnProperty.call(env, "DB") || Object.prototype.hasOwnProperty.call(env, "JOB_WORKFLOW"));
    const resolvedDirectoryCopyChunkSize = await resolveDirectoryCopyChunkSize(fileSystem, payload);
    const directoryCopyObjectLimit = isWorkersEnv
      ? resolvedDirectoryCopyChunkSize
      : payload.options?.maxDirectoryCopyObjects;

    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let totalBytesTransferred = 0; // 累计已传输字节
    let totalItemsObserved = payload.items.length;

    console.log(`[CopyTaskHandler] 开始执行作业 ${job.jobId}, 共 ${payload.items.length} 项`);

    // 预扫描所有源文件，获取 totalBytes 和每个文件大小（并发执行）
    const prescanConcurrency = isWorkersEnv ? PRESCAN_CONCURRENCY_WORKERS : PRESCAN_CONCURRENCY_DOCKER;

    const fileSizes: number[] = new Array(payload.items.length).fill(0);

    // 批量并发预扫描
    for (let batchStart = 0; batchStart < payload.items.length; batchStart += prescanConcurrency) {
      const batchEnd = Math.min(batchStart + prescanConcurrency, payload.items.length);
      const batchPromises: Promise<void>[] = [];

      for (let i = batchStart; i < batchEnd; i++) {
        const item = payload.items[i];

        // 目录跳过
        if (item.sourcePath.endsWith("/")) {
          continue;
        }

        const scanPromise = (async () => {
          try {
            const fileInfo = await fileSystem.getFileInfo(item.sourcePath, job.userId, job.userType);
            fileSizes[i] = fileInfo?.size || 0;
          } catch (error) {
            console.warn(`[CopyTaskHandler] 无法获取文件大小: ${item.sourcePath}`, error);
          }
        })();

        batchPromises.push(scanPromise);
      }

      await Promise.all(batchPromises);
    }

    const totalBytes = fileSizes.reduce((sum, size) => sum + size, 0);

    // 初始化每个文件的状态跟踪数组（包含文件大小）
    const itemResults: ItemResult[] = payload.items.map((item, index) => ({
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
      status: "pending" as const,
      fileSize: fileSizes[index],
    }));

    await context.updateProgress(job.jobId, { totalBytes, itemResults });

    console.log(`[CopyTaskHandler] 预扫描完成，总大小: ${totalBytes} 字节`);

    // 获取重试策略
    const retryPolicy: RetryPolicy = payload.options?.retryPolicy || DEFAULT_RETRY_POLICY;
    console.log(`[CopyTaskHandler] 重试策略: limit=${retryPolicy.limit}, delay=${retryPolicy.delay}ms, backoff=${retryPolicy.backoff}`);

    // 为每个文件计算进度上报的最小步长和最近一次上报的字节数（仅在 Workers 环境下会使用）
    const lastReportedBytesPerItem: number[] = new Array(payload.items.length).fill(0);
    const progressStepPerItem: number[] = fileSizes.map((size) => {
      if (!size || size <= 0) {
        return DEFAULT_PROGRESS_BYTES_STEP;
      }
      const step = Math.ceil(size / MAX_PROGRESS_UPDATES_PER_ITEM);
      return Math.max(step, DEFAULT_PROGRESS_BYTES_STEP);
    });

    // Docker 环境：基于时间间隔的进度节流，避免高频写入 SQLite
    let lastDockerProgressTime = 0;

    // 计算单个作业内的复制并发数
    const userMaxConcurrency = payload.options?.maxConcurrency;
    let jobConcurrency = Number(userMaxConcurrency);
    if (!Number.isFinite(jobConcurrency) || jobConcurrency <= 0) {
      jobConcurrency = 2;
    }
    jobConcurrency = Math.min(Math.max(jobConcurrency, 1), 32);

    console.log(`[CopyTaskHandler] 作业内复制并发数: ${jobConcurrency} (isWorkersEnv=${isWorkersEnv})`);

    const processItem = async (i: number): Promise<void> => {
      const item = payload.items[i];

      // 检查取消状态（避免在 Job 已被取消时继续处理新文件）
      if (await context.isCancelled(job.jobId)) {
        console.log(`[CopyTaskHandler] 作业 ${job.jobId} 已取消, 跳过剩余项 (当前索引 ${i + 1}/${payload.items.length})`);
        return;
      }

      // 单文件重试循环
      let lastError: Error | null = null;
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

          // 重试前再次检查取消
          if (await context.isCancelled(job.jobId)) {
            console.log(`[CopyTaskHandler] 作业 ${job.jobId} 在重试等待期间被取消`);
            return;
          }
        }

        itemResults[i].status = attempt > 0 ? "retrying" : "processing";
        currentFileBytes = 0;

        try {
          // 调用 FileSystem.copyItem() - 自动选择同存储原子复制或跨存储流式复制
          const copyResult = await fileSystem.copyItem(item.sourcePath, item.targetPath, job.userId, job.userType, {
            ...payload.options,
            maxDirectoryCopyObjects: directoryCopyObjectLimit,
            onProgress: (bytesTransferred: number) => {
              currentFileBytes = bytesTransferred;
              itemResults[i].bytesTransferred = bytesTransferred;
              const absoluteBytes = totalBytesTransferred + currentFileBytes;

              // Docker/Node.js 环境：按时间间隔节流
              if (!isWorkersEnv) {
                const now = Date.now();
                if (now - lastDockerProgressTime >= DOCKER_PROGRESS_INTERVAL_MS) {
                  lastDockerProgressTime = now;
                  context
                    .updateProgress(job.jobId, {
                      bytesTransferred: absoluteBytes,
                      itemResults,
                    })
                    .catch(() => {});
                }
                return;
              }

              // Cloudflare Workers 环境：按字节步长节流进度上报，减少 D1 子请求次数
              const lastReported = lastReportedBytesPerItem[i];
              const step = progressStepPerItem[i];
              if (absoluteBytes - lastReported >= step) {
                lastReportedBytesPerItem[i] = absoluteBytes;
                context
                  .updateProgress(job.jobId, {
                    bytesTransferred: absoluteBytes,
                    itemResults,
                  })
                  .catch(() => {});
              }
            },
          });

          const resultStatus = (copyResult?.status as string) || "success";
          const isSkipped = resultStatus === "skipped" || copyResult?.skipped === true;
          const copyDetails = copyResult?.details || null;
          const detailSuccess = Number(copyDetails?.success || 0);
          const detailFailed = Number(copyDetails?.failed || 0);
          const detailSkipped = Number(copyDetails?.skipped || 0);
          const detailTotal = Number(copyDetails?.total || (detailSuccess + detailFailed + detailSkipped) || 0);

          if (isSkipped) {
            // 驱动显式表示跳过：不计入失败，但标记为 skipped
            fileSkipped = true;
            // 记录跳过原因，供前端展示（不影响任务最终状态）
            // - 优先使用驱动返回的 message/error
            // - 否则给一个可读的默认原因（最常见是 skipExisting 导致）
            const skipReason =
              copyResult?.message ||
              copyResult?.error ||
              (payload.options?.skipExisting
                ? "目标已存在，已按“跳过已存在文件”设置跳过"
                : "已跳过");
            itemResults[i].message = String(skipReason);
          } else if (resultStatus === "failed") {
            // 驱动显式表示失败：抛出错误触发重试/失败分支，并保留 message 供上层使用
            const reason = copyResult?.message || copyResult?.error || "复制失败";
            throw new Error(reason);
          } else if (resultStatus === "partial") {
            // 目录递归内部部分成功：记录明细，最终任务应显示为 partial
            const summary = copyResult?.message || `部分完成：成功 ${detailSuccess}，失败 ${detailFailed}，跳过 ${detailSkipped}`;
            itemResults[i].message = String(summary);
            itemResults[i].error = detailFailed > 0 ? `递归复制存在 ${detailFailed} 个失败项` : undefined;
            itemResults[i].bytesTransferred = copyResult?.contentLength || currentFileBytes || 0;
            itemResults[i].meta = {
              ...(itemResults[i].meta || {}),
              copyDetails,
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
            // 视为成功：累计字节数并记录传输进度
            const fileBytes = copyResult?.contentLength || currentFileBytes || 0;
            totalBytesTransferred += fileBytes;
            itemResults[i].bytesTransferred = fileBytes;
            fileSuccess = true;
          }

          itemResults[i].retryCount = attempt;
          break;
        } catch (error: any) {
          lastError = error;

          const canRetry = isRetryableError(error);
          const hasMoreRetries = attempt < retryPolicy.limit;

          if (!canRetry || !hasMoreRetries) {
            const retryInfo = attempt > 0 ? ` (已重试 ${attempt}/${retryPolicy.limit} 次)` : "";
            const retryableInfo = !canRetry ? " [不可重试错误]" : "";
            const causeInfo =
              error?.details?.cause && error.details.cause !== error.message
                ? `；原因：${error.details.cause}`
                : "";

            itemResults[i].status = "failed";
            itemResults[i].error = `${error.message || String(error)}${causeInfo}${retryInfo}${retryableInfo}`;
            itemResults[i].retryCount = attempt;

            console.error(
              `[CopyTaskHandler] 复制最终失败 [${i + 1}/${payload.items.length}]${retryInfo}${retryableInfo} ` +
                `${item.sourcePath} → ${item.targetPath}: ${error.message || error}`
            );

            break;
          }

          console.warn(
            `[CopyTaskHandler] 复制失败 [${i + 1}/${payload.items.length}] (尝试 ${attempt + 1}/${retryPolicy.limit + 1}) ` +
              `${item.sourcePath}: ${error.message || error} [将重试]`
          );
        }
      }

      // 更新最终状态
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
        if (retryCount !== undefined && retryCount > 0) {
          console.log(`[CopyTaskHandler] ✓ 复制成功 (经 ${retryCount} 次重试) ${item.sourcePath}`);
        }
      } else {
        failedCount++;
      }

      // 更新进度
      await context.updateProgress(job.jobId, {
        processedItems: successCount + failedCount + skippedCount,
        totalItems: totalItemsObserved,
        successCount,
        failedCount,
        skippedCount,
        bytesTransferred: totalBytesTransferred,
        itemResults,
      });
    };

    // 按 jobConcurrency 进行分批并发执行，保证单个作业内不会超过配置的复制并发数
    for (let batchStart = 0; batchStart < payload.items.length; batchStart += jobConcurrency) {
      // 在启动新批次前检查是否已经取消
      if (await context.isCancelled(job.jobId)) {
        console.log(`[CopyTaskHandler] 作业 ${job.jobId} 已取消, 停止启动新的复制批次 (已处理 ~${batchStart}/${payload.items.length} 项)`);
        break;
      }

      const batchEnd = Math.min(batchStart + jobConcurrency, payload.items.length);
      const batchPromises: Promise<void>[] = [];
      for (let i = batchStart; i < batchEnd; i++) {
        batchPromises.push(processItem(i));
      }
      await Promise.all(batchPromises);
    }

    console.log(`[CopyTaskHandler] 作业 ${job.jobId} 执行完成: ` + `成功 ${successCount}, 失败 ${failedCount}, 跳过 ${skippedCount}, ` + `传输 ${totalBytesTransferred} 字节`);

    // 写操作后的缓存一致性：复制成功后主动失效目标挂载点目录缓存
    if (successCount > 0) {
      try {
        // 收敛失效粒度（更接近成熟系统的做法）：
        // - 优先使用“子路径(subPath) + 祖先目录”失效，而不是整 mount 失效
        // - 仅当无法解析 subPath 或路径数量过多时，降级为 mount 级失效（一致性优先）
        const mountDirPaths = new Map<string, Set<string>>();
        const mountFallback = new Set<string>();
        const dirtyTargetPathsByMount = new Map<string, string[]>();
        const indexStore = (() => {
          const db = fileSystem.mountManager?.db ?? null;
          return db ? new FsSearchIndexStore(db) : null;
        })();

        const toParentDir = (subPath: string): string => {
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

          // 索引增量：仅收集成功项的 targetPath，统一“收敛 + 入队”
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
            mountDirPaths.set(mountId, new Set<string>());
          }
          mountDirPaths.get(mountId)?.add(dirPath);
        }

        const MAX_PATHS_PER_MOUNT = 200;
        const mountsToLog: string[] = [];

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

        // 仅出现在“所有成功项都无法解析 subPath”的情况下
        for (const mountId of mountFallback) {
          if (mountDirPaths.has(mountId)) continue;
          invalidateFsCache({ mountId, reason: "copy-job", db: fileSystem.mountManager?.db ?? null });
          mountsToLog.push(`${mountId}(mount)`);
        }

        if (mountsToLog.length > 0) {
          console.log(`[CopyTaskHandler] 已触发目录缓存失效: ${mountsToLog.join(", ")}`);
        }

        // 索引 dirty 入队（合并阈值）：避免复制大批量文件时对 D1/SQLite 造成写入放大
        if (indexStore && dirtyTargetPathsByMount.size > 0) {
          const MAX_DIRTY_OPS_PER_MOUNT = 200;

          const ensureDirPath = (p: string): string => {
            const raw = typeof p === "string" && p ? p : "/";
            const trimmed = raw.replace(/\/+$/g, "");
            if (!trimmed || trimmed === "/") return "/";
            return `${trimmed}/`;
          };

          const parentDirPath = (p: string): string => {
            const raw = typeof p === "string" && p ? p : "/";
            const trimmed = raw.replace(/\/+$/g, "");
            if (!trimmed || trimmed === "/") return "/";
            const idx = trimmed.lastIndexOf("/");
            if (idx <= 0) return "/";
            return ensureDirPath(trimmed.slice(0, idx) || "/");
          };

          const toDirtyDirectory = (p: string): string => (p.endsWith("/") ? ensureDirPath(p) : parentDirPath(p));

          const commonDirPrefix = (dirs: string[]): string => {
            const list = Array.isArray(dirs) ? dirs.filter(Boolean) : [];
            if (list.length === 0) return "/";

            const toSegs = (dir: string) =>
              String(dir || "/")
                .replace(/^\/+|\/+$/g, "")
                .split("/")
                .filter(Boolean);

            let prefix = toSegs(list[0]);
            for (let i = 1; i < list.length; i++) {
              const segs = toSegs(list[i]);
              const next: string[] = [];
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
            } catch (err: unknown) {
              const errMessage = err instanceof Error ? err.message : String(err);
              console.warn("[CopyTaskHandler] upsertDirty 失败（已忽略）", errMessage);
            }
          }
        }
      } catch (error) {
        // 缓存失效失败不应影响作业结果；但需要日志以便排查一致性问题
        console.warn("[CopyTaskHandler] 目录缓存失效失败（已忽略）", error);
      }
    }
  }

  /** 创建统计模板 - 初始化所有项状态为 pending */
  createStatsTemplate(payload: any): TaskStats {
    const copyPayload = payload as CopyTaskPayload;

    const itemResults: ItemResult[] = copyPayload.items.map((item) => ({
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
      status: "pending" as const,
    }));

    return {
      totalItems: copyPayload.items.length,
      processedItems: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      bytesTransferred: 0,
      itemResults,
    };
  }
}

import type { TaskHandler, InternalJob, ExecutionContext } from "../TaskHandler.js";
import type { TaskStats, ItemResult } from "../types.js";
import { ValidationError } from "../../../../http/errors.js";

const DEFAULT_DELETE_OBJECT_LIMIT = 1000;
const MAX_DELETE_OBJECT_LIMIT = 1000;

type DeleteTaskPayload = {
  paths: string[];
  options?: {
    maxDirectoryDeleteObjects?: number;
  };
};

function isDirectoryPathHint(path: string | undefined): boolean {
  return typeof path === "string" && path.endsWith("/");
}

function clampChunkSize(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_DELETE_OBJECT_LIMIT;
  }
  return Math.min(Math.max(Math.floor(numeric), 1), MAX_DELETE_OBJECT_LIMIT);
}

function ensureItemResults(payload: DeleteTaskPayload, stats: TaskStats): ItemResult[] {
  const current = Array.isArray(stats.itemResults) ? stats.itemResults : [];
  return payload.paths.map((path, index) => ({
    kind: "delete",
    label: path,
    sourcePath: path,
    isDirectory: current[index]?.isDirectory ?? isDirectoryPathHint(path),
    status: current[index]?.status || "pending",
    error: current[index]?.error,
    message: current[index]?.message,
    meta: current[index]?.meta,
  }));
}

function appendLimited(existing: any[] | undefined, next: any[] | undefined, limit = 20): any[] {
  return [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(next) ? next : [])].slice(0, limit);
}

function buildOperationProgress(active: Record<string, any>, chunkSize: number, currentIndex: number, mode = "directory_delete") {
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
    invocationLimitReachedCount: Number(active.invocationLimitReachedCount || 0),
  };
}

async function resolveChunkSize(fileSystem: any, payload: DeleteTaskPayload): Promise<number> {
  if (payload.options?.maxDirectoryDeleteObjects !== undefined) {
    return clampChunkSize(payload.options.maxDirectoryDeleteObjects);
  }

  const db = fileSystem?.mountManager?.db;
  if (db && typeof db.prepare === "function") {
    try {
      const row = await db.prepare("SELECT value FROM system_settings WHERE key = ?").bind("delete_directory_chunk_size").first();
      if (row?.value !== undefined && row?.value !== null) {
        return clampChunkSize(row.value);
      }
    } catch (error) {
      console.warn("[DeleteTaskHandler] 读取 delete_directory_chunk_size 设置失败，使用默认值", error);
    }
  }

  return DEFAULT_DELETE_OBJECT_LIMIT;
}

export class DeleteTaskHandler implements TaskHandler {
  readonly taskType = "delete";

  async validate(payload: any): Promise<void> {
    if (!payload?.paths || !Array.isArray(payload.paths)) {
      throw new ValidationError("paths 必须是数组");
    }
    if (payload.paths.length === 0) {
      throw new ValidationError("paths 不能为空");
    }
    for (let i = 0; i < payload.paths.length; i += 1) {
      if (!payload.paths[i] || typeof payload.paths[i] !== "string") {
        throw new ValidationError(`paths[${i}] 必须是非空字符串`);
      }
    }
  }

  async executeChunk(job: InternalJob, context: ExecutionContext) {
    const payload = job.payload as DeleteTaskPayload;
    const fileSystem = context.getFileSystem();
    const chunkSize = await resolveChunkSize(fileSystem, payload);
    const currentStats = context.getStats ? await context.getStats(job.jobId) : job.stats;
    const itemResults = ensureItemResults(payload, currentStats);
    const checkpoint = (currentStats.deleteCheckpoint || {}) as {
      currentIndex?: number;
      startAfter?: string | null;
      activeDirectory?: Record<string, any> | null;
      initialized?: boolean;
    };

    if (!checkpoint.initialized) {
      await context.updateProgress(job.jobId, {
        totalItems: Math.max(Number(currentStats.totalItems || 0), payload.paths.length),
        itemResults,
        deleteCheckpoint: { currentIndex: 0, startAfter: null, activeDirectory: null, initialized: true },
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
      const canChunkDirectory =
        isDirectoryPathHint(path) &&
        typeof pathCtx?.driver?.deleteDirectoryChunk === "function";

      if (canChunkDirectory) {
        const activeDirectory = checkpoint.activeDirectory || {
          success: 0,
          failed: 0,
          skipped: 0,
          processed: 0,
          failedItems: [],
          invocationLimitReachedCount: 0,
          lastCompletedKey: null,
          lastError: null,
        };

        const chunkResult = await pathCtx.driver.deleteDirectoryChunk(pathCtx.subPath, {
          mount: pathCtx.mount,
          subPath: pathCtx.subPath,
          path,
          db: fileSystem.mountManager?.db,
          userIdOrInfo: job.userId,
          userType: job.userType,
          startAfter: checkpoint.startAfter || null,
          maxObjects: chunkSize,
        });

        const nextDirectory = {
          success: Number(activeDirectory.success || 0) + Number(chunkResult?.success || 0),
          failed: Number(activeDirectory.failed || 0) + Number(chunkResult?.failed || 0),
          skipped: Number(activeDirectory.skipped || 0) + Number(chunkResult?.skipped || 0),
          processed: Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0),
          totalObjects: Math.max(
            Number(activeDirectory.totalObjects || 0),
            Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0) + (chunkResult?.done ? 0 : chunkSize),
          ),
          failedItems: appendLimited(activeDirectory.failedItems, chunkResult?.failedItems),
          invocationLimitReachedCount:
            Number(activeDirectory.invocationLimitReachedCount || 0) + (chunkResult?.invocationLimitReached === true ? 1 : 0),
          lastCompletedKey: chunkResult?.lastCompletedKey || activeDirectory.lastCompletedKey || null,
          lastError: chunkResult?.lastError || activeDirectory.lastError || null,
          batchSize: chunkSize,
          currentBatch: Math.max(1, Math.ceil((Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0)) / Math.max(1, chunkSize))),
        };

        itemResults[currentIndex].message = chunkResult?.done
          ? `目录删除完成：成功 ${nextDirectory.success}，失败 ${nextDirectory.failed}，跳过 ${nextDirectory.skipped}`
          : `目录删除进行中：成功 ${nextDirectory.success}，失败 ${nextDirectory.failed}，跳过 ${nextDirectory.skipped}`;
        itemResults[currentIndex].meta = {
          ...(itemResults[currentIndex].meta || {}),
          deleteDetails: nextDirectory,
        };

        const operationProgress = buildOperationProgress(nextDirectory, chunkSize, currentIndex);
        const nextTotalItems = Math.max(Number(currentStats.totalItems || payload.paths.length), payload.paths.length);

        if (chunkResult?.done) {
          const itemFailed = nextDirectory.failed > 0;
          itemResults[currentIndex].status = itemFailed ? "failed" : (chunkResult?.skippedRoot ? "skipped" : "success");
          if (itemFailed) {
            itemResults[currentIndex].error = `目录删除存在 ${nextDirectory.failed} 个失败项`;
          }

          try {
            fileSystem.emitCacheInvalidation?.({ mount: pathCtx.mount, paths: [path], reason: "batch-remove" });
          } catch (error) {
            console.warn("[DeleteTaskHandler] 目录缓存失效失败（已忽略）", error);
          }

          await context.updateProgress(job.jobId, {
            totalItems: nextTotalItems,
            processedItems: baseProcessed + 1,
            successCount: baseSuccess + Number(chunkResult?.success || 0),
            failedCount: baseFailed + Number(chunkResult?.failed || 0),
            skippedCount: baseSkipped + Number(chunkResult?.skipped || 0),
            operationProgress: { ...operationProgress, totalObjects: nextDirectory.processed },
            itemResults,
            deleteCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true },
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
            initialized: true,
          },
        });

        return {
          done: false,
          message: "directory chunk deleted",
          invocationLimitReached: chunkResult?.invocationLimitReached === true,
        };
      }

      const result = await fileSystem.batchRemoveItems([path], job.userId, job.userType);
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      if (failed.length > 0) {
        itemResults[currentIndex].status = "failed";
        itemResults[currentIndex].error = failed[0]?.error || "删除失败";
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + 1,
          successCount: baseSuccess,
          failedCount: baseFailed + 1,
          skippedCount: baseSkipped,
          itemResults,
          deleteCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true },
        });
      } else {
        itemResults[currentIndex].status = "success";
        itemResults[currentIndex].message = "删除成功";
        await context.updateProgress(job.jobId, {
          processedItems: baseProcessed + 1,
          successCount: baseSuccess + 1,
          failedCount: baseFailed,
          skippedCount: baseSkipped,
          itemResults,
          deleteCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true },
        });
      }

      return { done: currentIndex + 1 >= payload.paths.length, message: "item deleted" };
    } catch (error: any) {
      itemResults[currentIndex].status = "failed";
      itemResults[currentIndex].error = `${error?.message || String(error || "删除失败")} [不可重试错误]`;
      await context.updateProgress(job.jobId, {
        processedItems: baseProcessed + 1,
        successCount: baseSuccess,
        failedCount: baseFailed + 1,
        skippedCount: baseSkipped,
        itemResults,
        deleteCheckpoint: { currentIndex: currentIndex + 1, startAfter: null, activeDirectory: null, initialized: true },
      });
      return { done: currentIndex + 1 >= payload.paths.length, message: "item failed" };
    }
  }

  async execute(job: InternalJob, context: ExecutionContext): Promise<void> {
    for (;;) {
      const result = await this.executeChunk(job, context);
      if (result.done) break;
    }
  }

  createStatsTemplate(payload: any): TaskStats {
    const deletePayload = payload as DeleteTaskPayload;
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
        status: "pending" as const,
      })),
    };
  }
}

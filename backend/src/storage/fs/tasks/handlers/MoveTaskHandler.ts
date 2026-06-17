import type { TaskHandler, InternalJob, ExecutionContext } from "../TaskHandler.js";
import type { TaskStats, ItemResult } from "../types.js";
import { ValidationError } from "../../../../http/errors.js";

const DEFAULT_BATCH_OBJECT_LIMIT = 10;
const MAX_BATCH_OBJECT_LIMIT = 100;
const WORKERS_COPY_PHASE_SAFE_OBJECT_LIMIT = 20;

type MoveTaskPayload = {
  items: Array<{
    sourcePath: string;
    targetPath: string;
  }>;
  options?: {
    maxDirectoryMoveObjects?: number;
    skipExisting?: boolean;
  };
};

function isDirectoryPathHint(path: string | undefined): boolean {
  return typeof path === "string" && path.endsWith("/");
}

function clampChunkSize(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_BATCH_OBJECT_LIMIT;
  return Math.min(Math.max(Math.floor(numeric), 1), MAX_BATCH_OBJECT_LIMIT);
}

function getEffectiveCopyPhaseChunkSize(configuredSize: number, activeDirectory?: Record<string, any> | null): number {
  const configured = Math.max(1, Math.floor(Number(configuredSize) || DEFAULT_BATCH_OBJECT_LIMIT));
  const limitHits = Math.max(0, Math.floor(Number(activeDirectory?.invocationLimitReachedCount || 0)));
  let effective = Math.min(configured, WORKERS_COPY_PHASE_SAFE_OBJECT_LIMIT);

  for (let i = 0; i < limitHits; i += 1) {
    effective = Math.max(1, Math.floor(effective / 2));
  }

  return Math.max(1, effective);
}

function ensureItemResults(payload: MoveTaskPayload, stats: TaskStats): ItemResult[] {
  const current = Array.isArray(stats.itemResults) ? stats.itemResults : [];
  return payload.items.map((item, index) => ({
    kind: "move",
    sourcePath: item.sourcePath,
    targetPath: item.targetPath,
    status: current[index]?.status || "pending",
    error: current[index]?.error,
    message: current[index]?.message,
    meta: current[index]?.meta,
  }));
}

function appendLimited(existing: any[] | undefined, next: any[] | undefined, limit = 20): any[] {
  return [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(next) ? next : [])].slice(0, limit);
}

function buildOperationProgress(active: Record<string, any>, chunkSize: number, currentIndex: number, phase: string) {
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
    invocationLimitReachedCount: Number(active.invocationLimitReachedCount || 0),
  };
}

async function resolveChunkSize(fileSystem: any, payload: MoveTaskPayload): Promise<number> {
  if (payload.options?.maxDirectoryMoveObjects !== undefined) {
    return clampChunkSize(payload.options.maxDirectoryMoveObjects);
  }

  const db = fileSystem?.mountManager?.db;
  if (db && typeof db.prepare === "function") {
    for (const key of ["batch_operation_chunk_size", "copy_directory_chunk_size"]) {
      try {
        const row = await db.prepare("SELECT value FROM system_settings WHERE key = ?").bind(key).first();
        if (row?.value !== undefined && row?.value !== null) return clampChunkSize(row.value);
      } catch (error) {
        console.warn(`[MoveTaskHandler] 读取 ${key} 设置失败，继续使用默认值`, error);
      }
    }
  }

  return DEFAULT_BATCH_OBJECT_LIMIT;
}

function sameMountAndDriver(sourceCtx: any, targetCtx: any): boolean {
  return sourceCtx?.mount?.id === targetCtx?.mount?.id &&
    sourceCtx?.driver?.getType?.() === targetCtx?.driver?.getType?.();
}

export class MoveTaskHandler implements TaskHandler {
  readonly taskType = "move";

  async validate(payload: any): Promise<void> {
    if (!payload?.items || !Array.isArray(payload.items)) {
      throw new ValidationError("items 必须是数组");
    }
    if (payload.items.length === 0) {
      throw new ValidationError("items 不能为空");
    }
    for (let i = 0; i < payload.items.length; i += 1) {
      const item = payload.items[i];
      if (!item?.sourcePath || typeof item.sourcePath !== "string") {
        throw new ValidationError(`items[${i}].sourcePath 必须是非空字符串`);
      }
      if (!item?.targetPath || typeof item.targetPath !== "string") {
        throw new ValidationError(`items[${i}].targetPath 必须是非空字符串`);
      }
    }
  }

  async executeChunk(job: InternalJob, context: ExecutionContext) {
    const payload = job.payload as MoveTaskPayload;
    const fileSystem = context.getFileSystem();
    const chunkSize = await resolveChunkSize(fileSystem, payload);
    const currentStats = context.getStats ? await context.getStats(job.jobId) : job.stats;
    const itemResults = ensureItemResults(payload, currentStats);
    const checkpoint = (currentStats.moveCheckpoint || {}) as {
      currentIndex?: number;
      phase?: "copy" | "delete";
      startAfter?: string | null;
      activeDirectory?: Record<string, any> | null;
      initialized?: boolean;
    };

    if (!checkpoint.initialized) {
      await context.updateProgress(job.jobId, {
        totalItems: Math.max(Number(currentStats.totalItems || 0), payload.items.length),
        itemResults,
        moveCheckpoint: { currentIndex: 0, phase: "copy", startAfter: null, activeDirectory: null, initialized: true },
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
      const canChunkDirectory =
        isDirectoryPathHint(item.sourcePath) &&
        isDirectoryPathHint(item.targetPath) &&
        sameMountAndDriver(sourceCtx, targetCtx) &&
        typeof sourceCtx?.driver?.copyDirectoryChunk === "function" &&
        typeof sourceCtx?.driver?.deleteDirectoryChunk === "function";

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
          lastCompletedKey: null,
        };

        if (phase === "copy") {
          const effectiveCopyChunkSize = getEffectiveCopyPhaseChunkSize(chunkSize, activeDirectory);
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
            maxObjects: effectiveCopyChunkSize,
            resumeMode: true,
          });

          const nextDirectory = {
            ...activeDirectory,
            phase: "copy",
            success: Number(activeDirectory.success || 0) + Number(chunkResult?.success || 0),
            failed: Number(activeDirectory.failed || 0) + Number(chunkResult?.failed || 0),
            skipped: Number(activeDirectory.skipped || 0) + Number(chunkResult?.skipped || 0),
            deduped: Number(activeDirectory.deduped || 0) + Number(chunkResult?.deduped || 0),
            processed: Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0),
            totalObjects: Math.max(
              Number(activeDirectory.totalObjects || 0),
              Number(activeDirectory.processed || 0) + Number(chunkResult?.processed || 0) + (chunkResult?.done ? 0 : effectiveCopyChunkSize),
            ),
            failedItems: appendLimited(activeDirectory.failedItems, chunkResult?.failedItems),
            invocationLimitReachedCount:
              Number(activeDirectory.invocationLimitReachedCount || 0) + (chunkResult?.invocationLimitReached === true ? 1 : 0),
            lastCompletedKey: chunkResult?.lastCompletedKey || activeDirectory.lastCompletedKey || null,
            batchSize: effectiveCopyChunkSize,
          };

          itemResults[currentIndex].message = chunkResult?.done
            ? `移动复制阶段完成：成功 ${nextDirectory.success}，失败 ${nextDirectory.failed}`
            : `移动复制阶段进行中：成功 ${nextDirectory.success}，失败 ${nextDirectory.failed}`;
          itemResults[currentIndex].meta = { ...(itemResults[currentIndex].meta || {}), moveDetails: nextDirectory };

          if (chunkResult?.done) {
            if (nextDirectory.failed > 0) {
              itemResults[currentIndex].status = "failed";
              itemResults[currentIndex].error = `移动复制阶段存在 ${nextDirectory.failed} 个失败项，已停止删除源目录`;
              await context.updateProgress(job.jobId, {
                processedItems: baseProcessed + 1,
                successCount: baseSuccess,
                failedCount: baseFailed + nextDirectory.failed,
                skippedCount: baseSkipped,
                itemResults,
                operationProgress: { ...buildOperationProgress(nextDirectory, effectiveCopyChunkSize, currentIndex, "copy"), totalObjects: nextDirectory.processed },
                moveCheckpoint: { currentIndex: currentIndex + 1, phase: "copy", startAfter: null, activeDirectory: null, initialized: true },
              });
              return { done: currentIndex + 1 >= payload.items.length, message: "move copy phase failed" };
            }

            await context.updateProgress(job.jobId, {
              operationProgress: { ...buildOperationProgress(nextDirectory, effectiveCopyChunkSize, currentIndex, "copy"), totalObjects: nextDirectory.processed },
              itemResults,
              moveCheckpoint: { currentIndex, phase: "delete", startAfter: null, activeDirectory: null, initialized: true },
            });
            return { done: false, message: "move entering delete phase" };
          }

          await context.updateProgress(job.jobId, {
            totalItems: Math.max(Number(currentStats.totalItems || payload.items.length), payload.items.length),
            successCount: baseSuccess + Number(chunkResult?.success || 0) + Number(chunkResult?.deduped || 0),
            failedCount: baseFailed + Number(chunkResult?.failed || 0),
            skippedCount: baseSkipped + Number(chunkResult?.skipped || 0),
            itemResults,
            operationProgress: buildOperationProgress(nextDirectory, effectiveCopyChunkSize, currentIndex, "copy"),
            moveCheckpoint: {
              currentIndex,
              phase: "copy",
              startAfter: chunkResult?.lastCompletedKey || chunkResult?.nextStartAfter || checkpoint.startAfter || null,
              activeDirectory: nextDirectory,
              initialized: true,
            },
          });
          return { done: false, message: "move copy chunk", invocationLimitReached: chunkResult?.invocationLimitReached === true };
        }

        const deleteActive = checkpoint.activeDirectory || {
          phase: "delete",
          success: 0,
          failed: 0,
          skipped: 0,
          processed: 0,
          failedItems: [],
          invocationLimitReachedCount: 0,
          lastCompletedKey: null,
        };
        const chunkResult = await sourceCtx.driver.deleteDirectoryChunk(sourceCtx.subPath, {
          mount: sourceCtx.mount,
          subPath: sourceCtx.subPath,
          path: item.sourcePath,
          db: fileSystem.mountManager?.db,
          userIdOrInfo: job.userId,
          userType: job.userType,
          startAfter: checkpoint.startAfter || null,
          maxObjects: chunkSize,
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
            Number(deleteActive.processed || 0) + Number(chunkResult?.processed || 0) + (chunkResult?.done ? 0 : chunkSize),
          ),
          failedItems: appendLimited(deleteActive.failedItems, chunkResult?.failedItems),
          invocationLimitReachedCount:
            Number(deleteActive.invocationLimitReachedCount || 0) + (chunkResult?.invocationLimitReached === true ? 1 : 0),
          lastCompletedKey: chunkResult?.lastCompletedKey || deleteActive.lastCompletedKey || null,
          batchSize: chunkSize,
        };

        itemResults[currentIndex].message = chunkResult?.done
          ? `移动删除源阶段完成：成功 ${nextDirectory.success}，失败 ${nextDirectory.failed}`
          : `移动删除源阶段进行中：成功 ${nextDirectory.success}，失败 ${nextDirectory.failed}`;
        itemResults[currentIndex].meta = { ...(itemResults[currentIndex].meta || {}), moveDeleteDetails: nextDirectory };

        if (chunkResult?.done) {
          const itemFailed = nextDirectory.failed > 0;
          itemResults[currentIndex].status = itemFailed ? "failed" : "success";
          if (itemFailed) itemResults[currentIndex].error = `移动删除源阶段存在 ${nextDirectory.failed} 个失败项`;

          try {
            fileSystem.emitCacheInvalidation?.({ mount: sourceCtx.mount, paths: [item.sourcePath, item.targetPath], reason: "rename" });
          } catch (error) {
            console.warn("[MoveTaskHandler] 目录缓存失效失败（已忽略）", error);
          }

          await context.updateProgress(job.jobId, {
            processedItems: baseProcessed + 1,
            successCount: baseSuccess + (itemFailed ? 0 : 1),
            failedCount: baseFailed + (itemFailed ? nextDirectory.failed : 0),
            skippedCount: baseSkipped,
            itemResults,
            operationProgress: { ...buildOperationProgress(nextDirectory, chunkSize, currentIndex, "delete"), totalObjects: nextDirectory.processed },
            moveCheckpoint: { currentIndex: currentIndex + 1, phase: "copy", startAfter: null, activeDirectory: null, initialized: true },
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
            initialized: true,
          },
        });
        return { done: false, message: "move delete chunk", invocationLimitReached: chunkResult?.invocationLimitReached === true };
      }

      await fileSystem.renameItem(item.sourcePath, item.targetPath, job.userId, job.userType);
      itemResults[currentIndex].status = "success";
      itemResults[currentIndex].message = "移动成功";
      await context.updateProgress(job.jobId, {
        processedItems: baseProcessed + 1,
        successCount: baseSuccess + 1,
        failedCount: baseFailed,
        skippedCount: baseSkipped,
        itemResults,
        moveCheckpoint: { currentIndex: currentIndex + 1, phase: "copy", startAfter: null, activeDirectory: null, initialized: true },
      });
      return { done: currentIndex + 1 >= payload.items.length, message: "item moved" };
    } catch (error: any) {
      itemResults[currentIndex].status = "failed";
      itemResults[currentIndex].error = `${error?.message || String(error || "移动失败")} [不可重试错误]`;
      await context.updateProgress(job.jobId, {
        processedItems: baseProcessed + 1,
        successCount: baseSuccess,
        failedCount: baseFailed + 1,
        skippedCount: baseSkipped,
        itemResults,
        moveCheckpoint: { currentIndex: currentIndex + 1, phase: "copy", startAfter: null, activeDirectory: null, initialized: true },
      });
      return { done: currentIndex + 1 >= payload.items.length, message: "item failed" };
    }
  }

  async execute(job: InternalJob, context: ExecutionContext): Promise<void> {
    for (;;) {
      const result = await this.executeChunk(job, context);
      if (result.done) break;
    }
  }

  createStatsTemplate(payload: any): TaskStats {
    const movePayload = payload as MoveTaskPayload;
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
        status: "pending" as const,
      })),
    };
  }
}

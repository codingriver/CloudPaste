import { ValidationError } from "../../../../http/errors.js";
import { ensureRepositoryFactory } from "../../../../utils/repositories.js";
import { FsSearchIndexStore } from "../../search/FsSearchIndexStore.js";
import { iterateListDirectoryItems } from "../../utils/listDirectoryPaging.js";
function normalizeMountRootPath(mountPath) {
  const raw = String(mountPath || "").trim();
  const collapsed = raw.replace(/\/{2,}/g, "/");
  const withoutTrailing = collapsed.replace(/\/+$/g, "") || "/";
  return withoutTrailing === "/" ? "/" : `${withoutTrailing}/`;
}
function parseModifiedMs(modified) {
  const ms = Date.parse(String(modified || ""));
  return Number.isFinite(ms) ? ms : 0;
}
function coercePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}
function tryRandomUuid() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
  }
  return `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
class FsIndexRebuildTaskHandler {
  taskType = "fs_index_rebuild";
  async validate(payload) {
    if (payload === null || typeof payload !== "object") {
      throw new ValidationError("payload \u5FC5\u987B\u662F\u5BF9\u8C61");
    }
    const mountIds = payload.mountIds;
    if (mountIds !== void 0 && mountIds !== null) {
      if (!Array.isArray(mountIds)) {
        throw new ValidationError("mountIds \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
      }
      for (let i = 0; i < mountIds.length; i++) {
        const id = mountIds[i];
        if (typeof id !== "string" || !id.trim()) {
          throw new ValidationError(`mountIds[${i}] \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
        }
      }
    }
    const options = payload.options ?? {};
    if (options && typeof options !== "object") {
      throw new ValidationError("options \u5FC5\u987B\u662F\u5BF9\u8C61");
    }
    if (options.batchSize !== void 0) {
      const n = Number(options.batchSize);
      if (!Number.isFinite(n) || n <= 0) {
        throw new ValidationError("options.batchSize \u5FC5\u987B\u662F\u6B63\u6574\u6570");
      }
    }
    if (options.maxDepth !== void 0 && options.maxDepth !== null) {
      const n = Number(options.maxDepth);
      if (!Number.isFinite(n) || n < 0) {
        throw new ValidationError("options.maxDepth \u5FC5\u987B\u662F >= 0 \u7684\u6574\u6570\u6216 null");
      }
    }
    if (options.maxMountsPerRun !== void 0 && options.maxMountsPerRun !== null) {
      const n = Number(options.maxMountsPerRun);
      if (!Number.isFinite(n) || n <= 0) {
        throw new ValidationError("options.maxMountsPerRun \u5FC5\u987B\u662F\u6B63\u6574\u6570\u6216 null");
      }
    }
  }
  createStatsTemplate(payload) {
    const mountIds = Array.isArray(payload?.mountIds) ? payload.mountIds : [];
    const total = mountIds.length > 0 ? mountIds.length : 0;
    return {
      totalItems: total,
      processedItems: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      // 复用 itemResults 以便前端任务列表可展示“每个挂载点”的结果
      itemResults: []
    };
  }
  async execute(job, context) {
    const payload = job.payload || {};
    const fileSystem = context.getFileSystem();
    const env = typeof context.getEnv === "function" ? context.getEnv() : null;
    const db = env?.DB ?? fileSystem?.mountManager?.db;
    if (!db) {
      throw new ValidationError("fs_index_rebuild: \u7F3A\u5C11 DB \u7ED1\u5B9A");
    }
    const factory = ensureRepositoryFactory(db, fileSystem?.repositoryFactory);
    const mountRepository = factory.getMountRepository();
    const allActiveMounts = await mountRepository.findAll(false);
    const requestedMountIds = Array.isArray(payload.mountIds) ? payload.mountIds.map((x) => String(x).trim()).filter(Boolean) : [];
    const mounts = requestedMountIds.length > 0 ? allActiveMounts.filter((m) => requestedMountIds.includes(String(m?.id))) : allActiveMounts;
    if (!mounts || mounts.length === 0) {
      await context.updateProgress(job.jobId, {
        totalItems: 0,
        processedItems: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        itemResults: []
      });
      return;
    }
    const options = payload.options || {};
    const batchSize = coercePositiveInt(options.batchSize, 200, 20, 1e3);
    const maxDepth = options.maxDepth === null || options.maxDepth === void 0 ? null : coercePositiveInt(options.maxDepth, 0, 0, 1e3);
    const maxMountsPerRun = options.maxMountsPerRun === null || options.maxMountsPerRun === void 0 ? null : coercePositiveInt(options.maxMountsPerRun, 1, 1, 1e4);
    const refresh = options.refresh !== false;
    const store = new FsSearchIndexStore(db);
    let processedMounts = 0;
    let successMounts = 0;
    let failedMounts = 0;
    let skippedMounts = 0;
    const itemResults = [];
    const effectiveMounts = maxMountsPerRun ? mounts.slice(0, maxMountsPerRun) : mounts;
    const truncatedMounts = mounts.length - effectiveMounts.length;
    const totalItems = effectiveMounts.length;
    console.log(
      `[FsIndexRebuildTaskHandler] \u5F00\u59CB\u6267\u884C\u4F5C\u4E1A ${job.jobId}, mounts=${effectiveMounts.length}/${mounts.length}, batchSize=${batchSize}, maxDepth=${maxDepth ?? "\u221E"}`
    );
    for (const mount of effectiveMounts) {
      const mountId = String(mount?.id || "");
      const mountPath = normalizeMountRootPath(String(mount?.mount_path || "/"));
      const mountSummary = {
        kind: "mount",
        mountId,
        mountName: mount?.name ?? null,
        mountPath,
        storageType: mount?.storage_type ?? null,
        status: "processing",
        scannedDirs: 0,
        discoveredCount: 0,
        upsertedCount: 0
      };
      itemResults.push(mountSummary);
      if (await context.isCancelled(job.jobId)) {
        console.warn(`[FsIndexRebuildTaskHandler] \u4F5C\u4E1A\u5DF2\u53D6\u6D88: ${job.jobId}`);
        if (mountId) {
          await store.markError(mountId, "\u7D22\u5F15\u91CD\u5EFA\u5DF2\u53D6\u6D88");
          mountSummary.status = "skipped";
          mountSummary.error = "cancelled";
          skippedMounts++;
          await context.updateProgress(job.jobId, {
            totalItems,
            processedItems: processedMounts,
            successCount: successMounts,
            failedCount: failedMounts,
            skippedCount: skippedMounts,
            itemResults,
            currentMountId: mountId
          });
        }
        break;
      }
      const runId = tryRandomUuid();
      const startedAt = Date.now();
      let upsertedCount = 0;
      let discoveredCount = 0;
      let scannedDirs = 0;
      let lastProgressReportAtMs = 0;
      try {
        if (!mountId) {
          throw new ValidationError("mount.id \u7F3A\u5931");
        }
        await store.markIndexing(mountId, { jobId: job.jobId });
        const queue = [{ path: mountPath, depth: 0 }];
        const pending = [];
        const seenDirs = /* @__PURE__ */ new Set();
        await context.updateProgress(job.jobId, {
          totalItems,
          processedItems: processedMounts,
          successCount: successMounts,
          failedCount: failedMounts,
          skippedCount: skippedMounts,
          itemResults,
          currentMountId: mountId,
          scannedDirs,
          upsertedCount,
          discoveredCount,
          pendingCount: pending.length
        });
        while (queue.length > 0) {
          if (await context.isCancelled(job.jobId)) {
            throw new Error("cancelled");
          }
          const current = queue.shift();
          const dirPath = current.path;
          const depth = current.depth;
          if (seenDirs.has(dirPath)) {
            continue;
          }
          seenDirs.add(dirPath);
          scannedDirs = seenDirs.size;
          for await (const item of iterateListDirectoryItems(
            fileSystem,
            dirPath,
            job.userId,
            job.userType,
            { refresh }
          )) {
            const fsPath = String(item?.path || "");
            if (!fsPath) continue;
            const isDir = Boolean(item?.isDirectory);
            discoveredCount++;
            pending.push({
              mountId,
              fsPath,
              name: String(item?.name || ""),
              isDir,
              size: Number(item?.size) || 0,
              modifiedMs: parseModifiedMs(item?.modified),
              mimetype: item?.mimetype ?? null
            });
            if (pending.length >= batchSize) {
              if (await context.isCancelled(job.jobId)) {
                throw new Error("cancelled");
              }
              await store.upsertEntries(pending, { indexRunId: runId });
              upsertedCount += pending.length;
              pending.length = 0;
            }
            if (isDir) {
              if (maxDepth !== null && depth >= maxDepth) {
                continue;
              }
              const childDir = fsPath.endsWith("/") ? fsPath : `${fsPath}/`;
              queue.push({ path: childDir, depth: depth + 1 });
            }
          }
          const nowMs = Date.now();
          const timeDue = nowMs - lastProgressReportAtMs >= 1500;
          if (seenDirs.size === 1 || seenDirs.size % 25 === 0 || timeDue) {
            lastProgressReportAtMs = nowMs;
            mountSummary.scannedDirs = scannedDirs;
            mountSummary.discoveredCount = discoveredCount;
            mountSummary.upsertedCount = upsertedCount;
            await context.updateProgress(job.jobId, {
              totalItems,
              processedItems: processedMounts,
              successCount: successMounts,
              failedCount: failedMounts,
              skippedCount: skippedMounts,
              itemResults,
              currentMountId: mountId,
              scannedDirs,
              upsertedCount,
              discoveredCount,
              pendingCount: pending.length
            });
          }
        }
        if (pending.length > 0) {
          if (await context.isCancelled(job.jobId)) {
            throw new Error("cancelled");
          }
          await store.upsertEntries(pending, { indexRunId: runId });
          upsertedCount += pending.length;
          pending.length = 0;
        }
        await store.cleanupMountByRunId(mountId, runId);
        await store.clearDirtyByMount(mountId);
        await store.markReady(mountId, Date.now());
        processedMounts++;
        successMounts++;
        mountSummary.status = "success";
        mountSummary.scannedDirs = scannedDirs;
        mountSummary.discoveredCount = discoveredCount;
        mountSummary.upsertedCount = upsertedCount;
        mountSummary.durationMs = Date.now() - startedAt;
        await context.updateProgress(job.jobId, {
          totalItems,
          processedItems: processedMounts,
          successCount: successMounts,
          failedCount: failedMounts,
          skippedCount: skippedMounts,
          itemResults,
          currentMountId: mountId,
          upsertedCount,
          discoveredCount,
          pendingCount: pending.length
        });
      } catch (error) {
        const cancelled = String(error?.message || "").toLowerCase() === "cancelled";
        const msg = cancelled ? "\u7D22\u5F15\u91CD\u5EFA\u5DF2\u53D6\u6D88" : String(error?.message || error || "unknown error");
        console.warn(
          `[FsIndexRebuildTaskHandler] mount \u91CD\u5EFA\u5931\u8D25: mountId=${mountId}, path=${mountPath}, error=${msg}`
        );
        if (mountId) {
          await store.markError(mountId, msg);
        }
        processedMounts++;
        if (cancelled) {
          skippedMounts++;
          mountSummary.status = "skipped";
          mountSummary.scannedDirs = scannedDirs;
          mountSummary.discoveredCount = discoveredCount;
          mountSummary.upsertedCount = upsertedCount;
          mountSummary.error = "cancelled";
        } else {
          failedMounts++;
          mountSummary.status = "failed";
          mountSummary.scannedDirs = scannedDirs;
          mountSummary.discoveredCount = discoveredCount;
          mountSummary.upsertedCount = upsertedCount;
          mountSummary.error = msg;
        }
        await context.updateProgress(job.jobId, {
          totalItems,
          processedItems: processedMounts,
          successCount: successMounts,
          failedCount: failedMounts,
          skippedCount: skippedMounts,
          itemResults,
          currentMountId: mountId,
          discoveredCount
        });
        if (cancelled) {
          break;
        }
        continue;
      }
    }
    console.log(
      `[FsIndexRebuildTaskHandler] \u4F5C\u4E1A\u5B8C\u6210: jobId=${job.jobId}, processed=${processedMounts}/${effectiveMounts.length}, ok=${successMounts}, failed=${failedMounts}, skipped=${skippedMounts}`
    );
    if (truncatedMounts > 0) {
      await context.updateProgress(job.jobId, {
        totalItems,
        processedItems: processedMounts,
        successCount: successMounts,
        failedCount: failedMounts,
        skippedCount: skippedMounts,
        itemResults,
        truncatedMounts
      });
    }
  }
}
export {
  FsIndexRebuildTaskHandler
};

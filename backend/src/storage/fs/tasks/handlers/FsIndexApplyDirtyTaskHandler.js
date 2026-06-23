import { ValidationError } from "../../../../http/errors.js";
import { ensureRepositoryFactory } from "../../../../utils/repositories.js";
import { FsSearchIndexStore } from "../../search/FsSearchIndexStore.js";
import { iterateListDirectoryItems } from "../../utils/listDirectoryPaging.js";
function coercePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}
function parseMaybeInt(value) {
  if (value === null || value === void 0) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}
function isDirectoryPath(fsPath) {
  return typeof fsPath === "string" && fsPath.endsWith("/");
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
function parseModifiedMs(modified) {
  const ms = Date.parse(String(modified || ""));
  return Number.isFinite(ms) ? ms : 0;
}
class FsIndexApplyDirtyTaskHandler {
  taskType = "fs_index_apply_dirty";
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
    if (options.maxItems !== void 0 && options.maxItems !== null) {
      const n = Number(options.maxItems);
      if (!Number.isFinite(n) || n <= 0) {
        throw new ValidationError("options.maxItems \u5FC5\u987B\u662F\u6B63\u6574\u6570\u6216 null");
      }
    }
    if (options.maxDepth !== void 0 && options.maxDepth !== null) {
      const n = Number(options.maxDepth);
      if (!Number.isFinite(n) || n < 0) {
        throw new ValidationError("options.maxDepth \u5FC5\u987B\u662F >=0 \u7684\u6574\u6570\u6216 null");
      }
    }
  }
  createStatsTemplate(payload) {
    const mountIds = Array.isArray(payload?.mountIds) ? payload.mountIds : [];
    return {
      totalItems: 0,
      processedItems: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      itemResults: [],
      mountsHint: mountIds.length > 0 ? mountIds.length : 0,
      totalDirtyProcessed: 0,
      totalUpserted: 0,
      totalDeleted: 0
    };
  }
  async execute(job, context) {
    const payload = job.payload || {};
    const fileSystem = context.getFileSystem();
    const env = typeof context.getEnv === "function" ? context.getEnv() : null;
    const db = env?.DB ?? fileSystem?.mountManager?.db;
    if (!db) {
      throw new ValidationError("fs_index_apply_dirty: \u7F3A\u5C11 DB \u7ED1\u5B9A");
    }
    const isWorkersEnv = !!env && (Object.prototype.hasOwnProperty.call(env, "DB") || Object.prototype.hasOwnProperty.call(env, "JOB_WORKFLOW"));
    const options = payload.options || {};
    const batchSize = coercePositiveInt(options.batchSize, isWorkersEnv ? 50 : 200, 10, 2e3);
    const maxItems = options.maxItems === null || options.maxItems === void 0 ? null : parseMaybeInt(options.maxItems);
    const rebuildDirectorySubtree = options.rebuildDirectorySubtree !== false;
    const maxDepth = options.maxDepth === null || options.maxDepth === void 0 ? null : parseMaybeInt(options.maxDepth);
    const refresh = options.refresh !== false;
    const store = new FsSearchIndexStore(db);
    const factory = ensureRepositoryFactory(db, fileSystem?.repositoryFactory);
    const mountRepository = factory.getMountRepository();
    const allMounts = await mountRepository.findAll(true);
    const mountInfoMap = new Map(
      allMounts.map((mount) => [String(mount?.id || ""), mount])
    );
    const requestedMountIds = Array.isArray(payload.mountIds) ? payload.mountIds.map((x) => String(x).trim()).filter(Boolean) : [];
    const mounts = requestedMountIds.length > 0 ? requestedMountIds : [];
    if (mounts.length === 0) {
      const resp = await db.prepare(`SELECT DISTINCT mount_id FROM fs_search_index_dirty ORDER BY mount_id ASC LIMIT 2000`).all();
      const rows = Array.isArray(resp?.results) ? resp.results : [];
      for (const r of rows) {
        const id = String(r?.mount_id || "");
        if (id) mounts.push(id);
      }
    }
    let processed = 0;
    let success = 0;
    let failed = 0;
    let skipped = 0;
    let totalUpserted = 0;
    let totalDeleted = 0;
    const itemResults = [];
    console.log(
      `[FsIndexApplyDirtyTaskHandler] \u5F00\u59CB\u6267\u884C\u4F5C\u4E1A ${job.jobId}, mounts=${mounts.length}, batchSize=${batchSize}, maxItems=${maxItems ?? "\u221E"}, rebuildDir=${rebuildDirectorySubtree}`
    );
    for (const mountId of mounts) {
      const mountStartedAt = Date.now();
      const mountInfo = mountInfoMap.get(mountId);
      const mountSummary = {
        kind: "mount",
        mountId,
        mountName: mountInfo?.name ?? null,
        mountPath: mountInfo?.mount_path ?? null,
        storageType: mountInfo?.storage_type ?? null,
        status: "processing",
        durationMs: 0,
        processedDirtyCount: 0,
        upsertedCount: 0,
        deletedCount: 0,
        skippedCount: 0,
        failedCount: 0
      };
      itemResults.push(mountSummary);
      if (await context.isCancelled(job.jobId)) {
        console.warn(`[FsIndexApplyDirtyTaskHandler] \u4F5C\u4E1A\u5DF2\u53D6\u6D88: ${job.jobId}`);
        break;
      }
      const stateMap = await store.getIndexStates([mountId]);
      const state = stateMap.get(mountId);
      if (String(state?.status || "not_ready") !== "ready") {
        skipped++;
        mountSummary.status = "skipped";
        mountSummary.error = "index_not_ready";
        mountSummary.durationMs = Date.now() - mountStartedAt;
        await context.updateProgress(job.jobId, {
          totalItems: maxItems ?? 0,
          processedItems: processed,
          successCount: success,
          failedCount: failed,
          skippedCount: skipped,
          itemResults,
          currentMountId: mountId,
          lastBatch: 0,
          totalDirtyProcessed: processed,
          totalUpserted,
          totalDeleted
        });
        continue;
      }
      while (true) {
        if (await context.isCancelled(job.jobId)) {
          console.warn(`[FsIndexApplyDirtyTaskHandler] \u4F5C\u4E1A\u5DF2\u53D6\u6D88: ${job.jobId}`);
          break;
        }
        if (maxItems !== null && processed >= maxItems) {
          break;
        }
        const remaining = maxItems !== null ? Math.max(maxItems - processed, 0) : null;
        const take = remaining !== null ? Math.max(1, Math.min(batchSize, remaining)) : batchSize;
        const rows = await store.listDirtyBatch(mountId, take);
        if (!rows || rows.length === 0) {
          break;
        }
        const consumedKeys = [];
        for (const row of rows) {
          const fsPath = String(row?.fs_path || "");
          const op = String(row?.op || "");
          const key = String(row?.dedupe_key || "");
          if (!fsPath || !key) {
            continue;
          }
          try {
            if (op === "delete") {
              if (isDirectoryPath(fsPath)) {
                await store.deleteByPathPrefix(mountId, fsPath);
              } else {
                await store.deleteEntry(mountId, fsPath);
              }
              success++;
              processed++;
              mountSummary.processedDirtyCount++;
              mountSummary.deletedCount++;
              totalDeleted++;
              consumedKeys.push(key);
              continue;
            }
            if (op !== "upsert") {
              skipped++;
              processed++;
              mountSummary.processedDirtyCount++;
              mountSummary.skippedCount++;
              consumedKeys.push(key);
              continue;
            }
            if (isDirectoryPath(fsPath) && rebuildDirectorySubtree) {
              const runId = tryRandomUuid();
              const startedDirAt = Date.now();
              const dirInfo = await fileSystem.getFileInfo(fsPath, job.userId, job.userType);
              await store.upsertEntries(
                [
                  {
                    mountId,
                    fsPath: String(dirInfo?.path || fsPath),
                    name: String(dirInfo?.name || ""),
                    isDir: true,
                    size: Number(dirInfo?.size || 0),
                    modifiedMs: parseModifiedMs(dirInfo?.modified),
                    mimetype: dirInfo?.mimetype ?? null
                  }
                ],
                { indexRunId: runId }
              );
              const queue = [{ path: fsPath, depth: 0 }];
              const pending = [];
              let upserted = 0;
              const seenDirs = /* @__PURE__ */ new Set();
              while (queue.length > 0) {
                if (await context.isCancelled(job.jobId)) {
                  throw new Error("cancelled");
                }
                const current = queue.shift();
                const dir = current.path;
                const depth = current.depth;
                if (seenDirs.has(dir)) continue;
                seenDirs.add(dir);
                for await (const item of iterateListDirectoryItems(
                  fileSystem,
                  dir,
                  job.userId,
                  job.userType,
                  { refresh }
                )) {
                  const childPath = String(item?.path || "");
                  if (!childPath) continue;
                  const isDir2 = Boolean(item?.isDirectory);
                  pending.push({
                    mountId,
                    fsPath: childPath,
                    name: String(item?.name || ""),
                    isDir: isDir2,
                    size: Number(item?.size) || 0,
                    modifiedMs: parseModifiedMs(item?.modified),
                    mimetype: item?.mimetype ?? null
                  });
                  if (pending.length >= batchSize) {
                    await store.upsertEntries(pending, { indexRunId: runId });
                    upserted += pending.length;
                    pending.length = 0;
                  }
                  if (isDir2) {
                    if (maxDepth !== null && depth >= maxDepth) continue;
                    queue.push({ path: childPath.endsWith("/") ? childPath : `${childPath}/`, depth: depth + 1 });
                  }
                }
              }
              if (pending.length > 0) {
                await store.upsertEntries(pending, { indexRunId: runId });
                upserted += pending.length;
                pending.length = 0;
              }
              await store.cleanupPrefixByRunId(mountId, fsPath, runId);
              success++;
              processed++;
              mountSummary.processedDirtyCount++;
              mountSummary.upsertedCount += upserted;
              totalUpserted += upserted;
              consumedKeys.push(key);
              itemResults.push({
                kind: "path",
                label: fsPath,
                sourcePath: fsPath,
                targetPath: "",
                status: "success",
                durationMs: Date.now() - startedDirAt,
                meta: {
                  upsertedCount: upserted
                }
              });
              continue;
            }
            const info = await fileSystem.getFileInfo(fsPath, job.userId, job.userType);
            const isDir = Boolean(info?.isDirectory);
            await store.upsertEntries(
              [
                {
                  mountId,
                  fsPath: String(info?.path || fsPath),
                  name: String(info?.name || ""),
                  isDir,
                  size: Number(info?.size || 0),
                  modifiedMs: parseModifiedMs(info?.modified),
                  mimetype: info?.mimetype ?? null
                }
              ],
              { indexRunId: null }
            );
            success++;
            processed++;
            mountSummary.processedDirtyCount++;
            mountSummary.upsertedCount++;
            totalUpserted++;
            consumedKeys.push(key);
          } catch (error) {
            const msg = String(error?.message || error || "unknown error");
            const status = error?.status || error?.statusCode || error?.response?.status;
            if (status === 404) {
              try {
                if (isDirectoryPath(fsPath)) {
                  await store.deleteByPathPrefix(mountId, fsPath);
                } else {
                  await store.deleteEntry(mountId, fsPath);
                }
                success++;
                processed++;
                mountSummary.processedDirtyCount++;
                mountSummary.deletedCount++;
                totalDeleted++;
                consumedKeys.push(key);
                continue;
              } catch (secondary) {
              }
            }
            console.warn(
              `[FsIndexApplyDirtyTaskHandler] apply failed: mountId=${mountId}, op=${op}, path=${fsPath}, error=${msg}`
            );
            failed++;
            processed++;
            mountSummary.processedDirtyCount++;
            mountSummary.failedCount++;
            itemResults.push({
              kind: "path",
              label: fsPath,
              sourcePath: fsPath,
              targetPath: "",
              status: "failed",
              error: msg
            });
          }
        }
        if (consumedKeys.length > 0) {
          await store.deleteDirtyByKeys(consumedKeys);
        }
        await context.updateProgress(job.jobId, {
          totalItems: maxItems ?? 0,
          processedItems: processed,
          successCount: success,
          failedCount: failed,
          skippedCount: skipped,
          itemResults,
          currentMountId: mountId,
          lastBatch: rows.length,
          totalDirtyProcessed: processed,
          totalUpserted,
          totalDeleted
        });
        if (rows.length < take) {
          break;
        }
      }
      if (mountSummary.status === "processing") {
        mountSummary.status = mountSummary.failedCount > 0 ? "failed" : "success";
        mountSummary.durationMs = Date.now() - mountStartedAt;
        await context.updateProgress(job.jobId, {
          totalItems: maxItems ?? 0,
          processedItems: processed,
          successCount: success,
          failedCount: failed,
          skippedCount: skipped,
          itemResults,
          currentMountId: mountId,
          lastBatch: 0,
          totalDirtyProcessed: processed,
          totalUpserted,
          totalDeleted
        });
      }
    }
    console.log(
      `[FsIndexApplyDirtyTaskHandler] \u4F5C\u4E1A\u7ED3\u675F: jobId=${job.jobId}, processed=${processed}, ok=${success}, failed=${failed}, skipped=${skipped}`
    );
  }
}
export {
  FsIndexApplyDirtyTaskHandler
};

import { api } from "@/api";
import { createGithubReleaseClient } from "./githubReleaseClient.js";
import {
  buildManifestBlob,
  compressBlob,
  createFileId,
  decryptChunk,
  decompressBlob,
  EMPTY_MANIFEST,
  encryptChunk,
  generateAesKey,
  importAesKey,
  normalizeManifest,
  readManifestFromAsset,
  saveBlob,
  sha256Base64,
} from "./manifestTransfer.js";

const normalizePath = (path) => {
  const raw = typeof path === "string" && path ? path : "/";
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  const collapsed = withLeading.replace(/\/{2,}/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/, "");
};

const normalizeDirPath = (path) => {
  const normalized = normalizePath(path);
  return normalized === "/" ? "/" : `${normalized}/`;
};

const joinPath = (...parts) => {
  const joined = parts
    .filter((part) => part != null && part !== "")
    .join("/")
    .replace(/\/{2,}/g, "/");
  return normalizePath(joined || "/");
};

const basename = (path) => {
  const normalized = normalizePath(path);
  if (normalized === "/") return "";
  return normalized.split("/").filter(Boolean).pop() || "";
};

const dirname = (path) => {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
};

const isChildPath = (candidate, parent) => {
  const child = normalizePath(candidate);
  const base = normalizePath(parent);
  return child === base || child.startsWith(`${base}/`);
};

const shouldUseAssetProxy = (clientConfig = {}) => {
  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
  const uploadBase = String(clientConfig?.uploadBase || clientConfig?.upload_base || "https://uploads.github.com").replace(/\/+$/, "");
  return isBrowser && uploadBase === "https://uploads.github.com";
};

export function createGithubReleaseEncryptedFsAdapter(context) {
  const mountPath = normalizePath(context?.mount?.mountPath || "/");
  const storageConfigId = context?.mount?.storageConfigId || context?.clientConfig?.storageId;
  let statePromise = null;

  const toManifestPath = (fsPath) => {
    const normalized = normalizePath(fsPath);
    if (normalized === mountPath) return "/";
    if (!normalized.startsWith(`${mountPath}/`)) {
      throw new Error("路径不属于当前 GitHub Release 加密挂载");
    }
    return normalizePath(normalized.slice(mountPath.length) || "/");
  };

  const toFsPath = (manifestPath) => {
    const rel = normalizePath(manifestPath);
    return rel === "/" ? mountPath : joinPath(mountPath, rel);
  };

  const loadState = async (refresh = false) => {
    if (statePromise && !refresh) return statePromise;
    statePromise = (async () => {
      const clientConfig = context.clientConfig || (await api.storage.getGithubReleaseEncryptedConfig(storageConfigId)).data;
      const revealResp = await api.storage.getStorageConfigReveal(storageConfigId, "plain");
      const token = revealResp?.data?.token || revealResp?.token || "";
      if (!token) throw new Error("GitHub Release 加密挂载缺少 GitHub token");
      const client = createGithubReleaseClient(
        clientConfig,
        token,
        shouldUseAssetProxy(clientConfig)
          ? {
              uploadAssetProxy: async ({ releaseId, name, blob, contentType }) => {
                const response = await api.storage.uploadGithubReleaseAsset(storageConfigId, {
                  releaseId,
                  name,
                  blob,
                  contentType,
                });
                return response?.data || response;
              },
              deleteAssetProxy: async (assetId) => {
                await api.storage.deleteGithubReleaseAsset(storageConfigId, assetId);
              },
            }
          : {},
      );
      const release = await client.resolveRelease();
      const assets = await client.listAssets(release.id);
      const manifestAssetName = clientConfig?.manifestAssetName || "index.manifest.json";
      const manifestAsset = assets.find((asset) => asset.name === manifestAssetName) || null;
      const manifest = normalizeManifest(await readManifestFromAsset(client, manifestAsset), storageConfigId);
      return { clientConfig, token, client, release, assets, manifest, manifestAssetName };
    })();
    return statePromise;
  };

  const uploadManifest = async (nextManifest) => {
    const state = await loadState();
    const currentManifestAsset = state.assets.find((asset) => asset.name === state.manifestAssetName) || null;
    if (currentManifestAsset?.id) {
      await state.client.deleteAsset(currentManifestAsset.id);
    }
    await state.client.uploadAsset({
      releaseId: state.release.id,
      name: state.manifestAssetName,
      blob: buildManifestBlob(nextManifest),
      contentType: "application/json",
    });
    statePromise = null;
  };

  const getEntries = async () => {
    const { manifest } = await loadState();
    return Array.isArray(manifest?.files) ? manifest.files.filter((item) => !item.deleted) : [];
  };

  const makeFileItem = (entry) => ({
    name: entry.name || basename(entry.path),
    path: toFsPath(entry.path),
    type: "file",
    isDirectory: false,
    is_dir: false,
    size: Number(entry.originalSize || 0),
    modified: entry.updatedAt || entry.createdAt || null,
    mime: entry.mime || "application/octet-stream",
    storage_type: "GITHUB_RELEASE_ENCRYPTED",
    fileId: entry.fileId,
    raw: entry,
  });

  const makeDirectoryItem = (relPath, meta = {}) => ({
    name: meta.name || basename(relPath),
    path: toFsPath(relPath),
    type: "directory",
    isDirectory: true,
    is_dir: true,
    isVirtual: false,
    size: Number.isFinite(meta.size) ? meta.size : 0,
    modified: meta.updatedAt || meta.createdAt || null,
    storage_type: "GITHUB_RELEASE_ENCRYPTED",
    raw: meta,
  });

  const listDirectory = async (fsPath, { refresh = false } = {}) => {
    if (refresh) statePromise = null;
    const dirRel = normalizePath(toManifestPath(fsPath));
    const entries = await getEntries();
    const dirs = new Map();
    const files = [];
    const prefix = dirRel === "/" ? "/" : `${dirRel}/`;

    for (const entry of entries) {
      const rel = normalizePath(entry.path);
      const isDirectoryEntry = entry.type === "directory" || entry.isDirectory === true;
      if (rel === dirRel) continue;
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      if (!rest) continue;
      const [head, ...tail] = rest.split("/");
      if (tail.length > 0) {
        const childRel = normalizePath(prefix + head);
        const current = dirs.get(childRel) || { path: childRel, name: head, size: 0, updatedAt: null };
        if (!isDirectoryEntry) current.size += Number(entry.originalSize || 0);
        if (entry.updatedAt && (!current.updatedAt || entry.updatedAt > current.updatedAt)) current.updatedAt = entry.updatedAt;
        dirs.set(childRel, current);
      } else if (isDirectoryEntry) {
        dirs.set(rel, { ...entry, path: rel, name: entry.name || head });
      } else {
        files.push(makeFileItem(entry));
      }
    }

    const items = [...Array.from(dirs.values()).map((item) => makeDirectoryItem(item.path, item)), ...files].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN");
    });

    return {
      path: normalizeDirPath(fsPath),
      type: "directory",
      isRoot: dirRel === "/",
      isVirtual: false,
      storage_type: "GITHUB_RELEASE_ENCRYPTED",
      mount_id: context?.mount?.id || null,
      items,
      meta: null,
    };
  };

  const getFileInfo = async (fsPath) => {
    const rel = normalizePath(toManifestPath(fsPath));
    const entries = await getEntries();
    const exact = entries.find((entry) => normalizePath(entry.path) === rel);
    if (exact) {
      return exact.type === "directory" || exact.isDirectory === true ? makeDirectoryItem(rel, exact) : makeFileItem(exact);
    }
    if (entries.some((entry) => isChildPath(entry.path, rel) && normalizePath(entry.path) !== rel)) {
      return makeDirectoryItem(rel, { name: basename(rel) });
    }
    throw new Error("文件不存在");
  };

  const saveManifestWithEntries = async (entries) => {
    const { manifest } = await loadState();
    const nextManifest = normalizeManifest({ ...manifest, files: entries, updatedAt: new Date().toISOString() }, storageConfigId);
    await uploadManifest(nextManifest);
    return nextManifest;
  };

  const createDirectory = async (fsPath) => {
    const rel = normalizePath(toManifestPath(fsPath));
    const entries = await getEntries();
    if (entries.some((entry) => normalizePath(entry.path) === rel)) return true;
    await saveManifestWithEntries([
      ...entries,
      {
        fileId: createFileId(),
        type: "directory",
        path: rel,
        name: basename(rel),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    return true;
  };

  const deleteEntries = async (fsPaths) => {
    const paths = fsPaths.map((path) => normalizePath(toManifestPath(path)));
    const entries = await getEntries();
    const state = await loadState();
    const deleted = [];
    const remaining = [];

    for (const entry of entries) {
      const rel = normalizePath(entry.path);
      const shouldDelete = paths.some((path) => rel === path || rel.startsWith(`${path}/`));
      if (!shouldDelete) {
        remaining.push(entry);
        continue;
      }
      deleted.push(entry);
    }

    await saveManifestWithEntries(remaining);
    for (const entry of deleted) {
      if (entry.fileId && !(entry.type === "directory" || entry.isDirectory === true)) {
        await api.storage.deleteGithubReleaseFileKey(storageConfigId, entry.fileId, { hard: true }).catch(() => null);
      }
      for (const chunk of entry.chunks || []) {
        if (chunk.assetId) {
          await state.client.deleteAsset(chunk.assetId).catch(() => null);
        }
      }
    }

    return { success: deleted.length, failed: [], deletedPaths: fsPaths };
  };

  const renameItem = async (oldFsPath, newFsPath) => {
    const oldRel = normalizePath(toManifestPath(oldFsPath));
    const newRel = normalizePath(toManifestPath(newFsPath));
    const entries = await getEntries();
    let changed = false;
    const nextEntries = entries.map((entry) => {
      const rel = normalizePath(entry.path);
      if (rel !== oldRel && !rel.startsWith(`${oldRel}/`)) return entry;
      const suffix = rel === oldRel ? "" : rel.slice(oldRel.length);
      const nextPath = normalizePath(`${newRel}${suffix}`);
      changed = true;
      return {
        ...entry,
        path: nextPath,
        name: rel === oldRel ? basename(newRel) : entry.name,
        updatedAt: new Date().toISOString(),
      };
    });
    if (!changed) throw new Error("文件不存在");
    await saveManifestWithEntries(nextEntries);
    return true;
  };

  const uploadFile = async (targetFsPath, fileOrBlob, { fileName = null, contentType = null, content = null } = {}) => {
    const name = fileName || fileOrBlob?.name || basename(targetFsPath) || "upload.bin";
    const rel = normalizePath(toManifestPath(targetFsPath));
    const state = await loadState();
    const blob =
      fileOrBlob instanceof Blob
        ? fileOrBlob
        : new Blob([content == null ? "" : String(content)], { type: contentType || "text/plain;charset=utf-8" });
    await deleteEntries([toFsPath(rel)]).catch(() => null);

    const fileId = createFileId();
    const compression = state.clientConfig?.compression || "gzip";
    const chunkSize = Math.max(1, Number(state.clientConfig?.chunkSizeMb || 64)) * 1024 * 1024;
    const chunkPrefix = state.clientConfig?.chunkAssetPrefix || "chunk__";
    const encryptedKey = await generateAesKey();
    const compressed = await compressBlob(blob, compression);
    const chunks = [];
    const totalChunks = Math.max(1, Math.ceil(compressed.size / chunkSize));

    for (let index = 0; index < totalChunks; index += 1) {
      const plainChunk = compressed.slice(index * chunkSize, Math.min(compressed.size, (index + 1) * chunkSize));
      const encrypted = await encryptChunk(plainChunk, encryptedKey.cryptoKey);
      const assetName = `${chunkPrefix}${fileId}__${String(index).padStart(6, "0")}.enc`;
      const asset = await state.client.uploadAsset({
        releaseId: state.release.id,
        name: assetName,
        blob: encrypted.blob,
        contentType: "application/octet-stream",
      });
      chunks.push({
        index,
        assetId: asset.id,
        assetName,
        size: encrypted.blob.size,
        iv: encrypted.iv,
        sha256: await sha256Base64(encrypted.blob),
        browserDownloadUrl: asset.browser_download_url,
      });
    }

    const entries = await getEntries();
    const nextEntry = {
      fileId,
      type: "file",
      path: rel,
      name,
      mime: contentType || fileOrBlob?.type || "application/octet-stream",
      originalSize: blob.size,
      compressedSize: compressed.size,
      encryptedSize: chunks.reduce((sum, chunk) => sum + chunk.size, 0),
      compression,
      encryption: "AES-GCM",
      chunkSize,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      permissions: { visibility: "private", downloadRole: "admin" },
      chunks,
    };
    await saveManifestWithEntries([...entries.filter((entry) => normalizePath(entry.path) !== rel), nextEntry]);
    await api.storage.saveGithubReleaseFileKey(storageConfigId, fileId, encryptedKey.base64);
    return { success: true, storagePath: toFsPath(rel) };
  };

  const updateFile = async (fsPath, content = "") => uploadFile(fsPath, null, { content, fileName: basename(fsPath), contentType: "text/plain;charset=utf-8" });

  const downloadFile = async (fsPath, fileName = null) => {
    const item = await getFileInfo(fsPath);
    if (item.isDirectory) throw new Error("不能下载目录");
    const entry = item.raw;
    const keyRecord = await api.storage.getGithubReleaseFileKey(storageConfigId, entry.fileId);
    const key = await importAesKey(keyRecord?.data?.encryptionKey || keyRecord?.encryptionKey);
    const state = await loadState();
    const blobs = [];
    const sortedChunks = [...(entry.chunks || [])].sort((a, b) => a.index - b.index);
    for (const chunk of sortedChunks) {
      const asset = state.assets.find((candidate) => candidate.id === chunk.assetId || candidate.name === chunk.assetName) || {
        id: chunk.assetId,
        name: chunk.assetName,
        browser_download_url: chunk.browserDownloadUrl,
      };
      const encryptedBlob = await state.client.downloadAsset(asset);
      const hash = await sha256Base64(encryptedBlob);
      if (chunk.sha256 && hash !== chunk.sha256) throw new Error(`分包校验失败: ${chunk.assetName}`);
      blobs.push(await decryptChunk(encryptedBlob, key, chunk.iv));
    }
    const merged = new Blob(blobs, { type: "application/octet-stream" });
    const restored = await decompressBlob(merged, entry.compression || "gzip");
    saveBlob(restored, fileName || item.name);
  };

  return {
    listDirectory,
    getFileInfo,
    createDirectory,
    renameItem,
    batchDeleteItems: deleteEntries,
    uploadFile,
    updateFile,
    downloadFile,
    getFileLink: async () => {
      throw new Error("GitHub Release 加密文件没有可直接访问的明文直链，请使用下载");
    },
  };
}

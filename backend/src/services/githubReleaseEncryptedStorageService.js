import { ensureRepositoryFactory } from "../utils/repositories.js";
import { NotFoundError, ValidationError } from "../http/errors.js";
import { StorageFactory } from "../storage/factory/StorageFactory.js";
import { decryptIfNeeded } from "../utils/crypto.js";

const STORAGE_TYPE = StorageFactory.SUPPORTED_TYPES.GITHUB_RELEASE_ENCRYPTED;

function normalizeNonEmptyString(value, fieldName) {
  const normalized = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  if (!normalized) {
    throw new ValidationError(`缺少必填字段: ${fieldName}`);
  }
  return normalized;
}

async function getGithubReleaseEncryptedConfig(factory, storageId, adminId, { withSecrets = false } = {}) {
  const storageRepo = factory.getStorageConfigRepository();
  const cfg = withSecrets
    ? await storageRepo.findByIdAndAdminWithSecrets(storageId, adminId)
    : await storageRepo.findByIdAndAdmin(storageId, adminId);
  if (!cfg || cfg.storage_type !== STORAGE_TYPE) {
    throw new NotFoundError("GitHub Release 加密存储库不存在");
  }
  return cfg;
}

function normalizeOptionalString(value) {
  const normalized = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return normalized || null;
}

function buildGithubHeaders(token, extra = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "CloudPaste-GithubReleaseEncrypted",
    ...extra,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function parseGithubError(response) {
  const text = await response.text().catch(() => "");
  try {
    const json = text ? JSON.parse(text) : null;
    const details = Array.isArray(json?.errors)
      ? json.errors
          .map((item) => [item.resource, item.field, item.code, item.message].filter(Boolean).join(" "))
          .filter(Boolean)
          .join("; ")
      : "";
    return [json?.message, details].filter(Boolean).join(": ") || text || `GitHub API 请求失败: ${response.status}`;
  } catch {
    return text || `GitHub API 请求失败: ${response.status}`;
  }
}

async function githubJson(url, { token, method = "GET", body = null } = {}) {
  const response = await fetch(url, {
    method,
    headers: buildGithubHeaders(token, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : null,
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new ValidationError(await parseGithubError(response));
  }
  return await response.json();
}

async function bootstrapEmptyRepository({ owner, repo, apiBase, token }) {
  if (!token) {
    throw new ValidationError("初始化空 GitHub 仓库需要 GitHub token");
  }
  await githubJson(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.cloudpaste-storage-init`, {
    token,
    method: "PUT",
    body: {
      message: "Initialize CloudPaste storage repository",
      content: "Q2xvdWRQYXN0ZSBHaXRIdWIgUmVsZWFzZSBlbmNyeXB0ZWQgc3RvcmFnZSBib290c3RyYXAuCg==",
    },
  });
}

function buildReleasePayload({ releaseTag, releaseName }) {
  const tag = normalizeOptionalString(releaseTag);
  if (!tag) {
    throw new ValidationError("初始化 GitHub Release 需要配置 release_tag");
  }
  return {
    tag_name: tag,
    name: releaseName || tag,
    body: "CloudPaste GitHub Release encrypted storage manifest and encrypted chunks.",
    draft: false,
    prerelease: false,
  };
}

async function resolveGithubRelease({ owner, repo, releaseId, releaseTag, apiBase, token }) {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  if (releaseId) {
    const byId = await githubJson(`${apiBase}/repos/${encodedOwner}/${encodedRepo}/releases/${encodeURIComponent(releaseId)}`, { token });
    if (byId) return byId;
  }
  if (releaseTag) {
    return await githubJson(`${apiBase}/repos/${encodedOwner}/${encodedRepo}/releases/tags/${encodeURIComponent(releaseTag)}`, { token });
  }
  return null;
}

async function updateStoredReleaseId(factory, cfg, releaseId) {
  if (!releaseId || String(cfg.release_id || "") === String(releaseId)) return;
  const raw = cfg.__config_json__ && typeof cfg.__config_json__ === "object" ? { ...cfg.__config_json__ } : {};
  raw.release_id = String(releaseId);
  await factory.getStorageConfigRepository().updateConfig(cfg.id, {
    config_json: JSON.stringify(raw),
  });
}

async function getInitContext(db, storageId, adminId, encryptionSecret, repositoryFactory) {
  const factory = ensureRepositoryFactory(db, repositoryFactory);
  const cfg = await getGithubReleaseEncryptedConfig(factory, storageId, adminId, { withSecrets: true });
  const owner = normalizeNonEmptyString(cfg.owner, "owner");
  const repo = normalizeNonEmptyString(cfg.repo, "repo");
  const releaseId = normalizeOptionalString(cfg.release_id);
  const releaseTag = normalizeOptionalString(cfg.release_tag);
  const apiBase = (cfg.api_base || "https://api.github.com").replace(/\/+$/, "");
  const token = await decryptIfNeeded(cfg.token, encryptionSecret);
  return { factory, cfg, owner, repo, releaseId, releaseTag, apiBase, token };
}

export async function getGithubReleaseEncryptedClientConfig(db, storageId, adminId, repositoryFactory = null) {
  const factory = ensureRepositoryFactory(db, repositoryFactory);
  const cfg = await getGithubReleaseEncryptedConfig(factory, storageId, adminId);
  const owner = normalizeNonEmptyString(cfg.owner, "owner");
  const repo = normalizeNonEmptyString(cfg.repo, "repo");

  return {
    storageId: cfg.id,
    storageType: STORAGE_TYPE,
    owner,
    repo,
    releaseId: cfg.release_id || null,
    releaseTag: cfg.release_tag || null,
    manifestAssetName: cfg.manifest_asset_name || "index.manifest.json",
    chunkAssetPrefix: cfg.chunk_asset_prefix || "chunk__",
    chunkSizeMb: Number(cfg.chunk_size_mb) > 0 ? Number(cfg.chunk_size_mb) : 64,
    compression: cfg.compression || "gzip",
    encryption: cfg.encryption || "AES-GCM",
    apiBase: cfg.api_base || "https://api.github.com",
    uploadBase: cfg.upload_base || "https://uploads.github.com",
  };
}

export async function checkGithubReleaseInitialization(db, storageId, adminId, encryptionSecret, repositoryFactory = null) {
  const ctx = await getInitContext(db, storageId, adminId, encryptionSecret, repositoryFactory);
  const release = await resolveGithubRelease(ctx);
  const initialized = Boolean(release?.id);
  if (initialized) {
    await updateStoredReleaseId(ctx.factory, ctx.cfg, release.id);
  }
  return {
    initialized,
    created: false,
    owner: ctx.owner,
    repo: ctx.repo,
    releaseId: release?.id ? String(release.id) : ctx.releaseId,
    releaseTag: release?.tag_name || ctx.releaseTag,
    manifestAssetName: ctx.cfg.manifest_asset_name || "index.manifest.json",
    message: initialized ? "GitHub Release 已初始化" : "GitHub Release 尚未初始化",
  };
}

export async function initializeGithubReleaseStorage(db, storageId, adminId, encryptionSecret, repositoryFactory = null) {
  const ctx = await getInitContext(db, storageId, adminId, encryptionSecret, repositoryFactory);
  let release = await resolveGithubRelease(ctx);
  if (release?.id) {
    await updateStoredReleaseId(ctx.factory, ctx.cfg, release.id);
    return {
      initialized: true,
      created: false,
      owner: ctx.owner,
      repo: ctx.repo,
      releaseId: String(release.id),
      releaseTag: release.tag_name || ctx.releaseTag,
      manifestAssetName: ctx.cfg.manifest_asset_name || "index.manifest.json",
      message: "GitHub Release 已初始化，无需重复创建",
    };
  }

  if (!ctx.token) {
    throw new ValidationError("初始化 GitHub Release 需要 GitHub token");
  }

  const createRelease = () =>
    githubJson(`${ctx.apiBase}/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/releases`, {
      token: ctx.token,
      method: "POST",
      body: buildReleasePayload({ releaseTag: ctx.releaseTag }),
    });

  try {
    release = await createRelease();
  } catch (error) {
    if (!String(error?.message || "").includes("Repository is empty")) {
      throw error;
    }
    await bootstrapEmptyRepository(ctx);
    release = await createRelease();
  }
  await updateStoredReleaseId(ctx.factory, ctx.cfg, release.id);

  return {
    initialized: true,
    created: true,
    owner: ctx.owner,
    repo: ctx.repo,
    releaseId: String(release.id),
    releaseTag: release.tag_name || ctx.releaseTag,
    manifestAssetName: ctx.cfg.manifest_asset_name || "index.manifest.json",
    message: "GitHub Release 初始化完成",
  };
}

export async function saveGithubReleaseFileKey(db, storageId, fileId, encryptionKey, adminId, repositoryFactory = null) {
  const factory = ensureRepositoryFactory(db, repositoryFactory);
  await getGithubReleaseEncryptedConfig(factory, storageId, adminId);

  const normalizedFileId = normalizeNonEmptyString(fileId, "fileId");
  const normalizedKey = normalizeNonEmptyString(encryptionKey, "encryptionKey");
  const repo = factory.getGithubReleaseFileKeyRepository();
  const row = await repo.upsertKey({
    storageConfigId: storageId,
    fileId: normalizedFileId,
    encryptionKey: normalizedKey,
    createdBy: adminId,
    deleted: 0,
  });

  return {
    fileId: row.file_id,
    storageId: row.storage_config_id,
    deleted: row.deleted === 1,
    updatedAt: row.updated_at,
  };
}

export async function getGithubReleaseFileKey(db, storageId, fileId, adminId, repositoryFactory = null) {
  const factory = ensureRepositoryFactory(db, repositoryFactory);
  await getGithubReleaseEncryptedConfig(factory, storageId, adminId);

  const normalizedFileId = normalizeNonEmptyString(fileId, "fileId");
  const repo = factory.getGithubReleaseFileKeyRepository();
  const row = await repo.findKey(storageId, normalizedFileId);
  if (!row) {
    throw new NotFoundError("文件密钥不存在");
  }

  return {
    fileId: row.file_id,
    storageId: row.storage_config_id,
    encryptionKey: row.encryption_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function deleteGithubReleaseFileKey(db, storageId, fileId, adminId, { hard = false } = {}, repositoryFactory = null) {
  const factory = ensureRepositoryFactory(db, repositoryFactory);
  await getGithubReleaseEncryptedConfig(factory, storageId, adminId);

  const normalizedFileId = normalizeNonEmptyString(fileId, "fileId");
  const repo = factory.getGithubReleaseFileKeyRepository();
  if (hard) {
    await repo.hardDeleteKey(storageId, normalizedFileId);
  } else {
  await repo.softDeleteKey(storageId, normalizedFileId);
  }
  return { fileId: normalizedFileId, storageId, deleted: true, hard };
}

export async function uploadGithubReleaseAssetProxy(
  db,
  storageId,
  adminId,
  encryptionSecret,
  { releaseId = null, name = null, contentType = "application/octet-stream", body = null } = {},
  repositoryFactory = null,
) {
  const ctx = await getInitContext(db, storageId, adminId, encryptionSecret, repositoryFactory);
  const assetName = normalizeNonEmptyString(name, "name");
  const resolvedReleaseId = normalizeOptionalString(releaseId) || ctx.releaseId || (await resolveGithubRelease(ctx))?.id;
  if (!resolvedReleaseId) {
    throw new ValidationError("上传 GitHub Release Asset 前需要先初始化 Release");
  }
  if (!ctx.token) {
    throw new ValidationError("上传 GitHub Release Asset 需要 GitHub token");
  }
  if (!body) {
    throw new ValidationError("上传内容不能为空");
  }

  const uploadBase = (ctx.cfg.upload_base || "https://uploads.github.com").replace(/\/+$/, "");
  const url = new URL(
    `${uploadBase}/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/releases/${encodeURIComponent(resolvedReleaseId)}/assets`,
  );
  url.searchParams.set("name", assetName);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: buildGithubHeaders(ctx.token, {
      "Content-Type": contentType || "application/octet-stream",
    }),
    body,
  });

  if (!response.ok) {
    throw new ValidationError(await parseGithubError(response));
  }

  return await response.json();
}

export async function deleteGithubReleaseAssetProxy(
  db,
  storageId,
  assetId,
  adminId,
  encryptionSecret,
  repositoryFactory = null,
) {
  const ctx = await getInitContext(db, storageId, adminId, encryptionSecret, repositoryFactory);
  const normalizedAssetId = normalizeNonEmptyString(assetId, "assetId");
  if (!ctx.token) {
    throw new ValidationError("删除 GitHub Release Asset 需要 GitHub token");
  }

  const response = await fetch(
    `${ctx.apiBase}/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/releases/assets/${encodeURIComponent(normalizedAssetId)}`,
    {
      method: "DELETE",
      headers: buildGithubHeaders(ctx.token),
    },
  );

  if (!response.ok && response.status !== 404) {
    throw new ValidationError(await parseGithubError(response));
  }

  return { assetId: normalizedAssetId, deleted: true };
}

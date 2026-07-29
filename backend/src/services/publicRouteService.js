import { ValidationError, NotFoundError } from "../http/errors.js";
import { ensureRepositoryFactory } from "../utils/repositories.js";

const RESERVED_PATHS = [
  "/",
  "/api",
  "/dav",
  "/upload",
  "/admin",
  "/paste",
  "/file",
  "/mount-explorer",
  "/assets",
  "/icons",
  "/favicon.ico",
  "/manifest.webmanifest",
  "/robots.txt",
  "/config.js",
  "/registerSW.js",
  "/sw.js",
  "/cloudpaste.svg",
  "/vite.svg",
  "/apple-touch-icon.png",
];
const TARGET_TYPES = new Set(["file", "directory"]);

function normalizePath(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${fieldName}不能为空`);
  }
  let path = value.trim().replace(/\\/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new ValidationError(`${fieldName}不能包含 . 或 .. 路径段`);
  }
  return path;
}

export function normalizePublicPath(path) {
  return normalizePath(path, "公开路径");
}

export function normalizeTargetFsPath(path) {
  return normalizePath(path, "目标路径");
}

export function isSameOrSubPath(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function validatePublicPath(path) {
  const normalized = normalizePublicPath(path);
  const conflict = RESERVED_PATHS.find((reserved) => {
    if (reserved === "/") return normalized === "/";
    return isSameOrSubPath(normalized, reserved) || isSameOrSubPath(reserved, normalized);
  });
  if (conflict) {
    throw new ValidationError(`公开路径与系统保留路径 ${conflict} 冲突`);
  }
  return normalized;
}

export function toPublicRouteDto(record) {
  if (!record) return null;
  return {
    id: record.id,
    publicPath: record.public_path,
    targetFsPath: record.target_fs_path,
    targetType: record.target_type,
    enabled: Boolean(record.enabled),
    createdBy: record.created_by,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export class PublicRouteService {
  constructor(db, repositoryFactory = null) {
    this.repositoryFactory = ensureRepositoryFactory(db, repositoryFactory);
    this.repository = this.repositoryFactory.getPublicRouteRepository();
  }

  async list(options = {}) {
    const records = await this.repository.findAll(options);
    return records.map(toPublicRouteDto);
  }

  async findById(id) {
    return toPublicRouteDto(await this.repository.findById(id));
  }

  async findByTarget(targetFsPath, targetType = null) {
    const normalizedTarget = normalizeTargetFsPath(targetFsPath);
    const record = await this.repository.findByTarget(normalizedTarget, targetType || null);
    return toPublicRouteDto(record);
  }

  async findByTargets(targetFsPaths) {
    const normalized = [...new Set((targetFsPaths || []).map(normalizeTargetFsPath))];
    const records = await this.repository.findByTargets(normalized);
    return records.map(toPublicRouteDto);
  }

  async create(input, createdBy) {
    const publicPath = validatePublicPath(input.publicPath);
    const targetFsPath = normalizeTargetFsPath(input.targetFsPath);
    const targetType = input.targetType;
    if (!TARGET_TYPES.has(targetType)) {
      throw new ValidationError("目标类型必须是 file 或 directory");
    }
    const publicConflict = await this.repository.findByPublicPath(publicPath);
    if (publicConflict) throw new ValidationError("公开路径已被使用");
    const targetConflict = await this.repository.findByTarget(targetFsPath, targetType);
    if (targetConflict) throw new ValidationError("该文件或文件夹已经存在公开路由");

    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return toPublicRouteDto(await this.repository.create({
      id,
      publicPath,
      targetFsPath,
      targetType,
      enabled: input.enabled !== false,
      createdBy,
    }));
  }

  async update(id, input) {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundError("公开路由不存在");

    const updates = {};
    if (input.publicPath !== undefined) {
      updates.publicPath = validatePublicPath(input.publicPath);
      const conflict = await this.repository.findByPublicPath(updates.publicPath);
      if (conflict && conflict.id !== id) throw new ValidationError("公开路径已被使用");
    }
    if (input.targetFsPath !== undefined) updates.targetFsPath = normalizeTargetFsPath(input.targetFsPath);
    if (input.targetType !== undefined) {
      if (!TARGET_TYPES.has(input.targetType)) throw new ValidationError("目标类型必须是 file 或 directory");
      updates.targetType = input.targetType;
    }
    if (input.enabled !== undefined) updates.enabled = Boolean(input.enabled);

    const nextTargetPath = updates.targetFsPath ?? existing.target_fs_path;
    const nextTargetType = updates.targetType ?? existing.target_type;
    if (nextTargetPath !== existing.target_fs_path || nextTargetType !== existing.target_type) {
      const conflict = await this.repository.findByTarget(nextTargetPath, nextTargetType);
      if (conflict && conflict.id !== id) throw new ValidationError("该文件或文件夹已经存在公开路由");
    }
    return toPublicRouteDto(await this.repository.update(id, updates));
  }

  async delete(id) {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundError("公开路由不存在");
    await this.repository.delete(id);
  }

  async bulkSetEnabled(ids, enabled) {
    if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError("请选择公开路由");
    return await this.repository.bulkSetEnabled(ids, Boolean(enabled));
  }

  async bulkDelete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError("请选择公开路由");
    return await this.repository.bulkDelete(ids);
  }

  async resolve(requestPath) {
    const normalizedRequestPath = normalizePublicPath(requestPath);
    const candidates = await this.repository.findEnabledCandidates(normalizedRequestPath);
    for (const record of candidates) {
      if (record.target_type === "file" && record.public_path === normalizedRequestPath) {
        return { route: toPublicRouteDto(record), fsPath: record.target_fs_path };
      }
      if (record.target_type === "directory" && isSameOrSubPath(normalizedRequestPath, record.public_path)) {
        const relativePath = normalizedRequestPath === record.public_path
          ? "index.html"
          : normalizedRequestPath.slice(record.public_path.length + 1);
        const base = record.target_fs_path === "/" ? "" : record.target_fs_path;
        return { route: toPublicRouteDto(record), fsPath: `${base}/${relativePath}` };
      }
    }
    return null;
  }
}

export const PUBLIC_ROUTE_RESERVED_PATHS = [...RESERVED_PATHS];

import { Hono } from "hono";
import { UserType } from "../constants/index.js";
import { NotFoundError, ValidationError } from "../http/errors.js";
import { usePolicy } from "../security/policies/policies.js";
import { resolvePrincipal } from "../security/helpers/principal.js";
import { PublicRouteService, normalizeTargetFsPath } from "../services/publicRouteService.js";
import { MountManager } from "../storage/managers/MountManager.js";
import { FileSystem } from "../storage/fs/FileSystem.js";
import { getEncryptionSecret } from "../utils/environmentUtils.js";
import { jsonCreated, jsonOk } from "../utils/common.js";

const publicRouteRoutes = new Hono();
const requireAdmin = usePolicy("admin.all");

const serviceFor = (c) => new PublicRouteService(c.env.DB, c.get("repos"));

export async function assertPublicRouteTargetExists(c, targetFsPath, targetType, resolveFileInfo = null) {
  if (!targetFsPath || !targetType) return;
  if (targetType !== "file" && targetType !== "directory") return;

  const normalizedPath = normalizeTargetFsPath(targetFsPath);
  let info = null;
  if (typeof resolveFileInfo === "function") {
    info = await resolveFileInfo(normalizedPath, targetType);
  } else {
    const principal = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
    const mountManager = new MountManager(c.env.DB, getEncryptionSecret(c), c.get("repos"), { env: c.env });
    const fileSystem = new FileSystem(mountManager, c.env);
    info = await fileSystem.getFileInfo(normalizedPath, principal.userId, UserType.ADMIN, c.req.raw);
  }
  if (!info) throw new NotFoundError("目标路径不存在");
  const actualType = info?.isDirectory ? "directory" : "file";
  if (actualType !== targetType) {
    throw new ValidationError(`目标路径类型不匹配：实际为${actualType === "directory" ? "文件夹" : "文件"}`);
  }
}

publicRouteRoutes.get("/api/admin/public-routes", requireAdmin, async (c) => {
  const enabledQuery = c.req.query("enabled");
  const enabled = enabledQuery === undefined ? null : enabledQuery === "true" || enabledQuery === "1";
  const data = await serviceFor(c).list({ search: c.req.query("search") || "", enabled });
  return jsonOk(c, data, "获取公开路由成功");
});

publicRouteRoutes.get("/api/admin/public-routes/status", requireAdmin, async (c) => {
  const targetFsPath = c.req.query("targetFsPath");
  const targetType = c.req.query("targetType") || null;
  if (!targetFsPath) throw new ValidationError("targetFsPath 不能为空");
  const data = await serviceFor(c).findByTarget(targetFsPath, targetType);
  return jsonOk(c, data, "获取公开状态成功");
});

publicRouteRoutes.post("/api/admin/public-routes/status/batch", requireAdmin, async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body?.targetFsPaths)) throw new ValidationError("targetFsPaths 必须是数组");
  const data = await serviceFor(c).findByTargets(body.targetFsPaths);
  return jsonOk(c, data, "批量获取公开状态成功");
});

publicRouteRoutes.post("/api/admin/public-routes", requireAdmin, async (c) => {
  const principal = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
  const body = await c.req.json();
  await assertPublicRouteTargetExists(c, body?.targetFsPath, body?.targetType);
  const data = await serviceFor(c).create(body, principal.userId);
  return jsonCreated(c, data, "公开路由创建成功");
});

publicRouteRoutes.put("/api/admin/public-routes/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const service = serviceFor(c);
  if (body?.targetFsPath !== undefined || body?.targetType !== undefined) {
    const existing = await service.findById(id);
    if (!existing) throw new NotFoundError("公开路由不存在");
    await assertPublicRouteTargetExists(
      c,
      body.targetFsPath ?? existing.targetFsPath,
      body.targetType ?? existing.targetType,
    );
  }
  const data = await service.update(id, body);
  return jsonOk(c, data, "公开路由更新成功");
});

publicRouteRoutes.delete("/api/admin/public-routes/:id", requireAdmin, async (c) => {
  await serviceFor(c).delete(c.req.param("id"));
  return jsonOk(c, undefined, "公开路由删除成功");
});

publicRouteRoutes.post("/api/admin/public-routes/bulk/enable", requireAdmin, async (c) => {
  const body = await c.req.json();
  const result = await serviceFor(c).bulkSetEnabled(body?.ids, true);
  return jsonOk(c, { changes: result?.changes ?? result?.meta?.changes ?? 0 }, "批量启用成功");
});

publicRouteRoutes.post("/api/admin/public-routes/bulk/disable", requireAdmin, async (c) => {
  const body = await c.req.json();
  const result = await serviceFor(c).bulkSetEnabled(body?.ids, false);
  return jsonOk(c, { changes: result?.changes ?? result?.meta?.changes ?? 0 }, "批量关闭成功");
});

publicRouteRoutes.post("/api/admin/public-routes/bulk/delete", requireAdmin, async (c) => {
  const body = await c.req.json();
  const result = await serviceFor(c).bulkDelete(body?.ids);
  return jsonOk(c, { changes: result?.changes ?? result?.meta?.changes ?? 0 }, "批量删除成功");
});

export default publicRouteRoutes;

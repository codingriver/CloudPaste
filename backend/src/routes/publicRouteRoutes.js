import { Hono } from "hono";
import { UserType } from "../constants/index.js";
import { ValidationError } from "../http/errors.js";
import { usePolicy } from "../security/policies/policies.js";
import { resolvePrincipal } from "../security/helpers/principal.js";
import { PublicRouteService } from "../services/publicRouteService.js";
import { jsonCreated, jsonOk } from "../utils/common.js";

const publicRouteRoutes = new Hono();
const requireAdmin = usePolicy("admin.all");

const serviceFor = (c) => new PublicRouteService(c.env.DB, c.get("repos"));

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
  const data = await serviceFor(c).create(await c.req.json(), principal.userId);
  return jsonCreated(c, data, "公开路由创建成功");
});

publicRouteRoutes.put("/api/admin/public-routes/:id", requireAdmin, async (c) => {
  const data = await serviceFor(c).update(c.req.param("id"), await c.req.json());
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

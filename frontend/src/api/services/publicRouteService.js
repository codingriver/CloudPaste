import { get, post, put, del } from "../client.js";

export const unwrapData = (response) =>
  response && typeof response === "object" && Object.prototype.hasOwnProperty.call(response, "data")
    ? response.data
    : response;

export async function listPublicRoutes(params = {}) {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.enabled !== undefined && params.enabled !== null) query.set("enabled", String(params.enabled));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return unwrapData(await get(`/admin/public-routes${suffix}`));
}

export async function getPublicRouteStatus(targetFsPath, targetType = null) {
  const query = new URLSearchParams({ targetFsPath });
  if (targetType) query.set("targetType", targetType);
  return unwrapData(await get(`/admin/public-routes/status?${query.toString()}`));
}

export async function getPublicRouteStatusBatch(targetFsPaths) {
  return unwrapData(await post("/admin/public-routes/status/batch", { targetFsPaths }));
}

export async function createPublicRoute(data) {
  return unwrapData(await post("/admin/public-routes", data));
}

export async function updatePublicRoute(id, data) {
  return unwrapData(await put(`/admin/public-routes/${id}`, data));
}

export async function deletePublicRoute(id) {
  return unwrapData(await del(`/admin/public-routes/${id}`));
}

export async function bulkEnablePublicRoutes(ids) {
  return unwrapData(await post("/admin/public-routes/bulk/enable", { ids }));
}

export async function bulkDisablePublicRoutes(ids) {
  return unwrapData(await post("/admin/public-routes/bulk/disable", { ids }));
}

export async function bulkDeletePublicRoutes(ids) {
  return unwrapData(await post("/admin/public-routes/bulk/delete", { ids }));
}

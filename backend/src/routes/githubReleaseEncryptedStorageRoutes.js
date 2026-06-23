import { Hono } from "hono";
import { UserType } from "../constants/index.js";
import { jsonOk, jsonCreated, getQueryBool } from "../utils/common.js";
import { usePolicy } from "../security/policies/policies.js";
import { resolvePrincipal } from "../security/helpers/principal.js";
import { useRepositories } from "../utils/repositories.js";
import {
  checkGithubReleaseInitialization,
  deleteGithubReleaseAssetProxy,
  deleteGithubReleaseFileKey,
  getGithubReleaseEncryptedClientConfig,
  getGithubReleaseFileKey,
  initializeGithubReleaseStorage,
  saveGithubReleaseFileKey,
  uploadGithubReleaseAssetProxy,
} from "../services/githubReleaseEncryptedStorageService.js";

const routes = new Hono();
const requireAdmin = usePolicy("admin.all");

routes.get("/api/storage/:storageId/github-release/config", requireAdmin, async (c) => {
  const { storageId } = c.req.param();
  const db = c.env.DB;
  const { userId: adminId } = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
  const repositoryFactory = useRepositories(c);
  const config = await getGithubReleaseEncryptedClientConfig(db, storageId, adminId, repositoryFactory);
  return jsonOk(c, config, "获取 GitHub Release 加密存储配置成功");
});

routes.get("/api/storage/:storageId/github-release/init-status", requireAdmin, async (c) => {
  const { storageId } = c.req.param();
  const db = c.env.DB;
  const { userId: adminId } = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
  const repositoryFactory = useRepositories(c);
  const result = await checkGithubReleaseInitialization(db, storageId, adminId, c.env.ENCRYPTION_SECRET, repositoryFactory);
  return jsonOk(c, result, result.message);
});

routes.post("/api/storage/:storageId/github-release/initialize", requireAdmin, async (c) => {
  const { storageId } = c.req.param();
  const db = c.env.DB;
  const { userId: adminId } = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
  const repositoryFactory = useRepositories(c);
  const result = await initializeGithubReleaseStorage(db, storageId, adminId, c.env.ENCRYPTION_SECRET, repositoryFactory);
  return jsonOk(c, result, result.message);
});

routes.post("/api/storage/:storageId/github-release/assets", requireAdmin, async (c) => {
  const { storageId } = c.req.param();
  const db = c.env.DB;
  const { userId: adminId } = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
  const repositoryFactory = useRepositories(c);
  const result = await uploadGithubReleaseAssetProxy(
    db,
    storageId,
    adminId,
    c.env.ENCRYPTION_SECRET,
    {
      releaseId: c.req.query("releaseId") || null,
      name: c.req.query("name") || null,
      contentType: c.req.header("content-type") || "application/octet-stream",
      body: c.req.raw?.body || null,
    },
    repositoryFactory,
  );
  return jsonCreated(c, result, "GitHub Release Asset 上传成功");
});

routes.delete("/api/storage/:storageId/github-release/assets/:assetId", requireAdmin, async (c) => {
  const { storageId, assetId } = c.req.param();
  const db = c.env.DB;
  const { userId: adminId } = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
  const repositoryFactory = useRepositories(c);
  const result = await deleteGithubReleaseAssetProxy(db, storageId, assetId, adminId, c.env.ENCRYPTION_SECRET, repositoryFactory);
  return jsonOk(c, result, "GitHub Release Asset 删除成功");
});

routes.post("/api/storage/:storageId/github-release/files/:fileId/key", requireAdmin, async (c) => {
  const { storageId, fileId } = c.req.param();
  const db = c.env.DB;
  const { userId: adminId } = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
  const body = await c.req.json();
  const repositoryFactory = useRepositories(c);
  const result = await saveGithubReleaseFileKey(db, storageId, fileId, body?.encryptionKey, adminId, repositoryFactory);
  return jsonCreated(c, result, "文件密钥保存成功");
});

routes.put("/api/storage/:storageId/github-release/files/:fileId/key", requireAdmin, async (c) => {
  const { storageId, fileId } = c.req.param();
  const db = c.env.DB;
  const { userId: adminId } = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
  const body = await c.req.json();
  const repositoryFactory = useRepositories(c);
  const result = await saveGithubReleaseFileKey(db, storageId, fileId, body?.encryptionKey, adminId, repositoryFactory);
  return jsonOk(c, result, "文件密钥已更新");
});

routes.get("/api/storage/:storageId/github-release/files/:fileId/key", requireAdmin, async (c) => {
  const { storageId, fileId } = c.req.param();
  const db = c.env.DB;
  const { userId: adminId } = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
  const repositoryFactory = useRepositories(c);
  const result = await getGithubReleaseFileKey(db, storageId, fileId, adminId, repositoryFactory);
  return jsonOk(c, result, "获取文件密钥成功");
});

routes.delete("/api/storage/:storageId/github-release/files/:fileId/key", requireAdmin, async (c) => {
  const { storageId, fileId } = c.req.param();
  const db = c.env.DB;
  const { userId: adminId } = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
  const hard = getQueryBool(c, "hard", false);
  const repositoryFactory = useRepositories(c);
  const result = await deleteGithubReleaseFileKey(db, storageId, fileId, adminId, { hard }, repositoryFactory);
  return jsonOk(c, result, "文件密钥删除成功");
});

export default routes;

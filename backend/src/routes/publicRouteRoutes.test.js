import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicRouteTargetExists } from "./publicRouteRoutes.js";

test("公开路由目标存在且类型匹配时允许保存", async () => {
  await assertPublicRouteTargetExists(
    {},
    "/docs/readme.md",
    "file",
    async (path) => ({ path, isDirectory: false }),
  );
  await assertPublicRouteTargetExists(
    {},
    "/docs",
    "directory",
    async (path) => ({ path, isDirectory: true }),
  );
});

test("公开路由目标不存在时拒绝保存", async () => {
  await assert.rejects(
    () => assertPublicRouteTargetExists({}, "/missing.md", "file", async () => null),
    /目标路径不存在/,
  );
});

test("公开路由目标类型不匹配时拒绝保存", async () => {
  await assert.rejects(
    () => assertPublicRouteTargetExists({}, "/docs", "file", async () => ({ isDirectory: true })),
    /目标路径类型不匹配：实际为文件夹/,
  );
  await assert.rejects(
    () => assertPublicRouteTargetExists({}, "/docs/readme.md", "directory", async () => ({ isDirectory: false })),
    /目标路径类型不匹配：实际为文件/,
  );
});

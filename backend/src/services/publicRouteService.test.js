import test from "node:test";
import assert from "node:assert/strict";
import {
  PublicRouteService,
  isSameOrSubPath,
  normalizePublicPath,
  normalizeTargetFsPath,
  validatePublicPath,
} from "./publicRouteService.js";

function createService(records = []) {
  const repository = {
    async findEnabledCandidates() {
      return records
        .filter((record) => Boolean(record.enabled))
        .sort((left, right) => right.public_path.length - left.public_path.length);
    },
  };
  return new PublicRouteService(null, {
    getPublicRouteRepository() {
      return repository;
    },
  });
}

test("公开路径和目标路径会被规范化", () => {
  assert.equal(normalizePublicPath("docs\\guide/"), "/docs/guide");
  assert.equal(normalizeTargetFsPath("//website///assets/"), "/website/assets");
});

test("公开路径拒绝点路径段", () => {
  assert.throws(() => normalizePublicPath("/docs/../admin"), /不能包含/);
  assert.throws(() => normalizeTargetFsPath("/website/./index.html"), /不能包含/);
});

test("系统保留路径及其父子路径不能公开", () => {
  assert.throws(() => validatePublicPath("/api/files"), /系统保留路径/);
  assert.throws(() => validatePublicPath("/dav"), /系统保留路径/);
  assert.throws(() => validatePublicPath("/mount-explorer/docs"), /系统保留路径/);
  assert.throws(() => validatePublicPath("/assets/docs"), /系统保留路径/);
  assert.throws(() => validatePublicPath("/"), /系统保留路径/);
  assert.equal(validatePublicPath("/docs"), "/docs");
});

test("路径边界判断不会混淆相似前缀", () => {
  assert.equal(isSameOrSubPath("/docs", "/docs"), true);
  assert.equal(isSameOrSubPath("/docs/assets", "/docs"), true);
  assert.equal(isSameOrSubPath("/docs-old", "/docs"), false);
  assert.equal(isSameOrSubPath("/api2", "/api"), false);
});

test("文件公开路由只精确匹配", async () => {
  const service = createService([
    {
      id: "file-route",
      public_path: "/manual.pdf",
      target_fs_path: "/files/manual.pdf",
      target_type: "file",
      enabled: 1,
    },
  ]);

  const matched = await service.resolve("/manual.pdf");
  assert.equal(matched.fsPath, "/files/manual.pdf");
  assert.equal(matched.route.id, "file-route");
  assert.equal(await service.resolve("/manual.pdf/extra"), null);
});

test("目录根路径固定解析到 index.html，子路径保留相对层级", async () => {
  const service = createService([
    {
      id: "directory-route",
      public_path: "/docs",
      target_fs_path: "/website",
      target_type: "directory",
      enabled: 1,
    },
  ]);

  assert.equal((await service.resolve("/docs")).fsPath, "/website/index.html");
  assert.equal((await service.resolve("/docs/assets/app.css")).fsPath, "/website/assets/app.css");
  assert.equal((await service.resolve("/docs/guides/start.md")).fsPath, "/website/guides/start.md");
  assert.equal((await service.resolve("/docs/reference.markdown")).fsPath, "/website/reference.markdown");
  assert.equal(await service.resolve("/docs-old"), null);
});

test("目录公开路由优先匹配更长、更具体的公开路径", async () => {
  const service = createService([
    {
      id: "root-docs",
      public_path: "/docs",
      target_fs_path: "/website/docs",
      target_type: "directory",
      enabled: 1,
    },
    {
      id: "api-docs",
      public_path: "/docs/api",
      target_fs_path: "/website/api-v2",
      target_type: "directory",
      enabled: 1,
    },
  ]);

  const matched = await service.resolve("/docs/api/index.json");
  assert.equal(matched.route.id, "api-docs");
  assert.equal(matched.fsPath, "/website/api-v2/index.json");
});

test("关闭的公开路由不会被解析", async () => {
  const service = createService([
    {
      id: "disabled-route",
      public_path: "/disabled",
      target_fs_path: "/website",
      target_type: "directory",
      enabled: 0,
    },
  ]);

  assert.equal(await service.resolve("/disabled"), null);
});

import assert from "node:assert/strict";
import test from "node:test";

import { NotFoundError } from "../../http/errors.js";
import { canNavigatePath } from "../../security/helpers/access.js";
import { isVirtualPath } from "../../storage/fs/utils/VirtualDirectory.js";
import { WebDAVAuth } from "../auth/core/WebDAVAuth.js";
import { resolveDepthZeroResource } from "../utils/resourceUtils.js";

const principal = { id: "test", basicPath: "/" };
const userType = "api_key";

function createFileSystem(overrides = {}) {
  return {
    async getFileInfo() {
      throw new Error("unexpected getFileInfo call");
    },
    async exists() {
      throw new Error("unexpected exists call");
    },
    async listDirectory() {
      throw new Error("unexpected listDirectory call");
    },
    ...overrides,
  };
}

test("Depth 0 以 getFileInfo 的真实类型为准，不根据尾斜杠强制目录", async () => {
  const fileSystem = createFileSystem({
    async getFileInfo(path) {
      return {
        path,
        name: "folder",
        isDirectory: true,
        size: null,
        modified: null,
      };
    },
  });

  const result = await resolveDepthZeroResource(
    fileSystem,
    "/cf/temp/folder/",
    principal,
    userType
  );

  assert.equal(result.isDirectory, true);
  assert.deepEqual(result.items, []);
});

test("不存在的尾斜杠路径不调用 listDirectory 伪造空目录", async () => {
  const notFound = new NotFoundError("资源不存在");
  let listCalls = 0;
  const fileSystem = createFileSystem({
    async getFileInfo() {
      throw notFound;
    },
    async exists() {
      return false;
    },
    async listDirectory() {
      listCalls += 1;
      return { type: "directory", items: [] };
    },
  });

  await assert.rejects(
    resolveDepthZeroResource(
      fileSystem,
      "/cf/temp/never-created/",
      principal,
      userType
    ),
    (error) => error === notFound
  );
  assert.equal(listCalls, 0);
});

test("驱动 stat 目录失败但 exists 为 true 时允许 listDirectory 兼容回退", async () => {
  let listCalls = 0;
  const fileSystem = createFileSystem({
    async getFileInfo() {
      throw new Error("driver cannot stat collection marker");
    },
    async exists() {
      return true;
    },
    async listDirectory(path) {
      listCalls += 1;
      return {
        path,
        type: "directory",
        items: [{ name: "child.txt", isDirectory: false }],
      };
    },
  });

  const result = await resolveDepthZeroResource(
    fileSystem,
    "/cf/temp/folder/",
    principal,
    userType
  );

  assert.equal(listCalls, 1);
  assert.equal(result.type, "directory");
  assert.equal(result.isDirectory, true);
  assert.equal(result.name, "folder");
  assert.deepEqual(result.items, []);
});

test("非尾斜杠路径 stat 失败时不做目录回退", async () => {
  const notFound = new NotFoundError("文件不存在");
  let existsCalls = 0;
  const fileSystem = createFileSystem({
    async getFileInfo() {
      throw notFound;
    },
    async exists() {
      existsCalls += 1;
      return true;
    },
  });

  await assert.rejects(
    resolveDepthZeroResource(
      fileSystem,
      "/cf/temp/missing.txt",
      principal,
      userType
    ),
    (error) => error === notFound
  );
  assert.equal(existsCalls, 0);
});

test("basicPath 与请求路径仅尾斜杠不同时仍允许访问", () => {
  assert.equal(canNavigatePath("/cf/temp/", "/cf/temp"), true);
  assert.equal(canNavigatePath("/cf/temp", "/cf/temp/"), true);

  const auth = new WebDAVAuth(null);
  assert.equal(auth.checkBasicPathPermission("/cf/temp/", "/cf/temp"), true);
  assert.equal(auth.checkBasicPathPermission("/cf/temp", "/cf/temp/"), true);
  assert.equal(auth.checkBasicPathPermission("/cf/temp/", "/cf/temp/child"), true);
});

test("认证入口不会因尾斜杠修复而扩大到 basicPath 的祖先路径", () => {
  const auth = new WebDAVAuth(null);
  assert.equal(auth.checkBasicPathPermission("/cf/temp/", "/cf"), false);
  assert.equal(auth.checkBasicPathPermission("/cf/temp/", "/cf/other"), false);
});

test("只有根路径和挂载点祖先路径属于虚拟目录", () => {
  const mounts = [{ id: "cf", mount_path: "/cf" }];

  assert.equal(isVirtualPath("/", mounts), true);
  assert.equal(isVirtualPath("/cf", mounts), false);
  assert.equal(isVirtualPath("/cf/", mounts), false);
  assert.equal(isVirtualPath("/cf/temp/missing", mounts), false);
  assert.equal(isVirtualPath("/cf/temp/missing/", mounts), false);

  const nestedMounts = [{ id: "archive", mount_path: "/team/archive" }];
  assert.equal(isVirtualPath("/team", nestedMounts), true);
  assert.equal(isVirtualPath("/team/", nestedMounts), true);
  assert.equal(isVirtualPath("/unrelated", nestedMounts), false);
});

test("空挂载列表不会把任意路径伪装成虚拟 Collection", () => {
  assert.equal(isVirtualPath("/", []), true);
  assert.equal(isVirtualPath("/cf/temp/missing", []), false);
  assert.equal(isVirtualPath("/cf/temp/missing/", []), false);
});

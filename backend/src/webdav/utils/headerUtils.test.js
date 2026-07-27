import assert from "node:assert/strict";
import test from "node:test";

import {
  getCollectionContentLocation,
  getWebDAVMultiStatusHeaders,
} from "./headerUtils.js";

test("无尾斜杠的 WebDAV 根目录生成 canonical Content-Location", () => {
  assert.equal(
    getCollectionContentLocation("https://example.com/dav", "/dav/"),
    "/dav/"
  );
});

test("无尾斜杠的子目录生成路径形式的 Content-Location", () => {
  assert.equal(
    getCollectionContentLocation(
      "https://example.com/dav/folder?token=secret#section",
      "/dav/folder/"
    ),
    "/dav/folder/"
  );
});

test("请求已带尾斜杠时不重复返回 Content-Location", () => {
  assert.equal(
    getCollectionContentLocation("https://example.com/dav/folder/", "/dav/folder/"),
    null
  );
});

test("规范目录路径缺少尾斜杠时自动补齐", () => {
  assert.equal(
    getCollectionContentLocation("https://example.com/dav/folder", "/dav/folder"),
    "/dav/folder/"
  );
});

test("目录路径段在 Content-Location 中使用合法 URL 编码", () => {
  assert.equal(
    getCollectionContentLocation(
      "https://example.com/dav/%E6%96%87%E6%A1%A3",
      "/dav/文档/"
    ),
    "/dav/%E6%96%87%E6%A1%A3/"
  );
  assert.equal(
    getCollectionContentLocation(
      "https://example.com/dav/a%20b%3F%23%25",
      "/dav/a b?#%/"
    ),
    "/dav/a%20b%3F%23%25/"
  );
});

test("Multi-Status 响应仅在提供规范位置时添加 Content-Location", () => {
  const withLocation = getWebDAVMultiStatusHeaders({
    contentLocation: "/dav/folder/",
  });
  const withoutLocation = getWebDAVMultiStatusHeaders();

  assert.equal(withLocation["Content-Location"], "/dav/folder/");
  assert.equal(withLocation["Content-Type"], "text/xml; charset=utf-8");
  assert.equal(withoutLocation["Content-Location"], undefined);
});

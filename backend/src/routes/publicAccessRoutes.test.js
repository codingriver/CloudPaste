import test from "node:test";
import assert from "node:assert/strict";
import {
  createPublicMarkdownHtml,
  createPublicMarkdownResponse,
  isPublicMarkdownPath,
  shouldBypassPublicRouteLookup,
} from "./publicAccessRoutes.js";

test("公开 Markdown 路径支持 md 和 markdown 扩展名", () => {
  assert.equal(isPublicMarkdownPath("/docs/README.md"), true);
  assert.equal(isPublicMarkdownPath("/docs/guide.MARKDOWN"), true);
  assert.equal(isPublicMarkdownPath("/docs/readme.md.txt"), false);
  assert.equal(isPublicMarkdownPath("/docs/index.html"), false);
});

test("公开 Markdown 阅读页复用本地 Vditor 资源并转义标题", () => {
  const html = createPublicMarkdownHtml("/docs/<guide>.md");
  assert.match(html, /public-markdown-viewer\.js/);
  assert.match(html, /vditor\/3\.11\.1\/dist\/index\.css/);
  assert.match(html, /&lt;guide&gt;\.md/);
  assert.doesNotMatch(html, /<guide>/);
});

test("公开 Markdown GET 响应包含阅读页和安全响应头", async () => {
  const response = createPublicMarkdownResponse({
    path: "/docs/guide.md",
    method: "GET",
    routeId: "directory-route",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-cache");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-CloudPaste-Public-Route"), "directory-route");
  assert.match(response.headers.get("Content-Security-Policy"), /object-src 'none'/);
  assert.match(await response.text(), /<title>guide\.md<\/title>/);
});

test("公开 Markdown HEAD 响应不返回页面正文", async () => {
  const response = createPublicMarkdownResponse({
    path: "/docs/guide.markdown",
    method: "HEAD",
    routeId: "directory-route",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(await response.text(), "");
});

test("系统和静态资源路径会跳过公开路由 D1 查询", () => {
  assert.equal(shouldBypassPublicRouteLookup("/"), true);
  assert.equal(shouldBypassPublicRouteLookup("/api/admin/public-routes"), true);
  assert.equal(shouldBypassPublicRouteLookup("/dav/docs"), true);
  assert.equal(shouldBypassPublicRouteLookup("/assets/app.js"), true);
  assert.equal(shouldBypassPublicRouteLookup("/icons/icon-192.png"), true);
  assert.equal(shouldBypassPublicRouteLookup("/favicon.ico"), true);
  assert.equal(shouldBypassPublicRouteLookup("/manifest.webmanifest"), true);
  assert.equal(shouldBypassPublicRouteLookup("/assets-old/app.js"), false);
  assert.equal(shouldBypassPublicRouteLookup("/docs/index.html"), false);
});

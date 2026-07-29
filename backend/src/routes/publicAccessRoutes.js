import { Hono } from "hono";
import { UserType } from "../constants/index.js";
import { PublicRouteService } from "../services/publicRouteService.js";
import { MountManager } from "../storage/managers/MountManager.js";
import { StorageStreaming, STREAMING_CHANNELS } from "../storage/streaming/index.js";
import { getEncryptionSecret } from "../utils/environmentUtils.js";

const publicAccessRoutes = new Hono();
const PUBLIC_SYSTEM_USER = "system-public-route";
const PUBLIC_MARKDOWN_RAW_QUERY = "__cloudpaste_raw";
const MARKDOWN_PATH_PATTERN = /\.(?:md|markdown)$/i;

export function isPublicMarkdownPath(path) {
  return MARKDOWN_PATH_PATTERN.test(String(path || ""));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getPublicMarkdownTitle(path) {
  const segment = String(path || "").split("/").filter(Boolean).pop() || "Markdown 文档";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createPublicMarkdownHtml(path) {
  const title = escapeHtml(getPublicMarkdownTitle(path));
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>${title}</title>
  <link rel="stylesheet" href="/assets/vditor/3.11.1/dist/index.css">
  <link rel="stylesheet" href="/assets/public-markdown-viewer.css">
</head>
<body>
  <header class="public-markdown-header">
    <div class="public-markdown-title" title="${title}">${title}</div>
    <a id="markdown-source-link" class="public-markdown-source" href="#">查看原文</a>
  </header>
  <main class="public-markdown-main">
    <div id="markdown-loading" class="public-markdown-loading">正在加载 Markdown 文档...</div>
    <div id="markdown-error" class="public-markdown-error" hidden></div>
    <article id="markdown-content" class="vditor-reset" hidden></article>
  </main>
  <script src="/assets/public-markdown-viewer.js" defer></script>
</body>
</html>`;
}

export function createPublicMarkdownResponse({ path, method = "GET", routeId = "" }) {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "media-src 'self' blob: https:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-CloudPaste-Public-Route": routeId,
  });
  return new Response(method === "HEAD" ? null : createPublicMarkdownHtml(path), {
    status: 200,
    headers,
  });
}

async function handlePublicAccess(c) {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.notFound();

  const resolved = await new PublicRouteService(c.env.DB, c.get("repos")).resolve(c.req.path);
  if (!resolved) return c.notFound();

  const isMarkdown = isPublicMarkdownPath(resolved.fsPath);
  const rawMarkdownRequested = c.req.query(PUBLIC_MARKDOWN_RAW_QUERY) === "1";
  if (isMarkdown && !rawMarkdownRequested) {
    return createPublicMarkdownResponse({
      path: c.req.path,
      method: c.req.method,
      routeId: resolved.route.id,
    });
  }

  const encryptionSecret = getEncryptionSecret(c);
  const mountManager = new MountManager(c.env.DB, encryptionSecret, c.get("repos"), { env: c.env });
  const streaming = new StorageStreaming({ mountManager, storageFactory: null, encryptionSecret });
  const response = await streaming.createResponse({
    path: resolved.fsPath,
    channel: STREAMING_CHANNELS.FS_WEB,
    rangeHeader: c.req.header("Range") || null,
    request: c.req.raw,
    userIdOrInfo: PUBLIC_SYSTEM_USER,
    userType: UserType.ADMIN,
    db: c.env.DB,
  });

  response.headers.set("X-CloudPaste-Public-Route", resolved.route.id);
  response.headers.set("Content-Disposition", "inline");
  if (isMarkdown) {
    response.headers.set("Content-Type", "text/markdown; charset=utf-8");
    response.headers.set("X-Content-Type-Options", "nosniff");
  }
  return response;
}

publicAccessRoutes.get("*", handlePublicAccess);
publicAccessRoutes.on("HEAD", "*", handlePublicAccess);

export default publicAccessRoutes;

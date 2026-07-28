# CloudPaste 普通站点式公开文件路由方案

## 1. 需求重新定义

这里的“公开访问”不是进入 CloudPaste 分享页，也不是打开一个带网盘 UI 的公开目录，而是把网盘中的文件或文件夹发布成一个普通网站的 URL 空间。

示例：

```text
域名路由配置：
site.example.com /  -> 网盘目录 /sites/demo

网盘内容：
/sites/demo/index.html
/sites/demo/assets/app.css
/sites/demo/assets/app.js
/sites/demo/images/logo.png

公开访问：
https://site.example.com/                 -> 返回 index.html
https://site.example.com/assets/app.css   -> 直接返回 CSS
https://site.example.com/assets/app.js    -> 直接返回 JS
https://site.example.com/images/logo.png  -> 直接返回图片
```

还应支持路径挂载：

```text
site.example.com /docs -> 网盘目录 /public/manual
site.example.com /logo.png -> 网盘文件 /branding/logo.png
```

这样 CloudPaste 扮演的是静态站点源站/文件发布器，而不是分享落地页。

## 2. 当前项目能力与主要缺口

根据当前项目代码：

- `backend/src/routes/fs/search_share.js` 已有 `/api/fs/create-share`，但只允许文件。
- `backend/src/services/fileShareService.js` 的 `createShareFromFileSystem()` 在目录资源上直接报错“只能为文件创建分享”。
- `backend/src/services/share/ShareRecordService.js` 当前分享记录是文件模型，公开 URL 为 `/file/{slug}`。
- `Cloudpaste-Proxy.js` 只处理 `/proxy/fs` 和 `/proxy/share/{slug}`，并不负责普通域名下任意路径的站点资源解析。
- 现有文件系统、挂载驱动和代理下载链路可以复用，但需要新增“站点发布”领域模型与路由解析层。

结论：不要直接扩展现有文件分享记录来假装目录站点。应保留文件分享功能，同时新增独立的“站点发布/公开路由”能力。

## 3. 推荐领域模型

### 3.1 站点发布配置 `site_routes`

建议新增独立表：

```text
id
hostname                 域名，小写并去端口
path_prefix              URL 挂载路径，根目录为 /
target_type              file | directory
target_fs_path           网盘中的绝对 FS 路径
enabled                   是否启用
index_files               JSON，例如 ["index.html", "index.htm"]
directory_listing         是否允许目录列表
spa_fallback              是否启用 SPA fallback
spa_fallback_file         默认 index.html
cache_control             可选的响应缓存策略
created_by
created_at
updated_at
```

约束：

- 唯一索引 `(hostname, path_prefix)`。
- `path_prefix` 必须是规范化绝对 URL 路径。
- `target_fs_path` 保存 CloudPaste 虚拟文件系统路径，不保存某个存储驱动的内部 key。
- 配置创建与修改时校验操作者对目标文件/目录拥有读取和发布权限。

### 3.2 与普通分享的关系

推荐明确区分：

- **普通分享**：`/file/{slug}`，可设置密码、有效期、访问次数，展示分享页。
- **站点发布**：自定义域名与路径直接提供 HTTP 文件响应，适合网页、文档站、资源目录。

站点发布可以复用现有文件读取、代理、Range 请求和存储驱动，但不应复用“访问一次扣一次浏览量”的文件分享语义。

如果产品仍需要有效期，可以在 `site_routes` 增加 `expires_at`；密码保护不建议作为首版功能，因为浏览器加载 CSS、JS、图片时无法自然完成逐资源密码验证。如确实需要私有站点，应设计域名级登录会话，而不是复用单文件密码参数。

## 4. 路由解析规则

### 4.1 请求优先级

后端/Worker 收到请求后按以下顺序处理：

1. 系统保留路径：`/api/*`、`/admin/*`、登录回调、健康检查、WebDAV、内部代理等。
2. 精确匹配请求 hostname。
3. 在同一 hostname 下进行 `path_prefix` 最长前缀匹配。
4. 将去掉 `path_prefix` 后的剩余 URL 路径解析为目标目录内的相对路径。
5. 找到资源则按普通 HTTP 文件响应；找不到则按站点配置返回 404 或 SPA fallback。
6. 未配置该 hostname 时，保持 CloudPaste 当前首页行为。

例如：

```text
site.example.com /      -> /sites/main
site.example.com /docs  -> /sites/docs

/docs/guide.html 命中 /docs，而不是 /
```

### 4.2 路径安全

必须在服务端统一处理：

- URL 百分号解码只执行一次，非法编码返回 400。
- 合并重复斜杠，处理尾斜杠，但不得把文件路径随意改写。
- 拒绝 `.`、`..`、编码后的路径穿越和反斜杠逃逸。
- 解析后的目标路径必须仍位于配置的 `target_fs_path` 之下。
- 域名统一小写、去端口和尾随点；只在可信代理配置下接受转发 Host。
- 禁止配置与系统保留路径冲突的 `path_prefix`。

## 5. 文件与目录的 HTTP 行为

### 5.1 文件目标

当路由直接绑定文件：

- 仅精确 URL 路径命中该文件。
- 返回正确 `Content-Type`、`Content-Length`、`ETag`、`Last-Modified`。
- 支持 `GET`、`HEAD`、`Range`、条件请求和 `304 Not Modified`。
- 默认使用 `Content-Disposition: inline`；危险或未知类型可按安全策略改为 `attachment`。

### 5.2 目录目标

当路由绑定目录：

- URL 子路径与网盘目录结构一一对应。
- 请求目录但 URL 缺少尾斜杠时，返回 308 到带尾斜杠地址，保证网页相对链接正确。
- 请求目录时按 `index_files` 顺序查找首页文件。
- 找到 `index.html` 就直接返回该文件，不进入 CloudPaste 前端页面。
- 未找到首页文件且 `directory_listing=true` 时，返回轻量目录索引页。
- 未找到首页文件且目录列表关闭时，返回 404，不暴露目录内容。

目录列表首版建议默认关闭；若开启，应只展示名称、类型、大小和修改时间，不展示存储配置、对象 key、签名或内部 ID。

### 5.3 SPA fallback

SPA fallback 必须是每条站点路由的显式配置，默认关闭：

- 请求路径没有对应文件，且 `Accept` 包含 `text/html` 时，返回站点根目录的 `index.html`。
- 对 `.js`、`.css`、图片、字体、API 请求和带文件扩展名的缺失资源不得 fallback，直接 404。
- SPA fallback 只在当前 `target_fs_path` 范围内查找，不能回落到 CloudPaste 管理前端。

## 6. 后端改造

建议新增：

```text
backend/src/services/site/SiteRouteService.js
backend/src/services/site/SiteResourceService.js
backend/src/routes/siteRoutes.js
backend/src/repositories/SiteRouteRepository.js
```

职责划分：

- `SiteRouteService`：配置 CRUD、域名/路径规范化、冲突检查、最长前缀匹配。
- `SiteResourceService`：安全拼接 FS 路径、文件/目录判断、index 查找、目录列表、SPA fallback。
- `SiteRouteRepository`：D1/SQLite 数据访问。
- `siteRoutes.js`：管理 API 和公开请求入口。

管理 API 建议：

```text
GET    /api/site-routes
POST   /api/site-routes
PUT    /api/site-routes/:id
DELETE /api/site-routes/:id
POST   /api/site-routes/check
```

公开资源请求不需要额外暴露 JSON 解析 API，应该直接在服务端请求链中解析 hostname/path 并输出资源响应，减少一次前端跳转和 API 往返。

## 7. 前端改造

### 7.1 网盘管理

文件和文件夹菜单增加“发布为站点路由”：

- 选择或输入域名。
- 填写公开路径，例如 `/`、`/docs`、`/logo.png`。
- 目录可配置首页文件、目录列表、SPA fallback。
- 展示最终 URL 和冲突检测结果。
- 已发布的资源显示“站点路由”标记，可直接编辑或停用。

原有“分享”菜单保留，不把两种功能混在同一个概念中。UI 可以并列显示：

```text
分享文件
发布为站点路由
```

### 7.2 独立路由管理页

建议后台增加“站点路由”页面，统一查看：

- 域名与公开路径。
- 映射的文件/文件夹路径。
- 是否启用、目录列表、SPA fallback。
- 冲突、目标资源失效等状态。
- 复制公开 URL、编辑、停用和删除操作。

## 8. Worker 与部署架构

### 8.1 首选架构

自定义域名直接绑定当前 `cloudpaste` Worker。Worker/API 入口必须收到原始 hostname 和 pathname，并在普通前端 fallback 之前执行站点路由解析。

注意：仓库根目录的 `Cloudpaste-Proxy.js` 是文件流反向代理示例，当前只处理 `/proxy/*`。它不是站点发布主入口，不建议把所有普通站点请求都塞入该脚本。站点解析应进入主 Worker 的 Hono 请求链，然后复用现有 LinkService/存储读取能力。

### 8.2 多域名处理

Cloudflare 中绑定自定义域名只是让请求到达 Worker；应用内仍需配置 hostname/path 到 FS 资源的映射。后台保存路由时可提示：

- 域名尚未绑定到 Worker：配置存在，但公网暂不可达。
- 域名已绑定：可以执行在线探测。

### 8.3 Docker/Nginx

反代必须传递原始 Host：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
```

只有在应用明确配置可信代理时，才读取 `X-Forwarded-Host`。Docker 与 Worker 应共用同一套 `SiteRouteService`，避免路由行为不一致。

## 9. HTTP、安全与缓存策略

- HTML 默认 `Cache-Control: no-cache` 或较短缓存，静态指纹资源可配置长缓存。
- 响应设置 `X-Content-Type-Options: nosniff`。
- HTML 是否允许执行取决于站点发布用途；因为这是主动发布功能，可允许 HTML，但必须与 CloudPaste 管理域名隔离，避免同源 Cookie、localStorage 和 CSP 风险。
- 强烈建议公开站点使用独立自定义域名，不要把用户 HTML 发布在管理后台同一 hostname 下。
- 管理 Cookie 应设置严格 Domain/Path，不得泄露给公开站点域名。
- 目录列表对文件名进行 HTML 转义，链接进行正确 URL 编码。
- 对单次目录查询、文件大小、并发和带宽进行限制，防止公开站点拖垮存储后端。
- 404、403 和目标失效响应不要返回内部 FS 路径或存储错误详情。

## 10. 数据迁移与兼容

- 新增 `site_routes` 表，不修改现有文件分享 URL 和行为。
- 历史分享不自动迁移为站点路由。
- 如果未来要从某条文件分享快速创建站点路由，只复制其 FS 目标并创建新配置，不让两者共享生命周期。
- 删除网盘资源时，站点路由应标记为“目标失效”或返回 404；不要静默指向同名新资源。

## 11. 测试重点

### 路由测试

- 根目录、路径挂载、同域多挂载和最长前缀匹配。
- 尾斜杠 308、百分号编码、中文文件名、空格和特殊字符。
- 系统保留路径不被站点路由覆盖。
- 未绑定域名保持原站点行为。

### 文件响应测试

- HTML/CSS/JS/图片/字体/MIME 类型。
- `GET`、`HEAD`、单段 Range、条件请求、ETag 和 304。
- 大文件流式响应，不在 Worker 内完整缓冲。
- 不同存储驱动的直链、代理和重定向行为一致。

### 目录与 SPA 测试

- index 文件优先级、目录列表开关、空目录。
- 相对路径资源加载正常。
- SPA 页面刷新正常，缺失静态资源仍返回 404。
- 无法越出发布根目录。

### 安全测试

- `../`、双重编码、反斜杠、重复斜杠和恶意 Host。
- HTML 与管理后台 Cookie/认证完全隔离。
- 目录列表 XSS、响应头注入和文件名编码。

## 12. 推荐实施顺序

1. 新增 `site_routes` 数据模型、迁移和 Repository。
2. 实现 hostname/path 规范化、最长前缀匹配和保留路径保护。
3. 实现 FS 资源安全解析、目录 index、文件流式响应、HEAD/Range/条件请求。
4. 实现目录列表和可选 SPA fallback。
5. 增加管理 API、网盘菜单和独立“站点路由”管理页。
6. 将公开站点解析接入主 Worker，并确保早于 CloudPaste 前端 fallback。
7. 同步 Docker/Nginx Host 透传规则。
8. 补齐测试、API 文档与部署说明。
9. 构建后部署至 Cloudflare Workers 的 `cloudpaste` Worker，使用独立测试域名验证。

## 13. 验收标准

- 可将网盘目录绑定到自定义域名 `/`，并像普通静态站点一样访问 `index.html`、CSS、JS、图片及任意子路径文件。
- 可将目录挂载到 `/docs` 等路径，也可将单文件映射到精确公开路径。
- 浏览器地址栏不会跳转到 `/file/{slug}` 或 CloudPaste 分享页。
- 文件响应支持正确 MIME、HEAD、Range、缓存协商和大文件流式传输。
- 目录首页、目录列表和 SPA fallback 均按每条路由独立配置。
- 管理/API 路由不会被公开站点配置覆盖，公开 HTML 与管理后台认证环境隔离。
- 现有文件分享功能保持兼容，不受站点发布功能影响。

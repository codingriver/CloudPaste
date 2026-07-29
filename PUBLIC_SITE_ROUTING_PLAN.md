# CloudPaste 文件与文件夹公开路由方案

## 1. 功能目标

公开路由用于把网盘中的单个文件或文件夹映射为普通站点 URL，不进入 `/file/{slug}` 分享页，也不展示 CloudPaste 网盘界面。

```text
目标目录：/website
公开路径：/docs

GET /docs                  -> /website/index.html
GET /docs/assets/app.css   -> /website/assets/app.css
GET /docs/images/logo.png  -> /website/images/logo.png
```

单文件采用精确匹配：

```text
目标文件：/manual/files/guide.pdf
公开路径：/downloads/guide.pdf

GET /downloads/guide.pdf -> /manual/files/guide.pdf
```

## 2. 精简原则

- 只维护一张 `public_routes` 路由表。
- 路由记录是公开状态的唯一事实来源。
- 不在文件表或目录元信息中增加 `is_public` 字段。
- 路由存在且 `enabled = 1` 表示目标公开。
- 路由不存在或 `enabled = 0` 表示目标不公开。
- 不增加密码、访客授权、权限继承、有效期、目录列表、SPA fallback 或缓存配置。
- 现有文件分享、WebDAV 与后台权限体系保持独立。

## 3. 数据模型

```sql
CREATE TABLE public_routes (
  id TEXT PRIMARY KEY,
  public_path TEXT NOT NULL UNIQUE,
  target_fs_path TEXT NOT NULL,
  target_type TEXT NOT NULL
    CHECK (target_type IN ('file', 'directory')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (target_fs_path, target_type)
);
```

约束含义：

- 同一个公开路径只能映射一个目标。
- 同一个 FS 文件或文件夹只能维护一条对应类型的公开路由。
- 文件和文件夹通过 `target_type` 区分。

## 4. 路由解析

### 4.1 文件路由

文件路由只接受 `public_path` 精确匹配，请求其子路径不会命中。

### 4.2 文件夹路由

文件夹路由接受公开根路径及其子路径：

- 请求公开根路径时，固定读取目标目录下的 `index.html`。
- 请求公开子路径时，将相对路径拼接到目标目录。
- 多条目录路由都可能匹配时，优先使用 `public_path` 最长的路由。
- 路径判断必须包含分段边界，`/docs-old` 不能命中 `/docs`。

### 4.3 路径规范化

公开路径和 FS 目标路径统一：

- 将反斜杠转换为 `/`。
- 确保以 `/` 开头。
- 合并重复斜杠。
- 移除非根路径末尾斜杠。
- 拒绝 `.` 与 `..` 路径段。

## 5. 系统保留路径

系统路由优先，公开路由不能覆盖或成为下列路径的父路径：

```text
/
/api
/dav
/upload
/admin
/paste
/file
/mount-explorer
/assets
```

例如 `/api/files`、`/dav/public`、`/mount-explorer/docs`、`/assets/docs` 均不能配置；`/api2` 不视为 `/api` 的子路径。

## 6. 请求处理顺序

1. CloudPaste 系统 API、管理接口和 WebDAV。
2. 现有 FS、分享、代理等业务路由。
3. 公开文件/文件夹路由解析。
4. 未命中公开路由的网页请求回退到 Static Assets / SPA。
5. API 与 WebDAV 未命中时返回原有 JSON 404。

Cloudflare Static Assets 使用 Worker-first，使自定义公开路径先进入 Worker；公开路由未命中时再通过 `ASSETS` binding 返回前端资源。

## 7. 文件响应

公开资源仅处理 `GET` 和 `HEAD`，复用现有 `MountManager` 与 `StorageStreaming`：

- 正确的内容类型与长度。
- `HEAD`。
- Range 请求。
- `ETag`、`Last-Modified` 和条件请求。
- Web `ReadableStream` / Node Readable 流。
- 默认 `Content-Disposition: inline`。

路由已经由管理员明确发布，因此匹配后由后端内部系统主体读取目标 FS 资源，不建立新的访客 ACL。

## 8. 管理接口

```text
GET    /api/admin/public-routes
GET    /api/admin/public-routes/status
POST   /api/admin/public-routes/status/batch
POST   /api/admin/public-routes
PUT    /api/admin/public-routes/:id
DELETE /api/admin/public-routes/:id

POST /api/admin/public-routes/bulk/enable
POST /api/admin/public-routes/bulk/disable
POST /api/admin/public-routes/bulk/delete
```

所有管理接口仅管理员可调用。

## 9. 前端入口

### 9.1 网盘管理

文件和文件夹右键菜单为管理员提供“公开访问设置”：

- 根据 FS 路径反向查询现有路由。
- 新建公开路径。
- 修改公开路径并重新启用。
- 清空公开路径后保存以取消公开。

API 密钥用户即使有网盘写权限也不会看到该入口，因为公开路由管理 API 仅允许管理员。

### 9.2 后台公开路由管理

后台路径：

```text
/admin/public-routes
```

页面支持：

- 查看公开 URL、目标 FS 路径、目标类型、状态和更新时间。
- 按公开路径或 FS 路径搜索。
- 按启用状态筛选。
- 单条启用、关闭和删除。
- 多选后批量启用、关闭和删除。
- 复制公开 URL 或在新窗口访问。

## 10. 数据库迁移

- Schema 版本由 34 升级到 36；版本 35 已被既有发布占用，保留为空迁移以兼容历史记录。
- 新数据库初始化时创建 `public_routes` 和索引。
- 旧数据库升级到版本 36 时幂等创建表和索引。
- 不迁移现有 `/file/{slug}` 分享记录。

## 11. 已覆盖测试

公开路由服务测试覆盖：

- 公开路径和目标路径规范化。
- 点路径段拒绝。
- 系统保留路径冲突。
- 带边界的父子路径判断。
- 文件精确匹配。
- 文件夹根路径到 `index.html`。
- 文件夹子路径映射。
- 最长公开路径优先。
- 关闭路由不参与解析。

## 12. 当前限制

- 创建路由时不主动验证目标是否存在，实际访问由存储层返回目标不存在。
- 文件或目录移动、重命名、删除后，路由不会自动改写；应在后台删除或修改失效路由。
- 公开路径由当前 CloudPaste 主域名提供，不包含按 hostname 分表或多域名配置。
- 根路径 `/` 保留给 CloudPaste 主站，不能配置为公开路由。
- 文件夹根地址固定读取 `index.html`，不可配置其他首页文件。

## 13. 验收标准

- 管理员可在网盘中为文件或文件夹设置自定义公开路径。
- 公开文件 URL 直接返回文件内容。
- 公开文件夹根地址返回目标目录的 `index.html`。
- 文件夹子资源按照相对路径直接访问。
- `/api`、`/dav`、后台、分享页和网盘管理路径不会被公开路由抢占。
- 后台可查看路由清单并执行单条和批量启停、删除。
- 取消或关闭路由后，公开 URL 立即停止命中对应 FS 目标。
- 现有文件分享、WebDAV 和 CloudPaste 前端行为保持兼容。

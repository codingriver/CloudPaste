# GitHub Release 加密存储库设计

## 背景与目标

CloudPaste 需要新增一种独立的存储库类型，用 GitHub Release 作为加密文件的数据面，并尽量避免大文件上传、下载流量经过 CloudPaste 后台 Worker。

该方案面向管理后台场景：前端允许持有 GitHub Token，并优先尝试让浏览器直接和 GitHub Release Assets 交互。实际验证中，GitHub 默认上传端点 `https://uploads.github.com` 不允许浏览器跨域预检请求，因此默认 GitHub 端点下上传和删除需要通过 CloudPaste 后端代理兜底；加密、压缩、分包、manifest 生成仍在前端完成。

新增存储库类型建议命名为：

```text
github_release_encrypted
```

## 设计原则

- 新存储库类型必须与现有存储库实现完全隔离，不复用现有后端上传、下载、预览、代理传输流程。
- CloudPaste 作为控制面，只负责存储库配置、密钥保存、权限校验和必要的管理 API。
- GitHub Release 作为数据面，保存 manifest、目录索引和加密后的文件分包。
- 前端负责文件压缩、分包、加密、上传、下载、解密、合并和解压。
- 大文件下载默认绕过 CloudPaste Worker；上传在 GitHub 官方 `uploads.github.com` 端点下受 CORS 限制，需要后端代理兜底，或配置支持 CORS 的可信上传中转服务。
- manifest 可以保存目录、文件名、大小、时间、权限展示字段和分包信息，但不能保存明文加密密钥。
- CloudPaste 数据库可以明文保存文件密钥，便于迁移和管理。
- manifest 中的权限只作为前端展示和索引字段，真正的下载授权必须在 CloudPaste 返回密钥时校验。
- 文件内容修改不做原地覆盖，按新分包、新密钥、新 manifest 的方式替换。
- 删除、替换等破坏性操作应优先考虑可恢复顺序，避免 manifest、密钥和 GitHub assets 状态不一致。

## 数据边界

### CloudPaste 数据库

CloudPaste 只保存控制面数据：

```json
{
  "storageId": "repo_xxx",
  "type": "github_release_encrypted",
  "owner": "github-owner",
  "repo": "cloudpaste-storage",
  "releaseId": 123456,
  "releaseTag": "cloudpaste-main"
}
```

文件密钥表保存：

```json
{
  "fileId": "f_abc123",
  "storageId": "repo_xxx",
  "encryptionKey": "base64-key",
  "createdBy": "admin",
  "createdAt": "2026-06-22T10:00:00Z",
  "updatedAt": "2026-06-22T10:00:00Z",
  "deleted": false
}
```

### GitHub Release

GitHub Release 保存数据面文件：

```text
index.manifest.json
chunk__f_abc123__000000.enc
chunk__f_abc123__000001.enc
chunk__f_abc123__000002.enc
```

如果后续文件数量较大，可以拆分为：

```text
index.manifest.json
manifest__f_abc123.json
chunk__f_abc123__000000.enc
chunk__f_abc123__000001.enc
```

初期优先使用单个 `index.manifest.json`，实现更简单，迁移也更直接。

## Manifest 结构

`index.manifest.json` 保存前端展示和下载所需的索引数据：

```json
{
  "version": 1,
  "storageType": "github_release_encrypted",
  "storageId": "repo_xxx",
  "updatedAt": "2026-06-22T10:00:00Z",
  "files": [
    {
      "fileId": "f_abc123",
      "type": "file",
      "path": "/docs/demo.pdf",
      "name": "demo.pdf",
      "mime": "application/pdf",
      "originalSize": 12345678,
      "compressedSize": 4567890,
      "encryptedSize": 4569000,
      "compression": "gzip",
      "encryption": "AES-GCM",
      "chunkSize": 67108864,
      "createdAt": "2026-06-22T09:00:00Z",
      "updatedAt": "2026-06-22T09:10:00Z",
      "permissions": {
        "visibility": "private",
        "downloadRole": "admin"
      },
      "chunks": [
        {
          "index": 0,
          "assetName": "chunk__f_abc123__000000.enc",
          "assetId": 111,
          "size": 4569000,
          "iv": "base64-iv",
          "sha256": "base64-sha256"
        }
      ]
    }
  ]
}
```

注意：

- `permissions` 只用于界面展示和前端索引。
- `encryptionKey` 不得写入 manifest。
- `fileId` 是 CloudPaste 密钥表和 GitHub manifest 之间的关联主键。

## 前端处理要求

上传前处理顺序：

```text
原始文件 -> 压缩 -> 分包 -> 加密每个分包 -> 上传 GitHub Release
```

下载后处理顺序：

```text
下载加密分包 -> 解密 -> 合并 -> 解压 -> 保存原始文件
```

建议：

- 加密使用浏览器 WebCrypto API 的 `AES-GCM`。
- 每个分包使用独立 IV。
- 分包大小默认可从 64MB 或 128MB 起步。
- 每个分包记录 sha256，用于下载后校验。
- 不要先加密再压缩，因为加密后的数据难以压缩。

## CloudPaste API 边界

CloudPaste 后台只提供轻量控制面 API：

```http
POST /api/storage
GET /api/storage/:storageId/github-release/config

POST /api/storage/:storageId/github-release/files/:fileId/key
GET /api/storage/:storageId/github-release/files/:fileId/key
PUT /api/storage/:storageId/github-release/files/:fileId/key
DELETE /api/storage/:storageId/github-release/files/:fileId/key
```

默认 GitHub 上传端点受浏览器 CORS 限制时，CloudPaste 额外提供 Release Asset 代理兜底：

```http
POST /api/storage/:storageId/github-release/assets?releaseId=:releaseId&name=:assetName
DELETE /api/storage/:storageId/github-release/assets/:assetId
```

这两个接口只转发已经在浏览器端加密后的 manifest 或分包内容，不接收明文文件，也不执行压缩、加密、解密、合并或解压。

## CRUD 流程

### 创建文件

```text
1. 前端读取 index.manifest.json。
2. 用户选择文件。
3. 前端生成 fileId 和 AES key。
4. 前端压缩文件。
5. 前端分包。
6. 前端加密每个分包。
7. 前端上传加密分包到 GitHub Release；如果 GitHub 上传端点被 CORS 阻止，则经 CloudPaste 后端代理转发。
8. 前端更新 index.manifest.json。
9. 前端上传新的 index.manifest.json 到 GitHub Release。
10. 前端调用 CloudPaste 保存 fileId -> encryptionKey。
```

失败处理：

- 如果分包上传失败，不更新 manifest，不保存 key。
- 如果 manifest 更新失败，保留已上传分包并提示重试或清理。
- 如果 key 保存失败，提示文件已上传但未登记密钥，允许重试保存 key。

### 查询文件

```text
1. 前端直接从 GitHub Release 下载 index.manifest.json。
2. 前端根据 path、name、type、size、time、permissions 构建目录树。
3. 普通目录浏览不请求 CloudPaste。
```

只有需要获取密钥、校验后台权限或管理存储库配置时，才请求 CloudPaste。

### 下载文件

```text
1. 用户点击下载。
2. 前端根据 manifest 找到 fileId 和 chunks。
3. 前端请求 CloudPaste 获取 fileId 对应 encryptionKey。
4. CloudPaste 校验权限后返回明文 key。
5. 前端直接从 GitHub Release 下载加密分包。
6. 前端校验 sha256。
7. 前端解密分包。
8. 前端合并并解压。
9. 前端保存原始文件。
```

该流程中 CloudPaste 不承载文件下载流量。

### 修改文件内容

GitHub Release Asset 不按原地覆盖设计。修改文件内容按替换处理：

```text
1. 前端上传新的加密分包。
2. 前端生成新的 encryptionKey。
3. 前端更新 manifest 中对应 fileId 的 chunks、size、updatedAt、hash 等字段。
4. 前端上传新的 index.manifest.json。
5. 前端调用 CloudPaste 更新 fileId -> new encryptionKey。
6. 前端删除旧的 GitHub Release 分包 assets。
```

更稳妥的实现可以增加 pending 状态：

```text
上传新分包 -> 保存 pending key -> 更新 manifest -> 激活 key -> 删除旧分包
```

### 重命名和移动目录

重命名、移动目录、修改展示权限等元数据操作不需要重新上传文件：

```text
1. 前端修改 manifest 中的 path、name 或 permissions。
2. 前端上传新的 index.manifest.json；默认 GitHub 上传端点下经 CloudPaste 后端代理转发。
```

CloudPaste 不需要更新密钥。

### 删除文件

建议优先使用软删除流程：

```text
1. 前端将 manifest 中的文件标记为 deleted: true。
2. 前端上传新的 index.manifest.json。
3. 前端调用 CloudPaste 删除或软删除 fileId 对应 key。
4. 前端删除 GitHub Release 上的分包 assets。
5. 前端从 manifest 中移除文件记录。
6. 前端再次上传 index.manifest.json。
```

简单管理后台也可以直接硬删除，但需要处理失败重试，避免出现 manifest 已删除但 GitHub 分包残留或 key 残留。

## 与现有存储库的隔离要求

实现时必须保持以下隔离：

- 独立的 storage type：`github_release_encrypted`。
- 独立的上传组件，不走现有后端上传流。
- 独立的下载组件，不走现有代理下载接口。
- 独立的 manifest 解析器和前端索引构建逻辑。
- 独立的密钥表或明确区分的密钥记录。
- 独立的 GitHub Release 配置。
- 不影响现有 GitHub API/Releases 只读存储能力。

## Worker Invocation 保护

本方案的主要目标之一是减少 CloudPaste Worker invocation 压力。

目标请求路径：

```text
管理和密钥请求：
浏览器 -> CloudPaste Worker -> 数据库

文件上传：
浏览器 -> GitHub Release（仅当端点支持浏览器 CORS 直传）

默认 GitHub 上传兜底：
浏览器 -> CloudPaste Worker -> GitHub Release

文件下载：
浏览器 -> GitHub Release

文件加解密：
浏览器本地完成
```

因此，CloudPaste Worker 不应参与：

- 加密分包下载。
- 文件压缩。
- 文件解压。
- 文件加密。
- 文件解密。
- 大文件合并。

由于 GitHub 官方上传端点不支持浏览器跨域直传，上传代理是可用性兜底，会消耗 Worker invocation、请求体和超时额度。若目标是严格绕过 Worker 文件传输，应优先选择 R2/S3 这类支持浏览器直传的对象存储，或接入一个支持 CORS 的非 Cloudflare 上传中转。

## 风险与限制

- 前端持有 GitHub Token 只适合管理后台或可信使用场景。
- GitHub Release Asset 不适合高并发、大规模对象存储场景。
- GitHub Release Asset 不支持可靠的原地覆盖，更新应按新 asset 替换处理。
- GitHub Release Asset 官方上传端点不支持浏览器 CORS 直传，管理后台上传默认会走 CloudPaste 代理兜底。
- 文件数量很多时，单个 manifest 会变大，需要升级为 index + per-file manifest。
- 多管理员同时修改 manifest 可能产生覆盖冲突，需要后续增加版本号或乐观锁。
- GitHub API rate limit 会影响大批量分包上传、删除和 assets 列表操作。

## 后续实现优先级

1. 新增 `github_release_encrypted` 存储库配置和密钥保存 API。
2. 实现前端读取和更新 `index.manifest.json`。
3. 实现前端压缩、分包、AES-GCM 加密和 GitHub Release 上传；默认 GitHub 端点通过 CloudPaste 代理兜底。
4. 实现前端下载、解密、合并和解压。
5. 实现文件重命名、移动、删除和 manifest 更新。
6. 增加失败重试、残留分包清理和 manifest 冲突检测。

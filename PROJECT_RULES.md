# CloudPaste 项目规则

## 部署指令默认语义

- 在本项目的对话、任务和操作中，用户未明确指定目标平台时，凡提到“部署”“更新部署”“重新部署”“发布”“上线”“发版”“部署项目”“更新线上版本”“打包”“打包发布”“构建发布”“release”“publish”及其他语义相近的表述，均默认指：将当前 CloudPaste 项目部署到远程 Cloudflare Workers。
- 默认部署对象固定为 Cloudflare Workers 上的 `cloudpaste` Worker 项目。
- 默认部署配置固定为 `backend/wrangler.spa.toml`，该文件中的 `name = "cloudpaste"` 是默认远程 Worker 目标的权威来源。
- 用户没有明确指定配置文件、部署模式或平台时，一律使用默认配置 `backend/wrangler.spa.toml` 进行远程部署。
- 用户只说“默认配置”“线上配置”“生产配置”“远程部署”“打包发布”“发布线上”等但未给出具体配置文件时，也必须解析为 `backend/wrangler.spa.toml`。
- 不得因为当前工作目录存在 `wrangler.toml`、`package.json` 中有其他部署脚本、GitHub Actions 中出现其他 Worker 名称或历史文档写法，而改用其他配置文件。
- 默认部署命令必须在 `backend/` 目录执行：`npx wrangler deploy --config wrangler.spa.toml`。
- 如需打包/发布，应先构建 `frontend/` 生产静态资源，并通过 `backend/wrangler.spa.toml` 的 `[assets] directory = "../frontend/dist"` 随 Worker 一体化发布。
- `backend/wrangler.toml` 仅用于用户明确要求“前后端分离的后端 Worker 部署”时使用，不得作为默认部署配置。
- `backend/wrangler.spa.local.toml` 仅用于本地或临时测试，不得作为远程默认部署配置。
- 只有用户明确写出其他配置文件路径或明确要求其他部署方式时，才允许偏离 `backend/wrangler.spa.toml`。
- 不得在未获得用户明确指示时，将上述部署/发布/打包指令解释为 Docker、Docker Compose、Cloudflare Pages、Vercel、Node.js 服务器、本地 Wrangler dev 或其他平台的部署。
- 如果用户明确指定其他平台、项目名称、环境或部署方式，则以该次明确指示为准。
- 涉及真实线上部署、更新或覆盖前，应先核对当前 Git 工作区、构建结果、`backend/wrangler.spa.toml`、目标 Worker 名称 `cloudpaste`、D1 绑定和必要 Secrets/变量，避免发布错误代码或错误环境。
- 如果文档、脚本或工作流中出现其他默认 Worker 名称（例如 `cloudpaste-spa`），不得据此改变默认目标；应以 `backend/wrangler.spa.toml` 的 `name = "cloudpaste"` 和本规则为准，并向用户说明不一致。

## Worker Invocation 保护

CloudPaste 的部署目标包含 Cloudflare Workers。所有新增或修改的文件管理操作，都必须默认考虑 Worker 单次 invocation 的时间、内存、CPU、子请求和第三方 API 调用限制。

### 必须按后台任务处理的操作

以下操作不得在一次 HTTP 请求内同步递归完成：

- 目录复制、目录移动、目录删除、目录重命名。
- 批量复制、批量移动、批量删除、批量下载前的目录展开。
- 跨存储库操作，尤其是 S3/R2/Backblaze/GitHub/WebDAV 之间的复制或移动。
- 需要枚举大量对象、分页 list、逐文件 copy/delete/put/get 的操作。
- 任何文件数量、目录层级或对象大小不可预估的操作。

这些操作应创建后台任务，并通过 Workflow 或等价任务编排机制分片执行。

### 分片与续跑要求

- 每个任务必须保存 checkpoint，例如当前 item index、目录分页游标、当前阶段、已处理数量、失败项和必要的目录状态。
- 单个 chunk 只处理有限数量对象，跨存储目录复制应保守控制单次处理量，避免耗尽子请求预算。
- 任务需要支持续跑，当前 invocation 接近限制、遇到平台级限流、分页未完成或 chunk 未完成时，必须返回非终态并调度下一次执行。
- 复制/移动/删除目录时，必须区分阶段：统计、复制、校验、删除源、完成。
- 移动目录必须先确认复制完成，再删除源目录；复制失败或部分失败时不得删除源。
- 目录重命名在对象存储中本质上是目录移动，必须走后台任务，不得同步递归 rename。

### 状态与进度要求

- 后台任务进入执行后，Workflow 接力、queued、waiting 等非终态状态不得让界面误显示为已完成。
- 已开始的分片任务在续跑接力期间应保持 `running`，避免进度从 `running` 抖回 `pending`。
- 完成状态只能在所有 chunk 和后续校验完成后写入。
- 进度必须同时包含批量 item 进度和目录对象进度，例如 `processedItems/totalItems` 与 `processedObjects/totalObjects`。
- 任务统计应记录 `successCount`、`failedCount`、`skippedCount`、失败项和 `invocationLimitReachedCount`。

### 错误处理要求

- Worker invocation/subrequest/time limit 类错误不得在同一 invocation 内无限重试。
- 可恢复错误应保存当前 checkpoint 后调度续跑。
- 不可恢复错误应标记当前 item 失败，并继续处理其他 item，最终给出 `partial` 或 `failed`。
- 删除、移动等破坏性操作必须避免在复制未确认成功时执行源删除。

### 测试要求

修改批量、目录、跨存储或任务状态相关代码时，必须至少验证：

- 单文件复制、移动、删除。
- 目录复制、目录移动、目录删除。
- 跨 S3 存储库目录复制或移动。
- 大于一个 chunk 的目录任务，确认中间状态不会误报 `completed`。
- Workflow 续跑期间状态不会从 `running` 抖回 `pending`。
- 最终目标文件可读取，源目录在移动/删除语义下符合预期。
- 清理测试目录，避免测试垃圾留在真实存储中。

### 代码审查重点

- 是否有同步递归目录操作。
- 是否有未分页或无上限的 list/copy/delete 循环。
- 是否在一次请求内处理不可预估数量的对象。
- 是否保存了足够的 checkpoint 来恢复执行。
- 是否把 Workflow 中间态误映射为任务终态。
- 是否在跨存储 copy/move 中正确处理失败、跳过和部分成功。

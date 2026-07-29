# CloudPaste Agent Rules

本文件是仓库根目录级 agent 规则，适用于整个项目。执行任何任务前，应同时遵守 `PROJECT_RULES.md`。

## 默认部署语义

- 用户未明确指定其他目标时，凡提到“部署”“更新部署”“重新部署”“上线”“发布”“发版”“打包”“打包发布”“构建发布”“release”“publish”等语义相近表述，均默认表示：将当前 CloudPaste 项目部署到远程 Cloudflare Workers。
- 默认远程部署目标固定为 Cloudflare Workers 上的 `cloudpaste` Worker。
- 默认部署不是 Docker、Docker Compose、Cloudflare Pages、Vercel、本地 Node.js 服务、本地 Wrangler dev，也不是只生成本地构建产物。
- 如果用户明确指定其他平台、环境、项目名或只要求本地构建/测试，则以该次明确指示为准。

## 默认部署配置

- 默认一体化部署配置文件是 `backend/wrangler.spa.toml`。
- 用户没有明确指定配置文件、部署模式或平台时，一律使用默认配置 `backend/wrangler.spa.toml` 进行远程部署。
- 用户只说“默认配置”“线上配置”“生产配置”“远程部署”“打包发布”“发布线上”等但未给出具体配置文件时，也必须解析为 `backend/wrangler.spa.toml`。
- 不得因为当前工作目录存在 `wrangler.toml`、`package.json` 中有其他部署脚本、GitHub Actions 中出现其他 Worker 名称或历史文档写法，而改用其他配置文件。
- `backend/wrangler.spa.toml` 中的 `name = "cloudpaste"` 是默认远程 Worker 目标的权威来源。
- 默认部署命令必须在 `backend/` 目录执行：`npx wrangler deploy --config wrangler.spa.toml`。
- 前端静态资源由 `backend/wrangler.spa.toml` 的 `[assets] directory = "../frontend/dist"` 绑定；需要打包/发布时，应先在 `frontend/` 构建生产静态资源，再用上述 Wrangler 配置部署。
- `backend/wrangler.toml` 仅用于“前后端分离的后端 Worker 部署”，不得作为默认部署配置。
- `backend/wrangler.spa.local.toml` 仅用于本地或临时测试，不得作为远程默认部署配置。
- 只有用户明确写出其他配置文件路径或明确要求其他部署方式时，才允许偏离 `backend/wrangler.spa.toml`。

## 发布前检查

- 真实远程部署前必须核对当前 Git 工作区、构建结果、`backend/wrangler.spa.toml`、目标 Worker 名称 `cloudpaste`、D1 绑定和必要 Secrets/变量。
- 如果发现文档、脚本或工作流中出现其他默认 Worker 名称（例如 `cloudpaste-spa`），不得据此改变默认目标；应以 `backend/wrangler.spa.toml` 的 `name = "cloudpaste"` 和本规则为准，并向用户说明不一致。
- 不得在未获用户明确授权时部署到 Cloudflare Pages、Docker、Vercel 或其他远程平台。

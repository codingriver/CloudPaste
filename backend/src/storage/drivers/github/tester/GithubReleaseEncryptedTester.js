import { ValidationError } from "../../../../http/errors.js";

export async function githubReleaseEncryptedTestConnection(config) {
  const owner = config?.owner ? String(config.owner).trim() : "";
  const repo = config?.repo ? String(config.repo).trim() : "";
  const releaseId = config?.release_id ? String(config.release_id).trim() : "";
  const releaseTag = config?.release_tag ? String(config.release_tag).trim() : "";

  const errors = [];
  if (!owner) errors.push("缺少 owner");
  if (!repo) errors.push("缺少 repo");
  if (!releaseId && !releaseTag) errors.push("需要 release_id 或 release_tag");
  if (errors.length) {
    throw new ValidationError(`GitHub Release 加密存储配置无效：${errors.join("，")}`);
  }

  return {
    success: true,
    message: "GitHub Release 加密存储配置有效。文件流由前端直连 GitHub Release，CloudPaste 仅保存密钥。",
    result: {
      info: {
        owner,
        repo,
        releaseId: releaseId || null,
        releaseTag: releaseTag || null,
        apiBase: config?.api_base || "https://api.github.com",
        uploadBase: config?.upload_base || "https://uploads.github.com",
        manifestAssetName: config?.manifest_asset_name || "index.manifest.json",
      },
      checks: [
        {
          key: "control-plane",
          label: "控制面配置",
          success: true,
          note: "未执行文件上传/下载测试",
        },
      ],
    },
  };
}

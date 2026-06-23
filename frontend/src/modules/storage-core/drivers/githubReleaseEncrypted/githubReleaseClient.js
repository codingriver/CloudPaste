const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_UPLOAD_BASE = "https://uploads.github.com";

function requireValue(value, name) {
  const normalized = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  if (!normalized) {
    throw new Error(`Missing ${name}`);
  }
  return normalized;
}

function buildHeaders(token, extra = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function parseGithubError(response) {
  const text = await response.text().catch(() => "");
  try {
    const json = text ? JSON.parse(text) : null;
    return json?.message || text || `GitHub request failed: ${response.status}`;
  } catch {
    return text || `GitHub request failed: ${response.status}`;
  }
}

export function createGithubReleaseClient(config = {}, token = "", options = {}) {
  const owner = requireValue(config.owner, "owner");
  const repo = requireValue(config.repo, "repo");
  const apiBase = (config.apiBase || config.api_base || DEFAULT_API_BASE).replace(/\/+$/, "");
  const uploadBase = (config.uploadBase || config.upload_base || DEFAULT_UPLOAD_BASE).replace(/\/+$/, "");

  const requestJson = async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: buildHeaders(token, options.headers || {}),
    });
    if (!response.ok) {
      throw new Error(await parseGithubError(response));
    }
    return response.json();
  };

  const resolveRelease = async () => {
    if (config.releaseId || config.release_id) {
      return { id: config.releaseId || config.release_id, tag_name: config.releaseTag || config.release_tag || null };
    }
    const tag = requireValue(config.releaseTag || config.release_tag, "releaseTag");
    return requestJson(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`);
  };

  const listAssets = async (releaseId) => {
    const id = releaseId || (await resolveRelease()).id;
    const allAssets = [];
    let page = 1;
    while (true) {
      const pageAssets = await requestJson(
        `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${id}/assets?per_page=100&page=${page}`,
      );
      if (!Array.isArray(pageAssets) || pageAssets.length === 0) break;
      allAssets.push(...pageAssets);
      if (pageAssets.length < 100) break;
      page += 1;
    }
    return allAssets;
  };

  const uploadAsset = async ({ releaseId, name, blob, contentType = "application/octet-stream" }) => {
    const id = releaseId || (await resolveRelease()).id;
    const assetName = requireValue(name, "name");
    if (typeof options.uploadAssetProxy === "function") {
      return options.uploadAssetProxy({ releaseId: id, name: assetName, blob, contentType });
    }
    const url = new URL(`${uploadBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${id}/assets`);
    url.searchParams.set("name", assetName);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(token, {
        "Content-Type": contentType,
      }),
      body: blob,
    });
    if (!response.ok) {
      throw new Error(await parseGithubError(response));
    }
    return response.json();
  };

  const deleteAsset = async (assetId) => {
    const id = requireValue(assetId, "assetId");
    if (typeof options.deleteAssetProxy === "function") {
      await options.deleteAssetProxy(id);
      return true;
    }
    const response = await fetch(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/${id}`, {
      method: "DELETE",
      headers: buildHeaders(token),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(await parseGithubError(response));
    }
    return true;
  };

  const downloadAsset = async (asset) => {
    const apiUrl = asset?.url || "";
    const browserUrl = asset?.browser_download_url || "";
    const url = token && apiUrl ? apiUrl : browserUrl;
    if (!url) {
      throw new Error("Missing asset download url");
    }
    const response = await fetch(url, {
      headers: token && apiUrl ? buildHeaders(token, { Accept: "application/octet-stream" }) : {},
    });
    if (!response.ok) {
      throw new Error(await parseGithubError(response));
    }
    return response.blob();
  };

  const downloadAssetByBrowserUrl = async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }
    return response.blob();
  };

  return {
    owner,
    repo,
    apiBase,
    uploadBase,
    resolveRelease,
    listAssets,
    uploadAsset,
    deleteAsset,
    downloadAsset,
    downloadAssetByBrowserUrl,
  };
}

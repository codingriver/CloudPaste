const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const EMPTY_MANIFEST = Object.freeze({
  version: 1,
  storageType: "github_release_encrypted",
  files: [],
});

export function createFileId() {
  return `f_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function sha256Base64(blobOrBuffer) {
  const buffer = blobOrBuffer instanceof ArrayBuffer ? blobOrBuffer : await blobOrBuffer.arrayBuffer();
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
}

export async function generateAesKey() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = await crypto.subtle.exportKey("raw", key);
  return {
    cryptoKey: key,
    base64: bytesToBase64(new Uint8Array(raw)),
  };
}

export async function importAesKey(base64Key) {
  return crypto.subtle.importKey("raw", base64ToBytes(base64Key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function compressBlob(blob, compression = "gzip") {
  if (compression === "none") return blob;
  if (compression !== "gzip") throw new Error(`Unsupported compression: ${compression}`);
  if (typeof CompressionStream !== "function") {
    throw new Error("当前浏览器不支持 CompressionStream，无法执行 gzip 压缩");
  }
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).blob();
}

export async function decompressBlob(blob, compression = "gzip") {
  if (compression === "none") return blob;
  if (compression !== "gzip") throw new Error(`Unsupported compression: ${compression}`);
  if (typeof DecompressionStream !== "function") {
    throw new Error("当前浏览器不支持 DecompressionStream，无法执行 gzip 解压");
  }
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).blob();
}

export async function encryptChunk(blob, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await blob.arrayBuffer());
  return {
    blob: new Blob([encrypted], { type: "application/octet-stream" }),
    iv: bytesToBase64(iv),
  };
}

export async function decryptChunk(blob, key, ivBase64) {
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(ivBase64) }, key, await blob.arrayBuffer());
  return new Blob([decrypted], { type: "application/octet-stream" });
}

export async function readManifestFromAsset(client, asset) {
  if (!asset) return { ...EMPTY_MANIFEST, files: [] };
  const blob = await client.downloadAsset(asset);
  const text = textDecoder.decode(await blob.arrayBuffer());
  const parsed = JSON.parse(text);
  return {
    ...EMPTY_MANIFEST,
    ...parsed,
    files: Array.isArray(parsed?.files) ? parsed.files : [],
  };
}

export function buildManifestBlob(manifest) {
  return new Blob([textEncoder.encode(JSON.stringify(manifest, null, 2))], {
    type: "application/json",
  });
}

export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function normalizeManifest(manifest, storageId) {
  return {
    ...EMPTY_MANIFEST,
    ...manifest,
    storageType: "github_release_encrypted",
    storageId,
    updatedAt: new Date().toISOString(),
    files: Array.isArray(manifest?.files) ? manifest.files : [],
  };
}

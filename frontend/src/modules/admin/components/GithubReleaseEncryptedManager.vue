<script setup>
import { computed, ref, watch } from "vue";
import { IconCheckCircle, IconClose, IconDelete, IconDownload, IconRefresh, IconUpload } from "@/components/icons";
import { useAdminStorageConfigService } from "@/modules/admin/services/storageConfigService.js";
import { createGithubReleaseClient } from "@/modules/storage-core";
import {
  buildManifestBlob,
  compressBlob,
  createFileId,
  decryptChunk,
  decompressBlob,
  EMPTY_MANIFEST,
  encryptChunk,
  generateAesKey,
  importAesKey,
  normalizeManifest,
  readManifestFromAsset,
  saveBlob,
  sha256Base64,
} from "@/modules/storage-core/drivers/githubReleaseEncrypted/manifestTransfer.js";

const props = defineProps({
  isOpen: { type: Boolean, default: false },
  darkMode: { type: Boolean, default: false },
  config: { type: Object, required: true },
});

const emit = defineEmits(["close"]);

const {
  getStorageConfigReveal,
  getGithubReleaseEncryptedConfig,
  getGithubReleaseInitializationStatus,
  initializeGithubReleaseStorage,
  saveGithubReleaseFileKey,
  updateGithubReleaseFileKey,
  getGithubReleaseFileKey,
  deleteGithubReleaseFileKey,
} = useAdminStorageConfigService();

const loading = ref(false);
const busy = ref(false);
const initializing = ref(false);
const error = ref("");
const message = ref("");
const clientConfig = ref(null);
const token = ref("");
const release = ref(null);
const initStatus = ref(null);
const assets = ref([]);
const manifest = ref({ ...EMPTY_MANIFEST, files: [] });
const selectedFile = ref(null);
const targetPath = ref("/");
const progressText = ref("");

const storageId = computed(() => props.config?.id);
const fileItems = computed(() => (Array.isArray(manifest.value?.files) ? manifest.value.files.filter((item) => !item.deleted) : []));
const manifestAssetName = computed(() => clientConfig.value?.manifestAssetName || "index.manifest.json");
const manifestAsset = computed(() => assets.value.find((asset) => asset.name === manifestAssetName.value) || null);
const isInitialized = computed(() => Boolean(initStatus.value?.initialized || release.value?.id));

const getClient = () => createGithubReleaseClient(clientConfig.value, token.value);

const setInfo = (text) => {
  message.value = text;
  error.value = "";
};

const setError = (err) => {
  error.value = err?.message || String(err || "操作失败");
  message.value = "";
};

const loadAll = async () => {
  if (!storageId.value) return;
  loading.value = true;
  progressText.value = "";
  try {
    const [cfg, reveal, status] = await Promise.all([
      getGithubReleaseEncryptedConfig(storageId.value),
      getStorageConfigReveal(storageId.value, "plain"),
      getGithubReleaseInitializationStatus(storageId.value).catch((err) => ({ initialized: false, message: err?.message || "初始化状态检查失败" })),
    ]);
    clientConfig.value = cfg;
    token.value = reveal?.token || "";
    initStatus.value = status;
    release.value = null;
    assets.value = [];
    manifest.value = normalizeManifest(EMPTY_MANIFEST, storageId.value);

    if (!status?.initialized) {
      setInfo(status?.message || "GitHub Release 尚未初始化，请先执行初始化");
      return;
    }

    const client = getClient();
    release.value = await client.resolveRelease();
    assets.value = await client.listAssets(release.value.id);
    manifest.value = normalizeManifest(await readManifestFromAsset(client, manifestAsset.value), storageId.value);
    setInfo("已加载 GitHub Release manifest");
  } catch (err) {
    setError(err);
  } finally {
    loading.value = false;
  }
};

const checkInitialization = async () => {
  if (!storageId.value) return;
  busy.value = true;
  try {
    const status = await getGithubReleaseInitializationStatus(storageId.value);
    initStatus.value = status;
    if (status?.initialized) {
      setInfo(status.message || "GitHub Release 已初始化");
      await loadAll();
    } else {
      release.value = null;
      assets.value = [];
      manifest.value = normalizeManifest(EMPTY_MANIFEST, storageId.value);
      setInfo(status?.message || "GitHub Release 尚未初始化");
    }
  } catch (err) {
    setError(err);
  } finally {
    busy.value = false;
  }
};

const initializeRelease = async () => {
  if (!storageId.value) return;
  initializing.value = true;
  try {
    const result = await initializeGithubReleaseStorage(storageId.value);
    initStatus.value = result;
    setInfo(result?.message || (result?.created ? "GitHub Release 初始化完成" : "GitHub Release 已初始化"));
    await loadAll();
  } catch (err) {
    setError(err);
  } finally {
    initializing.value = false;
  }
};

const uploadManifest = async (nextManifest) => {
  if (!release.value?.id) {
    throw new Error("GitHub Release 尚未初始化");
  }
  const client = getClient();
  const currentManifestAsset = assets.value.find((asset) => asset.name === manifestAssetName.value) || null;
  if (currentManifestAsset?.id) {
    await client.deleteAsset(currentManifestAsset.id);
  }
  const asset = await client.uploadAsset({
    releaseId: release.value.id,
    name: manifestAssetName.value,
    blob: buildManifestBlob(nextManifest),
    contentType: "application/json",
  });
  assets.value = await client.listAssets(release.value.id);
  return asset;
};

const handleFileChange = (event) => {
  selectedFile.value = event.target.files?.[0] || null;
  if (selectedFile.value && (!targetPath.value || targetPath.value === "/")) {
    targetPath.value = `/${selectedFile.value.name}`;
  }
};

const uploadSelectedFile = async () => {
  if (!selectedFile.value) return;
  busy.value = true;
  try {
    const file = selectedFile.value;
    const fileId = createFileId();
    const compression = clientConfig.value?.compression || "gzip";
    const chunkSize = Math.max(1, Number(clientConfig.value?.chunkSizeMb || 64)) * 1024 * 1024;
    const chunkPrefix = clientConfig.value?.chunkAssetPrefix || "chunk__";
    const normalizedPath = targetPath.value && targetPath.value.startsWith("/") ? targetPath.value : `/${targetPath.value || file.name}`;
    const name = normalizedPath.split("/").filter(Boolean).pop() || file.name;
    const encryptedKey = await generateAesKey();
    const compressed = await compressBlob(file, compression);
    const client = getClient();
    const chunks = [];
    const totalChunks = Math.max(1, Math.ceil(compressed.size / chunkSize));

    for (let index = 0; index < totalChunks; index += 1) {
      progressText.value = `加密并上传分包 ${index + 1}/${totalChunks}`;
      const start = index * chunkSize;
      const end = Math.min(compressed.size, start + chunkSize);
      const plainChunk = compressed.slice(start, end);
      const encrypted = await encryptChunk(plainChunk, encryptedKey.cryptoKey);
      const assetName = `${chunkPrefix}${fileId}__${String(index).padStart(6, "0")}.enc`;
      const asset = await client.uploadAsset({
        releaseId: release.value.id,
        name: assetName,
        blob: encrypted.blob,
        contentType: "application/octet-stream",
      });
      chunks.push({
        index,
        assetId: asset.id,
        assetName,
        size: encrypted.blob.size,
        iv: encrypted.iv,
        sha256: await sha256Base64(encrypted.blob),
        browserDownloadUrl: asset.browser_download_url,
      });
    }

    const nextManifest = normalizeManifest(
      {
        ...manifest.value,
        files: [
          ...fileItems.value,
          {
            fileId,
            type: "file",
            path: normalizedPath,
            name,
            mime: file.type || "application/octet-stream",
            originalSize: file.size,
            compressedSize: compressed.size,
            encryptedSize: chunks.reduce((sum, chunk) => sum + chunk.size, 0),
            compression,
            encryption: "AES-GCM",
            chunkSize,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            permissions: { visibility: "private", downloadRole: "admin" },
            chunks,
          },
        ],
      },
      storageId.value,
    );

    progressText.value = "更新 manifest";
    await uploadManifest(nextManifest);
    progressText.value = "保存文件密钥";
    await saveGithubReleaseFileKey(storageId.value, fileId, encryptedKey.base64);
    manifest.value = nextManifest;
    selectedFile.value = null;
    setInfo("文件上传完成");
  } catch (err) {
    setError(err);
  } finally {
    busy.value = false;
    progressText.value = "";
  }
};

const downloadFile = async (item) => {
  busy.value = true;
  try {
    const keyRecord = await getGithubReleaseFileKey(storageId.value, item.fileId);
    const key = await importAesKey(keyRecord.encryptionKey);
    const client = getClient();
    const blobs = [];
    const sortedChunks = [...(item.chunks || [])].sort((a, b) => a.index - b.index);

    for (const chunk of sortedChunks) {
      progressText.value = `下载并解密分包 ${chunk.index + 1}/${sortedChunks.length}`;
      const asset = assets.value.find((entry) => entry.id === chunk.assetId || entry.name === chunk.assetName) || {
        id: chunk.assetId,
        name: chunk.assetName,
        browser_download_url: chunk.browserDownloadUrl,
      };
      const encryptedBlob = await client.downloadAsset(asset);
      const hash = await sha256Base64(encryptedBlob);
      if (chunk.sha256 && hash !== chunk.sha256) {
        throw new Error(`分包校验失败: ${chunk.assetName}`);
      }
      blobs.push(await decryptChunk(encryptedBlob, key, chunk.iv));
    }

    progressText.value = "解压并保存文件";
    const merged = new Blob(blobs, { type: "application/octet-stream" });
    const restored = await decompressBlob(merged, item.compression || "gzip");
    saveBlob(restored, item.name);
    setInfo("文件下载完成");
  } catch (err) {
    setError(err);
  } finally {
    busy.value = false;
    progressText.value = "";
  }
};

const deleteFile = async (item) => {
  if (!window.confirm(`删除 ${item.name}？`)) return;
  busy.value = true;
  try {
    const client = getClient();
    const nextManifest = normalizeManifest(
      {
        ...manifest.value,
        files: fileItems.value.filter((entry) => entry.fileId !== item.fileId),
      },
      storageId.value,
    );
    await uploadManifest(nextManifest);
    await deleteGithubReleaseFileKey(storageId.value, item.fileId);
    for (const chunk of item.chunks || []) {
      await client.deleteAsset(chunk.assetId).catch(() => null);
    }
    manifest.value = nextManifest;
    assets.value = await client.listAssets(release.value.id);
    setInfo("文件已删除");
  } catch (err) {
    setError(err);
  } finally {
    busy.value = false;
  }
};

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      void loadAll();
    }
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3">
    <div class="w-full max-w-5xl max-h-[88vh] rounded-lg shadow-xl flex flex-col" :class="darkMode ? 'bg-gray-800 text-gray-100' : 'bg-white text-gray-900'">
      <div class="px-4 py-3 border-b flex items-center justify-between" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
        <div>
          <h3 class="text-base font-semibold">GitHub Release 加密文件管理</h3>
          <p class="text-xs mt-0.5" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ config.name }}</p>
        </div>
        <button class="p-1 rounded" :class="darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'" @click="emit('close')">
          <IconClose class="h-5 w-5" />
        </button>
      </div>

      <div class="p-4 overflow-y-auto space-y-4">
        <div v-if="error" class="p-3 rounded text-sm border" :class="darkMode ? 'bg-red-900/30 border-red-700 text-red-200' : 'bg-red-50 border-red-200 text-red-700'">{{ error }}</div>
        <div v-if="message" class="p-3 rounded text-sm border" :class="darkMode ? 'bg-green-900/20 border-green-700 text-green-200' : 'bg-green-50 border-green-200 text-green-700'">{{ message }}</div>
        <div v-if="progressText" class="text-sm" :class="darkMode ? 'text-blue-300' : 'text-blue-700'">{{ progressText }}</div>

        <div class="flex flex-col gap-3 rounded border p-3 sm:flex-row sm:items-center sm:justify-between" :class="darkMode ? 'border-gray-700 bg-gray-900/30' : 'border-gray-200 bg-gray-50'">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-sm font-medium">
              <IconCheckCircle v-if="isInitialized" class="h-4 w-4" :class="darkMode ? 'text-green-300' : 'text-green-600'" />
              <span>{{ isInitialized ? "GitHub Release 已初始化" : "GitHub Release 未初始化" }}</span>
            </div>
            <p class="mt-1 break-all text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-600'">
              {{ initStatus?.releaseTag || clientConfig?.releaseTag || "未配置 release_tag" }}
              <span v-if="initStatus?.releaseId || clientConfig?.releaseId"> · ID: {{ initStatus?.releaseId || clientConfig?.releaseId }}</span>
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button class="px-3 py-2 rounded text-sm flex items-center gap-1" :class="darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-white hover:bg-gray-100 border border-gray-200'" :disabled="loading || busy || initializing" @click="checkInitialization">
              <IconRefresh class="h-4 w-4" :class="{ 'animate-spin': busy && !initializing }" />检查初始化
            </button>
            <button class="px-3 py-2 rounded text-sm text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1" :disabled="loading || busy || initializing || isInitialized" @click="initializeRelease">
              <IconCheckCircle class="h-4 w-4" :class="{ 'animate-spin': initializing }" />初始化 Release
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label class="block">
              <span class="block text-xs mb-1" :class="darkMode ? 'text-gray-400' : 'text-gray-600'">目标路径</span>
              <input v-model="targetPath" class="w-full px-3 py-2 rounded border text-sm" :class="darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'border-gray-300'" />
            </label>
            <label class="block">
              <span class="block text-xs mb-1" :class="darkMode ? 'text-gray-400' : 'text-gray-600'">选择文件</span>
              <input type="file" class="w-full text-sm" @change="handleFileChange" />
            </label>
          </div>
          <div class="flex gap-2">
            <button class="px-3 py-2 rounded text-sm flex items-center gap-1" :class="darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'" :disabled="loading || busy" @click="loadAll">
              <IconRefresh class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新
            </button>
            <button class="px-3 py-2 rounded text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1" :disabled="!selectedFile || loading || busy || !isInitialized" @click="uploadSelectedFile">
              <IconUpload class="h-4 w-4" />上传
            </button>
          </div>
        </div>

        <div class="overflow-x-auto border rounded" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <table class="min-w-full text-sm">
            <thead :class="darkMode ? 'bg-gray-700' : 'bg-gray-50'">
              <tr>
                <th class="text-left px-3 py-2">路径</th>
                <th class="text-left px-3 py-2">大小</th>
                <th class="text-left px-3 py-2">更新时间</th>
                <th class="text-right px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading">
                <td colspan="4" class="px-3 py-8 text-center">加载中...</td>
              </tr>
              <tr v-else-if="fileItems.length === 0">
                <td colspan="4" class="px-3 py-8 text-center" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">manifest 中暂无文件</td>
              </tr>
              <template v-else>
                <tr v-for="item in fileItems" :key="item.fileId" class="border-t" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
                  <td class="px-3 py-2 break-all">{{ item.path }}</td>
                  <td class="px-3 py-2 whitespace-nowrap">{{ item.originalSize }} B</td>
                  <td class="px-3 py-2 whitespace-nowrap">{{ item.updatedAt || item.createdAt }}</td>
                  <td class="px-3 py-2">
                    <div class="flex justify-end gap-2">
                      <button class="px-2 py-1 rounded text-xs flex items-center gap-1" :class="darkMode ? 'bg-blue-700 hover:bg-blue-600' : 'bg-blue-100 text-blue-800 hover:bg-blue-200'" :disabled="busy" @click="downloadFile(item)">
                        <IconDownload class="h-3.5 w-3.5" />下载
                      </button>
                      <button class="px-2 py-1 rounded text-xs flex items-center gap-1" :class="darkMode ? 'bg-red-700 hover:bg-red-600' : 'bg-red-100 text-red-800 hover:bg-red-200'" :disabled="busy" @click="deleteFile(item)">
                        <IconDelete class="h-3.5 w-3.5" />删除
                      </button>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

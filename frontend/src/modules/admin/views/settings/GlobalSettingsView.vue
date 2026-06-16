<script setup>
import { ref, onMounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { useAdminSystemService } from "@/modules/admin/services/systemService.js";
import { useThemeMode } from "@/composables/core/useThemeMode.js";
import { useGlobalMessage } from "@/composables/core/useGlobalMessage.js";
import { IconRefresh, IconUpload, IconShieldCheck, IconCopy, IconTrash } from "@/components/icons";
import { createLogger } from "@/utils/logger.js";

const { t } = useI18n();
const log = createLogger("GlobalSettingsView");
const { getGlobalSettings, updateGlobalSettings } = useAdminSystemService();
const { isDarkMode: darkMode } = useThemeMode();
const { showSuccess, showError } = useGlobalMessage();

const uploadSettings = ref({
  max_upload_size: 100,
  max_upload_size_unit: "MB",
  enableOverwrite: true,
  defaultUseProxy: false,
  copyDirectoryChunkSize: 10,
  deleteDirectoryChunkSize: 1000,
});

const signSettings = ref({ signAll: false, expires: 0 });
const sizeUnits = ["KB", "MB", "GB"];
const isLoading = ref(false);
const isSavingUpload = ref(false);
const isSavingSign = ref(false);

const isUploadFormValid = computed(() => {
  const copySize = Number(uploadSettings.value.copyDirectoryChunkSize);
  const deleteSize = Number(uploadSettings.value.deleteDirectoryChunkSize);
  return uploadSettings.value.max_upload_size > 0 &&
    Number.isInteger(copySize) && copySize >= 1 && copySize <= 100 &&
    Number.isInteger(deleteSize) && deleteSize >= 1 && deleteSize <= 1000;
});

onMounted(async () => {
  isLoading.value = true;
  try {
    const settings = await getGlobalSettings();
    settings.forEach((setting) => {
      switch (setting.key) {
        case "max_upload_size":
          uploadSettings.value.max_upload_size = parseInt(setting.value) || 100;
          uploadSettings.value.max_upload_size_unit = "MB";
          break;
        case "file_naming_strategy":
          uploadSettings.value.enableOverwrite = setting.value === "overwrite";
          break;
        case "default_use_proxy":
          uploadSettings.value.defaultUseProxy = setting.value === "true";
          break;
        case "copy_directory_chunk_size":
          uploadSettings.value.copyDirectoryChunkSize = Math.min(Math.max(parseInt(setting.value) || 10, 1), 100);
          break;
        case "delete_directory_chunk_size":
          uploadSettings.value.deleteDirectoryChunkSize = parseInt(setting.value) || 1000;
          break;
        case "proxy_sign_all":
          signSettings.value.signAll = setting.value === "true";
          break;
        case "proxy_sign_expires":
          signSettings.value.expires = parseInt(setting.value) || 0;
          break;
      }
    });
  } catch (error) {
    log.error("获取全局设置失败:", error);
    showError(t("admin.global.messages.updateFailed"));
  } finally {
    isLoading.value = false;
  }
});

const convertToMB = (value, unit) => {
  if (unit === "KB") return value / 1024;
  if (unit === "GB") return value * 1024;
  return value;
};

const handleSaveUpload = async () => {
  if (!isUploadFormValid.value) {
    showError(t("admin.global.uploadSettings.validationError"));
    return;
  }

  isSavingUpload.value = true;
  try {
    const convertedSize = convertToMB(uploadSettings.value.max_upload_size, uploadSettings.value.max_upload_size_unit);
    await updateGlobalSettings({
      max_upload_size: Math.round(convertedSize),
      file_naming_strategy: uploadSettings.value.enableOverwrite ? "overwrite" : "random_suffix",
      default_use_proxy: uploadSettings.value.defaultUseProxy.toString(),
      copy_directory_chunk_size: String(uploadSettings.value.copyDirectoryChunkSize),
      delete_directory_chunk_size: String(uploadSettings.value.deleteDirectoryChunkSize),
    });
    showSuccess(t("admin.global.messages.updateSuccess"));
  } catch (error) {
    log.error("更新上传设置失败:", error);
    showError(error.message || t("admin.global.messages.updateFailed"));
  } finally {
    isSavingUpload.value = false;
  }
};

const handleSaveSign = async () => {
  isSavingSign.value = true;
  try {
    await updateGlobalSettings({
      proxy_sign_all: signSettings.value.signAll.toString(),
      proxy_sign_expires: signSettings.value.expires.toString(),
    });
    showSuccess(t("admin.global.messages.updateSuccess"));
  } catch (error) {
    log.error("更新签名设置失败:", error);
    showError(error.message || t("admin.global.messages.updateFailed"));
  } finally {
    isSavingSign.value = false;
  }
};
</script>

<template>
  <div class="flex-1 flex flex-col overflow-y-auto">
    <div class="mb-8">
      <h1 class="text-2xl font-bold mb-2" :class="darkMode ? 'text-white' : 'text-gray-900'">
        {{ t("admin.global.title") }}
      </h1>
      <p class="text-base" :class="darkMode ? 'text-gray-400' : 'text-gray-600'">
        {{ t("admin.global.description") }}
      </p>
    </div>

    <div v-if="isLoading" class="flex items-center justify-center py-12">
      <IconRefresh size="lg" class="animate-spin" :class="darkMode ? 'text-gray-400' : 'text-gray-500'" />
    </div>

    <div v-else class="space-y-6 max-w-2xl">
      <section class="rounded-xl border transition-colors" :class="darkMode ? 'bg-gray-800/50 border-gray-700' : 'bg-white border-gray-200'">
        <div class="px-5 py-4 border-b" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-9 h-9 rounded-lg" :class="darkMode ? 'bg-blue-500/20' : 'bg-blue-50'">
              <IconUpload size="sm" :class="darkMode ? 'text-blue-400' : 'text-blue-600'" />
            </div>
            <div>
              <h2 class="text-base font-semibold" :class="darkMode ? 'text-white' : 'text-gray-900'">{{ t("admin.global.uploadSettings.title") }}</h2>
              <p class="text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.uploadSettings.description") }}</p>
            </div>
          </div>
        </div>
        <div class="p-5 space-y-4">
          <div class="flex items-center justify-between gap-4">
            <label class="block text-sm font-medium" :class="darkMode ? 'text-gray-200' : 'text-gray-700'">
              {{ t("admin.global.uploadSettings.maxUploadSizeLabel") }} <span class="text-red-500">*</span>
            </label>
            <div class="flex items-center gap-2">
              <input v-model.number="uploadSettings.max_upload_size" type="number" min="1" step="1" class="w-24 px-3 py-2 border rounded-lg text-sm" :class="darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'" />
              <select v-model="uploadSettings.max_upload_size_unit" class="px-3 py-2 border rounded-lg text-sm" :class="darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'">
                <option v-for="unit in sizeUnits" :key="unit" :value="unit">{{ unit }}</option>
              </select>
            </div>
          </div>
          <div class="border-t" :class="darkMode ? 'border-gray-700' : 'border-gray-200'"></div>
          <div class="flex items-center justify-between gap-4">
            <div>
              <label class="block text-sm font-medium" :class="darkMode ? 'text-gray-200' : 'text-gray-700'">{{ t("admin.global.uploadSettings.fileOverwriteModeLabel") }}</label>
              <p class="text-xs mt-0.5" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.uploadSettings.fileOverwriteModeHint") }}</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input v-model="uploadSettings.enableOverwrite" type="checkbox" class="sr-only peer" />
              <div class="w-11 h-6 bg-gray-200 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>
          <div class="border-t" :class="darkMode ? 'border-gray-700' : 'border-gray-200'"></div>
          <div class="flex items-center justify-between gap-4">
            <div>
              <label class="block text-sm font-medium" :class="darkMode ? 'text-gray-200' : 'text-gray-700'">{{ t("admin.global.uploadSettings.defaultUseProxyLabel") }}</label>
              <p class="text-xs mt-0.5" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.uploadSettings.defaultUseProxyHint") }}</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input v-model="uploadSettings.defaultUseProxy" type="checkbox" class="sr-only peer" />
              <div class="w-11 h-6 bg-gray-200 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>
        <div class="px-5 py-4 border-t flex justify-end" :class="darkMode ? 'border-gray-700 bg-gray-800/30' : 'border-gray-100 bg-gray-50/50'">
          <button type="button" @click="handleSaveUpload" :disabled="isSavingUpload || !isUploadFormValid" class="inline-flex items-center px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50" :class="isSavingUpload ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'">
            <IconRefresh v-if="isSavingUpload" size="sm" class="animate-spin -ml-0.5 mr-2" />
            {{ isSavingUpload ? t("admin.global.buttons.updating") : t("admin.global.buttons.updateSettings") }}
          </button>
        </div>
      </section>

      <section class="rounded-xl border transition-colors" :class="darkMode ? 'bg-gray-800/50 border-gray-700' : 'bg-white border-gray-200'">
        <div class="px-5 py-4 border-b" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-9 h-9 rounded-lg" :class="darkMode ? 'bg-indigo-500/20' : 'bg-indigo-50'">
              <IconCopy size="sm" :class="darkMode ? 'text-indigo-400' : 'text-indigo-600'" />
            </div>
            <div>
              <h2 class="text-base font-semibold" :class="darkMode ? 'text-white' : 'text-gray-900'">{{ t("admin.global.copySettings.title") }}</h2>
              <p class="text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.copySettings.description") }}</p>
            </div>
          </div>
        </div>
        <div class="p-5">
          <div class="flex items-center justify-between gap-4">
            <div>
              <label class="block text-sm font-medium" :class="darkMode ? 'text-gray-200' : 'text-gray-700'">{{ t("admin.global.copySettings.directoryChunkSizeLabel") }} <span class="text-red-500">*</span></label>
              <p class="text-xs mt-0.5" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.copySettings.directoryChunkSizeHint") }}</p>
            </div>
            <div class="flex items-center gap-2">
              <input v-model.number="uploadSettings.copyDirectoryChunkSize" type="number" min="1" max="100" step="1" class="w-24 px-3 py-2 border rounded-lg text-sm" :class="darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'" />
              <span class="text-sm" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.copySettings.itemsUnit") }}</span>
            </div>
          </div>
        </div>
        <div class="px-5 py-4 border-t flex justify-end" :class="darkMode ? 'border-gray-700 bg-gray-800/30' : 'border-gray-100 bg-gray-50/50'">
          <button type="button" @click="handleSaveUpload" :disabled="isSavingUpload || !isUploadFormValid" class="inline-flex items-center px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50" :class="isSavingUpload ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'">
            <IconRefresh v-if="isSavingUpload" size="sm" class="animate-spin -ml-0.5 mr-2" />
            {{ isSavingUpload ? t("admin.global.buttons.updating") : t("admin.global.buttons.updateSettings") }}
          </button>
        </div>
      </section>

      <section class="rounded-xl border transition-colors" :class="darkMode ? 'bg-gray-800/50 border-gray-700' : 'bg-white border-gray-200'">
        <div class="px-5 py-4 border-b" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-9 h-9 rounded-lg" :class="darkMode ? 'bg-red-500/20' : 'bg-red-50'">
              <IconTrash size="sm" :class="darkMode ? 'text-red-400' : 'text-red-600'" />
            </div>
            <div>
              <h2 class="text-base font-semibold" :class="darkMode ? 'text-white' : 'text-gray-900'">{{ t("admin.global.deleteSettings.title") }}</h2>
              <p class="text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.deleteSettings.description") }}</p>
            </div>
          </div>
        </div>
        <div class="p-5">
          <div class="flex items-center justify-between gap-4">
            <div>
              <label class="block text-sm font-medium" :class="darkMode ? 'text-gray-200' : 'text-gray-700'">{{ t("admin.global.deleteSettings.directoryChunkSizeLabel") }} <span class="text-red-500">*</span></label>
              <p class="text-xs mt-0.5" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.deleteSettings.directoryChunkSizeHint") }}</p>
            </div>
            <div class="flex items-center gap-2">
              <input v-model.number="uploadSettings.deleteDirectoryChunkSize" type="number" min="1" max="1000" step="1" class="w-24 px-3 py-2 border rounded-lg text-sm" :class="darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'" />
              <span class="text-sm" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.deleteSettings.itemsUnit") }}</span>
            </div>
          </div>
        </div>
        <div class="px-5 py-4 border-t flex justify-end" :class="darkMode ? 'border-gray-700 bg-gray-800/30' : 'border-gray-100 bg-gray-50/50'">
          <button type="button" @click="handleSaveUpload" :disabled="isSavingUpload || !isUploadFormValid" class="inline-flex items-center px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50" :class="isSavingUpload ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'">
            <IconRefresh v-if="isSavingUpload" size="sm" class="animate-spin -ml-0.5 mr-2" />
            {{ isSavingUpload ? t("admin.global.buttons.updating") : t("admin.global.buttons.updateSettings") }}
          </button>
        </div>
      </section>

      <section class="rounded-xl border transition-colors" :class="darkMode ? 'bg-gray-800/50 border-gray-700' : 'bg-white border-gray-200'">
        <div class="px-5 py-4 border-b" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-9 h-9 rounded-lg" :class="darkMode ? 'bg-emerald-500/20' : 'bg-emerald-50'">
              <IconShieldCheck size="sm" :class="darkMode ? 'text-emerald-400' : 'text-emerald-600'" />
            </div>
            <div>
              <h2 class="text-base font-semibold" :class="darkMode ? 'text-white' : 'text-gray-900'">{{ t("admin.global.proxySignSettings.title") }}</h2>
              <p class="text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.proxySignSettings.description") }}</p>
            </div>
          </div>
        </div>
        <div class="p-5 space-y-4">
          <div class="flex items-center justify-between gap-4">
            <div>
              <label class="block text-sm font-medium" :class="darkMode ? 'text-gray-200' : 'text-gray-700'">{{ t("admin.global.proxySignSettings.signAllLabel") }}</label>
              <p class="text-xs mt-0.5" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.proxySignSettings.signAllHint") }}</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input v-model="signSettings.signAll" type="checkbox" class="sr-only peer" />
              <div class="w-11 h-6 bg-gray-200 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>
          <div class="border-t" :class="darkMode ? 'border-gray-700' : 'border-gray-200'"></div>
          <div class="flex items-center justify-between gap-4">
            <div>
              <label class="block text-sm font-medium" :class="darkMode ? 'text-gray-200' : 'text-gray-700'">{{ t("admin.global.proxySignSettings.expiresLabel") }}</label>
              <p class="text-xs mt-0.5" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.proxySignSettings.expiresHint") }}</p>
            </div>
            <div class="flex items-center gap-2">
              <input v-model.number="signSettings.expires" type="number" min="0" step="1" class="w-24 px-3 py-2 border rounded-lg text-sm" :class="darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'" />
              <span class="text-sm" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ t("admin.global.proxySignSettings.expiresUnit") }}</span>
            </div>
          </div>
        </div>
        <div class="px-5 py-4 border-t flex justify-end" :class="darkMode ? 'border-gray-700 bg-gray-800/30' : 'border-gray-100 bg-gray-50/50'">
          <button type="button" @click="handleSaveSign" :disabled="isSavingSign" class="inline-flex items-center px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50" :class="isSavingSign ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'">
            <IconRefresh v-if="isSavingSign" size="sm" class="animate-spin -ml-0.5 mr-2" />
            {{ isSavingSign ? t("admin.global.buttons.updating") : t("admin.global.buttons.updateSettings") }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

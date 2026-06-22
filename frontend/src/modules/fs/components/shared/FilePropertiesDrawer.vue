<template>
  <Teleport to="body">
    <Transition name="drawer-fade">
      <div v-if="isOpen" class="fixed inset-0 z-[70]">
        <button class="absolute inset-0 bg-black/35" type="button" :aria-label="t('common.close')" @click="$emit('close')"></button>
        <aside
          class="absolute right-0 top-0 h-full w-full max-w-md shadow-xl flex flex-col"
          :class="darkMode ? 'bg-gray-900 text-gray-100' : 'bg-white text-gray-900'"
        >
          <header class="px-4 py-3 border-b flex items-center justify-between" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
            <div class="min-w-0">
              <h3 class="text-base font-semibold truncate">{{ title }}</h3>
              <p class="text-xs truncate mt-0.5" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ subtitle }}</p>
            </div>
            <button
              type="button"
              class="p-2 rounded-md transition-colors"
              :class="darkMode ? 'hover:bg-gray-800 text-gray-300' : 'hover:bg-gray-100 text-gray-600'"
              @click="$emit('close')"
            >
              <IconClose size="sm" />
            </button>
          </header>

          <div class="flex-1 overflow-y-auto p-4 space-y-5">
            <section>
              <div class="flex items-start gap-3">
                <div class="shrink-0 w-12 h-12" v-html="itemIcon"></div>
                <div class="min-w-0">
                  <div class="font-medium truncate" :title="primaryName">{{ primaryName }}</div>
                  <div class="text-sm mt-1 break-all" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ primaryPath }}</div>
                </div>
              </div>
            </section>

            <section class="space-y-2">
              <h4 class="text-xs font-semibold uppercase tracking-wide" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
                {{ t("mount.properties.basic") }}
              </h4>
              <PropertyRow :label="t('mount.properties.type')" :value="typeLabel" :dark-mode="darkMode" />
              <PropertyRow :label="t('mount.properties.size')" :value="sizeLabel" :dark-mode="darkMode" />
              <PropertyRow :label="t('mount.properties.modified')" :value="modifiedLabel" :dark-mode="darkMode" />
              <PropertyRow :label="t('mount.properties.path')" :value="primaryPath" :dark-mode="darkMode" mono />
              <PropertyRow v-if="sourceLabel" :label="t('mount.properties.source')" :value="sourceLabel" :dark-mode="darkMode" />
            </section>

            <section v-if="isBatch" class="space-y-2">
              <h4 class="text-xs font-semibold uppercase tracking-wide" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
                {{ t("mount.properties.selection") }}
              </h4>
              <PropertyRow :label="t('mount.properties.totalItems')" :value="String(items.length)" :dark-mode="darkMode" />
              <PropertyRow :label="t('mount.properties.files')" :value="String(fileCount)" :dark-mode="darkMode" />
              <PropertyRow :label="t('mount.properties.folders')" :value="String(folderCount)" :dark-mode="darkMode" />
            </section>

            <section class="space-y-2">
              <h4 class="text-xs font-semibold uppercase tracking-wide" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
                {{ t("mount.properties.actions") }}
              </h4>
              <div class="grid grid-cols-2 gap-2">
                <ActionButton v-if="!isBatch && !primaryItem?.isDirectory" :dark-mode="darkMode" @click="$emit('download', primaryItem)">
                  <IconDownload size="sm" />
                  <span>{{ t("mount.fileItem.download") }}</span>
                </ActionButton>
                <ActionButton v-if="!isBatch && !primaryItem?.isDirectory" :dark-mode="darkMode" @click="$emit('get-link', primaryItem)">
                  <IconLink size="sm" />
                  <span>{{ t("mount.fileItem.getLink") }}</span>
                </ActionButton>
                <ActionButton :dark-mode="darkMode" @click="$emit('copy-path', targetPayload)">
                  <IconDocumentText size="sm" />
                  <span>{{ t("mount.contextMenu.copyPath") }}</span>
                </ActionButton>
                <ActionButton :dark-mode="darkMode" @click="$emit('copy-name', targetPayload)">
                  <IconDocumentText size="sm" />
                  <span>{{ t("mount.contextMenu.copyName") }}</span>
                </ActionButton>
                <ActionButton :dark-mode="darkMode" @click="$emit('zip-download', targetPayload)">
                  <IconArchive size="sm" />
                  <span>{{ t("mount.contextMenu.downloadZip") }}</span>
                </ActionButton>
                <ActionButton v-if="canWrite" :dark-mode="darkMode" @click="$emit('copy', targetPayload)">
                  <IconCopy size="sm" />
                  <span>{{ t("mount.fileItem.copy") }}</span>
                </ActionButton>
                <ActionButton v-if="canWrite" :dark-mode="darkMode" @click="$emit('move', targetPayload)">
                  <IconArrowRight size="sm" />
                  <span>{{ t("mount.fileItem.move") }}</span>
                </ActionButton>
                <ActionButton v-if="canWrite && !isBatch" :dark-mode="darkMode" @click="$emit('rename', primaryItem)">
                  <IconRename size="sm" />
                  <span>{{ t("mount.fileItem.rename") }}</span>
                </ActionButton>
                <ActionButton v-if="canWrite" :dark-mode="darkMode" danger @click="$emit('delete', targetPayload)">
                  <IconDelete size="sm" />
                  <span>{{ t("mount.fileItem.delete") }}</span>
                </ActionButton>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, h } from "vue";
import { useI18n } from "vue-i18n";
import { IconArchive, IconArrowRight, IconClose, IconCopy, IconDelete, IconDocumentText, IconDownload, IconLink, IconRename } from "@/components/icons";
import { getFileIcon } from "@/utils/fileTypeIcons.js";
import { formatFileSize } from "@/utils/fileUtils.js";

const props = defineProps({
  isOpen: { type: Boolean, default: false },
  item: { type: [Object, Array], default: null },
  darkMode: { type: Boolean, default: false },
  canWrite: { type: Boolean, default: true },
});

defineEmits(["close", "download", "get-link", "copy-path", "copy-name", "zip-download", "copy", "move", "rename", "delete"]);

const { t } = useI18n();

const items = computed(() => (Array.isArray(props.item) ? props.item.filter(Boolean) : props.item ? [props.item] : []));
const isBatch = computed(() => items.value.length > 1);
const primaryItem = computed(() => items.value[0] || null);
const targetPayload = computed(() => (isBatch.value ? items.value : primaryItem.value));
const fileCount = computed(() => items.value.filter((item) => !item.isDirectory).length);
const folderCount = computed(() => items.value.filter((item) => item.isDirectory).length);
const primaryName = computed(() => (isBatch.value ? t("mount.properties.batchTitle", { count: items.value.length }) : primaryItem.value?.name || "-"));
const primaryPath = computed(() => (isBatch.value ? items.value.map((item) => item.path).join("\n") : primaryItem.value?.path || "-"));
const title = computed(() => t("mount.fileItem.properties"));
const subtitle = computed(() => (isBatch.value ? t("mount.properties.batchSubtitle", { files: fileCount.value, folders: folderCount.value }) : primaryItem.value?.path || ""));
const itemIcon = computed(() => (primaryItem.value ? getFileIcon(primaryItem.value, props.darkMode) : ""));
const typeLabel = computed(() => {
  if (isBatch.value) return t("mount.properties.multipleTypes");
  if (primaryItem.value?.isDirectory) return t("mount.fileTypes.folder");
  return primaryItem.value?.mimeType || primaryItem.value?.mimetype || t("mount.fileTypes.file");
});
const sizeLabel = computed(() => {
  if (isBatch.value) {
    const total = items.value.reduce((sum, item) => sum + (Number.isFinite(item?.size) ? item.size : 0), 0);
    return formatFileSize(total);
  }
  return formatFileSize(primaryItem.value?.size);
});
const modifiedLabel = computed(() => {
  const value = primaryItem.value?.modified || primaryItem.value?.updated_at || primaryItem.value?.updatedAt;
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
});
const sourceLabel = computed(() => primaryItem.value?.size_source || primaryItem.value?.modified_source || "");

const PropertyRow = (rowProps) =>
  h("div", { class: "grid grid-cols-[6rem_1fr] gap-3 text-sm" }, [
    h("div", { class: rowProps.darkMode ? "text-gray-400" : "text-gray-500" }, rowProps.label),
    h("div", { class: [rowProps.darkMode ? "text-gray-100" : "text-gray-800", rowProps.mono ? "font-mono text-xs whitespace-pre-wrap break-all" : "break-all"] }, rowProps.value || "-"),
  ]);
PropertyRow.props = ["label", "value", "darkMode", "mono"];

const ActionButton = (buttonProps, { slots, emit }) => {
  const cls = buttonProps.danger
    ? buttonProps.darkMode
      ? "border-red-500/30 text-red-300 hover:bg-red-500/10"
      : "border-red-200 text-red-600 hover:bg-red-50"
    : buttonProps.darkMode
      ? "border-gray-700 text-gray-200 hover:bg-gray-800"
      : "border-gray-200 text-gray-700 hover:bg-gray-50";
  return h(
    "button",
    {
      type: "button",
      class: `inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors ${cls}`,
      onClick: () => emit("click"),
    },
    slots.default?.(),
  );
};
ActionButton.props = ["darkMode", "danger"];
ActionButton.emits = ["click"];
</script>

<style scoped>
.drawer-fade-enter-active,
.drawer-fade-leave-active {
  transition: opacity 180ms ease;
}

.drawer-fade-enter-from,
.drawer-fade-leave-to {
  opacity: 0;
}
</style>

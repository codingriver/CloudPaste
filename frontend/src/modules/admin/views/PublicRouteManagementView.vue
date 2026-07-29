<script setup>
import { computed, onMounted, ref } from "vue";
import {
  bulkDeletePublicRoutes,
  bulkDisablePublicRoutes,
  bulkEnablePublicRoutes,
  deletePublicRoute,
  listPublicRoutes,
  updatePublicRoute,
} from "@/api/services/publicRouteService.js";
import { useThemeMode } from "@/composables/core/useThemeMode.js";
import { useConfirmDialog } from "@/composables/core/useConfirmDialog.js";
import ConfirmDialog from "@/components/common/dialogs/ConfirmDialog.vue";
import {
  IconArchive,
  IconCheckCircle,
  IconCopy,
  IconDelete,
  IconExternalLink,
  IconFolder,
  IconLink,
  IconRefresh,
  IconSearch,
  IconXCircle,
} from "@/components/icons";

const { isDarkMode: darkMode } = useThemeMode();
const { dialogState, confirm, handleConfirm, handleCancel } = useConfirmDialog();

const routes = ref([]);
const loading = ref(false);
const actionLoading = ref(false);
const error = ref("");
const notice = ref("");
const searchQuery = ref("");
const enabledFilter = ref("all");
const selectedIds = ref([]);

const selectedCount = computed(() => selectedIds.value.length);
const allSelected = computed(
  () => routes.value.length > 0 && routes.value.every((route) => selectedIds.value.includes(route.id)),
);

const enabledCount = computed(() => routes.value.filter((route) => route.enabled).length);
const disabledCount = computed(() => routes.value.length - enabledCount.value);

const showNotice = (message) => {
  notice.value = message;
  window.setTimeout(() => {
    if (notice.value === message) notice.value = "";
  }, 2500);
};

const getErrorMessage = (err, fallback) => err?.message || fallback;

const loadRoutes = async () => {
  loading.value = true;
  error.value = "";
  try {
    routes.value = await listPublicRoutes({
      search: searchQuery.value.trim(),
      enabled: enabledFilter.value === "all" ? null : enabledFilter.value === "enabled",
    });
    selectedIds.value = selectedIds.value.filter((id) => routes.value.some((route) => route.id === id));
  } catch (err) {
    error.value = getErrorMessage(err, "加载公开路由失败");
  } finally {
    loading.value = false;
  }
};

const clearSearch = () => {
  searchQuery.value = "";
  loadRoutes();
};

const toggleAll = () => {
  selectedIds.value = allSelected.value ? [] : routes.value.map((route) => route.id);
};

const toggleSelected = (id) => {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((selectedId) => selectedId !== id)
    : [...selectedIds.value, id];
};

const publicUrl = (route) => {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}${route.publicPath}`;
};

const openPublicRoute = (route) => {
  window.open(publicUrl(route), "_blank", "noopener,noreferrer");
};

const copyPublicUrl = async (route) => {
  try {
    await navigator.clipboard.writeText(publicUrl(route));
    showNotice("公开地址已复制");
  } catch {
    error.value = "复制失败，请手动复制公开地址";
  }
};

const formatDateTime = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const setRouteEnabled = async (route, enabled) => {
  actionLoading.value = true;
  error.value = "";
  try {
    await updatePublicRoute(route.id, { enabled });
    route.enabled = enabled;
    showNotice(enabled ? "公开路由已启用" : "公开路由已关闭");
  } catch (err) {
    error.value = getErrorMessage(err, "更新公开路由失败");
  } finally {
    actionLoading.value = false;
  }
};

const confirmDeleteRoute = async (route) => {
  const accepted = await confirm({
    title: "删除公开路由",
    message: `确定删除公开路径 ${route.publicPath} 吗？删除后该地址将无法继续访问。`,
    confirmType: "danger",
    confirmText: "删除",
    darkMode: darkMode.value,
  });
  if (!accepted) return;

  actionLoading.value = true;
  error.value = "";
  try {
    await deletePublicRoute(route.id);
    routes.value = routes.value.filter((item) => item.id !== route.id);
    selectedIds.value = selectedIds.value.filter((id) => id !== route.id);
    showNotice("公开路由已删除");
  } catch (err) {
    error.value = getErrorMessage(err, "删除公开路由失败");
  } finally {
    actionLoading.value = false;
  }
};

const runBulkAction = async (action) => {
  if (!selectedIds.value.length || actionLoading.value) return;

  if (action === "delete") {
    const accepted = await confirm({
      title: "批量删除公开路由",
      message: `确定删除选中的 ${selectedIds.value.length} 条公开路由吗？此操作不可撤销。`,
      confirmType: "danger",
      confirmText: "批量删除",
      darkMode: darkMode.value,
    });
    if (!accepted) return;
  }

  actionLoading.value = true;
  error.value = "";
  try {
    const ids = [...selectedIds.value];
    if (action === "enable") await bulkEnablePublicRoutes(ids);
    if (action === "disable") await bulkDisablePublicRoutes(ids);
    if (action === "delete") await bulkDeletePublicRoutes(ids);

    if (action === "delete") {
      routes.value = routes.value.filter((route) => !ids.includes(route.id));
    } else {
      const enabled = action === "enable";
      routes.value.forEach((route) => {
        if (ids.includes(route.id)) route.enabled = enabled;
      });
    }
    selectedIds.value = [];
    showNotice(
      action === "enable" ? "所选公开路由已启用" : action === "disable" ? "所选公开路由已关闭" : "所选公开路由已删除",
    );
  } catch (err) {
    error.value = getErrorMessage(err, "批量操作失败");
  } finally {
    actionLoading.value = false;
  }
};

onMounted(loadRoutes);
</script>

<template>
  <div class="p-3 sm:p-4 md:p-5 lg:p-6 flex-1 flex flex-col overflow-y-auto">
    <div class="flex flex-col gap-4 mb-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 class="text-lg sm:text-xl font-medium" :class="darkMode ? 'text-white' : 'text-gray-900'">公开路由管理</h2>
          <p class="mt-1 text-sm" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">路由记录即公开状态；关闭路由会立即停止对应地址的公开访问。</p>
        </div>
        <button
          type="button"
          class="inline-flex items-center justify-center px-3 py-2 rounded-md text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
          :disabled="loading || actionLoading"
          @click="loadRoutes"
        >
          <IconRefresh class="mr-2" :class="loading ? 'animate-spin' : ''" />
          {{ loading ? "刷新中" : "刷新" }}
        </button>
      </div>

      <form class="flex flex-col lg:flex-row gap-3" @submit.prevent="loadRoutes">
        <div class="relative flex-1">
          <IconSearch class="absolute left-3 top-1/2 -translate-y-1/2" :class="darkMode ? 'text-gray-500' : 'text-gray-400'" />
          <input
            v-model="searchQuery"
            type="search"
            class="w-full pl-10 pr-24 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            :class="darkMode ? 'bg-gray-800 border-gray-700 text-gray-100' : 'bg-white border-gray-300 text-gray-900'"
            placeholder="搜索公开路径或 FS 目标路径"
          />
          <button v-if="searchQuery" type="button" class="absolute right-16 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-700" @click="clearSearch">清空</button>
          <button type="submit" class="absolute right-1 top-1 bottom-1 px-3 rounded text-sm text-white bg-primary-600 hover:bg-primary-700">搜索</button>
        </div>
        <select
          v-model="enabledFilter"
          class="px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          :class="darkMode ? 'bg-gray-800 border-gray-700 text-gray-100' : 'bg-white border-gray-300 text-gray-900'"
          @change="loadRoutes"
        >
          <option value="all">全部状态</option>
          <option value="enabled">仅已启用</option>
          <option value="disabled">仅已关闭</option>
        </select>
      </form>

      <div class="grid grid-cols-3 gap-2 sm:gap-3">
        <div class="rounded-lg border p-3" :class="darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'">
          <div class="text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">当前清单</div>
          <div class="mt-1 text-xl font-semibold" :class="darkMode ? 'text-white' : 'text-gray-900'">{{ routes.length }}</div>
        </div>
        <div class="rounded-lg border p-3" :class="darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'">
          <div class="text-xs text-green-600 dark:text-green-400">已启用</div>
          <div class="mt-1 text-xl font-semibold text-green-600 dark:text-green-400">{{ enabledCount }}</div>
        </div>
        <div class="rounded-lg border p-3" :class="darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'">
          <div class="text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">已关闭</div>
          <div class="mt-1 text-xl font-semibold" :class="darkMode ? 'text-gray-300' : 'text-gray-700'">{{ disabledCount }}</div>
        </div>
      </div>

      <div
        v-if="selectedCount"
        class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border p-3"
        :class="darkMode ? 'bg-gray-800 border-gray-700' : 'bg-blue-50 border-blue-200'"
      >
        <span class="text-sm" :class="darkMode ? 'text-gray-200' : 'text-blue-900'">已选择 {{ selectedCount }} 条路由</span>
        <div class="flex flex-wrap gap-2">
          <button class="px-3 py-1.5 rounded-md text-sm text-white bg-green-600 hover:bg-green-700 disabled:opacity-50" :disabled="actionLoading" @click="runBulkAction('enable')">批量启用</button>
          <button class="px-3 py-1.5 rounded-md text-sm text-white bg-gray-600 hover:bg-gray-700 disabled:opacity-50" :disabled="actionLoading" @click="runBulkAction('disable')">批量关闭</button>
          <button class="px-3 py-1.5 rounded-md text-sm text-white bg-red-600 hover:bg-red-700 disabled:opacity-50" :disabled="actionLoading" @click="runBulkAction('delete')">批量删除</button>
          <button class="px-3 py-1.5 rounded-md text-sm border" :class="darkMode ? 'border-gray-600 text-gray-200' : 'border-gray-300 text-gray-700'" @click="selectedIds = []">取消选择</button>
        </div>
      </div>
    </div>

    <div v-if="notice" class="mb-4 p-3 rounded-lg bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">{{ notice }}</div>
    <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">{{ error }}</div>

    <div v-if="loading && !routes.length" class="flex flex-1 items-center justify-center rounded-lg shadow-md" :class="darkMode ? 'bg-gray-800' : 'bg-white'">
      <IconRefresh class="animate-spin h-8 w-8 text-primary-500" />
    </div>

    <div v-else-if="routes.length" class="rounded-lg shadow-md overflow-hidden" :class="darkMode ? 'bg-gray-800' : 'bg-white'">
      <div class="hidden lg:block overflow-x-auto">
        <table class="min-w-full divide-y" :class="darkMode ? 'divide-gray-700' : 'divide-gray-200'">
          <thead :class="darkMode ? 'bg-gray-700' : 'bg-gray-50'">
            <tr>
              <th class="px-4 py-3 text-left"><input type="checkbox" :checked="allSelected" class="rounded border-gray-300" @change="toggleAll" /></th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase" :class="darkMode ? 'text-gray-300' : 'text-gray-500'">公开地址</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase" :class="darkMode ? 'text-gray-300' : 'text-gray-500'">目标</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase" :class="darkMode ? 'text-gray-300' : 'text-gray-500'">状态</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase" :class="darkMode ? 'text-gray-300' : 'text-gray-500'">更新时间</th>
              <th class="px-4 py-3 text-right text-xs font-medium uppercase" :class="darkMode ? 'text-gray-300' : 'text-gray-500'">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y" :class="darkMode ? 'divide-gray-700' : 'divide-gray-200'">
            <tr v-for="route in routes" :key="route.id" :class="darkMode ? 'hover:bg-gray-700/60' : 'hover:bg-gray-50'">
              <td class="px-4 py-4"><input type="checkbox" :checked="selectedIds.includes(route.id)" class="rounded border-gray-300" @change="toggleSelected(route.id)" /></td>
              <td class="px-4 py-4 max-w-sm">
                <div class="flex items-center gap-2">
                  <IconLink class="flex-shrink-0 text-primary-500" />
                  <button class="font-mono text-sm text-left break-all text-primary-600 dark:text-primary-400 hover:underline" @click="openPublicRoute(route)">{{ publicUrl(route) }}</button>
                  <button title="复制公开地址" class="flex-shrink-0 text-gray-400 hover:text-primary-500" @click="copyPublicUrl(route)"><IconCopy /></button>
                </div>
              </td>
              <td class="px-4 py-4 max-w-md">
                <div class="flex items-center gap-2">
                  <IconFolder v-if="route.targetType === 'directory'" class="flex-shrink-0 text-amber-500" />
                  <IconArchive v-else class="flex-shrink-0 text-blue-500" />
                  <div class="min-w-0">
                    <div class="font-mono text-sm break-all" :class="darkMode ? 'text-gray-100' : 'text-gray-900'">{{ route.targetFsPath }}</div>
                    <div class="text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ route.targetType === "directory" ? "文件夹" : "文件" }}</div>
                  </div>
                </div>
              </td>
              <td class="px-4 py-4">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium" :class="route.enabled ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'">
                  <IconCheckCircle v-if="route.enabled" class="mr-1" />
                  <IconXCircle v-else class="mr-1" />
                  {{ route.enabled ? "已启用" : "已关闭" }}
                </span>
              </td>
              <td class="px-4 py-4 text-sm whitespace-nowrap" :class="darkMode ? 'text-gray-300' : 'text-gray-600'">{{ formatDateTime(route.updatedAt) }}</td>
              <td class="px-4 py-4">
                <div class="flex items-center justify-end gap-2">
                  <button class="px-2.5 py-1.5 rounded-md text-xs font-medium text-white disabled:opacity-50" :class="route.enabled ? 'bg-gray-600 hover:bg-gray-700' : 'bg-green-600 hover:bg-green-700'" :disabled="actionLoading" @click="setRouteEnabled(route, !route.enabled)">{{ route.enabled ? "关闭" : "启用" }}</button>
                  <button title="新窗口访问" class="p-1.5 rounded text-gray-500 hover:text-primary-600" @click="openPublicRoute(route)"><IconExternalLink /></button>
                  <button title="删除" class="p-1.5 rounded text-gray-500 hover:text-red-600" :disabled="actionLoading" @click="confirmDeleteRoute(route)"><IconDelete /></button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="lg:hidden divide-y" :class="darkMode ? 'divide-gray-700' : 'divide-gray-200'">
        <div class="p-3 flex items-center gap-2" :class="darkMode ? 'bg-gray-700' : 'bg-gray-50'">
          <input type="checkbox" :checked="allSelected" class="rounded border-gray-300" @change="toggleAll" />
          <span class="text-sm" :class="darkMode ? 'text-gray-300' : 'text-gray-600'">全选当前清单</span>
        </div>
        <article v-for="route in routes" :key="route.id" class="p-4">
          <div class="flex items-start gap-3">
            <input type="checkbox" :checked="selectedIds.includes(route.id)" class="mt-1 rounded border-gray-300" @change="toggleSelected(route.id)" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-2">
                <span class="inline-flex items-center px-2 py-1 rounded-full text-xs" :class="route.enabled ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'">{{ route.enabled ? "已启用" : "已关闭" }}</span>
                <span class="text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">{{ route.targetType === "directory" ? "文件夹" : "文件" }}</span>
              </div>
              <button class="mt-3 block font-mono text-sm text-left break-all text-primary-600 dark:text-primary-400" @click="openPublicRoute(route)">{{ publicUrl(route) }}</button>
              <div class="mt-2 font-mono text-xs break-all" :class="darkMode ? 'text-gray-300' : 'text-gray-600'">{{ route.targetFsPath }}</div>
              <div class="mt-4 flex flex-wrap gap-2">
                <button class="px-3 py-1.5 rounded-md text-xs text-white" :class="route.enabled ? 'bg-gray-600' : 'bg-green-600'" :disabled="actionLoading" @click="setRouteEnabled(route, !route.enabled)">{{ route.enabled ? "关闭" : "启用" }}</button>
                <button class="px-3 py-1.5 rounded-md text-xs border" :class="darkMode ? 'border-gray-600 text-gray-200' : 'border-gray-300 text-gray-700'" @click="copyPublicUrl(route)">复制地址</button>
                <button class="px-3 py-1.5 rounded-md text-xs text-white bg-red-600" :disabled="actionLoading" @click="confirmDeleteRoute(route)">删除</button>
              </div>
            </div>
          </div>
        </article>
      </div>
    </div>

    <div v-else class="flex flex-1 flex-col items-center justify-center py-12 rounded-lg shadow-md" :class="darkMode ? 'bg-gray-800 text-gray-400' : 'bg-white text-gray-500'">
      <IconArchive class="h-16 w-16 mb-4 opacity-50" />
      <p>{{ searchQuery || enabledFilter !== "all" ? "没有符合条件的公开路由" : "暂无公开路由，可在网盘管理中设置文件或文件夹公开访问" }}</p>
    </div>

    <ConfirmDialog
      v-bind="dialogState"
      @confirm="handleConfirm"
      @cancel="handleCancel"
    />
  </div>
</template>

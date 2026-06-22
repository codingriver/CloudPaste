<template>
  <div class="mount-explorer-container mx-auto px-3 sm:px-6 flex-1 flex flex-col pt-6 sm:pt-8 w-full max-w-full sm:max-w-6xl">
    <div class="header mb-4 border-b pb-2 flex justify-between items-center" :class="darkMode ? 'border-gray-800' : 'border-gray-100'">
      <h2 class="text-xl font-semibold" :class="darkMode ? 'text-gray-100' : 'text-gray-900'">{{ $t("mount.title") }}</h2>

      <!-- 右侧按钮组 -->
      <div class="flex items-center gap-2">
        <!-- 搜索按钮 -->
        <button
          @click="handleOpenSearchModal"
          class="flex items-center gap-2 px-3 py-1.5 rounded-md border transition-all duration-200 hover:shadow-sm"
          :class="
            darkMode
              ? 'border-gray-600 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-gray-200'
              : 'border-gray-300 bg-white hover:bg-gray-50 text-gray-600 hover:text-gray-700'
          "
          :title="$t('search.title')"
        >
          <!-- 搜索图标 -->
          <IconSearch size="sm" class="w-4 h-4" aria-hidden="true" />

          <!-- 搜索文字（在小屏幕上隐藏） -->
          <span class="hidden sm:inline text-sm text-gray-500" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
            {{ $t("search.placeholder") }}
          </span>

          <!-- 快捷键提示（在大屏幕上显示） -->
          <kbd
            class="hidden lg:inline-flex items-center px-1.5 py-0.5 text-xs font-mono rounded border"
            :class="darkMode ? 'bg-gray-700 border-gray-600 text-gray-300' : 'bg-gray-100 border-gray-300 text-gray-600'"
          >
            Ctrl K
          </kbd>
        </button>

        <!-- 设置按钮 -->
        <button
          @click="handleOpenSettingsDrawer"
          class="p-2 rounded-md border transition-all duration-200 hover:shadow-sm"
          :class="
            darkMode
              ? 'border-gray-600 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-gray-200'
              : 'border-gray-300 bg-white hover:bg-gray-50 text-gray-600 hover:text-gray-700'
          "
          :title="$t('mount.settings.title')"
        >
          <IconSettings size="sm" class="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!-- 权限管理组件 -->
    <PermissionManager
      :dark-mode="darkMode"
      permission-type="mount"
      :permission-required-text="$t('mount.permissionRequired')"
      :login-auth-text="$t('mount.loginAuth')"
      @permission-change="handlePermissionChange"
      @navigate-to-admin="navigateToAdmin"
    />

    <!-- 主要内容区域 -->
    <div v-if="hasPermission" class="mount-explorer-main">
      <!-- 顶部 README（仅目录视图显示） -->
      <DirectoryReadme v-if="!showFilePreview" position="top" :meta="directoryMeta" :dark-mode="darkMode" />

      <!-- 操作按钮 -->
      <div v-if="!showFilePreview" class="mb-4">
        <div class="px-1">
          <FileOperations
            :current-path="currentPath"
            :is-virtual="isVirtualDirectory"
            :dark-mode="darkMode"
            :view-mode="viewMode"
            :selected-items="selectedItems"
            :refreshing="directoryRefreshing"
            @create-folder="handleCreateFolder"
            @create-text-file="handleCreateTextFile"
            @refresh="handleRefresh"
            @change-view-mode="handleViewModeChange"
            @open-upload-modal="handleOpenUploadModal"
            @open-copy-modal="handleBatchCopy"
            @open-tasks-modal="handleOpenTasksModal"
            @task-created="handleTaskCreated"
            @show-message="handleShowMessage"
          />
        </div>
      </div>

      <!-- 上传弹窗 -->
      <UppyUploadModal
        v-if="hasEverOpenedUploadModal"
        :is-open="isUploadModalOpen"
        :current-path="currentPath"
        :dark-mode="darkMode"
        :is-admin="isAdmin"
        @close="handleCloseUploadModal"
        @upload-success="handleUploadSuccess"
        @upload-error="handleUploadError"
      />

      <!-- 复制弹窗 -->
      <CopyModal
        v-if="hasEverOpenedCopyModal"
        :is-open="isCopyModalOpen"
        :dark-mode="darkMode"
        :selected-items="copyModalItems"
        :source-path="currentPath"
        :is-admin="isAdmin"
        :api-key-info="apiKeyInfo"
        @close="handleCloseCopyModal"
        @copy-started="handleCopyStarted"
      />

      <!-- 移动弹窗 -->
      <CopyModal
        v-if="hasEverOpenedMoveModal"
        mode="move"
        :is-open="isMoveModalOpen"
        :dark-mode="darkMode"
        :selected-items="moveModalItems"
        :source-path="currentPath"
        :is-admin="isAdmin"
        :api-key-info="apiKeyInfo"
        @close="handleCloseMoveModal"
        @move-started="handleMoveStarted"
      />

      <!-- 任务列表弹窗 -->
      <TaskListModal
        v-if="hasEverOpenedTasksModal"
        :is-open="isTasksModalOpen"
        :dark-mode="darkMode"
        @close="handleCloseTasksModal"
        @task-completed="handleTaskCompleted"
      />

      <!-- 新建文件夹弹窗 -->
      <InputDialog
        :is-open="showCreateFolderDialog"
        :title="t('mount.operations.createFolder')"
        :description="t('mount.createFolder.enterName')"
        :label="t('mount.createFolder.folderName')"
        :placeholder="t('mount.createFolder.placeholder')"
        :validator="validateFsItemNameDialog"
        :confirm-text="t('mount.createFolder.create')"
        :cancel-text="t('mount.createFolder.cancel')"
        :loading="isCreatingFolder"
        :loading-text="t('mount.createFolder.creating')"
        :dark-mode="darkMode"
        @confirm="handleCreateFolderConfirm"
        @cancel="handleCreateFolderCancel"
        @close="showCreateFolderDialog = false"
      />

      <!-- 新建文本弹窗 -->
      <InputDialog
        :is-open="showCreateTextFileDialog"
        :title="t('mount.createTextFile.title')"
        :description="t('mount.createTextFile.enterName')"
        :label="t('mount.createTextFile.fileName')"
        :initial-value="t('mount.createTextFile.defaultName')"
        :placeholder="t('mount.createTextFile.placeholder')"
        :validator="validateFsItemNameDialog"
        :confirm-text="t('mount.createTextFile.create')"
        :cancel-text="t('mount.createTextFile.cancel')"
        :loading="isCreatingTextFile"
        :loading-text="t('mount.createTextFile.creating')"
        :dark-mode="darkMode"
        @confirm="handleCreateTextFileConfirm"
        @cancel="handleCreateTextFileCancel"
        @close="showCreateTextFileDialog = false"
      />

      <!-- 右键菜单重命名弹窗 -->
      <InputDialog
        :is-open="contextMenuRenameDialogOpen"
        :title="t('mount.rename.title')"
        :description="t('mount.rename.enterNewName')"
        :label="t('mount.rename.newName')"
        :initial-value="contextMenuRenameItem?.name || ''"
        :validator="validateFsItemNameDialog"
        :confirm-text="t('mount.rename.confirm')"
        :cancel-text="t('mount.rename.cancel')"
        :loading="isRenaming"
        :loading-text="t('mount.rename.renaming')"
        :dark-mode="darkMode"
        @confirm="handleContextMenuRenameConfirm"
        @cancel="handleContextMenuRenameCancel"
        @close="contextMenuRenameDialogOpen = false"
      />

      <!-- 通用 ConfirmDialog 组件替换内联对话框 -->
      <ConfirmDialog
        :is-open="showDeleteDialog"
        :title="itemsToDelete.length === 1 ? t('mount.delete.title') : t('mount.batchDelete.title')"
        :confirm-text="itemsToDelete.length === 1 ? t('mount.delete.confirm') : t('mount.batchDelete.confirmButton')"
        :cancel-text="itemsToDelete.length === 1 ? t('mount.delete.cancel') : t('mount.batchDelete.cancelButton')"
        :loading="isDeleting"
        :loading-text="itemsToDelete.length === 1 ? t('mount.delete.deleting') : t('mount.batchDelete.deleting')"
        :dark-mode="darkMode"
        confirm-type="danger"
        @confirm="confirmDelete"
        @cancel="cancelDelete"
        @close="showDeleteDialog = false"
      >
        <template #content>
          <template v-if="itemsToDelete.length === 1">
            {{
              t("mount.delete.message", {
                type: itemsToDelete[0]?.isDirectory ? t("mount.fileTypes.folder") : t("mount.fileTypes.file"),
                name: itemsToDelete[0]?.name,
              })
            }}
            {{ itemsToDelete[0]?.isDirectory ? t("mount.delete.folderWarning") : "" }}
          </template>
          <template v-else>
            {{ t("mount.batchDelete.message", { count: itemsToDelete.length }) }}
            <div class="mt-2">
              <div class="text-xs font-medium mb-1">{{ t("mount.batchDelete.selectedItems") }}</div>
              <div class="max-h-32 overflow-y-auto bg-gray-50 dark:bg-gray-700 rounded p-2 text-xs">
                <div v-for="item in itemsToDelete.slice(0, 10)" :key="item.path" class="flex items-center py-0.5">
                  <span class="truncate">{{ item.name }}</span>
                  <span v-if="item.isDirectory" class="ml-1 text-gray-500">{{ t("mount.batchDelete.folder") }}</span>
                </div>
                <div v-if="itemsToDelete.length > 10" class="text-gray-500 py-0.5">
                  {{ t("mount.batchDelete.moreItems", { count: itemsToDelete.length - 10 }) }}
                </div>
              </div>
            </div>
          </template>
        </template>
      </ConfirmDialog>

      <Teleport to="body">
        <div
          v-if="showUnsavedPreviewDialog"
          class="fixed inset-0 z-[75] overflow-auto bg-black bg-opacity-50 flex items-center justify-center p-4"
          @click="handleCancelClosePreview"
        >
          <div class="relative w-full max-w-md p-6 rounded-lg shadow-xl" :class="darkMode ? 'bg-gray-800' : 'bg-white'" @click.stop>
            <div class="mb-5">
              <h3 class="text-lg font-semibold" :class="darkMode ? 'text-gray-100' : 'text-gray-900'">
                {{ t("mount.filePreview.unsavedChangesTitle") }}
              </h3>
              <p class="text-sm mt-2" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
                {{ t("mount.filePreview.unsavedChangesMessage") }}
              </p>
            </div>

            <div class="flex flex-col sm:flex-row sm:justify-end gap-2">
              <button
                type="button"
                :disabled="isSavingPreviewBeforeClose"
                class="px-4 py-2 rounded-md transition-colors"
                :class="[darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100', isSavingPreviewBeforeClose ? 'opacity-50 cursor-not-allowed' : '']"
                @click="handleDiscardAndClosePreview"
              >
                {{ t("mount.filePreview.discardAndBack") }}
              </button>
              <button
                type="button"
                :disabled="isSavingPreviewBeforeClose"
                class="px-4 py-2 rounded-md transition-colors"
                :class="[darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100', isSavingPreviewBeforeClose ? 'opacity-50 cursor-not-allowed' : '']"
                @click="handleCancelClosePreview"
              >
                {{ t("mount.filePreview.keepEditing") }}
              </button>
              <button
                type="button"
                :disabled="isSavingPreviewBeforeClose"
                class="px-4 py-2 rounded-md text-white transition-colors inline-flex items-center justify-center gap-2"
                :class="isSavingPreviewBeforeClose ? 'bg-primary-500 cursor-not-allowed' : darkMode ? 'bg-primary-600 hover:bg-primary-700' : 'bg-primary-500 hover:bg-primary-600'"
                @click="handleSaveAndClosePreview"
              >
                <IconRefresh v-if="isSavingPreviewBeforeClose" class="w-4 h-4 animate-spin" aria-hidden="true" />
                <span>{{ isSavingPreviewBeforeClose ? t("mount.filePreview.saving") : t("mount.filePreview.saveAndBack") }}</span>
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 面包屑导航 -->
      <div class="mb-4">
          <BreadcrumbNav
          :current-path="currentViewPath"
          :dark-mode="darkMode"
          @navigate="handleNavigate"
          @prefetch="handlePrefetch"
          :basic-path="apiKeyInfo?.basic_path || '/'"
          :user-type="isAdmin ? 'admin' : 'user'"
        />
      </div>

      <!-- 内容区域 - 根据模式显示文件列表或文件预览 -->
      <div class="mount-content bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 transition-colors duration-200">
        <Transition name="fade-slide" mode="out-in" @before-enter="handleContentBeforeEnter">
          <!-- 文件列表模式 -->
          <div v-if="!showFilePreview" key="list">
            <!-- 内嵌式密码验证 -->
            <PathPasswordDialog
              v-if="pathPassword.showPasswordDialog.value"
              :is-open="pathPassword.showPasswordDialog.value"
              :path="pathPassword.pendingPath.value || currentPath"
              :dark-mode="darkMode"
              :inline="true"
              @verified="handlePasswordVerified"
              @cancel="handlePasswordCancel"
              @close="handlePasswordClose"
              @error="handlePasswordError"
            />

            <template v-else>
              <!-- 非阻塞错误提示：不再用 error 直接替换整个列表区域 -->
              <div v-if="error" class="mb-4 p-4 bg-red-100 dark:bg-red-900/20 border border-red-300 dark:border-red-700 rounded-lg">
                <div class="flex items-start justify-between gap-3">
                  <div class="flex items-start">
                    <IconXCircle size="md" class="w-5 h-5 text-red-500 mr-2 mt-0.5 shrink-0" aria-hidden="true" />
                    <div>
                      <div class="text-red-700 dark:text-red-200 font-medium">{{ $t("common.error") }}</div>
                      <div class="text-red-700/90 dark:text-red-200/90 text-sm mt-0.5">{{ error }}</div>
                      <div class="mt-3 flex flex-wrap gap-2">
                        <button
                          class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
                          :class="darkMode ? 'bg-red-800/40 hover:bg-red-800/60 text-red-100' : 'bg-red-200 hover:bg-red-300 text-red-900'"
                          @click="handleRetryDirectory"
                        >
                          {{ $t("common.retry") }}
                        </button>
                        <button
                          class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
                          :class="darkMode ? 'bg-gray-700 hover:bg-gray-600 text-gray-100' : 'bg-gray-200 hover:bg-gray-300 text-gray-800'"
                          @click="dismissDirectoryError"
                        >
                          {{ $t("common.close") }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 目录列表 -->
              <div class="min-h-[400px]">
                <DirectoryList
                  ref="directoryListRef"
                  :current-path="currentPath"
                  :items="visibleItems"
                  :loading="loading"
                  :has-more="directoryHasMore"
                  :loading-more="directoryLoadingMore"
                  :is-virtual="isVirtualDirectory"
                  :dark-mode="darkMode"
                  :view-mode="viewMode"
                  :show-checkboxes="explorerSettings.settings.showCheckboxes"
                  :selected-items="getSelectedItems()"
                  :context-highlight-path="contextHighlightPath"
                  :animations-enabled="explorerSettings.settings.animationsEnabled"
                  :file-name-overflow="explorerSettings.settings.fileNameOverflow"
                  :show-action-buttons="explorerSettings.settings.showActionButtons"
                  :processing-paths="processingPathSet"
                  :rename-loading="isDirectoryListRenaming"
                  @navigate="handleNavigate"
                  @download="handleDownload"
                  @getLink="handleGetLink"
                  @rename="handleRename"
                  @edit="handlePreview"
                  @delete="handleDelete"
                  @preview="handlePreview"
                  @load-more="handleLoadMore"
                  @item-select="handleItemSelect"
                  @toggle-select-all="toggleSelectAll"
                  @show-message="handleShowMessage"
                  @contextmenu="handleFileContextMenu"
                />
              </div>
            </template>
          </div>

          <!-- 文件预览模式 -->
          <div v-else key="preview">
            <!-- 预览加载状态 -->
            <div v-if="isPreviewLoading" class="p-8 text-center">
              <LoadingIndicator
                :text="$t('common.loading')"
                :dark-mode="darkMode"
                size="xl"
                icon-class="text-blue-500"
              />
            </div>

            <!-- 预览错误状态 -->
            <div v-else-if="previewError" class="p-8 text-center">
              <div class="flex flex-col items-center space-y-4">
                <IconExclamation size="3xl" class="w-12 h-12 text-red-500" aria-hidden="true" />
                <div class="text-red-600 dark:text-red-400">
                  {{ previewError }}
                </div>
                <button @click="closePreviewWithUrl" class="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors">
                  {{ $t("common.back") }}
                </button>
              </div>
            </div>

            <!-- 预览内容 -->
            <div v-else-if="previewFile || previewInfo" class="p-4">
              <!-- 返回按钮 -->
              <div class="mb-4">
                <button
                  @click="closePreviewWithUrl"
                  class="inline-flex items-center px-3 py-1.5 rounded-md transition-colors text-sm font-medium"
                  :class="darkMode ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-200 hover:bg-gray-300 text-gray-700'"
                >
                  <IconBack size="sm" class="w-4 h-4 mr-1.5" aria-hidden="true" />
                  <span>{{ t("mount.backToFileList") }}</span>
                </button>
              </div>

              <!-- 文件预览内容 -->
              <FilePreview
                ref="filePreviewRef"
                :file="previewInfo || previewFile"
                :dark-mode="darkMode"
                :is-loading="isPreviewLoading"
                :is-admin="isAdmin"
                :api-key-info="apiKeyInfo"
                :has-file-permission="hasFilePermission"
                :directory-items="visibleItems"
                @download="handleDownload"
                @loaded="handlePreviewLoaded"
                @error="handlePreviewError"
                @show-message="handleShowMessage"
              />
            </div>
          </div>
        </Transition>
      </div>

      <!-- 底部 README -->
      <DirectoryReadme v-if="!showFilePreview" position="bottom" :meta="directoryMeta" :dark-mode="darkMode" />
    </div>

    <!-- 搜索弹窗 -->
    <SearchModal
      v-if="hasEverOpenedSearchModal"
      :is-open="isSearchModalOpen"
      :dark-mode="darkMode"
      :current-path="currentPath"
      :current-mount-id="currentMountId"
      @close="handleCloseSearchModal"
      @item-click="handleSearchItemClick"
    />

    <!-- 设置抽屉 -->
    <SettingsDrawer
      v-if="hasEverOpenedSettingsDrawer"
      :is-open="isSettingsDrawerOpen"
      :dark-mode="darkMode"
      @close="handleCloseSettingsDrawer"
    />

    <!-- FS 媒体查看器（Lightbox Shell） -->
      <FsMediaLightboxDialog v-if="hasEverOpenedLightbox" />

    <FilePropertiesDrawer
      :is-open="isPropertiesDrawerOpen"
      :item="propertiesTarget"
      :dark-mode="darkMode"
      :can-write="!isVirtualDirectory"
      @close="handleClosePropertiesDrawer"
      @download="handleDownload"
      @get-link="handleGetLink"
      @copy-path="handleCopyPath"
      @copy-name="handleCopyName"
      @zip-download="handlePropertiesZipDownload"
      @copy="handlePropertiesCopy"
      @move="handlePropertiesMove"
      @rename="handlePropertiesRename"
      @delete="handlePropertiesDelete"
    />

    <!-- 悬浮操作栏 (当有选中项时显示) -->
    <FloatingActionBar
      v-if="hasPermission && selectedCount > 0"
      :selected-count="selectedCount"
      :dark-mode="darkMode"
      @download="handleBatchDownload"
      @copy-link="handleBatchGetLink"
      @copy="handleBatchCopy"
      @move="handleBatchMove"
      @add-to-basket="handleBatchAddToBasket"
      @rename="handleBatchRename"
      @delete="batchDelete"
      @clear-selection="handleClearSelection"
    />

    <!-- 浮动工具栏 (右下角快捷操作) -->
    <FloatingToolbar
      v-if="hasPermission"
      :dark-mode="darkMode"
      :can-write="!isVirtualDirectory"
      :show-checkboxes="explorerSettings.showCheckboxes"
      @refresh="handleRefresh"
      @new-folder="handleCreateFolder"
      @new-text-file="handleCreateTextFile"
      @upload="handleOpenUploadModal"
      @toggle-checkboxes="explorerSettings.toggleShowCheckboxes"
      @open-basket="handleOpenFileBasket"
      @open-tasks="handleOpenTasksModal"
      @settings="handleOpenSettingsDrawer"
    />

    <!-- 返回顶部按钮 -->
    <BackToTop :dark-mode="darkMode" />
  </div>
</template>

<script setup>
import { ref, computed, provide, onMounted, onBeforeUnmount, watch, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { storeToRefs } from "pinia";
import { useEventListener, useWindowScroll } from "@vueuse/core";
import { useThemeMode } from "@/composables/core/useThemeMode.js";
import { IconBack, IconExclamation, IconRefresh, IconSearch, IconSettings, IconXCircle } from "@/components/icons";
import LoadingIndicator from "@/components/common/LoadingIndicator.vue";

// 组合式函数 - 使用统一聚合导出
// 按需从具体文件导入
import { useSelection } from "@/composables/ui-interaction/useSelection.js";
import { useUIState } from "@/composables/ui-interaction/useUIState.js";
import { useFileBasket } from "@/composables/file-system/useFileBasket.js";
import { useFileOperations } from "@/composables/file-system/useFileOperations.js";
import { usePathPassword } from "@/composables/usePathPassword.js";
import { useContextMenu } from "@/composables/useContextMenu.js";

// 视图控制器
import { useMountExplorerController } from "./useMountExplorerController.js";

// 子组件
import BreadcrumbNav from "@/modules/fs/components/shared/BreadcrumbNav.vue";
import DirectoryList from "@/modules/fs/components/directory/DirectoryList.vue";
import DirectoryReadme from "@/modules/fs/components/DirectoryReadme.vue";
import FileOperations from "@/modules/fs/components/shared/FileOperations.vue";
import FilePropertiesDrawer from "@/modules/fs/components/shared/FilePropertiesDrawer.vue";
// （Uppy、Office、EPUB、视频播放器等）按需加载
const FilePreview = defineAsyncComponent(() => import("@/modules/fs/components/preview/FilePreview.vue"));
const UppyUploadModal = defineAsyncComponent(() => import("@/modules/fs/components/shared/modals/UppyUploadModal.vue"));
const CopyModal = defineAsyncComponent(() => import("@/modules/fs/components/shared/modals/CopyModal.vue"));
const TaskListModal = defineAsyncComponent(() => import("@/modules/fs/components/shared/modals/TaskListModal.vue"));
const SearchModal = defineAsyncComponent(() => import("@/modules/fs/components/shared/modals/SearchModal.vue"));
import PathPasswordDialog from "@/modules/fs/components/shared/modals/PathPasswordDialog.vue";
import ConfirmDialog from "@/components/common/dialogs/ConfirmDialog.vue";
import InputDialog from "@/components/common/dialogs/InputDialog.vue";
const FsMediaLightboxDialog = defineAsyncComponent(() => import("@/modules/fs/components/lightbox/FsMediaLightboxDialog.vue"));
import PermissionManager from "@/components/common/PermissionManager.vue";
const SettingsDrawer = defineAsyncComponent(() => import("@/modules/fs/components/shared/SettingsDrawer.vue"));
import FloatingActionBar from "@/modules/fs/components/shared/FloatingActionBar.vue";
import FloatingToolbar from "@/modules/fs/components/shared/FloatingToolbar.vue";
import BackToTop from "@/modules/fs/components/shared/BackToTop.vue";
import { useExplorerSettings } from "@/composables/useExplorerSettings";
import { createFsItemNameDialogValidator, isSameOrSubPath, validateFsItemName } from "@/utils/fsPathUtils.js";
import { useFsMediaLightbox } from "@/modules/fs/composables/useFsMediaLightbox";
import { useFsService } from "@/modules/fs/fsService.js";
import { copyToClipboard } from "@/utils/clipboard.js";
import { TaskStatus, TaskType, useTaskManager } from "@/utils/taskManager.js";
import { createLogger } from "@/utils/logger.js";

const { t } = useI18n();
const log = createLogger("MountExplorerView");

const validateFsItemNameDialog = createFsItemNameDialogValidator(t);

// 使用组合式函数
const selection = useSelection();
const fileOperations = useFileOperations();
const uiState = useUIState();
const fileBasket = useFileBasket();
const pathPassword = usePathPassword();
const fsService = useFsService();
const taskManager = useTaskManager();

// 右键菜单 - 延迟初始化
let contextMenu = null;
let processingTaskPollTimer = null;
const backendProcessingPathSet = ref(new Set());

// Lightbox（模块内单例）
const fsLightbox = useFsMediaLightbox();

// 文件篮状态
const { isBasketOpen } = storeToRefs(fileBasket);

// 控制器：封装路由 / 权限 / 目录加载与预览初始化
const {
  currentPath,
  currentViewPath,
  loading,
  error,
  hasPermissionForCurrentPath,
  directoryItems,
  isVirtualDirectory,
  directoryMeta,
  directoryHasMore,
  directoryLoadingMore,
  directoryRefreshing,
  isAdmin,
  hasApiKey,
  hasFilePermission,
  hasMountPermission,
  hasPermission,
  apiKeyInfo,
  currentMountId,
  previewFile,
  previewInfo,
  isPreviewLoading,
  previewError,
  showFilePreview,
  updateUrl,
  navigateTo,
  navigateToPreserveHistory,
  navigateToFile,
  stopPreview,
  refreshDirectory,
  refreshDirectoryInBackground,
  refreshCurrentRoute,
  prefetchDirectory,
  consumePendingScrollRestore,
  invalidateCaches,
  removeItemsFromCurrentDirectory,
  loadMoreCurrentDirectory,
} = useMountExplorerController();

const { y: windowScrollY } = useWindowScroll();

// ===== 仅“第一次打开”时才加载重弹窗组件 =====
const hasEverOpenedUploadModal = ref(false);
const hasEverOpenedCopyModal = ref(false);
const hasEverOpenedMoveModal = ref(false);
const hasEverOpenedTasksModal = ref(false);
const hasEverOpenedSearchModal = ref(false);
const hasEverOpenedSettingsDrawer = ref(false);
const hasEverOpenedLightbox = ref(false);

const scheduleWindowScrollTo = (top) => {
  if (typeof window === "undefined") return;
  // 等列表 DOM 插入并完成一次布局后再滚动
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      windowScrollY.value = top;
    });
    return;
  }
  // 降级：极端环境无 rAF
  setTimeout(() => {
    windowScrollY.value = top;
  }, 0);
};

// 解决你说的“先下→到顶→再下”抖动：把滚动设置统一收口到 Transition 的进入阶段，只执行一次
const handleContentBeforeEnter = () => {
  // 进入预览：默认回到顶部
  if (showFilePreview.value) {
    scheduleWindowScrollTo(0);
    return;
  }

  // 回到列表：如果 controller 有“待恢复的滚动值”，在列表真正进入前先设置好
  if (typeof consumePendingScrollRestore === "function") {
    const value = consumePendingScrollRestore();
    if (typeof value === "number") {
      scheduleWindowScrollTo(value);
    }
  }
};

// 根据目录 Meta 的隐藏规则计算实际可见条目
const visibleItems = computed(() => {
  const items = directoryItems.value || [];
  const meta = directoryMeta.value;
  const patterns = meta && Array.isArray(meta.hidePatterns) ? meta.hidePatterns : [];

  if (!patterns.length) {
    return items;
  }

  const regexes = patterns
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch {
        return null;
      }
    })
    .filter((re) => re);

  if (!regexes.length) {
    return items;
  }

  return items.filter((item) => !regexes.some((re) => re.test(item.name)));
});

const normalizeProcessingPath = (path) => String(path || "").replace(/\/+$/, "");

const isProcessingPathMatch = (path, processingPath) => {
  const normalizedPath = normalizeProcessingPath(path);
  const normalizedProcessingPath = normalizeProcessingPath(processingPath);
  if (!normalizedPath || !normalizedProcessingPath) return false;
  if (normalizedPath === normalizedProcessingPath) return true;
  return normalizedPath.startsWith(`${normalizedProcessingPath}/`);
};

const processingPathSet = computed(() => {
  const activeStatuses = new Set([TaskStatus.PENDING, TaskStatus.RUNNING]);
  const writeTaskTypes = new Set([TaskType.COPY, TaskType.MOVE, TaskType.DELETE]);
  const paths = new Set(backendProcessingPathSet.value);

  for (const task of taskManager.state.tasks || []) {
    if (!activeStatuses.has(task?.status) || !writeTaskTypes.has(task?.type)) continue;

    const affectedPaths = Array.isArray(task?.details?.affectedPaths) ? task.details.affectedPaths : [];
    for (const path of affectedPaths) {
      const normalized = normalizeProcessingPath(path);
      if (normalized) paths.add(normalized);
    }
  }

  return paths;
});

const isItemProcessing = (item) => {
  const path = normalizeProcessingPath(item?.path);
  return Boolean(path && Array.from(processingPathSet.value).some((processingPath) => isProcessingPathMatch(path, processingPath)));
};

const hasProcessingSelection = () => getSelectedItems().some((item) => isItemProcessing(item));

const warnProcessingOperation = () => {
  showMessage("warning", t("mount.messages.itemProcessingLocked"));
};

const { selectedItems, selectedCount, setAvailableItems, toggleSelectAll, getSelectedItems, selectItem, clearSelection } = selection;

// 组合式函数状态和方法
const {
  // 消息管理
  showMessage,
  // 弹窗状态管理
  isUploadModalOpen,
  isCopyModalOpen,
  isTasksModalOpen,
  isSearchModalOpen,

  openUploadModal,
  closeUploadModal,
  openCopyModal,
  closeCopyModal,
  openTasksModal,
  closeTasksModal,
  openSearchModal,
  closeSearchModal,
} = uiState;

const showDeleteDialog = ref(false);
const itemsToDelete = ref([]);
const isDeleting = ref(false);
const showUnsavedPreviewDialog = ref(false);
const isSavingPreviewBeforeClose = ref(false);

// 右键菜单相关状态
const contextMenuRenameItem = ref(null);
const contextMenuRenameDialogOpen = ref(false);
const isRenaming = ref(false); // 重命名操作的 loading 状态
const contextMenuCopyItems = ref([]);
const contextMenuMoveItems = ref([]);
// 右键菜单高亮的项目路径（临时高亮，不是勾选选中）
const contextHighlightPath = ref(null);
// DirectoryList 组件引用
const directoryListRef = ref(null);
const filePreviewRef = ref(null);
// DirectoryList 重命名操作的 loading 状态
const isDirectoryListRenaming = ref(false);

// 新建文件夹弹窗状态
const showCreateFolderDialog = ref(false);
const isCreatingFolder = ref(false);
const showCreateTextFileDialog = ref(false);
const isCreatingTextFile = ref(false);

// 设置抽屉状态
const isSettingsDrawerOpen = ref(false);
const isMoveModalOpen = ref(false);
const isPropertiesDrawerOpen = ref(false);
const propertiesTarget = ref(null);

// ===== 仅“第一次打开”时才加载重弹窗组件（watch 需要在依赖变量定义之后注册） =====
watch(
  () => isUploadModalOpen.value,
  (open) => {
    if (open) hasEverOpenedUploadModal.value = true;
  }
);
watch(
  () => isCopyModalOpen.value,
  (open) => {
    if (open) hasEverOpenedCopyModal.value = true;
  }
);
watch(
  () => isMoveModalOpen.value,
  (open) => {
    if (open) hasEverOpenedMoveModal.value = true;
  }
);
watch(
  () => isTasksModalOpen.value,
  (open) => {
    if (open) hasEverOpenedTasksModal.value = true;
  }
);
watch(
  () => isSearchModalOpen.value,
  (open) => {
    if (open) hasEverOpenedSearchModal.value = true;
  }
);
watch(
  () => isSettingsDrawerOpen.value,
  (open) => {
    if (open) hasEverOpenedSettingsDrawer.value = true;
  }
);
watch(
  () => fsLightbox.isOpen.value,
  (open) => {
    if (open) hasEverOpenedLightbox.value = true;
  }
);

// 初始化用户配置
const explorerSettings = useExplorerSettings();

// 从 explorerSettings 获取视图模式
const viewMode = computed(() => explorerSettings.settings.viewMode);
const setViewMode = (mode) => explorerSettings.setViewMode(mode);

// 复制弹窗使用的项目列表：优先使用右键菜单选中的项目，否则使用勾选的项目
const copyModalItems = computed(() => {
  if (contextMenuCopyItems.value.length > 0) {
    return contextMenuCopyItems.value;
  }
  return getSelectedItems();
});

// 移动弹窗使用的项目列表：预留右键入口，当前多选工具栏使用勾选项目
const moveModalItems = computed(() => {
  if (contextMenuMoveItems.value.length > 0) {
    return contextMenuMoveItems.value;
  }
  return getSelectedItems();
});

// 初始化右键菜单
const initContextMenu = () => {
  contextMenu = useContextMenu({
    onOpen: (item) => {
      if (!item) return;
      if (isItemProcessing(item)) {
        warnProcessingOperation();
        return;
      }
      if (item.isDirectory) {
        handleNavigate(item.path);
      } else {
        handlePreview(item);
      }
    },
    onDownload: handleDownload,
    onGetLink: handleGetLink,
    onRename: handleContextRename,
    onDelete: handleContextDelete,
    onCopy: handleContextCopy,
    onMove: handleContextMove,
    onProperties: handleOpenProperties,
    onCopyPath: handleCopyPath,
    onCopyName: handleCopyName,
    onZipDownload: handleZipDownload,
    onAddToBasket: (items) => {
      const itemsArray = Array.isArray(items) ? items : [items];
      const result = fileBasket.addSelectedToBasket(itemsArray, currentPath.value);
      if (result.success) {
        showMessage("success", result.message);
      } else {
        showMessage("error", result.message);
      }
    },
    onToggleCheckboxes: () => {
      // 切换勾选框显示状态
      explorerSettings.toggleShowCheckboxes();
    },
    onRefresh: handleRefresh,
    canWrite: () => !isVirtualDirectory.value,
    t,
  });
};

const isBackendJobComplete = (status) => ["completed", "success", "partial"].includes(String(status || "").toLowerCase());
const isBackendJobFailed = (status) => ["failed", "cancelled", "canceled"].includes(String(status || "").toLowerCase());
const isBackendJobActive = (status) => ["pending", "running"].includes(String(status || "").toLowerCase());
const isWriteJobType = (taskType) => ["copy", "move", "delete"].includes(String(taskType || "").toLowerCase());

const addNormalizedProcessingPath = (paths, path) => {
  const normalized = normalizeProcessingPath(path);
  if (normalized) paths.add(normalized);
};

const getParentDirectoryPath = (path) => {
  const normalized = normalizeProcessingPath(path);
  if (!normalized || normalized === "/") return "/";
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex <= 0) return "/";
  return normalized.slice(0, slashIndex);
};

const collectProcessingPathsFromJob = (job) => {
  const paths = new Set();
  const payload = job?.payload || {};
  const stats = job?.stats || {};

  if (Array.isArray(payload.paths)) {
    for (const path of payload.paths) {
      addNormalizedProcessingPath(paths, path);
    }
  }

  if (Array.isArray(payload.items)) {
    for (const item of payload.items) {
      addNormalizedProcessingPath(paths, item?.sourcePath);
      addNormalizedProcessingPath(paths, item?.targetPath);
      addNormalizedProcessingPath(paths, getParentDirectoryPath(item?.targetPath));
    }
  }

  if (Array.isArray(stats.itemResults)) {
    for (const item of stats.itemResults) {
      addNormalizedProcessingPath(paths, item?.sourcePath);
      addNormalizedProcessingPath(paths, item?.targetPath);
      addNormalizedProcessingPath(paths, getParentDirectoryPath(item?.targetPath));
    }
  }

  return paths;
};

const syncBackendProcessingLocks = async () => {
  try {
    const response = await fsService.listJobs({ limit: 100 });
    const payload = response?.data || response || {};
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    const paths = new Set();

    for (const job of jobs) {
      if (!isBackendJobActive(job?.status) || !isWriteJobType(job?.taskType)) continue;
      for (const path of collectProcessingPathsFromJob(job)) {
        paths.add(path);
      }
    }

    backendProcessingPathSet.value = paths;
  } catch (error) {
    log.warn("[MountExplorer] 同步后端批量任务锁失败:", error);
  }
};

const pollProcessingTaskLocks = async () => {
  const activeStatuses = new Set([TaskStatus.PENDING, TaskStatus.RUNNING]);
  const localTasks = (taskManager.state.tasks || []).filter((task) => activeStatuses.has(task?.status) && task?.details?.jobId);
  await syncBackendProcessingLocks();
  if (localTasks.length === 0) return;

  let hasCompleted = false;
  for (const task of localTasks) {
    try {
      const response = await fsService.getJobStatus(task.details.jobId);
      const job = response?.data || response;
      const status = job?.status;
      if (isBackendJobComplete(status)) {
        taskManager.completeTask(task.id, { status, affectedPaths: [] });
        hasCompleted = true;
      } else if (isBackendJobFailed(status)) {
        taskManager.failTask(task.id, job?.errorMessage || status, { status, affectedPaths: [] });
        hasCompleted = true;
      }
    } catch (error) {
      log.warn("[MountExplorer] 轮询批量任务锁状态失败:", error);
    }
  }

  if (hasCompleted) {
    invalidateCaches();
    await refreshDirectory();
  }
};

onMounted(() => {
  explorerSettings.loadSettings();
  explorerSettings.setupDarkModeObserver();
  initContextMenu();
  void syncBackendProcessingLocks();
  processingTaskPollTimer = window.setInterval(() => {
    void pollProcessingTaskLocks();
  }, 5000);
});

const props = defineProps({
  mode: {
    type: String,
    default: "default", // 默认模式，或 "selection"（选择模式）
  },
});

const { isDarkMode: darkMode } = useThemeMode();

// 权限变化处理
const handlePermissionChange = (hasPermission) => {
  // 权限状态会自动更新，这里只需要记录日志
};

// API密钥信息
// 导航到管理页面
const navigateToAdmin = () => {
  import("@/router").then(({ routerUtils }) => {
    routerUtils.navigateTo("admin");
  });
};

// 搜索相关事件处理
const handleOpenSearchModal = () => {
  openSearchModal();
};

// 设置抽屉事件处理
const handleOpenSettingsDrawer = () => {
  isSettingsDrawerOpen.value = true;
};

const handleCloseSettingsDrawer = () => {
  isSettingsDrawerOpen.value = false;
};

// 打开文件篮
const handleOpenFileBasket = () => {
  fileBasket.toggleBasket();
};

const toItemArray = (items) => (Array.isArray(items) ? items.filter(Boolean) : items ? [items] : []);

const getItemParentPath = (item) => {
  const rawPath = String(item?.path || "");
  if (!rawPath || rawPath === "/") return "/";
  const normalized = item?.isDirectory ? rawPath.replace(/\/+$/, "") : rawPath;
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return `${normalized.slice(0, index)}/`.replace(/\/{2,}/g, "/");
};

const handleContextRename = (item) => {
  if (!item) return;
  if (isItemProcessing(item)) {
    warnProcessingOperation();
    return;
  }
  contextMenuRenameItem.value = item;
  contextMenuRenameDialogOpen.value = true;
};

const handleContextDelete = (items) => {
  const itemsArray = toItemArray(items);
  if (itemsArray.length === 0) return;
  if (itemsArray.some((item) => isItemProcessing(item))) {
    warnProcessingOperation();
    return;
  }
  itemsToDelete.value = itemsArray;
  showDeleteDialog.value = true;
};

const handleContextCopy = (items) => {
  const itemsArray = toItemArray(items);
  if (itemsArray.length === 0) {
    showMessage("warning", t("mount.messages.noItemsSelected"));
    return;
  }
  contextMenuCopyItems.value = itemsArray;
  openCopyModal();
};

const handleContextMove = (items) => {
  const itemsArray = toItemArray(items);
  if (itemsArray.length === 0) {
    showMessage("warning", t("mount.messages.noItemsSelected"));
    return;
  }
  if (itemsArray.some((item) => isItemProcessing(item))) {
    warnProcessingOperation();
    return;
  }
  contextMenuMoveItems.value = itemsArray;
  isMoveModalOpen.value = true;
};

const handleOpenProperties = (items) => {
  const itemsArray = toItemArray(items);
  propertiesTarget.value = itemsArray.length > 1 ? itemsArray : itemsArray[0] || null;
  isPropertiesDrawerOpen.value = !!propertiesTarget.value;
};

const handleClosePropertiesDrawer = () => {
  isPropertiesDrawerOpen.value = false;
  propertiesTarget.value = null;
};

const handleCopyPath = async (items) => {
  const itemsArray = toItemArray(items);
  const text = itemsArray.map((item) => item.path).filter(Boolean).join("\n");
  const ok = await copyToClipboard(text);
  showMessage(ok ? "success" : "error", ok ? t("mount.messages.pathCopiedSuccess") : t("mount.messages.copyFailed", { message: t("common.unknown") }));
};

const handleCopyName = async (items) => {
  const itemsArray = toItemArray(items);
  const text = itemsArray.map((item) => item.name).filter(Boolean).join("\n");
  const ok = await copyToClipboard(text);
  showMessage(ok ? "success" : "error", ok ? t("mount.messages.nameCopiedSuccess") : t("mount.messages.copyFailed", { message: t("common.unknown") }));
};

const collectFilesForZip = async (items) => {
  const output = [];
  const visitedDirs = new Set();

  const addFile = (file, sourceDirectory = null) => {
    if (!file || file.isDirectory || !file.path || !file.name) return;
    output.push({
      ...file,
      sourceDirectory: sourceDirectory || getItemParentPath(file),
    });
  };

  const walkDirectory = async (dir) => {
    const dirPath = String(dir?.path || "");
    if (!dirPath || visitedDirs.has(dirPath)) return;
    visitedDirs.add(dirPath);

    let cursor = null;
    do {
      const data = await fsService.getDirectoryList(dirPath, { cursor });
      const children = Array.isArray(data?.items) ? data.items : [];

      for (const child of children) {
        if (child?.isDirectory) {
          await walkDirectory(child);
        } else {
          addFile(child, getItemParentPath(child));
        }
      }

      cursor = typeof data?.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
    } while (cursor);
  };

  for (const item of toItemArray(items)) {
    if (item?.isDirectory) {
      await walkDirectory(item);
    } else {
      addFile(item);
    }
  }

  const unique = new Map();
  for (const file of output) {
    if (!unique.has(file.path)) {
      unique.set(file.path, file);
    }
  }
  return Array.from(unique.values());
};

const handleZipDownload = async (items) => {
  const itemsArray = toItemArray(items);
  if (itemsArray.length === 0) {
    showMessage("warning", t("mount.messages.noItemsSelected"));
    return;
  }

  try {
    showMessage("info", t("mount.messages.zipPreparing"));
    const files = await collectFilesForZip(itemsArray);
    if (files.length === 0) {
      showMessage("warning", t("mount.messages.noFilesForZip"));
      return;
    }

    const result = await fileBasket.createPackTaskForFiles(files, {
      taskName: t("mount.contextMenu.zipTaskName", { count: files.length }),
      emptyMessage: t("mount.messages.noFilesForZip"),
    });

    if (result.success) {
      showMessage("success", result.message);
      openTasksModal();
    } else {
      showMessage("warning", result.message);
    }
  } catch (error) {
    log.error("创建 ZIP 下载任务失败:", error);
    showMessage("error", t("mount.messages.zipCreateFailed", { message: error?.message || t("common.unknown") }));
  }
};

const closePropertiesAfterAction = () => {
  if (isPropertiesDrawerOpen.value) {
    handleClosePropertiesDrawer();
  }
};

const handlePropertiesZipDownload = async (items) => {
  await handleZipDownload(items);
  closePropertiesAfterAction();
};

const handlePropertiesCopy = (items) => {
  handleContextCopy(items);
  closePropertiesAfterAction();
};

const handlePropertiesMove = (items) => {
  handleContextMove(items);
  closePropertiesAfterAction();
};

const handlePropertiesRename = (item) => {
  handleContextRename(item);
  closePropertiesAfterAction();
};

const handlePropertiesDelete = (items) => {
  handleContextDelete(items);
  closePropertiesAfterAction();
};

// 悬浮操作栏事件处理
const handleBatchDownload = async () => {
  const selectedFiles = getSelectedItems();
  for (const item of selectedFiles) {
    if (!item.isDirectory) {
      await handleDownload(item);
    }
  }
};

const handleBatchGetLink = async () => {
  const selectedFiles = getSelectedItems();
  if (selectedFiles.length === 1 && !selectedFiles[0].isDirectory) {
    await handleGetLink(selectedFiles[0]);
  }
};

const handleBatchRename = () => {
  const selectedFiles = getSelectedItems();
  if (selectedFiles.length === 1) {
    if (isItemProcessing(selectedFiles[0])) {
      warnProcessingOperation();
      return;
    }
    // 直接打开重命名对话框
    contextMenuRenameItem.value = selectedFiles[0];
    contextMenuRenameDialogOpen.value = true;
  }
};

const handleClearSelection = () => {
  clearSelection();
};

const handleCloseSearchModal = () => {
  closeSearchModal();
};

// 处理搜索结果项点击
const handleSearchItemClick = async (item) => {
  try {
    if (!item.isDirectory) {
      await navigateToFile(item.path);
    } else {
      await navigateTo(item.path);
    }

    // 关闭搜索模态框
    closeSearchModal();
  } catch (error) {
    log.error("搜索结果导航失败:", error);
    showMessage("error", "导航失败: " + error.message);
  }
};

// ===== MountExplorerMain的所有方法 =====

/**
 * 处理导航
 */
const handleNavigate = async (path) => {
  // 面包屑/返回上级属于“回退导航”：
  // - 优先保留目标目录的 history 快照
  if (isSameOrSubPath(path, currentViewPath.value)) {
    await navigateToPreserveHistory(path);
    return;
  }

  await navigateTo(path);
};

const handlePrefetch = (path) => {
  prefetchDirectory(path);
};

/**
 * 处理刷新
 */
const REFRESH_SLOW_HINT_MS = 6000;

const handleRefresh = async () => {
  if (directoryRefreshing.value) return;

  let slowHintTimer = null;
  try {
    slowHintTimer = window.setTimeout(() => {
      if (directoryRefreshing.value) {
        showMessage("info", t("mount.messages.refreshStillRunning"));
      }
    }, REFRESH_SLOW_HINT_MS);

    const refreshed = await refreshDirectoryInBackground();
    if (refreshed) {
      showMessage("success", t("mount.messages.refreshSuccess"));
    }
  } catch (error) {
    showMessage("error", error?.message || t("mount.messages.refreshFailed"));
  } finally {
    if (slowHintTimer) {
      window.clearTimeout(slowHintTimer);
    }
  }
};

/**
 * 处理“加载更多”（用于上游分页的目录）
 */
const handleLoadMore = async () => {
  await loadMoreCurrentDirectory();
};

/**
 * 处理视图模式变化
 */
const handleViewModeChange = (newViewMode) => {
  setViewMode(newViewMode);
  // 视图模式已通过 useExplorerSettings 自动保存到 localStorage
};

/**
 * 处理文件夹创建 - 打开弹窗
 */
const handleCreateFolder = () => {
  showCreateFolderDialog.value = true;
};

/**
 * 处理创建文本文件 - 打开弹窗
 */
const handleCreateTextFile = () => {
  showCreateTextFileDialog.value = true;
};

/**
 * 处理新建文件夹确认
 */
const handleCreateFolderConfirm = async (folderName) => {
  if (!folderName) return;

  isCreatingFolder.value = true;
  try {
    // 使用fileOperations创建文件夹，传递正确的参数
    const result = await fileOperations.createFolder(currentPath.value, folderName);

    if (result.success) {
      showMessage("success", result.message);
      invalidateCaches();
      // 重新加载当前目录内容
      await refreshDirectory();
      showCreateFolderDialog.value = false;
    } else {
      showMessage("error", result.message);
    }
  } catch (error) {
    log.error("创建文件夹失败:", error);
    showMessage("error", "创建文件夹失败，请重试");
  } finally {
    isCreatingFolder.value = false;
  }
};

/**
 * 处理新建文件夹取消
 */
const handleCreateFolderCancel = () => {
  showCreateFolderDialog.value = false;
};

/**
 * 处理新建文本确认
 */
const handleCreateTextFileConfirm = async (fileName) => {
  if (!fileName) return;

  const nameValidation = validateFsItemName(fileName);
  if (!nameValidation.valid) return;

  const normalizedName = fileName.trim();
  const exists = visibleItems.value.some((item) => item?.name === normalizedName);
  if (exists) {
    showMessage("error", t("mount.messages.itemAlreadyExists", { name: normalizedName }));
    return;
  }

  isCreatingTextFile.value = true;
  try {
    const result = await fileOperations.createTextFile(currentPath.value, normalizedName, "");

    if (result.success) {
      showMessage("success", result.message);
      invalidateCaches();
      await refreshDirectory();
      showCreateTextFileDialog.value = false;
    } else {
      showMessage("error", result.message);
    }
  } catch (error) {
    log.error("创建文本文件失败:", error);
    showMessage("error", error.message || t("mount.messages.createTextFileFailed"));
  } finally {
    isCreatingTextFile.value = false;
  }
};

/**
 * 处理新建文本取消
 */
const handleCreateTextFileCancel = () => {
  showCreateTextFileDialog.value = false;
};

/**
 * 处理右键菜单重命名确认
 */
const handleContextMenuRenameConfirm = async (newName) => {
  if (!contextMenuRenameItem.value || !newName || !newName.trim()) return;

  const nameValidation = validateFsItemName(newName);
  if (!nameValidation.valid) return;

  // 设置 loading 状态
  isRenaming.value = true;

  try {
    const item = contextMenuRenameItem.value;
    const isDirectory = item.isDirectory;
    const oldPath = item.path;
    const basePath = isDirectory && oldPath.endsWith("/") ? oldPath.slice(0, -1) : oldPath;
    const parentPath = basePath.substring(0, basePath.lastIndexOf("/") + 1);
    let newPath = parentPath + newName.trim();

    // 目录在后端契约中仍以 `/` 结尾
    if (isDirectory) {
      newPath += "/";
    }

    if (isDirectory) {
      const response = await fsService.batchMoveItems([{ sourcePath: oldPath, targetPath: newPath }], {});
      const data = response?.data || response;
      showMessage(
        "success",
        response?.message ||
          t("mount.taskManager.moveStarted", {
            count: 1,
            path: newPath,
          }),
      );
      if (data?.jobId) {
        openTasksModal();
      }
      invalidateCaches();
      contextMenuRenameDialogOpen.value = false;
      contextMenuRenameItem.value = null;
      return;
    }

    // 文件重命名仍使用轻量同步接口；文件夹重命名走后台任务，避免大目录触发 Worker invocation 限制。
    const result = await fileOperations.renameItem(oldPath, newPath);

    if (result.success) {
      showMessage("success", result.message);
      invalidateCaches();
      // 重新加载当前目录内容
      await refreshDirectory();
      // 关闭对话框并清理状态
      contextMenuRenameDialogOpen.value = false;
      contextMenuRenameItem.value = null;
    } else {
      showMessage("error", result.message);
    }
  } catch (error) {
    log.error("重命名失败:", error);
    showMessage("error", error.message || t("mount.rename.failed"));
  } finally {
    isRenaming.value = false;
  }
};

/**
 * 处理右键菜单重命名取消
 */
const handleContextMenuRenameCancel = () => {
  contextMenuRenameDialogOpen.value = false;
  contextMenuRenameItem.value = null;
};

/**
 * 关闭文件篮面板
 */
const closeBasket = () => {
  try {
    fileBasket.closeBasket();
  } catch (error) {
    log.error("关闭文件篮面板失败:", error);
  }
};

/**
 * 处理文件下载
 */
const handleDownload = async (item) => {
  const result = await fileOperations.downloadFile(item);

  if (result.success) {
    showMessage("success", result.message);
  } else {
    showMessage("error", result.message);
  }
};

/**
 * 处理获取文件链接
 */
const handleGetLink = async (item) => {
  const result = await fileOperations.getFileLink(item);

  if (result.success) {
    showMessage("success", result.message);
  } else {
    showMessage("error", result.message);
  }
};

/**
 * 处理文件预览
 */
const handlePreview = async (item) => {
  if (!item || item.isDirectory) return;
  if (isItemProcessing(item)) {
    warnProcessingOperation();
    return;
  }

  // 直接导航到文件路径（pathname 表示对象）
  await navigateToFile(item.path);
};

/**
 * 处理文件删除（显示确认对话框）
 */
const handleDelete = (item) => {
  if (isItemProcessing(item)) {
    warnProcessingOperation();
    return;
  }
  itemsToDelete.value = [item];
  showDeleteDialog.value = true;
};

/**
 * 处理文件重命名
 */
const handleRename = async ({ item, newName }) => {
  if (!item || !newName || !newName.trim()) return;
  if (isItemProcessing(item)) {
    warnProcessingOperation();
    return;
  }

  const nameValidation = validateFsItemName(newName);
  if (!nameValidation.valid) return;

  // 设置 loading 状态（用于 DirectoryList 内部的重命名对话框）
  isDirectoryListRenaming.value = true;

  try {
    // 构建新路径
    const isDirectory = item.isDirectory;
    const oldPath = item.path;
    const basePath = isDirectory && oldPath.endsWith("/") ? oldPath.slice(0, -1) : oldPath;
    const parentPath = basePath.substring(0, basePath.lastIndexOf("/") + 1);
    let newPath = parentPath + newName.trim();

    // 目录在后端契约中仍以 `/` 结尾
    if (isDirectory) {
      newPath += "/";
    }

    // 使用fileOperations重命名
    const result = await fileOperations.renameItem(oldPath, newPath);

    if (result.success) {
      showMessage("success", result.message);
      invalidateCaches();
      // 重新加载当前目录内容
      await refreshDirectory();
    } else {
      showMessage("error", result.message);
    }
  } catch (error) {
    showMessage("error", error.message || t("mount.rename.failed"));
  } finally {
    isDirectoryListRenaming.value = false;
    // 关闭 DirectoryList 的重命名对话框
    directoryListRef.value?.closeRenameDialog();
  }
};

/**
 * 处理项目选择
 */
const handleItemSelect = (item, selected) => {
  selectItem(item, selected);
};

// handleItemDelete方法在原始文件中不存在，已删除（使用handleDelete代替）

/**
 * 处理批量删除
 */
const batchDelete = () => {
  const selectedFiles = getSelectedItems();

  if (selectedFiles.length === 0) {
    showMessage("warning", t("mount.messages.noItemsSelected"));
    return;
  }
  if (selectedFiles.some((item) => isItemProcessing(item))) {
    warnProcessingOperation();
    return;
  }

  itemsToDelete.value = selectedFiles;
  showDeleteDialog.value = true;
};

/**
 * 取消删除
 */
const cancelDelete = () => {
  // 删除过程中不允许取消
  if (isDeleting.value) return;

  // 清理删除状态
  itemsToDelete.value = [];
};

/**
 * 确认删除
 */
const confirmDelete = async () => {
  if (itemsToDelete.value.length === 0 || isDeleting.value) return;

  isDeleting.value = true;

  try {
    // 使用fileOperations删除项目
    const result = await fileOperations.batchDeleteItems(itemsToDelete.value);

    if (result.success) {
      if (result.jobId) {
        const affectedPaths = itemsToDelete.value.map((item) => item?.path).filter(Boolean);
        const taskId = taskManager.addTask(TaskType.DELETE, t("mount.taskManager.deleteTask"), affectedPaths.length || 1);
        taskManager.updateTaskProgress(taskId, 0, {
          jobId: result.jobId,
          total: affectedPaths.length,
          processed: 0,
          affectedPaths,
        });

        showMessage("success", result.message || "删除作业已创建");
        if (itemsToDelete.value.length > 1) {
          clearSelection();
        }
        showDeleteDialog.value = false;
        itemsToDelete.value = [];
        openTasksModal();
        return;
      }

      showMessage(result.status === "partial" ? "warning" : "success", result.message);

      // 删除属于写操作：清空前端缓存（秒开快照 + 可验证缓存），强制下一次导航以服务端为准
      invalidateCaches();
      // 立即从当前目录移除（减少等待与闪烁）
      const deletedPaths = Array.isArray(result.deletedPaths)
        ? result.deletedPaths
        : itemsToDelete.value.map((item) => item?.path).filter(Boolean);
      removeItemsFromCurrentDirectory(deletedPaths);

      // 如果是批量删除，清空选择状态
      if (itemsToDelete.value.length > 1) {
        clearSelection();
      }

      // 关闭对话框
      showDeleteDialog.value = false;
      itemsToDelete.value = [];

      // 重新加载当前目录内容
      await refreshDirectory();
    } else {
      showMessage("error", result.message);
    }
  } catch (error) {
    log.error("删除操作失败:", error);
    showMessage("error", error.message || t("mount.messages.deleteFailed", { message: t("common.unknown") }));
  } finally {
    isDeleting.value = false;
  }
};

// 这些方法在原始MountExplorerMain.vue中不存在，已删除

const handleBatchAddToBasket = () => {
  try {
    const selectedFiles = getSelectedItems();
    const result = fileBasket.addSelectedToBasket(selectedFiles, currentPath.value);

    if (result.success) {
      showMessage("success", result.message);
      // 可选：关闭勾选模式
      // toggleCheckboxMode(false);
    } else {
      showMessage("error", result.message);
    }
  } catch (error) {
    log.error("批量添加到文件篮失败:", error);
    showMessage("error", t("fileBasket.messages.batchAddFailed"));
  }
};

// 弹窗相关方法
const handleOpenUploadModal = () => {
  openUploadModal();
};

const handleCloseUploadModal = () => {
  closeUploadModal();
};

const handleUploadSuccess = async (payload) => {
  const count = Number(payload?.count || 0);
  const skippedUploadCount = Number(payload?.skippedUploadCount || 0);

  if (skippedUploadCount > 0) {
    showMessage("success", t("mount.messages.uploadSuccessWithSkipped", { count, skipped: skippedUploadCount }));
  } else if (count > 1) {
    // 兼容：多文件时给更明确的提示
    showMessage("success", t("mount.messages.uploadSuccessWithCount", { count }));
  } else {
    showMessage("success", t("mount.messages.uploadSuccess"));
  }
  invalidateCaches();
  await refreshDirectory();
};

const handleUploadError = (error) => {
  log.error("上传失败:", error);
  showMessage("error", error.message || t("mount.messages.uploadFailed"));
};

const handleBatchCopy = () => {
  if (selectedItems.value.length === 0) {
    showMessage("warning", t("mount.messages.noItemsSelected"));
    return;
  }
  openCopyModal();
};

const handleCloseCopyModal = () => {
  closeCopyModal();
  // 清理右键菜单复制项目
  contextMenuCopyItems.value = [];
};

const handleCopyStarted = (event) => {
  // 显示复制开始消息
  const message =
    event?.message ||
    t("mount.taskManager.copyStarted", {
      count: event?.itemCount || 0,
      path: event?.targetPath || "",
    });
  showMessage("success", message);
  clearSelection();
};

const handleBatchMove = () => {
  if (selectedItems.value.length === 0) {
    showMessage("warning", t("mount.messages.noItemsSelected"));
    return;
  }
  if (hasProcessingSelection()) {
    warnProcessingOperation();
    return;
  }
  isMoveModalOpen.value = true;
};

const handleCloseMoveModal = () => {
  isMoveModalOpen.value = false;
  contextMenuMoveItems.value = [];
};

const handleMoveStarted = (event) => {
  const message =
    event?.message ||
    t("mount.taskManager.moveStarted", {
      count: event?.itemCount || 0,
      path: event?.targetPath || "",
    });
  showMessage("success", message);
  clearSelection();
};

const handleOpenTasksModal = () => {
  openTasksModal();
};

const handleCloseTasksModal = () => {
  closeTasksModal();
};

/**
 * 处理任务完成事件 - 自动刷新当前目录
 */
const handleTaskCompleted = async (event) => {
  // 延迟一小段时间再刷新，确保后端数据已同步
  setTimeout(async () => {
    try {
      invalidateCaches();
      await refreshDirectory();
      showMessage('success', t('mount.taskManager.taskCompletedRefresh'));
    } catch (error) {
      log.error('[MountExplorer] 刷新目录失败:', error);
    }
  }, 500);
};

/**
 * 处理任务创建事件
 */
const handleTaskCreated = (taskInfo) => {
  // 可以在这里添加额外的任务跟踪逻辑
  // 例如：打开任务管理器面板
  // openTasksModal();
};

const handleShowMessage = (messageInfo) => {
  showMessage(messageInfo.type, messageInfo.message);
};

// 用于存储清除高亮的函数引用，以便在下次右键时先移除旧监听器
let clearHighlightHandler = null;
let stopClearHighlightListener = null;

// 处理右键菜单事件
// 1. 单文件右键：只临时高亮显示当前文件
// 2. 有选中项时右键：操作已选中的项目
const handleFileContextMenu = (payload) => {
  if (!contextMenu) return;
  const { event, item, action } = payload;

  // 处理特殊操作（不需要 item 的操作）
  if (action) {
    switch (action) {
      case 'copy':
        // 复制操作：使用 payload.items
        if (payload.items && payload.items.length > 0) {
          contextMenuCopyItems.value = payload.items;
          openCopyModal();
        }
        return;
      
      case 'add-to-basket':
        // 添加到文件篮操作：使用 payload.items
        if (payload.items && payload.items.length > 0) {
          const result = fileBasket.addSelectedToBasket(payload.items, currentPath.value);
          if (result.success) {
            showMessage("success", result.message);
          } else {
            showMessage("error", result.message);
          }
        }
        return;
      
      case 'toggle-checkboxes':
        // 切换勾选框显示
        explorerSettings.toggleShowCheckboxes();
        return;
    }
  }

  // 常规右键菜单处理（需要 item）
  if (!item) return;

  // 先移除之前的监听器（如果存在）
  if (typeof stopClearHighlightListener === "function") {
    stopClearHighlightListener();
    stopClearHighlightListener = null;
  }
  clearHighlightHandler = null;

  // 获取当前已选中的项目
  const selectedFiles = getSelectedItems();
  const isItemSelected = selectedFiles.some((i) => i.path === item.path);

  let itemsForMenu;

  if (selectedFiles.length > 0) {
    // 有选中项时：
    // - 如果右键的项目已在选中列表中，操作所有选中项目
    // - 如果右键的项目不在选中列表中，只操作当前项目（不改变选中状态）
    if (isItemSelected) {
      itemsForMenu = selectedFiles;
      // 已选中的项目不需要临时高亮
      contextHighlightPath.value = null;
    } else {
      itemsForMenu = [item];
      // 设置临时高亮
      contextHighlightPath.value = item.path;
    }
  } else {
    // 无选中项：只操作当前右键的项目，设置临时高亮
    itemsForMenu = [item];
    contextHighlightPath.value = item.path;
  }

  // 显示右键菜单（传递当前勾选框显示状态）
  contextMenu.showContextMenu(event, item, itemsForMenu, darkMode.value, explorerSettings.settings.showCheckboxes);

  // 创建清除高亮的处理函数
  // 只监听 click 事件（左键点击关闭菜单时清除高亮）
  // 不监听 contextmenu 事件，因为下次右键会直接设置新的高亮
  clearHighlightHandler = () => {
    contextHighlightPath.value = null;
    if (typeof stopClearHighlightListener === "function") {
      stopClearHighlightListener();
      stopClearHighlightListener = null;
    }
  };

  // 延迟添加监听器，避免当前事件立即触发
  // 使用 ref 存储 timeout ID 以便在组件卸载时清理
  const timeoutId = setTimeout(() => {
    if (clearHighlightHandler) {
      stopClearHighlightListener = useEventListener(document, "click", clearHighlightHandler, { once: true });
    }
  }, 50);
};

// 密码验证事件处理
const handlePasswordVerified = ({ path, token, message }) => {
  // 保存验证 token
  pathPassword.savePathToken(path, token);

  // 显示成功消息
  showMessage("success", message || t("mount.pathPassword.verified"));

  // 关闭弹窗
  pathPassword.closePasswordDialog();
  pathPassword.clearPendingPath();

  // 重新加载当前路由（可能是目录，也可能是文件深链）
  refreshCurrentRoute();
};

const handlePasswordCancel = async () => {
  // 关闭密码弹窗
  pathPassword.closePasswordDialog();
  pathPassword.clearPendingPath();

  // 计算父目录路径
  const currentPathValue = currentPath.value;
  let parentPath = "/";

  if (currentPathValue && currentPathValue !== "/") {
    // 移除末尾的斜杠（如果有）
    const normalized = currentPathValue.replace(/\/+$/, "");
    // 获取最后一个斜杠之前的部分
    const lastSlashIndex = normalized.lastIndexOf("/");
    if (lastSlashIndex > 0) {
      parentPath = normalized.substring(0, lastSlashIndex);
    }
  }

  // 导航到父目录
  await navigateTo(parentPath);
};

const handlePasswordClose = () => {
  pathPassword.closePasswordDialog();
};

const handlePasswordError = ({ message }) => {
  log.error("密码验证错误:", message);
  showMessage("error", message);
};

// 预览相关方法
let lastPreviewLoadedKey = "";
const handlePreviewLoaded = () => {
  // 避免同一个文件在媒体事件重复触发时刷屏
  const f = previewInfo.value || previewFile.value;
  const key = f?.path || f?.name || "";
  if (key && key === lastPreviewLoadedKey) return;
  lastPreviewLoadedKey = key;
};

const handlePreviewError = (error) => {
  log.error("预览加载失败:", error);
  showMessage("error", t("mount.messages.previewError"));
};

const closePreviewWithUrl = async () => {
  if (filePreviewRef.value?.hasUnsavedChanges?.()) {
    showUnsavedPreviewDialog.value = true;
    return;
  }

  await navigateToPreserveHistory(currentPath.value);
};

const closePreviewWithoutUnsavedCheck = async () => {
  showUnsavedPreviewDialog.value = false;
  await navigateToPreserveHistory(currentPath.value);
};

const handleCancelClosePreview = () => {
  if (isSavingPreviewBeforeClose.value) return;
  showUnsavedPreviewDialog.value = false;
};

const handleDiscardAndClosePreview = async () => {
  if (isSavingPreviewBeforeClose.value) return;
  await closePreviewWithoutUnsavedCheck();
};

const handleSaveAndClosePreview = async () => {
  if (isSavingPreviewBeforeClose.value) return;
  isSavingPreviewBeforeClose.value = true;
  try {
    const saved = await filePreviewRef.value?.saveCurrentFile?.();
    if (saved) {
      await closePreviewWithoutUnsavedCheck();
    }
  } finally {
    isSavingPreviewBeforeClose.value = false;
  }
};

const handleRetryDirectory = async () => {
  // 清掉当前错误
  error.value = null;
  await refreshDirectory();
};

const dismissDirectoryError = () => {
  error.value = null;
};

// 预览相关事件处理已在上面定义

// 提供数据给子组件
provide("darkMode", darkMode);
provide("isAdmin", isAdmin);
provide("apiKeyInfo", apiKeyInfo);
provide("hasPermissionForCurrentPath", hasPermissionForCurrentPath);
provide("navigateToFile", navigateToFile);

// 处理认证状态变化
const handleAuthStateChange = (event) => {
  // 权限状态会自动更新，这里只需要记录日志
};

// 全局快捷键处理
const handleGlobalKeydown = (event) => {
  // Ctrl+K 打开搜索
  if ((event.ctrlKey || event.metaKey) && event.key === "k") {
    event.preventDefault();
    if (hasPermission.value && !isSearchModalOpen.value) {
      handleOpenSearchModal();
    }
  }

  // ESC 关闭搜索
  if (event.key === "Escape" && isSearchModalOpen.value) {
    handleCloseSearchModal();
  }
};

// 注册全局事件（自动清理）
useEventListener(window, "auth-state-changed", handleAuthStateChange);
useEventListener(document, "keydown", handleGlobalKeydown);

// 监听目录项目变化，更新选择状态（仅针对可见条目）
watch(
  () => visibleItems.value,
  (newItems) => {
    setAvailableItems(newItems);
  },
  { immediate: true }
);

// 监听路径变化，自动关闭密码弹窗
watch(
  () => currentPath.value,
  (newPath, oldPath) => {
    if (newPath !== oldPath && pathPassword.showPasswordDialog.value) {
      pathPassword.closePasswordDialog();
      pathPassword.clearPendingPath();
    }
  }
);

// 组件卸载时清理资源
onBeforeUnmount(() => {
  // 清理 clearHighlightHandler 事件监听器
  if (typeof stopClearHighlightListener === "function") {
    stopClearHighlightListener();
    stopClearHighlightListener = null;
  }
  clearHighlightHandler = null;

  // 清理 MutationObserver
  explorerSettings.cleanupDarkModeObserver();
  if (processingTaskPollTimer) {
    window.clearInterval(processingTaskPollTimer);
    processingTaskPollTimer = null;
  }

  // 停止预览
  stopPreview();

  // 清理选择状态
  clearSelection();
});
</script>

<style scoped>
/* Smooth View Transitions */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
</style>

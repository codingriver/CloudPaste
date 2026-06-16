<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
        <component :is="headerIcon" class="w-4 h-4" />
        {{ t('admin.tasks.details.itemList') }}
        <span class="text-gray-500 dark:text-gray-400 font-normal">({{ itemResults.length }})</span>
      </h3>
    </div>

    <div class="grid grid-cols-2 gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-3 py-2 text-xs">
      <div>
        <div class="text-gray-500 dark:text-gray-400">路径进度</div>
        <div class="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {{ processedItems }}/{{ totalItems || processedItems }}
        </div>
      </div>
      <div>
        <div class="text-gray-500 dark:text-gray-400">成功/失败/跳过</div>
        <div class="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {{ successCount }}/{{ failedCount }}/{{ skippedCount }}
        </div>
      </div>
    </div>

    <div
      v-if="operationProgress"
      class="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-lg border px-3 py-2 text-xs"
      :class="operationProgressClass"
    >
      <div>
        <div class="text-gray-500 dark:text-gray-400">处理对象</div>
        <div class="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {{ operationProgress.processedObjects }}/{{ operationProgress.totalObjects }}
        </div>
      </div>
      <div>
        <div class="text-gray-500 dark:text-gray-400">当前批次</div>
        <div class="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          第 {{ operationProgress.currentBatch || '--' }} 批
        </div>
      </div>
      <div>
        <div class="text-gray-500 dark:text-gray-400">每批数量</div>
        <div class="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {{ operationProgress.batchSize || '--' }}
        </div>
      </div>
      <div>
        <div class="text-gray-500 dark:text-gray-400">阶段</div>
        <div class="mt-0.5 font-semibold text-gray-900 dark:text-gray-100">
          {{ formatPhase(operationProgress.phase) }}
        </div>
      </div>
    </div>

    <div v-if="itemResults.length > 0" class="space-y-2 max-h-[400px] overflow-y-auto pr-1">
      <div
        v-for="(item, index) in itemResults"
        :key="index"
        class="rounded-lg overflow-hidden bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
      >
        <div
          class="flex items-center gap-3 px-3 py-2.5 text-xs cursor-pointer select-none hover:bg-gray-50/70 dark:hover:bg-gray-700/30"
          @click="toggleExpand(index)"
        >
          <span class="flex-shrink-0">
            <span v-if="item.status === 'success'" class="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center shadow-sm">
              <IconCheck class="w-3 h-3 text-white" />
            </span>
            <span v-else-if="item.status === 'processing'" class="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center shadow-sm">
              <IconRefresh class="w-3 h-3 text-white animate-spin" />
            </span>
            <span v-else-if="item.status === 'failed'" class="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center shadow-sm">
              <IconClose class="w-3 h-3 text-white" />
            </span>
            <span v-else-if="item.status === 'skipped'" class="w-5 h-5 rounded-full bg-yellow-500 flex items-center justify-center shadow-sm">
              <span class="text-white text-xs leading-none">-</span>
            </span>
            <span v-else class="w-5 h-5 rounded-full border-2 flex items-center justify-center border-gray-300 dark:border-gray-500 bg-gray-100 dark:bg-gray-700">
              <span class="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500"></span>
            </span>
          </span>

          <span class="flex-1 min-w-0">
            <span class="block truncate font-medium text-gray-800 dark:text-gray-100" :title="displayPath(item)">
              {{ extractNameFromPath(displayPath(item)) || displayPath(item) }}
            </span>
            <span class="block truncate font-mono text-gray-500 dark:text-gray-400" :title="displayPath(item)">
              {{ displayPath(item) }}
            </span>
          </span>

          <span
            class="flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-medium"
            :class="getStatusBadgeClass(item.status)"
          >
            {{ getStatusText(item.status) }}
          </span>

          <IconChevronDown
            class="w-4 h-4 flex-shrink-0 text-gray-400 dark:text-gray-500 transition-transform duration-200"
            :class="{ 'rotate-180': expandedItems.has(index) }"
          />
        </div>

        <Transition
          enter-active-class="transition-all duration-200 ease-out"
          enter-from-class="opacity-0 max-h-0"
          enter-to-class="opacity-100 max-h-52"
          leave-active-class="transition-all duration-150 ease-in"
          leave-from-class="opacity-100 max-h-52"
          leave-to-class="opacity-0 max-h-0"
        >
          <div v-if="expandedItems.has(index)" class="overflow-hidden">
            <div class="px-3 pb-2 pt-1 space-y-1.5 border-t border-gray-100 dark:border-gray-700/50">
              <div class="flex items-start gap-2 text-xs">
                <span class="flex-shrink-0 text-gray-500 dark:text-gray-400">{{ t('admin.tasks.details.sourcePath') }}:</span>
                <span class="font-mono text-gray-700 dark:text-gray-300 break-all select-text">{{ item.sourcePath || item.label || '-' }}</span>
              </div>
              <div v-if="item.targetPath" class="flex items-start gap-2 text-xs">
                <span class="flex-shrink-0 text-gray-500 dark:text-gray-400">{{ t('admin.tasks.details.targetPath') }}:</span>
                <span class="font-mono text-gray-700 dark:text-gray-300 break-all select-text">{{ item.targetPath }}</span>
              </div>
              <div v-if="getDetails(item)" class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-xs">
                <div class="rounded bg-gray-50 dark:bg-gray-900 px-2 py-1">
                  <span class="text-gray-500 dark:text-gray-400">对象</span>
                  <span class="ml-1 font-mono text-gray-800 dark:text-gray-100">
                    {{ getDetails(item).processed || 0 }}/{{ getDetails(item).totalObjects || getDetails(item).processed || 0 }}
                  </span>
                </div>
                <div class="rounded bg-gray-50 dark:bg-gray-900 px-2 py-1">
                  <span class="text-gray-500 dark:text-gray-400">成功</span>
                  <span class="ml-1 font-mono text-gray-800 dark:text-gray-100">{{ getDetails(item).success || 0 }}</span>
                </div>
                <div class="rounded bg-gray-50 dark:bg-gray-900 px-2 py-1">
                  <span class="text-gray-500 dark:text-gray-400">失败</span>
                  <span class="ml-1 font-mono text-gray-800 dark:text-gray-100">{{ getDetails(item).failed || 0 }}</span>
                </div>
                <div class="rounded bg-gray-50 dark:bg-gray-900 px-2 py-1">
                  <span class="text-gray-500 dark:text-gray-400">跳过</span>
                  <span class="ml-1 font-mono text-gray-800 dark:text-gray-100">{{ getDetails(item).skipped || 0 }}</span>
                </div>
              </div>
            </div>
          </div>
        </Transition>

        <div v-if="item.error" class="px-3 pb-2">
          <div class="flex items-start gap-1.5 px-2 py-1.5 rounded text-xs bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300">
            <IconExclamation class="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span class="break-words">{{ item.error }}</span>
          </div>
        </div>
        <div v-else-if="item.message" class="px-3 pb-2">
          <div class="px-2 py-1.5 rounded text-xs bg-gray-50 dark:bg-gray-900 text-gray-600 dark:text-gray-300">
            {{ item.message }}
          </div>
        </div>
      </div>
    </div>

    <div v-else class="text-center py-8 text-gray-500 dark:text-gray-400 text-sm">
      <component :is="headerIcon" class="w-8 h-8 mx-auto mb-2 opacity-50" />
      <p>{{ t('admin.tasks.details.noFiles') }}</p>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  IconCheck,
  IconClose,
  IconRefresh,
  IconChevronDown,
  IconExclamation,
  IconSync,
  IconTrash
} from '@/components/icons'

const props = defineProps({
  task: {
    type: Object,
    required: true
  }
})

const { t } = useI18n()
const expandedItems = ref(new Set())

const itemResults = computed(() => props.task.stats?.itemResults || [])
const stats = computed(() => props.task.stats || {})
const isDeleteTask = computed(() => props.task.taskType === 'delete')
const headerIcon = computed(() => isDeleteTask.value ? IconTrash : IconSync)
const totalItems = computed(() => Number(stats.value.totalItems || 0))
const processedItems = computed(() => Number(stats.value.processedItems || 0))
const successCount = computed(() => Number(stats.value.successCount || 0))
const failedCount = computed(() => Number(stats.value.failedCount || 0))
const skippedCount = computed(() => Number(stats.value.skippedCount || 0))

const operationProgress = computed(() => {
  const progress = stats.value.operationProgress
  if (!['directory_delete', 'directory_move'].includes(progress?.mode)) return null
  return progress
})

const operationProgressClass = computed(() => {
  if (isDeleteTask.value) {
    return 'border-red-100 dark:border-red-900/40 bg-red-50/60 dark:bg-red-950/20'
  }
  return 'border-cyan-100 dark:border-cyan-900/40 bg-cyan-50/60 dark:bg-cyan-950/20'
})

const toggleExpand = (index) => {
  if (expandedItems.value.has(index)) {
    expandedItems.value.delete(index)
  } else {
    expandedItems.value.add(index)
  }
}

const displayPath = (item) => item?.sourcePath || item?.targetPath || item?.label || ''

const extractNameFromPath = (path) => {
  if (!path || typeof path !== 'string') return ''
  return path.replace(/\/+$/, '').split('/').filter(Boolean).pop() || ''
}

const getDetails = (item) => item?.meta?.deleteDetails || item?.meta?.moveDetails || item?.meta?.moveDeleteDetails || null

const formatPhase = (phase) => {
  const phaseMap = {
    copy: '复制',
    delete: '删除',
    move: '移动',
  }
  return phaseMap[phase] || phase || '-'
}

const getStatusBadgeClass = (status) => {
  const classes = {
    success: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    processing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    retrying: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    skipped: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
    pending: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
  }
  return classes[status] || classes.pending
}

const getStatusText = (status) => {
  const textMap = {
    success: t('admin.tasks.fileStatus.success'),
    processing: t('admin.tasks.fileStatus.processing'),
    retrying: t('admin.tasks.fileStatus.retrying'),
    failed: t('admin.tasks.fileStatus.failed'),
    skipped: t('admin.tasks.fileStatus.skipped'),
    pending: t('admin.tasks.fileStatus.pending')
  }
  return textMap[status] || status
}
</script>

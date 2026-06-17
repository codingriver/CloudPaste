<template>
  <!-- 模式1: 已知总数 - 百分比进度条 -->
  <div v-if="hasKnownTotal" class="w-24 flex flex-col gap-1">
    <div class="flex justify-between text-[10px] text-gray-500 dark:text-gray-400">
      <span>{{ progressPercent }}%</span>
      <span v-if="task.status === 'running'" class="animate-pulse text-blue-500 dark:text-blue-400">...</span>
    </div>
    <div class="flex h-1.5 w-full rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700">
      <div
        :style="{ width: `${successPercent}%` }"
        class="bg-emerald-500 dark:bg-emerald-600 transition-all duration-300"
      />
      <div
        :style="{ width: `${skippedPercent}%` }"
        class="bg-amber-400 dark:bg-amber-500 transition-all duration-300"
      />
      <div
        :style="{ width: `${failedPercent}%` }"
        class="bg-red-500 dark:bg-red-600 transition-all duration-300"
      />
    </div>
  </div>

  <!-- 模式2: 动态任务 - 迷你进度条 -->
  <div v-else-if="hasDynamicStats" class="w-24 flex flex-col gap-1">
    <div class="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400">
      <span v-if="dynamicDisplayCount > 0">{{ t('admin.tasks.progress.items', { count: dynamicDisplayCount }) }}</span>
      <span v-if="task.status === 'running'" class="animate-pulse text-blue-500 dark:text-blue-400">...</span>
    </div>
    <!-- 迷你分段进度条（基于成功/失败/跳过比例） -->
    <div v-if="dynamicTotal > 0" class="flex h-1 w-full rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700">
      <div
        :style="{ width: `${dynamicSuccessPercent}%` }"
        class="bg-emerald-500 dark:bg-emerald-600 transition-all duration-300"
      />
      <div
        :style="{ width: `${dynamicSkippedPercent}%` }"
        class="bg-amber-400 dark:bg-amber-500 transition-all duration-300"
      />
      <div
        :style="{ width: `${dynamicFailedPercent}%` }"
        class="bg-red-500 dark:bg-red-600 transition-all duration-300"
      />
    </div>
    <!-- 运行中但无结果时显示不确定进度条 -->
    <div v-else-if="task.status === 'running'" class="h-1 w-full rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700">
      <div class="h-full w-1/3 bg-blue-500 dark:bg-blue-400 rounded-full animate-indeterminate" />
    </div>
  </div>

  <!-- 模式3: 无统计数据 -->
  <div v-else class="text-xs text-gray-400 dark:text-gray-500">{{ t('admin.tasks.progress.empty') }}</div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { getItemResults, getObjectProgress, getPathProgress } from '@/modules/admin/utils/taskProgress'

const props = defineProps({
  task: {
    type: Object,
    required: true
  }
})

const { t } = useI18n()

const itemResults = computed(() => {
  return getItemResults(props.task)
})

const isBatchPathMode = computed(() => {
  return ['delete', 'move'].includes(props.task.taskType) && itemResults.value.length > 1
})

const pathStatusCounts = computed(() => {
  return getPathProgress(props.task)
})

const objectProgress = computed(() => getObjectProgress(props.task))

const directoryProgress = computed(() => {
  if (isBatchPathMode.value) return null

  const operation = props.task.stats?.operationProgress
  if (['directory_copy', 'directory_delete', 'directory_move'].includes(operation?.mode)) {
    return operation
  }

  const direct = props.task.stats?.directoryProgress
  if (direct?.mode === 'directory_copy') return direct

  const firstDetails = props.task.stats?.itemResults?.find((item) => (
    item?.meta?.copyDetails || item?.meta?.deleteDetails || item?.meta?.moveDetails
  ))
  const details = firstDetails?.meta?.copyDetails || firstDetails?.meta?.deleteDetails || firstDetails?.meta?.moveDetails
  if (!details) return null

  const processedObjects = Number(details.processed || details.processedObjects || 0)
  const totalObjects = Number(details.totalObjects || processedObjects || 0)
  if (processedObjects <= 0 && totalObjects <= 0) return null

  return {
    processedObjects,
    totalObjects,
    successObjects: Number(details.success || details.successObjects || 0),
    failedObjects: Number(details.failed || details.failedObjects || 0),
    skippedObjects: Number(details.skipped || details.skippedObjects || 0),
    dedupedObjects: Number(details.deduped || details.dedupedObjects || 0),
  }
})

// 已知总数模式：目录内部对象总数优先，其次才是顶层任务项总数
const hasKnownTotal = computed(() => {
  return total.value > 0
})

// 动态模式：没有总数但有处理统计或 itemResults
const hasDynamicStats = computed(() => {
  if (hasKnownTotal.value) return false
  const stats = props.task.stats
  if (!stats) return false
  return (
    stats.successCount > 0 ||
    stats.failedCount > 0 ||
    stats.skippedCount > 0 ||
    stats.processedItems > 0 ||
    (Array.isArray(stats.itemResults) && stats.itemResults.length > 0)
  )
})

// 基础统计
const total = computed(() => {
  if (objectProgress.value.knownTotal) return objectProgress.value.total
  if (isBatchPathMode.value) return pathStatusCounts.value.total
  return directoryProgress.value?.totalObjects || props.task.stats?.totalItems || 0
})
const processed = computed(() => {
  if (objectProgress.value.knownTotal) return objectProgress.value.processed
  if (isBatchPathMode.value) return pathStatusCounts.value.processed
  return directoryProgress.value?.processedObjects || props.task.stats?.processedItems || 0
})
const success = computed(() => {
  if (objectProgress.value.knownTotal) return objectProgress.value.success + objectProgress.value.deduped
  if (isBatchPathMode.value) return pathStatusCounts.value.success
  return directoryProgress.value?.successObjects || props.task.stats?.successCount || 0
})
const failed = computed(() => {
  if (objectProgress.value.knownTotal) return objectProgress.value.failed
  if (isBatchPathMode.value) return pathStatusCounts.value.failed
  return directoryProgress.value?.failedObjects || props.task.stats?.failedCount || 0
})
const skipped = computed(() => {
  if (objectProgress.value.knownTotal) return objectProgress.value.skipped
  if (isBatchPathMode.value) return pathStatusCounts.value.skipped
  return directoryProgress.value?.skippedObjects || props.task.stats?.skippedCount || 0
})
const itemResultsCount = computed(() => {
  return itemResults.value.length
})

// 已知总数模式的百分比计算
const progressPercent = computed(() => {
  if (total.value === 0) return 0
  return Math.min(100, Math.round((processed.value / total.value) * 100))
})

const successPercent = computed(() => {
  if (total.value === 0) return 0
  return Math.min(100, (success.value / total.value) * 100)
})

const skippedPercent = computed(() => {
  if (total.value === 0) return 0
  return Math.min(100, (skipped.value / total.value) * 100)
})

const failedPercent = computed(() => {
  if (total.value === 0) return 0
  return Math.min(100, (failed.value / total.value) * 100)
})

// 动态模式的百分比计算（基于 processedItems 或 successCount+failedCount+skippedCount）
const dynamicTotal = computed(() => {
  if (processed.value > 0) return processed.value
  const sum = success.value + failed.value + skipped.value
  return sum > 0 ? sum : 0
})

const dynamicDisplayCount = computed(() => {
  if (processed.value > 0) return processed.value
  if (itemResultsCount.value > 0) return itemResultsCount.value
  return 0
})

const dynamicSuccessPercent = computed(() => {
  if (dynamicTotal.value === 0) return 0
  return (success.value / dynamicTotal.value) * 100
})

const dynamicSkippedPercent = computed(() => {
  if (dynamicTotal.value === 0) return 0
  return (skipped.value / dynamicTotal.value) * 100
})

const dynamicFailedPercent = computed(() => {
  if (dynamicTotal.value === 0) return 0
  return (failed.value / dynamicTotal.value) * 100
})
</script>

<style scoped>
@keyframes indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(400%);
  }
}

.animate-indeterminate {
  animation: indeterminate 1.5s ease-in-out infinite;
}
</style>

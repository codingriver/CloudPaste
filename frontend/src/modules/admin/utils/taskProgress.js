const TERMINAL_STATUSES = new Set(['success', 'failed', 'skipped'])

export const getItemResults = (taskOrStats) => {
  const stats = taskOrStats?.stats || taskOrStats || {}
  return Array.isArray(stats.itemResults) ? stats.itemResults : []
}

export const isTerminalStatus = (status) => TERMINAL_STATUSES.has(status)

export const getPathProgress = (taskOrStats) => {
  const items = getItemResults(taskOrStats)
  const result = { total: items.length, processed: 0, success: 0, failed: 0, skipped: 0 }

  for (const item of items) {
    if (item?.status === 'success') {
      result.success += 1
      result.processed += 1
    } else if (item?.status === 'failed') {
      result.failed += 1
      result.processed += 1
    } else if (item?.status === 'skipped') {
      result.skipped += 1
      result.processed += 1
    }
  }

  return result
}

const numeric = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const isDirectoryPath = (path) => typeof path === 'string' && path.endsWith('/')

export const getItemOperationDetails = (item) => {
  const meta = item?.meta || {}
  if (meta.moveDeleteDetails) return meta.moveDeleteDetails
  return meta.copyDetails || meta.deleteDetails || meta.moveDetails || null
}

export const getObjectProgress = (taskOrStats) => {
  const items = getItemResults(taskOrStats)
  const result = {
    total: 0,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    deduped: 0,
    knownTotal: false,
  }

  for (const item of items) {
    const details = getItemOperationDetails(item)
    if (details) {
      const processed = numeric(details.processed ?? details.processedObjects)
      const total = Math.max(numeric(details.totalObjects), processed)
      result.total += total
      result.processed += processed
      result.success += numeric(details.success ?? details.successObjects)
      result.failed += numeric(details.failed ?? details.failedObjects)
      result.skipped += numeric(details.skipped ?? details.skippedObjects)
      result.deduped += numeric(details.deduped ?? details.dedupedObjects)
      result.knownTotal = result.knownTotal || total > 0
      continue
    }

    const path = item?.sourcePath || item?.targetPath || item?.label || ''
    if (isDirectoryPath(path)) {
      continue
    }

    result.total += 1
    result.knownTotal = true
    if (item?.status === 'success') {
      result.processed += 1
      result.success += 1
    } else if (item?.status === 'failed') {
      result.processed += 1
      result.failed += 1
    } else if (item?.status === 'skipped') {
      result.processed += 1
      result.skipped += 1
    }
  }

  return result
}

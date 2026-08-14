const path = require('node:path')

const {
  DEFAULT_DISK_CACHE_TTL_MS,
  parseBooleanEnv,
  parsePositiveIntEnv,
  summarizeCacheDirectory,
  clearCacheDirectory
} = require('../coverage_history_cache')

function resolveHistoryCacheDir() {
  return path.resolve(
    __dirname,
    '..',
    process.env.COVERAGE_HISTORY_DISK_CACHE_DIR || '.cache/coverage-history'
  )
}

function resolvePurchaseCacheDir() {
  return path.resolve(
    __dirname,
    '..',
    process.env.COVERAGE_PURCHASE_CACHE_DIR || '.cache/coverage-purchase-predictions'
  )
}

function renderStats(label, summary) {
  const historyStats = summary.stats && typeof summary.stats === 'object'
    ? summary.stats
    : {}
  const hits = Object.values(historyStats).reduce((sum, item) => sum + Number(item?.hits || 0), 0)
  const misses = Object.values(historyStats).reduce((sum, item) => sum + Number(item?.misses || 0), 0)
  const joined = Object.values(historyStats).reduce((sum, item) => sum + Number(item?.join_inflight || 0), 0)

  console.log(`${label}`)
  console.log(`files=${summary.files}`)
  console.log(`total_size_bytes=${summary.totalSizeBytes}`)
  console.log(`oldest_entry=${summary.oldestEntryIso || 'none'}`)
  console.log(`newest_entry=${summary.newestEntryIso || 'none'}`)
  console.log(`hits=${hits}`)
  console.log(`misses=${misses}`)
  console.log(`join_inflight=${joined}`)
}

function runCommand(cacheName, action) {
  const config = cacheName === 'purchase'
    ? {
        dir: resolvePurchaseCacheDir(),
        label: 'coverage-purchase-cache'
      }
    : {
        dir: resolveHistoryCacheDir(),
        label: 'coverage-history-cache'
      }

  if (action === 'clear') {
    const result = clearCacheDirectory(config.dir)
    console.log(`${config.label}`)
    console.log(`removed=${result.removed}`)
    console.log(`directory=${result.directory}`)
    return
  }

  const summary = summarizeCacheDirectory(config.dir)
  renderStats(config.label, summary)
}

if (require.main === module) {
  const cacheName = String(process.argv[2] || '').trim().toLowerCase()
  const action = String(process.argv[3] || 'stats').trim().toLowerCase()

  if (!['history', 'purchase'].includes(cacheName) || !['stats', 'clear'].includes(action)) {
    console.error('Usage: node scripts/coverage_cache_cli.cjs <history|purchase> <stats|clear>')
    process.exit(1)
  }

  runCommand(cacheName, action)
}

module.exports = {
  DEFAULT_DISK_CACHE_TTL_MS,
  clearCacheDirectory,
  parseBooleanEnv,
  parsePositiveIntEnv,
  resolveHistoryCacheDir,
  resolvePurchaseCacheDir,
  runCommand,
  summarizeCacheDirectory
}

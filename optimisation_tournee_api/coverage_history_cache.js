const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { normalizeClientId } = require('./client_identity')

const DEFAULT_COVERAGE_HISTORY_WINDOW_DAYS = 1095
const DEFAULT_COVERAGE_HISTORY_CACHE_TTL_MS = 30 * 60 * 1000
const DEFAULT_COVERAGE_HISTORY_CACHE_MAX_ENTRIES = 8
const DEFAULT_DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }

  return JSON.stringify(value)
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}

function normalizeDateCacheKey(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString().slice(0, 10)
}

function normalizeStringList(values = []) {
  if (!Array.isArray(values)) return []

  return [...new Set(
    values
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )].sort()
}

function normalizeFilterValue(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeFilterValue(item)).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)))
  }

  if (value && typeof value === 'object') {
    const normalized = {}
    Object.keys(value).sort().forEach(key => {
      normalized[key] = normalizeFilterValue(value[key])
    })
    return normalized
  }

  return value
}

function hashCoverageClientIds(activeClientIds = []) {
  const normalizedClientIds = [...new Set(
    (Array.isArray(activeClientIds) ? activeClientIds : [])
      .map(value => normalizeClientId(value))
      .filter(Boolean)
  )].sort()

  return sha256Hex(normalizedClientIds.join('|'))
}

function hashExactStringList(values = []) {
  return sha256Hex(normalizeStringList(values).join('|'))
}

function serializeForCache(value) {
  if (value instanceof Map) {
    return {
      __cache_type: 'Map',
      entries: [...value.entries()].map(([key, entryValue]) => [
        serializeForCache(key),
        serializeForCache(entryValue)
      ])
    }
  }

  if (value instanceof Set) {
    return {
      __cache_type: 'Set',
      values: [...value.values()].map(item => serializeForCache(item))
    }
  }

  if (value instanceof Date) {
    return {
      __cache_type: 'Date',
      value: value.toISOString()
    }
  }

  if (Array.isArray(value)) {
    return value.map(item => serializeForCache(item))
  }

  if (value && typeof value === 'object') {
    const output = {}
    Object.keys(value).forEach(key => {
      output[key] = serializeForCache(value[key])
    })
    return output
  }

  return value
}

function deserializeFromCache(value) {
  if (Array.isArray(value)) {
    return value.map(item => deserializeFromCache(item))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  if (value.__cache_type === 'Map') {
    return new Map(
      (Array.isArray(value.entries) ? value.entries : []).map(entry => [
        deserializeFromCache(entry?.[0]),
        deserializeFromCache(entry?.[1])
      ])
    )
  }

  if (value.__cache_type === 'Set') {
    return new Set(
      (Array.isArray(value.values) ? value.values : []).map(item => deserializeFromCache(item))
    )
  }

  if (value.__cache_type === 'Date') {
    return new Date(value.value)
  }

  const output = {}
  Object.keys(value).forEach(key => {
    output[key] = deserializeFromCache(value[key])
  })
  return output
}

function deepCloneCacheValue(value) {
  return deserializeFromCache(serializeForCache(value))
}

function computeSourceFingerprint(filePaths = [], extraValues = []) {
  const normalizedPaths = normalizeStringList(filePaths)
  const parts = []

  normalizedPaths.forEach(filePath => {
    try {
      const absolutePath = path.resolve(filePath)
      const stats = fs.statSync(absolutePath)
      const content = fs.readFileSync(absolutePath)
      parts.push(`${absolutePath}:${stats.size}:${stats.mtimeMs}:${sha256Hex(content)}`)
    } catch (error) {
      parts.push(`${String(filePath)}:missing`)
    }
  })

  normalizeStringList(extraValues).forEach(value => {
    parts.push(`extra:${value}`)
  })

  return sha256Hex(parts.join('|'))
}

function buildCoverageHistoryCacheKeyParts({
  name,
  startDate,
  historyWindowDays = DEFAULT_COVERAGE_HISTORY_WINDOW_DAYS,
  commercialCodes = [],
  documentFilters = {},
  activeClientIds = null,
  exactClientCodes = null,
  database = '',
  logicalSchemaVersion = '',
  sqlVersion = '',
  codeVersion = '',
  dataVersion = '',
  predictionDate = '',
  predictionParams = null,
  modelVersion = '',
  datasetCutoff = '',
  scoreVersion = '',
  extraContext = null
} = {}) {
  const payload = {
    name: String(name || '').trim(),
    start_date: normalizeDateCacheKey(startDate),
    history_window_days: Math.max(1, Number.parseInt(historyWindowDays, 10) || DEFAULT_COVERAGE_HISTORY_WINDOW_DAYS),
    commercials: normalizeStringList(commercialCodes),
    document_filters: normalizeFilterValue(documentFilters || {}),
    database: String(database || '').trim(),
    logical_schema_version: String(logicalSchemaVersion || '').trim(),
    sql_version: String(sqlVersion || '').trim(),
    code_version: String(codeVersion || '').trim(),
    data_version: String(dataVersion || '').trim(),
    prediction_date: normalizeDateCacheKey(predictionDate),
    prediction_params: normalizeFilterValue(predictionParams || {}),
    model_version: String(modelVersion || '').trim(),
    dataset_cutoff: String(datasetCutoff || '').trim(),
    score_version: String(scoreVersion || '').trim(),
    extra_context: normalizeFilterValue(extraContext || {})
  }

  if (Array.isArray(activeClientIds)) {
    payload.active_client_ids_sha256 = hashCoverageClientIds(activeClientIds)
  }

  if (Array.isArray(exactClientCodes)) {
    payload.exact_client_codes_sha256 = hashExactStringList(exactClientCodes)
  }

  return payload
}

function buildCoverageHistoryCacheKey(options = {}) {
  return stableStringify(buildCoverageHistoryCacheKeyParts(options))
}

function parseBooleanEnv(rawValue, defaultValue = false) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return defaultValue
  }

  const normalized = String(rawValue).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return defaultValue
}

function parsePositiveIntEnv(rawValue, defaultValue) {
  const parsed = Number.parseInt(rawValue, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue
}

function createCoverageHistoryCacheMetrics() {
  return {
    hits: 0,
    misses: 0,
    buildMs: 0
  }
}

function recordCoverageHistoryCacheMetrics(metrics, status, buildMs = 0) {
  if (!metrics || typeof metrics !== 'object') return

  if (['hit_memory', 'hit_disk', 'join_inflight'].includes(status)) {
    metrics.hits = Number(metrics.hits || 0) + 1
    return
  }

  if (status === 'miss') {
    metrics.misses = Number(metrics.misses || 0) + 1
    metrics.buildMs = Number(metrics.buildMs || 0) + Math.max(0, Number(buildMs || 0))
  }
}

function ensureDirectorySync(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true })
}

function readJsonFileSafe(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(text)
}

function writeJsonAtomic(filePath, value) {
  ensureDirectorySync(path.dirname(filePath))
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const payload = JSON.stringify(value)
  const fileDescriptor = fs.openSync(tempFilePath, 'w')

  try {
    fs.writeFileSync(fileDescriptor, payload, 'utf8')
    fs.fsyncSync(fileDescriptor)
  } finally {
    fs.closeSync(fileDescriptor)
  }

  fs.renameSync(tempFilePath, filePath)
}

function readCacheStatsFile(statsFilePath) {
  try {
    const stats = readJsonFileSafe(statsFilePath)
    return stats && typeof stats === 'object'
      ? stats
      : {}
  } catch (error) {
    return {}
  }
}

function writeCacheStatsFile(statsFilePath, nextStats) {
  try {
    writeJsonAtomic(statsFilePath, nextStats)
  } catch (error) {
    return
  }
}

function updatePersistentCacheStats(cacheDir, type, status) {
  if (!cacheDir || !type) return

  const statsFilePath = path.join(cacheDir, 'stats.json')
  const currentStats = readCacheStatsFile(statsFilePath)
  const typeStats = currentStats[type] && typeof currentStats[type] === 'object'
    ? currentStats[type]
    : {}

  typeStats.hits = Number(typeStats.hits || 0)
  typeStats.misses = Number(typeStats.misses || 0)
  typeStats.join_inflight = Number(typeStats.join_inflight || 0)
  typeStats.last_status = status
  typeStats.updated_at = new Date().toISOString()

  if (status === 'miss') typeStats.misses += 1
  if (status === 'join_inflight') typeStats.join_inflight += 1
  if (status === 'hit_memory' || status === 'hit_disk') typeStats.hits += 1

  currentStats[type] = typeStats
  writeCacheStatsFile(statsFilePath, currentStats)
}

function summarizeCacheDirectory(cacheDir) {
  const directoryPath = path.resolve(cacheDir || '.')
  if (!fs.existsSync(directoryPath)) {
    return {
      directory: directoryPath,
      files: 0,
      totalSizeBytes: 0,
      oldestEntryIso: null,
      newestEntryIso: null,
      stats: {}
    }
  }

  let files = 0
  let totalSizeBytes = 0
  let oldestEntryMs = null
  let newestEntryMs = null

  const stack = [directoryPath]
  while (stack.length) {
    const currentPath = stack.pop()
    const entries = fs.readdirSync(currentPath, { withFileTypes: true })
    entries.forEach(entry => {
      const entryPath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        return
      }

      if (entry.name === 'stats.json') return

      const stats = fs.statSync(entryPath)
      files += 1
      totalSizeBytes += Number(stats.size || 0)
      const timestampMs = Number(stats.mtimeMs || 0)
      oldestEntryMs = oldestEntryMs == null ? timestampMs : Math.min(oldestEntryMs, timestampMs)
      newestEntryMs = newestEntryMs == null ? timestampMs : Math.max(newestEntryMs, timestampMs)
    })
  }

  return {
    directory: directoryPath,
    files,
    totalSizeBytes,
    oldestEntryIso: oldestEntryMs == null ? null : new Date(oldestEntryMs).toISOString(),
    newestEntryIso: newestEntryMs == null ? null : new Date(newestEntryMs).toISOString(),
    stats: readCacheStatsFile(path.join(directoryPath, 'stats.json'))
  }
}

function clearCacheDirectory(cacheDir) {
  const directoryPath = path.resolve(cacheDir || '.')
  if (!fs.existsSync(directoryPath)) {
    return {
      directory: directoryPath,
      removed: 0
    }
  }

  let removed = 0
  const stack = [directoryPath]
  while (stack.length) {
    const currentPath = stack.pop()
    const entries = fs.readdirSync(currentPath, { withFileTypes: true })
    entries.forEach(entry => {
      const entryPath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        return
      }

      fs.unlinkSync(entryPath)
      removed += 1
    })
  }

  return {
    directory: directoryPath,
    removed
  }
}

class CoverageHistoryCache {
  constructor({
    ttlMs = DEFAULT_COVERAGE_HISTORY_CACHE_TTL_MS,
    maxEntries = DEFAULT_COVERAGE_HISTORY_CACHE_MAX_ENTRIES,
    disabled = false,
    logger = null,
    diskEnabled = false,
    diskDir = null
  } = {}) {
    this.ttlMs = Math.max(1, Number.parseInt(ttlMs, 10) || DEFAULT_COVERAGE_HISTORY_CACHE_TTL_MS)
    this.maxEntries = Math.max(1, Number.parseInt(maxEntries, 10) || DEFAULT_COVERAGE_HISTORY_CACHE_MAX_ENTRIES)
    this.disabled = Boolean(disabled)
    this.logger = typeof logger === 'function' ? logger : null
    this.diskEnabled = Boolean(diskEnabled)
    this.diskDir = this.diskEnabled && diskDir
      ? path.resolve(diskDir)
      : null
    this.entries = new Map()
  }

  log(event) {
    if (this.logger) {
      this.logger(event)
    }
  }

  buildKeyHash(key) {
    return sha256Hex(key).slice(0, 16)
  }

  pruneExpired(now = Date.now()) {
    for (const [key, entry] of this.entries.entries()) {
      if (!entry) {
        this.entries.delete(key)
        continue
      }

      if (!entry.pending && Number(entry.expiresAt || 0) <= now) {
        this.entries.delete(key)
      }
    }
  }

  touch(key, entry) {
    if (!this.entries.has(key)) return
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  enforceMaxEntries() {
    if (this.entries.size <= this.maxEntries) return

    for (const [key, entry] of this.entries.entries()) {
      if (this.entries.size <= this.maxEntries) {
        break
      }

      if (entry?.pending) {
        continue
      }

      this.entries.delete(key)
    }
  }

  clearMemory() {
    this.entries.clear()
  }

  getTypeDirectory(type) {
    if (!this.diskDir) return null
    return path.join(this.diskDir, String(type || 'unknown').trim() || 'unknown')
  }

  getEntryFilePath(key, type) {
    const typeDirectory = this.getTypeDirectory(type)
    if (!typeDirectory) return null
    return path.join(typeDirectory, `${sha256Hex(key)}.json`)
  }

  readDiskEntry(key, type, now = Date.now()) {
    if (!this.diskEnabled) return null
    const entryFilePath = this.getEntryFilePath(key, type)
    if (!entryFilePath || !fs.existsSync(entryFilePath)) return null

    try {
      const payload = readJsonFileSafe(entryFilePath)
      const expiresAt = Number(payload?.expiresAt || 0)
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        fs.unlinkSync(entryFilePath)
        return null
      }

      return {
        value: deserializeFromCache(payload.value),
        expiresAt,
        storedAt: Number(payload?.storedAt || 0)
      }
    } catch (error) {
      try {
        fs.unlinkSync(entryFilePath)
      } catch (unlinkError) {
        // Ignore broken cleanup.
      }
      return null
    }
  }

  writeDiskEntry(key, type, value, expiresAt) {
    if (!this.diskEnabled) return
    const entryFilePath = this.getEntryFilePath(key, type)
    if (!entryFilePath) return

    writeJsonAtomic(entryFilePath, {
      keyHash: this.buildKeyHash(key),
      storedAt: Date.now(),
      expiresAt,
      value: serializeForCache(value)
    })
  }

  async getOrCreate({
    key,
    type,
    build,
    metrics = null
  } = {}) {
    if (typeof build !== 'function') {
      throw new TypeError('CoverageHistoryCache requires a build function')
    }

    const keyHash = key ? this.buildKeyHash(key) : ''

    if (!key || this.disabled) {
      const startedAt = Date.now()
      const value = await build()
      const buildMs = Date.now() - startedAt
      recordCoverageHistoryCacheMetrics(metrics, 'miss', buildMs)
      this.log({ type, status: 'miss', key: keyHash, buildMs })
      return deepCloneCacheValue(value)
    }

    const now = Date.now()
    this.pruneExpired(now)

    const existing = this.entries.get(key)
    if (existing?.pending) {
      this.touch(key, existing)
      recordCoverageHistoryCacheMetrics(metrics, 'join_inflight')
      this.log({ type, status: 'join_inflight', key: keyHash })
      updatePersistentCacheStats(this.diskDir, type, 'join_inflight')
      return deepCloneCacheValue(await existing.pending)
    }

    if (existing && Number(existing.expiresAt || 0) > now) {
      this.touch(key, existing)
      const ageMs = Math.max(0, now - Number(existing.storedAt || now))
      recordCoverageHistoryCacheMetrics(metrics, 'hit_memory')
      this.log({ type, status: 'hit_memory', key: keyHash, ageMs })
      updatePersistentCacheStats(this.diskDir, type, 'hit_memory')
      return deepCloneCacheValue(existing.value)
    }

    if (existing) {
      this.entries.delete(key)
    }

    const diskEntry = this.readDiskEntry(key, type, now)
    if (diskEntry) {
      const memoryEntry = {
        value: diskEntry.value,
        expiresAt: diskEntry.expiresAt,
        storedAt: diskEntry.storedAt || now,
        pending: null
      }
      this.entries.set(key, memoryEntry)
      this.touch(key, memoryEntry)
      this.enforceMaxEntries()
      const ageMs = Math.max(0, now - Number(memoryEntry.storedAt || now))
      recordCoverageHistoryCacheMetrics(metrics, 'hit_disk')
      this.log({ type, status: 'hit_disk', key: keyHash, ageMs })
      updatePersistentCacheStats(this.diskDir, type, 'hit_disk')
      return deepCloneCacheValue(memoryEntry.value)
    }

    const entry = {
      value: undefined,
      storedAt: now,
      expiresAt: 0,
      pending: null
    }

    entry.pending = (async () => {
      const startedAt = Date.now()

      try {
        const builtValue = await build()
        entry.value = deepCloneCacheValue(builtValue)
        entry.storedAt = Date.now()
        entry.expiresAt = entry.storedAt + this.ttlMs
        entry.pending = null
        this.touch(key, entry)
        this.enforceMaxEntries()
        this.writeDiskEntry(key, type, entry.value, entry.expiresAt)

        const buildMs = Date.now() - startedAt
        recordCoverageHistoryCacheMetrics(metrics, 'miss', buildMs)
        this.log({ type, status: 'miss', key: keyHash, buildMs })
        updatePersistentCacheStats(this.diskDir, type, 'miss')
        return entry.value
      } catch (error) {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key)
        }
        throw error
      }
    })()

    this.entries.set(key, entry)
    this.enforceMaxEntries()
    return deepCloneCacheValue(await entry.pending)
  }
}

function createCoverageHistoryCache(options = {}) {
  return new CoverageHistoryCache({
    ttlMs: parsePositiveIntEnv(
      process.env.COVERAGE_HISTORY_CACHE_TTL_MS,
      DEFAULT_COVERAGE_HISTORY_CACHE_TTL_MS
    ),
    maxEntries: parsePositiveIntEnv(
      process.env.COVERAGE_HISTORY_CACHE_MAX_ENTRIES,
      DEFAULT_COVERAGE_HISTORY_CACHE_MAX_ENTRIES
    ),
    disabled: parseBooleanEnv(process.env.COVERAGE_HISTORY_CACHE_DISABLED, false),
    diskEnabled: parseBooleanEnv(process.env.COVERAGE_HISTORY_DISK_CACHE_ENABLED, false),
    diskDir: process.env.COVERAGE_HISTORY_DISK_CACHE_DIR || '.cache/coverage-history',
    ...options
  })
}

module.exports = {
  CoverageHistoryCache,
  DEFAULT_COVERAGE_HISTORY_CACHE_MAX_ENTRIES,
  DEFAULT_COVERAGE_HISTORY_CACHE_TTL_MS,
  DEFAULT_COVERAGE_HISTORY_WINDOW_DAYS,
  DEFAULT_DISK_CACHE_TTL_MS,
  buildCoverageHistoryCacheKey,
  buildCoverageHistoryCacheKeyParts,
  clearCacheDirectory,
  computeSourceFingerprint,
  createCoverageHistoryCache,
  createCoverageHistoryCacheMetrics,
  deepCloneCacheValue,
  deserializeFromCache,
  hashCoverageClientIds,
  hashExactStringList,
  parseBooleanEnv,
  parsePositiveIntEnv,
  serializeForCache,
  stableStringify,
  summarizeCacheDirectory
}

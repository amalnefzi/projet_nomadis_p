const crypto = require('node:crypto')
const {
  NEXT_BEST_VISIT_PLAN_CACHE_KEY_VERSION
} = require('./next_best_visit_versions')

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }

  return JSON.stringify(value)
}

function hashBusinessPayload(payload) {
  return crypto
    .createHash('sha1')
    .update(stableStringify(payload))
    .digest('hex')
}

class VersionedMemoryCache {
  constructor({ ttlMs = 300000 } = {}) {
    this.ttlMs = Math.max(1000, Number(ttlMs) || 300000)
    this.entries = new Map()
  }

  get(key) {
    const entry = this.getEntry(key)
    return entry ? entry.value : null
  }

  getEntry(key) {
    const entry = this.entries.get(String(key || ''))
    if (!entry) return null
    if (Number(entry.expiresAt || 0) <= Date.now()) {
      this.entries.delete(String(key || ''))
      return null
    }
    return {
      ...entry
    }
  }

  set(key, value) {
    const now = Date.now()
    this.entries.set(String(key || ''), {
      value,
      createdAt: now,
      expiresAt: now + this.ttlMs
    })
    return value
  }

  size() {
    const keys = [...this.entries.keys()]
    keys.forEach(key => {
      this.getEntry(key)
    })
    return this.entries.size
  }

  clear() {
    this.entries.clear()
  }
}

function buildNextBestVisitPlanCacheKey({
  startDate,
  planningHorizonDays,
  commercialCodes,
  objectiveMode,
  limits,
  profileVersion,
  predictionVersion,
  constraintsVersion
}) {
  return hashBusinessPayload({
    plan_cache_key_version: NEXT_BEST_VISIT_PLAN_CACHE_KEY_VERSION,
    start_date: startDate,
    planning_horizon_days: planningHorizonDays,
    commercial_codes: [...(commercialCodes || [])].sort(),
    objective_mode: objectiveMode,
    limits: limits || {},
    profile_version: profileVersion,
    prediction_version: predictionVersion,
    constraints_version: constraintsVersion
  })
}

function buildNextBestVisitProfileVersion(payload = {}) {
  return hashBusinessPayload(payload)
}

function createNextBestVisitCaches() {
  return {
    cadenceProfiles: new VersionedMemoryCache({ ttlMs: 15 * 60 * 1000 }),
    plans: new VersionedMemoryCache({ ttlMs: 10 * 60 * 1000 })
  }
}

module.exports = {
  buildNextBestVisitPlanCacheKey,
  buildNextBestVisitProfileVersion,
  createNextBestVisitCaches,
  hashBusinessPayload,
  stableStringify,
  VersionedMemoryCache
}

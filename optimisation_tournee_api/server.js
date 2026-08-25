const crypto = require('node:crypto')
const { execFile } = require('child_process')
const path = require('path')
const axios = require('axios')
const express = require('express')
const mysql = require('mysql2')
const cors = require('cors')
const fs = require('fs')
const {
  computeAdjustedTargetMaxVisits,
  resolveCoverageSlotCapacity
} = require('./coverage_capacity_policy')
const {
  CoverageHistoryCache,
  DEFAULT_COVERAGE_HISTORY_WINDOW_DAYS,
  DEFAULT_DISK_CACHE_TTL_MS,
  buildCoverageHistoryCacheKey,
  computeSourceFingerprint,
  createCoverageHistoryCache,
  createCoverageHistoryCacheMetrics,
  hashCoverageClientIds,
  hashExactStringList,
  parseBooleanEnv,
  parsePositiveIntEnv,
  summarizeCacheDirectory,
  clearCacheDirectory
} = require('./coverage_history_cache')
const {
  buildCoverageNonCancelledDocumentSqlCondition,
  resolveCoveragePredictedCa
} = require('./coverage_predicted_ca')
const {
  buildActiveClientIndexes,
  dedupeClientRowsById,
  normalizeClientId,
  normalizeExactClientCode,
  normalizeHistoricalClientCode,
  resolveHistoricalClientMatch
} = require('./client_identity')
const {
  buildCoverageConstraintsDiagnosticResponse,
  loadCoverageConstraints,
  mergeCoverageCommercialConstraintEntries,
  resolveCoverageClientRestriction
} = require('./coverage_constraints_provider')
const {
  buildRecoveryPlanRowsFromProfiles,
  loadRecoveryProfiles
} = require('./coverage_recovery_profiles')
const {
  getPastSalesPlanMessage,
  shouldRejectPastSalesPlanRequest
} = require('./dashboardDateGuard')
const {
  loadCoveragePurchasePredictionProfiles
} = require('./coverage_purchase_prediction_profiles')
const {
  buildCanonicalCoverageFunctionalSnapshot,
  computeStableObjectHash,
  computeCoverageFunctionalResultHash
} = require('./coverage_functional_hash')
const nextBestVisitService = require('./next_best_visit_service')
const {
  clearNextBestVisitModelDependentCaches,
  generateNextBestVisitPlan,
  getNextBestVisitReadiness,
  ensureNextBestVisitProfilesReady
} = nextBestVisitService
const {
  buildPlannedVisitMetadata,
  fetchSalesVisitFeedbackRecords,
  getSalesVisitFeedbackMonitoring,
  getSalesVisitFeedbackMonitoringDetails,
  replacePendingSalesVisitFeedbackForTournee,
  upsertSalesVisitFeedback
} = require('./sales_visit_feedback_service')
const {
  DEFAULT_AUTO_LEARNING_CHECK_INTERVAL_MS,
  DEFAULT_AUTO_LEARNING_STARTUP_DELAY_MS,
  ensureSalesLearningTables,
  startAutomaticSalesLearningCycle,
  getSalesLearningStatus,
  promoteSalesLearningCandidate,
  retrainSalesLearningCandidate,
  rollbackSalesLearningModel
} = require('./sales_learning_candidate_service')
const {
  isV2ValidationLabEnabled,
  registerNextBestVisitValidationLabRoutes
} = require('./next_best_visit_validation_lab_routes')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())

const apiDir = __dirname
const SALES_V2_AUTO_LEARNING_ENABLED = parseBooleanEnv(
  process.env.SALES_V2_LEARNING_AUTO_ENABLED,
  true
)
const SALES_V2_AUTO_LEARNING_CHECK_INTERVAL_MS = parsePositiveIntEnv(
  'SALES_V2_LEARNING_AUTO_CHECK_INTERVAL_MS',
  DEFAULT_AUTO_LEARNING_CHECK_INTERVAL_MS
)
const SALES_V2_AUTO_LEARNING_STARTUP_DELAY_MS = parsePositiveIntEnv(
  'SALES_V2_LEARNING_AUTO_STARTUP_DELAY_MS',
  DEFAULT_AUTO_LEARNING_STARTUP_DELAY_MS
)
const NEXT_BEST_VISIT_DISABLE_STARTUP_BACKGROUND_WORK = parseBooleanEnv(
  process.env.NEXT_BEST_VISIT_DISABLE_STARTUP_BACKGROUND_WORK,
  false
)
const SHARED_DEPOT_ORIGIN = {
  latitude: Number(process.env.DEPOT_LATITUDE || 36.8065),
  longitude: Number(process.env.DEPOT_LONGITUDE || 10.1815),
  nom: process.env.DEPOT_NAME || 'Depot principal',
  adresse: process.env.DEPOT_ADDRESS || 'Point de depart commun'
}
const DEPOT_COORDS_BY_CODE = (() => {
  try {
    return JSON.parse(process.env.DEPOT_COORDS_BY_CODE || '{}')
  } catch (error) {
    console.warn('DEPOT_COORDS_BY_CODE invalide, fallback sur depot partage.')
    return {}
  }
})()

const parsedDbPort = Number.parseInt(process.env.DB_PORT || '3306', 10)
const parsedDbConnectionLimit = Number.parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10)
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number.isFinite(parsedDbPort) && parsedDbPort > 0 ? parsedDbPort : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'dist_utic'
}
const DB_POOL_CONFIG = {
  ...DB_CONFIG,
  waitForConnections: true,
  connectionLimit: Number.isFinite(parsedDbConnectionLimit) && parsedDbConnectionLimit > 0 ? parsedDbConnectionLimit : 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
}

const dbPool = mysql.createPool(DB_POOL_CONFIG)
let dbBootstrapStarted = false
let dbBootstrapPromise = null
let salesLearningAutoSchedulerStarted = false
let dbConnectionAnnounced = false

function getDbTargetLabel() {
  return `${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`
}

function formatDbError(error) {
  if (!error) {
    return `Erreur SQL inconnue (${getDbTargetLabel()})`
  }

  if (error.code === 'ECONNREFUSED') {
    return `Connexion MySQL refusee vers ${getDbTargetLabel()}. Demarrez MySQL ou corrigez DB_HOST/DB_PORT.`
  }

  if (error.code === 'ER_ACCESS_DENIED_ERROR') {
    return `Acces MySQL refuse pour ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}. Verifiez DB_USER/DB_PASS.`
  }

  if (error.code === 'ER_BAD_DB_ERROR') {
    return `Base MySQL introuvable (${DB_CONFIG.database}) sur ${DB_CONFIG.host}:${DB_CONFIG.port}. Verifiez DB_NAME.`
  }

  return error.message || String(error)
}

function toDbError(error) {
  const dbError = error instanceof Error ? error : new Error(String(error || 'Erreur SQL inconnue'))
  dbError.message = formatDbError(error)
  if (error?.code) {
    dbError.code = error.code
  }
  return dbError
}

function announceDbConnection() {
  if (dbConnectionAnnounced) {
    return
  }

  dbConnectionAnnounced = true
  console.log(`Connecte a la base de donnees ${DB_CONFIG.database} (${DB_CONFIG.host}:${DB_CONFIG.port}) !`)
  console.log('Le reentrainement automatique est desactive dans server.js. Utilisez le scheduler systeme.')
}

function attachDbErrorHandler(connection) {
  if (!connection || connection.__nomadisErrorHandlerAttached) {
    return
  }

  connection.__nomadisErrorHandlerAttached = true
  connection.on('error', error => {
    console.error('Erreur SQL runtime:', formatDbError(error))
  })
}

function getPoolConnection() {
  return new Promise((resolve, reject) => {
    dbPool.getConnection((err, connection) => {
      if (err) {
        reject(toDbError(err))
        return
      }

      attachDbErrorHandler(connection)
      announceDbConnection()
      resolve(connection)
    })
  })
}

function triggerDbBootstrap() {
  announceDbConnection()

  if (dbBootstrapStarted || dbBootstrapPromise) {
    return
  }

  dbBootstrapStarted = true
  dbBootstrapPromise = Promise.all([
    ensureMovementSupportTables(),
    ensureCoverageSupportTables(),
    ensurePredictionLoggingTables(),
    ensurePredictionFeedbackTables(),
    ensureSalesLearningTables(queryAsync)
  ])
    .catch(error => {
      console.error('Initialisation tables support impossible:', error.message)
    })
    .finally(() => {
      dbBootstrapPromise = null
    })

  if (!NEXT_BEST_VISIT_DISABLE_STARTUP_BACKGROUND_WORK) {
    ensureNextBestVisitProfilesReady({
      queryAsync,
      withTransaction,
      querySalesHistoryRowsForClients: nextBestVisitService.__testables.querySalesHistoryRowsForClients,
      normalizeSalesHistoryRowsForClients: nextBestVisitService.__testables.normalizeSalesHistoryRowsForClients,
      queryVisitHistoryRowsForClients: nextBestVisitService.__testables.queryVisitHistoryRowsForClients,
      normalizeVisitHistoryRowsForClients: nextBestVisitService.__testables.normalizeVisitHistoryRowsForClients,
      planningStartDate: formatLocalDate(new Date()),
      autoTriggerRebuild: true,
      logger: console
    })
      .then(result => {
        const readinessStatus = String(result?.status || 'missing')
        if (readinessStatus === 'ready') {
          console.log('Next Best Visit profiles already ready; startup rebuild skipped.')
          return
        }
        if (readinessStatus === 'building') {
          console.log('Next Best Visit profile rebuild started in background at startup.')
          return
        }
        if (readinessStatus === 'failed') {
          console.warn(`Next Best Visit startup readiness failed: ${result?.snapshotState?.latest_error_message || 'unknown_error'}`)
          return
        }
        console.log(`Next Best Visit startup readiness status: ${readinessStatus}`)
      })
      .catch(error => {
        console.error('Next Best Visit startup readiness trigger failed:', error.message || String(error))
      })
  }

  startSalesLearningAutomaticCycleScheduler()
}

function probeDbConnection() {
  return getPoolConnection()
    .then(connection => {
      connection.release()
      triggerDbBootstrap()
    })
    .catch(error => {
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ER_ACCESS_DENIED_ERROR' || error?.code === 'ER_BAD_DB_ERROR') {
        console.error('Erreur SQL de connexion:', error.message)
      } else {
        console.error('Erreur SQL de connexion:', formatDbError(error))
      }
    })
}

function queryDb(sql, params, callback, connection = null) {
  const queryParams = typeof params === 'function' ? [] : params
  const queryCallback = typeof params === 'function' ? params : callback
  const executor = connection || dbPool

  if (connection) {
    attachDbErrorHandler(connection)
  }

  executor.query(sql, queryParams, (err, rows) => {
    if (err) {
      queryCallback(toDbError(err))
      return
    }

    triggerDbBootstrap()
    queryCallback(null, rows)
  })
}

function beginTransactionAsync(connection) {
  return new Promise((resolve, reject) => {
    connection.beginTransaction(err => {
      if (err) {
        reject(toDbError(err))
        return
      }

      resolve()
    })
  })
}

function commitAsync(connection) {
  return new Promise((resolve, reject) => {
    connection.commit(err => {
      if (err) {
        reject(toDbError(err))
        return
      }

      resolve()
    })
  })
}

function rollbackAsync(connection) {
  return new Promise((resolve, reject) => {
    connection.rollback(err => {
      if (err) {
        reject(toDbError(err))
        return
      }

      resolve()
    })
  })
}

async function withTransaction(handler, { logPrefix = 'SQL' } = {}) {
  const connection = await getPoolConnection()
  let transactionStarted = false

  try {
    await beginTransactionAsync(connection)
    transactionStarted = true

    const result = await handler(connection)
    await commitAsync(connection)
    return result
  } catch (error) {
    if (transactionStarted) {
      try {
        await rollbackAsync(connection)
      } catch (rollbackError) {
        console.error(`[${logPrefix}] Rollback impossible:`, rollbackError.message)
      }
    }

    throw error
  } finally {
    connection.release()
  }
}

probeDbConnection()

const COMMERCIAL_OPTIONS_CACHE_TTL_MS = 5 * 60 * 1000
const AI_PREDICTION_CACHE_TTL_MS = 3 * 60 * 1000
const COVERAGE_DATA_VERSION = String(process.env.COVERAGE_DATA_VERSION || '1').trim() || '1'
function isCoveragePerfDebugEnabled() {
  return parseBooleanEnv(process.env.COVERAGE_PERF_DEBUG, false)
}
const COVERAGE_AI_CONCURRENCY = Math.max(1, parsePositiveIntEnv(process.env.COVERAGE_AI_CONCURRENCY, 2))
const COVERAGE_HISTORY_DISK_CACHE_ENABLED = parseBooleanEnv(process.env.COVERAGE_HISTORY_DISK_CACHE_ENABLED, false)
const COVERAGE_HISTORY_DISK_CACHE_TTL_MS = parsePositiveIntEnv(
  process.env.COVERAGE_HISTORY_DISK_CACHE_TTL_MS,
  DEFAULT_DISK_CACHE_TTL_MS
)
const COVERAGE_HISTORY_DISK_CACHE_DIR = path.resolve(
  apiDir,
  process.env.COVERAGE_HISTORY_DISK_CACHE_DIR || '.cache/coverage-history'
)
const COVERAGE_PURCHASE_CACHE_DIR = path.resolve(
  apiDir,
  process.env.COVERAGE_PURCHASE_CACHE_DIR || '.cache/coverage-purchase-predictions'
)
const COVERAGE_PURCHASE_CACHE_ENABLED = parseBooleanEnv(process.env.COVERAGE_PURCHASE_CACHE_ENABLED, false)
const COVERAGE_PURCHASE_CACHE_TTL_MS = parsePositiveIntEnv(
  process.env.COVERAGE_PURCHASE_CACHE_TTL_MS,
  DEFAULT_DISK_CACHE_TTL_MS
)
const COVERAGE_HISTORY_SCHEMA_VERSION = 'coverage_history_cache_v2'
const COVERAGE_PURCHASE_SCHEMA_VERSION = 'coverage_purchase_cache_v1'
const COVERAGE_CAPACITY_MODE_VALIDATED_VISIT = 'validated_visit_capacity'
const COVERAGE_CAPACITY_MODE_SALES_PROXY = 'sales_activity_proxy'
const COVERAGE_CAPACITY_MODE_CONFIGURED_HARD = 'configured_hard_capacity'
const COVERAGE_CAPACITY_MODE_UNKNOWN = 'unknown'
const COVERAGE_PLANNING_MODE_RECOVERY = 'recovery_coverage'
const COVERAGE_PLANNING_MODE_SALES = 'sales_coverage'
const DEFAULT_COVERAGE_WINDOW_DAYS = 14
const DEFAULT_DAILY_MAX_MODE = 'flexible'
const DAILY_MAX_MODE_STRICT = 'strict'
const DAILY_MAX_MODE_FLEXIBLE = 'flexible'
const COVERAGE_VALIDATED_VISIT_MIN_ACTIVE_DAYS = Math.max(
  1,
  Number.parseInt(process.env.COVERAGE_VALIDATED_VISIT_MIN_ACTIVE_DAYS || '20', 10) || 20
)
let commercialOptionsCache = {
  data: null,
  expiresAt: 0,
  pending: null
}
const aiPredictionRequestCache = new Map()
const COVERAGE_HISTORY_CODE_VERSION = computeSourceFingerprint(
  [
    path.join(apiDir, 'server.js'),
    path.join(apiDir, 'coverage_history_cache.js'),
    path.join(apiDir, 'client_identity.js'),
    path.join(apiDir, 'coverage_predicted_ca.js')
  ],
  [
    'client_history_sql_v3',
    'sales_profiles_sql_v2',
    'validated_visit_profiles_sql_v2'
  ]
)
const COVERAGE_PURCHASE_CODE_VERSION = computeSourceFingerprint(
  [
    path.join(apiDir, 'server.js'),
    path.join(apiDir, 'coverage_history_cache.js'),
    path.join(apiDir, 'coverage_purchase_prediction_profiles.js')
  ],
  [
    'coverage_purchase_cache_v1',
    'fetchLoggedAiPredictions',
    'computePriorityScore'
  ]
)
const COVERAGE_HISTORY_WINDOW_DAYS = DEFAULT_COVERAGE_HISTORY_WINDOW_DAYS
const COVERAGE_HISTORY_METRICS_WINDOW_DAYS = 365
const COVERAGE_DOC_TYPES = Object.freeze(['facture', 'bl', 'blf'])
const COVERAGE_HISTORY_FILTERS_SALES_PROFILES = Object.freeze({
  source: 'sales_capacity_profiles',
  deleted_at_null: true,
  doc_types: [...COVERAGE_DOC_TYPES],
  exclude_annule: '1'
})
const COVERAGE_HISTORY_FILTERS_VALIDATED_VISITS = Object.freeze({
  source: 'validated_visit_capacity_profiles',
  validation_status: 'validated'
})
const COVERAGE_HISTORY_FILTERS_CLIENT_HISTORY = Object.freeze({
  document_history: {
    deleted_at_null: true,
    doc_types: [...COVERAGE_DOC_TYPES]
  },
  visit_history: {
    validation_status: 'validated'
  },
  history_metrics_window_days: COVERAGE_HISTORY_METRICS_WINDOW_DAYS,
  history_metrics_exclude_annule: true
})
const coverageHistoryCache = createCoverageHistoryCache({
  ttlMs: COVERAGE_HISTORY_DISK_CACHE_ENABLED
    ? COVERAGE_HISTORY_DISK_CACHE_TTL_MS
    : undefined,
  diskEnabled: COVERAGE_HISTORY_DISK_CACHE_ENABLED,
  diskDir: COVERAGE_HISTORY_DISK_CACHE_DIR,
  logger: event => {
    const parts = [
      `[COVERAGE_HISTORY_CACHE] type=${String(event?.type || '').trim() || 'unknown'}`,
      `status=${String(event?.status || '').trim() || 'unknown'}`
    ]

    if (String(event?.key || '').trim()) {
      parts.push(`key=${String(event.key).trim()}`)
    }
    if (Number.isFinite(Number(event?.ageMs)) && Number(event.ageMs) >= 0) {
      parts.push(`age_ms=${Math.round(Number(event.ageMs))}`)
    }
    if (Number.isFinite(Number(event?.buildMs)) && Number(event.buildMs) >= 0) {
      parts.push(`build_ms=${Math.round(Number(event.buildMs))}`)
    }

    console.log(parts.join(' '))
  }
})
const coveragePurchasePredictionCache = new CoverageHistoryCache({
  ttlMs: COVERAGE_PURCHASE_CACHE_TTL_MS,
  maxEntries: 64,
  disabled: !COVERAGE_PURCHASE_CACHE_ENABLED,
  diskEnabled: COVERAGE_PURCHASE_CACHE_ENABLED,
  diskDir: COVERAGE_PURCHASE_CACHE_DIR,
  logger: event => {
    const parts = [
      `[COVERAGE_PURCHASE_CACHE] type=${String(event?.type || '').trim() || 'unknown'}`,
      `status=${String(event?.status || '').trim() || 'unknown'}`
    ]

    if (String(event?.key || '').trim()) {
      parts.push(`key=${String(event.key).trim()}`)
    }
    if (Number.isFinite(Number(event?.ageMs)) && Number(event.ageMs) >= 0) {
      parts.push(`age_ms=${Math.round(Number(event.ageMs))}`)
    }
    if (Number.isFinite(Number(event?.buildMs)) && Number(event.buildMs) >= 0) {
      parts.push(`build_ms=${Math.round(Number(event.buildMs))}`)
    }

    console.log(parts.join(' '))
  }
})

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }

  return JSON.stringify(value)
}

function createCoveragePerfTracker(requestId = crypto.randomUUID()) {
  const stages = []

  function logStage(stage, durationMs) {
    console.log(
      `[COVERAGE_PERF] request_id=${requestId} stage=${String(stage || 'unknown').trim() || 'unknown'} duration_ms=${Math.round(Number(durationMs || 0))}`
    )
  }

  return {
    requestId,
    stages,
    mark(stage, startedAt) {
      const durationMs = Date.now() - startedAt
      stages.push({
        stage,
        duration_ms: Math.max(0, Math.round(durationMs))
      })
      logStage(stage, durationMs)
      return durationMs
    },
    async time(stage, handler) {
      const startedAt = Date.now()
      try {
        return await handler()
      } finally {
        this.mark(stage, startedAt)
      }
    },
    merge(performanceEntries = []) {
      ;(Array.isArray(performanceEntries) ? performanceEntries : []).forEach(entry => {
        if (!entry || !entry.stage) return
        stages.push({
          stage: String(entry.stage),
          duration_ms: Math.max(0, Math.round(Number(entry.duration_ms || 0)))
        })
        logStage(entry.stage, entry.duration_ms)
      })
    },
    toMeta() {
      return {
        request_id: requestId,
        stages: stages.map(entry => ({
          stage: entry.stage,
          duration_ms: entry.duration_ms
        }))
      }
    }
  }
}

async function runCoveragePerfStage(perfTracker, stage, handler) {
  if (!perfTracker || typeof perfTracker.time !== 'function') {
    return handler()
  }

  return perfTracker.time(stage, handler)
}

function buildPredictionRequestCacheKey(requestPayload = {}) {
  if (!requestPayload || typeof requestPayload !== 'object') return ''

  const normalizedPayload = { ...requestPayload }
  if (Array.isArray(normalizedPayload.commercials)) {
    normalizedPayload.commercials = normalizedPayload.commercials
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .sort()
  }

  return stableStringify(normalizedPayload)
}

function buildCoveragePurchaseCacheKey({ requestPayload = {}, cacheContext = {} } = {}) {
  return buildCoverageHistoryCacheKey({
    name: 'coveragePurchasePredictions',
    predictionDate: requestPayload?.date,
    activeClientIds: cacheContext?.activeClientIds || [],
    exactClientCodes: cacheContext?.exactClientCodes || [],
    database: DB_CONFIG.database,
    logicalSchemaVersion: COVERAGE_PURCHASE_SCHEMA_VERSION,
    sqlVersion: 'dashboard_predict_payload_v1',
    codeVersion: COVERAGE_PURCHASE_CODE_VERSION,
    dataVersion: COVERAGE_DATA_VERSION,
    predictionParams: requestPayload,
    modelVersion: String(cacheContext?.modelVersion || process.env.AI_MODEL_VERSION || 'unknown').trim(),
    datasetCutoff: String(cacheContext?.datasetCutoff || process.env.AI_DATASET_CUTOFF || '').trim(),
    scoreVersion: String(cacheContext?.scoreVersion || process.env.AI_SCORE_VERSION || 'computePriorityScore').trim(),
    extraContext: {
      request_context: cacheContext?.requestContext || {}
    }
  })
}

function resolveCoveragePlanningMode(rawValue) {
  return String(rawValue || '').trim().toLowerCase() === COVERAGE_PLANNING_MODE_SALES
    ? COVERAGE_PLANNING_MODE_SALES
    : COVERAGE_PLANNING_MODE_RECOVERY
}

function isSalesCoveragePlanningMode(rawValue) {
  return resolveCoveragePlanningMode(rawValue) === COVERAGE_PLANNING_MODE_SALES
}

function normalizeCoverageWindowDays(rawValue) {
  return Math.max(
    1,
    Math.min(180, Number.parseInt(rawValue, 10) || DEFAULT_COVERAGE_WINDOW_DAYS)
  )
}

function normalizeDailyMaxMode(rawValue) {
  return String(rawValue || '').trim().toLowerCase() === DAILY_MAX_MODE_STRICT
    ? DAILY_MAX_MODE_STRICT
    : DAILY_MAX_MODE_FLEXIBLE
}

function pruneExpiredPredictionCache(now = Date.now()) {
  for (const [cacheKey, entry] of aiPredictionRequestCache.entries()) {
    if (!entry) {
      aiPredictionRequestCache.delete(cacheKey)
      continue
    }

    if (!entry.pending && Number(entry.expiresAt || 0) <= now) {
      aiPredictionRequestCache.delete(cacheKey)
    }
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function buildDistanceMap(clients) {
  const geoClients = clients.filter(c => c.latitude != null && c.longitude != null && !isNaN(Number(c.latitude)) && !isNaN(Number(c.longitude)))
  if (!geoClients.length) {
    return { distanceMap: new Map(), maxDistance: 0 }
  }

  const centerLat = geoClients.reduce((sum, c) => sum + Number(c.latitude), 0) / geoClients.length
  const centerLon = geoClients.reduce((sum, c) => sum + Number(c.longitude), 0) / geoClients.length

  const distanceMap = new Map()
  let maxDistance = 0

  geoClients.forEach(c => {
    const dist = haversineKm(centerLat, centerLon, Number(c.latitude), Number(c.longitude))
    distanceMap.set(String(c.nbr_client), dist)
    if (dist > maxDistance) maxDistance = dist
  })

  return { distanceMap, maxDistance }
}

function computePriorityScore(chiffrePredit, maxChiffre, probAchat, habitScore, recencyScore, distanceKm, maxDistanceKm) {
  const venteNorm = maxChiffre > 0 ? chiffrePredit / maxChiffre : 0
  const purchaseSignal = clamp(
    (((probAchat || 0) * 0.75) + ((habitScore || 0) * 0.15) + ((recencyScore || 0) * 0.10)) / 100,
    0,
    1
  )
  const distanceNorm = maxDistanceKm > 0 ? clamp(distanceKm / maxDistanceKm, 0, 1) : 0

  const scoreNorm = (0.6 * venteNorm) + (0.35 * purchaseSignal) - (0.05 * distanceNorm)
  return roundScore(clamp(scoreNorm * 100, 0, 100))
}

function computeRecoveryScore(encoursCredit, maxEncours, plafondCredit, distanceKm, maxDistanceKm) {
  const encoursNorm = maxEncours > 0 ? encoursCredit / maxEncours : 0
  const plafondRatio = plafondCredit > 0 ? clamp(encoursCredit / plafondCredit, 0, 1.5) / 1.5 : 0
  const distanceNorm = maxDistanceKm > 0 ? clamp(distanceKm / maxDistanceKm, 0, 1) : 0
  const scoreNorm = (0.70 * encoursNorm) + (0.20 * plafondRatio) - (0.10 * distanceNorm)
  return roundScore(clamp(scoreNorm * 100, 0, 100))
}

function computeSmartRecoveryScore({
  dueBalance,
  maxDueBalance,
  likelyRecoveryAmount,
  maxLikelyRecovery,
  severeOverdueBalance,
  maxSevereOverdue,
  paymentBehaviorScore,
  distanceKm,
  maxDistanceKm
}) {
  const dueBalanceNorm = maxDueBalance > 0 ? dueBalance / maxDueBalance : 0
  const likelyRecoveryNorm = maxLikelyRecovery > 0 ? likelyRecoveryAmount / maxLikelyRecovery : 0
  const severeOverdueNorm = maxSevereOverdue > 0 ? severeOverdueBalance / maxSevereOverdue : 0
  const paymentBehaviorNorm = clamp(paymentBehaviorScore || 0, 0, 1)
  const distanceNorm = maxDistanceKm > 0 ? clamp(distanceKm / maxDistanceKm, 0, 1) : 0

  const scoreNorm =
    (0.45 * dueBalanceNorm) +
    (0.25 * severeOverdueNorm) +
    (0.20 * likelyRecoveryNorm) +
    (0.15 * paymentBehaviorNorm) -
    (0.05 * distanceNorm)

  return roundScore(clamp(scoreNorm * 100, 0, 100))
}

function roundScore(value) {
  return Math.round(value * 10) / 10
}

function normalizeClientKeys(rawValue) {
  const exactCode = normalizeExactClientCode(rawValue)
  return exactCode ? [exactCode] : []
}

function setClientMapValue(map, rawValue, payload) {
  const exactCode = normalizeExactClientCode(rawValue)
  if (!exactCode) return
  map.set(exactCode, payload)
}

function getClientMapValue(map, rawValue) {
  const exactCode = normalizeExactClientCode(rawValue)
  return exactCode && map.has(exactCode) ? map.get(exactCode) : null
}

function getCanonicalClientKey(rawValue) {
  return normalizeExactClientCode(rawValue)
}

function getClientUniqueKey(row = {}) {
  return normalizeClientId(row.client_id ?? row.id ?? row.client_unique_key)
}

function fillMissingCoverageClientData(target, source) {
  if (!target || !source) return target

  const copyTextIfMissing = field => {
    const targetValue = String(target[field] ?? '').trim()
    const sourceValue = String(source[field] ?? '').trim()
    if (!targetValue && sourceValue) {
      target[field] = source[field]
    }
  }

  const copyNumberIfMissing = field => {
    const targetValue = Number(target[field])
    const sourceValue = Number(source[field])
    if (!Number.isFinite(targetValue) && Number.isFinite(sourceValue)) {
      target[field] = source[field]
    }
  }

  copyTextIfMissing('nom')
  copyTextIfMissing('user_code')
  copyTextIfMissing('routing_code')
  copyTextIfMissing('delegation')
  copyTextIfMissing('region')
  copyTextIfMissing('adresse')
  copyNumberIfMissing('potentiel')
  copyNumberIfMissing('latitude')
  copyNumberIfMissing('longitude')

  return target
}

function dedupeCoverageClientRows(rows = []) {
  const deduped = dedupeClientRowsById((Array.isArray(rows) ? rows : []).map(row => ({
    ...row,
    client_id: row?.client_id ?? row?.id,
    client_code: row?.client_code ?? row?.code ?? row?.nbr_client,
    nbr_client: normalizeExactClientCode(row?.nbr_client ?? row?.client_code ?? row?.code)
  })))

  deduped.rows.forEach(row => {
    row.nbr_client = normalizeExactClientCode(row.nbr_client || row.client_code)
    fillMissingCoverageClientData(row, {
      nom: row.nom,
      user_code: row.user_code,
      routing_code: row.routing_code,
      delegation: row.delegation,
      region: row.region,
      adresse: row.adresse,
      potentiel: row.potentiel,
      latitude: row.latitude,
      longitude: row.longitude
    })
  })

  return deduped
}

function estimateLikelyRecoveryAmount({
  encoursCredit,
  avgPaymentAmount,
  maxPaymentAmount,
  totalPaid30d,
  nbPaymentsHist,
  nbDocsCredit
}) {
  const encours = Number(encoursCredit || 0)
  if (encours <= 0) return 0

  const avgPaid = Number(avgPaymentAmount || 0)
  const maxPaid = Number(maxPaymentAmount || 0)
  const paid30d = Number(totalPaid30d || 0)
  const trancheRatio = nbDocsCredit > 0 ? Number(nbPaymentsHist || 0) / nbDocsCredit : 0
  const tendsToPayByTranches = trancheRatio > 1.2

  let estimated = avgPaid

  if (tendsToPayByTranches) {
    estimated = Math.max(avgPaid, paid30d > 0 ? paid30d * 0.6 : 0)
  } else {
    estimated = Math.max(avgPaid * 1.15, maxPaid * 0.5, paid30d > 0 ? paid30d * 0.4 : 0)
  }

  if (estimated <= 0) {
    estimated = Math.min(encours, maxPaid || avgPaid || encours * 0.25)
  }

  return roundScore(clamp(estimated, 0, encours))
}

function parseSqlDate(value) {
  if (!value) return null
  const datePart = String(value).slice(0, 10)
  const [year, month, day] = datePart.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(Date.UTC(year, month - 1, day))
}

function diffDays(dateA, dateB) {
  const first = parseSqlDate(dateA)
  const second = parseSqlDate(dateB)
  if (!first || !second) return null
  return Math.max(0, Math.floor((second.getTime() - first.getTime()) / 86400000))
}

function buildDepotOrigin(depotConfig, route, commercial, depotCode) {
  if (!depotConfig || !Number.isFinite(Number(depotConfig.latitude)) || !Number.isFinite(Number(depotConfig.longitude))) {
    return null
  }

  const routeLabel = route ? `Route ${route}` : 'Toutes les routes'
  const commercialLabel = commercial ? `Commercial ${commercial}` : 'Tous les commerciaux'

  return {
    latitude: Number(depotConfig.latitude),
    longitude: Number(depotConfig.longitude),
    nom: depotConfig.nom || SHARED_DEPOT_ORIGIN.nom,
    adresse: depotConfig.adresse || SHARED_DEPOT_ORIGIN.adresse,
    type: 'depot',
    depot_code: depotCode || null,
    route: route || null,
    commercial: commercial || null,
    adresse: `${depotConfig.adresse || SHARED_DEPOT_ORIGIN.adresse} - ${routeLabel} / ${commercialLabel}`
  }
}

function getSharedDepotOrigin(route, commercial, depotCode = null) {
  return buildDepotOrigin(SHARED_DEPOT_ORIGIN, route, commercial, depotCode)
}

function queryAsync(sql, params = [], connection = null) {
  return new Promise((resolve, reject) => {
    queryDb(sql, params, (err, rows) => {
      if (err) reject(err)
      else resolve(rows)
    }, connection)
  })
}

function buildCoverageRecoveryQueryRows(queryExecutor = queryAsync, defaultConnection = null) {
  if (typeof queryExecutor !== 'function') {
    throw new Error('buildCoverageRecoveryQueryRows requires a query executor function.')
  }

  return async (sql, params = [], connection = defaultConnection) => queryExecutor(sql, params, connection)
}

let movementSupportTablesPending = null
let coverageSupportTablesPending = null
let predictionLoggingTablesPending = null
let predictionFeedbackTablesPending = null

function readCurrentIaPrecisionScore() {
  try {
    const precisionLue = fs.readFileSync(path.join(apiDir, 'precision.txt'), 'utf8')
    const parsedValue = parseFloat(precisionLue)
    return Number.isFinite(parsedValue) ? parsedValue : 0
  } catch (error) {
    return 0
  }
}

async function ensureMovementSupportTables() {
  if (movementSupportTablesPending) {
    return movementSupportTablesPending
  }

  movementSupportTablesPending = (async () => {
    await queryAsync(`
      CREATE TABLE IF NOT EXISTS stock_depots (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        produit_code VARCHAR(255) NOT NULL,
        soussociete_code VARCHAR(255) NOT NULL,
        quantite DOUBLE NOT NULL DEFAULT 0,
        retour DOUBLE NOT NULL DEFAULT 0,
        dlc DOUBLE NOT NULL DEFAULT 0,
        casse DOUBLE NOT NULL DEFAULT 0,
        reservation DOUBLE NOT NULL DEFAULT 0,
        securite DOUBLE NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT NULL,
        updated_at TIMESTAMP NULL DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY stock_depots_unique (produit_code, soussociete_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await queryAsync(`
      CREATE TABLE IF NOT EXISTS stock_depot_info (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_code VARCHAR(255) DEFAULT NULL,
        commercial_code VARCHAR(255) DEFAULT NULL,
        soussociete_code VARCHAR(255) DEFAULT NULL,
        code VARCHAR(255) DEFAULT NULL,
        produit_code VARCHAR(255) DEFAULT NULL,
        old_quantite DOUBLE DEFAULT NULL,
        diff_quantite DOUBLE DEFAULT NULL,
        new_quantite DOUBLE DEFAULT NULL,
        module_nomadis VARCHAR(255) DEFAULT NULL,
        type_mouvement VARCHAR(255) DEFAULT NULL,
        cause VARCHAR(255) DEFAULT NULL,
        etat VARCHAR(255) DEFAULT NULL,
        latitude VARCHAR(255) DEFAULT NULL,
        longitude VARCHAR(255) DEFAULT NULL,
        date DATETIME DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT NULL,
        updated_at TIMESTAMP NULL DEFAULT NULL,
        PRIMARY KEY (id),
        KEY stock_depot_info_code_idx (code),
        KEY stock_depot_info_produit_idx (produit_code),
        KEY stock_depot_info_soussociete_idx (soussociete_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await queryAsync(`
      CREATE TABLE IF NOT EXISTS mouvements_deleted (
        archive_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        id BIGINT UNSIGNED NOT NULL,
        magasinier_code VARCHAR(255) DEFAULT NULL,
        depot_code VARCHAR(255) DEFAULT NULL,
        commercial_code VARCHAR(255) DEFAULT NULL,
        caisse_code VARCHAR(191) DEFAULT NULL,
        soussociete_code VARCHAR(255) DEFAULT NULL,
        produit_code VARCHAR(255) DEFAULT NULL,
        prix_achat_ht DOUBLE DEFAULT NULL,
        prix_achat_ttc DOUBLE DEFAULT NULL,
        quantite DOUBLE DEFAULT NULL,
        qte_demande DOUBLE DEFAULT NULL,
        prix_ht DOUBLE DEFAULT NULL,
        prix_ttc DOUBLE DEFAULT NULL,
        p_tva DOUBLE DEFAULT NULL,
        taux_tva DOUBLE DEFAULT NULL,
        remise DOUBLE DEFAULT NULL,
        type VARCHAR(255) DEFAULT NULL,
        num_serie VARCHAR(255) DEFAULT NULL,
        numero VARCHAR(255) DEFAULT NULL,
        configuration VARCHAR(255) DEFAULT NULL,
        etat VARCHAR(255) DEFAULT NULL,
        isSync TINYINT(1) DEFAULT 0,
        wavesoft VARCHAR(50) DEFAULT NULL,
        num_lot VARCHAR(50) DEFAULT NULL,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT NULL,
        updated_at TIMESTAMP NULL DEFAULT NULL,
        date DATETIME DEFAULT NULL,
        date_accept DATETIME DEFAULT NULL,
        from_stock TINYINT(1) DEFAULT NULL,
        PRIMARY KEY (archive_id),
        KEY mouvements_deleted_id_idx (id),
        KEY mouvements_deleted_numero_idx (numero),
        KEY mouvements_deleted_produit_idx (produit_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    console.log('Tables support mouvements verifiees.')
  })().catch(error => {
    movementSupportTablesPending = null
    throw error
  })

  return movementSupportTablesPending
}

async function ensureCoverageSupportTables() {
  if (coverageSupportTablesPending) {
    return coverageSupportTablesPending
  }

  coverageSupportTablesPending = (async () => {
    await queryAsync(`
      CREATE TABLE IF NOT EXISTS client_visits (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        client_id BIGINT UNSIGNED DEFAULT NULL,
        client_code VARCHAR(191) NOT NULL,
        commercial_code VARCHAR(191) NOT NULL,
        tournee_code VARCHAR(191) DEFAULT NULL,
        planned_date DATE DEFAULT NULL,
        check_in_at DATETIME DEFAULT NULL,
        check_out_at DATETIME DEFAULT NULL,
        check_in_latitude DECIMAL(10,7) DEFAULT NULL,
        check_in_longitude DECIMAL(10,7) DEFAULT NULL,
        validation_status VARCHAR(50) NOT NULL DEFAULT 'pending',
        visit_result VARCHAR(50) DEFAULT NULL,
        sale_amount DECIMAL(15,3) DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_client_visits_client_date (client_code, check_in_at),
        KEY idx_client_visits_commercial_date (commercial_code, check_in_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await ensureTableColumn('client_visits', 'client_id', 'BIGINT UNSIGNED DEFAULT NULL')
    await ensureTableIndex('client_visits', 'idx_client_visits_client_id_date', 'INDEX `idx_client_visits_client_id_date` (`client_id`, `check_in_at`)')

    console.log('Table client_visits verifiee.')

    await queryAsync(`
      CREATE TABLE IF NOT EXISTS sales_v2_visit_feedback (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        planned_visit_id VARCHAR(191) NOT NULL,
        assigned_slot_id VARCHAR(191) DEFAULT NULL,
        client_id VARCHAR(191) DEFAULT NULL,
        client_code VARCHAR(191) NOT NULL,
        commercial_code VARCHAR(191) NOT NULL,
        planned_date DATE NOT NULL,
        execution_status VARCHAR(50) NOT NULL DEFAULT 'pending',
        purchase_made TINYINT(1) DEFAULT NULL,
        actual_ca DECIMAL(15,3) DEFAULT NULL,
        actual_quantity DECIMAL(15,3) DEFAULT NULL,
        visit_date_actual DATETIME DEFAULT NULL,
        note TEXT DEFAULT NULL,
        non_visit_reason TEXT DEFAULT NULL,
        no_purchase_reason TEXT DEFAULT NULL,
        prediction_snapshot_json LONGTEXT DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_sales_v2_visit_feedback_planned_visit (planned_visit_id),
        KEY idx_sales_v2_visit_feedback_client_date (client_code, planned_date),
        KEY idx_sales_v2_visit_feedback_commercial_date (commercial_code, planned_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await ensureTableColumn('sales_v2_visit_feedback', 'tournee_code', 'VARCHAR(191) DEFAULT NULL')
    await ensureTableIndex(
      'sales_v2_visit_feedback',
      'idx_sales_v2_visit_feedback_tournee_status',
      'INDEX `idx_sales_v2_visit_feedback_tournee_status` (`tournee_code`, `execution_status`)'
    )

    console.log('Table sales_v2_visit_feedback verifiee.')
  })().catch(error => {
    coverageSupportTablesPending = null
    throw error
  })

  return coverageSupportTablesPending
}

async function ensurePredictionLoggingTables() {
  if (predictionLoggingTablesPending) {
    return predictionLoggingTablesPending
  }

  predictionLoggingTablesPending = (async () => {
    await queryAsync(`
      CREATE TABLE IF NOT EXISTS ia_prediction_runs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        run_code VARCHAR(191) NOT NULL,
        source_context VARCHAR(191) NOT NULL,
        source_mode VARCHAR(191) DEFAULT NULL,
        request_date DATE DEFAULT NULL,
        request_payload_json LONGTEXT DEFAULT NULL,
        request_context_json LONGTEXT DEFAULT NULL,
        request_commercials_json LONGTEXT DEFAULT NULL,
        request_route_code VARCHAR(191) DEFAULT NULL,
        request_commercial_code VARCHAR(191) DEFAULT NULL,
        request_top_clients INT DEFAULT NULL,
        request_target_chiffre DOUBLE DEFAULT NULL,
        response_status VARCHAR(64) DEFAULT NULL,
        response_message TEXT DEFAULT NULL,
        response_meta_json LONGTEXT DEFAULT NULL,
        total_candidates INT DEFAULT NULL,
        selected_clients INT DEFAULT NULL,
        expected_buyers_estimate INT DEFAULT NULL,
        selection_limit INT DEFAULT NULL,
        model_version VARCHAR(255) DEFAULT NULL,
        precision_score DOUBLE DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY ia_prediction_runs_code_unique (run_code),
        KEY ia_prediction_runs_context_idx (source_context),
        KEY ia_prediction_runs_request_date_idx (request_date),
        KEY ia_prediction_runs_commercial_idx (request_commercial_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await queryAsync(`
      CREATE TABLE IF NOT EXISTS ia_prediction_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        run_code VARCHAR(191) NOT NULL,
        client_id BIGINT UNSIGNED DEFAULT NULL,
        client_code VARCHAR(191) NOT NULL,
        prediction_rank INT DEFAULT NULL,
        best_commercial_code VARCHAR(191) DEFAULT NULL,
        predicted_score DOUBLE DEFAULT NULL,
        confidence_score DOUBLE DEFAULT NULL,
        vip_score INT DEFAULT NULL,
        predicted_qte DOUBLE DEFAULT NULL,
        predicted_ca DOUBLE DEFAULT NULL,
        predicted_ca_if_buy DOUBLE DEFAULT NULL,
        predicted_qte_if_buy DOUBLE DEFAULT NULL,
        predicted_unit_price DOUBLE DEFAULT NULL,
        prob_achat DOUBLE DEFAULT NULL,
        habit_score DOUBLE DEFAULT NULL,
        recency_score DOUBLE DEFAULT NULL,
        details_json LONGTEXT DEFAULT NULL,
        commercial_scores_json LONGTEXT DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY ia_prediction_items_run_client_unique (run_code, client_code),
        KEY ia_prediction_items_run_code_idx (run_code),
        KEY ia_prediction_items_best_commercial_idx (best_commercial_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await ensureTableColumn('ia_prediction_items', 'client_id', 'BIGINT UNSIGNED DEFAULT NULL')
    await ensureTableIndex('ia_prediction_items', 'ia_prediction_items_client_id_idx', 'INDEX `ia_prediction_items_client_id_idx` (`client_id`)')

    console.log('Tables logging IA verifiees.')
  })().catch(error => {
    predictionLoggingTablesPending = null
    throw error
  })

  return predictionLoggingTablesPending
}

async function ensurePredictionFeedbackTables() {
  if (predictionFeedbackTablesPending) {
    return predictionFeedbackTablesPending
  }

  predictionFeedbackTablesPending = (async () => {
    await queryAsync(`
      CREATE TABLE IF NOT EXISTS ia_prediction_feedback (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        run_code VARCHAR(191) NOT NULL,
        client_id BIGINT UNSIGNED DEFAULT NULL,
        client_code VARCHAR(191) NOT NULL,
        feedback_stage VARCHAR(64) NOT NULL,
        feedback_date DATE DEFAULT NULL,
        request_date DATE DEFAULT NULL,
        source_context VARCHAR(191) DEFAULT NULL,
        source_mode VARCHAR(191) DEFAULT NULL,
        was_predicted TINYINT(1) NOT NULL DEFAULT 1,
        selected_in_final_plan TINYINT(1) NOT NULL DEFAULT 0,
        selection_source VARCHAR(64) DEFAULT NULL,
        predicted_rank INT DEFAULT NULL,
        predicted_score DOUBLE DEFAULT NULL,
        predicted_ca DOUBLE DEFAULT NULL,
        predicted_qte DOUBLE DEFAULT NULL,
        prob_achat DOUBLE DEFAULT NULL,
        best_commercial_code VARCHAR(191) DEFAULT NULL,
        final_rank INT DEFAULT NULL,
        final_commercial_code VARCHAR(191) DEFAULT NULL,
        final_route_code VARCHAR(191) DEFAULT NULL,
        final_depot_code VARCHAR(191) DEFAULT NULL,
        final_tournee_code VARCHAR(191) DEFAULT NULL,
        actual_sale_amount DOUBLE DEFAULT NULL,
        actual_sale_qty DOUBLE DEFAULT NULL,
        actual_purchase_flag TINYINT(1) DEFAULT NULL,
        actual_doc_count INT DEFAULT NULL,
        actual_checked_at DATETIME DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY ia_prediction_feedback_run_client_stage_unique (run_code, client_code, feedback_stage),
        KEY ia_prediction_feedback_run_code_idx (run_code),
        KEY ia_prediction_feedback_feedback_date_idx (feedback_date),
        KEY ia_prediction_feedback_final_commercial_idx (final_commercial_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await ensureTableColumn('ia_prediction_feedback', 'client_id', 'BIGINT UNSIGNED DEFAULT NULL')
    await ensureTableIndex('ia_prediction_feedback', 'ia_prediction_feedback_client_id_idx', 'INDEX `ia_prediction_feedback_client_id_idx` (`client_id`)')

    console.log('Table feedback IA verifiee.')
  })().catch(error => {
    predictionFeedbackTablesPending = null
    throw error
  })

  return predictionFeedbackTablesPending
}

async function recordPredictionValidationFeedback({
  predictionRunCode,
  feedbackDate,
  commercialCode,
  routeCode,
  depotCode,
  validationCode,
  stops,
  logPrefix = 'PLAN_VALIDATE'
}) {
  const normalizedRunCode = String(predictionRunCode || '').trim()
  if (!normalizedRunCode) {
    return {
      savedRows: 0,
      predictedRows: 0,
      selectedRows: 0,
      unmatchedSelectedRows: 0,
      skipped: true,
      reason: 'missing_prediction_run_code'
    }
  }

  const normalizedStops = normalizeValidatedStops(stops)
  if (!normalizedStops.length) {
    return {
      savedRows: 0,
      predictedRows: 0,
      selectedRows: 0,
      unmatchedSelectedRows: 0,
      skipped: true,
      reason: 'empty_stops'
    }
  }

  await ensurePredictionFeedbackTables()

  const runRows = await queryAsync(
    `SELECT run_code, request_date, source_context, source_mode
     FROM ia_prediction_runs
     WHERE run_code = ?
     LIMIT 1`,
    [normalizedRunCode]
  )

  const runMeta = runRows[0]
  if (!runMeta) {
    return {
      savedRows: 0,
      predictedRows: 0,
      selectedRows: normalizedStops.length,
      unmatchedSelectedRows: normalizedStops.length,
      skipped: true,
      reason: 'prediction_run_not_found'
    }
  }

  const predictedItems = await queryAsync(
    `SELECT
       client_id,
       client_code,
       prediction_rank,
       best_commercial_code,
       predicted_score,
       predicted_ca,
       predicted_qte,
       prob_achat
     FROM ia_prediction_items
     WHERE run_code = ?
     ORDER BY prediction_rank ASC, client_code ASC`,
    [normalizedRunCode]
  )

  const selectedByClientId = new Map()
  const selectedByClientCode = new Map()
  normalizedStops.forEach((stop, index) => {
    const clientId = normalizeClientId(stop.client_id)
    const clientCode = normalizeExactClientCode(stop.client_code)
    const selectedEntry = {
      stop,
      finalRank: index + 1
    }

    if (clientId && !selectedByClientId.has(clientId)) {
      selectedByClientId.set(clientId, selectedEntry)
    }
    if (clientCode && !selectedByClientCode.has(clientCode)) {
      selectedByClientCode.set(clientCode, selectedEntry)
    }
  })

  await queryAsync(
    `DELETE FROM ia_prediction_feedback
     WHERE run_code = ?
       AND feedback_stage = 'tournee_validation'`,
    [normalizedRunCode]
  )

  const matchedSelectedClientIds = new Set()
  let savedRows = 0

  for (const item of predictedItems) {
    const itemClientId = normalizeClientId(item.client_id)
    const itemClientCode = normalizeExactClientCode(item.client_code)
    if (!itemClientId && !itemClientCode) continue

    const selectedEntry = (
      (itemClientId ? selectedByClientId.get(itemClientId) : null) ||
      (itemClientCode ? selectedByClientCode.get(itemClientCode) : null) ||
      null
    )
    if (selectedEntry?.stop?.client_id) {
      matchedSelectedClientIds.add(normalizeClientId(selectedEntry.stop.client_id))
    }

    await queryAsync(
      `INSERT INTO ia_prediction_feedback (
        run_code,
        client_id,
        client_code,
        feedback_stage,
        feedback_date,
        request_date,
        source_context,
        source_mode,
        was_predicted,
        selected_in_final_plan,
        selection_source,
        predicted_rank,
        predicted_score,
        predicted_ca,
        predicted_qte,
        prob_achat,
        best_commercial_code,
        final_rank,
        final_commercial_code,
        final_route_code,
        final_depot_code,
        final_tournee_code
      ) VALUES (?, ?, 'tournee_validation', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedRunCode,
        itemClientId || normalizeClientId(selectedEntry?.stop?.client_id) || null,
        String(item.client_code || '').trim(),
        feedbackDate || null,
        runMeta.request_date || null,
        runMeta.source_context || null,
        runMeta.source_mode || null,
        selectedEntry ? 1 : 0,
        selectedEntry ? 'validated_selected' : 'validated_not_selected',
        item.prediction_rank != null ? Number(item.prediction_rank) : null,
        item.predicted_score != null ? Number(item.predicted_score) : null,
        item.predicted_ca != null ? Number(item.predicted_ca) : null,
        item.predicted_qte != null ? Number(item.predicted_qte) : null,
        item.prob_achat != null ? Number(item.prob_achat) : null,
        String(item.best_commercial_code || '').trim() || null,
        selectedEntry ? selectedEntry.finalRank : null,
        String(commercialCode || '').trim() || null,
        String(routeCode || '').trim() || null,
        String(depotCode || '').trim() || null,
        String(validationCode || '').trim() || null
      ]
    )

    savedRows += 1
  }

  let unmatchedSelectedRows = 0
  for (const [clientId, selectedEntry] of selectedByClientId.entries()) {
    if (matchedSelectedClientIds.has(clientId)) continue

    const fallbackClientCode = String(selectedEntry.stop.client_code || '').trim()
    if (!fallbackClientCode) continue

    await queryAsync(
      `INSERT INTO ia_prediction_feedback (
        run_code,
        client_id,
        client_code,
        feedback_stage,
        feedback_date,
        request_date,
        source_context,
        source_mode,
        was_predicted,
        selected_in_final_plan,
        selection_source,
        final_rank,
        final_commercial_code,
        final_route_code,
        final_depot_code,
        final_tournee_code
      ) VALUES (?, ?, 'tournee_validation', ?, ?, ?, ?, 0, 1, 'validated_manual_only', ?, ?, ?, ?, ?)`,
      [
        normalizedRunCode,
        clientId || null,
        fallbackClientCode,
        feedbackDate || null,
        runMeta.request_date || null,
        runMeta.source_context || null,
        runMeta.source_mode || null,
        selectedEntry.finalRank,
        String(commercialCode || '').trim() || null,
        String(routeCode || '').trim() || null,
        String(depotCode || '').trim() || null,
        String(validationCode || '').trim() || null
      ]
    )

    savedRows += 1
    unmatchedSelectedRows += 1
  }

  console.log(
    `[${logPrefix}] Feedback prediction enregistre -> run=${normalizedRunCode} rows=${savedRows} predicted=${predictedItems.length} selected=${selectedByKey.size} unmatched=${unmatchedSelectedRows}`
  )

  return {
    savedRows,
    predictedRows: predictedItems.length,
    selectedRows: selectedByClientId.size,
    unmatchedSelectedRows,
    skipped: false,
    reason: null
  }
}

async function reconcilePredictionFeedbackActualSales({
  runCode = null,
  feedbackDate = null,
  dateFrom = null,
  dateTo = null,
  onlyPending = true,
  logPrefix = 'PREDICTION_RECONCILE'
}) {
  await ensurePredictionFeedbackTables()

  const whereClauses = [`feedback_stage = 'tournee_validation'`]
  const params = []

  const normalizedRunCode = String(runCode || '').trim()
  if (normalizedRunCode) {
    whereClauses.push('run_code = ?')
    params.push(normalizedRunCode)
  }

  const normalizedFeedbackDate = normalizeDateOnly(feedbackDate)
  const normalizedDateFrom = normalizeDateOnly(dateFrom)
  const normalizedDateTo = normalizeDateOnly(dateTo)

  if (normalizedFeedbackDate) {
    whereClauses.push('feedback_date = ?')
    params.push(normalizedFeedbackDate)
  } else if (normalizedDateFrom && normalizedDateTo) {
    whereClauses.push('feedback_date BETWEEN ? AND ?')
    params.push(normalizedDateFrom, normalizedDateTo)
  } else if (normalizedDateFrom) {
    whereClauses.push('feedback_date >= ?')
    params.push(normalizedDateFrom)
  } else if (normalizedDateTo) {
    whereClauses.push('feedback_date <= ?')
    params.push(normalizedDateTo)
  }

  if (onlyPending) {
    whereClauses.push('(actual_checked_at IS NULL OR actual_purchase_flag IS NULL)')
  }

  const feedbackRows = await queryAsync(
    `SELECT
       id,
       run_code,
       client_code,
       feedback_date
     FROM ia_prediction_feedback
     WHERE ${whereClauses.join(' AND ')}
     ORDER BY feedback_date ASC, client_code ASC`,
    params
  )

  if (!feedbackRows.length) {
    return {
      requestedRows: 0,
      checkedRows: 0,
      purchasedRows: 0,
      zeroSaleRows: 0,
      skippedRows: 0,
      sourceSalesRows: 0,
      skipped: true,
      reason: 'no_feedback_rows'
    }
  }

  const eligibleRows = feedbackRows.filter(row => {
    const rowDate = normalizeDateOnly(row.feedback_date)
    const clientCode = String(row.client_code || '').trim()
    return rowDate && clientCode
  })

  const skippedRows = feedbackRows.length - eligibleRows.length
  if (!eligibleRows.length) {
    return {
      requestedRows: feedbackRows.length,
      checkedRows: 0,
      purchasedRows: 0,
      zeroSaleRows: 0,
      skippedRows,
      sourceSalesRows: 0,
      skipped: true,
      reason: 'no_eligible_feedback_rows'
    }
  }

  const clientCodesForSales = [...new Set(
    eligibleRows
      .map(row => normalizeExactClientCode(row.client_code))
      .filter(Boolean)
  )]

  if (!clientCodesForSales.length) {
    return {
      requestedRows: feedbackRows.length,
      checkedRows: 0,
      purchasedRows: 0,
      zeroSaleRows: 0,
      skippedRows: feedbackRows.length,
      sourceSalesRows: 0,
      skipped: true,
      reason: 'no_exact_client_codes'
    }
  }

  const eligibleDates = eligibleRows
    .map(row => normalizeDateOnly(row.feedback_date))
    .filter(Boolean)
    .sort()

  const salesDateFrom = eligibleDates[0]
  const salesDateTo = eligibleDates[eligibleDates.length - 1]
  const clientFilter = buildInClause(`TRIM(e.client_code)`, clientCodesForSales)

  const salesRows = await queryAsync(
    `
      SELECT
        sales_docs.sale_date,
        sales_docs.client_code,
        COUNT(*) AS actual_doc_count,
        SUM(sales_docs.net_amount) AS actual_sale_amount,
        SUM(COALESCE(doc_quantities.total_qty, 0)) AS actual_sale_qty
      FROM (
        SELECT
          e.code AS doc_code,
          DATE(e.date) AS sale_date,
          TRIM(e.client_code) AS client_code,
          CAST(COALESCE(e.net_a_payer, '0') AS DECIMAL(15,3)) AS net_amount
        FROM entetecommercials e
        WHERE e.deleted_at IS NULL
          AND e.type IN ('facture', 'bl', 'blf')
          AND DATE(e.date) BETWEEN ? AND ?
          ${clientFilter.sql}
      ) sales_docs
      LEFT JOIN (
        SELECT
          l.entetecommercial_code AS doc_code,
          SUM(CAST(COALESCE(l.quantite, '0') AS DECIMAL(15,3))) AS total_qty
        FROM lignecommercials l
        GROUP BY l.entetecommercial_code
      ) doc_quantities ON doc_quantities.doc_code = sales_docs.doc_code
      GROUP BY sales_docs.sale_date, sales_docs.client_code
      ORDER BY sales_docs.sale_date ASC, sales_docs.client_code ASC
    `,
    [salesDateFrom, salesDateTo, ...clientFilter.params]
  )

  const salesByDateClient = new Map()
  ;(salesRows || []).forEach(row => {
    const salesKey = `${normalizeDateOnly(row.sale_date)}::${normalizeExactClientCode(row.client_code)}`
    salesByDateClient.set(salesKey, {
      actualDocCount: Number(row.actual_doc_count || 0),
      actualSaleAmount: Number(row.actual_sale_amount || 0),
      actualSaleQty: Number(row.actual_sale_qty || 0)
    })
  })

  let checkedRows = 0
  let purchasedRows = 0
  let zeroSaleRows = 0

  for (const row of eligibleRows) {
    const rowDate = normalizeDateOnly(row.feedback_date)
    const salesKey = `${rowDate}::${normalizeExactClientCode(row.client_code)}`
    const actualSales = salesByDateClient.get(salesKey) || null

    const actualDocCount = Math.max(0, Number(actualSales?.actualDocCount || 0))
    const actualSaleAmount = Number(actualSales?.actualSaleAmount || 0)
    const actualSaleQty = Number(actualSales?.actualSaleQty || 0)
    const actualPurchaseFlag = actualDocCount > 0 || actualSaleAmount > 0 || actualSaleQty > 0 ? 1 : 0

    await queryAsync(
      `UPDATE ia_prediction_feedback
       SET
         actual_sale_amount = ?,
         actual_sale_qty = ?,
         actual_purchase_flag = ?,
         actual_doc_count = ?,
         actual_checked_at = NOW()
       WHERE id = ?`,
      [
        Number(actualSaleAmount.toFixed(3)),
        Number(actualSaleQty.toFixed(3)),
        actualPurchaseFlag,
        actualDocCount,
        row.id
      ]
    )

    checkedRows += 1
    if (actualPurchaseFlag) purchasedRows += 1
    else zeroSaleRows += 1
  }

  console.log(
    `[${logPrefix}] Reconciliation ventes -> rows=${checkedRows} purchased=${purchasedRows} zero=${zeroSaleRows} sales=${salesRows.length}`
  )

  return {
    requestedRows: feedbackRows.length,
    checkedRows,
    purchasedRows,
    zeroSaleRows,
    skippedRows,
    sourceSalesRows: salesRows.length,
    skipped: false,
    reason: null,
    range: {
      from: salesDateFrom,
      to: salesDateTo
    }
  }
}

async function fetchLoggedAiPredictions(requestPayload, loggingContext = {}) {
  const purchaseCacheKey = COVERAGE_PURCHASE_CACHE_ENABLED
    ? buildCoveragePurchaseCacheKey({
        requestPayload,
        cacheContext: loggingContext?.cacheContext || {}
      })
    : ''
  const cacheKey = purchaseCacheKey || buildPredictionRequestCacheKey(requestPayload)
  const now = Date.now()

  if (purchaseCacheKey) {
    const cachedData = await coveragePurchasePredictionCache.getOrCreate({
      key: purchaseCacheKey,
      type: 'purchase_predictions',
      build: async () => {
        const response = await axios.post('http://127.0.0.1:5001/api/predict', requestPayload)
        return response?.data || null
      }
    })

    return {
      response: { data: cachedData },
      loggingResult: {
        runCode: cachedData?.prediction_run_code || null,
        sourceContext: loggingContext.sourceContext || null
      },
      cacheStatus: 'persistent'
    }
  }

  if (aiPredictionRequestCache.size > 200) {
    pruneExpiredPredictionCache(now)
  }

  if (cacheKey) {
    const cachedEntry = aiPredictionRequestCache.get(cacheKey)
    if (cachedEntry?.data && Number(cachedEntry.expiresAt || 0) > now) {
      return {
        response: { data: cachedEntry.data },
        loggingResult: {
          runCode: cachedEntry.data?.prediction_run_code || null,
          sourceContext: loggingContext.sourceContext || null
        },
        cacheStatus: 'hit'
      }
    }

    if (cachedEntry?.pending) {
      const sharedResponse = await cachedEntry.pending
      return {
        response: sharedResponse,
        loggingResult: {
          runCode: sharedResponse?.data?.prediction_run_code || null,
          sourceContext: loggingContext.sourceContext || null
        },
        cacheStatus: 'shared'
      }
    }
  }

  const pendingResponse = axios.post('http://127.0.0.1:5001/api/predict', requestPayload)
    .then(response => {
      if (cacheKey) {
        aiPredictionRequestCache.set(cacheKey, {
          data: response?.data || null,
          expiresAt: Date.now() + AI_PREDICTION_CACHE_TTL_MS,
          pending: null
        })
      }
      return response
    })
    .catch(error => {
      if (cacheKey) {
        aiPredictionRequestCache.delete(cacheKey)
      }
      throw error
    })

  if (cacheKey) {
    aiPredictionRequestCache.set(cacheKey, {
      data: null,
      expiresAt: now + AI_PREDICTION_CACHE_TTL_MS,
      pending: pendingResponse
    })
  }

  const response = await pendingResponse
  return {
    response,
    loggingResult: {
      runCode: response?.data?.prediction_run_code || null,
      sourceContext: loggingContext.sourceContext || null
    },
    cacheStatus: 'miss'
  }
}

async function reloadIaModelsFromFlask({ expected_model_version = null, action = 'promote' } = {}) {
  const response = await axios.post('http://127.0.0.1:5001/api/reload-models', {
    expected_model_version,
    action
  }, {
    timeout: 120000
  })

  if (response.status !== 200 || response.data?.status !== 'success') {
    throw new Error(response.data?.message || 'Reload IA Flask impossible.')
  }

  return response.data
}

async function fetchIaModelStatusFromFlask() {
  const response = await axios.get('http://127.0.0.1:5001/api/model-status', {
    timeout: 30000
  })

  if (response.status !== 200 || response.data?.status !== 'success') {
    throw new Error(response.data?.message || 'Statut IA Flask indisponible.')
  }

  return response.data
}

async function invalidateSalesLearningModelDependentCaches({
  action = 'promote',
  previous_model_version = null,
  current_model_version = null
} = {}) {
  const aiPredictionRequestEntriesBefore = aiPredictionRequestCache.size
  aiPredictionRequestCache.clear()

  const coveragePurchaseMemoryEntriesBefore = coveragePurchasePredictionCache.entries?.size || 0
  if (typeof coveragePurchasePredictionCache.clearMemory === 'function') {
    coveragePurchasePredictionCache.clearMemory()
  }

  let coveragePurchaseDiskClear = null
  if (COVERAGE_PURCHASE_CACHE_ENABLED) {
    coveragePurchaseDiskClear = clearCacheDirectory(COVERAGE_PURCHASE_CACHE_DIR)
  }

  const nextBestVisitCacheClear = clearNextBestVisitModelDependentCaches()

  return {
    status: 'cleared',
    action,
    previous_model_version: previous_model_version || null,
    current_model_version: current_model_version || null,
    cleared_caches: [
      'ai_prediction_request_cache',
      'coverage_purchase_prediction_cache_memory',
      'coverage_purchase_prediction_cache_disk',
      'next_best_visit_plan_cache'
    ],
    ai_prediction_request_entries_before: aiPredictionRequestEntriesBefore,
    ai_prediction_request_entries_after: aiPredictionRequestCache.size,
    coverage_purchase_prediction_cache_memory_before: coveragePurchaseMemoryEntriesBefore,
    coverage_purchase_prediction_cache_memory_after: coveragePurchasePredictionCache.entries?.size || 0,
    coverage_purchase_prediction_cache_disk: coveragePurchaseDiskClear,
    next_best_visit_cache: nextBestVisitCacheClear
  }
}

async function runAutomaticSalesLearningCycle({
  force = false,
  trigger = 'automatic'
} = {}) {
  const result = await startAutomaticSalesLearningCycle({
    queryAsync,
    baseDir: __dirname,
    force,
    trigger,
    reloadPredictionService: reloadIaModelsFromFlask,
    fetchPredictionServiceStatus: fetchIaModelStatusFromFlask,
    invalidateModelDependentCaches: invalidateSalesLearningModelDependentCaches
  })

  const status = String(result?.status || '').trim()
  if (status === 'promoted' || status === 'successful') {
    console.log(`Sales V2 automatic learning promoted a new model (${result?.current_model?.model_version || 'unknown'}).`)
  } else if (status === 'current_kept' || status === 'current_retained' || status === 'insufficient_evidence') {
    console.log(`Sales V2 automatic learning kept current model (${result?.current_model?.model_version || 'unknown'}).`)
  } else if (status === 'waiting_for_feedback') {
    console.log('Sales V2 automatic learning waiting for new valid feedback.')
  } else if (status === 'failed') {
    console.warn(`Sales V2 automatic learning cycle failed: ${result?.error || result?.message || 'unknown_error'}`)
  }

  return result
}

function startSalesLearningAutomaticCycleScheduler() {
  if (!SALES_V2_AUTO_LEARNING_ENABLED || salesLearningAutoSchedulerStarted) {
    return
  }

  salesLearningAutoSchedulerStarted = true
  console.log(`Sales V2 automatic learning scheduler enabled (interval=${SALES_V2_AUTO_LEARNING_CHECK_INTERVAL_MS}ms, startup_delay=${SALES_V2_AUTO_LEARNING_STARTUP_DELAY_MS}ms).`)

  setTimeout(() => {
    runAutomaticSalesLearningCycle({
      trigger: 'startup'
    }).catch(error => {
      console.error('Sales V2 automatic learning startup cycle failed:', error.message || String(error))
    })
  }, SALES_V2_AUTO_LEARNING_STARTUP_DELAY_MS)

  setInterval(() => {
    runAutomaticSalesLearningCycle({
      trigger: 'interval'
    }).catch(error => {
      console.error('Sales V2 automatic learning interval cycle failed:', error.message || String(error))
    })
  }, SALES_V2_AUTO_LEARNING_CHECK_INTERVAL_MS)
}

async function fetchAiPredictionsForClientBatch({
  targetDate,
  clientCodes = []
}) {
  const normalizedClientCodes = [...new Set(
    (Array.isArray(clientCodes) ? clientCodes : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )]

  const response = await axios.post('http://127.0.0.1:5001/api/predict-client-batch', {
    date: targetDate,
    target_date: targetDate,
    client_codes: normalizedClientCodes
  }, {
    timeout: 180000
  })

  return response?.data || {}
}

async function fetchOrToolsCoveragePlan(requestPayload) {
  return axios.post('http://127.0.0.1:5001/api/optimize-coverage', requestPayload, {
    timeout: 180000
  })
}

async function tableExists(tableName, connection = null) {
  const rows = await queryAsync(
    `
      SELECT 1
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      LIMIT 1
    `,
    [DB_CONFIG.database, tableName],
    connection
  )
  return rows.length > 0
}

async function columnExists(tableName, columnName, connection = null) {
  const rows = await queryAsync(
    `
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [DB_CONFIG.database, tableName, columnName],
    connection
  )
  return rows.length > 0
}

async function indexExists(tableName, indexName, connection = null) {
  const rows = await queryAsync(
    `
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1
    `,
    [DB_CONFIG.database, tableName, indexName],
    connection
  )
  return rows.length > 0
}

async function ensureTableColumn(tableName, columnName, definition, connection = null) {
  if (!await tableExists(tableName, connection)) return false
  if (await columnExists(tableName, columnName, connection)) return false

  await queryAsync(
    `ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`,
    [],
    connection
  )
  return true
}

async function ensureTableIndex(tableName, indexName, definition, connection = null) {
  if (!await tableExists(tableName, connection)) return false
  if (await indexExists(tableName, indexName, connection)) return false

  await queryAsync(
    `ALTER TABLE \`${tableName}\` ADD ${definition}`,
    [],
    connection
  )
  return true
}

async function fetchOrToolsCoverageAnalysis(requestPayload) {
  return axios.post('http://127.0.0.1:5001/api/analyze-coverage', requestPayload, {
    timeout: 120000
  })
}

const COVERAGE_AUTO_PERIOD_LIMIT_DAYS = 180
const COVERAGE_MIN_SPARE_VISITS = 1
const COVERAGE_MAX_SOLVER_RETRIES = 1
const DEFAULT_COVERAGE_SERVICE_MINUTES = 12

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : []
  const safeConcurrency = Math.max(1, Math.min(Number(concurrency || 1), list.length || 1))
  const results = new Array(list.length)
  let nextIndex = 0

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex
      nextIndex += 1

      if (currentIndex >= list.length) {
        return
      }

      results[currentIndex] = await worker(list[currentIndex], currentIndex)
    }
  }

  await Promise.all(
    Array.from({ length: safeConcurrency }, () => runWorker())
  )

  return results
}

function buildCoverageOptimizerSlots(workingDays, commercials, totalClients, minVisits, maxVisits, capacityProfiles = new Map()) {
  const safeMinVisits = Math.max(1, Number(minVisits || 1))
  const safeMaxVisits = Math.max(safeMinVisits, Number(maxVisits || safeMinVisits))
  const slots = []

  workingDays.forEach(day => {
    commercials.forEach(commercial => {
      const commercialCode = String(commercial.value || '').trim()
      const capacity = resolveCommercialCapacityForDay(
        capacityProfiles.get(commercialCode) || null,
        day.dayIndex,
        safeMaxVisits
      )

      const historicalCap = Math.max(0, Number(capacity.historicalClientCapacity || 0))
      const loadUnitsPerClient = Math.max(1, Number(capacity.loadUnitsPerClient || 0) || 1)
      const hardMaxClients = safeMaxVisits

      slots.push({
        id: `${day.date}::${commercialCode}`,
        date: day.date,
        day_label: day.label,
        day_index: day.dayIndex,
        commercial_code: commercialCode,
        commercial_label: commercial.label,
        requested_max_clients: safeMaxVisits,
        hard_max_clients: hardMaxClients,
        historical_max_clients: historicalCap > 0 ? historicalCap : null,
        max_truck_units: null,
        truck_bound_client_capacity: null,
        route_capacity_hint: null,
        capacity_has_signal: false,
        client_capacity_source: 'requested_constraints',
        truck_capacity_source: 'disabled_for_exact_planner',
        load_units_per_client: roundScore(loadUnitsPerClient)
      })
    })
  })

  return slots
}

function buildCoverageCapacityWindow(startDate, periodDays, commercials, totalClients, minVisits, maxVisits, capacityProfiles = new Map()) {
  const workingDays = buildWorkingDays(startDate, periodDays)
  const slots = buildCoverageOptimizerSlots(
    workingDays,
    commercials,
    totalClients,
    minVisits,
    maxVisits,
    capacityProfiles
  )
  const safeTotalClients = Math.max(0, Number(totalClients || 0))
  const totalPotentialBlocks = workingDays.length * commercials.length
  const minimumRequiredBlocks = safeTotalClients > 0
    ? Math.ceil(safeTotalClients / Math.max(1, maxVisits || 1))
    : 0
  const maximumUsableBlocks = safeTotalClients > 0
    ? Math.min(totalPotentialBlocks, Math.floor(safeTotalClients / Math.max(1, minVisits || 1)))
    : 0
  const requiredAverageVisitsPerBlock = minimumRequiredBlocks > 0
    ? Math.ceil(safeTotalClients / minimumRequiredBlocks)
    : 0
  const totalRequestedCapacity = totalPotentialBlocks * Math.max(1, maxVisits || 1)
  const totalOperationalCapacity = totalRequestedCapacity
  const totalHistoricalCapacity = slots.reduce(
    (sum, slot) => sum + Math.max(0, Number(slot.historical_max_clients || 0)),
    0
  )
  const totalTruckCapacityUnits = 0
  const maxOperationalBlockCapacity = slots.reduce(
    (max, slot) => Math.max(max, Number(slot.hard_max_clients || 0)),
    0
  )
  const coverageSafetyBufferVisits = safeTotalClients > 0 ? COVERAGE_MIN_SPARE_VISITS : 0

  return {
    startDate,
    periodDays,
    workingDays,
    slots,
    totalClients: safeTotalClients,
    totalPotentialBlocks,
    minimumRequiredBlocks,
    maximumUsableBlocks,
    requiredAverageVisitsPerBlock,
    totalRequestedCapacity,
    totalOperationalCapacity,
    totalHistoricalCapacity,
    totalTruckCapacityUnits,
    maxOperationalBlockCapacity,
    coverageSafetyBufferVisits,
    requestedFullCoverageImpossible: safeTotalClients > totalRequestedCapacity,
    operationalFullCoverageImpossible: safeTotalClients > totalOperationalCapacity,
    operationalCoverageBufferImpossible: totalOperationalCapacity < (safeTotalClients + coverageSafetyBufferVisits),
    requestedShortfall: Math.max(0, safeTotalClients - totalRequestedCapacity),
    operationalShortfall: Math.max(0, safeTotalClients - totalOperationalCapacity)
  }
}

function resolveCoveragePlanningWindow({
  startDate,
  requestedPeriodDays,
  seedPeriodDays = requestedPeriodDays,
  commercials,
  totalClients,
  minVisits,
  maxVisits,
  capacityProfiles = new Map(),
  maxSearchPeriodDays = COVERAGE_AUTO_PERIOD_LIMIT_DAYS,
  allowAutoExtension = true
}) {
  const safeRequestedPeriodDays = Math.max(1, Number(requestedPeriodDays || 1))
  const safeMaxSearchPeriodDays = Math.max(
    safeRequestedPeriodDays,
    Number(maxSearchPeriodDays || safeRequestedPeriodDays)
  )
  const requestedWindow = buildCoverageCapacityWindow(
    startDate,
    safeRequestedPeriodDays,
    commercials,
    totalClients,
    minVisits,
    maxVisits,
    capacityProfiles
  )

  const safeSeedPeriodDays = Math.max(
    safeRequestedPeriodDays,
    Math.min(safeMaxSearchPeriodDays, Number(seedPeriodDays || safeRequestedPeriodDays))
  )
  let currentPeriodDays = safeSeedPeriodDays
  let effectiveWindow = currentPeriodDays === safeRequestedPeriodDays
    ? requestedWindow
    : buildCoverageCapacityWindow(
        startDate,
        currentPeriodDays,
        commercials,
        totalClients,
        minVisits,
        maxVisits,
        capacityProfiles
      )

  while (
    allowAutoExtension &&
    effectiveWindow.operationalCoverageBufferImpossible &&
    currentPeriodDays < safeMaxSearchPeriodDays
  ) {
    currentPeriodDays += 1
    effectiveWindow = buildCoverageCapacityWindow(
      startDate,
      currentPeriodDays,
      commercials,
      totalClients,
      minVisits,
      maxVisits,
      capacityProfiles
    )
  }

  return {
    requestedWindow,
    effectiveWindow,
    periodWasExtended: currentPeriodDays > safeRequestedPeriodDays,
    maxSearchPeriodDays: safeMaxSearchPeriodDays,
    extensionLimitReached: effectiveWindow.operationalFullCoverageImpossible,
    recommendedPeriodDays: effectiveWindow.operationalFullCoverageImpossible
      ? null
      : currentPeriodDays
  }
}

async function fetchCommercialOptions() {
  const now = Date.now()
  if (commercialOptionsCache.data !== null && commercialOptionsCache.expiresAt > now) {
    return commercialOptionsCache.data
  }

  if (commercialOptionsCache.pending) {
    return commercialOptionsCache.pending
  }

  commercialOptionsCache.pending = (async () => {
    const rows = await queryAsync(`
      SELECT
        u.code AS commercial,
        NULLIF(TRIM(CONCAT(COALESCE(u.prenom, ''), ' ', COALESCE(u.nom, ''))), '') AS full_name
      FROM users u
      WHERE u.isactif = 1
        AND COALESCE(u.isadmin, 0) = 0
        AND u.deleted_at IS NULL
        AND u.role_code = 'commercial'
        AND u.type IN ('prevendeur', 'cashvan', 'cashvan_livreur')
        AND u.code IS NOT NULL
        AND u.code <> ''
        AND EXISTS (
          SELECT 1
          FROM clients c
          WHERE c.user_code = u.code
            AND c.deleted_at IS NULL
            AND c.isactif = '1'
            AND EXISTS (
              SELECT 1
              FROM entetecommercials e
              WHERE e.client_code = c.code
                AND e.deleted_at IS NULL
                AND e.type IN ('facture', 'bl', 'blf')
                AND (
                  e.commercial_code = u.code
                  OR e.user_code = u.code
                )
            )
        )
      ORDER BY COALESCE(u.ordre, 999999), u.code
    `)

    const data = (rows || [])
      .map(row => {
        const value = String(row.commercial || '').trim()
        const fullName = String(row.full_name || '').trim()
        return {
          value,
          label: fullName ? `${fullName} (${value})` : `Commercial ${value}`
        }
      })
      .filter(item => item.value)

    commercialOptionsCache.data = data
    commercialOptionsCache.expiresAt = Date.now() + COMMERCIAL_OPTIONS_CACHE_TTL_MS

    return data
  })()

  try {
    return await commercialOptionsCache.pending
  } finally {
    commercialOptionsCache.pending = null
  }
}

function resolveCoverageClientScope({
  selectedCommercialCodes = [],
  selectedClientIds = [],
  availableCommercialCodes = []
} = {}) {
  const normalizedSelectedCommercialCodes = [...new Set(
    (Array.isArray(selectedCommercialCodes) ? selectedCommercialCodes : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )]
  const normalizedSelectedClientIds = [...new Set(
    (Array.isArray(selectedClientIds) ? selectedClientIds : [])
      .map(value => normalizeClientId(value))
      .filter(Boolean)
  )]
  const normalizedAvailableCommercialCodes = [...new Set(
    (Array.isArray(availableCommercialCodes) ? availableCommercialCodes : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )]
  const selectedCommercialSet = new Set(normalizedSelectedCommercialCodes)
  const selectedClientIdSet = new Set(normalizedSelectedClientIds)
  const allCommercialsSelected = normalizedSelectedCommercialCodes.length === 0 || (
    normalizedAvailableCommercialCodes.length > 0 &&
    normalizedSelectedCommercialCodes.length === normalizedAvailableCommercialCodes.length
  )
  const commercialFilterApplied = !allCommercialsSelected && selectedCommercialSet.size > 0
  const explicitClientIdsApplied = selectedClientIdSet.size > 0
  let mode = 'all_active_clients'

  if (commercialFilterApplied && explicitClientIdsApplied) {
    mode = 'specific_commercial_with_client_ids'
  } else if (commercialFilterApplied) {
    mode = 'specific_commercial'
  } else if (explicitClientIdsApplied) {
    mode = 'explicit_client_ids'
  }

  return {
    mode,
    selectedCommercialCodes: normalizedSelectedCommercialCodes,
    selectedCommercialSet,
    selectedCommercialCodesCount: allCommercialsSelected
      ? normalizedAvailableCommercialCodes.length
      : normalizedSelectedCommercialCodes.length,
    selectedClientIds: normalizedSelectedClientIds,
    selectedClientIdSet,
    explicitClientIdsApplied,
    allCommercialsSelected,
    commercialFilterApplied,
    client_filter_applied: commercialFilterApplied || explicitClientIdsApplied
  }
}

function buildCoverageClientScopePayload(clientScope = null, activeClientsCount = 0) {
  const scope = clientScope && typeof clientScope === 'object' ? clientScope : {}
  return {
    mode: String(scope.mode || 'all_active_clients'),
    active_clients_count: Math.max(0, Number(activeClientsCount || 0) || 0),
    selected_commercial_codes_count: Math.max(0, Number(scope.selectedCommercialCodesCount || 0) || 0),
    client_filter_applied: Boolean(scope.client_filter_applied)
  }
}

function filterCoverageClientsByScope(clients = [], clientScope = null) {
  const scope = clientScope && typeof clientScope === 'object' ? clientScope : resolveCoverageClientScope()
  const list = Array.isArray(clients) ? clients : []

  return list
    .filter(client => (
      scope.selectedClientIdSet.size === 0 ||
      scope.selectedClientIdSet.has(normalizeClientId(client?.client_id))
    ))
    .filter(client => (
      !scope.commercialFilterApplied ||
      scope.selectedCommercialSet.has(String(client?.resolved_commercial_code || '').trim())
    ))
}

async function countCoverageActiveClientsLight({
  selectedCommercialCodes = [],
  selectedClientIds = [],
  availableCommercialCodes = [],
  clientScope = null,
  queryImpl = queryAsync
} = {}) {
  const resolvedClientScope = clientScope && typeof clientScope === 'object'
    ? clientScope
    : resolveCoverageClientScope({
        selectedCommercialCodes,
        selectedClientIds,
        availableCommercialCodes
      })
  const whereClauses = [
    'c.deleted_at IS NULL',
    "c.isactif = '1'"
  ]
  const params = []
  const clientAlias = 'c'
  const visitAlias = 'client_visit_activity_light'
  const documentAlias = 'client_doc_activity_light'
  const joins = []

  if (resolvedClientScope.commercialFilterApplied) {
    joins.push(buildCoverageClientVisitActivityJoin(clientAlias, visitAlias))
    joins.push(buildCoverageClientDocumentActivityJoin(clientAlias, documentAlias))
    const resolvedCommercialExpression = buildCoverageClientResolvedCommercialExpression({
      clientAlias,
      visitAlias,
      documentAlias
    })
    const placeholders = resolvedClientScope.selectedCommercialCodes.map(() => '?').join(', ')
    whereClauses.push(`TRIM(COALESCE(${resolvedCommercialExpression}, '')) IN (${placeholders})`)
    params.push(...resolvedClientScope.selectedCommercialCodes)
  }

  if (resolvedClientScope.selectedClientIdSet.size > 0) {
    const placeholders = [...resolvedClientScope.selectedClientIdSet].map(() => '?').join(', ')
    whereClauses.push(`CAST(c.id AS CHAR) IN (${placeholders})`)
    params.push(...resolvedClientScope.selectedClientIdSet)
  }

  const rows = await queryImpl(
    `
      SELECT COUNT(DISTINCT c.id) AS active_clients_count
      FROM clients c
      ${joins.join('\n      ')}
      WHERE ${whereClauses.join('\n        AND ')}
    `,
    params
  )

  return Number(rows?.[0]?.active_clients_count || 0)
}

function buildCoverageClientVisitActivityJoin(clientAlias = 'c', activityAlias = 'client_visit_activity') {
  return `
    LEFT JOIN (
      SELECT
        latest_visits.client_code,
        SUBSTRING_INDEX(
          GROUP_CONCAT(
            latest_visits.commercial_code
            ORDER BY latest_visits.activity_date DESC, latest_visits.visit_id DESC SEPARATOR ','
          ),
          ',',
          1
        ) AS commercial_code
      FROM (
        SELECT
          TRIM(v.client_code) AS client_code,
          TRIM(v.commercial_code) AS commercial_code,
          DATE(v.check_in_at) AS activity_date,
          v.id AS visit_id
        FROM client_visits v
        WHERE v.validation_status = 'validated'
          AND v.check_in_at IS NOT NULL
          AND TRIM(COALESCE(v.client_code, '')) <> ''
          AND TRIM(COALESCE(v.commercial_code, '')) <> ''
      ) latest_visits
      GROUP BY latest_visits.client_code
    ) ${activityAlias} ON ${activityAlias}.client_code = TRIM(${clientAlias}.code)
  `
}

function buildCoverageClientDocumentActivityJoin(clientAlias = 'c', activityAlias = 'client_doc_activity') {
  return `
    LEFT JOIN (
      SELECT
        latest_docs.client_code,
        SUBSTRING_INDEX(
          GROUP_CONCAT(
            latest_docs.commercial_code
            ORDER BY latest_docs.activity_date DESC, latest_docs.document_code DESC SEPARATOR ','
          ),
          ',',
          1
        ) AS commercial_code
      FROM (
        SELECT
          TRIM(e.client_code) AS client_code,
          COALESCE(NULLIF(TRIM(e.commercial_code), ''), NULLIF(TRIM(e.user_code), '')) AS commercial_code,
          DATE(e.date) AS activity_date,
          e.code AS document_code
        FROM entetecommercials e
        WHERE e.deleted_at IS NULL
          AND e.type IN ('facture', 'bl', 'blf')
          AND TRIM(COALESCE(e.client_code, '')) <> ''
          AND COALESCE(NULLIF(TRIM(e.commercial_code), ''), NULLIF(TRIM(e.user_code), '')) IS NOT NULL
      ) latest_docs
      GROUP BY latest_docs.client_code
    ) ${activityAlias} ON ${activityAlias}.client_code = TRIM(${clientAlias}.code)
  `
}

function buildCoverageClientResolvedCommercialExpression({
  clientAlias = 'c',
  visitAlias = 'client_visit_activity',
  documentAlias = 'client_doc_activity'
} = {}) {
  return `COALESCE(
    NULLIF(TRIM(${clientAlias}.user_code), ''),
    NULLIF(TRIM(${visitAlias}.commercial_code), ''),
    NULLIF(TRIM(${documentAlias}.commercial_code), '')
  )`
}

async function resolveDepotOrigin(route, commercial) {
  if (!route) {
    return getSharedDepotOrigin(route, commercial)
  }

  try {
    const rows = await queryAsync(
      `SELECT code, depot_code FROM routings WHERE code = ? LIMIT 1`,
      [route]
    )

    const routing = rows[0]
    if (!routing || !routing.depot_code) {
      return getSharedDepotOrigin(route, commercial)
    }

    const depotRows = await queryAsync(
      `SELECT code, nom, latitude, longitude, adresse
       FROM depots
       WHERE code = ? AND actif = 1
       LIMIT 1`,
      [routing.depot_code]
    )

    const depot = depotRows[0]
    if (depot && Number.isFinite(Number(depot.latitude)) && Number.isFinite(Number(depot.longitude))) {
      return buildDepotOrigin(depot, route, commercial, routing.depot_code)
    }

    const depotConfig = DEPOT_COORDS_BY_CODE[routing.depot_code]
    if (depotConfig) {
      return buildDepotOrigin(depotConfig, route, commercial, routing.depot_code)
    }

    return getSharedDepotOrigin(route, commercial, routing.depot_code)
  } catch (error) {
    console.error('Impossible de resoudre le depot de la route:', error.message)
    return getSharedDepotOrigin(route, commercial)
  }
}

function splitClientObjective(sortedClients, maxClients, targetChiffre) {
  const hasMaxClients = Number.isFinite(maxClients) && maxClients > 0
  const cappedClients = hasMaxClients ? sortedClients.slice(0, maxClients) : [...sortedClients]
  if (!targetChiffre || targetChiffre <= 0) {
    return {
      selected: cappedClients,
      suggestions: hasMaxClients ? sortedClients.slice(maxClients) : []
    }
  }

  const selected = []
  let cumulativeChiffre = 0

  for (const client of cappedClients) {
    selected.push(client)
    cumulativeChiffre += Number(client.chiffre_brut || 0)
    if (cumulativeChiffre >= targetChiffre) {
      break
    }
  }

  return {
    selected,
    suggestions: [
      ...cappedClients.slice(selected.length),
      ...(hasMaxClients ? sortedClients.slice(maxClients) : [])
    ]
  }
}

const FRENCH_DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi']

function parseLocalDate(value) {
  if (!value) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return today
  }

  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number)
  const parsed = new Date(year, (month || 1) - 1, day || 1)
  parsed.setHours(0, 0, 0, 0)
  return parsed
}

function formatLocalDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeDateOnly(value) {
  if (!value) return ''

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatLocalDate(value)
  }

  const rawValue = String(value).trim()
  if (!rawValue) return ''

  const isoMatch = rawValue.match(/^(\d{4}-\d{2}-\d{2})/)
  if (isoMatch) {
    return isoMatch[1]
  }

  const parsed = new Date(rawValue)
  if (!Number.isNaN(parsed.getTime())) {
    return formatLocalDate(parsed)
  }

  return ''
}

function addLocalDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  next.setHours(0, 0, 0, 0)
  return next
}

function resolveFrenchDayLabel(dateValue, fallbackLabel = null) {
  const parsed = parseLocalDate(dateValue)
  const computed = FRENCH_DAY_NAMES[parsed.getDay()]
  return FRENCH_DAY_NAMES.includes(fallbackLabel) ? fallbackLabel : computed
}

function buildWorkingDays(startDateValue, periodDays) {
  const startDate = parseLocalDate(startDateValue)
  const days = []

  for (let offset = 0; offset < periodDays; offset += 1) {
    const current = addLocalDays(startDate, offset)

    days.push({
      date: formatLocalDate(current),
      dayIndex: current.getDay(),
      label: FRENCH_DAY_NAMES[current.getDay()]
    })
  }

  return days
}

function parseBooleanFlag(rawValue, defaultValue = false) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return defaultValue
  }

  if (typeof rawValue === 'boolean') {
    return rawValue
  }

  const normalized = String(rawValue).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return defaultValue
}

function parseWorkingDaySelection(rawValue) {
  const fallbackDays = [0, 1, 2, 3, 4, 5, 6]
  const list = Array.isArray(rawValue)
    ? rawValue
    : typeof rawValue === 'string' && rawValue.trim()
      ? rawValue.split(',')
      : []

  const normalizedDays = [...new Set(
    list
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isFinite(value) && value >= 0 && value <= 6)
  )].sort((a, b) => a - b)

  return normalizedDays.length ? normalizedDays : fallbackDays
}

function parseCoverageAvailabilityPayload(rawValue) {
  if (!rawValue) return {}
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    return rawValue
  }

  if (typeof rawValue === 'string') {
    try {
      const parsed = JSON.parse(rawValue)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      return {}
    }
  }

  return {}
}

function normalizeCoverageDateList(values = []) {
  if (!Array.isArray(values)) return []

  return [...new Set(
    values
      .map(value => normalizeDateOnly(value))
      .filter(Boolean)
  )].sort()
}

function buildCoverageCommercialAvailability({
  planningDays,
  commercialCode,
  defaultMaxVisitsPerSlot,
  minDailyCaPerCommercial,
  rawAvailabilityEntry
}) {
  const entry = rawAvailabilityEntry && typeof rawAvailabilityEntry === 'object'
    ? rawAvailabilityEntry
    : {}
  const workingDaySet = new Set(
    (Array.isArray(entry.working_days) ? entry.working_days : [])
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isFinite(value) && value >= 0 && value <= 6)
  )
  const applicablePlanningDays = workingDaySet.size
    ? planningDays.filter(day => workingDaySet.has(day.dayIndex))
    : planningDays
  const availableDatesInput = normalizeCoverageDateList(entry.available_dates)
  const unavailableDates = new Set(normalizeCoverageDateList(entry.unavailable_dates))
  const planningDateSet = new Set(applicablePlanningDays.map(day => day.date))
  const baselineDates = availableDatesInput.length
    ? availableDatesInput.filter(date => planningDateSet.has(date))
    : applicablePlanningDays.map(day => day.date).filter(date => !unavailableDates.has(date))

  const maxVisitsByDate = {}
  const hardMaxVisitsByDate = {}
  const minCaByDate = {}
  const maxLoadUnitsByDate = {}
  baselineDates.forEach(date => {
    const rawMaxVisits = entry.max_visits_by_date?.[date]
    const parsedMaxVisits = Number.parseInt(rawMaxVisits, 10)
    maxVisitsByDate[date] = Number.isFinite(parsedMaxVisits) && parsedMaxVisits > 0
      ? Math.min(250, parsedMaxVisits)
      : defaultMaxVisitsPerSlot

    const rawHardMaxVisits = entry.hard_max_visits_by_date?.[date] ?? entry.max_visits_hard_by_date?.[date]
    const parsedHardMaxVisits = Number.parseInt(rawHardMaxVisits, 10)
    if (Number.isFinite(parsedHardMaxVisits) && parsedHardMaxVisits > 0) {
      hardMaxVisitsByDate[date] = Math.min(250, parsedHardMaxVisits)
    }

    const rawMinCa = Number(entry.min_ca_by_date?.[date])
    minCaByDate[date] = Number.isFinite(rawMinCa) && rawMinCa > 0
      ? roundScore(rawMinCa)
      : roundScore(minDailyCaPerCommercial)

    const rawMaxLoadUnits = Number(
      entry.max_load_units_by_date?.[date] ??
      entry.hard_max_load_units_by_date?.[date]
    )
    if (Number.isFinite(rawMaxLoadUnits) && rawMaxLoadUnits > 0) {
      maxLoadUnitsByDate[date] = roundScore(rawMaxLoadUnits)
    }
  })

  return {
    commercialCode,
    availableDates: baselineDates,
    maxVisitsByDate,
    hardMaxVisitsByDate,
    minCaByDate,
    maxLoadUnitsByDate
  }
}

function assertCoverageConstraintPayload(payload = {}) {
  const commercials = Array.isArray(payload.commercials) ? payload.commercials : []
  const clients = Array.isArray(payload.clients) ? payload.clients : []

  commercials.forEach(commercial => {
    const availableDates = new Set(
      (Array.isArray(commercial.available_dates) ? commercial.available_dates : [])
        .map(value => normalizeDateOnly(value))
        .filter(Boolean)
    )

    Object.entries(commercial.hard_capacity_by_date || {}).forEach(([dateKey, value]) => {
      const dateIso = normalizeDateOnly(dateKey)
      if (!dateIso || !Number.isFinite(Number(value)) || Number(value) <= 0) return
      if (!availableDates.has(dateIso)) {
        throw new Error(`Coverage hard capacity references unavailable slot ${commercial.code || commercial.commercial_code}:${dateIso}.`)
      }
      if (!commercial.hard_capacity_known_by_date?.[dateIso]) {
        throw new Error(`Coverage hard capacity is missing hard_capacity_known_by_date for ${commercial.code || commercial.commercial_code}:${dateIso}.`)
      }
    })

    Object.entries(commercial.max_load_units_by_date || {}).forEach(([dateKey, value]) => {
      const dateIso = normalizeDateOnly(dateKey)
      if (!dateIso || !Number.isFinite(Number(value)) || Number(value) <= 0) return
      if (!availableDates.has(dateIso)) {
        throw new Error(`Coverage truck capacity references unavailable slot ${commercial.code || commercial.commercial_code}:${dateIso}.`)
      }
    })
  })

  clients.forEach(client => {
    const allowedCommercialCodes = (Array.isArray(client.allowed_commercial_codes) ? client.allowed_commercial_codes : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
    if (allowedCommercialCodes.length === 0) {
      throw new Error(`Coverage client ${client.client_id || client.client_code || '?'} has no allowed commercial codes.`)
    }
  })
}

function assertCoverageConstraintResult(payload = {}, result = {}) {
  const slotById = new Map()
  ;(Array.isArray(payload.commercials) ? payload.commercials : []).forEach(commercial => {
    ;(Array.isArray(commercial.available_dates) ? commercial.available_dates : []).forEach(dateIso => {
      const slotId = `${dateIso}::${commercial.code}`
      slotById.set(slotId, {
        commercial_code: commercial.code,
        hard_capacity: Number(commercial.hard_capacity_by_date?.[dateIso] || 0) || 0,
        max_load_units: Number(commercial.max_load_units_by_date?.[dateIso] || 0) || 0,
        max_route_minutes: Number(commercial.max_route_minutes_by_date?.[dateIso] || 0) || 0
      })
    })
  })

  const clientById = new Map(
    (Array.isArray(payload.clients) ? payload.clients : [])
      .map(client => [String(client.client_id || '').trim(), client])
      .filter(entry => entry[0])
  )

  ;(Array.isArray(result.blocks) ? result.blocks : []).forEach(block => {
    const slotId = String(block.slot_id || '').trim()
    const slot = slotById.get(slotId)
    if (!slot) return

    const plannedClients = Array.isArray(block.clients) ? block.clients : []
    if (slot.hard_capacity > 0 && plannedClients.length > slot.hard_capacity) {
      throw new Error(`Coverage result exceeds hard capacity on ${slotId}.`)
    }

    if (slot.max_load_units > 0) {
      const plannedLoadUnits = plannedClients.reduce((sum, client) => sum + (Number(client.predicted_load_units || 0) || 0), 0)
      if (plannedLoadUnits > slot.max_load_units + 1e-9) {
        throw new Error(`Coverage result exceeds truck capacity on ${slotId}.`)
      }
    }
    const routeMinutesWithoutBreak = Number(block.time?.route_minutes_without_break || 0) || 0
    if (slot.max_route_minutes > 0 && Boolean(block.time?.time_capacity_known) && routeMinutesWithoutBreak > slot.max_route_minutes + 1e-9) {
      throw new Error(`Coverage result exceeds route time on ${slotId}.`)
    }

    plannedClients.forEach(client => {
      const clientId = String(client.client_id || '').trim()
      const payloadClient = clientById.get(clientId)
      const allowedCodes = (Array.isArray(payloadClient?.allowed_commercial_codes) ? payloadClient.allowed_commercial_codes : [])
        .map(value => String(value || '').trim())
        .filter(Boolean)
      if (allowedCodes.length && !allowedCodes.includes(slot.commercial_code)) {
        throw new Error(`Coverage result assigned forbidden commercial ${slot.commercial_code} to client ${clientId}.`)
      }
    })
  })
}

function buildCoverageRecoveryPayloadFields(profile = null) {
  const credit = profile?.credit || {}
  const paymentBehavior = profile?.payment_behavior || {}
  const recovery = profile?.recovery || {}
  const sources = profile?.sources || {}

  const totalBalance = Number(credit.total_balance)
  const dueAmount = Number(credit.due_amount)
  const daysPastDue = Number(credit.days_past_due)
  const daysSinceExpectedPayment = Number(paymentBehavior.days_since_expected_payment)
  const paymentBehaviorScore = Number(paymentBehavior.payment_behavior_score)
  const expectedCollectionAmount = Number(recovery.expected_collection_amount)
  const recoveryPriorityScore = Number(recovery.collection_priority_score)

  const recoveryDataKnown = [
    Number.isFinite(totalBalance),
    Number.isFinite(dueAmount),
    Number.isFinite(daysPastDue),
    Boolean(String(paymentBehavior.expected_next_payment_date || '').trim()),
    Number.isFinite(daysSinceExpectedPayment),
    Number.isFinite(paymentBehaviorScore),
    Number.isFinite(expectedCollectionAmount),
    Number.isFinite(recoveryPriorityScore)
  ].some(Boolean)

  const recoverySourceParts = []
  if (sources.credit) recoverySourceParts.push(`credit:${String(sources.credit).trim()}`)
  if (sources.payments) recoverySourceParts.push(`payments:${String(sources.payments).trim()}`)

  return {
    recovery_total_balance: Number.isFinite(totalBalance)
      ? roundScore(Math.max(0, totalBalance))
      : null,
    recovery_due_amount: Number.isFinite(dueAmount)
      ? roundScore(Math.max(0, dueAmount))
      : null,
    recovery_days_past_due: Number.isFinite(daysPastDue)
      ? Math.max(0, Math.round(daysPastDue))
      : null,
    recovery_expected_next_payment_date: String(paymentBehavior.expected_next_payment_date || '').trim() || null,
    recovery_days_since_expected_payment: Number.isFinite(daysSinceExpectedPayment)
      ? Math.max(0, Math.round(daysSinceExpectedPayment))
      : null,
    recovery_payment_behavior_score: Number.isFinite(paymentBehaviorScore)
      ? roundScore(Math.max(0, Math.min(100, paymentBehaviorScore)))
      : null,
    recovery_expected_collection_amount: Number.isFinite(expectedCollectionAmount)
      ? roundScore(Math.max(0, expectedCollectionAmount))
      : null,
    recovery_priority_score: Number.isFinite(recoveryPriorityScore)
      ? roundScore(Math.max(0, Math.min(100, recoveryPriorityScore)))
      : null,
    recovery_data_known: recoveryDataKnown,
    recovery_source: recoverySourceParts.length ? recoverySourceParts.join('|') : null
  }
}

async function fetchCoverageCommercialCapacityProfiles(commercialCodes = [], startDate, options = {}) {
  const normalizedCodes = [...new Set(
    (Array.isArray(commercialCodes) ? commercialCodes : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )]

  if (!normalizedCodes.length || !startDate) {
    return new Map()
  }

  const cacheKey = buildCoverageHistoryCacheKey({
    name: 'salesCapacityProfiles',
    startDate,
    historyWindowDays: COVERAGE_HISTORY_WINDOW_DAYS,
    commercialCodes: normalizedCodes,
    documentFilters: COVERAGE_HISTORY_FILTERS_SALES_PROFILES,
    database: DB_CONFIG.database,
    logicalSchemaVersion: COVERAGE_HISTORY_SCHEMA_VERSION,
    sqlVersion: 'sales_capacity_profiles_sql_v2',
    codeVersion: COVERAGE_HISTORY_CODE_VERSION,
    dataVersion: COVERAGE_DATA_VERSION
  })

  return coverageHistoryCache.getOrCreate({
    key: cacheKey,
    type: 'sales_profiles',
    metrics: options.cacheMetrics,
    build: async () => {
      return runCoveragePerfStage(options.perfTracker, 'load_sales_profiles', async () => {
        const commercialFilter = buildInClause(
          "COALESCE(NULLIF(TRIM(e.commercial_code), ''), NULLIF(TRIM(e.user_code), ''))",
          normalizedCodes
        )

        const activityRows = await queryAsync(
          `
            SELECT
              COALESCE(NULLIF(TRIM(e.commercial_code), ''), NULLIF(TRIM(e.user_code), '')) AS commercial_code,
              DATE(e.date) AS activity_date,
              DAYOFWEEK(DATE(e.date)) - 1 AS day_index,
              COUNT(DISTINCT TRIM(e.client_code)) AS unique_clients,
              SUM(COALESCE(doc_quantities.total_quantity, 0)) AS total_quantity
            FROM entetecommercials e
            LEFT JOIN (
              SELECT
                l.entetecommercial_code AS doc_code,
                SUM(CAST(COALESCE(l.quantite, '0') AS DECIMAL(15,3))) AS total_quantity
              FROM lignecommercials l
              GROUP BY l.entetecommercial_code
            ) doc_quantities ON doc_quantities.doc_code = e.code
            WHERE e.deleted_at IS NULL
              AND e.type IN ('facture', 'bl', 'blf')
              AND COALESCE(TRIM(e.annule), '') <> '1'
              AND DATE(e.date) >= DATE_SUB(?, INTERVAL ${COVERAGE_HISTORY_WINDOW_DAYS} DAY)
              AND DATE(e.date) < ?
              ${commercialFilter.sql}
            GROUP BY commercial_code, activity_date, day_index
            ORDER BY commercial_code ASC, activity_date ASC
          `,
          [startDate, startDate, ...commercialFilter.params]
        )

        return buildCommercialCapacityProfiles(
          activityRows || [],
          [],
          COVERAGE_CAPACITY_MODE_SALES_PROXY
        )
      })
    }
  })
}

async function fetchCoverageValidatedVisitCapacityProfiles(commercialCodes = [], startDate, options = {}) {
  const normalizedCodes = [...new Set(
    (Array.isArray(commercialCodes) ? commercialCodes : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )]

  if (!normalizedCodes.length || !startDate) {
    return new Map()
  }

  const cacheKey = buildCoverageHistoryCacheKey({
    name: 'validatedVisitCapacityProfiles',
    startDate,
    historyWindowDays: COVERAGE_HISTORY_WINDOW_DAYS,
    commercialCodes: normalizedCodes,
    documentFilters: COVERAGE_HISTORY_FILTERS_VALIDATED_VISITS,
    database: DB_CONFIG.database,
    logicalSchemaVersion: COVERAGE_HISTORY_SCHEMA_VERSION,
    sqlVersion: 'validated_visit_profiles_sql_v2',
    codeVersion: COVERAGE_HISTORY_CODE_VERSION,
    dataVersion: COVERAGE_DATA_VERSION
  })

  return coverageHistoryCache.getOrCreate({
    key: cacheKey,
    type: 'validated_visit_profiles',
    metrics: options.cacheMetrics,
    build: async () => {
      return runCoveragePerfStage(options.perfTracker, 'load_validated_visits', async () => {
        const commercialFilter = buildInClause(
          "TRIM(v.commercial_code)",
          normalizedCodes
        )

        const activityRows = await queryAsync(
          `
            SELECT
              TRIM(v.commercial_code) AS commercial_code,
              DATE(v.check_in_at) AS activity_date,
              DAYOFWEEK(DATE(v.check_in_at)) - 1 AS day_index,
              COUNT(DISTINCT COALESCE(NULLIF(CAST(v.client_id AS CHAR), ''), CONCAT('code:', TRIM(v.client_code)))) AS unique_clients,
              0 AS total_quantity
            FROM client_visits v
            WHERE v.validation_status = 'validated'
              AND v.check_in_at IS NOT NULL
              AND TRIM(COALESCE(v.commercial_code, '')) <> ''
              AND DATE(v.check_in_at) >= DATE_SUB(?, INTERVAL ${COVERAGE_HISTORY_WINDOW_DAYS} DAY)
              AND DATE(v.check_in_at) < ?
              ${commercialFilter.sql}
            GROUP BY commercial_code, activity_date, day_index
            ORDER BY commercial_code ASC, activity_date ASC
          `,
          [startDate, startDate, ...commercialFilter.params]
        )

        return buildCommercialCapacityProfiles(
          activityRows || [],
          [],
          COVERAGE_CAPACITY_MODE_VALIDATED_VISIT
        )
      })
    }
  })
}

function buildCoveragePlannerMessage(result = {}) {
  if (String(result.user_message || '').trim()) {
    return String(result.user_message).trim()
  }

  const summary = result.summary || {}
  const diagnostics = result.diagnostics || {}
  const operational = result.operational || {}
  const clientsToCover = Number(summary.clients_to_cover || 0)
  const coveredClients = Number(summary.unique_clients_covered || 0)
  const missingClients = Number(summary.missing_clients_count || 0)
  const duplicateClients = Number(summary.duplicate_clients_count || 0)
  const usedSlots = Number(summary.used_slots || 0)
  const capacityMode = String(summary.capacity_mode || operational.capacity_mode || '').trim()
  const operationalCapacityKnown = Boolean(
    summary.operational_capacity_known ??
    operational.operational_capacity_known
  )

  if (!operationalCapacityKnown && capacityMode === COVERAGE_CAPACITY_MODE_SALES_PROXY) {
    return 'Le plan couvre les clients et repartit la charge selon l activite de vente historique. La faisabilite terrain reste a confirmer, car les visites reelles, les durees et les temps de trajet ne sont pas encore mesures.'
  }

  if (operational.status === 'under_tension' || operational.status === 'critical_overload') {
    return 'La couverture complete necessite une charge superieure aux capacites historiques. Consultez les commerciaux surcharges ou augmentez la periode / les ressources.'
  }

  if (result.status === 'success') {
    const notes = [
      `${coveredClients} client(s) uniques planifies sur ${usedSlots} block(s).`,
      Number(summary.total_ca_shortfall || 0) > 0
        ? `Deficit CA restant: ${Number(summary.total_ca_shortfall || 0).toFixed(1)} TND.`
        : 'Aucun deficit CA residuel.',
      diagnostics.invalid_gps_clients?.length
        ? `${diagnostics.invalid_gps_clients.length} client(s) sans GPS valide ont ete conserves dans le plan.`
        : null
    ].filter(Boolean)
    return notes.join(' ')
  }

  if (result.reason === 'insufficient_commercial_capacity') {
    return `Capacite insuffisante pour ${result.commercial || 'le commercial'}: ${result.clients_required || 0} client(s) a couvrir pour ${result.capacity || 0} visite(s) disponibles.`
  }

  if (result.reason === 'insufficient_visit_capacity') {
    return `Capacites physiques insuffisantes: ${clientsToCover} client(s) obligatoires pour ${Number(summary.total_capacity || 0)} visite(s) disponibles apres application des limites dures.`
  }

  if (result.reason === 'deadline_or_commercial_unreachable') {
    return `Au moins ${diagnostics.deadline_issues?.length || 0} client(s) ne peuvent pas etre places avant leur date limite ou sur un commercial autorise.`
  }

  if (result.reason === 'physical_slot_unreachable') {
    return 'Au moins un client depasse la capacite physique de tous les slots compatibles vendeurs/camions.'
  }

  if (result.reason === 'daily_ca_target_unreachable') {
    return 'Le CA minimum journalier par commercial est infaisable en mode strict avec les donnees actuelles.'
  }

  if (result.status === 'invalid') {
    return `Le plan retourne par le solveur est invalide: ${missingClients} manquant(s), ${duplicateClients} doublon(s).`
  }

  return result.message || "Le plan de couverture n'a pas pu etre calcule avec ces contraintes."
}

function buildCoveragePlanInputFromQuery(query = {}) {
  const normalizedCommercials = Array.isArray(query.commercials)
    ? query.commercials
    : (query.commercials ? parseCommercialSelection(query.commercials) : (
      query.commercial_codes ? parseCommercialSelection(query.commercial_codes) : undefined
    ))
  const normalizedClients = Array.isArray(query.clients)
    ? query.clients
    : (query.clients ? parseClientSelection(query.clients) : undefined)

  return {
    planning_mode: resolveCoveragePlanningMode(query.planning_mode),
    start_date: query.start_date,
    planning_start_date: query.planning_start_date,
    planning_horizon_days: query.planning_horizon_days,
    period_days: query.period_days,
    planning_days: query.planning_days,
    min_clients: query.min_clients ?? query.min_visits,
    max_clients: query.max_clients ?? query.max_visits,
    coverage_window_days: query.coverage_window_days,
    visit_frequency_days: query.visit_frequency_days || query.coverage_frequency_days,
    daily_max_mode: query.daily_max_mode,
    default_max_visits_per_slot: query.default_max_visits_per_slot || query.max_visits,
    min_daily_ca_per_commercial: query.min_daily_ca_per_commercial ?? query.min_daily_ca ?? query.min_total_ca,
    strict_ca: query.strict_ca,
    allow_commercial_reassignment: query.allow_commercial_reassignment,
    working_days: query.working_days,
    commercials: normalizedCommercials,
    commercial_codes: normalizedCommercials,
    clients: normalizedClients,
    commercial_availability: query.commercial_availability
  }
}

function parseOptionalCoverageMaxVisits(rawValue) {
  if (rawValue === '' || rawValue === null || rawValue === undefined) {
    return null
  }

  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return Math.max(1, Math.min(250, parsed))
}

function computeCoverageRecommendedMaxCapacity(clientsToCover, totalSlots) {
  const normalizedClients = Math.max(0, Number.parseInt(clientsToCover, 10) || 0)
  const normalizedSlots = Math.max(0, Number.parseInt(totalSlots, 10) || 0)
  if (normalizedClients <= 0 || normalizedSlots <= 0) {
    return 0
  }
  return Math.ceil(normalizedClients / normalizedSlots)
}

function buildCoverageBlockingReasons({
  analysisResult,
  planningContext
}) {
  const reasons = []
  const feasibility = analysisResult?.feasibility || {}
  const strictCa = analysisResult?.strict_ca || {}
  const unavailableSlotsRemoved = Math.max(
    0,
    Number(planningContext?.theoreticalTotalSlots || 0) - Number(planningContext?.totalSlots || 0)
  )

  const pushReason = (code, title, detail) => {
    if (!code || reasons.some(item => item.code === code)) return
    reasons.push({ code, title, detail })
  }

  switch (String(analysisResult?.reason || '').trim()) {
    case 'insufficient_visit_capacity':
      pushReason(
        'capacites_physiques_insuffisantes',
        'Capacites physiques insuffisantes',
        `${Number(feasibility.clients_to_cover || 0)} client(s) a couvrir pour ${Number(feasibility.configured_total_capacity || 0)} visite(s) disponibles apres application des limites dures.`
      )
      break
    case 'insufficient_commercial_capacity':
      pushReason(
        'capacite_portefeuille_fixe_insuffisante',
        'Capacite insuffisante pour un commercial ayant un portefeuille fixe',
        `${analysisResult?.feasibility?.commercial || 'Ce commercial'} doit couvrir ${Number(feasibility.clients_required || 0)} client(s), mais seulement ${Number(feasibility.capacity || 0)} visite(s) restent disponibles sur la periode.`
      )
      break
    case 'no_available_slots':
      pushReason(
        'indisponibilites_trop_nombreuses',
        'Indisponibilites trop nombreuses',
        `Aucun slot n'est disponible sur ${Number(planningContext?.activeDaysCount || 0)} jour(s) actif(s) pour les commerciaux selectionnes.`
      )
      break
    case 'deadline_or_commercial_unreachable':
      pushReason(
        unavailableSlotsRemoved > 0 ? 'indisponibilites_trop_nombreuses' : 'dates_limites_ou_portefeuille_bloquant',
        unavailableSlotsRemoved > 0 ? 'Indisponibilites trop nombreuses' : 'Dates limites ou portefeuille bloquant',
        unavailableSlotsRemoved > 0
          ? `Les indisponibilites retirent ${unavailableSlotsRemoved} slot(s), ce qui laisse certains clients sans date ou sans commercial possible avant leur echeance.`
          : `Au moins ${Array.isArray(feasibility.details) ? feasibility.details.length : 0} client(s) n'ont aucun slot compatible avant leur date limite.`
      )
      break
    case 'physical_slot_unreachable':
      pushReason(
        'contraintes_physiques_insuffisantes',
        'Contraintes physiques vendeurs/camions insuffisantes',
        Array.isArray(feasibility.details) && feasibility.details.length
          ? `Au moins ${feasibility.details.length} client(s) ont une charge previsionnelle superieure a la capacite de tous les slots compatibles.`
          : 'Au moins un client ne peut pas etre place sans depasser les capacites physiques disponibles.'
      )
      break
    default:
      break
  }

  if (strictCa.enabled && strictCa.possible === false) {
    const totalRequiredCa = Number(strictCa.total_required_ca || 0)
    const totalPossibleCa = Number(strictCa.total_possible_ca || 0)
    const strictCaIssues = Array.isArray(strictCa.issues) ? strictCa.issues.length : 0
    pushReason(
      'objectif_ca_impossible_strict',
      'Objectif CA impossible en mode strict',
      totalRequiredCa > totalPossibleCa
        ? `Le CA minimum cumule demande est de ${totalRequiredCa.toFixed(1)} TND, alors que le potentiel total disponible atteint ${totalPossibleCa.toFixed(1)} TND.`
        : `${strictCaIssues} slot(s) ne peuvent pas atteindre leur CA minimum journalier, meme avec la meilleure affectation theorique.`
    )
  }

  return reasons
}

function hasCoverageAdjustedParameters(planningContext) {
  return (
    Number(planningContext?.adjustedTargetMaxVisitsPerSlot || 0) > Number(planningContext?.requestedUserMaxVisits || 0) ||
    Number(planningContext?.normalizedUserMinVisits || 0) !== Number(planningContext?.requestedUserMinVisits || 0)
  )
}

function resolveCoverageGuaranteeStatus() {
  return 'single_visit_only'
}

function buildCoverageSingleVisitDisclaimer(planningContext) {
  const coverageWindowDays = Number(
    planningContext?.coverageWindowDays ??
    planningContext?.visitFrequencyDays ??
    DEFAULT_COVERAGE_WINDOW_DAYS
  )
  return `Ce plan repartit une visite par client sur l horizon. La couverture recurrente tous les ${coverageWindowDays} jours n est pas encore garantie.`
}

function resolveCoverageBlockEstimatedMinutes(block = {}) {
  const rawValue = (
    block?.total_estimated_minutes ??
    block?.time?.route_minutes_with_break ??
    block?.time?.route_minutes_total ??
    block?.time?.route_minutes ??
    block?.estimated_duration_minutes
  )
  const normalized = Number(rawValue)
  return Number.isFinite(normalized) ? normalized : null
}

function buildCoverageCapacityMessage(planningContext, summary = {}, blocks = []) {
  const requestedUserMaxVisits = Math.max(0, Number(planningContext?.requestedUserMaxVisits || 0))
  const capacityDeficit = Math.max(0, Number(planningContext?.capacityPrecheck?.capacity_deficit || 0))
  const missingClientsCount = Math.max(0, Number(summary?.missing_clients_count || 0))
  const blocksAboveUserMax = requestedUserMaxVisits > 0
    ? blocks.filter(block => Number(block?.over_requested_max_by || 0) > 0).length
    : 0
  const maximumBlockOverage = requestedUserMaxVisits > 0
    ? blocks.reduce((maxValue, block) => Math.max(maxValue, Number(block?.over_requested_max_by || 0)), 0)
    : 0

  if (planningContext?.dailyMaxMode === DAILY_MAX_MODE_STRICT) {
    if (missingClientsCount > 0) {
      return `Mode maximum strict: ${missingClientsCount} client(s) restent non planifies pour respecter le maximum quotidien de ${requestedUserMaxVisits} client(s).`
    }
    if (requestedUserMaxVisits > 0) {
      return `Mode maximum strict: aucun block ne depasse ${requestedUserMaxVisits} client(s).`
    }
    return 'Mode maximum strict actif.'
  }

  if (capacityDeficit > 0 && blocksAboveUserMax > 0) {
    return `La capacite demandee est insuffisante de ${capacityDeficit} visite(s). Pour couvrir les clients, ${blocksAboveUserMax} block(s) depassent le maximum demande, jusqu a +${maximumBlockOverage}.`
  }
  if (capacityDeficit > 0) {
    return `La capacite demandee est insuffisante de ${capacityDeficit} visite(s). En mode flexible, certains blocks peuvent depasser le maximum demande.`
  }
  if (requestedUserMaxVisits > 0) {
    return `Mode maximum flexible: le seuil demande reste ${requestedUserMaxVisits} client(s) par block, avec depassement autorise uniquement si necessaire.`
  }
  return 'Mode maximum flexible actif.'
}

function buildCoverageResponseMessage(result = {}, planningContext, summary = {}, blocks = []) {
  const parts = [
    buildCoveragePlannerMessage(result),
    buildCoverageCapacityMessage(planningContext, summary, blocks),
    buildCoverageSingleVisitDisclaimer(planningContext)
  ].filter(Boolean)

  return [...new Set(parts)].join(' ')
}

function buildCoverageCapacityPrecheck(planningContext) {
  const basePrecheck = planningContext?.capacityPrecheck && typeof planningContext.capacityPrecheck === 'object'
    ? planningContext.capacityPrecheck
    : {}

  return {
    active_clients_count: Number(basePrecheck.active_clients_count || planningContext?.selectedClientsCount || 0),
    required_visits_count: Number(basePrecheck.required_visits_count || planningContext?.requiredVisitsCount || 0),
    available_slots_count: Number(basePrecheck.available_slots_count || planningContext?.theoreticalTotalSlots || 0),
    available_slots_after_constraints_count: Number(basePrecheck.available_slots_after_constraints_count || planningContext?.totalSlots || 0),
    strict_capacity: Number(basePrecheck.strict_capacity || 0),
    capacity_deficit: Number(basePrecheck.capacity_deficit || 0),
    minimum_required_average: Number(basePrecheck.minimum_required_average || 0),
    minimum_required_peak_estimate: Number(basePrecheck.minimum_required_peak_estimate || 0),
    feasibility_status: String(basePrecheck.feasibility_status || 'unknown'),
    coverage_guarantee_status: resolveCoverageGuaranteeStatus(),
    planning_horizon_days: Number(planningContext?.planningHorizonDays || planningContext?.planningDays || 0),
    coverage_window_days: Number(planningContext?.coverageWindowDays || planningContext?.visitFrequencyDays || DEFAULT_COVERAGE_WINDOW_DAYS),
    daily_max_mode: String(planningContext?.dailyMaxMode || DEFAULT_DAILY_MAX_MODE)
  }
}

function decorateCoverageBlocks(blocks = [], planningContext) {
  const requestedUserMaxVisits = Math.max(0, Number(planningContext?.requestedUserMaxVisits || 0))

  return (Array.isArray(blocks) ? blocks : []).map(block => {
    const clientsCount = Number(block?.clients_count || 0)
    const totalEstimatedMinutes = resolveCoverageBlockEstimatedMinutes(block)
    const maxRouteMinutes = Number(block?.time?.max_route_minutes ?? 0)
    const workdayLimitKnown = Number.isFinite(maxRouteMinutes) && maxRouteMinutes > 0
    const exceedsWorkday = Boolean(
      workdayLimitKnown &&
      totalEstimatedMinutes != null &&
      totalEstimatedMinutes > maxRouteMinutes
    )
    const overRequestedMaxBy = requestedUserMaxVisits > 0 && clientsCount > requestedUserMaxVisits
      ? clientsCount - requestedUserMaxVisits
      : 0

    return {
      ...block,
      total_estimated_minutes: totalEstimatedMinutes,
      workday_limit_known: workdayLimitKnown,
      exceeds_workday: exceedsWorkday,
      requested_user_max_visits: requestedUserMaxVisits || null,
      exceeds_requested_max: overRequestedMaxBy > 0,
      over_requested_max_by: overRequestedMaxBy
    }
  })
}

function decorateCoverageSummary(summary = {}, planningContext, blocks = []) {
  const requestedUserMaxVisits = Math.max(0, Number(planningContext?.requestedUserMaxVisits || 0))
  const usedBlocks = blocks.filter(block => Number(block?.clients_count || 0) > 0)
  const blocksAboveUserMax = requestedUserMaxVisits > 0
    ? usedBlocks.filter(block => Number(block?.over_requested_max_by || 0) > 0).length
    : 0
  const maximumBlockOverage = requestedUserMaxVisits > 0
    ? usedBlocks.reduce((maxValue, block) => Math.max(maxValue, Number(block?.over_requested_max_by || 0)), 0)
    : 0
  const totalVisits = Number(summary?.total_visits || 0)
  const capacityPrecheck = buildCoverageCapacityPrecheck(planningContext)

  return {
    ...summary,
    planning_horizon_days: Number(planningContext?.planningHorizonDays || planningContext?.planningDays || 0),
    coverage_window_days: Number(planningContext?.coverageWindowDays || planningContext?.visitFrequencyDays || DEFAULT_COVERAGE_WINDOW_DAYS),
    daily_max_mode: String(planningContext?.dailyMaxMode || DEFAULT_DAILY_MAX_MODE),
    strict_capacity: capacityPrecheck.strict_capacity,
    required_visits_count: capacityPrecheck.required_visits_count,
    available_slots_count: capacityPrecheck.available_slots_count,
    capacity_deficit: capacityPrecheck.capacity_deficit,
    minimum_required_average: capacityPrecheck.minimum_required_average,
    minimum_required_peak_estimate: capacityPrecheck.minimum_required_peak_estimate,
    visits_planned_count: totalVisits,
    visits_non_planned_count: Number(summary?.missing_clients_count || 0),
    blocks_above_user_max: blocksAboveUserMax,
    maximum_block_overage: maximumBlockOverage,
    actual_average_clients_per_used_block: usedBlocks.length > 0 ? roundScore(totalVisits / usedBlocks.length) : 0,
    coverage_guarantee_status: resolveCoverageGuaranteeStatus()
  }
}

function buildCoveragePrecheckResponse(planningContext) {
  const capacityPrecheck = buildCoverageCapacityPrecheck(planningContext)
  const requestedUserMaxVisits = Math.max(0, Number(planningContext?.requestedUserMaxVisits || 0))
  const message = (
    planningContext?.dailyMaxMode === DAILY_MAX_MODE_STRICT && capacityPrecheck.capacity_deficit > 0
      ? `La capacite stricte demandee est insuffisante de ${capacityPrecheck.capacity_deficit} visite(s). En mode strict, certains clients resteront non planifies.`
      : planningContext?.dailyMaxMode === DAILY_MAX_MODE_FLEXIBLE && capacityPrecheck.capacity_deficit > 0
        ? `La capacite demandee est insuffisante de ${capacityPrecheck.capacity_deficit} visite(s). En mode flexible, certains blocks pourront depasser le maximum demande.`
        : requestedUserMaxVisits > 0
          ? `Capacite theorique stricte: ${capacityPrecheck.strict_capacity} visite(s) pour ${capacityPrecheck.required_visits_count} visite(s) requises.`
          : 'Resume de faisabilite calcule avant generation.'
  )

  return {
    status: 'ready',
    can_continue: true,
    client_scope: buildCoverageClientScopePayload(
      planningContext?.clientScope,
      capacityPrecheck.active_clients_count
    ),
    capacity_precheck: capacityPrecheck,
    request_context: buildCoverageRequestContext(planningContext, planningContext.strictCa),
    message: `${message} ${buildCoverageSingleVisitDisclaimer(planningContext)}`.trim()
  }
}

async function buildCoverageCapacityPrecheckContext(rawBody = {}, dependencyOverrides = {}) {
  const {
    fetchCommercialOptions: fetchCommercialOptionsImpl = fetchCommercialOptions,
    countCoverageActiveClientsLight: countCoverageActiveClientsLightImpl = countCoverageActiveClientsLight
  } = dependencyOverrides || {}
  const startedAt = Date.now()
  const todayIso = formatLocalDate(new Date())
  const startDate = normalizeDateOnly(rawBody.start_date || rawBody.planning_start_date) || todayIso
  const planningHorizonDays = Math.max(
    1,
    Math.min(60, Number.parseInt(rawBody.planning_horizon_days ?? rawBody.period_days ?? rawBody.planning_days, 10) || 14)
  )
  const coverageWindowDays = normalizeCoverageWindowDays(rawBody.coverage_window_days ?? rawBody.visit_frequency_days)
  const dailyMaxMode = normalizeDailyMaxMode(rawBody.daily_max_mode)
  const requestedUserMinVisits = Math.max(
    0,
    Number.parseInt(rawBody.minimum_clients ?? rawBody.min_clients ?? rawBody.min_visits, 10) || 0
  )
  const requestedUserMaxVisits = Math.max(
    0,
    Number.parseInt(rawBody.maximum_clients ?? rawBody.max_clients ?? rawBody.max_visits, 10) || 0
  )
  const selectedCommercialCodes = parseCommercialSelection(
    rawBody.commercial === 'all'
      ? []
      : (rawBody.commercial ?? rawBody.commercials ?? rawBody.commercial_codes)
  )
  const selectedClientIds = parseClientSelection(rawBody.clients ?? rawBody.client_ids ?? rawBody.client_codes)
  const workingDaySelection = parseWorkingDaySelection(rawBody.working_days)
  const planningDaysList = buildWorkingDays(startDate, planningHorizonDays)
    .filter(day => workingDaySelection.includes(day.dayIndex))

  if (!planningDaysList.length) {
    return {
      invalidResponse: {
        status: 'invalid_parameters',
        message: 'Aucun jour travaille n est selectionne sur la periode demandee.'
      }
    }
  }

  const allCommercials = await fetchCommercialOptionsImpl()
  const selectedCommercials = selectedCommercialCodes.length
    ? allCommercials.filter(item => selectedCommercialCodes.includes(item.value))
    : allCommercials
  const clientScope = resolveCoverageClientScope({
    selectedCommercialCodes: selectedCommercials.map(item => item.value),
    selectedClientIds,
    availableCommercialCodes: allCommercials.map(item => item.value)
  })

  if (!selectedCommercials.length) {
    return {
      invalidResponse: {
        status: 'invalid_parameters',
        message: 'Aucun commercial actif disponible pour le precontrole de capacite.'
      }
    }
  }

  const activeClientsCount = await countCoverageActiveClientsLightImpl({
    selectedCommercialCodes: clientScope.selectedCommercialCodes,
    selectedClientIds: clientScope.selectedClientIds,
    availableCommercialCodes: allCommercials.map(item => item.value),
    clientScope
  })
  const workingDaysCount = planningDaysList.length
  const selectedCommercialsCount = selectedCommercials.length
  const availableSlotsCount = workingDaysCount * selectedCommercialsCount
  const requiredVisitsCount = activeClientsCount
  const strictCapacity = availableSlotsCount > 0 && requestedUserMaxVisits > 0
    ? availableSlotsCount * requestedUserMaxVisits
    : 0
  const capacityDeficit = Math.max(0, requiredVisitsCount - strictCapacity)
  const minimumRequiredAverage = availableSlotsCount > 0
    ? Number((requiredVisitsCount / availableSlotsCount).toFixed(2))
    : 0
  const minimumRequiredPeakEstimate = availableSlotsCount > 0
    ? Math.ceil(requiredVisitsCount / availableSlotsCount)
    : 0
  const capacityPrecheck = {
    active_clients_count: activeClientsCount,
    required_visits_count: requiredVisitsCount,
    working_days_count: workingDaysCount,
    selected_commercials_count: selectedCommercialsCount,
    available_slots_count: availableSlotsCount,
    strict_capacity: strictCapacity,
    capacity_deficit: capacityDeficit,
    minimum_required_average: minimumRequiredAverage,
    minimum_required_peak_estimate: minimumRequiredPeakEstimate,
    feasibility_status: availableSlotsCount <= 0
      ? 'no_available_slots'
      : requestedUserMaxVisits <= 0
        ? 'no_strict_max_configured'
        : capacityDeficit > 0
          ? 'strict_capacity_insufficient'
          : 'strict_capacity_sufficient',
    coverage_guarantee_status: resolveCoverageGuaranteeStatus(),
    planning_horizon_days: planningHorizonDays,
    coverage_window_days: coverageWindowDays,
    daily_max_mode: dailyMaxMode
  }
  const totalMs = Math.max(0, Date.now() - startedAt)
  console.log(`[COVERAGE_PRECHECK_PERF] total_ms=${totalMs}`)

  return {
    startDate,
    planningMode: COVERAGE_PLANNING_MODE_SALES,
    planningDays: planningHorizonDays,
    planningHorizonDays,
    visitFrequencyDays: coverageWindowDays,
    coverageWindowDays,
    dailyMaxMode,
    requestedUserMinVisits,
    normalizedUserMinVisits: requestedUserMinVisits,
    requestedUserMaxVisits,
    normalizedUserMaxVisits: requestedUserMaxVisits,
    strictCa: false,
    requiredVisitsCount,
    selectedClientsCount: activeClientsCount,
    selectedCommercials,
    clientScope,
    workingDaySelection,
    planningDaysList,
    theoreticalTotalSlots: availableSlotsCount,
    totalSlots: availableSlotsCount,
    totalConfiguredCapacity: strictCapacity,
    activeDaysCount: workingDaysCount,
    dedupedClientResult: { duplicateRows: 0 },
    historyMatchDiagnostics: null,
    historyCacheHits: 0,
    historyCacheMisses: 0,
    historyBuildMs: 0,
    minDailyCaPerCommercial: 0,
    allowCommercialReassignment: true,
    recommendedMaxVisitsPerSlot: requestedUserMaxVisits,
    adjustedTargetMaxVisitsPerSlot: requestedUserMaxVisits,
    resolvedMaxVisitsPerSlot: requestedUserMaxVisits,
    hardPhysicalLimitedSlotsCount: 0,
    maxHardPhysicalMaxVisitsPerSlot: requestedUserMaxVisits || null,
    historicalSoftCapacityTotal: 0,
    salesActivityProxyTotal: 0,
    capacityMode: COVERAGE_CAPACITY_MODE_UNKNOWN,
    timeCapacityKnown: false,
    operationalCapacityKnown: false,
    requestedManualMaxVisits: null,
    capacityPrecheck
  }
}

function buildCoverageRequestContext(planningContext, strictCaValue) {
  return {
    planning_mode: planningContext.planningMode || COVERAGE_PLANNING_MODE_RECOVERY,
    start_date: planningContext.startDate,
    planning_days: planningContext.planningDays,
    planning_horizon_days: planningContext.planningHorizonDays || planningContext.planningDays,
    visit_frequency_days: planningContext.visitFrequencyDays,
    coverage_window_days: planningContext.coverageWindowDays || planningContext.visitFrequencyDays,
    daily_max_mode: planningContext.dailyMaxMode || DEFAULT_DAILY_MAX_MODE,
    selected_commercials_count: planningContext.selectedCommercials.length,
    selected_clients_count: planningContext.selectedClientsCount || 0,
    required_visits_count: planningContext.requiredVisitsCount || planningContext.selectedClientsCount || 0,
    available_slots_count: planningContext.theoreticalTotalSlots || 0,
    strict_capacity: planningContext.capacityPrecheck?.strict_capacity || 0,
    capacity_deficit: planningContext.capacityPrecheck?.capacity_deficit || 0,
    coverage_guarantee_status: resolveCoverageGuaranteeStatus(),
    user_min_visits_per_slot: planningContext.requestedUserMinVisits,
    adjusted_user_min_visits_per_slot: planningContext.normalizedUserMinVisits,
    user_max_visits_per_slot: planningContext.requestedUserMaxVisits,
    adjusted_target_max_visits_per_slot: planningContext.adjustedTargetMaxVisitsPerSlot,
    hard_physical_max_visits_per_slot: planningContext.maxHardPhysicalMaxVisitsPerSlot || null,
    hard_physical_limited_slots_count: planningContext.hardPhysicalLimitedSlotsCount || 0,
    strict_ca: strictCaValue,
    default_max_visits_per_slot: planningContext.adjustedTargetMaxVisitsPerSlot,
    recommended_max_capacity: planningContext.recommendedMaxVisitsPerSlot,
    resolved_max_capacity: planningContext.resolvedMaxVisitsPerSlot,
    capacity_mode: planningContext.capacityMode || COVERAGE_CAPACITY_MODE_UNKNOWN,
    time_capacity_known: Boolean(planningContext.timeCapacityKnown),
    operational_capacity_known: Boolean(planningContext.operationalCapacityKnown),
    historical_soft_capacity_total: planningContext.historicalSoftCapacityTotal || 0,
    sales_activity_proxy_total: planningContext.salesActivityProxyTotal || 0,
    validated_visit_min_active_days: COVERAGE_VALIDATED_VISIT_MIN_ACTIVE_DAYS,
    min_daily_ca_per_commercial: roundScore(planningContext.minDailyCaPerCommercial),
    allow_commercial_reassignment: planningContext.allowCommercialReassignment,
    working_days: planningContext.workingDaySelection,
    history_cache_hits: Number(planningContext.historyCacheHits || 0),
    history_cache_misses: Number(planningContext.historyCacheMisses || 0),
    history_build_ms: Number(planningContext.historyBuildMs || 0),
    duplicate_source_rows_removed: planningContext.dedupedClientResult.duplicateRows,
    history_match_diagnostics: planningContext.historyMatchDiagnostics || {
      resolution_counts: {
        exact_match: 0,
        unique_normalized_match: 0,
        ambiguous_match: 0,
        no_match: 0
      },
      ambiguous_match_rows: 0,
      no_match_rows: 0,
      ambiguous_normalized_codes: []
    }
  }
}

function buildCoveragePlannerEmptyResponse(planningContext) {
  return {
    status: 'success',
    summary: {
      planning_start_date: planningContext.startDate,
      planning_end_date: planningContext.planningDaysList[planningContext.planningDaysList.length - 1]?.date || planningContext.startDate,
      planning_horizon_days: planningContext.planningHorizonDays || planningContext.planningDays,
      coverage_window_days: planningContext.coverageWindowDays || planningContext.visitFrequencyDays,
      daily_max_mode: planningContext.dailyMaxMode || DEFAULT_DAILY_MAX_MODE,
      clients_to_cover: 0,
      unique_clients_covered: 0,
      missing_clients_count: 0,
      duplicate_clients_count: 0,
      total_visits: 0,
      total_slots: planningContext.totalSlots,
      used_slots: 0,
      unused_slots: planningContext.totalSlots,
      total_capacity: planningContext.totalConfiguredCapacity,
      required_average_per_slot: 0,
      required_minimum_max_per_slot: 0,
      total_predicted_ca: 0,
      total_ca_shortfall: 0,
      solver_status: 'OPTIMAL',
      time_capacity_known: Boolean(planningContext.timeCapacityKnown),
      operational_capacity_known: Boolean(planningContext.operationalCapacityKnown),
      strict_capacity: Number(planningContext.capacityPrecheck?.strict_capacity || 0),
      required_visits_count: Number(planningContext.capacityPrecheck?.required_visits_count || 0),
      available_slots_count: Number(planningContext.capacityPrecheck?.available_slots_count || 0),
      capacity_deficit: Number(planningContext.capacityPrecheck?.capacity_deficit || 0),
      minimum_required_average: Number(planningContext.capacityPrecheck?.minimum_required_average || 0),
      minimum_required_peak_estimate: Number(planningContext.capacityPrecheck?.minimum_required_peak_estimate || 0),
      coverage_guarantee_status: resolveCoverageGuaranteeStatus()
    },
    blocks: [],
    diagnostics: {
      capacity_issues: [],
      commercial_capacity_issues: [],
      deadline_issues: [],
      ca_issues: [],
      invalid_gps_clients: [],
      input_duplicate_clients_removed: []
    },
    depot: SHARED_DEPOT_ORIGIN,
    client_scope: buildCoverageClientScopePayload(
      planningContext?.clientScope,
      planningContext?.capacityPrecheck?.active_clients_count || planningContext?.selectedClientsCount || 0
    ),
    capacity_precheck: buildCoverageCapacityPrecheck(planningContext),
    request_context: buildCoverageRequestContext(planningContext, planningContext.strictCa),
    message: `Aucun client actif a couvrir sur la periode analysee. ${buildCoverageSingleVisitDisclaimer(planningContext)}`
  }
}

async function buildCoveragePlanningContext(rawBody = {}, dependencyOverrides = {}, runtimeOptions = {}) {
  const {
    fetchCommercialOptions: fetchCommercialOptionsImpl = fetchCommercialOptions,
    fetchCoverageActiveClients: fetchCoverageActiveClientsImpl = fetchCoverageActiveClients,
    loadCoverageConstraints: loadCoverageConstraintsImpl = loadCoverageConstraints,
    fetchCoverageCommercialCapacityProfiles: fetchCoverageCommercialCapacityProfilesImpl = fetchCoverageCommercialCapacityProfiles,
    fetchCoverageValidatedVisitCapacityProfiles: fetchCoverageValidatedVisitCapacityProfilesImpl = fetchCoverageValidatedVisitCapacityProfiles,
    loadRecoveryProfiles: loadRecoveryProfilesImpl = loadRecoveryProfiles,
    recoveryQueryRows = buildCoverageRecoveryQueryRows(queryAsync),
    loadCoveragePurchasePredictionProfiles: loadCoveragePurchasePredictionProfilesImpl = loadCoveragePurchasePredictionProfiles,
    fetchLoggedAiPredictions: fetchLoggedAiPredictionsImpl = fetchLoggedAiPredictions
  } = dependencyOverrides || {}
  const perfTracker = runtimeOptions?.perfTracker || null
  const precheckOnly = Boolean(runtimeOptions?.precheckOnly)
  const planningMode = resolveCoveragePlanningMode(rawBody.planning_mode)
  const isSalesCoverageMode = planningMode === COVERAGE_PLANNING_MODE_SALES
  const coverageHistoryCacheMetrics = createCoverageHistoryCacheMetrics()
  const todayIso = formatLocalDate(new Date())
  const startDate = normalizeDateOnly(rawBody.start_date || rawBody.planning_start_date) || todayIso
  const planningDays = Math.max(
    1,
    Math.min(60, Number.parseInt(rawBody.planning_horizon_days ?? rawBody.period_days ?? rawBody.planning_days, 10) || 14)
  )
  const visitFrequencyDays = normalizeCoverageWindowDays(rawBody.coverage_window_days ?? rawBody.visit_frequency_days)
  const dailyMaxMode = normalizeDailyMaxMode(rawBody.daily_max_mode)
  const requestedManualMaxVisits = parseOptionalCoverageMaxVisits(rawBody.default_max_visits_per_slot)
  const requestedUserMinVisits = Math.max(0, Number.parseInt(rawBody.min_clients ?? rawBody.min_visits, 10) || 0)
  const requestedUserMaxVisits = Math.max(0, Number.parseInt(rawBody.max_clients ?? rawBody.max_visits, 10) || 0)
  const minDailyCaPerCommercial = Math.max(
    0,
    Number(rawBody.min_daily_ca_per_commercial ?? rawBody.min_daily_ca ?? rawBody.min_total_ca ?? 0) || 0
  )
  const strictCa = parseBooleanFlag(rawBody.strict_ca, false)
  const allowCommercialReassignment = parseBooleanFlag(rawBody.allow_commercial_reassignment, true)
  const selectedCommercialCodes = parseCommercialSelection(rawBody.commercials ?? rawBody.commercial_codes)
  const selectedClientIds = parseClientSelection(rawBody.clients ?? rawBody.client_ids ?? rawBody.client_codes)
  const workingDaySelection = parseWorkingDaySelection(rawBody.working_days)
  const planningDaysList = buildWorkingDays(startDate, planningDays)
    .filter(day => workingDaySelection.includes(day.dayIndex))
  const availabilityPayload = parseCoverageAvailabilityPayload(rawBody.commercial_availability)

  if (!planningDaysList.length) {
    return {
      invalidResponse: {
        status: 'invalid_parameters',
        message: 'Aucun jour travaille n\'est selectionne sur la periode demandee.'
      }
    }
  }

  const allCommercials = await fetchCommercialOptionsImpl()
  const selectedCommercials = selectedCommercialCodes.length
    ? allCommercials.filter(item => selectedCommercialCodes.includes(item.value))
    : allCommercials
  const clientScope = resolveCoverageClientScope({
    selectedCommercialCodes: selectedCommercials.map(item => item.value),
    selectedClientIds,
    availableCommercialCodes: allCommercials.map(item => item.value)
  })

  if (!selectedCommercials.length) {
    return {
      invalidResponse: {
        status: 'invalid_parameters',
        message: 'Aucun commercial actif disponible pour la planification.'
      }
    }
  }

  const availabilityDrafts = selectedCommercials.map(item => {
    const availability = buildCoverageCommercialAvailability({
      planningDays: planningDaysList,
      commercialCode: item.value,
      defaultMaxVisitsPerSlot: dailyMaxMode === DAILY_MAX_MODE_STRICT && requestedUserMaxVisits > 0
        ? requestedUserMaxVisits
        : 1,
      minDailyCaPerCommercial,
      rawAvailabilityEntry: availabilityPayload[item.value]
    })

    return {
      code: item.value,
      label: item.label,
      available_dates: availability.availableDates
    }
  })

  const activeAvailabilityDrafts = availabilityDrafts.filter(item => item.available_dates.length > 0)
  if (!activeAvailabilityDrafts.length) {
    return {
      invalidResponse: {
        status: 'invalid_parameters',
        message: 'Toutes les disponibilites commerciales sont vides sur la periode selectionnee.'
      }
    }
  }

  const coverageClientDirectory = await fetchCoverageActiveClientsImpl({
    selectedCommercialCodes: clientScope.selectedCommercialCodes,
    selectedClientIds: clientScope.selectedClientIds,
    startDate,
    allCommercialsSelected: clientScope.allCommercialsSelected,
    clientScope,
    cacheMetrics: coverageHistoryCacheMetrics,
    perfTracker
  })
  const dedupedClientResult = coverageClientDirectory.dedupedClientResult
  const historyMatchDiagnostics = coverageClientDirectory.historySnapshot.diagnostics
  const clients = coverageClientDirectory.clients
  const planningEndDate = planningDaysList[planningDaysList.length - 1]?.date || startDate
  const coverageConstraints = await runCoveragePerfStage(perfTracker, 'load_constraints', async () => loadCoverageConstraintsImpl({
    startDate,
    endDate: planningEndDate,
    commercialCodes: selectedCommercials.map(item => item.value),
    clientIds: clients.map(client => client.client_id)
  }, {
    queryAsync,
    database: DB_CONFIG.database
  }))
  const mergedAvailabilityPayload = selectedCommercials.reduce((accumulator, item) => {
    accumulator[item.value] = mergeCoverageCommercialConstraintEntries(
      coverageConstraints.commercials?.[item.value] || {},
      availabilityPayload[item.value] || {}
    )
    return accumulator
  }, {})
  const availabilityDraftsWithConstraints = selectedCommercials.map(item => {
    const availability = buildCoverageCommercialAvailability({
      planningDays: planningDaysList,
      commercialCode: item.value,
      defaultMaxVisitsPerSlot: dailyMaxMode === DAILY_MAX_MODE_STRICT && requestedUserMaxVisits > 0
        ? requestedUserMaxVisits
        : 1,
      minDailyCaPerCommercial,
      rawAvailabilityEntry: mergedAvailabilityPayload[item.value]
    })

    return {
      code: item.value,
      label: item.label,
      available_dates: availability.availableDates
    }
  })
  const totalSlots = availabilityDraftsWithConstraints.reduce((sum, item) => sum + item.available_dates.length, 0)
  if (!totalSlots) {
    return {
      invalidResponse: {
        status: 'invalid_parameters',
        message: 'Toutes les disponibilites commerciales sont indisponibles sur la periode selectionnee.'
      }
    }
  }
  const recommendedMaxVisitsPerSlot = computeCoverageRecommendedMaxCapacity(clients.length, totalSlots)
  const flexibleCapacityTarget = computeAdjustedTargetMaxVisits({
    userMaxVisits: requestedUserMaxVisits,
    activeClients: clients.length,
    availableSlots: totalSlots,
    manualMaxVisits: requestedManualMaxVisits
  })
  const theoreticalTotalSlots = planningDaysList.length * selectedCommercials.length
  const requiredVisitsCount = clients.length
  const strictCapacity = theoreticalTotalSlots > 0 && requestedUserMaxVisits > 0
    ? theoreticalTotalSlots * requestedUserMaxVisits
    : 0
  const capacityDeficit = Math.max(0, requiredVisitsCount - strictCapacity)
  const minimumRequiredAverage = theoreticalTotalSlots > 0
    ? Number((requiredVisitsCount / theoreticalTotalSlots).toFixed(2))
    : 0
  const minimumRequiredPeakEstimate = theoreticalTotalSlots > 0
    ? Math.ceil(requiredVisitsCount / theoreticalTotalSlots)
    : 0
  const adjustedCapacityTarget = dailyMaxMode === DAILY_MAX_MODE_STRICT && requestedUserMaxVisits > 0
    ? {
        ...flexibleCapacityTarget,
        userPreferredMaxVisits: requestedUserMaxVisits,
        effectiveTargetMaxVisits: requestedUserMaxVisits,
        adjustedTargetMaxVisits: requestedUserMaxVisits,
        adjustmentReason: capacityDeficit > 0
          ? 'strict_capacity_insufficient'
          : 'user_range_enforced_strict'
      }
    : flexibleCapacityTarget
  const adjustedTargetMaxVisitsPerSlot = Math.max(
    1,
    Number(adjustedCapacityTarget.adjustedTargetMaxVisits || 0) || 1
  )
  const normalizedUserMinVisits = requestedUserMinVisits
  const normalizedUserMaxVisits = requestedUserMaxVisits
  const userPreferredMaxVisitsPerSlot = Math.max(
    0,
    Number(adjustedCapacityTarget.userPreferredMaxVisits || normalizedUserMaxVisits || 0) || 0
  )
  const capacityPrecheck = {
    active_clients_count: requiredVisitsCount,
    required_visits_count: requiredVisitsCount,
    available_slots_count: theoreticalTotalSlots,
    available_slots_after_constraints_count: totalSlots,
    strict_capacity: strictCapacity,
    capacity_deficit: capacityDeficit,
    minimum_required_average: minimumRequiredAverage,
    minimum_required_peak_estimate: minimumRequiredPeakEstimate,
    feasibility_status: theoreticalTotalSlots <= 0
      ? 'no_available_slots'
      : requestedUserMaxVisits <= 0
        ? 'no_strict_max_configured'
        : capacityDeficit > 0
          ? 'strict_capacity_insufficient'
          : 'strict_capacity_sufficient',
    coverage_guarantee_status: 'single_visit_only'
  }

  const [salesCapacityProfiles, validatedVisitCapacityProfiles] = await Promise.all([
    fetchCoverageCommercialCapacityProfilesImpl(
      selectedCommercials.map(item => item.value),
      startDate,
      { cacheMetrics: coverageHistoryCacheMetrics, perfTracker }
    ),
    fetchCoverageValidatedVisitCapacityProfilesImpl(
      selectedCommercials.map(item => item.value),
      startDate,
      { cacheMetrics: coverageHistoryCacheMetrics, perfTracker }
    )
  ])
  const capacityModeContext = resolveCoverageCapacityMode({
    visitProfiles: validatedVisitCapacityProfiles,
    salesProfiles: salesCapacityProfiles
  })
  const timeCapacityKnown = Boolean(coverageConstraints.diagnostic?.time_capacity_known)
  const operationalCapacityKnown = Boolean(timeCapacityKnown)
  const selectedCapacityProfiles = capacityModeContext.capacityMode === COVERAGE_CAPACITY_MODE_VALIDATED_VISIT
    ? validatedVisitCapacityProfiles
    : salesCapacityProfiles
  const historicalFallbackCapacity = computeCoverageHistoricalFallbackCapacity(
    selectedCapacityProfiles,
    adjustedTargetMaxVisitsPerSlot
  )
  const salesProxyFallbackCapacity = computeCoverageHistoricalFallbackCapacity(
    salesCapacityProfiles,
    adjustedTargetMaxVisitsPerSlot
  )
  const dayIndexByDate = new Map(planningDaysList.map(day => [day.date, day.dayIndex]))
  let historicalSoftCapacityTotal = 0
  let salesActivityProxyTotal = 0
  let hardPhysicalCapacityTotal = 0
  let hardPhysicalLimitedSlotsCount = 0
  let maxHardPhysicalMaxVisitsPerSlot = 0
  const commercials = await runCoveragePerfStage(perfTracker, 'build_slots', async () => availabilityDraftsWithConstraints
    .map(item => {
      const availability = buildCoverageCommercialAvailability({
        planningDays: planningDaysList,
        commercialCode: item.code,
        defaultMaxVisitsPerSlot: dailyMaxMode === DAILY_MAX_MODE_STRICT && requestedUserMaxVisits > 0
          ? requestedUserMaxVisits
          : Math.max(1, userPreferredMaxVisitsPerSlot || adjustedTargetMaxVisitsPerSlot),
        minDailyCaPerCommercial,
        rawAvailabilityEntry: mergedAvailabilityPayload[item.code]
      })
      const profile = selectedCapacityProfiles.get(item.code) || null
      const salesProxyProfile = salesCapacityProfiles.get(item.code) || null
      const maxVisitsByDate = {}
      const userPreferredMinByDate = {}
      const userPreferredMaxByDate = {}
      const recommendedMinByDate = {}
      const recommendedMaxByDate = {}
      const effectiveTargetMinByDate = {}
      const effectiveTargetMaxByDate = {}
      const hardCapacityKnownByDate = {}
      const adjustmentReasonByDate = {}
      const maxLoadUnitsByDate = {}
      const historicalSoftCapacityByDate = {}
      const salesActivityProxyByDate = {}
      const salesProxySourceByDate = {}
      const salesProxyConfidenceByDate = {}
      const recommendedCapacityByDate = {}
      const hardCapacityByDate = {}
      const capacitySourceByDate = {}
      const shiftStartTimeByDate = {}
      const shiftEndTimeByDate = {}
      const maxRouteMinutesByDate = {}
      const breakMinutesByDate = {}
      const depotByDate = {}
      const timeConstraintSourceByDate = {}

      availability.availableDates.forEach(date => {
        const preferredMaxForDate = Math.max(
          0,
          Number(availability.maxVisitsByDate?.[date] || userPreferredMaxVisitsPerSlot || 0) || 0
        )
        const requestedCapacityForDate = dailyMaxMode === DAILY_MAX_MODE_STRICT && requestedUserMaxVisits > 0
          ? Math.max(preferredMaxForDate, requestedUserMaxVisits, 1)
          : Math.max(
              adjustedTargetMaxVisitsPerSlot,
              preferredMaxForDate,
              1
            )
        const capacity = resolveCommercialCapacityForDay(
          profile,
          dayIndexByDate.get(date),
          {
            requestedMaxVisits: requestedCapacityForDate,
            adjustedTargetMaxVisits: dailyMaxMode === DAILY_MAX_MODE_STRICT && requestedUserMaxVisits > 0
              ? requestedCapacityForDate
              : adjustedTargetMaxVisitsPerSlot,
            fallbackHistoricalCapacity: historicalFallbackCapacity,
            hardMaxVisits: availability.hardMaxVisitsByDate?.[date],
            hardMaxLoadUnits: availability.maxLoadUnitsByDate?.[date]
          }
        )
        const salesProxyCapacity = salesProxyProfile
          ? resolveCommercialCapacityForDay(
              salesProxyProfile,
              dayIndexByDate.get(date),
              {
                requestedMaxVisits: requestedCapacityForDate,
                adjustedTargetMaxVisits: dailyMaxMode === DAILY_MAX_MODE_STRICT && requestedUserMaxVisits > 0
                  ? requestedCapacityForDate
                  : adjustedTargetMaxVisitsPerSlot,
                fallbackHistoricalCapacity: salesProxyFallbackCapacity
              }
            )
          : null
        maxVisitsByDate[date] = capacity.maxClients
        userPreferredMinByDate[date] = Math.max(0, Number(normalizedUserMinVisits || 0) || 0)
        userPreferredMaxByDate[date] = preferredMaxForDate > 0 ? preferredMaxForDate : null
        historicalSoftCapacityByDate[date] = Number(capacity.historicalSoftCapacity || historicalFallbackCapacity || 1)
        recommendedCapacityByDate[date] = Number(capacity.recommendedCapacity || capacity.historicalSoftCapacity || historicalFallbackCapacity || 1)
        recommendedMinByDate[date] = recommendedCapacityByDate[date]
        recommendedMaxByDate[date] = recommendedCapacityByDate[date]
        effectiveTargetMinByDate[date] = Math.max(0, Number(normalizedUserMinVisits || 0) || 0)
        effectiveTargetMaxByDate[date] = Math.max(1, Number(adjustedTargetMaxVisitsPerSlot || 1) || 1)
        hardCapacityKnownByDate[date] = Boolean(capacity.hardCapacityKnown)
        adjustmentReasonByDate[date] = String(adjustedCapacityTarget.adjustmentReason || 'user_range_accepted').trim() || 'user_range_accepted'
        capacitySourceByDate[date] = String(capacity.capacitySource || 'fallback_operational_capacity').trim() || 'fallback_operational_capacity'
        historicalSoftCapacityTotal += Number(capacity.historicalSoftCapacity || historicalFallbackCapacity || 0)
        if (salesProxyCapacity && Number.isFinite(Number(salesProxyCapacity.historicalSoftCapacity)) && Number(salesProxyCapacity.historicalSoftCapacity) > 0) {
          const proxyValue = Number(salesProxyCapacity.historicalSoftCapacity)
          salesActivityProxyByDate[date] = proxyValue
          salesActivityProxyTotal += proxyValue
          salesProxySourceByDate[date] = String(salesProxyCapacity.historicalCapacitySource || salesProxyCapacity.capacitySource || 'global_sales_history_fallback').trim() || 'global_sales_history_fallback'
          salesProxyConfidenceByDate[date] = String(salesProxyCapacity.capacityConfidence || 'low').trim().toLowerCase() || 'low'
        } else {
          salesProxySourceByDate[date] = 'no_sales_history'
          salesProxyConfidenceByDate[date] = 'low'
        }
        if (Number.isFinite(Number(capacity.maxLoadUnits)) && Number(capacity.maxLoadUnits) > 0) {
          maxLoadUnitsByDate[date] = roundScore(Number(capacity.maxLoadUnits))
        }
        if (Number.isFinite(Number(capacity.hardCapacity)) && Number(capacity.hardCapacity) > 0) {
          hardCapacityByDate[date] = Number(capacity.hardCapacity)
        }
        if (capacity.hasHardPhysicalCapacity) {
          hardPhysicalLimitedSlotsCount += 1
          hardPhysicalCapacityTotal += Number(capacity.maxClients || 0)
        }
        if (Number.isFinite(Number(capacity.hardPhysicalMaxVisits)) && Number(capacity.hardPhysicalMaxVisits) > 0) {
          maxHardPhysicalMaxVisitsPerSlot = Math.max(
            maxHardPhysicalMaxVisitsPerSlot,
            Number(capacity.hardPhysicalMaxVisits)
          )
        }
        const shiftStartTime = String(mergedAvailabilityPayload[item.code]?.shift_start_time_by_date?.[date] || '').trim()
        const shiftEndTime = String(mergedAvailabilityPayload[item.code]?.shift_end_time_by_date?.[date] || '').trim()
        const maxRouteMinutes = Number(mergedAvailabilityPayload[item.code]?.max_route_minutes_by_date?.[date])
        const breakMinutes = Number(mergedAvailabilityPayload[item.code]?.break_minutes_by_date?.[date])
        const depotLatitude = Number(mergedAvailabilityPayload[item.code]?.depot_latitude_by_date?.[date])
        const depotLongitude = Number(mergedAvailabilityPayload[item.code]?.depot_longitude_by_date?.[date])
        const depotId = String(mergedAvailabilityPayload[item.code]?.depot_id_by_date?.[date] || '').trim()
        const timeConstraintSource = String(
          mergedAvailabilityPayload[item.code]?.time_constraint_source_by_date?.[date] ||
          mergedAvailabilityPayload[item.code]?.constraint_sources_by_date?.[date] ||
          ''
        ).trim()
        if (shiftStartTime) {
          shiftStartTimeByDate[date] = shiftStartTime
        }
        if (shiftEndTime) {
          shiftEndTimeByDate[date] = shiftEndTime
        }
        if (Number.isFinite(maxRouteMinutes) && maxRouteMinutes > 0) {
          maxRouteMinutesByDate[date] = roundScore(maxRouteMinutes)
        }
        if (Number.isFinite(breakMinutes) && breakMinutes >= 0) {
          breakMinutesByDate[date] = roundScore(breakMinutes)
        }
        if (Number.isFinite(depotLatitude) && Number.isFinite(depotLongitude)) {
          depotByDate[date] = {
            id: depotId || null,
            latitude: depotLatitude,
            longitude: depotLongitude
          }
        }
        if (timeConstraintSource) {
          timeConstraintSourceByDate[date] = timeConstraintSource
        }
      })

      return {
        code: item.code,
        label: item.label,
        available_dates: availability.availableDates,
        max_visits_by_date: maxVisitsByDate,
        min_ca_by_date: availability.minCaByDate,
        user_preferred_min_by_date: userPreferredMinByDate,
        user_preferred_max_by_date: userPreferredMaxByDate,
        recommended_min_by_date: recommendedMinByDate,
        recommended_max_by_date: recommendedMaxByDate,
        effective_target_min_by_date: effectiveTargetMinByDate,
        effective_target_max_by_date: effectiveTargetMaxByDate,
        hard_capacity_known_by_date: hardCapacityKnownByDate,
        adjustment_reason_by_date: adjustmentReasonByDate,
        max_load_units_by_date: maxLoadUnitsByDate,
        historical_soft_capacity_by_date: historicalSoftCapacityByDate,
        sales_activity_proxy_by_date: salesActivityProxyByDate,
        sales_proxy_source_by_date: salesProxySourceByDate,
        sales_proxy_confidence_by_date: salesProxyConfidenceByDate,
        recommended_capacity_by_date: recommendedCapacityByDate,
        hard_capacity_by_date: hardCapacityByDate,
        capacity_source_by_date: capacitySourceByDate,
        shift_start_time_by_date: shiftStartTimeByDate,
        shift_end_time_by_date: shiftEndTimeByDate,
        max_route_minutes_by_date: maxRouteMinutesByDate,
        break_minutes_by_date: breakMinutesByDate,
        depot_by_date: depotByDate,
        time_constraint_source_by_date: timeConstraintSourceByDate
      }
    })
    .filter(item => item.available_dates.length > 0))
  if (!commercials.length) {
    return {
      invalidResponse: {
        status: 'invalid_parameters',
        message: 'Aucun slot commercial disponible apres application des contraintes terrain.'
      }
    }
  }
  const resolvedMaxVisitsPerSlot = commercials.reduce((max, commercial) => {
    const commercialMax = Object.values(commercial.max_visits_by_date || {}).reduce(
      (maxValue, currentValue) => Math.max(maxValue, Number(currentValue || 0)),
      0
    )
    return Math.max(max, commercialMax)
  }, adjustedTargetMaxVisitsPerSlot)

  if (!clients.length) {
    const totalConfiguredCapacity = commercials.reduce(
      (sum, item) => sum + Object.values(item.max_visits_by_date || {}).reduce((slotSum, value) => slotSum + Number(value || 0), 0),
      0
    )

    return {
      startDate,
      planningMode,
      planningDays,
      planningHorizonDays: planningDays,
      visitFrequencyDays,
      coverageWindowDays: visitFrequencyDays,
      dailyMaxMode,
      requiredVisitsCount,
      capacityPrecheck,
      requestedManualMaxVisits,
      requestedUserMinVisits,
      requestedUserMaxVisits,
      normalizedUserMinVisits,
      normalizedUserMaxVisits,
      recommendedMaxVisitsPerSlot,
      adjustedTargetMaxVisitsPerSlot,
      resolvedMaxVisitsPerSlot,
      historyCacheHits: coverageHistoryCacheMetrics.hits,
      historyCacheMisses: coverageHistoryCacheMetrics.misses,
      historyBuildMs: Math.round(Number(coverageHistoryCacheMetrics.buildMs || 0)),
      historicalSoftCapacityTotal,
      salesActivityProxyTotal,
      capacityMode: capacityModeContext.capacityMode,
      timeCapacityKnown,
      operationalCapacityKnown,
      hardPhysicalCapacityTotal,
      hardPhysicalLimitedSlotsCount,
      maxHardPhysicalMaxVisitsPerSlot,
      minDailyCaPerCommercial,
      strictCa,
      allowCommercialReassignment,
      workingDaySelection,
      planningDaysList,
      selectedCommercials,
      clientScope,
      selectedClientIds,
      activeCommercials: commercials,
      totalSlots,
      totalConfiguredCapacity,
      theoreticalTotalSlots: planningDaysList.length * selectedCommercials.length,
      activeDaysCount: planningDaysList.length,
      selectedClientsCount: clients.length,
      dedupedClientResult,
      historyMatchDiagnostics,
      emptyResponse: buildCoveragePlannerEmptyResponse({
        startDate,
        planningMode,
        planningDays,
        planningHorizonDays: planningDays,
        visitFrequencyDays,
        coverageWindowDays: visitFrequencyDays,
        dailyMaxMode,
        requiredVisitsCount,
        capacityPrecheck,
        recommendedMaxVisitsPerSlot,
        adjustedTargetMaxVisitsPerSlot,
        resolvedMaxVisitsPerSlot,
        historyCacheHits: coverageHistoryCacheMetrics.hits,
        historyCacheMisses: coverageHistoryCacheMetrics.misses,
        historyBuildMs: Math.round(Number(coverageHistoryCacheMetrics.buildMs || 0)),
        capacityMode: capacityModeContext.capacityMode,
        timeCapacityKnown,
        operationalCapacityKnown,
        requestedUserMinVisits,
        requestedUserMaxVisits,
        normalizedUserMinVisits,
        normalizedUserMaxVisits,
        salesActivityProxyTotal,
        hardPhysicalLimitedSlotsCount,
        maxHardPhysicalMaxVisitsPerSlot,
        minDailyCaPerCommercial,
        strictCa,
        allowCommercialReassignment,
        workingDaySelection,
        planningDaysList,
        selectedCommercials,
        clientScope,
        selectedClientsCount: clients.length,
        totalSlots,
        totalConfiguredCapacity,
        dedupedClientResult,
        historyMatchDiagnostics
      })
    }
  }
  const purchasePredictionDistanceContext = buildDistanceMap(
    clients.map(client => ({
      nbr_client: client.client_code,
      latitude: client.latitude,
      longitude: client.longitude
    }))
  )
  if (precheckOnly) {
    return {
      startDate,
      planningMode,
      planningDays,
      planningHorizonDays: planningDays,
      visitFrequencyDays,
      coverageWindowDays: visitFrequencyDays,
      dailyMaxMode,
      requiredVisitsCount,
      capacityPrecheck,
      requestedManualMaxVisits,
      requestedUserMinVisits,
      requestedUserMaxVisits,
      normalizedUserMinVisits,
      normalizedUserMaxVisits,
      recommendedMaxVisitsPerSlot,
      adjustedTargetMaxVisitsPerSlot,
      resolvedMaxVisitsPerSlot,
      historyCacheHits: coverageHistoryCacheMetrics.hits,
      historyCacheMisses: coverageHistoryCacheMetrics.misses,
      historyBuildMs: Math.round(Number(coverageHistoryCacheMetrics.buildMs || 0)),
      historicalSoftCapacityTotal,
      salesActivityProxyTotal,
      capacityMode: capacityModeContext.capacityMode,
      timeCapacityKnown,
      operationalCapacityKnown,
      hardPhysicalCapacityTotal,
      hardPhysicalLimitedSlotsCount,
      maxHardPhysicalMaxVisitsPerSlot,
      minDailyCaPerCommercial,
      strictCa,
      allowCommercialReassignment,
      workingDaySelection,
      planningDaysList,
      selectedCommercials,
      clientScope,
      selectedClientIds,
      activeCommercials: commercials,
      totalSlots,
      totalConfiguredCapacity,
      theoreticalTotalSlots: planningDaysList.length * selectedCommercials.length,
      activeDaysCount: planningDaysList.length,
      selectedClientsCount: clients.length,
      dedupedClientResult,
      historyMatchDiagnostics,
      coverageConstraints
    }
  }
  const recoveryProfilesPromise = isSalesCoverageMode
    ? Promise.resolve([])
    : loadRecoveryProfilesImpl({
        clientIds: clients.map(client => client.client_id),
        referenceDate: startDate,
        queryRows: recoveryQueryRows
      })
  const exactClientIds = clients.map(client => client.client_id)
  const exactClientCodes = clients.map(client => client.client_code)
  const purchasePredictionProfilesPromise = runCoveragePerfStage(perfTracker, 'load_purchase_predictions', async () => loadCoveragePurchasePredictionProfilesImpl({
    clientRows: clients.map(client => ({
      client_id: client.client_id,
      client_code: client.client_code,
      nom: client.nom,
      latitude: client.latitude,
      longitude: client.longitude
    })),
    planningDates: planningDaysList.map(day => day.date),
    referenceDate: startDate,
    fetchPredictionsForDate: async ({ date }) => {
      const { response } = await fetchLoggedAiPredictionsImpl(
        { date },
        {
          sourceContext: 'coverage_purchase_profiles',
          sourceMode: 'coverage',
          requestContext: {
            date_reference: startDate,
            prediction_date: date
          },
          cacheContext: {
            activeClientIds: exactClientIds,
            exactClientCodes,
            modelVersion: process.env.AI_MODEL_VERSION || 'unknown',
            datasetCutoff: process.env.AI_DATASET_CUTOFF || '',
            scoreVersion: process.env.AI_SCORE_VERSION || 'computePriorityScore',
            requestContext: {
              planning_mode: planningMode,
              prediction_date: date
            }
          }
        }
      )
      return response?.data || null
    },
    scorePredictionCandidate: ({ clientRow, rawPrediction, predictionPayloadMeta }) => {
      const distanceKm = purchasePredictionDistanceContext.distanceMap.get(String(clientRow.client_code || '').trim()) || 0
      return computePriorityScore(
        Number(rawPrediction?.chiffre || 0) || 0,
        Number(predictionPayloadMeta?.maxPredictedValue || 0) || 0,
        Number(rawPrediction?.prob_achat || 0) || 0,
        Number(rawPrediction?.habit_score || 0) || 0,
        Number(rawPrediction?.recency_score || 0) || 0,
        distanceKm,
        purchasePredictionDistanceContext.maxDistance || 0
      )
    },
    logger: console,
    concurrency: COVERAGE_AI_CONCURRENCY
  }))
  const [recoveryProfiles, purchasePredictionProfilesResult] = await Promise.all([
    recoveryProfilesPromise,
    purchasePredictionProfilesPromise
  ])
  const recoveryProfileByClientId = new Map(
    (Array.isArray(recoveryProfiles) ? recoveryProfiles : [])
      .map(profile => [String(profile?.client_id || '').trim(), profile])
      .filter(entry => entry[0])
  )
  const purchasePredictionProfileByClientId = new Map(
    (Array.isArray(purchasePredictionProfilesResult?.profiles) ? purchasePredictionProfilesResult.profiles : [])
      .map(profile => [String(profile?.client_id || '').trim(), profile])
      .filter(entry => entry[0])
  )
  const activeCommercialCodes = commercials.map(item => item.code)
  const optimizerPayload = await runCoveragePerfStage(perfTracker, 'build_client_payload', async () => ({
    planning_mode: planningMode,
    planning_start_date: startDate,
    planning_days: planningDays,
    planning_horizon_days: planningDays,
    visit_frequency_days: visitFrequencyDays,
    coverage_window_days: visitFrequencyDays,
    daily_max_mode: dailyMaxMode,
    strict_ca: strictCa,
    default_max_visits_per_slot: adjustedTargetMaxVisitsPerSlot,
    user_min_visits_per_slot: normalizedUserMinVisits,
    user_max_visits_per_slot: normalizedUserMaxVisits,
    min_daily_ca_per_commercial: roundScore(minDailyCaPerCommercial),
    allow_commercial_reassignment: allowCommercialReassignment,
    working_days: workingDaySelection,
    capacity_mode: capacityModeContext.capacityMode,
    time_capacity_known: timeCapacityKnown,
    operational_capacity_known: operationalCapacityKnown,
    depot: SHARED_DEPOT_ORIGIN,
    commercials,
    clients: clients.map(client => {
      const purchasePredictionContext = purchasePredictionProfileByClientId.get(String(client.client_id || '').trim()) || null
      const predictedCaContext = isSalesCoverageMode && purchasePredictionContext?.purchase_prediction_known
        ? {
            predicted_ca: purchasePredictionContext.expected_order_value,
            predicted_ca_known: purchasePredictionContext.expected_order_value != null,
            predicted_ca_source: purchasePredictionContext.purchase_prediction_source || 'dashboard_fetchLoggedAiPredictions'
          }
        : resolveCoveragePredictedCa(client.history_metrics)
      const recoveryContext = isSalesCoverageMode
        ? buildCoverageRecoveryPayloadFields(null)
        : buildCoverageRecoveryPayloadFields(
            recoveryProfileByClientId.get(String(client.client_id || '').trim()) || null
          )
      const historicalCommercialCode = String(
        client.historical_commercial_code ||
        client.resolved_commercial_code ||
        client.user_code ||
        ''
      ).trim()
      const clientRestriction = resolveCoverageClientRestriction({
        clientId: client.client_id,
        constraintEntry: coverageConstraints.client_restrictions?.[String(client.client_id || '').trim()],
        historicalCommercialCode,
        activeCommercialCodes,
        allowCommercialReassignment
      })

      return {
        client_id: String(client.client_id || '').trim(),
        client_code: String(client.client_code || client.nbr_client || '').trim(),
        client_name: String(client.nom || client.client_code || client.nbr_client || '').trim(),
        address: String(client.adresse || '').trim() || null,
        latitude: Number.isFinite(Number(client.latitude)) ? Number(client.latitude) : null,
        longitude: Number.isFinite(Number(client.longitude)) ? Number(client.longitude) : null,
        historical_commercial_code: historicalCommercialCode,
        allowed_commercial_codes: clientRestriction.allowed_commercial_codes,
        user_code: String(client.user_code || '').trim() || null,
        delegation: String(client.delegation || '').trim() || null,
        routing_code: String(client.routing_code || '').trim() || null,
        region: String(client.region || '').trim() || null,
        commercial_zone: buildCoverageCommercialZoneLabel(client),
        predicted_ca: predictedCaContext.predicted_ca == null
          ? null
          : roundScore(Math.max(0, Number(predictedCaContext.predicted_ca))),
        predicted_ca_source: predictedCaContext.predicted_ca_source,
        predicted_ca_known: predictedCaContext.predicted_ca_known,
        predicted_load_units: roundScore(
          Math.max(
            0.1,
            Number(client.history_metrics?.avg_load_units_hist || 0) || 1
          )
        ),
        service_minutes: clientRestriction.service_minutes == null
          ? null
          : roundScore(Math.max(0, Number(clientRestriction.service_minutes))),
        service_minutes_known: clientRestriction.service_minutes != null && Number.isFinite(Number(clientRestriction.service_minutes)),
        estimated_stop_minutes_by_commercial_date: {
          ...(clientRestriction.estimated_stop_minutes_by_commercial_date || {})
        },
        recovery_total_balance: recoveryContext.recovery_total_balance,
        recovery_due_amount: recoveryContext.recovery_due_amount,
        recovery_days_past_due: recoveryContext.recovery_days_past_due,
        recovery_expected_next_payment_date: recoveryContext.recovery_expected_next_payment_date,
        recovery_days_since_expected_payment: recoveryContext.recovery_days_since_expected_payment,
        recovery_payment_behavior_score: recoveryContext.recovery_payment_behavior_score,
        recovery_expected_collection_amount: recoveryContext.recovery_expected_collection_amount,
        recovery_priority_score: recoveryContext.recovery_priority_score,
        recovery_data_known: recoveryContext.recovery_data_known,
        recovery_source: recoveryContext.recovery_source,
        purchase_prediction_score: purchasePredictionContext?.purchase_prediction_score ?? null,
        predicted_purchase_date: purchasePredictionContext?.predicted_purchase_date ?? null,
        purchase_days_until_prediction: purchasePredictionContext?.purchase_days_until_prediction ?? null,
        recommended_quantity: purchasePredictionContext?.recommended_quantity ?? null,
        expected_order_value: purchasePredictionContext?.expected_order_value ?? null,
        predicted_products: Array.isArray(purchasePredictionContext?.predicted_products)
          ? purchasePredictionContext.predicted_products.map(item => ({
              name: String(item?.name || '').trim(),
              quantity: roundScore(Math.max(0, Number(item?.quantity || 0) || 0))
            })).filter(item => item.name && item.quantity > 0)
          : [],
        purchase_prediction_known: Boolean(purchasePredictionContext?.purchase_prediction_known),
        purchase_prediction_source: purchasePredictionContext?.purchase_prediction_source ?? null,
        last_real_visit_date: client.last_real_visit_date || null,
        visit_frequency_days: visitFrequencyDays,
        is_mandatory: true
      }
    })
  }))
  assertCoverageConstraintPayload(optimizerPayload)

  const totalConfiguredCapacity = commercials.reduce(
    (sum, item) => sum + Object.values(item.max_visits_by_date || {}).reduce((slotSum, value) => slotSum + Number(value || 0), 0),
    0
  )

  return {
    startDate,
    planningMode,
    planningDays,
    planningHorizonDays: planningDays,
    visitFrequencyDays,
    coverageWindowDays: visitFrequencyDays,
    dailyMaxMode,
    requiredVisitsCount,
    capacityPrecheck,
    requestedManualMaxVisits,
    requestedUserMinVisits,
    requestedUserMaxVisits,
    normalizedUserMinVisits,
    normalizedUserMaxVisits,
    recommendedMaxVisitsPerSlot,
    adjustedTargetMaxVisitsPerSlot,
    resolvedMaxVisitsPerSlot,
    historyCacheHits: coverageHistoryCacheMetrics.hits,
    historyCacheMisses: coverageHistoryCacheMetrics.misses,
    historyBuildMs: Math.round(Number(coverageHistoryCacheMetrics.buildMs || 0)),
    historicalSoftCapacityTotal,
    salesActivityProxyTotal,
    capacityMode: capacityModeContext.capacityMode,
    timeCapacityKnown,
    operationalCapacityKnown,
    hardPhysicalCapacityTotal,
    hardPhysicalLimitedSlotsCount,
    maxHardPhysicalMaxVisitsPerSlot,
    minDailyCaPerCommercial,
    strictCa,
    allowCommercialReassignment,
    workingDaySelection,
    planningDaysList,
    selectedCommercials,
    clientScope,
    selectedClientIds,
    activeCommercials: commercials,
    totalSlots,
    totalConfiguredCapacity,
    theoreticalTotalSlots: planningDaysList.length * selectedCommercials.length,
    activeDaysCount: planningDaysList.length,
    selectedClientsCount: clients.length,
    dedupedClientResult,
    historyMatchDiagnostics,
    coverageConstraints,
    optimizerPayload
  }
}

function parseCommercialSelection(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue.map(value => String(value || '').trim()).filter(Boolean)
  }

  if (!rawValue) return []

  return String(rawValue)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

function isStrictIsoDateOnly(value) {
  const rawValue = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    return false
  }

  const [year, month, day] = rawValue.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)
  parsed.setHours(0, 0, 0, 0)
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  )
}

function parseIntegerLikeForNextBestVisitHttp(value) {
  const rawValue = String(value ?? '').trim()
  if (rawValue === '') {
    return { empty: true, valid: true, value: null }
  }

  if (!/^-?\d+$/.test(rawValue)) {
    return { empty: false, valid: false, value: null }
  }

  return {
    empty: false,
    valid: true,
    value: Number.parseInt(rawValue, 10)
  }
}

async function validateNextBestVisitHttpRequest(rawBody = {}, dependencyOverrides = {}) {
  const fetchCommercialOptionsImpl = typeof dependencyOverrides.fetchCommercialOptions === 'function'
    ? dependencyOverrides.fetchCommercialOptions
    : fetchCommercialOptions
  const todayIso = String(
    dependencyOverrides.todayIso ||
    formatLocalDate(new Date())
  ).trim()
  const startDate = String(rawBody.start_date ?? rawBody.planning_start_date ?? '').trim()

  if (!isStrictIsoDateOnly(startDate)) {
    return {
      valid: false,
      message: 'La date de debut du plan de tournees ventes est invalide.'
    }
  }

  if (startDate < todayIso) {
    return {
      valid: false,
      message: 'La date de debut du plan de tournees ventes ne peut pas etre dans le passe.'
    }
  }

  const planningDays = parseIntegerLikeForNextBestVisitHttp(
    rawBody.planning_horizon_days ?? rawBody.period_days ?? rawBody.planning_days
  )
  if (!planningDays.valid || planningDays.value < 1 || planningDays.value > 60) {
    return {
      valid: false,
      message: 'La periode du plan de tournees ventes doit etre comprise entre 1 et 60 jours.'
    }
  }

  const minClients = parseIntegerLikeForNextBestVisitHttp(
    rawBody.minimum_clients ?? rawBody.min_clients ?? rawBody.min_visits
  )
  if (!minClients.valid || (!minClients.empty && minClients.value < 0)) {
    return {
      valid: false,
      message: 'La charge cible par commercial et par jour ne peut pas etre negative.'
    }
  }

  const maxClients = parseIntegerLikeForNextBestVisitHttp(
    rawBody.maximum_clients ?? rawBody.max_clients ?? rawBody.max_visits
  )
  if (!maxClients.valid || (!maxClients.empty && maxClients.value < 0)) {
    return {
      valid: false,
      message: 'Le maximum par commercial et par jour ne peut pas etre negatif.'
    }
  }

  const hasStrictMaximum = !maxClients.empty && maxClients.value > 0
  if (
    normalizeDailyMaxMode(rawBody.daily_max_mode) === DAILY_MAX_MODE_STRICT &&
    hasStrictMaximum &&
    Number(minClients.value || 0) > Number(maxClients.value || 0)
  ) {
    return {
      valid: false,
      message: 'En mode maximum strict, la charge cible ne peut pas depasser le maximum renseigne.'
    }
  }

  const selectedCommercialCodes = parseCommercialSelection(
    rawBody.commercials ??
    rawBody.commercial_codes ??
    rawBody.commercial ??
    rawBody.commercial_code
  )

  if (!selectedCommercialCodes.length) {
    return {
      valid: false,
      message: 'Selectionne au moins un commercial pour generer le plan de tournees ventes.'
    }
  }

  const allCommercials = await fetchCommercialOptionsImpl()
  const validCommercialCodes = new Set(
    (Array.isArray(allCommercials) ? allCommercials : [])
      .map(item => String(item?.value || '').trim())
      .filter(Boolean)
  )
  const unknownCommercialCodes = [...new Set(
    selectedCommercialCodes.filter(code => !validCommercialCodes.has(code))
  )]

  if (unknownCommercialCodes.length) {
    return {
      valid: false,
      message: `Codes commerciaux introuvables : ${unknownCommercialCodes.join(', ')}.`
    }
  }

  return {
    valid: true,
    normalizedBody: {
      ...rawBody,
      start_date: startDate,
      commercial_codes: selectedCommercialCodes,
      commercials: selectedCommercialCodes,
      commercial: selectedCommercialCodes.length === 1 ? selectedCommercialCodes[0] : null
    }
  }
}

function normalizeSingleSalesV2BlockPayload(rawBody = {}) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {}
  const nestedBlocks = Array.isArray(body.blocks) ? body.blocks.filter(block => block && typeof block === 'object') : []

  if (nestedBlocks.length > 1) {
    const error = new Error('Un seul bloc Sales V2 (commercial + date) peut etre valide a la fois.')
    error.statusCode = 400
    throw error
  }

  const baseBlock = body.block && typeof body.block === 'object'
    ? body.block
    : (nestedBlocks[0] || body)
  const dateCandidate = String(body.date ?? baseBlock.date ?? '').trim()
  const commercialCode = String(body.commercial_code ?? baseBlock.commercial_code ?? '').trim()
  const commercialLabel = String(
    body.commercial_label ??
    baseBlock.commercial_label ??
    baseBlock.commercial_name ??
    `Commercial ${commercialCode}`
  ).trim()
  const clients = Array.isArray(baseBlock.clients)
    ? baseBlock.clients
    : (Array.isArray(body.clients) ? body.clients : [])

  if (!isStrictIsoDateOnly(dateCandidate)) {
    const error = new Error('La date du bloc Sales V2 est invalide.')
    error.statusCode = 400
    throw error
  }

  if (!commercialCode) {
    const error = new Error('Le commercial du bloc Sales V2 est obligatoire.')
    error.statusCode = 400
    throw error
  }

  if (!clients.length) {
    const error = new Error('Le bloc Sales V2 ne contient aucune visite a valider.')
    error.statusCode = 400
    throw error
  }

  return {
    date: formatLocalDate(parseLocalDate(dateCandidate)),
    dayLabel: String(body.day_label ?? baseBlock.day_label ?? '').trim() || null,
    commercialCode,
    commercialLabel: commercialLabel || `Commercial ${commercialCode}`,
    routeCode: String(body.route_code ?? baseBlock.route_code ?? '').trim(),
    depotCode: String(body.depot_code ?? baseBlock.depot_code ?? '').trim(),
    depotName: String(body.depot_name ?? baseBlock.depot_name ?? '').trim(),
    slotId: String(baseBlock.slot_id ?? body.slot_id ?? `${dateCandidate}::${commercialCode}`).trim(),
    clients
  }
}

function buildSalesV2ValidationSeeds(blockPayload) {
  const stops = []

  blockPayload.clients.forEach((client, index) => {
    const clientCode = normalizeExactClientCode(client?.client_code ?? client?.nbr_client)

    if (!clientCode) {
      const error = new Error(`La visite #${index + 1} du bloc Sales V2 n'a pas de client_code exploitable.`)
      error.statusCode = 400
      throw error
    }

    stops.push({
      client_id: normalizeClientId(client?.client_id ?? client?.id ?? client?.client_unique_key),
      client_code: clientCode,
      client_name: String(client?.client_name ?? client?.nom ?? '').trim(),
      adresse: String(client?.adresse ?? '').trim(),
      latitude: Number.isFinite(Number(client?.latitude)) ? String(Number(client.latitude)) : null,
      longitude: Number.isFinite(Number(client?.longitude)) ? String(Number(client.longitude)) : null,
      rang: Number.isFinite(Number(client?.rang)) && Number(client.rang) > 0 ? Number(client.rang) : index + 1
    })
  })

  return {
    stops
  }
}

async function validateSalesV2BlockRequest(blockPayload, dependencyOverrides = {}) {
  const fetchCommercialOptionsImpl = typeof dependencyOverrides.fetchCommercialOptions === 'function'
    ? dependencyOverrides.fetchCommercialOptions
    : fetchCommercialOptions
  const todayIso = String(
    dependencyOverrides.todayIso ||
    formatLocalDate(new Date())
  ).trim()

  if (blockPayload.date < todayIso) {
    const error = new Error('La date du bloc Sales V2 ne peut pas etre dans le passe.')
    error.statusCode = 400
    throw error
  }

  const allCommercials = await fetchCommercialOptionsImpl()
  const activeCommercialCodes = new Set(
    (Array.isArray(allCommercials) ? allCommercials : [])
      .map(item => String(item?.value || '').trim())
      .filter(Boolean)
  )

  if (!activeCommercialCodes.has(blockPayload.commercialCode)) {
    const error = new Error(`Le commercial du bloc Sales V2 est introuvable ou inactif: ${blockPayload.commercialCode}.`)
    error.statusCode = 400
    throw error
  }
}

function buildSalesV2ValidationVisits(blockPayload, normalizedStops) {
  const visits = normalizedStops.map((stop, index) => {
    const client = blockPayload.clients[index] && typeof blockPayload.clients[index] === 'object'
      ? blockPayload.clients[index]
      : {}

    return buildPlannedVisitMetadata({
      ...client,
      client_id: stop.client_id,
      client_code: stop.client_code,
      assigned_slot_id: blockPayload.slotId,
      assigned_date: blockPayload.date,
      planned_date: blockPayload.date,
      candidate_date: blockPayload.date,
      commercial_code: blockPayload.commercialCode
    })
  })

  const plannedVisitIds = visits.map(visit => visit.planned_visit_id)
  if (new Set(plannedVisitIds).size !== plannedVisitIds.length) {
    const error = new Error('Le bloc Sales V2 contient des visites dupliquees pour un meme commercial et une meme date.')
    error.statusCode = 400
    throw error
  }

  return visits
}

async function validateNextBestVisitBlockPlan(rawBody = {}, dependencyOverrides = {}) {
  const blockPayload = normalizeSingleSalesV2BlockPayload(rawBody)
  const {
    stops
  } = buildSalesV2ValidationSeeds(blockPayload)
  const ensureCoverageSupportTablesImpl = typeof dependencyOverrides.ensureCoverageSupportTables === 'function'
    ? dependencyOverrides.ensureCoverageSupportTables
    : ensureCoverageSupportTables
  const ensureValidatedTourneeIdentityColumnsImpl = typeof dependencyOverrides.ensureValidatedTourneeIdentityColumns === 'function'
    ? dependencyOverrides.ensureValidatedTourneeIdentityColumns
    : ensureValidatedTourneeIdentityColumns
  const withTransactionImpl = typeof dependencyOverrides.withTransaction === 'function'
    ? dependencyOverrides.withTransaction
    : withTransaction
  const queryAsyncImpl = typeof dependencyOverrides.queryAsync === 'function'
    ? dependencyOverrides.queryAsync
    : queryAsync
  const replacePendingSalesVisitFeedbackForTourneeImpl = typeof dependencyOverrides.replacePendingSalesVisitFeedbackForTournee === 'function'
    ? dependencyOverrides.replacePendingSalesVisitFeedbackForTournee
    : replacePendingSalesVisitFeedbackForTournee

  await validateSalesV2BlockRequest(blockPayload, dependencyOverrides)
  await ensureCoverageSupportTablesImpl()
  await ensureValidatedTourneeIdentityColumnsImpl()

  const normalizedStops = await validateAndResolveValidatedTourneeStops(stops, {
    queryExecutor: queryAsyncImpl
  })
  const visits = buildSalesV2ValidationVisits(blockPayload, normalizedStops)
  const persisted = await withTransactionImpl(async connection => {
    await ensureValidatedTourneeIdentityColumnsImpl(connection)
    const txQueryAsync = async (sql, params = []) => queryAsyncImpl(sql, params, connection)

    const persistedTournee = await replaceValidatedTourneeRowsInTransaction({
      selectedDate: blockPayload.date,
      dayLabel: blockPayload.dayLabel,
      commercialCode: blockPayload.commercialCode,
      commercialLabel: blockPayload.commercialLabel,
      routeCode: blockPayload.routeCode,
      depotCode: blockPayload.depotCode,
      depotName: blockPayload.depotName,
      normalizedStops,
      frequence: 'sales_v2',
      categorieCode: 'sales_v2',
      typeClient: 'sales_v2_plan',
      codePrefix: 'sales-v2',
      connection,
      queryExecutor: txQueryAsync
    })

    const feedbackResult = await replacePendingSalesVisitFeedbackForTourneeImpl(txQueryAsync, {
      tournee_code: persistedTournee.validationCode,
      visits
    })

    return {
      persistedTournee,
      feedbackResult
    }
  }, { logPrefix: 'SALES_V2_VALIDATE' })

  return {
    status: 'success',
    message: `Le bloc Sales V2 du ${blockPayload.date} pour ${blockPayload.commercialLabel} a ete valide.`,
    saved_rows: normalizedStops.length,
    feedback_rows: persisted.feedbackResult.savedRows,
    tournee_code: persisted.persistedTournee.validationCode,
    commercial_code: blockPayload.commercialCode,
    date: blockPayload.date
  }
}

async function handleNextBestVisitValidationRoute(req, res, dependencyOverrides = {}) {
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {}
  const fetchCommercialOptionsImpl = typeof dependencyOverrides.fetchCommercialOptions === 'function'
    ? dependencyOverrides.fetchCommercialOptions
    : fetchCommercialOptions
  const todayIso = String(
    dependencyOverrides.todayIso ||
    req?.app?.locals?.todayIsoForTests ||
    formatLocalDate(new Date())
  ).trim()

  try {
    const result = await validateNextBestVisitBlockPlan(rawBody, {
      ...dependencyOverrides,
      fetchCommercialOptions: fetchCommercialOptionsImpl,
      todayIso
    })
    return res.json(result)
  } catch (error) {
    const statusCode = error.statusCode || 500
    console.error('Erreur validation bloc next-best-visits:', error.message)
    return res.status(statusCode).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant la validation du bloc Sales V2.'
    })
  }
}

function parseClientSelection(rawValue) {
  if (Array.isArray(rawValue)) {
    return [...new Set(
      rawValue
        .map(value => String(value || '').trim())
        .filter(Boolean)
    )]
  }

  if (!rawValue) return []

  return [...new Set(
    String(rawValue)
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  )]
}

function buildInClause(column, values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { sql: '', params: [] }
  }

  const placeholders = values.map(() => '?').join(', ')
  return {
    sql: ` AND ${column} IN (${placeholders})`,
    params: [...values]
  }
}

function buildOptionalInClause(column, values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { clause: '', params: [] }
  }

  const placeholders = values.map(() => '?').join(', ')
  return {
    clause: `${column} IN (${placeholders})`,
    params: [...values]
  }
}

function buildCoverageHistoryNormalizedCodeExpression(column) {
  return `COALESCE(NULLIF(TRIM(LEADING '0' FROM TRIM(${column})), ''), '0')`
}

function buildCoverageHistoryFilter({
  exactColumn,
  normalizedColumn,
  exactCodes = [],
  normalizedCodes = []
}) {
  const clauses = []
  const params = []
  const exactFilter = buildOptionalInClause(exactColumn, exactCodes)
  const normalizedFilter = buildOptionalInClause(normalizedColumn, normalizedCodes)

  if (exactFilter.clause) {
    clauses.push(exactFilter.clause)
    params.push(...exactFilter.params)
  }
  if (normalizedFilter.clause) {
    clauses.push(normalizedFilter.clause)
    params.push(...normalizedFilter.params)
  }

  return {
    sql: clauses.length ? ` AND (${clauses.join(' OR ')})` : '',
    params
  }
}

function createCoverageHistoryDiagnostics() {
  return {
    exact_match: 0,
    unique_normalized_match: 0,
    ambiguous_match: 0,
    no_match: 0,
    ambiguous_match_keys: new Set(),
    no_match_keys: new Set()
  }
}

function recordCoverageHistoryResolution(diagnostics, match) {
  if (!diagnostics || !match?.status) return

  if (match.status === 'exact_match') diagnostics.exact_match += 1
  else if (match.status === 'unique_normalized_match') diagnostics.unique_normalized_match += 1
  else if (match.status === 'ambiguous_match') {
    diagnostics.ambiguous_match += 1
    diagnostics.ambiguous_match_keys.add(
      `${match.normalized_code || ''}::${match.exact_code || ''}`
    )
  } else if (match.status === 'no_match') {
    diagnostics.no_match += 1
    diagnostics.no_match_keys.add(match.exact_code || '')
  }
}

function buildCoverageHistoryDiagnosticsResponse(diagnostics, activeIndexes) {
  return {
    resolution_counts: {
      exact_match: Number(diagnostics?.exact_match || 0),
      unique_normalized_match: Number(diagnostics?.unique_normalized_match || 0),
      ambiguous_match: Number(diagnostics?.ambiguous_match || 0),
      no_match: Number(diagnostics?.no_match || 0)
    },
    ambiguous_match_rows: diagnostics?.ambiguous_match_keys?.size || 0,
    no_match_rows: diagnostics?.no_match_keys?.size || 0,
    ambiguous_normalized_codes: Array.isArray(activeIndexes?.ambiguousNormalizedCodes)
      ? activeIndexes.ambiguousNormalizedCodes
      : []
  }
}

function buildCoverageCommercialZoneLabel(client = {}) {
  const explicitDashboardLabel = String(client.commercia_zone || '').trim()
  if (explicitDashboardLabel) {
    return explicitDashboardLabel
  }

  const userCode = String(
    client.user_code ||
    client.commercial_code ||
    client.historical_commercial_code ||
    client.resolved_commercial_code ||
    ''
  ).trim()
  const delegation = String(client.delegation || '').trim()
  if (userCode || delegation) {
    return `Comm ${userCode || '-'} - ${delegation || 'Zone inconnue'}`
  }

  const zoneLikeLabel = String(
    client.commercial_zone ||
    client.zone_comm ||
    client.routing_code ||
    client.region ||
    ''
  ).trim()
  if (zoneLikeLabel) {
    return zoneLikeLabel
  }

  return userCode || 'Non disponible'
}

function shouldReplaceCoverageHistoryEntry(previousEntry, nextDate, nextRank) {
  if (!previousEntry) return true
  const previousDate = String(previousEntry.activity_date || '')
  const candidateDate = String(nextDate || '')
  if (candidateDate > previousDate) return true
  if (candidateDate < previousDate) return false
  return Number(nextRank || 0) > Number(previousEntry.activity_rank || 0)
}

async function buildCoverageClientHistorySnapshot(activeClients = [], startDate = null, options = {}) {
  const cacheKey = buildCoverageHistoryCacheKey({
    name: 'buildCoverageClientHistorySnapshot',
    startDate,
    historyWindowDays: COVERAGE_HISTORY_WINDOW_DAYS,
    documentFilters: COVERAGE_HISTORY_FILTERS_CLIENT_HISTORY,
    activeClientIds: (Array.isArray(activeClients) ? activeClients : []).map(client => client?.client_id),
    database: DB_CONFIG.database,
    logicalSchemaVersion: COVERAGE_HISTORY_SCHEMA_VERSION,
    sqlVersion: 'client_history_snapshot_sql_v3',
    codeVersion: COVERAGE_HISTORY_CODE_VERSION,
    dataVersion: COVERAGE_DATA_VERSION
  })

  return coverageHistoryCache.getOrCreate({
    key: cacheKey,
    type: 'client_history',
    metrics: options.cacheMetrics,
    build: async () => {
      return runCoveragePerfStage(options.perfTracker, 'load_client_history', async () => {
        const activeIndexes = buildActiveClientIndexes(activeClients)
        const exactCodes = activeIndexes.activeClients
          .map(client => normalizeExactClientCode(client.client_code))
          .filter(Boolean)
        const normalizedCodes = [...new Set(
          activeIndexes.activeClients
            .map(client => normalizeHistoricalClientCode(client.client_code))
            .filter(Boolean)
        )]

        if (!exactCodes.length) {
          return {
            activeIndexes,
            latestVisitCommercialByClientId: new Map(),
            latestDocCommercialByClientId: new Map(),
            lastVisitDateByClientId: new Map(),
            historyMetricsByClientId: new Map(),
            diagnostics: buildCoverageHistoryDiagnosticsResponse(
              createCoverageHistoryDiagnostics(),
              activeIndexes
            )
          }
        }

        const visitHistoryFilter = buildCoverageHistoryFilter({
          exactColumn: 'TRIM(v.client_code)',
          normalizedColumn: buildCoverageHistoryNormalizedCodeExpression('v.client_code'),
          exactCodes,
          normalizedCodes
        })
        const docHistoryFilter = buildCoverageHistoryFilter({
          exactColumn: 'TRIM(e.client_code)',
          normalizedColumn: buildCoverageHistoryNormalizedCodeExpression('e.client_code'),
          exactCodes,
          normalizedCodes
        })

      const queryPromises = [
        queryAsync(
          `
            SELECT
              TRIM(v.client_code) AS historical_client_code,
              TRIM(v.commercial_code) AS commercial_code,
              DATE(v.check_in_at) AS activity_date,
              v.id AS activity_rank
            FROM client_visits v
            WHERE v.validation_status = 'validated'
              AND v.check_in_at IS NOT NULL
              AND TRIM(COALESCE(v.client_code, '')) <> ''
              AND TRIM(COALESCE(v.commercial_code, '')) <> ''
              ${visitHistoryFilter.sql}
          `,
          visitHistoryFilter.params
        ),
        queryAsync(
          `
            SELECT
              TRIM(e.client_code) AS historical_client_code,
              COALESCE(NULLIF(TRIM(e.commercial_code), ''), NULLIF(TRIM(e.user_code), '')) AS commercial_code,
              DATE(e.date) AS activity_date,
              e.code AS activity_rank
            FROM entetecommercials e
            WHERE e.deleted_at IS NULL
              AND e.type IN ('facture', 'bl', 'blf')
              AND TRIM(COALESCE(e.client_code, '')) <> ''
              AND COALESCE(NULLIF(TRIM(e.commercial_code), ''), NULLIF(TRIM(e.user_code), '')) IS NOT NULL
              ${docHistoryFilter.sql}
          `,
          docHistoryFilter.params
        ),
        queryAsync(
          `
            SELECT
              TRIM(v.client_code) AS historical_client_code,
              MAX(DATE(v.check_in_at)) AS last_real_visit_date
            FROM client_visits v
            WHERE v.validation_status = 'validated'
              AND v.check_in_at IS NOT NULL
              AND TRIM(COALESCE(v.client_code, '')) <> ''
              ${visitHistoryFilter.sql}
            GROUP BY TRIM(v.client_code)
          `,
          visitHistoryFilter.params
        )
      ]

      if (startDate) {
        queryPromises.push(queryAsync(
          `
            SELECT
              TRIM(e.client_code) AS historical_client_code,
              AVG(CAST(COALESCE(e.net_a_payer, '0') AS DECIMAL(15,3))) AS avg_ca_hist,
              AVG(COALESCE(doc_quantities.total_quantity, 0)) AS avg_load_units_hist
            FROM entetecommercials e
            LEFT JOIN (
              SELECT
                l.entetecommercial_code AS doc_code,
                SUM(CAST(COALESCE(l.quantite, '0') AS DECIMAL(15,3))) AS total_quantity
              FROM lignecommercials l
              GROUP BY l.entetecommercial_code
            ) doc_quantities ON doc_quantities.doc_code = e.code
            WHERE e.deleted_at IS NULL
              AND e.type IN ('facture', 'bl', 'blf')
              AND ${buildCoverageNonCancelledDocumentSqlCondition('e.annule')}
              AND DATE(e.date) <= ?
              AND DATE(e.date) >= DATE_SUB(?, INTERVAL ${COVERAGE_HISTORY_METRICS_WINDOW_DAYS} DAY)
              AND TRIM(COALESCE(e.client_code, '')) <> ''
              ${docHistoryFilter.sql}
            GROUP BY TRIM(e.client_code)
          `,
          [startDate, startDate, ...docHistoryFilter.params]
        ))
      }

      const [visitCommercialRows, docCommercialRows, lastVisitRows, historicalMetricRows = []] = await Promise.all(queryPromises)
      const latestVisitCommercialByClientId = new Map()
      const latestDocCommercialByClientId = new Map()
      const lastVisitDateByClientId = new Map()
      const historyMetricsByClientId = new Map()
      const diagnostics = createCoverageHistoryDiagnostics()

      const applyCommercialActivity = (rows, targetMap) => {
        ;(rows || []).forEach(row => {
          const match = resolveHistoricalClientMatch(row.historical_client_code, activeIndexes)
          recordCoverageHistoryResolution(diagnostics, match)
          if (!['exact_match', 'unique_normalized_match'].includes(match.status)) return

          const clientId = normalizeClientId(match.client_id)
          const commercialCode = normalizeExactClientCode(row.commercial_code)
          const activityDate = normalizeDateOnly(row.activity_date)
          if (!clientId || !commercialCode || !activityDate) return

          if (shouldReplaceCoverageHistoryEntry(targetMap.get(clientId), activityDate, row.activity_rank)) {
            targetMap.set(clientId, {
              commercial_code: commercialCode,
              activity_date: activityDate,
              activity_rank: row.activity_rank
            })
          }
        })
      }

      applyCommercialActivity(visitCommercialRows, latestVisitCommercialByClientId)
      applyCommercialActivity(docCommercialRows, latestDocCommercialByClientId)

      ;(lastVisitRows || []).forEach(row => {
        const match = resolveHistoricalClientMatch(row.historical_client_code, activeIndexes)
        recordCoverageHistoryResolution(diagnostics, match)
        if (!['exact_match', 'unique_normalized_match'].includes(match.status)) return

        const clientId = normalizeClientId(match.client_id)
        const lastRealVisitDate = normalizeDateOnly(row.last_real_visit_date)
        if (!clientId || !lastRealVisitDate) return

        const previousDate = normalizeDateOnly(lastVisitDateByClientId.get(clientId))
        if (!previousDate || lastRealVisitDate > previousDate) {
          lastVisitDateByClientId.set(clientId, lastRealVisitDate)
        }
      })

      ;(historicalMetricRows || []).forEach(row => {
        const match = resolveHistoricalClientMatch(row.historical_client_code, activeIndexes)
        recordCoverageHistoryResolution(diagnostics, match)
        if (!['exact_match', 'unique_normalized_match'].includes(match.status)) return

        const clientId = normalizeClientId(match.client_id)
        if (!clientId) return

        const existing = historyMetricsByClientId.get(clientId) || {
          avg_ca_hist_sum: 0,
          avg_ca_hist_count: 0,
          avg_load_units_hist_sum: 0,
          avg_load_units_hist_count: 0
        }

        const avgCaHist = Number(row.avg_ca_hist || 0)
        const avgLoadUnitsHist = Number(row.avg_load_units_hist || 0)
        if (Number.isFinite(avgCaHist)) {
          existing.avg_ca_hist_sum += avgCaHist
          existing.avg_ca_hist_count += 1
        }
        if (Number.isFinite(avgLoadUnitsHist)) {
          existing.avg_load_units_hist_sum += avgLoadUnitsHist
          existing.avg_load_units_hist_count += 1
        }
        historyMetricsByClientId.set(clientId, existing)
      })

      historyMetricsByClientId.forEach((value, clientId) => {
        historyMetricsByClientId.set(clientId, {
          avg_ca_hist: value.avg_ca_hist_count > 0
            ? value.avg_ca_hist_sum / value.avg_ca_hist_count
            : 0,
          avg_load_units_hist: value.avg_load_units_hist_count > 0
            ? value.avg_load_units_hist_sum / value.avg_load_units_hist_count
            : 0
        })
      })

        return {
          activeIndexes,
          latestVisitCommercialByClientId,
          latestDocCommercialByClientId,
          lastVisitDateByClientId,
          historyMetricsByClientId,
          diagnostics: buildCoverageHistoryDiagnosticsResponse(diagnostics, activeIndexes)
        }
      })
    }
  })
}

async function fetchCoverageActiveClients({
  selectedCommercialCodes = [],
  selectedClientIds = [],
  startDate = null,
  allCommercialsSelected = false,
  clientScope = null,
  cacheMetrics = null,
  perfTracker = null
} = {}) {
  const rawClients = await runCoveragePerfStage(perfTracker, 'load_active_clients', async () => queryAsync(`
    SELECT
      c.id AS client_id,
      c.code AS client_code,
      c.nom,
      c.user_code,
      c.routing_code,
      c.delegation,
      c.region,
      c.potentiel,
      c.adresse_facturation AS adresse,
      c.latitude,
      c.longitude
    FROM clients c
    WHERE c.deleted_at IS NULL
      AND c.isactif = '1'
    ORDER BY c.nom, c.code
  `))

  const dedupedClientResult = dedupeCoverageClientRows(rawClients || [])
  const historySnapshot = await buildCoverageClientHistorySnapshot(
    dedupedClientResult.rows,
    startDate,
    { cacheMetrics, perfTracker }
  )
  const selectedClientIdSet = new Set(
    (Array.isArray(selectedClientIds) ? selectedClientIds : [])
      .map(value => normalizeClientId(value))
      .filter(Boolean)
  )
  const selectedCommercialSet = new Set(
    (Array.isArray(selectedCommercialCodes) ? selectedCommercialCodes : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )
  const resolvedClientScope = clientScope && typeof clientScope === 'object'
    ? clientScope
    : resolveCoverageClientScope({
        selectedCommercialCodes: [...selectedCommercialSet],
        selectedClientIds: [...selectedClientIdSet],
        availableCommercialCodes: allCommercialsSelected ? [...selectedCommercialSet] : []
      })

  const clients = filterCoverageClientsByScope(
    historySnapshot.activeIndexes.activeClients
    .map(client => {
      const clientId = normalizeClientId(client.client_id)
      const clientCode = normalizeExactClientCode(client.client_code || client.nbr_client)
      const resolvedCommercialCode = normalizeExactClientCode(client.user_code) ||
        normalizeExactClientCode(historySnapshot.latestVisitCommercialByClientId.get(clientId)?.commercial_code) ||
        normalizeExactClientCode(historySnapshot.latestDocCommercialByClientId.get(clientId)?.commercial_code)

      return {
        ...client,
        client_id: clientId,
        client_code: clientCode,
        nbr_client: clientCode,
        resolved_commercial_code: resolvedCommercialCode,
        historical_commercial_code: resolvedCommercialCode,
        last_real_visit_date: historySnapshot.lastVisitDateByClientId.get(clientId) || null,
        history_metrics: historySnapshot.historyMetricsByClientId.get(clientId) || null
      }
    }),
    resolvedClientScope
  )

  return {
    clients,
    dedupedClientResult,
    historySnapshot
  }
}

async function fetchCoverageConstraintClientIds({
  selectedCommercialCodes = [],
  selectedClientIds = [],
  allCommercialsSelected = false,
  clientScope = null
} = {}) {
  const selectedClientIdSet = new Set(
    (Array.isArray(selectedClientIds) ? selectedClientIds : [])
      .map(value => normalizeClientId(value))
      .filter(Boolean)
  )
  const selectedCommercialSet = new Set(
    (Array.isArray(selectedCommercialCodes) ? selectedCommercialCodes : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )
  const resolvedClientScope = clientScope && typeof clientScope === 'object'
    ? clientScope
    : resolveCoverageClientScope({
        selectedCommercialCodes: [...selectedCommercialSet],
        selectedClientIds: [...selectedClientIdSet],
        availableCommercialCodes: allCommercialsSelected ? [...selectedCommercialSet] : []
      })
  const rows = await queryAsync(`
      SELECT
        c.id AS client_id,
        c.user_code
      FROM clients c
      WHERE c.deleted_at IS NULL
        AND c.isactif = '1'
      ORDER BY c.id ASC
    `)

  return (rows || [])
    .map(row => ({
      client_id: normalizeClientId(row.client_id),
      user_code: String(row.user_code || '').trim()
    }))
    .filter(row => row.client_id)
    .filter(row => (
      resolvedClientScope.selectedClientIdSet.size === 0 || resolvedClientScope.selectedClientIdSet.has(row.client_id)
    ))
    .filter(row => (
      !resolvedClientScope.commercialFilterApplied ||
      resolvedClientScope.selectedCommercialSet.has(row.user_code)
    ))
    .map(row => row.client_id)
}

function extractNumericCapacityHint(rawValue) {
  const normalized = String(rawValue || '').trim().toLowerCase()
  if (!normalized) return null

  // A depot/routing code often contains digits that are identifiers, not truck capacity.
  // Only treat a value as a capacity hint when the text explicitly looks like a capacity field.
  if (!/(cap|capac|charge|chargement|qte|qty|quant|unit|unite|u\b|palette|pal)/.test(normalized)) {
    return null
  }

  const matches = normalized.match(/\d+(?:[.,]\d+)?/g)
  if (!matches || matches.length === 0) return null

  const rawNumber = String(matches[matches.length - 1] || '').replace(',', '.')
  const parsed = Number(rawNumber)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

function computeQuantile(sortedValues, percentile) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0
  if (sortedValues.length === 1) return Number(sortedValues[0] || 0)

  const safePercentile = clamp(Number(percentile || 0), 0, 1)
  const position = (sortedValues.length - 1) * safePercentile
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lowerValue = Number(sortedValues[lowerIndex] || 0)
  const upperValue = Number(sortedValues[upperIndex] || 0)

  if (lowerIndex === upperIndex) return lowerValue

  const weight = position - lowerIndex
  return lowerValue + ((upperValue - lowerValue) * weight)
}

function summarizeNumericSeries(values) {
  const normalized = (Array.isArray(values) ? values : [])
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)

  if (normalized.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p75: 0,
      p90: 0
    }
  }

  const total = normalized.reduce((sum, value) => sum + value, 0)

  return {
    count: normalized.length,
    min: normalized[0],
    max: normalized[normalized.length - 1],
    avg: total / normalized.length,
    p50: computeQuantile(normalized, 0.5),
    p75: computeQuantile(normalized, 0.75),
    p90: computeQuantile(normalized, 0.9)
  }
}

function deriveClientCapacityFromStats(stats) {
  if (!stats || !stats.count) return null

  const base = Math.max(
    Number(stats.p75 || 0),
    Number(stats.p90 || 0) * 0.95,
    Number(stats.avg || 0) * 1.05,
    stats.count < 4 ? Number(stats.max || 0) : 0
  )

  return Math.max(1, Math.round(clamp(base, 1, 250)))
}

function deriveLoadUnitsPerClientFromStats(stats) {
  if (!stats || !stats.count) return null

  const base = Math.max(
    Number(stats.p75 || 0),
    Number(stats.avg || 0),
    stats.count < 4 ? Number(stats.max || 0) : 0
  )

  if (!(base > 0)) return null
  return roundScore(Math.max(0.25, base))
}

function deriveTruckCapacityFromStats(stats, routeCapacityHint = null) {
  const safeRouteHint = Number(routeCapacityHint || 0)
  let derived = 0

  if (stats && stats.count) {
    derived = Math.max(
      Number(stats.p75 || 0) * 1.05,
      Number(stats.p90 || 0) * 0.95,
      Number(stats.avg || 0) * 1.10,
      stats.count < 4 ? Number(stats.max || 0) : 0
    )
  }

  if (Number.isFinite(safeRouteHint) && safeRouteHint > 0) {
    derived = derived > 0
      ? Math.min(safeRouteHint, Math.max(derived, safeRouteHint * 0.6))
      : safeRouteHint
  }

  if (!(derived > 0)) return null
  return Math.max(1, Math.round(derived))
}

function deriveCapacitySignalConfidence(stats, sourceMode = COVERAGE_CAPACITY_MODE_SALES_PROXY) {
  const count = Number(stats?.count || 0)

  if (sourceMode === COVERAGE_CAPACITY_MODE_VALIDATED_VISIT) {
    if (count >= 60) return 'high'
    if (count >= 20) return 'medium'
    return 'low'
  }

  if (count >= 20) return 'medium'
  return 'low'
}

function countCapacityProfileActiveDays(profiles) {
  let total = 0

  ;(profiles instanceof Map ? [...profiles.values()] : []).forEach(profile => {
    total += Number(profile?.overall?.count || 0)
  })

  return total
}

function resolveCoverageCapacityMode({ visitProfiles, salesProfiles }) {
  const validatedVisitActiveDays = countCapacityProfileActiveDays(visitProfiles)
  if (validatedVisitActiveDays >= COVERAGE_VALIDATED_VISIT_MIN_ACTIVE_DAYS) {
    return {
      capacityMode: COVERAGE_CAPACITY_MODE_VALIDATED_VISIT,
      operationalCapacityKnown: true,
      validatedVisitActiveDays
    }
  }

  const salesActiveDays = countCapacityProfileActiveDays(salesProfiles)
  if (salesActiveDays > 0) {
    return {
      capacityMode: COVERAGE_CAPACITY_MODE_SALES_PROXY,
      operationalCapacityKnown: false,
      validatedVisitActiveDays
    }
  }

  return {
    capacityMode: COVERAGE_CAPACITY_MODE_UNKNOWN,
    operationalCapacityKnown: false,
    validatedVisitActiveDays
  }
}

function buildCommercialCapacityProfiles(activityRows, routeHintRows, sourceMode = COVERAGE_CAPACITY_MODE_SALES_PROXY) {
  const profiles = new Map()
  const routeHintsByCommercial = new Map()

  ;(routeHintRows || []).forEach(row => {
    const commercialCode = String(row.commercial_code || '').trim()
    if (!commercialCode) return

    const routeHint = extractNumericCapacityHint(row.depot_code)
    if (!Number.isFinite(routeHint) || routeHint <= 0) return

    if (!routeHintsByCommercial.has(commercialCode)) {
      routeHintsByCommercial.set(commercialCode, new Map())
    }

    const weight = Math.max(1, Number(row.nb_clients || 0))
    const commercialHints = routeHintsByCommercial.get(commercialCode)
    commercialHints.set(routeHint, (commercialHints.get(routeHint) || 0) + weight)
  })

  routeHintsByCommercial.forEach((_, commercialCode) => {
    if (!profiles.has(commercialCode)) {
      profiles.set(commercialCode, {
        commercial_code: commercialCode,
        overall: {
          clientSamples: [],
          loadSamples: [],
          loadPerClientSamples: []
        },
        byDayIndex: new Map()
      })
    }
  })

  ;(activityRows || []).forEach(row => {
    const commercialCode = String(row.commercial_code || '').trim()
    if (!commercialCode) return

    if (!profiles.has(commercialCode)) {
      profiles.set(commercialCode, {
        commercial_code: commercialCode,
        overall: {
          clientSamples: [],
          loadSamples: [],
          loadPerClientSamples: []
        },
        byDayIndex: new Map()
      })
    }

    const profile = profiles.get(commercialCode)
    const dayIndex = Number(row.day_index)
    const uniqueClients = Number(row.unique_clients || 0)
    const effectiveLoad = Math.max(
      0,
      Number(row.loading_quantity || 0),
      Number(row.total_quantity || 0)
    )

    profile.overall.clientSamples.push(uniqueClients)
    profile.overall.loadSamples.push(effectiveLoad)
    if (uniqueClients > 0 && effectiveLoad > 0) {
      profile.overall.loadPerClientSamples.push(effectiveLoad / uniqueClients)
    }

    if (!profile.byDayIndex.has(dayIndex)) {
      profile.byDayIndex.set(dayIndex, {
        clientSamples: [],
        loadSamples: [],
        loadPerClientSamples: []
      })
    }

    const dayProfile = profile.byDayIndex.get(dayIndex)
    dayProfile.clientSamples.push(uniqueClients)
    dayProfile.loadSamples.push(effectiveLoad)
    if (uniqueClients > 0 && effectiveLoad > 0) {
      dayProfile.loadPerClientSamples.push(effectiveLoad / uniqueClients)
    }
  })

  profiles.forEach((profile, commercialCode) => {
    const weightedHints = routeHintsByCommercial.get(commercialCode)
    const routeCapacityHint = weightedHints
      ? [...weightedHints.entries()]
          .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))[0]?.[0] || null
      : null

    const overallClientStats = summarizeNumericSeries(profile.overall.clientSamples)
    const overallLoadStats = summarizeNumericSeries(profile.overall.loadSamples)
    const overallLoadPerClientStats = summarizeNumericSeries(profile.overall.loadPerClientSamples)

    profile.overall = {
      ...overallClientStats,
      client_capacity_limit: deriveClientCapacityFromStats(overallClientStats),
      load_capacity_units: deriveTruckCapacityFromStats(overallLoadStats, routeCapacityHint),
      load_units_per_client: deriveLoadUnitsPerClientFromStats(overallLoadPerClientStats),
      route_capacity_hint: routeCapacityHint,
      capacity_signal_mode: sourceMode,
      confidence: deriveCapacitySignalConfidence(overallClientStats, sourceMode)
    }

    profile.byDayIndex.forEach((dayProfile, dayIndex) => {
      const clientStats = summarizeNumericSeries(dayProfile.clientSamples)
      const loadStats = summarizeNumericSeries(dayProfile.loadSamples)
      const loadPerClientStats = summarizeNumericSeries(dayProfile.loadPerClientSamples)
      profile.byDayIndex.set(dayIndex, {
        ...clientStats,
        client_capacity_limit: deriveClientCapacityFromStats(clientStats) || profile.overall.client_capacity_limit,
        load_capacity_units: deriveTruckCapacityFromStats(loadStats, routeCapacityHint) || profile.overall.load_capacity_units,
        load_units_per_client: deriveLoadUnitsPerClientFromStats(loadPerClientStats) || profile.overall.load_units_per_client,
        route_capacity_hint: routeCapacityHint,
        capacity_signal_mode: sourceMode,
        confidence: deriveCapacitySignalConfidence(clientStats, sourceMode)
      })
    })
  })

  return profiles
}

function computeCoverageHistoricalFallbackCapacity(capacityProfiles, adjustedTargetMaxVisits = 1) {
  const samples = []

  ;(capacityProfiles instanceof Map ? [...capacityProfiles.values()] : []).forEach(profile => {
    const overallCapacity = Number(profile?.overall?.client_capacity_limit || 0)
    if (Number.isFinite(overallCapacity) && overallCapacity > 0) {
      samples.push(overallCapacity)
    }

    if (profile?.byDayIndex instanceof Map) {
      profile.byDayIndex.forEach(dayProfile => {
        const dayCapacity = Number(dayProfile?.client_capacity_limit || 0)
        if (Number.isFinite(dayCapacity) && dayCapacity > 0) {
          samples.push(dayCapacity)
        }
      })
    }
  })

  if (!samples.length) {
    return Math.max(1, Number(adjustedTargetMaxVisits || 1) || 1)
  }

  const stats = summarizeNumericSeries(samples)
  const fallback = Number(stats.p50 || stats.avg || adjustedTargetMaxVisits || 1)
  return Math.max(1, Math.round(clamp(fallback, 1, 250)))
}

function resolveCommercialCapacityForDay(profile, dayIndex, requestedMaxVisitsOrOptions) {
  const options = (
    requestedMaxVisitsOrOptions &&
    typeof requestedMaxVisitsOrOptions === 'object' &&
    !Array.isArray(requestedMaxVisitsOrOptions)
  )
    ? requestedMaxVisitsOrOptions
    : { requestedMaxVisits: requestedMaxVisitsOrOptions }
  const requestedLimit = Math.max(1, Number(options.requestedMaxVisits || 1))
  const fallbackHistoricalCapacity = Math.max(1, Number(options.fallbackHistoricalCapacity || 1))
  const adjustedTargetLimit = Math.max(
    requestedLimit,
    Number(options.adjustedTargetMaxVisits || requestedLimit)
  )
  const dayProfile = profile?.byDayIndex?.get(dayIndex) || null
  const overallProfile = profile?.overall || null
  const sourceMode = String(
    dayProfile?.capacity_signal_mode ||
    overallProfile?.capacity_signal_mode ||
    COVERAGE_CAPACITY_MODE_UNKNOWN
  ).trim() || COVERAGE_CAPACITY_MODE_UNKNOWN

  const resolvedHistoricalClientCapacity = Number(
    dayProfile?.client_capacity_limit ||
    overallProfile?.client_capacity_limit ||
    0
  )
  const resolvedHistoricalTruckCapacity = Number(
    dayProfile?.load_capacity_units ||
    overallProfile?.load_capacity_units ||
    0
  )
  const resolvedLoadUnitsPerClient = Number(
    dayProfile?.load_units_per_client ||
    overallProfile?.load_units_per_client ||
    0
  )
  const historicalClientCapacity = Number.isFinite(resolvedHistoricalClientCapacity) && resolvedHistoricalClientCapacity > 0
    ? resolvedHistoricalClientCapacity
    : null
  const capacity = resolveCoverageSlotCapacity({
    requestedMaxVisits: requestedLimit,
    adjustedTargetMaxVisits: adjustedTargetLimit,
    historicalClientCapacity,
    historicalLoadUnits: Number.isFinite(resolvedHistoricalTruckCapacity) && resolvedHistoricalTruckCapacity > 0
      ? resolvedHistoricalTruckCapacity
      : null,
    historicalLoadUnitsPerClient: Number.isFinite(resolvedLoadUnitsPerClient) && resolvedLoadUnitsPerClient > 0
      ? resolvedLoadUnitsPerClient
      : null,
    hardMaxVisits: options.hardMaxVisits,
    hardMaxLoadUnits: options.hardMaxLoadUnits
  })
  const recommendedSoftCandidates = [
    historicalClientCapacity,
    capacity.historicalTruckBoundSoftMaxVisits,
    fallbackHistoricalCapacity
  ].filter(value => Number.isFinite(Number(value)) && Number(value) > 0)
  const historicalSoftCapacity = recommendedSoftCandidates.length
    ? Math.max(1, Math.round(Math.min(...recommendedSoftCandidates)))
    : Math.max(1, requestedLimit)
  const recommendedCapacity = capacity.hardPhysicalMaxVisits != null
    ? Math.max(1, Math.min(historicalSoftCapacity, Number(capacity.hardPhysicalMaxVisits || historicalSoftCapacity)))
    : historicalSoftCapacity
  const prefix = sourceMode === COVERAGE_CAPACITY_MODE_VALIDATED_VISIT ? 'validated_visit' : 'sales_history'
  const historicalSource = dayProfile?.client_capacity_limit
    ? `commercial_weekday_${prefix}`
    : (overallProfile?.client_capacity_limit
        ? `commercial_overall_${prefix}`
        : (fallbackHistoricalCapacity > 0
            ? `global_${prefix}_fallback`
            : 'adjusted_target_fallback'))

  return {
    maxClients: capacity.maxClients,
    requestedMaxClients: requestedLimit,
    adjustedTargetMaxClients: capacity.adjustedTargetMaxVisits,
    historicalClientCapacity,
    historicalSoftCapacity,
    recommendedCapacity,
    historicalSoftMaxClients: capacity.historicalSoftMaxVisits,
    maxLoadUnits: capacity.maxLoadUnits,
    clientSource: capacity.clientCapacitySource,
    truckSource: capacity.truckCapacitySource,
    routeCapacityHint: overallProfile?.route_capacity_hint || null,
    truckBoundClientCapacity: capacity.hardPhysicalMaxVisits,
    historicalTruckBoundClientCapacity: capacity.historicalTruckBoundSoftMaxVisits,
    hardPhysicalMaxVisits: capacity.hardPhysicalMaxVisits,
    hardCapacity: capacity.hardPhysicalMaxVisits,
    hasOperationalCapacitySignal: capacity.hasHistoricalCapacitySignal,
    hasHardPhysicalCapacity: capacity.hasHardPhysicalLimit,
    loadUnitsPerClient: capacity.loadUnitsPerClient != null
      ? roundScore(capacity.loadUnitsPerClient)
      : null,
    capacityMode: sourceMode,
    capacityConfidence: String(dayProfile?.confidence || overallProfile?.confidence || 'low').trim().toLowerCase() || 'low',
    historicalCapacitySource: historicalSource,
    capacitySource: historicalSource
  }
}

function deriveFallbackProbability(visitsHist, daysSinceLastVisit, periodDays) {
  const visitSignal = clamp((Number(visitsHist || 0) / 24) * 100, 6, 70)
  const urgencySignal = clamp((Number(daysSinceLastVisit || 0) / Math.max(periodDays, 1)) * 55, 0, 55)
  return roundScore(clamp((visitSignal * 0.65) + urgencySignal, 5, 85))
}

function deriveFallbackHabitScore(visitsHist) {
  return roundScore(clamp((Number(visitsHist || 0) / 40) * 100, 5, 100))
}

function deriveFallbackRecencyScore(daysSinceLastVisit, periodDays) {
  return roundScore(clamp((Number(daysSinceLastVisit || 0) / Math.max(periodDays, 1)) * 100, 0, 100))
}

function buildValidatedTourneeCode(prefix, date, commercialCode) {
  const safeDate = String(date || '').replace(/[^0-9]/g, '')
  const safeCommercial = String(commercialCode || '').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'
  const safePrefix = String(prefix || 'tournee').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'tournee'
  return `${safePrefix}-${safeDate}-${safeCommercial}`
}

function buildCoverageValidationCode(date, commercialCode) {
  return buildValidatedTourneeCode('coverage', date, commercialCode)
}

function normalizeValidatedStops(stops) {
  return (Array.isArray(stops) ? stops : [])
    .map((stop, index) => ({
      client_id: normalizeClientId(stop.client_id ?? stop.id ?? stop.client_unique_key),
      client_code: normalizeExactClientCode(stop.client_code || stop.nbr_client),
      client_name: String(stop.client_name || stop.nom || '').trim(),
      adresse: String(stop.adresse || '').trim(),
      latitude: Number.isFinite(Number(stop.latitude)) ? String(Number(stop.latitude)) : null,
      longitude: Number.isFinite(Number(stop.longitude)) ? String(Number(stop.longitude)) : null,
      rang: Number.isFinite(Number(stop.rang)) && Number(stop.rang) > 0 ? Number(stop.rang) : index + 1
    }))
    .filter(stop => stop.client_id || stop.client_code)
}

async function resolveValidatedStopsWithClientIdentity(stops, options = {}) {
  const connection = options && typeof options === 'object' ? (options.connection || null) : null
  const queryExecutor = options && typeof options === 'object' && typeof options.queryExecutor === 'function'
    ? options.queryExecutor
    : queryAsync
  const normalizedStops = normalizeValidatedStops(stops)
  const exactCodes = [...new Set(
    normalizedStops
      .filter(stop => stop.client_code)
      .map(stop => stop.client_code)
      .filter(Boolean)
  )]

  if (exactCodes.length > 0) {
    const codeFilter = buildInClause('c.code', exactCodes)
    const clientRows = await queryExecutor(
      `
        SELECT
          c.id AS client_id,
          c.code AS client_code
        FROM clients c
        WHERE c.deleted_at IS NULL
          AND c.isactif = '1'
          ${codeFilter.sql}
      `,
      codeFilter.params,
      connection
    )
    const clientIdentityByCode = new Map(
      (clientRows || []).map(row => [
        normalizeExactClientCode(row.client_code),
        {
          client_id: normalizeClientId(row.client_id),
          client_code: normalizeExactClientCode(row.client_code)
        }
      ])
    )

    normalizedStops.forEach(stop => {
      if (!stop.client_code) {
        stop.client_id = ''
        return
      }

      const resolvedIdentity = clientIdentityByCode.get(stop.client_code) || null
      if (!resolvedIdentity) {
        stop.client_id = ''
        return
      }

      stop.client_id = resolvedIdentity.client_id || ''
      stop.client_code = resolvedIdentity.client_code || stop.client_code
    })
  }

  const missingClientIdentity = normalizedStops
    .filter(stop => !stop.client_id)
    .map(stop => ({
      client_code: stop.client_code,
      client_name: stop.client_name
    }))

  const duplicateClientIds = []
  const seenClientIds = new Set()
  normalizedStops.forEach(stop => {
    if (!stop.client_id) return
    if (seenClientIds.has(stop.client_id)) {
      duplicateClientIds.push(stop.client_id)
      return
    }
    seenClientIds.add(stop.client_id)
  })

  return {
    stops: normalizedStops,
    missingClientIdentity,
    duplicateClientIds: [...new Set(duplicateClientIds)]
  }
}

async function ensureValidatedTourneeIdentityColumns(connection = null) {
  await ensureTableColumn('tournees', 'client_id', 'BIGINT UNSIGNED DEFAULT NULL', connection)
  await ensureTableIndex('tournees', 'tournees_client_id_idx', 'INDEX `tournees_client_id_idx` (`client_id`)', connection)
}

function buildValidatedLoadingCode(date, commercialCode) {
  return buildValidatedTourneeCode('prechargement', date, commercialCode)
}

function normalizeProductLookupKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim()
}

function normalizeLoadingProducts(products) {
  return (Array.isArray(products) ? products : [])
    .map((item, index) => {
      const nom = String(
        item?.nom ||
        item?.name ||
        item?.produit_nom ||
        item?.produit_code ||
        ''
      ).trim()
      const quantiteBrute = Number.parseFloat(String(
        item?.quantite ??
        item?.quantity ??
        item?.qte ??
        item?.qte_reco ??
        0
      ).replace(',', '.'))

      return {
        nom,
        quantite: Number.isFinite(quantiteBrute) ? Number(quantiteBrute.toFixed(3)) : 0,
        ordre: index + 1
      }
    })
    .filter(item => item.nom && item.quantite > 0)
}

async function resolveMovementSoussocieteCode({ commercialCode = '', depotCode = '' } = {}) {
  return null
}

async function validateAndResolveValidatedTourneeStops(stops, options = {}) {
  const resolvedStops = await resolveValidatedStopsWithClientIdentity(stops, options)
  const normalizedStops = resolvedStops.stops

  if (!normalizedStops.length) {
    const error = new Error('Aucun client valide a enregistrer pour cette tournee.')
    error.statusCode = 400
    throw error
  }

  if (resolvedStops.missingClientIdentity.length > 0) {
    const missingCodes = resolvedStops.missingClientIdentity
      .map(item => item.client_code || item.client_name || 'client_sans_id')
      .join(', ')
    const error = new Error(`Impossible de relier certains clients a un client_id actif: ${missingCodes}.`)
    error.statusCode = 400
    throw error
  }

  if (resolvedStops.duplicateClientIds.length > 0) {
    const error = new Error(`Des doublons client_id ont ete detectes dans la tournee: ${resolvedStops.duplicateClientIds.join(', ')}.`)
    error.statusCode = 400
    throw error
  }

  return normalizedStops
}

async function replaceValidatedTourneeRowsInTransaction({
  selectedDate,
  dayLabel,
  commercialCode,
  commercialLabel,
  routeCode,
  depotCode,
  depotName,
  normalizedStops,
  frequence,
  categorieCode,
  typeClient,
  codePrefix,
  connection,
  queryExecutor = queryAsync
}) {
  const resolvedDayLabel = resolveFrenchDayLabel(selectedDate, dayLabel)
  const validationCode = buildValidatedTourneeCode(codePrefix, selectedDate, commercialCode)
  const routingCode = routeCode || commercialCode || 'plan-ia'
  const depotValue = depotCode || depotName || null
  const tourneeLabel = `${commercialLabel} - ${selectedDate}`

  await queryExecutor(
    `DELETE FROM tournees
     WHERE deleted_at IS NULL
       AND frequence = ?
       AND code_layer = ?
       AND date_debut = ?
       AND date_fin = ?`,
    [frequence, commercialCode, selectedDate, selectedDate],
    connection
  )

  for (const stop of normalizedStops) {
    const coordinates = stop.latitude != null && stop.longitude != null
      ? JSON.stringify({ latitude: Number(stop.latitude), longitude: Number(stop.longitude) })
      : null

    await queryExecutor(
      `INSERT INTO tournees (
        code,
        libelle,
        layer,
        coordinates,
        code_jour,
        client_id,
        client_code,
        routing_code,
        depot_code,
        frequence,
        dates,
        actif,
        actif_client,
        date_debut,
        date_fin,
        rang,
        categorie_code,
        type_layer,
        code_layer,
        couleur,
        type_client,
        rs_client_code,
        latitude,
        longitude,
        adresse,
        activite,
        client,
        icon,
        couleur_icon,
        image
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 'tournee', ?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL)`,
      [
        validationCode,
        tourneeLabel,
        coordinates,
        resolvedDayLabel,
        stop.client_id || null,
        stop.client_code,
        routingCode,
        depotValue,
        frequence,
        selectedDate,
        selectedDate,
        selectedDate,
        stop.rang,
        categorieCode,
        commercialCode,
        typeClient,
        stop.client_code,
        stop.latitude,
        stop.longitude,
        stop.adresse || null,
        stop.client_name || null
      ],
      connection
    )
  }

  return {
    validationCode,
    routingCode,
    depotValue,
    tourneeLabel
  }
}

async function resolveLoadingProductDefinition(productName, cache = new Map(), connection = null) {
  const lookupKey = String(productName || '').trim()
  const normalizedLookupKey = normalizeProductLookupKey(lookupKey)

  if (!lookupKey) {
    return null
  }

  if (cache.has(lookupKey)) {
    return cache.get(lookupKey)
  }

  const productSelect = `
    SELECT
      code,
      prix_achat_ht,
      prix_achat_ttc,
      prix_ht,
      prix_ttc,
      tva,
      chargement,
      qte_stock,
      updated_at,
      sousfamille_code,
      famille_code,
      libelle,
      description,
      details
    FROM produits
    WHERE %ACTIF_CONDITION%
      AND %FIELD_CONDITION%
    ORDER BY
      CASE WHEN chargement = 1 THEN 0 ELSE 1 END ASC,
      qte_stock DESC,
      updated_at DESC,
      code ASC
    LIMIT %LIMIT_VALUE%
  `

  const exactFields = ['code', 'sousfamille_code', 'famille_code', 'libelle', 'description', 'details']
  const activeConditions = ['actif = 1', '1 = 1']
  let resolved = null

  exactSearch:
  for (const activeCondition of activeConditions) {
    for (const field of exactFields) {
      const sql = productSelect
        .replace('%ACTIF_CONDITION%', activeCondition)
        .replace('%FIELD_CONDITION%', `${field} = ?`)
        .replace('%LIMIT_VALUE%', '1')

      const rows = await queryAsync(sql, [lookupKey], connection)
      if (rows.length > 0) {
        resolved = rows[0]
        break exactSearch
      }
    }
  }

  if (!resolved && normalizedLookupKey) {
    const likePattern = `%${lookupKey}%`
    const sql = productSelect
      .replace('%ACTIF_CONDITION%', 'actif = 1')
      .replace('%FIELD_CONDITION%', '(code LIKE ? OR sousfamille_code LIKE ? OR famille_code LIKE ? OR libelle LIKE ? OR description LIKE ? OR details LIKE ?)')
      .replace('%LIMIT_VALUE%', '50')

    const rows = await queryAsync(sql, Array(6).fill(likePattern), connection)
    const scoredRows = rows
      .map(row => {
        const ranks = [
          ['code', 0],
          ['sousfamille_code', 1],
          ['famille_code', 2],
          ['libelle', 3],
          ['description', 4],
          ['details', 5]
        ]

        let bestRank = Number.POSITIVE_INFINITY
        for (const [field, rank] of ranks) {
          const candidateValue = normalizeProductLookupKey(row[field])
          if (!candidateValue) continue

          if (candidateValue === normalizedLookupKey) {
            bestRank = Math.min(bestRank, rank)
          } else if (
            candidateValue.includes(normalizedLookupKey) ||
            normalizedLookupKey.includes(candidateValue)
          ) {
            bestRank = Math.min(bestRank, rank + 10)
          }
        }

        return {
          row,
          bestRank
        }
      })
      .filter(item => Number.isFinite(item.bestRank))
      .sort((a, b) => {
        if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank
        if (Number(a.row.chargement || 0) !== Number(b.row.chargement || 0)) {
          return Number(b.row.chargement || 0) - Number(a.row.chargement || 0)
        }
        if (Number(a.row.qte_stock || 0) !== Number(b.row.qte_stock || 0)) {
          return Number(b.row.qte_stock || 0) - Number(a.row.qte_stock || 0)
        }
        return String(a.row.code || '').localeCompare(String(b.row.code || ''))
      })

    resolved = scoredRows[0]?.row || null
  }

  cache.set(lookupKey, resolved || null)
  return resolved || null
}

async function replaceValidatedLoadingPrediction({
  date,
  commercialCode,
  depotCode,
  loadingProducts,
  logPrefix = 'PLAN_VALIDATE',
  connection = null
}) {
  const selectedDate = formatLocalDate(parseLocalDate(date))
  const loadingCode = buildValidatedLoadingCode(selectedDate, commercialCode)
  const normalizedProducts = normalizeLoadingProducts(loadingProducts)
  const movementDate = `${selectedDate} 00:00:00`
  const mouvementDepotCode = String(depotCode || '').trim() || null
  const soussocieteCode = await resolveMovementSoussocieteCode({
    commercialCode,
    depotCode: mouvementDepotCode
  })
  const magasinierCode = String(process.env.PRECHARGEMENT_MAGASINIER_CODE || 'nomadis').trim() || null
  const resolutionCache = new Map()
  const createdAt = new Date()

  await queryAsync(
    `DELETE FROM mouvements
     WHERE deleted_at IS NULL
       AND type = 'pre-chargement'
       AND from_dash = 1
       AND commercial_code = ?
       AND DATE(date) = ?
       AND (numero = ? OR group_cmd_code = ?)`,
    [commercialCode, selectedDate, loadingCode, loadingCode],
    connection
  )

  if (!normalizedProducts.length) {
    console.log(`[${logPrefix}] Aucun pre-chargement IA a enregistrer pour date=${selectedDate} commercial=${commercialCode}`)
    return {
      savedRows: 0,
      movementCode: loadingCode
    }
  }

  for (const product of normalizedProducts) {
    const definition = await resolveLoadingProductDefinition(product.nom, resolutionCache, connection)

    if (!definition?.code) {
      const error = new Error(`Produit de chargement introuvable pour la prediction: ${product.nom}.`)
      error.statusCode = 400
      throw error
    }

    const quantite = Number(product.quantite)
    const prixAchatHt = Number.isFinite(Number(definition.prix_achat_ht)) ? Number(definition.prix_achat_ht) : 0
    const prixAchatTtc = Number.isFinite(Number(definition.prix_achat_ttc)) ? Number(definition.prix_achat_ttc) : 0
    const prixHt = Number.isFinite(Number(definition.prix_ht)) ? Number(definition.prix_ht) : null
    const prixTtc = Number.isFinite(Number(definition.prix_ttc)) ? Number(definition.prix_ttc) : null
    const tauxTva = Number.isFinite(Number(definition.tva)) ? Number(definition.tva) : null
    const pTva = prixHt != null && prixTtc != null
      ? Number(((prixTtc - prixHt) * quantite).toFixed(3))
      : null

    await queryAsync(
      `INSERT INTO mouvements (
        magasinier_code,
        depot_code,
        commercial_code,
        soussociete_code,
        produit_code,
        prix_achat_ht,
        prix_achat_ttc,
        quantite,
        qte_demande,
        prix_ht,
        prix_ttc,
        p_tva,
        taux_tva,
        remise,
        type,
        type_chargement,
        from_stock,
        from_stock_ri,
        from_dash,
        numero,
        group_cmd_code,
        configuration,
        etat,
        date,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pre-chargement', NULL, 1, 0, 1, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        magasinierCode,
        mouvementDepotCode,
        commercialCode,
        soussocieteCode,
        definition.code,
        prixAchatHt,
        prixAchatTtc,
        quantite,
        quantite,
        prixHt,
        prixTtc,
        pTva,
        tauxTva,
        loadingCode,
        loadingCode,
        product.nom,
        movementDate,
        createdAt,
        createdAt
      ],
      connection
    )
  }

  console.log(`[${logPrefix}] Pre-chargement IA enregistre -> code=${loadingCode} rows=${normalizedProducts.length}`)

  return {
    savedRows: normalizedProducts.length,
    movementCode: loadingCode
  }
}

async function saveValidatedTourneePlan({
  date,
  dayLabel,
  commercialCode,
  commercialLabel,
  routeCode,
  depotCode,
  depotName,
  stops,
  frequence,
  categorieCode,
  typeClient,
  codePrefix,
  predictionRunCode = null,
  loadingProducts = null,
  logPrefix = 'PLAN_VALIDATE'
}) {
  const selectedDate = formatLocalDate(parseLocalDate(date))

  if (!commercialCode) {
    const error = new Error('Commercial manquant pour la validation de la tournee.')
    error.statusCode = 400
    throw error
  }

  const normalizedStops = await validateAndResolveValidatedTourneeStops(stops, {
    queryExecutor: queryAsyncImpl
  })

  console.log(`[${logPrefix}] Debut validation -> date=${selectedDate} commercial=${commercialCode} stops=${normalizedStops.length}`)

  try {
    await ensureMovementSupportTables()
    await ensureValidatedTourneeIdentityColumns()

    const loadingResult = await withTransaction(async connection => {
      await ensureValidatedTourneeIdentityColumns(connection)
      const persistedTournee = await replaceValidatedTourneeRowsInTransaction({
        selectedDate,
        dayLabel,
        commercialCode,
        commercialLabel,
        routeCode,
        depotCode,
        depotName,
        normalizedStops,
        frequence,
        categorieCode,
        typeClient,
        codePrefix,
        connection
      })

      return Array.isArray(loadingProducts)
        ? replaceValidatedLoadingPrediction({
          date: selectedDate,
          commercialCode,
          depotCode: persistedTournee.depotValue,
          loadingProducts,
          logPrefix,
          connection
        })
        : { savedRows: 0, movementCode: null }
    }, { logPrefix })

    const validationCode = buildValidatedTourneeCode(codePrefix, selectedDate, commercialCode)
    const routingCode = routeCode || commercialCode || 'plan-ia'
    const depotValue = depotCode || depotName || null

    console.log(`[${logPrefix}] Succes -> code=${validationCode} rows=${normalizedStops.length}`)

    let feedbackResult = {
      savedRows: 0,
      predictedRows: 0,
      selectedRows: normalizedStops.length,
      unmatchedSelectedRows: 0,
      skipped: true,
      reason: 'missing_prediction_run_code'
    }

    try {
      feedbackResult = await recordPredictionValidationFeedback({
        predictionRunCode,
        feedbackDate: selectedDate,
        commercialCode,
        routeCode: routingCode,
        depotCode: depotValue,
        validationCode,
        stops: normalizedStops,
        logPrefix
      })
    } catch (feedbackError) {
      console.warn(`[${logPrefix}] Feedback prediction non enregistre: ${feedbackError.message}`)
      feedbackResult = {
        savedRows: 0,
        predictedRows: 0,
        selectedRows: normalizedStops.length,
        unmatchedSelectedRows: 0,
        skipped: true,
        reason: 'feedback_logging_error'
      }
    }

    let reconciliationResult = {
      requestedRows: 0,
      checkedRows: 0,
      purchasedRows: 0,
      zeroSaleRows: 0,
      skippedRows: 0,
      sourceSalesRows: 0,
      skipped: true,
      reason: 'feedback_not_available'
    }

    if (!feedbackResult.skipped && String(predictionRunCode || '').trim()) {
      try {
        reconciliationResult = await reconcilePredictionFeedbackActualSales({
          runCode: predictionRunCode,
          feedbackDate: selectedDate,
          onlyPending: false,
          logPrefix: `${logPrefix}_ACTUAL`
        })
      } catch (reconciliationError) {
        console.warn(`[${logPrefix}] Reconciliation ventes non terminee: ${reconciliationError.message}`)
        reconciliationResult = {
          requestedRows: 0,
          checkedRows: 0,
          purchasedRows: 0,
          zeroSaleRows: 0,
          skippedRows: 0,
          sourceSalesRows: 0,
          skipped: true,
          reason: 'reconciliation_error'
        }
      }
    }

    const loadingMessage = loadingResult.savedRows > 0
      ? ` Le pre-chargement IA (${loadingResult.savedRows} produit${loadingResult.savedRows > 1 ? 's' : ''}) a aussi ete enregistre.`
      : ''

    return {
      status: 'success',
      message: `La tournee finale du ${selectedDate} pour ${commercialLabel} a ete enregistree.${loadingMessage}`,
      saved_rows: normalizedStops.length,
      saved_loading_rows: loadingResult.savedRows,
      loading_code: loadingResult.movementCode,
      tournee_code: validationCode,
      prediction_run_code: String(predictionRunCode || '').trim() || null,
      prediction_feedback_rows: feedbackResult.savedRows,
      prediction_feedback_skipped: Boolean(feedbackResult.skipped),
      prediction_feedback_reason: feedbackResult.reason,
      prediction_feedback_unmatched_selected_rows: feedbackResult.unmatchedSelectedRows,
      prediction_actual_checked_rows: reconciliationResult.checkedRows,
      prediction_actual_purchase_rows: reconciliationResult.purchasedRows,
      prediction_actual_zero_rows: reconciliationResult.zeroSaleRows,
      prediction_actual_skipped_rows: reconciliationResult.skippedRows,
      prediction_actual_reconcile_skipped: Boolean(reconciliationResult.skipped),
      prediction_actual_reconcile_reason: reconciliationResult.reason
    }
  } catch (error) {
    throw error
  }
}

function computeCoveragePriorityScore({
  predictedCa,
  maxPredictedCa,
  probability,
  habitScore,
  recencyScore,
  distanceKm,
  maxDistanceKm,
  daysSinceLastVisit,
  periodDays,
  repetitionIndex = 0
}) {
  const urgencyRecency = Math.max(
    Number(recencyScore || 0),
    clamp((Number(daysSinceLastVisit || 0) / Math.max(periodDays, 1)) * 100, 0, 100)
  )
  const baseScore = computePriorityScore(
    Number(predictedCa || 0),
    Number(maxPredictedCa || 0),
    Number(probability || 0),
    Number(habitScore || 0),
    urgencyRecency,
    Number(distanceKm || 0),
    Number(maxDistanceKm || 0)
  )

  return roundScore(clamp(baseScore - (repetitionIndex * 7), 0, 100))
}

function buildCoverageQuickProfiles(clients, historiqueByClient, startDate, periodDays) {
  return (Array.isArray(clients) ? clients : []).map(client => {
    const hist = getClientMapValue(historiqueByClient, client.nbr_client) || {}
    const visitsHist = Number(hist.visits_hist || 0)
    const avgCaHist = Number(hist.avg_ca_hist || 0)
    const ca90d = Number(hist.ca_90d || 0)
    const daysSinceLastVisit = diffDays(hist.last_visit_date, startDate) ?? periodDays
    const fallbackBaseCa = Math.max(25, avgCaHist, ca90d > 0 ? ca90d / 6 : 0)
    const criticalThresholdDays = Math.max(1, Number(periodDays || 14))
    const isCriticalCoverage = Number(daysSinceLastVisit || 0) >= criticalThresholdDays

    return {
      nbr_client: client.nbr_client,
      predicted_ca: fallbackBaseCa,
      probability: deriveFallbackProbability(visitsHist, daysSinceLastVisit, periodDays),
      habit_score: deriveFallbackHabitScore(visitsHist),
      recency_score: deriveFallbackRecencyScore(daysSinceLastVisit, periodDays),
      visits_hist: visitsHist,
      days_since_last_visit: daysSinceLastVisit,
      is_critical_coverage: isCriticalCoverage
    }
  })
}

function buildCoveragePlanFailure({
  availableSlots,
  eligibleSlotCount = 0,
  strictEligibleCapacity = 0,
  bestHistoricalBlockCapacity = 0,
  requestedMinVisits = 1,
  requestedMaxVisits = 1,
  effectiveMinVisits = requestedMinVisits,
  effectiveMaxVisits = requestedMaxVisits,
  planningMode = 'strict',
  usedRelaxedFallback = false,
  strictFallbackReasonCode = null,
  strictFallbackReason = null,
  infeasibleReasonCode,
  infeasibleReason
}) {
  const recommendedMinVisits = Math.max(1, Math.min(requestedMinVisits, bestHistoricalBlockCapacity || requestedMinVisits || 1))
  const recommendedMaxVisits = Math.max(
    recommendedMinVisits,
    Math.min(requestedMaxVisits, Math.max(bestHistoricalBlockCapacity || recommendedMinVisits, recommendedMinVisits))
  )

  return {
    slots: [],
    totalClientCapacity: 0,
    totalTruckCapacityUnits: 0,
    totalAvailableSlots: availableSlots.length,
    eligibleSlotCount,
    strictEligibleCapacity,
    targetVisits: 0,
    selectedSlotCount: 0,
    fullCoveragePossible: false,
    bestHistoricalBlockCapacity,
    planningMode,
    usedRelaxedFallback,
    requestedMinVisits,
    requestedMaxVisits,
    effectiveMinVisits,
    effectiveMaxVisits,
    strictFallbackReasonCode,
    strictFallbackReason,
    recommendedMinVisits,
    recommendedMaxVisits,
    infeasibleReasonCode,
    infeasibleReason
  }
}

function cloneCoverageSlots(availableSlots, safeMinVisits) {
  return availableSlots.map(slot => ({
    ...slot,
    tournees: [],
    total_predicted_ca: 0,
    total_score: 0,
    total_reco_units: 0,
    uniqueClients: new Set(),
    target_size: 0,
    min_size: safeMinVisits,
    strict_limits: true
  }))
}

function buildStrictCoverageSlotPlan(availableSlots, desiredVisitCount, safeMinVisits, safeMaxVisits, config = {}) {
  const bestHistoricalBlockCapacity = Number(config.bestHistoricalBlockCapacity || 0)
  const requestedMinVisits = Number(config.requestedMinVisits || safeMinVisits)
  const requestedMaxVisits = Number(config.requestedMaxVisits || safeMaxVisits)
  const workingSlots = cloneCoverageSlots(availableSlots, safeMinVisits)
  const eligibleSlots = workingSlots.filter(slot => Number(slot.max_size || 0) >= safeMinVisits)
  const strictEligibleCapacity = eligibleSlots.reduce((sum, slot) => sum + Number(slot.max_size || 0), 0)

  if (eligibleSlots.length === 0) {
    return buildCoveragePlanFailure({
      availableSlots: workingSlots,
      eligibleSlotCount: 0,
      strictEligibleCapacity,
      bestHistoricalBlockCapacity,
      requestedMinVisits,
      requestedMaxVisits,
      effectiveMinVisits: safeMinVisits,
      effectiveMaxVisits: safeMaxVisits,
      infeasibleReasonCode: 'min_block_capacity_unreachable',
      infeasibleReason: `Aucun block historique n'atteint le minimum strict de ${safeMinVisits} client(s) sur la periode choisie.`
    })
  }

  if (desiredVisitCount < safeMinVisits) {
    return buildCoveragePlanFailure({
      availableSlots: workingSlots,
      eligibleSlotCount: eligibleSlots.length,
      strictEligibleCapacity,
      bestHistoricalBlockCapacity,
      requestedMinVisits,
      requestedMaxVisits,
      effectiveMinVisits: safeMinVisits,
      effectiveMaxVisits: safeMaxVisits,
      infeasibleReasonCode: 'total_demand_below_min_block',
      infeasibleReason: `La demande totale (${desiredVisitCount}) est inferieure au minimum strict requis pour un seul block (${safeMinVisits}).`
    })
  }

  const rankedEligibleSlots = eligibleSlots
    .slice()
    .sort((a, b) => {
      if (Number(b.max_size || 0) !== Number(a.max_size || 0)) {
        return Number(b.max_size || 0) - Number(a.max_size || 0)
      }
      return Number(a.slot_order || 0) - Number(b.slot_order || 0)
    })

  const prefixCapacities = [0]
  rankedEligibleSlots.forEach(slot => {
    prefixCapacities.push(prefixCapacities[prefixCapacities.length - 1] + Number(slot.max_size || 0))
  })

  const cappedDesiredVisits = Math.min(desiredVisitCount, prefixCapacities[prefixCapacities.length - 1])
  let bestPlan = null

  for (let slotCount = 1; slotCount <= rankedEligibleSlots.length; slotCount += 1) {
    const minRequiredVisits = slotCount * safeMinVisits
    if (minRequiredVisits > cappedDesiredVisits) break

    const maxAssignableVisits = Math.min(prefixCapacities[slotCount], cappedDesiredVisits)
    if (maxAssignableVisits < minRequiredVisits) continue

    if (
      !bestPlan ||
      maxAssignableVisits > bestPlan.targetVisits ||
      (maxAssignableVisits === bestPlan.targetVisits && slotCount < bestPlan.slotCount)
    ) {
      bestPlan = {
        slotCount,
        targetVisits: maxAssignableVisits
      }
    }
  }

  if (!bestPlan || bestPlan.targetVisits < safeMinVisits) {
    return buildCoveragePlanFailure({
      availableSlots: workingSlots,
      eligibleSlotCount: eligibleSlots.length,
      strictEligibleCapacity,
      bestHistoricalBlockCapacity,
      requestedMinVisits,
      requestedMaxVisits,
      effectiveMinVisits: safeMinVisits,
      effectiveMaxVisits: safeMaxVisits,
      infeasibleReasonCode: 'strict_blocks_impossible',
      infeasibleReason: `Impossible de former des blocks stricts entre ${safeMinVisits} et ${safeMaxVisits} client(s) avec les capacites historiques disponibles.`
    })
  }

  const chosenSlots = rankedEligibleSlots
    .slice(0, bestPlan.slotCount)
    .sort((a, b) => Number(a.slot_order || 0) - Number(b.slot_order || 0))

  chosenSlots.forEach(slot => {
    slot.target_size = safeMinVisits
    slot.min_size = safeMinVisits
    slot.strict_limits = true
  })

  let remainder = Math.max(0, bestPlan.targetVisits - (bestPlan.slotCount * safeMinVisits))
  const slotDistributionOrder = chosenSlots
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => {
      const spareA = Number(a.slot.max_size || 0) - Number(a.slot.target_size || 0)
      const spareB = Number(b.slot.max_size || 0) - Number(b.slot.target_size || 0)
      if (spareB !== spareA) return spareB - spareA
      return a.index - b.index
    })

  while (remainder > 0) {
    let progressed = false
    for (const entry of slotDistributionOrder) {
      if (entry.slot.target_size >= Number(entry.slot.max_size || 0)) continue
      entry.slot.target_size += 1
      remainder -= 1
      progressed = true
      if (remainder <= 0) break
    }
    if (!progressed) break
  }

  const totalClientCapacity = chosenSlots.reduce((sum, slot) => sum + Number(slot.max_size || 0), 0)
  const totalTruckCapacityUnits = chosenSlots.reduce((sum, slot) => {
    const loadUnits = Number(slot.max_load_units || 0)
    return sum + (Number.isFinite(loadUnits) ? loadUnits : 0)
  }, 0)
  const targetVisits = chosenSlots.reduce((sum, slot) => sum + Number(slot.target_size || 0), 0)

  return {
    slots: chosenSlots,
    totalClientCapacity,
    totalTruckCapacityUnits,
    totalAvailableSlots: workingSlots.length,
    eligibleSlotCount: eligibleSlots.length,
    strictEligibleCapacity,
    targetVisits,
    selectedSlotCount: chosenSlots.length,
    fullCoveragePossible: targetVisits >= desiredVisitCount,
    bestHistoricalBlockCapacity,
    planningMode: 'strict',
    usedRelaxedFallback: false,
    requestedMinVisits,
    requestedMaxVisits,
    effectiveMinVisits: safeMinVisits,
    effectiveMaxVisits: safeMaxVisits,
    strictFallbackReasonCode: null,
    strictFallbackReason: null,
    recommendedMinVisits: safeMinVisits,
    recommendedMaxVisits: safeMaxVisits,
    infeasibleReasonCode: null,
    infeasibleReason: null
  }
}

function buildClosestCoverageSlotPlan(availableSlots, desiredVisitCount, config = {}) {
  const safeMinVisits = Math.max(1, Number(config.safeMinVisits || 1))
  const safeMaxVisits = Math.max(safeMinVisits, Number(config.safeMaxVisits || safeMinVisits))
  const bestHistoricalBlockCapacity = Number(config.bestHistoricalBlockCapacity || 0)
  const strictReferencePlan = config.strictReferencePlan || config.strictFailure || null
  const positiveCapacityMax = availableSlots.reduce((max, slot) => Math.max(max, Number(slot.max_size || 0)), 0)
  const highestCandidateMin = Math.max(1, Math.min(safeMinVisits, positiveCapacityMax || safeMinVisits))

  if (desiredVisitCount <= 0 || positiveCapacityMax <= 0) {
    return buildCoveragePlanFailure({
      availableSlots,
      eligibleSlotCount: Number(config.strictEligibleSlotCount || 0),
      strictEligibleCapacity: Number(config.strictEligibleCapacity || 0),
      bestHistoricalBlockCapacity,
      requestedMinVisits: safeMinVisits,
      requestedMaxVisits: safeMaxVisits,
      effectiveMinVisits: highestCandidateMin,
      effectiveMaxVisits: safeMaxVisits,
      planningMode: 'relaxed',
      usedRelaxedFallback: true,
      strictFallbackReasonCode: strictReferencePlan?.infeasibleReasonCode || null,
      strictFallbackReason: strictReferencePlan?.infeasibleReason || null,
      infeasibleReasonCode: desiredVisitCount <= 0 ? 'no_relaxed_visits_to_assign' : 'no_positive_capacity_slots',
      infeasibleReason: desiredVisitCount <= 0
        ? "La demande client est nulle apres application des capacites reelles."
        : "Aucune capacite historique positive n'a ete detectee pour generer un plan approche."
    })
  }

  let bestPlan = null

  for (let candidateMin = highestCandidateMin; candidateMin >= 1; candidateMin -= 1) {
    const candidatePlan = buildStrictCoverageSlotPlan(
      availableSlots,
      desiredVisitCount,
      candidateMin,
      safeMaxVisits,
      {
        bestHistoricalBlockCapacity,
        requestedMinVisits: safeMinVisits,
        requestedMaxVisits: safeMaxVisits
      }
    )

    if (!candidatePlan.slots.length || Number(candidatePlan.targetVisits || 0) <= 0) {
      continue
    }

    const candidateVisits = Number(candidatePlan.targetVisits || 0)
    const bestVisits = Number(bestPlan?.targetVisits || 0)
    const candidateMinDistance = Math.abs(safeMinVisits - candidateMin)
    const bestMinDistance = Math.abs(safeMinVisits - Number(bestPlan?.effectiveMinVisits || safeMinVisits))

    const candidateIsBetter = !bestPlan
      || candidateVisits > bestVisits
      || (
        candidateVisits === bestVisits
        && (
          candidateMinDistance < bestMinDistance
          || (
            candidateMinDistance === bestMinDistance
            && Number(candidatePlan.selectedSlotCount || 0) < Number(bestPlan.selectedSlotCount || Number.POSITIVE_INFINITY)
          )
        )
      )

    if (candidateIsBetter) {
      bestPlan = candidatePlan
    }
  }

  if (bestPlan) {
    const effectiveMinVisits = Math.max(1, Number(bestPlan.effectiveMinVisits || highestCandidateMin))
    const usedRelaxedFallback = effectiveMinVisits !== safeMinVisits
    const finalSlots = usedRelaxedFallback
      ? bestPlan.slots.map(slot => ({
          ...slot,
          strict_limits: false
        }))
      : bestPlan.slots
    const achievableMax = finalSlots.reduce((max, slot) => Math.max(max, Number(slot.max_size || 0)), effectiveMinVisits)
    const recommendedMaxVisits = Math.max(effectiveMinVisits, Math.min(safeMaxVisits, achievableMax || safeMaxVisits))

    let strictFallbackReasonCode = null
    let strictFallbackReason = null

    if (usedRelaxedFallback) {
      const strictVisits = Number(strictReferencePlan?.targetVisits || 0)
      if (strictVisits > 0) {
        strictFallbackReasonCode = 'strict_coverage_too_low'
        strictFallbackReason = `Avec la plage stricte ${safeMinVisits}-${safeMaxVisits}, le moteur ne pouvait couvrir qu'environ ${strictVisits} client(s) sur ${desiredVisitCount} pendant cette periode. Pour maximiser la couverture, le minimum a ete abaisse a ${effectiveMinVisits}.`
      } else {
        strictFallbackReasonCode = strictReferencePlan?.infeasibleReasonCode || bestPlan.infeasibleReasonCode || 'strict_constraints_unreachable'
        strictFallbackReason = strictReferencePlan?.infeasibleReason || bestPlan.infeasibleReason || `La plage stricte ${safeMinVisits}-${safeMaxVisits} n'etait pas exploitable sur cette periode.`
      }
    }

    return {
      ...bestPlan,
      slots: finalSlots,
      planningMode: usedRelaxedFallback ? 'relaxed' : 'strict',
      usedRelaxedFallback,
      requestedMinVisits: safeMinVisits,
      requestedMaxVisits: safeMaxVisits,
      effectiveMinVisits,
      effectiveMaxVisits: recommendedMaxVisits,
      strictFallbackReasonCode,
      strictFallbackReason,
      recommendedMinVisits: effectiveMinVisits,
      recommendedMaxVisits,
      infeasibleReasonCode: null,
      infeasibleReason: null
    }
  }

  return buildCoveragePlanFailure({
    availableSlots,
    eligibleSlotCount: Number(config.strictEligibleSlotCount || 0),
    strictEligibleCapacity: Number(config.strictEligibleCapacity || 0),
    bestHistoricalBlockCapacity,
    requestedMinVisits: safeMinVisits,
    requestedMaxVisits: safeMaxVisits,
    effectiveMinVisits: highestCandidateMin,
    effectiveMaxVisits: safeMaxVisits,
    planningMode: 'relaxed',
    usedRelaxedFallback: true,
    strictFallbackReasonCode: strictReferencePlan?.infeasibleReasonCode || null,
    strictFallbackReason: strictReferencePlan?.infeasibleReason || null,
    infeasibleReasonCode: 'closest_plan_unreachable',
    infeasibleReason: "Le moteur n'a pas trouve de plan approche exploitable avec les capacites historiques disponibles."
  })
}

function buildCoverageFirstSlotPlan(availableSlots, desiredVisitCount, config = {}) {
  const safeMinVisits = Math.max(1, Number(config.safeMinVisits || 1))
  const safeMaxVisits = Math.max(safeMinVisits, Number(config.safeMaxVisits || safeMinVisits))
  const bestHistoricalBlockCapacity = Number(config.bestHistoricalBlockCapacity || 0)
  const strictReferencePlan = config.strictReferencePlan || null
  const workingSlots = cloneCoverageSlots(availableSlots, safeMinVisits)
  const activeSlots = workingSlots.filter(slot => Number(slot.max_size || 0) > 0)
  const strictEligibleSlotCount = activeSlots.filter(slot => Number(slot.max_size || 0) >= safeMinVisits).length
  const strictEligibleCapacity = activeSlots
    .filter(slot => Number(slot.max_size || 0) >= safeMinVisits)
    .reduce((sum, slot) => sum + Number(slot.max_size || 0), 0)

  if (desiredVisitCount <= 0) {
    return buildCoveragePlanFailure({
      availableSlots: workingSlots,
      eligibleSlotCount: strictEligibleSlotCount,
      strictEligibleCapacity,
      bestHistoricalBlockCapacity,
      requestedMinVisits: safeMinVisits,
      requestedMaxVisits: safeMaxVisits,
      effectiveMinVisits: safeMinVisits,
      effectiveMaxVisits: safeMaxVisits,
      planningMode: 'coverage_first',
      usedRelaxedFallback: true,
      strictFallbackReasonCode: strictReferencePlan?.infeasibleReasonCode || null,
      strictFallbackReason: strictReferencePlan?.infeasibleReason || null,
      infeasibleReasonCode: 'no_relaxed_visits_to_assign',
      infeasibleReason: "La demande client est nulle apres application des capacites reelles."
    })
  }

  if (!activeSlots.length) {
    return buildCoveragePlanFailure({
      availableSlots: workingSlots,
      eligibleSlotCount: strictEligibleSlotCount,
      strictEligibleCapacity,
      bestHistoricalBlockCapacity,
      requestedMinVisits: safeMinVisits,
      requestedMaxVisits: safeMaxVisits,
      effectiveMinVisits: safeMinVisits,
      effectiveMaxVisits: safeMaxVisits,
      planningMode: 'coverage_first',
      usedRelaxedFallback: true,
      strictFallbackReasonCode: strictReferencePlan?.infeasibleReasonCode || null,
      strictFallbackReason: strictReferencePlan?.infeasibleReason || null,
      infeasibleReasonCode: 'no_positive_capacity_slots',
      infeasibleReason: "Aucune capacite historique positive n'a ete detectee pour generer un plan approche."
    })
  }

  const totalClientCapacity = activeSlots.reduce((sum, slot) => sum + Number(slot.max_size || 0), 0)
  const totalTruckCapacityUnits = activeSlots.reduce((sum, slot) => {
    const loadUnits = Number(slot.max_load_units || 0)
    return sum + (Number.isFinite(loadUnits) ? loadUnits : 0)
  }, 0)
  const targetVisits = Math.min(Math.max(0, Number(desiredVisitCount || 0)), totalClientCapacity)

  activeSlots.forEach(slot => {
    slot.target_size = 0
    slot.min_size = safeMinVisits
    slot.strict_limits = false
  })

  let remainingVisits = targetVisits
  let remainingSlots = activeSlots
    .slice()
    .sort((a, b) => Number(a.slot_order || 0) - Number(b.slot_order || 0))

  while (remainingVisits > 0 && remainingSlots.length > 0) {
    const idealShare = Math.max(1, Math.ceil(remainingVisits / remainingSlots.length))
    let distributedThisRound = 0

    remainingSlots.forEach(slot => {
      if (remainingVisits <= 0) return

      const slotCapacity = Math.max(0, Number(slot.max_size || 0))
      const slotRemainingCapacity = Math.max(0, slotCapacity - Number(slot.target_size || 0))
      if (slotRemainingCapacity <= 0) return

      const allocation = Math.min(slotRemainingCapacity, idealShare, remainingVisits)
      if (allocation <= 0) return

      slot.target_size += allocation
      remainingVisits -= allocation
      distributedThisRound += allocation
    })

    if (distributedThisRound <= 0) {
      break
    }

    remainingSlots = remainingSlots.filter(slot => Number(slot.target_size || 0) < Number(slot.max_size || 0))
  }

  const targetedSlots = activeSlots.filter(slot => Number(slot.target_size || 0) > 0)
  const actualTargetSizes = targetedSlots.map(slot => Number(slot.target_size || 0)).filter(value => value > 0)
  const effectiveMinVisits = actualTargetSizes.length ? Math.min(...actualTargetSizes) : 1
  const effectiveMaxVisits = actualTargetSizes.length ? Math.max(...actualTargetSizes) : safeMaxVisits
  const fullCoveragePossible = totalClientCapacity >= desiredVisitCount
  const requestedRangeSatisfied = targetedSlots.length > 0 && targetedSlots.every(slot => (
    Number(slot.target_size || 0) >= safeMinVisits &&
    Number(slot.target_size || 0) <= safeMaxVisits
  ))
  const capacityAverageNeeded = targetedSlots.length > 0
    ? Math.ceil(Math.max(1, Number(desiredVisitCount || 0)) / targetedSlots.length)
    : safeMaxVisits
  const usedRelaxedFallback = !fullCoveragePossible || !requestedRangeSatisfied

  let strictFallbackReasonCode = null
  let strictFallbackReason = null

  if (!fullCoveragePossible) {
    strictFallbackReasonCode = 'hard_capacity_limit'
    strictFallbackReason = `La capacite totale reelle sur cette periode est d'environ ${totalClientCapacity} client(s), donc les ${desiredVisitCount} client(s) actifs ne peuvent pas tous etre couverts sans depasser les limites reelles clients/camion.`
  } else if (capacityAverageNeeded > safeMaxVisits) {
    strictFallbackReasonCode = 'requested_max_too_low_for_full_coverage'
    strictFallbackReason = `Pour couvrir ${desiredVisitCount} client(s) sur ${targetedSlots.length} block(s), il faut en moyenne ${capacityAverageNeeded} client(s) par block. Le max saisi (${safeMaxVisits}) est donc trop bas pour une couverture complete sur cette periode.`
  } else if (effectiveMinVisits < safeMinVisits) {
    strictFallbackReasonCode = 'requested_min_too_high_for_real_slots'
    strictFallbackReason = `La couverture complete force certains block(s) a descendre sous le minimum saisi (${safeMinVisits}) pour pouvoir utiliser toute la periode disponible sans perdre de clients.`
  } else if (strictReferencePlan?.strictFallbackReason) {
    strictFallbackReasonCode = strictReferencePlan.strictFallbackReasonCode || null
    strictFallbackReason = strictReferencePlan.strictFallbackReason
  }

  return {
    slots: targetedSlots,
    totalClientCapacity,
    totalTruckCapacityUnits,
    totalAvailableSlots: workingSlots.length,
    eligibleSlotCount: strictEligibleSlotCount,
    strictEligibleCapacity,
    targetVisits,
    selectedSlotCount: targetedSlots.length,
    fullCoveragePossible,
    bestHistoricalBlockCapacity,
    planningMode: 'coverage_first',
    usedRelaxedFallback,
    requestedMinVisits: safeMinVisits,
    requestedMaxVisits: safeMaxVisits,
    effectiveMinVisits,
    effectiveMaxVisits,
    strictFallbackReasonCode,
    strictFallbackReason,
    recommendedMinVisits: Math.max(1, Math.min(safeMinVisits, effectiveMinVisits)),
    recommendedMaxVisits: Math.max(safeMaxVisits, Math.min(Math.max(effectiveMaxVisits, capacityAverageNeeded), Math.max(bestHistoricalBlockCapacity || 0, effectiveMaxVisits, capacityAverageNeeded))),
    infeasibleReasonCode: null,
    infeasibleReason: null
  }
}

function createBlockSlots(workingDays, commercials, totalVisits, minVisits, maxVisits, capacityProfiles = new Map(), options = {}) {
  const allowRelaxedFallback = Boolean(options.allowRelaxedFallback)
  const availableSlots = []
  const safeMinVisits = Math.max(1, Number(minVisits || 1))
  const safeMaxVisits = Math.max(safeMinVisits, Number(maxVisits || safeMinVisits))
  let slotOrder = 0

  workingDays.forEach(day => {
    commercials.forEach(commercial => {
      const commercialCode = String(commercial.value || '').trim()
      const capacity = resolveCommercialCapacityForDay(
        capacityProfiles.get(commercialCode) || null,
        day.dayIndex,
        safeMaxVisits
      )

      availableSlots.push({
        id: `${day.date}::${commercialCode}`,
        date: day.date,
        day_label: day.label,
        day_index: day.dayIndex,
        proposed_commercial: commercialCode,
        proposed_commercial_label: commercial.label,
        tournees: [],
        total_predicted_ca: 0,
        total_score: 0,
        total_reco_units: 0,
        uniqueClients: new Set(),
        target_size: 0,
        min_size: safeMinVisits,
        max_size: capacity.maxClients,
        requested_max_size: capacity.requestedMaxClients,
        historical_client_capacity: capacity.historicalClientCapacity,
        max_load_units: capacity.maxLoadUnits,
        client_capacity_source: capacity.clientSource,
        truck_capacity_source: capacity.truckSource,
        route_capacity_hint: capacity.routeCapacityHint,
        truck_bound_client_capacity: capacity.truckBoundClientCapacity,
        load_units_per_client: capacity.loadUnitsPerClient,
        strict_limits: true,
        slot_order: slotOrder++
      })
    })
  })

  const bestHistoricalBlockCapacity = availableSlots.reduce(
    (max, slot) => Math.max(max, Number(slot.max_size || 0)),
    0
  )
  const desiredVisitCount = Math.max(0, Number(totalVisits || 0))

  if (availableSlots.length === 0) {
    return buildCoveragePlanFailure({
      availableSlots,
      bestHistoricalBlockCapacity,
      requestedMinVisits: safeMinVisits,
      requestedMaxVisits: safeMaxVisits,
      infeasibleReasonCode: 'no_slots_available',
      infeasibleReason: "Aucun block disponible n'a ete construit sur la periode choisie."
    })
  }

  const strictPlan = buildStrictCoverageSlotPlan(
    availableSlots,
    desiredVisitCount,
    safeMinVisits,
    safeMaxVisits,
    {
      bestHistoricalBlockCapacity,
      requestedMinVisits: safeMinVisits,
      requestedMaxVisits: safeMaxVisits
    }
  )

  if (!allowRelaxedFallback) {
    return strictPlan
  }

  const bestCoveragePlan = buildCoverageFirstSlotPlan(availableSlots, desiredVisitCount, {
    safeMinVisits,
    safeMaxVisits,
    bestHistoricalBlockCapacity,
    strictEligibleSlotCount: Number(strictPlan.eligibleSlotCount || 0),
    strictEligibleCapacity: Number(strictPlan.strictEligibleCapacity || 0),
    strictReferencePlan: strictPlan
  })

  if (bestCoveragePlan.slots.length && Number(bestCoveragePlan.targetVisits || 0) > 0) {
    return bestCoveragePlan
  }

  return strictPlan
}

function resolveSlotClientLimit(slot, options = {}) {
  const useCapacityLimit = Boolean(options.useCapacityLimit)
  const preferredLimit = useCapacityLimit
    ? Number(slot.max_size || slot.target_size || 0)
    : Number(slot.target_size || slot.max_size || 0)
  return Math.max(0, preferredLimit)
}

function resolveCoveragePlanningUnits(slot, entry, slotSignal = null) {
  const plannedUnits = Number(
    entry?.planned_load_units_per_client ||
    entry?.ia_qte_reco ||
    entry?.qte_reco ||
    0
  )
  const historicalUnits = Number(slot?.load_units_per_client || 0)
  const entryHistoricalUnits = Number(entry?.historical_load_units_per_client || 0)
  const effectiveHistoricalUnits = plannedUnits > 0
    ? plannedUnits
    : (entryHistoricalUnits > 0
        ? entryHistoricalUnits
        : (historicalUnits > 0 ? historicalUnits : 0))

  if (effectiveHistoricalUnits > 0) {
    return Math.max(1, Math.ceil(effectiveHistoricalUnits))
  }

  return 1
}

function buildAssignedCoverageClientRow(entry, slot, scoringContext = {}) {
  const slotSignal = entry.slot_predictions?.[slot.id] || null
  const assignedPredictedCa = roundScore(Number(slotSignal?.weighted_predicted_ca || entry.predicted_ca || 0))
  const assignedIaQteReco = Math.max(1, Math.round(Number(slotSignal?.weighted_qte || entry.ia_qte_reco || entry.qte_reco || 1)))
  const assignedQteReco = resolveCoveragePlanningUnits(slot, entry, slotSignal)
  const assignedProducts = slotSignal?.details && typeof slotSignal.details === 'object'
    ? Object.entries(slotSignal.details)
        .map(([nom, quantite]) => ({ nom, quantite }))
        .sort((a, b) => Number(b.quantite || 0) - Number(a.quantite || 0))
    : entry.produits
  const assignedScoreIa = slotSignal
    ? computeCoveragePriorityScore({
        predictedCa: assignedPredictedCa,
        maxPredictedCa: scoringContext.maxPredictedCa,
        probability: slotSignal.probability ?? entry.probability,
        habitScore: slotSignal.habit_score ?? entry.habit_score,
        recencyScore: slotSignal.recency_score ?? entry.recency_score,
        distanceKm: entry.distance_km,
        maxDistanceKm: scoringContext.maxDistanceKm,
        daysSinceLastVisit: entry.days_since_last_visit,
        periodDays: scoringContext.periodDays,
        repetitionIndex: entry.repetition_index
      })
    : entry.score_ia

  return {
    nbr_client: entry.nbr_client,
    canonical_client_key: entry.canonical_client_key,
    chiffre_brut: assignedPredictedCa,
    chiffre: `${Number(assignedPredictedCa || 0).toFixed(1)} TND`,
    score_ia: assignedScoreIa,
    qte_reco: assignedQteReco,
    ia_qte_reco: assignedIaQteReco,
    vente_reelle: 0,
    details: {
      agro: Math.max(0, Math.round(assignedQteReco * 0.45)),
      chips: Math.max(0, Math.round(assignedQteReco * 0.35)),
      bur: Math.max(0, Math.round(assignedQteReco * 0.20))
    },
    produits: assignedProducts,
    prob_achat: Number(slotSignal?.probability ?? entry.probability),
    habit_score: Number(slotSignal?.habit_score ?? entry.habit_score),
    recency_score: Number(slotSignal?.recency_score ?? entry.recency_score),
    commercial_affinity_score: Number(slotSignal?.assignment_prob || entry.commercial_affinity_score || 0),
    distance_km: entry.distance_km,
    date_jour: slot.date,
    commercia_zone: entry.commercia_zone,
    region: entry.region,
    recouvrement: 0,
    nom: entry.nom,
    adresse: entry.adresse,
    latitude: entry.latitude,
    longitude: entry.longitude,
    repetition_index: entry.repetition_index,
    zone_comm: entry.commercia_zone
  }
}

function applyCoverageVisitToSlot(slot, entry, scoringContext = {}) {
  const clientRow = buildAssignedCoverageClientRow(entry, slot, scoringContext)
  slot.tournees.push(clientRow)
  slot.uniqueClients.add(entry.canonical_client_key)
  slot.total_predicted_ca += Number(clientRow.chiffre_brut || 0)
  slot.total_score += Number(clientRow.score_ia || 0)
  slot.total_reco_units += Number(clientRow.qte_reco || 0)
  return clientRow
}

function removeCoverageVisitFromSlot(slot, clientRow) {
  const rowIndex = slot.tournees.findIndex(row => row === clientRow || row.canonical_client_key === clientRow.canonical_client_key)
  if (rowIndex >= 0) {
    slot.tournees.splice(rowIndex, 1)
  }
  slot.uniqueClients.delete(clientRow.canonical_client_key)
  slot.total_predicted_ca = Math.max(0, Number(slot.total_predicted_ca || 0) - Number(clientRow.chiffre_brut || 0))
  slot.total_score = Math.max(0, Number(slot.total_score || 0) - Number(clientRow.score_ia || 0))
  slot.total_reco_units = Math.max(0, Number(slot.total_reco_units || 0) - Number(clientRow.qte_reco || 0))
}

function canPlaceCoverageVisitInSlot(slot, visit, options = {}) {
  if (!slot || !visit) return false

  const slotLimit = resolveSlotClientLimit(slot, options)
  if (slot.uniqueClients.has(visit.canonical_client_key)) return false
  if (slot.tournees.length >= slotLimit) return false

  const slotSignal = visit.slot_predictions?.[slot.id] || null
  const projectedUnits = resolveCoveragePlanningUnits(slot, visit, slotSignal)
  if (Number.isFinite(Number(slot.max_load_units)) && Number(slot.max_load_units) > 0) {
    const nextLoad = Number(slot.total_reco_units || 0) + projectedUnits
    if (nextLoad > Number(slot.max_load_units)) {
      return false
    }
  }

  return true
}

function tryRepairCoverageVisitByRebalancing(slots, visitEntry, visitEntryByKey, scoringContext = {}, cursorRef = { current: 0 }, diagnostics = null, options = {}) {
  const candidateSlots = Array.isArray(slots)
    ? slots.slice().sort((a, b) => Number(a.slot_order || 0) - Number(b.slot_order || 0))
    : []

  for (const targetSlot of candidateSlots) {
    if (!targetSlot || targetSlot.uniqueClients.has(visitEntry.canonical_client_key)) {
      continue
    }

    const targetSlotSignal = visitEntry.slot_predictions?.[targetSlot.id] || null
    const projectedUnits = resolveCoveragePlanningUnits(targetSlot, visitEntry, targetSlotSignal)
    const donorRows = targetSlot.tournees
      .slice()
      .sort((a, b) => (
        Number(b.qte_reco || 0) - Number(a.qte_reco || 0)
      ) || (
        Number(a.score_ia || 0) - Number(b.score_ia || 0)
      ))

    for (const donorRow of donorRows) {
      const donorEntry = visitEntryByKey.get(String(donorRow.canonical_client_key || '').trim())
      if (!donorEntry) continue

      const alternativeSlots = candidateSlots.filter(slot => slot.id !== targetSlot.id)
      const recipientSlot = pickBestSlotForVisit(
        alternativeSlots,
        donorEntry,
        cursorRef,
        diagnostics,
        { useCapacityLimit: true, dailyCaTarget: Number(options.dailyCaTarget || 0) }
      )

      if (!recipientSlot) {
        continue
      }

      const slotLimit = resolveSlotClientLimit(targetSlot, { useCapacityLimit: true })
      const nextClientCount = Math.max(0, targetSlot.tournees.length - 1) + 1
      if (nextClientCount > slotLimit) {
        continue
      }

      if (Number.isFinite(Number(targetSlot.max_load_units)) && Number(targetSlot.max_load_units) > 0) {
        const nextLoad = Math.max(0, Number(targetSlot.total_reco_units || 0) - Number(donorRow.qte_reco || 0)) + projectedUnits
        if (nextLoad > Number(targetSlot.max_load_units)) {
          continue
        }
      }

      removeCoverageVisitFromSlot(targetSlot, donorRow)
      applyCoverageVisitToSlot(recipientSlot, donorEntry, scoringContext)
      recipientSlot.target_size = Math.max(Number(recipientSlot.target_size || 0), recipientSlot.tournees.length)
      applyCoverageVisitToSlot(targetSlot, visitEntry, scoringContext)
      targetSlot.target_size = Math.max(Number(targetSlot.target_size || 0), targetSlot.tournees.length)

      return {
        repaired: true,
        targetSlotId: targetSlot.id,
        recipientSlotId: recipientSlot.id,
        movedClientKey: donorEntry.canonical_client_key
      }
    }
  }

  return {
    repaired: false,
    targetSlotId: null,
    recipientSlotId: null,
    movedClientKey: null
  }
}

function repairUnassignedCoverageVisits(slots, unassignedClientKeys, visitEntryByKey, scoringContext = {}, options = {}) {
  const allSlots = Array.isArray(slots)
    ? slots.slice().sort((a, b) => Number(a.slot_order || 0) - Number(b.slot_order || 0))
    : []
  const remainingClientKeys = Array.isArray(unassignedClientKeys) ? unassignedClientKeys : []
  const diagnostics = { clientCapacityBlocks: 0, truckCapacityBlocks: 0 }
  const cursorRef = { current: 0 }
  const repairedAssignments = []
  const stillUnassignedKeys = []
  let rebalancedRepairs = 0

  const rankedEntries = remainingClientKeys
    .map(clientKey => visitEntryByKey.get(String(clientKey || '').trim()) || null)
    .filter(Boolean)
    .sort((a, b) => {
      if (Number(Boolean(b.is_critical_coverage)) !== Number(Boolean(a.is_critical_coverage))) {
        return Number(Boolean(b.is_critical_coverage)) - Number(Boolean(a.is_critical_coverage))
      }
      if (Number(b.coverage_gap_days || 0) !== Number(a.coverage_gap_days || 0)) {
        return Number(b.coverage_gap_days || 0) - Number(a.coverage_gap_days || 0)
      }
      if (Number(b.score_ia || 0) !== Number(a.score_ia || 0)) {
        return Number(b.score_ia || 0) - Number(a.score_ia || 0)
      }
      return Number(b.predicted_ca || 0) - Number(a.predicted_ca || 0)
    })

  rankedEntries.forEach(entry => {
    const slotPredictionMap = entry.slot_predictions && typeof entry.slot_predictions === 'object'
      ? entry.slot_predictions
      : {}
    const preferredSlots = Object.keys(slotPredictionMap).length
      ? allSlots.filter(slot => Boolean(slotPredictionMap[slot.id]))
      : allSlots

    const recipientSlot = pickBestSlotForVisit(
      preferredSlots.length ? preferredSlots : allSlots,
      entry,
      cursorRef,
      diagnostics,
      { useCapacityLimit: true, dailyCaTarget: Number(options.dailyCaTarget || 0) }
    )

    if (!recipientSlot) {
      const rebalanceResult = tryRepairCoverageVisitByRebalancing(
        preferredSlots.length ? preferredSlots : allSlots,
        entry,
        visitEntryByKey,
        scoringContext,
        cursorRef,
        diagnostics,
        { dailyCaTarget: Number(options.dailyCaTarget || 0) }
      )

      if (!rebalanceResult.repaired) {
        stillUnassignedKeys.push(entry.canonical_client_key)
        return
      }

      rebalancedRepairs += 1
      repairedAssignments.push({
        slot_id: rebalanceResult.targetSlotId,
        client_key: entry.canonical_client_key
      })
      return
    }

    applyCoverageVisitToSlot(recipientSlot, entry, scoringContext)
    recipientSlot.target_size = Math.max(Number(recipientSlot.target_size || 0), recipientSlot.tournees.length)
    repairedAssignments.push({
      slot_id: recipientSlot.id,
      client_key: entry.canonical_client_key
    })
  })

  return {
    repairedVisits: repairedAssignments.length,
    rebalancedRepairs,
    repairedAssignments,
    remainingUnassignedKeys: stillUnassignedKeys,
    diagnostics
  }
}

function compactUnderfilledCoverageSlots(slots, visitEntryByKey, scoringContext = {}, options = {}) {
  if (options.coverageFirst) {
    return {
      movedVisits: 0,
      deferredVisits: 0,
      dissolvedSlots: 0,
      diagnostics: { clientCapacityBlocks: 0, truckCapacityBlocks: 0 }
    }
  }

  const dailyCaTarget = Math.max(0, Number(options.dailyCaTarget || 0))
  const candidates = (Array.isArray(slots) ? slots : [])
    .filter(slot => slot.tournees.length > 0)
    .slice()
    .sort((a, b) => {
      const minA = Math.max(1, Number(a.min_size || 1))
      const minB = Math.max(1, Number(b.min_size || 1))
      const underfilledA = Number(a.tournees.length || 0) < minA ? 1 : 0
      const underfilledB = Number(b.tournees.length || 0) < minB ? 1 : 0
      if (underfilledB !== underfilledA) return underfilledB - underfilledA

      const caMissA = dailyCaTarget > 0 ? Math.max(0, dailyCaTarget - Number(a.total_predicted_ca || 0)) : 0
      const caMissB = dailyCaTarget > 0 ? Math.max(0, dailyCaTarget - Number(b.total_predicted_ca || 0)) : 0
      if (caMissB !== caMissA) return caMissB - caMissA

      return Number(a.tournees.length || 0) - Number(b.tournees.length || 0)
    })

  if (!candidates.length) {
    return {
      movedVisits: 0,
      deferredVisits: 0,
      dissolvedSlots: 0
    }
  }

  const cursorRef = { current: 0 }
  const diagnostics = { clientCapacityBlocks: 0, truckCapacityBlocks: 0 }
  let movedVisits = 0
  let deferredVisits = 0
  let dissolvedSlots = 0

  for (const donorSlot of candidates) {
    const minimumSize = Math.max(1, Number(donorSlot.min_size || 1))
    const underfilled = donorSlot.tournees.length < minimumSize
    const belowDailyCa = dailyCaTarget > 0 && Number(donorSlot.total_predicted_ca || 0) < dailyCaTarget

    if (donorSlot.tournees.length === 0 || (!underfilled && !belowDailyCa)) {
      continue
    }

    const donorVisits = donorSlot.tournees
      .slice()
      .sort((a, b) => {
        if (Number(a.qte_reco || 0) !== Number(b.qte_reco || 0)) {
          return Number(a.qte_reco || 0) - Number(b.qte_reco || 0)
        }
        return Number(a.score_ia || 0) - Number(b.score_ia || 0)
      })

    for (const clientRow of donorVisits) {
      if (!donorSlot.tournees.some(row => row.canonical_client_key === clientRow.canonical_client_key)) {
        continue
      }

      const visitEntry = visitEntryByKey.get(clientRow.canonical_client_key) || null
      if (!visitEntry) {
        continue
      }

      const recipientSlots = slots.filter(slot => (
        slot.id !== donorSlot.id &&
        slot.tournees.length > 0
      ))

      const recipientSlot = pickBestSlotForVisit(
        recipientSlots,
        visitEntry,
        cursorRef,
        diagnostics,
        { useCapacityLimit: true, dailyCaTarget }
      )

      if (!recipientSlot) {
        continue
      }

      removeCoverageVisitFromSlot(donorSlot, clientRow)
      applyCoverageVisitToSlot(recipientSlot, visitEntry, scoringContext)
      movedVisits += 1
    }

    const donorStillUnderfilled = donorSlot.tournees.length > 0 && donorSlot.tournees.length < minimumSize
    const donorStillBelowDailyCa = donorSlot.tournees.length > 0 && dailyCaTarget > 0 && Number(donorSlot.total_predicted_ca || 0) < dailyCaTarget

    if (donorStillUnderfilled || donorStillBelowDailyCa) {
      deferredVisits += donorSlot.tournees.length
      donorSlot.tournees = []
      donorSlot.uniqueClients.clear()
      donorSlot.total_predicted_ca = 0
      donorSlot.total_score = 0
      donorSlot.total_reco_units = 0
      dissolvedSlots += 1
    } else if (donorSlot.tournees.length === 0) {
      dissolvedSlots += 1
    }
  }

  return {
    movedVisits,
    deferredVisits,
    dissolvedSlots,
    diagnostics
  }
}

function pickBestSlotForVisit(slots, visit, cursorRef, diagnostics = null, options = {}) {
  if (!slots.length) return null

  const totalSlots = slots.length
  const preferredCommercial = String(visit.proposed_commercial || '').trim()
  const preferredSlotId = String(visit.recommended_slot_id || '').trim()
  const clientKey = visit.canonical_client_key
  const dailyCaTarget = Math.max(0, Number(options.dailyCaTarget || 0))

  const scoreSlot = (slot, index) => {
    const slotSignal = visit.slot_predictions?.[slot.id] || null
    const mlAffinity = clamp(Number(slotSignal?.assignment_prob || 0), 0, 100)
    const mlPredictedCa = Math.max(0, Number(slotSignal?.weighted_predicted_ca || slotSignal?.predicted_ca || 0))
    const projectedUnits = resolveCoveragePlanningUnits(slot, visit, slotSignal)
    const sameCommercial = preferredCommercial && slot.proposed_commercial === preferredCommercial ? 6 : 0
    const recommendedSlotBonus = preferredSlotId && slot.id === preferredSlotId ? 12 : 0
    const slotLimit = resolveSlotClientLimit(slot, options)
    const remainingCapacity = Math.max(0, slotLimit - slot.tournees.length)
    const remainingTruckUnits = Number.isFinite(Number(slot.max_load_units))
      ? Math.max(0, Number(slot.max_load_units) - Number(slot.total_reco_units || 0))
      : projectedUnits
    const truckRoomBonus = Math.min(remainingTruckUnits, projectedUnits * 2) * 0.02
    const loadPenalty = slot.tournees.length * 2
    const cursorBonus = ((index - cursorRef.current + totalSlots) % totalSlots) === 0 ? 4 : 0
    const consolidationBonus = Boolean(options.useCapacityLimit)
      ? slot.tournees.length * 0.75
      : 0
    const currentCa = Number(slot.total_predicted_ca || 0)
    const caGap = dailyCaTarget > 0 ? Math.max(0, dailyCaTarget - currentCa) : 0
    const caTargetBonus = dailyCaTarget > 0 && caGap > 0
      ? Math.min(caGap, mlPredictedCa) * 0.03
      : 0
    const criticalCoverageBonus = visit.is_critical_coverage ? 22 : 0
    const softTarget = Math.max(0, Number(slot.target_size || 0))
    const softTargetGap = softTarget > 0 ? Math.max(0, softTarget - slot.tournees.length) : 0
    const softTargetBonus = softTarget > 0
      ? (softTargetGap > 0 ? softTargetGap * 2.25 : Math.max(-8, (softTarget - slot.tournees.length) * 1.25))
      : 0
    return (mlAffinity * 0.45) + (mlPredictedCa * 0.02) + sameCommercial + recommendedSlotBonus + (remainingCapacity * 3) + truckRoomBonus - loadPenalty + cursorBonus + consolidationBonus + caTargetBonus + criticalCoverageBonus + softTargetBonus
  }

  let bestIndex = -1
  let bestScore = Number.NEGATIVE_INFINITY
  let blockedByClientCapacity = 0
  let blockedByTruckCapacity = 0

  for (let i = 0; i < totalSlots; i += 1) {
    const index = (cursorRef.current + i) % totalSlots
    const slot = slots[index]
    const slotLimit = resolveSlotClientLimit(slot, options)
    if (slot.uniqueClients.has(clientKey)) continue
    if (slot.tournees.length >= slotLimit) {
      blockedByClientCapacity += 1
      continue
    }

    const slotSignal = visit.slot_predictions?.[slot.id] || null
    const projectedUnits = resolveCoveragePlanningUnits(slot, visit, slotSignal)
    if (Number.isFinite(Number(slot.max_load_units)) && Number(slot.max_load_units) > 0) {
      const nextLoad = Number(slot.total_reco_units || 0) + projectedUnits
      if (nextLoad > Number(slot.max_load_units)) {
        blockedByTruckCapacity += 1
        continue
      }
    }

    const currentScore = scoreSlot(slot, index)
    if (currentScore > bestScore) {
      bestScore = currentScore
      bestIndex = index
    }
  }

  if (bestIndex < 0) {
    if (diagnostics) {
      diagnostics.clientCapacityBlocks += blockedByClientCapacity > 0 ? 1 : 0
      diagnostics.truckCapacityBlocks += blockedByTruckCapacity > 0 ? 1 : 0
    }
    return null
  }

  cursorRef.current = (bestIndex + 1) % totalSlots
  return slots[bestIndex]
}

function finalizeCoverageBlock(slot, depotOrigin) {
  const tournees = slot.tournees
    .sort((a, b) => (b.score_ia - a.score_ia) || (b.chiffre_brut - a.chiffre_brut))
    .map((row, index) => ({
      ...row,
      date_jour: slot.date,
      jour_label: slot.day_label,
      ordre_theorique: index + 1
    }))

  const produitsTotaux = {}
  tournees.forEach(row => {
    if (row.produits && row.produits.length > 0) {
      row.produits.forEach(produit => {
        const nom = String(produit.nom || '').trim()
        if (!nom) return
        if (!produitsTotaux[nom]) {
          produitsTotaux[nom] = 0
        }
        produitsTotaux[nom] += Number(produit.quantite || 0)
      })
    }
  })

  const detailsProduits = Object.entries(produitsTotaux)
    .map(([nom, quantite]) => ({ nom, quantite: roundScore(quantite) }))
    .sort((a, b) => b.quantite - a.quantite)

  const chargeTotale = {
    agro: tournees.reduce((sum, row) => sum + Number(row.details?.agro || 0), 0),
    chips: tournees.reduce((sum, row) => sum + Number(row.details?.chips || 0), 0),
    bureautique: tournees.reduce((sum, row) => sum + Number(row.details?.bur || 0), 0),
    detailsProduits
  }

  const itineraire = tournees.map((row, index) => `${index + 1}. ${row.nom} (${row.nbr_client}) - ${row.adresse || 'Adresse non specifiee'}`)
  const itineraire_geo = tournees.map((row, index) => ({
    step: index + 1,
    client_code: row.nbr_client,
    nom: row.nom,
    adresse: row.adresse || 'Adresse non specifiee',
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    score_ia: row.score_ia,
    qte_reco: row.qte_reco
  }))

  return {
    id: slot.id,
    date: slot.date,
    day_label: slot.day_label,
    proposed_commercial: slot.proposed_commercial,
    proposed_commercial_label: slot.proposed_commercial_label,
    prediction_run_code: String(slot.prediction_run_code || '').trim() || null,
    clients_count: tournees.length,
    predicted_ca: roundScore(slot.total_predicted_ca),
    average_score: tournees.length ? roundScore(slot.total_score / tournees.length) : 0,
    capacity: {
      planned_clients: tournees.length,
      target_clients: Number(slot.target_size || 0),
      min_clients: Number(slot.min_size || 0),
      max_clients: Number(slot.max_size || slot.target_size || 0),
      historical_max_clients: Number(slot.historical_client_capacity || 0),
      strict_limits: Boolean(slot.strict_limits),
      planned_truck_units: roundScore(Number(slot.total_reco_units || 0)),
      max_truck_units: Number.isFinite(Number(slot.max_load_units)) ? roundScore(Number(slot.max_load_units)) : null,
      client_capacity_source: slot.client_capacity_source,
      truck_capacity_source: slot.truck_capacity_source,
      route_capacity_hint: slot.route_capacity_hint,
      truck_bound_client_capacity: Number(slot.truck_bound_client_capacity || 0) || null,
      load_units_per_client: Number(slot.load_units_per_client || 0) || null,
      planned_route_minutes: Number.isFinite(Number(slot.planned_route_minutes)) ? roundScore(Number(slot.planned_route_minutes)) : null,
      estimated_route_minutes: Number.isFinite(Number(slot.estimated_route_minutes)) ? roundScore(Number(slot.estimated_route_minutes)) : null,
      max_route_minutes: Number.isFinite(Number(slot.max_route_minutes)) && Number(slot.max_route_minutes) > 0 ? roundScore(Number(slot.max_route_minutes)) : null,
      route_duration_overflow: Number.isFinite(Number(slot.route_duration_overflow)) ? roundScore(Number(slot.route_duration_overflow)) : 0
    },
    detail: {
      tournees,
      total: tournees.length,
      jourSelectionne: slot.date,
      chargeTotale,
      itineraire,
      itineraire_geo,
      depot_origin: depotOrigin
    }
  }
}

function runManualTraining(res) {
  const scriptPath = path.join(apiDir, 'train_auto.py')
  execFile('python', [scriptPath], { cwd: apiDir }, async (error, stdout, stderr) => {
    if (error) {
      console.error(`Erreur d'execution Python: ${error.message}`)
      if (stderr) {
        console.error(stderr)
      }
      return res.status(500).json({
        status: 'error',
        message: "Le reentrainement manuel a echoue. L'application continue d'utiliser le dernier modele valide."
      })
    }

    console.log(`Resultat Python:\n${stdout}`)
    let reloadStatus = 'Reload IA non tente.'
    try {
      const reloadResponse = await axios.post('http://127.0.0.1:5001/api/reload-models')
      reloadStatus = reloadResponse.data?.message || 'Modeles IA recharges.'
    } catch (reloadError) {
      reloadStatus = `Reload IA indisponible: ${reloadError.message}`
      console.warn(reloadStatus)
    }

    return res.json({
      status: 'success',
      message: 'Reentrainement termine. Le dernier modele IA est maintenant disponible.',
      details: stdout,
      reload_status: reloadStatus
    })
  })
}

app.post('/api/train-ia', (req, res) => {
  console.log("Lancement d'un reentrainement manuel IA...")
  runManualTraining(res)
})

app.post('/api/ia/prediction-feedback/reconcile', async (req, res) => {
  const payload = req.body || {}
  const runCode = String(payload.run_code || payload.prediction_run_code || req.query.run_code || '').trim() || null
  const feedbackDate = String(payload.feedback_date || req.query.feedback_date || '').trim() || null
  const dateFrom = String(payload.date_from || req.query.date_from || '').trim() || null
  const dateTo = String(payload.date_to || req.query.date_to || '').trim() || null
  const rawOnlyPending = payload.only_pending ?? req.query.only_pending
  const onlyPending = rawOnlyPending == null
    ? true
    : !['0', 'false', 'non', 'no'].includes(String(rawOnlyPending).trim().toLowerCase())

  try {
    const result = await reconcilePredictionFeedbackActualSales({
      runCode,
      feedbackDate,
      dateFrom,
      dateTo,
      onlyPending,
      logPrefix: 'PREDICTION_RECONCILE_API'
    })

    return res.json({
      status: 'success',
      message: result.skipped
        ? 'Aucune ligne feedback eligible a reconcilier pour le moment.'
        : `${result.checkedRows} ligne(s) feedback ont ete rapprochees avec les ventes reelles.`,
      filters: {
        run_code: runCode,
        feedback_date: feedbackDate,
        date_from: dateFrom,
        date_to: dateTo,
        only_pending: onlyPending
      },
      ...result
    })
  } catch (error) {
    console.error('[PREDICTION_RECONCILE_API] Erreur reconciliation feedback:', error.message)
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Impossible de rapprocher les feedbacks IA avec les ventes reelles.'
    })
  }
})

app.get('/api/tournees/options', async (req, res) => {
  try {
    const [routeRows, commerciaux, activeClientRows] = await Promise.all([
      queryAsync(`
        SELECT DISTINCT TRIM(routing_code) AS route
        FROM clients
        WHERE deleted_at IS NULL
          AND isactif = '1'
          AND routing_code IS NOT NULL
          AND TRIM(routing_code) != ''
        ORDER BY route
      `),
      fetchCommercialOptions(),
      queryAsync(`
        SELECT COUNT(DISTINCT id) AS active_clients_count
        FROM clients
        WHERE deleted_at IS NULL
          AND isactif = '1'
      `)
    ])

    res.json({
      routes: (routeRows || []).map(row => {
        const route = String(row?.route || '').trim()
        return {
          value: route,
          label: `Route ${route}`
        }
      }).filter(option => option.value),
      commerciaux,
      active_clients_count: Number(activeClientRows?.[0]?.active_clients_count || 0),
      coverage_defaults: {
        coverage_window_days: DEFAULT_COVERAGE_WINDOW_DAYS,
        daily_max_mode: DEFAULT_DAILY_MAX_MODE
      },
      next_best_visit_defaults: {
        objective_mode: 'balanced',
        respect_availability: 'flexible',
        minimum_confidence: 0,
        daily_max_mode: DEFAULT_DAILY_MAX_MODE
      }
    })
  } catch (error) {
    console.error('Erreur SQL options tournees:', error.message)
    res.status(500).json({ error: 'Erreur SQL options tournees' })
  }
})

app.post('/api/tournees/coverage-plan/validate', async (req, res) => {
  const payload = req.body || {}
  const commercialCode = String(payload.commercial_code || '').trim()
  const commercialLabel = String(payload.commercial_label || `Commercial ${commercialCode}`).trim()
  const routeCode = String(payload.route_code || '').trim()
  const depotCode = String(payload.depot_code || '').trim()
  const depotName = String(payload.depot_name || '').trim()
  const stops = payload.stops

  try {
    const result = await saveValidatedTourneePlan({
      date: payload.date,
      dayLabel: payload.day_label,
      commercialCode,
      commercialLabel,
      routeCode,
      depotCode,
      depotName,
      stops,
      frequence: 'couverture_ia',
      categorieCode: 'coverage_ia',
      typeClient: 'coverage_plan',
      codePrefix: 'coverage',
      predictionRunCode: payload.prediction_run_code,
      logPrefix: 'COVERAGE_VALIDATE'
    })

    return res.json(result)
  } catch (error) {
    const statusCode = error.statusCode || 500
    console.error('[COVERAGE_VALIDATE] Erreur validation plan de route:', error.message)
    return res.status(statusCode).json({ error: error.message || "Impossible d'enregistrer la tournee finale." })
  }
})

app.post('/api/tournees/plan/validate', async (req, res) => {
  const payload = req.body || {}
  const commercialCode = String(payload.commercial_code || '').trim()
  const commercialLabel = String(payload.commercial_label || `Commercial ${commercialCode}`).trim()
  const routeCode = String(payload.route_code || '').trim()
  const depotCode = String(payload.depot_code || '').trim()
  const depotName = String(payload.depot_name || '').trim()
  const stops = payload.stops
  const modeTournee = String(payload.mode_tournee || 'vente').trim() === 'recouvrement' ? 'recouvrement' : 'vente'
  const loadingProducts = Array.isArray(payload.loading_products) ? payload.loading_products : null

  try {
    const result = await saveValidatedTourneePlan({
      date: payload.date,
      dayLabel: payload.day_label,
      commercialCode,
      commercialLabel,
      routeCode,
      depotCode,
      depotName,
      stops,
      frequence: modeTournee === 'recouvrement' ? 'plan_route_recouvrement' : 'plan_route_vente',
      categorieCode: modeTournee === 'recouvrement' ? 'plan_route_recouvrement' : 'plan_route_vente',
      typeClient: modeTournee === 'recouvrement' ? 'route_plan_recouvrement' : 'route_plan_vente',
      codePrefix: modeTournee === 'recouvrement' ? 'recouvrement' : 'vente',
      predictionRunCode: payload.prediction_run_code,
      loadingProducts: modeTournee === 'recouvrement' ? null : loadingProducts,
      logPrefix: 'ROUTE_PLAN_VALIDATE'
    })

    return res.json(result)
  } catch (error) {
    const statusCode = error.statusCode || 500
    console.error('[ROUTE_PLAN_VALIDATE] Erreur validation plan de route:', error.message)
    return res.status(statusCode).json({ error: error.message || "Impossible d'enregistrer la tournee finale." })
  }
})

async function generateCoveragePlanResponse(rawBody = {}, dependencyOverrides = {}, runtimeOptions = {}) {
  const perfTracker = runtimeOptions.perfTracker || createCoveragePerfTracker()
  const totalStartedAt = runtimeOptions.totalStartedAt || Date.now()
  const buildPlanningContextImpl = typeof dependencyOverrides.buildCoveragePlanningContext === 'function'
    ? dependencyOverrides.buildCoveragePlanningContext
    : buildCoveragePlanningContext
  const fetchCoveragePlanImpl = typeof dependencyOverrides.fetchOrToolsCoveragePlan === 'function'
    ? dependencyOverrides.fetchOrToolsCoveragePlan
    : fetchOrToolsCoveragePlan
  const computeFunctionalHashImpl = typeof dependencyOverrides.computeCoverageFunctionalResultHash === 'function'
    ? dependencyOverrides.computeCoverageFunctionalResultHash
    : computeCoverageFunctionalResultHash
  const computeObjectHashImpl = typeof dependencyOverrides.computeStableObjectHash === 'function'
    ? dependencyOverrides.computeStableObjectHash
    : computeStableObjectHash

  const planningContext = await buildPlanningContextImpl(rawBody, {}, { perfTracker })
  if (planningContext.invalidResponse) {
    perfTracker.mark('total', totalStartedAt)
    return {
      statusCode: 200,
      payload: planningContext.invalidResponse
    }
  }
  if (planningContext.emptyResponse) {
    perfTracker.mark('total', totalStartedAt)
    return {
      statusCode: 200,
      payload: planningContext.emptyResponse
    }
  }

  const optimizerPayload = {
    ...planningContext.optimizerPayload,
    strict_ca: planningContext.strictCa || planningContext.minDailyCaPerCommercial > 0,
    include_feasibility_analysis: true
  }
  const optimizerResponse = await runCoveragePerfStage(perfTracker, 'call_python', async () => fetchCoveragePlanImpl(optimizerPayload))
  const optimizerResult = optimizerResponse?.data && typeof optimizerResponse.data === 'object'
    ? optimizerResponse.data
    : {}
  perfTracker.merge(optimizerResult?.meta?.performance?.stages || [])
  const analysisResult = optimizerResult?.analysis && typeof optimizerResult.analysis === 'object'
    ? optimizerResult.analysis
    : {}
  const blockingReasons = buildCoverageBlockingReasons({
    analysisResult,
    planningContext
  })
  const hardReason = String(analysisResult.reason || '').trim()
  if (hardReason === 'no_available_slots') {
    perfTracker.mark('total', totalStartedAt)
    const capacityPrecheck = buildCoverageCapacityPrecheck(planningContext)
    return {
      statusCode: 200,
      payload: {
        status: 'infeasible',
        reason: hardReason,
        summary: {
          planning_start_date: planningContext.startDate,
          planning_end_date: planningContext.planningDaysList[planningContext.planningDaysList.length - 1]?.date || planningContext.startDate,
          planning_horizon_days: planningContext.planningHorizonDays || planningContext.planningDays,
          coverage_window_days: planningContext.coverageWindowDays || planningContext.visitFrequencyDays,
          daily_max_mode: planningContext.dailyMaxMode || DEFAULT_DAILY_MAX_MODE,
          clients_to_cover: Number(analysisResult?.feasibility?.clients_to_cover || 0),
          unique_clients_covered: 0,
          missing_clients_count: Number(analysisResult?.feasibility?.clients_to_cover || 0),
          duplicate_clients_count: 0,
          total_visits: 0,
          total_slots: planningContext.totalSlots,
          used_slots: 0,
          unused_slots: planningContext.totalSlots,
          total_capacity: planningContext.totalConfiguredCapacity,
          required_average_per_slot: Number(analysisResult?.feasibility?.required_average_per_slot || 0),
          required_minimum_max_per_slot: Number(analysisResult?.feasibility?.required_minimum_max_per_slot || 0),
          total_predicted_ca: 0,
          total_ca_shortfall: 0,
          solver_status: 'SKIPPED_AFTER_ANALYSIS',
          strict_capacity: capacityPrecheck.strict_capacity,
          required_visits_count: capacityPrecheck.required_visits_count,
          available_slots_count: capacityPrecheck.available_slots_count,
          capacity_deficit: capacityPrecheck.capacity_deficit,
          minimum_required_average: capacityPrecheck.minimum_required_average,
          minimum_required_peak_estimate: capacityPrecheck.minimum_required_peak_estimate,
          coverage_guarantee_status: resolveCoverageGuaranteeStatus()
        },
        blocks: [],
        diagnostics: {
          capacity_issues: [],
          commercial_capacity_issues: [],
          deadline_issues: [],
          ca_issues: [],
          invalid_gps_clients: [],
          input_duplicate_clients_removed: []
        },
        depot: SHARED_DEPOT_ORIGIN,
        analysis: analysisResult,
        client_scope: buildCoverageClientScopePayload(
          planningContext?.clientScope,
          capacityPrecheck.active_clients_count
        ),
        capacity_precheck: capacityPrecheck,
        request_context: buildCoverageRequestContext(planningContext, false),
        message: blockingReasons.length
          ? blockingReasons.map(item => item.title).join(' - ')
          : `Le plan de couverture n'est pas realisable sur cette periode. ${buildCoverageSingleVisitDisclaimer(planningContext)}`
      }
    }
  }

  assertCoverageConstraintResult(optimizerPayload, optimizerResult)

  const baseResponsePayload = await runCoveragePerfStage(perfTracker, 'serialize_response', async () => {
    const decoratedBlocks = decorateCoverageBlocks(optimizerResult?.blocks, planningContext)
    const decoratedSummary = decorateCoverageSummary(optimizerResult?.summary || {}, planningContext, decoratedBlocks)
    return {
      ...optimizerResult,
      summary: decoratedSummary,
      blocks: decoratedBlocks,
      depot: SHARED_DEPOT_ORIGIN,
      analysis: analysisResult,
      client_scope: buildCoverageClientScopePayload(
        planningContext?.clientScope,
        planningContext?.capacityPrecheck?.active_clients_count || planningContext?.selectedClientsCount || 0
      ),
      capacity_precheck: buildCoverageCapacityPrecheck(planningContext),
      request_context: buildCoverageRequestContext(planningContext, optimizerPayload.strict_ca),
      message: buildCoverageResponseMessage(optimizerResult, planningContext, decoratedSummary, decoratedBlocks)
    }
  })
  perfTracker.mark('total', totalStartedAt)
  const payload = !isCoveragePerfDebugEnabled()
    ? baseResponsePayload
    : {
        ...(function () {
          const optimizerMeta = optimizerResult?.meta && typeof optimizerResult.meta === 'object'
            ? optimizerResult.meta
            : {}
          if (optimizerMeta.input_fingerprints && typeof optimizerMeta.input_fingerprints === 'object') {
            const fingerprints = optimizerMeta.input_fingerprints
            console.log(
              `[COVERAGE_INPUT] request_params_hash=${String(fingerprints.request_params_hash || '')} ` +
              `clients_snapshot_hash=${String(fingerprints.clients_snapshot_hash || '')} ` +
              `slots_hash=${String(fingerprints.slots_hash || '')} ` +
              `constraints_hash=${String(fingerprints.constraints_hash || '')} ` +
              `predictions_hash=${String(fingerprints.predictions_hash || '')} ` +
              `history_profiles_hash=${String(fingerprints.history_profiles_hash || '')} ` +
              `input_candidate_pairs_snapshot_hash=${String(fingerprints.input_candidate_pairs_snapshot_hash || '')} ` +
              `functional_input_hash=${String(fingerprints.functional_input_hash || '')}`
            )
          }
          if (optimizerMeta.greedy_trace && typeof optimizerMeta.greedy_trace === 'object') {
            const trace = optimizerMeta.greedy_trace
            console.log(
              `[COVERAGE_GREEDY_TRACE] greedy_candidate_order_hash=${String(trace.greedy_candidate_order_hash || '')} ` +
              `client_priority_order_hash=${String(trace.client_priority_order_hash || '')} ` +
              `candidate_order_by_client_hash=${String(trace.candidate_order_by_client_hash || '')} ` +
              `initial_capacities_hash=${String(trace.initial_capacities_hash || '')} ` +
              `assignment_decisions_hash=${String(trace.assignment_decisions_hash || '')} ` +
              `assignments_before_postprocess_hash=${String(trace.assignments_before_postprocess_hash || '')} ` +
              `assignments_after_postprocess_hash=${String(trace.assignments_after_postprocess_hash || '')} ` +
              `canonical_functional_result_hash=${String(trace.canonical_functional_result_hash || '')}`
            )
          }
          const nodePythonPayloadHash = computeObjectHashImpl(optimizerResponse?.data && typeof optimizerResponse.data === 'object' ? optimizerResponse.data : {})
          const nodeResultBeforeEnrichmentHash = computeObjectHashImpl(optimizerResult)
          const nodeResultAfterEnrichmentHash = computeObjectHashImpl(baseResponsePayload)
          const canonicalFunctionalResultHash = computeFunctionalHashImpl(baseResponsePayload)
          console.log(
            `[COVERAGE_RESULT] node_python_payload_hash=${nodePythonPayloadHash} ` +
            `node_result_before_enrichment_hash=${nodeResultBeforeEnrichmentHash} ` +
            `node_result_after_enrichment_hash=${nodeResultAfterEnrichmentHash} ` +
            `canonical_functional_result_hash=${canonicalFunctionalResultHash}`
          )
          return {
            ...baseResponsePayload,
            meta: {
              ...(baseResponsePayload.meta && typeof baseResponsePayload.meta === 'object' ? baseResponsePayload.meta : {}),
              performance: perfTracker.toMeta(),
              result_hashes: {
                ...(
                  baseResponsePayload.meta?.result_hashes && typeof baseResponsePayload.meta.result_hashes === 'object'
                    ? baseResponsePayload.meta.result_hashes
                    : {}
                ),
                node_python_payload_hash: nodePythonPayloadHash,
                node_result_before_enrichment_hash: nodeResultBeforeEnrichmentHash,
                node_result_after_enrichment_hash: nodeResultAfterEnrichmentHash,
                canonical_functional_result_hash: canonicalFunctionalResultHash
              }
            }
          }
        })()
      }

  return {
    statusCode: 200,
    payload
  }
}

async function handleCoverageCapacityPrecheck(req, res) {
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {}

  try {
    const planningContext = await buildCoverageCapacityPrecheckContext(rawBody)
    if (planningContext.invalidResponse) {
      return res.json(planningContext.invalidResponse)
    }
    if (planningContext.emptyResponse) {
      return res.json({
        ...buildCoveragePrecheckResponse(planningContext),
        status: 'ready',
        message: planningContext.emptyResponse.message
      })
    }

    return res.json(buildCoveragePrecheckResponse(planningContext))
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant le precontrole de faisabilite coverage.'
    })
  }
}

app.post('/api/tournees/coverage-capacity-precheck', handleCoverageCapacityPrecheck)
app.post('/api/tournees/coverage-plan/precheck', handleCoverageCapacityPrecheck)

app.get('/api/tournees/next-best-visits/readiness', async (req, res) => {
  const planningStartDate = String(req.query?.start_date || '').trim() || null
  const historicalCutoffDate = String(req.query?.historical_cutoff_date || '').trim() || null

  try {
    const readiness = await getNextBestVisitReadiness({
      queryAsync,
      withTransaction,
      planningStartDate,
      historicalCutoffDate,
      autoTriggerRebuild: true,
      logger: console
    })
    return res.json(readiness)
  } catch (error) {
    console.error('Erreur readiness next-best-visits:', error.message)
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant le readiness V2.'
    })
  }
})

app.post('/api/tournees/next-best-visits/readiness/retry', async (req, res) => {
  const planningStartDate = String(req.body?.start_date || '').trim() || null
  const historicalCutoffDate = String(req.body?.historical_cutoff_date || '').trim() || null

  try {
    const readiness = await getNextBestVisitReadiness({
      queryAsync,
      withTransaction,
      planningStartDate,
      historicalCutoffDate,
      autoTriggerRebuild: true,
      forceRetry: true,
      logger: console
    })
    return res.json(readiness)
  } catch (error) {
    console.error('Erreur retry readiness next-best-visits:', error.message)
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant la relance du readiness V2.'
    })
  }
})

app.get('/api/tournees/next-best-visits/visit-feedback', async (req, res) => {
  const plannedVisitIds = Array.isArray(req.query?.planned_visit_ids)
    ? req.query.planned_visit_ids
    : (req.query?.planned_visit_ids ?? req.query?.planned_visit_id ?? [])

  try {
    const records = await fetchSalesVisitFeedbackRecords(queryAsync, {
      plannedVisitIds
    })

    return res.json({
      status: 'success',
      records,
      records_by_planned_visit_id: records.reduce((accumulator, record) => {
        if (record?.planned_visit_id) {
          accumulator[record.planned_visit_id] = record
        }
        return accumulator
      }, {})
    })
  } catch (error) {
    console.error('Erreur lecture feedback next-best-visits:', error.message)
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant la lecture du feedback V2.'
    })
  }
})

app.post('/api/tournees/next-best-visits/validate', async (req, res) => {
  return handleNextBestVisitValidationRoute(req, res)
})

app.put('/api/tournees/next-best-visits/visit-feedback/:plannedVisitId', async (req, res) => {
  const plannedVisitId = String(req.params?.plannedVisitId || '').trim() || null
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {}

  try {
    const record = await upsertSalesVisitFeedback(queryAsync, rawBody, plannedVisitId, {
      updateOnly: true
    })
    return res.json({
      status: 'success',
      record
    })
  } catch (error) {
    const statusCode = error.statusCode || (/required|must be/i.test(String(error.message || '')) ? 400 : 500)
    console.error('Erreur ecriture feedback next-best-visits:', error.message)
    return res.status(statusCode).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant la sauvegarde du feedback V2.'
    })
  }
})

app.get('/api/tournees/next-best-visits/feedback/monitoring', async (req, res) => {
  try {
    const monitoring = await getSalesVisitFeedbackMonitoring(queryAsync, {
      start_date: req.query?.start_date,
      end_date: req.query?.end_date,
      commercial_codes: req.query?.commercial_codes
    })

    return res.json({
      status: 'success',
      ...monitoring
    })
  } catch (error) {
    const statusCode = /start_date|end_date/i.test(String(error.message || '')) ? 400 : 500
    console.error('Erreur monitoring feedback next-best-visits:', error.message)
    return res.status(statusCode).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant le monitoring V2.'
    })
  }
})

app.get('/api/tournees/next-best-visits/feedback/monitoring/details', async (req, res) => {
  try {
    const details = await getSalesVisitFeedbackMonitoringDetails(queryAsync, {
      start_date: req.query?.start_date,
      end_date: req.query?.end_date,
      commercial_codes: req.query?.commercial_codes
    })

    return res.json({
      status: 'success',
      ...details
    })
  } catch (error) {
    const statusCode = /start_date|end_date/i.test(String(error.message || '')) ? 400 : 500
    console.error('Erreur monitoring detail feedback next-best-visits:', error.message)
    return res.status(statusCode).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant le monitoring detail V2.'
    })
  }
})

app.get('/api/tournees/next-best-visits/learning/status', async (req, res) => {
  try {
    const status = await getSalesLearningStatus(queryAsync, {
      baseDir: __dirname,
      feedbackFilters: {
        start_date: req.query?.start_date,
        end_date: req.query?.end_date,
        commercial_codes: req.query?.commercial_codes
      }
    })

    return res.json({
      status: 'success',
      ...status
    })
  } catch (error) {
    const statusCode = /start_date|end_date/i.test(String(error.message || '')) ? 400 : 500
    console.error('Erreur statut learning next-best-visits:', error.message)
    return res.status(statusCode).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant le statut learning V2.'
    })
  }
})

app.post('/api/tournees/next-best-visits/learning/retrain-candidate', async (req, res) => {
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {}

  try {
    const result = await retrainSalesLearningCandidate({
      queryAsync,
      baseDir: __dirname,
      feedbackFilters: {
        start_date: rawBody.start_date,
        end_date: rawBody.end_date,
        commercial_codes: rawBody.commercial_codes
      }
    })

    return res.json(result)
  } catch (error) {
    const statusCode = /start_date|end_date/i.test(String(error.message || '')) ? 400 : 500
    console.error('Erreur retrain candidat next-best-visits:', error.message)
    return res.status(statusCode).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant le retrain candidat V2.'
    })
  }
})

app.post('/api/tournees/next-best-visits/learning/promote-candidate', async (req, res) => {
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {}

  try {
    const result = await promoteSalesLearningCandidate({
      queryAsync,
      baseDir: __dirname,
      candidateVersion: rawBody.candidate_version,
      reloadPredictionService: reloadIaModelsFromFlask,
      fetchPredictionServiceStatus: fetchIaModelStatusFromFlask,
      invalidateModelDependentCaches: invalidateSalesLearningModelDependentCaches
    })

    return res.json(result)
  } catch (error) {
    console.error('Erreur promotion candidat next-best-visits:', error.message)
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant la promotion du candidat V2.'
    })
  }
})

app.post('/api/tournees/next-best-visits/learning/rollback', async (req, res) => {
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {}

  try {
    const result = await rollbackSalesLearningModel({
      queryAsync,
      baseDir: __dirname,
      rollbackTargetVersion: rawBody.model_version,
      reloadPredictionService: reloadIaModelsFromFlask,
      fetchPredictionServiceStatus: fetchIaModelStatusFromFlask,
      invalidateModelDependentCaches: invalidateSalesLearningModelDependentCaches
    })

    return res.json(result)
  } catch (error) {
    console.error('Erreur rollback modele next-best-visits:', error.message)
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant le rollback du modele V2.'
    })
  }
})

app.post('/api/tournees/next-best-visits/learning/run-cycle', async (req, res) => {
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {}

  try {
    const result = await runAutomaticSalesLearningCycle({
      force: Boolean(rawBody.force),
      trigger: Boolean(rawBody.force) ? 'manual_retry' : 'manual_check'
    })

    return res.json(result)
  } catch (error) {
    console.error('Erreur cycle automatique learning next-best-visits:', error.message)
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant le cycle learning V2.'
    })
  }
})

async function handleNextBestVisitRoute(req, res, dependencyOverrides = {}) {
  const httpStartedAt = Date.now()
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {}
  const generateNextBestVisitPlanImpl = typeof dependencyOverrides.generateNextBestVisitPlan === 'function'
    ? dependencyOverrides.generateNextBestVisitPlan
    : generateNextBestVisitPlan
  const validateNextBestVisitHttpRequestImpl = typeof dependencyOverrides.validateNextBestVisitHttpRequest === 'function'
    ? dependencyOverrides.validateNextBestVisitHttpRequest
    : validateNextBestVisitHttpRequest
  const fetchCommercialOptionsImpl = typeof dependencyOverrides.fetchCommercialOptions === 'function'
    ? dependencyOverrides.fetchCommercialOptions
    : fetchCommercialOptions
  const todayIso = String(
    dependencyOverrides.todayIso ||
    req?.app?.locals?.todayIsoForTests ||
    formatLocalDate(new Date())
  ).trim()

  try {
    const validation = await validateNextBestVisitHttpRequestImpl(rawBody, {
      fetchCommercialOptions: fetchCommercialOptionsImpl,
      todayIso
    })

    if (!validation.valid) {
      return res.status(400).json({
        status: 'invalid_parameters',
        message: validation.message
      })
    }

    const payload = await generateNextBestVisitPlanImpl(validation.normalizedBody, {
      fetchCommercialOptions: fetchCommercialOptionsImpl,
      fetchCoverageActiveClients,
      loadCoverageConstraints: async params => loadCoverageConstraints(params, {
        queryAsync,
        database: DB_CONFIG.database
      }),
      fetchAiPredictionsForClientBatch,
      queryAsync,
      withTransaction,
      sharedDepotOrigin: SHARED_DEPOT_ORIGIN
    })

    const performance = payload?.meta?.performance && typeof payload.meta.performance === 'object'
      ? payload.meta.performance
      : { stages: [] }
    const stages = [
      ...(Array.isArray(performance.stages) ? performance.stages : []),
      {
        stage: 'total_http',
        duration_ms: Math.max(0, Date.now() - httpStartedAt)
      }
    ]
    const excludedFromCoverage = new Set(['total_service', 'total_http', 'load_or_build_cadence_profiles'])
    const totalHttpMs = stages
      .filter(stage => stage.stage === 'total_http')
      .reduce((sum, stage) => sum + Math.max(0, Math.round(Number(stage.duration_ms || 0))), 0)
    const explainedMs = stages
      .filter(stage => !excludedFromCoverage.has(stage.stage))
      .reduce((sum, stage) => sum + Math.max(0, Math.round(Number(stage.duration_ms || 0))), 0)
    const boundedExplainedMs = totalHttpMs > 0 ? Math.min(explainedMs, totalHttpMs) : explainedMs
    const responsePayload = {
      ...payload,
      meta: {
        ...(payload?.meta && typeof payload.meta === 'object' ? payload.meta : {}),
        performance: {
          ...performance,
          stages,
          unaccounted_time_ms: totalHttpMs > 0 ? Math.max(0, totalHttpMs - boundedExplainedMs) : 0,
          timing_coverage_rate: totalHttpMs > 0 ? Math.round((boundedExplainedMs / totalHttpMs) * 1000) / 10 : null
        }
      }
    }

    if (String(responsePayload?.status || '').startsWith('profile_snapshot_')) {
      return res.status(409).json(responsePayload)
    }

    if (String(responsePayload?.status || '').trim() === 'invalid_parameters') {
      return res.status(400).json(responsePayload)
    }

    return res.json(responsePayload)
  } catch (error) {
    console.error('Erreur V2 next-best-visits:', error.message)
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant la generation V2.'
    })
  }
}

app.post('/api/tournees/next-best-visits', async (req, res) => {
  return handleNextBestVisitRoute(req, res)
})

registerNextBestVisitValidationLabRoutes(app, {
  env: process.env
})

app.post('/api/tournees/coverage-plan/analyze', async (req, res) => {
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {}

  try {
    const planningContext = await buildCoveragePlanningContext(rawBody)
    if (planningContext.invalidResponse) {
      return res.json(planningContext.invalidResponse)
    }
    if (planningContext.emptyResponse) {
      return res.json({
        status: 'feasible',
        analysis: {
          clients_to_cover: 0,
          selected_commercials_count: planningContext.selectedCommercials.length,
          active_days_count: planningContext.activeDaysCount,
          theoretical_total_slots: planningContext.theoreticalTotalSlots,
          total_slots: planningContext.totalSlots,
          capacity_total: planningContext.totalConfiguredCapacity,
          required_average_per_slot: 0,
          user_max_capacity: planningContext.requestedUserMaxVisits,
          adjusted_target_max_capacity: planningContext.adjustedTargetMaxVisitsPerSlot,
          hard_physical_max_capacity: planningContext.maxHardPhysicalMaxVisitsPerSlot || null,
          recommended_max_capacity: planningContext.recommendedMaxVisitsPerSlot,
          resolved_max_capacity: planningContext.resolvedMaxVisitsPerSlot,
          capacity_mode: planningContext.capacityMode || COVERAGE_CAPACITY_MODE_UNKNOWN,
          operational_capacity_known: Boolean(planningContext.operationalCapacityKnown),
          sales_activity_proxy_total: Number(planningContext.salesActivityProxyTotal || 0),
          estimated_extra_commercial_days: null,
          manual_capacity_override: planningContext.requestedManualMaxVisits !== null,
          unavailable_slots_removed: Math.max(0, planningContext.theoreticalTotalSlots - planningContext.totalSlots),
          operational_status: 'unknown',
          operational_status_label: 'Capacite terrain non mesuree',
          status_label: 'capacite_terrain_non_mesuree',
          blocking_reasons: []
        },
        request_context: planningContext.emptyResponse.request_context,
        message: 'Aucun client actif a couvrir sur la periode analysee.'
      })
    }

    const analysisPayload = {
      ...planningContext.optimizerPayload,
      strict_ca: planningContext.strictCa || planningContext.minDailyCaPerCommercial > 0
    }
    const analysisResponse = await fetchOrToolsCoverageAnalysis(analysisPayload)
    const analysisResult = analysisResponse?.data && typeof analysisResponse.data === 'object'
      ? analysisResponse.data
      : {}
    const blockingReasons = buildCoverageBlockingReasons({
      analysisResult,
      planningContext
    })
    const adjustedMessage = 'Certains parametres ont ete ajustes afin d assurer la meilleure couverture possible.'
    const operational = analysisResult.operational && typeof analysisResult.operational === 'object'
      ? analysisResult.operational
      : {}
    const capacityMode = String(
      operational.capacity_mode ||
      planningContext.capacityMode ||
      COVERAGE_CAPACITY_MODE_UNKNOWN
    ).trim() || COVERAGE_CAPACITY_MODE_UNKNOWN
    const operationalCapacityKnown = Boolean(
      operational.operational_capacity_known ??
      planningContext.operationalCapacityKnown
    )
    const operationalMessage = !operationalCapacityKnown && capacityMode === COVERAGE_CAPACITY_MODE_SALES_PROXY
      ? 'Le plan couvre les clients et repartit la charge selon l activite de vente historique. La faisabilite terrain reste a confirmer, car les visites reelles, les durees et les temps de trajet ne sont pas encore mesures.'
      : (
        operational.status === 'under_tension' || operational.status === 'critical_overload'
      )
        ? 'La couverture complete necessite une charge superieure aux capacites historiques. Consultez les commerciaux surcharges ou augmentez la periode / les ressources.'
        : null

    return res.json({
      status: analysisResult.status || 'error',
      analysis: {
        clients_to_cover: Number(analysisResult?.feasibility?.clients_to_cover || 0),
        selected_commercials_count: planningContext.selectedCommercials.length,
        selected_clients_count: planningContext.selectedClientsCount || 0,
        active_days_count: planningContext.activeDaysCount,
        theoretical_total_slots: planningContext.theoreticalTotalSlots,
        total_slots: planningContext.totalSlots,
        capacity_total: planningContext.totalConfiguredCapacity,
        required_average_per_slot: Number(analysisResult?.feasibility?.required_average_per_slot || 0),
        user_max_capacity: planningContext.requestedUserMaxVisits,
        adjusted_target_max_capacity: planningContext.adjustedTargetMaxVisitsPerSlot,
        hard_physical_max_capacity: planningContext.maxHardPhysicalMaxVisitsPerSlot || null,
        recommended_max_capacity: planningContext.recommendedMaxVisitsPerSlot,
        resolved_max_capacity: planningContext.resolvedMaxVisitsPerSlot,
        capacity_mode: capacityMode,
        operational_capacity_known: operationalCapacityKnown,
        sales_activity_proxy_total: Number(operational.sales_activity_proxy_total || 0),
        required_to_sales_proxy_ratio: Number(operational.required_to_sales_proxy_ratio || 0),
        total_historical_capacity: Number(operational.total_historical_capacity || 0),
        total_required_clients: Number(operational.total_required_clients || 0),
        operational_capacity_gap: Number(operational.operational_capacity_gap || 0),
        required_capacity_multiplier: Number(operational.required_capacity_multiplier || 0),
        estimated_extra_slots_needed: operational.estimated_extra_slots_needed == null ? null : Number(operational.estimated_extra_slots_needed || 0),
        estimated_extra_commercial_days: operational.estimated_extra_commercial_days == null ? null : Number(operational.estimated_extra_commercial_days || 0),
        estimated_extra_commercial_days_needed: operational.estimated_extra_commercial_days == null ? null : Number(operational.estimated_extra_commercial_days || 0),
        operational_status: String(operational.status || 'unknown'),
        operational_status_label: String(operational.status_label || 'Capacite terrain non mesuree'),
        manual_capacity_override: planningContext.requestedManualMaxVisits !== null,
        unavailable_slots_removed: Math.max(0, planningContext.theoreticalTotalSlots - planningContext.totalSlots),
        status_label: !operationalCapacityKnown && capacityMode === COVERAGE_CAPACITY_MODE_SALES_PROXY
          ? 'capacite_terrain_non_mesuree'
          : analysisResult.status === 'feasible'
          ? String(operational.status_label || 'realisable_theoriquement').replaceAll(' ', '_').toLowerCase()
          : 'physiquement_impossible',
        blocking_reasons: blockingReasons,
        strict_ca_enabled: planningContext.strictCa
      },
      operational,
      request_context: buildCoverageRequestContext(planningContext, analysisPayload.strict_ca),
      message: blockingReasons.length
        ? blockingReasons.map(item => item.title).join(' - ')
        : operationalMessage
          ? operationalMessage
        : hasCoverageAdjustedParameters(planningContext)
          ? adjustedMessage
          : 'La configuration est realisable avec la capacite ajustee.'
    })
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant l analyse de faisabilite coverage.'
    })
  }
})

app.get('/api/tournees/coverage-constraints/diagnostic', async (req, res) => {
  try {
    const rawInput = buildCoveragePlanInputFromQuery(req.query || {})
    const todayIso = formatLocalDate(new Date())
    const startDate = normalizeDateOnly(rawInput.start_date || rawInput.planning_start_date) || todayIso
    const planningDays = Math.max(1, Math.min(60, Number.parseInt(rawInput.planning_horizon_days ?? rawInput.period_days ?? rawInput.planning_days, 10) || 14))
    const workingDaySelection = parseWorkingDaySelection(rawInput.working_days)
    const planningDaysList = buildWorkingDays(startDate, planningDays)
      .filter(day => workingDaySelection.includes(day.dayIndex))

    if (!planningDaysList.length) {
      return res.status(400).json({
        error: 'Aucun jour travaille n est selectionne sur la periode demandee.'
      })
    }

    const allCommercials = await fetchCommercialOptions()
    const selectedCommercialCodes = parseCommercialSelection(rawInput.commercials)
    const selectedCommercials = selectedCommercialCodes.length
      ? allCommercials.filter(item => selectedCommercialCodes.includes(item.value))
      : allCommercials
    const allCommercialsSelected = (
      allCommercials.length > 0 &&
      selectedCommercials.length === allCommercials.length
    )

    if (!selectedCommercials.length) {
      return res.status(400).json({
        error: 'Aucun commercial actif disponible pour le diagnostic coverage.'
      })
    }

    const selectedClientIds = parseClientSelection(rawInput.clients ?? rawInput.client_ids ?? rawInput.client_codes)
    const clientIds = await fetchCoverageConstraintClientIds({
      selectedCommercialCodes: selectedCommercials.map(item => item.value),
      selectedClientIds,
      allCommercialsSelected
    })
    const endDate = planningDaysList[planningDaysList.length - 1]?.date || startDate
    const coverageConstraints = await loadCoverageConstraints({
      startDate,
      endDate,
      commercialCodes: selectedCommercials.map(item => item.value),
      clientIds
    }, {
      queryAsync,
      database: DB_CONFIG.database
    })

    return res.json(
      buildCoverageConstraintsDiagnosticResponse(coverageConstraints, {
        startDate,
        endDate,
        commercialsChecked: selectedCommercials.length,
        clientsChecked: clientIds.length
      })
    )
  } catch (error) {
    return res.status(500).json({
      error: error.message || 'Erreur inattendue pendant le diagnostic des contraintes coverage.'
    })
  }
})

app.post('/api/tournees/coverage-plan', async (req, res) => {
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {}

  try {
    const result = await generateCoveragePlanResponse(rawBody)
    return res.status(result.statusCode || 200).json(result.payload)
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur inattendue pendant la generation du plan de couverture.'
    })
  }
})

app.get('/api/tournees/coverage-plan', async (req, res) => {
  try {
    const proxyResponse = await axios.post(
      `http://127.0.0.1:${PORT}/api/tournees/coverage-plan`,
      buildCoveragePlanInputFromQuery(req.query),
      {
        timeout: 300000,
        headers: {
          'x-internal-coverage-proxy': '1'
        }
      }
    )
    return res.status(proxyResponse.status).json(proxyResponse.data)
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status || 500).json(error.response.data)
    }
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Erreur interne pendant le proxy coverage GET -> POST.'
    })
  }
})

const FUTURE_SALES_AI_UNAVAILABLE_MESSAGE = "Le plan de vente future est indisponible car le moteur IA n'a pas pu calculer les predictions."
const FUTURE_SALES_AI_TRANSPORT_MESSAGE = "Le plan de vente future est indisponible car le moteur IA est temporairement injoignable. Reessayez dans quelques instants."

function buildFutureSalesAiUnavailableMessage(aiPayload = null) {
  const upstreamMessage = typeof aiPayload?.message === 'string'
    ? aiPayload.message.trim()
    : ''

  if (upstreamMessage) {
    return `${FUTURE_SALES_AI_UNAVAILABLE_MESSAGE} ${upstreamMessage}`
  }

  return FUTURE_SALES_AI_UNAVAILABLE_MESSAGE
}

function buildFutureSalesAiUnavailableResponse(aiPayload = null) {
  const predictionRunCode = typeof aiPayload?.prediction_run_code === 'string' && aiPayload.prediction_run_code.trim()
    ? aiPayload.prediction_run_code.trim()
    : null
  const body = {
    status: 'error',
    message: buildFutureSalesAiUnavailableMessage(aiPayload)
  }

  if (predictionRunCode) {
    body.prediction_run_code = predictionRunCode
  }

  return {
    ok: false,
    statusCode: 503,
    body
  }
}

function buildFutureSalesAiTransportFailureResponse() {
  return {
    ok: false,
    statusCode: 503,
    body: {
      status: 'error',
      message: FUTURE_SALES_AI_TRANSPORT_MESSAGE
    }
  }
}

function normalizePredictionBasketProducts(rawDetails) {
  if (!rawDetails || typeof rawDetails !== 'object' || Array.isArray(rawDetails)) {
    return []
  }

  return Object.entries(rawDetails)
    .map(([nom, quantite]) => {
      const normalizedName = String(nom || '').trim()
      const normalizedQuantity = roundScore(Number(quantite || 0))
      if (!normalizedName || !Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
        return null
      }
      return {
        nom: normalizedName,
        quantite: normalizedQuantity
      }
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.quantite || 0) - Number(a.quantite || 0))
}

function buildSalesPredictionBasket(rawPrediction = null) {
  const produits = normalizePredictionBasketProducts(rawPrediction?.details)
  const totalQuantity = roundScore(
    produits.reduce((sum, produit) => sum + Number(produit.quantite || 0), 0)
  )

  return {
    produits,
    totalQuantity,
    details: Object.fromEntries(
      produits.map(produit => [produit.nom, produit.quantite])
    )
  }
}

function normalizeLoggedSalesPredictionEntry(rawPrediction = null) {
  if (!rawPrediction || typeof rawPrediction !== 'object' || Array.isArray(rawPrediction)) {
    return null
  }

  const basket = buildSalesPredictionBasket(rawPrediction)
  return {
    ...rawPrediction,
    qte: basket.totalQuantity,
    details: basket.details
  }
}

function normalizeLoggedSalesPredictions(predictions) {
  if (!predictions || typeof predictions !== 'object' || Array.isArray(predictions)) {
    return {}
  }

  return Object.entries(predictions).reduce((accumulator, [clientCode, rawPrediction]) => {
    const normalizedClientCode = String(clientCode || '').trim()
    const normalizedPrediction = normalizeLoggedSalesPredictionEntry(rawPrediction)
    if (normalizedClientCode && normalizedPrediction) {
      accumulator[normalizedClientCode] = normalizedPrediction
    }
    return accumulator
  }, {})
}

function normalizeFutureSalesAiResult(aiResponse) {
  const payload = aiResponse?.data ?? null

  if (!payload || payload.status !== 'success') {
    return buildFutureSalesAiUnavailableResponse(payload)
  }

  const predictions = payload.predictions && typeof payload.predictions === 'object' && !Array.isArray(payload.predictions)
    ? normalizeLoggedSalesPredictions(payload.predictions)
    : {}

  return {
    ok: true,
    predictions,
    predictionRunCode: typeof payload.prediction_run_code === 'string' && payload.prediction_run_code.trim()
      ? payload.prediction_run_code.trim()
      : null
  }
}

app.get('/api/tournees/plan', async (req, res) => {
  const date_precise = req.query.date_precise || new Date().toISOString().split('T')[0]
  const date_debut = req.query.date_debut
  const date_fin = req.query.date_fin
  const commercial = req.query.commercial
  const route = req.query.route
  const modeTournee = req.query.mode_tournee === 'recouvrement' ? 'recouvrement' : 'vente'
  const parsedTopClients = parseInt(req.query.top_clients, 10)
  const topClients = Number.isFinite(parsedTopClients) && parsedTopClients > 0
    ? Math.max(1, parsedTopClients)
    : null
  const targetChiffre = Math.max(0, parseFloat(req.query.target_chiffre || '0') || 0)

  const useRange = Boolean(date_debut && date_fin)
  const dateReference = useRange ? date_fin : date_precise
  const datePrediction = useRange ? date_debut : date_precise

  if (shouldRejectPastSalesPlanRequest({
    modeTournee,
    datePrecise: date_precise,
    dateDebut: date_debut,
    dateFin: date_fin
  })) {
    return res.status(400).json({
      status: 'error',
      message: getPastSalesPlanMessage()
    })
  }

  const requestDate = new Date(dateReference)
  requestDate.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const isPast = requestDate < today
  const depotOrigin = await resolveDepotOrigin(route, commercial)

  let sqlClients = `
    SELECT
      c.id AS client_id,
      c.code AS nbr_client,
      CAST(COALESCE(c.plafond_credit, '0') AS DECIMAL(15,3)) AS plafond,
      CAST(COALESCE(c.encours_actuelement, '0') AS DECIMAL(15,3)) AS encours_credit,
      CAST(COALESCE(c.delai_paiement, '0') AS DECIMAL(15,3)) AS delai_paiement,
      c.potentiel,
      ? AS date_jour, CONCAT('Comm ', COALESCE(c.user_code, '-'), ' - ', COALESCE(c.delegation, 'Zone inconnue')) AS commercia_zone,
      COALESCE(c.region, 'Non Definie') AS region,
      (CASE WHEN CAST(COALESCE(c.encours_actuelement, '0') AS DECIMAL) > 0 THEN 1 ELSE 0 END) AS recouvrement_reel,
      c.nom, c.adresse_facturation AS adresse,
      c.latitude AS latitude, c.longitude AS longitude
    FROM clients c
    WHERE c.deleted_at IS NULL AND c.isactif = '1'
  `
  const params = [dateReference]
  if (route) { sqlClients += ' AND c.routing_code = ?'; params.push(route) }
  if (commercial) { sqlClients += ' AND c.user_code = ?'; params.push(commercial) }

  queryDb(sqlClients, params, async (err, clients) => {
    if (err) return res.status(500).json({ error: err.message })
    const { distanceMap, maxDistance } = buildDistanceMap(clients)

    let totalChiffre = 0
    let iaAgro = 0
    let iaChips = 0
    let iaBur = 0
    let tourneesFormattees = []

    if (modeTournee === 'recouvrement') {
      try {
        const recoveryProfiles = await loadRecoveryProfiles({
          clientIds: clients.map(clientRow => clientRow.client_id),
          referenceDate: dateReference,
          connection: null,
          queryRows: buildCoverageRecoveryQueryRows(queryAsync),
          clientRows: clients,
          logger: console
        })

        const recoveryBuild = buildRecoveryPlanRowsFromProfiles({
          profiles: recoveryProfiles,
          clients,
          distanceMap,
          maxDistanceKm: maxDistance
        })

        tourneesFormattees = recoveryBuild.rows

        const recoverySelection = splitClientObjective(tourneesFormattees, topClients, targetChiffre)
        tourneesFormattees = recoverySelection.selected
        return envoyerReponse(res, tourneesFormattees, dateReference, 0, 0, 0, depotOrigin, {
          mode: modeTournee,
          recovery_filter_mode: recoveryBuild.recoveryFilterMode,
          suggestions_ajout: recoverySelection.suggestions
        })
      } catch (errRecouvrement) {
        return res.status(500).json({ error: errRecouvrement.message })
      }
    }

    if (isPast) {
      let aiPredictions = {}
      let predictionRunCode = null
      try {
        const { response: aiResponse, loggingResult } = await fetchLoggedAiPredictions(
          { date: datePrediction },
          {
            sourceContext: 'tournees_plan_past',
            sourceMode: modeTournee,
            requestRouteCode: route || null,
            requestCommercialCode: commercial || null,
            requestTopClients: topClients,
            requestTargetChiffre: targetChiffre,
            requestContext: {
              date_reference: dateReference,
              date_prediction: datePrediction,
              use_range: useRange,
              route_code: route || null,
              commercial_code: commercial || null
            }
          }
        )
        predictionRunCode = aiResponse.data?.prediction_run_code || loggingResult?.runCode || null
        if (aiResponse.data.status === 'success') {
          aiPredictions = normalizeLoggedSalesPredictions(aiResponse.data.predictions)
        }
      } catch (error) {
        console.error('Serveur Python injoignable, backtesting sans IA')
      }

      const sqlReel = `
        SELECT
          e.client_code,
          e.code AS doc_code,
          e.net_a_payer,
          COALESCE(p.sousfamille_code, 'Divers') AS produit_nom,
          p.famille_code AS famille_code,
          SUM(l.quantite) AS qte_ligne
        FROM entetecommercials e
        LEFT JOIN lignecommercials l ON e.code = l.entetecommercial_code
        LEFT JOIN produits p ON l.produit_code = p.code
        WHERE DATE(e.date) ${useRange ? 'BETWEEN ? AND ?' : '= ?'} AND e.type IN ('facture', 'bl', 'blf')
        GROUP BY e.client_code, e.code, e.net_a_payer, p.sousfamille_code, p.famille_code
      `

      queryDb(sqlReel, useRange ? [date_debut, date_fin] : [date_precise], (errVentes, ventes) => {
        if (errVentes) return res.status(500).json({ error: errVentes.message })

        const ventesMap = {}
        iaAgro = 0
        iaChips = 0
        iaBur = 0

        ventes.forEach(v => {
          if (!ventesMap[v.client_code]) {
            ventesMap[v.client_code] = {
              chiffre: 0,
              qte: 0,
              docs: new Set(),
              details: { agro: 0, chips: 0, bur: 0 },
              produitsMap: {}
            }
          }

          const cMap = ventesMap[v.client_code]
          if (!cMap.docs.has(v.doc_code)) {
            cMap.chiffre += v.net_a_payer
            cMap.docs.add(v.doc_code)
          }

          const qteLigne = v.qte_ligne || 0
          cMap.qte += qteLigne

          if (v.produit_nom) {
            if (!cMap.produitsMap[v.produit_nom]) {
              cMap.produitsMap[v.produit_nom] = 0
            }
            cMap.produitsMap[v.produit_nom] += qteLigne
          }

          const famille = (v.famille_code || '').toUpperCase()
          if (famille.includes('CHIPS') || famille.includes('SNACK') || famille.includes('CHAMALLOWS') || famille.includes('BISCUIT')) {
            cMap.details.chips += qteLigne
            iaChips += qteLigne
          } else if (famille.includes('BUR') || famille.includes('PAPIER')) {
            cMap.details.bur += qteLigne
            iaBur += qteLigne
          } else {
            cMap.details.agro += qteLigne
            iaAgro += qteLigne
          }
        })

        const maxPredPast = clients.reduce((max, c) => {
          const clientCodeStr = String(c.nbr_client || '').trim()
          const iaData = aiPredictions[clientCodeStr]
          const scoreValue = iaData ? iaData.chiffre : (ventesMap[c.nbr_client] ? ventesMap[c.nbr_client].chiffre : 0)
          return Math.max(max, scoreValue || 0)
        }, 0)

        tourneesFormattees = clients.map(c => {
          const dataReelle = ventesMap[c.nbr_client]
          if (!dataReelle) return null

          const chiffreReel = dataReelle.chiffre
          const qte = dataReelle.qte
          const details = dataReelle.details

          const produitsReels = Object.entries(dataReelle.produitsMap || {})
            .map(([nom, quantite]) => ({ nom, quantite }))
            .sort((a, b) => b.quantite - a.quantite)

          const clientCodeStr = String(c.nbr_client || '').trim()
          const iaData = aiPredictions[clientCodeStr]
          const predictionBasket = buildSalesPredictionBasket(iaData)
          const hasValidPredictionBasket = predictionBasket.totalQuantity > 0
          if (iaData && !hasValidPredictionBasket) return null
          const chiffrePred = iaData ? iaData.chiffre : chiffreReel
          const probAchat = iaData ? (iaData.prob_achat || 0) : 0
          const habitScore = iaData ? (iaData.habit_score || 0) : 0
          const recencyScore = iaData ? (iaData.recency_score || 0) : 0
          const distanceKm = distanceMap.get(String(c.nbr_client)) || 0
          const finalScore = computePriorityScore(chiffrePred, maxPredPast, probAchat, habitScore, recencyScore, distanceKm, maxDistance)

          let produitsAAfficher = produitsReels
          if (iaData) {
            produitsAAfficher = predictionBasket.produits
          }

          totalChiffre += chiffreReel

          return {
            client_id: c.client_id,
            nbr_client: c.nbr_client,
            chiffre: `${chiffrePred.toFixed(1)} TND`,
            chiffre_brut: chiffrePred,
            vente_reelle: chiffreReel,
            score_ia: finalScore,
            qte_reco: iaData ? predictionBasket.totalQuantity : qte,
            details,
            produits: produitsAAfficher,
            prob_achat: probAchat,
            habit_score: habitScore,
            recency_score: recencyScore,
            distance_km: roundScore(distanceKm),
            date_jour: c.date_jour,
            commercia_zone: c.commercia_zone,
            region: c.region === 'GT' ? 'Grand Tunis' : c.region,
            recouvrement: c.recouvrement_reel,
            nom: `${c.nom} (Reel)`,
            adresse: c.adresse || 'Adresse non specifiee',
            latitude: c.latitude,
            longitude: c.longitude,
            canonical_client_key: getClientUniqueKey(c) || getCanonicalClientKey(c.nbr_client)
          }
        }).filter(Boolean).sort((a, b) => b.score_ia - a.score_ia)

        const pastSelection = splitClientObjective(tourneesFormattees, topClients, targetChiffre)
        tourneesFormattees = pastSelection.selected

        envoyerReponse(res, tourneesFormattees, dateReference, iaAgro, iaChips, iaBur, depotOrigin, {
          mode: modeTournee,
          suggestions_ajout: pastSelection.suggestions,
          prediction_run_code: predictionRunCode
        })
      })
    } else {
      let aiPredictions = {}
      let predictionRunCode = null
      try {
        const { response: aiResponse, loggingResult } = await fetchLoggedAiPredictions(
          { date: datePrediction },
          {
            sourceContext: 'tournees_plan_future',
            sourceMode: modeTournee,
            requestRouteCode: route || null,
            requestCommercialCode: commercial || null,
            requestTopClients: topClients,
            requestTargetChiffre: targetChiffre,
            requestContext: {
              date_reference: dateReference,
              date_prediction: datePrediction,
              use_range: useRange,
              route_code: route || null,
              commercial_code: commercial || null
            }
          }
        )
        const normalizedAiResult = normalizeFutureSalesAiResult(aiResponse)
        predictionRunCode = normalizedAiResult.predictionRunCode || loggingResult?.runCode || null

        if (!normalizedAiResult.ok) {
          if (predictionRunCode && !normalizedAiResult.body.prediction_run_code) {
            normalizedAiResult.body.prediction_run_code = predictionRunCode
          }
          return res.status(normalizedAiResult.statusCode).json(normalizedAiResult.body)
        }

        aiPredictions = normalizedAiResult.predictions
      } catch (error) {
        console.error('Serveur Python (api_ia.py) injoignable.', error)
        const transportFailure = buildFutureSalesAiTransportFailureResponse()
        return res.status(transportFailure.statusCode).json(transportFailure.body)
      }

      const maxPredFuture = clients.reduce((max, c) => {
        const clientCodeStr = String(c.nbr_client || '').trim()
        const iaData = aiPredictions[clientCodeStr]
        return Math.max(max, iaData ? (iaData.chiffre || 0) : 0)
      }, 0)

      const tousLesClients = clients.map(c => {
        const clientCodeStr = String(c.nbr_client || '').trim()
        const iaData = aiPredictions[clientCodeStr]
        const predictionBasket = buildSalesPredictionBasket(iaData)

        const probAchat = iaData ? (iaData.prob_achat || 0) : 0
        const habitScore = iaData ? (iaData.habit_score || 0) : 0
        const recencyScore = iaData ? (iaData.recency_score || 0) : 0
        const qteRecoIA = iaData ? predictionBasket.totalQuantity : 0
        const vnPreditIA = iaData ? iaData.chiffre : 0
        const caIfBuyIA = iaData ? (iaData.ca_if_buy || 0) : 0
        const distanceKm = distanceMap.get(String(c.nbr_client)) || 0
        const scoreIA = iaData ? computePriorityScore(vnPreditIA, maxPredFuture, probAchat, habitScore, recencyScore, distanceKm, maxDistance) : 0
        const hasValidPredictionBasket = iaData ? predictionBasket.totalQuantity > 0 : false
        const isViable = iaData
          ? (hasValidPredictionBasket && (probAchat >= 8 || vnPreditIA >= 8 || caIfBuyIA >= 35 || qteRecoIA >= 1))
          : false

        let produits = predictionBasket.produits
        let clientAgro = 0
        let clientChips = 0
        let clientBur = 0

        if (iaData && hasValidPredictionBasket) {
          clientAgro = Math.floor(qteRecoIA * 0.45)
          clientChips = Math.floor(qteRecoIA * 0.35)
          clientBur = Math.floor(qteRecoIA * 0.20)
          const sommeDetails = clientAgro + clientChips + clientBur
          if (sommeDetails < qteRecoIA) clientAgro += (qteRecoIA - sommeDetails)
          else if (sommeDetails > qteRecoIA && clientAgro > 0) clientAgro -= (sommeDetails - qteRecoIA)
        } else {
          clientAgro = Math.floor(qteRecoIA * 0.45)
          clientChips = Math.floor(qteRecoIA * 0.35)
          clientBur = Math.floor(qteRecoIA * 0.20)
        }

        return {
          client_id: c.client_id,
          nbr_client: c.nbr_client,
          chiffre_brut: vnPreditIA,
          chiffre: `${vnPreditIA.toFixed(1)} TND`,
          vente_reelle: 0,
          score_ia: scoreIA,
          qte_reco: qteRecoIA,
          details: { agro: clientAgro, chips: clientChips, bur: clientBur },
          produits,
          prob_achat: probAchat,
          ca_if_buy: caIfBuyIA,
          habit_score: habitScore,
          recency_score: recencyScore,
          distance_km: roundScore(distanceKm),
          date_jour: c.date_jour,
          commercia_zone: c.commercia_zone,
          region: c.region === 'GT' ? 'Grand Tunis' : c.region,
          recouvrement: c.recouvrement_reel,
          nom: c.nom,
          adresse: c.adresse || 'Adresse non specifiee',
          latitude: c.latitude,
          longitude: c.longitude,
          is_viable: isViable,
          canonical_client_key: getClientUniqueKey(c) || getCanonicalClientKey(c.nbr_client)
        }
      }).filter(t => t.chiffre_brut > 0 && t.qte_reco > 0 && t.is_viable)

      tourneesFormattees = tousLesClients
        .sort((a, b) => b.score_ia - a.score_ia)

      const futureSelection = splitClientObjective(tourneesFormattees, topClients, targetChiffre)
      tourneesFormattees = futureSelection.selected

      iaAgro = 0
      iaChips = 0
      iaBur = 0
      totalChiffre = 0

      tourneesFormattees.forEach(t => {
        totalChiffre += t.chiffre_brut
        iaAgro += t.details.agro
        iaChips += t.details.chips
        iaBur += t.details.bur
      })

      envoyerReponse(res, tourneesFormattees, dateReference, iaAgro, iaChips, iaBur, depotOrigin, {
        mode: modeTournee,
        suggestions_ajout: futureSelection.suggestions,
        prediction_run_code: predictionRunCode
      })
    }
  })
})

function envoyerReponse(res, tournees, date_precise, agro, chips, bur, depotOrigin, extra = {}) {
  const produitsTotaux = {}
  tournees.forEach(t => {
    if (t.produits && t.produits.length > 0) {
      t.produits.forEach(p => {
        if (!produitsTotaux[p.nom]) {
          produitsTotaux[p.nom] = 0
        }
        produitsTotaux[p.nom] += p.quantite
      })
    }
  })

  const produitsMappes = Object.entries(produitsTotaux)
    .map(([nom, quantite]) => ({ nom, quantite }))
    .sort((a, b) => b.quantite - a.quantite)

  const chargeTotale = {
    agro,
    chips,
    bureautique: bur,
    detailsProduits: produitsMappes
  }

  const vraiePrecision = readCurrentIaPrecisionScore()

  const itineraire = tournees.map((r, idx) => `${idx + 1}. ${r.nom} (${r.nbr_client}) - ${r.adresse || 'Adresse non specifiee'}`)
  const itineraire_geo = tournees.map((r, idx) => ({
    step: idx + 1,
    client_id: r.client_id ?? null,
    client_code: r.nbr_client,
    nom: r.nom,
    adresse: r.adresse || 'Adresse non specifiee',
    latitude: r.latitude !== undefined && r.latitude !== null ? Number(r.latitude) : null,
    longitude: r.longitude !== undefined && r.longitude !== null ? Number(r.longitude) : null,
    score_ia: r.score_ia,
    qte_reco: r.qte_reco
  }))

  res.json({
    tournees,
    total: tournees.length,
    jourSelectionne: date_precise,
    chargeTotale,
    precision_ia: vraiePrecision,
    itineraire,
    itineraire_geo,
    depot_origin: depotOrigin,
    ...extra
  })
}

const PORT = process.env.PORT || 5000

module.exports = {
  app,
  __testables: {
    buildCoverageCapacityPrecheckContext,
    buildCoverageCapacityPrecheck,
    buildCoveragePlanningContext,
    buildCoveragePrecheckResponse,
    validateNextBestVisitHttpRequest,
    validateNextBestVisitBlockPlan,
    handleNextBestVisitRoute,
    handleNextBestVisitValidationRoute,
    fetchAiPredictionsForClientBatch,
    generateNextBestVisitPlan,
    resolveCoverageClientScope,
    countCoverageActiveClientsLight,
    buildCoveragePurchaseCacheKey,
    buildCoverageRecoveryQueryRows,
    buildCoverageRecoveryPayloadFields,
    buildCoverageRequestContext,
    buildCanonicalCoverageFunctionalSnapshot,
    computeStableObjectHash,
    computeCoverageFunctionalResultHash,
    decorateCoverageBlocks,
    decorateCoverageSummary,
    buildSalesV2ValidationSeeds,
    fetchCommercialOptions,
    fetchCoverageActiveClients,
    fetchLoggedAiPredictions,
    normalizeFutureSalesAiResult,
    buildFutureSalesAiTransportFailureResponse,
    buildSalesPredictionBasket,
    normalizeLoggedSalesPredictionEntry,
    normalizeLoggedSalesPredictions,
    withTransaction,
    isV2ValidationLabEnabled,
    registerNextBestVisitValidationLabRoutes,
    replaceValidatedTourneeRowsInTransaction,
    validateAndResolveValidatedTourneeStops,
    loadCoverageConstraintsForApi: params => loadCoverageConstraints(params, {
      queryAsync,
      sharedDepotOrigin: SHARED_DEPOT_ORIGIN,
      depotCoordsByCode: DEPOT_COORDS_BY_CODE
    }),
    queryAsync,
    generateCoveragePlanResponse,
    coveragePurchasePredictionCache,
    sharedDepotOrigin: SHARED_DEPOT_ORIGIN,
    closeOpenHandles: () => new Promise(resolve => {
      try {
        dbPool.end(() => resolve())
      } catch (error) {
        resolve()
      }
    })
  }
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`Serveur API pret sur http://localhost:${PORT}`))
}

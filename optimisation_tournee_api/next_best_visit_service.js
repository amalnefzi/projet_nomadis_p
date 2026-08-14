const path = require('node:path')
const {
  buildActiveClientIndexes,
  normalizeClientId,
  normalizeExactClientCode,
  normalizeHistoricalClientCode,
  resolveHistoricalClientMatch
} = require('./client_identity')
const {
  buildCadenceProfiles,
  normalizeDateOnly
} = require('./client_cadence_intelligence')
const {
  DEFAULT_OBJECTIVE_MODE: ENGINE_DEFAULT_OBJECTIVE_MODE,
  buildCandidateDatesByClientId: buildCandidateDatesByClientIdFromEngine,
  buildClientScopePayload: buildClientScopePayloadFromEngine,
  buildCompatibleCommercialCodesByClientId: buildCompatibleCommercialCodesByClientIdFromEngine,
  buildDepotByCommercialDate: buildDepotByCommercialDateFromEngine,
  computeOpportunityScoring: computeOpportunityScoringFromEngine,
  generateNextBestVisitPlanFromData,
  normalizeNextBestVisitRequest: normalizeNextBestVisitRequestFromEngine,
  remapPredictionsByClientId: remapPredictionsByClientIdFromEngine
} = require('./next_best_visit_engine')
const {
  buildNextBestVisitPlanCacheKey,
  createNextBestVisitCaches,
  hashBusinessPayload
} = require('./next_best_visit_cache')
const {
  ensurePredictionCacheTables,
  readPredictionCacheRows,
  readPredictionCacheStats,
  upsertPredictionCacheRows
} = require('./next_best_visit_prediction_cache_store')
const {
  loadProfileSnapshotByClientIds,
  readProfileSnapshotState
} = require('./next_best_visit_profile_snapshot_store')
const {
  ensureNextBestVisitProfilesReady,
  runNextBestVisitProfileRebuildNow
} = require('./next_best_visit_profile_readiness')
const {
  buildPlannedVisitMetadata
} = require('./sales_visit_feedback_service')
const {
  NEXT_BEST_VISIT_PLAN_CACHE_KEY_VERSION,
  buildNextBestVisitPredictionFeaturesVersion,
  buildNextBestVisitPredictionModelVersion,
  readCanonicalFeatureStoreIdentity
} = require('./next_best_visit_versions')
const {
  resolveObjectiveWeightSet
} = require('./visit_opportunity_scoring')

const DEFAULT_MAX_CANDIDATE_DATES_PER_CLIENT = 4
const DEFAULT_MINIMUM_CONFIDENCE = 0
const DEFAULT_OBJECTIVE_MODE = ENGINE_DEFAULT_OBJECTIVE_MODE
const DEFAULT_DAILY_MAX_MODE = 'flexible'

const sharedCaches = createNextBestVisitCaches()

function clearNextBestVisitModelDependentCaches() {
  const cleared = {
    plans_entries_before: sharedCaches.plans.size(),
    cadence_profiles_entries_before: sharedCaches.cadenceProfiles.size()
  }

  sharedCaches.plans.clear()

  return {
    status: 'cleared',
    cleared_caches: ['plans'],
    ...cleared,
    plans_entries_after: sharedCaches.plans.size(),
    cadence_profiles_entries_after: sharedCaches.cadenceProfiles.size()
  }
}

function createPerfTracker() {
  const stages = []
  return {
    async run(stage, fn) {
      const startedAt = Date.now()
      try {
        return await fn()
      } finally {
        stages.push({
          stage: String(stage || 'unknown'),
          duration_ms: Math.max(0, Date.now() - startedAt)
        })
      }
    },
    record(stage, durationMs) {
      stages.push({
        stage: String(stage || 'unknown'),
        duration_ms: Math.max(0, Math.round(Number(durationMs || 0)))
      })
    },
    stages() {
      return [...stages]
    }
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function roundScore(value) {
  return Math.round(Number(value || 0) * 10) / 10
}

function roundQuantity(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function normalizeNullablePositiveInt(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizePredictionSupport(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    return roundQuantity(numeric)
  }
  const text = String(value).trim()
  return text || null
}

function buildHistoryNormalizedCodeExpression(column) {
  return `COALESCE(NULLIF(TRIM(LEADING '0' FROM TRIM(${column})), ''), '0')`
}

function buildOptionalInClause(column, values = []) {
  if (!Array.isArray(values) || !values.length) {
    return { clause: '', params: [] }
  }
  const placeholders = values.map(() => '?').join(', ')
  return {
    clause: `${column} IN (${placeholders})`,
    params: [...values]
  }
}

function buildHistoryFilter({ exactColumn, normalizedColumn, exactCodes = [], normalizedCodes = [] }) {
  const clauses = []
  const params = []
  const exact = buildOptionalInClause(exactColumn, exactCodes)
  const normalized = buildOptionalInClause(normalizedColumn, normalizedCodes)
  if (exact.clause) {
    clauses.push(exact.clause)
    params.push(...exact.params)
  }
  if (normalized.clause) {
    clauses.push(normalized.clause)
    params.push(...normalized.params)
  }
  return {
    sql: clauses.length ? ` AND (${clauses.join(' OR ')})` : '',
    params
  }
}

function normalizeRecommendedProducts(products = [], fallbackSource = null) {
  const rawProducts = Array.isArray(products)
    ? products
    : (products && typeof products === 'object')
      ? Object.entries(products).map(([name, quantity]) => ({
          product_label: name,
          estimated_quantity: quantity
        }))
      : []

  return rawProducts
    .map(item => {
      const productId = String(item?.product_id || '').trim() || null
      const productCode = String(item?.product_code || item?.produit_code || item?.code || '').trim() || null
      const productLabel = String(item?.product_label || item?.label || item?.name || item?.nom || '').trim() || null
      const estimatedQuantity = item?.estimated_quantity ?? item?.quantity ?? item?.quantite
      const normalizedQuantity = estimatedQuantity == null ? null : Number(estimatedQuantity)
      if (!productId && !productCode && !productLabel) return null
      if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) return null
      return {
        product_id: productId,
        product_code: productCode,
        product_label: productLabel,
        estimated_quantity: roundQuantity(normalizedQuantity),
        prediction_source: String(item?.prediction_source || item?.source || fallbackSource || '').trim() || null,
        confidence_or_support: normalizePredictionSupport(
          item?.confidence_or_support ??
          item?.support ??
          item?.confidence ??
          item?.docs_count ??
          null
        )
      }
    })
    .filter(Boolean)
}

function normalizeObjectiveMode(value) {
  const normalized = String(value || DEFAULT_OBJECTIVE_MODE).trim().toLowerCase()
  return {
    maximize_sales: 'maximize_sales',
    balanced: 'balanced',
    reactivate_at_risk: 'reactivate_at_risk',
    commercial_priority: 'commercial_priority'
  }[normalized] || DEFAULT_OBJECTIVE_MODE
}

function normalizeAvailabilityMode(value) {
  return String(value || 'flexible').trim().toLowerCase() === 'strict'
    ? 'strict'
    : 'flexible'
}

function normalizeDailyMaxMode(value) {
  return String(value || DEFAULT_DAILY_MAX_MODE).trim().toLowerCase() === 'strict'
    ? 'strict'
    : DEFAULT_DAILY_MAX_MODE
}

function normalizeNextBestVisitRequest(rawBody = {}) {
  return normalizeNextBestVisitRequestFromEngine(rawBody)
}

async function querySalesHistoryRowsForClients({
  queryAsync,
  activeClients = [],
  referenceDate
}) {
  const activeIndexes = buildActiveClientIndexes(activeClients)
  const exactCodes = activeIndexes.activeClients.map(client => normalizeExactClientCode(client.client_code)).filter(Boolean)
  const normalizedCodes = [...new Set(activeIndexes.activeClients.map(client => normalizeHistoricalClientCode(client.client_code)).filter(Boolean))]
  if (!exactCodes.length) return new Map()

  const historyFilter = buildHistoryFilter({
    exactColumn: 'TRIM(e.client_code)',
    normalizedColumn: buildHistoryNormalizedCodeExpression('e.client_code'),
    exactCodes,
    normalizedCodes
  })

  const rows = await queryAsync(
    `
      SELECT
        TRIM(e.client_code) AS historical_client_code,
        DATE(e.date) AS purchase_date,
        CAST(COALESCE(e.net_a_payer, '0') AS DECIMAL(15,3)) AS order_value,
        COALESCE(doc_quantities.total_quantity, 0) AS order_quantity,
        COALESCE(NULLIF(TRIM(e.commercial_code), ''), NULLIF(TRIM(e.user_code), '')) AS commercial_code
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
        AND DATE(e.date) <= ?
        ${historyFilter.sql}
      ORDER BY DATE(e.date) ASC, e.code ASC
    `,
    [referenceDate, ...historyFilter.params]
  )

  return {
    rows: Array.isArray(rows) ? rows : [],
    activeIndexes
  }
}

function normalizeSalesHistoryRowsForClients({
  rows = [],
  activeIndexes
} = {}) {
  const map = new Map()
  ;(Array.isArray(rows) ? rows : []).forEach(row => {
    const match = resolveHistoricalClientMatch(row.historical_client_code, activeIndexes)
    if (!['exact_match', 'unique_normalized_match'].includes(match.status)) return
    const clientId = normalizeClientId(match.client_id)
    const list = map.get(clientId) || []
    list.push({
      purchase_date: normalizeDateOnly(row.purchase_date),
      order_value: Number(row.order_value),
      order_quantity: Number(row.order_quantity),
      commercial_code: String(row.commercial_code || '').trim() || null
    })
    map.set(clientId, list)
  })
  return map
}

async function fetchSalesHistoryForClients({
  queryAsync,
  activeClients = [],
  referenceDate
}) {
  const { rows, activeIndexes } = await querySalesHistoryRowsForClients({
    queryAsync,
    activeClients,
    referenceDate
  })
  return normalizeSalesHistoryRowsForClients({
    rows,
    activeIndexes
  })
}

async function querySalesProductHistoryRowsForClients({
  queryAsync,
  activeClients = [],
  referenceDate
}) {
  const activeIndexes = buildActiveClientIndexes(activeClients)
  const exactCodes = activeIndexes.activeClients.map(client => normalizeExactClientCode(client.client_code)).filter(Boolean)
  const normalizedCodes = [...new Set(activeIndexes.activeClients.map(client => normalizeHistoricalClientCode(client.client_code)).filter(Boolean))]
  if (!exactCodes.length) return { rows: [], activeIndexes }

  const historyFilter = buildHistoryFilter({
    exactColumn: 'TRIM(e.client_code)',
    normalizedColumn: buildHistoryNormalizedCodeExpression('e.client_code'),
    exactCodes,
    normalizedCodes
  })

  const rows = await queryAsync(
    `
      SELECT
        TRIM(e.client_code) AS historical_client_code,
        e.code AS doc_code,
        DATE(e.date) AS purchase_date,
        COALESCE(NULLIF(TRIM(l.produit_code), ''), NULLIF(TRIM(p.code), '')) AS product_code,
        NULLIF(TRIM(p.libelle), '') AS product_label,
        SUM(CAST(COALESCE(l.quantite, '0') AS DECIMAL(15,3))) AS product_quantity
      FROM entetecommercials e
      JOIN lignecommercials l ON l.entetecommercial_code = e.code
      LEFT JOIN produits p ON l.produit_code = p.code
      WHERE e.deleted_at IS NULL
        AND e.type IN ('facture', 'bl', 'blf')
        AND DATE(e.date) <= ?
        ${historyFilter.sql}
      GROUP BY
        TRIM(e.client_code),
        e.code,
        DATE(e.date),
        COALESCE(NULLIF(TRIM(l.produit_code), ''), NULLIF(TRIM(p.code), '')),
        NULLIF(TRIM(p.libelle), '')
      ORDER BY DATE(e.date) DESC, e.code DESC
    `,
    [referenceDate, ...historyFilter.params]
  )

  return {
    rows: Array.isArray(rows) ? rows : [],
    activeIndexes
  }
}

function normalizeSalesProductHistoryRowsForClients({
  rows = [],
  activeIndexes
} = {}) {
  const map = new Map()
  ;(Array.isArray(rows) ? rows : []).forEach(row => {
    const match = resolveHistoricalClientMatch(row.historical_client_code, activeIndexes)
    if (!['exact_match', 'unique_normalized_match'].includes(match.status)) return
    const productCode = String(row.product_code || '').trim()
    const quantity = Number(row.product_quantity)
    if (!productCode || !Number.isFinite(quantity) || quantity <= 0) return
    const clientId = normalizeClientId(match.client_id)
    const list = map.get(clientId) || []
    list.push({
      purchase_date: normalizeDateOnly(row.purchase_date),
      doc_code: String(row.doc_code || '').trim() || null,
      product_id: null,
      product_code: productCode,
      product_label: String(row.product_label || '').trim() || null,
      quantity: roundQuantity(quantity)
    })
    map.set(clientId, list)
  })
  return map
}

async function fetchSalesProductHistoryForClients({
  queryAsync,
  activeClients = [],
  referenceDate
}) {
  const { rows, activeIndexes } = await querySalesProductHistoryRowsForClients({
    queryAsync,
    activeClients,
    referenceDate
  })
  return normalizeSalesProductHistoryRowsForClients({
    rows,
    activeIndexes
  })
}

async function queryVisitHistoryRowsForClients({
  queryAsync,
  activeClients = [],
  referenceDate
}) {
  const activeIndexes = buildActiveClientIndexes(activeClients)
  const exactCodes = activeIndexes.activeClients.map(client => normalizeExactClientCode(client.client_code)).filter(Boolean)
  const normalizedCodes = [...new Set(activeIndexes.activeClients.map(client => normalizeHistoricalClientCode(client.client_code)).filter(Boolean))]
  if (!exactCodes.length) return new Map()

  const historyFilter = buildHistoryFilter({
    exactColumn: 'TRIM(v.client_code)',
    normalizedColumn: buildHistoryNormalizedCodeExpression('v.client_code'),
    exactCodes,
    normalizedCodes
  })

  const rows = await queryAsync(
    `
      SELECT
        TRIM(v.client_code) AS historical_client_code,
        DATE(COALESCE(v.check_in_at, v.planned_date)) AS visit_date,
        TRIM(v.commercial_code) AS commercial_code,
        TRIM(COALESCE(v.visit_result, '')) AS visit_result
      FROM client_visits v
      WHERE v.validation_status = 'validated'
        AND DATE(COALESCE(v.check_in_at, v.planned_date)) <= ?
        ${historyFilter.sql}
      ORDER BY DATE(COALESCE(v.check_in_at, v.planned_date)) ASC, v.id ASC
    `,
    [referenceDate, ...historyFilter.params]
  )

  return {
    rows: Array.isArray(rows) ? rows : [],
    activeIndexes
  }
}

function normalizeVisitHistoryRowsForClients({
  rows = [],
  activeIndexes
} = {}) {
  const map = new Map()
  ;(Array.isArray(rows) ? rows : []).forEach(row => {
    const match = resolveHistoricalClientMatch(row.historical_client_code, activeIndexes)
    if (!['exact_match', 'unique_normalized_match'].includes(match.status)) return
    const clientId = normalizeClientId(match.client_id)
    const list = map.get(clientId) || []
    list.push({
      visit_date: normalizeDateOnly(row.visit_date),
      commercial_code: String(row.commercial_code || '').trim() || null,
      visit_result: String(row.visit_result || '').trim() || null
    })
    map.set(clientId, list)
  })
  return map
}

async function fetchVisitHistoryForClients({
  queryAsync,
  activeClients = [],
  referenceDate
}) {
  const { rows, activeIndexes } = await queryVisitHistoryRowsForClients({
    queryAsync,
    activeClients,
    referenceDate
  })
  return normalizeVisitHistoryRowsForClients({
    rows,
    activeIndexes
  })
}

function buildCompatibleCommercialCodesByClientId(clients = [], selectedCommercials = [], coverageConstraints = {}) {
  return buildCompatibleCommercialCodesByClientIdFromEngine(clients, selectedCommercials, coverageConstraints)
}

async function fetchDateSpecificPredictions({
  clients = [],
  candidateDatesByClientId = new Map(),
  fetchAiPredictionsForClientBatch
}) {
  const predictionsByClientDate = new Map()
  const coverageByDate = []
  const byDate = invertCandidateDatesByClientId(clients, candidateDatesByClientId)
  const normalizedDates = [...byDate.keys()].sort()

  await Promise.all(normalizedDates.map(async date => {
    const requestedEntries = byDate.get(date) || []
    const requestedClientCodes = requestedEntries.map(entry => entry.client_code)
    const payload = await fetchAiPredictionsForClientBatch({
      targetDate: date,
      clientCodes: requestedClientCodes
    })
    const predictions = Array.isArray(payload?.predictions) ? payload.predictions : []
    const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {}

    predictions.forEach(prediction => {
      const clientCode = normalizeExactClientCode(prediction?.client_code)
      if (!clientCode) return
      const recommendedProducts = normalizeRecommendedProducts(
        prediction?.recommended_products ??
        prediction?.predicted_products ??
        prediction?.details,
        'model'
      )
      predictionsByClientDate.set(`${clientCode}::${date}`, {
        purchase_prediction_score: prediction?.score ?? prediction?.purchase_probability,
        purchase_probability: prediction?.purchase_probability,
        expected_order_value: prediction?.predicted_ca,
        recommended_quantity: prediction?.recommended_quantity,
        predicted_ca_if_buy: prediction?.predicted_ca_if_buy,
        predicted_quantity_if_buy: prediction?.predicted_quantity_if_buy,
        predicted_products: recommendedProducts.map(product => ({ ...product })),
        recommended_products: recommendedProducts.map(product => ({ ...product })),
        predicted_purchase_date: date,
        purchase_prediction_known: prediction?.purchase_probability != null,
        prediction_vip: prediction?.vip ?? null,
        probability_model_only: prediction?.probability_model_only ?? null,
        habit_score: prediction?.habit_score ?? null,
        recency_score: prediction?.recency_score ?? null,
        confidence: typeof prediction?.model_confidence === 'number'
          ? Number(prediction.model_confidence) / 100
          : null,
        prediction_source: prediction?.prediction_source || null
      })
    })

    const requestedCount = Number(meta.prediction_requested_clients_count ?? requestedClientCodes.length)
    const returnedCount = Number(meta.prediction_returned_clients_count ?? predictions.length)
    const knownCount = Number(meta.prediction_known_count ?? predictions.filter(item => item?.purchase_probability != null).length)
    const nullCount = Number(meta.prediction_null_count ?? Math.max(0, returnedCount - knownCount))
    coverageByDate.push({
      date,
      requested_count: requestedCount,
      returned_count: returnedCount,
      known_count: knownCount,
      null_count: nullCount,
      coverage_rate: requestedCount > 0 ? roundScore((knownCount / requestedCount) * 100) : null,
      top_k_truncation_detected: Boolean(meta.top_k_truncation_detected)
    })
  }))

  return {
    predictionsByClientDate,
    coverageByDate
  }
}

function remapPredictionsByClientId(clients = [], predictionsByCodeDate = new Map()) {
  return remapPredictionsByClientIdFromEngine(clients, predictionsByCodeDate)
}

function buildDepotByCommercialDate(coverageConstraints = {}, selectedCommercials = [], planningDates = [], sharedDepot = null) {
  return buildDepotByCommercialDateFromEngine(coverageConstraints, selectedCommercials, planningDates, sharedDepot)
}

function computeOpportunityScoring(opportunities = [], objectiveMode = DEFAULT_OBJECTIVE_MODE) {
  return computeOpportunityScoringFromEngine(opportunities, objectiveMode)
}

function diffDaysFromDates(laterDate, earlierDate) {
  if (!laterDate || !earlierDate) return null
  const later = new Date(`${laterDate}T00:00:00Z`)
  const earlier = new Date(`${earlierDate}T00:00:00Z`)
  if (Number.isNaN(later.getTime()) || Number.isNaN(earlier.getTime())) return null
  return Math.max(0, Math.round((later.getTime() - earlier.getTime()) / 86400000))
}

function buildHistoricalRecommendedProducts(productHistoryRows = [], {
  referenceDate = null,
  maxProducts = 5,
  recencyWindowDays = 45
} = {}) {
  const aggregates = new Map()
  ;(Array.isArray(productHistoryRows) ? productHistoryRows : []).forEach(row => {
    const productCode = String(row?.product_code || '').trim()
    const purchaseDate = normalizeDateOnly(row?.purchase_date)
    const quantity = Number(row?.quantity)
    if (!productCode || !purchaseDate || !Number.isFinite(quantity) || quantity <= 0) return

    const entry = aggregates.get(productCode) || {
      product_id: String(row?.product_id || '').trim() || null,
      product_code: productCode,
      product_label: String(row?.product_label || '').trim() || null,
      doc_codes: new Set(),
      total_quantity: 0,
      last_purchase_date: null,
      last_quantity: null
    }

    if (row?.doc_code) {
      entry.doc_codes.add(String(row.doc_code).trim())
    }
    entry.total_quantity += quantity
    if (!entry.last_purchase_date || purchaseDate > entry.last_purchase_date) {
      entry.last_purchase_date = purchaseDate
      entry.last_quantity = quantity
      if (!entry.product_label && row?.product_label) {
        entry.product_label = String(row.product_label).trim() || null
      }
    }
    aggregates.set(productCode, entry)
  })

  return [...aggregates.values()]
    .map(entry => {
      const docsCount = entry.doc_codes.size
      const daysSinceLastPurchase = diffDaysFromDates(referenceDate, entry.last_purchase_date)
      const stableRecurring = docsCount >= 2
      const recentProduct = daysSinceLastPurchase != null && daysSinceLastPurchase <= recencyWindowDays
      if (!stableRecurring && !recentProduct) return null

      const estimatedQuantity = stableRecurring
        ? entry.total_quantity / Math.max(1, docsCount)
        : entry.last_quantity
      if (!Number.isFinite(estimatedQuantity) || estimatedQuantity <= 0) return null

      return {
        product_id: entry.product_id,
        product_code: entry.product_code,
        product_label: entry.product_label,
        estimated_quantity: roundQuantity(estimatedQuantity),
        prediction_source: 'historical_pattern',
        confidence_or_support: docsCount,
        _sort_docs_count: docsCount,
        _sort_last_purchase_date: entry.last_purchase_date || '',
        _sort_total_quantity: entry.total_quantity
      }
    })
    .filter(Boolean)
    .sort((left, right) => {
      const docsDelta = Number(right._sort_docs_count || 0) - Number(left._sort_docs_count || 0)
      if (docsDelta !== 0) return docsDelta
      const dateDelta = String(right._sort_last_purchase_date || '').localeCompare(String(left._sort_last_purchase_date || ''))
      if (dateDelta !== 0) return dateDelta
      const quantityDelta = Number(right._sort_total_quantity || 0) - Number(left._sort_total_quantity || 0)
      if (quantityDelta !== 0) return quantityDelta
      return String(left.product_code || '').localeCompare(String(right.product_code || ''))
    })
    .slice(0, Math.max(1, Number(maxProducts) || 5))
    .map(item => ({
      product_id: item.product_id,
      product_code: item.product_code,
      product_label: item.product_label,
      estimated_quantity: item.estimated_quantity,
      prediction_source: item.prediction_source,
      confidence_or_support: item.confidence_or_support
    }))
}

function buildLoadingPredictionForBlock(block = {}) {
  const clients = Array.isArray(block?.clients) ? block.clients : []
  const totals = new Map()
  let visitsWithBasketPrediction = 0

  clients.forEach(client => {
    const products = normalizeRecommendedProducts(
      client?.recommended_products ?? client?.predicted_products,
      client?.basket_prediction_source || null
    )
    if (products.length > 0) {
      visitsWithBasketPrediction += 1
    }

    products.forEach(product => {
      const key = `${product.product_code || ''}::${product.product_label || ''}::${product.product_id || ''}`
      const entry = totals.get(key) || {
        product_id: product.product_id,
        product_code: product.product_code,
        product_label: product.product_label,
        estimated_need: 0,
        model_count: 0,
        historical_count: 0,
        support_total: 0
      }
      entry.estimated_need += Number(product.estimated_quantity || 0)
      if (product.prediction_source === 'model') {
        entry.model_count += 1
      } else if (product.prediction_source === 'historical_pattern') {
        entry.historical_count += 1
      }
      if (typeof product.confidence_or_support === 'number' && Number.isFinite(product.confidence_or_support)) {
        entry.support_total += Number(product.confidence_or_support)
      }
      totals.set(key, entry)
    })
  })

  const products = [...totals.values()]
    .map(entry => ({
      product_id: entry.product_id,
      product_code: entry.product_code,
      product_label: entry.product_label,
      estimated_need: roundQuantity(entry.estimated_need),
      recommended_load_quantity: roundQuantity(entry.estimated_need),
      prediction_source: entry.model_count > 0 && entry.historical_count === 0
        ? 'model'
        : entry.historical_count > 0 && entry.model_count === 0
          ? 'historical_pattern'
          : entry.model_count > 0 && entry.historical_count > 0
            ? 'mixed'
            : null,
      confidence_or_support: entry.historical_count > 0 && entry.model_count === 0
        ? roundQuantity(entry.support_total)
        : null
    }))
    .sort((left, right) => {
      const quantityDelta = Number(right.estimated_need || 0) - Number(left.estimated_need || 0)
      if (quantityDelta !== 0) return quantityDelta
      return String(left.product_code || left.product_label || '').localeCompare(String(right.product_code || right.product_label || ''))
    })

  return {
    commercial_code: String(block?.commercial_code || '').trim() || null,
    planning_date: normalizeDateOnly(block?.date) || null,
    products,
    coverage: {
      planned_visits: clients.length,
      visits_with_basket_prediction: visitsWithBasketPrediction,
      basket_prediction_coverage_pct: clients.length > 0
        ? roundScore((visitsWithBasketPrediction / clients.length) * 100)
        : null
    }
  }
}

function enrichPayloadWithBasketRecommendations(payload = {}, {
  productHistoryByClientId = new Map(),
  referenceDate = null
} = {}) {
  const nextBlocks = (Array.isArray(payload?.blocks) ? payload.blocks : []).map(block => {
    const nextClients = (Array.isArray(block?.clients) ? block.clients : []).map(client => {
      const modelProducts = normalizeRecommendedProducts(
        client?.recommended_products ?? client?.predicted_products,
        'model'
      )
      const fallbackProducts = modelProducts.length === 0
        ? buildHistoricalRecommendedProducts(
            productHistoryByClientId.get(String(client?.client_id || '').trim()) || [],
            { referenceDate }
          )
        : []
      const recommendedProducts = modelProducts.length > 0 ? modelProducts : fallbackProducts
      const basketPredictionSource = modelProducts.length > 0
        ? 'model'
        : fallbackProducts.length > 0
          ? 'historical_pattern'
          : 'unavailable'

      return {
        ...client,
        predicted_products: recommendedProducts.map(product => ({ ...product })),
        recommended_products: recommendedProducts.map(product => ({ ...product })),
        basket_prediction_source: basketPredictionSource
      }
    })

    return {
      ...block,
      clients: nextClients,
      loading_prediction: buildLoadingPredictionForBlock({
        ...block,
        clients: nextClients
      })
    }
  })

  return {
    ...payload,
    blocks: nextBlocks
  }
}

function enrichPayloadWithPlannedVisitMetadata(payload = {}) {
  const nextBlocks = (Array.isArray(payload?.blocks) ? payload.blocks : []).map(block => {
    const nextClients = (Array.isArray(block?.clients) ? block.clients : []).map(client => {
      const metadata = buildPlannedVisitMetadata({
        ...client,
        assigned_slot_id: client?.assigned_slot_id ?? block?.slot_id,
        assigned_date: client?.assigned_date ?? block?.date,
        commercial_code: client?.commercial_code ?? block?.commercial_code
      })

      return {
        ...client,
        assigned_slot_id: metadata.assigned_slot_id,
        assigned_date: metadata.planned_date,
        planned_visit_id: metadata.planned_visit_id,
        prediction_snapshot: metadata.prediction_snapshot
      }
    })

    return {
      ...block,
      clients: nextClients
    }
  })

  return {
    ...payload,
    blocks: nextBlocks
  }
}

function buildSummary({
  requestContext,
  blocks = [],
  deferredClients = [],
  cacheStatus,
  objectiveMode
}) {
  const totalExpectedCa = blocks.reduce((sum, block) => sum + (Number(block.predicted_order_value_total || 0) || 0), 0)
  const totalVisits = blocks.reduce((sum, block) => sum + (Number(block.clients_count || 0) || 0), 0)
  const allVisits = blocks.flatMap(block => Array.isArray(block.clients) ? block.clients : [])
  const confidenceValues = allVisits.map(visit => Number(visit.confidence)).filter(Number.isFinite)
  const globalConfidence = confidenceValues.length
    ? roundScore(confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length)
    : null

  return {
    planning_start_date: requestContext.startDate,
    planning_horizon_days: requestContext.planningHorizonDays,
    objective_mode: objectiveMode,
    max_days_without_contact: requestContext.maxDaysWithoutContact,
    daily_max_mode: requestContext.dailyMaxMode,
    total_expected_ca: roundScore(totalExpectedCa),
    probable_sales_count: allVisits.filter(visit => Number(visit.purchase_probability || 0) >= 50).length,
    recommended_visits_count: totalVisits,
    deferred_clients_count: deferredClients.length,
    load_by_commercial: blocks.reduce((accumulator, block) => {
      accumulator[block.commercial_code] = Number(block.clients_count || 0)
      return accumulator
    }, {}),
    global_confidence: globalConfidence,
    cache_status: cacheStatus,
    main_selection_reasons: [
      'probabilite_achat',
      'valeur_attendue',
      'cadence_client',
      'synergie_geographique'
    ],
    terrain_warnings: blocks.some(block => block.workday_limit_known === false)
      ? ['faisabilite_terrain_a_confirmer']
      : []
  }
}

function buildClientScopePayload(selectedCommercials = [], activeClientsCount = 0) {
  return buildClientScopePayloadFromEngine(selectedCommercials, activeClientsCount)
}

function summarizePerformanceStages(stages = [], totalStageName = 'total_service') {
  const excludedFromCoverage = new Set([
    'total_service',
    'total_http'
  ])
  const normalizedStages = (Array.isArray(stages) ? stages : []).map(stage => ({
    stage: String(stage?.stage || 'unknown'),
    duration_ms: Math.max(0, Math.round(Number(stage?.duration_ms || 0)))
  }))
  const totalDuration = normalizedStages
    .filter(stage => stage.stage === totalStageName)
    .reduce((sum, stage) => sum + stage.duration_ms, 0)
  const explainedDuration = normalizedStages
    .filter(stage => !excludedFromCoverage.has(stage.stage))
    .reduce((sum, stage) => sum + stage.duration_ms, 0)
  const effectiveExplainedDuration = totalDuration > 0
    ? Math.min(explainedDuration, totalDuration)
    : explainedDuration
  const unaccountedTimeMs = totalDuration > 0
    ? Math.max(0, totalDuration - effectiveExplainedDuration)
    : 0
  const normalizedStagesWithOverhead = unaccountedTimeMs > 0
    ? [
        ...normalizedStages,
        {
          stage: 'service_overhead',
          duration_ms: unaccountedTimeMs
        }
      ]
    : normalizedStages
  const explainedDurationWithOverhead = normalizedStagesWithOverhead
    .filter(stage => !excludedFromCoverage.has(stage.stage))
    .reduce((sum, stage) => sum + stage.duration_ms, 0)
  const timingCoverageRate = totalDuration > 0
    ? roundScore((Math.min(explainedDurationWithOverhead, totalDuration) / totalDuration) * 100)
    : null

  return {
    stages: normalizedStagesWithOverhead,
    unaccounted_time_ms: unaccountedTimeMs,
    timing_coverage_rate: timingCoverageRate
  }
}

function buildSnapshotUnavailablePayload(snapshotState = {}, requestContext = {}) {
  const snapshotStatus = String(snapshotState?.status || 'missing').trim() || 'missing'
  const defaultMessage = snapshotStatus === 'stale' || snapshotStatus === 'missing' || snapshotStatus === 'building'
    ? 'Preparation des profils clients en cours...'
    : snapshotStatus === 'failed'
      ? 'La preparation des profils clients a echoue.'
      : 'Preparation des profils clients requise.'

  return {
    status: snapshotStatus,
    message: defaultMessage,
    summary: {
      planning_start_date: requestContext.startDate || null,
      planning_horizon_days: requestContext.planningHorizonDays || null,
      profile_snapshot_status: snapshotStatus
    },
    diagnostics: {
      profile_snapshot_status: snapshotStatus,
      required_profile_version: snapshotState?.required_profile_version || null,
      active_profile_version: snapshotState?.active_profile_version || null,
      source_data_version: snapshotState?.source_fingerprint?.source_data_version || null,
      historical_cutoff_date: snapshotState?.required_historical_cutoff_date || null,
      rebuild_status: snapshotState?.rebuild_status || null,
      latest_error_message: snapshotState?.latest_error_message || null
    },
    statuses: {
      technical_validation_status: 'not_applicable',
      logical_validation_status: 'not_applicable',
      commercial_validation_status: 'not_validated',
      data_environment: 'development',
      data_representativeness: 'non_representative'
    },
    profile_snapshot: {
      status: snapshotStatus,
      version: snapshotState?.active_profile_version || null,
      required_version: snapshotState?.required_profile_version || null,
      computed_at: snapshotState?.snapshot?.computed_at || null,
      clients_count: Number(snapshotState?.snapshot?.clients_count || 0),
      source_data_version: snapshotState?.source_fingerprint?.source_data_version || null,
      historical_cutoff_date: snapshotState?.snapshot?.historical_cutoff_date || snapshotState?.required_historical_cutoff_date || null,
      rebuild_started_at: snapshotState?.rebuilding_started_at || null,
      rebuild_finished_at: snapshotState?.last_completed_at || null,
      latest_error_message: snapshotState?.latest_error_message || null,
      retry_supported: snapshotStatus === 'failed'
    }
  }
}

function buildPlanCacheSummary(cacheEntry = null) {
  const createdAt = Number(cacheEntry?.createdAt || 0)
  return {
    plan_cache_status: cacheEntry ? 'hit' : 'miss',
    plan_cache_age_ms: cacheEntry && createdAt > 0 ? Math.max(0, Date.now() - createdAt) : null,
    plan_cache_key_version: NEXT_BEST_VISIT_PLAN_CACHE_KEY_VERSION
  }
}

function mapBatchPredictionRow(row = {}, {
  targetDate,
  clientId,
  clientCode
} = {}) {
  const recommendedProducts = normalizeRecommendedProducts(
    row?.recommended_products ??
    row?.predicted_products ??
    row?.details,
    'model'
  )
  return {
    client_id: String(row?.client_id || clientId || '').trim() || null,
    client_code: String(row?.client_code || clientCode || '').trim() || null,
    target_date: String(targetDate || '').trim().slice(0, 10),
    purchase_probability: row?.purchase_probability == null ? null : Number(row.purchase_probability),
    predicted_ca: row?.predicted_ca == null ? null : Number(row.predicted_ca),
    recommended_quantity: row?.recommended_quantity == null ? null : Number(row.recommended_quantity),
    model_confidence: row?.model_confidence == null ? null : Number(row.model_confidence),
    score: row?.score == null ? null : Number(row.score),
    vip: row?.vip == null ? null : Number(row.vip),
    predicted_ca_if_buy: row?.predicted_ca_if_buy == null ? null : Number(row.predicted_ca_if_buy),
    predicted_quantity_if_buy: row?.predicted_quantity_if_buy == null ? null : Number(row.predicted_quantity_if_buy),
    probability_model_only: row?.probability_model_only == null ? null : Number(row.probability_model_only),
    habit_score: row?.habit_score == null ? null : Number(row.habit_score),
    recency_score: row?.recency_score == null ? null : Number(row.recency_score),
    prediction_source: row?.prediction_source || null,
    predicted_products: recommendedProducts.map(product => ({ ...product })),
    recommended_products: recommendedProducts.map(product => ({ ...product }))
  }
}

function buildCachedBatchPredictionResolver({
  queryAsync,
  fetchAiPredictionsForClientBatch,
  perfTracker,
  modelVersion,
  featuresVersion,
  sourceDataVersion
}) {
  return async function resolveBatchPredictions({
    targetDate,
    requestedClients = [],
    clientCodes = []
  } = {}) {
    const requestedEntries = Array.isArray(requestedClients) && requestedClients.length
      ? requestedClients
      : (Array.isArray(clientCodes) ? clientCodes : []).map((clientCode, index) => ({
          client_id: String(index + 1),
          client_code: String(clientCode || '').trim()
        }))
    const normalizedRequests = [...new Map(
      requestedEntries
        .map(entry => {
          const clientId = String(entry?.client_id || '').trim()
          const clientCode = String(entry?.client_code || '').trim()
          if (!clientId || !clientCode || !targetDate) return null
          return [`${clientId}::${clientCode}`, {
            client_id: clientId,
            client_code: clientCode,
            target_date: String(targetDate).slice(0, 10)
          }]
        })
        .filter(Boolean)
    ).values()]

    if (!normalizedRequests.length) {
      return {
        status: 'success',
        predictions: [],
        meta: {
          prediction_requested_clients_count: 0,
          prediction_returned_clients_count: 0,
          prediction_known_count: 0,
          prediction_null_count: 0,
          prediction_cache_hit_count: 0,
          prediction_cache_miss_count: 0,
          prediction_cache_hit_rate: null,
          python_requested_count: 0,
          top_k_truncation_detected: false
        }
      }
    }

    await ensurePredictionCacheTables(queryAsync)
    const cacheReadResult = await perfTracker.run('prediction_cache_read', async () => readPredictionCacheRows(queryAsync, {
      requests: normalizedRequests,
      modelVersion,
      featuresVersion,
      sourceDataVersion
    }))
    const missingRequests = normalizedRequests.filter(requestEntry => !cacheReadResult.by_key.has(
      `${requestEntry.client_id}::${requestEntry.client_code}::${requestEntry.target_date}`
    ))

    let fetchedRowsByCode = new Map()
    let missMeta = {}
    if (missingRequests.length > 0) {
      const missPayload = await perfTracker.run('fetch_prediction_misses', async () => fetchAiPredictionsForClientBatch({
        targetDate,
        clientCodes: missingRequests.map(item => item.client_code)
      }))
      const fetchedRows = Array.isArray(missPayload?.predictions) ? missPayload.predictions : []
      missMeta = missPayload?.meta && typeof missPayload.meta === 'object' ? missPayload.meta : {}
      fetchedRowsByCode = new Map(
        fetchedRows.map(row => [String(row?.client_code || '').trim(), row]).filter(([clientCode]) => clientCode)
      )

      const rowsToPersist = missingRequests.map(requestEntry => {
        const batchRow = mapBatchPredictionRow(fetchedRowsByCode.get(requestEntry.client_code) || {}, {
          targetDate,
          clientId: requestEntry.client_id,
          clientCode: requestEntry.client_code
        })
        return {
          ...batchRow,
          model_version: modelVersion,
          features_version: featuresVersion,
          source_data_version: sourceDataVersion,
          prediction_payload: batchRow,
          python_meta: missMeta
        }
      })
      await perfTracker.run('prediction_cache_write', async () => upsertPredictionCacheRows(queryAsync, rowsToPersist))

      rowsToPersist.forEach(row => {
        cacheReadResult.by_key.set(`${row.client_id}::${row.client_code}::${row.target_date}`, {
          ...row
        })
      })
    }

    const orderedRows = normalizedRequests.map(requestEntry => {
      const key = `${requestEntry.client_id}::${requestEntry.client_code}::${requestEntry.target_date}`
      const cachedRow = cacheReadResult.by_key.get(key)
      return mapBatchPredictionRow(cachedRow || {}, {
        targetDate: requestEntry.target_date,
        clientId: requestEntry.client_id,
        clientCode: requestEntry.client_code
      })
    })
    const knownCount = orderedRows.filter(row => row.purchase_probability != null).length
    const nullCount = Math.max(0, orderedRows.length - knownCount)

    return {
      status: 'success',
      predictions: orderedRows,
      meta: {
        prediction_requested_clients_count: normalizedRequests.length,
        prediction_returned_clients_count: orderedRows.length,
        prediction_known_count: knownCount,
        prediction_null_count: nullCount,
        prediction_cache_hit_count: cacheReadResult.hit_count,
        prediction_cache_miss_count: cacheReadResult.miss_count,
        prediction_cache_hit_rate: cacheReadResult.hit_rate,
        python_requested_count: missingRequests.length,
        top_k_truncation_detected: false,
        batch_total_ms: missMeta.batch_total_ms ?? null,
        model_load_ms: missMeta.model_load_ms ?? null,
        feature_lookup_ms: missMeta.feature_lookup_ms ?? null,
        prediction_compute_ms: missMeta.prediction_compute_ms ?? null,
        serialization_ms: missMeta.serialization_ms ?? null
      }
    }
  }
}

function buildProductionStatuses(payload = {}) {
  const status = String(payload?.status || '').trim().toLowerCase()
  return {
    technical_validation_status: status === 'success' ? 'passed' : 'not_applicable',
    logical_validation_status: 'not_applicable',
    commercial_validation_status: 'not_validated',
    data_environment: 'development',
    data_representativeness: 'non_representative'
  }
}

function decorateNextBestVisitPayload(payload = {}, serviceStages = []) {
  const engineStages = Array.isArray(payload?.meta?.performance?.stages)
    ? payload.meta.performance.stages
    : []
  const performance = summarizePerformanceStages([
    ...serviceStages,
    ...engineStages
  ])

  return {
    ...payload,
    statuses: buildProductionStatuses(payload),
    meta: {
      ...(payload?.meta && typeof payload.meta === 'object' ? payload.meta : {}),
      performance
    }
  }
}

function buildCandidateDatesByClientId(cadenceProfiles = [], requestContext = {}) {
  return buildCandidateDatesByClientIdFromEngine(cadenceProfiles, requestContext)
}

function invertCandidateDatesByClientId(clients = [], candidateDatesByClientId = new Map()) {
  const byDate = new Map()
  ;(Array.isArray(clients) ? clients : []).forEach(client => {
    const clientId = String(client.client_id || '')
    const clientCode = String(client.client_code || '').trim()
    ;(candidateDatesByClientId.get(clientId) || []).forEach(date => {
      const list = byDate.get(date) || []
      list.push({
        client_id: clientId,
        client_code: clientCode
      })
      byDate.set(date, list)
    })
  })
  return byDate
}

async function getNextBestVisitReadiness({
  queryAsync,
  withTransaction = null,
  planningStartDate = null,
  historicalCutoffDate = null,
  autoTriggerRebuild = true,
  forceRetry = false,
  logger = console
} = {}) {
  if (typeof queryAsync !== 'function') {
    throw new Error('queryAsync requis pour le readiness V2.')
  }

  const [readinessResult, predictionCacheStats, canonicalFeatureIdentity] = await Promise.all([
    (typeof withTransaction === 'function'
      ? ensureNextBestVisitProfilesReady({
          queryAsync,
          withTransaction,
          querySalesHistoryRowsForClients,
          normalizeSalesHistoryRowsForClients,
          queryVisitHistoryRowsForClients,
          normalizeVisitHistoryRowsForClients,
          planningStartDate,
          historicalCutoffDate,
          autoTriggerRebuild,
          forceRetry,
          logger
        })
      : readProfileSnapshotState(queryAsync, {
          planningStartDate,
          historicalCutoffDate
        })),
    readPredictionCacheStats(queryAsync),
    readCanonicalFeatureStoreIdentity(queryAsync)
  ])
  const snapshotState = readinessResult?.snapshotState || readinessResult || null
  const readinessStatus = readinessResult?.status || snapshotState?.status || 'missing'

  return {
    status: readinessStatus,
    data_environment: 'development',
    commercial_validation_status: 'not_validated',
    error: readinessStatus === 'failed'
      ? snapshotState.latest_error_message || null
      : null,
    profile_snapshot: {
      status: readinessStatus,
      version: snapshotState.active_profile_version || snapshotState.required_profile_version || null,
      required_version: snapshotState.required_profile_version || null,
      computed_at: snapshotState.snapshot?.computed_at || null,
      clients_count: Number(snapshotState.snapshot?.clients_count || 0),
      source_data_version: snapshotState.source_fingerprint?.source_data_version || null,
      historical_cutoff_date: snapshotState.snapshot?.historical_cutoff_date || snapshotState.required_historical_cutoff_date || null,
      latest_error_message: snapshotState.latest_error_message || null,
      rebuild_started_at: snapshotState.rebuilding_started_at || null,
      last_completed_at: snapshotState.last_completed_at || null
    },
    prediction_cache: {
      entries_count: Number(predictionCacheStats.entries_count || 0),
      model_version: predictionCacheStats.model_version || buildNextBestVisitPredictionModelVersion(path.resolve(__dirname)),
      features_version: predictionCacheStats.features_version || canonicalFeatureIdentity.features_version || buildNextBestVisitPredictionFeaturesVersion(path.resolve(__dirname)),
      latest_updated_at: predictionCacheStats.latest_updated_at || null
    },
    plan_cache: {
      entries_count: sharedCaches.plans.size(),
      key_version: NEXT_BEST_VISIT_PLAN_CACHE_KEY_VERSION
    },
    statuses: {
      technical_validation_status: readinessStatus === 'ready' ? 'passed' : 'not_applicable',
      logical_validation_status: 'not_applicable',
      commercial_validation_status: 'not_validated',
      data_environment: 'development',
      data_representativeness: 'non_representative'
    }
  }
}

async function generateNextBestVisitPlan(rawBody = {}, dependencies = {}) {
  const {
    fetchCommercialOptions,
    fetchCoverageActiveClients,
    loadCoverageConstraints,
    fetchAiPredictionsForClientBatch,
    loadProfileSnapshot = null,
    allowInlineProfileBuild = false,
    queryAsync,
    withTransaction = null,
    sharedDepotOrigin = null
  } = dependencies
  const perf = createPerfTracker()
  const totalServiceStartedAt = Date.now()

  const requestContext = await perf.run('request_validation', async () => normalizeNextBestVisitRequest(rawBody))
  const allCommercials = await perf.run('load_commercial_options', async () => fetchCommercialOptions())
  const selectedCommercials = requestContext.commercialCodes.length
    ? allCommercials.filter(item => requestContext.commercialCodes.includes(item.value))
    : allCommercials

  if (!selectedCommercials.length) {
    return {
      status: 'invalid_parameters',
      message: 'Aucun commercial actif disponible pour V2.'
    }
  }

  const coverageClientDirectory = await perf.run('load_active_clients', async () => fetchCoverageActiveClients({
    selectedCommercialCodes: selectedCommercials.map(item => item.value),
    selectedClientIds: [],
    startDate: requestContext.startDate,
    allCommercialsSelected: selectedCommercials.length === allCommercials.length,
    clientScope: null
  }))
  const clients = coverageClientDirectory.clients || []
  if (!clients.length) {
    return generateNextBestVisitPlanFromData({
      requestContext,
      clients: [],
      selectedCommercials,
      coverageConstraints: {},
      sharedDepotOrigin,
      cacheStatus: 'empty'
    })
  }

  const planningDates = Array.from({ length: requestContext.planningHorizonDays }, (_, index) => {
    const date = new Date(`${requestContext.startDate}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() + index)
    return date.toISOString().slice(0, 10)
  })
  const coverageConstraints = await perf.run('load_constraints', async () => loadCoverageConstraints({
    startDate: requestContext.startDate,
    endDate: planningDates[planningDates.length - 1],
    commercialCodes: selectedCommercials.map(item => item.value),
    clientIds: clients.map(client => client.client_id)
  }))

  const snapshotState = await perf.run('readiness_check', async () => {
    if (typeof loadProfileSnapshot === 'function') {
      return loadProfileSnapshot({
        clients,
        requestContext,
        historicalCutoffDate: requestContext.historicalCutoffDate || requestContext.startDate
      })
    }

    if (allowInlineProfileBuild) {
      return {
        status: 'ready',
        required_profile_version: 'inline_test_profile_version',
        source_fingerprint: {
          source_data_version: 'inline_test_source_version'
        },
        snapshot: {
          computed_at: null,
          clients_count: clients.length
        }
      }
    }

    const readinessResult = await ensureNextBestVisitProfilesReady({
      queryAsync,
      withTransaction,
      querySalesHistoryRowsForClients,
      normalizeSalesHistoryRowsForClients,
      queryVisitHistoryRowsForClients,
      normalizeVisitHistoryRowsForClients,
      planningStartDate: requestContext.startDate,
      historicalCutoffDate: requestContext.historicalCutoffDate,
      autoTriggerRebuild: true
    })
    return readinessResult?.snapshotState || null
  })

  if (snapshotState?.status !== 'ready') {
    perf.record('total_service', Date.now() - totalServiceStartedAt)
    return decorateNextBestVisitPayload(buildSnapshotUnavailablePayload(snapshotState, requestContext), perf.stages())
  }

  const cadenceProfiles = await perf.run('load_profile_snapshot', async () => {
    if (Array.isArray(snapshotState?.cadenceProfiles)) {
      return snapshotState.cadenceProfiles
    }
    if (allowInlineProfileBuild) {
      const historyReferenceDate = requestContext.historicalCutoffDate || requestContext.startDate
      const [salesHistoryByClientId, visitHistoryByClientId] = await Promise.all([
        fetchSalesHistoryForClients({
          queryAsync,
          activeClients: clients,
          referenceDate: historyReferenceDate
        }),
        fetchVisitHistoryForClients({
          queryAsync,
          activeClients: clients,
          referenceDate: historyReferenceDate
        })
      ])
      return buildCadenceProfiles({
        clients,
        salesHistoryByClientId,
        visitHistoryByClientId,
        referenceDate: historyReferenceDate,
        maxDaysWithoutContact: requestContext.maxDaysWithoutContact
      })
    }

    const rows = await loadProfileSnapshotByClientIds(queryAsync, {
      profileVersion: snapshotState.active_profile_storage_version || snapshotState.required_profile_version,
      clientIds: clients.map(client => client.client_id)
    })
    if (rows.length !== clients.length) {
      throw new Error(`Snapshot de profils incomplet: ${rows.length}/${clients.length} clients charges.`)
    }
    return rows
  })

  const predictionModelVersion = buildNextBestVisitPredictionModelVersion(path.resolve(__dirname))
  const canonicalFeatureIdentity = typeof queryAsync === 'function'
    ? await perf.run('read_feature_store_identity', async () => readCanonicalFeatureStoreIdentity(queryAsync))
    : null
  const predictionFeaturesVersion =
    canonicalFeatureIdentity?.features_version ||
    buildNextBestVisitPredictionFeaturesVersion(path.resolve(__dirname))
  const predictionSourceDataVersion =
    canonicalFeatureIdentity?.source_data_watermark ||
    snapshotState.source_fingerprint?.source_data_version ||
    snapshotState.snapshot?.source_data_version ||
    null
  const constraintsVersion = hashBusinessPayload({
    commercials: coverageConstraints?.commercials || {},
    client_restrictions: coverageConstraints?.client_restrictions || {}
  })

  const planCacheKey = buildNextBestVisitPlanCacheKey({
    startDate: requestContext.startDate,
    planningHorizonDays: requestContext.planningHorizonDays,
    commercialCodes: selectedCommercials.map(item => item.value),
    objectiveMode: requestContext.objectiveMode,
    limits: {
      max_visits_per_day: requestContext.maxVisitsPerDay,
      min_visits_per_day_preference: requestContext.minVisitsPerDayPreference,
      min_daily_ca_per_commercial: requestContext.minDailyCaPerCommercial,
      max_days_without_contact: requestContext.maxDaysWithoutContact,
      minimum_confidence: requestContext.minimumConfidence,
      historical_cutoff_date: requestContext.historicalCutoffDate,
      respect_availability: requestContext.respectAvailability,
      daily_max_mode: requestContext.dailyMaxMode
    },
    profileVersion: snapshotState.required_profile_version,
    predictionVersion: `${predictionModelVersion}::${predictionFeaturesVersion}`,
    constraintsVersion
  })
  let cachedPlanEntry = null
  await perf.run('cache_read', async () => {
    cachedPlanEntry = sharedCaches.plans.getEntry(planCacheKey)
  })
  if (cachedPlanEntry?.value) {
    const cacheSummary = buildPlanCacheSummary(cachedPlanEntry)
    perf.record('total_service', Date.now() - totalServiceStartedAt)
    return decorateNextBestVisitPayload({
      ...cachedPlanEntry.value,
      summary: {
        ...(cachedPlanEntry.value.summary || {}),
        cache_status: 'plan_hit',
        ...cacheSummary
      }
    }, perf.stages())
  }

  const batchPredictionFetcher = typeof fetchAiPredictionsForClientBatch === 'function'
    ? buildCachedBatchPredictionResolver({
        queryAsync,
        fetchAiPredictionsForClientBatch,
        perfTracker: perf,
        modelVersion: predictionModelVersion,
        featuresVersion: predictionFeaturesVersion,
        sourceDataVersion: predictionSourceDataVersion
      })
    : async ({ clientCodes = [] }) => ({
        status: 'success',
        predictions: clientCodes.map(clientCode => ({
          client_id: null,
          client_code: clientCode,
          purchase_probability: null,
          predicted_ca: null,
          recommended_quantity: null,
          model_confidence: null,
          score: null,
          vip: null,
          prediction_source: 'prediction_fetcher_missing'
        })),
        meta: {
          prediction_requested_clients_count: clientCodes.length,
          prediction_returned_clients_count: clientCodes.length,
          prediction_known_count: 0,
          prediction_null_count: clientCodes.length,
          prediction_cache_hit_count: 0,
          prediction_cache_miss_count: clientCodes.length,
          prediction_cache_hit_rate: 0,
          python_requested_count: 0,
          top_k_truncation_detected: false
        }
      })

  const payload = await generateNextBestVisitPlanFromData({
    requestContext,
    clients,
    cadenceProfiles,
    selectedCommercials,
    coverageConstraints,
    predictionResolver: batchPredictionFetcher,
    sharedDepotOrigin,
    cacheStatus: 'plan_miss',
    profileCacheStatus: 'snapshot_ready',
    profileVersion: snapshotState.required_profile_version,
    predictionVersion: `${predictionModelVersion}::${predictionFeaturesVersion}`,
    constraintsVersion
  })

  const plannedClientIds = new Set(
    (Array.isArray(payload?.blocks) ? payload.blocks : [])
      .flatMap(block => Array.isArray(block?.clients) ? block.clients : [])
      .map(client => String(client?.client_id || '').trim())
      .filter(Boolean)
  )
  const historicalProductHistoryByClientId = typeof queryAsync === 'function' && plannedClientIds.size > 0
    ? await perf.run('load_product_history', async () => fetchSalesProductHistoryForClients({
        queryAsync,
        activeClients: clients.filter(client => plannedClientIds.has(String(client?.client_id || '').trim())),
        referenceDate: requestContext.historicalCutoffDate || requestContext.startDate
      }))
    : new Map()
  const enrichedPayload = await perf.run('build_basket_loading_predictions', async () => enrichPayloadWithBasketRecommendations(payload, {
    productHistoryByClientId: historicalProductHistoryByClientId,
    referenceDate: requestContext.historicalCutoffDate || requestContext.startDate
  }))
  const executionReadyPayload = await perf.run('build_visit_feedback_references', async () => enrichPayloadWithPlannedVisitMetadata(enrichedPayload))

  await perf.run('cache_write', async () => {
    sharedCaches.plans.set(planCacheKey, executionReadyPayload)
  })
  const cacheSummary = buildPlanCacheSummary(null)
  perf.record('total_service', Date.now() - totalServiceStartedAt)
  return decorateNextBestVisitPayload({
    ...executionReadyPayload,
    summary: {
      ...(executionReadyPayload.summary || {}),
      profile_snapshot_status: 'ready',
      profile_snapshot_version: snapshotState.required_profile_version,
      source_data_version: predictionSourceDataVersion,
      ...cacheSummary
    },
    profile_snapshot: {
      status: 'ready',
      version: snapshotState.required_profile_version,
      computed_at: snapshotState?.snapshot?.computed_at || null,
      clients_count: Number(snapshotState?.snapshot?.clients_count || cadenceProfiles.length || 0),
      source_data_version: predictionSourceDataVersion
    }
  }, perf.stages())
}

module.exports = {
  DEFAULT_OBJECTIVE_MODE,
  clearNextBestVisitModelDependentCaches,
  ensureNextBestVisitProfilesReady,
  getNextBestVisitReadiness,
  generateNextBestVisitPlan,
  normalizeNextBestVisitRequest,
  runNextBestVisitProfileRebuildNow,
  __testables: {
    buildCandidateDatesByClientId,
    buildClientScopePayload,
    buildCompatibleCommercialCodesByClientId,
    buildDepotByCommercialDate,
    computeOpportunityScoring,
    decorateNextBestVisitPayload,
    buildCachedBatchPredictionResolver,
    buildSnapshotUnavailablePayload,
    querySalesHistoryRowsForClients,
    normalizeSalesHistoryRowsForClients,
    fetchSalesHistoryForClients,
    querySalesProductHistoryRowsForClients,
    normalizeSalesProductHistoryRowsForClients,
    fetchSalesProductHistoryForClients,
    queryVisitHistoryRowsForClients,
    normalizeVisitHistoryRowsForClients,
    fetchVisitHistoryForClients,
    fetchDateSpecificPredictions,
    generateNextBestVisitPlanFromData,
    getNextBestVisitReadiness,
    normalizeRecommendedProducts,
    buildHistoricalRecommendedProducts,
    buildLoadingPredictionForBlock,
    enrichPayloadWithBasketRecommendations,
    enrichPayloadWithPlannedVisitMetadata,
    remapPredictionsByClientId,
    runNextBestVisitProfileRebuildNow,
    summarizePerformanceStages
  }
}

const crypto = require('node:crypto')
const { HIGH_PROBABILITY_THRESHOLD_PERCENT } = require('./next_best_visit_engine')

const ALLOWED_EXECUTION_STATUSES = new Set(['pending', 'visited', 'not_visited'])
const ALLOWED_MONITORING_SEGMENTS = new Set([
  'overall',
  'commercial',
  'planning_date',
  'portfolio_status',
  'prediction_source'
])

function normalizeDateOnly(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  const normalized = String(value || '').trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null
}

function normalizeDateTime(value) {
  if (value == null || String(value).trim() === '') return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('visit_date_actual must be a valid date/time.')
  }
  const year = parsed.getUTCFullYear()
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0')
  const day = String(parsed.getUTCDate()).padStart(2, '0')
  const hours = String(parsed.getUTCHours()).padStart(2, '0')
  const minutes = String(parsed.getUTCMinutes()).padStart(2, '0')
  const seconds = String(parsed.getUTCSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function normalizeNullableText(value) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

function normalizeNullableDecimal(value, fieldName) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a valid positive number or null.`)
  }
  return Number(parsed.toFixed(3))
}

function normalizeNullableBoolean(value, fieldName) {
  if (value == null || value === '') return null
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  throw new Error(`${fieldName} must be true, false, or null.`)
}

function normalizePredictedProducts(products = []) {
  return (Array.isArray(products) ? products : [])
    .map(item => {
      const productId = normalizeNullableText(item?.product_id)
      const productCode = normalizeNullableText(item?.product_code)
      const productLabel = normalizeNullableText(item?.product_label)
      const estimatedQuantity = item?.estimated_quantity == null ? null : Number(item.estimated_quantity)
      if (!productId && !productCode && !productLabel) return null
      return {
        product_id: productId,
        product_code: productCode,
        product_label: productLabel,
        estimated_quantity: Number.isFinite(estimatedQuantity)
          ? Number(estimatedQuantity.toFixed(3))
          : null,
        prediction_source: normalizeNullableText(item?.prediction_source),
        confidence_or_support: item?.confidence_or_support == null
          ? null
          : (Number.isFinite(Number(item.confidence_or_support))
              ? Number(Number(item.confidence_or_support).toFixed(3))
              : normalizeNullableText(item.confidence_or_support))
      }
    })
    .filter(Boolean)
}

function buildPlannedVisitId({
  assigned_slot_id = null,
  client_id = null,
  client_code = null,
  commercial_code = null,
  planned_date = null
} = {}) {
  const canonicalPayload = {
    assigned_slot_id: normalizeNullableText(assigned_slot_id),
    client_id: normalizeNullableText(client_id),
    client_code: normalizeNullableText(client_code),
    commercial_code: normalizeNullableText(commercial_code),
    planned_date: normalizeDateOnly(planned_date)
  }

  const digest = crypto
    .createHash('sha1')
    .update(JSON.stringify(canonicalPayload))
    .digest('hex')

  return `sv2_visit_${digest}`
}

function buildVisitPredictionSnapshot(raw = {}) {
  return {
    predicted_ca: raw?.predicted_ca == null ? null : Number(raw.predicted_ca),
    predicted_ca_if_buy: raw?.predicted_ca_if_buy == null ? null : Number(raw.predicted_ca_if_buy),
    recommended_quantity: raw?.recommended_quantity == null ? null : Number(raw.recommended_quantity),
    predicted_quantity_if_buy: raw?.predicted_quantity_if_buy == null ? null : Number(raw.predicted_quantity_if_buy),
    priority: raw?.purchase_prediction_score == null ? null : Number(raw.purchase_prediction_score),
    purchase_probability: raw?.purchase_probability == null ? null : Number(raw.purchase_probability),
    portfolio_status: normalizeNullableText(raw?.portfolio_status || raw?.final_client_status),
    planned_date: normalizeDateOnly(raw?.assigned_date ?? raw?.planned_date ?? raw?.candidate_date),
    basket_prediction_source: normalizeNullableText(raw?.basket_prediction_source),
    recommended_products: normalizePredictedProducts(raw?.recommended_products ?? raw?.predicted_products)
  }
}

function buildPlannedVisitMetadata(raw = {}) {
  const assignedSlotId = normalizeNullableText(raw?.assigned_slot_id)
  const clientId = normalizeNullableText(raw?.client_id)
  const clientCode = normalizeNullableText(raw?.client_code)
  const commercialCode = normalizeNullableText(raw?.commercial_code)
  const plannedDate = normalizeDateOnly(raw?.assigned_date ?? raw?.planned_date ?? raw?.candidate_date)

  return {
    planned_visit_id: buildPlannedVisitId({
      assigned_slot_id: assignedSlotId,
      client_id: clientId,
      client_code: clientCode,
      commercial_code: commercialCode,
      planned_date: plannedDate
    }),
    assigned_slot_id: assignedSlotId,
    client_id: clientId,
    client_code: clientCode,
    commercial_code: commercialCode,
    planned_date: plannedDate,
    prediction_snapshot: buildVisitPredictionSnapshot({
      ...raw,
      assigned_date: plannedDate
    })
  }
}

function parsePredictionSnapshot(value) {
  if (value == null || value === '') return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

function mapFeedbackRow(row = {}) {
  return {
    planned_visit_id: normalizeNullableText(row.planned_visit_id),
    assigned_slot_id: normalizeNullableText(row.assigned_slot_id),
    client_id: normalizeNullableText(row.client_id),
    client_code: normalizeNullableText(row.client_code),
    commercial_code: normalizeNullableText(row.commercial_code),
    planned_date: normalizeDateOnly(row.planned_date),
    tournee_code: normalizeNullableText(row.tournee_code),
    execution_status: normalizeNullableText(row.execution_status) || 'pending',
    purchase_made: row.purchase_made == null ? null : Boolean(Number(row.purchase_made)),
    actual_ca: row.actual_ca == null ? null : Number(row.actual_ca),
    actual_quantity: row.actual_quantity == null ? null : Number(row.actual_quantity),
    visit_date_actual: row.visit_date_actual == null ? null : String(row.visit_date_actual),
    note: normalizeNullableText(row.note),
    non_visit_reason: normalizeNullableText(row.non_visit_reason),
    no_purchase_reason: normalizeNullableText(row.no_purchase_reason),
    prediction_snapshot: parsePredictionSnapshot(row.prediction_snapshot_json ?? row.prediction_snapshot),
    created_at: row.created_at == null ? null : String(row.created_at),
    updated_at: row.updated_at == null ? null : String(row.updated_at)
  }
}

function assertMatchingIdentity(existing = {}, nextRecord = {}) {
  const fieldDefinitions = [
    ['client_id', normalizeNullableText],
    ['client_code', normalizeNullableText],
    ['commercial_code', normalizeNullableText],
    ['planned_date', normalizeDateOnly],
    ['tournee_code', normalizeNullableText]
  ]

  fieldDefinitions.forEach(([fieldName, normalizer]) => {
    const existingValue = normalizer(existing[fieldName])
    const nextValue = normalizer(nextRecord[fieldName])
    if (existingValue && nextValue && existingValue !== nextValue) {
      const error = new Error(`Existing feedback identity mismatch on ${fieldName}.`)
      error.statusCode = 409
      throw error
    }
  })
}

function normalizeFeedbackUpsertInput(raw = {}, plannedVisitIdFromParams = null) {
  const plannedVisitId = normalizeNullableText(plannedVisitIdFromParams || raw?.planned_visit_id)
  if (!plannedVisitId) {
    throw new Error('planned_visit_id is required.')
  }

  const executionStatus = normalizeNullableText(raw?.execution_status || 'pending')
  if (!ALLOWED_EXECUTION_STATUSES.has(executionStatus)) {
    throw new Error('execution_status must be pending, visited, or not_visited.')
  }

  const record = {
    planned_visit_id: plannedVisitId,
    assigned_slot_id: normalizeNullableText(raw?.assigned_slot_id),
    client_id: normalizeNullableText(raw?.client_id),
    client_code: normalizeNullableText(raw?.client_code),
    commercial_code: normalizeNullableText(raw?.commercial_code),
    planned_date: normalizeDateOnly(raw?.planned_date),
    tournee_code: normalizeNullableText(raw?.tournee_code),
    execution_status: executionStatus,
    purchase_made: normalizeNullableBoolean(raw?.purchase_made, 'purchase_made'),
    actual_ca: normalizeNullableDecimal(raw?.actual_ca, 'actual_ca'),
    actual_quantity: normalizeNullableDecimal(raw?.actual_quantity, 'actual_quantity'),
    visit_date_actual: normalizeDateTime(raw?.visit_date_actual),
    note: normalizeNullableText(raw?.note),
    non_visit_reason: normalizeNullableText(raw?.non_visit_reason),
    no_purchase_reason: normalizeNullableText(raw?.no_purchase_reason),
    prediction_snapshot: parsePredictionSnapshot(raw?.prediction_snapshot)
  }

  if (!record.client_code) {
    throw new Error('client_code is required.')
  }
  if (!record.commercial_code) {
    throw new Error('commercial_code is required.')
  }
  if (!record.planned_date) {
    throw new Error('planned_date is required.')
  }

  if (record.execution_status !== 'visited') {
    record.purchase_made = null
    record.actual_ca = null
    record.actual_quantity = null
    record.visit_date_actual = null
    record.no_purchase_reason = null
  }

  if (record.execution_status === 'visited' && record.purchase_made !== false) {
    record.no_purchase_reason = null
  }

  if (record.execution_status === 'visited') {
    record.non_visit_reason = null
  }

  return record
}

function normalizePendingFeedbackSeed(raw = {}) {
  const normalized = normalizeFeedbackUpsertInput({
    ...raw,
    execution_status: 'pending'
  }, raw?.planned_visit_id)
  const tourneeCode = normalizeNullableText(raw?.tournee_code)

  if (!tourneeCode) {
    throw new Error('tournee_code is required.')
  }

  return {
    ...normalized,
    tournee_code: tourneeCode,
    prediction_snapshot: parsePredictionSnapshot(raw?.prediction_snapshot) ?? buildVisitPredictionSnapshot(raw)
  }
}

function parsePlannedVisitIds(rawIds) {
  if (Array.isArray(rawIds)) {
    return rawIds
      .flatMap(value => String(value || '').split(','))
      .map(value => value.trim())
      .filter(Boolean)
  }
  if (rawIds == null) return []
  return String(rawIds)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

function parseCommercialCodes(rawCodes) {
  if (Array.isArray(rawCodes)) {
    return rawCodes
      .flatMap(value => String(value || '').split(','))
      .map(value => value.trim())
      .filter(Boolean)
  }
  if (rawCodes == null) return []
  return String(rawCodes)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

function parseMonitoringFilters(rawFilters = {}) {
  const startDate = rawFilters?.start_date == null ? null : normalizeDateOnly(rawFilters.start_date)
  const endDate = rawFilters?.end_date == null ? null : normalizeDateOnly(rawFilters.end_date)
  if (rawFilters?.start_date != null && !startDate) {
    throw new Error('start_date must be a valid YYYY-MM-DD date.')
  }
  if (rawFilters?.end_date != null && !endDate) {
    throw new Error('end_date must be a valid YYYY-MM-DD date.')
  }
  if (startDate && endDate && startDate > endDate) {
    throw new Error('start_date must be on or before end_date.')
  }

  return {
    start_date: startDate,
    end_date: endDate,
    commercial_codes: [...new Set(parseCommercialCodes(rawFilters?.commercial_codes))]
  }
}

function toNullableNumber(value) {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function buildSalesVisitMonitoringDetail(record = {}) {
  const snapshot = parsePredictionSnapshot(record?.prediction_snapshot ?? record?.prediction_snapshot_json) ?? {}

  const predictedExpectedVisitCa = toNullableNumber(snapshot?.predicted_ca)
  const predictedCaIfBuy = toNullableNumber(snapshot?.predicted_ca_if_buy)
  const predictedEstimatedQuantity = toNullableNumber(snapshot?.recommended_quantity)
  const predictedQuantityIfBuy = toNullableNumber(snapshot?.predicted_quantity_if_buy)
  const actualCa = toNullableNumber(record?.actual_ca)
  const actualQuantity = toNullableNumber(record?.actual_quantity)
  const executionStatus = normalizeNullableText(record?.execution_status) || 'pending'
  const purchaseMade = record?.purchase_made == null ? null : Boolean(record.purchase_made)

  let expectedCaError = null
  if (predictedExpectedVisitCa != null && executionStatus === 'visited' && purchaseMade != null) {
    if (purchaseMade === false) {
      expectedCaError = Number((predictedExpectedVisitCa - 0).toFixed(3))
    } else if (actualCa != null) {
      expectedCaError = Number((predictedExpectedVisitCa - actualCa).toFixed(3))
    }
  }

  let conditionalCaError = null
  if (predictedCaIfBuy != null && executionStatus === 'visited' && purchaseMade === true && actualCa != null) {
    conditionalCaError = Number((predictedCaIfBuy - actualCa).toFixed(3))
  }

  let quantityError = null
  if (predictedQuantityIfBuy != null && executionStatus === 'visited' && purchaseMade === true && actualQuantity != null) {
    quantityError = Number((predictedQuantityIfBuy - actualQuantity).toFixed(3))
  }

  return {
    planned_visit_id: normalizeNullableText(record?.planned_visit_id),
    client_id: normalizeNullableText(record?.client_id),
    client_code: normalizeNullableText(record?.client_code),
    commercial_code: normalizeNullableText(record?.commercial_code),
    planned_date: normalizeDateOnly(record?.planned_date),
    execution_status: executionStatus,
    purchase_made: purchaseMade,
    predicted: {
      expected_visit_ca: predictedExpectedVisitCa,
      ca_if_buy: predictedCaIfBuy,
      estimated_quantity: predictedEstimatedQuantity,
      quantity_if_buy: predictedQuantityIfBuy,
      priority: toNullableNumber(snapshot?.priority),
      portfolio_status: normalizeNullableText(snapshot?.portfolio_status),
      prediction_source: normalizeNullableText(snapshot?.basket_prediction_source)
    },
    actual: {
      actual_ca: actualCa,
      actual_quantity: actualQuantity
    },
    comparison: {
      expected_ca_error: expectedCaError,
      conditional_ca_error: conditionalCaError,
      quantity_error: quantityError
    }
  }
}

function normalizeProbabilityToPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return null
  const numericValue = Number(value)
  return numericValue > 1 ? numericValue : numericValue * 100
}

function classifySalesVisitOutcome(detail = {}) {
  const executionStatus = String(detail?.execution_status || 'pending')
  const visited = executionStatus === 'visited'
  const purchaseMade = detail?.purchase_made == null ? null : Boolean(detail.purchase_made)
  const predictedProbabilityPercent = normalizeProbabilityToPercent(detail?.predicted?.priority)
  const predictedPurchase = predictedProbabilityPercent == null
    ? null
    : predictedProbabilityPercent >= HIGH_PROBABILITY_THRESHOLD_PERCENT

  let purchaseOutcome = 'unknown'
  if (executionStatus === 'pending') {
    purchaseOutcome = 'pending'
  } else if (!visited) {
    purchaseOutcome = 'not_visited'
  } else if (purchaseMade == null || predictedPurchase == null) {
    purchaseOutcome = 'unknown'
  } else if (predictedPurchase && purchaseMade) {
    purchaseOutcome = 'predicted_and_realized'
  } else if (predictedPurchase && !purchaseMade) {
    purchaseOutcome = 'predicted_not_realized'
  } else if (!predictedPurchase && purchaseMade) {
    purchaseOutcome = 'not_predicted_but_realized'
  } else {
    purchaseOutcome = 'not_predicted_and_not_realized'
  }

  return {
    ...detail,
    visited,
    predicted_purchase_probability_percent: predictedProbabilityPercent,
    predicted_purchase: predictedPurchase,
    purchase_outcome: purchaseOutcome
  }
}

function summarizeSalesVisitOutcomes(rows = []) {
  return rows.reduce((summary, row) => {
    const key = String(row?.purchase_outcome || 'unknown')
    summary[key] = Number(summary[key] || 0) + 1
    return summary
  }, {
    pending: 0,
    not_visited: 0,
    predicted_and_realized: 0,
    predicted_not_realized: 0,
    not_predicted_but_realized: 0,
    not_predicted_and_not_realized: 0,
    unknown: 0
  })
}

function buildValidatedTourComparison(records = []) {
  const rows = (Array.isArray(records) ? records : [])
    .map(buildSalesVisitMonitoringDetail)
    .map(classifySalesVisitOutcome)

  return {
    rows,
    outcome_counts: summarizeSalesVisitOutcomes(rows),
    summary: finalizeSummaryAccumulator(
      rows.reduce((accumulator, detail) => {
        updateExecutionAccumulator(accumulator.execution, detail)
        updatePurchaseAccumulator(accumulator.purchase, detail)
        const expectedActualValue = detail.execution_status === 'visited' && detail.purchase_made != null
          ? (detail.purchase_made ? detail.actual.actual_ca : 0)
          : null
        updateErrorAccumulator(accumulator.ca_expected, detail.predicted.expected_visit_ca, expectedActualValue, { includeMape: true })
        updateErrorAccumulator(
          accumulator.ca_if_buy,
          detail.predicted.ca_if_buy,
          detail.execution_status === 'visited' && detail.purchase_made === true ? detail.actual.actual_ca : null,
          { includeMape: true }
        )
        updateErrorAccumulator(
          accumulator.quantity,
          detail.predicted.quantity_if_buy,
          detail.execution_status === 'visited' && detail.purchase_made === true ? detail.actual.actual_quantity : null,
          { includeMape: false }
        )
        return accumulator
      }, createSummaryAccumulator())
    )
  }
}

function createExecutionAccumulator() {
  return {
    planned: 0,
    visited: 0,
    not_visited: 0,
    pending: 0
  }
}

function createPurchaseAccumulator() {
  return {
    comparable_visits: 0,
    purchases: 0,
    no_purchase: 0
  }
}

function createErrorAccumulator(includeMape = true) {
  return {
    comparable_count: 0,
    absolute_error_sum: 0,
    signed_error_sum: 0,
    mape_valid_count: includeMape ? 0 : null,
    absolute_percentage_error_sum: includeMape ? 0 : null
  }
}

function createSummaryAccumulator() {
  return {
    execution: createExecutionAccumulator(),
    purchase: createPurchaseAccumulator(),
    ca_expected: createErrorAccumulator(true),
    ca_if_buy: createErrorAccumulator(true),
    quantity: createErrorAccumulator(false)
  }
}

function updateExecutionAccumulator(accumulator, detail) {
  accumulator.planned += 1
  if (detail.execution_status === 'visited') {
    accumulator.visited += 1
  } else if (detail.execution_status === 'not_visited') {
    accumulator.not_visited += 1
  } else {
    accumulator.pending += 1
  }
}

function updatePurchaseAccumulator(accumulator, detail) {
  if (detail.execution_status !== 'visited' || detail.purchase_made == null) return
  accumulator.comparable_visits += 1
  if (detail.purchase_made) {
    accumulator.purchases += 1
  } else {
    accumulator.no_purchase += 1
  }
}

function updateErrorAccumulator(accumulator, predictedValue, actualValue, {
  includeMape = true
} = {}) {
  if (predictedValue == null || actualValue == null) return
  const signedError = Number(predictedValue) - Number(actualValue)
  const absoluteError = Math.abs(signedError)
  accumulator.comparable_count += 1
  accumulator.absolute_error_sum += absoluteError
  accumulator.signed_error_sum += signedError
  if (includeMape && Number(actualValue) > 0) {
    accumulator.mape_valid_count += 1
    accumulator.absolute_percentage_error_sum += absoluteError / Number(actualValue)
  }
}

function finalizeExecutionAccumulator(accumulator) {
  return {
    planned: accumulator.planned,
    visited: accumulator.visited,
    not_visited: accumulator.not_visited,
    pending: accumulator.pending,
    execution_rate: accumulator.planned > 0
      ? Number((accumulator.visited / accumulator.planned).toFixed(6))
      : null
  }
}

function finalizePurchaseAccumulator(accumulator) {
  return {
    comparable_visits: accumulator.comparable_visits,
    purchases: accumulator.purchases,
    no_purchase: accumulator.no_purchase,
    conversion_rate: accumulator.comparable_visits > 0
      ? Number((accumulator.purchases / accumulator.comparable_visits).toFixed(6))
      : null
  }
}

function finalizeErrorAccumulator(accumulator, {
  includeMape = true
} = {}) {
  const comparableCount = accumulator.comparable_count
  return {
    comparable_count: comparableCount,
    mae: comparableCount > 0
      ? Number((accumulator.absolute_error_sum / comparableCount).toFixed(6))
      : null,
    bias: comparableCount > 0
      ? Number((accumulator.signed_error_sum / comparableCount).toFixed(6))
      : null,
    mape_valid_count: includeMape ? accumulator.mape_valid_count : undefined,
    mape: includeMape
      ? (accumulator.mape_valid_count > 0
          ? Number((accumulator.absolute_percentage_error_sum / accumulator.mape_valid_count).toFixed(6))
          : null)
      : undefined
  }
}

function finalizeSummaryAccumulator(accumulator) {
  return {
    execution: finalizeExecutionAccumulator(accumulator.execution),
    purchase: finalizePurchaseAccumulator(accumulator.purchase),
    ca_expected: finalizeErrorAccumulator(accumulator.ca_expected, { includeMape: true }),
    ca_if_buy: finalizeErrorAccumulator(accumulator.ca_if_buy, { includeMape: true }),
    quantity: (() => {
      const quantity = finalizeErrorAccumulator(accumulator.quantity, { includeMape: false })
      return {
        comparable_count: quantity.comparable_count,
        mae: quantity.mae,
        bias: quantity.bias
      }
    })()
  }
}

function buildSalesVisitFeedbackMonitoring(details = []) {
  const normalizedDetails = (Array.isArray(details) ? details : []).map(buildSalesVisitMonitoringDetail)
  const overall = createSummaryAccumulator()
  const byCommercial = new Map()
  const byPlanningDate = new Map()
  const byPortfolioStatus = new Map()
  const byPredictionSource = new Map()

  const upsertSegmentAccumulator = (segmentMap, key) => {
    const normalizedKey = normalizeNullableText(key)
    if (!normalizedKey) return null
    if (!segmentMap.has(normalizedKey)) {
      segmentMap.set(normalizedKey, createSummaryAccumulator())
    }
    return segmentMap.get(normalizedKey)
  }

  normalizedDetails.forEach(detail => {
    const accumulators = [
      overall,
      upsertSegmentAccumulator(byCommercial, detail.commercial_code),
      upsertSegmentAccumulator(byPlanningDate, detail.planned_date),
      upsertSegmentAccumulator(byPortfolioStatus, detail.predicted.portfolio_status),
      upsertSegmentAccumulator(byPredictionSource, detail.predicted.prediction_source)
    ].filter(Boolean)

    const expectedActualValue = detail.execution_status === 'visited' && detail.purchase_made != null
      ? (detail.purchase_made ? detail.actual.actual_ca : 0)
      : null

    accumulators.forEach(accumulator => {
      updateExecutionAccumulator(accumulator.execution, detail)
      updatePurchaseAccumulator(accumulator.purchase, detail)
      updateErrorAccumulator(
        accumulator.ca_expected,
        detail.predicted.expected_visit_ca,
        expectedActualValue,
        { includeMape: true }
      )
      updateErrorAccumulator(
        accumulator.ca_if_buy,
        detail.predicted.ca_if_buy,
        detail.execution_status === 'visited' && detail.purchase_made === true ? detail.actual.actual_ca : null,
        { includeMape: true }
      )
      updateErrorAccumulator(
        accumulator.quantity,
        detail.predicted.quantity_if_buy,
        detail.execution_status === 'visited' && detail.purchase_made === true ? detail.actual.actual_quantity : null,
        { includeMape: false }
      )
    })
  })

  const finalizeSegmentMap = segmentMap => Object.fromEntries(
    [...segmentMap.entries()]
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
      .map(([key, accumulator]) => [key, finalizeSummaryAccumulator(accumulator)])
  )

  return {
    rows: normalizedDetails,
    summary: finalizeSummaryAccumulator(overall),
    segmented: {
      by_commercial: finalizeSegmentMap(byCommercial),
      by_planning_date: finalizeSegmentMap(byPlanningDate),
      by_portfolio_status: finalizeSegmentMap(byPortfolioStatus),
      by_prediction_source: finalizeSegmentMap(byPredictionSource)
    }
  }
}

async function fetchSalesVisitFeedbackMonitoringRecords(queryAsync, rawFilters = {}) {
  const filters = parseMonitoringFilters(rawFilters)
  const whereClauses = []
  const params = []

  if (filters.start_date) {
    whereClauses.push('planned_date >= ?')
    params.push(filters.start_date)
  }
  if (filters.end_date) {
    whereClauses.push('planned_date <= ?')
    params.push(filters.end_date)
  }
  if (filters.commercial_codes.length) {
    whereClauses.push(`commercial_code IN (${filters.commercial_codes.map(() => '?').join(', ')})`)
    params.push(...filters.commercial_codes)
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : ''
  const rows = await queryAsync(
    `
      SELECT
        planned_visit_id,
        assigned_slot_id,
        client_id,
        client_code,
        commercial_code,
        planned_date,
        tournee_code,
        execution_status,
        purchase_made,
        actual_ca,
        actual_quantity,
        visit_date_actual,
        note,
        non_visit_reason,
        no_purchase_reason,
        prediction_snapshot_json,
        created_at,
        updated_at
      FROM sales_v2_visit_feedback
      ${whereSql}
      ORDER BY planned_date ASC, commercial_code ASC, client_code ASC, planned_visit_id ASC
    `,
    params
  )

  return {
    filters,
    records: (Array.isArray(rows) ? rows : []).map(mapFeedbackRow)
  }
}

async function getSalesVisitFeedbackMonitoring(queryAsync, rawFilters = {}) {
  const { filters, records } = await fetchSalesVisitFeedbackMonitoringRecords(queryAsync, rawFilters)
  const monitoring = buildSalesVisitFeedbackMonitoring(records)
  return {
    filters,
    summary: monitoring.summary,
    segmented: monitoring.segmented,
    row_count: monitoring.rows.length
  }
}

async function getSalesVisitFeedbackMonitoringDetails(queryAsync, rawFilters = {}) {
  const { filters, records } = await fetchSalesVisitFeedbackMonitoringRecords(queryAsync, rawFilters)
  const monitoring = buildSalesVisitFeedbackMonitoring(records)
  return {
    filters,
    rows: monitoring.rows,
    row_count: monitoring.rows.length
  }
}

async function fetchSalesVisitFeedbackRecords(queryAsync, {
  plannedVisitIds = []
} = {}) {
  const normalizedIds = [...new Set(parsePlannedVisitIds(plannedVisitIds))]
  if (!normalizedIds.length) {
    return []
  }

  const placeholders = normalizedIds.map(() => '?').join(', ')
  const rows = await queryAsync(
    `
      SELECT
        planned_visit_id,
        assigned_slot_id,
        client_id,
        client_code,
        commercial_code,
        planned_date,
        tournee_code,
        execution_status,
        purchase_made,
        actual_ca,
        actual_quantity,
        visit_date_actual,
        note,
        non_visit_reason,
        no_purchase_reason,
        prediction_snapshot_json,
        created_at,
        updated_at
      FROM sales_v2_visit_feedback
      WHERE planned_visit_id IN (${placeholders})
      ORDER BY planned_date ASC, commercial_code ASC, client_code ASC, planned_visit_id ASC
    `,
    normalizedIds
  )

  return (Array.isArray(rows) ? rows : []).map(mapFeedbackRow)
}

async function loadSalesVisitFeedbackRecordsByTourneeCode(queryAsync, tourneeCode) {
  const rows = await queryAsync(
    `
      SELECT
        planned_visit_id,
        assigned_slot_id,
        client_id,
        client_code,
        commercial_code,
        planned_date,
        tournee_code,
        execution_status,
        purchase_made,
        actual_ca,
        actual_quantity,
        visit_date_actual,
        note,
        non_visit_reason,
        no_purchase_reason,
        prediction_snapshot_json,
        created_at,
        updated_at
      FROM sales_v2_visit_feedback
      WHERE tournee_code = ?
      ORDER BY planned_date ASC, commercial_code ASC, client_code ASC, planned_visit_id ASC
    `,
    [tourneeCode]
  )

  return (Array.isArray(rows) ? rows : []).map(mapFeedbackRow)
}

async function loadSalesVisitFeedbackRecordById(queryAsync, plannedVisitId) {
  const rows = await queryAsync(
    `
      SELECT
        planned_visit_id,
        assigned_slot_id,
        client_id,
        client_code,
        commercial_code,
        planned_date,
        tournee_code,
        execution_status,
        purchase_made,
        actual_ca,
        actual_quantity,
        visit_date_actual,
        note,
        non_visit_reason,
        no_purchase_reason,
        prediction_snapshot_json,
        created_at,
        updated_at
      FROM sales_v2_visit_feedback
      WHERE planned_visit_id = ?
      LIMIT 1
    `,
    [plannedVisitId]
  )

  return Array.isArray(rows) && rows[0] ? mapFeedbackRow(rows[0]) : null
}

async function upsertSalesVisitFeedback(queryAsync, rawInput = {}, plannedVisitIdFromParams = null, options = {}) {
  const record = normalizeFeedbackUpsertInput(rawInput, plannedVisitIdFromParams)
  const existing = await loadSalesVisitFeedbackRecordById(queryAsync, record.planned_visit_id)
  if (!existing && options?.updateOnly) {
    const error = new Error(`Aucun feedback Sales V2 valide pour ${record.planned_visit_id}.`)
    error.statusCode = 404
    throw error
  }
  if (existing) {
    assertMatchingIdentity(existing, record)
  }

  const predictionSnapshot = existing?.prediction_snapshot ?? record.prediction_snapshot ?? null
  const predictionSnapshotJson = predictionSnapshot == null ? null : JSON.stringify(predictionSnapshot)

  if (existing) {
    await queryAsync(
      `
        UPDATE sales_v2_visit_feedback
        SET
          execution_status = ?,
          purchase_made = ?,
          actual_ca = ?,
          actual_quantity = ?,
          visit_date_actual = ?,
          note = ?,
          non_visit_reason = ?,
          no_purchase_reason = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE planned_visit_id = ?
      `,
      [
        record.execution_status,
        record.purchase_made == null ? null : (record.purchase_made ? 1 : 0),
        record.actual_ca,
        record.actual_quantity,
        record.visit_date_actual,
        record.note,
        record.non_visit_reason,
        record.no_purchase_reason,
        record.planned_visit_id
      ]
    )
  } else {
    await queryAsync(
      `
        INSERT INTO sales_v2_visit_feedback (
          planned_visit_id,
          assigned_slot_id,
          client_id,
          client_code,
          commercial_code,
          planned_date,
          tournee_code,
          execution_status,
          purchase_made,
          actual_ca,
          actual_quantity,
          visit_date_actual,
          note,
          non_visit_reason,
          no_purchase_reason,
          prediction_snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`,
      [
        record.planned_visit_id,
        record.assigned_slot_id,
        record.client_id,
        record.client_code,
        record.commercial_code,
        record.planned_date,
        record.tournee_code,
        record.execution_status,
        record.purchase_made == null ? null : (record.purchase_made ? 1 : 0),
        record.actual_ca,
        record.actual_quantity,
        record.visit_date_actual,
        record.note,
        record.non_visit_reason,
        record.no_purchase_reason,
        predictionSnapshotJson
      ]
    )
  }

  const saved = await loadSalesVisitFeedbackRecordById(queryAsync, record.planned_visit_id)
  return saved
}

async function replacePendingSalesVisitFeedbackForTournee(queryAsync, {
  tournee_code: rawTourneeCode,
  visits = []
} = {}) {
  const tourneeCode = normalizeNullableText(rawTourneeCode)
  if (!tourneeCode) {
    throw new Error('tournee_code is required.')
  }

  const normalizedVisits = (Array.isArray(visits) ? visits : []).map(visit => normalizePendingFeedbackSeed({
    ...visit,
    tournee_code: tourneeCode
  }))
  if (!normalizedVisits.length) {
    throw new Error('At least one validated Sales V2 visit is required.')
  }

  const plannedVisitIds = normalizedVisits.map(visit => visit.planned_visit_id)
  if (new Set(plannedVisitIds).size !== plannedVisitIds.length) {
    const error = new Error('Duplicate planned_visit_id detected inside the validated Sales V2 block.')
    error.statusCode = 400
    throw error
  }

  const existingByTournee = await loadSalesVisitFeedbackRecordsByTourneeCode(queryAsync, tourneeCode)
  const finalizedRows = existingByTournee.filter(record => String(record.execution_status || 'pending') !== 'pending')
  if (finalizedRows.length) {
    const error = new Error(`Impossible de revalider le bloc Sales V2 ${tourneeCode} car ${finalizedRows.length} visite(s) ont deja un retour terrain.`)
    error.statusCode = 409
    throw error
  }

  const existingById = await fetchSalesVisitFeedbackRecords(queryAsync, {
    plannedVisitIds
  })
  const conflictingTourneeRows = existingById.filter(record => {
    const existingTourneeCode = normalizeNullableText(record?.tournee_code)
    return existingTourneeCode && existingTourneeCode !== tourneeCode
  })
  if (conflictingTourneeRows.length) {
    const conflictIds = conflictingTourneeRows.map(record => record.planned_visit_id).join(', ')
    const error = new Error(`Certaines visites Sales V2 existent deja sur un autre bloc valide: ${conflictIds}.`)
    error.statusCode = 409
    throw error
  }

  await queryAsync(
    `
      DELETE FROM sales_v2_visit_feedback
      WHERE tournee_code = ?
        AND execution_status = 'pending'
    `,
    [tourneeCode]
  )

  for (const visit of normalizedVisits) {
    await upsertSalesVisitFeedback(queryAsync, visit, visit.planned_visit_id)
  }

  const records = await fetchSalesVisitFeedbackRecords(queryAsync, {
    plannedVisitIds
  })

  return {
    savedRows: records.length,
    records
  }
}

module.exports = {
  buildPlannedVisitId,
  buildPlannedVisitMetadata,
  buildVisitPredictionSnapshot,
  buildSalesVisitMonitoringDetail,
  buildSalesVisitFeedbackMonitoring,
  buildValidatedTourComparison,
  classifySalesVisitOutcome,
  fetchSalesVisitFeedbackRecords,
  fetchSalesVisitFeedbackMonitoringRecords,
  getSalesVisitFeedbackMonitoring,
  getSalesVisitFeedbackMonitoringDetails,
  loadSalesVisitFeedbackRecordsByTourneeCode,
  replacePendingSalesVisitFeedbackForTournee,
  upsertSalesVisitFeedback,
  __testables: {
    ALLOWED_MONITORING_SEGMENTS,
    ALLOWED_EXECUTION_STATUSES,
    finalizeSummaryAccumulator,
    loadSalesVisitFeedbackRecordById,
    mapFeedbackRow,
    normalizeFeedbackUpsertInput,
    normalizePendingFeedbackSeed,
    parseMonitoringFilters,
    parsePlannedVisitIds
  }
}

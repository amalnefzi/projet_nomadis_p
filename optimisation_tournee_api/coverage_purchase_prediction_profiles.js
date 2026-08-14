const {
  normalizeClientId,
  normalizeExactClientCode
} = require('./client_identity')

function roundScore(value) {
  return Math.round(Number(value || 0) * 10) / 10
}

function normalizeDateOnly(value) {
  const normalized = String(value || '').trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null
}

function diffDays(startDate, endDate) {
  const start = normalizeDateOnly(startDate)
  const end = normalizeDateOnly(endDate)
  if (!start || !end) return null
  const startTs = Date.parse(`${start}T00:00:00Z`)
  const endTs = Date.parse(`${end}T00:00:00Z`)
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return null
  return Math.max(0, Math.round((endTs - startTs) / 86400000))
}

function buildPredictedProducts(rawDetails = {}) {
  if (!rawDetails || typeof rawDetails !== 'object') return []
  return Object.entries(rawDetails)
    .map(([name, quantity]) => {
      const normalizedName = String(name || '').trim()
      const normalizedQuantity = Number(quantity)
      if (!normalizedName || !Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) return null
      return {
        name: normalizedName,
        quantity: roundScore(normalizedQuantity)
      }
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.quantity || 0) - Number(a.quantity || 0))
}

function toOptionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

async function mapWithConcurrency(items = [], concurrency = 1, iteratee) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return []

  const limit = Math.max(1, Number.parseInt(concurrency, 10) || 1)
  const results = new Array(list.length)
  let nextIndex = 0

  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (true) {
      const currentIndex = nextIndex
      nextIndex += 1
      if (currentIndex >= list.length) {
        return
      }

      results[currentIndex] = await iteratee(list[currentIndex], currentIndex)
    }
  })

  await Promise.all(workers)
  return results
}

function chooseBestPredictionCandidate(candidates = []) {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((left, right) => {
    const scoreDelta = Number(right.purchase_prediction_score || 0) - Number(left.purchase_prediction_score || 0)
    if (scoreDelta !== 0) return scoreDelta
    const leftDate = normalizeDateOnly(left.predicted_purchase_date) || '9999-12-31'
    const rightDate = normalizeDateOnly(right.predicted_purchase_date) || '9999-12-31'
    if (leftDate !== rightDate) return leftDate.localeCompare(rightDate)
    const valueDelta = Number(right.expected_order_value || 0) - Number(left.expected_order_value || 0)
    if (valueDelta !== 0) return valueDelta
    return Number(right.recommended_quantity || 0) - Number(left.recommended_quantity || 0)
  })[0] || null
}

async function loadCoveragePurchasePredictionProfiles({
  clientRows = [],
  planningDates = [],
  referenceDate = null,
  fetchPredictionsForDate,
  scorePredictionCandidate,
  logger = console,
  concurrency = 1
}) {
  const normalizedClientRows = (Array.isArray(clientRows) ? clientRows : [])
    .map(clientRow => ({
      client_id: normalizeClientId(clientRow?.client_id),
      client_code: normalizeExactClientCode(clientRow?.client_code || clientRow?.nbr_client || clientRow?.code),
      client_name: String(clientRow?.nom || clientRow?.client_name || clientRow?.client_code || '').trim() || null,
      latitude: Number.isFinite(Number(clientRow?.latitude)) ? Number(clientRow.latitude) : null,
      longitude: Number.isFinite(Number(clientRow?.longitude)) ? Number(clientRow.longitude) : null
    }))
    .filter(clientRow => clientRow.client_id && clientRow.client_code)

  const clientRowsById = new Map(normalizedClientRows.map(clientRow => [clientRow.client_id, clientRow]))
  const clientRowsByExactCode = new Map()
  const ambiguousExactCodes = new Set()
  normalizedClientRows.forEach(clientRow => {
    const existing = clientRowsByExactCode.get(clientRow.client_code)
    if (existing && existing.client_id !== clientRow.client_id) {
      ambiguousExactCodes.add(clientRow.client_code)
      clientRowsByExactCode.delete(clientRow.client_code)
      return
    }
    if (!ambiguousExactCodes.has(clientRow.client_code)) {
      clientRowsByExactCode.set(clientRow.client_code, clientRow)
    }
  })

  const normalizedPlanningDates = [...new Set(
    (Array.isArray(planningDates) ? planningDates : [])
      .map(value => normalizeDateOnly(value))
      .filter(Boolean)
  )].sort()

  if (!normalizedClientRows.length || !normalizedPlanningDates.length || typeof fetchPredictionsForDate !== 'function') {
    return {
      profiles: [],
      diagnostic: {
        dates_checked: normalizedPlanningDates.length,
        clients_checked: normalizedClientRows.length,
        clients_with_prediction: 0,
        clients_without_prediction: normalizedClientRows.length,
        ambiguous_client_codes: [...ambiguousExactCodes].sort(),
        source: 'dashboard_fetchLoggedAiPredictions'
      }
    }
  }

  const candidatesByClientId = new Map()
  normalizedClientRows.forEach(clientRow => {
    candidatesByClientId.set(clientRow.client_id, [])
  })

  const predictionsByDate = await mapWithConcurrency(
    normalizedPlanningDates,
    concurrency,
    async planningDate => {
      try {
        const predictionPayload = await fetchPredictionsForDate({ date: planningDate })
        const predictions = predictionPayload?.predictions && typeof predictionPayload.predictions === 'object'
          ? predictionPayload.predictions
          : {}
        const maxPredictedValue = Object.values(predictions).reduce(
          (maxValue, entry) => Math.max(maxValue, Number(entry?.chiffre || 0) || 0),
          0
        )
        return {
          planningDate,
          predictionPayload,
          predictionPayloadMeta: {
            maxPredictedValue
          }
        }
      } catch (error) {
        logger?.warn?.(`[COVERAGE_PURCHASE] prediction fetch failed for ${planningDate}: ${error.message}`)
        return {
          planningDate,
          predictionPayload: null,
          predictionPayloadMeta: {
            maxPredictedValue: 0
          }
        }
      }
    }
  )

  for (const predictionEntry of predictionsByDate) {
    const planningDate = predictionEntry?.planningDate
    const predictionPayload = predictionEntry?.predictionPayload
    if (!planningDate || predictionPayload?.status !== 'success' || !predictionPayload?.predictions || typeof predictionPayload.predictions !== 'object') {
      continue
    }

    const predictionPayloadMeta = predictionEntry?.predictionPayloadMeta || { maxPredictedValue: 0 }
    const predictions = predictionPayload.predictions
    for (const [rawClientCode, rawPrediction] of Object.entries(predictions)) {
      const exactClientCode = normalizeExactClientCode(rawClientCode)
      if (!exactClientCode || ambiguousExactCodes.has(exactClientCode)) continue
      const clientRow = clientRowsByExactCode.get(exactClientCode)
      if (!clientRow) continue

      const recommendedQuantity = toOptionalFiniteNumber(rawPrediction?.qte)
      const expectedOrderValue = toOptionalFiniteNumber(rawPrediction?.chiffre)
      const purchaseScore = typeof scorePredictionCandidate === 'function'
        ? scorePredictionCandidate({
            clientRow,
            planningDate,
            rawPrediction,
            predictionPayload,
            predictionPayloadMeta
          })
        : Number(rawPrediction?.score)

      const candidate = {
        client_id: clientRow.client_id,
        client_code: clientRow.client_code,
        purchase_prediction_score: Number.isFinite(purchaseScore) ? roundScore(Math.max(0, purchaseScore)) : null,
        predicted_purchase_date: planningDate,
        purchase_days_until_prediction: diffDays(referenceDate, planningDate),
        recommended_quantity: Number.isFinite(recommendedQuantity) ? roundScore(Math.max(0, recommendedQuantity)) : null,
        expected_order_value: Number.isFinite(expectedOrderValue) ? roundScore(Math.max(0, expectedOrderValue)) : null,
        predicted_products: buildPredictedProducts(rawPrediction?.details),
        purchase_prediction_known: true,
        purchase_prediction_source: 'dashboard_fetchLoggedAiPredictions',
        raw_prediction: rawPrediction
      }

      candidatesByClientId.get(clientRow.client_id)?.push(candidate)
    }
  }

  const profiles = normalizedClientRows.map(clientRow => {
    const bestCandidate = chooseBestPredictionCandidate(candidatesByClientId.get(clientRow.client_id) || [])
    if (!bestCandidate) {
      return {
        client_id: clientRow.client_id,
        client_code: clientRow.client_code,
        purchase_prediction_score: null,
        predicted_purchase_date: null,
        purchase_days_until_prediction: null,
        recommended_quantity: null,
        expected_order_value: null,
        predicted_products: [],
        purchase_prediction_known: false,
        purchase_prediction_source: null
      }
    }

    return {
      client_id: clientRow.client_id,
      client_code: clientRow.client_code,
      purchase_prediction_score: bestCandidate.purchase_prediction_score,
      predicted_purchase_date: bestCandidate.predicted_purchase_date,
      purchase_days_until_prediction: bestCandidate.purchase_days_until_prediction,
      recommended_quantity: bestCandidate.recommended_quantity,
      expected_order_value: bestCandidate.expected_order_value,
      predicted_products: bestCandidate.predicted_products,
      purchase_prediction_known: true,
      purchase_prediction_source: bestCandidate.purchase_prediction_source
    }
  })

  const clientsWithPrediction = profiles.filter(profile => profile.purchase_prediction_known).length
  return {
    profiles,
    diagnostic: {
      dates_checked: normalizedPlanningDates.length,
      clients_checked: normalizedClientRows.length,
      clients_with_prediction: clientsWithPrediction,
      clients_without_prediction: normalizedClientRows.length - clientsWithPrediction,
      ambiguous_client_codes: [...ambiguousExactCodes].sort(),
      source: 'dashboard_fetchLoggedAiPredictions'
    }
  }
}

module.exports = {
  loadCoveragePurchasePredictionProfiles
}

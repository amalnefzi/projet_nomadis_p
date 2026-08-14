function normalizeDateOnly(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = String(value.getFullYear())
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const normalized = String(value || '').trim().slice(0, 10)
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized
  }

  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : null
}

function parseDate(value) {
  const normalized = normalizeDateOnly(value)
  if (!normalized) return null
  const timestamp = Date.parse(`${normalized}T00:00:00Z`)
  return Number.isFinite(timestamp) ? new Date(timestamp) : null
}

function formatDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null
}

function diffDays(startDate, endDate) {
  const start = parseDate(startDate)
  const end = parseDate(endDate)
  if (!start || !end) return null
  return Math.round((end.getTime() - start.getTime()) / 86400000)
}

function addDays(dateValue, days) {
  const date = parseDate(dateValue)
  const numericDays = Number(days)
  if (!date || !Number.isFinite(numericDays)) return null
  date.setUTCDate(date.getUTCDate() + Math.round(numericDays))
  return formatDate(date)
}

function roundNumber(value, digits = 1) {
  const factor = 10 ** digits
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.round(numeric * factor) / factor : null
}

function average(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite)
  if (!numbers.length) return null
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
}

function median(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  if (!numbers.length) return null
  const mid = Math.floor(numbers.length / 2)
  return numbers.length % 2 === 1
    ? numbers[mid]
    : (numbers[mid - 1] + numbers[mid]) / 2
}

function weightedAverageRecent(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite)
  if (!numbers.length) return null
  const recent = numbers.slice(-3)
  const totalWeight = recent.reduce((sum, _, index) => sum + (index + 1), 0)
  const weightedTotal = recent.reduce((sum, value, index) => sum + (value * (index + 1)), 0)
  return totalWeight > 0 ? weightedTotal / totalWeight : null
}

function sampleStdDev(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite)
  if (numbers.length < 2) return null
  const mean = average(numbers)
  const variance = numbers.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (numbers.length - 1)
  return Math.sqrt(variance)
}

function weekdayIndex(dateValue) {
  const date = parseDate(dateValue)
  if (!date) return null
  return date.getUTCDay()
}

function buildUsualWeekdays(purchaseDates = []) {
  const counts = new Map()
  purchaseDates.forEach(dateValue => {
    const day = weekdayIndex(dateValue)
    if (day == null) return
    counts.set(day, (counts.get(day) || 0) + 1)
  })

  const maxCount = [...counts.values()].reduce((maxValue, value) => Math.max(maxValue, value), 0)
  return [...counts.entries()]
    .filter(([, count]) => count >= Math.max(1, Math.ceil(maxCount * 0.6)))
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .map(([day]) => day)
}

function buildTrendLabel(purchaseDates = [], referenceDate) {
  const reference = parseDate(referenceDate)
  if (!reference || purchaseDates.length < 4) return 'insufficient_history'

  const recentStart = new Date(reference.getTime())
  recentStart.setUTCDate(recentStart.getUTCDate() - 90)
  const previousStart = new Date(reference.getTime())
  previousStart.setUTCDate(previousStart.getUTCDate() - 180)

  const recentCount = purchaseDates.filter(dateValue => {
    const date = parseDate(dateValue)
    return date && date >= recentStart && date <= reference
  }).length
  const previousCount = purchaseDates.filter(dateValue => {
    const date = parseDate(dateValue)
    return date && date >= previousStart && date < recentStart
  }).length

  if (recentCount >= previousCount + 2) return 'up'
  if (previousCount >= recentCount + 2) return 'down'
  return 'stable'
}

function buildConfidence(purchaseCount, intervalCount) {
  if (purchaseCount >= 16 && intervalCount >= 8) return 0.9
  if (purchaseCount >= 8 && intervalCount >= 4) return 0.78
  if (purchaseCount >= 4 && intervalCount >= 2) return 0.62
  if (purchaseCount >= 2 && intervalCount >= 1) return 0.42
  return 0.18
}

function buildInactivityRisk(daysSinceLastPurchase, recommendedIntervalDays) {
  if (!Number.isFinite(daysSinceLastPurchase)) return 'unknown'
  if (!Number.isFinite(recommendedIntervalDays) || recommendedIntervalDays <= 0) {
    return daysSinceLastPurchase >= 45 ? 'high' : daysSinceLastPurchase >= 21 ? 'medium' : 'low'
  }
  if (daysSinceLastPurchase >= (recommendedIntervalDays * 1.6)) return 'high'
  if (daysSinceLastPurchase >= (recommendedIntervalDays * 1.15)) return 'medium'
  return 'low'
}

function buildFallbackProfile(client = {}, referenceDate, maxDaysWithoutContact = null, lastContactDate = null) {
  const fallbackInterval = Number.isFinite(Number(maxDaysWithoutContact)) && Number(maxDaysWithoutContact) > 0
    ? Math.round(Number(maxDaysWithoutContact))
    : 21
  const daysSinceLastContact = diffDays(lastContactDate, referenceDate)

  return {
    client_id: String(client.client_id || ''),
    client_code: String(client.client_code || ''),
    last_purchase_date: null,
    purchase_count: 0,
    average_days_between_purchases: null,
    median_days_between_purchases: null,
    recent_weighted_purchase_interval_days: null,
    purchase_frequency_per_week: null,
    purchase_frequency_per_month: null,
    usual_purchase_weekdays: [],
    usual_order_quantity: null,
    usual_order_value: null,
    purchase_interval_variability: null,
    next_purchase_date_estimate: null,
    next_purchase_window_start: null,
    next_purchase_window_end: null,
    cadence_confidence: 0.18,
    history_depth: 0,
    customer_activity_trend: 'insufficient_history',
    inactivity_risk: buildInactivityRisk(daysSinceLastContact, fallbackInterval),
    recommended_visit_interval_days: fallbackInterval,
    fallback_strategy: 'low_history_default_interval',
    last_contact_date: normalizeDateOnly(lastContactDate),
    days_since_last_purchase: null,
    days_since_last_contact: Number.isFinite(daysSinceLastContact) ? daysSinceLastContact : null
  }
}

function buildCadenceProfile({
  client = {},
  salesHistory = [],
  visitHistory = [],
  referenceDate,
  maxDaysWithoutContact = null
}) {
  const normalizedSales = [...(Array.isArray(salesHistory) ? salesHistory : [])]
    .map(row => ({
      purchase_date: normalizeDateOnly(row.purchase_date || row.sale_date || row.date),
      order_value: Number(row.order_value ?? row.net_amount),
      order_quantity: Number(row.order_quantity ?? row.total_quantity),
      commercial_code: String(row.commercial_code || '').trim() || null
    }))
    .filter(row => row.purchase_date)
    .sort((left, right) => left.purchase_date.localeCompare(right.purchase_date))

  const normalizedVisits = [...(Array.isArray(visitHistory) ? visitHistory : [])]
    .map(row => normalizeDateOnly(row.visit_date || row.check_in_at || row.planned_date))
    .filter(Boolean)
    .sort()

  const purchaseDates = normalizedSales.map(row => row.purchase_date)
  const purchaseCount = purchaseDates.length
  const uniquePurchaseDates = [...new Set(purchaseDates)]
  const intervals = []
  for (let index = 1; index < uniquePurchaseDates.length; index += 1) {
    const gapDays = diffDays(uniquePurchaseDates[index - 1], uniquePurchaseDates[index])
    if (Number.isFinite(gapDays) && gapDays > 0) {
      intervals.push(gapDays)
    }
  }

  const lastPurchaseDate = uniquePurchaseDates[uniquePurchaseDates.length - 1] || null
  const lastVisitDate = normalizedVisits[normalizedVisits.length - 1] || null
  const lastContactDate = [lastPurchaseDate, lastVisitDate].filter(Boolean).sort().slice(-1)[0] || null
  if (!purchaseCount) {
    return buildFallbackProfile(client, referenceDate, maxDaysWithoutContact, lastContactDate)
  }

  const averageInterval = average(intervals)
  const medianInterval = median(intervals)
  const recentWeightedInterval = weightedAverageRecent(intervals)
  const effectiveInterval = recentWeightedInterval ?? medianInterval ?? averageInterval ?? (
    Number.isFinite(Number(maxDaysWithoutContact)) ? Number(maxDaysWithoutContact) : 21
  )
  const daysSinceLastPurchase = diffDays(lastPurchaseDate, referenceDate)
  const spanDays = Math.max(1, diffDays(uniquePurchaseDates[0], lastPurchaseDate) || 1)
  const variability = sampleStdDev(intervals)
  const variabilityRatio = variability != null && averageInterval
    ? roundNumber(variability / Math.max(averageInterval, 1), 2)
    : null
  const confidence = buildConfidence(purchaseCount, intervals.length)
  const recommendedVisitIntervalDays = Math.max(2, Math.round(
    Number.isFinite(effectiveInterval)
      ? Math.min(effectiveInterval, Math.max(2, effectiveInterval * 0.9))
      : 21
  ))
  const windowHalfWidth = Math.max(
    1,
    Math.min(
      7,
      Math.round(
        variability != null
          ? Math.max(1, variability)
          : Math.max(1, (effectiveInterval || 7) * 0.2)
      )
    )
  )
  const nextPurchaseDateEstimate = addDays(lastPurchaseDate, effectiveInterval)
  const nextPurchaseWindowStart = nextPurchaseDateEstimate ? addDays(nextPurchaseDateEstimate, -windowHalfWidth) : null
  const nextPurchaseWindowEnd = nextPurchaseDateEstimate ? addDays(nextPurchaseDateEstimate, windowHalfWidth) : null
  const values = normalizedSales.map(row => row.order_value).filter(Number.isFinite)
  const quantities = normalizedSales.map(row => row.order_quantity).filter(Number.isFinite)
  const daysSinceLastContact = diffDays(lastContactDate, referenceDate)

  return {
    client_id: String(client.client_id || ''),
    client_code: String(client.client_code || ''),
    last_purchase_date: lastPurchaseDate,
    purchase_count: purchaseCount,
    average_days_between_purchases: roundNumber(averageInterval, 1),
    median_days_between_purchases: roundNumber(medianInterval, 1),
    recent_weighted_purchase_interval_days: roundNumber(recentWeightedInterval, 1),
    purchase_frequency_per_week: roundNumber((purchaseCount / spanDays) * 7, 2),
    purchase_frequency_per_month: roundNumber((purchaseCount / spanDays) * 30, 2),
    usual_purchase_weekdays: buildUsualWeekdays(uniquePurchaseDates),
    usual_order_quantity: roundNumber(average(quantities), 2),
    usual_order_value: roundNumber(average(values), 2),
    purchase_interval_variability: variabilityRatio,
    next_purchase_date_estimate: nextPurchaseDateEstimate,
    next_purchase_window_start: nextPurchaseWindowStart,
    next_purchase_window_end: nextPurchaseWindowEnd,
    cadence_confidence: roundNumber(confidence, 2),
    history_depth: purchaseCount,
    customer_activity_trend: buildTrendLabel(uniquePurchaseDates, referenceDate),
    inactivity_risk: buildInactivityRisk(daysSinceLastPurchase, recommendedVisitIntervalDays),
    recommended_visit_interval_days: recommendedVisitIntervalDays,
    fallback_strategy: purchaseCount < 3 ? 'light_history_low_confidence' : null,
    last_contact_date: lastContactDate,
    days_since_last_purchase: Number.isFinite(daysSinceLastPurchase) ? daysSinceLastPurchase : null,
    days_since_last_contact: Number.isFinite(daysSinceLastContact) ? daysSinceLastContact : null
  }
}

function buildCadenceProfiles({
  clients = [],
  salesHistoryByClientId = new Map(),
  visitHistoryByClientId = new Map(),
  referenceDate,
  maxDaysWithoutContact = null
}) {
  return (Array.isArray(clients) ? clients : []).map(client => buildCadenceProfile({
    client,
    salesHistory: salesHistoryByClientId.get(String(client.client_id || '')) || [],
    visitHistory: visitHistoryByClientId.get(String(client.client_id || '')) || [],
    referenceDate,
    maxDaysWithoutContact
  }))
}

module.exports = {
  addDays,
  buildCadenceProfile,
  buildCadenceProfiles,
  diffDays,
  formatDate,
  normalizeDateOnly,
  parseDate
}

const {
  addDays,
  buildCadenceProfiles,
  normalizeDateOnly,
  diffDays
} = require('./client_cadence_intelligence')
const {
  buildPlanningDates,
  buildSparseCandidateDateEntries,
  buildSparseCandidateDates,
  buildVisitOpportunities,
  resolveDecisionMode
} = require('./visit_opportunity_builder')
const {
  computeOpportunityScore,
  resolveObjectiveWeightSet
} = require('./visit_opportunity_scoring')
const {
  assignVisitOpportunities,
  buildCommercialSlots
} = require('./visit_assignment_optimizer')
const {
  normalizeExactClientCode
} = require('./client_identity')

const DEFAULT_MAX_CANDIDATE_DATES_PER_CLIENT = 4
const DEFAULT_MINIMUM_CONFIDENCE = 0
const DEFAULT_OBJECTIVE_MODE = 'balanced'
const DEFAULT_DAILY_MAX_MODE = 'flexible'
const HIGH_PROBABILITY_THRESHOLD_PERCENT = 50

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

function toOptionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const values = [lat1, lon1, lat2, lon2].map(Number)
  if (values.some(value => !Number.isFinite(value))) return null
  const [aLat, aLon, bLat, bLon] = values.map(value => value * (Math.PI / 180))
  const dLat = bLat - aLat
  const dLon = bLon - aLon
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat) * Math.cos(bLat) * (Math.sin(dLon / 2) ** 2)
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function normalizeNullablePositiveInt(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
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
  const startDate = normalizeDateOnly(rawBody.start_date || rawBody.planning_start_date) || normalizeDateOnly(new Date().toISOString())
  const historicalCutoffDate = normalizeDateOnly(rawBody.historical_cutoff_date)
  const planningHorizonDays = clamp(
    Number.parseInt(rawBody.planning_horizon_days ?? rawBody.period_days ?? rawBody.horizon_days, 10) || 14,
    1,
    60
  )
  const minVisitsPerDayPreference = Math.max(0, Number.parseInt(rawBody.min_clients ?? rawBody.min_visits, 10) || 0)
  const maxVisitsPerDay = normalizeNullablePositiveInt(rawBody.max_clients ?? rawBody.max_visits)
  const minDailyCaPerCommercial = Number(rawBody.min_daily_ca_per_commercial ?? rawBody.min_daily_ca ?? 0) || 0
  const commercialCodes = [...new Set(
    (Array.isArray(rawBody.commercial_codes) ? rawBody.commercial_codes : Array.isArray(rawBody.commercials) ? rawBody.commercials : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )]

  return {
    startDate,
    historicalCutoffDate,
    planningHorizonDays,
    minVisitsPerDayPreference,
    maxVisitsPerDay,
    minDailyCaPerCommercial: minDailyCaPerCommercial > 0 ? minDailyCaPerCommercial : null,
    commercialCodes,
    objectiveMode: normalizeObjectiveMode(rawBody.objective_mode || rawBody.objective),
    maxDaysWithoutContact: normalizeNullablePositiveInt(rawBody.max_days_without_contact),
    respectAvailability: normalizeAvailabilityMode(rawBody.respect_availability),
    minimumConfidence: clamp(Number(rawBody.minimum_confidence ?? rawBody.min_confidence ?? DEFAULT_MINIMUM_CONFIDENCE) || 0, 0, 100),
    dailyMaxMode: normalizeDailyMaxMode(rawBody.daily_max_mode),
    maxCandidateDatesPerClient: clamp(Number.parseInt(rawBody.max_candidate_dates_per_client, 10) || DEFAULT_MAX_CANDIDATE_DATES_PER_CLIENT, 1, 8)
  }
}

function buildCompatibleCommercialCodesByClientId(clients = [], selectedCommercials = [], coverageConstraints = {}) {
  const selectedCodes = new Set((Array.isArray(selectedCommercials) ? selectedCommercials : []).map(item => String(item.value || item.code || '').trim()).filter(Boolean))
  const map = new Map()

  ;(Array.isArray(clients) ? clients : []).forEach(client => {
    const clientId = String(client.client_id || '')
    const restriction = coverageConstraints?.client_restrictions?.[clientId] || null
    const deniedCodes = Array.isArray(restriction?.denied_commercial_codes)
      ? restriction.denied_commercial_codes
        .map(code => String(code || '').trim())
        .filter(code => selectedCodes.has(code))
      : []
    const deniedCodeSet = new Set(deniedCodes)
    const rawAllowedCodes = Array.isArray(restriction?.allowed_commercial_codes)
      ? restriction.allowed_commercial_codes
        .map(code => String(code || '').trim())
        .filter(Boolean)
      : null
    const hasExplicitAllowedRestriction = Array.isArray(rawAllowedCodes) && rawAllowedCodes.length > 0
    const explicitAllowed = hasExplicitAllowedRestriction
      ? rawAllowedCodes.filter(code => selectedCodes.has(code) && !deniedCodeSet.has(code))
      : []
    const compatibleCodes = hasExplicitAllowedRestriction
      ? explicitAllowed
      : [...selectedCodes].filter(code => !deniedCodeSet.has(code))
    map.set(clientId, [...new Set(compatibleCodes)].sort())
  })

  return map
}

function resolveHistoricalCommercialContinuityCode(client = {}) {
  return String(client.resolved_commercial_code || client.user_code || '').trim() || null
}

function resolveDominantHistoricalCommercialCode({
  historyRows = [],
  selectedCodeSet = new Set(),
  referenceDate = null
} = {}) {
  const statsByCommercialCode = new Map()

  ;(Array.isArray(historyRows) ? historyRows : []).forEach(row => {
    const purchaseDate = normalizeDateOnly(row?.purchase_date)
    if (!purchaseDate) return
    if (referenceDate && purchaseDate > referenceDate) return

    const commercialCode = String(row?.commercial_code || '').trim()
    if (!commercialCode || !selectedCodeSet.has(commercialCode)) return

    const stats = statsByCommercialCode.get(commercialCode) || {
      salesCount: 0,
      mostRecentSaleDate: null
    }
    stats.salesCount += 1
    if (!stats.mostRecentSaleDate || purchaseDate > stats.mostRecentSaleDate) {
      stats.mostRecentSaleDate = purchaseDate
    }
    statsByCommercialCode.set(commercialCode, stats)
  })

  if (!statsByCommercialCode.size) return null

  return [...statsByCommercialCode.entries()]
    .sort(([leftCode, leftStats], [rightCode, rightStats]) => {
      const salesCountDelta = Number(rightStats.salesCount || 0) - Number(leftStats.salesCount || 0)
      if (salesCountDelta !== 0) return salesCountDelta

      const recencyDelta = String(rightStats.mostRecentSaleDate || '').localeCompare(String(leftStats.mostRecentSaleDate || ''))
      if (recencyDelta !== 0) return recencyDelta

      return String(leftCode || '').localeCompare(String(rightCode || ''))
    })[0][0]
}

function buildHistoricalCommercialCircuitProfileByCode({
  clients = [],
  salesHistoryByClientId = new Map(),
  selectedCommercials = [],
  referenceDate = null
} = {}) {
  const selectedCodeSet = new Set(
    (Array.isArray(selectedCommercials) ? selectedCommercials : [])
      .map(item => String(item?.value || item?.code || '').trim())
      .filter(Boolean)
  )
  const normalizedReferenceDate = normalizeDateOnly(referenceDate)
  const pointsByCommercialCode = new Map()

  ;(Array.isArray(clients) ? clients : []).forEach(client => {
    const clientId = String(client?.client_id || '').trim()
    const latitude = toOptionalFiniteNumber(client?.latitude)
    const longitude = toOptionalFiniteNumber(client?.longitude)
    if (!clientId || latitude == null || longitude == null) return

    const historyRows = salesHistoryByClientId instanceof Map
      ? (salesHistoryByClientId.get(clientId) || [])
      : []
    const dominantCommercialCode = resolveDominantHistoricalCommercialCode({
      historyRows,
      selectedCodeSet,
      referenceDate: normalizedReferenceDate
    })
    if (!dominantCommercialCode) return

    const pointsByClientId = pointsByCommercialCode.get(dominantCommercialCode) || new Map()
    if (!pointsByClientId.has(clientId)) {
      pointsByClientId.set(clientId, {
        client_id: clientId,
        latitude,
        longitude
      })
    }
    pointsByCommercialCode.set(dominantCommercialCode, pointsByClientId)
  })

  return new Map(
    [...pointsByCommercialCode.entries()].map(([commercialCode, pointsByClientId]) => [
      commercialCode,
      [...pointsByClientId.values()]
    ])
  )
}

function computeCommercialCircuitDistanceKmForClient({
  client = {},
  commercialCode = '',
  historicalCommercialCircuitProfileByCode = new Map()
} = {}) {
  const clientId = String(client?.client_id || '').trim()
  const latitude = toOptionalFiniteNumber(client?.latitude)
  const longitude = toOptionalFiniteNumber(client?.longitude)
  if (!clientId || latitude == null || longitude == null) return null

  const candidatePoints = historicalCommercialCircuitProfileByCode instanceof Map
    ? (historicalCommercialCircuitProfileByCode.get(String(commercialCode || '').trim()) || [])
    : []
  const nearestDistances = (Array.isArray(candidatePoints) ? candidatePoints : [])
    .filter(point => String(point?.client_id || '').trim() !== clientId)
    .map(point => haversineKm(latitude, longitude, point?.latitude, point?.longitude))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
    .slice(0, 3)

  if (!nearestDistances.length) return null
  return roundScore(nearestDistances.reduce((sum, value) => sum + value, 0) / nearestDistances.length)
}

function buildHistoricalCommercialCircuitDistanceByClientId({
  clients = [],
  compatibleCommercialCodesByClientId = new Map(),
  historicalCommercialCircuitProfileByCode = new Map()
} = {}) {
  const distancesByClientId = new Map()

  ;(Array.isArray(clients) ? clients : []).forEach(client => {
    const clientId = String(client?.client_id || '').trim()
    if (!clientId) return
    const compatibleCommercialCodes = compatibleCommercialCodesByClientId instanceof Map
      ? (compatibleCommercialCodesByClientId.get(clientId) || [])
      : []
    const distancesByCommercialCode = {}
    compatibleCommercialCodes.forEach(commercialCode => {
      const distanceKm = computeCommercialCircuitDistanceKmForClient({
        client,
        commercialCode,
        historicalCommercialCircuitProfileByCode
      })
      if (Number.isFinite(distanceKm)) {
        distancesByCommercialCode[commercialCode] = distanceKm
      }
    })
    distancesByClientId.set(clientId, distancesByCommercialCode)
  })

  return distancesByClientId
}

function attachHistoricalCommercialCircuitDiagnostics({
  opportunities = [],
  clients = [],
  compatibleCommercialCodesByClientId = new Map(),
  salesHistoryByClientId = new Map(),
  selectedCommercials = [],
  referenceDate = null
} = {}) {
  const historicalCommercialCircuitProfileByCode = buildHistoricalCommercialCircuitProfileByCode({
    clients,
    salesHistoryByClientId,
    selectedCommercials,
    referenceDate
  })
  const distancesByClientId = buildHistoricalCommercialCircuitDistanceByClientId({
    clients,
    compatibleCommercialCodesByClientId,
    historicalCommercialCircuitProfileByCode
  })
  const clientsById = new Map(
    (Array.isArray(clients) ? clients : [])
      .map(client => [String(client?.client_id || '').trim(), client])
      .filter(([clientId]) => clientId)
  )

  return (Array.isArray(opportunities) ? opportunities : []).map(opportunity => {
    const clientId = String(opportunity?.client_id || '').trim()
    const client = clientsById.get(clientId) || {}
    const commercialCircuitDistancesKm = distancesByClientId.get(clientId) || {}
    return {
      ...opportunity,
      commercial_circuit_distances_km: { ...commercialCircuitDistancesKm },
      historical_commercial_continuity_code: resolveHistoricalCommercialContinuityCode(client)
    }
  })
}

function buildPortfolioCandidateWindow(profile = {}, candidateDateEntries = []) {
  const candidateEntry = Array.isArray(candidateDateEntries) && candidateDateEntries.length
    ? candidateDateEntries[0]
    : null

  if (candidateEntry) {
    return {
      next_due_date: normalizeDateOnly(candidateEntry.preferred_date || candidateEntry.candidate_date) || null,
      next_due_window_start: normalizeDateOnly(candidateEntry.earliest_allowed_date) || null,
      next_due_window_end: normalizeDateOnly(candidateEntry.latest_allowed_date) || null,
      candidate_date_source: String(candidateEntry.candidate_date_source || '').trim() || null,
      date_flexibility_type: String(candidateEntry.date_flexibility_type || '').trim() || null
    }
  }

  const nextWindowStart = normalizeDateOnly(profile.next_purchase_window_start || profile.next_purchase_date_estimate)
  const nextWindowEnd = normalizeDateOnly(profile.next_purchase_window_end || profile.next_purchase_date_estimate)

  return {
    next_due_date: null,
    next_due_window_start: nextWindowStart || nextWindowEnd || null,
    next_due_window_end: nextWindowEnd || nextWindowStart || null,
    candidate_date_source: null,
    date_flexibility_type: null
  }
}

function resolvePortfolioStatus({
  invalidClientData,
  decisionMode,
  isCapacityIssue,
  isHardConstraint,
  overdueByAge,
  nextDueDate,
  startDate,
  planningEndDate
} = {}) {
  // Le statut métier est calculé ici :
  // - invalid_data / capacity_unplanned / hard_constraint_unplanned sont des statuts post-assignment
  //   lorsqu'un client n'a pas pu être planifié pour une raison dure.
  // - due_now / overdue / due_soon / not_due / exploration_needed sont des statuts pré-assignment
  //   basés sur la fenêtre de prochaine échéance, le profil de cadence et le mode décisionnel.
  if (invalidClientData) return 'invalid_data'
  if (isCapacityIssue) return 'capacity_unplanned'
  if (isHardConstraint) return 'hard_constraint_unplanned'
  if (decisionMode === 'exploration') {
  return 'exploration_needed'
}
  if (nextDueDate && startDate && nextDueDate === startDate) return 'due_now'
  if (nextDueDate && startDate && nextDueDate < startDate) return 'overdue'
  if (overdueByAge) return 'overdue'

  if (nextDueDate && planningEndDate && nextDueDate <= planningEndDate) return 'due_soon'

  return 'not_due'
}

function resolvePortfolioAction(portfolioStatus) {
  switch (String(portfolioStatus || '').trim()) {
    case 'due_now': return 'visit_now'
    case 'due_soon': return 'visit_soon'
    case 'overdue': return 'visit_overdue'
    case 'not_due': return 'wait_next_window'
    case 'exploration_needed': return 'explore_client'
    case 'capacity_unplanned': return 'review_capacity'
    case 'hard_constraint_unplanned': return 'resolve_constraints'
    case 'invalid_data': return 'fix_data'
    default: return 'review_client'
  }
}

function buildPortfolioReasonCodes({
  candidateWindow,
  status,
  decisionMode,
  rejectedReasonCodes = [],
  hasPurchasePrediction,
  hasUsualWeekdays,
  maxDaysWithoutContactGuardrail
} = {}) {
  const codes = new Set()
  if (status === 'invalid_data') codes.add('INVALID_DATA')
  if (status === 'exploration_needed') codes.add('EXPLORATION_NEEDED')
  if (status === 'capacity_unplanned') codes.add('CAPACITY_CONSTRAINT')
  if (status === 'hard_constraint_unplanned') codes.add('HARD_CONSTRAINT')
  if (status === 'overdue') codes.add('OVERDUE')
  if (status === 'not_due') codes.add('NOT_DUE')
  if (status === 'due_now' || status === 'due_soon') codes.add('DUE_IN_HORIZON')
  if (decisionMode === 'predictive') codes.add('PREDICTIVE_MODE')
  if (decisionMode === 'hybrid') codes.add('HYBRID_MODE')
  if (decisionMode === 'exploration') codes.add('EXPLORATION_MODE')
  if (candidateWindow?.candidate_date_source) codes.add(String(candidateWindow.candidate_date_source).trim().toUpperCase())
  if (candidateWindow?.date_flexibility_type) codes.add(String(candidateWindow.date_flexibility_type).trim().toUpperCase())
  if (hasPurchasePrediction) codes.add('PREDICTION_AVAILABLE')
  if (hasUsualWeekdays) codes.add('USUAL_WEEKDAY')
  if (maxDaysWithoutContactGuardrail) codes.add('MAX_DAYS_WITHOUT_CONTACT')
  rejectedReasonCodes.forEach(code => {
    const normalized = String(code || '').trim()
    if (normalized) codes.add(normalized)
  })
  return [...codes].filter(Boolean)
}

function buildPreAssignmentPortfolioDecisionMap({
  clients = [],
  cadenceProfiles = [],
  candidateDateEntriesByClientId = new Map(),
  compatibleCommercialCodesByClientId = new Map(),
  requestContext = {},
  planningDates = []
} = {}) {
  const clientsById = buildClientIndex(clients)
  const profileByClientId = new Map(
    (Array.isArray(cadenceProfiles) ? cadenceProfiles : [])
      .map(profile => [String(profile?.client_id || '').trim(), profile])
      .filter(([clientId]) => clientId)
  )
  const decisionsByClientId = new Map()

  clientsById.forEach((client, clientId) => {
    const profile = profileByClientId.get(clientId) || {}
    const candidateDateEntries = candidateDateEntriesByClientId.get(clientId) || []
    const compatibleCommercialCodes = compatibleCommercialCodesByClientId.get(clientId) || []
    decisionsByClientId.set(clientId, buildPortfolioDecision({
      client,
      profile,
      candidateDateEntries,
      selectedVisits: [],
      rejectedOpportunities: [],
      compatibleCommercialCodes,
      requestContext,
      planningDates
    }))
  })

  return decisionsByClientId
}

function buildPortfolioDecision({
  client = {},
  profile = {},
  candidateDateEntries = [],
  selectedVisits = [],
  rejectedOpportunities = [],
  compatibleCommercialCodes = [],
  requestContext = {},
  planningDates = []
} = {}) {
  const startDate = normalizeDateOnly(requestContext.startDate)
  const planningEndDate = normalizeDateOnly(planningDates[planningDates.length - 1])
  const hasSelectedVisit = Array.isArray(selectedVisits) && selectedVisits.length > 0
    let rejectedReasonCodes = [...new Set((Array.isArray(rejectedOpportunities) ? rejectedOpportunities : []).flatMap(item => item?.rejection_reason_codes || []))]
  const candidateWindow = buildPortfolioCandidateWindow(profile, candidateDateEntries)
  const decisionMode = String(profile.decision_mode || resolveDecisionMode(profile)).trim() || 'predictive'
  const _rvid = profile.recommended_visit_interval_days
  const recommendedVisitIntervalDays = (_rvid === null || _rvid === undefined || _rvid === '')
    ? null
    : (Number.isFinite(Number(_rvid)) ? Number(_rvid) : null)
  const _cad = profile.cadence_confidence
  const cadenceConfidence = (_cad === null || _cad === undefined || _cad === '')
    ? null
    : (Number.isFinite(Number(_cad)) ? Number(_cad) : null)
  const lastPurchaseDate = normalizeDateOnly(profile.last_purchase_date || profile.last_sale_date || null)
  const lastVisitDate = normalizeDateOnly(client.last_real_visit_date || client.last_visit_date || null)
  const overdueByAge = Boolean(
    lastPurchaseDate &&
    Number.isFinite(Number(recommendedVisitIntervalDays)) &&
    startDate &&
    diffDays(startDate, addDays(lastPurchaseDate, recommendedVisitIntervalDays)) < 0
  )
    const isCapacityIssue = Boolean(!hasSelectedVisit && rejectedReasonCodes.includes('CAPACITY_REACHED'))
    const isHardConstraint = Boolean(!hasSelectedVisit && rejectedReasonCodes.includes('EXPLICIT_UNAVAILABLE'))

    // Determine pre-assignment (business) status first — this must NOT depend on compatibleCommercialCodes.
    const hasInvalidClientData = !String(client.client_id || '').trim() || !String(client.client_code || '').trim()
    const preAssignmentStatus = resolvePortfolioStatus({
      invalidClientData: hasInvalidClientData,
      decisionMode,
      isCapacityIssue,
      isHardConstraint,
      overdueByAge,
      nextDueDate: candidateWindow.next_due_date,
      startDate,
      planningEndDate
    })

    // Decide whether a visit needs to be planned based on pre-assignment status
    const visitRequiredStatuses = new Set(['due_now', 'due_soon', 'overdue', 'exploration_needed'])
    let status = preAssignmentStatus

    // If a visit is required but there are no compatible commercials, mark as hard_constraint_unplanned
    if (
      visitRequiredStatuses.has(preAssignmentStatus) &&
      !hasSelectedVisit &&
      Array.isArray(compatibleCommercialCodes) &&
      compatibleCommercialCodes.length === 0
    ) {
      status = 'hard_constraint_unplanned'
      // ensure reason code is reported
      if (!rejectedReasonCodes.includes('NO_COMPATIBLE_COMMERCIAL')) rejectedReasonCodes.push('NO_COMPATIBLE_COMMERCIAL')
    }

  const nextAction = resolvePortfolioAction(status)
  const reasonCodes = buildPortfolioReasonCodes({
    candidateWindow,
    status,
    decisionMode,
    rejectedReasonCodes,
    hasPurchasePrediction: Boolean(profile.purchase_prediction_known || profile.purchase_prediction_score != null),
    hasUsualWeekdays: Array.isArray(profile.usual_purchase_weekdays) && profile.usual_purchase_weekdays.length > 0,
    maxDaysWithoutContactGuardrail: Boolean(candidateWindow.candidate_date_source === 'max_days_without_contact' || profile.max_days_without_contact)
  })
  const priorityScore = Number.isFinite(Number(profile.purchase_prediction_score))
    ? Number(profile.purchase_prediction_score)
    : Number.isFinite(Number(cadenceConfidence))
      ? roundScore(cadenceConfidence * 100)
      : null
  const dataConfidence = cadenceConfidence

  return {
    portfolio_status: status,
    next_action: nextAction,
    next_due_date: candidateWindow.next_due_date,
    next_due_window_start: candidateWindow.next_due_window_start,
    next_due_window_end: candidateWindow.next_due_window_end,
    decision_mode: decisionMode,
    recommended_visit_interval_days: recommendedVisitIntervalDays,
    cadence_confidence: cadenceConfidence,
    last_purchase_date: lastPurchaseDate,
    last_visit_date: lastVisitDate,
    reason_codes: reasonCodes,
    priority_score: priorityScore,
    data_confidence: dataConfidence
  }
}

function buildPortfolioSummary(portfolioStatusCounts = {}, activeClientsCount = 0) {
  const summary = {
    total_clients: Number(activeClientsCount || 0),
    active_clients_count: Number(activeClientsCount || 0),
    due_now_count: Number(portfolioStatusCounts.due_now || 0),
    due_soon_count: Number(portfolioStatusCounts.due_soon || 0),
    not_due_count: Number(portfolioStatusCounts.not_due || 0),
    overdue_count: Number(portfolioStatusCounts.overdue || 0),
    exploration_needed_count: Number(portfolioStatusCounts.exploration_needed || 0),
    capacity_unplanned_count: Number(portfolioStatusCounts.capacity_unplanned || 0),
    hard_constraint_unplanned_count: Number(portfolioStatusCounts.hard_constraint_unplanned || 0),
    invalid_data_count: Number(portfolioStatusCounts.invalid_data || 0)
  }
  const total = Object.values(summary).slice(2).reduce((sum, value) => sum + Number(value || 0), 0)
  summary.portfolio_invariant_status = summary.total_clients === total ? 'passed' : 'failed'
  summary.portfolio_invariant_difference = Number(summary.total_clients || 0) - total
  return summary
}

function buildFeasibility({
  requestContext = {},
  selectedCommercials = [],
  portfolioSummary = {},
  clientFinalDecisions = {}
} = {}) {
  const selectedCommercialsCount = Math.max(0, Array.isArray(selectedCommercials) ? selectedCommercials.length : 0)
  const horizonDays = Math.max(0, Number(requestContext.planningHorizonDays || 0))
  const targetCapacity = selectedCommercialsCount > 0 && Number.isFinite(Number(requestContext.minVisitsPerDayPreference))
    ? selectedCommercialsCount * horizonDays * Number(requestContext.minVisitsPerDayPreference)
    : 0
  const maxVisitsPerDay = Number.isFinite(Number(requestContext.maxVisitsPerDay))
    ? Number(requestContext.maxVisitsPerDay)
    : null
  const maximumCapacity = maxVisitsPerDay != null
    ? selectedCommercialsCount * horizonDays * maxVisitsPerDay
    : null
  const requiredVisitsInHorizon = (
    Number(portfolioSummary.due_now_count || 0) +
    Number(portfolioSummary.due_soon_count || 0) +
    Number(portfolioSummary.overdue_count || 0) +
    Number(portfolioSummary.capacity_unplanned_count || 0) +
    Number(portfolioSummary.hard_constraint_unplanned_count || 0)
  )

const requiredPortfolioStatuses = new Set([
  'due_now',
  'due_soon',
  'overdue',
  'capacity_unplanned',
  'hard_constraint_unplanned'
])

const selectedRequiredClientsCount = Object.values(
  clientFinalDecisions || {}
).filter(decision => (
  decision?.final_client_status === 'selected' &&
  requiredPortfolioStatuses.has(
    String(decision?.portfolio_status || '')
  )
)).length

const requiredUnplannedClientsCount = Math.max(
  0,
  requiredVisitsInHorizon - selectedRequiredClientsCount
)

  const capacityDeficit = maximumCapacity != null
    ? Math.max(0, requiredVisitsInHorizon - maximumCapacity)
    : null
  const capacitySurplus = maximumCapacity != null
    ? Math.max(0, maximumCapacity - requiredVisitsInHorizon)
    : null
  const recommendedMinimumHorizonDays = capacityDeficit != null && capacityDeficit > 0 && maxVisitsPerDay != null && selectedCommercialsCount > 0
    ? Math.ceil(requiredVisitsInHorizon / (selectedCommercialsCount * maxVisitsPerDay))
    : null
  const feasibilityStatus = selectedCommercialsCount === 0
    ? 'no_commercials_selected'
    : maximumCapacity != null && capacityDeficit > 0
      ? 'capacity_insufficient'
      : 'feasible'

  return {
    required_visits_in_horizon: requiredVisitsInHorizon,

    selected_required_clients_count:
    selectedRequiredClientsCount,

    required_unplanned_clients_count:
    requiredUnplannedClientsCount,

    target_capacity: targetCapacity,
    maximum_capacity: maximumCapacity,
    capacity_deficit: capacityDeficit,
    capacity_surplus: capacitySurplus,
    recommended_minimum_horizon_days: recommendedMinimumHorizonDays,
    feasibility_status: feasibilityStatus,
    selected_commercials_count: selectedCommercialsCount,
    horizon_days: horizonDays,
    commercial_day_slots: selectedCommercialsCount * horizonDays
  }
}

function buildExplorationGroupKey(client = {}, compatibleCommercialCodes = []) {
  const routingScope = [
    client.commercial_zone,
    client.delegation,
    client.region,
    client.routing_code
  ].map(value => String(value || '').trim()).filter(Boolean).join('::') || 'unscoped'
  return [
    [...(Array.isArray(compatibleCommercialCodes) ? compatibleCommercialCodes : [])].sort().join('|') || 'all',
    routingScope
  ].join('::')
}

function buildStableExplorationOffset(groupKey, workingDates = []) {
  if (!Array.isArray(workingDates) || !workingDates.length) return 0
  let hash = 0
  const normalized = String(groupKey || '')
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash * 31) + normalized.charCodeAt(index)) % 2147483647
  }
  return Math.abs(hash) % workingDates.length
}

function resolveWorkingDatesForClient({
  planningDates = [],
  compatibleCommercialCodes = [],
  coverageConstraints = {}
} = {}) {
  const constraintsByCommercial = coverageConstraints?.commercials || {}
  const workingDates = new Set()
  ;(Array.isArray(compatibleCommercialCodes) ? compatibleCommercialCodes : []).forEach(code => {
    const constraint = constraintsByCommercial[String(code || '')] || {}
    const availableDates = Array.isArray(constraint.available_dates) && constraint.available_dates.length
      ? constraint.available_dates
      : planningDates
    const unavailableDates = new Set(Array.isArray(constraint.unavailable_dates) ? constraint.unavailable_dates : [])
    availableDates.forEach(date => {
      if (planningDates.includes(date) && !unavailableDates.has(date)) {
        workingDates.add(date)
      }
    })
  })
  return [...workingDates].sort()
}

function buildExplorationWindowOverrides({
  cadenceProfiles = [],
  clients = [],
  requestContext = {},
  planningDates = [],
  coverageConstraints = {},
  compatibleCommercialCodesByClientId = new Map()
} = {}) {
  const profilesByClientId = new Map((Array.isArray(cadenceProfiles) ? cadenceProfiles : []).map(profile => [String(profile.client_id || ''), profile]))
  const clientsById = new Map((Array.isArray(clients) ? clients : []).map(client => [String(client.client_id || ''), client]))
  const groups = new Map()

  profilesByClientId.forEach((profile, clientId) => {
    if (!profile) return
    if (String(profile.last_purchase_date || '').trim()) return
    if (!(Number(profile.purchase_count || 0) <= 0 && Number(profile.history_depth || 0) <= 0)) return
    const client = clientsById.get(clientId) || {}
    const compatibleCommercialCodes = compatibleCommercialCodesByClientId.get(clientId) || []
    const workingDates = resolveWorkingDatesForClient({
      planningDates,
      compatibleCommercialCodes,
      coverageConstraints
    })
    const effectiveDates = workingDates.length ? workingDates : planningDates
    if (!effectiveDates.length) return
    const groupKey = buildExplorationGroupKey(client, compatibleCommercialCodes)
    const list = groups.get(groupKey) || []
    list.push({
      clientId,
      clientCode: String(client.client_code || profile.client_code || ''),
      workingDates: effectiveDates
    })
    groups.set(groupKey, list)
  })

  const overrides = new Map()
  groups.forEach((groupEntries, groupKey) => {
    const sortedGroup = [...groupEntries].sort((left, right) => {
      const leftKey = `${String(left.clientId || '')}::${String(left.clientCode || '')}`
      const rightKey = `${String(right.clientId || '')}::${String(right.clientCode || '')}`
      return leftKey.localeCompare(rightKey)
    })
    const commonDates = sortedGroup[0]?.workingDates || planningDates
    const offset = buildStableExplorationOffset(`${groupKey}::${requestContext.startDate || ''}`, commonDates)
    sortedGroup.forEach((entry, index) => {
      const effectiveDates = entry.workingDates.length ? entry.workingDates : commonDates
      const anchorDate = effectiveDates[(offset + index) % effectiveDates.length] || effectiveDates[0] || null
      if (!anchorDate) return
      const anchorPosition = planningDates.indexOf(anchorDate)
      const earliestAllowedDate = anchorPosition > 0 ? planningDates[anchorPosition - 1] : anchorDate
      const latestAllowedDate = anchorPosition >= 0 && anchorPosition < planningDates.length - 1
        ? planningDates[anchorPosition + 1]
        : anchorDate
      overrides.set(String(entry.clientId || ''), {
        preferredDate: anchorDate,
        earliestAllowedDate,
        latestAllowedDate
      })
    })
  })

  return overrides
}

function buildCandidateDateEntriesByClientId(
  cadenceProfiles = [],
  requestContext = {},
  planningDates = null,
  clients = [],
  options = {}
) {
  const clientById = new Map((Array.isArray(clients) ? clients : []).map(client => [String(client.client_id || ''), client]))
  const explorationWindowOverrides = buildExplorationWindowOverrides({
    cadenceProfiles,
    clients,
    requestContext,
    planningDates: Array.isArray(planningDates) ? planningDates : buildPlanningDates(requestContext.startDate, requestContext.planningHorizonDays),
    coverageConstraints: options.coverageConstraints || {},
    compatibleCommercialCodesByClientId: options.compatibleCommercialCodesByClientId instanceof Map
      ? options.compatibleCommercialCodesByClientId
      : new Map()
  })
  const map = new Map()
  ;(Array.isArray(cadenceProfiles) ? cadenceProfiles : []).forEach(profile => {
    map.set(String(profile.client_id || ''), buildSparseCandidateDateEntries(profile, {
      startDate: requestContext.startDate,
      planningHorizonDays: requestContext.planningHorizonDays,
      maxCandidateDatesPerClient: requestContext.maxCandidateDatesPerClient,
      maxDaysWithoutContact: requestContext.maxDaysWithoutContact,
      planningDates,
      clientMetadata: clientById.get(String(profile.client_id || '')) || {},
      explorationWindowOverride: explorationWindowOverrides.get(String(profile.client_id || '')) || null
    }))
  })
  return map
}

function buildCandidateDatesByClientId(cadenceProfiles = [], requestContext = {}, planningDates = null, clients = []) {
  const entryMap = buildCandidateDateEntriesByClientId(cadenceProfiles, requestContext, planningDates, clients)
  const map = new Map()
  entryMap.forEach((entries, clientId) => {
    map.set(clientId, [...new Set((Array.isArray(entries) ? entries : []).map(entry => entry.candidate_date))])
  })
  return map
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

function buildPredictionResolverFromRecords(records = []) {
  const normalizedRecords = Array.isArray(records) ? records : []
  const groupedByDate = normalizedRecords.reduce((map, item) => {
    const date = normalizeDateOnly(item?.candidate_date || item?.target_date || item?.date)
    if (!date) return map
    const list = map.get(date) || []
    list.push(item)
    map.set(date, list)
    return map
  }, new Map())

  return async ({ targetDate, clientCodes = [] }) => {
    const date = normalizeDateOnly(targetDate)
    const rows = groupedByDate.get(date) || []
    const byCode = new Map(rows.map(item => [normalizeExactClientCode(item.client_code), item]))
    const predictions = clientCodes.map(clientCode => {
      const code = normalizeExactClientCode(clientCode)
      const record = byCode.get(code) || null
      if (!record) {
        return {
          client_id: null,
          client_code: code,
          purchase_probability: null,
          predicted_ca: null,
          recommended_quantity: null,
          model_confidence: null,
          score: null,
          vip: null,
          probability_model_only: null,
          habit_score: null,
          recency_score: null,
          prediction_source: 'fixture_missing_prediction'
        }
      }
      return {
        client_id: record.client_id || null,
        client_code: code,
        purchase_probability: record.purchase_probability ?? null,
        predicted_ca: record.predicted_ca ?? null,
        recommended_quantity: record.recommended_quantity ?? null,
        model_confidence: record.model_confidence ?? null,
        score: record.score ?? record.purchase_probability ?? null,
        vip: record.vip ?? null,
        probability_model_only: record.probability_model_only ?? null,
        habit_score: record.habit_score ?? null,
        recency_score: record.recency_score ?? null,
        prediction_source: record.prediction_source || 'fixture_prediction'
      }
    })
    const knownCount = predictions.filter(item => item.purchase_probability != null).length
    return {
      status: 'success',
      predictions,
      meta: {
        prediction_requested_clients_count: clientCodes.length,
        prediction_returned_clients_count: predictions.length,
        prediction_known_count: knownCount,
        prediction_null_count: Math.max(0, predictions.length - knownCount),
        top_k_truncation_detected: false
      }
    }
  }
}

async function resolvePredictionsForCandidateDates({
  clients = [],
  candidateDatesByClientId = new Map(),
  predictionResolver,
  perfTracker = null
}) {
  const predictionsByClientDate = new Map()
  const coverageByDate = []
  const predictionRequestsByDate = await (perfTracker
    ? perfTracker.run('prediction_payload_build', async () => {
      const byDate = invertCandidateDatesByClientId(clients, candidateDatesByClientId)
      return [...byDate.keys()].sort().map(date => ({
        date,
        requested_entries: byDate.get(date) || [],
        requested_client_codes: (byDate.get(date) || []).map(entry => entry.client_code)
      }))
    })
    : Promise.resolve((() => {
      const byDate = invertCandidateDatesByClientId(clients, candidateDatesByClientId)
      return [...byDate.keys()].sort().map(date => ({
        date,
        requested_entries: byDate.get(date) || [],
        requested_client_codes: (byDate.get(date) || []).map(entry => entry.client_code)
      }))
    })()))

  const predictionResponses = []
  for (const requestEntry of predictionRequestsByDate) {
    predictionResponses.push({
      date: requestEntry.date,
      requested_client_codes: requestEntry.requested_client_codes,
      payload: await predictionResolver({
        targetDate: requestEntry.date,
        clientCodes: requestEntry.requested_client_codes,
        requestedClients: requestEntry.requested_entries
      })
    })
  }

  await (perfTracker
    ? perfTracker.run('prediction_response_mapping', async () => {
      predictionResponses.forEach(({ date, requested_client_codes: requestedClientCodes, payload }) => {
        const predictions = Array.isArray(payload?.predictions) ? payload.predictions : []
        const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {}

        predictions.forEach(prediction => {
          const clientCode = normalizeExactClientCode(prediction?.client_code)
          if (!clientCode) return
          predictionsByClientDate.set(`${clientCode}::${date}`, {
            purchase_prediction_score: prediction?.score ?? prediction?.purchase_probability,
            purchase_probability: prediction?.purchase_probability,
            expected_order_value: prediction?.predicted_ca,
            predicted_ca_if_buy: prediction?.predicted_ca_if_buy ?? null,
            recommended_quantity: prediction?.recommended_quantity,
            predicted_quantity_if_buy: prediction?.predicted_quantity_if_buy ?? null,
            predicted_products: Array.isArray(prediction?.predicted_products) ? prediction.predicted_products : [],
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
          top_k_truncation_detected: Boolean(meta.top_k_truncation_detected),
          prediction_cache_hit_count: Number(meta.prediction_cache_hit_count || 0),
          prediction_cache_miss_count: Number(meta.prediction_cache_miss_count || 0),
          prediction_cache_hit_rate: meta.prediction_cache_hit_rate == null ? null : Number(meta.prediction_cache_hit_rate),
          python_requested_count: Number(meta.python_requested_count || 0),
          python_batch_total_ms: meta.batch_total_ms == null ? null : Number(meta.batch_total_ms),
          python_model_load_ms: meta.model_load_ms == null ? null : Number(meta.model_load_ms),
          python_feature_lookup_ms: meta.feature_lookup_ms == null ? null : Number(meta.feature_lookup_ms),
          python_prediction_compute_ms: meta.prediction_compute_ms == null ? null : Number(meta.prediction_compute_ms),
          python_serialization_ms: meta.serialization_ms == null ? null : Number(meta.serialization_ms)
        })
      })
    })
    : Promise.resolve(predictionResponses.forEach(({ date, requested_client_codes: requestedClientCodes, payload }) => {
      const predictions = Array.isArray(payload?.predictions) ? payload.predictions : []
      const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {}

      predictions.forEach(prediction => {
        const clientCode = normalizeExactClientCode(prediction?.client_code)
        if (!clientCode) return
        predictionsByClientDate.set(`${clientCode}::${date}`, {
          purchase_prediction_score: prediction?.score ?? prediction?.purchase_probability,
          purchase_probability: prediction?.purchase_probability,
          expected_order_value: prediction?.predicted_ca,
          predicted_ca_if_buy: prediction?.predicted_ca_if_buy ?? null,
          recommended_quantity: prediction?.recommended_quantity,
          predicted_quantity_if_buy: prediction?.predicted_quantity_if_buy ?? null,
          predicted_products: Array.isArray(prediction?.predicted_products) ? prediction.predicted_products : [],
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
        top_k_truncation_detected: Boolean(meta.top_k_truncation_detected),
        prediction_cache_hit_count: Number(meta.prediction_cache_hit_count || 0),
        prediction_cache_miss_count: Number(meta.prediction_cache_miss_count || 0),
        prediction_cache_hit_rate: meta.prediction_cache_hit_rate == null ? null : Number(meta.prediction_cache_hit_rate),
        python_requested_count: Number(meta.python_requested_count || 0),
        python_batch_total_ms: meta.batch_total_ms == null ? null : Number(meta.batch_total_ms),
        python_model_load_ms: meta.model_load_ms == null ? null : Number(meta.model_load_ms),
        python_feature_lookup_ms: meta.feature_lookup_ms == null ? null : Number(meta.feature_lookup_ms),
        python_prediction_compute_ms: meta.prediction_compute_ms == null ? null : Number(meta.prediction_compute_ms),
        python_serialization_ms: meta.serialization_ms == null ? null : Number(meta.serialization_ms)
      })
    })))

  return {
    predictionsByClientDate,
    coverageByDate
  }
}

function remapPredictionsByClientId(clients = [], predictionsByCodeDate = new Map()) {
  const map = new Map()
  const clientIdByCode = new Map(
    (Array.isArray(clients) ? clients : [])
      .map(client => [normalizeExactClientCode(client.client_code), String(client.client_id || '')])
      .filter(([clientCode, clientId]) => clientCode && clientId)
  )
  predictionsByCodeDate.forEach((value, key) => {
    const separatorIndex = key.indexOf('::')
    if (separatorIndex <= 0) return
    const clientCode = key.slice(0, separatorIndex)
    const clientId = clientIdByCode.get(clientCode)
    if (!clientId) return
    const date = key.slice(separatorIndex + 2)
    map.set(`${clientId}::${date}`, value)
  })
  return map
}

function buildDepotByCommercialDate(coverageConstraints = {}, selectedCommercials = [], planningDates = [], sharedDepot = null) {
  const map = new Map()
  ;(Array.isArray(selectedCommercials) ? selectedCommercials : []).forEach(commercial => {
    const code = String(commercial.value || commercial.code || '')
    const entry = coverageConstraints?.commercials?.[code] || {}
    planningDates.forEach(date => {
      const depot = entry.depot_by_date?.[date] || sharedDepot || null
      if (!depot) return
      map.set(`${code}::${date}`, depot)
    })
  })
  return map
}

function buildAvailabilitySignalMap(signals = []) {
  const map = new Map()
  ;(Array.isArray(signals) ? signals : []).forEach(signal => {
    const clientId = String(signal.client_id || '')
    const clientCode = normalizeExactClientCode(signal.client_code)
    const date = normalizeDateOnly(signal.date)
    const status = String(signal.status || '').trim().toLowerCase()
    if (!date || !status) return
    if (clientId) {
      map.set(`${clientId}::${date}`, {
        status,
        source: signal.source || null
      })
    }
    if (clientCode) {
      map.set(`${clientCode}::${date}`, {
        status,
        source: signal.source || null
      })
    }
  })
  return map
}

function buildClientIndex(clients = []) {
  return new Map(
    (Array.isArray(clients) ? clients : [])
      .map(client => [String(client?.client_id || '').trim(), client])
      .filter(([clientId]) => clientId)
  )
}

function groupSelectedVisitsByClientId(blocks = []) {
  const map = new Map()
  ;(Array.isArray(blocks) ? blocks : []).forEach(block => {
    ;(Array.isArray(block?.clients) ? block.clients : []).forEach(client => {
      const clientId = String(client?.client_id || '').trim()
      if (!clientId) return
      const list = map.get(clientId) || []
      list.push({
        ...client,
        assigned_date: block.date,
        assigned_commercial_code: block.commercial_code,
        assigned_slot_id: block.slot_id
      })
      map.set(clientId, list)
    })
  })
  return map
}

function groupRejectedOpportunitiesByClientId(rejectedOpportunities = []) {
  const map = new Map()
  ;(Array.isArray(rejectedOpportunities) ? rejectedOpportunities : []).forEach(item => {
    const clientId = String(item?.client_id || '').trim()
    if (!clientId) return
    const list = map.get(clientId) || []
    list.push(item)
    map.set(clientId, list)
  })
  return map
}

function inferNoCandidateDateReason(profile = {}, requestContext = {}, planningDates = []) {
  const planningDateSet = new Set(Array.isArray(planningDates) ? planningDates : [])
  const hasWindowSignals = [
    profile?.next_purchase_window_start,
    profile?.next_purchase_date_estimate,
    profile?.next_purchase_window_end
  ].map(normalizeDateOnly).filter(Boolean)
  const hasAnyHistory = Boolean(
    normalizeDateOnly(profile?.last_purchase_date) ||
    normalizeDateOnly(profile?.last_contact_date) ||
    Number(profile?.purchase_count || 0) > 0 ||
    Number(profile?.history_depth || 0) > 0
  )
  const daysSinceLastPurchase = Number(profile?.days_since_last_purchase)

  if (!profile || typeof profile !== 'object') {
    return 'invalid_cadence_profile'
  }
  if (!String(profile?.client_id || '').trim()) {
    return 'invalid_cadence_profile'
  }
  if (hasWindowSignals.length > 0 && !hasWindowSignals.some(date => planningDateSet.has(date))) {
    return 'next_window_outside_horizon'
  }
  if (Number.isFinite(daysSinceLastPurchase) && daysSinceLastPurchase <= 1 && !profile?.next_purchase_window_start) {
    const maxDaysWithoutContact = Number(requestContext?.maxDaysWithoutContact || 0)
    if (!(maxDaysWithoutContact > 0)) {
      return 'filtered_by_hard_constraint'
    }
    const safeguardDate = addDays(profile?.last_contact_date || requestContext?.startDate, maxDaysWithoutContact)
    return safeguardDate && planningDateSet.has(safeguardDate)
      ? 'no_valid_fallback_date'
      : 'filtered_by_hard_constraint'
  }
  if (!hasAnyHistory && hasWindowSignals.length === 0) {
    return 'insufficient_history'
  }
  if (
    Array.isArray(profile?.usual_purchase_weekdays) &&
    profile.usual_purchase_weekdays.length > 0 &&
    Array.isArray(planningDates) &&
    planningDates.length > 0 &&
    !planningDates.some(date => profile.usual_purchase_weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()))
  ) {
    return 'filtered_by_hard_constraint'
  }
  return 'no_valid_fallback_date'
}

function summarizeNoCandidateDateClients({
  clients = [],
  cadenceProfiles = [],
  candidateDatesByClientId = new Map(),
  requestContext = {},
  planningDates = []
}) {
  const profileByClientId = new Map(
    (Array.isArray(cadenceProfiles) ? cadenceProfiles : [])
      .map(profile => [String(profile?.client_id || '').trim(), profile])
      .filter(([clientId]) => clientId)
  )
  const reasons = {}
  const clientsWithoutCandidateDate = []

  ;(Array.isArray(clients) ? clients : []).forEach(client => {
    const clientId = String(client?.client_id || '').trim()
    if (!clientId) return
    const candidateDates = candidateDatesByClientId.get(clientId) || []
    if (candidateDates.length > 0) return
    const reason = inferNoCandidateDateReason(
      profileByClientId.get(clientId) || { client_id: clientId },
      requestContext,
      planningDates
    )
    reasons[reason] = Number(reasons[reason] || 0) + 1
    clientsWithoutCandidateDate.push({
      client_id: clientId,
      client_code: String(client?.client_code || '').trim(),
      client_name: String(client?.nom || client?.client_name || client?.client_code || '').trim() || null,
      no_candidate_date_reason: reason
    })
  })

  return {
    clients_without_candidate_date: clientsWithoutCandidateDate,
    aggregated_reasons: reasons
  }
}

function resolveFinalClientStatus(rejectedOpportunities = []) {
  const reasonCodes = new Set()
  ;(Array.isArray(rejectedOpportunities) ? rejectedOpportunities : []).forEach(item => {
    ;(Array.isArray(item?.rejection_reason_codes) ? item.rejection_reason_codes : []).forEach(code => {
      if (code) reasonCodes.add(String(code).trim())
    })
  })
  if (reasonCodes.has('LOW_CONFIDENCE')) return 'below_confidence'
  if (reasonCodes.has('EXPLICIT_UNAVAILABLE')) return 'unavailable'
  if (reasonCodes.has('CAPACITY_REACHED')) return 'deferred_capacity'
  if (
    reasonCodes.has('LOW_EFFECTIVE_SCORE') ||
    reasonCodes.has('LOW_PURCHASE_PROBABILITY') ||
    reasonCodes.has('RECENT_PURCHASE_DEPRIORITIZED') ||
    reasonCodes.has('DETOUR_TOO_LARGE')
  ) {
    return 'deferred_low_score'
  }
  return 'other_unclassified'
}

function buildClientFinalDecisions({
  clients = [],
  blocks = [],
  rejectedOpportunities = [],
  candidateDatesByClientId = new Map(),
  candidateDateEntriesByClientId = new Map(),
  cadenceProfiles = [],
  compatibleCommercialCodesByClientId = new Map(),
  selectedCommercials = [],
  requestContext = {},
  planningDates = []
}) {
  const clientsById = buildClientIndex(clients)
  const profileByClientId = new Map(
    (Array.isArray(cadenceProfiles) ? cadenceProfiles : [])
      .map(profile => [String(profile?.client_id || '').trim(), profile])
      .filter(([clientId]) => clientId)
  )
  const selectedVisitsByClientId = groupSelectedVisitsByClientId(blocks)
  const rejectedByClientId = groupRejectedOpportunitiesByClientId(rejectedOpportunities)
  const noCandidateSummary = summarizeNoCandidateDateClients({
    clients,
    cadenceProfiles,
    candidateDatesByClientId,
    requestContext,
    planningDates
  })
  const noCandidateByClientId = new Map(
    noCandidateSummary.clients_without_candidate_date.map(item => [item.client_id, item.no_candidate_date_reason])
  )
  const clientFinalDecisions = {}
  const categoryCounts = {
    selected: 0,
    deferred_capacity: 0,
    deferred_low_score: 0,
    no_candidate_date: 0,
    below_confidence: 0,
    unavailable: 0,
    filtered_commercial_scope: 0,
    invalid_client_data: 0,
    other_unclassified: 0
  }

  clientsById.forEach((client, clientId) => {
    const selectedVisits = selectedVisitsByClientId.get(clientId) || []
    const rejectedForClient = rejectedByClientId.get(clientId) || []
    const compatibleCodes = compatibleCommercialCodesByClientId.get(clientId) || []
    const candidateDates = candidateDatesByClientId.get(clientId) || []
    const candidateDateEntries = candidateDateEntriesByClientId.get(clientId) || []
    const noCandidateDateReason = noCandidateByClientId.get(clientId) || null
    const rejectionReasonCodes = [...new Set(rejectedForClient.flatMap(item => item?.rejection_reason_codes || []))].filter(Boolean)
    const profile = profileByClientId.get(clientId) || {}
    const portfolioDecision = buildPortfolioDecision({
      client,
      profile,
      candidateDateEntries,
      selectedVisits,
      rejectedOpportunities: rejectedForClient,
      compatibleCommercialCodes: compatibleCodes,
      requestContext,
      planningDates
    })
    let finalClientStatus = 'other_unclassified'

    if (!clientId || !String(client?.client_code || '').trim()) {
      finalClientStatus = 'invalid_client_data'
    } else if (selectedVisits.length > 0) {
      finalClientStatus = 'selected'
    } else if (!compatibleCodes.length) {
      finalClientStatus = 'filtered_commercial_scope'
    } else if (candidateDates.length === 0) {
      finalClientStatus = 'no_candidate_date'
    } else if (rejectedForClient.length > 0) {
      finalClientStatus = resolveFinalClientStatus(rejectedForClient)
    }

    categoryCounts[finalClientStatus] = Number(categoryCounts[finalClientStatus] || 0) + 1
    clientFinalDecisions[clientId] = {
      client_id: clientId,
      client_code: String(client?.client_code || '').trim(),
      client_name: String(client?.nom || client?.client_name || client?.client_code || '').trim() || null,
      final_client_status: finalClientStatus,
      selected_visits_count: selectedVisits.length,
      rejected_opportunities_count: rejectedForClient.length,
      candidate_dates_count: candidateDates.length,
      no_candidate_date_reason: noCandidateDateReason,
      rejection_reason_codes: rejectionReasonCodes,
      ...portfolioDecision
    }
  })

  const activeClientsCount = clientsById.size
  const invariantTotal = Object.values(categoryCounts).reduce((sum, value) => sum + Number(value || 0), 0)
  const populationInvariantDifference = activeClientsCount - invariantTotal
  const portfolioStatusCounts = Array.from(Object.values(clientFinalDecisions)).reduce((accumulator, decision) => {
    const status = String(decision.portfolio_status || 'not_due')
    accumulator[status] = Number(accumulator[status] || 0) + 1
    return accumulator
  }, {})
  const portfolioSummaryStartMs = Date.now()
  const portfolioSummary = buildPortfolioSummary(portfolioStatusCounts, activeClientsCount)
  const portfolioSummaryMs = Date.now() - portfolioSummaryStartMs
  const portfolioFeasibilityStartMs = Date.now()
  const portfolioFeasibility = buildFeasibility({
    requestContext,
    selectedCommercials,
    portfolioSummary,
    clientFinalDecisions
  })
  const portfolioFeasibilityMs = Date.now() - portfolioFeasibilityStartMs
  const deferredClients = Object.values(clientFinalDecisions)
    .filter(item => item.final_client_status !== 'selected')
    .map(item => ({
      client_id: item.client_id,
      client_code: item.client_code,
      client_name: item.client_name,
      final_client_status: item.final_client_status,
      explanation_codes: item.final_client_status === 'no_candidate_date'
        ? [item.no_candidate_date_reason].filter(Boolean)
        : [...item.rejection_reason_codes],
      explanation_reasons: item.final_client_status === 'no_candidate_date'
        ? [item.no_candidate_date_reason].filter(Boolean)
        : [],
      no_candidate_date_reason: item.no_candidate_date_reason
    }))

  return {
    active_clients_count: activeClientsCount,
    client_final_decisions: clientFinalDecisions,
    category_counts: categoryCounts,
    deferred_clients: deferredClients,
    clients_sans_date_recommandable: noCandidateSummary.clients_without_candidate_date,
    no_candidate_date_reasons: noCandidateSummary.aggregated_reasons,
    portfolio_summary: portfolioSummary,
    portfolio_feasibility: portfolioFeasibility,
    portfolio_summary_ms: portfolioSummaryMs,
    portfolio_feasibility_ms: portfolioFeasibilityMs,
    population_invariant_status: populationInvariantDifference === 0 ? 'passed' : 'failed',
    population_invariant_difference: populationInvariantDifference
  }
}

function detectProbabilityUnit(visits = []) {
  const values = (Array.isArray(visits) ? visits : [])
    .map(visit => visit?.purchase_probability)
    .filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(value => Number(value))
  if (!values.length) {
    return {
      probability_unit: 'unknown',
      high_probability_threshold: HIGH_PROBABILITY_THRESHOLD_PERCENT,
      expected_sales_count: null
    }
  }
  const maxValue = Math.max(...values)
  const isPercentage = maxValue > 1
  return {
    probability_unit: isPercentage ? 'percentage_0_100' : 'ratio_0_1',
    high_probability_threshold: isPercentage ? HIGH_PROBABILITY_THRESHOLD_PERCENT : 0.5,
    expected_sales_count: roundScore(values.reduce((sum, value) => (
      sum + (isPercentage ? (value / 100) : value)
    ), 0))
  }
}

function summarizeZoneResolution(visits = []) {
  return (Array.isArray(visits) ? visits : []).reduce((summary, visit) => {
    const status = String(visit?.zone_resolution_status || '').trim() || 'zone_not_propagated'
    summary[status] = Number(summary[status] || 0) + 1
    return summary
  }, {
    zone_resolved: 0,
    zone_source_missing: 0,
    zone_not_propagated: 0
  })
}

function computeOpportunityScoring(opportunities = [], objectiveMode = DEFAULT_OBJECTIVE_MODE) {
  const maxPredictedCa = opportunities.reduce((maxValue, opportunity) => Math.max(maxValue, Number(opportunity.predicted_ca || 0) || 0), 0)
  const maxRecommendedQuantity = opportunities.reduce((maxValue, opportunity) => Math.max(maxValue, Number(opportunity.recommended_quantity || 0) || 0), 0)

  return opportunities.map(opportunity => {
    const scored = computeOpportunityScore(opportunity, {
      objectiveMode,
      maxPredictedCa,
      maxRecommendedQuantity,
      maxDetourKm: 35,
      maxVisitMinutes: 90
    })
    return {
      ...opportunity,
      visit_opportunity_score: scored.visit_opportunity_score,
      score_components: scored.score_components,
      score_weights: scored.weights,
      score_breakdown: scored.score_breakdown
    }
  })
}

function buildSummary({
  requestContext,
  blocks = [],
  finalDecisionSummary = {},
  assignment = {},
  cacheStatus,
  objectiveMode
}) {
  const allVisits = blocks.flatMap(block => Array.isArray(block.clients) ? block.clients : [])
  const visitsByClientId = allVisits.reduce((map, visit) => {
    const clientId = String(visit?.client_id || '').trim()
    if (!clientId) return map
    const list = map.get(clientId) || []
    list.push(visit)
    map.set(clientId, list)
    return map
  }, new Map())
  const totalVisits = allVisits.length
  const confidenceValues = allVisits.map(visit => Number(visit.confidence)).filter(Number.isFinite)
  const knownPredictionVisits = allVisits.filter(visit => visit?.purchase_prediction_known === true)
  const nullPredictionVisits = allVisits.filter(visit => visit?.purchase_prediction_known !== true)
  const knownPredictedCaValues = allVisits
    .map(visit => visit?.predicted_ca)
    .filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(value => Number(value))
  const probabilityMeta = detectProbabilityUnit(allVisits)
  const zoneResolution = summarizeZoneResolution(allVisits)
  const highProbabilityVisitsCount = allVisits.filter(visit => {
    if (visit?.purchase_probability == null || !Number.isFinite(Number(visit.purchase_probability))) return false
    return Number(visit.purchase_probability) >= Number(probabilityMeta.high_probability_threshold)
  }).length
  const globalConfidence = confidenceValues.length
    ? roundScore(confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length)
    : null
  const selectedPredictiveCount = allVisits.filter(visit => String(visit?.decision_mode || '') === 'predictive').length
  const selectedHybridCount = allVisits.filter(visit => String(visit?.decision_mode || '') === 'hybrid').length
  const selectedExplorationCount = allVisits.filter(visit => String(visit?.decision_mode || '') === 'exploration').length
  const predictedCaKnownSum = knownPredictedCaValues.length
    ? roundScore(knownPredictedCaValues.reduce((sum, value) => sum + value, 0))
    : null
  const predictedCaNullCount = Math.max(0, totalVisits - knownPredictedCaValues.length)
  const expectedCaCompletenessStatus = totalVisits === 0
    ? 'unavailable'
    : predictedCaKnownSum == null
      ? 'unavailable'
      : predictedCaNullCount > 0
        ? 'partial'
        : 'complete'
  const selectedUniqueClientsCount = visitsByClientId.size
  const selectedClientsWithMultipleVisitsCount = [...visitsByClientId.values()].filter(list => list.length > 1).length
  const maximumVisitsForOneClient = [...visitsByClientId.values()].reduce(
    (maxValue, list) => Math.max(maxValue, list.length),
    0
  )
  const categoryCounts = finalDecisionSummary?.category_counts || {}
  const noCandidateDateCount = Number(categoryCounts.no_candidate_date || 0)
  const deferredUniqueClientsCount = [
    'deferred_capacity',
    'deferred_low_score',
    'below_confidence',
    'unavailable',
    'filtered_commercial_scope',
    'invalid_client_data',
    'other_unclassified'
  ].reduce((sum, key) => sum + Number(categoryCounts[key] || 0), 0)

  return {
    planning_start_date: requestContext.startDate,
    planning_horizon_days: requestContext.planningHorizonDays,
    objective_mode: objectiveMode,
    max_days_without_contact: requestContext.maxDaysWithoutContact,
    daily_max_mode: requestContext.dailyMaxMode,
    active_clients_count: Number(finalDecisionSummary?.active_clients_count || 0),
    selected_unique_clients_count: selectedUniqueClientsCount,
    selected_visits_count: totalVisits,
    selected_clients_with_multiple_visits_count: selectedClientsWithMultipleVisitsCount,
    maximum_visits_for_one_client: maximumVisitsForOneClient,
    deferred_unique_clients_count: deferredUniqueClientsCount,
    no_candidate_date_count: noCandidateDateCount,
    population_invariant_status: finalDecisionSummary?.population_invariant_status || 'failed',
    population_invariant_difference: Number(finalDecisionSummary?.population_invariant_difference || 0),
    selected_prediction_known_count: knownPredictionVisits.length,
    selected_prediction_null_count: nullPredictionVisits.length,
    selected_prediction_coverage_rate: totalVisits > 0
      ? roundScore((knownPredictionVisits.length / totalVisits) * 100)
      : null,
    selected_predictive_count: selectedPredictiveCount,
    selected_hybrid_count: selectedHybridCount,
    selected_exploration_count: selectedExplorationCount,
    minimum_preferred_bonus_applied_count: Number(assignment.minimum_preferred_bonus_applied_count || 0),
    visits_shifted_for_soft_balance_count: Number(assignment.visits_shifted_for_soft_balance_count || 0),
    average_date_shift_days: Number(assignment.average_date_shift_days || 0),
    maximum_date_shift_days: Number(assignment.maximum_date_shift_days || 0),
    repeated_clients_count: Number(assignment.repeated_clients_count || selectedClientsWithMultipleVisitsCount),
    repeated_visits_count: Number(assignment.repeated_visits_count || Math.max(0, totalVisits - selectedUniqueClientsCount)),
    minimum_observed_gap_days: assignment.minimum_observed_gap_days ?? null,
    one_day_gap_count: Number(assignment.one_day_gap_count || 0),
    justified_one_day_gap_count: Number(assignment.justified_one_day_gap_count || 0),
    unjustified_one_day_gap_count: Number(assignment.unjustified_one_day_gap_count || 0),
    duplicate_cycle_selection_count: Number(assignment.duplicate_cycle_selection_count || 0),
    suspicious_repeat_count: Number(assignment.suspicious_repeat_count || 0),
    predicted_ca_known_sum: predictedCaKnownSum,
    predicted_ca_known_count: knownPredictedCaValues.length,
    predicted_ca_null_count: predictedCaNullCount,
    predicted_ca_coverage_rate: totalVisits > 0
      ? roundScore((knownPredictedCaValues.length / totalVisits) * 100)
      : null,
    predicted_ca_average_when_known: knownPredictedCaValues.length > 0
      ? roundScore(knownPredictedCaValues.reduce((sum, value) => sum + value, 0) / knownPredictedCaValues.length)
      : null,
    predicted_ca_average_per_all_visits: totalVisits > 0 && knownPredictedCaValues.length > 0
      ? roundScore(knownPredictedCaValues.reduce((sum, value) => sum + value, 0) / totalVisits)
      : null,
    expected_ca_completeness_status: expectedCaCompletenessStatus,
    total_expected_ca: predictedCaKnownSum,
    high_probability_visits_count: highProbabilityVisitsCount,
    high_probability_threshold: probabilityMeta.high_probability_threshold,
    known_probability_count: probabilityMeta.probability_unit === 'unknown'
      ? 0
      : allVisits.filter(visit => visit?.purchase_probability != null && Number.isFinite(Number(visit.purchase_probability))).length,
    null_probability_count: allVisits.filter(visit => visit?.purchase_probability == null || !Number.isFinite(Number(visit.purchase_probability))).length,
    probability_unit: probabilityMeta.probability_unit,
    expected_sales_count: probabilityMeta.expected_sales_count,
    probable_sales_count: highProbabilityVisitsCount,
    recommended_visits_count: totalVisits,
    deferred_clients_count: deferredUniqueClientsCount,
    terrain_feasibility_status: 'not_confirmed',
    zone_resolved_count: Number(zoneResolution.zone_resolved || 0),
    zone_source_missing_count: Number(zoneResolution.zone_source_missing || 0),
    zone_not_propagated_count: Number(zoneResolution.zone_not_propagated || 0),
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
  return {
    mode: selectedCommercials.length === 1 ? 'specific_commercial' : 'all_active_clients',
    active_clients_count: activeClientsCount,
    selected_commercial_codes_count: selectedCommercials.length,
    client_filter_applied: false
  }
}

function buildValidationSnapshot({ opportunities = [], blocks = [], deferredClients = [] }) {
  const selectedVisits = blocks.flatMap(block => (
    Array.isArray(block.clients)
      ? block.clients.map(client => ({
          ...client,
          assigned_date: block.date,
          assigned_commercial_code: block.commercial_code,
          assigned_slot_id: block.slot_id
        }))
      : []
  ))
  const highestOpportunityByClientCode = new Map()
  opportunities.forEach(opportunity => {
    const clientCode = normalizeExactClientCode(opportunity.client_code)
    if (!clientCode) return
    const current = highestOpportunityByClientCode.get(clientCode)
    if (!current || Number(opportunity.visit_opportunity_score || 0) > Number(current.visit_opportunity_score || 0)) {
      highestOpportunityByClientCode.set(clientCode, opportunity)
    }
  })

  return {
    selected_visits: selectedVisits,
    deferred_clients: deferredClients,
    top_opportunities_by_client_code: Object.fromEntries([...highestOpportunityByClientCode.entries()])
  }
}

async function generateNextBestVisitPlanFromData({
  requestContext,
  clients = [],
  cadenceProfiles: precomputedCadenceProfiles = null,
  selectedCommercials = [],
  coverageConstraints = {},
  salesHistoryByClientId = new Map(),
  visitHistoryByClientId = new Map(),
  predictionResolver = null,
  predictions = [],
  availabilitySignals = [],
  sharedDepotOrigin = null,
  cacheStatus = 'not_cached',
  profileCacheStatus = 'not_cached',
  profileVersion = 'inline',
  predictionVersion = 'inline',
  constraintsVersion = 'inline',
  includeValidationDetails = false
} = {}) {
  const normalizedRequestContext = requestContext && typeof requestContext === 'object'
    ? requestContext
    : normalizeNextBestVisitRequest({})
  const perf = createPerfTracker()
  const planningDates = buildPlanningDates(normalizedRequestContext.startDate, normalizedRequestContext.planningHorizonDays)

  if (!clients.length) {
    const emptyDecisionSummary = {
      active_clients_count: 0,
      category_counts: {
        selected: 0,
        deferred_capacity: 0,
        deferred_low_score: 0,
        no_candidate_date: 0,
        below_confidence: 0,
        unavailable: 0,
        filtered_commercial_scope: 0,
        invalid_client_data: 0,
        other_unclassified: 0
      },
      population_invariant_status: 'passed',
      population_invariant_difference: 0
    }
    return {
      status: 'success',
      message: 'Aucun client actif a evaluer.',
      summary: buildSummary({
        requestContext: normalizedRequestContext,
        blocks: [],
        finalDecisionSummary: emptyDecisionSummary,
        cacheStatus,
        objectiveMode: normalizedRequestContext.objectiveMode
      }),
      blocks: [],
      deferred_clients: [],
      clients_sans_date_recommandable: [],
      client_final_decisions: {},
      client_scope: buildClientScopePayload(selectedCommercials, 0),
      portfolio_summary: buildPortfolioSummary({}, 0),
      portfolio_feasibility: buildFeasibility({
        requestContext: normalizedRequestContext,
        selectedCommercials,
        portfolioSummary: buildPortfolioSummary({}, 0)
      }),
      capacity_precheck: null,
      request_context: normalizedRequestContext,
      diagnostics: {
        sparse_opportunity_count: 0,
        cartesian_candidate_count_avoided: 0,
        objective_weights: resolveObjectiveWeightSet(normalizedRequestContext.objectiveMode),
        warning_codes: [],
        no_candidate_date_count: 0,
        no_candidate_date_reasons: {},
        rejected_opportunities_count: 0,
        rejected_opportunities_by_selected_client: []
      },
      statuses: {
        technical_validation_status: 'not_applicable',
        logical_validation_status: 'not_applicable',
        commercial_validation_status: 'not_validated',
        data_environment: 'synthetic_validation',
        data_representativeness: 'non_representative'
      },
      meta: {
        performance: {
          stages: perf.stages()
        }
      }
    }
  }

  const cadenceProfiles = Array.isArray(precomputedCadenceProfiles)
    ? precomputedCadenceProfiles
    : await perf.run('build_cadence_profiles', async () => buildCadenceProfiles({
      clients,
      salesHistoryByClientId,
      visitHistoryByClientId,
      referenceDate: normalizedRequestContext.historicalCutoffDate || normalizedRequestContext.startDate,
      maxDaysWithoutContact: normalizedRequestContext.maxDaysWithoutContact
    }))
  const candidateDateEntriesByClientId = await perf.run(
    'build_sparse_candidate_dates',
    async () => buildCandidateDateEntriesByClientId(
      cadenceProfiles,
      normalizedRequestContext,
      planningDates,
      clients,
      {
        coverageConstraints,
        compatibleCommercialCodesByClientId: buildCompatibleCommercialCodesByClientId(clients, selectedCommercials, coverageConstraints)
      }
    )
  )
  const candidateDatesByClientId = new Map(
    [...candidateDateEntriesByClientId.entries()].map(([clientId, entries]) => [
      clientId,
      [...new Set((Array.isArray(entries) ? entries : []).map(entry => entry.candidate_date))]
    ])
  )

  const effectivePredictionResolver = typeof predictionResolver === 'function'
    ? predictionResolver
    : buildPredictionResolverFromRecords(predictions)
  const predictionFetchResult = await resolvePredictionsForCandidateDates({
    clients,
    candidateDatesByClientId,
    predictionResolver: effectivePredictionResolver,
    perfTracker: perf
  })

  const predictionsByClientDate = remapPredictionsByClientId(clients, predictionFetchResult.predictionsByClientDate)
  const compatibleCommercialCodesByClientId = buildCompatibleCommercialCodesByClientId(clients, selectedCommercials, coverageConstraints)
  const depotByCommercialDate = buildDepotByCommercialDate(coverageConstraints, selectedCommercials, planningDates, sharedDepotOrigin)
  const availabilityByClientDate = buildAvailabilitySignalMap(availabilitySignals)
  const preAssignmentPortfolioByClientId = buildPreAssignmentPortfolioDecisionMap({
    clients,
    cadenceProfiles,
    candidateDateEntriesByClientId,
    compatibleCommercialCodesByClientId,
    requestContext: normalizedRequestContext,
    planningDates
  })

  const opportunities = await perf.run('build_opportunities', async () => buildVisitOpportunities({
    clients,
    cadenceProfiles,
    predictionsByClientDate,
    compatibleCommercialCodesByClientId,
    depotByCommercialDate,
    options: {
      startDate: normalizedRequestContext.startDate,
      planningHorizonDays: normalizedRequestContext.planningHorizonDays,
      maxCandidateDatesPerClient: normalizedRequestContext.maxCandidateDatesPerClient,
      maxDaysWithoutContact: normalizedRequestContext.maxDaysWithoutContact,
      candidateDatesByClientId,
      candidateDateEntriesByClientId,
      planningDates,
      availabilityByClientDate
    }
  }))
  const opportunitiesWithCommercialCircuit = attachHistoricalCommercialCircuitDiagnostics({
    opportunities,
    clients,
    compatibleCommercialCodesByClientId,
    salesHistoryByClientId,
    selectedCommercials,
    referenceDate: normalizedRequestContext.historicalCutoffDate || normalizedRequestContext.startDate
  })
  const opportunitiesWithPortfolio = opportunitiesWithCommercialCircuit.map(opportunity => {
    const portfolioDecision = preAssignmentPortfolioByClientId.get(String(opportunity.client_id || '').trim()) || {}
    return {
      ...opportunity,
      portfolio_status: portfolioDecision.portfolio_status || null,
      next_action: portfolioDecision.next_action || null,
      next_due_date: portfolioDecision.next_due_date ?? null,
      next_due_window_start: portfolioDecision.next_due_window_start ?? null,
      next_due_window_end: portfolioDecision.next_due_window_end ?? null
    }
  })
  const scoredOpportunities = await perf.run('scoring', async () => computeOpportunityScoring(opportunitiesWithPortfolio, normalizedRequestContext.objectiveMode))
  const assignment = await perf.run('assignment', async () => {
    const slots = buildCommercialSlots({
      planningDates,
      selectedCommercials,
      commercialConstraintsByCode: new Map(Object.entries(coverageConstraints?.commercials || {})),
      requestMaxVisits: normalizedRequestContext.maxVisitsPerDay,
      minDailyCaPerCommercial: normalizedRequestContext.minDailyCaPerCommercial
    })
    return assignVisitOpportunities({
      opportunities: scoredOpportunities,
      slots,
      options: {
        respectAvailability: normalizedRequestContext.respectAvailability,
        minimumConfidence: normalizedRequestContext.minimumConfidence,
        minimumVisitsPreference: normalizedRequestContext.minVisitsPerDayPreference
      }
    })
  })
  await perf.run('explanations', async () => Promise.resolve())
  const portfolioDecisionsStartMs = Date.now()
  const finalDecisionSummary = buildClientFinalDecisions({
    clients,
    blocks: assignment.blocks,
    rejectedOpportunities: assignment.rejected_opportunities,
    candidateDatesByClientId,
    candidateDateEntriesByClientId,
    cadenceProfiles,
    compatibleCommercialCodesByClientId,
    selectedCommercials,
    requestContext: normalizedRequestContext,
    planningDates
  })
  const portfolioDecisionsBuildMs = Date.now() - portfolioDecisionsStartMs
  const summary = await perf.run('aggregation', async () => buildSummary({
    requestContext: normalizedRequestContext,
    blocks: assignment.blocks,
    finalDecisionSummary,
    assignment,
    cacheStatus,
    objectiveMode: normalizedRequestContext.objectiveMode
  }))
  const serializedBlocks = assignment.blocks

  const opportunitiesByDate = planningDates.map(date => {
    const dayOpportunities = scoredOpportunities.filter(opportunity => String(opportunity.candidate_date || '') === date)
    const knownPredictionCount = dayOpportunities.filter(opportunity => opportunity.purchase_prediction_known).length
    const nullPredictionCount = Math.max(0, dayOpportunities.length - knownPredictionCount)
    return {
      date,
      opportunities_count: dayOpportunities.length,
      predictive_count: dayOpportunities.filter(opportunity => String(opportunity.decision_mode || '') === 'predictive').length,
      hybrid_count: dayOpportunities.filter(opportunity => String(opportunity.decision_mode || '') === 'hybrid').length,
      exploration_count: dayOpportunities.filter(opportunity => String(opportunity.decision_mode || '') === 'exploration').length,
      known_predictions_count: knownPredictionCount,
      null_predictions_count: nullPredictionCount
    }
  })
  const selectedByDate = planningDates.map(date => {
    const blockVisits = assignment.blocks
      .filter(block => String(block.date || '') === date)
      .flatMap(block => Array.isArray(block.clients) ? block.clients : [])
    const uniqueClientCount = new Set(blockVisits.map(visit => String(visit.client_id || '')).filter(Boolean)).size
    const predictedCaSum = roundScore(blockVisits.reduce((sum, visit) => sum + (Number(visit.predicted_ca || 0) || 0), 0))
    return {
      date,
      selected_visits_count: blockVisits.length,
      selected_unique_clients_count: uniqueClientCount,
      predictive_count: blockVisits.filter(visit => String(visit.decision_mode || '') === 'predictive').length,
      hybrid_count: blockVisits.filter(visit => String(visit.decision_mode || '') === 'hybrid').length,
      exploration_count: blockVisits.filter(visit => String(visit.decision_mode || '') === 'exploration').length,
      predicted_ca_sum: predictedCaSum,
      known_predictions_count: blockVisits.filter(visit => visit.purchase_prediction_known).length,
      null_predictions_count: blockVisits.filter(visit => !visit.purchase_prediction_known).length
    }
  })
  const payload = await perf.run('serialization', async () => ({
    status: 'success',
    message: serializedBlocks.length
      ? 'Plan V2 genere a partir d opportunites sparse et d un score commercial explicable.'
      : 'Aucune visite n a ete retenue sur cet horizon avec les regles V2 actuelles.',
    summary,
    blocks: serializedBlocks,
    deferred_clients: finalDecisionSummary.deferred_clients,
    clients_sans_date_recommandable: finalDecisionSummary.clients_sans_date_recommandable,
    client_final_decisions: finalDecisionSummary.client_final_decisions,
    portfolio_summary: finalDecisionSummary.portfolio_summary,
    portfolio_feasibility: finalDecisionSummary.portfolio_feasibility,
    depot: sharedDepotOrigin,
    client_scope: buildClientScopePayload(selectedCommercials, clients.length),
    capacity_precheck: null,
    request_context: normalizedRequestContext,
    diagnostics: {
      active_clients_count: clients.length,
      portfolio_decisions_build_ms: portfolioDecisionsBuildMs,
      portfolio_summary_ms: Number(finalDecisionSummary?.portfolio_summary_ms || 0),
      portfolio_feasibility_ms: Number(finalDecisionSummary?.portfolio_feasibility_ms || 0),
      full_cartesian_pair_count: clients.length * planningDates.length * Math.max(selectedCommercials.length, 1),
      sparse_candidate_dates_count: [...candidateDatesByClientId.values()].reduce((sum, values) => sum + values.length, 0),
      opportunities_count: scoredOpportunities.length,
      selected_visits_count: assignment.selected_visits_count,
      sparse_opportunity_count: scoredOpportunities.length,
      cartesian_candidate_count_avoided: Math.max(0, (clients.length * planningDates.length * Math.max(selectedCommercials.length, 1)) - scoredOpportunities.length),
      candidate_dates_considered: [...new Set([...candidateDatesByClientId.values()].flat())].length,
      sparsity_ratio: clients.length > 0 && planningDates.length > 0 && selectedCommercials.length > 0
        ? roundScore((scoredOpportunities.length / (clients.length * planningDates.length * selectedCommercials.length)) * 100)
        : null,
      average_opportunities_per_client: clients.length > 0 ? roundScore(scoredOpportunities.length / clients.length) : null,
      maximum_opportunities_per_client: [...candidateDatesByClientId.values()].reduce((maxValue, values) => Math.max(maxValue, values.length), 0),
      candidate_date_flexibility_breakdown: scoredOpportunities.reduce((accumulator, opportunity) => {
        const key = String(opportunity.date_flexibility_type || 'fixed')
        accumulator[key] = Number(accumulator[key] || 0) + 1
        return accumulator
      }, {
        fixed: 0,
        narrow_window: 0,
        flexible_window: 0,
        exploration_window: 0
      }),
      profile_cache_status: profileCacheStatus,
      objective_weights: resolveObjectiveWeightSet(normalizedRequestContext.objectiveMode),
      profile_version: profileVersion,
      prediction_version: predictionVersion,
      constraints_version: constraintsVersion,
      clients_with_candidate_dates_count: [...candidateDatesByClientId.entries()].filter(([, values]) => (values || []).length > 0).length,
      clients_without_candidate_dates_count: finalDecisionSummary.clients_sans_date_recommandable.length,
      no_candidate_date_count: finalDecisionSummary.clients_sans_date_recommandable.length,
      no_candidate_date_reasons: finalDecisionSummary.no_candidate_date_reasons,
      prediction_coverage_by_date: predictionFetchResult.coverageByDate,
      prediction_requested_clients_count: predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.requested_count || 0), 0),
      prediction_returned_clients_count: predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.returned_count || 0), 0),
      prediction_known_count: predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.known_count || 0), 0),
      prediction_null_count: predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.null_count || 0), 0),
      prediction_coverage_rate: predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.requested_count || 0), 0) > 0
        ? roundScore(
            (
              predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.known_count || 0), 0) /
              predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.requested_count || 0), 0)
            ) * 100
          )
        : null,
      prediction_cache_hit_count: predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.prediction_cache_hit_count || 0), 0),
      prediction_cache_miss_count: predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.prediction_cache_miss_count || 0), 0),
      prediction_cache_hit_rate: predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.requested_count || 0), 0) > 0
        ? roundScore(
            (
              predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.prediction_cache_hit_count || 0), 0) /
              predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.requested_count || 0), 0)
            ) * 100
          )
        : null,
      python_requested_count: predictionFetchResult.coverageByDate.reduce((sum, item) => sum + Number(item.python_requested_count || 0), 0),
      top_k_truncation_detected: predictionFetchResult.coverageByDate.some(item => item.top_k_truncation_detected),
      zone_resolution: summarizeZoneResolution(assignment.blocks.flatMap(block => Array.isArray(block.clients) ? block.clients : [])),
      terrain_feasibility_status: 'not_confirmed',
      opportunities_by_date: opportunitiesByDate,
      selected_by_date: selectedByDate,
      minimum_preferred_bonus_applied_count: Number(assignment.minimum_preferred_bonus_applied_count || 0),
      visits_shifted_for_soft_balance_count: Number(assignment.visits_shifted_for_soft_balance_count || 0),
      average_date_shift_days: Number(assignment.average_date_shift_days || 0),
      maximum_date_shift_days: Number(assignment.maximum_date_shift_days || 0),
      fixed_opportunities_shifted_count: Number(assignment.fixed_opportunities_shifted_count || 0),
      strong_opportunities_shifted_count: Number(assignment.strong_opportunities_shifted_count || 0),
      repeated_clients_count: Number(assignment.repeated_clients_count || 0),
      repeated_visits_count: Number(assignment.repeated_visits_count || 0),
      minimum_observed_gap_days: assignment.minimum_observed_gap_days ?? null,
      one_day_gap_count: Number(assignment.one_day_gap_count || 0),
      justified_one_day_gap_count: Number(assignment.justified_one_day_gap_count || 0),
      unjustified_one_day_gap_count: Number(assignment.unjustified_one_day_gap_count || 0),
      duplicate_cycle_selection_count: Number(assignment.duplicate_cycle_selection_count || 0),
      suspicious_repeat_count: Number(assignment.suspicious_repeat_count || 0),
      repeat_classification_counts: assignment.repeat_classification_counts || {},
      exploration_visits_per_client: assignment.exploration_visits_per_client || {},
      exploration_repeat_prevented_count: Number(assignment.exploration_repeat_prevented_count || 0),
      duplicate_cycle_selection_prevented_count: Number(assignment.duplicate_cycle_selection_prevented_count || 0),
      rejected_opportunities_count: Number(assignment.rejected_opportunities_count || 0),
      rejected_opportunities_by_selected_client: assignment.rejected_opportunities_by_selected_client || [],
      population_invariant_status: finalDecisionSummary.population_invariant_status,
      population_invariant_difference: finalDecisionSummary.population_invariant_difference,
      warning_codes: assignment.warning_codes,
      warnings: assignment.warnings
    },
    statuses: {
      technical_validation_status: 'not_applicable',
      logical_validation_status: 'not_applicable',
      commercial_validation_status: 'not_validated',
      data_environment: 'synthetic_validation',
      data_representativeness: 'non_representative'
    }
  }))
  payload.meta = {
    performance: {
      stages: perf.stages()
    }
  }

  if (includeValidationDetails) {
    payload.validation = buildValidationSnapshot({
      opportunities: scoredOpportunities,
      blocks: assignment.blocks,
      deferredClients: assignment.deferred_clients
    })
  }

  return payload
}

module.exports = {
  DEFAULT_DAILY_MAX_MODE,
  DEFAULT_MAX_CANDIDATE_DATES_PER_CLIENT,
  DEFAULT_MINIMUM_CONFIDENCE,
  DEFAULT_OBJECTIVE_MODE,
  HIGH_PROBABILITY_THRESHOLD_PERCENT,
  buildAvailabilitySignalMap,
  buildCandidateDatesByClientId,
  buildCandidateDateEntriesByClientId,
  buildClientScopePayload,
  buildCompatibleCommercialCodesByClientId,
  buildHistoricalCommercialCircuitProfileByCode,
  buildHistoricalCommercialCircuitDistanceByClientId,
  computeCommercialCircuitDistanceKmForClient,
  buildDepotByCommercialDate,
  buildClientFinalDecisions,
  buildPredictionResolverFromRecords,
  buildSummary,
  attachHistoricalCommercialCircuitDiagnostics,
  computeOpportunityScoring,
  createPerfTracker,
  detectProbabilityUnit,
  generateNextBestVisitPlanFromData,
  invertCandidateDatesByClientId,
  normalizeNextBestVisitRequest,
  remapPredictionsByClientId,
  resolvePredictionsForCandidateDates,
  summarizeNoCandidateDateClients,
  summarizeZoneResolution
}

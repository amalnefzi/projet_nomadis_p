const crypto = require('node:crypto')

const {
  addDays,
  buildCadenceProfiles,
  diffDays,
  normalizeDateOnly
} = require('./client_cadence_intelligence')
const {
  buildPlanningDates,
  buildVisitOpportunities
} = require('./visit_opportunity_builder')
const {
  assignVisitOpportunities,
  buildCommercialSlots
} = require('./visit_assignment_optimizer')
const {
  generateNextBestVisitPlan,
  __testables: serviceTestables
} = require('./next_best_visit_service')
const {
  __testables: serverTestables
} = require('./server')

const DEFAULT_BACKTEST_WINDOWS = Object.freeze([
  {
    label: 'h7_recent',
    cutoff: '2026-07-01',
    startDate: '2026-07-02',
    horizonDays: 7
  },
  {
    label: 'h14_recent',
    cutoff: '2026-06-16',
    startDate: '2026-06-17',
    horizonDays: 14
  },
  {
    label: 'h30_recent',
    cutoff: '2026-05-16',
    startDate: '2026-05-17',
    horizonDays: 30
  }
])

function roundNumber(value, digits = 2) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  const factor = 10 ** digits
  return Math.round(numeric * factor) / factor
}

function roundPercent(value) {
  return roundNumber(value, 1)
}

function average(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite)
  if (!numbers.length) return null
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
}

function median(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right)
  if (!numbers.length) return null
  const mid = Math.floor(numbers.length / 2)
  return numbers.length % 2 === 1
    ? numbers[mid]
    : (numbers[mid - 1] + numbers[mid]) / 2
}

function buildDeterministicScore(seed, key) {
  const digest = crypto
    .createHash('sha1')
    .update(`${String(seed || '')}::${String(key || '')}`)
    .digest('hex')
    .slice(0, 12)
  return Number.parseInt(digest, 16)
}

function cloneSlots(slots = []) {
  return JSON.parse(JSON.stringify(Array.isArray(slots) ? slots : []))
}

function flattenAssignedVisits(assignment = {}) {
  return (Array.isArray(assignment.blocks) ? assignment.blocks : []).flatMap(block => (
    Array.isArray(block.clients)
      ? block.clients.map(client => ({
          ...client,
          assigned_date: block.date,
          assigned_commercial_code: block.commercial_code,
          assigned_slot_id: block.slot_id
        }))
      : []
  ))
}

function buildRecommendedVisitsByClientId(visits = []) {
  const map = new Map()
  ;(Array.isArray(visits) ? visits : []).forEach(visit => {
    const clientId = String(visit.client_id || '')
    const list = map.get(clientId) || []
    list.push(visit)
    map.set(clientId, list)
  })
  return map
}

function matchVisitsToPurchases(recommendedVisits = [], actualPurchases = [], toleranceDays = 1) {
  const sortedVisits = [...recommendedVisits].sort((left, right) => (
    String(left.candidate_date || '').localeCompare(String(right.candidate_date || '')) ||
    String(left.visit_opportunity_id || '').localeCompare(String(right.visit_opportunity_id || ''))
  ))
  const sortedPurchases = [...actualPurchases].sort((left, right) => (
    String(left.purchase_date || '').localeCompare(String(right.purchase_date || ''))
  ))
  const matchedPurchaseIndexes = new Set()
  const matches = []

  sortedVisits.forEach(visit => {
    let bestIndex = -1
    let bestDistance = Number.POSITIVE_INFINITY
    sortedPurchases.forEach((purchase, index) => {
      if (matchedPurchaseIndexes.has(index)) return
      const distance = Math.abs(diffDays(visit.candidate_date, purchase.purchase_date) ?? Number.POSITIVE_INFINITY)
      if (!Number.isFinite(distance) || distance > toleranceDays) return
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = index
      }
    })

    if (bestIndex >= 0) {
      matchedPurchaseIndexes.add(bestIndex)
      matches.push({
        visit,
        purchase: sortedPurchases[bestIndex],
        date_error_days: bestDistance
      })
    }
  })

  return {
    matches,
    unmatched_visits_count: Math.max(0, sortedVisits.length - matches.length),
    unmatched_purchases_count: Math.max(0, sortedPurchases.length - matchedPurchaseIndexes.size)
  }
}

function buildActualPurchaseMap(salesHistoryByClientId = new Map(), startDate, endDate) {
  const map = new Map()
  salesHistoryByClientId.forEach((rows, clientId) => {
    const filtered = (Array.isArray(rows) ? rows : []).filter(row => (
      row.purchase_date >= startDate &&
      row.purchase_date <= endDate
    ))
    if (filtered.length) {
      map.set(String(clientId || ''), filtered)
    }
  })
  return map
}

function buildCadenceBucket(profile = {}) {
  if (!Number.isFinite(Number(profile.purchase_count)) || Number(profile.purchase_count) <= 0) {
    return 'inactive'
  }
  if (Number(profile.days_since_last_purchase) >= 90) return 'inactive'
  if (Number(profile.purchase_interval_variability) >= 0.9) return 'irregular'

  const interval = Number(profile.recommended_visit_interval_days)
  if (!Number.isFinite(interval)) return 'irregular'
  if (interval <= 9) return 'weekly'
  if (interval <= 20) return 'biweekly'
  if (interval <= 40) return 'monthly'
  return 'irregular'
}

function summarizeCadenceProfiles(cadenceProfiles = []) {
  const intervals = cadenceProfiles
    .map(profile => Number(profile.median_days_between_purchases))
    .filter(Number.isFinite)
  const confidences = cadenceProfiles
    .map(profile => Number(profile.cadence_confidence))
    .filter(Number.isFinite)

  const summary = {
    active_clients: cadenceProfiles.length,
    clients_with_0_purchase: 0,
    clients_with_1_purchase: 0,
    clients_with_2_purchases: 0,
    clients_with_3_or_more_purchases: 0,
    median_history_depth: median(cadenceProfiles.map(profile => Number(profile.history_depth))),
    purchase_interval_days_median: median(intervals),
    purchase_interval_days_average: average(intervals),
    cadence_high_confidence_clients: 0,
    cadence_average_confidence: roundNumber(average(confidences), 3),
    cadence_low_confidence_clients: 0,
    fallback_only_clients: 0,
    cadence_bucket_counts: {
      weekly: 0,
      biweekly: 0,
      monthly: 0,
      irregular: 0,
      inactive: 0
    }
  }

  ;(Array.isArray(cadenceProfiles) ? cadenceProfiles : []).forEach(profile => {
    const purchaseCount = Number(profile.purchase_count || 0)
    const confidence = Number(profile.cadence_confidence || 0)
    if (purchaseCount <= 0) summary.clients_with_0_purchase += 1
    else if (purchaseCount === 1) summary.clients_with_1_purchase += 1
    else if (purchaseCount === 2) summary.clients_with_2_purchases += 1
    else summary.clients_with_3_or_more_purchases += 1

    if (confidence >= 0.75) summary.cadence_high_confidence_clients += 1
    if (confidence <= 0.42) summary.cadence_low_confidence_clients += 1
    if (profile.fallback_strategy) summary.fallback_only_clients += 1

    const bucket = buildCadenceBucket(profile)
    summary.cadence_bucket_counts[bucket] += 1
  })

  return summary
}

function computeWindowMetrics({
  assignment,
  actualSalesByClientId,
  toleranceDays = 1
}) {
  const visits = flattenAssignedVisits(assignment)
  const recommendedVisitsByClientId = buildRecommendedVisitsByClientId(visits)
  const actualBuyerClientIds = new Set([...actualSalesByClientId.keys()])
  const allMatches = []

  recommendedVisitsByClientId.forEach((clientVisits, clientId) => {
    const purchases = actualSalesByClientId.get(clientId) || []
    const matchResult = matchVisitsToPurchases(clientVisits, purchases, toleranceDays)
    allMatches.push(...matchResult.matches)
  })

  const matchedClientIds = new Set(allMatches.map(item => String(item.visit.client_id || '')))
  const actualCaCaptured = allMatches.reduce((sum, item) => sum + (Number(item.purchase.order_value || 0) || 0), 0)
  const totalActualCa = [...actualSalesByClientId.values()]
    .flat()
    .reduce((sum, row) => sum + (Number(row.order_value || 0) || 0), 0)

  const predictedCaErrors = allMatches
    .map(item => {
      const predicted = Number(item.visit.predicted_ca)
      const actual = Number(item.purchase.order_value)
      return Number.isFinite(predicted) && Number.isFinite(actual)
        ? Math.abs(predicted - actual)
        : null
    })
    .filter(Number.isFinite)
  const quantityErrors = allMatches
    .map(item => {
      const predicted = Number(item.visit.recommended_quantity)
      const actual = Number(item.purchase.order_quantity)
      return Number.isFinite(predicted) && Number.isFinite(actual)
        ? Math.abs(predicted - actual)
        : null
    })
    .filter(Number.isFinite)

  const frequentClientIds = [...recommendedVisitsByClientId.entries()]
    .filter(([, clientVisits]) => Number(clientVisits[0]?.recommended_visit_interval_days) <= 7)
    .map(([clientId]) => clientId)
  const frequentClientsWithRepeatPurchases = frequentClientIds.filter(clientId => (
    (actualSalesByClientId.get(clientId) || []).length >= 2
  ))
  const frequentRepeatDetected = frequentClientsWithRepeatPurchases.filter(clientId => (
    (recommendedVisitsByClientId.get(clientId) || []).length >= 2
  ))

  const monthlyClientIds = [...recommendedVisitsByClientId.entries()]
    .filter(([, clientVisits]) => Number(clientVisits[0]?.recommended_visit_interval_days) >= 21)
    .map(([clientId]) => clientId)
  const monthlyOvervisited = monthlyClientIds.filter(clientId => (
    (recommendedVisitsByClientId.get(clientId) || []).length > 1
  ))

  return {
    recommended_visits_count: visits.length,
    unique_recommended_clients: recommendedVisitsByClientId.size,
    actual_buyers_in_period: actualBuyerClientIds.size,
    recommended_clients_who_bought: matchedClientIds.size,
    precision_at_capacity: visits.length > 0 ? roundPercent((allMatches.length / visits.length) * 100) : null,
    buyer_recall: actualBuyerClientIds.size > 0 ? roundPercent((matchedClientIds.size / actualBuyerClientIds.size) * 100) : null,
    actual_ca_captured: roundNumber(actualCaCaptured, 2),
    percentage_of_period_ca_captured: totalActualCa > 0 ? roundPercent((actualCaCaptured / totalActualCa) * 100) : null,
    average_actual_ca_per_recommended_visit: visits.length > 0 ? roundNumber(actualCaCaptured / visits.length, 2) : null,
    visits_without_purchase: Math.max(0, visits.length - allMatches.length),
    purchase_hit_rate: visits.length > 0 ? roundPercent((allMatches.length / visits.length) * 100) : null,
    predicted_ca_mae: roundNumber(average(predictedCaErrors), 2),
    quantity_mae: roundNumber(average(quantityErrors), 2),
    date_error_days: roundNumber(average(allMatches.map(item => item.date_error_days)), 2),
    cadence_due_hit_rate: allMatches.length > 0
      ? roundPercent((allMatches.filter(item => Number(item.visit.cadence_due_score) >= 60).length / allMatches.length) * 100)
      : null,
    frequent_client_repeat_detection_rate: frequentClientsWithRepeatPurchases.length > 0
      ? roundPercent((frequentRepeatDetected.length / frequentClientsWithRepeatPurchases.length) * 100)
      : null,
    monthly_client_overvisit_rate: monthlyClientIds.length > 0
      ? roundPercent((monthlyOvervisited.length / monthlyClientIds.length) * 100)
      : null,
    tolerance_hits: {
      same_day: visits.length > 0
        ? allMatches.filter(item => item.date_error_days === 0).length
        : 0,
      plus_minus_1: allMatches.length,
      plus_minus_3: null
    }
  }
}

function extendToleranceMetrics(baseMetrics, assignment, actualSalesByClientId) {
  const visits = flattenAssignedVisits(assignment)
  const byClientId = buildRecommendedVisitsByClientId(visits)
  const matchesWithinThreeDays = []
  byClientId.forEach((clientVisits, clientId) => {
    const purchases = actualSalesByClientId.get(clientId) || []
    matchesWithinThreeDays.push(...matchVisitsToPurchases(clientVisits, purchases, 3).matches)
  })
  return {
    ...baseMetrics,
    tolerance_hits: {
      ...(baseMetrics.tolerance_hits || {}),
      plus_minus_3: matchesWithinThreeDays.length
    }
  }
}

function summarizeV2ServiceValidation(v2Payload = {}) {
  const summary = v2Payload && typeof v2Payload === 'object' ? (v2Payload.summary || {}) : {}
  const payloadStatus = String(v2Payload?.status || '').trim().toLowerCase()
  const snapshotStatus = String(
    summary?.profile_snapshot_status ||
    v2Payload?.diagnostics?.profile_snapshot_status ||
    ''
  ).trim().toLowerCase()

  if (payloadStatus === 'success') {
    const selectedVisitsCount = summary?.selected_visits_count ?? summary?.recommended_visits_count
    return {
      v2_selected_visits_count: selectedVisitsCount == null ? null : Number(selectedVisitsCount),
      v2_service_validation_status: 'executed'
    }
  }

  if (snapshotStatus) {
    return {
      v2_selected_visits_count: null,
      v2_service_validation_status: `not_executed_snapshot_${snapshotStatus}`
    }
  }

  return {
    v2_selected_visits_count: null,
    v2_service_validation_status: 'not_executed'
  }
}

function buildStrategyScores(opportunities = [], strategy, seed) {
  if (strategy === 'v2') {
    return serviceTestables.computeOpportunityScoring(opportunities, 'balanced')
  }

  return opportunities.map(opportunity => {
    let score = 0
    if (strategy === 'random') {
      score = buildDeterministicScore(seed, opportunity.visit_opportunity_id)
    } else if (strategy === 'recency') {
      score = Number(opportunity.days_since_last_purchase || 0) * 1000
        + Number(opportunity.predicted_ca || 0)
        + Number(opportunity.purchase_probability || 0)
    } else if (strategy === 'vip') {
      score = Number(opportunity.prediction_vip || 0) * 1000
        + Number(opportunity.predicted_ca || 0)
        + Number(opportunity.purchase_probability || 0)
    } else if (strategy === 'probability_only') {
      score = Number(opportunity.purchase_probability || 0) * 1000
        + Number(opportunity.predicted_ca || 0)
    }

    return {
      ...opportunity,
      visit_opportunity_score: score
    }
  })
}

function runStrategyAssignment({
  opportunities = [],
  slots = [],
  strategy,
  requestContext,
  seed
}) {
  const startedAt = Date.now()
  const scored = buildStrategyScores(opportunities, strategy, seed)
  const assignment = assignVisitOpportunities({
    opportunities: scored,
    slots: cloneSlots(slots),
    options: {
      respectAvailability: requestContext.respectAvailability,
      minimumConfidence: requestContext.minimumConfidence,
      minimumVisitsPreference: requestContext.minVisitsPerDayPreference
    }
  })

  return {
    assignment,
    runtime_ms: Math.max(0, Date.now() - startedAt)
  }
}

async function buildBacktestContext({
  cutoff,
  startDate,
  horizonDays,
  commercialCodes = [],
  requestOverrides = {}
}) {
  const allCommercials = await serverTestables.fetchCommercialOptions()
  const selectedCommercials = commercialCodes.length
    ? allCommercials.filter(item => commercialCodes.includes(item.value))
    : allCommercials
  const requestContext = {
    startDate,
    historicalCutoffDate: cutoff,
    planningHorizonDays: horizonDays,
    minVisitsPerDayPreference: Number(requestOverrides.min_visits ?? 0) || 0,
    maxVisitsPerDay: Number(requestOverrides.max_visits ?? 8) || 8,
    minDailyCaPerCommercial: null,
    commercialCodes: selectedCommercials.map(item => item.value),
    objectiveMode: 'balanced',
    maxDaysWithoutContact: Number(requestOverrides.max_days_without_contact ?? 21) || 21,
    respectAvailability: String(requestOverrides.respect_availability || 'flexible'),
    minimumConfidence: Number(requestOverrides.minimum_confidence ?? 0) || 0,
    dailyMaxMode: 'flexible',
    maxCandidateDatesPerClient: Number(requestOverrides.max_candidate_dates_per_client ?? 4) || 4
  }
  const clientsResult = await serverTestables.fetchCoverageActiveClients({
    selectedCommercialCodes: selectedCommercials.map(item => item.value),
    selectedClientIds: [],
    startDate,
    allCommercialsSelected: selectedCommercials.length === allCommercials.length,
    clientScope: null
  })
  const clients = clientsResult.clients || []
  const planningDates = buildPlanningDates(startDate, horizonDays)
  const coverageConstraints = await serverTestables.loadCoverageConstraintsForApi({
    startDate,
    endDate: planningDates[planningDates.length - 1],
    commercialCodes: selectedCommercials.map(item => item.value),
    clientIds: clients.map(client => client.client_id)
  })
  const [salesHistoryByClientId, visitHistoryByClientId, salesThroughHorizonByClientId] = await Promise.all([
    serviceTestables.fetchSalesHistoryForClients({
      queryAsync: serverTestables.queryAsync,
      activeClients: clients,
      referenceDate: cutoff
    }),
    serviceTestables.fetchVisitHistoryForClients({
      queryAsync: serverTestables.queryAsync,
      activeClients: clients,
      referenceDate: cutoff
    }),
    serviceTestables.fetchSalesHistoryForClients({
      queryAsync: serverTestables.queryAsync,
      activeClients: clients,
      referenceDate: planningDates[planningDates.length - 1]
    })
  ])
  const cadenceProfiles = buildCadenceProfiles({
    clients,
    salesHistoryByClientId,
    visitHistoryByClientId,
    referenceDate: cutoff,
    maxDaysWithoutContact: requestContext.maxDaysWithoutContact
  })
  const candidateDatesByClientId = serviceTestables.buildCandidateDatesByClientId(cadenceProfiles, requestContext)
  const predictionFetchResult = await serviceTestables.fetchDateSpecificPredictions({
    clients,
    candidateDatesByClientId,
    fetchAiPredictionsForClientBatch: serverTestables.fetchAiPredictionsForClientBatch
  })
  const predictionsByClientDate = serviceTestables.remapPredictionsByClientId(
    clients,
    predictionFetchResult.predictionsByClientDate
  )
  const compatibleCommercialCodesByClientId = serviceTestables.buildCompatibleCommercialCodesByClientId(
    clients,
    selectedCommercials,
    coverageConstraints
  )
  const depotByCommercialDate = serviceTestables.buildDepotByCommercialDate(
    coverageConstraints,
    selectedCommercials,
    planningDates,
    serverTestables.sharedDepotOrigin
  )
  const opportunities = buildVisitOpportunities({
    clients,
    cadenceProfiles,
    predictionsByClientDate,
    compatibleCommercialCodesByClientId,
    depotByCommercialDate,
    options: {
      startDate,
      planningHorizonDays: horizonDays,
      maxCandidateDatesPerClient: requestContext.maxCandidateDatesPerClient,
      maxDaysWithoutContact: requestContext.maxDaysWithoutContact,
      candidateDatesByClientId
    }
  })
  const slots = buildCommercialSlots({
    planningDates,
    selectedCommercials,
    commercialConstraintsByCode: new Map(Object.entries(coverageConstraints?.commercials || {})),
    requestMaxVisits: requestContext.maxVisitsPerDay,
    minDailyCaPerCommercial: requestContext.minDailyCaPerCommercial
  })

  return {
    requestContext,
    selectedCommercials,
    clients,
    cadenceProfiles,
    candidateDatesByClientId,
    predictionCoverageByDate: predictionFetchResult.coverageByDate,
    opportunities,
    slots,
    actualSalesByClientId: buildActualPurchaseMap(
      salesThroughHorizonByClientId,
      startDate,
      planningDates[planningDates.length - 1]
    ),
    diagnostics: {
      active_clients_count: clients.length,
      full_cartesian_pair_count: clients.length * planningDates.length * Math.max(1, selectedCommercials.length),
      sparse_candidate_dates_count: [...candidateDatesByClientId.values()].reduce((sum, values) => sum + values.length, 0),
      opportunities_count: opportunities.length,
      average_opportunities_per_client: clients.length > 0 ? roundNumber(opportunities.length / clients.length, 3) : null,
      maximum_opportunities_per_client: [...candidateDatesByClientId.values()].reduce((maxValue, values) => Math.max(maxValue, values.length), 0),
      sparsity_ratio: clients.length > 0 && planningDates.length > 0 && selectedCommercials.length > 0
        ? roundPercent((opportunities.length / (clients.length * planningDates.length * selectedCommercials.length)) * 100)
        : null
    }
  }
}

async function runWindowBacktest(windowConfig, options = {}) {
  const context = await buildBacktestContext({
    ...windowConfig,
    requestOverrides: {
      ...(windowConfig.requestOverrides || {}),
      ...(options.requestOverrides || {})
    }
  })
  const seed = `${windowConfig.label}::${windowConfig.cutoff}::${windowConfig.startDate}`
  const v2Result = runStrategyAssignment({
    opportunities: context.opportunities,
    slots: context.slots,
    strategy: 'v2',
    requestContext: context.requestContext,
    seed
  })
  const randomResult = runStrategyAssignment({
    opportunities: context.opportunities,
    slots: context.slots,
    strategy: 'random',
    requestContext: context.requestContext,
    seed
  })
  const recencyResult = runStrategyAssignment({
    opportunities: context.opportunities,
    slots: context.slots,
    strategy: 'recency',
    requestContext: context.requestContext,
    seed
  })
  const vipResult = runStrategyAssignment({
    opportunities: context.opportunities,
    slots: context.slots,
    strategy: 'vip',
    requestContext: context.requestContext,
    seed
  })
  const probabilityOnlyResult = runStrategyAssignment({
    opportunities: context.opportunities,
    slots: context.slots,
    strategy: 'probability_only',
    requestContext: context.requestContext,
    seed
  })

  const v2PayloadStartedAt = Date.now()
  const v2Payload = await generateNextBestVisitPlan({
    start_date: windowConfig.startDate,
    historical_cutoff_date: windowConfig.cutoff,
    planning_horizon_days: windowConfig.horizonDays,
    commercial_codes: context.selectedCommercials.map(item => item.value),
    objective_mode: 'balanced',
    max_clients: context.requestContext.maxVisitsPerDay,
    max_candidate_dates_per_client: context.requestContext.maxCandidateDatesPerClient,
    max_days_without_contact: context.requestContext.maxDaysWithoutContact,
    respect_availability: context.requestContext.respectAvailability,
    minimum_confidence: context.requestContext.minimumConfidence
  }, {
    fetchCommercialOptions: serverTestables.fetchCommercialOptions,
    fetchCoverageActiveClients: serverTestables.fetchCoverageActiveClients,
    loadCoverageConstraints: serverTestables.loadCoverageConstraintsForApi,
    fetchAiPredictionsForClientBatch: serverTestables.fetchAiPredictionsForClientBatch,
    queryAsync: serverTestables.queryAsync,
    sharedDepotOrigin: serverTestables.sharedDepotOrigin
  })
  const v2PayloadRuntimeMs = Math.max(0, Date.now() - v2PayloadStartedAt)
  const v2ServiceValidation = summarizeV2ServiceValidation(v2Payload)

  const strategyResults = {
    v2: v2Result,
    random: randomResult,
    recency: recencyResult,
    vip: vipResult,
    probability_only: probabilityOnlyResult
  }
  const metricsByStrategy = {}
  Object.entries(strategyResults).forEach(([strategy, result]) => {
    const baseMetrics = computeWindowMetrics({
      assignment: result.assignment,
      actualSalesByClientId: context.actualSalesByClientId,
      toleranceDays: 1
    })
    metricsByStrategy[strategy] = extendToleranceMetrics(
      {
        ...baseMetrics,
        runtime_ms: result.runtime_ms
      },
      result.assignment,
      context.actualSalesByClientId
    )
  })

  return {
    window: windowConfig,
    cadence_summary: summarizeCadenceProfiles(context.cadenceProfiles),
    prediction_coverage_by_date: context.predictionCoverageByDate,
    diagnostics: context.diagnostics,
    v2_payload_runtime_ms: v2PayloadRuntimeMs,
    v2_payload_diagnostics: v2Payload.diagnostics || {},
    v2_payload_performance: v2Payload.meta?.performance?.stages || [],
    v2_selected_visits_count: v2ServiceValidation.v2_selected_visits_count,
    v2_service_validation_status: v2ServiceValidation.v2_service_validation_status,
    metrics_by_strategy: metricsByStrategy
  }
}

function aggregateStrategyMetrics(windowResults = [], strategy) {
  const metrics = windowResults
    .map(result => result.metrics_by_strategy?.[strategy])
    .filter(Boolean)
  if (!metrics.length) return null

  const sumField = fieldName => metrics.reduce((sum, item) => sum + (Number(item[fieldName] || 0) || 0), 0)
  const avgField = fieldName => roundNumber(average(metrics.map(item => item[fieldName])), 2)

  return {
    recommended_visits_count: sumField('recommended_visits_count'),
    unique_recommended_clients: sumField('unique_recommended_clients'),
    actual_buyers_in_period: sumField('actual_buyers_in_period'),
    recommended_clients_who_bought: sumField('recommended_clients_who_bought'),
    precision_at_capacity: avgField('precision_at_capacity'),
    buyer_recall: avgField('buyer_recall'),
    actual_ca_captured: roundNumber(sumField('actual_ca_captured'), 2),
    percentage_of_period_ca_captured: avgField('percentage_of_period_ca_captured'),
    average_actual_ca_per_recommended_visit: avgField('average_actual_ca_per_recommended_visit'),
    visits_without_purchase: sumField('visits_without_purchase'),
    purchase_hit_rate: avgField('purchase_hit_rate'),
    predicted_ca_mae: avgField('predicted_ca_mae'),
    quantity_mae: avgField('quantity_mae'),
    date_error_days: avgField('date_error_days'),
    cadence_due_hit_rate: avgField('cadence_due_hit_rate'),
    frequent_client_repeat_detection_rate: avgField('frequent_client_repeat_detection_rate'),
    monthly_client_overvisit_rate: avgField('monthly_client_overvisit_rate'),
    runtime_ms: avgField('runtime_ms')
  }
}

async function runNextBestVisitBacktest(options = {}) {
  const windows = Array.isArray(options.windows) && options.windows.length
    ? options.windows
    : DEFAULT_BACKTEST_WINDOWS
  const cadenceSummary = await auditCadenceSnapshot({
    referenceDate: options.cadenceReferenceDate || '2026-08-03',
    maxDaysWithoutContact: Number(options.maxDaysWithoutContact ?? 21) || 21
  })
  const windowResults = []
  for (const windowConfig of windows) {
    windowResults.push(await runWindowBacktest(windowConfig, options))
  }

  return {
    windows: windowResults,
    aggregated: {
      cadence_summary: cadenceSummary,
      strategies: {
        v2: aggregateStrategyMetrics(windowResults, 'v2'),
        random: aggregateStrategyMetrics(windowResults, 'random'),
        recency: aggregateStrategyMetrics(windowResults, 'recency'),
        vip: aggregateStrategyMetrics(windowResults, 'vip'),
        probability_only: aggregateStrategyMetrics(windowResults, 'probability_only'),
        v1: null
      },
      timings: {
        v2_end_to_end_runtime_ms_average: roundNumber(average(windowResults.map(result => result.v2_payload_runtime_ms)), 2),
        v2_end_to_end_runtime_ms_max: roundNumber(Math.max(...windowResults.map(result => Number(result.v2_payload_runtime_ms || 0))), 2)
      }
    }
  }
}

async function auditCadenceSnapshot({
  referenceDate = '2026-08-03',
  maxDaysWithoutContact = 21
} = {}) {
  const allCommercials = await serverTestables.fetchCommercialOptions()
  const clientsResult = await serverTestables.fetchCoverageActiveClients({
    selectedCommercialCodes: allCommercials.map(item => item.value),
    selectedClientIds: [],
    startDate: referenceDate,
    allCommercialsSelected: true,
    clientScope: null
  })
  const clients = clientsResult.clients || []
  const [salesHistoryByClientId, visitHistoryByClientId] = await Promise.all([
    serviceTestables.fetchSalesHistoryForClients({
      queryAsync: serverTestables.queryAsync,
      activeClients: clients,
      referenceDate
    }),
    serviceTestables.fetchVisitHistoryForClients({
      queryAsync: serverTestables.queryAsync,
      activeClients: clients,
      referenceDate
    })
  ])
  const cadenceProfiles = buildCadenceProfiles({
    clients,
    salesHistoryByClientId,
    visitHistoryByClientId,
    referenceDate,
    maxDaysWithoutContact
  })
  return summarizeCadenceProfiles(cadenceProfiles)
}

module.exports = {
  DEFAULT_BACKTEST_WINDOWS,
  aggregateStrategyMetrics,
  auditCadenceSnapshot,
  buildBacktestContext,
  buildCadenceBucket,
  computeWindowMetrics,
  matchVisitsToPurchases,
  runNextBestVisitBacktest,
  runWindowBacktest,
  summarizeV2ServiceValidation,
  summarizeCadenceProfiles
}

if (require.main === module) {
  runNextBestVisitBacktest()
    .then(result => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return serverTestables.closeOpenHandles()
    })
    .then(() => process.exit(0))
    .catch(async error => {
      console.error(error)
      await serverTestables.closeOpenHandles()
      process.exit(1)
    })
}

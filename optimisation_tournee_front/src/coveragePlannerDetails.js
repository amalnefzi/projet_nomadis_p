import {
  formatDistanceKm,
  formatInteger,
  formatNullableCurrency
} from './coveragePlannerUtils.js'
import {
  formatDistanceMeters,
  formatDurationMinutes,
  formatDurationSeconds
} from './tourRouteUtils.js'

export const PRIORITY_REASON_LABELS = {
  credit_overdue: 'Credit echu',
  expected_payment_date_reached: 'Paiement attendu',
  high_expected_collection: 'Encaissement important',
  coverage_deadline_near: 'Visite urgente',
  habitual_commercial: 'Commercial habituel',
  low_route_detour: 'Faible detour',
  recovery_data_unavailable: 'Recouvrement indisponible',
  high_purchase_prediction: "Forte opportunite d'achat",
  predicted_purchase_date_near: 'Achat prevu prochainement',
  high_expected_order_value: 'Chiffre predit eleve',
  purchase_prediction_unavailable: 'Prediction indisponible'
}

export const ASSIGNMENT_REASON_LABELS = {
  usual_commercial: 'Commercial habituel',
  same_zone: 'Meme zone',
  nearest_commercial: 'Commercial le plus proche',
  capacity_balance: 'Reaffecte (capacite / temps)',
  only_available_commercial: 'Seul commercial disponible',
  optimisation_globale: 'Optimisation globale'
}

export function buildAssignmentReasonModel(client = {}) {
  const explanation = client?.assignment_explanation
  if (!explanation || typeof explanation !== 'object') {
    return {
      primaryReason: null,
      primaryLabel: 'Raison : non precisee',
      reasonLabels: [],
      distanceKm: null,
      zone: null
    }
  }
  const primaryReason = String(explanation.primary_reason || '').trim() || null
  const reasonLabels = Array.isArray(explanation.reason_labels)
    ? explanation.reason_labels.map(label => String(label || '').trim()).filter(Boolean)
    : []
  return {
    primaryReason,
    primaryLabel: primaryReason
      ? (ASSIGNMENT_REASON_LABELS[primaryReason] || reasonLabels[0] || primaryReason)
      : 'Raison : non precisee',
    reasonLabels,
    distanceKm: Number.isFinite(Number(explanation.distance_km)) ? Number(explanation.distance_km) : null,
    zone: String(explanation.zone || '').trim() || null
  }
}

export function buildAssignmentReasonSummary(block = {}) {
  const counts = block?.assignment_reason_counts
  if (!counts || typeof counts !== 'object') return []
  return Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]) || String(left[0]).localeCompare(String(right[0])))
    .map(([reason, count]) => ({
      reason,
      count: Number(count),
      label: ASSIGNMENT_REASON_LABELS[reason] || reason
    }))
}

const FRENCH_DAY_LABELS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi']

const RECOVERY_HIDDEN_REASON_CODES = new Set([
  'high_purchase_prediction',
  'predicted_purchase_date_near',
  'high_expected_order_value',
  'purchase_prediction_unavailable'
])

export function translatePriorityReasons(reasonCodes = []) {
  return [...new Set((Array.isArray(reasonCodes) ? reasonCodes : [])
    .filter(reason => !RECOVERY_HIDDEN_REASON_CODES.has(reason))
    .map(reason => PRIORITY_REASON_LABELS[reason] || reason)
    .filter(Boolean))]
}

function hasValidGps(client = {}) {
  if (client?.latitude === null || client?.latitude === undefined || client?.latitude === '') return false
  if (client?.longitude === null || client?.longitude === undefined || client?.longitude === '') return false
  return Number.isFinite(Number(client.latitude)) && Number.isFinite(Number(client.longitude))
}

function normalizeExactString(value) {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

function normalizeNullableNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null
  }

  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue : null
}

function normalizeMetricNumber(value, fallback = 0) {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue : fallback
}

function buildCoverageClientIdentity(client = {}) {
  return {
    clientId: normalizeExactString(client?.client_id ?? client?.clientId ?? client?.id ?? client?.client_unique_key),
    clientCode: normalizeExactString(client?.client_code ?? client?.clientCode ?? client?.nbr_client)
  }
}

function buildCoverageValidationRouteOrderIndex(routePlan = null) {
  return (Array.isArray(routePlan?.orderedStops) ? routePlan.orderedStops : []).reduce((accumulator, stop, index) => {
    const step = Number(stop?.step)
    const rank = Number.isFinite(step) && step > 0 ? step : index + 1
    const clientId = normalizeExactString(stop?.client_id ?? stop?.clientId)
    const clientCode = normalizeExactString(stop?.client_code ?? stop?.clientCode ?? stop?.id)

    if (clientId && !(clientId in accumulator.byClientId)) {
      accumulator.byClientId[clientId] = rank
    }

    if (clientCode && !(clientCode in accumulator.byClientCode)) {
      accumulator.byClientCode[clientCode] = rank
    }

    return accumulator
  }, {
    byClientId: {},
    byClientCode: {}
  })
}

function deriveCoverageDayLabel(dateValue) {
  const normalizedDate = normalizeExactString(dateValue)
  if (!normalizedDate) {
    return null
  }

  const parsedDate = new Date(`${normalizedDate}T00:00:00`)
  if (Number.isNaN(parsedDate.getTime())) {
    return null
  }

  return FRENCH_DAY_LABELS[parsedDate.getDay()] || null
}

export function buildCoverageFeasibilityMetrics(responseData = {}) {
  const analysis = responseData?.analysis && typeof responseData.analysis === 'object'
    ? responseData.analysis
    : {}
  const feasibility = analysis?.feasibility && typeof analysis.feasibility === 'object'
    ? analysis.feasibility
    : {}
  const inputSummary = analysis?.input_summary && typeof analysis.input_summary === 'object'
    ? analysis.input_summary
    : {}
  const summary = responseData?.summary && typeof responseData.summary === 'object'
    ? responseData.summary
    : {}
  const diagnostics = responseData?.diagnostics && typeof responseData.diagnostics === 'object'
    ? responseData.diagnostics
    : {}
  const recoveryEligibility = diagnostics?.recovery_eligibility && typeof diagnostics.recovery_eligibility === 'object'
    ? diagnostics.recovery_eligibility
    : {}
  const operational = responseData?.operational && typeof responseData.operational === 'object'
    ? responseData.operational
    : {}
  const requestContext = responseData?.request_context && typeof responseData.request_context === 'object'
    ? responseData.request_context
    : {}
  const clientScope = responseData?.client_scope && typeof responseData.client_scope === 'object'
    ? responseData.client_scope
    : {}
  const capacityPrecheck = responseData?.capacity_precheck && typeof responseData.capacity_precheck === 'object'
    ? responseData.capacity_precheck
    : {}
  const nonEmptyBlocksCount = (Array.isArray(responseData?.blocks) ? responseData.blocks : [])
    .filter(block => normalizeMetricNumber(block?.clients_count, 0) > 0)
    .length
  const activeClientsCount = normalizeMetricNumber(
    capacityPrecheck.active_clients_count ??
    clientScope.active_clients_count
  )
  const recoverableClientsCount = normalizeMetricNumber(
    recoveryEligibility.eligible_count ??
    summary.clients_to_cover ??
    feasibility.clients_to_cover ??
    analysis.clients_to_cover ??
    capacityPrecheck.required_visits_count
  )
  const theoreticalTotalSlots = normalizeMetricNumber(
    capacityPrecheck.available_slots_count ??
    analysis.theoretical_total_slots ??
    summary.total_slots
  )
  const totalSlots = normalizeMetricNumber(
    capacityPrecheck.available_slots_after_constraints_count ??
    analysis.total_slots ??
    summary.total_slots ??
    capacityPrecheck.available_slots_count
  )
  const strictCapacity = normalizeMetricNumber(capacityPrecheck.strict_capacity)
  const requiredVisitsCount = normalizeMetricNumber(
    capacityPrecheck.required_visits_count ??
    feasibility.clients_to_cover ??
    summary.clients_to_cover ??
    analysis.clients_to_cover
  )
  const requiredAveragePerSlot = normalizeMetricNumber(
    capacityPrecheck.minimum_required_average ??
    summary.required_average_per_slot ??
    feasibility.required_average_per_slot ??
    analysis.required_average_per_slot
  )

  return {
    activeClientsCount,
    recoverableClientsCount,
    plannedClientsCount: normalizeMetricNumber(
      summary.total_visits ??
      summary.unique_clients_covered ??
      summary.clients_to_cover
    ),
    plannedBlocksCount: normalizeMetricNumber(summary.used_slots ?? nonEmptyBlocksCount),
    selectedCommercialsCount: normalizeMetricNumber(
      clientScope.selected_commercial_codes_count ??
      inputSummary.selected_commercials_count ??
      analysis.selected_commercials_count
    ),
    activeDaysCount: normalizeMetricNumber(
      summary.planning_horizon_days ??
      capacityPrecheck.planning_horizon_days ??
      requestContext.planning_horizon_days ??
      inputSummary.planning_days ??
      analysis.active_days_count
    ),
    theoreticalTotalSlots,
    totalSlots,
    strictCapacity,
    capacityTotal: normalizeMetricNumber(
      analysis.capacity_total ??
      summary.total_capacity ??
      strictCapacity
    ),
    requiredVisitsCount,
    totalRequiredClients: normalizeMetricNumber(
      analysis.total_required_clients ??
      operational.total_required_clients ??
      requiredVisitsCount ??
      recoverableClientsCount
    ),
    capacityDeficit: normalizeMetricNumber(capacityPrecheck.capacity_deficit),
    minimumRequiredAverage: requiredAveragePerSlot,
    requiredAveragePerSlot,
    minimumRequiredPeakEstimate: normalizeMetricNumber(
      capacityPrecheck.minimum_required_peak_estimate ??
      summary.required_minimum_max_per_slot ??
      feasibility.required_minimum_max_per_slot
    ),
    userMaxCapacity: normalizeMetricNumber(
      analysis.user_max_capacity ??
      requestContext.user_max_visits_per_slot
    ),
    adjustedTargetMaxCapacity: normalizeMetricNumber(
      analysis.adjusted_target_max_capacity ??
      requestContext.adjusted_target_max_visits_per_slot ??
      requestContext.default_max_visits_per_slot
    ),
    recommendedMaxCapacity: normalizeMetricNumber(
      analysis.recommended_max_capacity ??
      requestContext.recommended_max_capacity
    ),
    unavailableSlotsRemoved: normalizeMetricNumber(
      analysis.unavailable_slots_removed ??
      Math.max(0, theoreticalTotalSlots - totalSlots)
    ),
    missingClientsCount: normalizeMetricNumber(
      summary.missing_clients_count ??
      capacityPrecheck.visits_non_planned_count
    ),
    clientsToCover: recoverableClientsCount,
    capacityMode: String(summary.capacity_mode || analysis.capacity_mode || operational.capacity_mode || requestContext.capacity_mode || 'unknown'),
    operationalCapacityKnown: Boolean(
      summary.operational_capacity_known ??
      analysis.operational_capacity_known ??
      operational.operational_capacity_known ??
      requestContext.operational_capacity_known
    ),
    salesActivityProxyTotal: normalizeMetricNumber(
      summary.sales_activity_proxy_total ??
      analysis.sales_activity_proxy_total ??
      operational.sales_activity_proxy_total ??
      requestContext.sales_activity_proxy_total
    ),
    requiredToSalesProxyRatio: normalizeMetricNumber(
      analysis.required_to_sales_proxy_ratio ??
      operational.required_to_sales_proxy_ratio
    ),
    plannedToSalesProxyRatio: normalizeMetricNumber(
      summary.planned_to_sales_proxy_ratio ??
      operational.planned_to_sales_proxy_ratio
    ),
    totalHistoricalCapacity: normalizeMetricNumber(
      summary.total_historical_capacity ??
      analysis.total_historical_capacity ??
      operational.total_historical_capacity
    ),
    operationalCapacityGap: normalizeMetricNumber(
      summary.operational_capacity_gap ??
      analysis.operational_capacity_gap ??
      operational.operational_capacity_gap
    ),
    requiredCapacityMultiplier: normalizeMetricNumber(
      summary.required_capacity_multiplier ??
      analysis.required_capacity_multiplier ??
      operational.required_capacity_multiplier
    ),
    estimatedExtraCommercialDays: normalizeNullableNumber(
      summary.estimated_extra_commercial_days ??
      summary.estimated_extra_commercial_days_needed ??
      analysis.estimated_extra_commercial_days ??
      analysis.estimated_extra_commercial_days_needed ??
      operational.estimated_extra_commercial_days ??
      operational.estimated_extra_commercial_days_needed
    ),
    operationalStatus: String(summary.operational_status || analysis.operational_status || operational.status || 'unknown'),
    operationalStatusLabel: String(summary.operational_status_label || analysis.operational_status_label || operational.status_label || 'Capacite terrain non mesuree')
  }
}

export function buildCoverageBlockValidationScopeKey(block = {}) {
  const slotId = normalizeExactString(block?.slot_id ?? block?.slotId) || 'slot:none'
  const planningDate = normalizeExactString(block?.date) || 'date:none'
  const commercialCode = normalizeExactString(block?.commercial_code ?? block?.commercialCode) || 'commercial:none'
  const clientFingerprint = (Array.isArray(block?.clients) ? block.clients : [])
    .map((client, index) => {
      const identity = buildCoverageClientIdentity(client)
      return `${index + 1}:${identity.clientId || 'id:none'}:${identity.clientCode || 'code:none'}`
    })
    .join('|')

  return [slotId, planningDate, commercialCode, clientFingerprint].join('::')
}

export function resolveCoverageValidationExecutionRank(client = {}, routeOrderIndex = null, fallbackRank = 1) {
  const normalizedFallbackRank = Number.isFinite(Number(fallbackRank)) && Number(fallbackRank) > 0
    ? Number(fallbackRank)
    : 1
  const identity = buildCoverageClientIdentity(client)

  if (identity.clientId && routeOrderIndex?.byClientId?.[identity.clientId]) {
    return routeOrderIndex.byClientId[identity.clientId]
  }

  if (identity.clientCode && routeOrderIndex?.byClientCode?.[identity.clientCode]) {
    return routeOrderIndex.byClientCode[identity.clientCode]
  }

  return normalizedFallbackRank
}

export function buildCoverageBlockValidationPayload(
  block = {},
  routePlan = null,
  { depotOrigin = null, predictionRunCode = null } = {}
) {
  const planningDate = normalizeExactString(block?.date)
  const commercialCode = normalizeExactString(block?.commercial_code ?? block?.commercialCode)
  const routeOrderIndex = buildCoverageValidationRouteOrderIndex(routePlan)
  const depotCode = normalizeExactString(
    block?.depot_code ??
    block?.depotCode ??
    block?.depot?.depot_code ??
    block?.depot?.code ??
    depotOrigin?.depot_code ??
    depotOrigin?.code
  ) || ''
  const depotName = normalizeExactString(
    block?.depot_name ??
    block?.depotName ??
    block?.depot?.nom ??
    block?.depot?.name ??
    depotOrigin?.nom ??
    depotOrigin?.name
  ) || ''

  return {
    date: planningDate,
    day_label: normalizeExactString(block?.day_label ?? block?.dayLabel) || deriveCoverageDayLabel(planningDate),
    commercial_code: commercialCode,
    commercial_label: normalizeExactString(block?.commercial_label ?? block?.commercialLabel) || commercialCode,
    route_code: normalizeExactString(block?.route_code ?? block?.routeCode) || '',
    depot_code: depotCode,
    depot_name: depotName,
    prediction_run_code: normalizeExactString(predictionRunCode ?? block?.prediction_run_code ?? block?.predictionRunCode),
    stops: (Array.isArray(block?.clients) ? block.clients : [])
      .map((client, index) => {
        const identity = buildCoverageClientIdentity(client)

        return {
          client_id: identity.clientId,
          client_code: identity.clientCode,
          client_name: normalizeExactString(client?.client_name ?? client?.clientName ?? client?.nom) || identity.clientCode || `Client ${index + 1}`,
          adresse: normalizeExactString(client?.adresse ?? client?.address) || '',
          latitude: normalizeNullableNumber(client?.latitude),
          longitude: normalizeNullableNumber(client?.longitude),
          rang: resolveCoverageValidationExecutionRank(client, routeOrderIndex, index + 1)
        }
      })
      .filter(stop => stop.client_id || stop.client_code)
  }
}

export function shouldStartCoverageValidationRequest({
  isSubmitting = false,
  validationPhase = 'idle',
  isValidated = false
} = {}) {
  return !isSubmitting && validationPhase !== 'validating' && !isValidated
}

export function shouldApplyCoverageValidationResponse({
  requestId,
  activeRequestId,
  requestScopeKey,
  activeScopeKey,
  isMounted = true
} = {}) {
  return Boolean(
    isMounted &&
    requestId != null &&
    activeRequestId != null &&
    requestId === activeRequestId &&
    requestScopeKey &&
    activeScopeKey &&
    requestScopeKey === activeScopeKey
  )
}

export function resolveSelectedCoverageBlock(blocks = [], selectedBlockId = null) {
  const normalizedBlocks = Array.isArray(blocks) ? blocks : []
  return normalizedBlocks.find(block => block?.slot_id === selectedBlockId) || normalizedBlocks[0] || null
}

export function computeCoverageGpsStats(clients = []) {
  const total = Array.isArray(clients) ? clients.length : 0
  const mapped = (Array.isArray(clients) ? clients : []).filter(client => hasValidGps(client)).length

  return {
    total,
    mapped,
    unavailable: Math.max(0, total - mapped)
  }
}

export function buildCoverageSidebarCardModel(block = {}) {
  const clientsCount = Number(block?.clients_count || 0)
  const recoveryKnown = Number(block?.recovery_data_known_count ?? 0)
  const recoveryPartial = Boolean(block?.recovery_completeness === false)

  let completenessLabel = 'Donnees recouvrement completes'
  if (recoveryPartial) {
    completenessLabel = `Donnees recouvrement partielles : ${formatInteger(recoveryKnown)}/${formatInteger(clientsCount)}`
  }

  return {
    date: block?.date || '-',
    commercialLabel: block?.commercial_label || block?.commercial_code || '-',
    clientsLabel: `${formatInteger(clientsCount)} client(s)`,
    collectionLabel: block?.expected_collection_total == null
      ? 'Collecte connue : Non disponible'
      : `Collecte connue : ${formatNullableCurrency(block.expected_collection_total)}`,
    completenessLabel
  }
}

export function buildCoverageClientRows(block = {}) {
  const rows = (Array.isArray(block?.clients) ? block.clients : []).map((client, index) => ({
    clientId: String(client?.client_id || `client-${index + 1}`),
    clientCode: String(client?.client_code || ''),
    clientName: String(client?.client_name || client?.client_code || `Client ${index + 1}`),
    routeOrder: index + 1,
    zoneLabel: client?.zone || client?.zone_comm || client?.commercia_zone || null,
    gpsAvailable: hasValidGps(client),
    reasons: translatePriorityReasons(client?.priority_reasons),
    assignmentReason: buildAssignmentReasonModel(client),
    coverageUrgency: client?.priority_breakdown?.coverage_urgency ?? null,
    recoveryPriorityScore: client?.recovery_priority_score ?? null,
    totalBalance: client?.recovery_total_balance ?? null,
    dueAmount: client?.recovery_due_amount ?? null,
    overdueDays: client?.recovery_days_past_due ?? null,
    expectedCollectionAmount: client?.recovery_expected_collection_amount ?? null,
    paymentBehaviorScore: client?.recovery_payment_behavior_score ?? null,
    hasImpaye: Boolean(client?.recovery_has_impaye)
  }))

  // Ordre metier : le meilleur score IA de recouvrement en premier (comme le plan de
  // tournee classique). L'ordre physique de visite reste disponible via routeOrder.
  const num = value => (Number.isFinite(Number(value)) ? Number(value) : -1)
  rows.sort((left, right) =>
    num(right.recoveryPriorityScore) - num(left.recoveryPriorityScore) ||
    num(right.dueAmount) - num(left.dueAmount) ||
    num(right.totalBalance) - num(left.totalBalance) ||
    String(left.clientCode).localeCompare(String(right.clientCode))
  )

  return rows.map((row, index) => ({ ...row, order: index + 1 }))
}

export function buildCoverageDetailHeaderModel(block = {}, routePlan = null) {
  const gpsStats = computeCoverageGpsStats(block?.clients)
  const driveDistance = routePlan?.summary?.distance ?? null
  const driveDuration = routePlan?.summary?.duration ?? null
  const knownServiceMinutes = block?.time?.service_minutes_known_count === Number(block?.clients_count || 0)
    ? Number(block?.time?.service_minutes_total ?? 0)
    : null
  const breakMinutes = Number(block?.time?.break_minutes ?? 0)
  const totalEstimatedMinutes = (
    driveDuration != null &&
    knownServiceMinutes != null
  )
    ? Math.round((Number(driveDuration) / 60) + knownServiceMinutes + (Number.isFinite(breakMinutes) ? breakMinutes : 0))
    : null

  const routeEstimatedMinutes = Number(
    block?.time?.estimated_route_minutes ?? block?.estimated_duration_minutes ?? 0
  )
  const workdayMinutes = Number(block?.time?.max_route_minutes ?? 0)
  const exceedsWorkday = Boolean(
    block?.exceeds_workday ??
    (workdayMinutes > 0 && Number.isFinite(routeEstimatedMinutes) && routeEstimatedMinutes > workdayMinutes)
  )

  return {
    commercialLabel: block?.commercial_label || block?.commercial_code || '-',
    date: block?.date || '-',
    clientsLabel: `${formatInteger(block?.clients_count || 0)} client(s)`,
    zoneLabel: block?.main_zone || block?.zone || null,
    workdayLabel: workdayMinutes > 0
      ? `${formatDurationMinutes(Math.round(routeEstimatedMinutes))} / journee ${formatDurationMinutes(Math.round(workdayMinutes))}`
      : 'Non disponible',
    exceedsWorkday,
    assignmentReasonSummary: buildAssignmentReasonSummary(block),
    expectedCollectionLabel: block?.expected_collection_total == null
      ? 'Non disponible'
      : formatNullableCurrency(block.expected_collection_total),
    overdueBalanceLabel: block?.overdue_balance_total == null
      ? 'Non disponible'
      : formatNullableCurrency(block.overdue_balance_total),
    distanceLabel: driveDistance != null
      ? formatDistanceMeters(driveDistance)
      : formatDistanceKm(block?.estimated_distance_km || 0),
    driveDurationLabel: driveDuration != null
      ? formatDurationSeconds(driveDuration)
      : 'Non disponible',
    serviceDurationLabel: knownServiceMinutes != null
      ? formatDurationMinutes(knownServiceMinutes)
      : 'Non disponible',
    totalDurationLabel: totalEstimatedMinutes != null
      ? formatDurationMinutes(totalEstimatedMinutes)
      : formatDurationMinutes(block?.estimated_duration_minutes),
    gpsStats,
    recoveryPartial: block?.recovery_completeness === false
  }
}

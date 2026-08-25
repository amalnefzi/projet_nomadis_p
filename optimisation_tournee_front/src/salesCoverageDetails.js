import {
  DEFAULT_COVERAGE_PERIOD_DAYS,
  formatDecimal,
  formatDistanceKm,
  formatInteger,
  formatNullableCurrency,
  todayIsoDate
} from './coveragePlannerUtils.js'
import {
  formatDistanceMeters,
  formatDurationMinutes,
  formatDurationSeconds
} from './tourRouteUtils.js'

export const SALES_COVERAGE_FORM_FIELDS = [
  { id: 'start_date', label: 'Date de debut' },
  { id: 'period_days', label: 'Periode en jours' },
  { id: 'min_clients', label: 'Charge cible / commercial / jour' },
  { id: 'max_clients', label: 'Maximum / commercial / jour' },
  { id: 'min_daily_ca_per_commercial', label: 'CA minimum journalier' },
  { id: 'commercial_codes', label: 'Commerciaux' }
]

export const SALES_COVERAGE_ALL_COMMERCIALS = '__ALL_COMMERCIALS__'
export const SALES_COVERAGE_ALL_COMMERCIALS_LABEL = 'Tous les commerciaux'

export function listSalesCommercialValues(options = []) {
  return (Array.isArray(options) ? options : [])
    .map(option => String(option?.value ?? '').trim())
    .filter(Boolean)
}

export function normalizeSelectedSalesCommercialCodes(selection = [], options = []) {
  const availableValues = listSalesCommercialValues(options)
  const inputValues = Array.isArray(selection)
    ? selection
    : (
        selection === SALES_COVERAGE_ALL_COMMERCIALS
          ? availableValues
          : (selection === null || selection === undefined || String(selection).trim() === '' ? [] : [selection])
      )
  const seen = new Set()
  const normalizedInput = inputValues
    .map(value => String(value ?? '').trim())
    .filter(value => {
      if (!value || seen.has(value)) return false
      seen.add(value)
      return true
    })

  if (!availableValues.length) {
    return normalizedInput
  }

  return availableValues.filter(value => normalizedInput.includes(value))
}

export function areAllSalesCommercialsSelected(selection = [], options = []) {
  const availableValues = listSalesCommercialValues(options)
  if (!availableValues.length) return false
  const normalizedSelection = normalizeSelectedSalesCommercialCodes(selection, options)
  return availableValues.every(value => normalizedSelection.includes(value))
}

export function toggleAllSalesCommercialsSelection(selection = [], options = []) {
  return areAllSalesCommercialsSelected(selection, options)
    ? []
    : listSalesCommercialValues(options)
}

export function toggleSalesCommercialSelection(selection = [], commercialCode, options = []) {
  const normalizedSelection = normalizeSelectedSalesCommercialCodes(selection, options)
  const normalizedCode = String(commercialCode ?? '').trim()
  if (!normalizedCode) return normalizedSelection
  return normalizedSelection.includes(normalizedCode)
    ? normalizedSelection.filter(value => value !== normalizedCode)
    : [...normalizedSelection, normalizedCode]
}

export function getSalesCommercialSelectionLabel(selection = [], options = []) {
  const normalizedSelection = normalizeSelectedSalesCommercialCodes(selection, options)
  const availableValues = listSalesCommercialValues(options)
  if (availableValues.length && normalizedSelection.length === availableValues.length) {
    return SALES_COVERAGE_ALL_COMMERCIALS_LABEL
  }
  if (normalizedSelection.length === 1) {
    const matchingOption = (Array.isArray(options) ? options : []).find(
      option => String(option?.value ?? '').trim() === normalizedSelection[0]
    )
    return matchingOption?.label || normalizedSelection[0]
  }
  if (normalizedSelection.length > 1) {
    return `${formatInteger(normalizedSelection.length)} commerciaux selectionnes`
  }
  return 'Aucun commercial selectionne'
}

function normalizeDailyMaxMode(rawValue, fallbackValue = 'flexible') {
  return String(rawValue || fallbackValue).trim().toLowerCase() === 'strict'
    ? 'strict'
    : 'flexible'
}

function normalizeNullableNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function hasCoordinateValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function hasValidGps(client = {}) {
  return hasCoordinateValue(client?.latitude) &&
    hasCoordinateValue(client?.longitude) &&
    Number.isFinite(Number(client?.latitude)) &&
    Number.isFinite(Number(client?.longitude))
}

function normalizePredictedProducts(products = []) {
  return (Array.isArray(products) ? products : [])
    .map(item => {
      const productId = String(item?.product_id || '').trim() || null
      const productCode = String(item?.product_code || item?.produit_code || item?.code || '').trim() || null
      const productLabel = String(item?.product_label || item?.label || item?.name || item?.nom || '').trim() || null
      const estimatedQuantity = Number(item?.estimated_quantity ?? item?.quantity ?? item?.quantite)
      if ((!productId && !productCode && !productLabel) || !Number.isFinite(estimatedQuantity) || estimatedQuantity <= 0) {
        return null
      }
      return {
        productId,
        productCode,
        productLabel,
        estimatedQuantity: Number(estimatedQuantity.toFixed(2)),
        predictionSource: String(item?.prediction_source || item?.source || '').trim() || null,
        confidenceOrSupport: item?.confidence_or_support == null
          ? null
          : (Number.isFinite(Number(item.confidence_or_support))
              ? Number(Number(item.confidence_or_support).toFixed(2))
              : String(item.confidence_or_support).trim() || null)
      }
    })
    .filter(Boolean)
}

export function formatSalesProductPredictionSource(source) {
  switch (String(source || '').trim()) {
    case 'model':
      return 'Base sur le modele'
    case 'historical_pattern':
      return 'Base sur l historique client'
    case 'mixed':
      return 'Mixte modele + historique'
    case 'unavailable':
      return 'Non disponible'
    default:
      return 'Non disponible'
  }
}

export function formatSalesVisitExecutionStatus(status) {
  switch (String(status || '').trim()) {
    case 'visited':
      return 'Visite effectuee'
    case 'not_visited':
      return 'Non visite'
    case 'pending':
    default:
      return 'En attente'
  }
}

function normalizeDateOnly(value) {
  const normalized = String(value || '').trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null
}

function isKnownPredictionClient(client = {}) {
  const inferredPredictionKnown = (
    client?.purchase_prediction_score != null ||
    client?.recommended_quantity != null ||
    client?.expected_order_value != null ||
    Boolean(normalizeDateOnly(client?.predicted_purchase_date)) ||
    normalizePredictedProducts(client?.predicted_products).length > 0
  )

  return Boolean(
    client?.purchase_prediction_known ?? inferredPredictionKnown
  )
}

function compareSalesPriority(left = {}, right = {}) {
  const knownDelta = Number(isKnownPredictionClient(right)) - Number(isKnownPredictionClient(left))
  if (knownDelta !== 0) return knownDelta

  const scoreDelta = Number(right?.purchase_prediction_score ?? Number.NEGATIVE_INFINITY) -
    Number(left?.purchase_prediction_score ?? Number.NEGATIVE_INFINITY)
  if (scoreDelta !== 0) return scoreDelta

  const leftDate = normalizeDateOnly(left?.predicted_purchase_date) || '9999-12-31'
  const rightDate = normalizeDateOnly(right?.predicted_purchase_date) || '9999-12-31'
  if (leftDate !== rightDate) return leftDate.localeCompare(rightDate)

  const valueDelta = Number(right?.expected_order_value ?? Number.NEGATIVE_INFINITY) -
    Number(left?.expected_order_value ?? Number.NEGATIVE_INFINITY)
  if (valueDelta !== 0) return valueDelta

  return String(left?.client_id || '').localeCompare(String(right?.client_id || ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  })
}

function resolveCommercialZoneDisplay(client = {}) {
  const explicitDashboardLabel = String(client?.commercia_zone || '').trim()
  if (explicitDashboardLabel) {
    return {
      label: explicitDashboardLabel,
      zoneStatus: 'zone_resolved',
      zoneSource: 'commercial_zone'
    }
  }

  const declaredZoneStatus = String(client?.zone_resolution_status || '').trim()
  const declaredZoneSource = String(client?.zone_source || '').trim() || null

  const userCode = String(
    client?.user_code ||
    client?.commercial_code ||
    client?.historical_commercial_code ||
    client?.resolved_commercial_code ||
    ''
  ).trim()
  const delegation = String(client?.delegation || '').trim()
  if (userCode || delegation) {
    return {
      label: `Comm ${userCode || '-'} - ${delegation || 'Zone non renseignee'}`,
      zoneStatus: declaredZoneStatus || 'zone_resolved',
      zoneSource: declaredZoneSource || 'delegation_user_code'
    }
  }

  const zoneLikeLabel = String(
    client?.commercial_zone ||
    client?.zone_comm ||
    client?.routing_code ||
    client?.route_code ||
    client?.region ||
    ''
  ).trim()
  if (zoneLikeLabel) {
    return {
      label: zoneLikeLabel,
      zoneStatus: declaredZoneStatus || 'zone_resolved',
      zoneSource: declaredZoneSource || 'fallback_zone_field'
    }
  }

  const commercialFallback = String(
    client?.commercial_label ||
    client?.historical_commercial_code ||
    client?.resolved_commercial_code ||
    client?.commercial_code ||
    client?.user_code ||
    ''
  ).trim()

  if (declaredZoneStatus === 'zone_not_propagated') {
    return {
      label: 'Zone non transmise',
      zoneStatus: declaredZoneStatus,
      zoneSource: declaredZoneSource || 'missing'
    }
  }

  if (declaredZoneStatus === 'zone_source_missing') {
    return {
      label: 'Zone non renseignee',
      zoneStatus: declaredZoneStatus,
      zoneSource: declaredZoneSource || 'missing'
    }
  }

  return {
    label: commercialFallback || 'Zone non transmise',
    zoneStatus: declaredZoneStatus || 'zone_not_propagated',
    zoneSource: declaredZoneSource || 'missing'
  }
}

export function formatCommercialZone(client = {}) {
  return resolveCommercialZoneDisplay(client).label
}

function normalizeClient(client = {}) {
  const zoneDisplay = resolveCommercialZoneDisplay(client)
  return {
    ...client,
    visit_order: Number(client?.visit_order || 0) || null,
    address: String(client?.address || client?.adresse || '').trim() || null,
    predicted_ca: normalizeNullableNumber(client?.predicted_ca),
    expected_order_value: normalizeNullableNumber(client?.expected_order_value),
    predicted_ca_if_buy: normalizeNullableNumber(client?.predicted_ca_if_buy),
    predicted_quantity_if_buy: normalizeNullableNumber(client?.predicted_quantity_if_buy),
    recommended_quantity: normalizeNullableNumber(client?.recommended_quantity),
    purchase_prediction_score: normalizeNullableNumber(client?.purchase_prediction_score),
    purchase_probability: normalizeNullableNumber(client?.purchase_probability),
    prediction_vip: normalizeNullableNumber(client?.prediction_vip ?? client?.vip),
    confidence: normalizeNullableNumber(client?.confidence),
    predicted_products: normalizePredictedProducts(client?.predicted_products),
    purchase_prediction_known: isKnownPredictionClient(client),
    commercial_zone: zoneDisplay.label,
    zone_resolution_status: zoneDisplay.zoneStatus,
    zone_source: zoneDisplay.zoneSource,
    candidate_date: normalizeDateOnly(client?.candidate_date ?? client?.assigned_date),
    assigned_date: normalizeDateOnly(client?.assigned_date ?? client?.candidate_date),
    preferred_date: normalizeDateOnly(client?.preferred_date ?? client?.candidate_date),
    earliest_allowed_date: normalizeDateOnly(client?.earliest_allowed_date ?? client?.candidate_date),
    latest_allowed_date: normalizeDateOnly(client?.latest_allowed_date ?? client?.candidate_date),
    date_flexibility_type: String(client?.date_flexibility_type || '').trim() || 'fixed',
    candidate_date_source: String(client?.candidate_date_source || '').trim() || null,
    date_shift_days: normalizeNullableNumber(client?.date_shift_days),
    shifted_within_recommended_window: Boolean(client?.shifted_within_recommended_window)
  }
}

function normalizeBlock(block = {}) {
  return {
    ...block,
    predicted_ca: normalizeNullableNumber(block?.predicted_ca),
    predicted_ca_known_total: normalizeNullableNumber(block?.predicted_ca_known_total),
    predicted_order_value_total: normalizeNullableNumber(block?.predicted_order_value_total),
    recommended_quantity_total: normalizeNullableNumber(block?.recommended_quantity_total),
    min_daily_ca_target: normalizeNullableNumber(block?.min_daily_ca_target ?? block?.ca_target),
    estimated_distance_km: normalizeNullableNumber(block?.estimated_distance_km),
    estimated_duration_minutes: normalizeNullableNumber(block?.estimated_duration_minutes),
    predicted_ca_known_count: Number(block?.predicted_ca_known_count ?? 0),
    predicted_ca_unknown_count: Number(block?.predicted_ca_unknown_count ?? 0),
    purchase_prediction_known_count: Number(block?.purchase_prediction_known_count ?? 0),
    purchase_prediction_unknown_count: Number(block?.purchase_prediction_unknown_count ?? 0),
    clients_count: Number(block?.clients_count ?? 0),
    min_daily_ca_status: String(block?.min_daily_ca_status || 'unknown').trim() || 'unknown',
    loading_prediction: block?.loading_prediction && typeof block.loading_prediction === 'object'
      ? block.loading_prediction
      : null,
    clients: (Array.isArray(block?.clients) ? block.clients : []).map(normalizeClient)
  }
}

function normalizeDepotOrigin(rawDepot = null) {
  const latitude = Number(rawDepot?.latitude)
  const longitude = Number(rawDepot?.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null
  }

  return {
    ...rawDepot,
    latitude,
    longitude
  }
}

export function buildSalesCoveragePayload(
  filters = {},
  commercialSelection = SALES_COVERAGE_ALL_COMMERCIALS,
  coverageDefaults = {}
) {
  const startDate = String(filters.start_date || todayIsoDate()).slice(0, 10)
  const periodDays = Math.max(1, Math.min(60, Number.parseInt(filters.period_days, 10) || DEFAULT_COVERAGE_PERIOD_DAYS))
  const coverageWindowDays = Math.max(
    1,
    Math.min(
      60,
      Number.parseInt(
        filters.coverage_window_days,
        10
      ) || Number.parseInt(coverageDefaults.coverage_window_days, 10) || DEFAULT_COVERAGE_PERIOD_DAYS
    )
  )
  const dailyMaxMode = normalizeDailyMaxMode(filters.daily_max_mode, coverageDefaults.daily_max_mode || 'flexible')
  const minClients = Math.max(0, Number.parseInt(filters.min_clients, 10) || 0)
  const maxClients = String(filters.max_clients || '').trim() === ''
    ? 0
    : Math.max(0, Number.parseInt(filters.max_clients, 10) || 0)
  const minDailyCaRaw = String(filters.min_daily_ca_per_commercial || '').replace(',', '.').trim()
  const minDailyCa = minDailyCaRaw === ''
    ? null
    : Math.max(0, Number(minDailyCaRaw) || 0)
  const commercialCodes = normalizeSelectedSalesCommercialCodes(commercialSelection)
  const maxDaysWithoutContact = String(filters.max_days_without_contact || '').trim() === ''
    ? null
    : Math.max(1, Number.parseInt(filters.max_days_without_contact, 10) || 0)
  const minimumConfidence = Math.max(0, Math.min(100, Number.parseFloat(filters.minimum_confidence) || 0))

  return {
    planning_mode: 'sales_coverage',
    start_date: startDate,
    planning_horizon_days: periodDays,
    period_days: periodDays,
    coverage_window_days: coverageWindowDays,
    visit_frequency_days: coverageWindowDays,
    daily_max_mode: dailyMaxMode,
    min_clients: minClients,
    max_clients: maxClients,
    min_daily_ca: minDailyCa,
    min_daily_ca_per_commercial: minDailyCa,
    objective_mode: String(filters.objective_mode || coverageDefaults.objective_mode || 'balanced'),
    max_days_without_contact: maxDaysWithoutContact,
    respect_availability: String(filters.respect_availability || coverageDefaults.respect_availability || 'flexible'),
    minimum_confidence: minimumConfidence,
    commercial_code: commercialCodes.length === 1 ? commercialCodes[0] : null,
    commercial_codes: commercialCodes,
    commercials: commercialCodes
  }
}

export function buildSalesCoveragePrecheckPayload(
  filters = {},
  commercialSelection = SALES_COVERAGE_ALL_COMMERCIALS,
  coverageDefaults = {}
) {
  const startDate = String(filters.start_date || todayIsoDate()).slice(0, 10)
  const planningHorizonDays = Math.max(1, Math.min(60, Number.parseInt(filters.period_days, 10) || DEFAULT_COVERAGE_PERIOD_DAYS))
  const coverageWindowDays = Math.max(
    1,
    Math.min(
      60,
      Number.parseInt(filters.coverage_window_days, 10) ||
      Number.parseInt(coverageDefaults.coverage_window_days, 10) ||
      DEFAULT_COVERAGE_PERIOD_DAYS
    )
  )

  const commercialCodes = normalizeSelectedSalesCommercialCodes(commercialSelection)

  return {
    start_date: startDate,
    planning_horizon_days: planningHorizonDays,
    coverage_window_days: coverageWindowDays,
    minimum_clients: Math.max(0, Number.parseInt(filters.min_clients, 10) || 0),
    maximum_clients: String(filters.max_clients || '').trim() === ''
      ? 0
      : Math.max(0, Number.parseInt(filters.max_clients, 10) || 0),
    daily_max_mode: normalizeDailyMaxMode(filters.daily_max_mode, coverageDefaults.daily_max_mode || 'flexible'),
    commercial: commercialCodes.length === 1 ? commercialCodes[0] : 'all',
    commercial_codes: commercialCodes
  }
}

export function describeSalesClientScope(clientScope = {}) {
  const mode = String(clientScope?.mode || '').trim()
  const activeClientsCount = Math.max(0, Number(clientScope?.active_clients_count || 0) || 0)
  const selectedCommercialCodesCount = Math.max(0, Number(clientScope?.selected_commercial_codes_count || 0) || 0)
  const clientFilterApplied = Boolean(clientScope?.client_filter_applied)
  const modeLabel = mode === 'specific_commercial'
    ? 'Commercial selectionne'
    : mode === 'specific_commercial_with_client_ids'
      ? 'Commercial et clients selectionnes'
      : mode === 'explicit_client_ids'
        ? 'Clients selectionnes'
        : 'Tous les clients actifs'

  return `${modeLabel} | ${formatInteger(activeClientsCount)} client(s) | ${formatInteger(selectedCommercialCodesCount)} commercial(aux) | filtre client ${clientFilterApplied ? 'oui' : 'non'}`
}

export function extractSalesPlanView(responseData = {}) {
  const blocks = (Array.isArray(responseData?.blocks) ? responseData.blocks : [])
    .filter(block => Number(block?.clients_count || 0) > 0)
    .map(normalizeBlock)

  return {
    status: String(responseData?.status || 'error'),
    message: String(responseData?.message || responseData?.user_message || '').trim(),
    depotOrigin: normalizeDepotOrigin(responseData?.depot),
    blocks,
    deferredClients: Array.isArray(responseData?.deferred_clients) ? responseData.deferred_clients : [],
    clientsSansDateRecommandable: Array.isArray(responseData?.clients_sans_date_recommandable)
      ? responseData.clients_sans_date_recommandable
      : [],
    clientFinalDecisions: responseData?.client_final_decisions && typeof responseData.client_final_decisions === 'object'
      ? responseData.client_final_decisions
      : {},
    portfolioSummary: responseData?.portfolio_summary && typeof responseData.portfolio_summary === 'object'
      ? responseData.portfolio_summary
      : {},
    portfolioFeasibility: responseData?.portfolio_feasibility &&
      typeof responseData.portfolio_feasibility === 'object'
      ? responseData.portfolio_feasibility
      : {},
    summary: responseData?.summary && typeof responseData.summary === 'object'
      ? responseData.summary
      : {},
    capacityPrecheck: responseData?.capacity_precheck && typeof responseData.capacity_precheck === 'object'
      ? responseData.capacity_precheck
      : {},
    clientScope: responseData?.client_scope && typeof responseData.client_scope === 'object'
      ? responseData.client_scope
      : {},
    requestContext: responseData?.request_context && typeof responseData.request_context === 'object'
      ? responseData.request_context
      : {},
    coverageGuaranteeStatus: String(
      responseData?.summary?.coverage_guarantee_status ||
      responseData?.capacity_precheck?.coverage_guarantee_status ||
      responseData?.request_context?.coverage_guarantee_status ||
      ''
    ).trim() || null,
    diagnostics: responseData?.diagnostics && typeof responseData.diagnostics === 'object'
      ? responseData.diagnostics
      : {},
    statuses: responseData?.statuses && typeof responseData.statuses === 'object'
      ? responseData.statuses
      : {}
  }
}

export function buildExpectedCaMetric(summary = {}) {
  const completenessStatus = String(summary?.expected_ca_completeness_status || 'unavailable').trim() || 'unavailable'
  const knownCount = Number(summary?.predicted_ca_known_count ?? 0)
  const nullCount = Number(summary?.predicted_ca_null_count ?? 0)
  const totalVisits = Number(summary?.selected_visits_count ?? summary?.recommended_visits_count ?? 0)
  const label = completenessStatus === 'complete'
    ? 'Valeur attendue totale'
    : completenessStatus === 'partial'
      ? 'Valeur attendue connue'
      : 'Valeur attendue indisponible'

  return {
    label,
    valueLabel: completenessStatus === 'unavailable'
      ? 'Non disponible'
      : formatNullableCurrency(summary?.predicted_ca_known_sum ?? summary?.total_expected_ca ?? null),
    detailLabel: totalVisits > 0
      ? `Calcule sur ${formatInteger(knownCount)} / ${formatInteger(totalVisits)} visites`
      : `Calcule sur ${formatInteger(knownCount)} visite(s)`,
    completenessStatus,
    knownCount,
    nullCount
  }
}

export function buildHighProbabilityMetric(summary = {}) {
  const threshold = summary?.high_probability_threshold ?? 50
  const knownCount = Number(summary?.known_probability_count ?? 0)
  const nullCount = Number(summary?.null_probability_count ?? 0)
  const thresholdLabel = Number.isInteger(Number(threshold))
    ? formatInteger(threshold)
    : formatDecimal(threshold)
  return {
    label: `Visites a forte probabilite (>= ${thresholdLabel} %)`,
    valueLabel: formatInteger(summary?.high_probability_visits_count ?? summary?.probable_sales_count ?? 0),
    detailLabel: `Probabilites connues : ${formatInteger(knownCount)} / ${formatInteger(knownCount + nullCount)}`
  }
}

export function resolveSelectedSalesBlock(blocks = [], selectedBlockId = null) {
  const normalizedBlocks = Array.isArray(blocks) ? blocks : []
  return normalizedBlocks.find(block => block?.slot_id === selectedBlockId) || normalizedBlocks[0] || null
}

export function computeSalesGpsStats(clients = []) {
  const list = Array.isArray(clients) ? clients : []
  const mapped = list.filter(hasValidGps).length
  return {
    total: list.length,
    mapped,
    unavailable: Math.max(0, list.length - mapped)
  }
}

export function buildSalesSidebarBlockModel(block = {}) {
  const knownCount = Number(block?.purchase_prediction_known_count ?? 0)
  const unknownCount = Number(block?.purchase_prediction_unknown_count ?? 0)
  let predictedLabel = 'Valeur attendue : Non disponible'

  if (knownCount > 0 && block?.predicted_order_value_total != null) {
    predictedLabel = unknownCount > 0 || block?.purchase_prediction_completeness === false
      ? `Valeur attendue connue : ${formatNullableCurrency(block.predicted_order_value_total)}`
      : `Valeur attendue totale : ${formatNullableCurrency(block.predicted_order_value_total)}`
  }

  return {
    title: block?.date || '-',
    commercialLabel: block?.commercial_label || block?.commercial_code || '-',
    clientsLabel: `${formatInteger(block?.clients_count || 0)} client(s)`,
    predictedLabel
  }
}

export function formatSalesPortfolioStatus(status) {
  switch (String(status || '').trim()) {
    case 'due_now':
      return 'A faire maintenant'
    case 'due_soon':
      return 'A faire bientot'
    case 'overdue':
      return 'En retard'
    case 'not_due':
      return 'Pas encore du'
    case 'exploration_needed':
      return 'Exploration requise'
    case 'capacity_unplanned':
      return 'Non planifie - capacite'
    case 'hard_constraint_unplanned':
      return 'Non planifie - contrainte forte'
    case 'invalid_data':
      return 'Donnees invalides'
    default:
      return status ? String(status) : 'Non disponible'
  }
}

function formatReasonCode(code) {
  switch (String(code || '').trim()) {
    case 'NO_COMPATIBLE_COMMERCIAL':
      return 'Aucun commercial compatible'
    case 'CAPACITY_CONSTRAINT':
      return 'Capacite insuffisante'
    case 'EXPLICIT_UNAVAILABLE':
      return 'Indisponibilite explicite'
    case 'EXPLORATION_REQUIRED':
      return 'Exploration requise'
    case 'INSUFFICIENT_HISTORY':
      return 'Historique insuffisant'
    default:
      return String(code || '').trim() || 'Non documente'
  }
}

export function formatSalesConfidencePercent(value) {
  if (value === null || value === undefined || value === '') {
    return 'Non disponible'
  }

  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return 'Non disponible'
  }

  const normalizedPercent = numericValue <= 1 ? numericValue * 100 : numericValue
  return `${formatDecimal(normalizedPercent, 1)} %`
}

export function buildSalesPortfolioSummary(planView = {}) {
  const decisions = planView?.clientFinalDecisions && typeof planView.clientFinalDecisions === 'object'
    ? Object.values(planView.clientFinalDecisions)
    : []
  const fallbackCounts = decisions.reduce((accumulator, decision) => {
    const status = String(decision?.portfolio_status || '').trim()
    if (!status) return accumulator
    accumulator[`${status}_count`] = Number(accumulator[`${status}_count`] || 0) + 1
    return accumulator
  }, {})
  const summary = planView?.portfolioSummary && typeof planView.portfolioSummary === 'object'
    ? planView.portfolioSummary
    : {}

  return {
    activeClientsCount: Number(
      summary.active_clients_count ??
      decisions.length ??
      planView?.clientScope?.active_clients_count ??
      0
    ),
    metrics: [
      { key: 'due_now', label: 'A faire maintenant', count: Number(summary.due_now_count ?? fallbackCounts.due_now_count ?? 0) },
      { key: 'due_soon', label: 'A faire bientot', count: Number(summary.due_soon_count ?? fallbackCounts.due_soon_count ?? 0) },
      { key: 'overdue', label: 'En retard', count: Number(summary.overdue_count ?? fallbackCounts.overdue_count ?? 0) },
      { key: 'not_due', label: 'Pas encore du', count: Number(summary.not_due_count ?? fallbackCounts.not_due_count ?? 0) },
      { key: 'exploration_needed', label: 'Exploration requise', count: Number(summary.exploration_needed_count ?? fallbackCounts.exploration_needed_count ?? 0) },
      { key: 'capacity_unplanned', label: 'Non planifie - capacite', count: Number(summary.capacity_unplanned_count ?? fallbackCounts.capacity_unplanned_count ?? 0) },
      { key: 'hard_constraint_unplanned', label: 'Non planifie - contrainte forte', count: Number(summary.hard_constraint_unplanned_count ?? fallbackCounts.hard_constraint_unplanned_count ?? 0) },
      { key: 'invalid_data', label: 'Donnees invalides', count: Number(summary.invalid_data_count ?? fallbackCounts.invalid_data_count ?? 0) }
    ]
  }
}

export function buildSalesExecutionSummary(planView = {}, filters = {}, selectedCommercialCodes = []) {
  const horizonDays = Number(
    planView?.summary?.planning_horizon_days ??
    planView?.requestContext?.planning_horizon_days ??
    filters?.period_days ??
    0
  )

  const selectedCommercialsCount =
    selectedCommercialCodes.length ||
    Number(planView?.clientScope?.selected_commercial_codes_count ?? 0)

  const targetPerDay = Math.max(
    0,
    Number.parseInt(filters?.min_clients, 10) || 0
  )

  const maximumPerDay = String(filters?.max_clients || '').trim() === ''
    ? 0
    : Math.max(0, Number.parseInt(filters?.max_clients, 10) || 0)

  const portfolioFeasibility =
    planView?.portfolioFeasibility &&
    typeof planView.portfolioFeasibility === 'object'
      ? planView.portfolioFeasibility
      : {}

  const capacityPrecheck =
    planView?.capacityPrecheck &&
    typeof planView.capacityPrecheck === 'object'
      ? planView.capacityPrecheck
      : {}

  const hasPortfolioFeasibility =
    Object.keys(portfolioFeasibility).length > 0

  const toNullableNumber = value => {
    if (value === null || value === undefined || value === '') {
      return null
    }

    const numericValue = Number(value)
    return Number.isFinite(numericValue) ? numericValue : null
  }

  const computedTargetCapacity =
    selectedCommercialsCount * horizonDays * targetPerDay

  const computedMaximumCapacity =
    maximumPerDay > 0
      ? selectedCommercialsCount * horizonDays * maximumPerDay
      : null

  const maximumCapacity = hasPortfolioFeasibility
    ? toNullableNumber(portfolioFeasibility.maximum_capacity)
    : computedMaximumCapacity

  const strictCapacity = hasPortfolioFeasibility
    ? maximumCapacity
    : toNullableNumber(capacityPrecheck.strict_capacity)


    const selectedVisitsCount = Number(
  planView?.summary?.selected_visits_count ??
  planView?.summary?.recommended_visits_count ??
  0
)

const selectedUniqueClientsCount = Number(
  planView?.summary?.selected_unique_clients_count ??
  selectedVisitsCount
)

const requiredVisitsCount = hasPortfolioFeasibility
  ? toNullableNumber(
      portfolioFeasibility.required_visits_in_horizon
    )
  : toNullableNumber(capacityPrecheck.required_visits_count)

const selectedRequiredClientsCount =
  hasPortfolioFeasibility
    ? toNullableNumber(
        portfolioFeasibility
          .selected_required_clients_count
      )
    : null

const backendPlanningGap =
  hasPortfolioFeasibility
    ? toNullableNumber(
        portfolioFeasibility
          .required_unplanned_clients_count
      )
    : null

const planningGap = backendPlanningGap !== null
  ? backendPlanningGap
  : requiredVisitsCount === null
    ? null
    : Math.max(
        0,
        requiredVisitsCount -
          selectedUniqueClientsCount
      )

  return {
    selectedVisitsCount,
    selectedUniqueClientsCount,
    selectedRequiredClientsCount,

    selectedCommercialsCount,
    horizonDays,

    targetCapacity:
      toNullableNumber(portfolioFeasibility.target_capacity) ??
      computedTargetCapacity,

    maximumCapacity,

    requiredVisitsCount,
    planningGap,

    strictCapacity,

    capacityDeficit: hasPortfolioFeasibility
      ? toNullableNumber(portfolioFeasibility.capacity_deficit)
      : toNullableNumber(capacityPrecheck.capacity_deficit),

    capacitySurplus:
      toNullableNumber(portfolioFeasibility.capacity_surplus),

    recommendedMinimumHorizonDays:
      toNullableNumber(
        portfolioFeasibility.recommended_minimum_horizon_days
      ),

    feasibilityStatus: String(
      portfolioFeasibility.feasibility_status ||
      capacityPrecheck.feasibility_status ||
      'unknown'
    ).trim() || 'unknown'
  }
}

export function buildSalesPredictionSummary(planView = {}) {
  const expectedValueMetric = buildExpectedCaMetric(planView?.summary || {})
  return {
    expectedValueMetric,
    knownCount: Number(planView?.summary?.selected_prediction_known_count ?? 0),
    totalVisits: Number(planView?.summary?.selected_visits_count ?? planView?.summary?.recommended_visits_count ?? 0),
    coverageRate: Number(planView?.summary?.selected_prediction_coverage_rate ?? 0)
  }
}

export function buildSalesProfileReadinessViewModel(readinessState = {}) {
  const payload = readinessState?.payload && typeof readinessState.payload === 'object'
    ? readinessState.payload
    : {}
  const topLevelStatus = String(payload?.status || '').trim() || null
  const snapshotStatus = String(payload?.profile_snapshot?.status || '').trim() || null
  const knownStatuses = new Set(['ready', 'building', 'failed', 'stale', 'missing'])
  const normalizeStatus = (value) => knownStatuses.has(value) ? value : null
  const normalizedTopLevelStatus = normalizeStatus(topLevelStatus)
  const normalizedSnapshotStatus = normalizeStatus(snapshotStatus)
  const status = normalizedTopLevelStatus === 'ready' || normalizedSnapshotStatus === 'ready'
    ? 'ready'
    : normalizedTopLevelStatus || normalizedSnapshotStatus || 'missing'
  const latestErrorMessage = String(
    payload?.error ||
    payload?.profile_snapshot?.latest_error_message ||
    readinessState?.error ||
    ''
  ).trim() || null
  const pending = Boolean(readinessState?.loading)
  const hasPayload = Boolean(normalizedTopLevelStatus || normalizedSnapshotStatus || latestErrorMessage || Object.keys(payload).length)
  const building = status === 'building'
  const waitingForPreparation = building || status === 'missing' || status === 'stale'
  const failed = status === 'failed'
  const ready = status === 'ready'
  const isLoading = pending && !hasPayload

  return {
    status,
    ready,
    building,
    failed,
    pending,
    isLoading,
    disableGenerate: !ready,
    shouldPoll: waitingForPreparation && !pending,
    canRetry: failed && !pending,
    latestErrorMessage,
    statusLabel: isLoading ? 'Preparation en cours...' : null,
    bannerMessage: failed
      ? (latestErrorMessage || 'La preparation des profils V2 a echoue.')
      : waitingForPreparation || isLoading
      ? 'Preparation en cours...'
      : null
  }
}

export function buildSalesClientRows(block = {}, routePlan = null) {
  const prioritySortedRows = (Array.isArray(block?.clients) ? block.clients : [])
    .map(normalizeClient)
    .sort(compareSalesPriority)

  const visitOrderByClientId = new Map(
    (Array.isArray(routePlan?.orderedStops) ? routePlan.orderedStops : [])
      .map((stop, index) => {
        const clientId = String(stop?.client_id || stop?.id || '').trim()
        if (!clientId) return null
        const step = Number(stop?.step)
        return [clientId, Number.isFinite(step) && step > 0 ? step : index + 1]
      })
      .filter(Boolean)
  )

  return prioritySortedRows.map((client, index) => {
    const zoneDisplay = resolveCommercialZoneDisplay(client)
    const dateSourceLabel = (() => {
      switch (String(client?.candidate_date_source || '').trim()) {
        case 'purchase_prediction':
          return 'Date predite d achat'
        case 'purchase_cadence':
          return 'Rythme d achat habituel'
        case 'usual_weekday':
          return 'Rythme d achat habituel'
        case 'low_history_fallback':
          return 'Fenetre flexible - historique limite'
        case 'exploration_fallback':
          return 'Visite d exploration'
        case 'max_days_without_contact':
          return 'Garde-fou sans contact'
        default:
          return 'Date recommandee'
      }
    })()
    const plannedDate = client?.assigned_date ?? client?.candidate_date ?? null
    return ({
      key: `${String(client?.client_id || `client-${index + 1}`)}-${plannedDate || 'no-date'}-${index + 1}`,
      order: index + 1,
      priorityRank: index + 1,
      visitOrder: visitOrderByClientId.get(String(client?.client_id || '').trim()) ?? null,
      clientId: String(client?.client_id || ''),
      clientCode: String(client?.client_code || ''),
      clientName: String(client?.client_name || client?.client_code || `Client ${index + 1}`),
      address: client?.address || 'Adresse non specifiee',
      commercialCode: String(client?.commercial_code || block?.commercial_code || '').trim() || null,
      commercialLabel: String(client?.commercial_label || block?.commercial_label || block?.commercial_code || '').trim() || null,
      priorityScore: client?.purchase_prediction_score ?? null,
      vipScore: client?.prediction_vip ?? null,
      estimatedQuantity: client?.recommended_quantity ?? null,
      estimatedQuantityIfBuy: client?.predicted_quantity_if_buy ?? null,
      plannedDate,
      predictedPurchaseDate: client?.predicted_purchase_date ?? null,
      preferredDate: client?.preferred_date ?? null,
      dateSourceLabel,
      dateFlexibilityType: client?.date_flexibility_type ?? 'fixed',
      dateShiftDays: client?.date_shift_days ?? null,
      shiftedWithinRecommendedWindow: Boolean(client?.shifted_within_recommended_window),
      expectedVisitValue: client?.expected_order_value ?? null,
      estimatedCaIfBuy: client?.predicted_ca_if_buy ?? null,
      purchaseProbability: client?.purchase_probability ?? null,
      dateConfidence: client?.confidence ?? null,
      portfolioStatus: String(client?.portfolio_status || client?.final_client_status || '').trim() || null,
      portfolioStatusLabel: formatSalesPortfolioStatus(client?.portfolio_status || client?.final_client_status || null),
      mainReasonLabels: (Array.isArray(client?.reason_codes) ? client.reason_codes : []).map(formatReasonCode),
      zoneLabel: zoneDisplay.label,
      zoneStatus: zoneDisplay.zoneStatus,
      zoneSource: zoneDisplay.zoneSource,
      predictionKnown: Boolean(client?.purchase_prediction_known),
      basketPredictionSource: String(client?.basket_prediction_source || '').trim() || (
        normalizePredictedProducts(client?.recommended_products ?? client?.predicted_products).length > 0
          ? normalizePredictedProducts(client?.recommended_products ?? client?.predicted_products)[0]?.predictionSource || null
          : 'unavailable'
      ),
      gpsAvailable: hasValidGps(client),
      predictedProducts: normalizePredictedProducts(client?.recommended_products ?? client?.predicted_products),
      plannedVisitId: String(client?.planned_visit_id || '').trim() || null,
      assignedSlotId: String(client?.assigned_slot_id || block?.slot_id || '').trim() || null,
      predictionSnapshot: client?.prediction_snapshot && typeof client.prediction_snapshot === 'object'
        ? client.prediction_snapshot
        : null
    })
  })
}

export function buildSalesVisitFeedbackRecordIndex(records = []) {
  return (Array.isArray(records) ? records : []).reduce((accumulator, record) => {
    const plannedVisitId = String(record?.planned_visit_id || '').trim()
    if (plannedVisitId) {
      accumulator[plannedVisitId] = {
        plannedVisitId,
        tourneeCode: String(record?.tournee_code || '').trim() || null,
        executionStatus: String(record?.execution_status || 'pending').trim() || 'pending',
        purchaseMade: record?.purchase_made == null ? null : Boolean(record.purchase_made),
        actualCa: record?.actual_ca == null ? null : Number(record.actual_ca),
        actualQuantity: record?.actual_quantity == null ? null : Number(record.actual_quantity),
        visitDateActual: record?.visit_date_actual == null ? null : String(record.visit_date_actual),
        note: String(record?.note || '').trim() || '',
        nonVisitReason: String(record?.non_visit_reason || '').trim() || '',
        noPurchaseReason: String(record?.no_purchase_reason || '').trim() || '',
        predictionSnapshot: record?.prediction_snapshot && typeof record.prediction_snapshot === 'object'
          ? record.prediction_snapshot
          : null,
        updatedAt: record?.updated_at == null ? null : String(record.updated_at)
      }
    }
    return accumulator
  }, {})
}

export function buildSalesVisitFeedbackDraft(...args) {
  const record = args[1] ?? null
  return {
    executionStatus: String(record?.executionStatus || 'pending').trim() || 'pending',
    purchaseMade: record?.purchaseMade == null ? '' : (record.purchaseMade ? 'true' : 'false'),
    actualCa: record?.actualCa == null ? '' : String(record.actualCa),
    actualQuantity: record?.actualQuantity == null ? '' : String(record.actualQuantity),
    note: String(record?.note || '').trim(),
    nonVisitReason: String(record?.nonVisitReason || '').trim(),
    noPurchaseReason: String(record?.noPurchaseReason || '').trim()
  }
}

export function buildSalesVisitFeedbackPayload(row = {}, draft = {}) {
  const executionStatus = String(draft?.executionStatus || 'pending').trim() || 'pending'
  const normalizeNullableNumber = (value) => {
    if (value == null || String(value).trim() === '') return null
    const parsed = Number(String(value).replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }

  return {
    planned_visit_id: row?.plannedVisitId || null,
    assigned_slot_id: row?.assignedSlotId || null,
    client_id: row?.clientId || null,
    client_code: row?.clientCode || null,
    commercial_code: row?.commercialCode || null,
    planned_date: row?.plannedDate || null,
    execution_status: executionStatus,
    purchase_made: executionStatus === 'visited'
      ? (draft?.purchaseMade === 'true' ? true : draft?.purchaseMade === 'false' ? false : null)
      : null,
    actual_ca: executionStatus === 'visited' ? normalizeNullableNumber(draft?.actualCa) : null,
    actual_quantity: executionStatus === 'visited' ? normalizeNullableNumber(draft?.actualQuantity) : null,
    note: String(draft?.note || '').trim() || null,
    non_visit_reason: executionStatus === 'not_visited'
      ? (String(draft?.nonVisitReason || '').trim() || null)
      : null,
    no_purchase_reason: executionStatus === 'visited' && draft?.purchaseMade === 'false'
      ? (String(draft?.noPurchaseReason || '').trim() || null)
      : null,
    prediction_snapshot: row?.predictionSnapshot || null
  }
}

export function buildSalesVisitFeedbackItems(rows = [], feedbackIndex = {}) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row?.plannedVisitId)
    .map(row => {
      const existingRecord = feedbackIndex?.[row.plannedVisitId] || null
      return {
        plannedVisitId: row.plannedVisitId,
        tourneeCode: existingRecord?.tourneeCode || null,
        clientId: row.clientId,
        clientCode: row.clientCode,
        clientName: row.clientName,
        commercialCode: row.commercialCode,
        commercialLabel: row.commercialLabel,
        plannedDate: row.plannedDate,
        executionStatus: existingRecord?.executionStatus || 'pending',
        executionStatusLabel: formatSalesVisitExecutionStatus(existingRecord?.executionStatus || 'pending'),
        purchaseMade: existingRecord?.purchaseMade ?? null,
        actualCa: existingRecord?.actualCa ?? null,
        actualQuantity: existingRecord?.actualQuantity ?? null,
        note: existingRecord?.note || '',
        updatedAt: existingRecord?.updatedAt || null,
        predictionSnapshot: existingRecord?.predictionSnapshot || row?.predictionSnapshot || null
      }
    })
}

export function buildSalesPredictionConsistency(block = {}, clientRows = []) {
  const rows = Array.isArray(clientRows) ? clientRows : []
  const totalRows = rows.length
  const knownRows = rows.filter(row => row?.predictionKnown).length
  const unknownRows = Math.max(0, totalRows - knownRows)
  const expectedKnown = Number(block?.purchase_prediction_known_count ?? 0)
  const expectedUnknown = Number(block?.purchase_prediction_unknown_count ?? 0)
  const expectedTotal = Number(
    block?.clients_count ??
    (Array.isArray(block?.clients) ? block.clients.length : 0)
  )
  const blockCountsMatch = expectedKnown + expectedUnknown === expectedTotal
  const rowCountsMatch = knownRows === expectedKnown &&
    unknownRows === expectedUnknown &&
    totalRows === expectedTotal

  return {
    totalRows,
    knownRows,
    unknownRows,
    expectedKnown,
    expectedUnknown,
    expectedTotal,
    blockCountsMatch,
    rowCountsMatch,
    consistent: blockCountsMatch && rowCountsMatch
  }
}

export function aggregateSalesLoadingPrediction(block = {}) {
  const productsFromPayload = Array.isArray(block?.loading_prediction?.products)
    ? block.loading_prediction.products.map(item => ({
        productId: String(item?.product_id || '').trim() || null,
        productCode: String(item?.product_code || '').trim() || null,
        productLabel: String(item?.product_label || '').trim() || null,
        estimatedNeed: item?.estimated_need == null ? null : Number(Number(item.estimated_need).toFixed(2)),
        recommendedLoadQuantity: item?.recommended_load_quantity == null ? null : Number(Number(item.recommended_load_quantity).toFixed(2)),
        predictionSource: String(item?.prediction_source || '').trim() || null,
        confidenceOrSupport: item?.confidence_or_support == null
          ? null
          : (Number.isFinite(Number(item.confidence_or_support))
              ? Number(Number(item.confidence_or_support).toFixed(2))
              : String(item.confidence_or_support).trim() || null)
      }))
    : null

  if (productsFromPayload) {
    return {
      commercialCode: String(block?.loading_prediction?.commercial_code || block?.commercial_code || '').trim() || null,
      planningDate: normalizeDateOnly(block?.loading_prediction?.planning_date || block?.date) || null,
      products: productsFromPayload,
      coverage: {
        plannedVisits: Number(block?.loading_prediction?.coverage?.planned_visits ?? block?.clients_count ?? 0),
        visitsWithBasketPrediction: Number(block?.loading_prediction?.coverage?.visits_with_basket_prediction ?? 0),
        basketPredictionCoveragePct: block?.loading_prediction?.coverage?.basket_prediction_coverage_pct == null
          ? null
          : Number(Number(block.loading_prediction.coverage.basket_prediction_coverage_pct).toFixed(1))
      }
    }
  }

  const totals = new Map()
  let visitsWithBasketPrediction = 0
  ;(Array.isArray(block?.clients) ? block.clients : []).forEach(client => {
    const products = normalizePredictedProducts(client?.recommended_products ?? client?.predicted_products)
    if (products.length > 0) {
      visitsWithBasketPrediction += 1
    }
    products.forEach(product => {
      const key = `${product.productCode || ''}::${product.productLabel || ''}::${product.productId || ''}`
      const entry = totals.get(key) || {
        productId: product.productId,
        productCode: product.productCode,
        productLabel: product.productLabel,
        estimatedNeed: 0,
        recommendedLoadQuantity: 0,
        predictionSource: product.predictionSource || null,
        confidenceOrSupport: 0,
        confidenceCount: 0
      }
      entry.estimatedNeed += Number(product.estimatedQuantity || 0)
      entry.recommendedLoadQuantity += Number(product.estimatedQuantity || 0)
      if (product.predictionSource === 'historical_pattern' && typeof product.confidenceOrSupport === 'number') {
        entry.confidenceOrSupport += Number(product.confidenceOrSupport)
        entry.confidenceCount += 1
      }
      totals.set(key, entry)
    })
  })

  return {
    commercialCode: String(block?.commercial_code || '').trim() || null,
    planningDate: normalizeDateOnly(block?.date) || null,
    products: [...totals.values()]
      .map(item => ({
        productId: item.productId,
        productCode: item.productCode,
        productLabel: item.productLabel,
        estimatedNeed: Number(item.estimatedNeed.toFixed(2)),
        recommendedLoadQuantity: Number(item.recommendedLoadQuantity.toFixed(2)),
        predictionSource: item.predictionSource,
        confidenceOrSupport: item.confidenceCount > 0
          ? Number(item.confidenceOrSupport.toFixed(2))
          : null
      }))
      .sort((left, right) => Number(right.estimatedNeed || 0) - Number(left.estimatedNeed || 0)),
    coverage: {
      plannedVisits: Number(block?.clients_count ?? (Array.isArray(block?.clients) ? block.clients.length : 0)),
      visitsWithBasketPrediction,
      basketPredictionCoveragePct: Number(
        (
          (Array.isArray(block?.clients) && block.clients.length > 0)
            ? (visitsWithBasketPrediction / block.clients.length) * 100
            : 0
        ).toFixed(1)
      )
    }
  }
}

export function buildSalesDetailHeaderModel(block = {}, routePlan = null) {
  const gpsStats = computeSalesGpsStats(block?.clients)
  const driveDistance = routePlan?.summary?.distance ?? null
  const driveDuration = routePlan?.summary?.duration ?? null
  const knownServiceMinutes = block?.time?.service_minutes_known_count === Number(block?.clients_count || 0)
    ? Number(block?.time?.service_minutes_total ?? 0)
    : null
  const totalEstimatedMinutes = (
    driveDuration != null &&
    knownServiceMinutes != null
  )
    ? Math.round((Number(driveDuration) / 60) + knownServiceMinutes + Number(block?.time?.break_minutes || 0))
    : null

  return {
    commercialLabel: block?.commercial_label || block?.commercial_code || '-',
    date: block?.date || '-',
    clientsLabel: `${formatInteger(block?.clients_count || 0)} client(s)`,
    predictedOrderLabel: block?.predicted_order_value_total == null
      ? 'Non disponible'
      : formatNullableCurrency(block.predicted_order_value_total),
    predictedLabelTone: Number(block?.purchase_prediction_unknown_count || 0) > 0
      ? 'partial'
      : (block?.predicted_order_value_total == null ? 'unknown' : 'complete'),
    minDailyCaLabel: block?.min_daily_ca_target == null || Number(block?.min_daily_ca_target || 0) <= 0
      ? 'Optionnel'
      : formatNullableCurrency(block.min_daily_ca_target),
    minDailyCaStatus: String(block?.min_daily_ca_status || 'unknown'),
    predictionCoverageLabel: `${formatInteger(block?.purchase_prediction_known_count || 0)} avec prediction / ${formatInteger(block?.purchase_prediction_unknown_count || 0)} sans prediction`,
    gpsStats,
    distanceLabel: driveDistance != null
      ? formatDistanceMeters(driveDistance)
      : (block?.estimated_distance_km != null ? formatDistanceKm(block.estimated_distance_km) : 'Non disponible'),
    driveDurationLabel: driveDuration != null
      ? formatDurationSeconds(driveDuration)
      : 'Non disponible',
    serviceDurationLabel: knownServiceMinutes != null
      ? formatDurationMinutes(knownServiceMinutes)
      : 'Non disponible',
    totalDurationLabel: totalEstimatedMinutes != null
      ? formatDurationMinutes(totalEstimatedMinutes)
      : formatDurationMinutes(block?.estimated_duration_minutes)
  }
}

export function formatSalesClientValue(value, suffix = '') {
  if (value === null || value === undefined || value === '') {
    return 'Non disponible'
  }

  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return 'Non disponible'
  }

  return `${formatDecimal(numericValue, 1)}${suffix}`
}

function addDaysToIsoDate(startDateValue, dayOffset = 0) {
  const normalized = normalizeDateOnly(startDateValue)
  if (!normalized) return null
  const [year, month, day] = normalized.split('-').map(Number)
  const date = new Date(year, (month || 1) - 1, day || 1)
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() + Number(dayOffset || 0))
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function buildDefaultSalesMonitoringFilters(startDateValue = todayIsoDate(), periodDaysValue = DEFAULT_COVERAGE_PERIOD_DAYS) {
  const startDate = normalizeDateOnly(startDateValue) || todayIsoDate()
  const periodDays = Math.max(1, Number.parseInt(periodDaysValue, 10) || DEFAULT_COVERAGE_PERIOD_DAYS)
  return {
    start_date: startDate,
    end_date: addDaysToIsoDate(startDate, periodDays - 1) || startDate,
    commercial_codes: []
  }
}

export function buildSalesMonitoringRequestPayload(filters = {}, selectedCommercialCodes = [], options = []) {
  const normalizedSelection = normalizeSelectedSalesCommercialCodes(selectedCommercialCodes, options)
  return {
    start_date: normalizeDateOnly(filters?.start_date) || null,
    end_date: normalizeDateOnly(filters?.end_date) || null,
    commercial_codes: normalizedSelection
  }
}

function normalizeMonitoringMetricBucket(bucket = {}, includeMape = false) {
  return {
    comparableCount: Number(bucket?.comparable_count ?? 0),
    mae: normalizeNullableNumber(bucket?.mae),
    bias: normalizeNullableNumber(bucket?.bias),
    mapeValidCount: includeMape ? Number(bucket?.mape_valid_count ?? 0) : null,
    mape: includeMape ? normalizeNullableNumber(bucket?.mape) : null
  }
}

function normalizeMonitoringSummary(summary = {}) {
  const execution = summary?.execution && typeof summary.execution === 'object'
    ? summary.execution
    : {}
  const purchase = summary?.purchase && typeof summary.purchase === 'object'
    ? summary.purchase
    : {}
  const caExpected = summary?.caExpected ?? summary?.ca_expected
  const caIfBuy = summary?.caIfBuy ?? summary?.ca_if_buy
  const quantity = summary?.quantity

  return {
    execution: {
      planned: Number(execution?.planned ?? 0),
      visited: Number(execution?.visited ?? 0),
      notVisited: Number(execution?.notVisited ?? execution?.not_visited ?? 0),
      pending: Number(execution?.pending ?? 0),
      executionRate: normalizeNullableNumber(execution?.executionRate ?? execution?.execution_rate)
    },
    purchase: {
      comparableVisits: Number(purchase?.comparableVisits ?? purchase?.comparable_visits ?? 0),
      purchases: Number(purchase?.purchases ?? 0),
      noPurchase: Number(purchase?.noPurchase ?? purchase?.no_purchase ?? 0),
      conversionRate: normalizeNullableNumber(purchase?.conversionRate ?? purchase?.conversion_rate)
    },
    caExpected: normalizeMonitoringMetricBucket(caExpected, true),
    caIfBuy: normalizeMonitoringMetricBucket(caIfBuy, true),
    quantity: normalizeMonitoringMetricBucket(quantity, false)
  }
}

function normalizeMonitoringRow(row = {}) {
  return {
    plannedVisitId: String(row?.planned_visit_id || '').trim() || null,
    clientId: String(row?.client_id || '').trim() || null,
    clientCode: String(row?.client_code || '').trim() || null,
    commercialCode: String(row?.commercial_code || '').trim() || null,
    plannedDate: normalizeDateOnly(row?.planned_date),
    executionStatus: String(row?.execution_status || 'pending').trim() || 'pending',
    executionStatusLabel: formatSalesVisitExecutionStatus(row?.execution_status || 'pending'),
    purchaseMade: row?.purchase_made == null ? null : Boolean(row.purchase_made),
    purchaseLabel: row?.purchase_made == null ? 'Non disponible' : (row.purchase_made ? 'Oui' : 'Non'),
    predicted: {
      expectedVisitCa: normalizeNullableNumber(row?.predicted?.expected_visit_ca),
      caIfBuy: normalizeNullableNumber(row?.predicted?.ca_if_buy),
      estimatedQuantity: normalizeNullableNumber(row?.predicted?.estimated_quantity),
      quantityIfBuy: normalizeNullableNumber(row?.predicted?.quantity_if_buy),
      priority: normalizeNullableNumber(row?.predicted?.priority),
      portfolioStatus: String(row?.predicted?.portfolio_status || '').trim() || null,
      predictionSource: String(row?.predicted?.prediction_source || '').trim() || null
    },
    actual: {
      actualCa: normalizeNullableNumber(row?.actual?.actual_ca),
      actualQuantity: normalizeNullableNumber(row?.actual?.actual_quantity)
    },
    comparison: {
      expectedCaError: normalizeNullableNumber(row?.comparison?.expected_ca_error),
      conditionalCaError: normalizeNullableNumber(row?.comparison?.conditional_ca_error),
      quantityError: normalizeNullableNumber(row?.comparison?.quantity_error)
    }
  }
}

export function formatSalesMonitoringMetricValue(value, kind = 'number') {
  if (value === null || value === undefined || value === '') {
    return 'Non disponible'
  }

  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return 'Non disponible'
  }

  if (kind === 'currency') {
    return formatNullableCurrency(numericValue)
  }
  if (kind === 'percent') {
    return `${formatDecimal(numericValue * 100, 1)} %`
  }
  return formatDecimal(numericValue, 1)
}

export function formatSalesMonitoringBiasLabel(value, kind = 'number') {
  if (value === null || value === undefined || value === '') {
    return 'Non disponible'
  }

  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return 'Non disponible'
  }

  const sign = numericValue > 0 ? '+' : numericValue < 0 ? '-' : ''
  const absoluteValue = Math.abs(numericValue)
  const formattedAbsolute = kind === 'currency'
    ? formatNullableCurrency(absoluteValue)
    : formatDecimal(absoluteValue, 1)
  return `${sign}${formattedAbsolute}`
}

export function buildSalesMonitoringKpis(summary = {}) {
  const normalizedSummary = normalizeMonitoringSummary(summary)
  return [
    { key: 'planned', label: 'Visites planifiees', valueLabel: formatInteger(normalizedSummary.execution.planned) },
    { key: 'visited', label: 'Visites effectuees', valueLabel: formatInteger(normalizedSummary.execution.visited) },
    { key: 'not_visited', label: 'Non visitees', valueLabel: formatInteger(normalizedSummary.execution.notVisited) },
    { key: 'pending', label: 'En attente', valueLabel: formatInteger(normalizedSummary.execution.pending) },
    { key: 'execution_rate', label: "Taux d execution", valueLabel: formatSalesMonitoringMetricValue(normalizedSummary.execution.executionRate, 'percent') },
    { key: 'purchases', label: 'Achats', valueLabel: formatInteger(normalizedSummary.purchase.purchases) },
    { key: 'no_purchase', label: 'Sans achat', valueLabel: formatInteger(normalizedSummary.purchase.noPurchase) },
    { key: 'conversion_rate', label: 'Taux de conversion', valueLabel: formatSalesMonitoringMetricValue(normalizedSummary.purchase.conversionRate, 'percent') },
    { key: 'ca_expected_mae', label: 'MAE valeur attendue', valueLabel: formatSalesMonitoringMetricValue(normalizedSummary.caExpected.mae, 'currency') },
    { key: 'ca_expected_bias', label: 'Biais CA', valueLabel: formatSalesMonitoringBiasLabel(normalizedSummary.caExpected.bias, 'currency') },
    { key: 'ca_if_buy_mae', label: 'MAE CA si achat', valueLabel: formatSalesMonitoringMetricValue(normalizedSummary.caIfBuy.mae, 'currency') },
    { key: 'quantity_mae', label: 'MAE quantite', valueLabel: formatSalesMonitoringMetricValue(normalizedSummary.quantity.mae, 'number') },
    { key: 'quantity_bias', label: 'Biais quantite', valueLabel: formatSalesMonitoringBiasLabel(normalizedSummary.quantity.bias, 'number') }
  ]
}

function buildMonitoringSegmentRows(segmentObject = {}) {
  return Object.entries(segmentObject && typeof segmentObject === 'object' ? segmentObject : {})
    .map(([key, summary]) => {
      const normalizedSummary = normalizeMonitoringSummary(summary)
      return {
        key,
        label: key,
        planned: normalizedSummary.execution.planned,
        visited: normalizedSummary.execution.visited,
        purchases: normalizedSummary.purchase.purchases,
        executionRateLabel: formatSalesMonitoringMetricValue(normalizedSummary.execution.executionRate, 'percent'),
        conversionRateLabel: formatSalesMonitoringMetricValue(normalizedSummary.purchase.conversionRate, 'percent'),
        expectedMaeLabel: formatSalesMonitoringMetricValue(normalizedSummary.caExpected.mae, 'currency'),
        expectedBiasLabel: formatSalesMonitoringBiasLabel(normalizedSummary.caExpected.bias, 'currency'),
        quantityMaeLabel: formatSalesMonitoringMetricValue(normalizedSummary.quantity.mae, 'number'),
        quantityBiasLabel: formatSalesMonitoringBiasLabel(normalizedSummary.quantity.bias, 'number')
      }
    })
    .sort((left, right) => String(left.label).localeCompare(String(right.label), undefined, { numeric: true, sensitivity: 'base' }))
}

export function buildSalesMonitoringDetailRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeMonitoringRow)
    .map(row => ({
      ...row,
      expectedVisitCaLabel: formatSalesMonitoringMetricValue(row.predicted.expectedVisitCa, 'currency'),
      actualCaLabel: formatSalesMonitoringMetricValue(row.actual.actualCa, 'currency'),
      expectedCaErrorLabel: formatSalesMonitoringBiasLabel(row.comparison.expectedCaError, 'currency'),
      caIfBuyLabel: formatSalesMonitoringMetricValue(row.predicted.caIfBuy, 'currency'),
      conditionalCaErrorLabel: formatSalesMonitoringBiasLabel(row.comparison.conditionalCaError, 'currency'),
      estimatedQuantityLabel: formatSalesMonitoringMetricValue(row.predicted.quantityIfBuy ?? row.predicted.estimatedQuantity, 'number'),
      actualQuantityLabel: formatSalesMonitoringMetricValue(row.actual.actualQuantity, 'number'),
      quantityErrorLabel: formatSalesMonitoringBiasLabel(row.comparison.quantityError, 'number'),
      portfolioStatusLabel: formatSalesPortfolioStatus(row.predicted.portfolioStatus),
      predictionSourceLabel: formatSalesProductPredictionSource(row.predicted.predictionSource)
    }))
}

export function buildSalesMonitoringPanelState(monitoringState = {}) {
  const loading = Boolean(monitoringState?.loading)
  const error = String(monitoringState?.error || '').trim() || null
  const rowCount = Number(monitoringState?.rowCount ?? 0)

  if (loading) {
    return {
      loading: true,
      error: null,
      empty: false,
      emptyMessage: null
    }
  }

  if (error) {
    return {
      loading: false,
      error,
      empty: false,
      emptyMessage: null
    }
  }

  if (rowCount <= 0) {
    return {
      loading: false,
      error: null,
      empty: true,
      emptyMessage: 'Aucun resultat de visite disponible sur cette periode.'
    }
  }

  return {
    loading: false,
    error: null,
    empty: false,
    emptyMessage: null
  }
}

function formatSalesLearningCycleStatus(status) {
  switch (String(status || '').trim()) {
    case 'training':
      return 'Entrainement en cours'
    case 'evaluating':
      return 'Evaluation en cours'
    case 'promoting':
      return 'Promotion en cours'
    case 'promoted':
      return 'Modele ameliore et adopte'
    case 'current_kept':
      return 'Modele actuel conserve'
    case 'failed':
      return 'Echec du cycle'
    case 'waiting_for_feedback':
      return 'En attente de nouvelles donnees'
    case 'idle':
    default:
      return 'Inactif'
  }
}

function formatSalesLearningDecision(decision) {
  switch (String(decision || '').trim()) {
    case 'promoted':
      return 'Modele ameliore et adopte'
    case 'current_retained':
      return 'Modele actuel conserve'
    case 'insufficient_data':
      return 'En attente de nouvelles donnees'
    case 'failed':
      return 'Echec du cycle'
    default:
      return 'Non disponible'
  }
}

function formatSalesLearningEvaluation(summary = null) {
  const decisionReason = String(summary?.decision_reason || '').trim()
  switch (decisionReason) {
    case 'all_targets_pass_policy':
      return 'Candidat meilleur sur le holdout'
    case 'one_or_more_targets_not_improved':
      return 'Modele actuel meilleur sur le holdout'
    case 'not_enough_target_evidence':
      return 'Evaluation insuffisante'
    case 'candidate_promoted':
      return 'Candidat promu apres validation'
    default:
      return summary ? 'Disponible' : 'Non disponible'
  }
}

export function buildSalesLearningStatusViewModel(learningState = {}) {
  const loading = Boolean(learningState?.loading)
  const error = String(learningState?.error || '').trim() || null
  const payload = learningState?.payload && typeof learningState.payload === 'object'
    ? learningState.payload
    : {}
  const cycleStatus = String(
    payload?.learning_cycle_status ||
    payload?.learning_cycle?.status ||
    ''
  ).trim() || 'idle'
  const currentModelVersion = String(
    payload?.current_model?.model_version ||
    payload?.current_model_version ||
    ''
  ).trim() || null
  const newValidFeedbackCount = Number(
    payload?.new_valid_feedback_count ??
    payload?.learning_cycle?.new_valid_feedback_count ??
    0
  )
  const minimumFeedbackRequired = Number(
    payload?.minimum_feedback_required ??
    payload?.learning_cycle?.minimum_feedback_required ??
    0
  )
  const latestComparisonSummary = payload?.latest_comparison_summary && typeof payload.latest_comparison_summary === 'object'
    ? payload.latest_comparison_summary
    : (payload?.learning_cycle?.latest_comparison_summary && typeof payload.learning_cycle.latest_comparison_summary === 'object'
        ? payload.learning_cycle.latest_comparison_summary
        : null)
  const activeStatuses = new Set(['training', 'evaluating', 'promoting'])

  return {
    loading,
    error,
    cycleStatus,
    shouldPoll: !loading && activeStatuses.has(cycleStatus),
    modelVersionLabel: currentModelVersion || 'Non disponible',
    newFeedbackLabel: formatInteger(newValidFeedbackCount),
    stateLabel: formatSalesLearningCycleStatus(cycleStatus),
    decisionLabel: formatSalesLearningDecision(
      payload?.last_decision ?? payload?.learning_cycle?.last_decision ?? null
    ),
    evaluationLabel: formatSalesLearningEvaluation(latestComparisonSummary),
    minimumFeedbackLabel: minimumFeedbackRequired > 0 ? formatInteger(minimumFeedbackRequired) : 'Non disponible',
    lastReason: String(
      payload?.last_reason ??
      payload?.learning_cycle?.last_reason ??
      ''
    ).trim() || null
  }
}

export function buildSalesMonitoringViewModel(summaryResponse = {}, detailsResponse = {}) {
  const summary = normalizeMonitoringSummary(summaryResponse?.summary)
  const detailRows = buildSalesMonitoringDetailRows(detailsResponse?.rows)
  const rowCount = Number(summaryResponse?.row_count ?? detailsResponse?.row_count ?? detailRows.length ?? 0)
  return {
    rowCount,
    filters: summaryResponse?.filters && typeof summaryResponse.filters === 'object'
      ? summaryResponse.filters
      : (detailsResponse?.filters && typeof detailsResponse.filters === 'object' ? detailsResponse.filters : {}),
    summary,
    kpis: buildSalesMonitoringKpis(summary),
    byCommercialRows: buildMonitoringSegmentRows(summaryResponse?.segmented?.by_commercial),
    byPlanningDateRows: buildMonitoringSegmentRows(summaryResponse?.segmented?.by_planning_date),
    detailRows
  }
}

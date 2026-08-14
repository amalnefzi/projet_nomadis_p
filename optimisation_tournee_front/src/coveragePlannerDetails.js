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

export function translatePriorityReasons(reasonCodes = []) {
  return [...new Set((Array.isArray(reasonCodes) ? reasonCodes : [])
    .map(reason => PRIORITY_REASON_LABELS[reason] || reason)
    .filter(Boolean))]
}

function hasValidGps(client = {}) {
  if (client?.latitude === null || client?.latitude === undefined || client?.latitude === '') return false
  if (client?.longitude === null || client?.longitude === undefined || client?.longitude === '') return false
  return Number.isFinite(Number(client.latitude)) && Number.isFinite(Number(client.longitude))
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
  const purchaseKnown = Number(block?.purchase_prediction_known_count ?? 0)
  const recoveryPartial = Boolean(block?.recovery_completeness === false)
  const purchasePartial = Boolean(block?.purchase_prediction_completeness === false)

  let completenessLabel = 'Donnees completes'
  if (recoveryPartial || purchasePartial) {
    completenessLabel = `Donnees partielles : Rec. ${formatInteger(recoveryKnown)}/${formatInteger(clientsCount)} | Achat ${formatInteger(purchaseKnown)}/${formatInteger(clientsCount)}`
  }

  return {
    date: block?.date || '-',
    commercialLabel: block?.commercial_label || block?.commercial_code || '-',
    clientsLabel: `${formatInteger(clientsCount)} client(s)`,
    collectionLabel: block?.expected_collection_total == null
      ? 'Collecte connue : Non disponible'
      : `Collecte connue : ${formatNullableCurrency(block.expected_collection_total)}`,
    predictedOrderLabel: block?.predicted_order_value_total == null
      ? 'Chiffre predit non disponible'
      : `${block?.purchase_prediction_completeness === false ? 'Chiffre predit partiel' : 'Chiffre predit connu'} : ${formatNullableCurrency(block.predicted_order_value_total)}`,
    completenessLabel
  }
}

export function buildCoverageClientRows(block = {}) {
  return (Array.isArray(block?.clients) ? block.clients : []).map((client, index) => ({
    clientId: String(client?.client_id || `client-${index + 1}`),
    clientCode: String(client?.client_code || ''),
    clientName: String(client?.client_name || client?.client_code || `Client ${index + 1}`),
    order: index + 1,
    zoneLabel: client?.zone || client?.zone_comm || client?.commercia_zone || null,
    gpsAvailable: hasValidGps(client),
    reasons: translatePriorityReasons(client?.priority_reasons),
    coverageUrgency: client?.priority_breakdown?.coverage_urgency ?? null,
    recoveryPriorityScore: client?.recovery_priority_score ?? null,
    purchasePredictionScore: client?.purchase_prediction_score ?? null,
    dueAmount: client?.recovery_due_amount ?? null,
    overdueDays: client?.recovery_days_past_due ?? null,
    expectedCollectionAmount: client?.recovery_expected_collection_amount ?? null,
    paymentBehaviorScore: client?.recovery_payment_behavior_score ?? null,
    recommendedQuantity: client?.recommended_quantity ?? null,
    expectedOrderValue: client?.expected_order_value ?? null,
    predictedPurchaseDate: client?.predicted_purchase_date ?? null,
    predictedCa: client?.predicted_ca ?? null
  }))
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

  return {
    commercialLabel: block?.commercial_label || block?.commercial_code || '-',
    date: block?.date || '-',
    clientsLabel: `${formatInteger(block?.clients_count || 0)} client(s)`,
    zoneLabel: block?.main_zone || block?.zone || null,
    expectedCollectionLabel: block?.expected_collection_total == null
      ? 'Non disponible'
      : formatNullableCurrency(block.expected_collection_total),
    overdueBalanceLabel: block?.overdue_balance_total == null
      ? 'Non disponible'
      : formatNullableCurrency(block.overdue_balance_total),
    predictedOrderLabel: block?.predicted_order_value_total == null
      ? 'Non disponible'
      : formatNullableCurrency(block.predicted_order_value_total),
    recommendedQuantityLabel: block?.recommended_quantity_total == null
      ? 'Non disponible'
      : `${formatInteger(block.recommended_quantity_total)} unites`,
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
    recoveryPartial: block?.recovery_completeness === false,
    purchasePartial: block?.purchase_prediction_completeness === false
  }
}

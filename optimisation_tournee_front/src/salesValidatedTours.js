import {
  formatSalesPortfolioStatus,
  formatSalesVisitExecutionStatus
} from './salesCoverageDetails.js'

function normalizeText(value) {
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

export function buildValidatedToursSearchParams(filters = {}) {
  const params = {}
  const date = normalizeText(filters.date)
  const commercialCode = normalizeText(filters.commercialCode)
  const tourneeCode = normalizeText(filters.tourneeCode)

  if (date) params.date = date
  if (commercialCode) params.commercial_code = commercialCode
  if (tourneeCode) params.tournee_code = tourneeCode

  return params
}

export function resolveCommercialLabel(commercialCode, options = []) {
  const normalizedCode = normalizeText(commercialCode)
  if (!normalizedCode) return 'Commercial non renseigne'

  const match = (Array.isArray(options) ? options : []).find(
    option => normalizeText(option?.value) === normalizedCode
  )

  return match?.label || `Commercial ${normalizedCode}`
}

const TOUR_STATUS_LABELS = {
  validated: 'Validee - a demarrer',
  in_progress: "En cours d'execution",
  completed: 'Terminee',
  replaced: 'Remplacee'
}

export function formatValidatedTourStatus(status) {
  const normalized = normalizeText(status) || 'validated'
  return TOUR_STATUS_LABELS[normalized] || normalized
}

export function normalizeValidatedTourSummary(raw = {}, options = []) {
  const commercialCode = normalizeText(raw?.commercial_code)
  const status = normalizeText(raw?.status) || 'validated'
  return {
    tourneeCode: normalizeText(raw?.tournee_code),
    date: normalizeText(raw?.date),
    commercialCode,
    commercialLabel: resolveCommercialLabel(commercialCode, options),
    routeCode: normalizeText(raw?.route_code),
    depotCode: normalizeText(raw?.depot_code),
    clientsCount: Number(raw?.clients_count || 0),
    status,
    statusLabel: formatValidatedTourStatus(status)
  }
}

export function normalizeValidatedTourSummaries(rawList = [], options = []) {
  return (Array.isArray(rawList) ? rawList : []).map(row => normalizeValidatedTourSummary(row, options))
}

export function buildValidatedTourHeaderModel(tourDetail = {}, options = []) {
  const commercialCode = normalizeText(tourDetail?.commercial_code)
  const status = normalizeText(tourDetail?.status) || 'validated'
  return {
    tourneeCode: normalizeText(tourDetail?.tournee_code),
    date: normalizeText(tourDetail?.date) || 'Non disponible',
    commercialCode,
    commercialLabel: resolveCommercialLabel(commercialCode, options),
    routeCode: normalizeText(tourDetail?.route_code) || 'Non disponible',
    depotCode: normalizeText(tourDetail?.depot_code) || 'Non disponible',
    clientsCount: Number(tourDetail?.clients_count || (Array.isArray(tourDetail?.stops) ? tourDetail.stops.length : 0)),
    status,
    statusLabel: formatValidatedTourStatus(status),
    isCompleted: status === 'completed',
    canComplete: status === 'validated' || status === 'in_progress',
    startedAt: normalizeText(tourDetail?.started_at),
    completedAt: normalizeText(tourDetail?.completed_at)
  }
}

function hasValidGps(stop = {}) {
  return Number.isFinite(Number(stop?.latitude)) && Number.isFinite(Number(stop?.longitude))
}

export function buildValidatedTourRows(tourDetail = {}) {
  const stops = Array.isArray(tourDetail?.stops) ? tourDetail.stops : []

  return stops.map((stop, index) => {
    const clientCode = normalizeText(stop?.client_code) || `client-${index + 1}`
    const executionStatus = normalizeText(stop?.execution_status) || 'pending'

    return {
      key: `${clientCode}-${index + 1}`,
      rang: Number(stop?.rang) || index + 1,
      plannedVisitId: normalizeText(stop?.planned_visit_id),
      assignedSlotId: normalizeText(stop?.assigned_slot_id),
      clientId: normalizeText(stop?.client_id),
      clientCode,
      clientName: normalizeText(stop?.client_name) || clientCode,
      address: normalizeText(stop?.adresse) || 'Adresse non specifiee',
      latitude: normalizeNullableNumber(stop?.latitude),
      longitude: normalizeNullableNumber(stop?.longitude),
      gpsAvailable: hasValidGps(stop),
      commercialCode: normalizeText(stop?.commercial_code) || normalizeText(tourDetail?.commercial_code),
      commercialLabel: null,
      plannedDate: normalizeText(stop?.planned_date) || normalizeText(tourDetail?.date),
      executionStatus,
      executionStatusLabel: formatSalesVisitExecutionStatus(executionStatus),
      purchaseMade: stop?.purchase_made ?? null,
      actualCa: normalizeNullableNumber(stop?.actual_ca),
      actualQuantity: normalizeNullableNumber(stop?.actual_quantity),
      note: normalizeText(stop?.note) || '',
      predictedCa: normalizeNullableNumber(stop?.predicted_ca),
      predictedCaIfBuy: normalizeNullableNumber(stop?.predicted_ca_if_buy),
      recommendedQuantity: normalizeNullableNumber(stop?.recommended_quantity),
      predictedQuantityIfBuy: normalizeNullableNumber(stop?.predicted_quantity_if_buy),
      purchaseProbability: normalizeNullableNumber(stop?.purchase_probability),
      portfolioStatus: normalizeText(stop?.portfolio_status),
      portfolioStatusLabel: formatSalesPortfolioStatus(stop?.portfolio_status),
      predictionSnapshot: stop?.prediction_snapshot && typeof stop.prediction_snapshot === 'object'
        ? stop.prediction_snapshot
        : null
    }
  })
}

export function buildValidatedTourRouteStops(rows = []) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    id: row.clientId || row.clientCode,
    client_id: row.clientId || '',
    client_code: row.clientCode || '',
    nom: row.clientName,
    adresse: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    step: row.rang
  }))
}

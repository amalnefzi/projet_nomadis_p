export const FRENCH_DAY_LABELS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi']
export const DEFAULT_COVERAGE_PERIOD_DAYS = 14
export const DEFAULT_COVERAGE_VISIT_FREQUENCY_DAYS = 14
export const DEFAULT_COVERAGE_WORKING_DAYS = ['0', '1', '2', '3', '4', '5', '6']

export function formatInteger(value) {
  const numericValue = Number(value)
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Number.isFinite(numericValue) ? numericValue : 0)
}

export function formatDecimal(value, digits = 1) {
  const numericValue = Number(value)
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(Number.isFinite(numericValue) ? numericValue : 0)
}

export function formatCurrency(value) {
  return `${formatDecimal(value, 1)} TND`
}

export function formatNullableCurrency(value) {
  if (value === null || value === undefined || value === '') {
    return 'Non disponible'
  }

  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return 'Non disponible'
  }

  return `${numericValue.toLocaleString('fr-TN', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  })} TND`
}

export function formatDistanceKm(value) {
  const numericValue = Number(value)
  const safeValue = Number.isFinite(numericValue) ? numericValue : 0
  return `${formatDecimal(safeValue, safeValue >= 10 ? 0 : 1)} km`
}

export function todayIsoDate() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function buildPlannerDates(startDateValue, periodDaysValue, workingDays = []) {
  const parsedPeriodDays = Number.parseInt(periodDaysValue, 10)
  const allowedDays = new Set(
    (Array.isArray(workingDays) ? workingDays : [])
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isFinite(value) && value >= 0 && value <= 6)
  )
  const normalizedAllowedDays = allowedDays.size ? allowedDays : new Set(DEFAULT_COVERAGE_WORKING_DAYS.map(Number))
  if (!startDateValue || !Number.isFinite(parsedPeriodDays) || parsedPeriodDays <= 0) {
    return []
  }

  const [year, month, day] = String(startDateValue).slice(0, 10).split('-').map(Number)
  const startDate = new Date(year, (month || 1) - 1, day || 1)
  if (Number.isNaN(startDate.getTime())) {
    return []
  }

  startDate.setHours(0, 0, 0, 0)
  const dates = []

  for (let offset = 0; offset < parsedPeriodDays; offset += 1) {
    const current = new Date(startDate)
    current.setDate(startDate.getDate() + offset)
    current.setHours(0, 0, 0, 0)
    if (!normalizedAllowedDays.has(current.getDay())) continue
    const isoDate = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`
    dates.push({
      date: isoDate,
      label: FRENCH_DAY_LABELS[current.getDay()] || ''
    })
  }

  return dates
}

export function buildCommercialAvailabilityRequest(selectedCommercials, unavailableDatesByCommercial = {}) {
  const payload = {}
  selectedCommercials.forEach(code => {
    const unavailableDates = [...new Set(
      (Array.isArray(unavailableDatesByCommercial?.[code]) ? unavailableDatesByCommercial[code] : [])
        .map(value => String(value || '').trim())
        .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
    )]
    if (!unavailableDates.length) return
    payload[code] = { unavailable_dates: unavailableDates }
  })
  return payload
}

export function computeRecommendedMaxCapacity(clientsToCover, totalSlots) {
  const normalizedClients = Math.max(0, Number.parseInt(clientsToCover, 10) || 0)
  const normalizedSlots = Math.max(0, Number.parseInt(totalSlots, 10) || 0)
  if (normalizedClients <= 0 || normalizedSlots <= 0) {
    return 0
  }
  return Math.ceil(normalizedClients / normalizedSlots)
}

export function computeBlockLoadStats(blocks = []) {
  const loads = (Array.isArray(blocks) ? blocks : [])
    .map(block => Number(block?.clients_count || 0))
    .filter(value => Number.isFinite(value) && value > 0)

  if (!loads.length) {
    return {
      min: 0,
      avg: 0,
      max: 0
    }
  }

  const total = loads.reduce((sum, value) => sum + value, 0)
  return {
    min: Math.min(...loads),
    avg: total / loads.length,
    max: Math.max(...loads)
  }
}

export function computeTotalEstimatedDistanceKm(blocks = []) {
  return (Array.isArray(blocks) ? blocks : []).reduce((sum, block) => {
    const distanceKm = Number(block?.estimated_distance_km || 0)
    return sum + (Number.isFinite(distanceKm) ? distanceKm : 0)
  }, 0)
}

export function computeTotalCaShortfall(blocks = []) {
  let hasUnknownShortfall = false
  const total = (Array.isArray(blocks) ? blocks : []).reduce((sum, block) => {
    if (block?.ca_shortfall === null || block?.ca_shortfall === undefined || block?.ca_shortfall === '') {
      hasUnknownShortfall = true
      return sum
    }

    const shortfall = Number(block?.ca_shortfall)
    if (!Number.isFinite(shortfall)) {
      hasUnknownShortfall = true
      return sum
    }
    return sum + shortfall
  }, 0)

  return hasUnknownShortfall ? null : total
}

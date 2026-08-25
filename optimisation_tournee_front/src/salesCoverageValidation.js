import { todayIsoDate } from './coveragePlannerUtils.js'
import { normalizeSelectedSalesCommercialCodes } from './salesCoverageDetails.js'

const SALES_COVERAGE_INVALID_DATE_MESSAGE = 'Selectionne une date de debut valide au format YYYY-MM-DD.'
const SALES_COVERAGE_PAST_DATE_MESSAGE = 'La date de debut du plan de tournees ventes ne peut pas etre dans le passe.'
const SALES_COVERAGE_PERIOD_MESSAGE = 'La periode du plan de tournees ventes doit etre comprise entre 1 et 60 jours.'
const SALES_COVERAGE_MIN_CLIENTS_MESSAGE = 'La charge cible par commercial et par jour ne peut pas etre negative.'
const SALES_COVERAGE_MAX_CLIENTS_MESSAGE = 'Le maximum par commercial et par jour ne peut pas etre negatif.'
const SALES_COVERAGE_STRICT_MAX_MESSAGE = 'En mode maximum strict, la charge cible ne peut pas depasser le maximum renseigne.'
const SALES_COVERAGE_NO_COMMERCIAL_MESSAGE = 'Selectionne au moins un commercial pour generer le plan de tournees ventes.'
const SALES_COVERAGE_UNKNOWN_COMMERCIALS_MESSAGE = 'Un ou plusieurs codes commerciaux selectionnes sont introuvables.'

function isValidIsoDateOnly(value) {
  const rawValue = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    return false
  }

  const [year, month, day] = rawValue.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)
  return (
    Number.isFinite(year) &&
    Number.isFinite(month) &&
    Number.isFinite(day) &&
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  )
}

function parseIntegerLike(value) {
  const rawValue = String(value ?? '').trim()
  if (rawValue === '') {
    return { empty: true, valid: true, value: null }
  }

  if (!/^-?\d+$/.test(rawValue)) {
    return { empty: false, valid: false, value: null }
  }

  return {
    empty: false,
    valid: true,
    value: Number.parseInt(rawValue, 10)
  }
}

function parseCommercialSelectionInput(selection) {
  if (Array.isArray(selection)) {
    return [...new Set(
      selection
        .map(value => String(value ?? '').trim())
        .filter(Boolean)
    )]
  }

  const rawValue = String(selection ?? '').trim()
  return rawValue ? [rawValue] : []
}

export function validateSalesCoverageFilters(
  filters = {},
  options = {},
  today = todayIsoDate()
) {
  const rawSelectedCommercialCodes = parseCommercialSelectionInput(filters.commercial_codes)
  const selectedCommercialCodes = normalizeSelectedSalesCommercialCodes(
    filters.commercial_codes,
    Array.isArray(options.commerciaux) ? options.commerciaux : []
  )
  const validCommercialCodes = new Set(
    (Array.isArray(options.commerciaux) ? options.commerciaux : [])
      .map(item => String(item?.value ?? '').trim())
      .filter(Boolean)
  )
  const startDate = String(filters.start_date || '').trim()

  if (!isValidIsoDateOnly(startDate)) {
    return {
      valid: false,
      message: SALES_COVERAGE_INVALID_DATE_MESSAGE
    }
  }

  if (startDate < String(today || '').trim()) {
    return {
      valid: false,
      message: SALES_COVERAGE_PAST_DATE_MESSAGE
    }
  }

  const periodDays = parseIntegerLike(filters.period_days)
  if (!periodDays.valid || periodDays.value < 1 || periodDays.value > 60) {
    return {
      valid: false,
      message: SALES_COVERAGE_PERIOD_MESSAGE
    }
  }

  const minClients = parseIntegerLike(filters.min_clients)
  if (!minClients.valid || minClients.value < 0) {
    return {
      valid: false,
      message: SALES_COVERAGE_MIN_CLIENTS_MESSAGE
    }
  }

  const maxClients = parseIntegerLike(filters.max_clients)
  if (!maxClients.valid || (!maxClients.empty && maxClients.value < 0)) {
    return {
      valid: false,
      message: SALES_COVERAGE_MAX_CLIENTS_MESSAGE
    }
  }

  const hasStrictMaximum = !maxClients.empty && maxClients.value > 0
  if (
    String(filters.daily_max_mode || '').trim() === 'strict' &&
    hasStrictMaximum &&
    minClients.value > maxClients.value
  ) {
    return {
      valid: false,
      message: SALES_COVERAGE_STRICT_MAX_MESSAGE
    }
  }

  if (!rawSelectedCommercialCodes.length) {
    return {
      valid: false,
      message: SALES_COVERAGE_NO_COMMERCIAL_MESSAGE
    }
  }

  if (rawSelectedCommercialCodes.some(code => !validCommercialCodes.has(code))) {
    return {
      valid: false,
      message: SALES_COVERAGE_UNKNOWN_COMMERCIALS_MESSAGE
    }
  }

  return {
    valid: true,
    message: null
  }
}

export function resolveSalesCoverageSubmitGuard({
  filters = {},
  commerciaux = [],
  invalidateGeneratedPlan,
  today,
  requestBuilder
} = {}) {
  const validation = validateSalesCoverageFilters(
    filters,
    { commerciaux },
    today
  )

  if (!validation.valid) {
    if (typeof invalidateGeneratedPlan === 'function') {
      invalidateGeneratedPlan()
    }

    return {
      shouldSubmit: false,
      errorMessage: validation.message,
      payload: null
    }
  }

  return {
    shouldSubmit: true,
    errorMessage: null,
    payload: typeof requestBuilder === 'function' ? requestBuilder() : null
  }
}

export const __testables = {
  isValidIsoDateOnly,
  parseIntegerLike,
  parseCommercialSelectionInput,
  SALES_COVERAGE_INVALID_DATE_MESSAGE,
  SALES_COVERAGE_PAST_DATE_MESSAGE,
  SALES_COVERAGE_PERIOD_MESSAGE,
  SALES_COVERAGE_MIN_CLIENTS_MESSAGE,
  SALES_COVERAGE_MAX_CLIENTS_MESSAGE,
  SALES_COVERAGE_STRICT_MAX_MESSAGE,
  SALES_COVERAGE_NO_COMMERCIAL_MESSAGE,
  SALES_COVERAGE_UNKNOWN_COMMERCIALS_MESSAGE
}

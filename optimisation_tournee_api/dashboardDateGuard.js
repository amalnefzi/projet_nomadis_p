const PAST_SALES_PLAN_MESSAGE = 'Les tournees de vente ne peuvent pas etre planifiees sur une date passee.'

function parseLocalIsoDate(value) {
  if (!value) return null

  const [year, month, day] = String(value).split('-').map(Number)
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null
  }

  const parsed = new Date(year, month - 1, day)
  parsed.setHours(0, 0, 0, 0)
  return parsed
}

function normalizeStartOfDay(value) {
  const date = value instanceof Date ? new Date(value) : new Date()
  date.setHours(0, 0, 0, 0)
  return date
}

function shouldRejectPastSalesPlanRequest({
  modeTournee,
  datePrecise,
  dateDebut,
  dateFin,
  today = new Date()
}) {
  if (modeTournee !== 'vente') return false

  const referenceDate = dateDebut && dateFin ? dateDebut : datePrecise
  const requestedDate = parseLocalIsoDate(referenceDate)
  if (!requestedDate) return false

  return requestedDate < normalizeStartOfDay(today)
}

function getPastSalesPlanMessage() {
  return PAST_SALES_PLAN_MESSAGE
}

module.exports = {
  getPastSalesPlanMessage,
  shouldRejectPastSalesPlanRequest
}

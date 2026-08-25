export function filterVisibleDashboardRows(
  rows = [],
  {
    isRecouvrementMode = false,
    topClients = null
  } = {}
) {
  const normalizedRows = Array.isArray(rows) ? rows : []
  const visibleRows = isRecouvrementMode
    ? normalizedRows
    : normalizedRows.filter(row => Number(row?.qte_reco || 0) > 0)

  if (!Number.isFinite(topClients) || topClients <= 0) {
    return visibleRows
  }

  const cappedCount = Math.min(visibleRows.length, Math.max(1, Number(topClients)))
  return visibleRows.slice(0, cappedCount)
}

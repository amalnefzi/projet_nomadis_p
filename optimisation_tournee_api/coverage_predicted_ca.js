function resolveCoveragePredictedCa(historyMetrics = null) {
  const rawAvgCaHist = historyMetrics?.avg_ca_hist
  if (rawAvgCaHist === null || rawAvgCaHist === undefined || rawAvgCaHist === '') {
    return {
      predicted_ca: null,
      predicted_ca_known: false,
      predicted_ca_source: 'unavailable'
    }
  }
  const avgCaHist = Number(rawAvgCaHist)

  if (Number.isFinite(avgCaHist)) {
    return {
      predicted_ca: avgCaHist,
      predicted_ca_known: true,
      predicted_ca_source: 'sales_history'
    }
  }

  return {
    predicted_ca: null,
    predicted_ca_known: false,
    predicted_ca_source: 'unavailable'
  }
}

function buildCoverageNonCancelledDocumentSqlCondition(columnName = 'annule') {
  return `(${columnName} IS NULL OR TRIM(${columnName}) = '' OR TRIM(${columnName}) = '0')`
}

module.exports = {
  buildCoverageNonCancelledDocumentSqlCondition,
  resolveCoveragePredictedCa
}

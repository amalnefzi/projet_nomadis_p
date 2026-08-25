import { todayIsoDate } from './coveragePlannerUtils.js'

export function normalizeSalesCoverageReadinessStartDate(startDate) {
  return String(startDate || todayIsoDate()).slice(0, 10)
}

export async function fetchSalesCoverageReadiness(
  axiosClient,
  apiUrl,
  startDate,
  timeoutMs
) {
  return axiosClient.get(`${apiUrl}/api/tournees/next-best-visits/readiness`, {
    timeout: timeoutMs,
    params: {
      start_date: normalizeSalesCoverageReadinessStartDate(startDate)
    }
  })
}

export async function retrySalesCoverageReadiness(
  axiosClient,
  apiUrl,
  startDate,
  timeoutMs
) {
  return axiosClient.post(
    `${apiUrl}/api/tournees/next-best-visits/readiness/retry`,
    {
      start_date: normalizeSalesCoverageReadinessStartDate(startDate)
    },
    {
      timeout: timeoutMs
    }
  )
}

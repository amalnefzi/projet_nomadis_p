export const DEFAULT_SALES_PLAN_API_ERROR_MESSAGE = "Erreur connexion. Verifiez MySQL et l'API."

export function getSalesPlanApiErrorMessage(error) {
  const apiMessage = typeof error?.response?.data?.message === 'string'
    ? error.response.data.message.trim()
    : ''

  if (apiMessage) {
    return apiMessage
  }

  const apiError = typeof error?.response?.data?.error === 'string'
    ? error.response.data.error.trim()
    : ''

  if (apiError) {
    return apiError
  }

  return DEFAULT_SALES_PLAN_API_ERROR_MESSAGE
}

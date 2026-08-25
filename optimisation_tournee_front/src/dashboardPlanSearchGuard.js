import {
  getPastSalesPlanMessage,
  shouldBlockPastSalesPlanRequest
} from './dashboardDateGuard.js'

export function createClearedDashboardPlanState(previousState = {}) {
  return {
    ...previousState,
    donneesTournee: null,
    editableTournees: [],
    additionalSuggestions: [],
    clickedClient: null,
    validationFeedback: null,
    isValidationModalOpen: false,
    manualOrderLocked: false
  }
}

export async function executeDashboardPlanSearchGuard({
  modeTournee,
  datePrecise,
  dateDebut,
  dateFin,
  today,
  previousState = {},
  requestPlan
} = {}) {
  if (shouldBlockPastSalesPlanRequest({
    modeTournee,
    datePrecise,
    dateDebut,
    dateFin,
    today
  })) {
    return {
      blocked: true,
      errorMessage: getPastSalesPlanMessage(),
      nextState: createClearedDashboardPlanState(previousState)
    }
  }

  return {
    blocked: false,
    response: await requestPlan()
  }
}

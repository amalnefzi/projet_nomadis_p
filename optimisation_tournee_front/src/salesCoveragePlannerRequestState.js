export function invalidateSalesCoveragePlannerRequest(currentSequence) {
  return {
    requestSequence: currentSequence + 1,
    viewState: {
      loading: false,
      error: null,
      planView: null,
      selectedBlockId: null
    }
  }
}

export function startSalesCoveragePlannerRequest(currentSequence) {
  return {
    requestSequence: currentSequence + 1,
    viewState: {
      loading: true,
      error: null,
      planView: null,
      selectedBlockId: null
    }
  }
}

export function resolveSalesCoveragePlannerRequestSuccess(
  activeSequence,
  requestSequence,
  planView
) {
  if (requestSequence !== activeSequence) {
    return null
  }

  return {
    loading: false,
    error: null,
    planView,
    selectedBlockId: planView?.blocks?.[0]?.slot_id || null
  }
}

export function resolveSalesCoveragePlannerRequestError(
  activeSequence,
  requestSequence,
  errorMessage
) {
  if (requestSequence !== activeSequence) {
    return null
  }

  return {
    loading: false,
    error: errorMessage,
    planView: null,
    selectedBlockId: null
  }
}

function isActiveSalesCoverageReadinessRequest(
  activeSequence,
  requestSequence,
  activeContextKey,
  requestContextKey
) {
  return (
    requestSequence === activeSequence &&
    requestContextKey === activeContextKey
  )
}

export function startSalesCoverageReadinessRequest(
  currentSequence,
  currentState = {}
) {
  return {
    requestSequence: currentSequence + 1,
    viewState: {
      loading: true,
      error: null,
      payload: currentState?.payload ?? null
    }
  }
}

export function resolveSalesCoverageReadinessRequestSuccess(
  activeSequence,
  requestSequence,
  activeContextKey,
  requestContextKey,
  payload
) {
  if (
    !isActiveSalesCoverageReadinessRequest(
      activeSequence,
      requestSequence,
      activeContextKey,
      requestContextKey
    )
  ) {
    return null
  }

  return {
    loading: false,
    error: null,
    payload: payload && typeof payload === 'object' ? payload : null
  }
}

export function resolveSalesCoverageReadinessRequestError(
  activeSequence,
  requestSequence,
  activeContextKey,
  requestContextKey,
  currentState,
  errorMessage
) {
  if (
    !isActiveSalesCoverageReadinessRequest(
      activeSequence,
      requestSequence,
      activeContextKey,
      requestContextKey
    )
  ) {
    return null
  }

  return {
    loading: false,
    error: errorMessage,
    payload: currentState?.payload ?? null
  }
}

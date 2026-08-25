function normalizeExactString(value) {
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

function buildClientIdentity(client = {}) {
  return {
    clientId: normalizeExactString(client?.client_id ?? client?.clientId ?? client?.id ?? client?.client_unique_key),
    clientCode: normalizeExactString(client?.client_code ?? client?.clientCode ?? client?.nbr_client)
  }
}

function normalizeRecommendedProducts(client = {}) {
  const products = Array.isArray(client?.recommended_products)
    ? client.recommended_products
    : (Array.isArray(client?.predicted_products) ? client.predicted_products : [])

  return products
}

export function buildSalesBlockValidationScopeKey(block = {}) {
  const slotId = normalizeExactString(block?.slot_id ?? block?.slotId) || 'slot:none'
  const planningDate = normalizeExactString(block?.date) || 'date:none'
  const commercialCode = normalizeExactString(block?.commercial_code ?? block?.commercialCode) || 'commercial:none'
  const clientFingerprint = (Array.isArray(block?.clients) ? block.clients : [])
    .map((client, index) => {
      const identity = buildClientIdentity(client)
      return `${index + 1}:${identity.clientId || 'id:none'}:${identity.clientCode || 'code:none'}`
    })
    .join('|')

  return [slotId, planningDate, commercialCode, clientFingerprint].join('::')
}

export function buildSalesValidationRouteOrderIndex(routePlan = null) {
  return (Array.isArray(routePlan?.orderedStops) ? routePlan.orderedStops : []).reduce((accumulator, stop, index) => {
    const step = Number(stop?.step)
    const rank = Number.isFinite(step) && step > 0 ? step : index + 1
    const clientId = normalizeExactString(stop?.client_id ?? stop?.clientId)
    const clientCode = normalizeExactString(stop?.client_code ?? stop?.clientCode ?? stop?.id)

    if (clientId && !(clientId in accumulator.byClientId)) {
      accumulator.byClientId[clientId] = rank
    }

    if (clientCode && !(clientCode in accumulator.byClientCode)) {
      accumulator.byClientCode[clientCode] = rank
    }

    return accumulator
  }, {
    byClientId: {},
    byClientCode: {}
  })
}

export function resolveSalesValidationExecutionRank(client = {}, routeOrderIndex = null, fallbackRank = 1) {
  const normalizedFallbackRank = Number.isFinite(Number(fallbackRank)) && Number(fallbackRank) > 0
    ? Number(fallbackRank)
    : 1
  const identity = buildClientIdentity(client)

  if (identity.clientId && routeOrderIndex?.byClientId?.[identity.clientId]) {
    return routeOrderIndex.byClientId[identity.clientId]
  }

  if (identity.clientCode && routeOrderIndex?.byClientCode?.[identity.clientCode]) {
    return routeOrderIndex.byClientCode[identity.clientCode]
  }

  return normalizedFallbackRank
}

export function buildSalesBlockValidationPayload(block = {}, routePlan = null) {
  const planningDate = normalizeExactString(block?.date)
  const commercialCode = normalizeExactString(block?.commercial_code ?? block?.commercialCode)
  const routeOrderIndex = buildSalesValidationRouteOrderIndex(routePlan)
  const slotId = normalizeExactString(block?.slot_id ?? block?.slotId) || (
    planningDate && commercialCode ? `${planningDate}::${commercialCode}` : null
  )

  return {
    block: {
      slot_id: slotId,
      date: planningDate,
      day_label: normalizeExactString(block?.day_label ?? block?.dayLabel),
      commercial_code: commercialCode,
      commercial_label: normalizeExactString(block?.commercial_label ?? block?.commercialLabel) || commercialCode,
      route_code: normalizeExactString(block?.route_code ?? block?.routeCode) || '',
      depot_code: normalizeExactString(
        block?.depot_code ??
        block?.depotCode ??
        block?.depot?.depot_code ??
        block?.depot?.code
      ) || '',
      depot_name: normalizeExactString(
        block?.depot_name ??
        block?.depotName ??
        block?.depot?.nom ??
        block?.depot?.name
      ) || '',
      clients: (Array.isArray(block?.clients) ? block.clients : []).map((client, index) => {
        const identity = buildClientIdentity(client)
        const rank = resolveSalesValidationExecutionRank(client, routeOrderIndex, index + 1)
        const clientName = normalizeExactString(client?.client_name ?? client?.clientName ?? client?.nom) || (
          identity.clientCode || `Client ${index + 1}`
        )

        return {
          client_id: identity.clientId,
          client_code: identity.clientCode,
          client_name: clientName,
          adresse: normalizeExactString(client?.adresse ?? client?.address),
          latitude: normalizeNullableNumber(client?.latitude),
          longitude: normalizeNullableNumber(client?.longitude),
          rang: rank,
          planned_visit_id: normalizeExactString(client?.planned_visit_id),
          assigned_slot_id: normalizeExactString(client?.assigned_slot_id ?? slotId),
          assigned_date: planningDate,
          planned_date: planningDate,
          candidate_date: planningDate,
          commercial_code: commercialCode,
          basket_prediction_source: normalizeExactString(client?.basket_prediction_source),
          predicted_ca: normalizeNullableNumber(client?.predicted_ca),
          predicted_ca_if_buy: normalizeNullableNumber(client?.predicted_ca_if_buy),
          recommended_quantity: normalizeNullableNumber(client?.recommended_quantity),
          predicted_quantity_if_buy: normalizeNullableNumber(client?.predicted_quantity_if_buy),
          purchase_prediction_score: normalizeNullableNumber(client?.purchase_prediction_score),
          portfolio_status: normalizeExactString(client?.portfolio_status ?? client?.final_client_status),
          recommended_products: normalizeRecommendedProducts(client),
          prediction_snapshot: client?.prediction_snapshot && typeof client.prediction_snapshot === 'object'
            ? client.prediction_snapshot
            : null
        }
      })
    }
  }
}

export function shouldStartSalesValidationRequest({
  isSubmitting = false,
  validationPhase = 'idle',
  isValidated = false,
  isRouteLoading = false
} = {}) {
  return !isSubmitting && validationPhase !== 'validating' && !isValidated && !isRouteLoading
}

export function deriveSalesBlockValidationStatus(rows = [], feedbackIndex = {}) {
  const plannedVisitIds = (Array.isArray(rows) ? rows : [])
    .map(row => normalizeExactString(row?.plannedVisitId))
    .filter(Boolean)

  if (!plannedVisitIds.length) {
    return {
      validated: false,
      matchedCount: 0,
      totalCount: 0,
      tourneeCode: null,
      message: null
    }
  }

  let sharedTourneeCode = null

  for (const plannedVisitId of plannedVisitIds) {
    const feedbackRecord = feedbackIndex?.[plannedVisitId] || null
    const tourneeCode = normalizeExactString(feedbackRecord?.tourneeCode ?? feedbackRecord?.tournee_code)

    if (!feedbackRecord || !tourneeCode) {
      return {
        validated: false,
        matchedCount: 0,
        totalCount: plannedVisitIds.length,
        tourneeCode: null,
        message: null
      }
    }

    if (sharedTourneeCode === null) {
      sharedTourneeCode = tourneeCode
      continue
    }

    if (sharedTourneeCode !== tourneeCode) {
      return {
        validated: false,
        matchedCount: 0,
        totalCount: plannedVisitIds.length,
        tourneeCode: null,
        message: null
      }
    }
  }

  return {
    validated: true,
    matchedCount: plannedVisitIds.length,
    totalCount: plannedVisitIds.length,
    tourneeCode: sharedTourneeCode,
    message: sharedTourneeCode
      ? `Tournee deja validee (${sharedTourneeCode}).`
      : 'Tournee deja validee.'
  }
}

export function shouldApplySalesValidationResponse({
  requestId,
  activeRequestId,
  requestScopeKey,
  activeScopeKey,
  isMounted = true
} = {}) {
  return Boolean(
    isMounted &&
    requestId != null &&
    activeRequestId != null &&
    requestId === activeRequestId &&
    requestScopeKey &&
    activeScopeKey &&
    requestScopeKey === activeScopeKey
  )
}

const {
  buildDeferredClientExplanation,
  buildSelectedVisitExplanation
} = require('./visit_explainability')

function roundScore(value) {
  return Math.round(Number(value || 0) * 10) / 10
}

function diffDays(startDate, endDate) {
  const startTs = Date.parse(`${String(startDate || '').slice(0, 10)}T00:00:00Z`)
  const endTs = Date.parse(`${String(endDate || '').slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return null
  return Math.round((endTs - startTs) / 86400000)
}

function buildSlotId(date, commercialCode) {
  return `${String(date || '')}::${String(commercialCode || '')}`
}

function resolveDailyCapacity({ requestMaxVisits, hardMaxVisits, fallbackMaxVisits = 8 }) {
  const hardCap = Number.isFinite(Number(hardMaxVisits)) && Number(hardMaxVisits) > 0
    ? Number(hardMaxVisits)
    : null
  const requestedCap = Number.isFinite(Number(requestMaxVisits)) && Number(requestMaxVisits) > 0
    ? Number(requestMaxVisits)
    : null

  if (hardCap != null && requestedCap != null) return Math.min(hardCap, requestedCap)
  if (hardCap != null) return hardCap
  if (requestedCap != null) return requestedCap
  return fallbackMaxVisits
}

function buildCommercialSlots({
  planningDates = [],
  selectedCommercials = [],
  commercialConstraintsByCode = new Map(),
  requestMaxVisits = null,
  minDailyCaPerCommercial = null
}) {
  const slots = []
  ;(Array.isArray(selectedCommercials) ? selectedCommercials : []).forEach(commercial => {
    const entry = commercialConstraintsByCode.get(String(commercial.value || commercial.code || '')) || {}
    const availableDateSet = new Set(Array.isArray(entry.available_dates) && entry.available_dates.length
      ? entry.available_dates
      : planningDates)
    const unavailableDateSet = new Set(Array.isArray(entry.unavailable_dates) ? entry.unavailable_dates : [])

    planningDates.forEach(date => {
      if (!availableDateSet.has(date) || unavailableDateSet.has(date)) return
      const commercialCode = String(commercial.value || commercial.code || '')
      const slotId = buildSlotId(date, commercialCode)
      slots.push({
        slot_id: slotId,
        date,
        commercial_code: commercialCode,
        commercial_label: String(commercial.label || commercialCode),
        max_visits: resolveDailyCapacity({
          requestMaxVisits,
          hardMaxVisits: entry.hard_max_visits_by_date?.[date]
        }),
        min_daily_ca_target: Number.isFinite(Number(minDailyCaPerCommercial)) && Number(minDailyCaPerCommercial) > 0
          ? Number(minDailyCaPerCommercial)
          : null,
        shift_start_time: entry.shift_start_time_by_date?.[date] || null,
        shift_end_time: entry.shift_end_time_by_date?.[date] || null,
        max_route_minutes: Number(entry.max_route_minutes_by_date?.[date]) || null,
        break_minutes: Number(entry.break_minutes_by_date?.[date]) || 0,
        depot: entry.depot_by_date?.[date] || null,
        visits: [],
        expected_order_value_total: 0
      })
    })
  })

  return slots
}

function buildScoreComparator(left = {}, right = {}) {
  const tierDelta = resolveOpportunityTierPriority(left) - resolveOpportunityTierPriority(right)
  if (tierDelta !== 0) return tierDelta
  const scoreDelta = Number(right.visit_opportunity_score || 0) - Number(left.visit_opportunity_score || 0)
  if (scoreDelta !== 0) return scoreDelta
  const caDelta = Number(right.predicted_ca || 0) - Number(left.predicted_ca || 0)
  if (caDelta !== 0) return caDelta
  return String(left.visit_opportunity_id || '').localeCompare(String(right.visit_opportunity_id || ''))
}

function computeClientGapDays(clientState = [], candidateDate) {
  if (!Array.isArray(clientState) || !clientState.length) return null
  const gaps = clientState
    .map(item => {
      const comparisonDate = String(item?.assigned_date || item?.candidate_date || item || '')
      const gap = diffDays(comparisonDate, candidateDate)
      return Number.isFinite(gap) ? Math.abs(gap) : null
    })
    .filter(Number.isFinite)
  if (!gaps.length) return null
  return Math.min(...gaps)
}

function resolveCadenceConfidenceRatio(opportunity = {}) {
  const rawValue = Number(opportunity.cadence_confidence || 0)
  if (!Number.isFinite(rawValue)) return 0
  return rawValue > 1 ? rawValue / 100 : rawValue
}

function allowsOneDayGap(opportunity = {}) {
  const cycleSource = String(opportunity.cycle_source || '').trim()
  const repeatJustificationCode = String(opportunity.repeat_justification_code || '').trim()
  const recommendedInterval = Number(opportunity.recommended_visit_interval_days || 0)
  const cadenceConfidenceRatio = resolveCadenceConfidenceRatio(opportunity)
  if (repeatJustificationCode === 'explicit_constraint') return true
  if (
    cycleSource === 'predicted_purchase_cycle' &&
    opportunity.purchase_prediction_known &&
    recommendedInterval <= 2 &&
    cadenceConfidenceRatio >= 0.7 &&
    ['fixed', 'narrow_window'].includes(String(opportunity.date_flexibility_type || ''))
  ) {
    return true
  }
  if (
    cycleSource === 'cadence_cycle' &&
    recommendedInterval <= 1 &&
    cadenceConfidenceRatio >= 0.85
  ) {
    return true
  }
  return false
}

function resolveMinimumGapDays(opportunity = {}) {
  const recommendedInterval = Math.max(1, Number(opportunity.recommended_visit_interval_days || 1) || 1)
  const cadenceConfidenceRatio = resolveCadenceConfidenceRatio(opportunity)
  const cycleSource = String(opportunity.cycle_source || '').trim()
  if (allowsOneDayGap(opportunity)) return 1

  let baselineGap = Math.max(2, Math.round(recommendedInterval * 0.35))
  if (recommendedInterval <= 3) baselineGap = Math.max(baselineGap, 2)
  if (recommendedInterval >= 7) baselineGap = Math.max(baselineGap, 3)
  if (recommendedInterval >= 14) baselineGap = Math.max(baselineGap, 5)
  if (cycleSource === 'exploration_cycle') baselineGap = Math.max(baselineGap, 7)
  if (cycleSource === 'low_history_cycle') baselineGap = Math.max(baselineGap, 3)
  if (cycleSource === 'max_days_without_contact_cycle') baselineGap = Math.max(baselineGap, 3)
  if (cadenceConfidenceRatio < 0.45) baselineGap = Math.max(baselineGap, 3)
  return baselineGap
}

function classifyRepeatPair(previousVisit = {}, currentVisit = {}) {
  const previousDate = String(previousVisit.assigned_date || previousVisit.candidate_date || '')
  const currentDate = String(currentVisit.assigned_date || currentVisit.candidate_date || '')
  const gapDays = diffDays(previousDate, currentDate)
  const minimumGapDays = Math.max(
    Number(previousVisit.personalized_minimum_gap_days || 0),
    Number(currentVisit.personalized_minimum_gap_days || 0),
    1
  )
  if (!Number.isFinite(gapDays)) {
    return {
      gap_days: null,
      minimum_gap_days: minimumGapDays,
      classification: 'insufficient_evidence',
      justified: false
    }
  }
  if (String(previousVisit.visit_cycle_id || '') && String(previousVisit.visit_cycle_id || '') === String(currentVisit.visit_cycle_id || '')) {
    return {
      gap_days: gapDays,
      minimum_gap_days: minimumGapDays,
      classification: 'duplicate_same_cycle',
      justified: false
    }
  }
  if (gapDays >= minimumGapDays) {
    return {
      gap_days: gapDays,
      minimum_gap_days: minimumGapDays,
      classification: 'normal_gap',
      justified: true
    }
  }
  if (gapDays === 1 && allowsOneDayGap(currentVisit)) {
    if (String(currentVisit.repeat_justification_code || '') === 'explicit_constraint') {
      return {
        gap_days: gapDays,
        minimum_gap_days: minimumGapDays,
        classification: 'justified_explicit_constraints',
        justified: true
      }
    }
    if (String(currentVisit.cycle_source || '') === 'predicted_purchase_cycle') {
      return {
        gap_days: gapDays,
        minimum_gap_days: minimumGapDays,
        classification: 'justified_distinct_prediction_cycles',
        justified: true
      }
    }
    return {
      gap_days: gapDays,
      minimum_gap_days: minimumGapDays,
      classification: 'justified_high_frequency_cadence',
      justified: true
    }
  }
  if (
    String(previousVisit.cycle_source || '') === 'exploration_cycle' ||
    String(currentVisit.cycle_source || '') === 'exploration_cycle'
  ) {
    return {
      gap_days: gapDays,
      minimum_gap_days: minimumGapDays,
      classification: 'exploration_repeat',
      justified: false
    }
  }
  if (
    previousVisit.minimum_preferred_bonus_applied ||
    currentVisit.minimum_preferred_bonus_applied ||
    previousVisit.shifted_within_recommended_window ||
    currentVisit.shifted_within_recommended_window
  ) {
    return {
      gap_days: gapDays,
      minimum_gap_days: minimumGapDays,
      classification: 'optimizer_artifact',
      justified: false
    }
  }
  return {
    gap_days: gapDays,
    minimum_gap_days: minimumGapDays,
    classification: 'insufficient_evidence',
    justified: false
  }
}

function ensureClientSelectionState(map, clientId) {
  const existingState = map.get(clientId)
  if (existingState) return existingState
  const nextState = {
    visits: [],
    cycleIds: new Set(),
    explorationVisitsCount: 0
  }
  map.set(clientId, nextState)
  return nextState
}

function resolveAllowedDates(opportunity = {}) {
  const earliest = String(opportunity.earliest_allowed_date || opportunity.preferred_date || opportunity.candidate_date || '')
  const latest = String(opportunity.latest_allowed_date || opportunity.preferred_date || opportunity.candidate_date || '')
  if (!earliest || !latest) return null
  return earliest <= latest
    ? { earliest, latest }
    : { earliest: latest, latest: earliest }
}

function resolveSlotShiftDays(opportunity = {}, slot = {}) {
  return Math.abs(diffDays(opportunity.preferred_date || opportunity.candidate_date, slot.date) || 0)
}

function isFlexibleForSoftBalance(opportunity = {}) {
  return ['flexible_window', 'exploration_window'].includes(String(opportunity.date_flexibility_type || ''))
}

function isObligationGradeStatus(status) {
  const normalized = String(status || '').trim()
  return normalized === 'overdue' || normalized === 'due_now'
}

function isTargetFillStatus(status) {
  return String(status || '').trim() === 'due_soon'
}

function isExplorationStatus(status, opportunity = {}) {
  return (
    String(status || '').trim() === 'exploration_needed' ||
    String(opportunity.decision_mode || '').trim() === 'exploration'
  )
}

function isNotDueStatus(status) {
  return String(status || '').trim() === 'not_due'
}

function resolveOpportunityTierPriority(opportunity = {}) {
  const portfolioStatus = String(opportunity.portfolio_status || '').trim()
  if (portfolioStatus === 'overdue') return 0
  if (portfolioStatus === 'due_now') return 1
  if (portfolioStatus === 'due_soon') return 2
  if (isExplorationStatus(portfolioStatus, opportunity)) return 3
  if (portfolioStatus === 'not_due') return 4
  return 5
}

function computeAssignmentMetrics(opportunity = {}, slot = {}, minimumVisitsPreference = 0) {
  const shiftDays = resolveSlotShiftDays(opportunity, slot)
  const baseScore = Number(opportunity.visit_opportunity_score || 0)
  const dateShiftPenaltyPerDay = Number(opportunity.date_shift_penalty_per_day || 0) || 0
  const dateShiftPenalty = shiftDays * dateShiftPenaltyPerDay
  const slotUnderMinimum = Number(minimumVisitsPreference || 0) > 0 && Number(slot.visits.length || 0) < Number(minimumVisitsPreference || 0)
  const softBalanceEligible = isFlexibleForSoftBalance(opportunity)
  const minimumGap = Math.max(0, Number(minimumVisitsPreference || 0) - Number(slot.visits.length || 0))
  const minimumPreferredBonus = slotUnderMinimum && softBalanceEligible
    ? Math.min(
      isTargetFillStatus(opportunity.portfolio_status) ? 18 : 8,
      minimumGap * (isTargetFillStatus(opportunity.portfolio_status) ? 1.6 : 0.8)
    )
    : 0
  const loadPenalty = softBalanceEligible ? Number(slot.visits.length || 0) * (isTargetFillStatus(opportunity.portfolio_status) ? 0.35 : 0.2) : 0
  const effectiveScore = roundScore(baseScore - dateShiftPenalty - loadPenalty + minimumPreferredBonus)

  return {
    shiftDays,
    slotUnderMinimum,
    minimumPreferredBonus,
    softBalanceEligible,
    effectiveScore
  }
}

function resolveHistoricalCommercialCircuitDistance(opportunity = {}, slot = {}) {
  const distancesByCommercialCode = opportunity?.commercial_circuit_distances_km
  if (!distancesByCommercialCode || typeof distancesByCommercialCode !== 'object') return null
  const distanceKm = Number(distancesByCommercialCode[String(slot?.commercial_code || '').trim()])
  return Number.isFinite(distanceKm) ? distanceKm : null
}

function matchesHistoricalCommercialContinuity(opportunity = {}, slot = {}) {
  const continuityCode = String(opportunity?.historical_commercial_continuity_code || '').trim()
  if (!continuityCode) return false
  return continuityCode === String(slot?.commercial_code || '').trim()
}

function shouldRejectLowSignalExploration(opportunity = {}, selectedSlot = {}, minimumVisitsPreference = 0) {
  if (!isLowSignalExploration(opportunity)) return false
  const selectedLowSignalCount = selectedSlot.visits.filter(visit => isLowSignalExploration(visit)).length
  const capReached = selectedLowSignalCount >= resolveLowSignalExplorationCap(selectedSlot)
  if (!capReached) return false
  if (isObligationGradeStatus(opportunity.portfolio_status)) return false
  if (isTargetFillStatus(opportunity.portfolio_status) && Number(selectedSlot.visits.length || 0) < Number(minimumVisitsPreference || 0)) {
    return false
  }
  return true
}

function compareSlotsForOpportunity(opportunity = {}, left = {}, right = {}, minimumVisitsPreference = 0) {
  const leftCircuitDistanceKm = resolveHistoricalCommercialCircuitDistance(opportunity, left)
  const rightCircuitDistanceKm = resolveHistoricalCommercialCircuitDistance(opportunity, right)
  const leftHasCircuitDistance = Number.isFinite(leftCircuitDistanceKm)
  const rightHasCircuitDistance = Number.isFinite(rightCircuitDistanceKm)

  if (leftHasCircuitDistance || rightHasCircuitDistance) {
    if (leftHasCircuitDistance !== rightHasCircuitDistance) {
      return leftHasCircuitDistance ? -1 : 1
    }
    const circuitDistanceDelta = Number(leftCircuitDistanceKm || 0) - Number(rightCircuitDistanceKm || 0)
    if (circuitDistanceDelta !== 0) return circuitDistanceDelta
  }

    const leftContinuity = matchesHistoricalCommercialContinuity(opportunity, left)
  const rightContinuity = matchesHistoricalCommercialContinuity(opportunity, right)

  if (leftContinuity !== rightContinuity) {
    return leftContinuity ? -1 : 1
  }

  const leftMetrics = computeAssignmentMetrics(opportunity, left, minimumVisitsPreference)
  const rightMetrics = computeAssignmentMetrics(opportunity, right, minimumVisitsPreference)
  const minimumPreference = Number(minimumVisitsPreference || 0)
  const leftUnderfill = Math.max(0, minimumPreference - Number(left.visits.length || 0))
  const rightUnderfill = Math.max(0, minimumPreference - Number(right.visits.length || 0))

  if (isTargetFillStatus(opportunity.portfolio_status)) {
    if (rightUnderfill !== leftUnderfill) return rightUnderfill - leftUnderfill
  }

  const scoreDelta = Number(rightMetrics.effectiveScore || 0) - Number(leftMetrics.effectiveScore || 0)
  if (scoreDelta !== 0) return scoreDelta

  if (!isTargetFillStatus(opportunity.portfolio_status) && rightUnderfill !== leftUnderfill) {
    return rightUnderfill - leftUnderfill
  }

  const currentLoadDelta = Number(left.visits.length) - Number(right.visits.length)
  if (currentLoadDelta !== 0) return currentLoadDelta
  const caGapLeft = (Number(left.min_daily_ca_target || 0) - Number(left.expected_order_value_total || 0))
  const caGapRight = (Number(right.min_daily_ca_target || 0) - Number(right.expected_order_value_total || 0))
  if (caGapLeft !== caGapRight) return caGapRight - caGapLeft
 
  return String(left.slot_id || '').localeCompare(String(right.slot_id || ''))
}

function isLowSignalExploration(opportunity = {}) {
  const baseScore = Number(opportunity.visit_opportunity_score || 0)
  const strategicScore = Number(opportunity.strategic_client_score || 0)
  const inactivityRisk = String(opportunity.inactivity_risk || '').trim().toLowerCase()
  return Boolean(
    !opportunity.purchase_prediction_known &&
    !opportunity.max_days_without_contact_guardrail &&
    String(opportunity.date_flexibility_type || '') === 'exploration_window' &&
    baseScore < 8 &&
    strategicScore < 55 &&
    inactivityRisk !== 'high'
  )
}

function resolveLowSignalExplorationCap(slot = {}) {
  const maxVisits = Number(slot.max_visits || 0)
  if (!Number.isFinite(maxVisits) || maxVisits <= 0) return 1
  return Math.max(1, Math.min(2, Math.floor(maxVisits / 20) + 1))
}

function buildDeferredReasonPriority(reasonCodes = []) {
  const priorityByCode = {
    EXPLICIT_UNAVAILABLE: 500,
    LOW_CONFIDENCE: 400,
    CAPACITY_REACHED: 300,
    LOW_EFFECTIVE_SCORE: 250,
    LOW_PURCHASE_PROBABILITY: 200,
    RECENT_PURCHASE_DEPRIORITIZED: 100
  }
  return (Array.isArray(reasonCodes) ? reasonCodes : []).reduce(
    (maxPriority, code) => Math.max(maxPriority, Number(priorityByCode[String(code || '').trim()] || 0)),
    0
  )
}

function shouldReplaceDeferredEntry(existingEntry, nextReasonCodes = []) {
  if (!existingEntry) return true
  return buildDeferredReasonPriority(nextReasonCodes) >= buildDeferredReasonPriority(existingEntry.explanation_codes)
}

function assignVisitOpportunities({
  opportunities = [],
  slots = [],
  options = {}
}) {
  const {
    respectAvailability = 'flexible',
    minimumConfidence = 0,
    minimumVisitsPreference = 0
  } = options
  const sortedOpportunities = [...(Array.isArray(opportunities) ? opportunities : [])].sort(buildScoreComparator)
  const slotsById = new Map((Array.isArray(slots) ? slots : []).map(slot => [slot.slot_id, slot]))
  const slotIdsByDate = new Map()
  const selectedStateByClientId = new Map()
  const deferredByClientId = new Map()
  const rejectedOpportunities = []
  const warningCodes = new Set()
  const warnings = []
  const assignmentDiagnostics = {
    minimum_preferred_bonus_applied_count: 0,
    visits_shifted_for_soft_balance_count: 0,
    total_date_shift_days: 0,
    maximum_date_shift_days: 0,
    fixed_opportunities_shifted_count: 0,
    strong_opportunities_shifted_count: 0,
    exploration_repeat_prevented_count: 0,
    duplicate_cycle_selection_prevented_count: 0
  }

  function recordClientRejection(opportunity, deferredReasonCodes = []) {
    const deferredClient = buildDeferredClientExplanation({
      client: opportunity,
      deferredReasonCodes,
      bestFutureDate: opportunity.next_purchase_date_estimate || null
    })
    rejectedOpportunities.push({
      client_id: String(opportunity?.client_id || ''),
      client_code: String(opportunity?.client_code || ''),
      candidate_date: String(opportunity?.candidate_date || ''),
      visit_opportunity_id: String(opportunity?.visit_opportunity_id || ''),
      rejection_reason_codes: [...(deferredClient.explanation_codes || [])],
      rejection_reasons: [...(deferredClient.explanation_reasons || [])]
    })
    if (shouldReplaceDeferredEntry(deferredByClientId.get(String(opportunity?.client_id || '')), deferredClient.explanation_codes)) {
      deferredByClientId.set(String(opportunity?.client_id || ''), deferredClient)
    }
  }

  ;(Array.isArray(slots) ? slots : []).forEach(slot => {
    const dateSlots = slotIdsByDate.get(slot.date) || []
    dateSlots.push(slot.slot_id)
    slotIdsByDate.set(slot.date, dateSlots)
  })

  sortedOpportunities.forEach(opportunity => {
    const clientId = String(opportunity.client_id || '')
    const confidence = Number(opportunity.confidence || 0)
    const clientState = ensureClientSelectionState(selectedStateByClientId, clientId)
    const allowedDates = resolveAllowedDates(opportunity)
    const personalizedMinimumGapDays = resolveMinimumGapDays(opportunity)
    opportunity.personalized_minimum_gap_days = personalizedMinimumGapDays
    const selectedCycleAlreadyExists = String(opportunity.visit_cycle_id || '') && clientState.cycleIds.has(String(opportunity.visit_cycle_id || ''))
    const explorationRepeatBlocked = String(opportunity.cycle_source || '') === 'exploration_cycle' && clientState.explorationVisitsCount >= 1

    if (respectAvailability === 'strict' && opportunity.availability_status === 'explicit_unavailable') {
      recordClientRejection(opportunity, ['EXPLICIT_UNAVAILABLE'])
      return
    }

    if (confidence < Number(minimumConfidence || 0)) {
      recordClientRejection(opportunity, ['LOW_CONFIDENCE'])
      return
    }

    if (selectedCycleAlreadyExists) {
      assignmentDiagnostics.duplicate_cycle_selection_prevented_count += 1
      recordClientRejection(opportunity, ['RECENT_PURCHASE_DEPRIORITIZED'])
      return
    }

    if (explorationRepeatBlocked) {
      assignmentDiagnostics.exploration_repeat_prevented_count += 1
      recordClientRejection(opportunity, ['LOW_EFFECTIVE_SCORE'])
      return
    }

    if (isNotDueStatus(opportunity.portfolio_status)) {
      recordClientRejection(opportunity, ['LOW_EFFECTIVE_SCORE'])
      return
    }

    const preliminarilyCompatibleSlots = [...slotsById.values()].filter(slot => {
      if (!slot) return false
      if (slot.visits.length >= Number(slot.max_visits || 0)) return false
      if (!(opportunity.possible_commercial_codes || []).includes(slot.commercial_code)) return false
      if (!allowedDates && slot.date !== String(opportunity.candidate_date || '')) return false
      if (allowedDates && (slot.date < allowedDates.earliest || slot.date > allowedDates.latest)) return false
      return true
    })
    const sameDayBlocked = preliminarilyCompatibleSlots.some(slot => (
      clientState.visits.some(visit => String(visit.assigned_date || visit.candidate_date || '') === String(slot.date || ''))
    ))
    const gapBlocked = preliminarilyCompatibleSlots.some(slot => {
      const nearestGap = computeClientGapDays(clientState.visits, slot.date)
      return (
        nearestGap != null &&
        nearestGap >= 0 &&
        nearestGap < personalizedMinimumGapDays &&
        !opportunity.max_days_without_contact_guardrail
      )
    })
    const compatibleSlotIds = preliminarilyCompatibleSlots
      .filter(slot => {
        if (clientState.visits.some(visit => String(visit.assigned_date || visit.candidate_date || '') === String(slot.date || ''))) return false
        const nearestGap = computeClientGapDays(clientState.visits, slot.date)
        if (
          nearestGap != null &&
          nearestGap >= 0 &&
          nearestGap < personalizedMinimumGapDays &&
          !opportunity.max_days_without_contact_guardrail
        ) {
          return false
        }
        return true
      })
      .map(slot => slot.slot_id)

    if (!compatibleSlotIds.length) {
      const deferredReasonCodes = []
      const recentPurchasePenalized = Array.isArray(opportunity.explanation_codes) &&
        opportunity.explanation_codes.includes('RECENT_PURCHASE_DEPRIORITIZED')
      if (recentPurchasePenalized) {
        deferredReasonCodes.push('RECENT_PURCHASE_DEPRIORITIZED')
      }
      if (Number.isFinite(Number(opportunity.days_since_last_purchase)) && Number(opportunity.days_since_last_purchase) <= 1 && !opportunity.max_days_without_contact_guardrail) {
        deferredReasonCodes.push('RECENT_PURCHASE_DEPRIORITIZED')
      }
      if (Number.isFinite(Number(opportunity.purchase_probability)) && Number(opportunity.purchase_probability) < 25) {
        deferredReasonCodes.push('LOW_PURCHASE_PROBABILITY')
      }
      if (sameDayBlocked || gapBlocked) {
        deferredReasonCodes.push('RECENT_PURCHASE_DEPRIORITIZED')
      }
      if (!deferredReasonCodes.length) {
        deferredReasonCodes.push('CAPACITY_REACHED')
      }
      recordClientRejection(opportunity, [...new Set(deferredReasonCodes)])
      return
    }

    const selectedSlot = compatibleSlotIds
      .map(slotId => slotsById.get(slotId))
      .sort((left, right) => compareSlotsForOpportunity(opportunity, left, right, minimumVisitsPreference))[0]
    const selectedSlotMetrics = computeAssignmentMetrics(opportunity, selectedSlot, minimumVisitsPreference)
    const selectedCircuitDistanceKm = resolveHistoricalCommercialCircuitDistance(opportunity, selectedSlot)
    const historicalCommercialContinuity = matchesHistoricalCommercialContinuity(opportunity, selectedSlot)

    if (shouldRejectLowSignalExploration(opportunity, selectedSlot, minimumVisitsPreference)) {
      recordClientRejection(opportunity, ['LOW_EFFECTIVE_SCORE'])
      return
    }

    const explained = buildSelectedVisitExplanation(opportunity)
    const assignedVisit = {
      ...opportunity,
      candidate_date: selectedSlot.date,
      assigned_date: selectedSlot.date,
      assigned_slot_id: selectedSlot.slot_id,
      date_shift_days: selectedSlotMetrics.shiftDays,
      minimum_preferred_bonus_applied: selectedSlotMetrics.minimumPreferredBonus > 0,
      assignment_effective_score: selectedSlotMetrics.effectiveScore,
      shifted_within_recommended_window: selectedSlot.date !== String(opportunity.preferred_date || opportunity.candidate_date || ''),
      commercial_code: selectedSlot.commercial_code,
      commercial_label: selectedSlot.commercial_label,
      circuit_distance_km: Number.isFinite(selectedCircuitDistanceKm) ? roundScore(selectedCircuitDistanceKm) : null,
      circuit_assignment_source: Number.isFinite(selectedCircuitDistanceKm) ? 'historical_commercial_circuit' : null,
      historical_commercial_continuity: historicalCommercialContinuity,
      explanation_codes: explained.explanation_codes,
      explanation_reasons: explained.explanation_reasons
    }
    selectedSlot.visits.push(assignedVisit)
    selectedSlot.expected_order_value_total += Number(assignedVisit.expected_order_value || 0) || 0
    clientState.visits.push(assignedVisit)
    clientState.cycleIds.add(String(assignedVisit.visit_cycle_id || ''))
    if (String(assignedVisit.cycle_source || '') === 'exploration_cycle') {
      clientState.explorationVisitsCount += 1
    }
    assignmentDiagnostics.total_date_shift_days += Number(selectedSlotMetrics.shiftDays || 0)
    assignmentDiagnostics.maximum_date_shift_days = Math.max(
      Number(assignmentDiagnostics.maximum_date_shift_days || 0),
      Number(selectedSlotMetrics.shiftDays || 0)
    )
    if (selectedSlotMetrics.minimumPreferredBonus > 0) {
      assignmentDiagnostics.minimum_preferred_bonus_applied_count += 1
    }
    if (selectedSlot.date !== String(opportunity.preferred_date || opportunity.candidate_date || '')) {
      assignmentDiagnostics.visits_shifted_for_soft_balance_count += 1
      if (String(opportunity.date_flexibility_type || '') === 'fixed') {
        assignmentDiagnostics.fixed_opportunities_shifted_count += 1
      }
      if (Number(opportunity.visit_opportunity_score || 0) >= 80) {
        assignmentDiagnostics.strong_opportunities_shifted_count += 1
      }
    }
    if (respectAvailability !== 'strict' && opportunity.availability_status === 'explicit_unavailable') {
      warningCodes.add('FLEXIBLE_EXPLICIT_UNAVAILABLE_SELECTED')
      warnings.push(`${selectedSlot.commercial_label} ${selectedSlot.date}: indisponibilite explicite ignoree en mode flexible`)
    }
  })

  if (Number(minimumVisitsPreference || 0) > 0) {
    ;(Array.isArray(slots) ? slots : []).forEach(slot => {
      slot.minimum_visits_preference_unmet = slot.visits.length < Number(minimumVisitsPreference || 0)
    })
  }

  const blocks = (Array.isArray(slots) ? slots : [])
    .map(slot => {
      const visits = [...slot.visits].sort(buildScoreComparator)
      return {
        slot_id: slot.slot_id,
        date: slot.date,
        commercial_code: slot.commercial_code,
        commercial_label: slot.commercial_label,
        clients_count: visits.length,
        minimum_preferred: Number(minimumVisitsPreference || 0),
        maximum_allowed: Number(slot.max_visits || 0),
        minimum_preferred_bonus_applied_count: visits.filter(visit => visit.minimum_preferred_bonus_applied).length,
        predicted_order_value_total: roundScore(visits.reduce((sum, visit) => sum + (Number(visit.expected_order_value || 0) || 0), 0)),
        predicted_ca: roundScore(visits.reduce((sum, visit) => sum + (Number(visit.predicted_ca || 0) || 0), 0)),
        recommended_quantity_total: roundScore(visits.reduce((sum, visit) => sum + (Number(visit.recommended_quantity || 0) || 0), 0)),
        purchase_prediction_known_count: visits.filter(visit => visit.purchase_prediction_known).length,
        purchase_prediction_unknown_count: visits.filter(visit => !visit.purchase_prediction_known).length,
        purchase_prediction_completeness: visits.every(visit => visit.purchase_prediction_known),
        min_daily_ca_target: slot.min_daily_ca_target,
        min_daily_ca_status: slot.min_daily_ca_target == null
          ? 'unknown'
          : slot.expected_order_value_total >= slot.min_daily_ca_target
            ? 'reached'
            : 'not_reached',
        estimated_distance_km: null,
        estimated_duration_minutes: null,
        total_estimated_minutes: null,
        workday_limit_known: Boolean(slot.max_route_minutes),
        exceeds_workday: false,
        time: {
          route_minutes_without_break: null,
          route_minutes_total: null,
          break_minutes: slot.break_minutes || 0,
          max_route_minutes: slot.max_route_minutes || null,
          service_minutes_total: null,
          service_minutes_known_count: 0
        },
        clients: visits
      }
    })
    .filter(block => block.clients_count > 0)

  const minimumPreferenceWarnings = (Array.isArray(slots) ? slots : [])
    .filter(slot => slot.minimum_visits_preference_unmet)
    .map(slot => `${slot.commercial_label} ${slot.date}: minimum prefere non atteint`)
  if (minimumPreferenceWarnings.length) {
    warningCodes.add('MINIMUM_VISITS_PREFERENCE_UNMET')
  }

  const selectedClientIds = new Set(
    [...selectedStateByClientId.entries()]
      .filter(([, state]) => Array.isArray(state?.visits) && state.visits.length > 0)
      .map(([clientId]) => clientId)
  )
  const repeatedClientVisitStats = [...selectedStateByClientId.values()]
    .map(state => [...state.visits].sort((left, right) => String(left.assigned_date || '').localeCompare(String(right.assigned_date || ''))))
  const repeatedClientsCount = repeatedClientVisitStats.filter(visits => visits.length > 1).length
  const repeatedVisitsCount = repeatedClientVisitStats.reduce((sum, visits) => sum + Math.max(0, visits.length - 1), 0)
  const repeatPairs = repeatedClientVisitStats.flatMap(visits => visits.slice(1).map((visit, index) => classifyRepeatPair(visits[index], visit)))
  const observedGaps = repeatPairs.map(item => item.gap_days).filter(Number.isFinite)
  const minimumObservedGapDays = observedGaps.length ? Math.min(...observedGaps) : null
  const oneDayGapCount = repeatPairs.filter(item => Number(item.gap_days) === 1).length
  const justifiedOneDayGapCount = repeatPairs.filter(item => Number(item.gap_days) === 1 && item.justified).length
  const unjustifiedOneDayGapCount = repeatPairs.filter(item => Number(item.gap_days) === 1 && !item.justified).length
  const duplicateCycleSelectionCount = repeatPairs.filter(item => item.classification === 'duplicate_same_cycle').length
  const suspiciousRepeatCount = repeatPairs.filter(item => !item.justified).length
  const repeatClassificationCounts = repeatPairs.reduce((accumulator, item) => {
    const key = String(item.classification || 'insufficient_evidence')
    accumulator[key] = Number(accumulator[key] || 0) + 1
    return accumulator
  }, {})
  const explorationVisitsPerClient = [...selectedStateByClientId.entries()].reduce((accumulator, [clientId, state]) => {
    if (Number(state.explorationVisitsCount || 0) > 0) {
      accumulator[clientId] = Number(state.explorationVisitsCount || 0)
    }
    return accumulator
  }, {})
  const rejectedOpportunitiesBySelectedClient = new Map()
  rejectedOpportunities.forEach(rejection => {
    const rejectionClientId = String(rejection.client_id || '')
    if (!selectedClientIds.has(rejectionClientId)) return
    const aggregate = rejectedOpportunitiesBySelectedClient.get(rejectionClientId) || {
      client_id: rejectionClientId,
      client_code: String(rejection.client_code || ''),
      rejected_opportunities_count: 0,
      rejection_reason_codes: new Set()
    }
    aggregate.rejected_opportunities_count += 1
    ;(Array.isArray(rejection.rejection_reason_codes) ? rejection.rejection_reason_codes : []).forEach(code => {
      aggregate.rejection_reason_codes.add(String(code || '').trim())
    })
    rejectedOpportunitiesBySelectedClient.set(rejectionClientId, aggregate)
  })

  return {
    blocks,
    deferred_clients: [...deferredByClientId.entries()]
      .filter(([clientId]) => !selectedClientIds.has(clientId))
      .map(([, value]) => value),
    selected_visits_count: blocks.reduce((sum, block) => sum + Number(block.clients_count || 0), 0),
    minimum_preferred_bonus_applied_count: assignmentDiagnostics.minimum_preferred_bonus_applied_count,
    visits_shifted_for_soft_balance_count: assignmentDiagnostics.visits_shifted_for_soft_balance_count,
    average_date_shift_days: blocks.reduce((sum, block) => sum + (Array.isArray(block.clients) ? block.clients.length : 0), 0) > 0
      ? roundScore(assignmentDiagnostics.total_date_shift_days / blocks.reduce((sum, block) => sum + (Array.isArray(block.clients) ? block.clients.length : 0), 0))
      : 0,
    maximum_date_shift_days: assignmentDiagnostics.maximum_date_shift_days,
    fixed_opportunities_shifted_count: assignmentDiagnostics.fixed_opportunities_shifted_count,
    strong_opportunities_shifted_count: assignmentDiagnostics.strong_opportunities_shifted_count,
    repeated_clients_count: repeatedClientsCount,
    repeated_visits_count: repeatedVisitsCount,
    minimum_observed_gap_days: minimumObservedGapDays,
    one_day_gap_count: oneDayGapCount,
    justified_one_day_gap_count: justifiedOneDayGapCount,
    unjustified_one_day_gap_count: unjustifiedOneDayGapCount,
    duplicate_cycle_selection_count: duplicateCycleSelectionCount,
    suspicious_repeat_count: suspiciousRepeatCount,
    repeat_classification_counts: repeatClassificationCounts,
    exploration_visits_per_client: explorationVisitsPerClient,
    exploration_repeat_prevented_count: assignmentDiagnostics.exploration_repeat_prevented_count,
    duplicate_cycle_selection_prevented_count: assignmentDiagnostics.duplicate_cycle_selection_prevented_count,
    rejected_opportunities: rejectedOpportunities,
    rejected_opportunities_count: rejectedOpportunities.length,
    rejected_opportunities_by_selected_client: [...rejectedOpportunitiesBySelectedClient.values()].map(item => ({
      client_id: item.client_id,
      client_code: item.client_code,
      rejected_opportunities_count: item.rejected_opportunities_count,
      rejection_reason_codes: [...item.rejection_reason_codes].filter(Boolean).sort()
    })),
    warnings: [...warnings, ...minimumPreferenceWarnings],
    warning_codes: [...warningCodes]
  }
}

module.exports = {
  assignVisitOpportunities,
  buildCommercialSlots
}

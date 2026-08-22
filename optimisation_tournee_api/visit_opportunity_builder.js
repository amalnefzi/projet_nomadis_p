const crypto = require('node:crypto')

const {
  addDays,
  diffDays,
  normalizeDateOnly,
  parseDate
} = require('./client_cadence_intelligence')

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function roundScore(value) {
  return Math.round(Number(value || 0) * 10) / 10
}

function toOptionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function buildPlanningDates(startDate, planningHorizonDays) {
  const start = parseDate(startDate)
  if (!start) return []
  const totalDays = Math.max(1, Number.parseInt(planningHorizonDays, 10) || 14)
  const dates = []
  for (let index = 0; index < totalDays; index += 1) {
    const nextDate = new Date(start.getTime())
    nextDate.setUTCDate(nextDate.getUTCDate() + index)
    dates.push(nextDate.toISOString().slice(0, 10))
  }
  return dates
}

function buildPlanningDateIndexMap(planningDates = []) {
  return new Map((Array.isArray(planningDates) ? planningDates : []).map((date, index) => [date, index]))
}

function weekdayIndex(dateValue) {
  const date = parseDate(dateValue)
  return date ? date.getUTCDay() : null
}

function buildOpportunityId(clientId, candidateDate) {
  return crypto
    .createHash('sha1')
    .update(`${String(clientId || '')}::${String(candidateDate || '')}`)
    .digest('hex')
    .slice(0, 16)
}

function buildVisitCycleId({
  clientId,
  clientCode,
  cycleSource,
  cycleSequenceNumber,
  cycleWindowStart,
  cycleWindowEnd,
  cyclePreferredDate
} = {}) {
  return crypto
    .createHash('sha1')
    .update([
      String(clientId || ''),
      String(clientCode || ''),
      String(cycleSource || ''),
      String(cycleSequenceNumber || ''),
      String(cycleWindowStart || ''),
      String(cycleWindowEnd || ''),
      String(cyclePreferredDate || '')
    ].join('::'))
    .digest('hex')
    .slice(0, 20)
}

function buildDeterministicSeed(value) {
  const digest = crypto
    .createHash('sha1')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 8)
  return Number.parseInt(digest, 16) || 0
}

function getPlanningDateInRange(planningDates = [], startDate, endDate, pick = 'first') {
  const normalizedStart = normalizeDateOnly(startDate)
  const normalizedEnd = normalizeDateOnly(endDate)
  if (!normalizedStart || !normalizedEnd) return null
  const candidates = planningDates.filter(date => date >= normalizedStart && date <= normalizedEnd)
  if (!candidates.length) return null
  return pick === 'last' ? candidates[candidates.length - 1] : candidates[0]
}

function clampDateToPlanning(dateValue, planningDates = []) {
  const normalizedDate = normalizeDateOnly(dateValue)
  if (!normalizedDate || !planningDates.length) return null
  if (planningDates.includes(normalizedDate)) return normalizedDate
  if (normalizedDate < planningDates[0]) return planningDates[0]
  if (normalizedDate > planningDates[planningDates.length - 1]) return planningDates[planningDates.length - 1]
  const fallback = planningDates.find(date => date >= normalizedDate)
  return fallback || planningDates[planningDates.length - 1] || null
}

function buildPlanningDateWindow(planningDates = [], centerIndex = 0, radius = 1) {
  if (!planningDates.length) return { preferredDate: null, earliestAllowedDate: null, latestAllowedDate: null }
  const boundedIndex = clamp(centerIndex, 0, planningDates.length - 1)
  return {
    preferredDate: planningDates[boundedIndex],
    earliestAllowedDate: planningDates[Math.max(0, boundedIndex - radius)],
    latestAllowedDate: planningDates[Math.min(planningDates.length - 1, boundedIndex + radius)]
  }
}

function buildClientMetadataFingerprint(profile = {}, clientMetadata = {}, startDate = '') {
  return [
    String(profile.client_id || ''),
    String(profile.client_code || clientMetadata.client_code || ''),
    String(clientMetadata.commercial_zone || ''),
    String(clientMetadata.delegation || ''),
    String(clientMetadata.user_code || clientMetadata.resolved_commercial_code || ''),
    String(clientMetadata.routing_code || ''),
    String(startDate || '')
  ].join('::')
}

function deriveHybridFallbackAnchor(profile = {}, planningDates = [], clientMetadata = {}) {
  if (!planningDates.length) return null
  const horizonLastIndex = planningDates.length - 1
  const interval = Math.max(1, Number(profile.recommended_visit_interval_days || 0) || 21)
  const lastPurchaseAge = toOptionalFiniteNumber(profile.days_since_last_purchase)
  const inactivityRisk = String(profile.inactivity_risk || '').trim().toLowerCase()
  const dueInDays = lastPurchaseAge != null
    ? clamp(interval - lastPurchaseAge, 0, horizonLastIndex)
    : null
  const zoneSeed = buildDeterministicSeed(buildClientMetadataFingerprint(profile, clientMetadata, planningDates[0]))
  const zoneOffset = (zoneSeed % 3) - 1
  const riskBias = inactivityRisk === 'high'
    ? 0
    : inactivityRisk === 'medium'
      ? Math.floor(horizonLastIndex * 0.2)
      : Math.floor(horizonLastIndex * 0.4)
  const anchorIndex = dueInDays != null
    ? clamp(Math.round(dueInDays) + zoneOffset, 0, horizonLastIndex)
    : clamp(riskBias + zoneOffset, 0, horizonLastIndex)
  return planningDates[anchorIndex]
}

function deriveExplorationWindow(profile = {}, planningDates = [], clientMetadata = {}) {
  if (!planningDates.length) {
    return {
      preferredDate: null,
      earliestAllowedDate: null,
      latestAllowedDate: null
    }
  }
  const horizonLastIndex = planningDates.length - 1
  const zoneKey = [
    clientMetadata.commercial_zone,
    clientMetadata.delegation,
    clientMetadata.user_code,
    clientMetadata.routing_code,
    clientMetadata.region
  ].filter(Boolean).join('::') || 'unscoped'
  const zoneBaseIndex = buildDeterministicSeed(`${zoneKey}::${planningDates[0]}`) % (horizonLastIndex + 1)
  const clientOffset = (buildDeterministicSeed(buildClientMetadataFingerprint(profile, clientMetadata, planningDates[0])) % 5) - 2
  const centerIndex = clamp(zoneBaseIndex + clientOffset, 0, horizonLastIndex)
  const radius = planningDates.length >= 7 ? 1 : 0
  return buildPlanningDateWindow(planningDates, centerIndex, radius)
}

function buildCycleMetadata(entry = {}) {
  const cycleSource = String(entry.cycle_source || 'cadence_cycle')
  const cycleWindowStart = normalizeDateOnly(entry.cycle_window_start || entry.earliestAllowedDate || entry.preferredDate || entry.candidate_date)
  const cycleWindowEnd = normalizeDateOnly(entry.cycle_window_end || entry.latestAllowedDate || entry.preferredDate || entry.candidate_date)
  const cyclePreferredDate = normalizeDateOnly(entry.cycle_preferred_date || entry.preferredDate || entry.candidate_date)
  const repeatJustificationCode = String(entry.repeat_justification_code || '').trim() || null
  const cycleSequenceNumber = Number.isFinite(Number(entry.cycle_sequence_number))
    ? Number(entry.cycle_sequence_number)
    : 1
  return {
    cycle_source: cycleSource,
    cycle_window_start: cycleWindowStart,
    cycle_window_end: cycleWindowEnd,
    cycle_preferred_date: cyclePreferredDate,
    cycle_confidence: Number.isFinite(Number(entry.cycle_confidence))
      ? roundScore(entry.cycle_confidence)
      : null,
    cycle_sequence_number: cycleSequenceNumber,
    repeat_justification_code: repeatJustificationCode,
    visit_cycle_id: String(entry.visit_cycle_id || buildVisitCycleId({
      clientId: entry.client_id,
      clientCode: entry.client_code,
      cycleSource,
      cycleSequenceNumber,
      cycleWindowStart,
      cycleWindowEnd,
      cyclePreferredDate
    }))
  }
}

function finalizeDateEntry(entry = {}, planningDates = []) {
  const planningDateSet = new Set(planningDates)
  const preferredDate = clampDateToPlanning(entry.preferredDate || entry.candidate_date, planningDates)
  const earliestAllowedDate = clampDateToPlanning(entry.earliestAllowedDate || preferredDate, planningDates)
  const latestAllowedDate = clampDateToPlanning(entry.latestAllowedDate || preferredDate, planningDates)
  if (!preferredDate || !earliestAllowedDate || !latestAllowedDate) return null
  if (!planningDateSet.has(preferredDate)) return null
  const earliest = earliestAllowedDate <= latestAllowedDate ? earliestAllowedDate : latestAllowedDate
  const latest = latestAllowedDate >= earliestAllowedDate ? latestAllowedDate : earliestAllowedDate
  if (preferredDate < earliest || preferredDate > latest) return null
  const cycleMetadata = buildCycleMetadata({
    ...entry,
    preferredDate,
    earliestAllowedDate: earliest,
    latestAllowedDate: latest
  })
  return {
    candidate_date: preferredDate,
    preferred_date: preferredDate,
    earliest_allowed_date: earliest,
    latest_allowed_date: latest,
    date_flexibility_type: String(entry.date_flexibility_type || 'fixed'),
    candidate_date_source: String(entry.candidate_date_source || 'purchase_cadence'),
    date_confidence: Number.isFinite(Number(entry.date_confidence)) ? roundScore(entry.date_confidence) : null,
    date_shift_penalty_per_day: Number.isFinite(Number(entry.date_shift_penalty_per_day))
      ? roundScore(entry.date_shift_penalty_per_day)
      : null,
    ...cycleMetadata
  }
}

function pushUniqueDateEntry(entries = [], nextEntry = null) {
  if (!nextEntry) return
  const entryKey = [
    nextEntry.candidate_date,
    nextEntry.earliest_allowed_date,
    nextEntry.latest_allowed_date,
    nextEntry.date_flexibility_type,
    nextEntry.candidate_date_source
  ].join('::')
  if (entries.some(entry => [
    entry.candidate_date,
    entry.earliest_allowed_date,
    entry.latest_allowed_date,
    entry.date_flexibility_type,
    entry.candidate_date_source
  ].join('::') === entryKey)) {
    return
  }
  entries.push(nextEntry)
}

function buildCadenceDueScore(profile = {}, candidateDate) {
  const daysUntilEstimate = diffDays(candidateDate, profile.next_purchase_date_estimate)
  const daysSinceLastPurchase = profile.days_since_last_purchase
  const interval = Number(profile.recommended_visit_interval_days || 0)

  if (profile.last_purchase_date && Number.isFinite(daysSinceLastPurchase) && daysSinceLastPurchase <= 1) {
    return 2
  }

  if (Number.isFinite(daysUntilEstimate)) {
    const score = 100 - Math.min(100, Math.abs(daysUntilEstimate) * 18)
    return roundScore(clamp(score, 5, 100))
  }

  if (Number.isFinite(interval) && Number.isFinite(daysSinceLastPurchase)) {
    const ratio = interval > 0 ? daysSinceLastPurchase / interval : 0
    return roundScore(clamp(ratio * 65, 5, 90))
  }

  return 20
}

function buildStrategicClientScore(client = {}, profile = {}) {
  const potentiel = Number(client.potentiel)
  const avgValue = Number(profile.usual_order_value)
  const valueScore = Number.isFinite(avgValue) ? clamp((avgValue / 600) * 100, 0, 100) : null
  if (Number.isFinite(potentiel) && potentiel > 0 && valueScore != null) {
    return roundScore(clamp((potentiel + valueScore) / 2, 0, 100))
  }
  if (Number.isFinite(potentiel) && potentiel > 0) return roundScore(clamp(potentiel, 0, 100))
  if (valueScore != null) return roundScore(valueScore)
  return null
}

function resolveDecisionMode(profile = {}) {
  const purchaseCount = Number(profile.purchase_count || 0)
  const historyDepth = Number(profile.history_depth || 0)
  const confidence = Number(profile.cadence_confidence || 0)
  if (purchaseCount <= 0 && historyDepth <= 0) return 'exploration'
  if (purchaseCount < 3 || confidence < 0.6) return 'hybrid'
  return 'predictive'
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const values = [lat1, lon1, lat2, lon2].map(Number)
  if (values.some(value => !Number.isFinite(value))) return null
  const [aLat, aLon, bLat, bLon] = values.map(value => value * (Math.PI / 180))
  const dLat = bLat - aLat
  const dLon = bLon - aLon
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat) * Math.cos(bLat) * (Math.sin(dLon / 2) ** 2)
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function normalizeZoneMetadata(client = {}) {
  const explicitCommercialZone = String(
    client.commercial_zone ||
    client.commercia_zone ||
    ''
  ).trim()
  const delegation = String(client.delegation || '').trim()
  const userCode = String(
    client.user_code ||
    client.commercial_code ||
    client.resolved_commercial_code ||
    ''
  ).trim()
  const routingCode = String(client.routing_code || client.route_code || '').trim()
  const region = String(client.region || '').trim()

  if (explicitCommercialZone) {
    return {
      user_code: userCode || null,
      delegation: delegation || null,
      region: region || null,
      routing_code: routingCode || null,
      commercial_zone: explicitCommercialZone,
      zone_source: 'commercial_zone',
      zone_resolution_status: 'zone_resolved'
    }
  }

  if (delegation || userCode) {
    return {
      user_code: userCode || null,
      delegation: delegation || null,
      region: region || null,
      routing_code: routingCode || null,
      commercial_zone: null,
      zone_source: 'delegation_user_code',
      zone_resolution_status: 'zone_resolved'
    }
  }

  if (routingCode) {
    return {
      user_code: userCode || null,
      delegation: delegation || null,
      region: region || null,
      routing_code: routingCode,
      commercial_zone: null,
      zone_source: 'routing_code',
      zone_resolution_status: 'zone_resolved'
    }
  }

  if (region) {
    return {
      user_code: userCode || null,
      delegation: delegation || null,
      region,
      routing_code: routingCode || null,
      commercial_zone: null,
      zone_source: 'region',
      zone_resolution_status: 'zone_resolved'
    }
  }

  return {
    user_code: userCode || null,
    delegation: delegation || null,
    region: region || null,
    routing_code: routingCode || null,
    commercial_zone: null,
    zone_source: 'missing',
    zone_resolution_status: 'zone_source_missing'
  }
}

function buildSparseCandidateDateEntries(profile = {}, options = {}) {
  const {
    startDate,
    planningHorizonDays,
    maxCandidateDatesPerClient = 4,
    maxDaysWithoutContact = null,
    planningDates: providedPlanningDates = null,
    clientMetadata = {},
    explorationWindowOverride = null
  } = options
  const planningDates = Array.isArray(providedPlanningDates) && providedPlanningDates.length
    ? providedPlanningDates
    : buildPlanningDates(startDate, planningHorizonDays)
  const planningDateSet = new Set(planningDates)
  const planningDateIndex = buildPlanningDateIndexMap(planningDates)
  const entries = []
  const interval = Math.max(1, Number(profile.recommended_visit_interval_days || 0) || 21)
  const usualWeekdays = Array.isArray(profile.usual_purchase_weekdays) ? profile.usual_purchase_weekdays : []
  const lastPurchaseAge = toOptionalFiniteNumber(profile.days_since_last_purchase)
  const cadenceConfidence = clamp((toOptionalFiniteNumber(profile.cadence_confidence) ?? 0.18) * 100, 0, 100)
  const decisionMode = resolveDecisionMode(profile)
  const windowConfidence = decisionMode === 'predictive'
    ? cadenceConfidence
    : decisionMode === 'hybrid'
      ? Math.min(cadenceConfidence, 55)
      : Math.min(cadenceConfidence, 35)

  if (Number.isFinite(lastPurchaseAge) && lastPurchaseAge <= 1 && !profile.next_purchase_window_start) {
    if (Number.isFinite(Number(maxDaysWithoutContact)) && Number(maxDaysWithoutContact) > 0) {
      const safeguardDate = addDays(profile.last_contact_date || startDate, Number(maxDaysWithoutContact))
      if (safeguardDate && planningDateSet.has(safeguardDate)) {
        pushUniqueDateEntry(entries, finalizeDateEntry({
          client_id: profile.client_id,
          client_code: profile.client_code,
          candidate_date: safeguardDate,
          preferredDate: safeguardDate,
          earliestAllowedDate: safeguardDate,
          latestAllowedDate: safeguardDate,
          date_flexibility_type: 'fixed',
          candidate_date_source: 'max_days_without_contact',
          date_confidence: Math.min(60, windowConfidence),
          date_shift_penalty_per_day: 12,
          cycle_source: 'max_days_without_contact_cycle',
          cycle_sequence_number: 1,
          cycle_window_start: safeguardDate,
          cycle_window_end: safeguardDate,
          cycle_preferred_date: safeguardDate,
          cycle_confidence: Math.min(60, windowConfidence),
          repeat_justification_code: 'distinct_guardrail_cycle'
        }, planningDates))
      }
    }
    return entries.slice(0, maxCandidateDatesPerClient)
  }

  let cursor = profile.next_purchase_window_start ||
    profile.next_purchase_date_estimate ||
    (decisionMode === 'hybrid'
      ? deriveHybridFallbackAnchor(profile, planningDates, clientMetadata)
      : null)
  const baseWindowSpanDays = Math.max(0, diffDays(
    profile.next_purchase_window_start || profile.next_purchase_date_estimate,
    profile.next_purchase_window_end || profile.next_purchase_date_estimate
  ) || 0)
  let loops = 0
  while (cursor && loops < 12 && entries.length < maxCandidateDatesPerClient) {
    const cycleStart = normalizeDateOnly(cursor) || normalizeDateOnly(profile.next_purchase_window_start)
    const cyclePreferred = cycleStart || normalizeDateOnly(profile.next_purchase_date_estimate)
    const cycleEnd = addDays(cyclePreferred, baseWindowSpanDays) || cyclePreferred
    const windowPlanningDates = planningDates.filter(date => (
      date >= String(cycleStart || cyclePreferred || '') &&
      date <= String(cycleEnd || cyclePreferred || '')
    ))
    const effectivePreferred = (() => {
      if (
        cyclePreferred &&
        windowPlanningDates.includes(cyclePreferred) &&
        (!usualWeekdays.length || usualWeekdays.includes(weekdayIndex(cyclePreferred)))
      ) {
        return cyclePreferred
      }
      if (usualWeekdays.length) {
        const weekdayAlignedDate = windowPlanningDates.find(date => usualWeekdays.includes(weekdayIndex(date)))
        if (weekdayAlignedDate) return weekdayAlignedDate
      }
      if (cyclePreferred && planningDateSet.has(cyclePreferred)) return cyclePreferred
      return getPlanningDateInRange(planningDates, cycleStart || cyclePreferred, cycleEnd || cyclePreferred, 'first')
    })()
    const effectiveEarliest = getPlanningDateInRange(
      planningDates,
      cycleStart || effectivePreferred,
      cycleEnd || effectivePreferred,
      'first'
    ) || effectivePreferred
    const effectiveLatest = getPlanningDateInRange(
      planningDates,
      cycleStart || effectivePreferred,
      cycleEnd || effectivePreferred,
      'last'
    ) || effectivePreferred

    if (effectivePreferred) {
      const preferredWeekday = weekdayIndex(effectivePreferred)
      const matchesUsualWeekday = usualWeekdays.includes(preferredWeekday)
      const windowWidth = diffDays(effectiveEarliest, effectiveLatest) ?? 0
      const defaultFlexibility = decisionMode === 'predictive'
        ? (windowWidth <= 0 ? 'fixed' : 'narrow_window')
        : 'flexible_window'
      pushUniqueDateEntry(entries, finalizeDateEntry({
        client_id: profile.client_id,
        client_code: profile.client_code,
        candidate_date: effectivePreferred,
        preferredDate: effectivePreferred,
        earliestAllowedDate: decisionMode === 'predictive'
          ? effectiveEarliest
          : getPlanningDateInRange(planningDates, addDays(effectivePreferred, -1), addDays(effectivePreferred, 0), 'first') || effectiveEarliest,
        latestAllowedDate: decisionMode === 'predictive'
          ? effectiveLatest
          : getPlanningDateInRange(planningDates, addDays(effectivePreferred, 0), addDays(effectivePreferred, 2), 'last') || effectiveLatest,
        date_flexibility_type: defaultFlexibility,
        candidate_date_source: matchesUsualWeekday
          ? 'usual_weekday'
          : decisionMode === 'hybrid'
            ? 'low_history_fallback'
            : 'purchase_cadence',
        date_confidence: windowConfidence,
        date_shift_penalty_per_day: decisionMode === 'predictive' ? 8 : 2,
        cycle_source: decisionMode === 'predictive'
          ? 'predicted_purchase_cycle'
          : decisionMode === 'hybrid'
            ? 'low_history_cycle'
            : 'cadence_cycle',
        cycle_sequence_number: loops + 1,
        cycle_window_start: decisionMode === 'predictive' ? effectiveEarliest : addDays(effectivePreferred, -1) || effectiveEarliest,
        cycle_window_end: decisionMode === 'predictive' ? effectiveLatest : addDays(effectivePreferred, 2) || effectiveLatest,
        cycle_preferred_date: effectivePreferred,
        cycle_confidence: windowConfidence,
        repeat_justification_code: decisionMode === 'predictive'
          ? 'distinct_prediction_cycle'
          : decisionMode === 'hybrid'
            ? 'low_history_cycle'
            : 'cadence_cycle'
      }, planningDates))
    }

    if (decisionMode === 'predictive' && loops >= 0 && interval >= Math.max(1, planningDates.length - 1)) {
      break
    }
    cursor = addDays(cycleStart || cursor, interval)
    loops += 1
  }

  if (Number.isFinite(Number(maxDaysWithoutContact)) && Number(maxDaysWithoutContact) > 0) {
    const safeguardDate = addDays(profile.last_contact_date || startDate, Number(maxDaysWithoutContact))
    if (safeguardDate && planningDateSet.has(safeguardDate)) {
      pushUniqueDateEntry(entries, finalizeDateEntry({
        client_id: profile.client_id,
        client_code: profile.client_code,
        candidate_date: safeguardDate,
        preferredDate: safeguardDate,
        earliestAllowedDate: safeguardDate,
        latestAllowedDate: safeguardDate,
        date_flexibility_type: 'fixed',
        candidate_date_source: 'max_days_without_contact',
        date_confidence: Math.min(60, windowConfidence),
        date_shift_penalty_per_day: 12,
        cycle_source: 'max_days_without_contact_cycle',
        cycle_sequence_number: entries.length + 1,
        cycle_window_start: safeguardDate,
        cycle_window_end: safeguardDate,
        cycle_preferred_date: safeguardDate,
        cycle_confidence: Math.min(60, windowConfidence),
        repeat_justification_code: 'distinct_guardrail_cycle'
      }, planningDates))
    }
  }

  if (usualWeekdays.length > 1 && interval <= 7 && entries.length < maxCandidateDatesPerClient) {
    planningDates.forEach(dateValue => {
      if (entries.length >= maxCandidateDatesPerClient) return
      const weekday = weekdayIndex(dateValue)
      if (!usualWeekdays.includes(weekday)) return
      const cycleSequenceNumber = Math.floor((planningDateIndex.get(dateValue) || 0) / Math.max(1, interval)) + 1
      pushUniqueDateEntry(entries, finalizeDateEntry({
        client_id: profile.client_id,
        client_code: profile.client_code,
        candidate_date: dateValue,
        preferredDate: dateValue,
        earliestAllowedDate: dateValue,
        latestAllowedDate: dateValue,
        date_flexibility_type: decisionMode === 'predictive' ? 'narrow_window' : 'flexible_window',
        candidate_date_source: 'usual_weekday',
        date_confidence: decisionMode === 'predictive' ? windowConfidence : Math.min(windowConfidence, 50),
        date_shift_penalty_per_day: decisionMode === 'predictive' ? 6 : 2,
        cycle_source: decisionMode === 'predictive' ? 'predicted_purchase_cycle' : 'cadence_cycle',
        cycle_sequence_number: cycleSequenceNumber,
        cycle_window_start: dateValue,
        cycle_window_end: dateValue,
        cycle_preferred_date: dateValue,
        cycle_confidence: decisionMode === 'predictive' ? windowConfidence : Math.min(windowConfidence, 50),
        repeat_justification_code: decisionMode === 'predictive'
          ? 'distinct_prediction_cycle'
          : 'high_frequency_cadence'
      }, planningDates))
    })
  }

const normalizedStartDate = normalizeDateOnly(startDate)

const cadenceDueDate = profile.last_purchase_date
  ? addDays(profile.last_purchase_date, interval)
  : null

const overdueByCadence = Boolean(
  cadenceDueDate &&
  normalizedStartDate &&
  cadenceDueDate < normalizedStartDate
)

if (
  !entries.length &&
  overdueByCadence &&
  planningDates.length > 0
) {
  const recoverySearchDates = planningDates.slice(
    0,
    Math.min(7, planningDates.length)
  )

  const recoveryPreferredDate =
    recoverySearchDates.find(dateValue =>
      usualWeekdays.length > 0 &&
      usualWeekdays.includes(weekdayIndex(dateValue))
    ) ||
    recoverySearchDates[0]

  const recoveryCenterIndex =
    planningDateIndex.get(recoveryPreferredDate) || 0

  const recoveryWindow = buildPlanningDateWindow(
    planningDates,
    recoveryCenterIndex,
    planningDates.length > 1 ? 1 : 0
  )

  pushUniqueDateEntry(
    entries,
    finalizeDateEntry({
      client_id: profile.client_id,
      client_code: profile.client_code,
      candidate_date: recoveryWindow.preferredDate,
      preferredDate: recoveryWindow.preferredDate,
      earliestAllowedDate:
        recoveryWindow.earliestAllowedDate,
      latestAllowedDate:
        recoveryWindow.latestAllowedDate,
      date_flexibility_type: 'flexible_window',
      candidate_date_source: 'overdue_recovery',
      date_confidence: Math.min(
        Math.max(windowConfidence, 40),
        60
      ),
      date_shift_penalty_per_day: 3,
      cycle_source: 'overdue_recovery_cycle',
      cycle_sequence_number: 1,
      cycle_window_start:
        recoveryWindow.earliestAllowedDate,
      cycle_window_end:
        recoveryWindow.latestAllowedDate,
      cycle_preferred_date:
        recoveryWindow.preferredDate,
      cycle_confidence: Math.min(
        Math.max(windowConfidence, 40),
        60
      ),
      repeat_justification_code:
        'overdue_recovery_guardrail'
    }, planningDates)
  )
}

  if (!entries.length && !profile.last_purchase_date && decisionMode === 'exploration') {
    const explorationWindow = explorationWindowOverride || deriveExplorationWindow(profile, planningDates, clientMetadata)
    pushUniqueDateEntry(entries, finalizeDateEntry({
      client_id: profile.client_id,
      client_code: profile.client_code,
      candidate_date: explorationWindow.preferredDate,
      preferredDate: explorationWindow.preferredDate,
      earliestAllowedDate: explorationWindow.earliestAllowedDate,
      latestAllowedDate: explorationWindow.latestAllowedDate,
      date_flexibility_type: 'exploration_window',
      candidate_date_source: 'exploration_fallback',
      date_confidence: Math.min(windowConfidence, 35),
      date_shift_penalty_per_day: 1,
      cycle_source: 'exploration_cycle',
      cycle_sequence_number: 1,
      cycle_window_start: explorationWindow.earliestAllowedDate,
      cycle_window_end: explorationWindow.latestAllowedDate,
      cycle_preferred_date: explorationWindow.preferredDate,
      cycle_confidence: Math.min(windowConfidence, 35),
      repeat_justification_code: null
    }, planningDates))
  }

  if (!entries.length && !profile.last_purchase_date && decisionMode === 'hybrid') {
    const hybridAnchor = deriveHybridFallbackAnchor(profile, planningDates, clientMetadata)
    const hybridCenterIndex = planningDateIndex.get(hybridAnchor)
    if (hybridCenterIndex != null) {
      const hybridWindow = buildPlanningDateWindow(planningDates, hybridCenterIndex, planningDates.length >= 5 ? 1 : 0)
      pushUniqueDateEntry(entries, finalizeDateEntry({
        client_id: profile.client_id,
        client_code: profile.client_code,
        candidate_date: hybridWindow.preferredDate,
        preferredDate: hybridWindow.preferredDate,
        earliestAllowedDate: hybridWindow.earliestAllowedDate,
        latestAllowedDate: hybridWindow.latestAllowedDate,
        date_flexibility_type: 'flexible_window',
        candidate_date_source: 'low_history_fallback',
        date_confidence: Math.min(windowConfidence, 50),
        date_shift_penalty_per_day: 2,
        cycle_source: 'low_history_cycle',
        cycle_sequence_number: 1,
        cycle_window_start: hybridWindow.earliestAllowedDate,
        cycle_window_end: hybridWindow.latestAllowedDate,
        cycle_preferred_date: hybridWindow.preferredDate,
        cycle_confidence: Math.min(windowConfidence, 50),
        repeat_justification_code: 'low_history_cycle'
      }, planningDates))
    }
  }

  return entries
    .sort((left, right) => String(left.candidate_date || '').localeCompare(String(right.candidate_date || '')))
    .slice(0, maxCandidateDatesPerClient)
}

function buildSparseCandidateDates(profile = {}, options = {}) {
  return buildSparseCandidateDateEntries(profile, options).map(entry => entry.candidate_date)
}

function annotateGeographicSynergy(opportunities = []) {
  const byDate = new Map()
  ;(Array.isArray(opportunities) ? opportunities : []).forEach(opportunity => {
    const dateKey = String(opportunity.candidate_date || '')
    const list = byDate.get(dateKey) || []
    list.push(opportunity)
    byDate.set(dateKey, list)
  })

  byDate.forEach(dayOpportunities => {
    const cellSize = 0.03
    const grid = new Map()

    dayOpportunities.forEach(opportunity => {
      const latitude = Number(opportunity.latitude)
      const longitude = Number(opportunity.longitude)
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return
      const latCell = Math.floor(latitude / cellSize)
      const lonCell = Math.floor(longitude / cellSize)
      const key = `${latCell}::${lonCell}`
      grid.set(key, (grid.get(key) || 0) + 1)
    })

    dayOpportunities.forEach(opportunity => {
      const latitude = Number(opportunity.latitude)
      const longitude = Number(opportunity.longitude)
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        opportunity.nearby_priority_clients_count = 0
        opportunity.geographic_synergy_score = 0
        return
      }
      const latCell = Math.floor(latitude / cellSize)
      const lonCell = Math.floor(longitude / cellSize)
      let nearbyCount = -1

      for (let latOffset = -1; latOffset <= 1; latOffset += 1) {
        for (let lonOffset = -1; lonOffset <= 1; lonOffset += 1) {
          nearbyCount += Number(grid.get(`${latCell + latOffset}::${lonCell + lonOffset}`) || 0)
        }
      }
      opportunity.nearby_priority_clients_count = nearbyCount
      opportunity.geographic_synergy_score = nearbyCount > 0
        ? roundScore(clamp(30 + (nearbyCount * 12), 0, 100))
        : 0
      if (opportunity.geographic_synergy_score >= 55 && nearbyCount > 0) {
        opportunity.explanation_codes = [...new Set([
          ...(Array.isArray(opportunity.explanation_codes) ? opportunity.explanation_codes : []),
          'GEOGRAPHIC_SYNERGY'
        ])]
      }
    })
  })

  return opportunities
}

function buildVisitOpportunities({
  clients = [],
  cadenceProfiles = [],
  predictionsByClientDate = new Map(),
  compatibleCommercialCodesByClientId = new Map(),
  depotByCommercialDate = new Map(),
  options = {}
}) {
  const {
    startDate,
    planningHorizonDays,
    maxCandidateDatesPerClient = 4,
    maxDaysWithoutContact = null,
    availabilityByClientDate = new Map(),
    planningDates: providedPlanningDates = null
  } = options
  const planningDates = Array.isArray(providedPlanningDates) && providedPlanningDates.length
    ? providedPlanningDates
    : buildPlanningDates(startDate, planningHorizonDays)
  const profileByClientId = new Map((Array.isArray(cadenceProfiles) ? cadenceProfiles : []).map(profile => [String(profile.client_id || ''), profile]))
  const providedCandidateDatesByClientId = options.candidateDatesByClientId instanceof Map
    ? options.candidateDatesByClientId
    : null
  const providedCandidateDateEntriesByClientId = options.candidateDateEntriesByClientId instanceof Map
    ? options.candidateDateEntriesByClientId
    : null
  const opportunities = []

  ;(Array.isArray(clients) ? clients : []).forEach(client => {
    const clientId = String(client.client_id || '')
    const profile = profileByClientId.get(clientId) || {}
    const zoneMetadata = normalizeZoneMetadata(client)
    const candidateDateEntries = providedCandidateDateEntriesByClientId?.get(clientId) || buildSparseCandidateDateEntries(profile, {
      startDate,
      planningHorizonDays,
      maxCandidateDatesPerClient,
      maxDaysWithoutContact,
      planningDates,
      clientMetadata: client
    })
    const candidateDates = candidateDateEntries.length
      ? [...new Set(candidateDateEntries.map(entry => entry.candidate_date))]
      : (providedCandidateDatesByClientId?.get(clientId) || buildSparseCandidateDates(profile, {
          startDate,
          planningHorizonDays,
          maxCandidateDatesPerClient,
          maxDaysWithoutContact,
          planningDates,
          clientMetadata: client
        }))
    const usualWeekdays = Array.isArray(profile.usual_purchase_weekdays) ? profile.usual_purchase_weekdays : []
    const compatibleCommercialCodes = compatibleCommercialCodesByClientId.get(clientId) || []
    const decisionMode = resolveDecisionMode(profile)

    candidateDates.forEach(candidateDate => {
      const dateEntry = candidateDateEntries.find(entry => entry.candidate_date === candidateDate) || finalizeDateEntry({
        candidate_date: candidateDate,
        preferredDate: candidateDate,
        earliestAllowedDate: candidateDate,
        latestAllowedDate: candidateDate,
        date_flexibility_type: 'fixed',
        candidate_date_source: 'purchase_cadence',
        date_confidence: clamp((toOptionalFiniteNumber(profile.cadence_confidence) ?? 0.18) * 100, 0, 100),
        date_shift_penalty_per_day: 8,
        client_id: clientId,
        client_code: String(client.client_code || ''),
        cycle_source: 'cadence_cycle',
        cycle_sequence_number: 1,
        cycle_window_start: candidateDate,
        cycle_window_end: candidateDate,
        cycle_preferred_date: candidateDate,
        cycle_confidence: clamp((toOptionalFiniteNumber(profile.cadence_confidence) ?? 0.18) * 100, 0, 100),
        repeat_justification_code: 'cadence_cycle'
      }, planningDates)
      const predictionKey = `${clientId}::${candidateDate}`
      const prediction = predictionsByClientDate.get(predictionKey) || {}
      const depotDistanceCandidates = compatibleCommercialCodes
        .map(code => {
          const depot = depotByCommercialDate.get(`${String(code)}::${candidateDate}`) || null
          return haversineKm(client.latitude, client.longitude, depot?.latitude, depot?.longitude)
        })
        .filter(Number.isFinite)
      const sourceSignals = []
      const explanationCodes = []
      const candidateWeekday = weekdayIndex(candidateDate)
      if (profile.next_purchase_window_start && profile.next_purchase_window_end) {
        sourceSignals.push('NEXT_PURCHASE_WINDOW')
        explanationCodes.push('PURCHASE_WINDOW_NEAR')
      }
      if (usualWeekdays.includes(candidateWeekday)) {
        sourceSignals.push('USUAL_PURCHASE_WEEKDAY')
        explanationCodes.push('USUAL_PURCHASE_WEEKDAY')
      }
      if (prediction.purchase_prediction_known) {
        sourceSignals.push('DATE_SPECIFIC_PREDICTION')
      }
      const maxWithoutContactDate = Number.isFinite(Number(maxDaysWithoutContact)) && Number(maxDaysWithoutContact) > 0
        ? addDays(profile.last_contact_date || startDate, Number(maxDaysWithoutContact))
        : null
      const isGuardrailDate = Boolean(maxWithoutContactDate && candidateDate === maxWithoutContactDate)
      if (isGuardrailDate) {
        sourceSignals.push('MAX_DAYS_WITHOUT_CONTACT')
        explanationCodes.push('MAX_DAYS_WITHOUT_CONTACT')
      }
      const daysSinceLastPurchase = toOptionalFiniteNumber(profile.days_since_last_purchase)
      if (daysSinceLastPurchase != null && daysSinceLastPurchase <= 2) {
        sourceSignals.push('RECENT_PURCHASE')
        explanationCodes.push('RECENT_PURCHASE_DEPRIORITIZED')
      }
      const explicitAvailability = availabilityByClientDate.get(`${clientId}::${candidateDate}`) ||
        availabilityByClientDate.get(`${String(client.client_code || '')}::${candidateDate}`) ||
        null
      const availabilityStatus = explicitAvailability?.status || (
        usualWeekdays.length
          ? (usualWeekdays.includes(candidateWeekday) ? 'estimated_available' : 'unknown')
          : 'unknown'
      )
      const purchaseProbability = toOptionalFiniteNumber(prediction.purchase_probability)
      const expectedOrderValue = toOptionalFiniteNumber(prediction.expected_order_value)
      const recommendedQuantity = toOptionalFiniteNumber(prediction.recommended_quantity)
      const predictedCaIfBuy = toOptionalFiniteNumber(prediction.predicted_ca_if_buy)
      const predictedQuantityIfBuy = toOptionalFiniteNumber(prediction.predicted_quantity_if_buy)
      const predictionConfidence = toOptionalFiniteNumber(prediction.confidence)
      const cadenceConfidence = toOptionalFiniteNumber(profile.cadence_confidence) ?? 0.18
      const confidence = predictionConfidence != null
        ? Math.min(predictionConfidence, cadenceConfidence)
        : cadenceConfidence
      if (purchaseProbability != null && purchaseProbability >= 60) {
        explanationCodes.push('HIGH_PURCHASE_PROBABILITY')
      }
      if (expectedOrderValue != null && expectedOrderValue >= 100) {
        explanationCodes.push('HIGH_EXPECTED_CA')
      }
      if (String(profile.inactivity_risk || '').trim().toLowerCase() === 'high') {
        explanationCodes.push('INACTIVITY_RISK')
      }
      if (availabilityStatus === 'unknown') {
        explanationCodes.push('AVAILABILITY_UNKNOWN')
      }
      if (decisionMode === 'exploration') {
        explanationCodes.push('EXPLORATION_VISIT')
      } else if (decisionMode === 'hybrid') {
        explanationCodes.push('LOW_HISTORY_HYBRID')
      }
      if (dateEntry?.date_flexibility_type === 'exploration_window') {
        explanationCodes.push('EXPLORATION_WINDOW')
      }

      opportunities.push({
        visit_opportunity_id: buildOpportunityId(clientId, candidateDate),
        client_id: clientId,
        client_code: String(client.client_code || ''),
        client_name: String(client.nom || client.client_name || client.client_code || '').trim() || null,
        address: String(client.adresse || client.address || '').trim() || null,
        latitude: toOptionalFiniteNumber(client.latitude),
        longitude: toOptionalFiniteNumber(client.longitude),
        user_code: zoneMetadata.user_code,
        delegation: zoneMetadata.delegation,
        region: zoneMetadata.region,
        routing_code: zoneMetadata.routing_code,
        commercial_zone: zoneMetadata.commercial_zone,
        zone_source: zoneMetadata.zone_source,
        zone_resolution_status: zoneMetadata.zone_resolution_status,
        candidate_date: candidateDate,
        preferred_date: dateEntry?.preferred_date || candidateDate,
        earliest_allowed_date: dateEntry?.earliest_allowed_date || candidateDate,
        latest_allowed_date: dateEntry?.latest_allowed_date || candidateDate,
        date_flexibility_type: dateEntry?.date_flexibility_type || 'fixed',
        candidate_date_source: dateEntry?.candidate_date_source || 'purchase_cadence',
        date_prediction_support: prediction.purchase_prediction_known ? 'known_prediction' : 'no_prediction',
        date_confidence: dateEntry?.date_confidence ?? null,
        date_shift_penalty_per_day: prediction.purchase_prediction_known && dateEntry?.date_flexibility_type === 'narrow_window'
          ? Math.max(10, Number(dateEntry?.date_shift_penalty_per_day || 0))
          : (dateEntry?.date_shift_penalty_per_day ?? null),
        visit_cycle_id: dateEntry?.visit_cycle_id || buildVisitCycleId({
          clientId,
          clientCode: String(client.client_code || ''),
          cycleSource: dateEntry?.cycle_source,
          cycleSequenceNumber: dateEntry?.cycle_sequence_number,
          cycleWindowStart: dateEntry?.cycle_window_start,
          cycleWindowEnd: dateEntry?.cycle_window_end,
          cyclePreferredDate: dateEntry?.cycle_preferred_date
        }),
        cycle_sequence_number: Number(dateEntry?.cycle_sequence_number || 1),
        cycle_source: dateEntry?.cycle_source || (
          decisionMode === 'predictive'
            ? 'predicted_purchase_cycle'
            : decisionMode === 'hybrid'
              ? 'low_history_cycle'
              : 'exploration_cycle'
        ),
        cycle_window_start: dateEntry?.cycle_window_start || (dateEntry?.earliest_allowed_date || candidateDate),
        cycle_window_end: dateEntry?.cycle_window_end || (dateEntry?.latest_allowed_date || candidateDate),
        cycle_preferred_date: dateEntry?.cycle_preferred_date || (dateEntry?.preferred_date || candidateDate),
        cycle_confidence: dateEntry?.cycle_confidence ?? dateEntry?.date_confidence ?? null,
        repeat_justification_code: dateEntry?.repeat_justification_code || null,
        possible_commercial_codes: compatibleCommercialCodes,
        purchase_probability: Number.isFinite(purchaseProbability) ? roundScore(purchaseProbability) : null,
        predicted_ca: Number.isFinite(expectedOrderValue) ? roundScore(expectedOrderValue) : null,
        expected_order_value: Number.isFinite(expectedOrderValue) ? roundScore(expectedOrderValue) : null,
        recommended_quantity: Number.isFinite(recommendedQuantity) ? roundScore(recommendedQuantity) : null,
        predicted_ca_if_buy: Number.isFinite(predictedCaIfBuy) ? roundScore(predictedCaIfBuy) : null,
        predicted_quantity_if_buy: Number.isFinite(predictedQuantityIfBuy) ? roundScore(predictedQuantityIfBuy) : null,
        predicted_products: Array.isArray(prediction.predicted_products) ? prediction.predicted_products : [],
        purchase_prediction_score: toOptionalFiniteNumber(prediction.purchase_prediction_score) != null
          ? roundScore(prediction.purchase_prediction_score)
          : null,
        purchase_prediction_known: Boolean(prediction.purchase_prediction_known),
        prediction_vip: toOptionalFiniteNumber(prediction.prediction_vip) != null
          ? roundScore(prediction.prediction_vip)
          : null,
        probability_model_only: toOptionalFiniteNumber(prediction.probability_model_only) != null
          ? roundScore(prediction.probability_model_only)
          : null,
        habit_score: toOptionalFiniteNumber(prediction.habit_score) != null
          ? roundScore(prediction.habit_score)
          : null,
        recency_score: toOptionalFiniteNumber(prediction.recency_score) != null
          ? roundScore(prediction.recency_score)
          : null,
        predicted_purchase_date: prediction.predicted_purchase_date || candidateDate,
        purchase_days_until_prediction: diffDays(startDate, prediction.predicted_purchase_date || candidateDate),
        cadence_due_score: buildCadenceDueScore(profile, candidateDate),
        availability_score: availabilityStatus === 'estimated_available' ? 65 : null,
        availability_status: availabilityStatus,
        inactivity_risk: profile.inactivity_risk || 'unknown',
        strategic_client_score: buildStrategicClientScore(client, profile),
        preselection_distance_estimate_km: depotDistanceCandidates.length
          ? roundScore(Math.min(...depotDistanceCandidates))
          : null,
        incremental_distance_estimate: null,
        estimated_visit_value: Number.isFinite(expectedOrderValue) ? roundScore(expectedOrderValue) : null,
        estimated_visit_time_minutes: null,
        confidence: roundScore(confidence * 100),
        decision_mode: decisionMode,
        source_signals: sourceSignals,
        explanation_codes: explanationCodes,
        usual_purchase_weekdays: usualWeekdays,
        next_purchase_date_estimate: profile.next_purchase_date_estimate,
        days_since_last_purchase: daysSinceLastPurchase,
        max_days_without_contact_guardrail: isGuardrailDate,
        recommended_visit_interval_days: profile.recommended_visit_interval_days,
        cadence_confidence: profile.cadence_confidence ?? null,
        personalized_minimum_gap_days: null,
        history_depth: profile.history_depth ?? 0,
        fallback_strategy: profile.fallback_strategy || null,
        availability_source: explicitAvailability?.source || null,
        customer_activity_trend: profile.customer_activity_trend || 'insufficient_history'
      })
    })
  })

  return annotateGeographicSynergy(opportunities)
}

module.exports = {
  buildPlanningDates,
  buildSparseCandidateDateEntries,
  buildSparseCandidateDates,
  buildVisitOpportunities,
  haversineKm,
  resolveDecisionMode
}

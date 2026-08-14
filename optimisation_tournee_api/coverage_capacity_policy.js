function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizePositiveNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function computeAdjustedTargetMaxVisits({
  userMaxVisits = 0,
  activeClients = 0,
  availableSlots = 0,
  manualMaxVisits = null
} = {}) {
  const normalizedUserMaxVisits = normalizePositiveInteger(userMaxVisits) || 0
  const normalizedManualMaxVisits = normalizePositiveInteger(manualMaxVisits) || 0
  const userPreferredMaxVisits = Math.max(normalizedUserMaxVisits, normalizedManualMaxVisits)
  const normalizedClients = Math.max(0, Number.parseInt(activeClients, 10) || 0)
  const normalizedSlots = Math.max(0, Number.parseInt(availableSlots, 10) || 0)
  const requiredCoverageMaxVisits = normalizedClients > 0 && normalizedSlots > 0
    ? Math.ceil(normalizedClients / normalizedSlots)
    : 0
  const effectiveTargetMaxVisits = Math.max(
    userPreferredMaxVisits,
    requiredCoverageMaxVisits,
    1
  )
  const adjustmentReason = (
    userPreferredMaxVisits > 0 &&
    requiredCoverageMaxVisits > userPreferredMaxVisits
  )
    ? 'user_range_below_required_load'
    : 'user_range_accepted'

  return {
    userMaxVisits: normalizedUserMaxVisits,
    manualMaxVisits: normalizedManualMaxVisits,
    userPreferredMaxVisits,
    requiredMinimumMaxVisits: requiredCoverageMaxVisits,
    requiredCoverageMaxVisits,
    effectiveTargetMaxVisits,
    adjustedTargetMaxVisits: effectiveTargetMaxVisits,
    adjustmentReason
  }
}

function resolveCoverageSlotCapacity({
  requestedMaxVisits = 0,
  adjustedTargetMaxVisits = 0,
  historicalClientCapacity = null,
  historicalLoadUnits = null,
  historicalLoadUnitsPerClient = null,
  hardMaxVisits = null,
  hardMaxLoadUnits = null
} = {}) {
  const normalizedRequestedMaxVisits = normalizePositiveInteger(requestedMaxVisits)
  const normalizedAdjustedTargetMaxVisits = Math.max(
    1,
    normalizePositiveInteger(adjustedTargetMaxVisits) || normalizedRequestedMaxVisits || 1
  )
  const normalizedHistoricalClientCapacity = normalizePositiveInteger(historicalClientCapacity)
  const normalizedHistoricalLoadUnits = normalizePositiveNumber(historicalLoadUnits)
  const normalizedLoadUnitsPerClient = normalizePositiveNumber(historicalLoadUnitsPerClient)
  const normalizedHardMaxVisits = normalizePositiveInteger(hardMaxVisits)
  const normalizedHardMaxLoadUnits = normalizePositiveNumber(hardMaxLoadUnits)

  const historicalTruckBoundSoftMaxVisits = normalizedHistoricalLoadUnits && normalizedLoadUnitsPerClient
    ? Math.max(1, Math.floor(normalizedHistoricalLoadUnits / normalizedLoadUnitsPerClient))
    : null
  const hardPhysicalMaxVisitsFromLoad = normalizedHardMaxLoadUnits && normalizedLoadUnitsPerClient
    ? Math.max(1, Math.floor(normalizedHardMaxLoadUnits / normalizedLoadUnitsPerClient))
    : null
  const hardPhysicalCandidates = [
    normalizedHardMaxVisits,
    hardPhysicalMaxVisitsFromLoad
  ].filter(value => Number.isFinite(value) && value > 0)
  const hardPhysicalMaxVisits = hardPhysicalCandidates.length
    ? Math.min(...hardPhysicalCandidates)
    : null
  const technicalSoftCeiling = Math.max(
    1,
    normalizedAdjustedTargetMaxVisits,
    normalizedRequestedMaxVisits || 0,
    normalizedHistoricalClientCapacity || 0,
    historicalTruckBoundSoftMaxVisits || 0
  )
  const maxClients = hardPhysicalMaxVisits != null
    ? Math.max(1, Math.min(technicalSoftCeiling, hardPhysicalMaxVisits))
    : technicalSoftCeiling

  return {
    requestedMaxVisits: normalizedRequestedMaxVisits || null,
    userPreferredMaxVisits: normalizedRequestedMaxVisits || null,
    adjustedTargetMaxVisits: normalizedAdjustedTargetMaxVisits,
    effectiveTargetMaxVisits: normalizedAdjustedTargetMaxVisits,
    technicalCeilingMaxVisits: technicalSoftCeiling,
    maxClients,
    historicalSoftMaxVisits: normalizedHistoricalClientCapacity,
    historicalTruckBoundSoftMaxVisits,
    hardPhysicalMaxVisits,
    hardCapacityKnown: hardPhysicalMaxVisits != null || normalizedHardMaxLoadUnits != null,
    hardPhysicalMaxLoadUnits: normalizedHardMaxLoadUnits,
    maxLoadUnits: normalizedHardMaxLoadUnits,
    loadUnitsPerClient: normalizedLoadUnitsPerClient,
    hasHardPhysicalLimit: hardPhysicalMaxVisits != null || normalizedHardMaxLoadUnits != null,
    hasHistoricalCapacitySignal: (
      normalizedHistoricalClientCapacity != null ||
      historicalTruckBoundSoftMaxVisits != null
    ),
    clientCapacitySource: hardPhysicalMaxVisits != null ? 'hard_physical' : 'adjusted_target',
    truckCapacitySource: normalizedHardMaxLoadUnits != null ? 'hard_physical' : 'none'
  }
}

module.exports = {
  computeAdjustedTargetMaxVisits,
  resolveCoverageSlotCapacity
}

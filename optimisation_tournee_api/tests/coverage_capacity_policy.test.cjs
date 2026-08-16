const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  computeAdjustedTargetMaxVisits,
  resolveCoverageSlotCapacity
} = require(path.join(process.cwd(), 'coverage_capacity_policy.js'))

test('a user range below the required load raises the effective target without turning history into a hard cap', () => {
  const adjustment = computeAdjustedTargetMaxVisits({
    userMaxVisits: 40,
    activeClients: 5757,
    availableSlots: 84
  })

  assert.equal(adjustment.requiredMinimumMaxVisits, 69)
  assert.equal(adjustment.userPreferredMaxVisits, 40)
  assert.equal(adjustment.effectiveTargetMaxVisits, 69)
  assert.equal(adjustment.adjustmentReason, 'user_range_below_required_load')

  const slotCapacity = resolveCoverageSlotCapacity({
    requestedMaxVisits: adjustment.userPreferredMaxVisits,
    adjustedTargetMaxVisits: adjustment.effectiveTargetMaxVisits,
    historicalClientCapacity: 7
  })

  assert.equal(slotCapacity.historicalSoftMaxVisits, 7)
  assert.equal(slotCapacity.hardPhysicalMaxVisits, null)
  assert.equal(slotCapacity.userPreferredMaxVisits, 40)
  assert.equal(slotCapacity.effectiveTargetMaxVisits, 69)
  assert.equal(slotCapacity.maxClients, 69)
})

test('an explicit hard physical limit stays the only hard ceiling', () => {
  const slotCapacity = resolveCoverageSlotCapacity({
    requestedMaxVisits: 60,
    adjustedTargetMaxVisits: 225,
    historicalClientCapacity: 7,
    hardMaxVisits: 30
  })

  assert.equal(slotCapacity.historicalSoftMaxVisits, 7)
  assert.equal(slotCapacity.effectiveTargetMaxVisits, 225)
  assert.equal(slotCapacity.hardPhysicalMaxVisits, 30)
  assert.equal(slotCapacity.maxClients, 30)
})

test('a user range already compatible with coverage is accepted as-is', () => {
  const adjustment = computeAdjustedTargetMaxVisits({
    userMaxVisits: 60,
    activeClients: 55,
    availableSlots: 1
  })

  assert.equal(adjustment.requiredCoverageMaxVisits, 55)
  assert.equal(adjustment.effectiveTargetMaxVisits, 60)
  assert.equal(adjustment.adjustmentReason, 'user_range_accepted')
})

test('historical soft signals never become a hard limit when no physical cap exists', () => {
  const slotCapacity = resolveCoverageSlotCapacity({
    requestedMaxVisits: 60,
    adjustedTargetMaxVisits: 225,
    historicalClientCapacity: 12
  })

  assert.equal(slotCapacity.hardPhysicalMaxVisits, null)
  assert.equal(slotCapacity.maxClients, 225)
})

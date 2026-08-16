import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_COVERAGE_VISIT_FREQUENCY_DAYS,
  DEFAULT_COVERAGE_WORKING_DAYS,
  buildPlannerDates,
  computeTotalCaShortfall,
  computeRecommendedMaxCapacity,
  formatNullableCurrency
} from '../coveragePlannerUtils.js'

test('default visit frequency is 14 days', () => {
  assert.equal(DEFAULT_COVERAGE_VISIT_FREQUENCY_DAYS, 14)
})

test('5768 clients, 6 commercials and 14 active days give 84 slots when everyone is available', () => {
  const activeDates = buildPlannerDates('2026-08-03', 14, DEFAULT_COVERAGE_WORKING_DAYS)
  assert.equal(activeDates.length, 14)
  assert.equal(activeDates.length * 6, 84)
})

test('recommended capacity is rounded up to 69 for 5768 clients over 84 slots', () => {
  assert.equal(computeRecommendedMaxCapacity(5768, 84), 69)
})

test('nullable currency formatting distinguishes unknown, zero and known values', () => {
  assert.equal(formatNullableCurrency(null), 'Non disponible')
  assert.equal(formatNullableCurrency(undefined), 'Non disponible')
  assert.equal(formatNullableCurrency(Number.NaN), 'Non disponible')
  assert.equal(formatNullableCurrency(0), '0,0 TND')
  assert.equal(formatNullableCurrency(360.3), '360,3 TND')
})

test('total shortfall becomes unknown when one block shortfall is unknown', () => {
  assert.equal(computeTotalCaShortfall([
    { ca_shortfall: 10 },
    { ca_shortfall: null }
  ]), null)
})

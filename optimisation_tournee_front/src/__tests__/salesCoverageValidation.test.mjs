import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  resolveSalesCoverageSubmitGuard,
  validateSalesCoverageFilters,
  __testables
} from '../salesCoverageValidation.js'

const TODAY = '2026-08-24'
const COMMERCIAUX = [
  { value: 'C01', label: 'Commercial 1' },
  { value: 'C02', label: 'Commercial 2' }
]

function buildValidFilters(overrides = {}) {
  return {
    start_date: TODAY,
    period_days: '14',
    min_clients: '20',
    max_clients: '30',
    daily_max_mode: 'flexible',
    commercial_codes: ['C01'],
    ...overrides
  }
}

const invalidCases = [
  {
    name: 'rejects an invalid start_date',
    filters: buildValidFilters({ start_date: '2026-02-31' }),
    message: __testables.SALES_COVERAGE_INVALID_DATE_MESSAGE
  },
  {
    name: 'rejects a past start_date',
    filters: buildValidFilters({ start_date: '2026-08-23' }),
    message: __testables.SALES_COVERAGE_PAST_DATE_MESSAGE
  },
  {
    name: 'rejects a period below one day',
    filters: buildValidFilters({ period_days: '0' }),
    message: __testables.SALES_COVERAGE_PERIOD_MESSAGE
  },
  {
    name: 'rejects a period above sixty days',
    filters: buildValidFilters({ period_days: '61' }),
    message: __testables.SALES_COVERAGE_PERIOD_MESSAGE
  },
  {
    name: 'rejects a negative target load',
    filters: buildValidFilters({ min_clients: '-1' }),
    message: __testables.SALES_COVERAGE_MIN_CLIENTS_MESSAGE
  },
  {
    name: 'rejects a negative maximum load',
    filters: buildValidFilters({ max_clients: '-1' }),
    message: __testables.SALES_COVERAGE_MAX_CLIENTS_MESSAGE
  },
  {
    name: 'rejects min_clients above strict max_clients',
    filters: buildValidFilters({
      daily_max_mode: 'strict',
      min_clients: '31',
      max_clients: '30'
    }),
    message: __testables.SALES_COVERAGE_STRICT_MAX_MESSAGE
  },
  {
    name: 'rejects when no commercial is selected',
    filters: buildValidFilters({ commercial_codes: [] }),
    message: __testables.SALES_COVERAGE_NO_COMMERCIAL_MESSAGE
  },
  {
    name: 'rejects unknown commercial codes',
    filters: buildValidFilters({ commercial_codes: ['C99'] }),
    message: __testables.SALES_COVERAGE_UNKNOWN_COMMERCIALS_MESSAGE
  }
]

for (const testCase of invalidCases) {
  test(testCase.name, () => {
    let invalidateCount = 0
    let requestBuilt = false

    const result = resolveSalesCoverageSubmitGuard({
      filters: testCase.filters,
      commerciaux: COMMERCIAUX,
      today: TODAY,
      invalidateGeneratedPlan: () => {
        invalidateCount += 1
      },
      requestBuilder: () => {
        requestBuilt = true
        return { sent: true }
      }
    })

    assert.deepEqual(result, {
      shouldSubmit: false,
      errorMessage: testCase.message,
      payload: null
    })
    assert.equal(invalidateCount, 1)
    assert.equal(requestBuilt, false)
  })
}

test('accepts a plan starting today', () => {
  const validation = validateSalesCoverageFilters(
    buildValidFilters({ start_date: TODAY }),
    { commerciaux: COMMERCIAUX },
    TODAY
  )

  assert.deepEqual(validation, {
    valid: true,
    message: null
  })
})

test('accepts a future plan with an empty maximum as no strict cap', () => {
  const validation = validateSalesCoverageFilters(
    buildValidFilters({
      start_date: '2026-08-30',
      daily_max_mode: 'strict',
      max_clients: '',
      min_clients: '45'
    }),
    { commerciaux: COMMERCIAUX },
    TODAY
  )

  assert.deepEqual(validation, {
    valid: true,
    message: null
  })
})

test('sales coverage date input enforces today as the minimum selectable date', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesCoveragePlanner.jsx'),
    'utf8'
  )

  assert.equal(source.includes('min={todayIsoDate()}'), true)
})

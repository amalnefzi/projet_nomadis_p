import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

import { buildSalesCoveragePayload } from '../salesCoverageDetails.js'

function loadCoveragePlannerHelpers() {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'CoveragePlanner.jsx'),
    'utf8'
  )
  const snippetStart = source.indexOf('const REQUEST_TIMEOUT_MS')
  const snippetEnd = source.indexOf('function buildAdjustmentNotes')

  assert.notEqual(snippetStart, -1)
  assert.notEqual(snippetEnd, -1)

  const context = {
    DEFAULT_COVERAGE_PERIOD_DAYS: 14,
    DEFAULT_COVERAGE_VISIT_FREQUENCY_DAYS: 14,
    todayIsoDate: () => '2026-08-28'
  }

  vm.runInNewContext(
    `
${source.slice(snippetStart, snippetEnd)}
globalThis.__coveragePlannerTestables = {
  TARGET_COLLECTION_AMOUNT_MESSAGE,
  normalizePlannerFilters,
  buildCoveragePayload
}
    `,
    context
  )

  return {
    source,
    ...context.__coveragePlannerTestables
  }
}

function buildSelection() {
  return {
    selectedCommercials: ['C01', 'C02']
  }
}

test('recovery planner title is now Plan de Recouvrement', () => {
  const { source } = loadCoveragePlannerHelpers()

  assert.equal(source.includes('Plan de Recouvrement'), true)
  assert.equal(source.includes('Plan de couverture</h2>'), false)
})

test('recovery planner sends null target_collection_amount when the input is empty', () => {
  const { normalizePlannerFilters, buildCoveragePayload } = loadCoveragePlannerHelpers()
  const normalizedFilters = normalizePlannerFilters({
    start_date: '2026-09-01',
    period_days: '14',
    min_clients: '5',
    max_clients: '',
    target_collection_amount: ''
  })
  const payload = buildCoveragePayload(normalizedFilters, buildSelection())

  assert.equal(normalizedFilters.target_collection_amount, '')
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'target_collection_amount'), true)
  assert.equal(payload.target_collection_amount, null)
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'min_daily_ca_per_commercial'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'strict_ca'), false)
})

test('recovery planner keeps zero as full coverage target_collection_amount', () => {
  const { buildCoveragePayload } = loadCoveragePlannerHelpers()
  const payload = buildCoveragePayload({
    start_date: '2026-09-01',
    period_days: '14',
    min_clients: '5',
    max_clients: '',
    target_collection_amount: '0'
  }, buildSelection())

  assert.equal(payload.target_collection_amount, 0)
})

test('recovery planner keeps positive decimal target_collection_amount as a number', () => {
  const { buildCoveragePayload } = loadCoveragePlannerHelpers()
  const payload = buildCoveragePayload({
    start_date: '2026-09-01',
    period_days: '14',
    min_clients: '5',
    max_clients: '',
    target_collection_amount: '1250.75'
  }, buildSelection())

  assert.equal(payload.target_collection_amount, 1250.75)
})

test('recovery planner blocks negative invalid or non finite collection targets', () => {
  const { buildCoveragePayload, TARGET_COLLECTION_AMOUNT_MESSAGE } = loadCoveragePlannerHelpers()

  for (const value of ['-1', 'abc', 'Infinity', '-Infinity', 'NaN']) {
    assert.throws(
      () => buildCoveragePayload({
        start_date: '2026-09-01',
        period_days: '14',
        min_clients: '5',
        max_clients: '',
        target_collection_amount: value
      }, buildSelection()),
      error => error?.message === TARGET_COLLECTION_AMOUNT_MESSAGE
    )
  }
})

test('sales v2 payload is unchanged and does not include target_collection_amount', () => {
  const payload = buildSalesCoveragePayload({
    start_date: '2026-09-01',
    period_days: '14',
    min_clients: '20',
    max_clients: '30',
    min_daily_ca_per_commercial: ''
  }, ['C01'], {
    coverage_window_days: 14,
    daily_max_mode: 'flexible'
  })

  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'target_collection_amount'), false)
})

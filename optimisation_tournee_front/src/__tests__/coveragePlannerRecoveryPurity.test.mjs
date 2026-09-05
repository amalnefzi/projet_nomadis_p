import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

import {
  buildCoverageClientRows,
  buildCoverageDetailHeaderModel,
  buildCoverageSidebarCardModel
} from '../coveragePlannerDetails.js'
import { buildSalesCoveragePayload } from '../salesCoverageDetails.js'

function readSource(relativePath) {
  return fs.readFileSync(
    path.resolve(process.cwd(), 'src', relativePath),
    'utf8'
  )
}

function loadCoveragePlannerHelpers() {
  const source = readSource('CoveragePlanner.jsx')
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
globalThis.__coveragePlannerRecoveryPurity = {
  normalizePlannerFilters,
  buildCoveragePayload
}
    `,
    context
  )

  return {
    source,
    ...context.__coveragePlannerRecoveryPurity
  }
}

test('recovery payload removes commercial CA constraints while keeping collection target fields', () => {
  const { buildCoveragePayload } = loadCoveragePlannerHelpers()

  const payload = buildCoveragePayload({
    start_date: '2026-09-01',
    period_days: '14',
    min_clients: '4',
    max_clients: '10',
    target_collection_amount: '1500.5',
    min_daily_ca_per_commercial: '900'
  }, {
    selectedCommercials: ['C01'],
    selectedClientCodes: ['CL-1']
  })

  assert.equal(payload.planning_mode, 'recovery_coverage')
  assert.equal(payload.target_collection_amount, 1500.5)
  assert.deepEqual(payload.commercials, ['C01'])
  assert.deepEqual(payload.clients, ['CL-1'])
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'min_daily_ca_per_commercial'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'strict_ca'), false)
})

test('recovery form no longer exposes commercial CA inputs while keeping collection and capacity inputs', () => {
  const { source } = loadCoveragePlannerHelpers()

  assert.equal(source.includes('CA minimum journalier'), false)
  assert.equal(source.includes('min_daily_ca_per_commercial'), false)
  assert.equal(source.includes('Objectif de collecte sur la periode (DT)'), true)
  assert.equal(source.includes('Clients min / commercial / jour'), true)
  assert.equal(source.includes('Clients max / commercial / jour'), true)
})

test('recovery KPI sources and detail helpers hide purchase and predicted CA fields', () => {
  const plannerSource = readSource('CoveragePlanner.jsx')
  const tableSource = readSource('CoverageTourClientTable.jsx')

  assert.equal(plannerSource.includes('purchase_prediction_summary'), false)
  assert.equal(plannerSource.includes('total_predicted_ca'), false)
  assert.equal(plannerSource.includes('total_ca_shortfall'), false)
  assert.equal(plannerSource.includes('CA prevu'), false)
  assert.equal(plannerSource.includes('Deficit total'), false)

  assert.equal(tableSource.includes('Score achat'), false)
  assert.equal(tableSource.includes('Qte recommandee'), false)
  assert.equal(tableSource.includes('Chiffre predit'), false)

  const sidebar = buildCoverageSidebarCardModel({
    clients_count: 3,
    recovery_data_known_count: 2,
    recovery_completeness: false,
    expected_collection_total: 420
  })
  const header = buildCoverageDetailHeaderModel({
    clients_count: 2,
    expected_collection_total: 100,
    overdue_balance_total: 50,
    predicted_order_value_total: 999,
    recommended_quantity_total: 4,
    clients: [
      { latitude: 36.8, longitude: 10.1 },
      { latitude: null, longitude: null }
    ]
  }, {
    summary: null
  })
  const row = buildCoverageClientRows({
    clients: [
      {
        client_id: '1',
        client_code: 'CL-1',
        client_name: 'Client 1',
        priority_reasons: [
          'credit_overdue',
          'high_purchase_prediction',
          'predicted_purchase_date_near',
          'high_expected_order_value'
        ],
        recovery_due_amount: 80,
        recovery_days_past_due: 12,
        recovery_expected_collection_amount: 55,
        recovery_payment_behavior_score: 0.6,
        purchase_prediction_score: 0.9,
        recommended_quantity: 7,
        expected_order_value: 300,
        predicted_purchase_date: '2026-09-03',
        predicted_ca: 450
      }
    ]
  })[0]

  assert.equal(Object.prototype.hasOwnProperty.call(sidebar, 'predictedOrderLabel'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(header, 'predictedOrderLabel'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(header, 'recommendedQuantityLabel'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'purchasePredictionScore'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'recommendedQuantity'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'expectedOrderValue'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'predictedPurchaseDate'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'predictedCa'), false)
  assert.deepEqual(row.reasons, ['Credit echu'])
})

test('recovery details keep recouvrement fields visible', () => {
  const tableSource = readSource('CoverageTourClientTable.jsx')
  const sidebar = buildCoverageSidebarCardModel({
    clients_count: 5,
    recovery_data_known_count: 4,
    recovery_completeness: false,
    expected_collection_total: 300
  })
  const header = buildCoverageDetailHeaderModel({
    clients_count: 2,
    expected_collection_total: 180,
    overdue_balance_total: 90,
    clients: [
      { latitude: 36.8, longitude: 10.1 },
      { latitude: null, longitude: null }
    ],
    recovery_completeness: false
  }, {
    summary: null
  })
  const row = buildCoverageClientRows({
    clients: [
      {
        client_id: '1',
        client_code: 'CL-1',
        recovery_due_amount: 120,
        recovery_days_past_due: 20,
        recovery_expected_collection_amount: 75,
        recovery_payment_behavior_score: 0.4
      }
    ]
  })[0]

  assert.equal(tableSource.includes('Recouvrement'), true)
  assert.equal(tableSource.includes('Collecte prevue'), true)
  assert.equal(tableSource.includes('Paiement'), true)
  assert.match(sidebar.collectionLabel, /Collecte connue/)
  assert.match(sidebar.completenessLabel, /Donnees recouvrement partielles/)
  assert.notEqual(header.expectedCollectionLabel, 'Non disponible')
  assert.notEqual(header.overdueBalanceLabel, 'Non disponible')
  assert.equal(header.recoveryPartial, true)
  assert.equal(row.dueAmount, 120)
  assert.equal(row.overdueDays, 20)
  assert.equal(row.expectedCollectionAmount, 75)
  assert.equal(row.paymentBehaviorScore, 0.4)
})

test('Sales V2 keeps its commercial CA controls and payload', () => {
  const salesSource = readSource('SalesCoveragePlanner.jsx')
  const salesDetailsSource = readSource('salesCoverageDetails.js')
  const payload = buildSalesCoveragePayload({
    start_date: '2026-09-01',
    period_days: '14',
    min_clients: '3',
    max_clients: '9',
    min_daily_ca_per_commercial: '800'
  }, ['C01'], {
    coverage_window_days: 14,
    daily_max_mode: 'flexible'
  })

  assert.equal(salesSource.includes('min_daily_ca_per_commercial'), true)
  assert.equal(salesDetailsSource.includes('CA minimum journalier'), true)
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'min_daily_ca_per_commercial'), true)
  assert.equal(payload.min_daily_ca_per_commercial, 800)
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'target_collection_amount'), false)
})

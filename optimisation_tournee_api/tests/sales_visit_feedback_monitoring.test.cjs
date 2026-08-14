const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildSalesVisitMonitoringDetail,
  getSalesVisitFeedbackMonitoring,
  getSalesVisitFeedbackMonitoringDetails
} = require('../sales_visit_feedback_service')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createMonitoringQueryAsyncMock(seedRows = []) {
  const rows = seedRows.map(clone)
  const queries = []

  return {
    rows,
    queries,
    queryAsync: async (sql, params = []) => {
      const normalizedSql = String(sql).replace(/\s+/g, ' ').trim()
      queries.push({ sql: normalizedSql, params: clone(params) })

      if (!normalizedSql.startsWith('SELECT ')) {
        throw new Error(`Monitoring must be read-only. Unexpected SQL: ${normalizedSql}`)
      }

      let result = rows
      const startDate = params[0] && /^\d{4}-\d{2}-\d{2}$/.test(String(params[0])) ? String(params[0]) : null
      const hasEndDate = normalizedSql.includes('planned_date <= ?')
      const endDate = hasEndDate
        ? String(params[startDate ? 1 : 0] || '')
        : null

      if (startDate) {
        result = result.filter(row => String(row.planned_date) >= startDate)
      }
      if (endDate) {
        result = result.filter(row => String(row.planned_date) <= endDate)
      }
      if (normalizedSql.includes('commercial_code IN')) {
        const commercialParams = params.filter(value => /^[A-Z0-9]+$/i.test(String(value)) && !/^\d{4}-\d{2}-\d{2}$/.test(String(value)))
        result = result.filter(row => commercialParams.includes(String(row.commercial_code)))
      }

      return result.map(clone)
    }
  }
}

function createFeedbackRow({
  plannedVisitId,
  clientCode,
  commercialCode,
  plannedDate,
  executionStatus = 'pending',
  purchaseMade = null,
  actualCa = null,
  actualQuantity = null,
  snapshot = {}
}) {
  return {
    planned_visit_id: plannedVisitId,
    assigned_slot_id: `${plannedDate}::${commercialCode}`,
    client_id: clientCode,
    client_code: clientCode,
    commercial_code: commercialCode,
    planned_date: plannedDate,
    execution_status: executionStatus,
    purchase_made: purchaseMade == null ? null : (purchaseMade ? 1 : 0),
    actual_ca: actualCa,
    actual_quantity: actualQuantity,
    visit_date_actual: null,
    note: null,
    non_visit_reason: null,
    no_purchase_reason: null,
    prediction_snapshot_json: JSON.stringify({
      predicted_ca: snapshot.predicted_ca ?? null,
      predicted_ca_if_buy: snapshot.predicted_ca_if_buy ?? null,
      recommended_quantity: snapshot.recommended_quantity ?? null,
      predicted_quantity_if_buy: snapshot.predicted_quantity_if_buy ?? null,
      priority: snapshot.priority ?? null,
      portfolio_status: snapshot.portfolio_status ?? null,
      planned_date: plannedDate,
      basket_prediction_source: snapshot.basket_prediction_source ?? null,
      recommended_products: snapshot.recommended_products ?? []
    }),
    created_at: '2026-08-10 09:00:00',
    updated_at: '2026-08-10 09:00:00'
  }
}

test('visited purchase with actual values computes expected, conditional and quantity errors with exact string codes preserved', () => {
  const detail = buildSalesVisitMonitoringDetail(createFeedbackRow({
    plannedVisitId: 'sv2_visit_a',
    clientCode: '00012',
    commercialCode: 'VL1900',
    plannedDate: '2026-08-10',
    executionStatus: 'visited',
    purchaseMade: true,
    actualCa: 120,
    actualQuantity: 8,
    snapshot: {
      predicted_ca: 100,
      predicted_ca_if_buy: 150,
      recommended_quantity: 6,
      predicted_quantity_if_buy: 10,
      portfolio_status: 'due_now'
    }
  }))

  assert.equal(detail.client_code, '00012')
  assert.equal(detail.commercial_code, 'VL1900')
  assert.equal(detail.predicted.expected_visit_ca, 100)
  assert.equal(detail.predicted.ca_if_buy, 150)
  assert.equal(detail.predicted.estimated_quantity, 6)
  assert.equal(detail.predicted.quantity_if_buy, 10)
  assert.equal(detail.actual.actual_ca, 120)
  assert.equal(detail.actual.actual_quantity, 8)
  assert.equal(detail.comparison.expected_ca_error, -20)
  assert.equal(detail.comparison.conditional_ca_error, 30)
  assert.equal(detail.comparison.quantity_error, 2)
})

test('visited without purchase uses realized visit value 0 only for expected visit CA comparison and excludes conditional metrics', async () => {
  const { queryAsync } = createMonitoringQueryAsyncMock([
    createFeedbackRow({
      plannedVisitId: 'sv2_visit_np',
      clientCode: '00959',
      commercialCode: 'C01',
      plannedDate: '2026-08-10',
      executionStatus: 'visited',
      purchaseMade: false,
      snapshot: {
        predicted_ca: 40,
        predicted_ca_if_buy: 80,
        recommended_quantity: 3,
        predicted_quantity_if_buy: 5,
        portfolio_status: 'due_soon'
      }
    })
  ])

  const monitoring = await getSalesVisitFeedbackMonitoring(queryAsync, {})
  assert.equal(monitoring.summary.execution.visited, 1)
  assert.equal(monitoring.summary.purchase.no_purchase, 1)
  assert.equal(monitoring.summary.ca_expected.comparable_count, 1)
  assert.equal(monitoring.summary.ca_expected.mae, 40)
  assert.equal(monitoring.summary.ca_expected.bias, 40)
  assert.equal(monitoring.summary.ca_expected.mape_valid_count, 0)
  assert.equal(monitoring.summary.ca_expected.mape, null)
  assert.equal(monitoring.summary.ca_if_buy.comparable_count, 0)
  assert.equal(monitoring.summary.quantity.comparable_count, 0)
})

test('visited purchase with actual_ca null is excluded from CA error metrics and null stays null in details', async () => {
  const row = createFeedbackRow({
    plannedVisitId: 'sv2_visit_null',
    clientCode: '00077',
    commercialCode: 'C02',
    plannedDate: '2026-08-11',
    executionStatus: 'visited',
    purchaseMade: true,
    actualCa: null,
    actualQuantity: null,
    snapshot: {
      predicted_ca: 50,
      predicted_ca_if_buy: 70,
      predicted_quantity_if_buy: 4
    }
  })
  const detail = buildSalesVisitMonitoringDetail(row)
  assert.equal(detail.actual.actual_ca, null)
  assert.equal(detail.actual.actual_quantity, null)
  assert.equal(detail.comparison.expected_ca_error, null)
  assert.equal(detail.comparison.conditional_ca_error, null)
  assert.equal(detail.comparison.quantity_error, null)

  const { queryAsync } = createMonitoringQueryAsyncMock([row])
  const monitoring = await getSalesVisitFeedbackMonitoring(queryAsync, {})
  assert.equal(monitoring.summary.ca_expected.comparable_count, 0)
  assert.equal(monitoring.summary.ca_if_buy.comparable_count, 0)
  assert.equal(monitoring.summary.quantity.comparable_count, 0)
})

test('pending and not_visited visits are excluded from prediction error metrics while execution counts remain correct', async () => {
  const { queryAsync } = createMonitoringQueryAsyncMock([
    createFeedbackRow({
      plannedVisitId: 'sv2_visit_pending',
      clientCode: '00001',
      commercialCode: 'C01',
      plannedDate: '2026-08-12',
      executionStatus: 'pending',
      snapshot: { predicted_ca: 10 }
    }),
    createFeedbackRow({
      plannedVisitId: 'sv2_visit_not_visited',
      clientCode: '00002',
      commercialCode: 'C01',
      plannedDate: '2026-08-12',
      executionStatus: 'not_visited',
      snapshot: { predicted_ca: 20 }
    })
  ])

  const monitoring = await getSalesVisitFeedbackMonitoring(queryAsync, {})
  assert.deepEqual(monitoring.summary.execution, {
    planned: 2,
    visited: 0,
    not_visited: 1,
    pending: 1,
    execution_rate: 0
  })
  assert.equal(monitoring.summary.ca_expected.comparable_count, 0)
  assert.equal(monitoring.summary.ca_if_buy.comparable_count, 0)
  assert.equal(monitoring.summary.quantity.comparable_count, 0)
})

test('aggregation works overall, by commercial and by planning date with correct bias sign and read-only behavior', async () => {
  const { queryAsync, queries, rows } = createMonitoringQueryAsyncMock([
    createFeedbackRow({
      plannedVisitId: 'sv2_visit_1',
      clientCode: '00100',
      commercialCode: 'C01',
      plannedDate: '2026-08-10',
      executionStatus: 'visited',
      purchaseMade: true,
      actualCa: 120,
      actualQuantity: 10,
      snapshot: {
        predicted_ca: 100,
        predicted_ca_if_buy: 130,
        predicted_quantity_if_buy: 8,
        recommended_quantity: 7,
        portfolio_status: 'due_now',
        basket_prediction_source: 'historical_pattern'
      }
    }),
    createFeedbackRow({
      plannedVisitId: 'sv2_visit_2',
      clientCode: '00101',
      commercialCode: 'C01',
      plannedDate: '2026-08-10',
      executionStatus: 'visited',
      purchaseMade: false,
      snapshot: {
        predicted_ca: 50,
        predicted_ca_if_buy: 90,
        predicted_quantity_if_buy: 5,
        portfolio_status: 'due_now',
        basket_prediction_source: 'historical_pattern'
      }
    }),
    createFeedbackRow({
      plannedVisitId: 'sv2_visit_3',
      clientCode: '00102',
      commercialCode: 'C02',
      plannedDate: '2026-08-11',
      executionStatus: 'visited',
      purchaseMade: true,
      actualCa: 40,
      actualQuantity: 5,
      snapshot: {
        predicted_ca: 60,
        predicted_ca_if_buy: 55,
        predicted_quantity_if_buy: 7,
        portfolio_status: 'exploration_needed',
        basket_prediction_source: 'model'
      }
    })
  ])

  const before = clone(rows)
  const monitoring = await getSalesVisitFeedbackMonitoring(queryAsync, {
    start_date: '2026-08-10',
    end_date: '2026-08-11'
  })

  assert.ok(queries.length >= 1)
  assert.ok(queries.every(entry => entry.sql.startsWith('SELECT ')))
  assert.deepEqual(rows, before)

  assert.equal(monitoring.summary.execution.planned, 3)
  assert.equal(monitoring.summary.execution.visited, 3)
  assert.equal(monitoring.summary.purchase.comparable_visits, 3)
  assert.equal(monitoring.summary.purchase.purchases, 2)
  assert.equal(monitoring.summary.purchase.no_purchase, 1)
  assert.equal(monitoring.summary.purchase.conversion_rate, 0.666667)

  assert.equal(monitoring.summary.ca_expected.comparable_count, 3)
  assert.equal(monitoring.summary.ca_expected.mae, 30)
  assert.equal(monitoring.summary.ca_expected.bias, 16.666667)
  assert.equal(monitoring.summary.ca_expected.mape_valid_count, 2)
  assert.equal(monitoring.summary.ca_expected.mape, 0.333333)

  assert.equal(monitoring.summary.ca_if_buy.comparable_count, 2)
  assert.equal(monitoring.summary.ca_if_buy.mae, 12.5)
  assert.equal(monitoring.summary.ca_if_buy.bias, 12.5)
  assert.equal(monitoring.summary.ca_if_buy.mape_valid_count, 2)
  assert.equal(monitoring.summary.ca_if_buy.mape, 0.229167)

  assert.equal(monitoring.summary.quantity.comparable_count, 2)
  assert.equal(monitoring.summary.quantity.mae, 2)
  assert.equal(monitoring.summary.quantity.bias, 0)

  assert.equal(monitoring.segmented.by_commercial.C01.ca_expected.comparable_count, 2)
  assert.equal(monitoring.segmented.by_commercial.C02.ca_expected.comparable_count, 1)
  assert.equal(monitoring.segmented.by_planning_date['2026-08-10'].ca_expected.comparable_count, 2)
  assert.equal(monitoring.segmented.by_planning_date['2026-08-11'].ca_expected.comparable_count, 1)
  assert.equal(monitoring.segmented.by_portfolio_status.due_now.ca_expected.comparable_count, 2)
  assert.equal(monitoring.segmented.by_prediction_source.historical_pattern.ca_expected.comparable_count, 2)
  assert.equal(monitoring.segmented.by_prediction_source.model.ca_expected.comparable_count, 1)
})

test('details endpoint preserves nulls and filters by commercial code', async () => {
  const { queryAsync } = createMonitoringQueryAsyncMock([
    createFeedbackRow({
      plannedVisitId: 'sv2_visit_keep',
      clientCode: '00011',
      commercialCode: 'C01',
      plannedDate: '2026-08-10',
      executionStatus: 'visited',
      purchaseMade: true,
      actualCa: 10,
      actualQuantity: null,
      snapshot: {
        predicted_ca: null,
        predicted_ca_if_buy: 11,
        recommended_quantity: null,
        predicted_quantity_if_buy: null,
        basket_prediction_source: null
      }
    }),
    createFeedbackRow({
      plannedVisitId: 'sv2_visit_drop',
      clientCode: '00012',
      commercialCode: 'C02',
      plannedDate: '2026-08-10',
      executionStatus: 'pending',
      snapshot: {
        predicted_ca: 22
      }
    })
  ])

  const details = await getSalesVisitFeedbackMonitoringDetails(queryAsync, {
    commercial_codes: ['C01']
  })

  assert.equal(details.row_count, 1)
  assert.equal(details.rows[0].planned_visit_id, 'sv2_visit_keep')
  assert.equal(details.rows[0].predicted.expected_visit_ca, null)
  assert.equal(details.rows[0].predicted.estimated_quantity, null)
  assert.equal(details.rows[0].actual.actual_quantity, null)
  assert.equal(details.rows[0].comparison.expected_ca_error, null)
  assert.equal(details.rows[0].comparison.quantity_error, null)
})

const test = require('node:test')
const assert = require('node:assert/strict')

const { __testables: serverTestables } = require('../server')

test.after(async () => {
  await serverTestables.closeOpenHandles()
})

function buildTourneeRow(overrides = {}) {
  return {
    client_code: '00152',
    client_id: '101',
    client_name: 'Client 00152',
    adresse: 'Adresse 1',
    latitude: 36.8,
    longitude: 10.1,
    rang: 1,
    tour_date: '2026-08-25',
    commercial_code: 'C01',
    route_code: 'C01',
    depot_code: 'DEP1',
    ...overrides
  }
}

function buildFeedbackRow(overrides = {}) {
  return {
    planned_visit_id: 'sv2_visit_abc',
    assigned_slot_id: '2026-08-25::C01',
    client_id: '101',
    client_code: '00152',
    commercial_code: 'C01',
    planned_date: '2026-08-25',
    tournee_code: 'sales-v2-20260825-C01',
    execution_status: 'pending',
    purchase_made: null,
    actual_ca: null,
    actual_quantity: null,
    visit_date_actual: null,
    note: null,
    non_visit_reason: null,
    no_purchase_reason: null,
    prediction_snapshot_json: JSON.stringify({
      predicted_ca: 150,
      predicted_ca_if_buy: 200,
      recommended_quantity: 6,
      predicted_quantity_if_buy: 8,
      purchase_probability: 65,
      portfolio_status: 'due_now',
      basket_prediction_source: 'model',
      recommended_products: [{ product_code: 'P1' }]
    }),
    created_at: '2026-08-24 10:00:00',
    updated_at: '2026-08-24 10:00:00',
    ...overrides
  }
}

function buildHeaderRow(overrides = {}) {
  return {
    id: 1,
    tournee_code: 'sales-v2-20260825-C01',
    commercial_code: 'C01',
    tour_type: 'sales_v2',
    planned_date: '2026-08-25',
    route_code: 'C01',
    depot_code: 'DEP1',
    clients_count: 2,
    status: 'validated',
    replaced_by_tournee_code: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-08-24 10:00:00',
    updated_at: '2026-08-24 10:00:00',
    ...overrides
  }
}

function buildHeaderQueryExecutor(headerRows) {
  return async (sql, params = []) => {
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim()

    if (normalizedSql.startsWith('SELECT * FROM sales_v2_validated_tours WHERE tour_type = ?')) {
      let filtered = headerRows.filter(row => row.tour_type === params[0] && row.status !== 'replaced')
      let paramIndex = 1
      if (normalizedSql.includes('planned_date = ?')) {
        filtered = filtered.filter(row => row.planned_date === params[paramIndex])
        paramIndex += 1
      }
      if (normalizedSql.includes('commercial_code = ?')) {
        filtered = filtered.filter(row => row.commercial_code === params[paramIndex])
        paramIndex += 1
      }
      if (normalizedSql.includes('tournee_code LIKE ?')) {
        const needle = String(params[paramIndex]).replace(/%/g, '')
        filtered = filtered.filter(row => row.tournee_code.includes(needle))
      }
      return filtered.map(row => ({ ...row }))
    }

    if (normalizedSql.startsWith('SELECT * FROM sales_v2_validated_tours WHERE tournee_code = ? ORDER BY id DESC LIMIT 1')) {
      const matches = headerRows.filter(row => row.tournee_code === params[0]).sort((a, b) => b.id - a.id)
      return matches.length ? [{ ...matches[0] }] : []
    }

    throw new Error(`Unexpected SQL in header harness: ${normalizedSql}`)
  }
}

test('fetchValidatedSalesTours reads the active headers from sales_v2_validated_tours and excludes replaced ones', async () => {
  const headerRows = [
    buildHeaderRow({ id: 1, tournee_code: 'sales-v2-20260825-C01', status: 'validated' }),
    buildHeaderRow({ id: 2, tournee_code: 'sales-v2-20260824-C01', planned_date: '2026-08-24', status: 'replaced' })
  ]
  const queryExecutor = buildHeaderQueryExecutor(headerRows)

  const tours = await serverTestables.fetchValidatedSalesTours(
    { date: '2026-08-25', commercialCode: 'C01', tourneeCode: 'sales-v2' },
    queryExecutor
  )

  assert.deepEqual(tours, [
    {
      tournee_code: 'sales-v2-20260825-C01',
      date: '2026-08-25',
      commercial_code: 'C01',
      route_code: 'C01',
      depot_code: 'DEP1',
      clients_count: 2,
      status: 'validated',
      started_at: null,
      completed_at: null
    }
  ])
})

test('fetchValidatedSalesTours returns an empty list without throwing when nothing matches', async () => {
  const queryExecutor = buildHeaderQueryExecutor([])
  const tours = await serverTestables.fetchValidatedSalesTours({ date: '2099-01-01' }, queryExecutor)
  assert.deepEqual(tours, [])
})

test('fetchValidatedSalesTourDetail merges tournees stops with feedback, preserves visit order and exposes the header status', async () => {
  const headerRows = [buildHeaderRow({ status: 'in_progress', started_at: '2026-08-25 08:00:00' })]
  const tourneeRows = [
    buildTourneeRow({ client_code: '00152', client_id: '101', rang: 1 }),
    buildTourneeRow({ client_code: '152', client_id: '102', client_name: 'Client 152', rang: 2, adresse: 'Adresse 2', latitude: 36.81, longitude: 10.11 })
  ]
  const feedbackRows = [
    buildFeedbackRow({ planned_visit_id: 'sv2_visit_1', client_code: '00152', client_id: '101' }),
    buildFeedbackRow({
      planned_visit_id: 'sv2_visit_2',
      client_code: '152',
      client_id: '102',
      execution_status: 'visited',
      purchase_made: 1,
      actual_ca: 180,
      actual_quantity: 7
    })
  ]
  const headerQueryExecutor = buildHeaderQueryExecutor(headerRows)

  const queryExecutor = async (sql, params) => {
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim()
    if (normalizedSql.startsWith('SELECT * FROM sales_v2_validated_tours')) {
      return headerQueryExecutor(sql, params)
    }
    if (normalizedSql.includes('FROM tournees') && normalizedSql.includes('ORDER BY rang')) {
      return tourneeRows
    }
    if (normalizedSql.includes('FROM sales_v2_visit_feedback') && normalizedSql.includes('WHERE tournee_code = ?')) {
      return feedbackRows
    }
    throw new Error(`Unexpected SQL in test: ${normalizedSql}`)
  }

  const detail = await serverTestables.fetchValidatedSalesTourDetail('sales-v2-20260825-C01', queryExecutor)

  assert.equal(detail.tournee_code, 'sales-v2-20260825-C01')
  assert.equal(detail.date, '2026-08-25')
  assert.equal(detail.commercial_code, 'C01')
  assert.equal(detail.status, 'in_progress')
  assert.equal(detail.started_at, '2026-08-25 08:00:00')
  assert.equal(detail.clients_count, 2)
  assert.equal(detail.stops.length, 2)

  assert.deepEqual(detail.stops.map(stop => stop.client_code), ['00152', '152'])
  assert.deepEqual(detail.stops.map(stop => stop.rang), [1, 2])

  const [firstStop, secondStop] = detail.stops
  assert.equal(firstStop.planned_visit_id, 'sv2_visit_1')
  assert.equal(firstStop.execution_status, 'pending')
  assert.equal(firstStop.predicted_ca, 150)
  assert.equal(firstStop.recommended_quantity, 6)
  assert.equal(firstStop.purchase_probability, 65)
  assert.equal(firstStop.adresse, 'Adresse 1')

  assert.equal(secondStop.execution_status, 'visited')
  assert.equal(secondStop.purchase_made, true)
  assert.equal(secondStop.actual_ca, 180)
  assert.equal(secondStop.actual_quantity, 7)
  assert.equal(secondStop.adresse, 'Adresse 2')
})

test('fetchValidatedSalesTourDetail rejects a blank tournee code before querying', async () => {
  await assert.rejects(
    () => serverTestables.fetchValidatedSalesTourDetail('   ', async () => {
      throw new Error('should not query')
    }),
    error => error.statusCode === 400
  )
})

test('fetchValidatedSalesTourDetail returns a 404-flagged error when the tournee code is unknown', async () => {
  const queryExecutor = buildHeaderQueryExecutor([])

  await assert.rejects(
    () => serverTestables.fetchValidatedSalesTourDetail('sales-v2-unknown', queryExecutor),
    error => error.statusCode === 404 && /Aucune tournee validee/.test(error.message)
  )
})

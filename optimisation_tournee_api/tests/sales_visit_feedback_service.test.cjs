const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildPlannedVisitMetadata,
  fetchSalesVisitFeedbackRecords,
  replacePendingSalesVisitFeedbackForTournee,
  upsertSalesVisitFeedback
} = require('../sales_visit_feedback_service')
const {
  __testables: {
    enrichPayloadWithPlannedVisitMetadata
  }
} = require('../next_best_visit_service')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createFeedbackQueryAsyncMock() {
  const rows = []
  let autoIncrement = 1

  return {
    rows,
    queryAsync: async (sql, params = []) => {
      const normalizedSql = String(sql)
      if (normalizedSql.includes('FROM sales_v2_visit_feedback') && normalizedSql.includes('WHERE planned_visit_id IN')) {
        const ids = params.map(value => String(value))
        return rows.filter(row => ids.includes(row.planned_visit_id)).map(clone)
      }

      if (normalizedSql.includes('FROM sales_v2_visit_feedback') && normalizedSql.includes('WHERE planned_visit_id = ?')) {
        const plannedVisitId = String(params[0] || '')
        const row = rows.find(entry => entry.planned_visit_id === plannedVisitId)
        return row ? [clone(row)] : []
      }

      if (normalizedSql.includes('FROM sales_v2_visit_feedback') && normalizedSql.includes('WHERE tournee_code = ?')) {
        const tourneeCode = String(params[0] || '')
        return rows.filter(entry => entry.tournee_code === tourneeCode).map(clone)
      }

      if (normalizedSql.includes('DELETE FROM sales_v2_visit_feedback') && normalizedSql.includes('WHERE tournee_code = ?')) {
        const tourneeCode = String(params[0] || '')
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (rows[index].tournee_code === tourneeCode && rows[index].execution_status === 'pending') {
            rows.splice(index, 1)
          }
        }
        return { affectedRows: 1 }
      }

      if (normalizedSql.includes('INSERT INTO sales_v2_visit_feedback')) {
        const now = '2026-08-10 09:00:00'
        const [
          planned_visit_id,
          assigned_slot_id,
          client_id,
          client_code,
          commercial_code,
          planned_date,
          tournee_code,
          execution_status,
          purchase_made,
          actual_ca,
          actual_quantity,
          visit_date_actual,
          note,
          non_visit_reason,
          no_purchase_reason,
          prediction_snapshot_json
        ] = params

        rows.push({
          id: autoIncrement++,
          planned_visit_id,
          assigned_slot_id,
          client_id,
          client_code,
          commercial_code,
          planned_date,
          tournee_code,
          execution_status,
          purchase_made,
          actual_ca,
          actual_quantity,
          visit_date_actual,
          note,
          non_visit_reason,
          no_purchase_reason,
          prediction_snapshot_json,
          created_at: now,
          updated_at: now
        })
        return { insertId: autoIncrement - 1 }
      }

      if (normalizedSql.includes('UPDATE sales_v2_visit_feedback')) {
        const plannedVisitId = String(params[8] || '')
        const row = rows.find(entry => entry.planned_visit_id === plannedVisitId)
        if (!row) {
          return { affectedRows: 0 }
        }
        row.execution_status = params[0]
        row.purchase_made = params[1]
        row.actual_ca = params[2]
        row.actual_quantity = params[3]
        row.visit_date_actual = params[4]
        row.note = params[5]
        row.non_visit_reason = params[6]
        row.no_purchase_reason = params[7]
        row.updated_at = '2026-08-10 09:05:00'
        return { affectedRows: 1 }
      }

      throw new Error(`Unexpected SQL in test mock: ${normalizedSql}`)
    }
  }
}

test('planned visit metadata adds a stable visit reference and immutable prediction snapshot', () => {
  const payload = enrichPayloadWithPlannedVisitMetadata({
    blocks: [
      {
        slot_id: '2026-08-10::VL1900',
        commercial_code: 'VL1900',
        date: '2026-08-10',
        clients: [
          {
            client_id: '3406',
            client_code: '00959',
            commercial_code: 'VL1900',
            predicted_ca: 136.6,
            predicted_ca_if_buy: 150.2,
            recommended_quantity: 2,
            predicted_quantity_if_buy: 3.4,
            purchase_prediction_score: 41.3,
            portfolio_status: 'due_now',
            basket_prediction_source: 'historical_pattern',
            recommended_products: [
              {
                product_code: 'BISKREM',
                product_label: 'BISKREM',
                estimated_quantity: 2,
                prediction_source: 'historical_pattern',
                confidence_or_support: 3
              }
            ]
          }
        ]
      }
    ]
  })

  const client = payload.blocks[0].clients[0]
  assert.equal(typeof client.planned_visit_id, 'string')
  assert.equal(client.client_code, '00959')
  assert.equal(client.assigned_slot_id, '2026-08-10::VL1900')
  assert.equal(client.assigned_date, '2026-08-10')
  assert.equal(client.prediction_snapshot.portfolio_status, 'due_now')
  assert.equal(client.prediction_snapshot.planned_date, '2026-08-10')
  assert.equal(client.prediction_snapshot.recommended_products[0].product_code, 'BISKREM')
})

test('feedback upsert keeps one state per planned visit and preserves exact codes', async () => {
  const { queryAsync, rows } = createFeedbackQueryAsyncMock()
  const metadata = buildPlannedVisitMetadata({
    assigned_slot_id: '2026-08-10::C01',
    client_id: '42',
    client_code: '00152',
    commercial_code: 'C01',
    planned_date: '2026-08-10',
    predicted_ca: 120,
    portfolio_status: 'due_now'
  })

  const firstSave = await upsertSalesVisitFeedback(queryAsync, {
    ...metadata,
    tournee_code: 'sales-v2-2026-08-10-C01',
    execution_status: 'pending'
  })
  const secondSave = await upsertSalesVisitFeedback(queryAsync, {
    ...metadata,
    tournee_code: 'sales-v2-2026-08-10-C01',
    execution_status: 'visited',
    purchase_made: true,
    actual_ca: 210.5,
    actual_quantity: 12
  })

  assert.equal(rows.length, 1)
  assert.equal(firstSave.client_code, '00152')
  assert.equal(secondSave.client_code, '00152')
  assert.equal(secondSave.commercial_code, 'C01')
  assert.equal(secondSave.execution_status, 'visited')
  assert.equal(secondSave.purchase_made, true)
  assert.equal(secondSave.actual_ca, 210.5)
  assert.equal(secondSave.actual_quantity, 12)
})

test('feedback supports pending to not_visited and visited with no purchase', async () => {
  const { queryAsync } = createFeedbackQueryAsyncMock()
  const metadata = buildPlannedVisitMetadata({
    assigned_slot_id: '2026-08-11::C02',
    client_id: '84',
    client_code: '00084',
    commercial_code: 'C02',
    planned_date: '2026-08-11',
    predicted_ca: 88,
    portfolio_status: 'due_soon'
  })

  const notVisited = await upsertSalesVisitFeedback(queryAsync, {
    ...metadata,
    tournee_code: 'sales-v2-2026-08-11-C02',
    execution_status: 'not_visited',
    non_visit_reason: 'Absence client'
  })
  const visitedNoPurchase = await upsertSalesVisitFeedback(queryAsync, {
    ...metadata,
    tournee_code: 'sales-v2-2026-08-11-C02',
    execution_status: 'visited',
    purchase_made: false,
    no_purchase_reason: 'Rupture budget'
  })

  assert.equal(notVisited.execution_status, 'not_visited')
  assert.equal(notVisited.purchase_made, null)
  assert.equal(notVisited.non_visit_reason, 'Absence client')
  assert.equal(visitedNoPurchase.execution_status, 'visited')
  assert.equal(visitedNoPurchase.purchase_made, false)
  assert.equal(visitedNoPurchase.no_purchase_reason, 'Rupture budget')
  assert.equal(visitedNoPurchase.actual_ca, null)
  assert.equal(visitedNoPurchase.actual_quantity, null)
})

test('feedback keeps null actual values and leaves the planning snapshot unchanged after updates', async () => {
  const { queryAsync } = createFeedbackQueryAsyncMock()
  const metadata = buildPlannedVisitMetadata({
    assigned_slot_id: '2026-08-12::C03',
    client_id: '126',
    client_code: '00126',
    commercial_code: 'C03',
    planned_date: '2026-08-12',
    predicted_ca: 75.5,
    predicted_ca_if_buy: 100.1,
    recommended_quantity: 4.5,
    predicted_quantity_if_buy: 6.2,
    purchase_prediction_score: 55,
    portfolio_status: 'exploration_needed'
  })

  await upsertSalesVisitFeedback(queryAsync, {
    ...metadata,
    tournee_code: 'sales-v2-2026-08-12-C03',
    execution_status: 'visited',
    purchase_made: true,
    actual_ca: null,
    actual_quantity: null
  })
  const updated = await upsertSalesVisitFeedback(queryAsync, {
    ...metadata,
    tournee_code: 'sales-v2-2026-08-12-C03',
    execution_status: 'visited',
    purchase_made: true,
    actual_ca: null,
    actual_quantity: null,
    prediction_snapshot: {
      portfolio_status: 'mutated'
    }
  })

  assert.equal(updated.actual_ca, null)
  assert.equal(updated.actual_quantity, null)
  assert.equal(updated.prediction_snapshot.portfolio_status, 'exploration_needed')
  assert.equal(updated.prediction_snapshot.predicted_ca, 75.5)
})

test('batch feedback read returns one record per planned visit id', async () => {
  const { queryAsync } = createFeedbackQueryAsyncMock()
  const visitA = buildPlannedVisitMetadata({
    assigned_slot_id: '2026-08-13::C01',
    client_id: '1',
    client_code: '00001',
    commercial_code: 'C01',
    planned_date: '2026-08-13'
  })
  const visitB = buildPlannedVisitMetadata({
    assigned_slot_id: '2026-08-13::C01',
    client_id: '2',
    client_code: '00002',
    commercial_code: 'C01',
    planned_date: '2026-08-13'
  })

  await upsertSalesVisitFeedback(queryAsync, {
    ...visitA,
    tournee_code: 'sales-v2-2026-08-13-C01',
    execution_status: 'pending'
  })
  await upsertSalesVisitFeedback(queryAsync, {
    ...visitB,
    tournee_code: 'sales-v2-2026-08-13-C01',
    execution_status: 'visited',
    purchase_made: false
  })

  const records = await fetchSalesVisitFeedbackRecords(queryAsync, {
    plannedVisitIds: [visitA.planned_visit_id, visitB.planned_visit_id]
  })

  assert.equal(records.length, 2)
  assert.deepEqual(
    records.map(record => record.planned_visit_id).sort(),
    [visitA.planned_visit_id, visitB.planned_visit_id].sort()
  )
})

test('feedback read preserves planned_date when the database returns DATE values as Date objects', async () => {
  const metadata = buildPlannedVisitMetadata({
    assigned_slot_id: '2026-08-14::C04',
    client_id: '204',
    client_code: '00204',
    commercial_code: 'C04',
    planned_date: '2026-08-14',
    predicted_ca: 44.2,
    portfolio_status: 'due_now'
  })

  const queryAsync = async (sql, params = []) => {
    const normalizedSql = String(sql)
    if (normalizedSql.includes('planned_visit_id IN')) {
      return [{
        planned_visit_id: params[0],
        assigned_slot_id: metadata.assigned_slot_id,
        client_id: metadata.client_id,
        client_code: metadata.client_code,
        commercial_code: metadata.commercial_code,
        planned_date: new Date(2026, 7, 14),
        execution_status: 'visited',
        purchase_made: 1,
        actual_ca: 55.5,
        actual_quantity: 6,
        visit_date_actual: null,
        note: null,
        non_visit_reason: null,
        no_purchase_reason: null,
        prediction_snapshot_json: JSON.stringify(metadata.prediction_snapshot),
        created_at: '2026-08-10 09:00:00',
        updated_at: '2026-08-10 09:05:00'
      }]
    }
    throw new Error(`Unexpected SQL in test mock: ${normalizedSql}`)
  }

  const [record] = await fetchSalesVisitFeedbackRecords(queryAsync, {
    plannedVisitIds: [metadata.planned_visit_id]
  })

  assert.equal(record.planned_date, '2026-08-14')
  assert.equal(record.client_code, '00204')
  assert.equal(record.commercial_code, 'C04')
})

test('feedback update-only refuses an unknown planned visit without insertion', async () => {
  const { queryAsync, rows } = createFeedbackQueryAsyncMock()
  const metadata = buildPlannedVisitMetadata({
    assigned_slot_id: '2026-08-15::C05',
    client_id: '205',
    client_code: '00205',
    commercial_code: 'C05',
    planned_date: '2026-08-15'
  })

  await assert.rejects(
    () => upsertSalesVisitFeedback(queryAsync, {
      ...metadata,
      execution_status: 'visited',
      purchase_made: true
    }, metadata.planned_visit_id, { updateOnly: true }),
    error => error?.statusCode === 404 && /Aucun feedback Sales V2 valide/.test(error.message)
  )
  assert.equal(rows.length, 0)
})

test('feedback update preserves identity, tournee_code and immutable prediction snapshot', async () => {
  const { queryAsync, rows } = createFeedbackQueryAsyncMock()
  const metadata = buildPlannedVisitMetadata({
    assigned_slot_id: '2026-08-16::C06',
    client_id: '206',
    client_code: '00206',
    commercial_code: 'C06',
    planned_date: '2026-08-16',
    predicted_ca: 96.4,
    portfolio_status: 'due_now'
  })

  await replacePendingSalesVisitFeedbackForTournee(queryAsync, {
    tournee_code: 'sales-v2-2026-08-16-C06',
    visits: [metadata]
  })
  const updated = await upsertSalesVisitFeedback(queryAsync, {
    planned_visit_id: metadata.planned_visit_id,
    client_id: metadata.client_id,
    client_code: metadata.client_code,
    commercial_code: metadata.commercial_code,
    planned_date: metadata.planned_date,
    execution_status: 'visited',
    purchase_made: false,
    no_purchase_reason: 'Budget reporte',
    prediction_snapshot: {
      portfolio_status: 'mutated'
    }
  }, metadata.planned_visit_id, { updateOnly: true })

  assert.equal(updated.client_id, metadata.client_id)
  assert.equal(updated.client_code, metadata.client_code)
  assert.equal(updated.commercial_code, metadata.commercial_code)
  assert.equal(updated.tournee_code, 'sales-v2-2026-08-16-C06')
  assert.equal(updated.prediction_snapshot.portfolio_status, 'due_now')
  assert.equal(rows.length, 1)
})

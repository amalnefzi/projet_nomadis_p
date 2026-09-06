const test = require('node:test')
const assert = require('node:assert/strict')

const {
  completeValidatedTour,
  listValidatedTourHeaders,
  markValidatedTourInProgress,
  replaceOrCreateValidatedTourHeader
} = require('../sales_v2_tour_lifecycle_service')

function createHeaderTableHarness() {
  const rows = []
  let autoIncrement = 1

  const queryExecutor = async (sql, params = []) => {
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim()

    if (normalizedSql.startsWith('SELECT * FROM sales_v2_validated_tours WHERE commercial_code = ? AND tour_type = ? AND planned_date = ? ORDER BY id DESC FOR UPDATE')) {
      const [commercialCode, tourType, plannedDate] = params
      return rows
        .filter(row => row.commercial_code === commercialCode && row.tour_type === tourType && row.planned_date === plannedDate)
        .sort((a, b) => b.id - a.id)
        .map(row => ({ ...row }))
    }

    if (normalizedSql.startsWith('UPDATE sales_v2_validated_tours SET status = \'replaced\'')) {
      const [replacedByTourneeCode, id] = params
      const row = rows.find(entry => entry.id === id)
      if (row) {
        row.status = 'replaced'
        row.replaced_by_tournee_code = replacedByTourneeCode
      }
      return { affectedRows: row ? 1 : 0 }
    }

    if (normalizedSql.startsWith('INSERT INTO sales_v2_validated_tours')) {
      const [tourneeCode, commercialCode, tourType, plannedDate, routeCode, depotCode, clientsCount] = params
      rows.push({
        id: autoIncrement++,
        tournee_code: tourneeCode,
        commercial_code: commercialCode,
        tour_type: tourType,
        planned_date: plannedDate,
        route_code: routeCode,
        depot_code: depotCode,
        clients_count: clientsCount,
        status: 'validated',
        replaced_by_tournee_code: null,
        started_at: null,
        completed_at: null,
        created_at: '2026-09-05 10:00:00',
        updated_at: '2026-09-05 10:00:00'
      })
      return { insertId: autoIncrement - 1 }
    }

    if (normalizedSql.startsWith('SELECT * FROM sales_v2_validated_tours WHERE tournee_code = ? ORDER BY id DESC LIMIT 1')) {
      const [tourneeCode] = params
      const matches = rows.filter(row => row.tournee_code === tourneeCode).sort((a, b) => b.id - a.id)
      return matches.length ? [{ ...matches[0] }] : []
    }

    if (normalizedSql.startsWith('UPDATE sales_v2_validated_tours SET status = \'in_progress\'')) {
      const [tourneeCode] = params
      const row = rows.find(entry => entry.tournee_code === tourneeCode && entry.status === 'validated')
      if (row) {
        row.status = 'in_progress'
        row.started_at = row.started_at || '2026-09-05 11:00:00'
      }
      return { affectedRows: row ? 1 : 0 }
    }

    if (normalizedSql.startsWith('UPDATE sales_v2_validated_tours SET status = \'completed\'')) {
      const [tourneeCode] = params
      const row = rows.find(entry => entry.tournee_code === tourneeCode && (entry.status === 'validated' || entry.status === 'in_progress'))
      if (row) {
        row.status = 'completed'
        row.completed_at = '2026-09-05 12:00:00'
      }
      return { affectedRows: row ? 1 : 0 }
    }

    if (normalizedSql.startsWith('SELECT * FROM sales_v2_validated_tours WHERE tour_type = ?')) {
      let filtered = rows.filter(row => row.tour_type === params[0] && row.status !== 'replaced')
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

    throw new Error(`Unexpected SQL in lifecycle harness: ${normalizedSql}`)
  }

  return { rows, queryExecutor }
}

test('replaceOrCreateValidatedTourHeader creates the first header row as validated', async () => {
  const harness = createHeaderTableHarness()

  const result = await replaceOrCreateValidatedTourHeader(harness.queryExecutor, {
    tourneeCode: 'sales-v2-20260905-C01',
    commercialCode: 'C01',
    plannedDate: '2026-09-05',
    routeCode: 'C01',
    depotCode: 'DEP1',
    clientsCount: 5
  })

  assert.equal(result.tourneeCode, 'sales-v2-20260905-C01')
  assert.equal(result.replacedTourneeCode, null)
  assert.equal(harness.rows.length, 1)
  assert.equal(harness.rows[0].status, 'validated')
})

test('revalidating the same commercial/date/type replaces the previous unstarted version', async () => {
  const harness = createHeaderTableHarness()

  await replaceOrCreateValidatedTourHeader(harness.queryExecutor, {
    tourneeCode: 'sales-v2-20260905-C01',
    commercialCode: 'C01',
    plannedDate: '2026-09-05',
    clientsCount: 3
  })

  const secondResult = await replaceOrCreateValidatedTourHeader(harness.queryExecutor, {
    tourneeCode: 'sales-v2-20260905-C01',
    commercialCode: 'C01',
    plannedDate: '2026-09-05',
    clientsCount: 7
  })

  assert.equal(secondResult.replacedTourneeCode, 'sales-v2-20260905-C01')
  assert.equal(secondResult.previousStatus, 'validated')
  assert.equal(harness.rows.length, 2)
  assert.equal(harness.rows[0].status, 'replaced')
  assert.equal(harness.rows[0].replaced_by_tournee_code, 'sales-v2-20260905-C01')
  assert.equal(harness.rows[1].status, 'validated')
  assert.equal(harness.rows[1].clients_count, 7)

  const active = await listValidatedTourHeaders(harness.queryExecutor, { commercialCode: 'C01' })
  assert.equal(active.length, 1)
  assert.equal(active[0].status, 'validated')
  assert.equal(active[0].clientsCount, 7)
})

test('replacing a tournee that is already in progress is refused', async () => {
  const harness = createHeaderTableHarness()

  await replaceOrCreateValidatedTourHeader(harness.queryExecutor, {
    tourneeCode: 'sales-v2-20260905-C01',
    commercialCode: 'C01',
    plannedDate: '2026-09-05',
    clientsCount: 3
  })

  await markValidatedTourInProgress(harness.queryExecutor, 'sales-v2-20260905-C01')

  await assert.rejects(
    () => replaceOrCreateValidatedTourHeader(harness.queryExecutor, {
      tourneeCode: 'sales-v2-20260905-C01',
      commercialCode: 'C01',
      plannedDate: '2026-09-05',
      clientsCount: 9
    }),
    error => error.statusCode === 409 && /deja en cours d'execution/.test(error.message)
  )

  assert.equal(harness.rows.length, 1)
  assert.equal(harness.rows[0].status, 'in_progress')
  assert.equal(harness.rows[0].clients_count, 3)
})

test('markValidatedTourInProgress is idempotent and only moves validated tours', async () => {
  const harness = createHeaderTableHarness()
  await replaceOrCreateValidatedTourHeader(harness.queryExecutor, {
    tourneeCode: 'sales-v2-20260905-C01',
    commercialCode: 'C01',
    plannedDate: '2026-09-05',
    clientsCount: 3
  })

  const first = await markValidatedTourInProgress(harness.queryExecutor, 'sales-v2-20260905-C01')
  assert.equal(first.status, 'in_progress')
  const startedAt = first.startedAt

  const second = await markValidatedTourInProgress(harness.queryExecutor, 'sales-v2-20260905-C01')
  assert.equal(second.status, 'in_progress')
  assert.equal(second.startedAt, startedAt)
})

test('revalidating after completion keeps the completed tournee intact under a versioned new code', async () => {
  const harness = createHeaderTableHarness()

  const first = await replaceOrCreateValidatedTourHeader(harness.queryExecutor, {
    tourneeCode: 'sales-v2-20260905-C01',
    commercialCode: 'C01',
    plannedDate: '2026-09-05',
    clientsCount: 3
  })
  await markValidatedTourInProgress(harness.queryExecutor, 'sales-v2-20260905-C01')
  await completeValidatedTour(harness.queryExecutor, 'sales-v2-20260905-C01')

  const second = await replaceOrCreateValidatedTourHeader(harness.queryExecutor, {
    tourneeCode: 'sales-v2-20260905-C01',
    commercialCode: 'C01',
    plannedDate: '2026-09-05',
    clientsCount: 5
  })

  assert.equal(first.tourneeCode, 'sales-v2-20260905-C01')
  assert.equal(second.tourneeCode, 'sales-v2-20260905-C01-v2')
  assert.equal(second.replacedTourneeCode, null)

  const completedRow = harness.rows.find(row => row.tournee_code === 'sales-v2-20260905-C01')
  const newRow = harness.rows.find(row => row.tournee_code === 'sales-v2-20260905-C01-v2')
  assert.equal(completedRow.status, 'completed')
  assert.equal(completedRow.clients_count, 3)
  assert.equal(newRow.status, 'validated')
  assert.equal(newRow.clients_count, 5)

  const active = await listValidatedTourHeaders(harness.queryExecutor, { commercialCode: 'C01' })
  assert.equal(active.length, 2)
  assert.deepEqual(active.map(row => row.status).sort(), ['completed', 'validated'])
})

test('completeValidatedTour terminates the execution and stays idempotent on repeat calls', async () => {
  const harness = createHeaderTableHarness()
  await replaceOrCreateValidatedTourHeader(harness.queryExecutor, {
    tourneeCode: 'sales-v2-20260905-C01',
    commercialCode: 'C01',
    plannedDate: '2026-09-05',
    clientsCount: 3
  })
  await markValidatedTourInProgress(harness.queryExecutor, 'sales-v2-20260905-C01')

  const completed = await completeValidatedTour(harness.queryExecutor, 'sales-v2-20260905-C01')
  assert.equal(completed.status, 'completed')
  assert.ok(completed.completedAt)

  const completedAgain = await completeValidatedTour(harness.queryExecutor, 'sales-v2-20260905-C01')
  assert.equal(completedAgain.status, 'completed')
  assert.equal(completedAgain.completedAt, completed.completedAt)
})

test('completeValidatedTour rejects an unknown tournee code with 404', async () => {
  const harness = createHeaderTableHarness()
  await assert.rejects(
    () => completeValidatedTour(harness.queryExecutor, 'sales-v2-unknown'),
    error => error.statusCode === 404
  )
})

test('completing a tournee code that has been replaced completes the current active version', async () => {
  const harness = createHeaderTableHarness()
  await replaceOrCreateValidatedTourHeader(harness.queryExecutor, {
    tourneeCode: 'sales-v2-20260905-C01',
    commercialCode: 'C01',
    plannedDate: '2026-09-05',
    clientsCount: 3
  })
  await replaceOrCreateValidatedTourHeader(harness.queryExecutor, {
    tourneeCode: 'sales-v2-20260905-C01',
    commercialCode: 'C01',
    plannedDate: '2026-09-05',
    clientsCount: 4
  })

  assert.equal(harness.rows.filter(row => row.status === 'replaced').length, 1)

  const completed = await completeValidatedTour(harness.queryExecutor, 'sales-v2-20260905-C01')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.clientsCount, 4)

  const stillReplaced = harness.rows.find(row => row.status === 'replaced')
  assert.equal(stillReplaced.clients_count, 3)
})

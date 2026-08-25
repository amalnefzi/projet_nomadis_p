const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildPlannedVisitMetadata
} = require('../sales_visit_feedback_service')
const {
  __testables: serverTestables
} = require('../server')

test.after(async () => {
  await serverTestables.closeOpenHandles()
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function buildValidationRequest(overrides = {}) {
  const blockOverrides = overrides.block && typeof overrides.block === 'object'
    ? overrides.block
    : {}
  const rootOverrides = { ...overrides }
  delete rootOverrides.block

  return {
    block: {
      date: '2026-08-25',
      commercial_code: 'C01',
      commercial_label: 'Commercial 1',
      slot_id: '2026-08-25::C01',
      clients: [
        {
          planned_visit_id: 'frontend-should-be-ignored',
          client_id: '101',
          client_code: '00152',
          commercial_code: 'C01',
          assigned_date: '2026-08-25',
          client_name: 'Client 00152',
          adresse: 'Adresse 1',
          latitude: 36.8,
          longitude: 10.1,
          predicted_ca: 150,
          portfolio_status: 'due_now'
        },
        {
          planned_visit_id: 'frontend-should-also-be-ignored',
          client_id: '102',
          client_code: '152',
          commercial_code: 'C01',
          assigned_date: '2026-08-25',
          client_name: 'Client 152',
          adresse: 'Adresse 2',
          latitude: 36.81,
          longitude: 10.11,
          predicted_ca: 80,
          portfolio_status: 'due_soon'
        }
      ],
      ...blockOverrides
    },
    ...rootOverrides
  }
}

function createMockReq(body, { todayIsoForTests = '2026-08-24' } = {}) {
  return {
    body,
    app: {
      locals: {
        todayIsoForTests
      }
    }
  }
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

function createSalesV2ValidationHarness({ failOnFeedbackInsertForClientCode = null } = {}) {
  const tournees = []
  const feedback = []

  const queryAsync = async (sql, params = []) => {
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim()

    if (normalizedSql.includes('FROM clients c') && normalizedSql.includes('WHERE c.deleted_at IS NULL')) {
      const requestedCodes = new Set(params.map(value => String(value || '').trim()))
      const rows = []
      for (const clientCode of requestedCodes) {
        if (clientCode === '00152') {
          rows.push({ client_id: '101', client_code: '00152' })
        }
        if (clientCode === '152') {
          rows.push({ client_id: '102', client_code: '152' })
        }
      }
      return rows
    }

    if (normalizedSql.startsWith('DELETE FROM tournees')) {
      const [frequence, commercialCode, dateDebut, dateFin] = params
      for (let index = tournees.length - 1; index >= 0; index -= 1) {
        const row = tournees[index]
        if (
          row.frequence === frequence &&
          row.code_layer === commercialCode &&
          row.date_debut === dateDebut &&
          row.date_fin === dateFin
        ) {
          tournees.splice(index, 1)
        }
      }
      return { affectedRows: 1 }
    }

    if (normalizedSql.startsWith('INSERT INTO tournees')) {
      const [
        code,
        libelle,
        coordinates,
        code_jour,
        client_id,
        client_code,
        routing_code,
        depot_code,
        frequence,
        date_debut,
        date_fin,
        dates,
        rang,
        categorie_code,
        code_layer,
        type_client,
        rs_client_code,
        latitude,
        longitude,
        adresse,
        client
      ] = params

      tournees.push({
        code,
        libelle,
        coordinates,
        code_jour,
        client_id,
        client_code,
        routing_code,
        depot_code,
        frequence,
        date_debut,
        date_fin,
        dates,
        rang,
        categorie_code,
        code_layer,
        type_client,
        rs_client_code,
        latitude,
        longitude,
        adresse,
        client
      })
      return { insertId: tournees.length }
    }

    if (normalizedSql.includes('FROM sales_v2_visit_feedback') && normalizedSql.includes('WHERE tournee_code = ?')) {
      const tourneeCode = String(params[0] || '')
      return feedback.filter(row => row.tournee_code === tourneeCode).map(clone)
    }

    if (normalizedSql.includes('FROM sales_v2_visit_feedback') && normalizedSql.includes('WHERE planned_visit_id IN')) {
      const ids = new Set(params.map(value => String(value || '')))
      return feedback.filter(row => ids.has(row.planned_visit_id)).map(clone)
    }

    if (normalizedSql.includes('FROM sales_v2_visit_feedback') && normalizedSql.includes('WHERE planned_visit_id = ?')) {
      const plannedVisitId = String(params[0] || '')
      const row = feedback.find(entry => entry.planned_visit_id === plannedVisitId)
      return row ? [clone(row)] : []
    }

    if (normalizedSql.startsWith('DELETE FROM sales_v2_visit_feedback')) {
      const tourneeCode = String(params[0] || '')
      for (let index = feedback.length - 1; index >= 0; index -= 1) {
        if (feedback[index].tournee_code === tourneeCode && feedback[index].execution_status === 'pending') {
          feedback.splice(index, 1)
        }
      }
      return { affectedRows: 1 }
    }

    if (normalizedSql.startsWith('INSERT INTO sales_v2_visit_feedback')) {
      const now = '2026-08-24 10:00:00'
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

      if (client_code === failOnFeedbackInsertForClientCode) {
        const error = new Error(`Simulated insert failure for ${client_code}`)
        error.statusCode = 500
        throw error
      }

      feedback.push({
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
      return { insertId: feedback.length }
    }

    if (normalizedSql.startsWith('UPDATE sales_v2_visit_feedback')) {
      const plannedVisitId = String(params[8] || '')
      const row = feedback.find(entry => entry.planned_visit_id === plannedVisitId)
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
      row.updated_at = '2026-08-24 10:05:00'
      return { affectedRows: 1 }
    }

    throw new Error(`Unexpected SQL in validation harness: ${normalizedSql}`)
  }

  const withTransaction = async handler => {
    const snapshot = {
      tournees: clone(tournees),
      feedback: clone(feedback)
    }

    try {
      return await handler({ tx: true })
    } catch (error) {
      tournees.splice(0, tournees.length, ...snapshot.tournees)
      feedback.splice(0, feedback.length, ...snapshot.feedback)
      throw error
    }
  }

  return {
    tournees,
    feedback,
    dependencies: {
      queryAsync,
      withTransaction,
      fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial 1' }],
      ensureCoverageSupportTables: async () => {},
      ensureValidatedTourneeIdentityColumns: async () => {}
    }
  }
}

test('rebuilds canonical Sales V2 identities before planned_visit_id and keeps 00152 and 152 distinct', async () => {
  const harness = createSalesV2ValidationHarness()
  const request = buildValidationRequest({
    block: {
      clients: [
        {
          planned_visit_id: 'frontend-should-be-ignored',
          client_id: '999',
          client_code: '00152',
          commercial_code: 'WRONG',
          assigned_date: '2026-01-01',
          assigned_slot_id: 'wrong-slot',
          client_name: 'Client 00152',
          adresse: 'Adresse 1',
          latitude: 36.8,
          longitude: 10.1,
          predicted_ca: 150,
          portfolio_status: 'due_now'
        },
        {
          planned_visit_id: 'frontend-should-also-be-ignored',
          client_id: null,
          client_code: '152',
          commercial_code: 'C99',
          assigned_date: '2026-01-02',
          assigned_slot_id: 'wrong-slot-2',
          client_name: 'Client 152',
          adresse: 'Adresse 2',
          latitude: 36.81,
          longitude: 10.11,
          predicted_ca: 80,
          portfolio_status: 'due_soon'
        }
      ]
    }
  })

  const result = await serverTestables.validateNextBestVisitBlockPlan(
    request,
    harness.dependencies
  )

  const expectedVisitIds = request.block.clients.map((client, index) => (
    buildPlannedVisitMetadata({
      ...client,
      client_id: index === 0 ? '101' : '102',
      client_code: index === 0 ? '00152' : '152',
      commercial_code: 'C01',
      assigned_slot_id: '2026-08-25::C01',
      assigned_date: '2026-08-25',
      planned_date: '2026-08-25',
      candidate_date: '2026-08-25'
    }).planned_visit_id
  )).sort()

  assert.equal(result.status, 'success')
  assert.equal(result.saved_rows, 2)
  assert.equal(result.feedback_rows, 2)
  assert.equal(harness.tournees.length, 2)
  assert.equal(harness.feedback.length, 2)
  assert.ok(harness.feedback.every(row => row.execution_status === 'pending'))
  assert.equal(new Set(harness.feedback.map(row => row.client_code)).size, 2)
  assert.equal(harness.feedback.find(row => row.client_code === '00152').client_id, '101')
  assert.equal(harness.feedback.find(row => row.client_code === '152').client_id, '102')
  assert.ok(harness.feedback.every(row => row.tournee_code === result.tournee_code))
  assert.notEqual(harness.feedback[0].planned_visit_id, 'frontend-should-be-ignored')
  assert.deepEqual(
    harness.feedback.map(row => row.planned_visit_id).sort(),
    expectedVisitIds
  )
  assert.deepEqual(
    harness.feedback.map(row => ({
      client_id: row.client_id,
      client_code: row.client_code
    })).sort((left, right) => left.client_code.localeCompare(right.client_code)),
    harness.tournees.map(row => ({
      client_id: row.client_id,
      client_code: row.client_code
    })).sort((left, right) => left.client_code.localeCompare(right.client_code))
  )
})

test('repeating the same Sales V2 validation stays idempotent without duplicates', async () => {
  const harness = createSalesV2ValidationHarness()
  const request = buildValidationRequest()

  await serverTestables.validateNextBestVisitBlockPlan(request, harness.dependencies)
  const secondResult = await serverTestables.validateNextBestVisitBlockPlan(request, harness.dependencies)

  assert.equal(secondResult.status, 'success')
  assert.equal(harness.tournees.length, 2)
  assert.equal(harness.feedback.length, 2)
})

test('validation rolls back tournees and feedback completely when feedback insertion fails', async () => {
  const harness = createSalesV2ValidationHarness({
    failOnFeedbackInsertForClientCode: '152'
  })

  await assert.rejects(
    () => serverTestables.validateNextBestVisitBlockPlan(
      buildValidationRequest(),
      harness.dependencies
    ),
    /Simulated insert failure for 152/
  )

  assert.equal(harness.tournees.length, 0)
  assert.equal(harness.feedback.length, 0)
})

test('revalidation is refused once a terrain result exists for the block', async () => {
  const harness = createSalesV2ValidationHarness()
  const request = buildValidationRequest()

  await serverTestables.validateNextBestVisitBlockPlan(request, harness.dependencies)
  harness.feedback[0].execution_status = 'visited'

  await assert.rejects(
    () => serverTestables.validateNextBestVisitBlockPlan(request, harness.dependencies),
    error => error?.statusCode === 409 && /deja un retour terrain/.test(error.message)
  )
  assert.equal(harness.feedback.length, 2)
  assert.equal(harness.feedback[0].execution_status, 'visited')
})

test('validation route rejects an unknown commercial before any write', async () => {
  let ensureCoverageSupportTablesCalls = 0
  let ensureValidatedTourneeIdentityColumnsCalls = 0
  let withTransactionCalls = 0
  let queryAsyncCalls = 0

  const req = createMockReq(buildValidationRequest({
    block: {
      commercial_code: 'C99'
    }
  }))
  const res = createMockRes()

  await serverTestables.handleNextBestVisitValidationRoute(req, res, {
    fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial 1' }],
    ensureCoverageSupportTables: async () => {
      ensureCoverageSupportTablesCalls += 1
    },
    ensureValidatedTourneeIdentityColumns: async () => {
      ensureValidatedTourneeIdentityColumnsCalls += 1
    },
    withTransaction: async () => {
      withTransactionCalls += 1
      throw new Error('withTransaction should not be called')
    },
    queryAsync: async () => {
      queryAsyncCalls += 1
      return []
    }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.body.status, 'error')
  assert.match(res.body.message, /introuvable ou inactif: C99/)
  assert.equal(ensureCoverageSupportTablesCalls, 0)
  assert.equal(ensureValidatedTourneeIdentityColumnsCalls, 0)
  assert.equal(withTransactionCalls, 0)
  assert.equal(queryAsyncCalls, 0)
})

test('validation route rejects a past date before any write', async () => {
  let ensureCoverageSupportTablesCalls = 0
  let ensureValidatedTourneeIdentityColumnsCalls = 0
  let withTransactionCalls = 0
  let queryAsyncCalls = 0

  const req = createMockReq(buildValidationRequest({
    block: {
      date: '2026-08-23'
    }
  }))
  const res = createMockRes()

  await serverTestables.handleNextBestVisitValidationRoute(req, res, {
    fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial 1' }],
    ensureCoverageSupportTables: async () => {
      ensureCoverageSupportTablesCalls += 1
    },
    ensureValidatedTourneeIdentityColumns: async () => {
      ensureValidatedTourneeIdentityColumnsCalls += 1
    },
    withTransaction: async () => {
      withTransactionCalls += 1
      throw new Error('withTransaction should not be called')
    },
    queryAsync: async () => {
      queryAsyncCalls += 1
      return []
    }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.body.status, 'error')
  assert.match(res.body.message, /ne peut pas etre dans le passe/)
  assert.equal(ensureCoverageSupportTablesCalls, 0)
  assert.equal(ensureValidatedTourneeIdentityColumnsCalls, 0)
  assert.equal(withTransactionCalls, 0)
  assert.equal(queryAsyncCalls, 0)
})

test('validation route keeps today and future blocks accepted for an active commercial', async () => {
  const todayHarness = createSalesV2ValidationHarness()
  const todayReq = createMockReq(buildValidationRequest({
    block: {
      date: '2026-08-24',
      slot_id: '2026-08-24::C01'
    }
  }))
  const todayRes = createMockRes()

  await serverTestables.handleNextBestVisitValidationRoute(todayReq, todayRes, {
    ...todayHarness.dependencies,
    fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial 1' }]
  })

  assert.equal(todayRes.statusCode, 200)
  assert.equal(todayRes.body.status, 'success')
  assert.equal(todayHarness.tournees.length, 2)
  assert.equal(todayHarness.feedback.length, 2)

  const futureHarness = createSalesV2ValidationHarness()
  const futureReq = createMockReq(buildValidationRequest())
  const futureRes = createMockRes()

  await serverTestables.handleNextBestVisitValidationRoute(futureReq, futureRes, {
    ...futureHarness.dependencies,
    fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial 1' }]
  })

  assert.equal(futureRes.statusCode, 200)
  assert.equal(futureRes.body.status, 'success')
  assert.equal(futureHarness.tournees.length, 2)
  assert.equal(futureHarness.feedback.length, 2)
})

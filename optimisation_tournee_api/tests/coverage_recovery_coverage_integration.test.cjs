const test = require('node:test')
const assert = require('node:assert/strict')

const { __testables } = require('../server.js')
const { loadRecoveryProfiles } = require('../coverage_recovery_profiles')

test.after(async () => {
  await __testables.closeOpenHandles()
})

test('maps known recovery profile fields for coverage payloads', () => {
  const mapped = __testables.buildCoverageRecoveryPayloadFields({
    client_id: '1425',
    credit: {
      total_balance: 1200.456,
      due_amount: 800.2,
      days_past_due: 17
    },
    payment_behavior: {
      expected_next_payment_date: '2026-08-15',
      days_since_expected_payment: 4,
      payment_behavior_score: 78.38
    },
    recovery: {
      expected_collection_amount: 250.55,
      collection_priority_score: 91.4
    },
    sources: {
      credit: 'entetecommercials.client_code_exact',
      payments: 'paiements.client_code_exact'
    }
  })

  assert.deepEqual(mapped, {
    recovery_total_balance: 1200.5,
    recovery_due_amount: 800.2,
    recovery_days_past_due: 17,
    recovery_expected_next_payment_date: '2026-08-15',
    recovery_days_since_expected_payment: 4,
    recovery_payment_behavior_score: 78.4,
    recovery_expected_collection_amount: 250.6,
    recovery_priority_score: 91.4,
    recovery_data_known: true,
    recovery_source: 'credit:entetecommercials.client_code_exact|payments:paiements.client_code_exact'
  })
})

test('keeps recovery nulls distinct from zero when profile data is unavailable', () => {
  const mapped = __testables.buildCoverageRecoveryPayloadFields(null)

  assert.deepEqual(mapped, {
    recovery_total_balance: null,
    recovery_due_amount: null,
    recovery_days_past_due: null,
    recovery_expected_next_payment_date: null,
    recovery_days_since_expected_payment: null,
    recovery_payment_behavior_score: null,
    recovery_expected_collection_amount: null,
    recovery_priority_score: null,
    recovery_data_known: false,
    recovery_source: null
  })
})

test('buildCoverageRecoveryQueryRows delegates to the shared query executor and returns rows directly', async () => {
  const capturedCalls = []
  const sharedExecutor = async (sql, params = [], connection = null) => {
    capturedCalls.push({ sql, params, connection })
    return [{ ok: true }]
  }
  const queryRows = __testables.buildCoverageRecoveryQueryRows(sharedExecutor)
  const rows = await queryRows('SELECT 1', ['x'])

  assert.equal(typeof queryRows, 'function')
  assert.deepEqual(rows, [{ ok: true }])
  assert.deepEqual(capturedCalls, [
    {
      sql: 'SELECT 1',
      params: ['x'],
      connection: null
    }
  ])
})

test('buildCoveragePlanningContext passes a callable queryRows to loadRecoveryProfiles and maps returned recovery rows', async () => {
  const queryRowsCalls = []
  const recoveryQueryRows = async (sql, params = [], connection = null) => {
    queryRowsCalls.push({ sql, params, connection })

    if (sql.includes('FROM clients c') && sql.includes('plafond_credit')) {
      return [
        {
          client_id: '15',
          client_code: '00600',
          plafond_credit: 1000,
          encours_credit: 250,
          delai_paiement: 7,
          nom: 'Client Test',
          adresse: 'Adresse test',
          latitude: 36.8,
          longitude: 10.1,
          region: 'Nord'
        }
      ]
    }

    if (sql.includes('FROM entetecommercials e') && sql.includes('doc_credit_amount')) {
      return [
        {
          client_code: '00600',
          credit_date: '2026-06-01',
          doc_solde: 250,
          doc_credit_amount: 250
        }
      ]
    }

    if (sql.includes('FROM entetecommercials e') && sql.includes('last_sale_date')) {
      return [
        {
          client_code: '00600',
          last_sale_date: '2026-06-20'
        }
      ]
    }

    if (sql.includes('FROM paiements p')) {
      return [
        {
          payment_id: 'p1',
          client_code: '00600',
          payment_date: '2026-06-15',
          payment_amount: 125,
          payment_ref: 'A'
        }
      ]
    }

    throw new Error(`Unexpected SQL in coverage integration test: ${sql.slice(0, 80)}`)
  }

  let capturedLoadRecoveryArgs = null
  const wrappedLoadRecoveryProfiles = async args => {
    capturedLoadRecoveryArgs = args
    return loadRecoveryProfiles(args)
  }

  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_start_date: '2026-07-31',
      planning_days: 1,
      working_days: [5]
    },
    {
      fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial C01' }],
      fetchCoverageActiveClients: async () => ({
        clients: [
          {
            client_id: '15',
            client_code: '00600',
            nbr_client: '00600',
            nom: 'Client Test',
            latitude: 36.8,
            longitude: 10.1,
            historical_commercial_code: 'C01',
            resolved_commercial_code: 'C01',
            user_code: 'C01',
            last_real_visit_date: '2026-07-01',
            history_metrics: {
              avg_load_units_hist: 1
            }
          }
        ],
        dedupedClientResult: {
          duplicateRows: 0
        },
        historySnapshot: {
          diagnostics: {
            resolution_counts: {
              exact_match: 0,
              unique_normalized_match: 0,
              ambiguous_match: 0,
              no_match: 0
            },
            ambiguous_match_rows: 0,
            no_match_rows: 0,
            ambiguous_normalized_codes: []
          }
        }
      }),
      loadCoverageConstraints: async () => ({
        commercials: {},
        client_restrictions: {},
        diagnostic: {
          time_capacity_known: false
        }
      }),
      fetchCoverageCommercialCapacityProfiles: async () => new Map(),
      fetchCoverageValidatedVisitCapacityProfiles: async () => new Map(),
      loadRecoveryProfiles: wrappedLoadRecoveryProfiles,
      recoveryQueryRows,
      loadCoveragePurchasePredictionProfiles: async () => ({
        profiles: []
      })
    }
  )

  assert.equal(typeof capturedLoadRecoveryArgs?.queryRows, 'function')
  assert.equal(capturedLoadRecoveryArgs?.queryRows, recoveryQueryRows)
  assert.equal(capturedLoadRecoveryArgs?.connection, undefined)
  assert.ok(queryRowsCalls.length >= 3)
  assert.ok(queryRowsCalls.every(call => call.connection === null))
  assert.equal(planningContext.optimizerPayload.clients.length, 1)
  assert.equal(planningContext.optimizerPayload.clients[0].recovery_total_balance, 250)
  assert.equal(planningContext.optimizerPayload.clients[0].recovery_due_amount, 250)
  assert.equal(planningContext.optimizerPayload.clients[0].recovery_data_known, true)
})

test('loadRecoveryProfiles still fails clearly when queryRows is missing', async () => {
  await assert.rejects(
    () => loadRecoveryProfiles({
      clientIds: ['15'],
      referenceDate: '2026-07-31'
    }),
    /loadRecoveryProfiles requires a queryRows function\./
  )
})

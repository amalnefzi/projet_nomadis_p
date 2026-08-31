const test = require('node:test')
const assert = require('node:assert/strict')

const { __testables } = require('../server.js')
const { loadRecoveryProfiles } = require('../coverage_recovery_profiles')

test.after(async () => {
  await __testables.closeOpenHandles()
})

function createCoverageClient({
  client_id,
  client_code,
  nbr_client,
  nom,
  history_metrics,
  ...overrides
} = {}) {
  const exactCode = client_code ?? nbr_client ?? client_id
  return {
    client_id: String(client_id ?? ''),
    client_code: String(exactCode ?? '').trim(),
    nbr_client: String(nbr_client ?? exactCode ?? '').trim(),
    nom: nom ?? `Client ${String(exactCode ?? '').trim()}`,
    adresse: 'Adresse test',
    latitude: 36.8,
    longitude: 10.1,
    historical_commercial_code: 'C01',
    resolved_commercial_code: 'C01',
    user_code: 'C01',
    delegation: 'ELMENZAH',
    routing_code: 'Route Nord',
    region: 'Nord',
    last_real_visit_date: '2026-07-20',
    history_metrics: {
      avg_ca_hist: 150,
      avg_load_units_hist: 2,
      ...(history_metrics || {})
    },
    ...overrides
  }
}

function createRecoveryProfile({
  client_id,
  client_code,
  total_balance = 100,
  due_amount = 0,
  expected_next_payment_date = null,
  historical_code_status = 'matched'
} = {}) {
  return {
    client_id: String(client_id ?? ''),
    client_code: String(client_code ?? '').trim(),
    credit: {
      total_balance,
      due_amount,
      days_past_due: due_amount > 0 ? 5 : 0
    },
    payment_behavior: {
      expected_next_payment_date,
      days_since_expected_payment: null,
      payment_behavior_score: 60
    },
    recovery: {
      expected_collection_amount: total_balance,
      collection_priority_score: 75
    },
    sources: {
      credit: 'entetecommercials.client_code_exact',
      payments: expected_next_payment_date ? 'paiements.client_code_exact' : null
    },
    diagnostics: {
      historical_code_status
    }
  }
}

function createRecoveryPlanningDependencies({
  clients,
  recoveryProfiles,
  onPurchasePredictionLoad,
  onConstraintsLoad
} = {}) {
  return {
    fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial C01' }],
    fetchCoverageActiveClients: async () => ({
      clients,
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
    loadCoverageConstraints: async params => {
      if (typeof onConstraintsLoad === 'function') {
        onConstraintsLoad(params)
      }
      return {
        commercials: {},
        client_restrictions: {},
        diagnostic: {
          time_capacity_known: false
        }
      }
    },
    fetchCoverageCommercialCapacityProfiles: async () => new Map(),
    fetchCoverageValidatedVisitCapacityProfiles: async () => new Map(),
    loadRecoveryProfiles: async () => recoveryProfiles,
    loadCoveragePurchasePredictionProfiles: async args => {
      if (typeof onPurchasePredictionLoad === 'function') {
        onPurchasePredictionLoad(args)
      }
      return { profiles: [] }
    }
  }
}

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

test('recovery_coverage keeps relaxed historical recouvrement clients when total balance is positive but no expected payment date can be inferred', async () => {
  const queryRowsCalls = []
  const recoveryQueryRows = async (sql, params = [], connection = null) => {
    queryRowsCalls.push({ sql, params, connection })

    if (sql.includes('FROM entetecommercials e') && sql.includes('doc_credit_amount')) {
      return [
        {
          client_code: '00999',
          credit_date: '2026-08-28',
          doc_solde: 250,
          doc_credit_amount: 250
        }
      ]
    }

    if (sql.includes('FROM entetecommercials e') && sql.includes('last_sale_date')) {
      return [
        {
          client_code: '00999',
          last_sale_date: '2026-08-20'
        }
      ]
    }

    if (sql.includes('FROM paiements p')) {
      return []
    }

    throw new Error(`Unexpected SQL in relaxed recovery integration test: ${sql.slice(0, 80)}`)
  }

  const wrappedLoadRecoveryProfiles = async args => loadRecoveryProfiles(args)
  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-29',
      planning_days: 1,
      working_days: [6]
    },
    {
      fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial C01' }],
      fetchCoverageActiveClients: async () => ({
        clients: [
          {
            client_id: '99',
            client_code: '00999',
            nbr_client: '00999',
            plafond_credit: 100,
            nom: 'Client Relaxed',
            latitude: 36.8,
            longitude: 10.1,
            historical_commercial_code: 'C01',
            resolved_commercial_code: 'C01',
            user_code: 'C01',
            last_real_visit_date: '2026-08-10',
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

  assert.ok(queryRowsCalls.length >= 3)
  assert.equal(planningContext.selectedClientsCount, 1)
  assert.equal(planningContext.optimizerPayload.clients.length, 1)
  assert.equal(planningContext.optimizerPayload.clients[0].client_id, '99')
  assert.equal(planningContext.optimizerPayload.clients[0].recovery_total_balance, 250)
  assert.equal(planningContext.optimizerPayload.clients[0].recovery_due_amount, 0)
  assert.equal(planningContext.optimizerPayload.clients[0].recovery_expected_next_payment_date, null)
  assert.deepEqual(planningContext.recoveryEligibilityDiagnostic.reasonCounts, {
    positive_total_balance_relaxed: 1
  })
})

test('recovery_coverage precheck builds slots and exposes totalConfiguredCapacity after eligibility filtering', async () => {
  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-29',
      planning_days: 1,
      working_days: [6]
    },
    createRecoveryPlanningDependencies({
      clients: [
        createCoverageClient({ client_id: '1', client_code: '00152' })
      ],
      recoveryProfiles: [
        createRecoveryProfile({ client_id: '1', client_code: '00152', due_amount: 120, total_balance: 120 })
      ]
    }),
    { precheckOnly: true }
  )

  assert.equal(planningContext.selectedClientsCount, 1)
  assert.equal(planningContext.totalSlots, 1)
  assert.equal(planningContext.activeCommercials.length, 1)
  assert.equal(planningContext.activeCommercials[0].available_dates.length, 1)
  assert.equal(planningContext.totalConfiguredCapacity, 1)
  assert.deepEqual(planningContext.recoveryEligibilityDiagnostic.reasonCounts, {
    positive_due_amount: 1
  })
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

test('recovery_coverage keeps only eligible clients in the optimizer payload and preserves exact 00152 / 152 identities', async () => {
  const activeClients = [
    createCoverageClient({ client_id: '1', client_code: '00152' }),
    createCoverageClient({ client_id: '2', client_code: '152' }),
    createCoverageClient({ client_id: '3', client_code: '300' }),
    createCoverageClient({ client_id: '4', client_code: '400' }),
    createCoverageClient({ client_id: '5', client_code: '500' })
  ]
  const recoveryProfiles = [
    createRecoveryProfile({ client_id: '1', client_code: '00152', due_amount: 120, total_balance: 120 }),
    createRecoveryProfile({ client_id: '2', client_code: '152', total_balance: 200, expected_next_payment_date: '2026-08-04' }),
    createRecoveryProfile({ client_id: '3', client_code: '300', total_balance: 0, due_amount: 0 }),
    createRecoveryProfile({ client_id: '4', client_code: '400', total_balance: 180, expected_next_payment_date: '2026-08-12' }),
    createRecoveryProfile({ client_id: '5', client_code: '500', total_balance: null, due_amount: null, expected_next_payment_date: null })
  ]

  let purchasePredictionClientIds = null
  let constrainedClientIds = null
  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 2,
      working_days: [1, 2]
    },
    createRecoveryPlanningDependencies({
      clients: activeClients,
      recoveryProfiles,
      onPurchasePredictionLoad: args => {
        purchasePredictionClientIds = args.clientRows.map(client => client.client_id)
      },
      onConstraintsLoad: params => {
        constrainedClientIds = params.clientIds
      }
    })
  )

  assert.equal(planningContext.selectedClientsCount, 2)
  assert.equal(planningContext.requiredVisitsCount, 2)
  assert.deepEqual(
    planningContext.optimizerPayload.clients.map(client => [client.client_id, client.client_code]),
    [
      ['1', '00152'],
      ['2', '152']
    ]
  )
  assert.equal(purchasePredictionClientIds, null)
  assert.deepEqual(constrainedClientIds, ['1', '2'])
  assert.equal(planningContext.recoveryEligibilityDiagnostic.population_before_filtering, 5)
  assert.equal(planningContext.recoveryEligibilityDiagnostic.eligible_count, 2)
  assert.equal(planningContext.recoveryEligibilityDiagnostic.excluded_count, 3)
  assert.deepEqual(planningContext.recoveryEligibilityDiagnostic.reasonCounts, {
    positive_due_amount: 1,
    expected_payment_in_period: 1,
    non_positive_total_balance: 1,
    payment_due_after_period: 1,
    missing_recovery_data: 1
  })
})

test('recovery_coverage returns a clear empty business response and skips optimizer when no client is eligible', async () => {
  const activeClients = [
    createCoverageClient({ client_id: '30', client_code: '0030' }),
    createCoverageClient({ client_id: '40', client_code: '0040' }),
    createCoverageClient({ client_id: '50', client_code: '0050' })
  ]
  const recoveryProfiles = [
    createRecoveryProfile({ client_id: '30', client_code: '0030', total_balance: 0, due_amount: 0 }),
    createRecoveryProfile({ client_id: '40', client_code: '0040', total_balance: 180, expected_next_payment_date: '2026-08-20' }),
    createRecoveryProfile({ client_id: '50', client_code: '0050', total_balance: null, due_amount: null, expected_next_payment_date: null })
  ]

  let optimizeCalls = 0
  let purchasePredictionLoads = 0
  const result = await __testables.generateCoveragePlanResponse(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 2,
      working_days: [1, 2]
    },
    {
      buildCoveragePlanningContext: (rawBody, _unused, runtimeOptions) => __testables.buildCoveragePlanningContext(
        rawBody,
        createRecoveryPlanningDependencies({
          clients: activeClients,
          recoveryProfiles,
          onPurchasePredictionLoad: () => {
            purchasePredictionLoads += 1
          }
        }),
        runtimeOptions
      ),
      fetchOrToolsCoveragePlan: async () => {
        optimizeCalls += 1
        return { data: { status: 'success' } }
      }
    }
  )

  assert.equal(optimizeCalls, 0)
  assert.equal(purchasePredictionLoads, 0)
  assert.equal(result.statusCode, 200)
  assert.equal(result.payload.summary.clients_to_cover, 0)
  assert.equal(result.payload.diagnostics.recovery_eligibility.population_before_filtering, 3)
  assert.equal(result.payload.diagnostics.recovery_eligibility.eligible_count, 0)
  assert.equal(result.payload.diagnostics.recovery_eligibility.excluded_count, 3)
  assert.deepEqual(result.payload.diagnostics.recovery_eligibility.reasonCounts, {
    non_positive_total_balance: 1,
    payment_due_after_period: 1,
    missing_recovery_data: 1
  })
  assert.match(result.payload.message, /Aucun client recouvrable/)
})

test('recovery_coverage 1c never loads purchase predictions and keeps purchase and CA fields neutral', async () => {
  const activeClients = [
    createCoverageClient({ client_id: '1', client_code: '00152' }),
    createCoverageClient({ client_id: '2', client_code: '152' })
  ]
  const recoveryProfiles = [
    createRecoveryProfile({ client_id: '1', client_code: '00152', due_amount: 120, total_balance: 120 }),
    createRecoveryProfile({ client_id: '2', client_code: '152', total_balance: 200, expected_next_payment_date: '2026-08-04' })
  ]

  let purchasePredictionLoads = 0
  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 2,
      working_days: [1, 2],
      strict_ca: true,
      min_daily_ca_per_commercial: 900
    },
    createRecoveryPlanningDependencies({
      clients: activeClients,
      recoveryProfiles,
      onPurchasePredictionLoad: () => {
        purchasePredictionLoads += 1
      }
    })
  )

  assert.equal(purchasePredictionLoads, 0)
  assert.equal(planningContext.strictCa, false)
  assert.equal(planningContext.minDailyCaPerCommercial, 0)
  assert.equal(planningContext.optimizerPayload.strict_ca, false)
  assert.equal(planningContext.optimizerPayload.min_daily_ca_per_commercial, 0)
  assert.ok(
    planningContext.optimizerPayload.commercials.every(commercial =>
      Object.values(commercial.min_ca_by_date || {}).every(value => Number(value || 0) === 0)
    )
  )

  for (const client of planningContext.optimizerPayload.clients) {
    assert.equal(client.predicted_ca, null)
    assert.equal(client.predicted_ca_known, false)
    assert.equal(client.predicted_ca_source, null)
    assert.equal(client.purchase_prediction_score, null)
    assert.equal(client.predicted_purchase_date, null)
    assert.equal(client.purchase_days_until_prediction, null)
    assert.equal(client.recommended_quantity, null)
    assert.equal(client.expected_order_value, null)
    assert.deepEqual(client.predicted_products, [])
    assert.equal(client.purchase_prediction_known, false)
    assert.equal(client.purchase_prediction_source, null)
  }
})

test('recovery_coverage forwards target_collection_amount exactly to request context and python payload', async () => {
  const activeClients = [
    createCoverageClient({ client_id: '1', client_code: '00152' }),
    createCoverageClient({ client_id: '2', client_code: '152' })
  ]
  const recoveryProfiles = [
    createRecoveryProfile({ client_id: '1', client_code: '00152', due_amount: 120, total_balance: 120 }),
    createRecoveryProfile({ client_id: '2', client_code: '152', total_balance: 200, expected_next_payment_date: '2026-08-04' })
  ]

  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 2,
      working_days: [1, 2],
      target_collection_amount: 125.5
    },
    createRecoveryPlanningDependencies({
      clients: activeClients,
      recoveryProfiles
    })
  )

  const requestContext = __testables.buildCoverageRequestContext(planningContext, planningContext.strictCa)
  let capturedOptimizerPayload = null

  const result = await __testables.generateCoveragePlanResponse(
    { planning_mode: 'recovery_coverage' },
    {
      buildCoveragePlanningContext: async () => planningContext,
      fetchOrToolsCoveragePlan: async payload => {
        capturedOptimizerPayload = payload
        return {
          data: {
            status: 'success',
            reason: null,
            summary: {
              planning_start_date: '2026-08-03',
              planning_end_date: '2026-08-04',
              clients_to_cover: 2,
              unique_clients_covered: 2,
              missing_clients_count: 0,
              duplicate_clients_count: 0,
              total_visits: 2,
              total_slots: 2,
              used_slots: 2,
              unused_slots: 0,
              total_capacity: 2,
              required_average_per_slot: 1,
              required_minimum_max_per_slot: 1,
              total_predicted_ca: 0,
              total_ca_shortfall: 0,
              solver_status: 'OPTIMAL'
            },
            blocks: [
              {
                slot_id: '2026-08-03::C01',
                date: '2026-08-03',
                commercial_code: 'C01',
                clients_count: 1,
                clients: [
                  {
                    client_id: '1',
                    client_code: '00152'
                  }
                ]
              },
              {
                slot_id: '2026-08-04::C01',
                date: '2026-08-04',
                commercial_code: 'C01',
                clients_count: 1,
                clients: [
                  {
                    client_id: '2',
                    client_code: '152'
                  }
                ]
              }
            ],
            diagnostics: {
              capacity_issues: [],
              commercial_capacity_issues: [],
              deadline_issues: [],
              ca_issues: [],
              invalid_gps_clients: [],
              input_duplicate_clients_removed: []
            },
            analysis: {
              status: 'feasible',
              reason: null,
              feasibility: {
                clients_to_cover: 2,
                total_slots: 2,
                configured_total_capacity: 2,
                missing_capacity: 0,
                required_average_per_slot: 1,
                required_minimum_max_per_slot: 1,
                commercial: null,
                clients_required: 0,
                capacity: 0,
                details: []
              },
              strict_ca: {
                enabled: false,
                possible: true,
                reason: null,
                total_required_ca: 0,
                total_possible_ca: 0,
                issues: []
              },
              operational: {},
              input_summary: {
                planning_start_date: '2026-08-03',
                planning_end_date: '2026-08-04',
                planning_days: 2,
                visit_frequency_days: 14,
                working_days: [1, 2],
                selected_commercials_count: 1,
                mandatory_clients_count: 2
              }
            }
          }
        }
      }
    }
  )

  assert.equal(planningContext.targetCollectionAmount, 125.5)
  assert.equal(planningContext.optimizerPayload.target_collection_amount, 125.5)
  assert.equal(requestContext.target_collection_amount, 125.5)
  assert.equal(result.statusCode, 200)
  assert.equal(capturedOptimizerPayload.target_collection_amount, 125.5)
})

test('recovery_coverage success exposes a stable top-level collection_target_context and prefers functional_metadata', async () => {
  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 2,
      working_days: [1, 2],
      target_collection_amount: 200
    },
    createRecoveryPlanningDependencies({
      clients: [
        createCoverageClient({ client_id: '1', client_code: '00152' }),
        createCoverageClient({ client_id: '2', client_code: '152' })
      ],
      recoveryProfiles: [
        createRecoveryProfile({ client_id: '1', client_code: '00152', due_amount: 120, total_balance: 120 }),
        createRecoveryProfile({ client_id: '2', client_code: '152', total_balance: 200, expected_next_payment_date: '2026-08-04' })
      ]
    })
  )

  const result = await __testables.generateCoveragePlanResponse(
    { planning_mode: 'recovery_coverage' },
    {
      buildCoveragePlanningContext: async () => planningContext,
      fetchOrToolsCoveragePlan: async () => ({
        data: {
          status: 'success',
          reason: null,
          summary: {
            planning_start_date: '2026-08-03',
            planning_end_date: '2026-08-04',
            clients_to_cover: 2,
            unique_clients_covered: 2,
            missing_clients_count: 0,
            duplicate_clients_count: 0,
            total_visits: 2,
            total_slots: 2,
            used_slots: 2,
            unused_slots: 0,
            total_capacity: 2,
            required_average_per_slot: 1,
            required_minimum_max_per_slot: 1,
            total_predicted_ca: 0,
            total_ca_shortfall: 0,
            solver_status: 'OPTIMAL'
          },
          blocks: [],
          diagnostics: {},
          analysis: {
            status: 'feasible',
            collection_target_context: {
              mode: 'target_collection',
              requested_target_collection_amount: 999.999,
              selected_estimated_collection_amount: 40,
              estimated_remaining_amount: 959.999,
              is_target_reached: false,
              stop_reason: 'analysis_fallback'
            }
          },
          functional_metadata: {
            collection_target_context: {
              mode: 'target_collection',
              requested_target_collection_amount: 200,
              selected_estimated_collection_amount: 120.129,
              estimated_remaining_amount: 79.871,
              is_target_reached: false,
              stop_reason: 'partial_target'
            }
          }
        }
      })
    }
  )

  assert.deepEqual(result.payload.collection_target_context, {
    mode: 'target_collection',
    requested_target_collection_amount: 200,
    selected_estimated_collection_amount: 120.13,
    estimated_remaining_amount: 79.87,
    is_target_reached: false,
    stop_reason: 'partial_target'
  })
})

test('recovery_coverage falls back to analysis collection_target_context when functional_metadata is absent', async () => {
  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 1,
      working_days: [1],
      target_collection_amount: 90
    },
    createRecoveryPlanningDependencies({
      clients: [
        createCoverageClient({ client_id: '1', client_code: '00152' })
      ],
      recoveryProfiles: [
        createRecoveryProfile({ client_id: '1', client_code: '00152', due_amount: 120, total_balance: 120 })
      ]
    })
  )

  const result = await __testables.generateCoveragePlanResponse(
    { planning_mode: 'recovery_coverage' },
    {
      buildCoveragePlanningContext: async () => planningContext,
      fetchOrToolsCoveragePlan: async () => ({
        data: {
          status: 'success',
          reason: null,
          summary: {
            planning_start_date: '2026-08-03',
            planning_end_date: '2026-08-03',
            clients_to_cover: 1,
            unique_clients_covered: 1,
            missing_clients_count: 0,
            duplicate_clients_count: 0,
            total_visits: 1,
            total_slots: 1,
            used_slots: 1,
            unused_slots: 0,
            total_capacity: 1,
            required_average_per_slot: 1,
            required_minimum_max_per_slot: 1,
            total_predicted_ca: 0,
            total_ca_shortfall: 0,
            solver_status: 'OPTIMAL'
          },
          blocks: [],
          diagnostics: {},
          analysis: {
            status: 'feasible',
            collection_target_context: {
              mode: 'target_collection',
              requested_target_collection_amount: 90,
              selected_estimated_collection_amount: 95.005,
              estimated_remaining_amount: 0,
              is_target_reached: true,
              stop_reason: 'target_reached'
            }
          }
        }
      })
    }
  )

  assert.deepEqual(result.payload.collection_target_context, {
    mode: 'target_collection',
    requested_target_collection_amount: 90,
    selected_estimated_collection_amount: 95.00,
    estimated_remaining_amount: 0,
    is_target_reached: true,
    stop_reason: 'target_reached'
  })
})

test('recovery_coverage full_coverage responses keep collection_target_context non applicable', async () => {
  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 1,
      working_days: [1]
    },
    createRecoveryPlanningDependencies({
      clients: [
        createCoverageClient({ client_id: '1', client_code: '00152' })
      ],
      recoveryProfiles: [
        createRecoveryProfile({ client_id: '1', client_code: '00152', due_amount: 120, total_balance: 120 })
      ]
    })
  )

  const result = await __testables.generateCoveragePlanResponse(
    { planning_mode: 'recovery_coverage' },
    {
      buildCoveragePlanningContext: async () => planningContext,
      fetchOrToolsCoveragePlan: async () => ({
        data: {
          status: 'success',
          reason: null,
          summary: {
            planning_start_date: '2026-08-03',
            planning_end_date: '2026-08-03',
            clients_to_cover: 1,
            unique_clients_covered: 1,
            missing_clients_count: 0,
            duplicate_clients_count: 0,
            total_visits: 1,
            total_slots: 1,
            used_slots: 1,
            unused_slots: 0,
            total_capacity: 1,
            required_average_per_slot: 1,
            required_minimum_max_per_slot: 1,
            total_predicted_ca: 0,
            total_ca_shortfall: 0,
            solver_status: 'OPTIMAL'
          },
          blocks: [],
          diagnostics: {},
          analysis: {
            status: 'feasible'
          }
        }
      })
    }
  )

  assert.deepEqual(result.payload.collection_target_context, {
    mode: 'full_coverage',
    requested_target_collection_amount: null,
    selected_estimated_collection_amount: null,
    estimated_remaining_amount: null,
    is_target_reached: null,
    stop_reason: 'full_coverage'
  })
})

test('recovery_coverage empty response with positive target reports no_candidates collection_target_context', async () => {
  const result = await __testables.generateCoveragePlanResponse(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 2,
      working_days: [1, 2],
      target_collection_amount: 150
    },
    {
      buildCoveragePlanningContext: (rawBody, _unused, runtimeOptions) => __testables.buildCoveragePlanningContext(
        rawBody,
        createRecoveryPlanningDependencies({
          clients: [
            createCoverageClient({ client_id: '30', client_code: '0030' }),
            createCoverageClient({ client_id: '40', client_code: '0040' })
          ],
          recoveryProfiles: [
            createRecoveryProfile({ client_id: '30', client_code: '0030', total_balance: 0, due_amount: 0 }),
            createRecoveryProfile({ client_id: '40', client_code: '0040', total_balance: null, due_amount: null, expected_next_payment_date: null })
          ]
        }),
        runtimeOptions
      ),
      fetchOrToolsCoveragePlan: async () => {
        throw new Error('optimizer should not be called for empty recovery responses')
      }
    }
  )

  assert.deepEqual(result.payload.collection_target_context, {
    mode: 'target_collection',
    requested_target_collection_amount: 150,
    selected_estimated_collection_amount: 0,
    estimated_remaining_amount: 150,
    is_target_reached: false,
    stop_reason: 'no_candidates'
  })
})

test('recovery_coverage no_available_slots with positive target reports target_unreachable collection_target_context', async () => {
  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 1,
      working_days: [1],
      target_collection_amount: 180
    },
    createRecoveryPlanningDependencies({
      clients: [
        createCoverageClient({ client_id: '1', client_code: '00152' })
      ],
      recoveryProfiles: [
        createRecoveryProfile({ client_id: '1', client_code: '00152', due_amount: 120, total_balance: 120 })
      ]
    })
  )

  planningContext.totalSlots = 0
  planningContext.theoreticalTotalSlots = 0
  planningContext.totalConfiguredCapacity = 0
  planningContext.capacityPrecheck = {
    strict_capacity: 0,
    required_visits_count: 1,
    available_slots_count: 0,
    capacity_deficit: 1,
    minimum_required_average: 1,
    minimum_required_peak_estimate: 1,
    active_clients_count: 1
  }

  const result = await __testables.generateCoveragePlanResponse(
    { planning_mode: 'recovery_coverage' },
    {
      buildCoveragePlanningContext: async () => planningContext,
      fetchOrToolsCoveragePlan: async () => ({
        data: {
          status: 'infeasible',
          reason: 'no_available_slots',
          analysis: {
            status: 'infeasible',
            reason: 'no_available_slots',
            feasibility: {
              clients_to_cover: 1,
              required_average_per_slot: 1,
              required_minimum_max_per_slot: 1
            }
          }
        }
      })
    }
  )

  assert.equal(result.statusCode, 200)
  assert.equal(result.payload.reason, 'no_available_slots')
  assert.deepEqual(result.payload.collection_target_context, {
    mode: 'target_collection',
    requested_target_collection_amount: 180,
    selected_estimated_collection_amount: 0,
    estimated_remaining_amount: 180,
    is_target_reached: false,
    stop_reason: 'target_unreachable'
  })
})

test('recovery_coverage normalizes decimal numeric strings for target_collection_amount', async () => {
  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 2,
      working_days: [1, 2],
      target_collection_amount: '170.459'
    },
    createRecoveryPlanningDependencies({
      clients: [
        createCoverageClient({ client_id: '1', client_code: '00152' })
      ],
      recoveryProfiles: [
        createRecoveryProfile({ client_id: '1', client_code: '00152', due_amount: 120, total_balance: 120 })
      ]
    })
  )

  assert.equal(planningContext.targetCollectionAmount, 170.459)
  assert.equal(typeof planningContext.targetCollectionAmount, 'number')
  assert.equal(planningContext.optimizerPayload.target_collection_amount, 170.459)
})

test('recovery_coverage accepts missing target_collection_amount as no target and keeps zero valid', async () => {
  const activeClients = [
    createCoverageClient({ client_id: '1', client_code: '00152' })
  ]
  const recoveryProfiles = [
    createRecoveryProfile({ client_id: '1', client_code: '00152', due_amount: 120, total_balance: 120 })
  ]

  const noTargetContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 2,
      working_days: [1, 2]
    },
    createRecoveryPlanningDependencies({
      clients: activeClients,
      recoveryProfiles
    })
  )
  const zeroTargetContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 2,
      working_days: [1, 2],
      target_collection_amount: 0
    },
    createRecoveryPlanningDependencies({
      clients: activeClients,
      recoveryProfiles
    })
  )

  assert.equal(noTargetContext.targetCollectionAmount, null)
  assert.equal(noTargetContext.optimizerPayload.target_collection_amount, null)
  assert.equal(
    __testables.buildCoverageRequestContext(noTargetContext, noTargetContext.strictCa).target_collection_amount,
    null
  )
  assert.equal(zeroTargetContext.targetCollectionAmount, 0)
  assert.equal(zeroTargetContext.optimizerPayload.target_collection_amount, 0)
  assert.equal(
    __testables.buildCoverageRequestContext(zeroTargetContext, zeroTargetContext.strictCa).target_collection_amount,
    0
  )
})

test('recovery_coverage rejects negative, non numeric and non finite target_collection_amount values', async () => {
  for (const rawValue of [-5, 'abc', Infinity]) {
    const planningContext = await __testables.buildCoveragePlanningContext({
      planning_mode: 'recovery_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 2,
      working_days: [1, 2],
      target_collection_amount: rawValue
    })

    assert.equal(planningContext.invalidResponse?.status, 'invalid_parameters')
    assert.match(
      planningContext.invalidResponse?.message || '',
      /target_collection_amount doit etre un nombre fini superieur ou egal a 0/
    )
  }
})

test('recovery_coverage reads target_collection_amount from the coverage query builder input', async () => {
  const rawInput = __testables.buildCoveragePlanInputFromQuery({
    planning_mode: 'recovery_coverage',
    planning_start_date: '2026-08-03',
    planning_days: '2',
    working_days: '1,2',
    target_collection_amount: '250.75'
  })
  const planningContext = await __testables.buildCoveragePlanningContext(
    rawInput,
    createRecoveryPlanningDependencies({
      clients: [
        createCoverageClient({ client_id: '1', client_code: '00152' })
      ],
      recoveryProfiles: [
        createRecoveryProfile({ client_id: '1', client_code: '00152', due_amount: 120, total_balance: 120 })
      ]
    })
  )

  assert.equal(rawInput.target_collection_amount, '250.75')
  assert.equal(planningContext.targetCollectionAmount, 250.75)
  assert.equal(planningContext.optimizerPayload.target_collection_amount, 250.75)
})

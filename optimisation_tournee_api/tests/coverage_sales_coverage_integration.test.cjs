const test = require('node:test')
const assert = require('node:assert/strict')

const { __testables } = require('../server.js')

test.after(async () => {
  await __testables.closeOpenHandles()
})

test('sales_coverage planning context skips recovery loading and uses grouped purchase predictions for predicted_ca', async () => {
  let recoveryCalls = 0

  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'sales_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 1,
      working_days: [1],
      commercial_codes: ['C01']
    },
    {
      fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial C01' }],
      fetchCoverageActiveClients: async () => ({
        clients: [
          {
            client_id: '15',
            client_code: '00152',
            nbr_client: '00152',
            nom: 'Client 00152',
            adresse: 'Adresse test',
            latitude: 36.8,
            longitude: 10.1,
            user_code: '1',
            delegation: 'ELMENZAH',
            routing_code: 'Route Nord',
            region: 'Nord',
            historical_commercial_code: 'C01',
            resolved_commercial_code: 'C01',
            last_real_visit_date: '2026-07-20',
            history_metrics: {
              avg_ca_hist: 150,
              avg_load_units_hist: 2
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
      loadRecoveryProfiles: async () => {
        recoveryCalls += 1
        return []
      },
      loadCoveragePurchasePredictionProfiles: async () => ({
        profiles: [
          {
            client_id: '15',
            client_code: '00152',
            purchase_prediction_score: 85,
            predicted_purchase_date: '2026-08-05',
            purchase_days_until_prediction: 2,
            recommended_quantity: 6,
            expected_order_value: 410.2,
            predicted_products: [
              { name: 'BISKREMCACAO', quantity: 3 }
            ],
            purchase_prediction_known: true,
            purchase_prediction_source: 'dashboard_fetchLoggedAiPredictions'
          }
        ]
      })
    }
  )

  const [client] = planningContext.optimizerPayload.clients

  assert.equal(planningContext.planningMode, 'sales_coverage')
  assert.equal(planningContext.optimizerPayload.planning_mode, 'sales_coverage')
  assert.equal(recoveryCalls, 0)
  assert.equal(planningContext.selectedCommercials.length, 1)
  assert.equal(planningContext.selectedCommercials[0].value, 'C01')
  assert.equal(client.client_id, '15')
  assert.equal(client.client_code, '00152')
  assert.equal(client.predicted_ca, 410.2)
  assert.equal(client.predicted_ca_source, 'dashboard_fetchLoggedAiPredictions')
  assert.equal(client.purchase_prediction_score, 85)
  assert.equal(client.recommended_quantity, 6)
  assert.equal(client.predicted_purchase_date, '2026-08-05')
  assert.equal(client.expected_order_value, 410.2)
  assert.equal(client.commercial_zone, 'Comm 1 - ELMENZAH')
  assert.equal(client.recovery_priority_score, null)
  assert.equal(client.recovery_expected_collection_amount, null)
  assert.equal(client.recovery_data_known, false)
})

test('sales_coverage planning context preserves exact multi-commercial codes as strings', async () => {
  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'sales_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 1,
      working_days: [1],
      commercial_codes: ['0001', 'VL1900']
    },
    {
      fetchCommercialOptions: async () => [
        { value: '0001', label: 'Commercial 0001' },
        { value: 'VL1900', label: 'Commercial VL1900' },
        { value: 'C03', label: 'Commercial C03' }
      ],
      fetchCoverageActiveClients: async () => ({
        clients: [
          {
            client_id: '15',
            client_code: '00152',
            nbr_client: '00152',
            nom: 'Client 00152',
            adresse: 'Adresse test',
            latitude: 36.8,
            longitude: 10.1,
            user_code: '1',
            delegation: 'ELMENZAH',
            routing_code: 'Route Nord',
            region: 'Nord',
            historical_commercial_code: '0001',
            resolved_commercial_code: '0001',
            last_real_visit_date: '2026-07-20'
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
      loadRecoveryProfiles: async () => [],
      loadCoveragePurchasePredictionProfiles: async () => ({ profiles: [] })
    }
  )

  assert.deepEqual(
    planningContext.selectedCommercials.map(item => item.value),
    ['0001', 'VL1900']
  )
  assert.deepEqual(
    planningContext.optimizerPayload.commercials.map(item => item.code),
    ['0001', 'VL1900']
  )
})

test('coverage-plan main flow uses a single optimize call and keeps the same functional hash despite technical path metadata', async () => {
  let optimizeCalls = 0
  let analyzeCalls = 0
  let capturedOptimizerPayload = null

  const planningContext = {
    planningMode: 'sales_coverage',
    startDate: '2026-08-03',
    planningDays: 2,
    planningDaysList: [{ date: '2026-08-03' }, { date: '2026-08-04' }],
    visitFrequencyDays: 14,
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    selectedClientsCount: 2,
    requestedUserMinVisits: 1,
    normalizedUserMinVisits: 1,
    requestedUserMaxVisits: 2,
    adjustedTargetMaxVisitsPerSlot: 2,
    maxHardPhysicalMaxVisitsPerSlot: 2,
    hardPhysicalLimitedSlotsCount: 0,
    recommendedMaxVisitsPerSlot: 2,
    resolvedMaxVisitsPerSlot: 2,
    capacityMode: 'configured_hard_capacity',
    timeCapacityKnown: false,
    operationalCapacityKnown: true,
    historicalSoftCapacityTotal: 2,
    salesActivityProxyTotal: 2,
    minDailyCaPerCommercial: 0,
    allowCommercialReassignment: true,
    workingDaySelection: [1, 2],
    historyCacheHits: 0,
    historyCacheMisses: 0,
    historyBuildMs: 0,
    dedupedClientResult: { duplicateRows: 0 },
    historyMatchDiagnostics: null,
    strictCa: false,
    totalSlots: 2,
    totalConfiguredCapacity: 2,
    optimizerPayload: {
      planning_mode: 'sales_coverage',
      planning_start_date: '2026-08-03',
      planning_days: 2,
      visit_frequency_days: 14,
      working_days: [1, 2],
      commercials: [
        {
          code: 'C01',
          available_dates: ['2026-08-03', '2026-08-04'],
          hard_capacity_by_date: {
            '2026-08-03': 1,
            '2026-08-04': 1
          }
        }
      ],
      clients: [
        {
          client_id: '15',
          client_code: '00152',
          allowed_commercial_codes: ['C01']
        },
        {
          client_id: '16',
          client_code: '152',
          allowed_commercial_codes: ['C01']
        }
      ]
    }
  }

  const analysis = {
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
      total_possible_ca: 540,
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

  const optimizerResult = {
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
      total_predicted_ca: 540,
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
            client_id: '15',
            client_code: '00152',
            predicted_ca: 420
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
            client_id: '16',
            client_code: '152',
            predicted_ca: 120
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
    analysis,
    meta: {
      performance: {
        stages: [
          { stage: 'python_normalization', duration_ms: 1 },
          { stage: 'python_candidates', duration_ms: 1 },
          { stage: 'python_solver', duration_ms: 1 }
        ]
      }
    }
  }

  const result = await __testables.generateCoveragePlanResponse(
    { planning_mode: 'sales_coverage' },
    {
      buildCoveragePlanningContext: async () => planningContext,
      fetchOrToolsCoveragePlan: async payload => {
        optimizeCalls += 1
        capturedOptimizerPayload = payload
        return { data: optimizerResult }
      },
      fetchOrToolsCoverageAnalysis: async () => {
        analyzeCalls += 1
        throw new Error('analyze endpoint should not be called in the main unified flow')
      }
    }
  )

  const legacyResponse = {
    ...result.payload,
    request_id: 'legacy-analysis-then-optimize',
    performance: {
      stages: [
        { stage: 'call_python_analysis', duration_ms: 7 },
        { stage: 'call_python', duration_ms: 9 }
      ]
    },
    cache_status: 'miss'
  }

  assert.equal(optimizeCalls, 1)
  assert.equal(analyzeCalls, 0)
  assert.equal(capturedOptimizerPayload.include_feasibility_analysis, true)
  assert.equal(result.payload.analysis.status, 'feasible')
  assert.equal(
    __testables.computeCoverageFunctionalResultHash(result.payload),
    __testables.computeCoverageFunctionalResultHash(legacyResponse)
  )
})

test('coverage-plan node layer logs input fingerprints, greedy trace and functional hash without exposing raw snapshots', async () => {
  const previousPerfDebug = process.env.COVERAGE_PERF_DEBUG
  process.env.COVERAGE_PERF_DEBUG = 'true'

  const originalConsoleLog = console.log
  const capturedLogs = []
  console.log = (...args) => {
    capturedLogs.push(args.join(' '))
  }

  try {
    const optimizerResult = {
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
        total_predicted_ca: 120,
        total_ca_shortfall: 0,
        solver_status: 'FEASIBLE'
      },
      blocks: [
        {
          slot_id: '2026-08-03::C01',
          date: '2026-08-03',
          commercial_code: 'C01',
          clients_count: 1,
          clients: [
            {
              client_id: '15',
              client_code: '00152',
              visit_order: 1,
              predicted_ca: 120
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
        status: 'feasible'
      },
      meta: {
        performance: {
          stages: [
            { stage: 'python_solver_total', duration_ms: 5 }
          ]
        },
        input_fingerprints: {
          request_params_hash: 'req-hash',
          clients_snapshot_hash: 'clients-hash',
          slots_hash: 'slots-hash',
          constraints_hash: 'constraints-hash',
          predictions_hash: 'predictions-hash',
          history_profiles_hash: 'history-hash',
          input_candidate_pairs_snapshot_hash: 'pairs-snapshot-hash',
          functional_input_hash: 'functional-input-hash'
        },
        greedy_trace: {
          greedy_candidate_order_hash: 'pairs-order-hash',
          client_priority_order_hash: 'priority-hash',
          candidate_order_by_client_hash: 'candidate-order-hash',
          assignment_decisions_hash: 'decisions-hash',
          assignments_after_postprocess_hash: 'after-postprocess-hash',
          canonical_functional_result_hash: 'functional-output-hash'
        },
        result_hashes: {
          python_solver_result_hash: 'python-solver-hash',
          python_response_before_flask_hash: 'python-before-flask-hash',
          flask_json_response_hash: 'flask-json-hash',
          canonical_functional_result_hash: __testables.computeCoverageFunctionalResultHash({
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
              total_predicted_ca: 120,
              total_ca_shortfall: 0,
              solver_status: 'FEASIBLE'
            },
            blocks: [
              {
                slot_id: '2026-08-03::C01',
                date: '2026-08-03',
                commercial_code: 'C01',
                clients: [
                  {
                    client_id: '15',
                    client_code: '00152',
                    visit_order: 1,
                    predicted_ca: 120
                  }
                ]
              }
            ],
            diagnostics: {
              missing_clients: [],
              duplicate_clients: []
            }
          })
        }
      }
    }

    await __testables.generateCoveragePlanResponse(
      { planning_mode: 'sales_coverage' },
      {
        buildCoveragePlanningContext: async () => ({
          planningMode: 'sales_coverage',
          startDate: '2026-08-03',
          planningDays: 1,
          planningDaysList: [{ date: '2026-08-03' }],
          visitFrequencyDays: 14,
          selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
          selectedClientsCount: 1,
          requestedUserMinVisits: 1,
          normalizedUserMinVisits: 1,
          requestedUserMaxVisits: 1,
          adjustedTargetMaxVisitsPerSlot: 1,
          maxHardPhysicalMaxVisitsPerSlot: 1,
          hardPhysicalLimitedSlotsCount: 0,
          recommendedMaxVisitsPerSlot: 1,
          resolvedMaxVisitsPerSlot: 1,
          capacityMode: 'configured_hard_capacity',
          timeCapacityKnown: false,
          operationalCapacityKnown: true,
          historicalSoftCapacityTotal: 1,
          salesActivityProxyTotal: 1,
          minDailyCaPerCommercial: 0,
          allowCommercialReassignment: true,
          workingDaySelection: [1],
          historyCacheHits: 0,
          historyCacheMisses: 0,
          historyBuildMs: 0,
          dedupedClientResult: { duplicateRows: 0 },
          historyMatchDiagnostics: null,
          strictCa: false,
          totalSlots: 1,
          totalConfiguredCapacity: 1,
          optimizerPayload: {
            planning_mode: 'sales_coverage',
            planning_start_date: '2026-08-03',
            planning_days: 1,
            visit_frequency_days: 14,
            working_days: [1],
            commercials: [{ code: 'C01', available_dates: ['2026-08-03'] }],
            clients: [{ client_id: '15', client_code: '00152', allowed_commercial_codes: ['C01'] }]
          }
        }),
        fetchOrToolsCoveragePlan: async () => ({ data: optimizerResult }),
        fetchOrToolsCoverageAnalysis: async () => {
          throw new Error('analyze endpoint should not be called in this unified flow')
        }
      }
    )

    assert.ok(capturedLogs.some(line => line.includes('[COVERAGE_INPUT] request_params_hash=req-hash')))
    assert.ok(capturedLogs.some(line => line.includes('[COVERAGE_GREEDY_TRACE] greedy_candidate_order_hash=pairs-order-hash')))
    assert.ok(capturedLogs.some(line => line.includes('[COVERAGE_RESULT] node_python_payload_hash=')))
    assert.ok(capturedLogs.every(line => !line.includes('clients_snapshot=')))
  } finally {
    console.log = originalConsoleLog
    if (previousPerfDebug == null) {
      delete process.env.COVERAGE_PERF_DEBUG
    } else {
      process.env.COVERAGE_PERF_DEBUG = previousPerfDebug
    }
  }
})

test('coverage-plan node canonical hash stays aligned with the Python canonical hash for the same business payload', async () => {
  const pythonCanonicalHash = '88868507a40202f4755f40cf1606d384b3349a59ac3a2ebea5c2c0d5466207e7'
  const optimizerResult = {
    status: 'success',
    reason: null,
    summary: {
      planning_start_date: '2026-08-03',
      planning_end_date: '2026-08-04',
      clients_to_cover: 3,
      unique_clients_covered: 2,
      missing_clients_count: 1,
      duplicate_clients_count: 0,
      total_visits: 2,
      total_slots: 2,
      used_slots: 2,
      unused_slots: 0,
      total_capacity: 2,
      required_average_per_slot: 1,
      required_minimum_max_per_slot: 1,
      total_predicted_ca: 420.0,
      predicted_ca_known_count: 1,
      predicted_ca_unknown_count: 1,
      predicted_ca_is_complete: false,
      total_ca_shortfall: 0.0,
      solver_status: 'FEASIBLE',
      coverage_rate: 66.67,
      average_clients_per_route: 1.0,
      routes_count: 2,
      active_clients: 3,
      unique_clients_planned: 2,
      missing_clients: 1,
      duplicate_clients: 0,
      predicted_ca: 420.0,
      total_estimated_km: 12.5
    },
    blocks: [
      {
        slot_id: '2026-08-04::C002',
        date: '2026-08-04',
        commercial_code: 'C002',
        clients: [
          {
            visit_order: 1,
            client_id: 'same-null',
            client_code: '152',
            predicted_ca: null,
            recommended_quantity: null,
            purchase_prediction_score: null,
            recovery_priority_score: null
          }
        ]
      },
      {
        slot_id: '2026-08-03::C001',
        date: '2026-08-03',
        commercial_code: 'C001',
        clients: [
          {
            visit_order: 2,
            client_id: 'same-00152',
            client_code: '00152',
            predicted_ca: 420.0,
            recommended_quantity: 6.0,
            purchase_prediction_score: 85.0,
            recovery_priority_score: null
          }
        ]
      }
    ],
    diagnostics: {
      missing_clients: ['same-missing'],
      duplicate_clients: []
    },
    meta: {
      result_hashes: {
        canonical_functional_result_hash: pythonCanonicalHash
      }
    }
  }

  const result = await __testables.generateCoveragePlanResponse(
    { planning_mode: 'sales_coverage' },
    {
      buildCoveragePlanningContext: async () => ({
        planningMode: 'sales_coverage',
        startDate: '2026-08-03',
        planningDays: 2,
        planningDaysList: [{ date: '2026-08-03' }, { date: '2026-08-04' }],
        visitFrequencyDays: 14,
        selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
        selectedClientsCount: 3,
        requestedUserMinVisits: 1,
        normalizedUserMinVisits: 1,
        requestedUserMaxVisits: 2,
        adjustedTargetMaxVisitsPerSlot: 2,
        maxHardPhysicalMaxVisitsPerSlot: 2,
        hardPhysicalLimitedSlotsCount: 0,
        recommendedMaxVisitsPerSlot: 2,
        resolvedMaxVisitsPerSlot: 2,
        capacityMode: 'configured_hard_capacity',
        timeCapacityKnown: false,
        operationalCapacityKnown: true,
        historicalSoftCapacityTotal: 2,
        salesActivityProxyTotal: 2,
        minDailyCaPerCommercial: 0,
        allowCommercialReassignment: true,
        workingDaySelection: [1, 2],
        historyCacheHits: 0,
        historyCacheMisses: 0,
        historyBuildMs: 0,
        dedupedClientResult: { duplicateRows: 0 },
        historyMatchDiagnostics: null,
        strictCa: false,
        totalSlots: 2,
        totalConfiguredCapacity: 2,
        optimizerPayload: {
          planning_mode: 'sales_coverage',
          planning_start_date: '2026-08-03',
          planning_days: 2,
          visit_frequency_days: 14,
          working_days: [1, 2],
          commercials: [{ code: 'C01', available_dates: ['2026-08-03', '2026-08-04'] }],
          clients: [
            { client_id: 'same-00152', client_code: '00152', allowed_commercial_codes: ['C01'] },
            { client_id: 'same-null', client_code: '152', allowed_commercial_codes: ['C01'] },
            { client_id: 'same-missing', client_code: 'MISSING', allowed_commercial_codes: ['C01'] }
          ]
        }
      }),
      fetchOrToolsCoveragePlan: async () => ({ data: optimizerResult })
    }
  )

  assert.equal(result.payload.meta.result_hashes.canonical_functional_result_hash, pythonCanonicalHash)
  assert.equal(__testables.computeCoverageFunctionalResultHash(result.payload), pythonCanonicalHash)
})

test('sales coverage planning context keeps horizon, coverage window and daily max mode distinct', async () => {
  const planningContext = await __testables.buildCoveragePlanningContext(
    {
      planning_mode: 'sales_coverage',
      planning_start_date: '2026-08-03',
      planning_horizon_days: 30,
      coverage_window_days: 14,
      daily_max_mode: 'strict',
      min_clients: 20,
      max_clients: 30,
      working_days: [1, 2, 3, 4, 5],
      commercial_codes: ['C01']
    },
    {
      fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial C01' }],
      fetchCoverageActiveClients: async () => ({
        clients: [
          {
            client_id: '15',
            client_code: '00152',
            nbr_client: '00152',
            nom: 'Client 00152',
            latitude: 36.8,
            longitude: 10.1,
            user_code: '1',
            delegation: 'ELMENZAH',
            routing_code: 'Route Nord',
            region: 'Nord',
            historical_commercial_code: 'C01',
            resolved_commercial_code: 'C01',
            last_real_visit_date: null,
            history_metrics: {
              avg_ca_hist: 150,
              avg_load_units_hist: 2
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
      loadRecoveryProfiles: async () => [],
      loadCoveragePurchasePredictionProfiles: async () => ({
        profiles: []
      })
    }
  )

  assert.equal(planningContext.planningHorizonDays, 30)
  assert.equal(planningContext.coverageWindowDays, 14)
  assert.equal(planningContext.dailyMaxMode, 'strict')
  assert.equal(planningContext.optimizerPayload.planning_horizon_days, 30)
  assert.equal(planningContext.optimizerPayload.coverage_window_days, 14)
  assert.equal(planningContext.optimizerPayload.daily_max_mode, 'strict')
  assert.equal(planningContext.optimizerPayload.clients[0].last_real_visit_date, null)
})

test('coverage precheck computes strict capacity deficit and minimum average before Python generation', () => {
  const planningContext = {
    planningMode: 'sales_coverage',
    startDate: '2026-08-03',
    planningDays: 30,
    planningHorizonDays: 30,
    visitFrequencyDays: 14,
    coverageWindowDays: 14,
    dailyMaxMode: 'flexible',
    selectedCommercials: new Array(6).fill(null).map((_, index) => ({ value: `C0${index + 1}`, label: `Commercial ${index + 1}` })),
    selectedClientsCount: 5768,
    requiredVisitsCount: 5768,
    requestedUserMinVisits: 20,
    normalizedUserMinVisits: 20,
    requestedUserMaxVisits: 30,
    adjustedTargetMaxVisitsPerSlot: 33,
    recommendedMaxVisitsPerSlot: 33,
    resolvedMaxVisitsPerSlot: 33,
    strictCa: false,
    timeCapacityKnown: false,
    operationalCapacityKnown: false,
    planningDaysList: [],
    workingDaySelection: [1, 2, 3, 4, 5],
    totalSlots: 180,
    theoreticalTotalSlots: 180,
    totalConfiguredCapacity: 5940,
    dedupedClientResult: { duplicateRows: 0 },
    historyMatchDiagnostics: null,
    capacityPrecheck: {
      active_clients_count: 5768,
      required_visits_count: 5768,
      available_slots_count: 180,
      available_slots_after_constraints_count: 180,
      strict_capacity: 5400,
      capacity_deficit: 368,
      minimum_required_average: 32.04,
      minimum_required_peak_estimate: 33,
      feasibility_status: 'strict_capacity_insufficient',
      coverage_guarantee_status: 'single_visit_only'
    }
  }

  const response = __testables.buildCoveragePrecheckResponse(planningContext)

  assert.equal(response.capacity_precheck.strict_capacity, 5400)
  assert.equal(response.capacity_precheck.capacity_deficit, 368)
  assert.equal(response.capacity_precheck.available_slots_count, 180)
  assert.ok(response.capacity_precheck.minimum_required_average > 32)
  assert.equal(response.capacity_precheck.minimum_required_peak_estimate, 33)
  assert.equal(response.request_context.planning_horizon_days, 30)
  assert.equal(response.request_context.coverage_window_days, 14)
  assert.equal(response.request_context.daily_max_mode, 'flexible')
  assert.equal(response.request_context.coverage_guarantee_status, 'single_visit_only')
  assert.ok(response.message.includes('368'))
})

test('coverage capacity precheck stays lightweight and never calls history, profiles, predictions or Python', async () => {
  const observed = {
    clientHistoryCalls: 0,
    salesProfilesCalls: 0,
    validatedVisitProfilesCalls: 0,
    predictionsCalls: 0,
    recoveryCalls: 0,
    optimizeCalls: 0,
    analyzeCalls: 0
  }

  const planningContext = await __testables.buildCoverageCapacityPrecheckContext(
    {
      start_date: '2026-08-02',
      planning_horizon_days: 30,
      coverage_window_days: 14,
      minimum_clients: 20,
      maximum_clients: 30,
      daily_max_mode: 'strict',
      commercial: 'all'
    },
    {
      fetchCommercialOptions: async () => new Array(6).fill(null).map((_, index) => ({
        value: `C0${index + 1}`,
        label: `Commercial ${index + 1}`
      })),
      countCoverageActiveClientsLight: async () => 5768,
      fetchCoverageActiveClients: async () => {
        observed.clientHistoryCalls += 1
        return { clients: [] }
      },
      fetchCoverageCommercialCapacityProfiles: async () => {
        observed.salesProfilesCalls += 1
        return new Map()
      },
      fetchCoverageValidatedVisitCapacityProfiles: async () => {
        observed.validatedVisitProfilesCalls += 1
        return new Map()
      },
      loadRecoveryProfiles: async () => {
        observed.recoveryCalls += 1
        return []
      },
      loadCoveragePurchasePredictionProfiles: async () => {
        observed.predictionsCalls += 1
        return { profiles: [] }
      },
      fetchOrToolsCoveragePlan: async () => {
        observed.optimizeCalls += 1
        return { data: {} }
      },
      fetchOrToolsCoverageAnalysis: async () => {
        observed.analyzeCalls += 1
        return { data: {} }
      }
    }
  )

  assert.equal(observed.clientHistoryCalls, 0)
  assert.equal(observed.salesProfilesCalls, 0)
  assert.equal(observed.validatedVisitProfilesCalls, 0)
  assert.equal(observed.predictionsCalls, 0)
  assert.equal(observed.recoveryCalls, 0)
  assert.equal(observed.optimizeCalls, 0)
  assert.equal(observed.analyzeCalls, 0)
  assert.equal(planningContext.capacityPrecheck.available_slots_count, 180)
  assert.equal(planningContext.capacityPrecheck.strict_capacity, 5400)
  assert.equal(planningContext.capacityPrecheck.capacity_deficit, 368)
  assert.equal(planningContext.capacityPrecheck.minimum_required_average, 32.04)
  assert.equal(planningContext.capacityPrecheck.minimum_required_peak_estimate, 33)
})

test('coverage client scope keeps all active clients when all selected commercials are used for slots only', async () => {
  const sixCommercials = new Array(6).fill(null).map((_, index) => ({
    value: `C0${index + 1}`,
    label: `Commercial ${index + 1}`
  }))
  let observedClientScope = null

  const planningContext = await __testables.buildCoverageCapacityPrecheckContext(
    {
      start_date: '2026-08-03',
      planning_horizon_days: 14,
      coverage_window_days: 14,
      maximum_clients: 30,
      daily_max_mode: 'strict',
      commercial: 'all'
    },
    {
      fetchCommercialOptions: async () => sixCommercials,
      countCoverageActiveClientsLight: async ({ clientScope }) => {
        observedClientScope = clientScope
        return 5768
      }
    }
  )

  const response = __testables.buildCoveragePrecheckResponse(planningContext)

  assert.equal(planningContext.capacityPrecheck.active_clients_count, 5768)
  assert.equal(planningContext.capacityPrecheck.required_visits_count, 5768)
  assert.equal(planningContext.capacityPrecheck.available_slots_count, 84)
  assert.equal(planningContext.capacityPrecheck.strict_capacity, 2520)
  assert.equal(planningContext.capacityPrecheck.capacity_deficit, 3248)
  assert.equal(planningContext.capacityPrecheck.minimum_required_average, 68.67)
  assert.equal(planningContext.capacityPrecheck.minimum_required_peak_estimate, 69)
  assert.equal(observedClientScope.mode, 'all_active_clients')
  assert.equal(observedClientScope.client_filter_applied, false)
  assert.equal(response.client_scope.mode, 'all_active_clients')
  assert.equal(response.client_scope.active_clients_count, 5768)
  assert.equal(response.client_scope.selected_commercial_codes_count, 6)
  assert.equal(response.client_scope.client_filter_applied, false)
})

test('coverage light precheck all scope does not add a user_code commercial filter', async () => {
  let observedSql = ''
  let observedParams = null

  await __testables.countCoverageActiveClientsLight({
    clientScope: __testables.resolveCoverageClientScope({
      selectedCommercialCodes: ['C01', 'C02', 'C03', 'C04', 'C05', 'C06'],
      availableCommercialCodes: ['C01', 'C02', 'C03', 'C04', 'C05', 'C06']
    }),
    queryImpl: async (sql, params) => {
      observedSql = sql
      observedParams = params
      return [{ active_clients_count: 5768 }]
    }
  })

  assert.equal(observedSql.includes("TRIM(COALESCE(c.user_code, '')) IN"), false)
  assert.equal(observedSql.includes('client_visit_activity_light'), false)
  assert.equal(observedSql.includes('client_doc_activity_light'), false)
  assert.deepEqual(observedParams, [])
})

test('coverage light precheck for a specific commercial matches coverage-plan resolved commercial semantics', async () => {
  let observedSql = ''
  let observedParams = null

  await __testables.countCoverageActiveClientsLight({
    clientScope: __testables.resolveCoverageClientScope({
      selectedCommercialCodes: ['C01'],
      availableCommercialCodes: ['C01', 'C02'],
      selectedClientIds: ['15', '16']
    }),
    queryImpl: async (sql, params) => {
      observedSql = sql
      observedParams = params
      return [{ active_clients_count: 2 }]
    }
  })

  assert.equal(observedSql.includes('client_visit_activity_light'), true)
  assert.equal(observedSql.includes('client_doc_activity_light'), true)
  assert.equal(observedSql.includes("TRIM(COALESCE(c.user_code, '')) IN"), false)
  assert.equal(observedSql.includes('CAST(c.id AS CHAR) IN (?, ?)'), true)
  assert.deepEqual(observedParams, ['C01', '15', '16'])
})

test('coverage capacity precheck keeps the same capacity calculation in strict and flexible modes', async () => {
  const baseOverrides = {
    fetchCommercialOptions: async () => new Array(6).fill(null).map((_, index) => ({
      value: `C0${index + 1}`,
      label: `Commercial ${index + 1}`
    })),
    countCoverageActiveClientsLight: async () => 5768
  }

  const strictContext = await __testables.buildCoverageCapacityPrecheckContext(
    {
      start_date: '2026-08-02',
      planning_horizon_days: 30,
      coverage_window_days: 14,
      maximum_clients: 30,
      daily_max_mode: 'strict',
      commercial: 'all'
    },
    baseOverrides
  )
  const flexibleContext = await __testables.buildCoverageCapacityPrecheckContext(
    {
      start_date: '2026-08-02',
      planning_horizon_days: 30,
      coverage_window_days: 14,
      maximum_clients: 30,
      daily_max_mode: 'flexible',
      commercial: 'all'
    },
    baseOverrides
  )

  assert.equal(strictContext.capacityPrecheck.available_slots_count, 180)
  assert.equal(flexibleContext.capacityPrecheck.available_slots_count, 180)
  assert.equal(strictContext.capacityPrecheck.strict_capacity, 5400)
  assert.equal(flexibleContext.capacityPrecheck.strict_capacity, 5400)
  assert.equal(strictContext.capacityPrecheck.capacity_deficit, 368)
  assert.equal(flexibleContext.capacityPrecheck.capacity_deficit, 368)
})

test('coverage-plan result reports strict mode without exceeding the requested max and keeps missing clients explicit', async () => {
  const result = await __testables.generateCoveragePlanResponse(
    { planning_mode: 'sales_coverage' },
    {
      buildCoveragePlanningContext: async () => ({
        planningMode: 'sales_coverage',
        startDate: '2026-08-03',
        planningDays: 2,
        planningHorizonDays: 2,
        visitFrequencyDays: 14,
        coverageWindowDays: 14,
        dailyMaxMode: 'strict',
        selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
        clientScope: {
          mode: 'specific_commercial',
          selectedCommercialCodesCount: 1,
          client_filter_applied: true
        },
        selectedClientsCount: 3,
        requiredVisitsCount: 3,
        requestedUserMinVisits: 1,
        normalizedUserMinVisits: 1,
        requestedUserMaxVisits: 2,
        adjustedTargetMaxVisitsPerSlot: 2,
        maxHardPhysicalMaxVisitsPerSlot: 2,
        hardPhysicalLimitedSlotsCount: 0,
        recommendedMaxVisitsPerSlot: 2,
        resolvedMaxVisitsPerSlot: 2,
        capacityMode: 'configured_hard_capacity',
        timeCapacityKnown: false,
        operationalCapacityKnown: true,
        historicalSoftCapacityTotal: 2,
        salesActivityProxyTotal: 2,
        minDailyCaPerCommercial: 0,
        allowCommercialReassignment: true,
        workingDaySelection: [1, 2],
        historyCacheHits: 0,
        historyCacheMisses: 0,
        historyBuildMs: 0,
        dedupedClientResult: { duplicateRows: 0 },
        historyMatchDiagnostics: null,
        strictCa: false,
        totalSlots: 2,
        totalConfiguredCapacity: 4,
        theoreticalTotalSlots: 2,
        capacityPrecheck: {
          strict_capacity: 4,
          required_visits_count: 3,
          available_slots_count: 2,
          capacity_deficit: 0,
          minimum_required_average: 1.5,
          minimum_required_peak_estimate: 2
        },
        optimizerPayload: {
          planning_mode: 'sales_coverage',
          planning_start_date: '2026-08-03',
          planning_days: 2,
          planning_horizon_days: 2,
          visit_frequency_days: 14,
          coverage_window_days: 14,
          daily_max_mode: 'strict',
          working_days: [1, 2],
          commercials: [{ code: 'C01', available_dates: ['2026-08-03', '2026-08-04'] }],
          clients: [
            { client_id: '15', client_code: '00152', allowed_commercial_codes: ['C01'] },
            { client_id: '16', client_code: '152', allowed_commercial_codes: ['C01'] },
            { client_id: '17', client_code: '00017', allowed_commercial_codes: ['C01'] }
          ]
        }
      }),
      fetchOrToolsCoveragePlan: async () => ({
        data: {
          status: 'partial_success',
          summary: {
            planning_start_date: '2026-08-03',
            planning_end_date: '2026-08-04',
            clients_to_cover: 3,
            unique_clients_covered: 2,
            missing_clients_count: 1,
            duplicate_clients_count: 0,
            total_visits: 2,
            total_slots: 2,
            used_slots: 1,
            unused_slots: 1,
            total_capacity: 4,
            required_average_per_slot: 1.5,
            required_minimum_max_per_slot: 2,
            total_predicted_ca: 120,
            predicted_ca_known_count: 2,
            predicted_ca_unknown_count: 0,
            predicted_ca_is_complete: true,
            total_ca_shortfall: 0,
            solver_status: 'FEASIBLE',
            coverage_rate: 66.67,
            average_clients_per_route: 2,
            routes_count: 1,
            active_clients: 3,
            unique_clients_planned: 2,
            missing_clients: 1,
            duplicate_clients: 0,
            predicted_ca: 120,
            total_estimated_km: 8
          },
          blocks: [
            {
              slot_id: '2026-08-03::C01',
              date: '2026-08-03',
              commercial_code: 'C01',
              clients_count: 2,
              clients: [
                { client_id: '15', client_code: '00152', visit_order: 1, predicted_ca: 60 },
                { client_id: '16', client_code: '152', visit_order: 2, predicted_ca: 60 }
              ]
            }
          ],
          diagnostics: {
            missing_clients: ['17'],
            duplicate_clients: []
          }
        }
      })
    }
  )

  assert.equal(result.payload.summary.daily_max_mode, 'strict')
  assert.equal(result.payload.client_scope.mode, 'specific_commercial')
  assert.equal(result.payload.client_scope.selected_commercial_codes_count, 1)
  assert.equal(result.payload.client_scope.active_clients_count, 3)
  assert.equal(result.payload.summary.blocks_above_user_max, 0)
  assert.equal(result.payload.summary.maximum_block_overage, 0)
  assert.equal(result.payload.summary.missing_clients_count, 1)
  assert.equal(result.payload.summary.coverage_guarantee_status, 'single_visit_only')
  assert.ok(result.payload.message.includes('Mode maximum strict'))
})

test('coverage-plan result reports flexible overruns explicitly when strict capacity is insufficient', async () => {
  const result = await __testables.generateCoveragePlanResponse(
    { planning_mode: 'sales_coverage' },
    {
      buildCoveragePlanningContext: async () => ({
        planningMode: 'sales_coverage',
        startDate: '2026-08-03',
        planningDays: 2,
        planningHorizonDays: 2,
        visitFrequencyDays: 14,
        coverageWindowDays: 14,
        dailyMaxMode: 'flexible',
        selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
        selectedClientsCount: 5,
        requiredVisitsCount: 5,
        requestedUserMinVisits: 1,
        normalizedUserMinVisits: 1,
        requestedUserMaxVisits: 2,
        adjustedTargetMaxVisitsPerSlot: 3,
        maxHardPhysicalMaxVisitsPerSlot: 3,
        hardPhysicalLimitedSlotsCount: 0,
        recommendedMaxVisitsPerSlot: 3,
        resolvedMaxVisitsPerSlot: 3,
        capacityMode: 'sales_activity_proxy',
        timeCapacityKnown: false,
        operationalCapacityKnown: false,
        historicalSoftCapacityTotal: 4,
        salesActivityProxyTotal: 4,
        minDailyCaPerCommercial: 0,
        allowCommercialReassignment: true,
        workingDaySelection: [1, 2],
        historyCacheHits: 0,
        historyCacheMisses: 0,
        historyBuildMs: 0,
        dedupedClientResult: { duplicateRows: 0 },
        historyMatchDiagnostics: null,
        strictCa: false,
        totalSlots: 2,
        totalConfiguredCapacity: 6,
        theoreticalTotalSlots: 2,
        capacityPrecheck: {
          strict_capacity: 4,
          required_visits_count: 5,
          available_slots_count: 2,
          capacity_deficit: 1,
          minimum_required_average: 2.5,
          minimum_required_peak_estimate: 3
        },
        optimizerPayload: {
          planning_mode: 'sales_coverage',
          planning_start_date: '2026-08-03',
          planning_days: 2,
          planning_horizon_days: 2,
          visit_frequency_days: 14,
          coverage_window_days: 14,
          daily_max_mode: 'flexible',
          working_days: [1, 2],
          commercials: [{ code: 'C01', available_dates: ['2026-08-03', '2026-08-04'] }],
          clients: [
            { client_id: '15', client_code: '00152', allowed_commercial_codes: ['C01'] },
            { client_id: '16', client_code: '152', allowed_commercial_codes: ['C01'] }
          ]
        }
      }),
      fetchOrToolsCoveragePlan: async () => ({
        data: {
          status: 'success',
          summary: {
            planning_start_date: '2026-08-03',
            planning_end_date: '2026-08-04',
            clients_to_cover: 5,
            unique_clients_covered: 5,
            missing_clients_count: 0,
            duplicate_clients_count: 0,
            total_visits: 5,
            total_slots: 2,
            used_slots: 2,
            unused_slots: 0,
            total_capacity: 6,
            required_average_per_slot: 2.5,
            required_minimum_max_per_slot: 3,
            total_predicted_ca: 250,
            predicted_ca_known_count: 5,
            predicted_ca_unknown_count: 0,
            predicted_ca_is_complete: true,
            total_ca_shortfall: 0,
            solver_status: 'FEASIBLE',
            coverage_rate: 100,
            average_clients_per_route: 2.5,
            routes_count: 2,
            active_clients: 5,
            unique_clients_planned: 5,
            missing_clients: 0,
            duplicate_clients: 0,
            predicted_ca: 250,
            total_estimated_km: 10
          },
          blocks: [
            {
              slot_id: '2026-08-03::C01',
              date: '2026-08-03',
              commercial_code: 'C01',
              clients_count: 3,
              clients: [
                { client_id: '15', client_code: '00152', visit_order: 1, predicted_ca: 50 },
                { client_id: '16', client_code: '152', visit_order: 2, predicted_ca: 50 },
                { client_id: '17', client_code: '00017', visit_order: 3, predicted_ca: 50 }
              ]
            },
            {
              slot_id: '2026-08-04::C01',
              date: '2026-08-04',
              commercial_code: 'C01',
              clients_count: 2,
              clients: [
                { client_id: '18', client_code: '00018', visit_order: 1, predicted_ca: 50 },
                { client_id: '19', client_code: '00019', visit_order: 2, predicted_ca: 50 }
              ]
            }
          ],
          diagnostics: {
            missing_clients: [],
            duplicate_clients: []
          }
        }
      })
    }
  )

  assert.equal(result.payload.summary.daily_max_mode, 'flexible')
  assert.equal(result.payload.summary.blocks_above_user_max, 1)
  assert.equal(result.payload.summary.maximum_block_overage, 1)
  assert.equal(result.payload.summary.coverage_guarantee_status, 'single_visit_only')
  assert.ok(result.payload.message.includes('insuffisante de 1 visite'))
})

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildVisitOpportunities
} = require('../visit_opportunity_builder')
const {
  assignVisitOpportunities,
  buildCommercialSlots
} = require('../visit_assignment_optimizer')
const {
  buildClientFinalDecisions,
  buildSummary
} = require('../next_best_visit_engine')
const {
  generateNextBestVisitPlan,
  __testables: serviceTestables
} = require('../next_best_visit_service')

function makeClient(clientId, overrides = {}) {
  const normalizedId = String(clientId)
  return {
    client_id: normalizedId,
    client_code: normalizedId.padStart(5, '0'),
    nom: `Client ${normalizedId}`,
    latitude: 36.8,
    longitude: 10.1,
    ...overrides
  }
}

function buildAuditFixtureVisits() {
  const visits = []

  for (let clientId = 1; clientId <= 60; clientId += 1) {
    for (let visitIndex = 0; visitIndex < 3; visitIndex += 1) {
      visits.push({ client_id: String(clientId), client_code: String(clientId).padStart(5, '0') })
    }
  }

  for (let clientId = 61; clientId <= 63; clientId += 1) {
    for (let visitIndex = 0; visitIndex < 4; visitIndex += 1) {
      visits.push({ client_id: String(clientId), client_code: String(clientId).padStart(5, '0') })
    }
  }

  for (let clientId = 64; clientId <= 328; clientId += 1) {
    visits.push({ client_id: String(clientId), client_code: String(clientId).padStart(5, '0') })
  }

  assert.equal(visits.length, 457)
  return visits.map((visit, index) => {
    const isKnownPrediction = index < 290
    const predictedCa = !isKnownPrediction
      ? null
      : index === 289
        ? 18.4
        : 4
    const decisionMode = index < 252
      ? 'predictive'
      : index < 295
        ? 'hybrid'
        : 'exploration'

    return {
      ...visit,
      client_name: `Client ${visit.client_id}`,
      confidence: 51.8,
      purchase_prediction_known: isKnownPrediction,
      purchase_probability: isKnownPrediction ? 23.8 : null,
      predicted_ca: predictedCa,
      expected_order_value: predictedCa,
      recommended_quantity: isKnownPrediction ? 1 : null,
      decision_mode: decisionMode,
      zone_resolution_status: index < 200 ? 'zone_resolved' : 'zone_source_missing'
    }
  })
}

test('selected clients and deferred clients stay mutually exclusive even when one client has rejected opportunities', () => {
  const slots = buildCommercialSlots({
    planningDates: ['2026-08-05', '2026-08-07'],
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    commercialConstraintsByCode: new Map([[
      'C01',
      {
        available_dates: ['2026-08-05', '2026-08-07'],
        unavailable_dates: [],
        hard_max_visits_by_date: {
          '2026-08-05': 1,
          '2026-08-07': 1
        }
      }
    ]]),
    requestMaxVisits: 1,
    minDailyCaPerCommercial: null
  })

  const assignment = assignVisitOpportunities({
    opportunities: [
      {
        visit_opportunity_id: 'opp-selected',
        client_id: '10',
        client_code: '00010',
        client_name: 'Client 10',
        candidate_date: '2026-08-05',
        possible_commercial_codes: ['C01'],
        purchase_probability: 80,
        predicted_ca: 120,
        expected_order_value: 120,
        recommended_quantity: 2,
        confidence: 80,
        recommended_visit_interval_days: 10,
        purchase_prediction_known: true,
        decision_mode: 'predictive',
        explanation_codes: [],
        visit_opportunity_score: 95
      },
      {
        visit_opportunity_id: 'opp-rejected-same-client',
        client_id: '10',
        client_code: '00010',
        client_name: 'Client 10',
        candidate_date: '2026-08-07',
        possible_commercial_codes: ['C01'],
        purchase_probability: 70,
        predicted_ca: 80,
        expected_order_value: 80,
        recommended_quantity: 1,
        confidence: 75,
        recommended_visit_interval_days: 10,
        purchase_prediction_known: true,
        decision_mode: 'predictive',
        explanation_codes: [],
        visit_opportunity_score: 70
      },
      {
        visit_opportunity_id: 'opp-deferred',
        client_id: '11',
        client_code: '00011',
        client_name: 'Client 11',
        candidate_date: '2026-08-05',
        possible_commercial_codes: ['C01'],
        purchase_probability: 10,
        predicted_ca: 10,
        expected_order_value: 10,
        recommended_quantity: 1,
        confidence: 45,
        recommended_visit_interval_days: 14,
        purchase_prediction_known: true,
        decision_mode: 'hybrid',
        explanation_codes: ['LOW_PURCHASE_PROBABILITY'],
        visit_opportunity_score: 10
      }
    ],
    slots,
    options: {
      respectAvailability: 'flexible',
      minimumConfidence: 0,
      minimumVisitsPreference: 0
    }
  })

  assert.equal(assignment.blocks.length, 1)
  assert.equal(assignment.deferred_clients.some(client => client.client_id === '10'), false)
  assert.equal(assignment.deferred_clients.some(client => client.client_id === '11'), true)
  assert.equal(assignment.rejected_opportunities_by_selected_client.length, 1)
  assert.equal(assignment.rejected_opportunities_by_selected_client[0].client_id, '10')
})

test('audit fixture keeps the exclusive population invariant and exposes no-candidate clients', () => {
  const clients = Array.from({ length: 5768 }, (_, index) => makeClient(index + 1))
  const candidateDatesByClientId = new Map()
  const compatibleCommercialCodesByClientId = new Map()
  const rejectedOpportunities = []

  clients.forEach((client, index) => {
    const clientId = String(index + 1)
    compatibleCommercialCodesByClientId.set(clientId, ['C01'])
    if (index < 328) {
      candidateDatesByClientId.set(clientId, ['2026-08-04'])
      return
    }
    if (index < 328 + 4733) {
      candidateDatesByClientId.set(clientId, ['2026-08-05'])
      rejectedOpportunities.push({
        client_id: clientId,
        client_code: client.client_code,
        rejection_reason_codes: ['LOW_PURCHASE_PROBABILITY']
      })
      return
    }
    candidateDatesByClientId.set(clientId, [])
  })

  const finalDecisionSummary = buildClientFinalDecisions({
    clients,
    blocks: [{
      slot_id: '2026-08-04::C01',
      date: '2026-08-04',
      commercial_code: 'C01',
      clients: Array.from({ length: 328 }, (_, index) => ({
        client_id: String(index + 1),
        client_code: String(index + 1).padStart(5, '0')
      }))
    }],
    rejectedOpportunities,
    candidateDatesByClientId,
    cadenceProfiles: [],
    compatibleCommercialCodesByClientId,
    requestContext: {
      startDate: '2026-08-04',
      planningHorizonDays: 14,
      maxDaysWithoutContact: 21
    },
    planningDates: Array.from({ length: 14 }, (_, index) => `2026-08-${String(index + 4).padStart(2, '0')}`)
  })

  assert.equal(finalDecisionSummary.active_clients_count, 5768)
  assert.equal(finalDecisionSummary.category_counts.selected, 328)
  assert.equal(finalDecisionSummary.category_counts.deferred_low_score, 4733)
  assert.equal(finalDecisionSummary.category_counts.no_candidate_date, 707)
  assert.equal(finalDecisionSummary.clients_sans_date_recommandable.length, 707)
  assert.equal(finalDecisionSummary.population_invariant_status, 'passed')
  assert.equal(finalDecisionSummary.population_invariant_difference, 0)
})

test('portfolio metadata attaches to every active client and exposes summary/feasibility', () => {
  const clients = [
    makeClient(1),
    makeClient(2)
  ]
  const candidateDateEntriesByClientId = new Map([
    ['1', [{
      client_id: '1',
      decision_mode: 'predictive',
      purchase_count: 4,
      history_depth: 12,
      candidate_date: '2026-08-04',
      preferred_date: '2026-08-04',
      earliest_allowed_date: '2026-08-04',
      latest_allowed_date: '2026-08-04',
      candidate_date_source: 'test_source',
      date_flexibility_type: 'fixed'
    }]],
    ['2', [{
      client_id: '2',
      decision_mode: 'hybrid',
      purchase_count: 2,
      history_depth: 6,
      candidate_date: '2026-08-05',
      preferred_date: '2026-08-05',
      earliest_allowed_date: '2026-08-05',
      latest_allowed_date: '2026-08-05',
      candidate_date_source: 'test_source',
      date_flexibility_type: 'fixed'
    }]]
  ])
  const candidateDatesByClientId = new Map([
    ['1', ['2026-08-04']],
    ['2', ['2026-08-05']]
  ])
const cadenceProfiles = [
  {
    client_id: '1',
    decision_mode: 'predictive',
    purchase_count: 4,
    history_depth: 12,
    recommended_visit_interval_days: 7,
    next_purchase_date_estimate: '2026-08-04',
    next_purchase_window_start: '2026-08-04',
    next_purchase_window_end: '2026-08-04',
    cadence_confidence: 0.85,
    purchase_prediction_known: true,
    purchase_prediction_score: 60
  },
  {
    client_id: '2',
    decision_mode: 'hybrid',
    purchase_count: 2,
    history_depth: 6,
    recommended_visit_interval_days: 14,
    next_purchase_date_estimate: '2026-08-05',
    next_purchase_window_start: '2026-08-05',
    next_purchase_window_end: '2026-08-05',
    cadence_confidence: 0.65,
    purchase_prediction_known: false
  }
]
  const selectedCommercials = [{ value: 'C01', label: 'Commercial C01' }]
  const compatibleCommercialCodesByClientId = new Map([
    ['1', ['C01']],
    ['2', ['C01']]
  ])
  const rejectedOpportunities = [
    {
      client_id: '2',
      client_code: '00002',
      rejection_reason_codes: ['CAPACITY_REACHED']
    }
  ]
  const finalDecisionSummary = buildClientFinalDecisions({
    clients,
    blocks: [
      {
        slot_id: '2026-08-04::C01',
        date: '2026-08-04',
        commercial_code: 'C01',
        clients: [{ client_id: '1', client_code: '00001' }]
      }
    ],
    rejectedOpportunities,
    candidateDatesByClientId,
    candidateDateEntriesByClientId,
    cadenceProfiles,
    compatibleCommercialCodesByClientId,
    selectedCommercials,
    requestContext: {
      startDate: '2026-08-04',
      planningHorizonDays: 7,
      maxVisitsPerDay: 1,
      minVisitsPerDayPreference: 1,
      maxDaysWithoutContact: 21
    },
    planningDates: ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10']
  })

  assert.equal(finalDecisionSummary.active_clients_count, 2)
  assert.deepEqual(Object.keys(finalDecisionSummary.client_final_decisions).sort(), ['1', '2'])
  assert.equal(finalDecisionSummary.client_final_decisions['1'].portfolio_status, 'due_now')
  assert.equal(finalDecisionSummary.client_final_decisions['1'].next_action, 'visit_now')
  assert.equal(finalDecisionSummary.client_final_decisions['1'].next_due_date, '2026-08-04')
  assert.equal(finalDecisionSummary.client_final_decisions['2'].portfolio_status, 'capacity_unplanned')
  assert.equal(finalDecisionSummary.client_final_decisions['2'].next_action, 'review_capacity')
  assert.ok(finalDecisionSummary.client_final_decisions['2'].reason_codes.includes('CAPACITY_CONSTRAINT'))
  assert.equal(finalDecisionSummary.portfolio_summary.active_clients_count, 2)
  assert.equal(finalDecisionSummary.portfolio_summary.due_now_count, 1)
  assert.equal(finalDecisionSummary.portfolio_summary.capacity_unplanned_count, 1)
  assert.equal(finalDecisionSummary.portfolio_summary.portfolio_invariant_status, 'passed')
  assert.equal(finalDecisionSummary.portfolio_feasibility.feasibility_status, 'feasible')
  assert.equal(finalDecisionSummary.portfolio_feasibility.maximum_capacity, 7)
})

test('summary distinguishes visits from unique clients, repeated clients, null predictions, and partial CA', () => {
  const allVisits = buildAuditFixtureVisits()
  const finalDecisionSummary = {
    active_clients_count: 5768,
    category_counts: {
      selected: 328,
      deferred_capacity: 0,
      deferred_low_score: 4733,
      no_candidate_date: 707,
      below_confidence: 0,
      unavailable: 0,
      filtered_commercial_scope: 0,
      invalid_client_data: 0,
      other_unclassified: 0
    },
    population_invariant_status: 'passed',
    population_invariant_difference: 0
  }

  const summary = buildSummary({
    requestContext: {
      startDate: '2026-08-04',
      planningHorizonDays: 14,
      maxDaysWithoutContact: 21,
      dailyMaxMode: 'flexible'
    },
    blocks: [{
      slot_id: '2026-08-04::C01',
      date: '2026-08-04',
      commercial_code: 'C01',
      clients: allVisits
    }],
    finalDecisionSummary,
    cacheStatus: 'not_cached',
    objectiveMode: 'balanced'
  })

  assert.equal(summary.selected_unique_clients_count, 328)
  assert.equal(summary.selected_visits_count, 457)
  assert.equal(summary.selected_clients_with_multiple_visits_count, 63)
  assert.equal(summary.maximum_visits_for_one_client, 4)
  assert.equal(summary.deferred_unique_clients_count, 4733)
  assert.equal(summary.no_candidate_date_count, 707)
  assert.equal(summary.selected_prediction_known_count, 290)
  assert.equal(summary.selected_prediction_null_count, 167)
  assert.equal(summary.selected_prediction_coverage_rate, 63.5)
  assert.equal(summary.predicted_ca_known_sum, 1174.4)
  assert.equal(summary.predicted_ca_known_count, 290)
  assert.equal(summary.predicted_ca_null_count, 167)
  assert.equal(summary.expected_ca_completeness_status, 'partial')
  assert.equal(summary.high_probability_visits_count, 0)
  assert.equal(summary.high_probability_threshold, 50)
  assert.equal(summary.null_probability_count, 167)
  assert.equal(summary.probability_unit, 'percentage_0_100')
  assert.equal(summary.selected_predictive_count, 252)
  assert.equal(summary.selected_hybrid_count, 43)
  assert.equal(summary.selected_exploration_count, 162)
})

test('visit opportunities propagate zone metadata and distinguish missing source', () => {
  const opportunities = buildVisitOpportunities({
    clients: [
      makeClient(1, {
        user_code: 'C01',
        delegation: 'ELMENZAH',
        region: 'Tunis',
        routing_code: 'R1'
      }),
      makeClient(2, {
        latitude: 36.81,
        longitude: 10.11
      })
    ],
    cadenceProfiles: [
      {
        client_id: '1',
        recommended_visit_interval_days: 7,
        next_purchase_date_estimate: '2026-08-05',
        next_purchase_window_start: '2026-08-05',
        next_purchase_window_end: '2026-08-05',
        cadence_confidence: 0.8
      },
      {
        client_id: '2',
        recommended_visit_interval_days: 7,
        next_purchase_date_estimate: '2026-08-05',
        next_purchase_window_start: '2026-08-05',
        next_purchase_window_end: '2026-08-05',
        cadence_confidence: 0.8
      }
    ],
    predictionsByClientDate: new Map(),
    compatibleCommercialCodesByClientId: new Map([
      ['1', ['C01']],
      ['2', ['C01']]
    ]),
    depotByCommercialDate: new Map([
      ['C01::2026-08-05', { latitude: 36.82, longitude: 10.18 }]
    ]),
    options: {
      startDate: '2026-08-04',
      planningHorizonDays: 7,
      maxCandidateDatesPerClient: 1,
      candidateDatesByClientId: new Map([
        ['1', ['2026-08-05']],
        ['2', ['2026-08-05']]
      ])
    }
  })

  const resolvedZoneOpportunity = opportunities.find(opportunity => opportunity.client_id === '1')
  const missingZoneOpportunity = opportunities.find(opportunity => opportunity.client_id === '2')

  assert.equal(resolvedZoneOpportunity.user_code, 'C01')
  assert.equal(resolvedZoneOpportunity.delegation, 'ELMENZAH')
  assert.equal(resolvedZoneOpportunity.region, 'Tunis')
  assert.equal(resolvedZoneOpportunity.routing_code, 'R1')
  assert.equal(resolvedZoneOpportunity.zone_resolution_status, 'zone_resolved')
  assert.equal(missingZoneOpportunity.zone_resolution_status, 'zone_source_missing')
  assert.equal(missingZoneOpportunity.commercial_zone, null)
})

test('service wrapper returns development statuses and exposes covered timings', async () => {
  const payload = await generateNextBestVisitPlan({
    start_date: '2026-08-04',
    historical_cutoff_date: '2026-08-03',
    planning_horizon_days: 7,
    period_days: 7,
    objective_mode: 'balanced',
    max_clients: 2,
    min_clients: 0,
    max_days_without_contact: 2,
    commercial_codes: ['C01']
  }, {
    allowInlineProfileBuild: true,
    fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial C01' }],
    fetchCoverageActiveClients: async () => ({
      clients: [
        makeClient(1, {
          user_code: 'C01',
          delegation: 'ELMENZAH',
          region: 'Tunis',
          routing_code: 'R1'
        }),
        makeClient(2, {
          latitude: 36.81,
          longitude: 10.11
        })
      ]
    }),
    loadCoverageConstraints: async () => ({
      commercials: {
        C01: {
          available_dates: ['2026-08-04', '2026-08-05'],
          unavailable_dates: [],
          hard_max_visits_by_date: {
            '2026-08-04': 2,
            '2026-08-05': 2
          }
        }
      },
      client_restrictions: {}
    }),
    fetchAiPredictionsForClientBatch: async ({ targetDate, clientCodes }) => ({
      status: 'success',
      predictions: clientCodes.map(clientCode => (
        clientCode === '00001'
          ? {
              client_id: '1',
              client_code: clientCode,
              purchase_probability: targetDate === '2026-08-04' ? 22 : 18,
              predicted_ca: targetDate === '2026-08-04' ? 15 : 12,
              recommended_quantity: 1,
              model_confidence: 82,
              score: 22,
              vip: 22,
              probability_model_only: 21,
              habit_score: 20,
              recency_score: 19,
              prediction_source: 'test_batch'
            }
          : {
              client_id: '2',
              client_code: clientCode,
              purchase_probability: null,
              predicted_ca: null,
              recommended_quantity: null,
              model_confidence: null,
              score: null,
              vip: null,
              probability_model_only: null,
              habit_score: null,
              recency_score: null,
              prediction_source: 'test_batch'
            }
      )),
      meta: {
        prediction_requested_clients_count: clientCodes.length,
        prediction_returned_clients_count: clientCodes.length,
        prediction_known_count: clientCodes.filter(code => code === '00001').length,
        prediction_null_count: clientCodes.filter(code => code !== '00001').length,
        top_k_truncation_detected: false
      }
    }),
    queryAsync: async (sql) => {
      if (sql.includes('FROM entetecommercials')) {
        return [
          { historical_client_code: '00001', purchase_date: '2026-07-15', order_value: 100, order_quantity: 2, commercial_code: 'C01' },
          { historical_client_code: '00001', purchase_date: '2026-07-22', order_value: 120, order_quantity: 3, commercial_code: 'C01' },
          { historical_client_code: '00001', purchase_date: '2026-07-29', order_value: 140, order_quantity: 3, commercial_code: 'C01' },
          { historical_client_code: '00002', purchase_date: '2026-07-08', order_value: 70, order_quantity: 1, commercial_code: 'C01' },
          { historical_client_code: '00002', purchase_date: '2026-07-15', order_value: 75, order_quantity: 1, commercial_code: 'C01' },
          { historical_client_code: '00002', purchase_date: '2026-07-22', order_value: 80, order_quantity: 1, commercial_code: 'C01' }
        ]
      }
      if (sql.includes('FROM client_visits')) {
        return [
          { historical_client_code: '00001', visit_date: '2026-07-30', commercial_code: 'C01', visit_result: 'sale' }
        ]
      }
      return []
    },
    sharedDepotOrigin: {
      latitude: 36.82,
      longitude: 10.18,
      nom: 'Depot principal'
    }
  })

  const selectedVisits = payload.blocks.flatMap(block => block.clients || [])
  const resolvedZoneVisit = selectedVisits.find(visit => visit.client_id === '1')
  const missingZoneVisit = selectedVisits.find(visit => visit.client_id === '2')

  assert.equal(payload.statuses.data_environment, 'development')
  assert.equal(payload.statuses.data_environment === 'synthetic_validation', false)
  assert.equal(payload.statuses.data_representativeness, 'non_representative')
  assert.equal(resolvedZoneVisit.user_code, 'C01')
  assert.equal(resolvedZoneVisit.delegation, 'ELMENZAH')
  assert.equal(resolvedZoneVisit.region, 'Tunis')
  assert.equal(resolvedZoneVisit.routing_code, 'R1')
  assert.equal(resolvedZoneVisit.zone_resolution_status, 'zone_resolved')
  assert.equal(typeof payload.meta.performance.timing_coverage_rate, 'number')
  assert.equal(typeof payload.meta.performance.unaccounted_time_ms, 'number')
})

test('timing summaries can cover at least 95 percent in deterministic fixtures', () => {
  const performance = serviceTestables.summarizePerformanceStages([
    { stage: 'request_validation', duration_ms: 8 },
    { stage: 'load_active_clients', duration_ms: 12 },
    { stage: 'load_sales_history', duration_ms: 15 },
    { stage: 'load_visit_history', duration_ms: 10 },
    { stage: 'load_constraints', duration_ms: 7 },
    { stage: 'build_cadence_profiles', duration_ms: 6 },
    { stage: 'build_sparse_candidate_dates', duration_ms: 5 },
    { stage: 'prediction_payload_build', duration_ms: 4 },
    { stage: 'fetch_batch_predictions', duration_ms: 16 },
    { stage: 'prediction_response_mapping', duration_ms: 4 },
    { stage: 'build_opportunities', duration_ms: 3 },
    { stage: 'scoring', duration_ms: 2 },
    { stage: 'assignment', duration_ms: 2 },
    { stage: 'summary_aggregation', duration_ms: 1 },
    { stage: 'block_serialization', duration_ms: 1 },
    { stage: 'response_serialization', duration_ms: 1 },
    { stage: 'total_service', duration_ms: 100 }
  ])

  assert.equal(performance.timing_coverage_rate >= 95, true)
  assert.equal(performance.unaccounted_time_ms <= 5, true)
})

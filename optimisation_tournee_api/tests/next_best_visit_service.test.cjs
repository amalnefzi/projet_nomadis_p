const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildSparseCandidateDates,
  buildVisitOpportunities
} = require('../visit_opportunity_builder')
const {
  computeOpportunityScore
} = require('../visit_opportunity_scoring')
const {
  assignVisitOpportunities,
  buildCommercialSlots
} = require('../visit_assignment_optimizer')
const {
  generateNextBestVisitPlan
} = require('../next_best_visit_service')

test('frequent, monthly, and recent clients keep sparse candidate dates', () => {
  const frequentDates = buildSparseCandidateDates({
    client_id: '1',
    recommended_visit_interval_days: 4,
    usual_purchase_weekdays: [1, 4],
    next_purchase_date_estimate: '2026-08-05',
    next_purchase_window_start: '2026-08-04',
    next_purchase_window_end: '2026-08-06',
    days_since_last_purchase: 5
  }, {
    startDate: '2026-08-03',
    planningHorizonDays: 14,
    maxCandidateDatesPerClient: 4,
    maxDaysWithoutContact: 12
  })

  const monthlyDates = buildSparseCandidateDates({
    client_id: '2',
    recommended_visit_interval_days: 30,
    usual_purchase_weekdays: [1],
    next_purchase_date_estimate: '2026-08-29',
    next_purchase_window_start: '2026-08-27',
    next_purchase_window_end: '2026-08-31',
    days_since_last_purchase: 2
  }, {
    startDate: '2026-08-03',
    planningHorizonDays: 14,
    maxCandidateDatesPerClient: 4,
    maxDaysWithoutContact: 35
  })

  const recentDates = buildSparseCandidateDates({
    client_id: '3',
    recommended_visit_interval_days: 7,
    usual_purchase_weekdays: [],
    next_purchase_date_estimate: null,
    next_purchase_window_start: null,
    next_purchase_window_end: null,
    last_contact_date: '2026-08-02',
    days_since_last_purchase: 1
  }, {
    startDate: '2026-08-03',
    planningHorizonDays: 5,
    maxCandidateDatesPerClient: 4,
    maxDaysWithoutContact: 3
  })

  assert.ok(frequentDates.length >= 2, 'frequent client should receive multiple sparse dates')
  assert.ok(frequentDates.every(date => date >= '2026-08-03' && date <= '2026-08-16'))
  assert.ok(monthlyDates.length <= 2, 'monthly client should not be forced into every week')
  assert.deepEqual(recentDates, ['2026-08-05'], 'recent purchase should only keep the guardrail date')
})

test('visit opportunities keep codes exact, preserve nulls, avoid same-day duplicates, and allow multi-date cadence', () => {
  const opportunities = buildVisitOpportunities({
    clients: [
      {
        client_id: '1',
        client_code: '00152',
        nom: 'Client Exact',
        latitude: 36.8,
        longitude: 10.1,
        potentiel: 80
      },
      {
        client_id: '2',
        client_code: '152',
        nom: 'Client Sans Zero',
        latitude: 36.81,
        longitude: 10.11,
        potentiel: null
      },
      {
        client_id: '3',
        client_code: '00003',
        nom: 'Client Fallback',
        latitude: null,
        longitude: null
      }
    ],
    cadenceProfiles: [
      {
        client_id: '1',
        client_code: '00152',
        recommended_visit_interval_days: 3,
        usual_purchase_weekdays: [2, 4],
        next_purchase_date_estimate: '2026-08-05',
        next_purchase_window_start: '2026-08-04',
        next_purchase_window_end: '2026-08-06',
        cadence_confidence: 0.82,
        inactivity_risk: 'medium',
        days_since_last_purchase: 6
      },
      {
        client_id: '2',
        client_code: '152',
        recommended_visit_interval_days: 25,
        usual_purchase_weekdays: [],
        next_purchase_date_estimate: null,
        next_purchase_window_start: null,
        next_purchase_window_end: null,
        cadence_confidence: 0.24,
        inactivity_risk: 'unknown',
        days_since_last_purchase: null
      },
      {
        client_id: '3',
        client_code: '00003',
        recommended_visit_interval_days: 21,
        usual_purchase_weekdays: [],
        next_purchase_date_estimate: null,
        next_purchase_window_start: null,
        next_purchase_window_end: null,
        cadence_confidence: 0.18,
        inactivity_risk: 'medium',
        last_contact_date: null,
        days_since_last_purchase: null
      }
    ],
    predictionsByClientDate: new Map([
      ['1::2026-08-05', {
        purchase_prediction_known: true,
        purchase_prediction_score: 86,
        purchase_probability: 82,
        expected_order_value: 340,
        recommended_quantity: 4,
        predicted_products: [{ name: 'Chips', quantity: 4 }],
        predicted_purchase_date: '2026-08-05',
        confidence: 0.9
      }],
      ['1::2026-08-08', {
        purchase_prediction_known: true,
        purchase_prediction_score: 74,
        purchase_probability: 61,
        expected_order_value: 180,
        recommended_quantity: 2,
        predicted_products: [],
        predicted_purchase_date: '2026-08-08',
        confidence: 0.74
      }],
      ['2::2026-08-03', {
        purchase_prediction_known: true,
        purchase_prediction_score: null,
        purchase_probability: 19,
        expected_order_value: null,
        recommended_quantity: null,
        predicted_products: [],
        predicted_purchase_date: '2026-08-03',
        confidence: null
      }]
    ]),
    compatibleCommercialCodesByClientId: new Map([
      ['1', ['C01']],
      ['2', ['C01']],
      ['3', ['C01']]
    ]),
    depotByCommercialDate: new Map([
      ['C01::2026-08-05', { latitude: 36.85, longitude: 10.15 }],
      ['C01::2026-08-08', { latitude: 36.85, longitude: 10.15 }]
    ]),
    options: {
      startDate: '2026-08-03',
      planningHorizonDays: 14,
      maxCandidateDatesPerClient: 4,
      maxDaysWithoutContact: 14
    }
  })

  const byClient = opportunities.reduce((accumulator, opportunity) => {
    const list = accumulator.get(opportunity.client_id) || []
    list.push(opportunity)
    accumulator.set(opportunity.client_id, list)
    return accumulator
  }, new Map())

  assert.ok((byClient.get('1') || []).length >= 2, 'same client should be allowed on different dates')
  assert.equal(
    new Set((byClient.get('1') || []).map(item => item.candidate_date)).size,
    (byClient.get('1') || []).length,
    'same client must not appear twice on the same day'
  )
  assert.equal((byClient.get('1') || [])[0].client_code, '00152')
  assert.equal((byClient.get('2') || [])[0].client_code, '152')
  assert.equal((byClient.get('2') || [])[0].availability_status, 'unknown')
  assert.equal((byClient.get('2') || [])[0].predicted_ca, null)
  assert.equal((byClient.get('2') || [])[0].recommended_quantity, null)
  assert.ok((byClient.get('3') || []).length > 0, 'fallback client should still receive explicit low-confidence opportunities')
})

test('scoring and assignment favor strong opportunities, respect strict availability, and defer weaker ones', () => {
  const opportunities = [
    {
      visit_opportunity_id: 'opp-1',
      client_id: '1',
      client_code: '00152',
      client_name: 'Fort',
      candidate_date: '2026-08-05',
      possible_commercial_codes: ['C01'],
      purchase_probability: 88,
      predicted_ca: 420,
      expected_order_value: 420,
      recommended_quantity: 5,
      cadence_due_score: 78,
      availability_status: 'unknown',
      inactivity_risk: 'medium',
      strategic_client_score: 70,
      geographic_synergy_score: 60,
      incremental_distance_estimate: 3,
      confidence: 84,
      recommended_visit_interval_days: 4,
      purchase_prediction_known: true,
      predicted_products: []
    },
    {
      visit_opportunity_id: 'opp-2',
      client_id: '2',
      client_code: '00044',
      client_name: 'Faible',
      candidate_date: '2026-08-05',
      possible_commercial_codes: ['C01'],
      purchase_probability: 12,
      predicted_ca: 20,
      expected_order_value: 20,
      recommended_quantity: 1,
      cadence_due_score: 15,
      availability_status: 'unknown',
      inactivity_risk: 'low',
      strategic_client_score: 10,
      geographic_synergy_score: 5,
      incremental_distance_estimate: 28,
      confidence: 50,
      recommended_visit_interval_days: 15,
      purchase_prediction_known: true,
      predicted_products: []
    },
    {
      visit_opportunity_id: 'opp-3',
      client_id: '3',
      client_code: '00077',
      client_name: 'Indispo',
      candidate_date: '2026-08-06',
      possible_commercial_codes: ['C01'],
      purchase_probability: 91,
      predicted_ca: 350,
      expected_order_value: 350,
      recommended_quantity: 4,
      cadence_due_score: 80,
      availability_status: 'explicit_unavailable',
      inactivity_risk: 'high',
      strategic_client_score: 55,
      geographic_synergy_score: 50,
      incremental_distance_estimate: 4,
      confidence: 88,
      recommended_visit_interval_days: 5,
      purchase_prediction_known: true,
      predicted_products: []
    }
  ].map(opportunity => ({
    ...opportunity,
    ...computeOpportunityScore(opportunity, {
      objectiveMode: 'balanced',
      maxPredictedCa: 420,
      maxRecommendedQuantity: 5,
      maxDetourKm: 30,
      maxVisitMinutes: 90
    })
  }))

  assert.ok(opportunities[0].visit_opportunity_score > opportunities[1].visit_opportunity_score)

  const slots = buildCommercialSlots({
    planningDates: ['2026-08-05', '2026-08-06'],
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    commercialConstraintsByCode: new Map([
      ['C01', {
        available_dates: ['2026-08-05', '2026-08-06'],
        unavailable_dates: [],
        hard_max_visits_by_date: {
          '2026-08-05': 1,
          '2026-08-06': 1
        }
      }]
    ]),
    requestMaxVisits: 1,
    minDailyCaPerCommercial: null
  })

  const assignment = assignVisitOpportunities({
    opportunities,
    slots,
    options: {
      respectAvailability: 'strict',
      minimumConfidence: 0,
      minimumVisitsPreference: 0
    }
  })

  assert.equal(assignment.blocks.length, 1)
  assert.equal(assignment.blocks[0].clients[0].client_code, '00152')
  assert.equal(assignment.blocks[0].clients[0].availability_status, 'unknown')
  assert.ok(assignment.deferred_clients.some(client => client.client_code === '00044'))
  assert.ok(assignment.deferred_clients.some(client => client.client_code === '00077'))
})

test('service is deterministic, caches plans, and fetches each sparse prediction date only once', async () => {
  const predictionCalls = []
  const salesRows = [
    { historical_client_code: '00152', purchase_date: '2026-07-22', order_value: 120, order_quantity: 2, commercial_code: 'C01' },
    { historical_client_code: '00152', purchase_date: '2026-07-25', order_value: 150, order_quantity: 3, commercial_code: 'C01' },
    { historical_client_code: '00152', purchase_date: '2026-07-29', order_value: 160, order_quantity: 3, commercial_code: 'C01' },
    { historical_client_code: '152', purchase_date: '2026-06-04', order_value: 80, order_quantity: 1, commercial_code: 'C01' },
    { historical_client_code: '152', purchase_date: '2026-07-04', order_value: 95, order_quantity: 1, commercial_code: 'C01' }
  ]
  const visitRows = [
    { historical_client_code: '00152', visit_date: '2026-07-30', commercial_code: 'C01', visit_result: 'sale' }
  ]

  const dependencies = {
    allowInlineProfileBuild: true,
    fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial C01' }],
    fetchCoverageActiveClients: async () => ({
      clients: [
        {
          client_id: '1',
          client_code: '00152',
          nom: 'Frequent',
          user_code: 'C01',
          resolved_commercial_code: 'C01',
          latitude: 36.8,
          longitude: 10.1,
          potentiel: 90
        },
        {
          client_id: '2',
          client_code: '152',
          nom: 'Monthly',
          user_code: 'C01',
          resolved_commercial_code: 'C01',
          latitude: 36.85,
          longitude: 10.12,
          potentiel: 40
        }
      ]
    }),
    loadCoverageConstraints: async () => ({
      commercials: {
        C01: {
          available_dates: ['2026-08-03', '2026-08-05', '2026-08-08'],
          unavailable_dates: [],
          hard_max_visits_by_date: {
            '2026-08-03': 2,
            '2026-08-05': 2,
            '2026-08-08': 2
          }
        }
      },
      client_restrictions: {}
    }),
    fetchAiPredictionsForClientBatch: async ({ targetDate, clientCodes }) => {
      predictionCalls.push(targetDate)
      return {
        status: 'success',
        predictions: clientCodes.map(clientCode => {
          if (clientCode === '00152') {
            return {
              client_id: '1',
              client_code: clientCode,
              purchase_probability: targetDate === '2026-08-05' ? 81 : 54,
              predicted_ca: targetDate === '2026-08-05' ? 340 : 180,
              predicted_ca_if_buy: targetDate === '2026-08-05' ? 510 : 260,
              recommended_quantity: targetDate === '2026-08-05' ? 4 : 2,
              predicted_quantity_if_buy: targetDate === '2026-08-05' ? 7 : 3,
              model_confidence: 82,
              score: targetDate === '2026-08-05' ? 86 : 62,
              vip: targetDate === '2026-08-05' ? 88 : 63,
              probability_model_only: targetDate === '2026-08-05' ? 80 : 53,
              habit_score: 70,
              recency_score: 68,
              prediction_source: 'test_batch'
            }
          }
          return {
            client_id: '2',
            client_code: clientCode,
            purchase_probability: 15,
            predicted_ca: 40,
            predicted_ca_if_buy: null,
            recommended_quantity: 1,
            predicted_quantity_if_buy: null,
            model_confidence: 30,
            score: 18,
            vip: 20,
            probability_model_only: 14,
            habit_score: 12,
            recency_score: 10,
            prediction_source: 'test_batch'
          }
        }),
        meta: {
          prediction_requested_clients_count: clientCodes.length,
          prediction_returned_clients_count: clientCodes.length,
          prediction_known_count: clientCodes.length,
          prediction_null_count: 0,
          top_k_truncation_detected: false
        }
      }
    },
    queryAsync: async (sql) => {
      if (sql.includes('FROM entetecommercials')) return salesRows
      if (sql.includes('FROM client_visits')) return visitRows
      return []
    },
    sharedDepotOrigin: {
      latitude: 36.81,
      longitude: 10.18,
      nom: 'Depot principal'
    }
  }

  const request = {
    start_date: '2026-08-03',
    historical_cutoff_date: '2026-08-02',
    planning_horizon_days: 10,
    commercial_codes: ['C01'],
    objective_mode: 'balanced',
    max_clients: 2,
    max_candidate_dates_per_client: 4
  }

  const firstPayload = await generateNextBestVisitPlan(request, dependencies)
  const firstCallCount = predictionCalls.length
  const secondPayload = await generateNextBestVisitPlan(request, dependencies)

  assert.equal(firstPayload.status, 'success')
  assert.ok(firstPayload.summary.recommended_visits_count >= 1)
  assert.ok(firstPayload.diagnostics.sparse_opportunity_count < (2 * 10 * 1))
  assert.ok(firstPayload.diagnostics.cartesian_candidate_count_avoided > 0)
  const firstClient = firstPayload.blocks.flatMap(block => block.clients).find(client => client.client_code === '00152')
  const secondClient = firstPayload.blocks.flatMap(block => block.clients).find(client => client.client_code === '152')
  assert.equal(firstClient.predicted_ca_if_buy, 510)
  assert.equal(firstClient.predicted_quantity_if_buy, 7)
  assert.equal(secondClient.predicted_ca_if_buy, null)
  assert.equal(secondClient.predicted_quantity_if_buy, null)
  assert.equal(secondPayload.summary.cache_status, 'plan_hit')
  assert.equal(predictionCalls.length, firstCallCount, 'cached plan should avoid duplicate prediction requests')
  assert.equal(new Set(predictionCalls).size, predictionCalls.length, 'each sparse date should be fetched once')
  assert.deepEqual(
    firstPayload.blocks.map(block => ({
      slot_id: block.slot_id,
      client_codes: block.clients.map(client => client.client_code)
    })),
    secondPayload.blocks.map(block => ({
      slot_id: block.slot_id,
      client_codes: block.clients.map(client => client.client_code)
    }))
  )
})

test('selected commercials recompute slot capacity and exact string codes are preserved', () => {
  const oneCommercialSlots = buildCommercialSlots({
    planningDates: ['2026-08-03', '2026-08-04'],
    selectedCommercials: [{ value: '0001', label: 'Commercial 0001' }],
    commercialConstraintsByCode: new Map([
      ['0001', {
        available_dates: ['2026-08-03', '2026-08-04'],
        unavailable_dates: [],
        hard_max_visits_by_date: {
          '2026-08-03': 2,
          '2026-08-04': 2
        }
      }]
    ]),
    requestMaxVisits: 2,
    minDailyCaPerCommercial: null
  })

  const multiCommercialSlots = buildCommercialSlots({
    planningDates: ['2026-08-03', '2026-08-04'],
    selectedCommercials: [
      { value: '0001', label: 'Commercial 0001' },
      { value: 'VL1900', label: 'Commercial VL1900' }
    ],
    commercialConstraintsByCode: new Map([
      ['0001', {
        available_dates: ['2026-08-03', '2026-08-04'],
        unavailable_dates: [],
        hard_max_visits_by_date: {
          '2026-08-03': 2,
          '2026-08-04': 2
        }
      }],
      ['VL1900', {
        available_dates: ['2026-08-03', '2026-08-04'],
        unavailable_dates: [],
        hard_max_visits_by_date: {
          '2026-08-03': 2,
          '2026-08-04': 2
        }
      }]
    ]),
    requestMaxVisits: 2,
    minDailyCaPerCommercial: null
  })

  assert.equal(oneCommercialSlots.length, 2)
  assert.equal(multiCommercialSlots.length, 4)
  assert.deepEqual(
    multiCommercialSlots.map(slot => slot.commercial_code),
    ['0001', '0001', 'VL1900', 'VL1900']
  )
  assert.equal(
    oneCommercialSlots.reduce((sum, slot) => sum + Number(slot.max_visits || 0), 0),
    4
  )
  assert.equal(
    multiCommercialSlots.reduce((sum, slot) => sum + Number(slot.max_visits || 0), 0),
    8
  )
})

test('assignment never places a client on an unselected commercial', () => {
  const opportunities = [
    {
      visit_opportunity_id: 'opp-selected',
      client_id: '1',
      client_code: '00152',
      client_name: 'Compatible',
      candidate_date: '2026-08-03',
      possible_commercial_codes: ['VL1900'],
      purchase_probability: 88,
      predicted_ca: 420,
      expected_order_value: 420,
      recommended_quantity: 5,
      cadence_due_score: 78,
      availability_status: 'unknown',
      inactivity_risk: 'medium',
      strategic_client_score: 70,
      geographic_synergy_score: 60,
      incremental_distance_estimate: 3,
      confidence: 84,
      recommended_visit_interval_days: 4,
      purchase_prediction_known: true,
      predicted_products: [],
      visit_opportunity_score: 99
    },
    {
      visit_opportunity_id: 'opp-unselected',
      client_id: '2',
      client_code: '00077',
      client_name: 'Forbidden',
      candidate_date: '2026-08-03',
      possible_commercial_codes: ['UNSELECTED'],
      purchase_probability: 95,
      predicted_ca: 500,
      expected_order_value: 500,
      recommended_quantity: 6,
      cadence_due_score: 80,
      availability_status: 'unknown',
      inactivity_risk: 'high',
      strategic_client_score: 75,
      geographic_synergy_score: 65,
      incremental_distance_estimate: 2,
      confidence: 90,
      recommended_visit_interval_days: 4,
      purchase_prediction_known: true,
      predicted_products: [],
      visit_opportunity_score: 120
    }
  ]

  const slots = buildCommercialSlots({
    planningDates: ['2026-08-03'],
    selectedCommercials: [{ value: 'VL1900', label: 'Commercial VL1900' }],
    commercialConstraintsByCode: new Map([
      ['VL1900', {
        available_dates: ['2026-08-03'],
        unavailable_dates: [],
        hard_max_visits_by_date: {
          '2026-08-03': 2
        }
      }]
    ]),
    requestMaxVisits: 2,
    minDailyCaPerCommercial: null
  })

  const assignment = assignVisitOpportunities({
    opportunities,
    slots,
    options: {
      respectAvailability: 'strict',
      minimumConfidence: 0,
      minimumVisitsPreference: 0
    }
  })

  assert.deepEqual(
    assignment.blocks.flatMap(block => block.clients.map(client => client.client_code)),
    ['00152']
  )
  assert.ok(assignment.deferred_clients.some(client => client.client_code === '00077'))
  assert.ok(
    assignment.blocks.every(block => String(block.commercial_code).trim() === 'VL1900')
  )
})

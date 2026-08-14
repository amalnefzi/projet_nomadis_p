const { after, test } = require('node:test')
const assert = require('node:assert/strict')

const {
  generateNextBestVisitPlan,
  __testables: nextBestVisitTestables
} = require('../next_best_visit_service')
const {
  buildCadenceBucket,
  computeWindowMetrics,
  matchVisitsToPurchases,
  summarizeV2ServiceValidation,
  summarizeCadenceProfiles
} = require('../next_best_visit_backtest')
const {
  __testables: serverTestables
} = require('../server')

after(async () => {
  await serverTestables.closeOpenHandles()
})

test('historical cutoff is used for history queries and does not leak the planning window', async () => {
  const referenceDates = []
  const dependencies = {
    allowInlineProfileBuild: true,
    fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial C01' }],
    fetchCoverageActiveClients: async () => ({
      clients: [{
        client_id: '1',
        client_code: '00152',
        nom: 'Client test',
        user_code: 'C01',
        resolved_commercial_code: 'C01',
        latitude: 36.8,
        longitude: 10.1,
        potentiel: 50
      }]
    }),
    loadCoverageConstraints: async () => ({
      commercials: {
        C01: {
          available_dates: ['2026-08-03', '2026-08-04'],
          unavailable_dates: [],
          hard_max_visits_by_date: {
            '2026-08-03': 2,
            '2026-08-04': 2
          }
        }
      },
      client_restrictions: {}
    }),
    fetchAiPredictionsForClientBatch: async ({ clientCodes }) => ({
      status: 'success',
      predictions: clientCodes.map(clientCode => ({
        client_id: '1',
        client_code: clientCode,
        purchase_probability: 72,
        predicted_ca: 210,
        recommended_quantity: 3,
        model_confidence: 80,
        score: 75,
        vip: 77,
        prediction_source: 'test_batch'
      })),
      meta: {
        prediction_requested_clients_count: clientCodes.length,
        prediction_returned_clients_count: clientCodes.length,
        prediction_known_count: clientCodes.length,
        prediction_null_count: 0,
        top_k_truncation_detected: false
      }
    }),
    queryAsync: async (sql, params = []) => {
      if (sql.includes('FROM entetecommercials') || sql.includes('FROM client_visits')) {
        referenceDates.push(params[0])
      }
      return []
    },
    sharedDepotOrigin: {
      latitude: 36.81,
      longitude: 10.18,
      nom: 'Depot principal'
    }
  }

  const payload = await generateNextBestVisitPlan({
    start_date: '2026-08-03',
    historical_cutoff_date: '2026-07-31',
    planning_horizon_days: 2,
    commercial_codes: ['C01'],
    max_clients: 2
  }, dependencies)

  assert.equal(payload.status, 'success')
  assert.ok(referenceDates.length >= 2)
  assert.ok(referenceDates.every(value => value === '2026-07-31'))
})

test('date specific batch prediction fetch preserves nulls and exact client codes without silent truncation', async () => {
  const result = await nextBestVisitTestables.fetchDateSpecificPredictions({
    clients: [
      { client_id: '1', client_code: '00152' },
      { client_id: '2', client_code: '152' }
    ],
    candidateDatesByClientId: new Map([
      ['1', ['2026-08-06']],
      ['2', ['2026-08-06']]
    ]),
    fetchAiPredictionsForClientBatch: async ({ targetDate, clientCodes }) => ({
      status: 'success',
      predictions: clientCodes.map(clientCode => (
        clientCode === '00152'
          ? {
              client_id: '1',
              client_code: clientCode,
              purchase_probability: 82,
              predicted_ca: 340,
              recommended_quantity: 4,
              model_confidence: 84,
              score: 86,
              vip: 88,
              prediction_source: `batch_${targetDate}`
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
              prediction_source: `batch_${targetDate}`
            }
      )),
      meta: {
        prediction_requested_clients_count: clientCodes.length,
        prediction_returned_clients_count: clientCodes.length,
        prediction_known_count: 1,
        prediction_null_count: 1,
        top_k_truncation_detected: false
      }
    })
  })

  assert.equal(result.coverageByDate.length, 1)
  assert.equal(result.coverageByDate[0].requested_count, 2)
  assert.equal(result.coverageByDate[0].returned_count, 2)
  assert.equal(result.coverageByDate[0].known_count, 1)
  assert.equal(result.coverageByDate[0].null_count, 1)
  assert.equal(result.coverageByDate[0].top_k_truncation_detected, false)
  assert.equal(result.predictionsByClientDate.get('00152::2026-08-06').purchase_probability, 82)
  assert.equal(result.predictionsByClientDate.get('00152::2026-08-06').prediction_vip, 88)
  assert.equal(result.predictionsByClientDate.get('152::2026-08-06').purchase_probability, null)
  assert.equal(result.predictionsByClientDate.get('152::2026-08-06').expected_order_value, null)
})

test('historical matching metrics use date tolerance correctly', () => {
  const assignment = {
    blocks: [{
      date: '2026-08-05',
      commercial_code: 'C01',
      slot_id: '2026-08-05::C01',
      clients: [
        {
          visit_opportunity_id: 'opp-1',
          client_id: '1',
          client_code: '00152',
          candidate_date: '2026-08-05',
          predicted_ca: 100,
          recommended_quantity: 2,
          cadence_due_score: 70,
          recommended_visit_interval_days: 5
        },
        {
          visit_opportunity_id: 'opp-2',
          client_id: '2',
          client_code: '00044',
          candidate_date: '2026-08-06',
          predicted_ca: 50,
          recommended_quantity: 1,
          cadence_due_score: 20,
          recommended_visit_interval_days: 30
        }
      ]
    }]
  }
  const actualSalesByClientId = new Map([
    ['1', [{ purchase_date: '2026-08-05', order_value: 120, order_quantity: 3 }]],
    ['2', [{ purchase_date: '2026-08-09', order_value: 60, order_quantity: 1 }]]
  ])

  const matchResult = matchVisitsToPurchases(
    assignment.blocks[0].clients.filter(client => client.client_id === '1'),
    actualSalesByClientId.get('1'),
    1
  )
  const metrics = computeWindowMetrics({
    assignment,
    actualSalesByClientId,
    toleranceDays: 1
  })

  assert.equal(matchResult.matches.length, 1)
  assert.equal(matchResult.matches[0].date_error_days, 0)
  assert.equal(metrics.recommended_visits_count, 2)
  assert.equal(metrics.recommended_clients_who_bought, 1)
  assert.equal(metrics.purchase_hit_rate, 50)
  assert.equal(metrics.visits_without_purchase, 1)
  assert.equal(metrics.predicted_ca_mae, 20)
  assert.equal(metrics.quantity_mae, 1)
  assert.equal(metrics.date_error_days, 0)
})

test('cadence summaries keep low-history confidence low and classify cadence buckets honestly', () => {
  const summary = summarizeCadenceProfiles([
    {
      purchase_count: 1,
      history_depth: 1,
      cadence_confidence: 0.18,
      fallback_strategy: 'light_history_low_confidence',
      recommended_visit_interval_days: 21,
      purchase_interval_variability: null,
      days_since_last_purchase: 5
    },
    {
      purchase_count: 10,
      history_depth: 10,
      cadence_confidence: 0.9,
      fallback_strategy: null,
      recommended_visit_interval_days: 7,
      purchase_interval_variability: 0.2,
      days_since_last_purchase: 4
    },
    {
      purchase_count: 5,
      history_depth: 5,
      cadence_confidence: 0.62,
      fallback_strategy: null,
      recommended_visit_interval_days: 16,
      purchase_interval_variability: 0.3,
      days_since_last_purchase: 12
    }
  ])

  assert.equal(buildCadenceBucket({
    purchase_count: 10,
    recommended_visit_interval_days: 7,
    purchase_interval_variability: 0.2,
    days_since_last_purchase: 4
  }), 'weekly')
  assert.equal(summary.clients_with_1_purchase, 1)
  assert.equal(summary.cadence_high_confidence_clients, 1)
  assert.equal(summary.cadence_low_confidence_clients, 1)
  assert.equal(summary.fallback_only_clients, 1)
  assert.equal(summary.cadence_bucket_counts.weekly, 1)
  assert.equal(summary.cadence_bucket_counts.biweekly, 1)
  assert.equal(summary.cadence_bucket_counts.monthly, 1)
})

test('backtest service validation reports stale snapshot payloads as not executed', () => {
  const result = summarizeV2ServiceValidation({
    status: 'stale',
    summary: {
      profile_snapshot_status: 'stale'
    }
  })

  assert.equal(result.v2_selected_visits_count, null)
  assert.equal(result.v2_service_validation_status, 'not_executed_snapshot_stale')
})

test('backtest service validation reports successful service payload visit counts', () => {
  const result = summarizeV2ServiceValidation({
    status: 'success',
    summary: {
      selected_visits_count: 12,
      recommended_visits_count: 15
    }
  })

  assert.equal(result.v2_selected_visits_count, 12)
  assert.equal(result.v2_service_validation_status, 'executed')
})

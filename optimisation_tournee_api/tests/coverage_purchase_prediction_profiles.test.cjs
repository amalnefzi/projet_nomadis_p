const test = require('node:test')
const assert = require('node:assert/strict')

const {
  loadCoveragePurchasePredictionProfiles
} = require('../coverage_purchase_prediction_profiles')

test('keeps 00152 and 152 distinct by client_id when loading dashboard predictions', async () => {
  const result = await loadCoveragePurchasePredictionProfiles({
    clientRows: [
      { client_id: '1', client_code: '00152', latitude: 36.8, longitude: 10.1 },
      { client_id: '2', client_code: '152', latitude: 36.81, longitude: 10.11 }
    ],
    planningDates: ['2026-08-03'],
    referenceDate: '2026-08-03',
    fetchPredictionsForDate: async () => ({
      status: 'success',
      predictions: {
        '00152': { chiffre: 300, qte: 8, prob_achat: 40, habit_score: 30, recency_score: 20, details: { Chips: 5 } },
        '152': { chiffre: 120, qte: 2, prob_achat: 20, habit_score: 10, recency_score: 5, details: { Bur: 2 } }
      }
    }),
    scorePredictionCandidate: ({ rawPrediction }) => rawPrediction.chiffre / 10
  })

  const byId = new Map(result.profiles.map(profile => [profile.client_id, profile]))
  assert.equal(byId.get('1').expected_order_value, 300)
  assert.equal(byId.get('2').expected_order_value, 120)
  assert.equal(byId.get('1').predicted_products[0].name, 'Chips')
  assert.equal(byId.get('2').predicted_products[0].name, 'Bur')
})

test('selects the best dashboard prediction candidate across planning dates', async () => {
  const result = await loadCoveragePurchasePredictionProfiles({
    clientRows: [
      { client_id: '10', client_code: '00010', latitude: 36.8, longitude: 10.1 }
    ],
    planningDates: ['2026-08-03', '2026-08-05'],
    referenceDate: '2026-08-03',
    fetchPredictionsForDate: async ({ date }) => ({
      status: 'success',
      predictions: {
        '00010': date === '2026-08-03'
          ? { chiffre: 200, qte: 3, prob_achat: 20, habit_score: 20, recency_score: 20 }
          : { chiffre: 180, qte: 2, prob_achat: 20, habit_score: 20, recency_score: 20 }
      }
    }),
    scorePredictionCandidate: ({ planningDate }) => planningDate === '2026-08-05' ? 85 : 20
  })

  assert.deepEqual(result.profiles[0], {
    client_id: '10',
    client_code: '00010',
    purchase_prediction_score: 85,
    predicted_purchase_date: '2026-08-05',
    purchase_days_until_prediction: 2,
    recommended_quantity: 2,
    expected_order_value: 180,
    predicted_products: [],
    purchase_prediction_known: true,
    purchase_prediction_source: 'dashboard_fetchLoggedAiPredictions'
  })
})

test('prediction loading concurrency never exceeds the configured limit and keeps dates aligned', async () => {
  let activeCalls = 0
  let maxActiveCalls = 0
  const completionOrder = []

  const result = await loadCoveragePurchasePredictionProfiles({
    clientRows: [
      { client_id: '10', client_code: '00010', latitude: 36.8, longitude: 10.1 }
    ],
    planningDates: ['2026-08-03', '2026-08-04', '2026-08-05'],
    referenceDate: '2026-08-03',
    concurrency: 2,
    fetchPredictionsForDate: async ({ date }) => {
      activeCalls += 1
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
      const delayMs = date === '2026-08-03' ? 30 : date === '2026-08-04' ? 10 : 20
      await new Promise(resolve => setTimeout(resolve, delayMs))
      completionOrder.push(date)
      activeCalls -= 1
      return {
        status: 'success',
        predictions: {
          '00010': {
            chiffre: date === '2026-08-05' ? 320 : date === '2026-08-04' ? 180 : 200,
            qte: date === '2026-08-05' ? 9 : 3,
            prob_achat: 30,
            habit_score: 20,
            recency_score: 15,
            details: { Chips: date === '2026-08-05' ? 9 : 3 }
          }
        }
      }
    },
    scorePredictionCandidate: ({ planningDate, predictionPayloadMeta, rawPrediction }) => {
      assert.ok(predictionPayloadMeta.maxPredictedValue >= Number(rawPrediction.chiffre))
      return planningDate === '2026-08-05' ? 90 : planningDate === '2026-08-04' ? 50 : 20
    }
  })

  assert.ok(maxActiveCalls <= 2)
  assert.deepEqual(completionOrder.sort(), ['2026-08-03', '2026-08-04', '2026-08-05'])
  assert.equal(result.profiles[0].predicted_purchase_date, '2026-08-05')
  assert.equal(result.profiles[0].expected_order_value, 320)
  assert.equal(result.profiles[0].recommended_quantity, 9)
  assert.deepEqual(result.profiles[0].predicted_products, [{ name: 'Chips', quantity: 9 }])
})

test('null purchase prediction values remain null and are never coerced', async () => {
  const result = await loadCoveragePurchasePredictionProfiles({
    clientRows: [
      { client_id: '10', client_code: '00010', latitude: 36.8, longitude: 10.1 }
    ],
    planningDates: ['2026-08-03'],
    referenceDate: '2026-08-03',
    fetchPredictionsForDate: async () => ({
      status: 'success',
      predictions: {
        '00010': { chiffre: null, qte: null, prob_achat: 30, habit_score: 20, recency_score: 15, details: null }
      }
    }),
    scorePredictionCandidate: () => null
  })

  assert.deepEqual(result.profiles[0], {
    client_id: '10',
    client_code: '00010',
    purchase_prediction_score: null,
    predicted_purchase_date: '2026-08-03',
    purchase_days_until_prediction: 0,
    recommended_quantity: null,
    expected_order_value: null,
    predicted_products: [],
    purchase_prediction_known: true,
    purchase_prediction_source: 'dashboard_fetchLoggedAiPredictions'
  })
})

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  __testables: serviceTestables
} = require('../next_best_visit_service')

test('model basket source is preserved when a real product-level prediction is available', async () => {
  const result = await serviceTestables.fetchDateSpecificPredictions({
    clients: [
      { client_id: '1', client_code: '00152' }
    ],
    candidateDatesByClientId: new Map([
      ['1', ['2026-08-11']]
    ]),
    fetchAiPredictionsForClientBatch: async () => ({
      predictions: [
        {
          client_code: '00152',
          purchase_probability: 72,
          predicted_products: [
            {
              product_code: '0007',
              product_label: 'Chips paprika',
              estimated_quantity: 3.4
            }
          ]
        }
      ],
      meta: {}
    })
  })

  const prediction = result.predictionsByClientDate.get('00152::2026-08-11')
  assert.equal(prediction.predicted_products[0].product_code, '0007')
  assert.equal(prediction.predicted_products[0].product_label, 'Chips paprika')
  assert.equal(prediction.predicted_products[0].estimated_quantity, 3.4)
  assert.equal(prediction.predicted_products[0].prediction_source, 'model')
})

test('historical fallback stays deterministic and only recommends repeated or recent client products', () => {
  const recommendedProducts = serviceTestables.buildHistoricalRecommendedProducts([
    {
      purchase_date: '2026-08-01',
      doc_code: 'A1',
      product_id: null,
      product_code: '0007',
      product_label: 'Chips paprika',
      quantity: 4
    },
    {
      purchase_date: '2026-07-20',
      doc_code: 'A2',
      product_id: null,
      product_code: '0007',
      product_label: 'Chips paprika',
      quantity: 2
    },
    {
      purchase_date: '2026-08-05',
      doc_code: 'B1',
      product_id: null,
      product_code: '0009',
      product_label: null,
      quantity: 1
    },
    {
      purchase_date: '2026-05-01',
      doc_code: 'C1',
      product_id: null,
      product_code: '0015',
      product_label: 'Produit stale',
      quantity: 10
    }
  ], {
    referenceDate: '2026-08-10'
  })

  assert.deepEqual(recommendedProducts, [
    {
      product_id: null,
      product_code: '0007',
      product_label: 'Chips paprika',
      estimated_quantity: 3,
      prediction_source: 'historical_pattern',
      confidence_or_support: 2
    },
    {
      product_id: null,
      product_code: '0009',
      product_label: null,
      estimated_quantity: 1,
      prediction_source: 'historical_pattern',
      confidence_or_support: 1
    }
  ])
})

test('insufficient history keeps basket prediction unavailable and invents no products', () => {
  const enriched = serviceTestables.enrichPayloadWithBasketRecommendations({
    blocks: [
      {
        commercial_code: 'C01',
        date: '2026-08-11',
        clients: [
          {
            client_id: '1',
            client_code: '00152',
            predicted_products: []
          }
        ]
      }
    ]
  }, {
    referenceDate: '2026-08-10',
    productHistoryByClientId: new Map([
      ['1', [
        {
          purchase_date: '2026-04-01',
          doc_code: 'OLD-1',
          product_id: null,
          product_code: '0099',
          product_label: 'Ancien produit',
          quantity: 5
        }
      ]]
    ])
  })

  const [client] = enriched.blocks[0].clients
  assert.equal(client.basket_prediction_source, 'unavailable')
  assert.deepEqual(client.recommended_products, [])
  assert.deepEqual(enriched.blocks[0].loading_prediction.products, [])
})

test('loading aggregation sums identical products without arbitrary safety margin and keeps blocks separated', () => {
  const enriched = serviceTestables.enrichPayloadWithBasketRecommendations({
    blocks: [
      {
        commercial_code: 'C01',
        date: '2026-08-11',
        clients: [
          {
            client_id: '1',
            client_code: '00152',
            predicted_products: [
              {
                product_code: '0007',
                product_label: 'Chips paprika',
                estimated_quantity: 3,
                prediction_source: 'model'
              }
            ]
          },
          {
            client_id: '2',
            client_code: '00153',
            predicted_products: [
              {
                product_code: '0007',
                product_label: 'Chips paprika',
                estimated_quantity: 2,
                prediction_source: 'model'
              }
            ]
          }
        ]
      },
      {
        commercial_code: 'C02',
        date: '2026-08-12',
        clients: [
          {
            client_id: '3',
            client_code: '00154',
            predicted_products: [
              {
                product_code: '0007',
                product_label: 'Chips paprika',
                estimated_quantity: 1,
                prediction_source: 'model'
              }
            ]
          }
        ]
      }
    ]
  }, {
    referenceDate: '2026-08-10',
    productHistoryByClientId: new Map()
  })

  assert.deepEqual(enriched.blocks[0].loading_prediction, {
    commercial_code: 'C01',
    planning_date: '2026-08-11',
    products: [
      {
        product_id: null,
        product_code: '0007',
        product_label: 'Chips paprika',
        estimated_need: 5,
        recommended_load_quantity: 5,
        prediction_source: 'model',
        confidence_or_support: null
      }
    ],
    coverage: {
      planned_visits: 2,
      visits_with_basket_prediction: 2,
      basket_prediction_coverage_pct: 100
    }
  })
  assert.equal(enriched.blocks[1].loading_prediction.commercial_code, 'C02')
  assert.equal(enriched.blocks[1].loading_prediction.planning_date, '2026-08-12')
  assert.equal(enriched.blocks[1].loading_prediction.products[0].recommended_load_quantity, 1)
})


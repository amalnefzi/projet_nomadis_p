import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCoverageClientRows,
  buildCoverageDetailHeaderModel,
  buildCoverageSidebarCardModel,
  resolveSelectedCoverageBlock,
  translatePriorityReasons
} from '../coveragePlannerDetails.js'

test('selection changes the resolved coverage detail block', () => {
  const blocks = [
    { slot_id: 'slot-a', date: '2026-08-03' },
    { slot_id: 'slot-b', date: '2026-08-04' }
  ]

  assert.equal(resolveSelectedCoverageBlock(blocks, 'slot-a').date, '2026-08-03')
  assert.equal(resolveSelectedCoverageBlock(blocks, 'slot-b').date, '2026-08-04')
})

test('null values stay unavailable and partial collection is labeled as partial', () => {
  const summary = buildCoverageSidebarCardModel({
    date: '2026-08-03',
    commercial_label: 'Comm 1',
    clients_count: 25,
    expected_collection_total: null,
    predicted_order_value_total: null,
    recovery_data_known_count: 9,
    purchase_prediction_known_count: 11,
    recovery_completeness: false,
    purchase_prediction_completeness: false
  })

  assert.equal(summary.collectionLabel, 'Collecte connue : Non disponible')
  assert.equal(summary.predictedOrderLabel, 'Chiffre predit non disponible')
  assert.match(summary.completenessLabel, /Donnees partielles/)
  assert.match(summary.completenessLabel, /Rec\. 9\/25/)
})

test('priority reasons are translated to short labels', () => {
  assert.deepEqual(
    translatePriorityReasons([
      'credit_overdue',
      'high_purchase_prediction',
      'purchase_prediction_unavailable'
    ]),
    [
      'Credit echu',
      "Forte opportunite d'achat",
      'Prediction indisponible'
    ]
  )
})

test('clients without GPS stay in the list and 00152 / 152 remain distinct by client_id', () => {
  const rows = buildCoverageClientRows({
    clients: [
      {
        client_id: '1',
        client_code: '00152',
        client_name: 'Client 00152',
        latitude: null,
        longitude: null,
        priority_reasons: ['recovery_data_unavailable']
      },
      {
        client_id: '2',
        client_code: '152',
        client_name: 'Client 152',
        latitude: 36.8,
        longitude: 10.1,
        priority_reasons: ['high_expected_order_value']
      }
    ]
  })

  assert.equal(rows.length, 2)
  assert.equal(rows[0].clientId, '1')
  assert.equal(rows[1].clientId, '2')
  assert.equal(rows[0].clientCode, '00152')
  assert.equal(rows[1].clientCode, '152')
  assert.equal(rows[0].gpsAvailable, false)
  assert.equal(rows[1].gpsAvailable, true)
})

test('detail header exposes GPS counts and keeps unknown values unavailable', () => {
  const header = buildCoverageDetailHeaderModel({
    clients_count: 2,
    expected_collection_total: null,
    overdue_balance_total: 120,
    predicted_order_value_total: 300,
    recommended_quantity_total: null,
    clients: [
      { latitude: 36.8, longitude: 10.1 },
      { latitude: null, longitude: null }
    ],
    time: {
      service_minutes_known_count: 0,
      service_minutes_total: null
    },
    estimated_duration_minutes: null
  }, {
    summary: null
  })

  assert.equal(header.expectedCollectionLabel, 'Non disponible')
  assert.equal(header.overdueBalanceLabel.includes('TND'), true)
  assert.equal(header.gpsStats.total, 2)
  assert.equal(header.gpsStats.mapped, 1)
  assert.equal(header.gpsStats.unavailable, 1)
})

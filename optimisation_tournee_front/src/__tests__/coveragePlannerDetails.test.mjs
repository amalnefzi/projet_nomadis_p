import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCoverageFeasibilityMetrics,
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
    recovery_data_known_count: 9,
    recovery_completeness: false
  })

  assert.equal(summary.collectionLabel, 'Collecte connue : Non disponible')
  assert.match(summary.completenessLabel, /Donnees recouvrement partielles/)
  assert.match(summary.completenessLabel, /9\/25/)
})

test('priority reasons keep recovery reasons and hide purchase signals', () => {
  assert.deepEqual(
    translatePriorityReasons([
      'credit_overdue',
      'high_purchase_prediction',
      'purchase_prediction_unavailable'
    ]),
    [
      'Credit echu'
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

test('feasibility metrics keep legacy planner keys mapped for recovery analysis rendering', () => {
  const metrics = buildCoverageFeasibilityMetrics({
    analysis: {
      clients_to_cover: 12,
      capacity_total: 9,
      required_average_per_slot: 1.5,
      user_max_capacity: 4,
      adjusted_target_max_capacity: 3,
      recommended_max_capacity: 5,
      unavailable_slots_removed: 2,
      total_required_clients: 12
    },
    diagnostics: {
      recovery_eligibility: {
        eligible_count: 12
      }
    },
    capacity_precheck: {
      active_clients_count: 18,
      available_slots_count: 8,
      available_slots_after_constraints_count: 6,
      strict_capacity: 9,
      required_visits_count: 12,
      minimum_required_average: 1.5,
      visits_non_planned_count: 3
    },
    operational: {
      total_required_clients: 12
    }
  })

  assert.equal(metrics.activeClientsCount, 18)
  assert.equal(metrics.recoverableClientsCount, 12)
  assert.equal(metrics.clientsToCover, 12)
  assert.equal(metrics.capacityTotal, 9)
  assert.equal(metrics.requiredAveragePerSlot, 1.5)
  assert.equal(metrics.userMaxCapacity, 4)
  assert.equal(metrics.adjustedTargetMaxCapacity, 3)
  assert.equal(metrics.recommendedMaxCapacity, 5)
  assert.equal(metrics.totalRequiredClients, 12)
  assert.equal(metrics.unavailableSlotsRemoved, 2)
})

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildValidatedToursSearchParams,
  buildValidatedTourHeaderModel,
  buildValidatedTourRouteStops,
  buildValidatedTourRows,
  formatValidatedTourStatus,
  normalizeValidatedTourSummaries,
  resolveCommercialLabel
} from '../salesValidatedTours.js'

const COMMERCIAUX = [
  { value: 'C01', label: 'Commercial Nord (C01)' },
  { value: 'C02', label: 'Commercial Sud (C02)' }
]

test('buildValidatedToursSearchParams keeps only non-empty filters', () => {
  assert.deepEqual(
    buildValidatedToursSearchParams({ date: '2026-08-25', commercialCode: '', tourneeCode: '  ' }),
    { date: '2026-08-25' }
  )
  assert.deepEqual(
    buildValidatedToursSearchParams({ date: '', commercialCode: 'C01', tourneeCode: 'sales-v2' }),
    { commercial_code: 'C01', tournee_code: 'sales-v2' }
  )
  assert.deepEqual(buildValidatedToursSearchParams({}), {})
})

test('resolveCommercialLabel falls back to the raw code when the commercial is unknown', () => {
  assert.equal(resolveCommercialLabel('C01', COMMERCIAUX), 'Commercial Nord (C01)')
  assert.equal(resolveCommercialLabel('C99', COMMERCIAUX), 'Commercial C99')
  assert.equal(resolveCommercialLabel('', COMMERCIAUX), 'Commercial non renseigne')
})

test('normalizeValidatedTourSummaries resolves commercial labels and status labels for the search results list', () => {
  const summaries = normalizeValidatedTourSummaries([
    { tournee_code: 'sales-v2-20260825-C01', date: '2026-08-25', commercial_code: 'C01', route_code: 'C01', depot_code: 'DEP1', clients_count: 3, status: 'in_progress' }
  ], COMMERCIAUX)

  assert.deepEqual(summaries, [{
    tourneeCode: 'sales-v2-20260825-C01',
    date: '2026-08-25',
    commercialCode: 'C01',
    commercialLabel: 'Commercial Nord (C01)',
    routeCode: 'C01',
    depotCode: 'DEP1',
    clientsCount: 3,
    status: 'in_progress',
    statusLabel: "En cours d'execution"
  }])
})

test('formatValidatedTourStatus translates every lifecycle status and falls back to validated', () => {
  assert.equal(formatValidatedTourStatus('validated'), 'Validee - a demarrer')
  assert.equal(formatValidatedTourStatus('in_progress'), "En cours d'execution")
  assert.equal(formatValidatedTourStatus('completed'), 'Terminee')
  assert.equal(formatValidatedTourStatus('replaced'), 'Remplacee')
  assert.equal(formatValidatedTourStatus(''), 'Validee - a demarrer')
})

test('buildValidatedTourHeaderModel exposes a display-ready header including lifecycle status', () => {
  const header = buildValidatedTourHeaderModel({
    tournee_code: 'sales-v2-20260825-C01',
    date: '2026-08-25',
    commercial_code: 'C02',
    route_code: 'R-1',
    depot_code: 'DEP1',
    clients_count: 2,
    status: 'completed',
    completed_at: '2026-08-25 17:00:00'
  }, COMMERCIAUX)

  assert.equal(header.commercialLabel, 'Commercial Sud (C02)')
  assert.equal(header.clientsCount, 2)
  assert.equal(header.date, '2026-08-25')
  assert.equal(header.status, 'completed')
  assert.equal(header.statusLabel, 'Terminee')
  assert.equal(header.isCompleted, true)
  assert.equal(header.canComplete, false)
  assert.equal(header.completedAt, '2026-08-25 17:00:00')
})

test('buildValidatedTourHeaderModel allows completion only while validated or in progress', () => {
  assert.equal(buildValidatedTourHeaderModel({ status: 'validated' }).canComplete, true)
  assert.equal(buildValidatedTourHeaderModel({ status: 'in_progress' }).canComplete, true)
  assert.equal(buildValidatedTourHeaderModel({ status: 'completed' }).canComplete, false)
  assert.equal(buildValidatedTourHeaderModel({ status: 'replaced' }).canComplete, false)
})

test('buildValidatedTourRows preserves the validated visit order (rang) instead of re-sorting by priority', () => {
  const rows = buildValidatedTourRows({
    commercial_code: 'C01',
    date: '2026-08-25',
    stops: [
      {
        rang: 1,
        client_code: '00152',
        client_id: '101',
        client_name: 'Client 00152',
        adresse: 'Adresse 1',
        latitude: 36.8,
        longitude: 10.1,
        planned_visit_id: 'sv2_visit_1',
        execution_status: 'pending',
        predicted_ca: 50,
        purchase_probability: 42.5
      },
      {
        rang: 2,
        client_code: '152',
        client_id: '102',
        client_name: 'Client 152',
        adresse: 'Adresse 2',
        execution_status: 'visited',
        purchase_made: 1,
        actual_ca: 300,
        actual_quantity: 5,
        predicted_ca: 500
      }
    ]
  })

  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.clientCode), ['00152', '152'])
  assert.deepEqual(rows.map(row => row.rang), [1, 2])
  assert.equal(rows[0].plannedVisitId, 'sv2_visit_1')
  assert.equal(rows[0].purchaseProbability, 42.5)
  assert.equal(rows[0].gpsAvailable, true)
  assert.equal(rows[1].gpsAvailable, false)
  assert.equal(rows[1].executionStatus, 'visited')
  assert.equal(rows[1].actualCa, 300)
  assert.equal(rows[1].actualQuantity, 5)
})

test('buildValidatedTourRouteStops maps rows into route-hook compatible stops', () => {
  const stops = buildValidatedTourRouteStops([
    { clientId: '101', clientCode: '00152', clientName: 'Client 00152', address: 'Adresse 1', latitude: 36.8, longitude: 10.1, rang: 1 }
  ])

  assert.deepEqual(stops, [{
    id: '101',
    client_id: '101',
    client_code: '00152',
    nom: 'Client 00152',
    adresse: 'Adresse 1',
    latitude: 36.8,
    longitude: 10.1,
    step: 1
  }])
})

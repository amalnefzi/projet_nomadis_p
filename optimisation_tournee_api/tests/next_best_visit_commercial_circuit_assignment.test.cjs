const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildCompatibleCommercialCodesByClientId,
  buildHistoricalCommercialCircuitProfileByCode,
  generateNextBestVisitPlanFromData
} = require('../next_best_visit_engine')
const {
  assignVisitOpportunities,
  buildCommercialSlots
} = require('../visit_assignment_optimizer')

function makeRequestContext(overrides = {}) {
  return {
    startDate: '2026-08-16',
    historicalCutoffDate: '2026-08-15',
    planningHorizonDays: 1,
    minVisitsPerDayPreference: 0,
    maxVisitsPerDay: 30,
    minDailyCaPerCommercial: null,
    commercialCodes: ['1', '2'],
    objectiveMode: 'balanced',
    maxDaysWithoutContact: null,
    respectAvailability: 'flexible',
    minimumConfidence: 0,
    dailyMaxMode: 'flexible',
    maxCandidateDatesPerClient: 4,
    ...overrides
  }
}

function makeSelectedCommercials() {
  return [
    { value: '1', label: 'Commercial 1' },
    { value: '2', label: 'Commercial 2' }
  ]
}

function makeClient(clientId, clientCode, latitude, longitude, overrides = {}) {
  return {
    client_id: String(clientId),
    client_code: String(clientCode),
    nom: `Client ${clientCode}`,
    latitude,
    longitude,
    user_code: '1',
    resolved_commercial_code: '1',
    ...overrides
  }
}

function makeCadenceProfile(clientId, clientCode, startDate = '2026-08-16') {
  return {
    client_id: String(clientId),
    client_code: String(clientCode),
    last_purchase_date: '2026-08-09',
    purchase_count: 6,
    average_days_between_purchases: 7,
    median_days_between_purchases: 7,
    recent_weighted_purchase_interval_days: 7,
    purchase_frequency_per_week: 1,
    purchase_frequency_per_month: 4,
    usual_purchase_weekdays: [],
    usual_order_quantity: 3,
    usual_order_value: 150,
    purchase_interval_variability: 0.2,
    next_purchase_date_estimate: startDate,
    next_purchase_window_start: startDate,
    next_purchase_window_end: startDate,
    cadence_confidence: 0.9,
    history_depth: 6,
    customer_activity_trend: 'stable',
    inactivity_risk: 'low',
    recommended_visit_interval_days: 7,
    fallback_strategy: null,
    last_contact_date: '2026-08-09',
    days_since_last_purchase: 7,
    days_since_last_contact: 7
  }
}

function makeCoverageConstraints({ startDate = '2026-08-16', clientRestrictions = {} } = {}) {
  return {
    commercials: {
      '1': { available_dates: [startDate], unavailable_dates: [] },
      '2': { available_dates: [startDate], unavailable_dates: [] }
    },
    client_restrictions: clientRestrictions
  }
}

function makeSalesHistoryByClientId(entriesByClientId = {}) {
  return new Map(
    Object.entries(entriesByClientId).map(([clientId, rows]) => [String(clientId), rows.map(row => ({ ...row }))])
  )
}

function getCircuitClientIds(profileByCommercialCode, commercialCode) {
  return (profileByCommercialCode.get(String(commercialCode)) || [])
    .map(point => String(point?.client_id || ''))
    .sort()
}

function getAssignedVisitForClient(payload, clientId) {
  const visits = (Array.isArray(payload?.blocks) ? payload.blocks : [])
    .flatMap(block => Array.isArray(block?.clients) ? block.clients : [])
  return visits.find(visit => String(visit?.client_id || '') === String(clientId)) || null
}

async function buildPlan({
  clients,
  salesHistoryByClientId,
  requestContext = makeRequestContext(),
  coverageConstraints = makeCoverageConstraints({ startDate: requestContext.startDate }),
  cadenceProfiles = clients.map(client => makeCadenceProfile(client.client_id, client.client_code, requestContext.startDate))
} = {}) {
  return generateNextBestVisitPlanFromData({
    requestContext,
    clients,
    cadenceProfiles,
    selectedCommercials: makeSelectedCommercials(),
    coverageConstraints,
    salesHistoryByClientId,
    predictions: []
  })
}

test('clients without explicit hard restrictions keep all selected operational commercials as candidates', () => {
  const compatible = buildCompatibleCommercialCodesByClientId(
    [makeClient('client-a', '00152', 36.8, 10.1)],
    makeSelectedCommercials(),
    makeCoverageConstraints()
  )

  assert.deepEqual(compatible.get('client-a'), ['1', '2'])
})

test('client with user_code 1 can be assigned to another selected commercial when that historical circuit is clearly closer', async () => {
  const clients = [
    makeClient('target', '00152', 36.8, 10.1),
    makeClient('near-2a', '00201', 36.801, 10.101, { user_code: '2', resolved_commercial_code: '2' }),
    makeClient('near-2b', '00202', 36.802, 10.102, { user_code: '2', resolved_commercial_code: '2' }),
    makeClient('near-2c', '00203', 36.803, 10.103, { user_code: '2', resolved_commercial_code: '2' }),
    makeClient('far-1a', '00101', 37.5, 11.2),
    makeClient('far-1b', '00102', 37.6, 11.3),
    makeClient('far-1c', '00103', 37.7, 11.4)
  ]
  const payload = await buildPlan({
    clients,
    salesHistoryByClientId: makeSalesHistoryByClientId({
      target: [{ purchase_date: '2026-08-10', commercial_code: '1' }],
      'near-2a': [{ purchase_date: '2026-08-11', commercial_code: '2' }],
      'near-2b': [{ purchase_date: '2026-08-12', commercial_code: '2' }],
      'near-2c': [{ purchase_date: '2026-08-13', commercial_code: '2' }],
      'far-1a': [{ purchase_date: '2026-08-09', commercial_code: '1' }],
      'far-1b': [{ purchase_date: '2026-08-08', commercial_code: '1' }],
      'far-1c': [{ purchase_date: '2026-08-07', commercial_code: '1' }]
    })
  })

  const assignedVisit = getAssignedVisitForClient(payload, 'target')
  assert.ok(assignedVisit, 'target client should receive an assigned visit')
  assert.equal(assignedVisit.commercial_code, '2')
  assert.equal(assignedVisit.circuit_assignment_source, 'historical_commercial_circuit')
  assert.equal(assignedVisit.historical_commercial_continuity, false)
  assert.equal(Number.isFinite(Number(assignedVisit.circuit_distance_km)), true)
})

test('explicit allowed_commercial_codes still force the allowed commercial', async () => {
  const clients = [
    makeClient('target', '00152', 36.8, 10.1),
    makeClient('near-2a', '00201', 36.801, 10.101, { user_code: '2', resolved_commercial_code: '2' }),
    makeClient('near-2b', '00202', 36.802, 10.102, { user_code: '2', resolved_commercial_code: '2' }),
    makeClient('near-2c', '00203', 36.803, 10.103, { user_code: '2', resolved_commercial_code: '2' })
  ]
  const payload = await buildPlan({
    clients,
    coverageConstraints: makeCoverageConstraints({
      clientRestrictions: {
        target: { allowed_commercial_codes: ['1'] }
      }
    }),
    salesHistoryByClientId: makeSalesHistoryByClientId({
      'near-2a': [{ purchase_date: '2026-08-11', commercial_code: '2' }],
      'near-2b': [{ purchase_date: '2026-08-12', commercial_code: '2' }],
      'near-2c': [{ purchase_date: '2026-08-13', commercial_code: '2' }]
    })
  })

  const assignedVisit = getAssignedVisitForClient(payload, 'target')
  assert.ok(assignedVisit, 'target client should still be assigned')
  assert.equal(assignedVisit.commercial_code, '1')
})

test('explicit allowed code unavailable leaves zero compatible commercials', () => {
  const compatible = buildCompatibleCommercialCodesByClientId(
    [makeClient('target', '00152', 36.8, 10.1)],
    [{ value: '2', label: 'Commercial 2' }],
    makeCoverageConstraints({
      clientRestrictions: {
        target: {
          allowed_commercial_codes: ['1'],
          denied_commercial_codes: ['2']
        }
      }
    })
  )

  assert.deepEqual(compatible.get('target'), [])
})

test('one isolated historical sale with another commercial does not put client in both circuits', () => {
  const profile = buildHistoricalCommercialCircuitProfileByCode({
    clients: [
      makeClient('shared', '00901', 36.8005, 10.1005)
    ],
    salesHistoryByClientId: makeSalesHistoryByClientId({
      shared: [
        { purchase_date: '2026-08-10', commercial_code: '1' },
        { purchase_date: '2026-08-11', commercial_code: '1' },
        { purchase_date: '2026-08-12', commercial_code: '1' },
        { purchase_date: '2026-08-13', commercial_code: '2' }
      ]
    }),
    selectedCommercials: makeSelectedCommercials(),
    referenceDate: '2026-08-15'
  })

  assert.deepEqual(getCircuitClientIds(profile, '1'), ['shared'])
  assert.deepEqual(getCircuitClientIds(profile, '2'), [])
})

test('historical client circuit point is assigned to the dominant commercial by sale frequency', () => {
  const profile = buildHistoricalCommercialCircuitProfileByCode({
    clients: [
      makeClient('dominant-frequency', '00902', 36.801, 10.101)
    ],
    salesHistoryByClientId: makeSalesHistoryByClientId({
      'dominant-frequency': [
        { purchase_date: '2026-08-07', commercial_code: '1' },
        { purchase_date: '2026-08-08', commercial_code: '1' },
        { purchase_date: '2026-08-09', commercial_code: '1' },
        { purchase_date: '2026-08-10', commercial_code: '2' },
        { purchase_date: '2026-08-11', commercial_code: '2' }
      ]
    }),
    selectedCommercials: makeSelectedCommercials(),
    referenceDate: '2026-08-15'
  })

  assert.deepEqual(getCircuitClientIds(profile, '1'), ['dominant-frequency'])
  assert.deepEqual(getCircuitClientIds(profile, '2'), [])
})

test('historical client circuit tie is resolved by most recent valid sale', () => {
  const profile = buildHistoricalCommercialCircuitProfileByCode({
    clients: [
      makeClient('recent-tie', '00903', 36.8015, 10.1015)
    ],
    salesHistoryByClientId: makeSalesHistoryByClientId({
      'recent-tie': [
        { purchase_date: '2026-08-09', commercial_code: '1' },
        { purchase_date: '2026-08-12', commercial_code: '1' },
        { purchase_date: '2026-08-10', commercial_code: '2' },
        { purchase_date: '2026-08-14', commercial_code: '2' },
        { purchase_date: '2026-08-20', commercial_code: '1' }
      ]
    }),
    selectedCommercials: makeSelectedCommercials(),
    referenceDate: '2026-08-15'
  })

  assert.deepEqual(getCircuitClientIds(profile, '1'), [])
  assert.deepEqual(getCircuitClientIds(profile, '2'), ['recent-tie'])
})

test('candidate client own coordinates and history are excluded from circuit distance calculation', async () => {
  const clients = [
    makeClient('target', '00152', 36.8, 10.1),
    makeClient('near-2a', '00201', 36.804, 10.104, { user_code: '2', resolved_commercial_code: '2' })
  ]
  const payload = await buildPlan({
    clients,
    salesHistoryByClientId: makeSalesHistoryByClientId({
      target: [{ purchase_date: '2026-08-10', commercial_code: '1' }],
      'near-2a': [{ purchase_date: '2026-08-11', commercial_code: '2' }]
    })
  })

  const assignedVisit = getAssignedVisitForClient(payload, 'target')
  assert.ok(assignedVisit, 'target client should receive an assigned visit')
  assert.equal(assignedVisit.commercial_code, '2')
  assert.equal(assignedVisit.circuit_distance_km > 0, true)
})

test('historical cutoff date prevents future sales from influencing the circuit profile', async () => {
  const requestContext = makeRequestContext({
    startDate: '2026-08-18',
    historicalCutoffDate: '2026-08-15'
  })
  const clients = [
    makeClient('target', '00152', 36.8, 10.1),
    makeClient('future-1', '00199', 36.8005, 10.1005),
    makeClient('past-2', '00201', 36.803, 10.103, { user_code: '2', resolved_commercial_code: '2' })
  ]
  const payload = await buildPlan({
    clients,
    requestContext,
    coverageConstraints: makeCoverageConstraints({ startDate: requestContext.startDate }),
    cadenceProfiles: clients.map(client => makeCadenceProfile(client.client_id, client.client_code, requestContext.startDate)),
    salesHistoryByClientId: makeSalesHistoryByClientId({
      'future-1': [{ purchase_date: '2026-08-17', commercial_code: '1' }],
      'past-2': [{ purchase_date: '2026-08-14', commercial_code: '2' }]
    })
  })

  const assignedVisit = getAssignedVisitForClient(payload, 'target')
  assert.ok(assignedVisit, 'target client should receive an assigned visit')
  assert.equal(assignedVisit.commercial_code, '2')
})

test('missing geographic history falls back safely without circuit diagnostics', async () => {
  const payload = await buildPlan({
    clients: [makeClient('target', '00152', 36.8, 10.1)],
    salesHistoryByClientId: makeSalesHistoryByClientId({})
  })

  const assignedVisit = getAssignedVisitForClient(payload, 'target')
  assert.ok(assignedVisit, 'target client should still be assigned without circuit history')
  assert.equal(assignedVisit.circuit_distance_km, null)
  assert.equal(assignedVisit.circuit_assignment_source, null)
})

test('when circuit distance is unknown, existing load balancing still decides the slot', () => {
  const slots = buildCommercialSlots({
    planningDates: ['2026-08-16'],
    selectedCommercials: makeSelectedCommercials(),
    requestMaxVisits: 30
  })
  const commercialOneSlot = slots.find(slot => slot.commercial_code === '1')
  commercialOneSlot.visits.push({
    visit_opportunity_id: 'existing',
    assigned_date: '2026-08-16',
    expected_order_value: 0
  })

  const assignment = assignVisitOpportunities({
    opportunities: [{
      visit_opportunity_id: 'new-opp',
      visit_cycle_id: 'cycle-new',
      cycle_source: 'cadence_cycle',
      client_id: 'target',
      client_code: '00152',
      client_name: 'Target Client',
      candidate_date: '2026-08-16',
      preferred_date: '2026-08-16',
      earliest_allowed_date: '2026-08-16',
      latest_allowed_date: '2026-08-16',
      date_flexibility_type: 'fixed',
      candidate_date_source: 'purchase_cadence',
      date_shift_penalty_per_day: 8,
      purchase_prediction_known: false,
      visit_opportunity_score: 75,
      predicted_ca: 100,
      expected_order_value: 100,
      recommended_visit_interval_days: 7,
      cadence_confidence: 0.9,
      confidence: 80,
      possible_commercial_codes: ['1', '2'],
      availability_status: 'estimated_available',
      explanation_codes: [],
      explanation_reasons: [],
      portfolio_status: 'due_now',
      historical_commercial_continuity_code: '1',
      commercial_circuit_distances_km: {}
    }],
    slots,
    options: {}
  })

  const assignedVisit = assignment.blocks
    .flatMap(block => block.clients)
    .find(visit => String(visit?.client_id || '') === 'target')
  assert.equal(assignedVisit.commercial_code, '2')
  assert.equal(assignedVisit.circuit_distance_km, null)
})

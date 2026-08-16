const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildClientFinalDecisions,
  generateNextBestVisitPlanFromData,
  normalizeNextBestVisitRequest
} = require('../next_best_visit_engine')
const { buildCommercialSlots } = require('../visit_assignment_optimizer')

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

function makeCandidateEntry(clientId, candidateDate) {
  return {
    client_id: String(clientId),
    candidate_date: candidateDate,
    preferred_date: candidateDate,
    earliest_allowed_date: candidateDate,
    latest_allowed_date: candidateDate,
    candidate_date_source: 'test_source',
    date_flexibility_type: 'fixed'
  }
}

test('smart portfolio core attribue un statut portfolio a 100% des clients actifs', () => {
  const clients = [
    makeClient(1, { client_code: '00152', nom: 'Recent Monthly' }),
    makeClient(2, { client_code: '00002', nom: 'Due Today' }),
    makeClient(3, { client_code: '00003', nom: 'Due Soon' }),
    makeClient(4, { client_code: '00004', nom: 'Overdue' }),
    makeClient(5, { client_code: '00005', nom: 'No History' }),
    makeClient(6, { client_code: '00006', nom: 'Hard Constraint' }),
    makeClient(7, { client_code: '00007', nom: 'Capacity Blocked' }),
    makeClient(8, { client_code: '', nom: 'Invalid Client' })
  ]

  const candidateDatesByClientId = new Map([
    ['1', ['2026-08-07']],
    ['2', ['2026-08-07']],
    ['3', ['2026-08-09']],
    ['4', ['2026-08-03']],
    ['5', []],
    ['6', ['2026-08-07']],
    ['7', ['2026-08-07']]
  ])

  const candidateDateEntriesByClientId = new Map([
    ['1', [makeCandidateEntry(1, '2026-08-07')]],
    ['2', [makeCandidateEntry(2, '2026-08-07')]],
    ['3', [makeCandidateEntry(3, '2026-08-09')]],
    ['4', [makeCandidateEntry(4, '2026-08-03')]],
    ['6', [makeCandidateEntry(6, '2026-08-07')]],
    ['7', [makeCandidateEntry(7, '2026-08-07')]]
  ])

  const cadenceProfiles = [
    {
      client_id: '1',
      recommended_visit_interval_days: 30,
      cadence_confidence: 0.92,
      purchase_count: 3,
      history_depth: 12,
      last_purchase_date: '2026-07-08',
      next_purchase_date_estimate: '2026-08-07',
      next_purchase_window_start: '2026-08-07',
      next_purchase_window_end: '2026-08-07',
      decision_mode: 'predictive'
    },
    {
      client_id: '2',
      recommended_visit_interval_days: 15,
      cadence_confidence: 0.8,
      purchase_count: 4,
      history_depth: 18,
      last_purchase_date: '2026-07-23',
      next_purchase_date_estimate: '2026-08-07',
      next_purchase_window_start: '2026-08-07',
      next_purchase_window_end: '2026-08-07',
      decision_mode: 'predictive'
    },
    {
      client_id: '3',
      recommended_visit_interval_days: 14,
      cadence_confidence: 0.7,
      purchase_count: 5,
      history_depth: 20,
      last_purchase_date: '2026-07-26',
      next_purchase_date_estimate: '2026-08-09',
      next_purchase_window_start: '2026-08-09',
      next_purchase_window_end: '2026-08-09',
      decision_mode: 'predictive'
    },
    {
      client_id: '4',
      recommended_visit_interval_days: 7,
      cadence_confidence: 0.75,
      purchase_count: 4,
      history_depth: 15,
      last_purchase_date: '2026-08-01',
      next_purchase_date_estimate: '2026-08-03',
      next_purchase_window_start: '2026-08-03',
      next_purchase_window_end: '2026-08-03',
      decision_mode: 'predictive'
    },
    {
      client_id: '5',
      recommended_visit_interval_days: null,
      cadence_confidence: 0.25,
      purchase_count: 0,
      history_depth: 0,
      decision_mode: 'exploration'
    },
    {
      client_id: '6',
      recommended_visit_interval_days: 10,
      cadence_confidence: 0.85,
      purchase_count: 2,
      history_depth: 6,
      last_purchase_date: '2026-07-28',
      next_purchase_date_estimate: '2026-08-07',
      next_purchase_window_start: '2026-08-07',
      next_purchase_window_end: '2026-08-07',
      decision_mode: 'hybrid'
    },
    {
      client_id: '7',
      recommended_visit_interval_days: 10,
      cadence_confidence: 0.85,
      purchase_count: 2,
      history_depth: 6,
      last_purchase_date: '2026-07-28',
      next_purchase_date_estimate: '2026-08-07',
      next_purchase_window_start: '2026-08-07',
      next_purchase_window_end: '2026-08-07',
      decision_mode: 'hybrid'
    }
  ]

  const rejectedOpportunities = [
    {
      client_id: '7',
      client_code: '00007',
      rejection_reason_codes: ['CAPACITY_REACHED']
    }
  ]

  const finalDecisionSummary = buildClientFinalDecisions({
    clients,
    blocks: [
      {
        slot_id: '2026-08-07::C01',
        date: '2026-08-07',
        commercial_code: 'C01',
        clients: [{ client_id: '1', client_code: '00152' }, { client_id: '2', client_code: '00002' }]
      }
    ],
    rejectedOpportunities,
    candidateDatesByClientId,
    candidateDateEntriesByClientId,
    cadenceProfiles,
    compatibleCommercialCodesByClientId: new Map([
      ['1', ['C01']],
      ['2', ['C01']],
      ['3', ['C01']],
      ['4', ['C01']],
      ['5', ['C01']],
      ['6', []],
      ['7', ['C01']]
    ]),
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    requestContext: {
      startDate: '2026-08-07',
      planningHorizonDays: 7,
      maxVisitsPerDay: 1,
      minVisitsPerDayPreference: 1,
      maxDaysWithoutContact: 21
    },
    planningDates: ['2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']
  })

  assert.equal(finalDecisionSummary.active_clients_count, 8)
  assert.equal(finalDecisionSummary.portfolio_summary.total_clients, 8)
  assert.equal(finalDecisionSummary.portfolio_summary.active_clients_count, 8)
  assert.equal(Object.values(finalDecisionSummary.client_final_decisions).length, 8)
  assert.equal(finalDecisionSummary.portfolio_summary.due_now_count, 2)
  assert.equal(finalDecisionSummary.portfolio_summary.due_soon_count, 1)
  assert.equal(finalDecisionSummary.portfolio_summary.overdue_count, 1)
  assert.equal(finalDecisionSummary.portfolio_summary.exploration_needed_count, 1)
  assert.equal(finalDecisionSummary.portfolio_summary.capacity_unplanned_count, 1)
  assert.equal(finalDecisionSummary.portfolio_summary.hard_constraint_unplanned_count, 1)
  assert.equal(finalDecisionSummary.portfolio_summary.invalid_data_count, 1)
  assert.equal(finalDecisionSummary.portfolio_summary.portfolio_invariant_status, 'passed')
  assert.equal(finalDecisionSummary.portfolio_summary.portfolio_invariant_difference, 0)
  assert.equal(finalDecisionSummary.client_final_decisions['1'].portfolio_status, 'due_now')
  assert.equal(finalDecisionSummary.client_final_decisions['2'].portfolio_status, 'due_now')
  assert.equal(finalDecisionSummary.client_final_decisions['3'].portfolio_status, 'due_soon')
  assert.equal(finalDecisionSummary.client_final_decisions['4'].portfolio_status, 'overdue')
  assert.equal(finalDecisionSummary.client_final_decisions['5'].portfolio_status, 'exploration_needed')
  assert.equal(finalDecisionSummary.client_final_decisions['6'].portfolio_status, 'hard_constraint_unplanned')
  assert.equal(finalDecisionSummary.client_final_decisions['7'].portfolio_status, 'capacity_unplanned')
  assert.equal(finalDecisionSummary.client_final_decisions['8'].portfolio_status, 'invalid_data')
  assert.equal(finalDecisionSummary.client_final_decisions['1'].next_action, 'visit_now')
  assert.equal(finalDecisionSummary.client_final_decisions['5'].next_action, 'explore_client')
  assert.equal(finalDecisionSummary.client_final_decisions['6'].next_action, 'resolve_constraints')
  assert.equal(finalDecisionSummary.client_final_decisions['7'].next_action, 'review_capacity')
  assert.equal(finalDecisionSummary.client_final_decisions['8'].next_action, 'fix_data')
  assert.equal(finalDecisionSummary.client_final_decisions['1'].recommended_visit_interval_days, 30)
  assert.equal(finalDecisionSummary.client_final_decisions['5'].recommended_visit_interval_days, null)
  assert.equal(finalDecisionSummary.client_final_decisions['1'].cadence_confidence, 0.92)
  assert.equal(finalDecisionSummary.client_final_decisions['7'].reason_codes.includes('CAPACITY_CONSTRAINT'), true)
})

test('no compatible commercials -> hard_constraint_unplanned when visit required', () => {
  const startDate = '2026-08-07'
  const planningDates = ['2026-08-07','2026-08-08','2026-08-09']

  const clients = [
    makeClient('A', { client_code: 'A0001', nom: 'Due Now' }),
    makeClient('B', { client_code: 'B0002', nom: 'Overdue' }),
    makeClient('C', { client_code: 'C0003', nom: 'Not Due' }),
    makeClient('D', { client_code: 'D0004', nom: 'Exploration Needed' })
  ]

  const candidateDatesByClientId = new Map([
    ['A', [startDate]], // due_now
    ['B', ['2026-07-01']], // overdue
    ['C', ['2026-09-01']], // not due within horizon
    // D has no candidate date -> exploration_needed when decision_mode exploration
  ])

  const candidateDateEntriesByClientId = new Map([
    ['A', [makeCandidateEntry('A', startDate)]],
    ['B', [makeCandidateEntry('B', '2026-07-01')]],
    ['C', [makeCandidateEntry('C', '2026-09-01')]]
  ])

  const cadenceProfiles = [
    { client_id: 'A', decision_mode: 'predictive', recommended_visit_interval_days: 30, cadence_confidence: 0.8, last_purchase_date: '2026-07-08' },
    { client_id: 'B', decision_mode: 'predictive', recommended_visit_interval_days: 10, cadence_confidence: 0.8, last_purchase_date: '2026-06-01' },
    { client_id: 'C', decision_mode: 'predictive', recommended_visit_interval_days: 90, cadence_confidence: 0.8, last_purchase_date: '2026-07-01' },
    { client_id: 'D', decision_mode: 'exploration', recommended_visit_interval_days: null, cadence_confidence: 0.2 }
  ]

  const finalDecisionSummary = buildClientFinalDecisions({
    clients,
    blocks: [],
    rejectedOpportunities: [],
    candidateDatesByClientId,
    candidateDateEntriesByClientId,
    cadenceProfiles,
    compatibleCommercialCodesByClientId: new Map([['A', []], ['B', []], ['C', []], ['D', []]]),
    selectedCommercials: [],
    requestContext: { startDate, planningHorizonDays: planningDates.length },
    planningDates
  })

  // A: due_now + no compatible => hard_constraint_unplanned
  assert.equal(finalDecisionSummary.client_final_decisions['A'].portfolio_status, 'hard_constraint_unplanned')
  // B: overdue + no compatible => hard_constraint_unplanned
  assert.equal(finalDecisionSummary.client_final_decisions['B'].portfolio_status, 'hard_constraint_unplanned')
  // C: not_due + no compatible => remains not_due
  assert.equal(finalDecisionSummary.client_final_decisions['C'].portfolio_status, 'not_due')
  // D: exploration_needed + no compatible => hard_constraint_unplanned
  assert.equal(finalDecisionSummary.client_final_decisions['D'].portfolio_status, 'hard_constraint_unplanned')
  // reason code for hard constraint should include NO_COMPATIBLE_COMMERCIAL
  assert.ok(finalDecisionSummary.client_final_decisions['A'].reason_codes.includes('NO_COMPATIBLE_COMMERCIAL'))
})

test('compatible commercial filtering never mutates next_due metadata', () => {
  const startDate = '2026-08-07'
  const planningDates = ['2026-08-07', '2026-08-08', '2026-08-09']
  const candidateEntry = makeCandidateEntry('A', startDate)

  const baseArgs = {
    clients: [makeClient('A', { client_code: 'A0001', nom: 'Due Client' })],
    blocks: [],
    rejectedOpportunities: [],
    candidateDatesByClientId: new Map([['A', [startDate]]]),
    candidateDateEntriesByClientId: new Map([['A', [candidateEntry]]]),
    cadenceProfiles: [{
      client_id: 'A',
      decision_mode: 'predictive',
      recommended_visit_interval_days: 30,
      cadence_confidence: 0.8,
      last_purchase_date: '2026-07-08',
      next_purchase_date_estimate: startDate,
      next_purchase_window_start: startDate,
      next_purchase_window_end: startDate
    }],
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    requestContext: { startDate, planningHorizonDays: planningDates.length },
    planningDates
  }

  const withCompatible = buildClientFinalDecisions({
    ...baseArgs,
    compatibleCommercialCodesByClientId: new Map([['A', ['C01']]])
  }).client_final_decisions['A']

  const withoutCompatible = buildClientFinalDecisions({
    ...baseArgs,
    compatibleCommercialCodesByClientId: new Map([['A', []]])
  }).client_final_decisions['A']

  assert.equal(withCompatible.portfolio_status, 'due_now')
  assert.equal(withoutCompatible.portfolio_status, 'hard_constraint_unplanned')
  assert.equal(withCompatible.next_due_date, withoutCompatible.next_due_date)
  assert.equal(withCompatible.next_due_window_start, withoutCompatible.next_due_window_start)
  assert.equal(withCompatible.next_due_window_end, withoutCompatible.next_due_window_end)
  assert.ok(withoutCompatible.reason_codes.includes('NO_COMPATIBLE_COMMERCIAL'))
})

test('generateNextBestVisitPlanFromData serialise portfolio metadata sans casser les anciens champs', async () => {
  const payload = await generateNextBestVisitPlanFromData({
    requestContext: normalizeNextBestVisitRequest({
      start_date: '2026-08-07',
      planning_horizon_days: 7,
      commercial_codes: ['C01']
    }),
    clients: [makeClient(1, { client_code: '00152' })],
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    coverageConstraints: { commercials: { C01: { available_dates: ['2026-08-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-08-07': 1 } } }, client_restrictions: {} },
    predictions: []
  })

  assert.equal(typeof payload.portfolio_summary, 'object')
  assert.equal(typeof payload.portfolio_feasibility, 'object')
  assert.equal(Array.isArray(payload.client_final_decisions), false)
  assert.equal(typeof payload.client_final_decisions['1'], 'object')
  assert.equal(typeof payload.client_final_decisions['1'].portfolio_status, 'string')
  assert.equal(typeof payload.client_final_decisions['1'].next_action, 'string')
  assert.ok('next_due_date' in payload.client_final_decisions['1'])
  assert.ok('decision_mode' in payload.client_final_decisions['1'])
  assert.ok('cadence_confidence' in payload.client_final_decisions['1'])
  assert.ok(Array.isArray(payload.client_final_decisions['1'].reason_codes))
  assert.equal(payload.summary.active_clients_count, 1)
  assert.equal(payload.client_scope.active_clients_count, 1)
})

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildCandidateDateEntriesByClientId
} = require('../next_best_visit_engine')
const {
  assignVisitOpportunities,
  buildCommercialSlots
} = require('../visit_assignment_optimizer')

function makeExplorationProfile(clientId, clientCode) {
  return {
    client_id: String(clientId),
    client_code: String(clientCode),
    purchase_count: 0,
    history_depth: 0,
    cadence_confidence: 0.12,
    recommended_visit_interval_days: 21,
    inactivity_risk: 'medium',
    usual_purchase_weekdays: []
  }
}

function makeClient(clientId, clientCode, overrides = {}) {
  return {
    client_id: String(clientId),
    client_code: String(clientCode),
    nom: `Client ${clientCode}`,
    delegation: 'CENTRE',
    user_code: 'C01',
    resolved_commercial_code: 'C01',
    latitude: 36.8,
    longitude: 10.1,
    ...overrides
  }
}

function makeOpportunity(overrides = {}) {
  return {
    visit_opportunity_id: 'opp-default',
    client_id: '1',
    client_code: '001',
    client_name: 'Client 001',
    candidate_date: '2026-08-04',
    preferred_date: '2026-08-04',
    earliest_allowed_date: '2026-08-04',
    latest_allowed_date: '2026-08-04',
    date_flexibility_type: 'fixed',
    candidate_date_source: 'purchase_cadence',
    date_shift_penalty_per_day: 8,
    purchase_prediction_known: false,
    visit_opportunity_score: 50,
    predicted_ca: 100,
    expected_order_value: 100,
    recommended_visit_interval_days: 7,
    confidence: 60,
    possible_commercial_codes: ['C01'],
    availability_status: 'estimated_available',
    explanation_codes: [],
    explanation_reasons: [],
    usual_purchase_weekdays: [],
    ...overrides
  }
}

test('exploration windows are deterministic and do not all collapse on planning start date', () => {
  const profiles = [
    makeExplorationProfile('1', '00152'),
    makeExplorationProfile('2', '00153'),
    makeExplorationProfile('3', '00154')
  ]
  const clients = [
    makeClient('1', '00152', { delegation: 'NORD' }),
    makeClient('2', '00153', { delegation: 'SUD' }),
    makeClient('3', '00154', { delegation: 'EST' })
  ]
  const requestContext = {
    startDate: '2026-08-04',
    planningHorizonDays: 14,
    maxCandidateDatesPerClient: 4,
    maxDaysWithoutContact: null
  }

  const firstMap = buildCandidateDateEntriesByClientId(profiles, requestContext, null, clients)
  const secondMap = buildCandidateDateEntriesByClientId(profiles, requestContext, null, clients)
  const firstEntries = [...firstMap.values()].flat()
  const secondEntries = [...secondMap.values()].flat()

  assert.deepEqual(firstEntries, secondEntries)
  assert.equal(firstEntries.every(entry => entry.date_flexibility_type === 'exploration_window'), true)
  assert.equal(firstEntries.every(entry => entry.candidate_date_source === 'exploration_fallback'), true)
  assert.equal(firstEntries.every(entry => entry.candidate_date === '2026-08-04'), false)
})

test('fixed opportunities stay fixed while flexible windows may shift within bounds', () => {
  const slots = buildCommercialSlots({
    planningDates: ['2026-08-04', '2026-08-05', '2026-08-06'],
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    requestMaxVisits: 1
  })
  const assignment = assignVisitOpportunities({
    opportunities: [
      makeOpportunity({
        visit_opportunity_id: 'fixed-1',
        client_id: '1',
        client_code: '00152',
        visit_opportunity_score: 95,
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        earliest_allowed_date: '2026-08-04',
        latest_allowed_date: '2026-08-04',
        date_flexibility_type: 'fixed'
      }),
      makeOpportunity({
        visit_opportunity_id: 'flex-1',
        client_id: '2',
        client_code: '00153',
        visit_opportunity_score: 60,
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        earliest_allowed_date: '2026-08-04',
        latest_allowed_date: '2026-08-06',
        date_flexibility_type: 'flexible_window',
        candidate_date_source: 'low_history_fallback',
        date_shift_penalty_per_day: 1
      })
    ],
    slots,
    options: {
      minimumVisitsPreference: 1
    }
  })

  const allVisits = assignment.blocks.flatMap(block => block.clients)
  const fixedVisit = allVisits.find(visit => visit.visit_opportunity_id === 'fixed-1')
  const flexibleVisit = allVisits.find(visit => visit.visit_opportunity_id === 'flex-1')

  assert.equal(fixedVisit.assigned_date, '2026-08-04')
  assert.equal(flexibleVisit.assigned_date, '2026-08-05')
  assert.equal(flexibleVisit.date_shift_days, 1)
  assert.equal(assignment.visits_shifted_for_soft_balance_count, 1)
})

test('strong opportunities are not shifted just to visually balance the days', () => {
  const slots = buildCommercialSlots({
    planningDates: ['2026-08-04', '2026-08-05'],
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    requestMaxVisits: 2
  })
  const assignment = assignVisitOpportunities({
    opportunities: [
      makeOpportunity({
        visit_opportunity_id: 'strong-1',
        client_id: '1',
        client_code: '00152',
        visit_opportunity_score: 92,
        predicted_ca: 600,
        expected_order_value: 600,
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        earliest_allowed_date: '2026-08-04',
        latest_allowed_date: '2026-08-05',
        date_flexibility_type: 'flexible_window',
        candidate_date_source: 'low_history_fallback',
        date_shift_penalty_per_day: 3
      }),
      makeOpportunity({
        visit_opportunity_id: 'weak-1',
        client_id: '2',
        client_code: '00153',
        visit_opportunity_score: 32,
        predicted_ca: 30,
        expected_order_value: 30,
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        earliest_allowed_date: '2026-08-04',
        latest_allowed_date: '2026-08-05',
        date_flexibility_type: 'flexible_window',
        candidate_date_source: 'low_history_fallback',
        date_shift_penalty_per_day: 1
      })
    ],
    slots,
    options: {
      minimumVisitsPreference: 1
    }
  })

  const allVisits = assignment.blocks.flatMap(block => block.clients)
  const strongVisit = allVisits.find(visit => visit.visit_opportunity_id === 'strong-1')
  const weakVisit = allVisits.find(visit => visit.visit_opportunity_id === 'weak-1')

  assert.equal(strongVisit.assigned_date, '2026-08-04')
  assert.ok(['2026-08-04', '2026-08-05'].includes(weakVisit.assigned_date))
  assert.equal(assignment.strong_opportunities_shifted_count, 0)
})

test('repeats on consecutive days are rejected unless explicitly justified', () => {
  const slots = buildCommercialSlots({
    planningDates: ['2026-08-04', '2026-08-05'],
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    requestMaxVisits: 2
  })
  const assignment = assignVisitOpportunities({
    opportunities: [
      makeOpportunity({
        visit_opportunity_id: 'repeat-1',
        client_id: '1',
        client_code: '00152',
        visit_opportunity_score: 80,
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        earliest_allowed_date: '2026-08-04',
        latest_allowed_date: '2026-08-04',
        date_flexibility_type: 'fixed',
        recommended_visit_interval_days: 7
      }),
      makeOpportunity({
        visit_opportunity_id: 'repeat-2',
        client_id: '1',
        client_code: '00152',
        visit_opportunity_score: 79,
        candidate_date: '2026-08-05',
        preferred_date: '2026-08-05',
        earliest_allowed_date: '2026-08-05',
        latest_allowed_date: '2026-08-05',
        date_flexibility_type: 'fixed',
        recommended_visit_interval_days: 7
      })
    ],
    slots,
    options: {
      minimumVisitsPreference: 0
    }
  })

  assert.equal(assignment.selected_visits_count, 1)
  assert.equal(assignment.rejected_opportunities_count, 1)
  assert.equal(assignment.minimum_observed_gap_days, null)
  assert.match(assignment.rejected_opportunities[0].rejection_reason_codes.join(','), /RECENT_PURCHASE_DEPRIORITIZED/)
})

test('low-signal exploration opportunities stay capped per slot instead of filling the whole day', () => {
  const slots = buildCommercialSlots({
    planningDates: ['2026-08-04'],
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    requestMaxVisits: 30
  })
  const assignment = assignVisitOpportunities({
    opportunities: [
      makeOpportunity({
        visit_opportunity_id: 'explore-low-1',
        client_id: '9',
        client_code: '00999',
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        earliest_allowed_date: '2026-08-04',
        latest_allowed_date: '2026-08-04',
        date_flexibility_type: 'exploration_window',
        candidate_date_source: 'exploration_fallback',
        decision_mode: 'exploration',
        visit_opportunity_score: 3.5,
        strategic_client_score: 10,
        purchase_prediction_known: false,
        inactivity_risk: 'unknown'
      }),
      makeOpportunity({
        visit_opportunity_id: 'explore-low-2',
        client_id: '10',
        client_code: '01000',
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        earliest_allowed_date: '2026-08-04',
        latest_allowed_date: '2026-08-04',
        date_flexibility_type: 'exploration_window',
        candidate_date_source: 'exploration_fallback',
        decision_mode: 'exploration',
        visit_opportunity_score: 3.6,
        strategic_client_score: 12,
        purchase_prediction_known: false,
        inactivity_risk: 'unknown'
      }),
      makeOpportunity({
        visit_opportunity_id: 'explore-low-3',
        client_id: '11',
        client_code: '01001',
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        earliest_allowed_date: '2026-08-04',
        latest_allowed_date: '2026-08-04',
        date_flexibility_type: 'exploration_window',
        candidate_date_source: 'exploration_fallback',
        decision_mode: 'exploration',
        visit_opportunity_score: 3.4,
        strategic_client_score: 8,
        purchase_prediction_known: false,
        inactivity_risk: 'unknown'
      })
    ],
    slots,
    options: {
      minimumVisitsPreference: 2
    }
  })

  assert.equal(assignment.selected_visits_count, 2)
  assert.equal(assignment.rejected_opportunities_count, 1)
  assert.match(assignment.rejected_opportunities[0].rejection_reason_codes.join(','), /LOW_EFFECTIVE_SCORE/)
})

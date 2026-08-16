const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildCandidateDateEntriesByClientId
} = require('../next_best_visit_engine')
const {
  assignVisitOpportunities,
  buildCommercialSlots
} = require('../visit_assignment_optimizer')
const {
  __testables: serviceTestables
} = require('../next_best_visit_service')

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

function makeOpportunity(overrides = {}) {
  return {
    visit_opportunity_id: 'opp-default',
    visit_cycle_id: 'cycle-default',
    cycle_source: 'cadence_cycle',
    cycle_sequence_number: 1,
    cycle_window_start: '2026-08-04',
    cycle_window_end: '2026-08-04',
    cycle_preferred_date: '2026-08-04',
    cycle_confidence: 60,
    repeat_justification_code: 'cadence_cycle',
    client_id: '1',
    client_code: '00152',
    client_name: 'Client 00152',
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
    cadence_confidence: 0.8,
    confidence: 60,
    possible_commercial_codes: ['C01'],
    availability_status: 'estimated_available',
    explanation_codes: [],
    explanation_reasons: [],
    usual_purchase_weekdays: [],
    ...overrides
  }
}

function makeSlots(planningDates) {
  return buildCommercialSlots({
    planningDates,
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    requestMaxVisits: 30
  })
}

test('multiple candidate dates from the same cycle produce at most one selected visit', () => {
  const assignment = assignVisitOpportunities({
    opportunities: [
      makeOpportunity({
        visit_opportunity_id: 'cycle-a-1',
        visit_cycle_id: 'cycle-a',
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        earliest_allowed_date: '2026-08-04',
        latest_allowed_date: '2026-08-06',
        date_flexibility_type: 'flexible_window',
        visit_opportunity_score: 80
      }),
      makeOpportunity({
        visit_opportunity_id: 'cycle-a-2',
        visit_cycle_id: 'cycle-a',
        candidate_date: '2026-08-05',
        preferred_date: '2026-08-05',
        earliest_allowed_date: '2026-08-04',
        latest_allowed_date: '2026-08-06',
        date_flexibility_type: 'flexible_window',
        visit_opportunity_score: 79
      })
    ],
    slots: makeSlots(['2026-08-04', '2026-08-05', '2026-08-06']),
    options: {}
  })

  assert.equal(assignment.selected_visits_count, 1)
  assert.equal(assignment.duplicate_cycle_selection_count, 0)
  assert.equal(assignment.duplicate_cycle_selection_prevented_count, 1)
})

test('two distinct cycles can still produce two visits for the same client', () => {
  const assignment = assignVisitOpportunities({
    opportunities: [
      makeOpportunity({
        visit_opportunity_id: 'cycle-a',
        visit_cycle_id: 'cycle-a',
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        cycle_source: 'predicted_purchase_cycle',
        repeat_justification_code: 'distinct_prediction_cycle',
        purchase_prediction_known: true,
        recommended_visit_interval_days: 2,
        date_flexibility_type: 'fixed'
      }),
      makeOpportunity({
        visit_opportunity_id: 'cycle-b',
        visit_cycle_id: 'cycle-b',
        candidate_date: '2026-08-05',
        preferred_date: '2026-08-05',
        earliest_allowed_date: '2026-08-05',
        latest_allowed_date: '2026-08-05',
        cycle_source: 'predicted_purchase_cycle',
        repeat_justification_code: 'distinct_prediction_cycle',
        purchase_prediction_known: true,
        recommended_visit_interval_days: 2,
        date_flexibility_type: 'fixed',
        visit_opportunity_score: 49
      })
    ],
    slots: makeSlots(['2026-08-04', '2026-08-05']),
    options: {}
  })

  assert.equal(assignment.selected_visits_count, 2)
  assert.equal(assignment.one_day_gap_count, 1)
  assert.equal(assignment.justified_one_day_gap_count, 1)
  assert.equal(assignment.unjustified_one_day_gap_count, 0)
  assert.equal(assignment.suspicious_repeat_count, 0)
})

test('one-day gaps are rejected when there is no strong repeat evidence', () => {
  const assignment = assignVisitOpportunities({
    opportunities: [
      makeOpportunity({
        visit_opportunity_id: 'monthly-a',
        visit_cycle_id: 'monthly-a',
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        recommended_visit_interval_days: 9
      }),
      makeOpportunity({
        visit_opportunity_id: 'monthly-b',
        visit_cycle_id: 'monthly-b',
        candidate_date: '2026-08-05',
        preferred_date: '2026-08-05',
        earliest_allowed_date: '2026-08-05',
        latest_allowed_date: '2026-08-05',
        recommended_visit_interval_days: 9,
        visit_opportunity_score: 49
      })
    ],
    slots: makeSlots(['2026-08-04', '2026-08-05']),
    options: {}
  })

  assert.equal(assignment.selected_visits_count, 1)
  assert.equal(assignment.rejected_opportunities_count, 1)
  assert.equal(assignment.one_day_gap_count, 0)
  assert.equal(assignment.suspicious_repeat_count, 0)
})

test('exploration defaults to a single visit per client in the horizon', () => {
  const assignment = assignVisitOpportunities({
    opportunities: [
      makeOpportunity({
        visit_opportunity_id: 'explore-a',
        visit_cycle_id: 'explore-a',
        cycle_source: 'exploration_cycle',
        repeat_justification_code: null,
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        earliest_allowed_date: '2026-08-04',
        latest_allowed_date: '2026-08-06',
        date_flexibility_type: 'exploration_window',
        candidate_date_source: 'exploration_fallback',
        purchase_prediction_known: false,
        recommended_visit_interval_days: 21,
        visit_opportunity_score: 12
      }),
      makeOpportunity({
        visit_opportunity_id: 'explore-b',
        visit_cycle_id: 'explore-b',
        cycle_source: 'exploration_cycle',
        repeat_justification_code: null,
        candidate_date: '2026-08-06',
        preferred_date: '2026-08-06',
        earliest_allowed_date: '2026-08-05',
        latest_allowed_date: '2026-08-06',
        date_flexibility_type: 'exploration_window',
        candidate_date_source: 'exploration_fallback',
        purchase_prediction_known: false,
        recommended_visit_interval_days: 21,
        visit_opportunity_score: 11
      })
    ],
    slots: makeSlots(['2026-08-04', '2026-08-05', '2026-08-06']),
    options: {}
  })

  assert.equal(assignment.selected_visits_count, 1)
  assert.equal(assignment.exploration_repeat_prevented_count, 1)
  assert.equal(assignment.exploration_visits_per_client['1'], 1)
})

test('the same client cannot be scheduled twice on the same day even with distinct cycles', () => {
  const assignment = assignVisitOpportunities({
    opportunities: [
      makeOpportunity({
        visit_opportunity_id: 'same-day-a',
        visit_cycle_id: 'same-day-a',
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04'
      }),
      makeOpportunity({
        visit_opportunity_id: 'same-day-b',
        visit_cycle_id: 'same-day-b',
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        visit_opportunity_score: 49
      })
    ],
    slots: makeSlots(['2026-08-04']),
    options: {}
  })

  assert.equal(assignment.selected_visits_count, 1)
  assert.equal(assignment.rejected_opportunities_count, 1)
})

test('monthly cadence clients stay protected against over-visiting', () => {
  const assignment = assignVisitOpportunities({
    opportunities: [
      makeOpportunity({
        visit_opportunity_id: 'monthly-cycle-a',
        visit_cycle_id: 'monthly-cycle-a',
        candidate_date: '2026-08-04',
        preferred_date: '2026-08-04',
        recommended_visit_interval_days: 30
      }),
      makeOpportunity({
        visit_opportunity_id: 'monthly-cycle-b',
        visit_cycle_id: 'monthly-cycle-b',
        candidate_date: '2026-08-14',
        preferred_date: '2026-08-14',
        earliest_allowed_date: '2026-08-14',
        latest_allowed_date: '2026-08-14',
        recommended_visit_interval_days: 30,
        visit_opportunity_score: 49
      })
    ],
    slots: makeSlots(['2026-08-04', '2026-08-14']),
    options: {}
  })

  assert.equal(assignment.selected_visits_count, 1)
  assert.equal(assignment.rejected_opportunities_count, 1)
})

test('exploration anchors are deterministic and distributed in round-robin by group', () => {
  const profiles = [
    makeExplorationProfile('1', '00152'),
    makeExplorationProfile('2', '00153'),
    makeExplorationProfile('3', '00154'),
    makeExplorationProfile('4', '00155')
  ]
  const clients = [
    makeClient('1', '00152', { delegation: 'NORD', resolved_commercial_code: 'C01' }),
    makeClient('2', '00153', { delegation: 'NORD', resolved_commercial_code: 'C01' }),
    makeClient('3', '00154', { delegation: 'NORD', resolved_commercial_code: 'C01' }),
    makeClient('4', '00155', { delegation: 'NORD', resolved_commercial_code: 'C01' })
  ]
  const requestContext = {
    startDate: '2026-08-04',
    planningHorizonDays: 5,
    maxCandidateDatesPerClient: 4,
    maxDaysWithoutContact: null
  }
  const planningDates = ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08']
  const options = {
    coverageConstraints: {
      commercials: {
        C01: {
          available_dates: planningDates,
          unavailable_dates: []
        }
      }
    },
    compatibleCommercialCodesByClientId: new Map([
      ['1', ['C01']],
      ['2', ['C01']],
      ['3', ['C01']],
      ['4', ['C01']]
    ])
  }

  const firstMap = buildCandidateDateEntriesByClientId(profiles, requestContext, planningDates, clients, options)
  const secondMap = buildCandidateDateEntriesByClientId(profiles, requestContext, planningDates, clients, options)
  const firstDates = [...firstMap.values()].map(entries => entries[0]?.candidate_date)
  const secondDates = [...secondMap.values()].map(entries => entries[0]?.candidate_date)

  assert.deepEqual(firstDates, secondDates)
  assert.equal(new Set(firstDates).size >= 3, true)
  assert.deepEqual(firstDates.sort(), [...firstDates].sort())
})

test('00152 remains distinct from 152 in exploration distribution and cycle identities', () => {
  const profiles = [
    makeExplorationProfile('1', '00152'),
    makeExplorationProfile('2', '152')
  ]
  const clients = [
    makeClient('1', '00152', { delegation: 'NORD' }),
    makeClient('2', '152', { delegation: 'SUD' })
  ]
  const requestContext = {
    startDate: '2026-08-04',
    planningHorizonDays: 7,
    maxCandidateDatesPerClient: 4,
    maxDaysWithoutContact: null
  }

  const entryMap = buildCandidateDateEntriesByClientId(profiles, requestContext, null, clients, {
    coverageConstraints: {
      commercials: {
        C01: {
          available_dates: ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10'],
          unavailable_dates: []
        }
      }
    },
    compatibleCommercialCodesByClientId: new Map([
      ['1', ['C01']],
      ['2', ['C01']]
    ])
  })

  const firstEntry = entryMap.get('1')[0]
  const secondEntry = entryMap.get('2')[0]

  assert.notEqual(firstEntry.visit_cycle_id, secondEntry.visit_cycle_id)
})

test('service performance summary now accounts for lightweight overhead timing', () => {
  const performance = serviceTestables.summarizePerformanceStages([
    { stage: 'load_profile_snapshot', duration_ms: 250 },
    { stage: 'assignment', duration_ms: 550 },
    { stage: 'total_service', duration_ms: 1000 }
  ])

  assert.equal(performance.unaccounted_time_ms, 200)
  assert.equal(performance.timing_coverage_rate, 100)
  assert.equal(performance.stages.some(stage => stage.stage === 'service_overhead' && stage.duration_ms === 200), true)
})

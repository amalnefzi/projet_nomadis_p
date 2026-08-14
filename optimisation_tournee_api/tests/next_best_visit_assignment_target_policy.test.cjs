const test = require('node:test')
const assert = require('node:assert/strict')

const {
  assignVisitOpportunities,
  buildCommercialSlots
} = require('../visit_assignment_optimizer')

function makeOpportunity(index, overrides = {}) {
  const clientId = String(overrides.client_id || index)
  const clientCode = String(overrides.client_code || String(index).padStart(5, '0'))
  return {
    visit_opportunity_id: `opp-${clientId}`,
    visit_cycle_id: `cycle-${clientId}`,
    cycle_source: 'cadence_cycle',
    client_id: clientId,
    client_code: clientCode,
    client_name: `Client ${clientCode}`,
    candidate_date: '2026-08-11',
    preferred_date: '2026-08-11',
    earliest_allowed_date: '2026-08-11',
    latest_allowed_date: '2026-08-11',
    date_flexibility_type: 'fixed',
    candidate_date_source: 'purchase_cadence',
    date_shift_penalty_per_day: 2,
    purchase_prediction_known: true,
    purchase_probability: 55,
    predicted_ca: 120,
    expected_order_value: 120,
    recommended_quantity: 2,
    confidence: 70,
    visit_opportunity_score: 50,
    strategic_client_score: 60,
    inactivity_risk: 'medium',
    possible_commercial_codes: ['C01'],
    availability_status: 'estimated_available',
    recommended_visit_interval_days: 7,
    portfolio_status: 'due_soon',
    decision_mode: 'predictive',
    explanation_codes: [],
    explanation_reasons: [],
    ...overrides
  }
}

function makeSlots(planningDates, maxVisits = 40) {
  return buildCommercialSlots({
    planningDates,
    selectedCommercials: [{ value: 'C01', label: 'Commercial C01' }],
    requestMaxVisits: maxVisits
  })
}

function countVisitsPerDate(assignment = {}) {
  return Object.fromEntries(
    (assignment.blocks || []).map(block => [block.date, Number(block.clients_count || 0)])
  )
}

test('Scenario A: target load materially influences selection instead of stopping arbitrarily low', () => {
  const opportunities = Array.from({ length: 35 }, (_, index) => makeOpportunity(index + 1, {
    portfolio_status: 'due_soon',
    decision_mode: 'exploration',
    purchase_prediction_known: false,
    visit_opportunity_score: 4 + (index % 3) * 0.1,
    strategic_client_score: 15 + (index % 4),
    inactivity_risk: 'medium',
    date_flexibility_type: 'exploration_window',
    candidate_date_source: 'exploration_fallback'
  }))

  const assignment = assignVisitOpportunities({
    opportunities,
    slots: makeSlots(['2026-08-11'], 40),
    options: {
      minimumVisitsPreference: 30
    }
  })

  assert.ok(assignment.selected_visits_count >= 30, `expected at least 30 selected visits, got ${assignment.selected_visits_count}`)
  assert.ok(assignment.selected_visits_count <= 35)
  assert.equal(
    assignment.rejected_opportunities.every(item => (item.rejection_reason_codes || []).includes('LOW_EFFECTIVE_SCORE')),
    true
  )
})

test('Scenario B: valid opportunities below target do not create fake visits', () => {
  const opportunities = Array.from({ length: 17 }, (_, index) => makeOpportunity(index + 1, {
    portfolio_status: 'due_soon',
    visit_opportunity_score: 30 - index
  }))

  const assignment = assignVisitOpportunities({
    opportunities,
    slots: makeSlots(['2026-08-11'], 40),
    options: {
      minimumVisitsPreference: 30
    }
  })

  assert.equal(assignment.selected_visits_count, 17)
  assert.equal(assignment.rejected_opportunities_count, 0)
})

test('Scenario C: due_now obligations are retained and due_soon opportunities fill toward target', () => {
  const dueNow = Array.from({ length: 15 }, (_, index) => makeOpportunity(index + 1, {
    portfolio_status: 'due_now',
    decision_mode: 'exploration',
    purchase_prediction_known: false,
    visit_opportunity_score: 3.5 + (index % 2) * 0.1,
    strategic_client_score: 12,
    inactivity_risk: 'medium',
    date_flexibility_type: 'exploration_window',
    candidate_date_source: 'exploration_fallback'
  }))
  const dueSoon = Array.from({ length: 20 }, (_, index) => makeOpportunity(index + 101, {
    portfolio_status: 'due_soon',
    decision_mode: 'exploration',
    purchase_prediction_known: false,
    visit_opportunity_score: 3.4 + (index % 3) * 0.1,
    strategic_client_score: 11,
    inactivity_risk: 'medium',
    date_flexibility_type: 'exploration_window',
    candidate_date_source: 'exploration_fallback'
  }))

  const assignment = assignVisitOpportunities({
    opportunities: [...dueNow, ...dueSoon],
    slots: makeSlots(['2026-08-11'], 40),
    options: {
      minimumVisitsPreference: 30
    }
  })

  const selectedCodes = new Set(assignment.blocks.flatMap(block => block.clients.map(client => String(client.client_code))))
  dueNow.forEach(opportunity => {
    assert.equal(selectedCodes.has(String(opportunity.client_code)), true, `expected due_now client ${opportunity.client_code} to be selected`)
  })
  assert.ok(assignment.selected_visits_count >= 30, `expected fill toward target, got ${assignment.selected_visits_count}`)
})

test('Scenario D: hard daily maximum stays enforced even when obligations exceed target', () => {
  const opportunities = Array.from({ length: 45 }, (_, index) => makeOpportunity(index + 1, {
    portfolio_status: index < 25 ? 'overdue' : 'due_now',
    purchase_probability: 60,
    purchase_prediction_known: true,
    visit_opportunity_score: 80 - index * 0.1
  }))

  const assignment = assignVisitOpportunities({
    opportunities,
    slots: makeSlots(['2026-08-11'], 40),
    options: {
      minimumVisitsPreference: 30
    }
  })

  assert.equal(assignment.selected_visits_count, 40)
  assert.equal(assignment.rejected_opportunities_count, 5)
  assert.equal(
    assignment.rejected_opportunities.every(item => (item.rejection_reason_codes || []).includes('CAPACITY_REACHED')),
    true
  )
})

test('Scenario E: multi-day flexible opportunities balance across days instead of collapsing on day 1', () => {
  const opportunities = Array.from({ length: 9 }, (_, index) => makeOpportunity(index + 1, {
    portfolio_status: 'due_soon',
    candidate_date: '2026-08-11',
    preferred_date: '2026-08-11',
    earliest_allowed_date: '2026-08-11',
    latest_allowed_date: '2026-08-13',
    date_flexibility_type: 'flexible_window',
    candidate_date_source: 'low_history_fallback',
    date_shift_penalty_per_day: 0.2,
    visit_opportunity_score: 20
  }))

  const assignment = assignVisitOpportunities({
    opportunities,
    slots: makeSlots(['2026-08-11', '2026-08-12', '2026-08-13'], 15),
    options: {
      minimumVisitsPreference: 3
    }
  })

  assert.deepEqual(countVisitsPerDate(assignment), {
    '2026-08-11': 3,
    '2026-08-12': 3,
    '2026-08-13': 3
  })
})

test('Scenario F: not_due clients are never scheduled just to fill the target', () => {
  const dueNow = Array.from({ length: 5 }, (_, index) => makeOpportunity(index + 1, {
    portfolio_status: 'due_now',
    visit_opportunity_score: 60 - index
  }))
  const notDue = Array.from({ length: 20 }, (_, index) => makeOpportunity(index + 101, {
    portfolio_status: 'not_due',
    visit_opportunity_score: 90 - index
  }))

  const assignment = assignVisitOpportunities({
    opportunities: [...dueNow, ...notDue],
    slots: makeSlots(['2026-08-11'], 40),
    options: {
      minimumVisitsPreference: 30
    }
  })

  assert.equal(assignment.selected_visits_count, 5)
  assert.equal(
    assignment.blocks.flatMap(block => block.clients).every(client => String(client.portfolio_status || '').trim() !== 'not_due'),
    true
  )
})

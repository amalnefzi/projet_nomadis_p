import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  buildDefaultSalesMonitoringFilters,
  buildSalesLearningStatusViewModel,
  buildSalesMonitoringKpis,
  buildSalesMonitoringPanelState,
  buildSalesMonitoringRequestPayload,
  buildSalesMonitoringViewModel,
  formatSalesMonitoringBiasLabel,
  formatSalesMonitoringMetricValue
} from '../salesCoverageDetails.js'

test('monitoring filters default to a bounded date window', () => {
  const filters = buildDefaultSalesMonitoringFilters('2026-08-10', 14)

  assert.deepEqual(filters, {
    start_date: '2026-08-10',
    end_date: '2026-08-23',
    commercial_codes: []
  })
})

test('monitoring request payload preserves exact commercial codes as strings', () => {
  const payload = buildSalesMonitoringRequestPayload({
    start_date: '2026-08-01',
    end_date: '2026-08-10'
  }, ['1', 'VL1900', '0007'], [
    { value: '1', label: 'Comm 1' },
    { value: 'VL1900', label: 'VL1900' },
    { value: '0007', label: '0007' }
  ])

  assert.deepEqual(payload, {
    start_date: '2026-08-01',
    end_date: '2026-08-10',
    commercial_codes: ['1', 'VL1900', '0007']
  })
})

test('monitoring metric formatting keeps null unavailable and valid zero visible', () => {
  assert.equal(formatSalesMonitoringMetricValue(null, 'currency'), 'Non disponible')
  assert.equal(formatSalesMonitoringMetricValue(0, 'currency'), '0,0 TND')
  assert.equal(formatSalesMonitoringMetricValue(0, 'number'), '0,0')
  assert.equal(formatSalesMonitoringMetricValue(0, 'percent'), '0,0 %')
})

test('monitoring bias formatting shows positive and negative signs explicitly', () => {
  assert.equal(formatSalesMonitoringBiasLabel(12.5, 'currency'), '+12,5 TND')
  assert.equal(formatSalesMonitoringBiasLabel(-4, 'number'), '-4,0')
  assert.equal(formatSalesMonitoringBiasLabel(null, 'currency'), 'Non disponible')
})

test('monitoring view-model normalizes API payloads and row formatting honestly', () => {
  const viewModel = buildSalesMonitoringViewModel({
    row_count: 2,
    summary: {
      execution: {
        planned: 2,
        visited: 1,
        not_visited: 0,
        pending: 1,
        execution_rate: 0.5
      },
      purchase: {
        comparable_visits: 1,
        purchases: 1,
        no_purchase: 0,
        conversion_rate: 1
      },
      ca_expected: {
        comparable_count: 1,
        mae: 10,
        bias: -3,
        mape_valid_count: 1,
        mape: 0.25
      },
      ca_if_buy: {
        comparable_count: 1,
        mae: 7,
        bias: 2,
        mape_valid_count: 1,
        mape: 0.1
      },
      quantity: {
        comparable_count: 1,
        mae: 1.5,
        bias: -0.5
      }
    },
    segmented: {
      by_commercial: {
        C01: {
          execution: { planned: 1, visited: 1, not_visited: 0, pending: 0, execution_rate: 1 },
          purchase: { comparable_visits: 1, purchases: 1, no_purchase: 0, conversion_rate: 1 },
          ca_expected: { comparable_count: 1, mae: 10, bias: -3, mape_valid_count: 1, mape: 0.25 },
          ca_if_buy: { comparable_count: 1, mae: 7, bias: 2, mape_valid_count: 1, mape: 0.1 },
          quantity: { comparable_count: 1, mae: 1.5, bias: -0.5 }
        }
      },
      by_planning_date: {
        '2026-08-10': {
          execution: { planned: 1, visited: 1, not_visited: 0, pending: 0, execution_rate: 1 },
          purchase: { comparable_visits: 1, purchases: 1, no_purchase: 0, conversion_rate: 1 },
          ca_expected: { comparable_count: 1, mae: 10, bias: -3, mape_valid_count: 1, mape: 0.25 },
          ca_if_buy: { comparable_count: 1, mae: 7, bias: 2, mape_valid_count: 1, mape: 0.1 },
          quantity: { comparable_count: 1, mae: 1.5, bias: -0.5 }
        }
      }
    }
  }, {
    row_count: 2,
    rows: [
      {
        planned_visit_id: 'sv2_visit_1',
        client_code: '00012',
        commercial_code: 'C01',
        planned_date: '2026-08-10',
        execution_status: 'visited',
        purchase_made: true,
        predicted: {
          expected_visit_ca: 100,
          ca_if_buy: 140,
          estimated_quantity: 4,
          quantity_if_buy: 6,
          portfolio_status: 'due_now',
          prediction_source: 'historical_pattern'
        },
        actual: {
          actual_ca: 120,
          actual_quantity: 5
        },
        comparison: {
          expected_ca_error: -20,
          conditional_ca_error: 20,
          quantity_error: 1
        }
      },
      {
        planned_visit_id: 'sv2_visit_2',
        client_code: '00013',
        commercial_code: 'C02',
        planned_date: '2026-08-11',
        execution_status: 'pending',
        purchase_made: null,
        predicted: {
          expected_visit_ca: null,
          ca_if_buy: null,
          estimated_quantity: null,
          quantity_if_buy: null,
          portfolio_status: null,
          prediction_source: null
        },
        actual: {
          actual_ca: null,
          actual_quantity: null
        },
        comparison: {
          expected_ca_error: null,
          conditional_ca_error: null,
          quantity_error: null
        }
      }
    ]
  })

  assert.equal(viewModel.rowCount, 2)
  assert.equal(viewModel.kpis.find(metric => metric.key === 'planned').valueLabel, '2')
  assert.equal(viewModel.kpis.find(metric => metric.key === 'execution_rate').valueLabel, '50,0 %')
  assert.equal(viewModel.kpis.find(metric => metric.key === 'ca_expected_bias').valueLabel, '-3,0 TND')
  assert.equal(viewModel.byCommercialRows[0].label, 'C01')
  assert.equal(viewModel.byPlanningDateRows[0].label, '2026-08-10')
  assert.equal(viewModel.detailRows[0].clientCode, '00012')
  assert.equal(viewModel.detailRows[0].expectedVisitCaLabel, '100,0 TND')
  assert.equal(viewModel.detailRows[0].actualCaLabel, '120,0 TND')
  assert.equal(viewModel.detailRows[0].expectedCaErrorLabel, '-20,0 TND')
  assert.equal(viewModel.detailRows[0].estimatedQuantityLabel, '6,0')
  assert.equal(viewModel.detailRows[1].expectedVisitCaLabel, 'Non disponible')
  assert.equal(viewModel.detailRows[1].actualQuantityLabel, 'Non disponible')
})

test('monitoring KPI builder keeps business labels and supports normalized summaries', () => {
  const kpis = buildSalesMonitoringKpis({
    execution: {
      planned: 4,
      visited: 3,
      notVisited: 1,
      pending: 0,
      executionRate: 0.75
    },
    purchase: {
      comparableVisits: 3,
      purchases: 2,
      noPurchase: 1,
      conversionRate: 2 / 3
    },
    caExpected: {
      comparableCount: 2,
      mae: 11,
      bias: -2,
      mapeValidCount: 2,
      mape: 0.2
    },
    caIfBuy: {
      comparableCount: 2,
      mae: 8,
      bias: 1,
      mapeValidCount: 2,
      mape: 0.1
    },
    quantity: {
      comparableCount: 2,
      mae: 1.2,
      bias: 0.4
    }
  })

  assert.equal(kpis.find(metric => metric.key === 'planned').label, 'Visites planifiees')
  assert.equal(kpis.find(metric => metric.key === 'execution_rate').valueLabel, '75,0 %')
  assert.equal(kpis.find(metric => metric.key === 'ca_expected_bias').valueLabel, '-2,0 TND')
})

test('monitoring panel state exposes loading, error and empty states', () => {
  assert.deepEqual(buildSalesMonitoringPanelState({
    loading: true,
    error: null,
    rowCount: 0
  }), {
    loading: true,
    error: null,
    empty: false,
    emptyMessage: null
  })

  assert.deepEqual(buildSalesMonitoringPanelState({
    loading: false,
    error: 'boom',
    rowCount: 0
  }), {
    loading: false,
    error: 'boom',
    empty: false,
    emptyMessage: null
  })

  assert.deepEqual(buildSalesMonitoringPanelState({
    loading: false,
    error: null,
    rowCount: 0
  }), {
    loading: false,
    error: null,
    empty: true,
    emptyMessage: 'Aucun resultat de visite disponible sur cette periode.'
  })
})

test('learning status view-model normalizes backend cycle state and polling semantics', () => {
  const activeView = buildSalesLearningStatusViewModel({
    loading: false,
    error: null,
    payload: {
      current_model: {
        model_version: 'model-v2'
      },
      learning_cycle_status: 'training',
      new_valid_feedback_count: 12,
      minimum_feedback_required: 30,
      last_decision: 'current_retained',
      latest_comparison_summary: {
        decision_reason: 'one_or_more_targets_not_improved'
      }
    }
  })

  assert.equal(activeView.modelVersionLabel, 'model-v2')
  assert.equal(activeView.newFeedbackLabel, '12')
  assert.equal(activeView.stateLabel, 'Entrainement en cours')
  assert.equal(activeView.decisionLabel, 'Modele actuel conserve')
  assert.equal(activeView.evaluationLabel, 'Modele actuel meilleur sur le holdout')
  assert.equal(activeView.shouldPoll, true)

  const waitingView = buildSalesLearningStatusViewModel({
    loading: false,
    error: null,
    payload: {
      learning_cycle_status: 'waiting_for_feedback',
      new_valid_feedback_count: 0,
      minimum_feedback_required: 30,
      last_decision: 'insufficient_data'
    }
  })

  assert.equal(waitingView.stateLabel, 'En attente de nouvelles donnees')
  assert.equal(waitingView.decisionLabel, 'En attente de nouvelles donnees')
  assert.equal(waitingView.shouldPoll, false)
})

test('normal Sales V2 planner hides monitoring and learning lifecycle surfaces', () => {
  const plannerSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesCoveragePlanner.jsx'),
    'utf8'
  )
  const panelSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesFeedbackMonitoringPanel.jsx'),
    'utf8'
  )
  const detailsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'salesCoverageDetails.js'),
    'utf8'
  )

  assert.equal(plannerSource.includes('/api/tournees/next-best-visits/feedback/monitoring'), false)
  assert.equal(plannerSource.includes('/api/tournees/next-best-visits/feedback/monitoring/details'), false)
  assert.equal(plannerSource.includes('/api/tournees/next-best-visits/learning/status'), false)
  assert.equal(plannerSource.includes('buildSalesMonitoringRequestPayload'), false)
  assert.equal(plannerSource.includes('SalesFeedbackMonitoringPanel'), false)
  assert.equal(panelSource.includes('Suivi Prevu vs Reel'), true)
  assert.equal(panelSource.includes('Apprentissage du modele'), true)
  assert.equal(panelSource.includes('Modele actuel'), true)
  assert.equal(detailsSource.includes('Visites planifiees'), true)
  assert.equal(detailsSource.includes('Entrainement en cours'), true)
  assert.equal(detailsSource.includes("Taux d execution"), true)
  assert.equal(panelSource.includes('Non disponible'), true)
  assert.equal(panelSource.includes('Biais positif = surestimation. Biais negatif = sous-estimation.'), true)
  assert.equal(panelSource.includes('CA prevu visite'), true)
  assert.equal(panelSource.includes('Qte prevue si achat'), true)
  assert.equal(panelSource.includes('Chargement du suivi prevu vs reel...'), true)
  assert.equal(detailsSource.includes('Aucun resultat de visite disponible sur cette periode.'), true)
})

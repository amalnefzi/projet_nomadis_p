import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { PLANNER_MODULES } from '../plannerModules.js'
import {
  SALES_COVERAGE_ALL_COMMERCIALS,
  SALES_COVERAGE_ALL_COMMERCIALS_LABEL,
  SALES_COVERAGE_FORM_FIELDS,
  aggregateSalesLoadingPrediction,
  areAllSalesCommercialsSelected,
  buildExpectedCaMetric,
  buildHighProbabilityMetric,
  buildSalesClientRows,
  buildSalesCoveragePayload,
  buildSalesCoveragePrecheckPayload,
  buildSalesDetailHeaderModel,
  buildSalesExecutionSummary,
  buildSalesVisitFeedbackDraft,
  buildSalesVisitFeedbackItems,
  buildSalesVisitFeedbackPayload,
  buildSalesVisitFeedbackRecordIndex,
  buildSalesPortfolioSummary,
  buildSalesPredictionConsistency,
  buildSalesPredictionSummary,
  buildSalesSidebarBlockModel,
  computeSalesGpsStats,
  describeSalesClientScope,
  extractSalesPlanView,
  formatCommercialZone,
  formatSalesConfidencePercent,
  formatSalesProductPredictionSource,
  formatSalesVisitExecutionStatus,
  getSalesCommercialSelectionLabel,
  listSalesCommercialValues,
  normalizeSelectedSalesCommercialCodes,
  resolveSelectedSalesBlock,
  toggleAllSalesCommercialsSelection,
  toggleSalesCommercialSelection
} from '../salesCoverageDetails.js'

test('navigation exposes the three independent interfaces', () => {
  assert.deepEqual(
    PLANNER_MODULES.map(item => item.label),
    [
      'Dashboard actuel',
      'Plan de Recouvrement',
      'Plan de tournees ventes'
    ]
  )
})

test('sales planner form exposes exactly the six required inputs', () => {
  assert.deepEqual(
    SALES_COVERAGE_FORM_FIELDS.map(field => field.label),
    [
      'Date de debut',
      'Periode en jours',
      'Charge cible / commercial / jour',
      'Maximum / commercial / jour',
      'CA minimum journalier',
      'Commerciaux'
    ]
  )
  assert.equal(SALES_COVERAGE_FORM_FIELDS.length, 6)
})

test('sales planner payload sends planning_mode sales_coverage and all commercials by default', () => {
  const payload = buildSalesCoveragePayload({
    start_date: '2026-08-03',
    period_days: '14',
    min_clients: '20',
    max_clients: '30',
    min_daily_ca_per_commercial: ''
  }, SALES_COVERAGE_ALL_COMMERCIALS, {
    coverage_window_days: 14,
    daily_max_mode: 'flexible'
  })

  assert.equal(payload.planning_mode, 'sales_coverage')
  assert.equal(payload.planning_horizon_days, 14)
  assert.equal(payload.period_days, 14)
  assert.equal(payload.coverage_window_days, 14)
  assert.equal(payload.visit_frequency_days, 14)
  assert.equal(payload.daily_max_mode, 'flexible')
  assert.equal(payload.min_daily_ca, null)
  assert.equal(payload.commercial_code, null)
  assert.deepEqual(payload.commercial_codes, [])
  assert.deepEqual(payload.commercials, [])
})

test('sales planner payload keeps one selected commercial as an exact string code', () => {
  const payload = buildSalesCoveragePayload({
    start_date: '2026-08-03',
    period_days: '14',
    min_clients: '20',
    max_clients: '30',
    min_daily_ca_per_commercial: ''
  }, ['001'], {
    coverage_window_days: 14,
    daily_max_mode: 'flexible'
  })

  assert.equal(payload.commercial_code, '001')
  assert.deepEqual(payload.commercial_codes, ['001'])
  assert.deepEqual(payload.commercials, ['001'])
})

test('sales planner payload keeps several selected commercials as exact strings', () => {
  const payload = buildSalesCoveragePayload({
    start_date: '2026-08-03',
    period_days: '14',
    min_clients: '20',
    max_clients: '30'
  }, ['1', 'VL1900', '0007'], {
    coverage_window_days: 14,
    daily_max_mode: 'flexible'
  })

  assert.equal(payload.commercial_code, null)
  assert.deepEqual(payload.commercial_codes, ['1', 'VL1900', '0007'])
  assert.deepEqual(payload.commercials, ['1', 'VL1900', '0007'])
})

test('sales commercial multi-select helpers keep all-selection and labels coherent', () => {
  const options = [
    { value: '1', label: 'Comm 1 - Nord' },
    { value: 'VL1900', label: 'VL1900 - Centre' },
    { value: '0007', label: '0007 - Sud' }
  ]

  assert.deepEqual(listSalesCommercialValues(options), ['1', 'VL1900', '0007'])
  assert.deepEqual(normalizeSelectedSalesCommercialCodes(SALES_COVERAGE_ALL_COMMERCIALS, options), ['1', 'VL1900', '0007'])
  assert.equal(areAllSalesCommercialsSelected(['1', 'VL1900', '0007'], options), true)
  assert.deepEqual(toggleAllSalesCommercialsSelection([], options), ['1', 'VL1900', '0007'])
  assert.deepEqual(toggleAllSalesCommercialsSelection(['1', 'VL1900', '0007'], options), [])
  assert.deepEqual(toggleSalesCommercialSelection(['1'], 'VL1900', options), ['1', 'VL1900'])
  assert.deepEqual(toggleSalesCommercialSelection(['1', 'VL1900'], '1', options), ['VL1900'])
  assert.equal(getSalesCommercialSelectionLabel(['1', 'VL1900', '0007'], options), SALES_COVERAGE_ALL_COMMERCIALS_LABEL)
  assert.equal(getSalesCommercialSelectionLabel(['VL1900'], options), 'VL1900 - Centre')
  assert.equal(getSalesCommercialSelectionLabel(['1', 'VL1900'], options), '2 commerciaux selectionnes')
})

test('sales planner keeps planning horizon and coverage window distinct for 7 and 14 days', () => {
  const payload = buildSalesCoveragePayload({
    start_date: '2026-08-03',
    period_days: '7',
    coverage_window_days: '14',
    daily_max_mode: 'strict',
    min_clients: '10',
    max_clients: '30'
  }, SALES_COVERAGE_ALL_COMMERCIALS, {
    coverage_window_days: 14,
    daily_max_mode: 'flexible'
  })

  assert.equal(payload.planning_horizon_days, 7)
  assert.equal(payload.period_days, 7)
  assert.equal(payload.coverage_window_days, 14)
  assert.equal(payload.visit_frequency_days, 14)
  assert.equal(payload.daily_max_mode, 'strict')
})

test('sales planner keeps planning horizon and coverage window distinct for 30 and 14 days', () => {
  const payload = buildSalesCoveragePayload({
    start_date: '2026-08-03',
    period_days: '30',
    coverage_window_days: '14',
    min_clients: '10',
    max_clients: '30'
  }, SALES_COVERAGE_ALL_COMMERCIALS, {
    coverage_window_days: 14,
    daily_max_mode: 'flexible'
  })

  assert.equal(payload.planning_horizon_days, 30)
  assert.equal(payload.coverage_window_days, 14)
  assert.notEqual(payload.planning_horizon_days, payload.coverage_window_days)
})

test('sales planner lightweight precheck payload uses the dedicated capacity endpoint shape', () => {
  const payload = buildSalesCoveragePrecheckPayload({
    start_date: '2026-08-03',
    period_days: '30',
    coverage_window_days: '14',
    min_clients: '20',
    max_clients: '30',
    daily_max_mode: 'flexible'
  }, SALES_COVERAGE_ALL_COMMERCIALS, {
    coverage_window_days: 14,
    daily_max_mode: 'flexible'
  })

  assert.deepEqual(payload, {
    start_date: '2026-08-03',
    planning_horizon_days: 30,
    coverage_window_days: 14,
    minimum_clients: 20,
    maximum_clients: 30,
    daily_max_mode: 'flexible',
    commercial: 'all',
    commercial_codes: []
  })
})

test('sales planner ui keeps Smart Portfolio and route execution separate', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesCoveragePlanner.jsx'),
    'utf8'
  )

  assert.equal(source.includes('La frequence de visite reste fixee a 14 jours.'), false)
  assert.equal(source.includes('Regles avancees'), true)
  assert.equal(source.includes('/api/tournees/coverage-capacity-precheck'), false)
  assert.equal(source.includes('/api/tournees/coverage-plan/precheck'), false)
  assert.equal(source.includes('AbortController'), false)
  assert.equal(source.includes('describeSalesClientScope'), true)
  assert.equal(source.includes('summary.client_scope'), false)
  assert.equal(source.includes('planView.clientScope'), true)
  assert.equal(source.includes('buildHighProbabilityMetric'), true)
  assert.equal(source.includes('Prediction coverage'), true)
  assert.equal(source.includes('/api/tournees/next-best-visits/readiness'), true)
  assert.equal(source.includes('Preparation des profils requise'), false)
  assert.equal(source.includes('Preparation en cours...'), true)
  assert.equal(source.includes('Cache du plan'), false)
  assert.equal(source.includes('SalesFeedbackMonitoringPanel'), false)
  assert.equal(source.includes('Tous les clients actifs restent suivis par le portefeuille Smart Portfolio.'), true)
  assert.equal(source.includes('La carte reste une vue d execution de route.'), true)
})

test('loading aggregation keeps exact product codes and does not add arbitrary safety margin', () => {
  const loadingPrediction = aggregateSalesLoadingPrediction({
    commercial_code: 'C01',
    date: '2026-08-11',
    clients_count: 2,
    clients: [
      {
        client_id: '1',
        recommended_products: [
          {
            product_code: '0007',
            product_label: 'Chips paprika',
            estimated_quantity: 3,
            prediction_source: 'historical_pattern',
            confidence_or_support: 2
          }
        ]
      },
      {
        client_id: '2',
        recommended_products: [
          {
            product_code: '0007',
            product_label: 'Chips paprika',
            estimated_quantity: 2,
            prediction_source: 'historical_pattern',
            confidence_or_support: 3
          }
        ]
      }
    ]
  })

  assert.equal(loadingPrediction.commercialCode, 'C01')
  assert.equal(loadingPrediction.planningDate, '2026-08-11')
  assert.deepEqual(loadingPrediction.products, [
    {
      productId: null,
      productCode: '0007',
      productLabel: 'Chips paprika',
      estimatedNeed: 5,
      recommendedLoadQuantity: 5,
      predictionSource: 'historical_pattern',
      confidenceOrSupport: 5
    }
  ])
  assert.equal(loadingPrediction.coverage.plannedVisits, 2)
  assert.equal(loadingPrediction.coverage.visitsWithBasketPrediction, 2)
  assert.equal(loadingPrediction.coverage.basketPredictionCoveragePct, 100)
})

test('client rows keep basket source and exact product codes as strings', () => {
  const rows = buildSalesClientRows({
    clients: [
      {
        client_id: '1',
        client_code: '00152',
        client_name: 'Client Exact',
        assigned_date: '2026-08-11',
        basket_prediction_source: 'historical_pattern',
        recommended_products: [
          {
            product_code: '0007',
            product_label: null,
            estimated_quantity: 3,
            prediction_source: 'historical_pattern',
            confidence_or_support: 2
          }
        ]
      }
    ]
  })

  assert.equal(rows[0].basketPredictionSource, 'historical_pattern')
  assert.equal(rows[0].predictedProducts[0].productCode, '0007')
  assert.equal(rows[0].predictedProducts[0].productLabel, null)
})

test('sales product prediction source labels stay honest', () => {
  assert.equal(formatSalesProductPredictionSource('model'), 'Base sur le modele')
  assert.equal(formatSalesProductPredictionSource('historical_pattern'), 'Base sur l historique client')
  assert.equal(formatSalesProductPredictionSource('unavailable'), 'Non disponible')
})

test('Sales V2 detail panels expose honest basket and loading labels', () => {
  const detailsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesTourDetails.jsx'),
    'utf8'
  )
  const loadingSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesLoadingPrediction.jsx'),
    'utf8'
  )
  const basketSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesBasketPrediction.jsx'),
    'utf8'
  )

  assert.equal(detailsSource.includes('SalesBasketPrediction'), true)
  assert.equal(loadingSource.includes('Chargement estime'), true)
  assert.equal(loadingSource.includes('Aucun coefficient de securite arbitraire n est ajoute'), true)
  assert.equal(basketSource.includes('Panier estime'), true)
  assert.equal(basketSource.includes('Panier : Non disponible'), true)
  assert.equal(basketSource.includes('Base sur l historique client'), false)
})

test('extractSalesPlanView keeps capacity precheck and coverage guarantee separate from result blocks', () => {
  const view = extractSalesPlanView({
    status: 'success',
    message: 'Resume',
    client_scope: {
      mode: 'all_active_clients',
      active_clients_count: 5768,
      selected_commercial_codes_count: 6,
      client_filter_applied: false
    },
    capacity_precheck: {
      required_visits_count: 5768,
      strict_capacity: 5400
    },
    request_context: {
      planning_horizon_days: 30,
      coverage_window_days: 14,
      daily_max_mode: 'flexible'
    },
    summary: {
      planning_horizon_days: 30,
      coverage_window_days: 14,
      coverage_guarantee_status: 'single_visit_only'
    },
    statuses: {
      data_environment: 'development'
    },
    clients_sans_date_recommandable: [
      { client_id: '77', no_candidate_date_reason: 'insufficient_history' }
    ],
    client_final_decisions: {
      77: { client_id: '77', final_client_status: 'no_candidate_date' }
    },
    blocks: []
  })

  assert.equal(view.capacityPrecheck.required_visits_count, 5768)
  assert.equal(view.clientScope.active_clients_count, 5768)
  assert.equal(view.requestContext.coverage_window_days, 14)
  assert.equal(view.summary.planning_horizon_days, 30)
  assert.equal(view.coverageGuaranteeStatus, 'single_visit_only')
  assert.equal(view.clientsSansDateRecommandable.length, 1)
  assert.equal(view.clientFinalDecisions['77'].final_client_status, 'no_candidate_date')
  assert.equal(view.statuses.data_environment, 'development')
})

test('describeSalesClientScope summarizes the corrected all-commercial scope for the UI', () => {
  const summary = describeSalesClientScope({
    mode: 'all_active_clients',
    active_clients_count: 5768,
    selected_commercial_codes_count: 6,
    client_filter_applied: false
  })

  assert.equal(summary.startsWith('Tous les clients actifs'), true)
  assert.equal(summary.includes('5768'), false)
  assert.match(summary, /5.\s*768|5.768|5 768/u)
  assert.equal(summary.includes('6 commercial(aux)'), true)
  assert.equal(summary.endsWith('filtre client non'), true)
})

test('plan blocks stay grouped by commercial/date and sidebar shows only the required summary', () => {
  const view = extractSalesPlanView({
    status: 'success',
    blocks: [
      {
        slot_id: '2026-08-03::S01',
        date: '2026-08-03',
        commercial_code: 'S01',
        commercial_label: 'Salah Ahmed (1)',
        clients_count: 69,
        purchase_prediction_known_count: 69,
        purchase_prediction_unknown_count: 0,
        predicted_order_value_total: 840.8,
        clients: [{}]
      },
      {
        slot_id: '2026-08-04::S01',
        date: '2026-08-04',
        commercial_code: 'S01',
        commercial_label: 'Salah Ahmed (1)',
        clients_count: 12,
        purchase_prediction_known_count: 7,
        purchase_prediction_unknown_count: 5,
        predicted_order_value_total: 220.4,
        clients: [{}]
      }
    ]
  })

  assert.equal(view.blocks.length, 2)
  assert.equal(view.blocks[0].commercial_code, 'S01')
  assert.equal(view.blocks[0].date, '2026-08-03')

  const fullSummary = buildSalesSidebarBlockModel(view.blocks[0])
  const partialSummary = buildSalesSidebarBlockModel(view.blocks[1])
  assert.equal(fullSummary.clientsLabel, '69 client(s)')
  assert.equal(fullSummary.predictedLabel, 'Valeur attendue totale : 840,8 TND')
  assert.equal(partialSummary.predictedLabel, 'Valeur attendue connue : 220,4 TND')
})

test('selecting a block updates the resolved sales detail block', () => {
  const blocks = [
    { slot_id: 'slot-a', date: '2026-08-03' },
    { slot_id: 'slot-b', date: '2026-08-04' }
  ]

  assert.equal(resolveSelectedSalesBlock(blocks, 'slot-a').date, '2026-08-03')
  assert.equal(resolveSelectedSalesBlock(blocks, 'slot-b').date, '2026-08-04')
})

test('dashboard and sales detail reuse the exact same commercial zone label', () => {
  const dashboardRow = {
    commercia_zone: 'Comm 1 - ELMENZAH',
    user_code: '1',
    delegation: 'ELMENZAH',
    routing_code: '1'
  }
  const salesRow = {
    user_code: '1',
    delegation: 'ELMENZAH',
    routing_code: '1'
  }

  assert.equal(formatCommercialZone(dashboardRow), 'Comm 1 - ELMENZAH')
  assert.equal(formatCommercialZone(salesRow), 'Comm 1 - ELMENZAH')
})

test('commercial zone labels distinguish source missing from not propagated', () => {
  assert.equal(formatCommercialZone({
    zone_resolution_status: 'zone_source_missing'
  }), 'Zone non renseignee')
  assert.equal(formatCommercialZone({
    zone_resolution_status: 'zone_not_propagated'
  }), 'Zone non transmise')
})

test('a full commercial zone label is never replaced by a raw code', () => {
  assert.equal(formatCommercialZone({
    user_code: '1',
    delegation: 'Ariana_Ville',
    routing_code: '1'
  }), 'Comm 1 - Ariana_Ville')
})

test('sales client rows keep priority, VIP, route order, and honest prediction fields separate', () => {
  const block = {
    clients_count: 4,
    purchase_prediction_known_count: 3,
    purchase_prediction_unknown_count: 1,
    clients: [
      {
        client_id: '1',
        client_code: '00152',
        client_name: 'Client 00152',
        user_code: '1',
        delegation: 'ELMENZAH',
        purchase_prediction_known: true,
        purchase_prediction_score: 30.2,
        prediction_vip: 15,
        candidate_date: '2026-08-04',
        assigned_date: '2026-08-04',
        preferred_date: '2026-08-04',
        candidate_date_source: 'purchase_prediction',
        recommended_quantity: 12.5,
        predicted_quantity_if_buy: 15.4,
        predicted_purchase_date: '2026-08-06',
        expected_order_value: 410.2,
        predicted_ca_if_buy: 512.4,
        latitude: null,
        longitude: null,
        portfolio_status: 'due_now',
        reason_codes: ['NO_COMPATIBLE_COMMERCIAL']
      },
      {
        client_id: '2',
        client_code: '152',
        client_name: 'Client 152',
        user_code: '1',
        delegation: 'Ariana_Ville',
        purchase_prediction_known: true,
        purchase_prediction_score: 64.6,
        prediction_vip: 82,
        candidate_date: '2026-08-05',
        assigned_date: '2026-08-06',
        preferred_date: '2026-08-05',
        candidate_date_source: 'low_history_fallback',
        shifted_within_recommended_window: true,
        date_shift_days: 1,
        recommended_quantity: 8,
        predicted_quantity_if_buy: 11,
        predicted_purchase_date: '2026-08-04',
        expected_order_value: 520,
        predicted_ca_if_buy: 830,
        latitude: 36.8,
        longitude: 10.1,
        portfolio_status: 'hard_constraint_unplanned',
        reason_codes: ['CAPACITY_CONSTRAINT']
      },
      {
        client_id: '3',
        client_code: '00003',
        client_name: 'Client 00003',
        user_code: '1',
        delegation: 'ELMENZAH',
        purchase_prediction_known: true,
        purchase_prediction_score: 27.1,
        prediction_vip: 40,
        candidate_date: '2026-08-08',
        assigned_date: '2026-08-08',
        preferred_date: '2026-08-08',
        candidate_date_source: 'purchase_cadence',
        recommended_quantity: 5,
        predicted_purchase_date: '2026-08-05',
        expected_order_value: 150
      },
      {
        client_id: '4',
        client_code: '00004',
        client_name: 'Client 00004',
        user_code: '1',
        delegation: 'ELMENZAH',
        purchase_prediction_known: false,
        purchase_prediction_score: null,
        recommended_quantity: null,
        predicted_purchase_date: null,
        expected_order_value: null,
        portfolio_status: 'not_due',
        reason_codes: []
      }
    ]
  }

  const rows = buildSalesClientRows(block, {
    orderedStops: [
      { client_id: '1', step: 1 },
      { client_id: '2', step: 2 }
    ]
  })

  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map(row => row.clientId), ['2', '1', '3', '4'])
  assert.deepEqual(rows.map(row => row.clientCode), ['152', '00152', '00003', '00004'])
  assert.equal(rows[0].priorityScore, 64.6)
  assert.equal(rows[0].vipScore, 82)
  assert.equal(rows[0].estimatedQuantity, 8)
  assert.equal(rows[0].estimatedQuantityIfBuy, 11)
  assert.equal(rows[0].predictedPurchaseDate, '2026-08-04')
  assert.equal(rows[0].expectedVisitValue, 520)
  assert.equal(rows[0].estimatedCaIfBuy, 830)
  assert.equal(rows[0].zoneLabel, 'Comm 1 - Ariana_Ville')
  assert.equal(rows[0].zoneStatus, 'zone_resolved')
  assert.equal(rows[0].zoneSource, 'delegation_user_code')
  assert.equal(rows[0].plannedDate, '2026-08-06')
  assert.equal(rows[0].dateSourceLabel, 'Fenetre flexible - historique limite')
  assert.equal(rows[0].shiftedWithinRecommendedWindow, true)
  assert.equal(rows[0].portfolioStatus, 'hard_constraint_unplanned')
  assert.equal(rows[0].portfolioStatusLabel, 'Non planifie - contrainte forte')
  assert.deepEqual(rows[0].mainReasonLabels, ['Capacite insuffisante'])
  assert.equal(rows[0].priorityRank, 1)
  assert.equal(rows[0].visitOrder, 2)
  assert.equal(rows[1].priorityRank, 2)
  assert.equal(rows[1].visitOrder, 1)
  assert.equal(rows[1].plannedDate, '2026-08-04')
  assert.equal(rows[1].dateSourceLabel, 'Date predite d achat')
  assert.equal(rows[1].portfolioStatus, 'due_now')
  assert.deepEqual(rows[1].mainReasonLabels, ['Aucun commercial compatible'])
  assert.equal(rows[3].predictionKnown, false)
  assert.equal(rows[3].visitOrder, null)
  assert.equal(Object.hasOwn(rows[0], 'recoveryPriorityScore'), false)
  assert.equal(rows[1].gpsAvailable, false)
})

test('expected value and high probability metrics keep partial data honest', () => {
  const expectedValueMetric = buildExpectedCaMetric({
    expected_ca_completeness_status: 'partial',
    predicted_ca_known_sum: 1174.4,
    predicted_ca_known_count: 290,
    predicted_ca_null_count: 167,
    selected_visits_count: 457
  })
  const predictionSummary = buildSalesPredictionSummary({
    summary: {
      selected_prediction_known_count: 290,
      selected_visits_count: 457,
      selected_prediction_coverage_rate: 63.5,
      expected_ca_completeness_status: 'partial',
      predicted_ca_known_sum: 1174.4,
      predicted_ca_known_count: 290,
      predicted_ca_null_count: 167
    }
  })
  const highProbabilityMetric = buildHighProbabilityMetric({
    high_probability_threshold: 50,
    high_probability_visits_count: 0,
    known_probability_count: 290,
    null_probability_count: 167
  })

  assert.equal(expectedValueMetric.label, 'Valeur attendue connue')
  assert.match(expectedValueMetric.valueLabel, /1.*174,4 TND/u)
  assert.equal(expectedValueMetric.detailLabel, 'Calcule sur 290 / 457 visites')
  assert.equal(predictionSummary.knownCount, 290)
  assert.equal(predictionSummary.totalVisits, 457)
  assert.equal(predictionSummary.coverageRate, 63.5)
  assert.equal(highProbabilityMetric.label, 'Visites a forte probabilite (>= 50 %)')
  assert.equal(highProbabilityMetric.valueLabel, '0')
  assert.equal(highProbabilityMetric.detailLabel, 'Probabilites connues : 290 / 457')
})

test('execution summary recomputes target and maximum capacity from the selected commercial count only', () => {
  const summary = buildSalesExecutionSummary(
    {
      summary: {
        selected_visits_count: 18
      },
      capacityPrecheck: {
        required_visits_count: 24,
        strict_capacity: 28,
        capacity_deficit: 0,
        feasibility_status: 'feasible'
      }
    },
    {
      period_days: '7',
      min_clients: '3',
      max_clients: '4'
    },
    ['1', 'VL1900']
  )

  assert.equal(summary.selectedCommercialsCount, 2)
  assert.equal(summary.horizonDays, 7)
  assert.equal(summary.targetCapacity, 42)
  assert.equal(summary.maximumCapacity, 56)
  assert.equal(summary.strictCapacity, 28)
})

test('execution summary uses portfolio feasibility returned by sales v2', () => {
  const planView = extractSalesPlanView({
    portfolio_feasibility: {
      required_visits_in_horizon: 65,
      selected_required_clients_count: 30,
      required_unplanned_clients_count: 35,
      target_capacity: 84,
      maximum_capacity: 112,
      capacity_deficit: 0,
      capacity_surplus: 47,
      recommended_minimum_horizon_days: null,
      feasibility_status: 'feasible'
    },
    summary: {
      selected_visits_count: 40,
      selected_unique_clients_count: 35,
      planning_horizon_days: 14
    },
    client_scope: {
      selected_commercial_codes_count: 2
    },
    blocks: []
  })

  const summary = buildSalesExecutionSummary(
    planView,
    {
      period_days: '14',
      min_clients: '1',
      max_clients: '1'
    },
    []
  )

  assert.equal(
    planView.portfolioFeasibility.required_visits_in_horizon,
    65
  )

  assert.equal(summary.selectedVisitsCount, 40)
  assert.equal(summary.selectedUniqueClientsCount, 35)

  assert.equal(summary.selectedRequiredClientsCount, 30)
  assert.equal(summary.requiredVisitsCount, 65)
  assert.equal(summary.planningGap, 35)
  assert.equal(summary.targetCapacity, 84)
  assert.equal(summary.maximumCapacity, 112)
  assert.equal(summary.strictCapacity, 112)
  assert.equal(summary.capacityDeficit, 0)
  assert.equal(summary.capacitySurplus, 47)
  assert.equal(summary.recommendedMinimumHorizonDays, null)
  assert.equal(summary.feasibilityStatus, 'feasible')
})

test('portfolio summary keeps every active client classified without residual bucket', () => {
  const summary = buildSalesPortfolioSummary({
    clientFinalDecisions: {
      a: { portfolio_status: 'due_now' },
      b: { portfolio_status: 'due_soon' },
      c: { portfolio_status: 'overdue' },
      d: { portfolio_status: 'not_due' },
      e: { portfolio_status: 'exploration_needed' },
      f: { portfolio_status: 'capacity_unplanned' },
      g: { portfolio_status: 'hard_constraint_unplanned' },
      h: { portfolio_status: 'invalid_data' }
    }
  })

  assert.equal(summary.activeClientsCount, 8)
  assert.deepEqual(summary.metrics.map(metric => metric.count), [1, 1, 1, 1, 1, 1, 1, 1])
  assert.equal(summary.metrics.some(metric => metric.key === 'other'), false)
})

test('changing OSRM visit order does not change the IA priority order', () => {
  const block = {
    clients: [
      {
        client_id: '10',
        client_code: '10',
        client_name: 'Top Priority',
        purchase_prediction_known: true,
        purchase_prediction_score: 64.6,
        predicted_purchase_date: '2026-08-03',
        expected_order_value: 500
      },
      {
        client_id: '20',
        client_code: '20',
        client_name: 'Lower Priority',
        purchase_prediction_known: true,
        purchase_prediction_score: 30.2,
        predicted_purchase_date: '2026-08-04',
        expected_order_value: 200
      }
    ]
  }

  const firstRouteRows = buildSalesClientRows(block, {
    orderedStops: [
      { client_id: '20', step: 1 },
      { client_id: '10', step: 2 }
    ]
  })
  const secondRouteRows = buildSalesClientRows(block, {
    orderedStops: [
      { client_id: '10', step: 1 },
      { client_id: '20', step: 2 }
    ]
  })

  assert.deepEqual(firstRouteRows.map(row => row.clientId), ['10', '20'])
  assert.deepEqual(secondRouteRows.map(row => row.clientId), ['10', '20'])
  assert.deepEqual(firstRouteRows.map(row => row.visitOrder), [2, 1])
  assert.deepEqual(secondRouteRows.map(row => row.visitOrder), [1, 2])
})

test('predicted products are aggregated and sorted by quantity descending', () => {
  const items = aggregateSalesLoadingPrediction({
    clients: [
      {
        predicted_products: [
          { name: 'BISKREMCACAO', quantity: 10 },
          { name: 'RANIFLOAT', quantity: 4 }
        ]
      },
      {
        predicted_products: [
          { name: 'BISKREMCACAO', quantity: 5 },
          { name: 'CHAMALLOWS', quantity: 2 }
        ]
      }
    ]
  })

  assert.deepEqual(items, {
    commercialCode: null,
    planningDate: null,
    products: [
      {
        productId: null,
        productCode: null,
        productLabel: 'BISKREMCACAO',
        estimatedNeed: 15,
        recommendedLoadQuantity: 15,
        predictionSource: null,
        confidenceOrSupport: null
      },
      {
        productId: null,
        productCode: null,
        productLabel: 'RANIFLOAT',
        estimatedNeed: 4,
        recommendedLoadQuantity: 4,
        predictionSource: null,
        confidenceOrSupport: null
      },
      {
        productId: null,
        productCode: null,
        productLabel: 'CHAMALLOWS',
        estimatedNeed: 2,
        recommendedLoadQuantity: 2,
        predictionSource: null,
        confidenceOrSupport: null
      }
    ],
    coverage: {
      plannedVisits: 2,
      visitsWithBasketPrediction: 2,
      basketPredictionCoveragePct: 100
    }
  })
})

test('gps stats and detail header keep clients without GPS visible and preserve unknown values', () => {
  const block = {
    date: '2026-08-03',
    commercial_label: 'Salah Ahmed (1)',
    clients_count: 2,
    predicted_order_value_total: null,
    purchase_prediction_known_count: 1,
    purchase_prediction_unknown_count: 1,
    min_daily_ca_target: 500,
    min_daily_ca_status: 'partial',
    estimated_duration_minutes: null,
    clients: [
      { latitude: 36.8, longitude: 10.1 },
      { latitude: null, longitude: null }
    ],
    time: {
      service_minutes_known_count: 0,
      service_minutes_total: null
    }
  }

  const gpsStats = computeSalesGpsStats(block.clients)
  const header = buildSalesDetailHeaderModel(block, { summary: null })

  assert.equal(gpsStats.total, 2)
  assert.equal(gpsStats.mapped, 1)
  assert.equal(gpsStats.unavailable, 1)
  assert.equal(header.predictedOrderLabel, 'Non disponible')
  assert.equal(header.minDailyCaStatus, 'partial')
  assert.match(header.predictionCoverageLabel, /1 avec prediction \/ 1 sans prediction/)
})

test('confidence formatter preserves null and expresses known percentages honestly', () => {
  assert.equal(formatSalesConfidencePercent(null), 'Non disponible')
  assert.equal(formatSalesConfidencePercent(0.82), '82,0 %')
  assert.equal(formatSalesConfidencePercent(64.6), '64,6 %')
})

test('prediction consistency matches block totals and keeps 00152 distinct from 152', () => {
  const block = {
    clients_count: 4,
    purchase_prediction_known_count: 3,
    purchase_prediction_unknown_count: 1,
    clients: [
      {
        client_id: '1',
        client_code: '00152',
        client_name: 'Client 00152',
        purchase_prediction_known: true,
        purchase_prediction_score: 64.6
      },
      {
        client_id: '2',
        client_code: '152',
        client_name: 'Client 152',
        purchase_prediction_known: true,
        purchase_prediction_score: 30.2
      },
      {
        client_id: '3',
        client_code: '00003',
        client_name: 'Client 00003',
        purchase_prediction_known: true,
        purchase_prediction_score: 27.1
      },
      {
        client_id: '4',
        client_code: '00004',
        client_name: 'Client 00004',
        purchase_prediction_known: false
      }
    ]
  }

  const rows = buildSalesClientRows(block, null)
  const consistency = buildSalesPredictionConsistency(block, rows)

  assert.equal(consistency.consistent, true)
  assert.equal(consistency.expectedKnown, 3)
  assert.equal(consistency.expectedUnknown, 1)
  assert.equal(consistency.expectedTotal, 4)
  assert.equal(consistency.knownRows, 3)
  assert.equal(consistency.unknownRows, 1)
  assert.notEqual(rows[0].clientCode, rows[1].clientCode)
})

test('visit feedback payload preserves exact client/commercial codes and null actual values', () => {
  const row = {
    plannedVisitId: 'sv2_visit_abc',
    assignedSlotId: '2026-08-10::VL1900',
    clientId: '3406',
    clientCode: '00959',
    commercialCode: 'VL1900',
    plannedDate: '2026-08-10',
    predictionSnapshot: {
      predicted_ca: 136.6,
      portfolio_status: 'due_now'
    }
  }

  const payload = buildSalesVisitFeedbackPayload(row, {
    executionStatus: 'visited',
    purchaseMade: 'true',
    actualCa: '',
    actualQuantity: '',
    note: 'Passe ce matin'
  })

  assert.equal(payload.client_code, '00959')
  assert.equal(payload.commercial_code, 'VL1900')
  assert.equal(payload.actual_ca, null)
  assert.equal(payload.actual_quantity, null)
  assert.equal(payload.prediction_snapshot.portfolio_status, 'due_now')
})

test('visit feedback items reload stored execution results correctly', () => {
  const rows = [
    {
      plannedVisitId: 'sv2_visit_1',
      clientId: '3406',
      clientCode: '00959',
      clientName: 'MOHAMED BOMBONIERE',
      commercialCode: 'VL1900',
      commercialLabel: 'VL1900',
      plannedDate: '2026-08-10',
      predictionSnapshot: {
        portfolio_status: 'due_now'
      }
    }
  ]
  const feedbackIndex = buildSalesVisitFeedbackRecordIndex([
    {
      planned_visit_id: 'sv2_visit_1',
      execution_status: 'visited',
      purchase_made: false,
      actual_ca: null,
      actual_quantity: null,
      note: 'Pas d achat',
      updated_at: '2026-08-10 09:05:00',
      prediction_snapshot: {
        portfolio_status: 'due_now'
      }
    }
  ])
  const items = buildSalesVisitFeedbackItems(rows, feedbackIndex)
  const draft = buildSalesVisitFeedbackDraft(rows[0], feedbackIndex.sv2_visit_1)

  assert.equal(items.length, 1)
  assert.equal(items[0].executionStatus, 'visited')
  assert.equal(items[0].executionStatusLabel, 'Visite effectuee')
  assert.equal(items[0].purchaseMade, false)
  assert.equal(items[0].note, 'Pas d achat')
  assert.equal(items[0].predictionSnapshot.portfolio_status, 'due_now')
  assert.equal(draft.purchaseMade, 'false')
  assert.equal(draft.actualCa, '')
  assert.equal(draft.actualQuantity, '')
})

test('visit feedback labels stay honest in the detail UI source', () => {
  const detailsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesTourDetails.jsx'),
    'utf8'
  )
  const panelSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesVisitFeedbackPanel.jsx'),
    'utf8'
  )

  assert.equal(detailsSource.includes('SalesVisitFeedbackPanel'), true)
  assert.equal(panelSource.includes('Resultat de la visite'), true)
  assert.equal(panelSource.includes('Visite effectuee'), true)
  assert.equal(panelSource.includes('Non visite'), true)
  assert.equal(panelSource.includes('Achat realise'), true)
  assert.equal(panelSource.includes('/api/tournees/next-best-visits/visit-feedback'), true)
  assert.equal(formatSalesVisitExecutionStatus('pending'), 'En attente')
})

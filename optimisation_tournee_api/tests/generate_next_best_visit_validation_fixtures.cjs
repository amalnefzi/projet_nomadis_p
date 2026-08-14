const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, 'fixtures', 'next_best_visit_validation')

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function addDays(dateString, deltaDays) {
  const date = new Date(`${dateString}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + deltaDays)
  return date.toISOString().slice(0, 10)
}

function client({
  id,
  code,
  name,
  commercial = 'C01',
  potentiel = 50,
  latitude = 36.8,
  longitude = 10.1
}) {
  return {
    client_id: String(id),
    client_code: String(code),
    nom: name,
    user_code: commercial,
    resolved_commercial_code: commercial,
    potentiel,
    latitude,
    longitude
  }
}

function salesSeries({ clientId, startDate, offsets = [], value = 120, quantity = 4, commercial = 'C01', stepValue = 0, stepQuantity = 0 }) {
  return offsets.map((offset, index) => ({
    client_id: String(clientId),
    purchase_date: addDays(startDate, offset),
    order_value: value + (stepValue * index),
    order_quantity: quantity + (stepQuantity * index),
    commercial_code: commercial
  }))
}

function prediction({ clientId, clientCode, date, probability = null, ca = null, quantity = null, confidence = null, score = null, vip = null, probabilityModelOnly = null, habitScore = null, recencyScore = null }) {
  return {
    client_id: String(clientId),
    client_code: String(clientCode),
    candidate_date: date,
    purchase_probability: probability,
    predicted_ca: ca,
    recommended_quantity: quantity,
    model_confidence: confidence,
    score,
    vip,
    probability_model_only: probabilityModelOnly,
    habit_score: habitScore,
    recency_score: recencyScore,
    prediction_source: 'fixture_prediction'
  }
}

function scenarioShell({
  scenario_id,
  planning_start_date = '2026-09-07',
  planning_horizon_days = 7,
  objective = 'balanced',
  maximum_visits_per_day = 2,
  minimum_confidence = 0,
  availability_mode = 'strict',
  max_days_without_contact = null,
  max_candidate_dates_per_client = 4,
  critical = true
}) {
  return {
    scenario_id,
    planning_start_date,
    historical_cutoff_date: planning_start_date,
    planning_horizon_days,
    objective,
    maximum_visits_per_day,
    minimum_confidence,
    availability_mode,
    max_days_without_contact,
    max_candidate_dates_per_client,
    critical
  }
}

function makeScenarioDefinitions() {
  const baseStart = '2026-09-07'
  const tuesdayStart = '2026-09-08'
  const longStart = '2026-09-07'

  const objectiveDataset = {
    clients: [
      client({ id: '301', code: 'OBJ_SALES', name: 'Sales Focus', potentiel: 34, latitude: 37.120, longitude: 10.760 }),
      client({ id: '302', code: 'OBJ_RISK', name: 'Risk Focus', potentiel: 72, latitude: 36.812, longitude: 10.182 }),
      client({ id: '303', code: 'OBJ_NEAR', name: 'Near Balanced', potentiel: 58, latitude: 36.811, longitude: 10.181 }),
      client({ id: '304', code: 'OBJ_VIP', name: 'Commercial Priority', potentiel: 100, latitude: 36.850, longitude: 10.230 })
    ],
    sales_history: [
      ...salesSeries({ clientId: '301', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 210, quantity: 8 }),
      ...salesSeries({ clientId: '302', startDate: baseStart, offsets: [-150, -120, -90, -60], value: 100, quantity: 3 }),
      ...salesSeries({ clientId: '303', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 190, quantity: 5 }),
      ...salesSeries({ clientId: '304', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 210, quantity: 5 })
    ],
    predictions: [
      prediction({ clientId: '301', clientCode: 'OBJ_SALES', date: '2026-09-07', probability: 86, ca: 300, quantity: 9, confidence: 84, score: 85, vip: 48 }),
      prediction({ clientId: '302', clientCode: 'OBJ_RISK', date: '2026-09-07', probability: 54, ca: 145, quantity: 4, confidence: 72, score: 60, vip: 64 }),
      prediction({ clientId: '303', clientCode: 'OBJ_NEAR', date: '2026-09-07', probability: 79, ca: 255, quantity: 6, confidence: 80, score: 80, vip: 58 }),
      prediction({ clientId: '304', clientCode: 'OBJ_VIP', date: '2026-09-07', probability: 80, ca: 285, quantity: 6, confidence: 81, score: 81, vip: 99 })
    ]
  }

  return [
    {
      scenario: scenarioShell({ scenario_id: 'frequent_customer', planning_horizon_days: 7, maximum_visits_per_day: 3 }),
      inputs: {
        clients: [
          client({ id: '1', code: 'FREQ_001', name: 'Client Frequent', potentiel: 78 }),
          client({ id: '2', code: 'FREQ_002', name: 'Client Nearby', potentiel: 40, latitude: 36.801, longitude: 10.101 })
        ],
        sales_history: [
          ...salesSeries({ clientId: '1', startDate: baseStart, offsets: [-18, -14, -11, -7, -4], value: 210, quantity: 6 }),
          ...salesSeries({ clientId: '2', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 90, quantity: 2 })
        ],
        visits_history: [],
        predictions: [
          prediction({ clientId: '1', clientCode: 'FREQ_001', date: '2026-09-07', probability: 84, ca: 320, quantity: 6, confidence: 88, score: 86, vip: 70 }),
          prediction({ clientId: '1', clientCode: 'FREQ_001', date: '2026-09-10', probability: 79, ca: 310, quantity: 5, confidence: 87, score: 83, vip: 70 }),
          prediction({ clientId: '2', clientCode: 'FREQ_002', date: '2026-09-07', probability: 35, ca: 80, quantity: 2, confidence: 55, score: 40, vip: 38 })
        ],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 2, '2026-09-10': 2 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['FREQ_001'],
        allowed_dates_by_client: { FREQ_001: ['2026-09-07', '2026-09-10'] },
        minimum_occurrences_in_horizon: { FREQ_001: 2 },
        maximum_occurrences_per_day: { FREQ_001: 1 },
        expected_decision_mode: { FREQ_001: 'predictive' },
        required_reason_codes: { FREQ_001: ['HIGH_PURCHASE_PROBABILITY'] }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'weekly_customer', maximum_visits_per_day: 2 }),
      inputs: {
        clients: [client({ id: '11', code: 'WEEK_001', name: 'Client Weekly', potentiel: 62 })],
        sales_history: salesSeries({ clientId: '11', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 180, quantity: 5 }),
        visits_history: [],
        predictions: [prediction({ clientId: '11', clientCode: 'WEEK_001', date: '2026-09-07', probability: 78, ca: 240, quantity: 5, confidence: 81, score: 79, vip: 60 })],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 2 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['WEEK_001'],
        maximum_occurrences_in_horizon: { WEEK_001: 1 },
        expected_decision_mode: { WEEK_001: 'predictive' }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'monthly_customer', maximum_visits_per_day: 2 }),
      inputs: {
        clients: [client({ id: '21', code: 'MONTH_001', name: 'Client Monthly', potentiel: 48 })],
        sales_history: salesSeries({ clientId: '21', startDate: baseStart, offsets: [-96, -65, -34, -6], value: 260, quantity: 7 }),
        visits_history: [],
        predictions: [],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'], unavailable_dates: [] } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_not_select_clients: ['MONTH_001'],
        maximum_occurrences_in_horizon: { MONTH_001: 0 }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'recent_purchase', planning_start_date: tuesdayStart, planning_horizon_days: 2, maximum_visits_per_day: 1, max_days_without_contact: 1 }),
      inputs: {
        clients: [
          client({ id: '31', code: 'RECENT_001', name: 'Recent VIP', potentiel: 92 }),
          client({ id: '32', code: 'RECENT_002', name: 'Strong Buyer', potentiel: 58, latitude: 36.801, longitude: 10.101 })
        ],
        sales_history: [
          ...salesSeries({ clientId: '31', startDate: tuesdayStart, offsets: [-29, -22, -15, -1], value: 220, quantity: 5 }),
          ...salesSeries({ clientId: '32', startDate: tuesdayStart, offsets: [-28, -21, -14, -7], value: 280, quantity: 7 })
        ],
        visits_history: [],
        predictions: [
          prediction({ clientId: '31', clientCode: 'RECENT_001', date: '2026-09-08', probability: 22, ca: 70, quantity: 2, confidence: 69, score: 38, vip: 96 }),
          prediction({ clientId: '32', clientCode: 'RECENT_002', date: '2026-09-08', probability: 88, ca: 360, quantity: 8, confidence: 85, score: 90, vip: 64 })
        ],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-08', '2026-09-09'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-08': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['RECENT_002'],
        must_not_select_clients: ['RECENT_001'],
        required_reason_codes: { RECENT_001: ['RECENT_PURCHASE_DEPRIORITIZED'] },
        relative_ranking: [['RECENT_002', 'RECENT_001']]
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'growth_customer', maximum_visits_per_day: 1 }),
      inputs: {
        clients: [client({ id: '41', code: 'GROW_001', name: 'Growing Client', potentiel: 66 })],
        sales_history: [
          ...salesSeries({ clientId: '41', startDate: baseStart, offsets: [-120, -95], value: 90, quantity: 2 }),
          ...salesSeries({ clientId: '41', startDate: baseStart, offsets: [-40, -26, -15, -7], value: 150, quantity: 5, stepValue: 35, stepQuantity: 1 })
        ],
        visits_history: [],
        predictions: [prediction({ clientId: '41', clientCode: 'GROW_001', date: '2026-09-08', probability: 83, ca: 340, quantity: 7, confidence: 84, score: 84, vip: 67 })],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-08': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['GROW_001'],
        expected_known_fields: { GROW_001: ['customer_activity_trend', 'recommended_visit_interval_days'] },
        expected_decision_mode: { GROW_001: 'predictive' }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'declining_customer_balanced', maximum_visits_per_day: 1, objective: 'balanced' }),
      inputs: {
        clients: [client({ id: '51', code: 'DECLINE_001', name: 'Declining Client', potentiel: 52 })],
        sales_history: [
          ...salesSeries({ clientId: '51', startDate: baseStart, offsets: [-30, -21, -12], value: 220, quantity: 5 }),
          ...salesSeries({ clientId: '51', startDate: baseStart, offsets: [-150, -130, -110, -90], value: 260, quantity: 6 })
        ],
        visits_history: [],
        predictions: [prediction({ clientId: '51', clientCode: 'DECLINE_001', date: '2026-09-09', probability: 44, ca: 120, quantity: 3, confidence: 68, score: 52, vip: 54 })],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'], unavailable_dates: [] } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        expected_known_fields: { DECLINE_001: ['inactivity_risk'] },
        expected_decision_mode: { DECLINE_001: 'predictive' }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'declining_customer_reactivate', maximum_visits_per_day: 1, objective: 'reactivate_at_risk', max_days_without_contact: 15 }),
      inputs: {
        clients: [client({ id: '61', code: 'DECLINE_002', name: 'Declining Reactivate', potentiel: 52 })],
        sales_history: [
          ...salesSeries({ clientId: '61', startDate: baseStart, offsets: [-150, -120, -90, -60, -15], value: 200, quantity: 4 })
        ],
        visits_history: [],
        predictions: [prediction({ clientId: '61', clientCode: 'DECLINE_002', date: '2026-09-07', probability: 58, ca: 150, quantity: 4, confidence: 66, score: 61, vip: 52 })],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07', '2026-09-08', '2026-09-09'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['DECLINE_002'],
        expected_known_fields: { DECLINE_002: ['inactivity_risk'] }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'vip_high_low_probability', maximum_visits_per_day: 1 }),
      inputs: {
        clients: [
          client({ id: '71', code: 'VIP_LOW', name: 'VIP Low Today', potentiel: 95, latitude: 36.90, longitude: 10.40 }),
          client({ id: '72', code: 'SALE_HIGH', name: 'Sale High Today', potentiel: 55, latitude: 36.80, longitude: 10.11 })
        ],
        sales_history: [
          ...salesSeries({ clientId: '71', startDate: baseStart, offsets: [-30, -20, -10, -1], value: 180, quantity: 4 }),
          ...salesSeries({ clientId: '72', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 240, quantity: 7 })
        ],
        visits_history: [],
        predictions: [
          prediction({ clientId: '71', clientCode: 'VIP_LOW', date: '2026-09-07', probability: 18, ca: 70, quantity: 2, confidence: 71, score: 35, vip: 96 }),
          prediction({ clientId: '72', clientCode: 'SALE_HIGH', date: '2026-09-07', probability: 87, ca: 360, quantity: 8, confidence: 84, score: 89, vip: 60 })
        ],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['SALE_HIGH'],
        must_not_select_clients: ['VIP_LOW'],
        relative_ranking: [['SALE_HIGH', 'VIP_LOW']]
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'probability_beats_vip', maximum_visits_per_day: 1, objective: 'maximize_sales' }),
      inputs: {
        clients: [
          client({ id: '81', code: 'VIP_MID', name: 'VIP Mid', potentiel: 58 }),
          client({ id: '82', code: 'PROB_HIGH', name: 'Probability High', potentiel: 48, latitude: 36.801, longitude: 10.101 })
        ],
        sales_history: [
          ...salesSeries({ clientId: '81', startDate: baseStart, offsets: [-35, -28, -21, -14], value: 130, quantity: 3 }),
          ...salesSeries({ clientId: '82', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 300, quantity: 9 })
        ],
        visits_history: [],
        predictions: [
          prediction({ clientId: '81', clientCode: 'VIP_MID', date: '2026-09-07', probability: 52, ca: 140, quantity: 3, confidence: 70, score: 56, vip: 58 }),
          prediction({ clientId: '82', clientCode: 'PROB_HIGH', date: '2026-09-07', probability: 89, ca: 390, quantity: 9, confidence: 86, score: 91, vip: 52 })
        ],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['PROB_HIGH'],
        relative_ranking: [['PROB_HIGH', 'VIP_MID']]
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'low_value_far', maximum_visits_per_day: 1 }),
      inputs: {
        clients: [
          client({ id: '91', code: 'FAR_LOW', name: 'Far Low', potentiel: 25, latitude: 37.20, longitude: 10.85 }),
          client({ id: '92', code: 'NEAR_OK', name: 'Near High', potentiel: 60, latitude: 36.802, longitude: 10.102 })
        ],
        sales_history: [
          ...salesSeries({ clientId: '91', startDate: baseStart, offsets: [-28, -14], value: 50, quantity: 1 }),
          ...salesSeries({ clientId: '92', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 240, quantity: 7 })
        ],
        visits_history: [],
        predictions: [
          prediction({ clientId: '91', clientCode: 'FAR_LOW', date: '2026-09-07', probability: 16, ca: 40, quantity: 1, confidence: 52, score: 22, vip: 28 }),
          prediction({ clientId: '92', clientCode: 'NEAR_OK', date: '2026-09-07', probability: 76, ca: 260, quantity: 6, confidence: 78, score: 77, vip: 54 })
        ],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['NEAR_OK'],
        must_not_select_clients: ['FAR_LOW'],
        forbidden_reason_codes: { FAR_LOW: ['HIGH_EXPECTED_CA'] }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'geographic_synergy', maximum_visits_per_day: 3 }),
      inputs: {
        clients: [
          client({ id: '101', code: 'CLUSTER_A', name: 'Cluster A', potentiel: 72, latitude: 36.810, longitude: 10.180 }),
          client({ id: '102', code: 'CLUSTER_B', name: 'Cluster B', potentiel: 68, latitude: 36.812, longitude: 10.182 }),
          client({ id: '103', code: 'CLUSTER_C', name: 'Cluster C', potentiel: 46, latitude: 36.811, longitude: 10.181 }),
          client({ id: '104', code: 'FAR_MED', name: 'Far Medium', potentiel: 46, latitude: 36.980, longitude: 10.480 })
        ],
        sales_history: [
          ...salesSeries({ clientId: '101', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 260, quantity: 7 }),
          ...salesSeries({ clientId: '102', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 255, quantity: 7 }),
          ...salesSeries({ clientId: '103', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 150, quantity: 4 }),
          ...salesSeries({ clientId: '104', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 145, quantity: 4 })
        ],
        visits_history: [],
        predictions: [
          prediction({ clientId: '101', clientCode: 'CLUSTER_A', date: '2026-09-07', probability: 86, ca: 320, quantity: 7, confidence: 84, score: 86, vip: 70 }),
          prediction({ clientId: '102', clientCode: 'CLUSTER_B', date: '2026-09-07', probability: 84, ca: 315, quantity: 7, confidence: 84, score: 84, vip: 68 }),
          prediction({ clientId: '103', clientCode: 'CLUSTER_C', date: '2026-09-07', probability: 54, ca: 150, quantity: 4, confidence: 74, score: 58, vip: 44 }),
          prediction({ clientId: '104', clientCode: 'FAR_MED', date: '2026-09-07', probability: 55, ca: 150, quantity: 4, confidence: 74, score: 57, vip: 44 })
        ],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 3 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['CLUSTER_A', 'CLUSTER_B', 'CLUSTER_C'],
        must_not_select_clients: ['FAR_MED']
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'no_history_exploration', maximum_visits_per_day: 1 }),
      inputs: {
        clients: [client({ id: '111', code: 'NEW_001', name: 'New Prospect', potentiel: 30 })],
        sales_history: [],
        visits_history: [],
        predictions: [],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07', '2026-09-08'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['NEW_001'],
        expected_decision_mode: { NEW_001: 'exploration' },
        expected_null_fields: { NEW_001: ['purchase_probability', 'predicted_ca', 'recommended_quantity'] },
        required_reason_codes: { NEW_001: ['EXPLORATION_VISIT'] }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'low_history_hybrid', maximum_visits_per_day: 1, max_days_without_contact: 14 }),
      inputs: {
        clients: [client({ id: '121', code: 'LIGHT_001', name: 'Light History', potentiel: 42 })],
        sales_history: salesSeries({ clientId: '121', startDate: baseStart, offsets: [-14], value: 140, quantity: 3 }),
        visits_history: [],
        predictions: [prediction({ clientId: '121', clientCode: 'LIGHT_001', date: '2026-09-07', probability: 61, ca: 180, quantity: 3, confidence: 58, score: 60, vip: 45 })],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['LIGHT_001'],
        expected_decision_mode: { LIGHT_001: 'hybrid' },
        expected_confidence_range: { LIGHT_001: { min: 10, max: 25 } }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'estimated_availability', maximum_visits_per_day: 1 }),
      inputs: {
        clients: [client({ id: '131', code: 'EST_001', name: 'Estimated Available', potentiel: 50 })],
        sales_history: salesSeries({ clientId: '131', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 180, quantity: 5 }),
        visits_history: [],
        predictions: [prediction({ clientId: '131', clientCode: 'EST_001', date: '2026-09-07', probability: 72, ca: 210, quantity: 5, confidence: 77, score: 74, vip: 50 })],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['EST_001'],
        expected_known_fields: { EST_001: ['availability_status'] },
        forbidden_reason_codes: { EST_001: ['EXPLICITLY_AVAILABLE'] }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'explicit_unavailable_strict', planning_start_date: tuesdayStart, planning_horizon_days: 3, maximum_visits_per_day: 1, availability_mode: 'strict', max_days_without_contact: 8 }),
      inputs: {
        clients: [client({ id: '141', code: 'UNAV_STRICT', name: 'Unavailable Tuesday', potentiel: 60 })],
        sales_history: salesSeries({ clientId: '141', startDate: tuesdayStart, offsets: [-28, -21, -14, -7], value: 210, quantity: 6 }),
        visits_history: [],
        predictions: [
          prediction({ clientId: '141', clientCode: 'UNAV_STRICT', date: '2026-09-08', probability: 88, ca: 310, quantity: 6, confidence: 85, score: 88, vip: 66 }),
          prediction({ clientId: '141', clientCode: 'UNAV_STRICT', date: '2026-09-09', probability: 74, ca: 250, quantity: 5, confidence: 78, score: 76, vip: 66 })
        ],
        availability: [{ client_id: '141', client_code: 'UNAV_STRICT', date: '2026-09-08', status: 'explicit_unavailable', source: 'fixture_availability' }],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-08', '2026-09-09', '2026-09-10'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-09': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['UNAV_STRICT'],
        allowed_dates_by_client: { UNAV_STRICT: ['2026-09-09'] },
        forbidden_dates_by_client: { UNAV_STRICT: ['2026-09-08'] }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'explicit_unavailable_flexible', planning_start_date: tuesdayStart, planning_horizon_days: 2, maximum_visits_per_day: 1, availability_mode: 'flexible' }),
      inputs: {
        clients: [client({ id: '151', code: 'UNAV_FLEX', name: 'Unavailable Flexible', potentiel: 60 })],
        sales_history: salesSeries({ clientId: '151', startDate: tuesdayStart, offsets: [-28, -21, -14, -7], value: 210, quantity: 6 }),
        visits_history: [],
        predictions: [prediction({ clientId: '151', clientCode: 'UNAV_FLEX', date: '2026-09-08', probability: 88, ca: 310, quantity: 6, confidence: 85, score: 88, vip: 66 })],
        availability: [{ client_id: '151', client_code: 'UNAV_FLEX', date: '2026-09-08', status: 'explicit_unavailable', source: 'fixture_availability' }],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-08', '2026-09-09'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-08': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['UNAV_FLEX'],
        allowed_dates_by_client: { UNAV_FLEX: ['2026-09-08'] },
        expected_warning_codes: ['FLEXIBLE_EXPLICIT_UNAVAILABLE_SELECTED']
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'exact_code_identity', maximum_visits_per_day: 2, max_days_without_contact: 7 }),
      inputs: {
        clients: [
          client({ id: '161', code: '00152', name: 'Zero Padded', potentiel: 60 }),
          client({ id: '162', code: '152', name: 'No Padding', potentiel: 40, latitude: 36.802, longitude: 10.102 })
        ],
        sales_history: [
          ...salesSeries({ clientId: '161', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 220, quantity: 5 }),
          ...salesSeries({ clientId: '162', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 140, quantity: 3 })
        ],
        visits_history: [],
        predictions: [
          prediction({ clientId: '161', clientCode: '00152', date: '2026-09-07', probability: 80, ca: 250, quantity: 5, confidence: 82, score: 81, vip: 60 }),
          prediction({ clientId: '162', clientCode: '152', date: '2026-09-07', probability: 62, ca: 170, quantity: 3, confidence: 66, score: 63, vip: 42 })
        ],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 2 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['00152', '152'],
        relative_ranking: [['00152', '152']]
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'null_preservation', maximum_visits_per_day: 1 }),
      inputs: {
        clients: [client({ id: '171', code: 'NULL_001', name: 'Null Client', potentiel: 20 })],
        sales_history: salesSeries({ clientId: '171', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 100, quantity: 3 }),
        visits_history: [],
        predictions: [prediction({ clientId: '171', clientCode: 'NULL_001', date: '2026-09-07', probability: null, ca: null, quantity: null, confidence: null, score: null, vip: 20 })],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['NULL_001'],
        expected_null_fields: { NULL_001: ['purchase_probability', 'predicted_ca', 'recommended_quantity'] },
        forbidden_reason_codes: { NULL_001: ['HIGH_EXPECTED_CA', 'HIGH_PURCHASE_PROBABILITY'] }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'capacity_competition', maximum_visits_per_day: 2 }),
      inputs: {
        clients: [
          client({ id: '181', code: 'CAP_A', name: 'Capacity A', potentiel: 72 }),
          client({ id: '182', code: 'CAP_B', name: 'Capacity B', potentiel: 68, latitude: 36.801, longitude: 10.101 }),
          client({ id: '183', code: 'CAP_C', name: 'Capacity C', potentiel: 54, latitude: 36.802, longitude: 10.102 })
        ],
        sales_history: [
          ...salesSeries({ clientId: '181', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 260, quantity: 7 }),
          ...salesSeries({ clientId: '182', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 240, quantity: 6 }),
          ...salesSeries({ clientId: '183', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 120, quantity: 3 })
        ],
        visits_history: [],
        predictions: [
          prediction({ clientId: '181', clientCode: 'CAP_A', date: '2026-09-07', probability: 86, ca: 330, quantity: 7, confidence: 84, score: 87, vip: 68 }),
          prediction({ clientId: '182', clientCode: 'CAP_B', date: '2026-09-07', probability: 81, ca: 290, quantity: 6, confidence: 81, score: 82, vip: 62 }),
          prediction({ clientId: '183', clientCode: 'CAP_C', date: '2026-09-07', probability: 49, ca: 130, quantity: 3, confidence: 66, score: 50, vip: 48 })
        ],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 2 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['CAP_A', 'CAP_B'],
        must_not_select_clients: ['CAP_C'],
        required_reason_codes: { CAP_C: ['CAPACITY_REACHED'] }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'repeat_visits_long_horizon', planning_horizon_days: 14, maximum_visits_per_day: 2, max_days_without_contact: 10 }),
      inputs: {
        clients: [client({ id: '191', code: 'REPEAT_001', name: 'Repeat Client', potentiel: 74 })],
        sales_history: salesSeries({ clientId: '191', startDate: longStart, offsets: [-18, -14, -11, -7, -4], value: 220, quantity: 5 }),
        visits_history: [],
        predictions: [
          prediction({ clientId: '191', clientCode: 'REPEAT_001', date: '2026-09-07', probability: 84, ca: 300, quantity: 5, confidence: 84, score: 84, vip: 66 }),
          prediction({ clientId: '191', clientCode: 'REPEAT_001', date: '2026-09-10', probability: 80, ca: 290, quantity: 5, confidence: 82, score: 80, vip: 66 }),
          prediction({ clientId: '191', clientCode: 'REPEAT_001', date: '2026-09-14', probability: 77, ca: 280, quantity: 4, confidence: 81, score: 78, vip: 66 }),
          prediction({ clientId: '191', clientCode: 'REPEAT_001', date: '2026-09-17', probability: 74, ca: 270, quantity: 4, confidence: 80, score: 75, vip: 66 })
        ],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1, '2026-09-10': 1, '2026-09-14': 1, '2026-09-17': 1 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['REPEAT_001'],
        maximum_occurrences_per_day: { REPEAT_001: 1 },
        minimum_occurrences_in_horizon: { REPEAT_001: 3 }
      }
    },
    {
      scenario: scenarioShell({ scenario_id: 'objective_balanced', maximum_visits_per_day: 1, objective: 'balanced', max_days_without_contact: 60 }),
      inputs: { ...objectiveDataset, visits_history: [], availability: [], commercials: [{ value: 'C01', label: 'Commercial C01' }], commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} }, shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' } },
      expected: { must_select_clients: ['OBJ_NEAR'] }
    },
    {
      scenario: scenarioShell({ scenario_id: 'objective_maximize_sales', maximum_visits_per_day: 1, objective: 'maximize_sales', max_days_without_contact: 60 }),
      inputs: { ...objectiveDataset, visits_history: [], availability: [], commercials: [{ value: 'C01', label: 'Commercial C01' }], commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} }, shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' } },
      expected: { must_select_clients: ['OBJ_SALES'] }
    },
    {
      scenario: scenarioShell({ scenario_id: 'objective_reactivate_at_risk', maximum_visits_per_day: 1, objective: 'reactivate_at_risk', max_days_without_contact: 60 }),
      inputs: { ...objectiveDataset, visits_history: [], availability: [], commercials: [{ value: 'C01', label: 'Commercial C01' }], commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} }, shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' } },
      expected: { must_select_clients: ['OBJ_RISK'] }
    },
    {
      scenario: scenarioShell({ scenario_id: 'objective_commercial_priority', maximum_visits_per_day: 1, objective: 'commercial_priority', max_days_without_contact: 60 }),
      inputs: { ...objectiveDataset, visits_history: [], availability: [], commercials: [{ value: 'C01', label: 'Commercial C01' }], commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 1 } } }, client_restrictions: {} }, shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' } },
      expected: { must_select_clients: ['OBJ_VIP'] }
    },
    {
      scenario: scenarioShell({ scenario_id: 'determinism_repeatable', maximum_visits_per_day: 2 }),
      inputs: {
        clients: [
          client({ id: '201', code: 'DET_A', name: 'Deterministic A', potentiel: 58 }),
          client({ id: '202', code: 'DET_B', name: 'Deterministic B', potentiel: 56, latitude: 36.801, longitude: 10.101 })
        ],
        sales_history: [
          ...salesSeries({ clientId: '201', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 180, quantity: 4 }),
          ...salesSeries({ clientId: '202', startDate: baseStart, offsets: [-28, -21, -14, -7], value: 170, quantity: 4 })
        ],
        visits_history: [],
        predictions: [
          prediction({ clientId: '201', clientCode: 'DET_A', date: '2026-09-07', probability: 71, ca: 210, quantity: 4, confidence: 77, score: 72, vip: 57 }),
          prediction({ clientId: '202', clientCode: 'DET_B', date: '2026-09-07', probability: 68, ca: 205, quantity: 4, confidence: 77, score: 69, vip: 56 })
        ],
        availability: [],
        commercials: [{ value: 'C01', label: 'Commercial C01' }],
        commercial_constraints: { commercials: { C01: { available_dates: ['2026-09-07'], unavailable_dates: [], hard_max_visits_by_date: { '2026-09-07': 2 } } }, client_restrictions: {} },
        shared_depot_origin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot lab' }
      },
      expected: {
        must_select_clients: ['DET_A', 'DET_B'],
        relative_ranking: [['DET_A', 'DET_B']]
      }
    }
  ]
}

function writeScenario(definition) {
  const scenarioId = definition.scenario.scenario_id
  const scenarioDir = path.join(ROOT, scenarioId)
  ensureDir(scenarioDir)
  writeJson(path.join(scenarioDir, 'scenario.json'), definition.scenario)
  writeJson(path.join(scenarioDir, 'inputs.json'), definition.inputs)
  writeJson(path.join(scenarioDir, 'expected_result.json'), definition.expected)
}

function main() {
  ensureDir(ROOT)
  makeScenarioDefinitions().forEach(writeScenario)
  process.stdout.write(`Generated fixtures in ${ROOT}\n`)
}

main()

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  generateNextBestVisitPlan,
  __testables: serviceTestables
} = require('../next_best_visit_service')

function makeClient(clientId, clientCode, overrides = {}) {
  return {
    client_id: String(clientId),
    client_code: String(clientCode),
    nom: `Client ${clientCode}`,
    user_code: 'C01',
    resolved_commercial_code: 'C01',
    latitude: 36.8,
    longitude: 10.1,
    potentiel: 80,
    ...overrides
  }
}

function makeCadenceProfile(clientId, clientCode, date = '2026-08-04') {
  return {
    client_id: String(clientId),
    client_code: String(clientCode),
    recommended_visit_interval_days: 7,
    next_purchase_date_estimate: date,
    next_purchase_window_start: date,
    next_purchase_window_end: date,
    cadence_confidence: 0.8,
    usual_purchase_weekdays: [],
    inactivity_risk: 'medium',
    history_depth: 4
  }
}

function buildPredictionCacheQueryMock() {
  const storedRows = new Map()
  const calls = []

  async function queryAsync(sql, params = []) {
    const normalizedSql = String(sql || '').replace(/\s+/g, ' ').trim()
    calls.push({ sql: normalizedSql, params: [...params] })

    if (normalizedSql.startsWith('CREATE TABLE IF NOT EXISTS next_best_visit_prediction_cache')) {
      return []
    }

    if (normalizedSql.startsWith('SELECT client_id, client_code, target_date')) {
      const [targetDate, modelVersion, featuresVersion, sourceDataVersion, ...rest] = params
      const half = Math.floor(rest.length / 2)
      const clientIds = new Set(rest.slice(0, half).map(value => String(value)))
      const clientCodes = new Set(rest.slice(half).map(value => String(value)))
      return [...storedRows.values()]
        .filter(row => (
          row.target_date === targetDate &&
          row.model_version === modelVersion &&
          row.features_version === featuresVersion &&
          row.source_data_version === sourceDataVersion &&
          clientIds.has(String(row.client_id)) &&
          clientCodes.has(String(row.client_code))
        ))
        .map(row => ({
          ...row,
          target_date: new Date(`${row.target_date}T00:00:00.000Z`)
        }))
    }

    if (normalizedSql.startsWith('INSERT INTO next_best_visit_prediction_cache')) {
      const chunkSize = 21
      for (let index = 0; index < params.length; index += chunkSize) {
        const row = params.slice(index, index + chunkSize)
        const record = {
          client_id: String(row[0]),
          client_code: String(row[1]),
          target_date: String(row[2]),
          model_version: String(row[3]),
          features_version: String(row[4]),
          source_data_version: String(row[5]),
          purchase_probability: row[6],
          predicted_ca: row[7],
          recommended_quantity: row[8],
          model_confidence: row[9],
          score: row[10],
          vip: row[11],
          predicted_ca_if_buy: row[12],
          predicted_quantity_if_buy: row[13],
          probability_model_only: row[14],
          habit_score: row[15],
          recency_score: row[16],
          prediction_source: row[17],
          prediction_payload_json: row[18],
          python_meta_json: row[19],
          computed_at: row[20]
        }
        const key = `${record.client_id}::${record.client_code}::${record.target_date}::${record.model_version}::${record.features_version}::${record.source_data_version}`
        storedRows.set(key, record)
      }
      return []
    }

    if (normalizedSql.startsWith('SELECT COUNT(*) AS entries_count')) {
      return [{
        entries_count: storedRows.size,
        model_version: null,
        features_version: null,
        latest_updated_at: null
      }]
    }

    return []
  }

  return {
    queryAsync,
    storedRows,
    calls
  }
}

test('snapshot missing returns an explicit status and does not call predictions', async () => {
  let predictionCalls = 0

  const payload = await generateNextBestVisitPlan({
    start_date: '2026-08-04',
    planning_horizon_days: 7,
    commercial_codes: ['C01']
  }, {
    fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial C01' }],
    fetchCoverageActiveClients: async () => ({
      clients: [makeClient('1', '00152')]
    }),
    loadCoverageConstraints: async () => ({
      commercials: {
        C01: {
          available_dates: ['2026-08-04'],
          unavailable_dates: [],
          hard_max_visits_by_date: {
            '2026-08-04': 2
          }
        }
      },
      client_restrictions: {}
    }),
    fetchAiPredictionsForClientBatch: async () => {
      predictionCalls += 1
      return { status: 'success', predictions: [], meta: {} }
    },
    loadProfileSnapshot: async () => ({
      status: 'missing',
      required_profile_version: 'profile-v1',
      active_profile_version: null,
      source_fingerprint: {
        source_data_version: 'source-v1'
      },
      snapshot: null,
      rebuild_status: 'missing',
      latest_error_message: null
    })
  })

  assert.equal(payload.status, 'missing')
  assert.equal(payload.summary.profile_snapshot_status, 'missing')
  assert.equal(predictionCalls, 0)
  assert.match(payload.message, /Preparation des profils clients en cours/i)
})

test('snapshot stale returns an explicit status and is not used silently', async () => {
  const payload = await generateNextBestVisitPlan({
    start_date: '2026-08-04',
    planning_horizon_days: 7,
    commercial_codes: ['C01']
  }, {
    fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial C01' }],
    fetchCoverageActiveClients: async () => ({
      clients: [makeClient('1', '00152')]
    }),
    loadCoverageConstraints: async () => ({
      commercials: {
        C01: {
          available_dates: ['2026-08-04'],
          unavailable_dates: [],
          hard_max_visits_by_date: {
            '2026-08-04': 2
          }
        }
      },
      client_restrictions: {}
    }),
    loadProfileSnapshot: async () => ({
      status: 'stale',
      required_profile_version: 'profile-required',
      active_profile_version: 'profile-old',
      source_fingerprint: {
        source_data_version: 'source-v2'
      },
      snapshot: {
        computed_at: '2026-08-04T08:00:00.000Z',
        clients_count: 1
      },
      rebuild_status: 'ready',
      latest_error_message: null
    })
  })

  assert.equal(payload.status, 'stale')
  assert.equal(payload.summary.profile_snapshot_status, 'stale')
  assert.equal(payload.profile_snapshot.required_version, 'profile-required')
  assert.match(payload.message, /Preparation des profils clients/i)
})

test('prediction cache keeps one exact entry per client/date and only misses call Python', async () => {
  const cacheMock = buildPredictionCacheQueryMock()
  let pythonCalls = 0

  const resolver = serviceTestables.buildCachedBatchPredictionResolver({
    queryAsync: cacheMock.queryAsync,
    perfTracker: {
      async run(_stage, fn) {
        return fn()
      }
    },
    modelVersion: 'model-v1',
    featuresVersion: 'features-v1',
    sourceDataVersion: 'source-v1',
    fetchAiPredictionsForClientBatch: async ({ targetDate, clientCodes }) => {
      pythonCalls += 1
      return {
        status: 'success',
        predictions: clientCodes.map(clientCode => (
          clientCode === '00152'
            ? {
                client_id: '10',
                client_code: clientCode,
                purchase_probability: 82,
                predicted_ca: 340,
                recommended_quantity: 4,
                model_confidence: 84,
                score: 86,
                vip: 88,
                probability_model_only: 80,
                habit_score: 70,
                recency_score: 68,
                prediction_source: `batch_${targetDate}`
              }
            : {
                client_id: '11',
                client_code: clientCode,
                purchase_probability: null,
                predicted_ca: null,
                recommended_quantity: null,
                model_confidence: null,
                score: null,
                vip: null,
                probability_model_only: null,
                habit_score: null,
                recency_score: null,
                prediction_source: `batch_${targetDate}`
              }
        )),
        meta: {
          prediction_requested_clients_count: clientCodes.length,
          prediction_returned_clients_count: clientCodes.length,
          prediction_known_count: 1,
          prediction_null_count: 1,
          batch_total_ms: 123.4,
          model_load_ms: 0,
          feature_lookup_ms: 45.6,
          prediction_compute_ms: 67.8,
          serialization_ms: 2.3
        }
      }
    }
  })

  const requestedClients = [
    { client_id: '10', client_code: '00152' },
    { client_id: '11', client_code: '152' }
  ]

  const firstPayload = await resolver({
    targetDate: '2026-08-04',
    clientCodes: requestedClients.map(item => item.client_code),
    requestedClients
  })
  const secondPayload = await resolver({
    targetDate: '2026-08-04',
    clientCodes: requestedClients.map(item => item.client_code),
    requestedClients
  })

  assert.equal(firstPayload.predictions.length, 2)
  assert.equal(firstPayload.meta.prediction_cache_hit_count, 0)
  assert.equal(firstPayload.meta.prediction_cache_miss_count, 2)
  assert.equal(firstPayload.meta.python_requested_count, 2)
  assert.equal(secondPayload.meta.prediction_cache_hit_count, 2)
  assert.equal(secondPayload.meta.prediction_cache_miss_count, 0)
  assert.equal(secondPayload.meta.python_requested_count, 0)
  assert.equal(pythonCalls, 1)
  assert.equal(firstPayload.predictions[0].client_code, '00152')
  assert.equal(firstPayload.predictions[1].client_code, '152')
  assert.equal(firstPayload.predictions[1].purchase_probability, null)
  assert.equal(cacheMock.storedRows.size, 2)
})

test('plan cache invalidates when profile version changes even if inputs stay the same', async () => {
  let snapshotVersion = 'profile-v1'

  const baseDependencies = {
    queryAsync: async () => [],
    fetchCommercialOptions: async () => [{ value: 'C01', label: 'Commercial C01' }],
    fetchCoverageActiveClients: async () => ({
      clients: [makeClient('1', '00152')]
    }),
    loadCoverageConstraints: async () => ({
      commercials: {
        C01: {
          available_dates: ['2026-08-04'],
          unavailable_dates: [],
          hard_max_visits_by_date: {
            '2026-08-04': 2
          }
        }
      },
      client_restrictions: {}
    }),
    loadProfileSnapshot: async () => ({
      status: 'ready',
      required_profile_version: snapshotVersion,
      active_profile_version: snapshotVersion,
      source_fingerprint: {
        source_data_version: 'source-v1'
      },
      snapshot: {
        computed_at: '2026-08-04T09:00:00.000Z',
        clients_count: 1
      },
      cadenceProfiles: [makeCadenceProfile('1', '00152')]
    }),
    sharedDepotOrigin: {
      latitude: 36.82,
      longitude: 10.18,
      nom: 'Depot principal'
    }
  }

  const request = {
    start_date: '2026-08-04',
    planning_horizon_days: 7,
    commercial_codes: ['C01'],
    max_clients: 2,
    min_clients: 0,
    objective_mode: 'balanced',
    minimum_confidence: 0,
    daily_max_mode: 'flexible'
  }

  const firstPayload = await generateNextBestVisitPlan(request, baseDependencies)
  const secondPayload = await generateNextBestVisitPlan(request, baseDependencies)
  snapshotVersion = 'profile-v2'
  const thirdPayload = await generateNextBestVisitPlan(request, baseDependencies)

  assert.equal(firstPayload.summary.plan_cache_status, 'miss')
  assert.equal(secondPayload.summary.plan_cache_status, 'hit')
  assert.equal(thirdPayload.summary.plan_cache_status, 'miss')
  assert.equal(firstPayload.summary.selected_unique_clients_count, secondPayload.summary.selected_unique_clients_count)
  assert.equal(secondPayload.summary.selected_unique_clients_count, thirdPayload.summary.selected_unique_clients_count)
})

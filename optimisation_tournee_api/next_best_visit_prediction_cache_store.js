const {
  stableStringify
} = require('./next_best_visit_versions')

const PREDICTION_CACHE_TABLE = 'next_best_visit_prediction_cache'

function normalizeDateOnly(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = String(value.getFullYear())
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const normalized = String(value || '').trim().slice(0, 10)
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized
  }

  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : null
}

function safeJsonParse(value, fallbackValue) {
  if (value === null || value === undefined || value === '') return fallbackValue
  try {
    return JSON.parse(value)
  } catch (error) {
    return fallbackValue
  }
}

async function ensurePredictionCacheTables(queryAsync, connection = null) {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS ${PREDICTION_CACHE_TABLE} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id VARCHAR(64) NOT NULL,
      client_code VARCHAR(191) NOT NULL,
      target_date DATE NOT NULL,
      model_version VARCHAR(191) NOT NULL,
      features_version VARCHAR(191) NOT NULL,
      source_data_version VARCHAR(191) NOT NULL,
      purchase_probability DOUBLE DEFAULT NULL,
      predicted_ca DOUBLE DEFAULT NULL,
      recommended_quantity DOUBLE DEFAULT NULL,
      model_confidence DOUBLE DEFAULT NULL,
      score DOUBLE DEFAULT NULL,
      vip DOUBLE DEFAULT NULL,
      predicted_ca_if_buy DOUBLE DEFAULT NULL,
      predicted_quantity_if_buy DOUBLE DEFAULT NULL,
      probability_model_only DOUBLE DEFAULT NULL,
      habit_score DOUBLE DEFAULT NULL,
      recency_score DOUBLE DEFAULT NULL,
      prediction_source VARCHAR(191) DEFAULT NULL,
      prediction_payload_json LONGTEXT DEFAULT NULL,
      python_meta_json LONGTEXT DEFAULT NULL,
      computed_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY next_best_visit_prediction_cache_unique (
        client_id,
        client_code,
        target_date,
        model_version,
        features_version,
        source_data_version
      ),
      KEY next_best_visit_prediction_cache_lookup_idx (
        target_date,
        model_version,
        features_version,
        source_data_version
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `, [], connection)
}

function buildPredictionCacheKey({ clientId, clientCode, targetDate }) {
  return `${String(clientId || '').trim()}::${String(clientCode || '').trim()}::${String(targetDate || '').trim()}`
}

function mapPredictionCacheRow(row = {}) {
  return {
    client_id: String(row.client_id || '').trim(),
    client_code: String(row.client_code || '').trim(),
    target_date: normalizeDateOnly(row.target_date),
    purchase_probability: row.purchase_probability == null ? null : Number(row.purchase_probability),
    predicted_ca: row.predicted_ca == null ? null : Number(row.predicted_ca),
    recommended_quantity: row.recommended_quantity == null ? null : Number(row.recommended_quantity),
    model_confidence: row.model_confidence == null ? null : Number(row.model_confidence),
    score: row.score == null ? null : Number(row.score),
    vip: row.vip == null ? null : Number(row.vip),
    predicted_ca_if_buy: row.predicted_ca_if_buy == null ? null : Number(row.predicted_ca_if_buy),
    predicted_quantity_if_buy: row.predicted_quantity_if_buy == null ? null : Number(row.predicted_quantity_if_buy),
    probability_model_only: row.probability_model_only == null ? null : Number(row.probability_model_only),
    habit_score: row.habit_score == null ? null : Number(row.habit_score),
    recency_score: row.recency_score == null ? null : Number(row.recency_score),
    prediction_source: row.prediction_source || null,
    prediction_payload: safeJsonParse(row.prediction_payload_json, {}),
    python_meta: safeJsonParse(row.python_meta_json, {}),
    computed_at: row.computed_at ? new Date(row.computed_at).toISOString() : null
  }
}

async function readPredictionCacheRows(queryAsync, {
  requests = [],
  modelVersion,
  featuresVersion,
  sourceDataVersion
} = {}) {
  const normalizedRequests = [...new Map(
    (Array.isArray(requests) ? requests : [])
      .map(requestEntry => {
        const clientId = String(requestEntry?.client_id || '').trim()
        const clientCode = String(requestEntry?.client_code || '').trim()
        const targetDate = String(requestEntry?.target_date || '').trim().slice(0, 10)
        if (!clientId || !clientCode || !targetDate) return null
        return [buildPredictionCacheKey({ clientId, clientCode, targetDate }), { clientId, clientCode, targetDate }]
      })
      .filter(Boolean)
  ).values()]

  if (!normalizedRequests.length) {
    return {
      rows: [],
      by_key: new Map(),
      hit_count: 0,
      miss_count: 0,
      hit_rate: null
    }
  }

  const groupedByDate = normalizedRequests.reduce((map, requestEntry) => {
    const list = map.get(requestEntry.targetDate) || []
    list.push(requestEntry)
    map.set(requestEntry.targetDate, list)
    return map
  }, new Map())

  const rows = []
  for (const [targetDate, dateRequests] of groupedByDate.entries()) {
    const chunkSize = 500
    for (let index = 0; index < dateRequests.length; index += chunkSize) {
      const chunk = dateRequests.slice(index, index + chunkSize)
      const clientIdPlaceholders = chunk.map(() => '?').join(', ')
      const clientCodePlaceholders = chunk.map(() => '?').join(', ')
      const chunkRows = await queryAsync(`
        SELECT
          client_id,
          client_code,
          target_date,
          purchase_probability,
          predicted_ca,
          recommended_quantity,
          model_confidence,
          score,
          vip,
          predicted_ca_if_buy,
          predicted_quantity_if_buy,
          probability_model_only,
          habit_score,
          recency_score,
          prediction_source,
          prediction_payload_json,
          python_meta_json,
          computed_at
        FROM ${PREDICTION_CACHE_TABLE}
        WHERE target_date = ?
          AND model_version = ?
          AND features_version = ?
          AND source_data_version = ?
          AND client_id IN (${clientIdPlaceholders})
          AND client_code IN (${clientCodePlaceholders})
      `, [
        targetDate,
        modelVersion,
        featuresVersion,
        sourceDataVersion,
        ...chunk.map(item => item.clientId),
        ...chunk.map(item => item.clientCode)
      ])
      rows.push(...(chunkRows || []))
    }
  }

  const mappedRows = rows.map(mapPredictionCacheRow)
  const byKey = new Map(
    mappedRows.map(row => [buildPredictionCacheKey({
      clientId: row.client_id,
      clientCode: row.client_code,
      targetDate: row.target_date
    }), row])
  )
  const hitCount = normalizedRequests.filter(requestEntry => byKey.has(buildPredictionCacheKey(requestEntry))).length
  const missCount = Math.max(0, normalizedRequests.length - hitCount)

  return {
    rows: mappedRows,
    by_key: byKey,
    hit_count: hitCount,
    miss_count: missCount,
    hit_rate: normalizedRequests.length > 0 ? Math.round((hitCount / normalizedRequests.length) * 1000) / 10 : null
  }
}

async function upsertPredictionCacheRows(queryAsync, rows = [], connection = null) {
  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map(row => {
      const clientId = String(row?.client_id || '').trim()
      const clientCode = String(row?.client_code || '').trim()
      const targetDate = String(row?.target_date || '').trim().slice(0, 10)
      if (!clientId || !clientCode || !targetDate) return null
      return [
        clientId,
        clientCode,
        targetDate,
        String(row.model_version || '').trim(),
        String(row.features_version || '').trim(),
        String(row.source_data_version || '').trim(),
        row.purchase_probability == null ? null : Number(row.purchase_probability),
        row.predicted_ca == null ? null : Number(row.predicted_ca),
        row.recommended_quantity == null ? null : Number(row.recommended_quantity),
        row.model_confidence == null ? null : Number(row.model_confidence),
        row.score == null ? null : Number(row.score),
        row.vip == null ? null : Number(row.vip),
        row.predicted_ca_if_buy == null ? null : Number(row.predicted_ca_if_buy),
        row.predicted_quantity_if_buy == null ? null : Number(row.predicted_quantity_if_buy),
        row.probability_model_only == null ? null : Number(row.probability_model_only),
        row.habit_score == null ? null : Number(row.habit_score),
        row.recency_score == null ? null : Number(row.recency_score),
        row.prediction_source == null ? null : String(row.prediction_source),
        JSON.stringify(row.prediction_payload || {}),
        JSON.stringify(row.python_meta || {}),
        new Date().toISOString().slice(0, 19).replace('T', ' ')
      ]
    })
    .filter(Boolean)

  if (!normalizedRows.length) return

  await ensurePredictionCacheTables(queryAsync, connection)
  const insertChunkSize = 100
  for (let index = 0; index < normalizedRows.length; index += insertChunkSize) {
    const chunk = normalizedRows.slice(index, index + insertChunkSize)
    const placeholders = chunk
      .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .join(', ')
    await queryAsync(`
      INSERT INTO ${PREDICTION_CACHE_TABLE} (
        client_id,
        client_code,
        target_date,
        model_version,
        features_version,
        source_data_version,
        purchase_probability,
        predicted_ca,
        recommended_quantity,
        model_confidence,
        score,
        vip,
        predicted_ca_if_buy,
        predicted_quantity_if_buy,
        probability_model_only,
        habit_score,
        recency_score,
        prediction_source,
        prediction_payload_json,
        python_meta_json,
        computed_at
      ) VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE
        purchase_probability = VALUES(purchase_probability),
        predicted_ca = VALUES(predicted_ca),
        recommended_quantity = VALUES(recommended_quantity),
        model_confidence = VALUES(model_confidence),
        score = VALUES(score),
        vip = VALUES(vip),
        predicted_ca_if_buy = VALUES(predicted_ca_if_buy),
        predicted_quantity_if_buy = VALUES(predicted_quantity_if_buy),
        probability_model_only = VALUES(probability_model_only),
        habit_score = VALUES(habit_score),
        recency_score = VALUES(recency_score),
        prediction_source = VALUES(prediction_source),
        prediction_payload_json = VALUES(prediction_payload_json),
        python_meta_json = VALUES(python_meta_json),
        computed_at = VALUES(computed_at)
    `, chunk.flat(), connection)
  }
}

async function readPredictionCacheStats(queryAsync) {
  await ensurePredictionCacheTables(queryAsync)
  const rows = await queryAsync(`
    SELECT
      COUNT(*) AS entries_count,
      MAX(model_version) AS model_version,
      MAX(features_version) AS features_version,
      MAX(updated_at) AS latest_updated_at
    FROM ${PREDICTION_CACHE_TABLE}
  `)
  const row = rows?.[0] || {}
  return {
    entries_count: Number(row.entries_count || 0),
    model_version: row.model_version || null,
    features_version: row.features_version || null,
    latest_updated_at: row.latest_updated_at ? new Date(row.latest_updated_at).toISOString() : null
  }
}

module.exports = {
  PREDICTION_CACHE_TABLE,
  buildPredictionCacheKey,
  ensurePredictionCacheTables,
  readPredictionCacheRows,
  readPredictionCacheStats,
  upsertPredictionCacheRows
}

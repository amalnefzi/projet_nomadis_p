const {
  NEXT_BEST_VISIT_CADENCE_ALGORITHM_VERSION,
  NEXT_BEST_VISIT_PROFILE_SCHEMA_VERSION,
  buildNextBestVisitProfileVersion,
  buildNextBestVisitSourceDataVersion,
  stableStringify
} = require('./next_best_visit_versions')

const SNAPSHOT_STATE_TABLE = 'next_best_visit_profile_snapshot_state'
const SNAPSHOT_TABLE = 'next_best_visit_profile_snapshots'
const PROFILE_TABLE = 'next_best_visit_client_profiles'
const DEFAULT_SCOPE_KEY = 'default'
const DEFAULT_PROFILE_REBUILD_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.NEXT_BEST_VISIT_PROFILE_REBUILD_TIMEOUT_MS || 30 * 60 * 1000)
)

function safeJsonParse(value, fallbackValue) {
  if (value === null || value === undefined || value === '') return fallbackValue
  try {
    return JSON.parse(value)
  } catch (error) {
    return fallbackValue
  }
}

function safeJsonStringify(value) {
  return stableStringify(value)
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

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

function shiftDate(dateValue, daysDelta) {
  const normalized = normalizeDateOnly(dateValue)
  if (!normalized) return null
  const parsed = new Date(`${normalized}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return null
  parsed.setUTCDate(parsed.getUTCDate() + Number(daysDelta || 0))
  return parsed.toISOString().slice(0, 10)
}

function maxDateOnly(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(normalizeDateOnly)
    .filter(Boolean)
    .sort()
    .at(-1) || null
}

function resolveLatestAvailableRelevantSourceDataDate(sourceFingerprint = {}) {
  return maxDateOnly([
    sourceFingerprint?.max_sale_date,
    sourceFingerprint?.max_visit_date
  ])
}

function resolveRequiredHistoricalCutoffDate({
  planningStartDate = null,
  historicalCutoffDate = null,
  sourceFingerprint = {}
} = {}) {
  const latestAvailableRelevantSourceDataDate = resolveLatestAvailableRelevantSourceDataDate(sourceFingerprint)
  if (!latestAvailableRelevantSourceDataDate) {
    return null
  }

  const explicitHistoricalCutoffDate = normalizeDateOnly(historicalCutoffDate)
  if (explicitHistoricalCutoffDate) {
    return explicitHistoricalCutoffDate < latestAvailableRelevantSourceDataDate
      ? explicitHistoricalCutoffDate
      : latestAvailableRelevantSourceDataDate
  }

  const planningStartDateDayBefore = shiftDate(planningStartDate, -1)
  if (!planningStartDateDayBefore) {
    return latestAvailableRelevantSourceDataDate
  }

  return planningStartDateDayBefore < latestAvailableRelevantSourceDataDate
    ? planningStartDateDayBefore
    : latestAvailableRelevantSourceDataDate
}

function resolveProfileVersionHistoricalCutoffDate({
  historicalCutoffDate = null,
  sourceFingerprint = {}
} = {}) {
  const explicitHistoricalCutoffDate = normalizeDateOnly(historicalCutoffDate)
  if (!explicitHistoricalCutoffDate) {
    return null
  }

  const latestAvailableRelevantSourceDataDate = resolveLatestAvailableRelevantSourceDataDate(sourceFingerprint)
  if (!latestAvailableRelevantSourceDataDate) {
    return explicitHistoricalCutoffDate
  }

  return explicitHistoricalCutoffDate < latestAvailableRelevantSourceDataDate
    ? explicitHistoricalCutoffDate
    : null
}

async function ensureProfileSnapshotTables(queryAsync, connection = null) {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS ${SNAPSHOT_STATE_TABLE} (
      scope_key VARCHAR(64) NOT NULL,
      active_profile_version VARCHAR(191) DEFAULT NULL,
      rebuild_status VARCHAR(32) NOT NULL DEFAULT 'missing',
      latest_error_message TEXT DEFAULT NULL,
      rebuilding_started_at DATETIME DEFAULT NULL,
      last_completed_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (scope_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `, [], connection)

  await queryAsync(`
    CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
      profile_version VARCHAR(191) NOT NULL,
      source_data_version VARCHAR(191) NOT NULL,
      profile_schema_version VARCHAR(64) NOT NULL,
      cadence_algorithm_version VARCHAR(64) NOT NULL,
      historical_cutoff_date DATE DEFAULT NULL,
      snapshot_status VARCHAR(32) NOT NULL,
      clients_count INT DEFAULT NULL,
      computed_at DATETIME DEFAULT NULL,
      source_metrics_json LONGTEXT DEFAULT NULL,
      timings_json LONGTEXT DEFAULT NULL,
      error_message TEXT DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_version),
      KEY next_best_visit_profile_snapshots_active_idx (is_active),
      KEY next_best_visit_profile_snapshots_status_idx (snapshot_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `, [], connection)

  await queryAsync(`
    CREATE TABLE IF NOT EXISTS ${PROFILE_TABLE} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      profile_version VARCHAR(191) NOT NULL,
      source_data_version VARCHAR(191) NOT NULL,
      client_id VARCHAR(64) NOT NULL,
      client_code VARCHAR(191) NOT NULL,
      computed_at DATETIME DEFAULT NULL,
      last_sale_date DATE DEFAULT NULL,
      last_visit_date DATE DEFAULT NULL,
      purchase_count INT DEFAULT NULL,
      average_interval_days DOUBLE DEFAULT NULL,
      median_interval_days DOUBLE DEFAULT NULL,
      weighted_interval_days DOUBLE DEFAULT NULL,
      usual_weekdays_json LONGTEXT DEFAULT NULL,
      average_order_value DOUBLE DEFAULT NULL,
      average_quantity DOUBLE DEFAULT NULL,
      activity_trend VARCHAR(64) DEFAULT NULL,
      inactivity_risk VARCHAR(64) DEFAULT NULL,
      recommended_visit_interval_days INT DEFAULT NULL,
      cadence_confidence DOUBLE DEFAULT NULL,
      history_depth INT DEFAULT NULL,
      decision_mode_hint VARCHAR(32) DEFAULT NULL,
      profile_payload_json LONGTEXT DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY next_best_visit_client_profiles_version_client_unique (profile_version, client_id),
      KEY next_best_visit_client_profiles_version_code_idx (profile_version, client_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `, [], connection)

  await queryAsync(`
    INSERT INTO ${SNAPSHOT_STATE_TABLE} (scope_key, rebuild_status)
    VALUES (?, 'missing')
    ON DUPLICATE KEY UPDATE scope_key = VALUES(scope_key)
  `, [DEFAULT_SCOPE_KEY], connection)
}

async function computeNextBestVisitSourceFingerprint(queryAsync) {
  const rows = await queryAsync(`
    SELECT
      (SELECT COUNT(*) FROM clients c WHERE c.deleted_at IS NULL AND c.isactif = '1') AS active_clients_count,
      (SELECT MAX(CAST(c.id AS CHAR)) FROM clients c WHERE c.deleted_at IS NULL AND c.isactif = '1') AS max_client_id,
      (SELECT COUNT(*) FROM entetecommercials e WHERE e.deleted_at IS NULL AND e.type IN ('facture', 'bl', 'blf')) AS sales_rows_count,
      (SELECT MAX(DATE(e.date)) FROM entetecommercials e WHERE e.deleted_at IS NULL AND e.type IN ('facture', 'bl', 'blf')) AS max_sale_date,
      (SELECT COUNT(*) FROM client_visits v WHERE v.validation_status = 'validated') AS visits_rows_count,
      (SELECT MAX(DATE(COALESCE(v.check_in_at, v.planned_date))) FROM client_visits v WHERE v.validation_status = 'validated') AS max_visit_date
  `)
  const row = rows?.[0] || {}
  const fingerprint = {
    active_clients_count: Number(row.active_clients_count || 0),
    max_client_id: String(row.max_client_id || '').trim() || null,
    sales_rows_count: Number(row.sales_rows_count || 0),
    max_sale_date: normalizeDateOnly(row.max_sale_date),
    visits_rows_count: Number(row.visits_rows_count || 0),
    max_visit_date: normalizeDateOnly(row.max_visit_date)
  }

  return {
    ...fingerprint,
    latest_available_relevant_source_data_date: resolveLatestAvailableRelevantSourceDataDate(fingerprint),
    source_data_version: buildNextBestVisitSourceDataVersion(fingerprint)
  }
}

function mapCadenceProfileRow(row = {}) {
  const payload = safeJsonParse(row.profile_payload_json, {})
  const usualPurchaseWeekdays = safeJsonParse(row.usual_weekdays_json, [])
  return {
    ...payload,
    client_id: String(row.client_id || '').trim(),
    client_code: String(row.client_code || '').trim(),
    last_purchase_date: normalizeDateOnly(row.last_sale_date) || null,
    last_contact_date: normalizeDateOnly(row.last_visit_date) || payload.last_contact_date || null,
    purchase_count: row.purchase_count == null ? null : Number(row.purchase_count),
    average_days_between_purchases: toNullableNumber(row.average_interval_days),
    median_days_between_purchases: toNullableNumber(row.median_interval_days),
    recent_weighted_purchase_interval_days: toNullableNumber(row.weighted_interval_days),
    usual_purchase_weekdays: Array.isArray(usualPurchaseWeekdays) ? usualPurchaseWeekdays : [],
    usual_order_value: toNullableNumber(row.average_order_value),
    usual_order_quantity: toNullableNumber(row.average_quantity),
    customer_activity_trend: row.activity_trend == null ? null : String(row.activity_trend),
    inactivity_risk: row.inactivity_risk == null ? null : String(row.inactivity_risk),
    recommended_visit_interval_days: row.recommended_visit_interval_days == null ? null : Number(row.recommended_visit_interval_days),
    cadence_confidence: toNullableNumber(row.cadence_confidence),
    history_depth: row.history_depth == null ? null : Number(row.history_depth),
    decision_mode_hint: row.decision_mode_hint == null ? null : String(row.decision_mode_hint)
  }
}

function buildStoredProfileRow(profile = {}, sourceDataVersion, computedAtIso) {
  const purchaseCount = profile.purchase_count == null
    ? profile.history_depth
    : profile.purchase_count
  const decisionModeHint = profile.decision_mode_hint ||
    profile.decision_mode ||
    profile.fallback_strategy ||
    null
  return [
    String(profile.client_id || '').trim(),
    String(profile.client_code || '').trim(),
    computedAtIso,
    normalizeDateOnly(profile.last_purchase_date),
    normalizeDateOnly(profile.last_contact_date),
    purchaseCount == null ? null : Number(purchaseCount),
    toNullableNumber(profile.average_days_between_purchases),
    toNullableNumber(profile.median_days_between_purchases),
    toNullableNumber(profile.recent_weighted_purchase_interval_days),
    safeJsonStringify(Array.isArray(profile.usual_purchase_weekdays) ? profile.usual_purchase_weekdays : []),
    toNullableNumber(profile.usual_order_value),
    toNullableNumber(profile.usual_order_quantity),
    profile.customer_activity_trend == null ? null : String(profile.customer_activity_trend),
    profile.inactivity_risk == null ? null : String(profile.inactivity_risk),
    profile.recommended_visit_interval_days == null ? null : Number(profile.recommended_visit_interval_days),
    toNullableNumber(profile.cadence_confidence),
    profile.history_depth == null ? null : Number(profile.history_depth),
    decisionModeHint == null ? null : String(decisionModeHint),
    JSON.stringify(profile),
    sourceDataVersion
  ]
}

async function markProfileSnapshotRebuildStarted(queryAsync, {
  scopeKey = DEFAULT_SCOPE_KEY
} = {}) {
  await ensureProfileSnapshotTables(queryAsync)
  await queryAsync(`
    UPDATE ${SNAPSHOT_STATE_TABLE}
    SET rebuild_status = 'rebuilding',
        latest_error_message = NULL,
        rebuilding_started_at = UTC_TIMESTAMP()
    WHERE scope_key = ?
  `, [scopeKey])
}

async function markProfileSnapshotRebuildFailed(queryAsync, errorMessage, {
  scopeKey = DEFAULT_SCOPE_KEY
} = {}) {
  await ensureProfileSnapshotTables(queryAsync)
  await queryAsync(`
    UPDATE ${SNAPSHOT_STATE_TABLE}
    SET rebuild_status = 'failed',
        latest_error_message = ?,
        rebuilding_started_at = NULL
    WHERE scope_key = ?
  `, [String(errorMessage || 'rebuild_failed'), scopeKey])
}

async function markProfileSnapshotRebuildAbandoned(queryAsync, {
  scopeKey = DEFAULT_SCOPE_KEY,
  nextStatus = 'stale',
  errorMessage = 'abandoned_rebuild_recovered'
} = {}) {
  await ensureProfileSnapshotTables(queryAsync)
  await queryAsync(`
    UPDATE ${SNAPSHOT_STATE_TABLE}
    SET rebuild_status = ?,
        latest_error_message = ?,
        rebuilding_started_at = NULL
    WHERE scope_key = ?
  `, [
    String(nextStatus || 'stale'),
    String(errorMessage || 'abandoned_rebuild_recovered'),
    scopeKey
  ])
}

function hasProfileSnapshotRebuildTimedOut(snapshotState = {}, {
  nowMs = Date.now(),
  timeoutMs = DEFAULT_PROFILE_REBUILD_TIMEOUT_MS
} = {}) {
  const startedAtMs = Date.parse(String(snapshotState?.rebuilding_started_at || ''))
  if (!Number.isFinite(startedAtMs)) {
    return false
  }
  return (Number(nowMs) - startedAtMs) > Number(timeoutMs || 0)
}

async function persistProfileSnapshot({
  queryAsync,
  connection,
  profileVersion,
  sourceDataVersion,
  historicalCutoffDate = null,
  cadenceProfiles = [],
  sourceMetrics = {},
  timings = {},
  scopeKey = DEFAULT_SCOPE_KEY
}) {
  await ensureProfileSnapshotTables(queryAsync, connection)
  const computedAtIso = new Date().toISOString().slice(0, 19).replace('T', ' ')

  await queryAsync(`
    INSERT INTO ${SNAPSHOT_TABLE} (
      profile_version,
      source_data_version,
      profile_schema_version,
      cadence_algorithm_version,
      historical_cutoff_date,
      snapshot_status,
      clients_count,
      computed_at,
      source_metrics_json,
      timings_json,
      error_message,
      is_active
    ) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, NULL, 0)
    ON DUPLICATE KEY UPDATE
      source_data_version = VALUES(source_data_version),
      profile_schema_version = VALUES(profile_schema_version),
      cadence_algorithm_version = VALUES(cadence_algorithm_version),
      historical_cutoff_date = VALUES(historical_cutoff_date),
      snapshot_status = 'ready',
      clients_count = VALUES(clients_count),
      computed_at = VALUES(computed_at),
      source_metrics_json = VALUES(source_metrics_json),
      timings_json = VALUES(timings_json),
      error_message = NULL
  `, [
    profileVersion,
    sourceDataVersion,
    NEXT_BEST_VISIT_PROFILE_SCHEMA_VERSION,
    NEXT_BEST_VISIT_CADENCE_ALGORITHM_VERSION,
    historicalCutoffDate,
    Array.isArray(cadenceProfiles) ? cadenceProfiles.length : 0,
    computedAtIso,
    JSON.stringify(sourceMetrics || {}),
    JSON.stringify(timings || {})
  ], connection)

  await queryAsync(`
    DELETE FROM ${PROFILE_TABLE}
    WHERE profile_version = ?
  `, [profileVersion], connection)

  const rows = (Array.isArray(cadenceProfiles) ? cadenceProfiles : [])
    .map(profile => buildStoredProfileRow(profile, sourceDataVersion, computedAtIso))
    .filter(row => row[0] && row[1])

  if (rows.length > 0) {
    const insertChunkSize = 100
    for (let index = 0; index < rows.length; index += insertChunkSize) {
      const chunk = rows.slice(index, index + insertChunkSize)
      await queryAsync(`
        INSERT INTO ${PROFILE_TABLE} (
          client_id,
          client_code,
          computed_at,
          last_sale_date,
          last_visit_date,
          purchase_count,
          average_interval_days,
          median_interval_days,
          weighted_interval_days,
          usual_weekdays_json,
          average_order_value,
          average_quantity,
          activity_trend,
          inactivity_risk,
          recommended_visit_interval_days,
          cadence_confidence,
          history_depth,
          decision_mode_hint,
          profile_payload_json,
          source_data_version,
          profile_version
        ) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
      `, chunk.flatMap(row => [...row, profileVersion]), connection)
    }
  }

  await queryAsync(`
    UPDATE ${SNAPSHOT_TABLE}
    SET is_active = CASE WHEN profile_version = ? THEN 1 ELSE 0 END
    WHERE is_active = 1 OR profile_version = ?
  `, [profileVersion, profileVersion], connection)

  await queryAsync(`
    UPDATE ${SNAPSHOT_STATE_TABLE}
    SET active_profile_version = ?,
        rebuild_status = 'ready',
        latest_error_message = NULL,
        rebuilding_started_at = NULL,
        last_completed_at = UTC_TIMESTAMP()
    WHERE scope_key = ?
  `, [profileVersion, scopeKey], connection)
}

async function readProfileSnapshotState(queryAsync, {
  planningStartDate = null,
  historicalCutoffDate = null,
  scopeKey = DEFAULT_SCOPE_KEY
} = {}) {
  await ensureProfileSnapshotTables(queryAsync)
  const [sourceFingerprint, stateRows, activeSnapshotRows] = await Promise.all([
    computeNextBestVisitSourceFingerprint(queryAsync),
    queryAsync(`
      SELECT
        scope_key,
        active_profile_version,
        rebuild_status,
        latest_error_message,
        rebuilding_started_at,
        last_completed_at
      FROM ${SNAPSHOT_STATE_TABLE}
      WHERE scope_key = ?
      LIMIT 1
    `, [scopeKey]),
    queryAsync(`
      SELECT
        profile_version,
        source_data_version,
        profile_schema_version,
        cadence_algorithm_version,
        historical_cutoff_date,
        snapshot_status,
        clients_count,
        computed_at,
        source_metrics_json,
        timings_json,
        error_message,
        is_active
      FROM ${SNAPSHOT_TABLE}
      WHERE is_active = 1
      ORDER BY updated_at DESC
      LIMIT 1
    `)
  ])

  const requiredHistoricalCutoffDate = resolveRequiredHistoricalCutoffDate({
    planningStartDate,
    historicalCutoffDate,
    sourceFingerprint
  })
  const requiredProfileVersionHistoricalCutoffDate = resolveProfileVersionHistoricalCutoffDate({
    historicalCutoffDate: requiredHistoricalCutoffDate,
    sourceFingerprint
  })
  const requiredProfileVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion: sourceFingerprint.source_data_version,
    historicalCutoffDate: requiredProfileVersionHistoricalCutoffDate
  })
  const state = stateRows?.[0] || {}
  const activeSnapshot = activeSnapshotRows?.[0] || null
  const activeProfileStorageVersion = activeSnapshot?.profile_version || state.active_profile_version || null
  let status = 'missing'
  let activeProfileVersion = activeProfileStorageVersion

  if (activeSnapshot) {
    const activeProfileVersionHistoricalCutoffDate = resolveProfileVersionHistoricalCutoffDate({
      historicalCutoffDate: activeSnapshot.historical_cutoff_date,
      sourceFingerprint
    })
    activeProfileVersion = buildNextBestVisitProfileVersion({
      sourceDataVersion: activeSnapshot.source_data_version || sourceFingerprint.source_data_version,
      historicalCutoffDate: activeProfileVersionHistoricalCutoffDate
    })
    const activeMatchesVersion = String(activeProfileVersion || '') === requiredProfileVersion
    const activeReady = String(activeSnapshot.snapshot_status || '').trim() === 'ready'
    const schemaMatches = String(activeSnapshot.profile_schema_version || '') === NEXT_BEST_VISIT_PROFILE_SCHEMA_VERSION
    const cadenceMatches = String(activeSnapshot.cadence_algorithm_version || '') === NEXT_BEST_VISIT_CADENCE_ALGORITHM_VERSION
    const sourceMatches = String(activeSnapshot.source_data_version || '') === sourceFingerprint.source_data_version

    if (activeReady && activeMatchesVersion && schemaMatches && cadenceMatches && sourceMatches) {
      status = 'ready'
    } else if (String(state.rebuild_status || '').trim() === 'rebuilding') {
      status = 'building'
    } else if (String(state.rebuild_status || '').trim() === 'failed') {
      status = 'failed'
    } else {
      status = 'stale'
    }
  } else if (String(state.rebuild_status || '').trim() === 'rebuilding') {
    status = 'building'
  } else if (String(state.rebuild_status || '').trim() === 'failed') {
    status = 'failed'
  }

  return {
    status,
    source_fingerprint: sourceFingerprint,
    required_historical_cutoff_date: requiredHistoricalCutoffDate,
    required_profile_version: requiredProfileVersion,
    active_profile_version: activeProfileVersion,
    active_profile_storage_version: activeProfileStorageVersion,
    snapshot: activeSnapshot
      ? {
          ...activeSnapshot,
          historical_cutoff_date: normalizeDateOnly(activeSnapshot.historical_cutoff_date),
          computed_at: activeSnapshot.computed_at ? new Date(activeSnapshot.computed_at).toISOString() : null,
          source_metrics: safeJsonParse(activeSnapshot.source_metrics_json, {}),
          timings: safeJsonParse(activeSnapshot.timings_json, {})
        }
      : null,
    rebuild_status: String(state.rebuild_status || '').trim() || 'missing',
    latest_error_message: state.latest_error_message || null,
    rebuilding_started_at: state.rebuilding_started_at ? new Date(state.rebuilding_started_at).toISOString() : null,
    last_completed_at: state.last_completed_at ? new Date(state.last_completed_at).toISOString() : null
  }
}

async function loadProfileSnapshotByClientIds(queryAsync, {
  profileVersion,
  clientIds = []
} = {}) {
  const normalizedClientIds = [...new Set(
    (Array.isArray(clientIds) ? clientIds : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )]

  if (!profileVersion || normalizedClientIds.length === 0) {
    return []
  }

  const chunkSize = 500
  const rows = []
  for (let index = 0; index < normalizedClientIds.length; index += chunkSize) {
    const chunk = normalizedClientIds.slice(index, index + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const chunkRows = await queryAsync(`
      SELECT
        profile_version,
        source_data_version,
        client_id,
        client_code,
        computed_at,
        last_sale_date,
        last_visit_date,
        purchase_count,
        average_interval_days,
        median_interval_days,
        weighted_interval_days,
        usual_weekdays_json,
        average_order_value,
        average_quantity,
        activity_trend,
        inactivity_risk,
        recommended_visit_interval_days,
        cadence_confidence,
        history_depth,
        decision_mode_hint,
        profile_payload_json
      FROM ${PROFILE_TABLE}
      WHERE profile_version = ?
        AND client_id IN (${placeholders})
    `, [profileVersion, ...chunk])
    rows.push(...(chunkRows || []))
  }

  return rows.map(mapCadenceProfileRow)
}

module.exports = {
  DEFAULT_SCOPE_KEY,
  PROFILE_TABLE,
  SNAPSHOT_STATE_TABLE,
  SNAPSHOT_TABLE,
  DEFAULT_PROFILE_REBUILD_TIMEOUT_MS,
  buildNextBestVisitProfileVersion,
  computeNextBestVisitSourceFingerprint,
  ensureProfileSnapshotTables,
  hasProfileSnapshotRebuildTimedOut,
  loadProfileSnapshotByClientIds,
  markProfileSnapshotRebuildAbandoned,
  markProfileSnapshotRebuildFailed,
  markProfileSnapshotRebuildStarted,
  persistProfileSnapshot,
  readProfileSnapshotState,
  resolveLatestAvailableRelevantSourceDataDate,
  resolveProfileVersionHistoricalCutoffDate,
  resolveRequiredHistoricalCutoffDate
}

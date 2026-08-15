const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildNextBestVisitProfileVersion,
  buildNextBestVisitSourceDataVersion
} = require('../next_best_visit_versions')
const {
  readProfileSnapshotState,
  resolveProfileVersionHistoricalCutoffDate,
  resolveRequiredHistoricalCutoffDate
} = require('../next_best_visit_profile_snapshot_store')
const {
  ensureNextBestVisitProfilesReady,
  runNextBestVisitProfileRebuildNow,
  __testables: readinessTestables
} = require('../next_best_visit_profile_readiness')

function createDeferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  }
}

function createSnapshotStateQueryMock({
  sourceFingerprint,
  stateRow,
  activeSnapshotRow
}) {
  const mutableStateRow = stateRow ? { ...stateRow } : null
  let mutableActiveSnapshotRow = activeSnapshotRow ? { ...activeSnapshotRow } : null

  async function queryAsync(sql, params = []) {
    const normalizedSql = String(sql || '').replace(/\s+/g, ' ').trim()

    if (normalizedSql.startsWith('CREATE TABLE IF NOT EXISTS next_best_visit_profile_snapshot_state')) {
      return []
    }
    if (normalizedSql.startsWith('CREATE TABLE IF NOT EXISTS next_best_visit_profile_snapshots')) {
      return []
    }
    if (normalizedSql.startsWith('CREATE TABLE IF NOT EXISTS next_best_visit_client_profiles')) {
      return []
    }
    if (normalizedSql.startsWith('INSERT INTO next_best_visit_profile_snapshot_state')) {
      return []
    }
    if (normalizedSql.startsWith('UPDATE next_best_visit_profile_snapshot_state SET rebuild_status = \'rebuilding\'')) {
      if (mutableStateRow) {
        mutableStateRow.rebuild_status = 'rebuilding'
        mutableStateRow.latest_error_message = null
        mutableStateRow.rebuilding_started_at = new Date().toISOString().slice(0, 19).replace('T', ' ')
      }
      return []
    }
    if (normalizedSql.startsWith('UPDATE next_best_visit_profile_snapshot_state SET rebuild_status = ?')) {
      if (mutableStateRow) {
        mutableStateRow.rebuild_status = params[0]
        mutableStateRow.latest_error_message = params[1]
        mutableStateRow.rebuilding_started_at = null
      }
      return []
    }
    if (normalizedSql.startsWith('SELECT (SELECT COUNT(*) FROM clients c')) {
      return [sourceFingerprint]
    }
    if (normalizedSql.includes('FROM next_best_visit_profile_snapshot_state')) {
      return mutableStateRow ? [mutableStateRow] : []
    }
    if (normalizedSql.includes('FROM next_best_visit_profile_snapshots')) {
      return mutableActiveSnapshotRow ? [mutableActiveSnapshotRow] : []
    }

    return []
  }

  queryAsync.__stateRow = mutableStateRow
  queryAsync.__getActiveSnapshotRow = () => mutableActiveSnapshotRow
  queryAsync.__setActiveSnapshotRow = row => {
    mutableActiveSnapshotRow = row ? { ...row } : null
  }

  return queryAsync
}

function createRebuildQueryMock({
  sourceFingerprint,
  activeClients = []
}) {
  const persistedProfilePayloads = []
  const persistedSnapshots = []

  async function queryAsync(sql, params = []) {
    const normalizedSql = String(sql || '').replace(/\s+/g, ' ').trim()

    if (normalizedSql.startsWith('CREATE TABLE IF NOT EXISTS next_best_visit_profile_snapshot_state')) {
      return []
    }
    if (normalizedSql.startsWith('CREATE TABLE IF NOT EXISTS next_best_visit_profile_snapshots')) {
      return []
    }
    if (normalizedSql.startsWith('CREATE TABLE IF NOT EXISTS next_best_visit_client_profiles')) {
      return []
    }
    if (normalizedSql.startsWith('INSERT INTO next_best_visit_profile_snapshot_state')) {
      return []
    }
    if (normalizedSql.startsWith('UPDATE next_best_visit_profile_snapshot_state SET rebuild_status = \'rebuilding\'')) {
      return []
    }
    if (normalizedSql.startsWith('SELECT (SELECT COUNT(*) FROM clients c')) {
      return [sourceFingerprint]
    }
    if (normalizedSql.startsWith('SELECT c.id AS client_id,')) {
      return activeClients
    }
    if (normalizedSql.startsWith('INSERT INTO next_best_visit_profile_snapshots')) {
      persistedSnapshots.push({
        profile_version: params[0],
        source_data_version: params[1],
        profile_schema_version: params[2],
        cadence_algorithm_version: params[3],
        historical_cutoff_date: params[4],
        clients_count: params[5]
      })
      return []
    }
    if (normalizedSql.startsWith('DELETE FROM next_best_visit_client_profiles')) {
      return []
    }
    if (normalizedSql.startsWith('INSERT INTO next_best_visit_client_profiles')) {
      for (let index = 0; index < params.length; index += 21) {
        persistedProfilePayloads.push(JSON.parse(params[index + 18]))
      }
      return []
    }
    if (normalizedSql.startsWith('UPDATE next_best_visit_profile_snapshots SET is_active = CASE WHEN profile_version = ? THEN 1 ELSE 0 END')) {
      return []
    }
    if (normalizedSql.startsWith('UPDATE next_best_visit_profile_snapshot_state SET active_profile_version = ?,')) {
      return []
    }
    if (normalizedSql.startsWith('UPDATE next_best_visit_profile_snapshot_state SET rebuild_status = ?')) {
      return []
    }

    return []
  }

  queryAsync.__persistedProfilePayloads = persistedProfilePayloads
  queryAsync.__persistedSnapshots = persistedSnapshots
  return queryAsync
}

test('changing planning_start_date alone with no newer data keeps the active snapshot ready', async () => {
  const baseFingerprint = {
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 10,
    max_sale_date: '2026-08-09',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  }
  const sourceDataVersion = buildNextBestVisitSourceDataVersion(baseFingerprint)
  const profileVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion
  })

  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint: baseFingerprint,
    stateRow: {
      scope_key: 'default',
      active_profile_version: profileVersion,
      rebuild_status: 'ready',
      latest_error_message: null,
      rebuilding_started_at: null,
      last_completed_at: '2026-08-10 08:00:00'
    },
    activeSnapshotRow: {
      profile_version: profileVersion,
      source_data_version: sourceDataVersion,
      profile_schema_version: '2026-08-04-d3-profile-schema-v2',
      cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
      historical_cutoff_date: '2026-08-09',
      snapshot_status: 'ready',
      clients_count: 2,
      computed_at: '2026-08-10 08:00:00',
      source_metrics_json: JSON.stringify(baseFingerprint),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const firstState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-08-10'
  })
  const laterPlanningState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-09-15'
  })

  assert.equal(resolveRequiredHistoricalCutoffDate({
    planningStartDate: '2026-09-15',
    sourceFingerprint: {
      ...baseFingerprint,
      latest_available_relevant_source_data_date: '2026-08-09'
    }
  }), '2026-08-09')
  assert.equal(firstState.status, 'ready')
  assert.equal(laterPlanningState.status, 'ready')
  assert.equal(laterPlanningState.required_historical_cutoff_date, '2026-08-09')
  assert.equal(laterPlanningState.required_profile_version, profileVersion)
})

test('planning_start_date-driven rebuild uses the planning cutoff instead of a future source max sale date', async () => {
  const sourceFingerprint = {
    active_clients_count: 1,
    max_client_id: '927',
    sales_rows_count: 1,
    max_sale_date: '2035-02-15',
    visits_rows_count: 0,
    max_visit_date: null
  }
  const queryAsync = createRebuildQueryMock({
    sourceFingerprint,
    activeClients: [{
      client_id: '927',
      client_code: '00927',
      nom: 'Client 00927'
    }]
  })
  const salesReferenceDates = []
  const visitReferenceDates = []

  const result = await runNextBestVisitProfileRebuildNow({
    queryAsync,
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async ({ referenceDate }) => {
      salesReferenceDates.push(referenceDate)
      return { rows: [], activeIndexes: [] }
    },
    normalizeSalesHistoryRowsForClients: () => new Map([
      ['927', [{
        purchase_date: '2025-12-23',
        order_value: 100,
        order_quantity: 1
      }]]
    ]),
    queryVisitHistoryRowsForClients: async ({ referenceDate }) => {
      visitReferenceDates.push(referenceDate)
      return { rows: [], activeIndexes: [] }
    },
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-14',
    historicalCutoffDate: null,
    readProfileSnapshotStateImpl: async () => ({
      status: 'missing'
    })
  })

  assert.equal(result.status, 'success')
  assert.deepEqual(salesReferenceDates, ['2026-08-13'])
  assert.deepEqual(visitReferenceDates, ['2026-08-13'])
  assert.notEqual(salesReferenceDates[0], '2035-02-15')
  assert.equal(queryAsync.__persistedProfilePayloads.length, 1)
  assert.equal(queryAsync.__persistedSnapshots.length, 1)
  assert.equal(queryAsync.__persistedSnapshots[0].historical_cutoff_date, '2026-08-13')
  assert.equal(
    queryAsync.__persistedSnapshots[0].profile_version,
    buildNextBestVisitProfileVersion({
      sourceDataVersion: sourceFingerprint.source_data_version,
      historicalCutoffDate: resolveProfileVersionHistoricalCutoffDate({
        historicalCutoffDate: '2026-08-13',
        sourceFingerprint
      })
    })
  )
  assert.equal(queryAsync.__persistedProfilePayloads[0].last_purchase_date, '2025-12-23')
  assert.equal(queryAsync.__persistedProfilePayloads[0].days_since_last_purchase, 233)
})

test('required cutoff advances from D-1 2026-08-13 to D-1 2026-08-14 as planning date moves from 2026-08-14 to 2026-08-15', () => {
  const sourceFingerprint = {
    active_clients_count: 1,
    max_client_id: '233',
    sales_rows_count: 12,
    max_sale_date: '2026-08-14',
    visits_rows_count: 2,
    max_visit_date: '2026-08-12'
  }

  assert.equal(resolveRequiredHistoricalCutoffDate({
    planningStartDate: '2026-08-14',
    historicalCutoffDate: null,
    sourceFingerprint
  }), '2026-08-13')

  assert.equal(resolveRequiredHistoricalCutoffDate({
    planningStartDate: '2026-08-15',
    historicalCutoffDate: null,
    sourceFingerprint
  }), '2026-08-14')
})

test('snapshot built for cutoff 2026-08-13 becomes stale when plan 2026-08-15 requires cutoff 2026-08-14', async () => {
  const sourceFingerprint = {
    active_clients_count: 1,
    max_client_id: '233',
    sales_rows_count: 12,
    max_sale_date: '2026-08-14',
    visits_rows_count: 2,
    max_visit_date: '2026-08-12'
  }
  const sourceDataVersion = buildNextBestVisitSourceDataVersion(sourceFingerprint)
  const cutoff13ProfileVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion,
    historicalCutoffDate: resolveProfileVersionHistoricalCutoffDate({
      historicalCutoffDate: '2026-08-13',
      sourceFingerprint
    })
  })
  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint,
    stateRow: {
      scope_key: 'default',
      active_profile_version: cutoff13ProfileVersion,
      rebuild_status: 'ready',
      latest_error_message: null,
      rebuilding_started_at: null,
      last_completed_at: '2026-08-13 08:00:00'
    },
    activeSnapshotRow: {
      profile_version: cutoff13ProfileVersion,
      source_data_version: sourceDataVersion,
      profile_schema_version: '2026-08-04-d3-profile-schema-v2',
      cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
      historical_cutoff_date: '2026-08-13',
      snapshot_status: 'ready',
      clients_count: 1,
      computed_at: '2026-08-13 08:00:00',
      source_metrics_json: JSON.stringify(sourceFingerprint),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const snapshotState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-08-15'
  })

  assert.equal(snapshotState.required_historical_cutoff_date, '2026-08-14')
  assert.equal(snapshotState.status, 'stale')
  assert.notEqual(snapshotState.required_profile_version, cutoff13ProfileVersion)
})

test('explicit historical cutoff is preserved for required cutoff and rebuilt snapshot persistence', async () => {
  const sourceFingerprint = {
    active_clients_count: 1,
    max_client_id: '233',
    sales_rows_count: 12,
    max_sale_date: '2026-08-14',
    visits_rows_count: 2,
    max_visit_date: '2026-08-12'
  }
  assert.equal(resolveRequiredHistoricalCutoffDate({
    planningStartDate: '2026-08-15',
    historicalCutoffDate: '2026-08-12',
    sourceFingerprint
  }), '2026-08-12')

  const queryAsync = createRebuildQueryMock({
    sourceFingerprint,
    activeClients: [{
      client_id: '233',
      client_code: '00233',
      nom: 'Client 00233'
    }]
  })

  const result = await runNextBestVisitProfileRebuildNow({
    queryAsync,
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async ({ referenceDate }) => {
      assert.equal(referenceDate, '2026-08-12')
      return { rows: [], activeIndexes: [] }
    },
    normalizeSalesHistoryRowsForClients: () => new Map([
      ['233', [{
        purchase_date: '2026-08-03',
        order_value: 100,
        order_quantity: 1
      }]]
    ]),
    queryVisitHistoryRowsForClients: async ({ referenceDate }) => {
      assert.equal(referenceDate, '2026-08-12')
      return { rows: [], activeIndexes: [] }
    },
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-15',
    historicalCutoffDate: '2026-08-12',
    readProfileSnapshotStateImpl: async () => ({
      status: 'missing'
    })
  })

  assert.equal(result.historical_cutoff_date, '2026-08-12')
  assert.equal(queryAsync.__persistedSnapshots.length, 1)
  assert.equal(queryAsync.__persistedSnapshots[0].historical_cutoff_date, '2026-08-12')
})

test('READY snapshot plus planning_start_date next day stays ready with no rebuild when snapshot already covers latest source data', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const currentSourceFingerprint = {
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 14,
    max_sale_date: '2026-08-11',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  }
  const sourceDataVersion = buildNextBestVisitSourceDataVersion(currentSourceFingerprint)
  const latestReadyProfileVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion
  })
  let rebuildCalls = 0

  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint: currentSourceFingerprint,
    stateRow: {
      scope_key: 'default',
      active_profile_version: latestReadyProfileVersion,
      rebuild_status: 'ready',
      latest_error_message: null,
      rebuilding_started_at: null,
      last_completed_at: '2026-08-11 07:00:00'
    },
    activeSnapshotRow: {
      profile_version: latestReadyProfileVersion,
      source_data_version: sourceDataVersion,
      profile_schema_version: '2026-08-04-d3-profile-schema-v2',
      cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
      historical_cutoff_date: '2026-08-11',
      snapshot_status: 'ready',
      clients_count: 2,
      computed_at: '2026-08-11 07:00:00',
      source_metrics_json: JSON.stringify(currentSourceFingerprint),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const plannerState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-08-12'
  })
  assert.equal(plannerState.status, 'ready')

  const readinessResult = await ensureNextBestVisitProfilesReady({
    queryAsync,
    planningStartDate: '2026-08-12',
    readProfileSnapshotStateImpl: readProfileSnapshotState,
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return { status: 'success' }
    }
  })

  assert.equal(readinessResult.status, 'ready')
  assert.equal(rebuildCalls, 0)
})

test('READY snapshot plus later future planning date stays ready when source data is unchanged', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const currentSourceFingerprint = {
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 14,
    max_sale_date: '2026-08-11',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  }
  const sourceDataVersion = buildNextBestVisitSourceDataVersion(currentSourceFingerprint)
  const latestReadyProfileVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion
  })
  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint: currentSourceFingerprint,
    stateRow: {
      scope_key: 'default',
      active_profile_version: latestReadyProfileVersion,
      rebuild_status: 'ready',
      latest_error_message: null,
      rebuilding_started_at: null,
      last_completed_at: '2026-08-11 07:00:00'
    },
    activeSnapshotRow: {
      profile_version: latestReadyProfileVersion,
      source_data_version: sourceDataVersion,
      profile_schema_version: '2026-08-04-d3-profile-schema-v2',
      cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
      historical_cutoff_date: '2026-08-11',
      snapshot_status: 'ready',
      clients_count: 2,
      computed_at: '2026-08-11 07:00:00',
      source_metrics_json: JSON.stringify(currentSourceFingerprint),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const laterPlanningState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-09-15'
  })

  assert.equal(laterPlanningState.status, 'ready')
  assert.equal(laterPlanningState.required_historical_cutoff_date, '2026-08-11')
})

test('newer relevant source data makes the active snapshot stale', async () => {
  const staleFingerprint = {
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 12,
    max_sale_date: '2026-08-12',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  }
  const activeSourceFingerprint = {
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 10,
    max_sale_date: '2026-08-09',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  }
  const activeSourceDataVersion = buildNextBestVisitSourceDataVersion(activeSourceFingerprint)
  const activeProfileVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion: activeSourceDataVersion
  })

  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint: staleFingerprint,
    stateRow: {
      scope_key: 'default',
      active_profile_version: activeProfileVersion,
      rebuild_status: 'ready',
      latest_error_message: null,
      rebuilding_started_at: null,
      last_completed_at: '2026-08-10 08:00:00'
    },
    activeSnapshotRow: {
      profile_version: activeProfileVersion,
      source_data_version: activeSourceDataVersion,
      profile_schema_version: '2026-08-04-d3-profile-schema-v2',
      cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
      historical_cutoff_date: '2026-08-09',
      snapshot_status: 'ready',
      clients_count: 2,
      computed_at: '2026-08-10 08:00:00',
      source_metrics_json: JSON.stringify(activeSourceFingerprint),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const snapshotState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-08-20'
  })

  assert.equal(snapshotState.status, 'stale')
  assert.equal(snapshotState.required_historical_cutoff_date, '2026-08-12')
  assert.notEqual(snapshotState.required_profile_version, activeProfileVersion)
})

test('same snapshot plus different future planning_start_date computes the same canonical required_version', async () => {
  const sourceFingerprint = {
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 14,
    max_sale_date: '2026-08-11',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  }
  const sourceDataVersion = buildNextBestVisitSourceDataVersion(sourceFingerprint)
  const canonicalProfileVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion
  })
  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint,
    stateRow: {
      scope_key: 'default',
      active_profile_version: 'legacy-profile-storage-key',
      rebuild_status: 'ready',
      latest_error_message: null,
      rebuilding_started_at: null,
      last_completed_at: '2026-08-11 07:00:00'
    },
    activeSnapshotRow: {
      profile_version: 'legacy-profile-storage-key',
      source_data_version: sourceDataVersion,
      profile_schema_version: '2026-08-04-d3-profile-schema-v2',
      cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
      historical_cutoff_date: '2026-08-11',
      snapshot_status: 'ready',
      clients_count: 2,
      computed_at: '2026-08-11 07:00:00',
      source_metrics_json: JSON.stringify(sourceFingerprint),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const nextDayState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-08-12'
  })
  const laterFutureState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-09-01'
  })

  assert.equal(nextDayState.required_profile_version, canonicalProfileVersion)
  assert.equal(laterFutureState.required_profile_version, canonicalProfileVersion)
  assert.equal(nextDayState.status, 'ready')
  assert.equal(laterFutureState.status, 'ready')
})

test('same snapshot plus different horizon/commercials/capacity/objective still uses the same canonical required_version', () => {
  const sourceDataVersion = buildNextBestVisitSourceDataVersion({
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 14,
    max_sale_date: '2026-08-11',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  })

  const baseVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion
  })
  const horizonVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion,
    planningHorizonDays: 30
  })
  const commercialVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion,
    commercialCodes: ['C01', 'VL1900']
  })
  const capacityVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion,
    maxVisitsPerDay: 12,
    minVisitsPerDayPreference: 8
  })
  const objectiveVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion,
    objectiveMode: 'maximize_ca'
  })

  assert.equal(horizonVersion, baseVersion)
  assert.equal(commercialVersion, baseVersion)
  assert.equal(capacityVersion, baseVersion)
  assert.equal(objectiveVersion, baseVersion)
})

test('profile schema change changes the canonical required_version and requires rebuild', async () => {
  const sourceFingerprint = {
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 14,
    max_sale_date: '2026-08-11',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  }
  const sourceDataVersion = buildNextBestVisitSourceDataVersion(sourceFingerprint)
  const legacyProfileVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion,
    profileSchemaVersion: 'legacy-schema-v1'
  })
  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint,
    stateRow: {
      scope_key: 'default',
      active_profile_version: legacyProfileVersion,
      rebuild_status: 'ready',
      latest_error_message: null,
      rebuilding_started_at: null,
      last_completed_at: '2026-08-11 07:00:00'
    },
    activeSnapshotRow: {
      profile_version: legacyProfileVersion,
      source_data_version: sourceDataVersion,
      profile_schema_version: 'legacy-schema-v1',
      cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
      historical_cutoff_date: '2026-08-11',
      snapshot_status: 'ready',
      clients_count: 2,
      computed_at: '2026-08-11 07:00:00',
      source_metrics_json: JSON.stringify(sourceFingerprint),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const snapshotState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-08-12'
  })

  assert.equal(snapshotState.status, 'stale')
  assert.notEqual(snapshotState.required_profile_version, legacyProfileVersion)
})

test('cadence/profile algorithm change changes the canonical required_version and requires rebuild', async () => {
  const sourceFingerprint = {
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 14,
    max_sale_date: '2026-08-11',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  }
  const sourceDataVersion = buildNextBestVisitSourceDataVersion(sourceFingerprint)
  const legacyProfileVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion,
    cadenceAlgorithmVersion: 'legacy-cadence-v0'
  })
  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint,
    stateRow: {
      scope_key: 'default',
      active_profile_version: legacyProfileVersion,
      rebuild_status: 'ready',
      latest_error_message: null,
      rebuilding_started_at: null,
      last_completed_at: '2026-08-11 07:00:00'
    },
    activeSnapshotRow: {
      profile_version: legacyProfileVersion,
      source_data_version: sourceDataVersion,
      profile_schema_version: '2026-08-04-d3-profile-schema-v2',
      cadence_algorithm_version: 'legacy-cadence-v0',
      historical_cutoff_date: '2026-08-11',
      snapshot_status: 'ready',
      clients_count: 2,
      computed_at: '2026-08-11 07:00:00',
      source_metrics_json: JSON.stringify(sourceFingerprint),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const snapshotState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-08-12'
  })

  assert.equal(snapshotState.status, 'stale')
  assert.notEqual(snapshotState.required_profile_version, legacyProfileVersion)
})

test('readiness returns ready for multiple future dates without starting rebuild when canonical profile version is unchanged', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const sourceFingerprint = {
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 14,
    max_sale_date: '2026-08-11',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  }
  const sourceDataVersion = buildNextBestVisitSourceDataVersion(sourceFingerprint)
  let rebuildCalls = 0
  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint,
    stateRow: {
      scope_key: 'default',
      active_profile_version: 'legacy-profile-storage-key',
      rebuild_status: 'ready',
      latest_error_message: null,
      rebuilding_started_at: null,
      last_completed_at: '2026-08-11 07:00:00'
    },
    activeSnapshotRow: {
      profile_version: 'legacy-profile-storage-key',
      source_data_version: sourceDataVersion,
      profile_schema_version: '2026-08-04-d3-profile-schema-v2',
      cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
      historical_cutoff_date: '2026-08-11',
      snapshot_status: 'ready',
      clients_count: 2,
      computed_at: '2026-08-11 07:00:00',
      source_metrics_json: JSON.stringify(sourceFingerprint),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const dates = ['2026-08-11', '2026-08-20', '2026-09-01']
  for (const planningStartDate of dates) {
    const readinessResult = await ensureNextBestVisitProfilesReady({
      queryAsync,
      planningStartDate,
      readProfileSnapshotStateImpl: readProfileSnapshotState,
      rebuildNowImpl: async () => {
        rebuildCalls += 1
        return { status: 'success' }
      }
    })
    assert.equal(readinessResult.status, 'ready')
  }

  assert.equal(rebuildCalls, 0)
})

test('startup readiness and planner readiness compute exactly the same canonical profile version', async () => {
  const sourceFingerprint = {
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 14,
    max_sale_date: '2026-08-11',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  }
  const sourceDataVersion = buildNextBestVisitSourceDataVersion(sourceFingerprint)
  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint,
    stateRow: {
      scope_key: 'default',
      active_profile_version: 'legacy-profile-storage-key',
      rebuild_status: 'ready',
      latest_error_message: null,
      rebuilding_started_at: null,
      last_completed_at: '2026-08-11 07:00:00'
    },
    activeSnapshotRow: {
      profile_version: 'legacy-profile-storage-key',
      source_data_version: sourceDataVersion,
      profile_schema_version: '2026-08-04-d3-profile-schema-v2',
      cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
      historical_cutoff_date: '2026-08-11',
      snapshot_status: 'ready',
      clients_count: 2,
      computed_at: '2026-08-11 07:00:00',
      source_metrics_json: JSON.stringify(sourceFingerprint),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const startupState = await readProfileSnapshotState(queryAsync)
  const plannerState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-09-01'
  })

  assert.equal(startupState.required_profile_version, plannerState.required_profile_version)
  assert.equal(startupState.required_profile_version, buildNextBestVisitProfileVersion({ sourceDataVersion }))
  assert.equal(startupState.status, 'ready')
  assert.equal(plannerState.status, 'ready')
})

test('ready snapshot returns immediately without starting a rebuild', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  let rebuildCalls = 0

  const result = await ensureNextBestVisitProfilesReady({
    queryAsync: async () => [],
    planningStartDate: '2026-08-20',
    readProfileSnapshotStateImpl: async () => ({
      status: 'ready',
      required_profile_version: 'profile-ready',
      required_historical_cutoff_date: '2026-08-09',
      source_fingerprint: {
        source_data_version: 'source-v1'
      },
      snapshot: {
        clients_count: 2
      }
    }),
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return { status: 'success' }
    }
  })

  assert.equal(result.status, 'ready')
  assert.equal(rebuildCalls, 0)
})

test('real profile version change still requires a rebuild', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  let rebuildCalls = 0

  const result = await ensureNextBestVisitProfilesReady({
    queryAsync: async () => [],
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    readProfileSnapshotStateImpl: async () => ({
      status: 'stale',
      required_profile_version: 'profile-schema-v2',
      required_historical_cutoff_date: '2026-08-11',
      source_fingerprint: {
        source_data_version: 'source-v1'
      },
      snapshot: {
        profile_schema_version: 'legacy-schema',
        historical_cutoff_date: '2026-08-11'
      },
      rebuilding_started_at: null
    }),
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return { status: 'success' }
    }
  })

  assert.equal(result.status, 'building')
  assert.equal(rebuildCalls, 1)
  await readinessTestables.getInFlightRebuildState().promise
})

test('missing snapshot starts exactly one rebuild across simultaneous readiness calls', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const deferred = createDeferred()
  let rebuildCalls = 0

  const resultPromises = await Promise.all([
    ensureNextBestVisitProfilesReady({
      queryAsync: async () => [],
      withTransaction: async handler => handler({}),
      querySalesHistoryRowsForClients: async () => [],
      normalizeSalesHistoryRowsForClients: () => new Map(),
      queryVisitHistoryRowsForClients: async () => [],
      normalizeVisitHistoryRowsForClients: () => new Map(),
      planningStartDate: '2026-08-20',
      readProfileSnapshotStateImpl: async () => ({
        status: 'missing',
        required_profile_version: 'profile-missing',
        required_historical_cutoff_date: '2026-08-09',
        source_fingerprint: {
          source_data_version: 'source-v1'
        },
        snapshot: null,
        rebuilding_started_at: null
      }),
      rebuildNowImpl: async () => {
        rebuildCalls += 1
        return deferred.promise
      }
    }),
    ensureNextBestVisitProfilesReady({
      queryAsync: async () => [],
      withTransaction: async handler => handler({}),
      querySalesHistoryRowsForClients: async () => [],
      normalizeSalesHistoryRowsForClients: () => new Map(),
      queryVisitHistoryRowsForClients: async () => [],
      normalizeVisitHistoryRowsForClients: () => new Map(),
      planningStartDate: '2026-08-20',
      readProfileSnapshotStateImpl: async () => ({
        status: 'missing',
        required_profile_version: 'profile-missing',
        required_historical_cutoff_date: '2026-08-09',
        source_fingerprint: {
          source_data_version: 'source-v1'
        },
        snapshot: null,
        rebuilding_started_at: null
      }),
      rebuildNowImpl: async () => {
        rebuildCalls += 1
        return deferred.promise
      }
    })
  ])

  assert.equal(resultPromises[0].status, 'building')
  assert.equal(resultPromises[1].status, 'building')
  assert.equal(rebuildCalls, 1)
  const inFlightPromise = readinessTestables.getInFlightRebuildState().promise
  assert.equal(Boolean(inFlightPromise), true)

  deferred.resolve({ status: 'success' })
  await inFlightPromise
})

test('stale snapshot starts exactly one rebuild', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const deferred = createDeferred()
  let rebuildCalls = 0

  const result = await ensureNextBestVisitProfilesReady({
    queryAsync: async () => [],
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    readProfileSnapshotStateImpl: async () => ({
      status: 'stale',
      required_profile_version: 'profile-stale',
      required_historical_cutoff_date: '2026-08-12',
      source_fingerprint: {
        source_data_version: 'source-v2'
      },
      snapshot: {
        historical_cutoff_date: '2026-08-09'
      },
      rebuilding_started_at: null
    }),
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return deferred.promise
    }
  })

  assert.equal(result.status, 'building')
  assert.equal(rebuildCalls, 1)
  const inFlightPromise = readinessTestables.getInFlightRebuildState().promise
  deferred.resolve({ status: 'success' })
  await inFlightPromise
})

test('failed rebuild exposes failed state without leaving a permanent lock', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const deferred = createDeferred()
  let rebuildCalls = 0
  let currentStatus = 'missing'

  const readProfileSnapshotStateImpl = async () => ({
    status: currentStatus,
    required_profile_version: 'profile-failed',
    required_historical_cutoff_date: '2026-08-12',
    source_fingerprint: {
      source_data_version: 'source-v2'
    },
    snapshot: null,
    rebuilding_started_at: null,
    latest_error_message: currentStatus === 'failed' ? 'boom' : null
  })

  const firstResult = await ensureNextBestVisitProfilesReady({
    queryAsync: async () => [],
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    readProfileSnapshotStateImpl,
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return deferred.promise
    }
  })

  assert.equal(firstResult.status, 'building')
  currentStatus = 'failed'
  const inFlightPromise = readinessTestables.getInFlightRebuildState().promise
  deferred.reject(new Error('boom'))
  await assert.rejects(() => inFlightPromise, /boom/)
  assert.equal(readinessTestables.getInFlightRebuildState().promise, null)

  const failedResult = await ensureNextBestVisitProfilesReady({
    queryAsync: async () => [],
    planningStartDate: '2026-08-20',
    readProfileSnapshotStateImpl
  })

  assert.equal(failedResult.status, 'failed')
  assert.equal(rebuildCalls, 1)
})

test('retry after failure starts a new rebuild', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const deferred = createDeferred()
  let rebuildCalls = 0

  const result = await ensureNextBestVisitProfilesReady({
    queryAsync: async () => [],
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    forceRetry: true,
    readProfileSnapshotStateImpl: async () => ({
      status: 'failed',
      required_profile_version: 'profile-retry',
      required_historical_cutoff_date: '2026-08-12',
      source_fingerprint: {
        source_data_version: 'source-v2'
      },
      snapshot: null,
      rebuilding_started_at: null,
      latest_error_message: 'previous failure'
    }),
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return deferred.promise
    }
  })

  assert.equal(result.status, 'building')
  assert.equal(rebuildCalls, 1)
  const inFlightPromise = readinessTestables.getInFlightRebuildState().promise
  deferred.resolve({ status: 'success' })
  await inFlightPromise
})

test('ready snapshot without forceRetry returns ready without starting a rebuild', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  let rebuildCalls = 0

  const result = await ensureNextBestVisitProfilesReady({
    queryAsync: async () => [],
    planningStartDate: '2026-08-20',
    forceRetry: false,
    readProfileSnapshotStateImpl: async () => ({
      status: 'ready',
      required_profile_version: 'profile-ready',
      required_historical_cutoff_date: '2026-08-12',
      source_fingerprint: {
        source_data_version: 'source-v2'
      },
      snapshot: {
        profile_version: 'profile-ready'
      },
      rebuilding_started_at: null
    }),
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return { status: 'success' }
    }
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.rebuildStarted, false)
  assert.equal(result.reusedInFlightRebuild, false)
  assert.equal(rebuildCalls, 0)
})

test('ready snapshot with forceRetry starts the rebuild path', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const deferred = createDeferred()
  let rebuildCalls = 0

  const result = await ensureNextBestVisitProfilesReady({
    queryAsync: async () => [],
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    forceRetry: true,
    readProfileSnapshotStateImpl: async () => ({
      status: 'ready',
      required_profile_version: 'profile-ready',
      required_historical_cutoff_date: '2026-08-12',
      source_fingerprint: {
        source_data_version: 'source-v2'
      },
      snapshot: {
        profile_version: 'profile-ready'
      },
      rebuilding_started_at: null
    }),
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return deferred.promise
    }
  })

  assert.equal(result.status, 'building')
  assert.equal(result.rebuildStarted, true)
  assert.equal(result.reusedInFlightRebuild, false)
  assert.equal(rebuildCalls, 1)
  const inFlightPromise = readinessTestables.getInFlightRebuildState().promise
  deferred.resolve({ status: 'success' })
  await inFlightPromise
})

test('persisted building with no in-flight job is recovered and starts exactly one rebuild', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  let rebuildCalls = 0
  const deferred = createDeferred()
  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint: {
      active_clients_count: 2,
      max_client_id: '200',
      sales_rows_count: 14,
      max_sale_date: '2026-08-11',
      visits_rows_count: 4,
      max_visit_date: '2026-08-08'
    },
    stateRow: {
      scope_key: 'default',
      active_profile_version: 'legacy-stored-key',
      rebuild_status: 'rebuilding',
      latest_error_message: null,
      rebuilding_started_at: '2026-08-11 16:47:07',
      last_completed_at: '2026-08-10 15:48:03'
    },
    activeSnapshotRow: {
      profile_version: 'legacy-stored-key',
      source_data_version: buildNextBestVisitSourceDataVersion({
        active_clients_count: 2,
        max_client_id: '200',
        sales_rows_count: 10,
        max_sale_date: '2026-08-09',
        visits_rows_count: 4,
        max_visit_date: '2026-08-08'
      }),
      profile_schema_version: '2026-08-04-d3-profile-schema-v2',
      cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
      historical_cutoff_date: '2026-08-09',
      snapshot_status: 'ready',
      clients_count: 2,
      computed_at: '2026-08-10 15:48:03',
      source_metrics_json: JSON.stringify({}),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const result = await ensureNextBestVisitProfilesReady({
    queryAsync,
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return deferred.promise
    }
  })

  assert.equal(result.status, 'building')
  assert.equal(rebuildCalls, 1)
  assert.equal(queryAsync.__stateRow.rebuild_status, 'stale')
  assert.equal(queryAsync.__stateRow.latest_error_message, 'rebuild_timed_out')
  const inFlightPromise = readinessTestables.getInFlightRebuildState().promise
  deferred.resolve({ status: 'success' })
  await inFlightPromise
})

test('persisted building from previous process is not reused as an active job', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  let rebuildCalls = 0

  const result = await ensureNextBestVisitProfilesReady({
    queryAsync: createSnapshotStateQueryMock({
      sourceFingerprint: {
        active_clients_count: 2,
        max_client_id: '200',
        sales_rows_count: 14,
        max_sale_date: '2026-08-11',
        visits_rows_count: 4,
        max_visit_date: '2026-08-08'
      },
      stateRow: {
        scope_key: 'default',
        active_profile_version: 'legacy-stored-key',
        rebuild_status: 'rebuilding',
        latest_error_message: null,
        rebuilding_started_at: '2026-08-11 16:47:07',
        last_completed_at: '2026-08-10 15:48:03'
      },
      activeSnapshotRow: null
    }),
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return { status: 'success' }
    }
  })

  assert.equal(result.reusedInFlightRebuild, false)
  assert.equal(rebuildCalls, 1)
  await readinessTestables.getInFlightRebuildState().promise
})

test('active current-process rebuild is reused as a single-flight job', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const deferred = createDeferred()
  let rebuildCalls = 0

  const readProfileSnapshotStateImpl = async () => ({
    status: 'missing',
    required_profile_version: 'profile-missing',
    required_historical_cutoff_date: '2026-08-09',
    source_fingerprint: {
      source_data_version: 'source-v1'
    },
    snapshot: null,
    rebuilding_started_at: null
  })

  const first = await ensureNextBestVisitProfilesReady({
    queryAsync: async () => [],
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    readProfileSnapshotStateImpl,
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return deferred.promise
    }
  })

  const second = await ensureNextBestVisitProfilesReady({
    queryAsync: async () => [],
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    readProfileSnapshotStateImpl: async () => ({
      status: 'building',
      required_profile_version: 'profile-missing',
      required_historical_cutoff_date: '2026-08-09',
      source_fingerprint: {
        source_data_version: 'source-v1'
      },
      snapshot: null,
      rebuilding_started_at: new Date().toISOString()
    }),
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return deferred.promise
    }
  })

  assert.equal(first.status, 'building')
  assert.equal(second.status, 'building')
  assert.equal(second.reusedInFlightRebuild, true)
  assert.equal(rebuildCalls, 1)

  deferred.resolve({ status: 'success' })
  await readinessTestables.getInFlightRebuildState().promise
})

test('stale building timeout is recovered automatically', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  let rebuildCalls = 0

  const result = await ensureNextBestVisitProfilesReady({
    queryAsync: createSnapshotStateQueryMock({
      sourceFingerprint: {
        active_clients_count: 2,
        max_client_id: '200',
        sales_rows_count: 14,
        max_sale_date: '2026-08-11',
        visits_rows_count: 4,
        max_visit_date: '2026-08-08'
      },
      stateRow: {
        scope_key: 'default',
        active_profile_version: 'legacy-stored-key',
        rebuild_status: 'rebuilding',
        latest_error_message: null,
        rebuilding_started_at: '2026-08-10 00:00:00',
        last_completed_at: '2026-08-09 00:00:00'
      },
      activeSnapshotRow: null
    }),
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    rebuildTimeoutMs: 1,
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return { status: 'success' }
    }
  })

  assert.equal(result.status, 'building')
  assert.equal(rebuildCalls, 1)
  await readinessTestables.getInFlightRebuildState().promise
})

test('successful recovery persists ready state with version equal to required_version', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const sourceFingerprint = {
    active_clients_count: 2,
    max_client_id: '200',
    sales_rows_count: 14,
    max_sale_date: '2026-08-11',
    visits_rows_count: 4,
    max_visit_date: '2026-08-08'
  }
  const sourceDataVersion = buildNextBestVisitSourceDataVersion(sourceFingerprint)
  const canonicalProfileVersion = buildNextBestVisitProfileVersion({
    sourceDataVersion
  })
  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint,
    stateRow: {
      scope_key: 'default',
      active_profile_version: 'legacy-stored-key',
      rebuild_status: 'rebuilding',
      latest_error_message: null,
      rebuilding_started_at: '2026-08-11 16:47:07',
      last_completed_at: '2026-08-10 15:48:03'
    },
    activeSnapshotRow: {
      profile_version: 'legacy-stored-key',
      source_data_version: buildNextBestVisitSourceDataVersion({
        ...sourceFingerprint,
        sales_rows_count: 10,
        max_sale_date: '2026-08-09'
      }),
      profile_schema_version: '2026-08-04-d3-profile-schema-v2',
      cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
      historical_cutoff_date: '2026-08-09',
      snapshot_status: 'ready',
      clients_count: 2,
      computed_at: '2026-08-10 15:48:03',
      source_metrics_json: JSON.stringify({}),
      timings_json: JSON.stringify({}),
      error_message: null,
      is_active: 1
    }
  })

  const startedResult = await ensureNextBestVisitProfilesReady({
    queryAsync,
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    rebuildNowImpl: async () => {
      queryAsync.__stateRow.active_profile_version = canonicalProfileVersion
      queryAsync.__stateRow.rebuild_status = 'ready'
      queryAsync.__stateRow.latest_error_message = null
      queryAsync.__stateRow.rebuilding_started_at = null
      queryAsync.__stateRow.last_completed_at = '2026-08-11 20:15:00'
      queryAsync.__setActiveSnapshotRow({
        profile_version: canonicalProfileVersion,
        source_data_version: sourceDataVersion,
        profile_schema_version: '2026-08-04-d3-profile-schema-v2',
        cadence_algorithm_version: '2026-08-04-d3-cadence-algorithm-v1',
        historical_cutoff_date: '2026-08-11',
        snapshot_status: 'ready',
        clients_count: 2,
        computed_at: '2026-08-11 20:15:00',
        source_metrics_json: JSON.stringify(sourceFingerprint),
        timings_json: JSON.stringify({}),
        error_message: null,
        is_active: 1
      })
      return {
        status: 'success',
        profile_version: canonicalProfileVersion
      }
    }
  })

  assert.equal(startedResult.status, 'building')
  await readinessTestables.getInFlightRebuildState().promise

  const recoveredState = await readProfileSnapshotState(queryAsync, {
    planningStartDate: '2026-08-20'
  })

  assert.equal(recoveredState.status, 'ready')
  assert.equal(recoveredState.active_profile_version, recoveredState.required_profile_version)
  assert.equal(recoveredState.active_profile_storage_version, canonicalProfileVersion)
  assert.equal(recoveredState.rebuilding_started_at, null)
  assert.notEqual(recoveredState.last_completed_at, null)
})

test('failed rebuild recovery marks failed, clears lock, and allows retry', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const deferred = createDeferred()
  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint: {
      active_clients_count: 2,
      max_client_id: '200',
      sales_rows_count: 14,
      max_sale_date: '2026-08-11',
      visits_rows_count: 4,
      max_visit_date: '2026-08-08'
    },
    stateRow: {
      scope_key: 'default',
      active_profile_version: 'legacy-stored-key',
      rebuild_status: 'rebuilding',
      latest_error_message: null,
      rebuilding_started_at: '2026-08-11 16:47:07',
      last_completed_at: '2026-08-10 15:48:03'
    },
    activeSnapshotRow: null
  })

  const first = await ensureNextBestVisitProfilesReady({
    queryAsync,
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    rebuildNowImpl: async () => {
      return deferred.promise
    }
  })

  assert.equal(first.status, 'building')
  const firstInFlightPromise = readinessTestables.getInFlightRebuildState().promise
  queryAsync.__stateRow.rebuild_status = 'failed'
  queryAsync.__stateRow.latest_error_message = 'boom'
  queryAsync.__stateRow.rebuilding_started_at = null
  deferred.reject(new Error('boom'))
  await assert.rejects(firstInFlightPromise, /boom/)
  assert.equal(readinessTestables.getInFlightRebuildState().promise, null)
  assert.equal(queryAsync.__stateRow.rebuild_status, 'failed')
  assert.equal(queryAsync.__stateRow.rebuilding_started_at, null)

  let retryCalls = 0
  const retry = await ensureNextBestVisitProfilesReady({
    queryAsync,
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    forceRetry: true,
    rebuildNowImpl: async () => {
      retryCalls += 1
      return { status: 'success' }
    }
  })

  assert.equal(retry.status, 'building')
  assert.equal(retryCalls, 1)
  await readinessTestables.getInFlightRebuildState().promise
})

test('restart during rebuild is recovered automatically by the next process', async () => {
  readinessTestables.resetNextBestVisitProfileReadinessStateForTests()
  const queryAsync = createSnapshotStateQueryMock({
    sourceFingerprint: {
      active_clients_count: 2,
      max_client_id: '200',
      sales_rows_count: 14,
      max_sale_date: '2026-08-11',
      visits_rows_count: 4,
      max_visit_date: '2026-08-08'
    },
    stateRow: {
      scope_key: 'default',
      active_profile_version: 'legacy-stored-key',
      rebuild_status: 'rebuilding',
      latest_error_message: null,
      rebuilding_started_at: '2026-08-11 16:47:07',
      last_completed_at: '2026-08-10 15:48:03'
    },
    activeSnapshotRow: null
  })

  let rebuildCalls = 0
  const result = await ensureNextBestVisitProfilesReady({
    queryAsync,
    withTransaction: async handler => handler({}),
    querySalesHistoryRowsForClients: async () => [],
    normalizeSalesHistoryRowsForClients: () => new Map(),
    queryVisitHistoryRowsForClients: async () => [],
    normalizeVisitHistoryRowsForClients: () => new Map(),
    planningStartDate: '2026-08-20',
    rebuildNowImpl: async () => {
      rebuildCalls += 1
      return { status: 'success' }
    }
  })

  assert.equal(result.status, 'building')
  assert.equal(rebuildCalls, 1)
  await readinessTestables.getInFlightRebuildState().promise
})

const {
  buildCadenceProfiles
} = require('./client_cadence_intelligence')
const {
  buildNextBestVisitProfileVersion,
  computeNextBestVisitSourceFingerprint,
  ensureProfileSnapshotTables,
  markProfileSnapshotRebuildFailed,
  markProfileSnapshotRebuildStarted,
  persistProfileSnapshot,
  resolveProfileVersionHistoricalCutoffDate
} = require('./next_best_visit_profile_snapshot_store')

function createPerfTracker() {
  const stages = []
  return {
    async run(stage, fn) {
      const startedAt = Date.now()
      try {
        return await fn()
      } finally {
        stages.push({
          stage: String(stage || 'unknown'),
          duration_ms: Math.max(0, Date.now() - startedAt)
        })
      }
    },
    stages() {
      return [...stages]
    }
  }
}

async function loadActiveClientsForProfileSnapshot(queryAsync) {
  return queryAsync(`
    SELECT
      c.id AS client_id,
      c.code AS client_code,
      c.nom,
      c.user_code,
      c.routing_code,
      c.delegation,
      c.region,
      c.potentiel,
      c.adresse_facturation AS adresse,
      c.latitude,
      c.longitude
    FROM clients c
    WHERE c.deleted_at IS NULL
      AND c.isactif = '1'
    ORDER BY c.nom, c.code
  `)
}

async function rebuildNextBestVisitProfileSnapshot({
  queryAsync,
  withTransaction,
  querySalesHistoryRowsForClients,
  normalizeSalesHistoryRowsForClients,
  queryVisitHistoryRowsForClients,
  normalizeVisitHistoryRowsForClients,
  historicalCutoffDate = null
}) {
  if (typeof queryAsync !== 'function') {
    throw new Error('queryAsync requis pour reconstruire le snapshot de profils V2.')
  }
  if (typeof withTransaction !== 'function') {
    throw new Error('withTransaction requis pour reconstruire le snapshot de profils V2.')
  }
  if (typeof querySalesHistoryRowsForClients !== 'function' || typeof normalizeSalesHistoryRowsForClients !== 'function') {
    throw new Error('query/normalize sales history requis pour reconstruire le snapshot de profils V2.')
  }
  if (typeof queryVisitHistoryRowsForClients !== 'function' || typeof normalizeVisitHistoryRowsForClients !== 'function') {
    throw new Error('query/normalize visit history requis pour reconstruire le snapshot de profils V2.')
  }

  const perf = createPerfTracker()
  await ensureProfileSnapshotTables(queryAsync)
  await markProfileSnapshotRebuildStarted(queryAsync)

  try {
    const sourceFingerprint = await perf.run('source_data_version_check', async () => computeNextBestVisitSourceFingerprint(queryAsync))
    const referenceDate = historicalCutoffDate || sourceFingerprint.max_sale_date || '2026-08-04'
    const activeClients = await perf.run('load_active_clients', async () => loadActiveClientsForProfileSnapshot(queryAsync))
    const salesHistoryByClientId = await perf.run('load_sales_history', async () => {
      const { rows, activeIndexes } = await perf.run('sales_history_query_ms', async () => querySalesHistoryRowsForClients({
        queryAsync,
        activeClients,
        referenceDate
      }))
      return perf.run('sales_history_normalization_ms', async () => normalizeSalesHistoryRowsForClients({
        rows,
        activeIndexes
      }))
    })
    const visitHistoryByClientId = await perf.run('load_visit_history', async () => {
      const { rows, activeIndexes } = await perf.run('visit_history_query_ms', async () => queryVisitHistoryRowsForClients({
        queryAsync,
        activeClients,
        referenceDate
      }))
      return perf.run('visit_history_normalization_ms', async () => normalizeVisitHistoryRowsForClients({
        rows,
        activeIndexes
      }))
    })
    const cadenceProfiles = await perf.run('load_or_build_cadence_profiles', async () => perf.run('cadence_profile_build_ms', async () => buildCadenceProfiles({
      clients: activeClients,
      salesHistoryByClientId,
      visitHistoryByClientId,
      referenceDate,
      maxDaysWithoutContact: null
    })))
    const profileVersionHistoricalCutoffDate = resolveProfileVersionHistoricalCutoffDate({
      historicalCutoffDate,
      sourceFingerprint
    })
    const profileVersion = buildNextBestVisitProfileVersion({
      sourceDataVersion: sourceFingerprint.source_data_version,
      historicalCutoffDate: profileVersionHistoricalCutoffDate
    })

    await withTransaction(async connection => {
      await perf.run('cadence_profile_cache_write_ms', async () => persistProfileSnapshot({
        queryAsync,
        connection,
        profileVersion,
        sourceDataVersion: sourceFingerprint.source_data_version,
        historicalCutoffDate,
        cadenceProfiles,
        sourceMetrics: sourceFingerprint,
        timings: {
          stages: perf.stages()
        }
      }))
    }, { logPrefix: 'NEXT_BEST_VISIT_PROFILE_REBUILD' })

    return {
      status: 'success',
      profile_snapshot_status: 'ready',
      profile_version: profileVersion,
      source_data_version: sourceFingerprint.source_data_version,
      historical_cutoff_date: historicalCutoffDate || null,
      active_clients_count: Array.isArray(activeClients) ? activeClients.length : 0,
      cadence_profiles_count: Array.isArray(cadenceProfiles) ? cadenceProfiles.length : 0,
      timings: {
        stages: perf.stages()
      }
    }
  } catch (error) {
    await markProfileSnapshotRebuildFailed(queryAsync, error.message || String(error))
    throw error
  }
}

module.exports = {
  rebuildNextBestVisitProfileSnapshot
}

const {
  DEFAULT_PROFILE_REBUILD_TIMEOUT_MS,
  hasProfileSnapshotRebuildTimedOut,
  markProfileSnapshotRebuildAbandoned,
  readProfileSnapshotState
} = require('./next_best_visit_profile_snapshot_store')
const {
  rebuildNextBestVisitProfileSnapshot
} = require('./next_best_visit_profile_snapshot_rebuilder')

let inFlightRebuildPromise = null
let inFlightRebuildMetadata = null

function createLogger(logger = console) {
  return {
    info(message, extra) {
      if (typeof logger?.info === 'function') {
        logger.info(message, extra)
      } else if (typeof logger?.log === 'function') {
        logger.log(message, extra)
      }
    },
    warn(message, extra) {
      if (typeof logger?.warn === 'function') {
        logger.warn(message, extra)
      } else if (typeof logger?.log === 'function') {
        logger.log(message, extra)
      }
    },
    error(message, extra) {
      if (typeof logger?.error === 'function') {
        logger.error(message, extra)
      } else if (typeof logger?.log === 'function') {
        logger.log(message, extra)
      }
    }
  }
}

async function runNextBestVisitProfileRebuildNow({
  queryAsync,
  withTransaction,
  querySalesHistoryRowsForClients,
  normalizeSalesHistoryRowsForClients,
  queryVisitHistoryRowsForClients,
  normalizeVisitHistoryRowsForClients,
  planningStartDate = null,
  historicalCutoffDate = null,
  readProfileSnapshotStateImpl = readProfileSnapshotState,
  rebuildNextBestVisitProfileSnapshotImpl = rebuildNextBestVisitProfileSnapshot
} = {}) {
  const snapshotState = await readProfileSnapshotStateImpl(queryAsync, {
    planningStartDate,
    historicalCutoffDate
  })

  return rebuildNextBestVisitProfileSnapshotImpl({
    queryAsync,
    withTransaction,
    querySalesHistoryRowsForClients,
    normalizeSalesHistoryRowsForClients,
    queryVisitHistoryRowsForClients,
    normalizeVisitHistoryRowsForClients,
    planningStartDate: planningStartDate || null,
    historicalCutoffDate: historicalCutoffDate || null
  })
}

function getInFlightRebuildState() {
  return {
    promise: inFlightRebuildPromise,
    metadata: inFlightRebuildMetadata
  }
}

function resetNextBestVisitProfileReadinessStateForTests() {
  inFlightRebuildPromise = null
  inFlightRebuildMetadata = null
}

async function ensureNextBestVisitProfilesReady({
  queryAsync,
  withTransaction,
  querySalesHistoryRowsForClients,
  normalizeSalesHistoryRowsForClients,
  queryVisitHistoryRowsForClients,
  normalizeVisitHistoryRowsForClients,
  planningStartDate = null,
  historicalCutoffDate = null,
  autoTriggerRebuild = true,
  forceRetry = false,
  rebuildTimeoutMs = DEFAULT_PROFILE_REBUILD_TIMEOUT_MS,
  logger = console,
  readProfileSnapshotStateImpl = readProfileSnapshotState,
  rebuildNowImpl = runNextBestVisitProfileRebuildNow,
  markProfileSnapshotRebuildAbandonedImpl = markProfileSnapshotRebuildAbandoned
} = {}) {
  if (typeof queryAsync !== 'function') {
    throw new Error('queryAsync requis pour assurer le readiness des profils V2.')
  }

  const safeLogger = createLogger(logger)
  let snapshotState = await readProfileSnapshotStateImpl(queryAsync, {
    planningStartDate,
    historicalCutoffDate
  })

  const hasInFlightRebuild = Boolean(inFlightRebuildPromise)
  const buildingStateTimedOut = snapshotState.status === 'building' && hasProfileSnapshotRebuildTimedOut(snapshotState, {
    timeoutMs: rebuildTimeoutMs
  })
  const buildingStateOrphaned = snapshotState.status === 'building' && !hasInFlightRebuild

  if (buildingStateOrphaned) {
    const recoveredStatus = snapshotState.snapshot ? 'stale' : 'missing'
    const recoveryReason = buildingStateTimedOut
      ? 'rebuild_timed_out'
      : 'abandoned_rebuild_recovered'

    safeLogger.warn('Recovering abandoned Next Best Visit profile rebuild state.', {
      previous_started_at: snapshotState.rebuilding_started_at || null,
      timed_out: buildingStateTimedOut,
      next_status: recoveredStatus
    })

    if (typeof markProfileSnapshotRebuildAbandonedImpl === 'function') {
      await markProfileSnapshotRebuildAbandonedImpl(queryAsync, {
        nextStatus: recoveredStatus,
        errorMessage: recoveryReason
      })
    }

    snapshotState = {
      ...snapshotState,
      status: recoveredStatus,
      rebuild_status: recoveredStatus,
      latest_error_message: recoveryReason,
      rebuilding_started_at: null
    }
  }

  if (snapshotState.status === 'ready' && !forceRetry) {
    return {
      status: 'ready',
      snapshotState,
      rebuildStarted: false,
      reusedInFlightRebuild: false
    }
  }

  if (snapshotState.status === 'building') {
    return {
      status: 'building',
      snapshotState,
      rebuildStarted: false,
      reusedInFlightRebuild: hasInFlightRebuild
    }
  }

  if (snapshotState.status === 'failed' && !forceRetry) {
    return {
      status: 'failed',
      snapshotState,
      rebuildStarted: false,
      reusedInFlightRebuild: false
    }
  }

  if (
    !autoTriggerRebuild ||
    typeof withTransaction !== 'function' ||
    typeof querySalesHistoryRowsForClients !== 'function' ||
    typeof normalizeSalesHistoryRowsForClients !== 'function' ||
    typeof queryVisitHistoryRowsForClients !== 'function' ||
    typeof normalizeVisitHistoryRowsForClients !== 'function'
  ) {
    return {
      status: snapshotState.status,
      snapshotState,
      rebuildStarted: false,
      reusedInFlightRebuild: false
    }
  }

  let reusedInFlightRebuild = false
  if (!inFlightRebuildPromise) {
    const startedAt = new Date().toISOString()
    inFlightRebuildMetadata = {
      started_at: startedAt,
      trigger: forceRetry ? 'retry' : 'auto'
    }
    inFlightRebuildPromise = (async () => {
      try {
        const result = await rebuildNowImpl({
          queryAsync,
          withTransaction,
          querySalesHistoryRowsForClients,
          normalizeSalesHistoryRowsForClients,
          queryVisitHistoryRowsForClients,
          normalizeVisitHistoryRowsForClients,
          planningStartDate,
          historicalCutoffDate,
          readProfileSnapshotStateImpl
        })
        safeLogger.info('Next Best Visit profiles rebuilt successfully.', {
          profile_version: result?.profile_version || null,
          historical_cutoff_date: result?.historical_cutoff_date || null
        })
        return result
      } catch (error) {
        safeLogger.error('Next Best Visit profile rebuild failed.', {
          message: error?.message || String(error)
        })
        throw error
      } finally {
        inFlightRebuildPromise = null
        inFlightRebuildMetadata = null
      }
    })()
  } else {
    reusedInFlightRebuild = true
    safeLogger.info('Reusing in-flight Next Best Visit profile rebuild.', {
      started_at: inFlightRebuildMetadata?.started_at || null
    })
  }

  return {
    status: 'building',
    snapshotState: {
      ...snapshotState,
      status: 'building',
      rebuilding_started_at: snapshotState.rebuilding_started_at || inFlightRebuildMetadata?.started_at || null
    },
    rebuildStarted: true,
    reusedInFlightRebuild
  }
}

module.exports = {
  ensureNextBestVisitProfilesReady,
  runNextBestVisitProfileRebuildNow,
  __testables: {
    getInFlightRebuildState,
    resetNextBestVisitProfileReadinessStateForTests
  }
}

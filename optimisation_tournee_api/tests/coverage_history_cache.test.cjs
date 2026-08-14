const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  CoverageHistoryCache,
  buildCoverageHistoryCacheKey,
  buildCoverageHistoryCacheKeyParts,
  clearCacheDirectory,
  summarizeCacheDirectory
} = require('../coverage_history_cache')
const {
  computeCoverageFunctionalResultHash
} = require('../coverage_functional_hash')

function createTempCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nomadis-coverage-cache-'))
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('persistent cache uses disk miss then memory hit then disk hit with deep-equal values', async () => {
  const cacheDir = createTempCacheDir()
  const events = []
  const cache = new CoverageHistoryCache({
    ttlMs: 1000,
    maxEntries: 8,
    diskEnabled: true,
    diskDir: cacheDir,
    logger: event => events.push(event)
  })
  let buildCount = 0

  const key = buildCoverageHistoryCacheKey({
    name: 'salesCapacityProfiles',
    startDate: '2026-07-31',
    historyWindowDays: 1095,
    commercialCodes: ['C01'],
    documentFilters: { doc_types: ['facture', 'bl', 'blf'] }
  })

  const first = await cache.getOrCreate({
    key,
    type: 'sales_profiles',
    build: async () => {
      buildCount += 1
      return { rows: [{ code: 'C01', totals: new Map([['1', 5]]) }] }
    }
  })
  const second = await cache.getOrCreate({
    key,
    type: 'sales_profiles',
    build: async () => {
      buildCount += 1
      return { rows: [{ code: 'C01', totals: new Map([['1', 99]]) }] }
    }
  })

  cache.clearMemory()
  const third = await cache.getOrCreate({
    key,
    type: 'sales_profiles',
    build: async () => {
      buildCount += 1
      return { rows: [{ code: 'C01', totals: new Map([['1', 777]]) }] }
    }
  })

  assert.equal(buildCount, 1)
  assert.deepEqual(first, second)
  assert.deepEqual(second, third)
  assert.notEqual(first, second)
  assert.equal(events[0].status, 'miss')
  assert.equal(events[1].status, 'hit_memory')
  assert.equal(events[2].status, 'hit_disk')
})

test('different data version, date and client ids produce cache misses', async () => {
  const cache = new CoverageHistoryCache({ ttlMs: 1000, maxEntries: 8 })
  let buildCount = 0

  const baseOptions = {
    name: 'buildCoverageClientHistorySnapshot',
    startDate: '2026-07-31',
    historyWindowDays: 1095,
    documentFilters: {
      document_history: { doc_types: ['facture', 'bl', 'blf'] },
      visit_history: { validation_status: 'validated' }
    },
    activeClientIds: ['10', '20'],
    database: 'dist_utic',
    logicalSchemaVersion: 'coverage_history_cache_v2',
    sqlVersion: 'client_history_snapshot_sql_v3',
    codeVersion: 'abc',
    dataVersion: '1'
  }

  const keys = [
    buildCoverageHistoryCacheKey(baseOptions),
    buildCoverageHistoryCacheKey({ ...baseOptions, dataVersion: '2' }),
    buildCoverageHistoryCacheKey({ ...baseOptions, startDate: '2026-08-01' }),
    buildCoverageHistoryCacheKey({ ...baseOptions, activeClientIds: ['10', '21'] })
  ]

  keys.forEach((key, index) => {
    if (index > 0) {
      assert.notEqual(keys[0], key)
    }
  })

  for (const key of keys) {
    await cache.getOrCreate({
      key,
      type: 'client_history',
      build: async () => {
        buildCount += 1
        return { buildCount }
      }
    })
  }

  assert.equal(buildCount, 4)
})

test('corrupted disk files are ignored and recalculated', async () => {
  const cacheDir = createTempCacheDir()
  const cache = new CoverageHistoryCache({
    ttlMs: 1000,
    maxEntries: 8,
    diskEnabled: true,
    diskDir: cacheDir
  })
  let buildCount = 0

  const key = buildCoverageHistoryCacheKey({
    name: 'validatedVisitCapacityProfiles',
    startDate: '2026-07-31',
    commercialCodes: ['C01'],
    documentFilters: { validation_status: 'validated' }
  })

  await cache.getOrCreate({
    key,
    type: 'validated_visit_profiles',
    build: async () => {
      buildCount += 1
      return { ok: true, buildCount }
    }
  })

  cache.clearMemory()
  const cacheFile = path.join(cacheDir, 'validated_visit_profiles', `${require('node:crypto').createHash('sha256').update(key).digest('hex')}.json`)
  fs.writeFileSync(cacheFile, '{broken-json', 'utf8')

  const nextValue = await cache.getOrCreate({
    key,
    type: 'validated_visit_profiles',
    build: async () => {
      buildCount += 1
      return { ok: true, buildCount }
    }
  })

  assert.equal(buildCount, 2)
  assert.deepEqual(nextValue, { ok: true, buildCount: 2 })
})

test('failed builds are never written to disk and the next call retries cleanly', async () => {
  const cacheDir = createTempCacheDir()
  const cache = new CoverageHistoryCache({
    ttlMs: 1000,
    maxEntries: 8,
    diskEnabled: true,
    diskDir: cacheDir
  })
  const key = buildCoverageHistoryCacheKey({
    name: 'salesCapacityProfiles',
    startDate: '2026-07-31',
    commercialCodes: ['C01'],
    documentFilters: { doc_types: ['facture', 'bl', 'blf'] }
  })

  await assert.rejects(
    cache.getOrCreate({
      key,
      type: 'sales_profiles',
      build: async () => {
        throw new Error('boom')
      }
    }),
    /boom/
  )

  const summaryAfterFailure = summarizeCacheDirectory(cacheDir)
  assert.equal(summaryAfterFailure.files, 0)

  const retried = await cache.getOrCreate({
    key,
    type: 'sales_profiles',
    build: async () => ({ recovered: true })
  })

  assert.deepEqual(retried, { recovered: true })
})

test('simultaneous identical calls join inflight and build only once', async () => {
  const events = []
  const cache = new CoverageHistoryCache({
    ttlMs: 1000,
    maxEntries: 8,
    logger: event => events.push(event)
  })
  let buildCount = 0
  let releaseBuild

  const key = buildCoverageHistoryCacheKey({
    name: 'buildCoverageClientHistorySnapshot',
    startDate: '2026-07-31',
    activeClientIds: ['1', '2'],
    documentFilters: {
      document_history: { doc_types: ['facture', 'bl', 'blf'] },
      visit_history: { validation_status: 'validated' }
    }
  })

  const build = async () => {
    buildCount += 1
    await new Promise(resolve => {
      releaseBuild = resolve
    })
    return { buildCount }
  }

  const firstPromise = cache.getOrCreate({ key, type: 'client_history', build })
  const secondPromise = cache.getOrCreate({ key, type: 'client_history', build })
  releaseBuild()

  const [first, second] = await Promise.all([firstPromise, secondPromise])
  assert.equal(buildCount, 1)
  assert.deepEqual(first, second)
  assert.equal(events[0].status, 'join_inflight')
})

test('client identity hash keeps 00152 and 152 distinct through client ids', () => {
  const keyFor00152 = buildCoverageHistoryCacheKeyParts({
    name: 'buildCoverageClientHistorySnapshot',
    startDate: '2026-07-31',
    historyWindowDays: 1095,
    documentFilters: {
      document_history: { doc_types: ['facture', 'bl', 'blf'] },
      visit_history: { validation_status: 'validated' }
    },
    activeClientIds: ['client-id-00152']
  })
  const keyFor152 = buildCoverageHistoryCacheKeyParts({
    name: 'buildCoverageClientHistorySnapshot',
    startDate: '2026-07-31',
    historyWindowDays: 1095,
    documentFilters: {
      document_history: { doc_types: ['facture', 'bl', 'blf'] },
      visit_history: { validation_status: 'validated' }
    },
    activeClientIds: ['client-id-152']
  })

  assert.notEqual(keyFor00152.active_client_ids_sha256, keyFor152.active_client_ids_sha256)
})

test('cache stats and clear operate on simulated entries only', async () => {
  const cacheDir = createTempCacheDir()
  const cache = new CoverageHistoryCache({
    ttlMs: 1000,
    maxEntries: 8,
    diskEnabled: true,
    diskDir: cacheDir
  })

  await cache.getOrCreate({
    key: 'demo-key',
    type: 'client_history',
    build: async () => ({ hello: 'world' })
  })

  const summary = summarizeCacheDirectory(cacheDir)
  assert.equal(summary.files, 1)
  assert.ok(summary.totalSizeBytes > 0)

  const cleared = clearCacheDirectory(cacheDir)
  assert.ok(cleared.removed >= 1)
  assert.equal(summarizeCacheDirectory(cacheDir).files, 0)
})

test('functional result hash stays identical before and after cache-related technical metadata', () => {
  const planA = {
    status: 'success',
    summary: {
      clients_to_cover: 2,
      total_predicted_ca: 520.2,
      history_cache_hits: 0
    },
    blocks: [
      {
        slot_id: '2026-08-01::C01',
        date: '2026-08-01',
        commercial_code: 'C01',
        clients: [
          {
            client_id: '1',
            priority_rank: 1,
            purchase_prediction_score: 85,
            recommended_quantity: 4,
            expected_order_value: 300
          }
        ]
      }
    ],
    meta: {
      request_id: 'abc',
      performance: {
        stages: [{ stage: 'total', duration_ms: 123 }]
      }
    }
  }
  const planB = {
    ...planA,
    summary: {
      ...planA.summary,
      history_cache_hits: 9,
      history_cache_misses: 1
    },
    meta: {
      request_id: 'def',
      performance: {
        stages: [{ stage: 'total', duration_ms: 999 }]
      }
    }
  }

  assert.equal(
    computeCoverageFunctionalResultHash(planA),
    computeCoverageFunctionalResultHash(planB)
  )
})

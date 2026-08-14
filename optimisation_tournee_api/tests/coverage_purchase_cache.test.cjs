const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const { CoverageHistoryCache } = require('../coverage_history_cache')
const { __testables } = require('../server.js')

function createTempCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nomadis-purchase-cache-'))
}

test.after(async () => {
  await __testables.closeOpenHandles()
})

test('same date and same exact clients reuse the cached dashboard prediction payload once', async () => {
  const cache = new CoverageHistoryCache({
    ttlMs: 1000,
    maxEntries: 8,
    diskEnabled: true,
    diskDir: createTempCacheDir()
  })
  let buildCount = 0
  const key = __testables.buildCoveragePurchaseCacheKey({
    requestPayload: { date: '2026-08-03' },
    cacheContext: {
      activeClientIds: ['1', '2'],
      exactClientCodes: ['00152', '152'],
      modelVersion: 'model-v1',
      datasetCutoff: '2026-07-31',
      scoreVersion: 'computePriorityScore'
    }
  })

  const first = await cache.getOrCreate({
    key,
    type: 'purchase_predictions',
    build: async () => {
      buildCount += 1
      return {
        status: 'success',
        predictions: {
          '00152': { score: 64.6, qte: 8, chiffre: 520, details: { Chips: 5 } },
          '152': { score: 30.2, qte: null, chiffre: null, details: null }
        }
      }
    }
  })
  const second = await cache.getOrCreate({
    key,
    type: 'purchase_predictions',
    build: async () => {
      buildCount += 1
      return { status: 'error' }
    }
  })

  assert.equal(buildCount, 1)
  assert.deepEqual(first, second)
  assert.equal(second.predictions['00152'].score, 64.6)
  assert.equal(second.predictions['00152'].qte, 8)
  assert.equal(second.predictions['00152'].chiffre, 520)
  assert.deepEqual(second.predictions['00152'].details, { Chips: 5 })
  assert.equal(second.predictions['152'].qte, null)
  assert.equal(second.predictions['152'].chiffre, null)
})

test('different prediction date or model version produces a new cache entry', async () => {
  const dateA = __testables.buildCoveragePurchaseCacheKey({
    requestPayload: { date: '2026-08-03' },
    cacheContext: {
      activeClientIds: ['1'],
      exactClientCodes: ['00152'],
      modelVersion: 'model-v1',
      datasetCutoff: '2026-07-31',
      scoreVersion: 'computePriorityScore'
    }
  })
  const dateB = __testables.buildCoveragePurchaseCacheKey({
    requestPayload: { date: '2026-08-04' },
    cacheContext: {
      activeClientIds: ['1'],
      exactClientCodes: ['00152'],
      modelVersion: 'model-v1',
      datasetCutoff: '2026-07-31',
      scoreVersion: 'computePriorityScore'
    }
  })
  const modelB = __testables.buildCoveragePurchaseCacheKey({
    requestPayload: { date: '2026-08-03' },
    cacheContext: {
      activeClientIds: ['1'],
      exactClientCodes: ['00152'],
      modelVersion: 'model-v2',
      datasetCutoff: '2026-07-31',
      scoreVersion: 'computePriorityScore'
    }
  })

  assert.notEqual(dateA, dateB)
  assert.notEqual(dateA, modelB)
})

test('purchase cache key keeps 00152 and 152 distinct exact codes', () => {
  const keyA = __testables.buildCoveragePurchaseCacheKey({
    requestPayload: { date: '2026-08-03' },
    cacheContext: {
      activeClientIds: ['1'],
      exactClientCodes: ['00152'],
      modelVersion: 'model-v1',
      datasetCutoff: '2026-07-31',
      scoreVersion: 'computePriorityScore'
    }
  })
  const keyB = __testables.buildCoveragePurchaseCacheKey({
    requestPayload: { date: '2026-08-03' },
    cacheContext: {
      activeClientIds: ['2'],
      exactClientCodes: ['152'],
      modelVersion: 'model-v1',
      datasetCutoff: '2026-07-31',
      scoreVersion: 'computePriorityScore'
    }
  })

  assert.notEqual(keyA, keyB)
})

const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')

const { __testables } = require('../server.js')

function buildCacheContext() {
  return {
    activeClientIds: ['15', '16'],
    exactClientCodes: ['00152', '00158'],
    modelVersion: 'model-v1',
    datasetCutoff: '2026-08-28',
    scoreVersion: 'computePriorityScore'
  }
}

function restorePatchedFunctions(originals) {
  if (originals.axiosPost) {
    axios.post = originals.axiosPost
  }
  if (originals.getOrCreate) {
    __testables.coveragePurchasePredictionCache.getOrCreate = originals.getOrCreate
  }
}

test.afterEach(() => {
  __testables.clearAiPredictionRequestCache()
})

test.after(async () => {
  await __testables.closeOpenHandles()
})

test('dashboard future bypasses a stale persistent empty cache and propagates the fresh prediction run code', async () => {
  __testables.clearAiPredictionRequestCache()
  const originals = {
    axiosPost: axios.post,
    getOrCreate: __testables.coveragePurchasePredictionCache.getOrCreate
  }
  let persistentCalls = 0

  __testables.coveragePurchasePredictionCache.getOrCreate = async () => {
    persistentCalls += 1
    return {
      status: 'success',
      prediction_run_code: 'stale-run',
      predictions: {}
    }
  }
  axios.post = async () => ({
    data: {
      status: 'success',
      prediction_run_code: 'fresh-run-007',
      predictions: {
        '00152': {
          chiffre: 220,
          qte: 3,
          details: { Chips: 3 }
        }
      }
    }
  })

  try {
    const result = await __testables.fetchLoggedAiPredictions(
      { date: '2026-08-30' },
      {
        sourceContext: 'tournees_plan_future',
        cacheContext: buildCacheContext()
      },
      {
        bypassPersistentCache: true
      }
    )
    const normalized = __testables.normalizeFutureSalesAiResult(result.response)

    assert.equal(persistentCalls, 0)
    assert.equal(result.cacheStatus, 'miss')
    assert.equal(result.loggingResult.runCode, 'fresh-run-007')
    assert.equal(normalized.ok, true)
    assert.equal(normalized.predictionRunCode, 'fresh-run-007')
    assert.deepEqual(normalized.predictions['00152'].details, { Chips: 3 })
  } finally {
    restorePatchedFunctions(originals)
  }
})

test('other callers keep using the persistent purchase cache by default', async () => {
  __testables.clearAiPredictionRequestCache()
  const originals = {
    axiosPost: axios.post,
    getOrCreate: __testables.coveragePurchasePredictionCache.getOrCreate
  }
  let persistentCalls = 0
  let pythonCalls = 0

  __testables.coveragePurchasePredictionCache.getOrCreate = async () => {
    persistentCalls += 1
    return {
      status: 'success',
      prediction_run_code: 'persistent-run-123',
      predictions: {
        '00158': {
          chiffre: 95,
          qte: 2,
          details: { Agro: 2 }
        }
      }
    }
  }
  axios.post = async () => {
    pythonCalls += 1
    throw new Error('Python should not be called when the persistent cache is used')
  }

  try {
    const result = await __testables.fetchLoggedAiPredictions(
      { date: '2026-08-30' },
      {
        sourceContext: 'sales_coverage',
        cacheContext: buildCacheContext()
      }
    )

    assert.equal(persistentCalls, 1)
    assert.equal(pythonCalls, 0)
    assert.equal(result.cacheStatus, 'persistent')
    assert.equal(result.loggingResult.runCode, 'persistent-run-123')
    assert.equal(result.response.data.prediction_run_code, 'persistent-run-123')
  } finally {
    restorePatchedFunctions(originals)
  }
})

test('nearby dashboard future calls can still reuse the short memory cache', async () => {
  __testables.clearAiPredictionRequestCache()
  const originals = {
    axiosPost: axios.post,
    getOrCreate: __testables.coveragePurchasePredictionCache.getOrCreate
  }
  let persistentCalls = 0
  let pythonCalls = 0

  __testables.coveragePurchasePredictionCache.getOrCreate = async () => {
    persistentCalls += 1
    throw new Error('Persistent purchase cache should be bypassed for dashboard future calls')
  }
  axios.post = async () => {
    pythonCalls += 1
    return {
      data: {
        status: 'success',
        prediction_run_code: 'fresh-run-memory',
        predictions: {
          '00152': {
            chiffre: 180,
            qte: 1,
            details: { Chips: 1 }
          }
        }
      }
    }
  }

  try {
    const first = await __testables.fetchLoggedAiPredictions(
      { date: '2026-08-30' },
      {
        sourceContext: 'tournees_plan_future',
        cacheContext: buildCacheContext()
      },
      {
        bypassPersistentCache: true
      }
    )
    const second = await __testables.fetchLoggedAiPredictions(
      { date: '2026-08-30' },
      {
        sourceContext: 'tournees_plan_future',
        cacheContext: buildCacheContext()
      },
      {
        bypassPersistentCache: true
      }
    )

    assert.equal(persistentCalls, 0)
    assert.equal(pythonCalls, 1)
    assert.equal(first.cacheStatus, 'miss')
    assert.equal(second.cacheStatus, 'hit')
    assert.equal(second.loggingResult.runCode, 'fresh-run-memory')
    assert.deepEqual(second.response.data, first.response.data)
  } finally {
    restorePatchedFunctions(originals)
  }
})

test('a fresh successful IA response with zero predictions stays valid for dashboard future', async () => {
  __testables.clearAiPredictionRequestCache()
  const originals = {
    axiosPost: axios.post,
    getOrCreate: __testables.coveragePurchasePredictionCache.getOrCreate
  }
  let persistentCalls = 0

  __testables.coveragePurchasePredictionCache.getOrCreate = async () => {
    persistentCalls += 1
    throw new Error('Persistent purchase cache should be bypassed for dashboard future calls')
  }
  axios.post = async () => ({
    data: {
      status: 'success',
      prediction_run_code: 'fresh-empty-run',
      predictions: {}
    }
  })

  try {
    const result = await __testables.fetchLoggedAiPredictions(
      { date: '2026-08-30' },
      {
        sourceContext: 'tournees_plan_future',
        cacheContext: buildCacheContext()
      },
      {
        bypassPersistentCache: true
      }
    )
    const normalized = __testables.normalizeFutureSalesAiResult(result.response)

    assert.equal(persistentCalls, 0)
    assert.equal(result.cacheStatus, 'miss')
    assert.equal(result.loggingResult.runCode, 'fresh-empty-run')
    assert.equal(normalized.ok, true)
    assert.deepEqual(normalized.predictions, {})
    assert.equal(normalized.predictionRunCode, 'fresh-empty-run')
  } finally {
    restorePatchedFunctions(originals)
  }
})

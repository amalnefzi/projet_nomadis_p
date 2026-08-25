const test = require('node:test')
const assert = require('node:assert/strict')

const { __testables } = require('../server.js')

test.after(async () => {
  await __testables.closeOpenHandles()
})

test('future sales normalizer returns HTTP 503 when IA status is not success', () => {
  const result = __testables.normalizeFutureSalesAiResult({
    data: {
      status: 'error',
      message: 'Modele introuvable',
      prediction_run_code: 'run-42'
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.statusCode, 503)
  assert.equal(result.body.status, 'error')
  assert.equal(result.body.prediction_run_code, 'run-42')
  assert.match(
    result.body.message,
    /Le plan de vente future est indisponible car le moteur IA n'a pas pu calculer les predictions\./
  )
  assert.match(result.body.message, /Modele introuvable/)
})

test('future sales normalizer preserves a successful empty IA payload as a valid empty result', () => {
  const result = __testables.normalizeFutureSalesAiResult({
    data: {
      status: 'success',
      predictions: {}
    }
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.predictions, {})
  assert.equal(result.predictionRunCode, null)
})

test('future sales normalizer keeps only positive product baskets and recomputes qte from them', () => {
  const result = __testables.normalizeFutureSalesAiResult({
    data: {
      status: 'success',
      predictions: {
        '00152': {
          chiffre: 180,
          qte: 0,
          details: {
            Chips: 2,
            Agro: 1
          }
        },
        '00158': {
          chiffre: 90,
          qte: 5,
          details: {
            Chips: 0,
            Agro: -1
          }
        }
      }
    }
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.predictions['00152'].details, { Chips: 2, Agro: 1 })
  assert.equal(result.predictions['00152'].qte, 3)
  assert.deepEqual(result.predictions['00158'].details, {})
  assert.equal(result.predictions['00158'].qte, 0)
})

test('future sales transport failure uses a business 503 message', () => {
  const result = __testables.buildFutureSalesAiTransportFailureResponse()

  assert.equal(result.ok, false)
  assert.equal(result.statusCode, 503)
  assert.equal(result.body.status, 'error')
  assert.equal(
    result.body.message,
    "Le plan de vente future est indisponible car le moteur IA est temporairement injoignable. Reessayez dans quelques instants."
  )
})

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SALES_PLAN_API_ERROR_MESSAGE,
  getSalesPlanApiErrorMessage
} from '../salesPlanApiError.js'

test("retourne le message metier renvoye par l'API", () => {
  const message = getSalesPlanApiErrorMessage({
    response: {
      data: {
        message: 'Le plan de vente future est indisponible car le moteur IA est temporairement injoignable.'
      }
    }
  })

  assert.equal(
    message,
    'Le plan de vente future est indisponible car le moteur IA est temporairement injoignable.'
  )
})

test("utilise le champ error quand l'API ne fournit pas de message", () => {
  const message = getSalesPlanApiErrorMessage({
    response: {
      data: {
        error: 'Erreur MySQL test'
      }
    }
  })

  assert.equal(message, 'Erreur MySQL test')
})

test('retombe sur le message par defaut sans payload exploitable', () => {
  assert.equal(getSalesPlanApiErrorMessage(new Error('network down')), DEFAULT_SALES_PLAN_API_ERROR_MESSAGE)
})

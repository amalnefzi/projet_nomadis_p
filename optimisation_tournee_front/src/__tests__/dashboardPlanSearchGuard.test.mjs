import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createClearedDashboardPlanState,
  executeDashboardPlanSearchGuard
} from '../dashboardPlanSearchGuard.js'

const PREVIOUS_PLAN_STATE = {
  donneesTournee: {
    mode: 'vente',
    tournees: [{ nbr_client: '00158' }],
    itineraire: ['1. Client test']
  },
  editableTournees: [{ nbr_client: '00158', qte_reco: 4 }],
  additionalSuggestions: [{ nbr_client: '00420', qte_reco: 2 }],
  clickedClient: 0,
  validationFeedback: { type: 'success', message: 'Ancienne validation' },
  isValidationModalOpen: true,
  manualOrderLocked: true,
  unrelatedFlag: 'keep-me'
}

test("ancien plan + vente date passee => aucun appel API et aucun ancien resultat visible", async () => {
  let apiCalls = 0

  const result = await executeDashboardPlanSearchGuard({
    modeTournee: 'vente',
    datePrecise: '2026-08-23',
    today: new Date(2026, 7, 24),
    previousState: PREVIOUS_PLAN_STATE,
    requestPlan: async () => {
      apiCalls += 1
      return { data: { tournees: [{ nbr_client: '00999' }] } }
    }
  })

  assert.equal(result.blocked, true)
  assert.equal(apiCalls, 0)
  assert.deepEqual(result.nextState, createClearedDashboardPlanState(PREVIOUS_PLAN_STATE))
  assert.equal(result.nextState.donneesTournee, null)
  assert.deepEqual(result.nextState.editableTournees, [])
  assert.deepEqual(result.nextState.additionalSuggestions, [])
  assert.equal(result.nextState.clickedClient, null)
  assert.equal(result.nextState.validationFeedback, null)
  assert.equal(result.nextState.isValidationModalOpen, false)
  assert.equal(result.nextState.manualOrderLocked, false)
  assert.equal(result.nextState.unrelatedFlag, 'keep-me')
})

test("recouvrement date passee reste autorise et n'est pas vide artificiellement", async () => {
  let apiCalls = 0
  const apiResponse = {
    data: {
      mode: 'recouvrement',
      tournees: [{ nbr_client: '00152', collecte_prevue: 320 }]
    }
  }

  const result = await executeDashboardPlanSearchGuard({
    modeTournee: 'recouvrement',
    datePrecise: '2026-08-23',
    today: new Date(2026, 7, 24),
    previousState: PREVIOUS_PLAN_STATE,
    requestPlan: async () => {
      apiCalls += 1
      return apiResponse
    }
  })

  assert.equal(result.blocked, false)
  assert.equal(apiCalls, 1)
  assert.deepEqual(result.response, apiResponse)
})

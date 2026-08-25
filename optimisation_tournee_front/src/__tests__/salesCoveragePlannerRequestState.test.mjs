import test from 'node:test'
import assert from 'node:assert/strict'

import {
  invalidateSalesCoveragePlannerRequest,
  resolveSalesCoverageReadinessRequestError,
  resolveSalesCoverageReadinessRequestSuccess,
  resolveSalesCoveragePlannerRequestError,
  resolveSalesCoveragePlannerRequestSuccess,
  startSalesCoverageReadinessRequest,
  startSalesCoveragePlannerRequest
} from '../salesCoveragePlannerRequestState.js'

function buildPlan(slotId, message = 'Plan genere') {
  return {
    message,
    blocks: slotId ? [{ slot_id: slotId }] : []
  }
}

test('succes puis changement de filtre supprime immediatement l ancien plan', () => {
  let activeSequence = 0

  const started = startSalesCoveragePlannerRequest(activeSequence)
  activeSequence = started.requestSequence

  const successViewState = resolveSalesCoveragePlannerRequestSuccess(
    activeSequence,
    activeSequence,
    buildPlan('slot-a')
  )

  assert.equal(successViewState.loading, false)
  assert.equal(successViewState.error, null)
  assert.equal(successViewState.planView.blocks[0].slot_id, 'slot-a')
  assert.equal(successViewState.selectedBlockId, 'slot-a')

  const invalidated = invalidateSalesCoveragePlannerRequest(activeSequence)
  activeSequence = invalidated.requestSequence

  assert.equal(invalidated.viewState.loading, false)
  assert.equal(invalidated.viewState.error, null)
  assert.equal(invalidated.viewState.planView, null)
  assert.equal(invalidated.viewState.selectedBlockId, null)
})

test('succes puis nouvelle requete en erreur efface l ancien plan avant et apres l echec', () => {
  let activeSequence = 0

  const firstRequest = startSalesCoveragePlannerRequest(activeSequence)
  activeSequence = firstRequest.requestSequence

  const firstSuccessViewState = resolveSalesCoveragePlannerRequestSuccess(
    activeSequence,
    activeSequence,
    buildPlan('slot-a')
  )

  assert.equal(firstSuccessViewState.planView.blocks[0].slot_id, 'slot-a')

  const secondRequest = startSalesCoveragePlannerRequest(activeSequence)
  activeSequence = secondRequest.requestSequence

  assert.equal(secondRequest.viewState.loading, true)
  assert.equal(secondRequest.viewState.error, null)
  assert.equal(secondRequest.viewState.planView, null)
  assert.equal(secondRequest.viewState.selectedBlockId, null)

  const errorViewState = resolveSalesCoveragePlannerRequestError(
    activeSequence,
    activeSequence,
    'Echec de generation'
  )

  assert.equal(errorViewState.loading, false)
  assert.equal(errorViewState.error, 'Echec de generation')
  assert.equal(errorViewState.planView, null)
  assert.equal(errorViewState.selectedBlockId, null)
})

test('une ancienne reponse tardive est ignoree et ne remplace jamais la requete la plus recente', () => {
  let activeSequence = 0

  const slowRequest = startSalesCoveragePlannerRequest(activeSequence)
  activeSequence = slowRequest.requestSequence
  const slowRequestSequence = activeSequence

  const latestRequest = startSalesCoveragePlannerRequest(activeSequence)
  activeSequence = latestRequest.requestSequence

  const staleSuccessViewState = resolveSalesCoveragePlannerRequestSuccess(
    activeSequence,
    slowRequestSequence,
    buildPlan('slot-stale')
  )

  assert.equal(staleSuccessViewState, null)
  assert.equal(latestRequest.viewState.loading, true)
  assert.equal(latestRequest.viewState.planView, null)

  const latestSuccessViewState = resolveSalesCoveragePlannerRequestSuccess(
    activeSequence,
    activeSequence,
    buildPlan('slot-fresh')
  )

  assert.equal(latestSuccessViewState.loading, false)
  assert.equal(latestSuccessViewState.error, null)
  assert.equal(latestSuccessViewState.planView.blocks[0].slot_id, 'slot-fresh')
  assert.equal(latestSuccessViewState.selectedBlockId, 'slot-fresh')
})

test('retry readiness preserves failed payload while disabling another retry during the request', () => {
  const failedState = {
    loading: false,
    error: null,
    payload: {
      status: 'failed',
      error: 'snapshot corrupted'
    }
  }

  const started = startSalesCoverageReadinessRequest(4, failedState)

  assert.equal(started.requestSequence, 5)
  assert.equal(started.viewState.loading, true)
  assert.equal(started.viewState.error, null)
  assert.deepEqual(started.viewState.payload, failedState.payload)
})

test('readiness retry success accepts the current date context and exposes the returned building state', () => {
  const successViewState = resolveSalesCoverageReadinessRequestSuccess(
    7,
    7,
    '2026-08-24',
    '2026-08-24',
    {
      status: 'building'
    }
  )

  assert.equal(successViewState.loading, false)
  assert.equal(successViewState.error, null)
  assert.deepEqual(successViewState.payload, { status: 'building' })
})

test('readiness retry success is ignored after a date change', () => {
  const staleSuccessViewState = resolveSalesCoverageReadinessRequestSuccess(
    8,
    8,
    '2026-08-25',
    '2026-08-24',
    {
      status: 'ready'
    }
  )

  assert.equal(staleSuccessViewState, null)
})

test('readiness retry error keeps the latest failed payload when the request is still current', () => {
  const errorViewState = resolveSalesCoverageReadinessRequestError(
    9,
    9,
    '2026-08-24',
    '2026-08-24',
    {
      payload: {
        status: 'failed',
        error: 'previous failure'
      }
    },
    'new failure'
  )

  assert.equal(errorViewState.loading, false)
  assert.equal(errorViewState.error, 'new failure')
  assert.deepEqual(errorViewState.payload, {
    status: 'failed',
    error: 'previous failure'
  })
})

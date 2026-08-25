import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getPastSalesPlanMessage,
  shouldBlockPastSalesPlanRequest
} from '../dashboardDateGuard.js'

const TODAY = new Date(2026, 7, 22)

test('bloque une date passee pour une tournee de vente avec un message explicite', () => {
  const blocked = shouldBlockPastSalesPlanRequest({
    modeTournee: 'vente',
    datePrecise: '2026-08-21',
    today: TODAY
  })

  assert.equal(blocked, true)
  assert.equal(
    getPastSalesPlanMessage(),
    'Les tournees de vente ne peuvent pas etre planifiees sur une date passee.'
  )
})

test('ne bloque pas le mode recouvrement sur une date passee', () => {
  const blocked = shouldBlockPastSalesPlanRequest({
    modeTournee: 'recouvrement',
    datePrecise: '2026-08-21',
    today: TODAY
  })

  assert.equal(blocked, false)
})

test('ne bloque pas une date de vente du jour ou future', () => {
  assert.equal(
    shouldBlockPastSalesPlanRequest({
      modeTournee: 'vente',
      datePrecise: '2026-08-22',
      today: TODAY
    }),
    false
  )

  assert.equal(
    shouldBlockPastSalesPlanRequest({
      modeTournee: 'vente',
      dateDebut: '2026-08-25',
      dateFin: '2026-08-30',
      today: TODAY
    }),
    false
  )
})

test('bloque une periode de vente qui commence dans le passe meme si elle finit dans le futur', () => {
  assert.equal(
    shouldBlockPastSalesPlanRequest({
      modeTournee: 'vente',
      dateDebut: '2026-08-21',
      dateFin: '2026-08-25',
      today: TODAY
    }),
    true
  )
})
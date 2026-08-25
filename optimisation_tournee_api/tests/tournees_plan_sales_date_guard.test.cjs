const test = require('node:test')
const assert = require('node:assert/strict')

const {
  getPastSalesPlanMessage,
  shouldRejectPastSalesPlanRequest
} = require('../dashboardDateGuard')

const TODAY = new Date(2026, 7, 22)

test('rejects a past sales date with the dashboard message', () => {
  const rejected = shouldRejectPastSalesPlanRequest({
    modeTournee: 'vente',
    datePrecise: '2026-08-21',
    today: TODAY
  })

  assert.equal(rejected, true)
  assert.equal(
    getPastSalesPlanMessage(),
    'Les tournees de vente ne peuvent pas etre planifiees sur une date passee.'
  )
})

test('keeps recouvrement requests allowed on past dates', () => {
  const rejected = shouldRejectPastSalesPlanRequest({
    modeTournee: 'recouvrement',
    datePrecise: '2026-08-21',
    today: TODAY
  })

  assert.equal(rejected, false)
})

test('rejects a sales range that starts in the past even when it ends in the future', () => {
  assert.equal(
    shouldRejectPastSalesPlanRequest({
      modeTournee: 'vente',
      dateDebut: '2026-08-21',
      dateFin: '2026-08-25',
      today: TODAY
    }),
    true
  )
})

test('keeps today and future sales dates allowed', () => {
  assert.equal(
    shouldRejectPastSalesPlanRequest({
      modeTournee: 'vente',
      datePrecise: '2026-08-22',
      today: TODAY
    }),
    false
  )

  assert.equal(
    shouldRejectPastSalesPlanRequest({
      modeTournee: 'vente',
      dateDebut: '2026-08-25',
      dateFin: '2026-08-30',
      today: TODAY
    }),
    false
  )
})

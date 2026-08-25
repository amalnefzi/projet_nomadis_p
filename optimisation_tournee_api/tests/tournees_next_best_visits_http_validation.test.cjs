const test = require('node:test')
const assert = require('node:assert/strict')

const {
  __testables: serverTestables
} = require('../server')

test.after(async () => {
  await serverTestables.closeOpenHandles()
})

const TODAY = '2026-08-24'
const COMMERCIAUX = [
  { value: 'C01', label: 'Commercial 1' },
  { value: 'C02', label: 'Commercial 2' }
]

function buildValidBody(overrides = {}) {
  return {
    start_date: TODAY,
    planning_horizon_days: 14,
    min_clients: 20,
    max_clients: 30,
    daily_max_mode: 'flexible',
    commercial_codes: ['C01'],
    commercials: ['C01'],
    ...overrides
  }
}

function createMockReq(body) {
  return {
    body,
    app: {
      locals: {
        todayIsoForTests: TODAY
      }
    }
  }
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

const invalidCases = [
  {
    name: 'rejects an invalid start_date',
    body: buildValidBody({ start_date: '2026-02-31' }),
    message: 'La date de debut du plan de tournees ventes est invalide.'
  },
  {
    name: 'rejects a past start_date',
    body: buildValidBody({ start_date: '2026-08-23' }),
    message: 'La date de debut du plan de tournees ventes ne peut pas etre dans le passe.'
  },
  {
    name: 'rejects a period below one day',
    body: buildValidBody({ planning_horizon_days: 0 }),
    message: 'La periode du plan de tournees ventes doit etre comprise entre 1 et 60 jours.'
  },
  {
    name: 'rejects a period above sixty days',
    body: buildValidBody({ planning_horizon_days: 61 }),
    message: 'La periode du plan de tournees ventes doit etre comprise entre 1 et 60 jours.'
  },
  {
    name: 'rejects a negative target load',
    body: buildValidBody({ min_clients: -1 }),
    message: 'La charge cible par commercial et par jour ne peut pas etre negative.'
  },
  {
    name: 'rejects a negative maximum load',
    body: buildValidBody({ max_clients: -1 }),
    message: 'Le maximum par commercial et par jour ne peut pas etre negatif.'
  },
  {
    name: 'rejects min_clients above strict max_clients when a maximum is provided',
    body: buildValidBody({
      daily_max_mode: 'strict',
      min_clients: 31,
      max_clients: 30
    }),
    message: 'En mode maximum strict, la charge cible ne peut pas depasser le maximum renseigne.'
  },
  {
    name: 'rejects when no commercial is selected',
    body: buildValidBody({
      commercial_codes: [],
      commercials: []
    }),
    message: 'Selectionne au moins un commercial pour generer le plan de tournees ventes.'
  },
  {
    name: 'rejects unknown commercial codes',
    body: buildValidBody({
      commercial_codes: ['C99'],
      commercials: ['C99']
    }),
    message: 'Codes commerciaux introuvables : C99.'
  }
]

for (const testCase of invalidCases) {
  test(testCase.name, async () => {
    let generationCallCount = 0
    const req = createMockReq(testCase.body)
    const res = createMockRes()

    await serverTestables.handleNextBestVisitRoute(req, res, {
      todayIso: TODAY,
      fetchCommercialOptions: async () => COMMERCIAUX,
      generateNextBestVisitPlan: async () => {
        generationCallCount += 1
        return { status: 'success' }
      }
    })

    assert.equal(res.statusCode, 400)
    assert.deepEqual(res.body, {
      status: 'invalid_parameters',
      message: testCase.message
    })
    assert.equal(generationCallCount, 0)
  })
}

test('accepts a plan starting today and forwards normalized commercial codes to generation', async () => {
  let receivedBody = null
  const req = createMockReq(buildValidBody())
  const res = createMockRes()

  await serverTestables.handleNextBestVisitRoute(req, res, {
    todayIso: TODAY,
    fetchCommercialOptions: async () => COMMERCIAUX,
    generateNextBestVisitPlan: async body => {
      receivedBody = body
      return { status: 'success', summary: { planning_start_date: body.start_date } }
    }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'success')
  assert.deepEqual(receivedBody.commercial_codes, ['C01'])
  assert.deepEqual(receivedBody.commercials, ['C01'])
  assert.equal(receivedBody.commercial, 'C01')
  assert.equal(receivedBody.start_date, TODAY)
})

test('accepts a future plan with max_clients equal to zero as no maximum', async () => {
  let generationCallCount = 0
  const req = createMockReq(buildValidBody({
    start_date: '2026-08-30',
    daily_max_mode: 'strict',
    max_clients: 0
  }))
  const res = createMockRes()

  await serverTestables.handleNextBestVisitRoute(req, res, {
    todayIso: TODAY,
    fetchCommercialOptions: async () => COMMERCIAUX,
    generateNextBestVisitPlan: async () => {
      generationCallCount += 1
      return { status: 'success' }
    }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'success')
  assert.equal(generationCallCount, 1)
})

test('maps service-level invalid_parameters responses to HTTP 400', async () => {
  const req = createMockReq(buildValidBody())
  const res = createMockRes()

  await serverTestables.handleNextBestVisitRoute(req, res, {
    todayIso: TODAY,
    fetchCommercialOptions: async () => COMMERCIAUX,
    generateNextBestVisitPlan: async () => ({
      status: 'invalid_parameters',
      message: 'Erreur metier controlee.'
    })
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.body.status, 'invalid_parameters')
  assert.equal(res.body.message, 'Erreur metier controlee.')
  assert.ok(Array.isArray(res.body.meta?.performance?.stages))
})

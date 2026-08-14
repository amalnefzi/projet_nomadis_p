const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const express = require('express')

const {
  generateNextBestVisitPlanFromData
} = require('../next_best_visit_engine')
const {
  generateNextBestVisitPlan,
  __testables: serviceTestables
} = require('../next_best_visit_service')
const {
  __testables: labTestables,
  listScenarioSummaries
} = require('../next_best_visit_validation_lab')
const {
  isV2ValidationLabEnabled,
  registerNextBestVisitValidationLabRoutes
} = require('../next_best_visit_validation_lab_routes')

function startServer(app) {
  return new Promise(resolve => {
    const server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      })
    })
  })
}

function stopServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

test('production wrapper and validation lab share the same pure engine reference', () => {
  assert.equal(serviceTestables.generateNextBestVisitPlanFromData, generateNextBestVisitPlanFromData)
  assert.equal(labTestables.generateNextBestVisitPlanFromData, generateNextBestVisitPlanFromData)
})

test('production wrapper still requires external loaders and does not become fixture-driven', async () => {
  await assert.rejects(
    generateNextBestVisitPlan({
      start_date: '2026-09-07',
      planning_horizon_days: 7,
      commercial_codes: ['C01']
    }, {}),
    /fetchCommercialOptions/
  )
})

test('validation lab routes stay disabled in production-like environments', () => {
  const app = express()
  assert.equal(isV2ValidationLabEnabled({ NODE_ENV: 'production' }), false)
  assert.equal(registerNextBestVisitValidationLabRoutes(app, { env: { NODE_ENV: 'production' } }), false)
  const routePaths = (app.router?.stack || [])
    .map(layer => layer.route?.path)
    .filter(Boolean)
  assert.equal(routePaths.length, 0)
})

test('validation lab routes run fixture-only scenarios in development mode', async () => {
  const app = express()
  app.use(express.json())
  assert.equal(isV2ValidationLabEnabled({ NODE_ENV: 'development' }), true)
  assert.equal(registerNextBestVisitValidationLabRoutes(app, { env: { NODE_ENV: 'development' } }), true)

  const { server, baseUrl } = await startServer(app)
  try {
    const scenariosResponse = await fetch(`${baseUrl}/api/dev/next-best-visit-validation/scenarios`)
    assert.equal(scenariosResponse.status, 200)
    const scenariosPayload = await scenariosResponse.json()
    assert.equal(scenariosPayload.commercial_validation_status, 'not_validated')
    assert.equal(scenariosPayload.data_environment, 'synthetic_validation')
    assert.ok(Array.isArray(scenariosPayload.scenarios))
    assert.ok(scenariosPayload.scenarios.length >= 20)
    assert.ok(listScenarioSummaries().every(item => item.scenario_id))

    const runResponse = await fetch(`${baseUrl}/api/dev/next-best-visit-validation/run/recent_purchase`, {
      method: 'POST'
    })
    assert.equal(runResponse.status, 200)
    const runPayload = await runResponse.json()
    assert.equal(runPayload.status, 'PASS')
    assert.equal(runPayload.technical_validation_status, 'passed')
    assert.equal(runPayload.logical_validation_status, 'passed')
    assert.equal(runPayload.commercial_validation_status, 'not_validated')
    assert.equal(runPayload.data_environment, 'synthetic_validation')
  } finally {
    await stopServer(server)
  }
})

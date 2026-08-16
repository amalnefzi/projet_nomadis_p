function normalizeFlag(value) {
  return String(value || '').trim().toLowerCase()
}

function isV2ValidationLabEnabled(env = process.env) {
  return normalizeFlag(env?.NODE_ENV) === 'development' ||
    normalizeFlag(env?.ENABLE_V2_VALIDATION_LAB) === 'true'
}

function registerNextBestVisitValidationLabRoutes(app, { env = process.env } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express app requis pour enregistrer les routes du validation lab.')
  }

  if (!isV2ValidationLabEnabled(env)) {
    return false
  }

  const {
    listScenarioIds,
    listScenarioSummaries,
    runAllValidationScenarios,
    runValidationScenario
  } = require('./next_best_visit_validation_lab')

  app.get('/api/dev/next-best-visit-validation/scenarios', async (_req, res) => {
    try {
      return res.json({
        status: 'success',
        data_environment: 'synthetic_validation',
        data_representativeness: 'non_representative',
        commercial_validation_status: 'not_validated',
        scenarios: listScenarioSummaries()
      })
    } catch (error) {
      return res.status(500).json({
        status: 'error',
        message: error.message || 'Erreur lors de la lecture des scenarios de validation.'
      })
    }
  })

  app.post('/api/dev/next-best-visit-validation/run', async (_req, res) => {
    try {
      return res.json(await runAllValidationScenarios())
    } catch (error) {
      return res.status(500).json({
        status: 'error',
        message: error.message || 'Erreur lors de l execution complete du validation lab.'
      })
    }
  })

  app.post('/api/dev/next-best-visit-validation/run/:scenarioId', async (req, res) => {
    const scenarioId = String(req.params?.scenarioId || '').trim()
    if (!scenarioId || !listScenarioIds().includes(scenarioId)) {
      return res.status(404).json({
        status: 'error',
        message: 'Scenario introuvable.'
      })
    }

    try {
      return res.json(await runValidationScenario(scenarioId))
    } catch (error) {
      return res.status(500).json({
        status: 'error',
        message: error.message || 'Erreur lors de l execution du scenario de validation.'
      })
    }
  })

  return true
}

module.exports = {
  isV2ValidationLabEnabled,
  registerNextBestVisitValidationLabRoutes
}

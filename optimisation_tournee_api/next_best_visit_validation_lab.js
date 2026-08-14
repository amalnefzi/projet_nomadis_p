const fs = require('node:fs')
const path = require('node:path')

const {
  buildPredictionResolverFromRecords,
  generateNextBestVisitPlanFromData,
  normalizeNextBestVisitRequest
} = require('./next_best_visit_engine')

const FIXTURES_ROOT = path.join(__dirname, 'tests', 'fixtures', 'next_best_visit_validation')
const SYNTHETIC_CACHE_NAMESPACE = 'synthetic_validation'
const BENCHMARK_TARGETS = Object.freeze([
  { clientCount: 100, horizonDays: 7, targetMs: 250 },
  { clientCount: 1000, horizonDays: 14, targetMs: 2000 },
  { clientCount: 5768, horizonDays: 14, targetMs: 8000 },
  { clientCount: 5768, horizonDays: 30, targetMs: 15000 }
])

function roundNumber(value, digits = 2) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  const factor = 10 ** digits
  return Math.round(numeric * factor) / factor
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function listScenarioIds() {
  if (!fs.existsSync(FIXTURES_ROOT)) return []
  return fs.readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

function listScenarioSummaries() {
  return listScenarioIds().map(scenarioId => {
    const files = buildFixtureFileMap(scenarioId)
    const validation = validateScenarioSchema(scenarioId, files)
    if (!validation.valid) {
      return {
        scenario_id: scenarioId,
        critical: true,
        valid: false,
        errors: validation.errors
      }
    }
    return {
      scenario_id: validation.scenario.scenario_id,
      planning_start_date: validation.scenario.planning_start_date,
      planning_horizon_days: validation.scenario.planning_horizon_days,
      objective: validation.scenario.objective || 'balanced',
      critical: validation.scenario.critical !== false,
      valid: true
    }
  })
}

function buildFixtureFileMap(scenarioId) {
  const dir = path.join(FIXTURES_ROOT, scenarioId)
  return {
    dir,
    scenario: path.join(dir, 'scenario.json'),
    inputs: path.join(dir, 'inputs.json'),
    expected: path.join(dir, 'expected_result.json')
  }
}

function validateScenarioSchema(scenarioId, files) {
  const missingFiles = Object.entries(files)
    .filter(([key, value]) => key !== 'dir' && !fs.existsSync(value))
    .map(([key]) => key)
  if (missingFiles.length) {
    return {
      valid: false,
      errors: missingFiles.map(key => `fixture manquante: ${scenarioId}/${key}.json`)
    }
  }

  const scenario = readJsonFile(files.scenario)
  const inputs = readJsonFile(files.inputs)
  const expected = readJsonFile(files.expected)
  const errors = []

  if (!scenario.scenario_id) errors.push('scenario_id manquant')
  if (!scenario.planning_start_date) errors.push('planning_start_date manquant')
  if (!scenario.planning_horizon_days) errors.push('planning_horizon_days manquant')
  if (!Array.isArray(inputs.clients)) errors.push('inputs.clients doit etre un tableau')
  if (!Array.isArray(inputs.sales_history)) errors.push('inputs.sales_history doit etre un tableau')
  if (!Array.isArray(inputs.visits_history)) errors.push('inputs.visits_history doit etre un tableau')
  if (!Array.isArray(inputs.predictions)) errors.push('inputs.predictions doit etre un tableau')
  if (!Array.isArray(inputs.availability)) errors.push('inputs.availability doit etre un tableau')
  if (!expected || typeof expected !== 'object') errors.push('expected_result invalide')

  return {
    valid: errors.length === 0,
    errors,
    scenario,
    inputs,
    expected
  }
}

function buildHistoryMap(rows = [], dateField) {
  return (Array.isArray(rows) ? rows : []).reduce((map, row) => {
    const clientId = String(row.client_id || '')
    if (!clientId) return map
    const list = map.get(clientId) || []
    list.push({
      ...row,
      [dateField]: row[dateField]
    })
    map.set(clientId, list)
    return map
  }, new Map())
}

function deriveSelectedCommercials(inputs = {}) {
  const provided = Array.isArray(inputs.commercials) ? inputs.commercials : []
  if (provided.length) {
    return provided.map(item => ({
      value: String(item.value || item.code || '').trim(),
      label: String(item.label || item.value || item.code || '').trim() || 'Commercial'
    }))
  }

  const fromClients = [...new Set(
    (Array.isArray(inputs.clients) ? inputs.clients : [])
      .map(client => String(client.resolved_commercial_code || client.user_code || '').trim())
      .filter(Boolean)
  )]
  return fromClients.map(code => ({ value: code, label: `Commercial ${code}` }))
}

function flattenBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : []).flatMap(block => (
    Array.isArray(block.clients)
      ? block.clients.map(client => ({
          ...client,
          assigned_date: block.date,
          assigned_commercial_code: block.commercial_code,
          assigned_slot_id: block.slot_id
        }))
      : []
  ))
}

function buildScenarioActualIndex(payload = {}) {
  const selectedVisits = flattenBlocks(payload.blocks)
  const deferredByClientCode = new Map(
    (Array.isArray(payload.deferred_clients) ? payload.deferred_clients : []).map(item => [String(item.client_code || ''), item])
  )
  const selectedByClientCode = selectedVisits.reduce((map, visit) => {
    const clientCode = String(visit.client_code || '')
    const list = map.get(clientCode) || []
    list.push(visit)
    map.set(clientCode, list)
    return map
  }, new Map())
  const topOpportunitiesByClientCode = new Map(
    Object.entries(payload.validation?.top_opportunities_by_client_code || {})
  )
  const ranking = [...selectedVisits]
    .sort((left, right) => (
      Number(right.visit_opportunity_score || 0) - Number(left.visit_opportunity_score || 0) ||
      String(left.visit_opportunity_id || '').localeCompare(String(right.visit_opportunity_id || ''))
    ))
    .map(item => item.client_code)

  return {
    payload,
    selectedVisits,
    selectedByClientCode,
    deferredByClientCode,
    topOpportunitiesByClientCode,
    ranking
  }
}

function resolveClientEvidence(actualIndex, clientCode) {
  const selected = actualIndex.selectedByClientCode.get(clientCode) || []
  if (selected.length) return selected[0]
  const deferred = actualIndex.deferredByClientCode.get(clientCode) || null
  const topOpportunity = actualIndex.topOpportunitiesByClientCode.get(clientCode) || null
  if (deferred && topOpportunity) {
    return {
      ...topOpportunity,
      ...deferred,
      explanation_codes: Array.isArray(deferred.explanation_codes) ? deferred.explanation_codes : topOpportunity.explanation_codes,
      explanation_reasons: Array.isArray(deferred.explanation_reasons) ? deferred.explanation_reasons : topOpportunity.explanation_reasons
    }
  }
  return deferred || topOpportunity || null
}

function getNestedValue(source, fieldName) {
  if (!source) return undefined
  return String(fieldName || '')
    .split('.')
    .filter(Boolean)
    .reduce((accumulator, key) => (accumulator == null ? undefined : accumulator[key]), source)
}

function compareExpectedResult(expected = {}, actualIndex) {
  const failures = []
  const selectedSet = new Set(actualIndex.selectedVisits.map(visit => visit.client_code))

  ;(expected.must_select_clients || []).forEach(clientCode => {
    if (!selectedSet.has(clientCode)) {
      failures.push(`client ${clientCode} devait etre selectionne`)
    }
  })
  ;(expected.must_not_select_clients || []).forEach(clientCode => {
    if (selectedSet.has(clientCode)) {
      failures.push(`client ${clientCode} ne devait pas etre selectionne`)
    }
  })

  Object.entries(expected.allowed_dates_by_client || {}).forEach(([clientCode, allowedDates]) => {
    const dates = (actualIndex.selectedByClientCode.get(clientCode) || []).map(item => item.assigned_date)
    if (dates.some(date => !allowedDates.includes(date))) {
      failures.push(`client ${clientCode} a une date hors fenetre autorisee`)
    }
  })
  Object.entries(expected.forbidden_dates_by_client || {}).forEach(([clientCode, forbiddenDates]) => {
    const dates = (actualIndex.selectedByClientCode.get(clientCode) || []).map(item => item.assigned_date)
    if (dates.some(date => forbiddenDates.includes(date))) {
      failures.push(`client ${clientCode} a ete place sur une date interdite`)
    }
  })
  ;(expected.relative_ranking || []).forEach(([higherClientCode, lowerClientCode]) => {
    const higherIndex = actualIndex.ranking.indexOf(higherClientCode)
    const lowerIndex = actualIndex.ranking.indexOf(lowerClientCode)
    if (higherIndex >= 0 && lowerIndex >= 0 && higherIndex >= lowerIndex) {
      failures.push(`le client ${higherClientCode} devait etre classe avant ${lowerClientCode}`)
    }
  })

  Object.entries(expected.expected_decision_mode || {}).forEach(([clientCode, expectedMode]) => {
    const evidence = resolveClientEvidence(actualIndex, clientCode)
    if (!evidence || evidence.decision_mode !== expectedMode) {
      failures.push(`client ${clientCode} devait etre en decision_mode ${expectedMode}`)
    }
  })
  Object.entries(expected.expected_confidence_range || {}).forEach(([clientCode, range]) => {
    const evidence = resolveClientEvidence(actualIndex, clientCode)
    const confidence = Number(evidence?.confidence)
    if (!Number.isFinite(confidence) || confidence < Number(range.min) || confidence > Number(range.max)) {
      failures.push(`client ${clientCode} devait avoir une confiance dans [${range.min}, ${range.max}]`)
    }
  })
  Object.entries(expected.required_reason_codes || {}).forEach(([clientCode, reasonCodes]) => {
    const evidence = resolveClientEvidence(actualIndex, clientCode)
    const codes = new Set(Array.isArray(evidence?.explanation_codes) ? evidence.explanation_codes : [])
    reasonCodes.forEach(code => {
      if (!codes.has(code)) {
        failures.push(`client ${clientCode} devait contenir le reason code ${code}`)
      }
    })
  })
  Object.entries(expected.forbidden_reason_codes || {}).forEach(([clientCode, reasonCodes]) => {
    const evidence = resolveClientEvidence(actualIndex, clientCode)
    const codes = new Set(Array.isArray(evidence?.explanation_codes) ? evidence.explanation_codes : [])
    reasonCodes.forEach(code => {
      if (codes.has(code)) {
        failures.push(`client ${clientCode} ne devait pas contenir le reason code ${code}`)
      }
    })
  })
  Object.entries(expected.expected_null_fields || {}).forEach(([clientCode, fieldNames]) => {
    const evidence = resolveClientEvidence(actualIndex, clientCode)
    fieldNames.forEach(fieldName => {
      if (getNestedValue(evidence, fieldName) !== null) {
        failures.push(`client ${clientCode} devait garder ${fieldName}=null`)
      }
    })
  })
  Object.entries(expected.expected_known_fields || {}).forEach(([clientCode, fieldNames]) => {
    const evidence = resolveClientEvidence(actualIndex, clientCode)
    fieldNames.forEach(fieldName => {
      const value = getNestedValue(evidence, fieldName)
      if (value == null) {
        failures.push(`client ${clientCode} devait connaitre ${fieldName}`)
      }
    })
  })
  Object.entries(expected.maximum_occurrences_per_day || {}).forEach(([clientCode, maxCount]) => {
    const perDay = (actualIndex.selectedByClientCode.get(clientCode) || []).reduce((map, visit) => {
      map.set(visit.assigned_date, (map.get(visit.assigned_date) || 0) + 1)
      return map
    }, new Map())
    if ([...perDay.values()].some(count => count > Number(maxCount))) {
      failures.push(`client ${clientCode} depasse le maximum quotidien autorise`)
    }
  })
  Object.entries(expected.minimum_occurrences_in_horizon || {}).forEach(([clientCode, minCount]) => {
    const count = (actualIndex.selectedByClientCode.get(clientCode) || []).length
    if (count < Number(minCount)) {
      failures.push(`client ${clientCode} devait apparaitre au moins ${minCount} fois`)
    }
  })
  Object.entries(expected.maximum_occurrences_in_horizon || {}).forEach(([clientCode, maxCount]) => {
    const count = (actualIndex.selectedByClientCode.get(clientCode) || []).length
    if (count > Number(maxCount)) {
      failures.push(`client ${clientCode} ne devait pas apparaitre plus de ${maxCount} fois`)
    }
  })
  ;(expected.expected_warning_codes || []).forEach(code => {
    const warnings = new Set(actualIndex.payload.diagnostics?.warning_codes || [])
    if (!warnings.has(code)) {
      failures.push(`warning code attendu absent: ${code}`)
    }
  })

  return failures
}

function verifyScoreBreakdownConsistency(payload = {}) {
  const failures = []
  const opportunities = Object.values(payload.validation?.top_opportunities_by_client_code || {})
  opportunities.forEach(opportunity => {
    const reconstructedScore = Number(opportunity?.score_breakdown?.reconstructed_score)
    const finalScore = Number(opportunity?.visit_opportunity_score)
    if (!Number.isFinite(reconstructedScore) || !Number.isFinite(finalScore)) return
    if (Math.abs(reconstructedScore - finalScore) > 0.2) {
      failures.push(`score breakdown incoherent pour ${opportunity.client_code}`)
    }
  })
  return failures
}

function normalizeDeterministicPayload(payload = {}) {
  const diagnostics = { ...(payload.diagnostics || {}) }
  const volatileKeys = [
    'portfolio_decisions_build_ms',
    'portfolio_summary_ms',
    'portfolio_feasibility_ms'
  ]
  volatileKeys.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(diagnostics, key)) {
      delete diagnostics[key]
    }
  })

  const meta = {}
  if (payload.meta && payload.meta.performance && Array.isArray(payload.meta.performance.stages)) {
    meta.performance = {
      stages: payload.meta.performance.stages.map(stage => {
        const normalizedStage = { ...stage }
        delete normalizedStage.duration_ms
        return normalizedStage
      })
    }
  }

  return {
    blocks: payload.blocks,
    deferred_clients: payload.deferred_clients,
    diagnostics,
    validation: payload.validation,
    meta
  }
}

async function runValidationScenario(scenarioId) {
  const files = buildFixtureFileMap(scenarioId)
  const validation = validateScenarioSchema(scenarioId, files)
  if (!validation.valid) {
    return {
      scenario_id: scenarioId,
      status: 'FAIL',
      runtime_ms: 0,
      failures: validation.errors,
      technical_validation_status: 'failed',
      logical_validation_status: 'failed',
      commercial_validation_status: 'not_validated',
      data_environment: 'synthetic_validation',
      data_representativeness: 'non_representative'
    }
  }

  const { scenario, inputs, expected } = validation
  const requestContext = normalizeNextBestVisitRequest({
    start_date: scenario.planning_start_date,
    historical_cutoff_date: scenario.historical_cutoff_date || scenario.planning_start_date,
    planning_horizon_days: scenario.planning_horizon_days,
    objective_mode: scenario.objective || 'balanced',
    max_clients: scenario.maximum_visits_per_day || 3,
    min_clients: scenario.minimum_visits_per_day_preference || 0,
    minimum_confidence: scenario.minimum_confidence || 0,
    respect_availability: scenario.availability_mode || 'strict',
    max_days_without_contact: scenario.max_days_without_contact || null,
    max_candidate_dates_per_client: scenario.max_candidate_dates_per_client || 4
  })
  const selectedCommercials = deriveSelectedCommercials(inputs)
  const salesHistoryByClientId = buildHistoryMap(inputs.sales_history, 'purchase_date')
  const visitHistoryByClientId = buildHistoryMap(inputs.visits_history, 'visit_date')
  const startedAt = Date.now()
  const payload = await generateNextBestVisitPlanFromData({
    requestContext,
    clients: inputs.clients,
    selectedCommercials,
    coverageConstraints: inputs.commercial_constraints || {},
    salesHistoryByClientId,
    visitHistoryByClientId,
    predictionResolver: buildPredictionResolverFromRecords(inputs.predictions),
    availabilitySignals: inputs.availability || [],
    sharedDepotOrigin: inputs.shared_depot_origin || null,
    includeValidationDetails: true,
    cacheStatus: 'synthetic_validation',
    profileCacheStatus: 'synthetic_validation',
    profileVersion: `${SYNTHETIC_CACHE_NAMESPACE}:${scenarioId}:profiles`,
    predictionVersion: `${SYNTHETIC_CACHE_NAMESPACE}:${scenarioId}:predictions`,
    constraintsVersion: `${SYNTHETIC_CACHE_NAMESPACE}:${scenarioId}:constraints`
  })
  const runtimeMs = Math.max(0, Date.now() - startedAt)
  const actualIndex = buildScenarioActualIndex(payload)
  const failures = [
    ...compareExpectedResult(expected, actualIndex),
    ...verifyScoreBreakdownConsistency(payload)
  ]
  const deterministicPayload = await generateNextBestVisitPlanFromData({
    requestContext,
    clients: inputs.clients,
    selectedCommercials,
    coverageConstraints: inputs.commercial_constraints || {},
    salesHistoryByClientId,
    visitHistoryByClientId,
    predictionResolver: buildPredictionResolverFromRecords(inputs.predictions),
    availabilitySignals: inputs.availability || [],
    sharedDepotOrigin: inputs.shared_depot_origin || null,
    includeValidationDetails: true,
    cacheStatus: 'synthetic_validation',
    profileCacheStatus: 'synthetic_validation',
    profileVersion: `${SYNTHETIC_CACHE_NAMESPACE}:${scenarioId}:profiles`,
    predictionVersion: `${SYNTHETIC_CACHE_NAMESPACE}:${scenarioId}:predictions`,
    constraintsVersion: `${SYNTHETIC_CACHE_NAMESPACE}:${scenarioId}:constraints`
  })
  const deterministic = JSON.stringify(normalizeDeterministicPayload(payload)) === JSON.stringify(normalizeDeterministicPayload(deterministicPayload))
  if (!deterministic) {
    failures.push('le scenario n est pas deterministe')
  }

  return {
    scenario_id: scenarioId,
    scenario,
    expected_result: expected,
    actual_result: payload,
    status: failures.length ? 'FAIL' : 'PASS',
    runtime_ms: runtimeMs,
    opportunities_count: payload.diagnostics?.opportunities_count ?? 0,
    selected_visits_count: payload.summary?.recommended_visits_count ?? 0,
    failures,
    deterministic,
    critical: scenario.critical !== false,
    technical_validation_status: failures.length ? 'failed' : 'passed',
    logical_validation_status: failures.length ? 'failed' : 'passed',
    commercial_validation_status: 'not_validated',
    data_environment: 'synthetic_validation',
    data_representativeness: 'non_representative'
  }
}

function buildValidationStatuses(results = [], benchmarks = []) {
  const criticalFailures = results.filter(result => result.critical && result.status !== 'PASS')
  const benchmarkFailures = benchmarks.filter(item => item.runtime_ms > item.target_ms)
  return {
    technical_validation_status: criticalFailures.length === 0 && benchmarkFailures.length === 0 ? 'passed' : 'failed',
    logical_validation_status: criticalFailures.length === 0 ? 'passed' : 'failed',
    commercial_validation_status: 'not_validated',
    data_environment: 'synthetic_validation',
    data_representativeness: 'non_representative'
  }
}

function buildSyntheticClient(index) {
  const clientId = String(index + 1)
  const exactCode = String(index + 1).padStart(index % 2 === 0 ? 5 : 3, '0')
  const potentiel = 20 + (index % 80)
  const latitude = 36.7 + ((index % 120) * 0.002)
  const longitude = 10.0 + ((index % 120) * 0.002)
  const commercialCode = `C${String((index % 8) + 1).padStart(2, '0')}`
  return {
    client_id: clientId,
    client_code: exactCode,
    nom: `Client ${exactCode}`,
    user_code: commercialCode,
    resolved_commercial_code: commercialCode,
    latitude,
    longitude,
    potentiel
  }
}

function buildSyntheticInputs({ clientCount, horizonDays }) {
  const planningStartDate = '2026-09-07'
  const clients = Array.from({ length: clientCount }, (_, index) => buildSyntheticClient(index))
  const sales_history = []
  const predictions = []
  const commercials = [...new Set(clients.map(client => client.resolved_commercial_code))]
    .map(code => ({ value: code, label: `Commercial ${code}` }))

  clients.forEach((client, index) => {
    const cadenceDays = index % 5 === 0 ? 7 : index % 5 === 1 ? 14 : index % 5 === 2 ? 30 : index % 5 === 3 ? 4 : 0
    if (cadenceDays > 0) {
      for (let offset = 1; offset <= 8; offset += 1) {
        const date = new Date(`${planningStartDate}T00:00:00Z`)
        date.setUTCDate(date.getUTCDate() - (offset * cadenceDays))
        sales_history.push({
          client_id: client.client_id,
          purchase_date: date.toISOString().slice(0, 10),
          order_value: 80 + ((index % 9) * 25),
          order_quantity: 3 + (index % 6),
          commercial_code: client.resolved_commercial_code
        })
      }
    }
  })

  for (let dayOffset = 0; dayOffset < horizonDays; dayOffset += 1) {
    const date = new Date(`${planningStartDate}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() + dayOffset)
    const candidateDate = date.toISOString().slice(0, 10)
    clients.forEach((client, index) => {
      if (index % 5 === 4 && dayOffset > 1) return
      predictions.push({
        client_id: client.client_id,
        client_code: client.client_code,
        candidate_date: candidateDate,
        purchase_probability: 15 + ((index + dayOffset) % 70),
        predicted_ca: 50 + ((index % 12) * 18) + (dayOffset * 2),
        recommended_quantity: 1 + ((index + dayOffset) % 6),
        model_confidence: 35 + ((index + dayOffset) % 55),
        score: 20 + ((index + dayOffset) % 75),
        vip: 10 + (index % 80),
        prediction_source: 'synthetic_benchmark'
      })
    })
  }

  return {
    clients,
    sales_history,
    visits_history: [],
    predictions,
    availability: [],
    commercials,
    commercial_constraints: {
      commercials: commercials.reduce((accumulator, commercial) => {
        accumulator[commercial.value] = {
          available_dates: Array.from({ length: horizonDays }, (_, offset) => {
            const date = new Date(`${planningStartDate}T00:00:00Z`)
            date.setUTCDate(date.getUTCDate() + offset)
            return date.toISOString().slice(0, 10)
          }),
          unavailable_dates: [],
          hard_max_visits_by_date: {}
        }
        return accumulator
      }, {}),
      client_restrictions: {}
    }
  }
}

async function runSyntheticBenchmarks() {
  const results = []
  for (const target of BENCHMARK_TARGETS) {
    const inputs = buildSyntheticInputs(target)
    const requestContext = normalizeNextBestVisitRequest({
      start_date: '2026-09-07',
      planning_horizon_days: target.horizonDays,
      objective_mode: 'balanced',
      max_clients: Math.max(3, Math.ceil(target.clientCount / 100)),
      respect_availability: 'flexible',
      minimum_confidence: 0,
      max_candidate_dates_per_client: target.horizonDays >= 30 ? 4 : 3
    })
    const startedAt = Date.now()
    const payload = await generateNextBestVisitPlanFromData({
      requestContext,
      clients: inputs.clients,
      selectedCommercials: inputs.commercials,
      coverageConstraints: inputs.commercial_constraints,
      salesHistoryByClientId: buildHistoryMap(inputs.sales_history, 'purchase_date'),
      visitHistoryByClientId: new Map(),
      predictionResolver: buildPredictionResolverFromRecords(inputs.predictions),
      availabilitySignals: [],
      sharedDepotOrigin: { latitude: 36.8065, longitude: 10.1815, nom: 'Depot synthese' },
      cacheStatus: 'synthetic_validation',
      profileCacheStatus: 'synthetic_validation',
      profileVersion: `${SYNTHETIC_CACHE_NAMESPACE}:benchmark:${target.clientCount}:${target.horizonDays}:profiles`,
      predictionVersion: `${SYNTHETIC_CACHE_NAMESPACE}:benchmark:${target.clientCount}:${target.horizonDays}:predictions`,
      constraintsVersion: `${SYNTHETIC_CACHE_NAMESPACE}:benchmark:${target.clientCount}:${target.horizonDays}:constraints`
    })
    results.push({
      client_count: target.clientCount,
      planning_horizon_days: target.horizonDays,
      target_ms: target.targetMs,
      runtime_ms: Math.max(0, Date.now() - startedAt),
      theoretical_cartesian_pairs: payload.diagnostics?.full_cartesian_pair_count ?? null,
      sparse_opportunities_count: payload.diagnostics?.opportunities_count ?? null,
      sparsity_ratio: payload.diagnostics?.sparsity_ratio ?? null,
      average_opportunities_per_client: payload.diagnostics?.average_opportunities_per_client ?? null,
      max_opportunities_per_client: payload.diagnostics?.maximum_opportunities_per_client ?? null,
      stages: payload.meta?.performance?.stages || []
    })
  }
  return results
}

async function runAllValidationScenarios() {
  const scenarioIds = listScenarioIds()
  const startedAt = Date.now()
  const scenarioResults = []
  for (const scenarioId of scenarioIds) {
    scenarioResults.push(await runValidationScenario(scenarioId))
  }
  const benchmarks = await runSyntheticBenchmarks()
  const statuses = buildValidationStatuses(scenarioResults, benchmarks)
  return {
    scenarios: scenarioResults,
    benchmarks,
    statuses,
    summary: {
      total: scenarioResults.length,
      passed: scenarioResults.filter(item => item.status === 'PASS').length,
      failed: scenarioResults.filter(item => item.status !== 'PASS').length,
      critical_failures: scenarioResults.filter(item => item.critical && item.status !== 'PASS').length,
      deterministic: scenarioResults.every(item => item.deterministic),
      total_runtime_ms: Math.max(0, Date.now() - startedAt)
    }
  }
}

module.exports = {
  BENCHMARK_TARGETS,
  FIXTURES_ROOT,
  SYNTHETIC_CACHE_NAMESPACE,
  __testables: {
    generateNextBestVisitPlanFromData
  },
  buildSyntheticInputs,
  listScenarioIds,
  listScenarioSummaries,
  runAllValidationScenarios,
  runSyntheticBenchmarks,
  runValidationScenario,
  validateScenarioSchema
}

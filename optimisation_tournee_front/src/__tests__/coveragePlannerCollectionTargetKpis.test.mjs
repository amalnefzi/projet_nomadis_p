import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

function loadCoveragePlannerCollectionTargetHelpers() {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'CoveragePlanner.jsx'),
    'utf8'
  )
  const snippetStart = source.indexOf('const REQUEST_TIMEOUT_MS')
  const snippetEnd = source.indexOf('function buildAdjustmentNotes')

  assert.notEqual(snippetStart, -1)
  assert.notEqual(snippetEnd, -1)

  const context = {
    DEFAULT_COVERAGE_PERIOD_DAYS: 14,
    DEFAULT_COVERAGE_VISIT_FREQUENCY_DAYS: 14,
    todayIsoDate: () => '2026-08-28'
  }

  vm.runInNewContext(
    `
${source.slice(snippetStart, snippetEnd)}
globalThis.__coveragePlannerCollectionTargetTestables = {
  buildCollectionTargetGlobalKpis
}
    `,
    context
  )

  return {
    source,
    ...context.__coveragePlannerCollectionTargetTestables
  }
}

function getMetric(metrics, label) {
  return metrics.find(metric => metric.label === label) || null
}

test('recovery planner global KPIs rely on top-level collection_target_context only', () => {
  const { source, buildCollectionTargetGlobalKpis } = loadCoveragePlannerCollectionTargetHelpers()

  assert.equal(source.includes('functional_metadata'), false)

  const metrics = buildCollectionTargetGlobalKpis({
    collection_target_context: {
      mode: 'target_collection',
      requested_target_collection_amount: 100,
      selected_estimated_collection_amount: 80,
      estimated_remaining_amount: 20,
      is_target_reached: false,
      stop_reason: 'analysis_fallback'
    },
    functional_metadata: {
      collection_target_context: {
        mode: 'target_collection',
        requested_target_collection_amount: 999,
        selected_estimated_collection_amount: 999,
        estimated_remaining_amount: 0,
        is_target_reached: true,
        stop_reason: 'target_reached'
      }
    }
  })

  assert.equal(getMetric(metrics, 'Objectif de collecte')?.value, '100,00 DT')
  assert.equal(getMetric(metrics, 'Collecte planifiee')?.value, '80,00 DT')
  assert.equal(getMetric(metrics, 'Reste estime')?.value, '20,00 DT')
  assert.equal(getMetric(metrics, "Statut de l'objectif")?.value, 'Objectif partiellement atteint')
})

test('recovery planner hides collection target KPIs when no plan context is available', () => {
  const { buildCollectionTargetGlobalKpis } = loadCoveragePlannerCollectionTargetHelpers()

  assert.equal(buildCollectionTargetGlobalKpis({}), null)
  assert.equal(buildCollectionTargetGlobalKpis(null), null)
})

test('recovery planner shows no candidates status for empty positive target responses', () => {
  const { buildCollectionTargetGlobalKpis } = loadCoveragePlannerCollectionTargetHelpers()

  const metrics = buildCollectionTargetGlobalKpis({
    collection_target_context: {
      mode: 'target_collection',
      requested_target_collection_amount: 150,
      selected_estimated_collection_amount: 0,
      estimated_remaining_amount: 150,
      is_target_reached: false,
      stop_reason: 'no_candidates'
    }
  })

  assert.equal(getMetric(metrics, 'Collecte planifiee')?.value, '0,00 DT')
  assert.equal(getMetric(metrics, "Statut de l'objectif")?.value, 'Aucun client recouvrable')
})

test('recovery planner shows unreachable status when no slots remain available', () => {
  const { buildCollectionTargetGlobalKpis } = loadCoveragePlannerCollectionTargetHelpers()

  const metrics = buildCollectionTargetGlobalKpis({
    collection_target_context: {
      mode: 'target_collection',
      requested_target_collection_amount: 180,
      selected_estimated_collection_amount: 0,
      estimated_remaining_amount: 180,
      is_target_reached: false,
      stop_reason: 'target_unreachable'
    }
  })

  assert.equal(getMetric(metrics, 'Objectif de collecte')?.value, '180,00 DT')
  assert.equal(getMetric(metrics, 'Reste estime')?.value, '180,00 DT')
  assert.equal(
    getMetric(metrics, "Statut de l'objectif")?.value,
    'Objectif non atteignable avec la capacite disponible'
  )
})

test('recovery planner marks reached targets and never shows negative amounts', () => {
  const { buildCollectionTargetGlobalKpis } = loadCoveragePlannerCollectionTargetHelpers()

  const metrics = buildCollectionTargetGlobalKpis({
    collection_target_context: {
      mode: 'target_collection',
      requested_target_collection_amount: 90,
      selected_estimated_collection_amount: 95.005,
      estimated_remaining_amount: -5,
      is_target_reached: true,
      stop_reason: 'target_reached'
    }
  })

  assert.equal(getMetric(metrics, 'Collecte planifiee')?.value, '95,01 DT')
  assert.equal(getMetric(metrics, 'Reste estime')?.value, '0,00 DT')
  assert.equal(getMetric(metrics, "Statut de l'objectif")?.value, 'Objectif atteint')
})

test('recovery planner accepts partial_target stop reasons as partially reached targets', () => {
  const { buildCollectionTargetGlobalKpis } = loadCoveragePlannerCollectionTargetHelpers()

  const metrics = buildCollectionTargetGlobalKpis({
    collection_target_context: {
      mode: 'target_collection',
      requested_target_collection_amount: 50,
      selected_estimated_collection_amount: 45.556,
      estimated_remaining_amount: 4.444,
      is_target_reached: false,
      stop_reason: 'partial_target'
    }
  })

  assert.equal(getMetric(metrics, 'Collecte planifiee')?.value, '45,56 DT')
  assert.equal(getMetric(metrics, 'Reste estime')?.value, '4,44 DT')
  assert.equal(getMetric(metrics, "Statut de l'objectif")?.value, 'Objectif partiellement atteint')
})

test('recovery planner shows full coverage KPIs as non applicable while keeping known collection totals', () => {
  const { buildCollectionTargetGlobalKpis } = loadCoveragePlannerCollectionTargetHelpers()

  const metrics = buildCollectionTargetGlobalKpis({
    collection_target_context: {
      mode: 'full_coverage',
      requested_target_collection_amount: null,
      selected_estimated_collection_amount: 230.5,
      estimated_remaining_amount: null,
      is_target_reached: null,
      stop_reason: 'full_coverage'
    }
  })

  assert.equal(getMetric(metrics, 'Objectif de collecte')?.value, 'Non applicable')
  assert.equal(getMetric(metrics, 'Collecte planifiee')?.value, '230,50 DT')
  assert.equal(getMetric(metrics, 'Reste estime')?.value, 'Non applicable')
  assert.equal(getMetric(metrics, "Statut de l'objectif")?.value, 'Couverture complete')
})

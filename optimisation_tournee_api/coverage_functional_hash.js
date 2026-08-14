const crypto = require('node:crypto')

const { stableStringify } = require('./coverage_history_cache')

const CANONICAL_COVERAGE_SUMMARY_FIELDS = [
  'planning_start_date',
  'planning_end_date',
  'clients_to_cover',
  'unique_clients_covered',
  'missing_clients_count',
  'duplicate_clients_count',
  'total_visits',
  'total_slots',
  'used_slots',
  'unused_slots',
  'total_capacity',
  'required_average_per_slot',
  'required_minimum_max_per_slot',
  'total_predicted_ca',
  'predicted_ca_known_count',
  'predicted_ca_unknown_count',
  'predicted_ca_is_complete',
  'total_ca_shortfall',
  'solver_status',
  'coverage_rate',
  'average_clients_per_route',
  'routes_count',
  'active_clients',
  'unique_clients_planned',
  'missing_clients',
  'duplicate_clients',
  'predicted_ca',
  'total_estimated_km'
]

function coverageHashSortValue(value) {
  if (value == null) return [0, '']
  if (typeof value === 'boolean') return [1, value ? '1' : '0']
  if (typeof value === 'number') return [2, String(value)]
  return [3, String(value)]
}

function compareCoverageHashValues(left, right) {
  const leftValue = coverageHashSortValue(left)
  const rightValue = coverageHashSortValue(right)
  if (leftValue[0] !== rightValue[0]) {
    return leftValue[0] - rightValue[0]
  }
  return leftValue[1].localeCompare(rightValue[1])
}

function buildCanonicalCoverageFunctionalSnapshot(plan = {}) {
  const summary = plan?.summary && typeof plan.summary === 'object'
    ? plan.summary
    : {}
  const diagnostics = plan?.diagnostics && typeof plan.diagnostics === 'object'
    ? plan.diagnostics
    : {}
  const plannedAssignments = []

  ;(Array.isArray(plan?.blocks) ? plan.blocks : []).forEach(block => {
    if (!block || typeof block !== 'object') return
    const slotId = block.slot_id ?? null
    const date = block.date ?? null
    const commercialCode = block.commercial_code ?? null
    ;(Array.isArray(block.clients) ? block.clients : []).forEach(client => {
      if (!client || typeof client !== 'object') return
      plannedAssignments.push({
        slot_id: slotId,
        date,
        commercial_code: commercialCode,
        visit_order: client.visit_order ?? null,
        client_id: client.client_id == null ? null : String(client.client_id),
        client_code: client.client_code == null ? null : String(client.client_code),
        predicted_ca: client.predicted_ca ?? null,
        recommended_quantity: client.recommended_quantity ?? null,
        purchase_prediction_score: client.purchase_prediction_score ?? null,
        recovery_priority_score: client.recovery_priority_score ?? null
      })
    })
  })

  plannedAssignments.sort((left, right) => {
    const keys = ['date', 'commercial_code', 'slot_id', 'visit_order', 'client_id', 'client_code']
    for (const key of keys) {
      const diff = compareCoverageHashValues(left[key], right[key])
      if (diff !== 0) return diff
    }
    return 0
  })

  const summarySnapshot = {}
  CANONICAL_COVERAGE_SUMMARY_FIELDS.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(summary, field)) {
      summarySnapshot[field] = summary[field]
    }
  })

  const unassignedClientIds = (Array.isArray(diagnostics.missing_clients) ? diagnostics.missing_clients : [])
    .map(value => (value == null ? null : String(value)))
    .sort(compareCoverageHashValues)
  const duplicateClientIds = (Array.isArray(diagnostics.duplicate_clients) ? diagnostics.duplicate_clients : [])
    .map(value => (value == null ? null : String(value)))
    .sort(compareCoverageHashValues)

  return {
    planned_assignments: plannedAssignments,
    unassigned_client_ids: unassignedClientIds,
    duplicate_client_ids: duplicateClientIds,
    summary: summarySnapshot
  }
}

function computeStableObjectHash(value) {
  return crypto
    .createHash('sha256')
    .update(stableStringify(value), 'utf8')
    .digest('hex')
}

function computeCoverageFunctionalResultHash(plan = {}) {
  return computeStableObjectHash(buildCanonicalCoverageFunctionalSnapshot(plan))
}

module.exports = {
  buildCanonicalCoverageFunctionalSnapshot,
  computeStableObjectHash,
  computeCoverageFunctionalResultHash,
  normalizeFunctionalValue: buildCanonicalCoverageFunctionalSnapshot
}

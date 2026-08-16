function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function roundScore(value) {
  return Math.round(Number(value || 0) * 10) / 10
}

const OBJECTIVE_WEIGHT_SETS = Object.freeze({
  maximize_sales: {
    purchase_probability: 0.31,
    predicted_ca: 0.26,
    recommended_quantity: 0.08,
    cadence_due: 0.12,
    strategic_client: 0.05,
    inactivity_risk: 0.05,
    availability: 0.04,
    geographic_synergy: 0.06,
    max_days_without_contact: 0.03,
    recent_purchase_penalty: -0.05,
    detour_penalty: -0.04,
    time_penalty: -0.02
  },
  balanced: {
    purchase_probability: 0.23,
    predicted_ca: 0.18,
    recommended_quantity: 0.06,
    cadence_due: 0.16,
    strategic_client: 0.06,
    inactivity_risk: 0.10,
    availability: 0.06,
    geographic_synergy: 0.08,
    max_days_without_contact: 0.08,
    recent_purchase_penalty: -0.08,
    detour_penalty: -0.06,
    time_penalty: -0.03
  },
  reactivate_at_risk: {
    purchase_probability: 0.14,
    predicted_ca: 0.10,
    recommended_quantity: 0.04,
    cadence_due: 0.14,
    strategic_client: 0.06,
    inactivity_risk: 0.22,
    availability: 0.05,
    geographic_synergy: 0.07,
    max_days_without_contact: 0.15,
    recent_purchase_penalty: -0.05,
    detour_penalty: -0.06,
    time_penalty: -0.01
  },
  commercial_priority: {
    purchase_probability: 0.18,
    predicted_ca: 0.14,
    recommended_quantity: 0.05,
    cadence_due: 0.14,
    strategic_client: 0.14,
    inactivity_risk: 0.10,
    availability: 0.05,
    geographic_synergy: 0.07,
    max_days_without_contact: 0.10,
    recent_purchase_penalty: -0.05,
    detour_penalty: -0.05,
    time_penalty: -0.02
  }
})

function resolveObjectiveWeightSet(mode = 'balanced') {
  const normalized = String(mode || 'balanced').trim().toLowerCase()
  return OBJECTIVE_WEIGHT_SETS[normalized] || OBJECTIVE_WEIGHT_SETS.balanced
}

function normalizeRiskLabel(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'high') return 1
  if (normalized === 'medium') return 0.6
  if (normalized === 'low') return 0.25
  return null
}

function normalizeAvailability(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'explicit_available') return 1
  if (normalized === 'estimated_available') return 0.65
  if (normalized === 'unknown') return null
  if (normalized === 'explicit_unavailable') return 0
  return null
}

function normalizeRatio(value, maxValue) {
  const numeric = Number(value)
  const numericMax = Number(maxValue)
  if (!Number.isFinite(numeric) || !(numericMax > 0)) return null
  return clamp(numeric / numericMax, 0, 1)
}

function normalizeDetourPenalty(distanceKm, context = {}) {
  const numericDistance = Number(distanceKm)
  if (!Number.isFinite(numericDistance) || numericDistance <= 0) return null
  const maxDistance = Math.max(1, Number(context.maxDetourKm || 30) || 30)
  return clamp(numericDistance / maxDistance, 0, 1)
}

function normalizeTimePenalty(timeMinutes, context = {}) {
  const numericMinutes = Number(timeMinutes)
  if (!Number.isFinite(numericMinutes) || numericMinutes <= 0) return null
  const maxMinutes = Math.max(1, Number(context.maxVisitMinutes || 90) || 90)
  return clamp(numericMinutes / maxMinutes, 0, 1)
}

function normalizeRecentPurchasePenalty(opportunity = {}) {
  const daysSinceLastPurchase = Number(opportunity.days_since_last_purchase)
  if (!Number.isFinite(daysSinceLastPurchase)) return null
  if (daysSinceLastPurchase <= 1) return 1
  if (daysSinceLastPurchase <= 2) return 0.8
  if (daysSinceLastPurchase <= 3) return 0.6
  if (daysSinceLastPurchase <= 5) return 0.35
  return 0
}

function computeOpportunityScore(opportunity = {}, context = {}) {
  const weights = resolveObjectiveWeightSet(context.objectiveMode)
  const preselectionDistanceKm = opportunity.preselection_distance_estimate_km ?? opportunity.incremental_distance_estimate
  const valueMap = {
    purchase_probability: normalizeRatio(opportunity.purchase_probability, 100),
    predicted_ca: normalizeRatio(opportunity.predicted_ca, context.maxPredictedCa),
    recommended_quantity: normalizeRatio(opportunity.recommended_quantity, context.maxRecommendedQuantity),
    cadence_due: normalizeRatio(opportunity.cadence_due_score, 100),
    strategic_client: normalizeRatio(opportunity.strategic_client_score, 100),
    inactivity_risk: normalizeRiskLabel(opportunity.inactivity_risk),
    availability: normalizeAvailability(opportunity.availability_status),
    geographic_synergy: normalizeRatio(opportunity.geographic_synergy_score, 100),
    max_days_without_contact: opportunity.max_days_without_contact_guardrail ? 1 : 0,
    recent_purchase_penalty: normalizeRecentPurchasePenalty(opportunity),
    detour_penalty: normalizeDetourPenalty(preselectionDistanceKm, context),
    time_penalty: normalizeTimePenalty(opportunity.estimated_visit_time_minutes, context)
  }

  let weightedTotal = 0
  let positiveWeightTotal = 0
  const components = {}
  const breakdown = {}
  const ignoredSignals = []

  Object.entries(weights).forEach(([key, weight]) => {
    const value = valueMap[key]
    if (value == null) {
      components[key] = null
      breakdown[key] = {
        weight,
        normalized_value: null,
        contribution_raw: null,
        contribution_score_points: null,
        ignored: true
      }
      ignoredSignals.push(key)
      return
    }

    components[key] = roundScore(value * 100)
    weightedTotal += value * weight
    positiveWeightTotal += Math.abs(weight)
    breakdown[key] = {
      weight,
      normalized_value: roundScore(value * 100),
      contribution_raw: Number((value * weight).toFixed(6)),
      contribution_score_points: null,
      ignored: false
    }
  })

  if (!(positiveWeightTotal > 0)) {
    return {
      visit_opportunity_score: 0,
      score_components: components,
      weights,
      score_breakdown: {
        components: breakdown,
        ignored_signals: ignoredSignals,
        normalization_denominator: 0,
        weighted_total_raw: 0,
        reconstructed_score: 0
      }
    }
  }

  const normalizedScore = clamp((weightedTotal / positiveWeightTotal) * 100, 0, 100)
  Object.values(breakdown).forEach(entry => {
    if (!entry || entry.ignored || entry.contribution_raw == null) return
    entry.contribution_score_points = roundScore((entry.contribution_raw / positiveWeightTotal) * 100)
  })
  return {
    visit_opportunity_score: roundScore(normalizedScore),
    score_components: components,
    weights,
    score_breakdown: {
      components: breakdown,
      ignored_signals: ignoredSignals,
      normalization_denominator: roundScore(positiveWeightTotal),
      weighted_total_raw: Number(weightedTotal.toFixed(6)),
      reconstructed_score: roundScore(normalizedScore)
    }
  }
}

module.exports = {
  OBJECTIVE_WEIGHT_SETS,
  computeOpportunityScore,
  resolveObjectiveWeightSet
}

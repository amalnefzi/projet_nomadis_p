function roundScore(value) {
  return Math.round(Number(value || 0) * 10) / 10
}

function resolveDateSourceLabel(opportunity = {}) {
  switch (String(opportunity.candidate_date_source || '').trim()) {
    case 'purchase_prediction':
      return 'Date predite d achat'
    case 'purchase_cadence':
      return 'Rythme d achat habituel'
    case 'usual_weekday':
      return 'Rythme d achat habituel'
    case 'low_history_fallback':
      return 'Fenetre flexible - historique limite'
    case 'exploration_fallback':
      return 'Date d exploration repartie dans l horizon'
    case 'max_days_without_contact':
      return 'Garde-fou sans contact'
    case 'explicit_constraint':
      return 'Contrainte explicite'
    default:
      return null
  }
}

function buildSelectedVisitExplanation(opportunity = {}) {
  const reasons = []
  const codes = [...new Set(Array.isArray(opportunity.explanation_codes) ? opportunity.explanation_codes : [])]
  const dateSourceLabel = resolveDateSourceLabel(opportunity)

  if (dateSourceLabel) {
    reasons.push(dateSourceLabel)
  }

  if (codes.includes('PURCHASE_WINDOW_NEAR') && Number.isFinite(Number(opportunity.purchase_days_until_prediction))) {
    reasons.push(`achat probable dans ${Math.max(0, Math.round(Number(opportunity.purchase_days_until_prediction)))} jour(s)`)
  }
  if (codes.includes('HIGH_PURCHASE_PROBABILITY') && Number.isFinite(Number(opportunity.purchase_probability))) {
    reasons.push(`probabilite d'achat ${roundScore(opportunity.purchase_probability)} %`)
  }
  if (codes.includes('HIGH_EXPECTED_CA') && Number.isFinite(Number(opportunity.predicted_ca))) {
    reasons.push(`CA attendu ${roundScore(opportunity.predicted_ca)} TND`)
  }
  if (Number.isFinite(Number(opportunity.recommended_quantity))) {
    reasons.push(`quantite recommandee ${roundScore(opportunity.recommended_quantity)}`)
  }
  if (codes.includes('USUAL_PURCHASE_WEEKDAY') && Array.isArray(opportunity.usual_purchase_weekdays) && opportunity.usual_purchase_weekdays.length) {
    reasons.push(`jour habituel compatible (${opportunity.usual_purchase_weekdays.join(', ')})`)
  }
  if (codes.includes('GEOGRAPHIC_SYNERGY') && Number.isFinite(Number(opportunity.nearby_priority_clients_count)) && Number(opportunity.nearby_priority_clients_count) > 0) {
    reasons.push(`${Math.round(Number(opportunity.nearby_priority_clients_count))} autre(s) client(s) prioritaire(s) a proximite`)
  }
  if (codes.includes('INACTIVITY_RISK') && Number.isFinite(Number(opportunity.days_since_last_purchase))) {
    reasons.push(`derniere commande il y a ${Math.round(Number(opportunity.days_since_last_purchase))} jour(s)`)
  }
  if (codes.includes('MAX_DAYS_WITHOUT_CONTACT') && opportunity.max_days_without_contact_guardrail) {
    reasons.push('garde-fou max jours sans contact atteint')
  }
  if (codes.includes('AVAILABILITY_UNKNOWN') && String(opportunity.availability_status || '').trim().toLowerCase() === 'unknown') {
    reasons.push('disponibilite client inconnue')
  }
  if (codes.includes('EXPLORATION_VISIT') && String(opportunity.decision_mode || '') === 'exploration') {
    reasons.push('visite d exploration faute d historique exploitable')
  }
  if (codes.includes('LOW_HISTORY_HYBRID') && String(opportunity.decision_mode || '') === 'hybrid') {
    reasons.push('historique insuffisant, decision hybride')
  }
  if (String(opportunity.repeat_justification_code || '') === 'distinct_prediction_cycle') {
    reasons.push('Nouveau cycle d achat predit')
  }
  if (String(opportunity.repeat_justification_code || '') === 'high_frequency_cadence') {
    reasons.push('Cadence d achat frequente confirmee')
  }
  if (String(opportunity.repeat_justification_code || '') === 'explicit_constraint') {
    reasons.push('Rendez-vous distinct')
  }
  if (String(opportunity.repeat_justification_code || '') === 'distinct_guardrail_cycle') {
    reasons.push('Garde-fou commercial distinct')
  }
  if (opportunity.shifted_within_recommended_window || (
    String(opportunity.assigned_date || '') &&
    String(opportunity.preferred_date || opportunity.candidate_date || '') &&
    String(opportunity.assigned_date || '') !== String(opportunity.preferred_date || opportunity.candidate_date || '')
  )) {
    reasons.push('date choisie dans la fenetre recommandee pour ameliorer la tournee')
  }

  return {
    explanation_codes: codes,
    explanation_reasons: reasons,
    date_source_label: dateSourceLabel
  }
}

function buildDeferredClientExplanation({
  client,
  deferredReasonCodes = [],
  bestFutureDate = null
}) {
  const reasons = []
  const codes = [...new Set(deferredReasonCodes.map(code => String(code || '').trim()).filter(Boolean))]

  if (codes.includes('RECENT_PURCHASE_DEPRIORITIZED')) reasons.push('achat trop recent')
  if (codes.includes('LOW_PURCHASE_PROBABILITY')) reasons.push('probabilite d achat trop faible')
  if (codes.includes('EXPLICIT_UNAVAILABLE')) reasons.push('indisponibilite explicite')
  if (codes.includes('DETOUR_TOO_LARGE')) reasons.push('detour trop important')
  if (codes.includes('CAPACITY_REACHED')) reasons.push('capacite journaliere atteinte')
  if (codes.includes('LOW_CONFIDENCE')) reasons.push('confiance insuffisante')
  if (bestFutureDate) reasons.push(`meilleure date recommandee ulterieure ${bestFutureDate}`)
  if (!reasons.length) reasons.push('aucune opportunite retenue dans l horizon courant')

  return {
    client_id: String(client?.client_id || ''),
    client_code: String(client?.client_code || ''),
    explanation_codes: codes,
    explanation_reasons: reasons,
    best_future_date: bestFutureDate
  }
}

module.exports = {
  buildDeferredClientExplanation,
  buildSelectedVisitExplanation
}

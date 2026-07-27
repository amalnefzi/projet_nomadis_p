import { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

function formatDuration(seconds) {
  const totalMinutes = Math.round((seconds || 0) / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours <= 0) return `${minutes} min`
  return `${hours} h ${minutes.toString().padStart(2, '0')}`
}

function formatDistance(meters) {
  const km = (meters || 0) / 1000
  return `${km.toFixed(km >= 10 ? 0 : 1)} km`
}

function buildOsrmStepText(step) {
  const maneuver = step?.maneuver || {}
  const type = maneuver.type || 'continue'
  const modifier = maneuver.modifier || ''
  const street = step?.name ? ` sur ${step.name}` : ''

  if (type === 'depart') return `Demarrer${street}`
  if (type === 'arrive') return 'Arriver a destination'
  if (type === 'roundabout') return `Prendre le rond-point${street}`
  if (type === 'merge') return `S'engager${street}`
  if (type === 'new name') return `Continuer${street}`
  if (type === 'fork') return `Prendre l'embranchement ${modifier}${street}`.trim()
  if (type === 'end of road') return `Au bout de la route, tourner ${modifier}${street}`.trim()
  if (type === 'turn') return `Tourner ${modifier}${street}`.trim()
  return `Continuer${street}`
}

function buildGoogleMapsUrl(origin, stops) {
  if (!stops.length) return '#'
  const destination = stops[stops.length - 1]
  const waypoints = stops
    .slice(0, -1)
    .map(stop => `${stop.latitude},${stop.longitude}`)
    .join('|')
  const originParam = origin
    ? `origin=${origin.latitude},${origin.longitude}&`
    : ''

  return `https://www.google.com/maps/dir/?api=1&${originParam}destination=${destination.latitude},${destination.longitude}&travelmode=driving${waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : ''}`
}

function todayIsoDate() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeGeoStop(stop, index = 0) {
  const latitude = Number(stop?.latitude)
  const longitude = Number(stop?.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null
  }

  return {
    ...stop,
    latitude,
    longitude,
    step: index + 1
  }
}

function buildApiCandidates(api) {
  const candidates = []
  const seen = new Set()
  const pushCandidate = value => {
    const normalized = String(value || '').trim()
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  pushCandidate(api)
  pushCandidate('http://localhost:5000')
  pushCandidate('http://127.0.0.1:5000')

  if (typeof window !== 'undefined' && window.location?.hostname) {
    pushCandidate(`http://${window.location.hostname}:5000`)
  }

  return candidates
}

const OPTIONS_REQUEST_TIMEOUT_MS = 20000
const COVERAGE_REQUEST_TIMEOUT_MS = 240000
const COVERAGE_REQUEST_TIMEOUT_MAX_MS = 600000

function computeCoverageRequestTimeoutMs(filters, selectedCommercialCount, totalCommercialCount) {
  const periodDays = Math.max(1, Number(filters?.period_days || 14))
  const resolvedCommercialCount = Math.max(
    1,
    Number(selectedCommercialCount || 0) || Number(totalCommercialCount || 0) || 1
  )
  const extraDays = Math.max(0, periodDays - 14)
  const extraCommercials = Math.max(0, resolvedCommercialCount - 1)

  return Math.min(
    COVERAGE_REQUEST_TIMEOUT_MAX_MS,
    COVERAGE_REQUEST_TIMEOUT_MS + (extraDays * 15000) + (extraCommercials * 20000)
  )
}

function countCoverageWorkingDays(startDateValue, periodDaysValue) {
  const parsedPeriodDays = Number.parseInt(periodDaysValue, 10)
  if (!startDateValue || !Number.isFinite(parsedPeriodDays) || parsedPeriodDays <= 0) {
    return 0
  }

  const [year, month, day] = String(startDateValue).slice(0, 10).split('-').map(Number)
  const startDate = new Date(year, (month || 1) - 1, day || 1)
  if (Number.isNaN(startDate.getTime())) {
    return 0
  }

  startDate.setHours(0, 0, 0, 0)
  let workingDaysCount = 0

  for (let offset = 0; offset < parsedPeriodDays; offset += 1) {
    const current = new Date(startDate)
    current.setDate(startDate.getDate() + offset)
    current.setHours(0, 0, 0, 0)
    if (current.getDay() !== 0) {
      workingDaysCount += 1
    }
  }

  return workingDaysCount
}

function buildCoverageErrorHelp(payload, fallbackInput = {}) {
  const toInt = value => {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }
  const toNumber = value => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  const diagnostics = payload?.diagnostics && typeof payload.diagnostics === 'object'
    ? payload.diagnostics
    : {}
  const context = payload?.context && typeof payload.context === 'object'
    ? payload.context
    : {}
  const reasonCode = String(payload?.reason_code || '').trim()
  const startDate = String(context.start_date || fallbackInput.start_date || todayIsoDate()).trim()
  const periodDays = toInt(context.period_days ?? fallbackInput.period_days)
  const minVisits = toInt(context.min_visits ?? fallbackInput.min_visits)
  const maxVisits = toInt(context.max_visits ?? fallbackInput.max_visits)
  const requestedMinRaw = toInt(
    diagnostics.requested_min_visits_raw ??
    context.requested_min_visits_raw ??
    fallbackInput.min_visits
  )
  const requestedMaxRaw = toInt(
    diagnostics.requested_max_visits_raw ??
    context.requested_max_visits_raw ??
    fallbackInput.max_visits
  )
  const normalizedMinVisits = toInt(diagnostics.normalized_min_visits ?? minVisits)
  const normalizedMaxVisits = toInt(diagnostics.normalized_max_visits ?? maxVisits)
  const selectedCommercialsCount = Number(
    context.selected_commercials_count ?? fallbackInput.selected_commercials_count ?? 0
  )
  const workingDaysCount = Number(
    context.working_days_count ?? countCoverageWorkingDays(startDate, periodDays)
  )
  const estimatedBlocks = Number(
    diagnostics.estimated_blocks ??
    (workingDaysCount > 0 && selectedCommercialsCount > 0 ? workingDaysCount * selectedCommercialsCount : 0)
  )
  const strictEligibleBlocks = Number(diagnostics.strict_eligible_blocks ?? 0)
  const bestHistoricalBlockCapacity = Number(diagnostics.best_historical_block_capacity ?? 0)
  const strictTotalCapacityVisits = Number(diagnostics.strict_total_capacity_visits ?? diagnostics.estimated_capacity_visits ?? 0)
  const estimatedRequiredVisits = Number(diagnostics.estimated_required_visits ?? 0)
  const selectedBlocks = Number(diagnostics.strict_selected_blocks ?? 0)
  const deferredVisits = Number(diagnostics.deferred_assignment_visits ?? 0)
  const blockedByClientCapacity = Number(diagnostics.blocked_by_client_capacity ?? 0)
  const blockedByTruckCapacity = Number(diagnostics.blocked_by_truck_capacity ?? 0)
  const explicitRecommendedMin = Number(diagnostics.recommended_min_visits ?? 0)
  const explicitRecommendedMax = Number(diagnostics.recommended_max_visits ?? 0)
  const averageCandidatePerBlock = estimatedBlocks > 0 ? Math.floor(estimatedRequiredVisits / estimatedBlocks) : 0
  const requestedFullCoverageImpossible = Boolean(diagnostics.requested_full_coverage_impossible)
  const fullCoverageMaxCapacity = toInt(diagnostics.full_coverage_max_capacity)
  const requiredAverageVisitsPerBlock = toInt(diagnostics.required_average_visits_per_block)
  const fullCoverageShortfall = toInt(diagnostics.full_coverage_shortfall)
  const effectiveMinVisits = toInt(diagnostics.effective_min_visits)
  const effectiveMaxVisits = toInt(diagnostics.effective_max_visits)
  const actualMinClientsPerBlock = toInt(diagnostics.actual_min_clients_per_block)
  const actualMaxClientsPerBlock = toInt(diagnostics.actual_max_clients_per_block)
  const actualBlocksCount = toInt(diagnostics.actual_blocks_count)
  const actualTotalVisits = toInt(diagnostics.actual_total_visits)
  const totalCandidateClients = toInt(diagnostics.total_candidate_clients ?? estimatedRequiredVisits)
  const coveredUniqueClients = toInt(diagnostics.covered_unique_clients)
  const deferredUniqueClients = toInt(diagnostics.deferred_unique_clients)
  const blocksBelowRequestedMin = toInt(diagnostics.blocks_below_requested_min)
  const blocksAboveRequestedMax = toInt(diagnostics.blocks_above_requested_max)
  const plannedTruckCapacity = toNumber(diagnostics.planned_truck_capacity)
  const requestedTruckUnits = toNumber(diagnostics.requested_truck_units)
  const strictFailureReason = String(diagnostics.strict_failure_reason || '').trim()
  const rangeInputNormalized = Boolean(diagnostics.range_input_normalized ?? context.range_input_normalized)
  const minTotalCa = toNumber(diagnostics.min_total_ca ?? context.min_total_ca ?? fallbackInput.min_total_ca)
  const totalPredictedCa = toNumber(diagnostics.total_predicted_ca)
  const requestedRangeLabel = `${requestedMinRaw || normalizedMinVisits || minVisits || '?'}-${requestedMaxRaw || normalizedMaxVisits || maxVisits || '?'}`
  const normalizedRangeLabel = `${normalizedMinVisits || minVisits || '?'}-${normalizedMaxVisits || maxVisits || '?'}`
  const obtainedRangeLabel = actualMinClientsPerBlock > 0
    ? `${actualMinClientsPerBlock}-${actualMaxClientsPerBlock}`
    : `${effectiveMinVisits || normalizedMinVisits || minVisits || '?'}-${effectiveMaxVisits || normalizedMaxVisits || maxVisits || '?'}`

  const recommendedMinCandidates = [
    explicitRecommendedMin,
    bestHistoricalBlockCapacity > 0 ? Math.floor(bestHistoricalBlockCapacity * 0.9) : 0,
    averageCandidatePerBlock > 0 ? averageCandidatePerBlock : 0
  ].filter(value => Number.isFinite(value) && value > 0)

  const recommendedMinVisits = recommendedMinCandidates.length
    ? Math.max(1, Math.min(...recommendedMinCandidates))
    : 0
  const recommendedMaxVisits = explicitRecommendedMax > 0
    ? Math.max(recommendedMinVisits || 1, explicitRecommendedMax)
    : bestHistoricalBlockCapacity > 0
      ? Math.max(recommendedMinVisits || 1, bestHistoricalBlockCapacity)
      : Math.max(recommendedMinVisits || 1, maxVisits || 1)

  const formula = [
    '1 block potentiel = 1 jour ouvrable x 1 commercial selectionne.',
    `Un block n'est retenu que si sa capacite historique respecte la plage ${minVisits || '?'}-${maxVisits || '?'} clients.`,
    'La repartition finale refuse tout depassement de capacite clients ou de charge camion.'
  ]

  const metrics = []
  const upsertMetric = (label, value) => {
    if (value === null || value === undefined || value === '') return
    const index = metrics.findIndex(item => item.label === label)
    const nextMetric = { label, value: String(value) }
    if (index >= 0) {
      metrics[index] = nextMetric
      return
    }
    metrics.push(nextMetric)
  }
  if (workingDaysCount > 0) metrics.push({ label: 'Jours ouvrables', value: String(workingDaysCount) })
  if (selectedCommercialsCount > 0) metrics.push({ label: 'Commerciaux', value: String(selectedCommercialsCount) })
  if (estimatedBlocks > 0) metrics.push({ label: 'Blocks possibles', value: String(estimatedBlocks) })
  upsertMetric('Blocks qui passent le minimum', strictEligibleBlocks)
  if (bestHistoricalBlockCapacity > 0) upsertMetric('Meilleure capacite observee', `${bestHistoricalBlockCapacity} clients`)
  if (strictTotalCapacityVisits > 0) upsertMetric('Capacite stricte totale', `${strictTotalCapacityVisits} visites`)
  if (estimatedRequiredVisits > 0) upsertMetric('Clients candidats', estimatedRequiredVisits)
  if (selectedBlocks > 0) upsertMetric('Blocks retenus', selectedBlocks)
  if (deferredVisits > 0) upsertMetric('Clients non repartis', deferredVisits)

  let title = 'Pourquoi le plan est refuse'
  let explanation = payload?.message || "Le plan de couverture n'a pas pu etre calcule avec ces parametres."
  const actions = []
  let recommendation = null

  switch (reasonCode) {
    case 'invalid_visit_range':
      title = 'Les bornes Min/Max ne sont pas coherentes'
      explanation = `Le champ "Max clients / block" doit etre superieur ou egal a "Min clients / block". Avec ${minVisits} min et ${maxVisits} max, le calcul est bloque avant meme de tester les commerciaux.`
      actions.push('Augmente "Max clients / block" pour qu\'il soit au moins egal au minimum.')
      actions.push('Ou baisse "Min clients / block" si tu veux des blocks plus petits.')
      recommendation = {
        label: `Min ${minVisits || 1} / Max ${Math.max(minVisits || 1, maxVisits || 0)}`,
        filters: {
          min_visits: minVisits || 1,
          max_visits: Math.max(minVisits || 1, maxVisits || 0)
        }
      }
      break
    case 'closest_plan_generated':
    case 'ortools_plan_generated': {
      const usingOrTools = reasonCode === 'ortools_plan_generated'
      title = usingOrTools ? 'Le plan OR-Tools a ete genere' : 'Le meilleur plan possible a ete genere'
      explanation = usingOrTools
        ? `Tu as demande ${requestedRangeLabel} client(s) par block. Le solveur OR-Tools a reparti les clients sur ${actualBlocksCount || selectedBlocks || 0} block(s) avec une plage finale de ${obtainedRangeLabel} client(s) par block.`
        : `Tu as demande ${requestedRangeLabel} client(s) par block. Le moteur a genere le resultat le plus proche possible avec ${actualBlocksCount || selectedBlocks || 0} block(s) et une plage finale de ${obtainedRangeLabel} client(s) par block.`
      if (rangeInputNormalized) {
        explanation += ` Les bornes saisies ont d'abord ete remises dans l'ordre logique (${requestedRangeLabel} -> ${normalizedRangeLabel}).`
      }
      if (strictFailureReason) {
        explanation += ` ${strictFailureReason}`
      } else if (bestHistoricalBlockCapacity > 0 && normalizedMinVisits > bestHistoricalBlockCapacity) {
        explanation += ` Le meilleur block historique observe monte a ${bestHistoricalBlockCapacity} clients, donc la demande stricte n'etait pas tenable telle quelle.`
      }
      if (coveredUniqueClients > 0) {
        explanation += ` ${coveredUniqueClients} client(s) ont ete couverts`
        explanation += deferredUniqueClients > 0
          ? ` et ${deferredUniqueClients} restent a reprogrammer.`
          : '.'
      }
      if (requestedFullCoverageImpossible && requiredAverageVisitsPerBlock > 0) {
        explanation += ` Pour couvrir 100% des ${totalCandidateClients || estimatedRequiredVisits} client(s) sur ${estimatedBlocks} block(s) possibles, il faudrait au moins ${requiredAverageVisitsPerBlock} client(s) par block, alors que ton max saisi est ${normalizedMaxVisits || maxVisits}.`
      }
      if (minTotalCa > 0 && totalPredictedCa > 0 && totalPredictedCa < minTotalCa) {
        explanation += ` Le CA estime (${totalPredictedCa.toLocaleString()} TND) reste sous le minimum demande (${minTotalCa.toLocaleString()} TND).`
      }

      formula.splice(0, formula.length,
        usingOrTools
          ? `Le solveur OR-Tools repartit d'abord les clients sur tous les blocks disponibles de la periode.`
          : `Le moteur essaie d'abord strictement ta plage demandee ${normalizedRangeLabel} client(s) par block.`,
        usingOrTools
          ? 'Le minimum et le maximum saisis restent des cibles d\'equilibrage, mais la couverture globale passe d\'abord.'
          : 'Si cette plage est impossible, il baisse seulement le minimum au plus petit niveau necessaire pour rester le plus proche possible de ta demande.',
        'La repartition finale refuse toujours de depasser la capacite clients ou la charge camion de chaque block.'
      )
      if (requestedFullCoverageImpossible && fullCoverageMaxCapacity > 0) {
        formula.push(`Couverture 100% theorique avec ta saisie = ${estimatedBlocks} block(s) x ${normalizedMaxVisits || maxVisits} max = ${fullCoverageMaxCapacity} visite(s).`)
      }

      upsertMetric('Plage demandee', `${requestedRangeLabel} clients`)
      upsertMetric('Plage obtenue', `${obtainedRangeLabel} clients`)
      if (actualBlocksCount > 0) upsertMetric('Blocks obtenus', actualBlocksCount)
      if (coveredUniqueClients > 0) upsertMetric('Clients couverts', coveredUniqueClients)
      if (totalCandidateClients > 0) upsertMetric('Clients candidats', totalCandidateClients)
      if (deferredUniqueClients > 0) upsertMetric('Clients restants', deferredUniqueClients)
      if (actualTotalVisits > 0) upsertMetric('Visites planifiees', actualTotalVisits)
      if (requestedFullCoverageImpossible && fullCoverageMaxCapacity > 0) {
        upsertMetric('Capacite max demandee', `${fullCoverageMaxCapacity} visites`)
      }
      if (requestedFullCoverageImpossible && requiredAverageVisitsPerBlock > 0) {
        upsertMetric('Moyenne requise / block', `${requiredAverageVisitsPerBlock} clients`)
      }
      if (requestedFullCoverageImpossible && fullCoverageShortfall > 0) {
        upsertMetric('Manque theorique', `${fullCoverageShortfall} clients`)
      }

      if (rangeInputNormalized) {
        actions.push(`Saisis directement Min ${normalizedMinVisits} / Max ${normalizedMaxVisits} si tu veux garder cette logique sans inversion automatique.`)
      }
      if (requestedFullCoverageImpossible && requiredAverageVisitsPerBlock > 0) {
        actions.push(`Avec cette periode et ces commerciaux, il faut un Max d'au moins ${requiredAverageVisitsPerBlock} client(s) par block pour viser 100% de couverture.`)
      }
      if (recommendedMinVisits > 0 && !usingOrTools) {
        actions.push(`Pour un prochain calcul plus stable, relance avec Min ${recommendedMinVisits} / Max ${recommendedMaxVisits}.`)
      }
      if (deferredUniqueClients > 0) {
        actions.push(`Allonge la periode ou ajoute des commerciaux pour absorber les ${deferredUniqueClients} client(s) restants.`)
      }
      if (blockedByClientCapacity > 0) {
        actions.push('Plusieurs blocks ont ete limites par leur capacite clients reelle.')
      }
      if (blockedByTruckCapacity > 0) {
        actions.push(`La charge camion a aussi bloque une partie de la repartition (${requestedTruckUnits.toLocaleString()} unites demandees pour environ ${plannedTruckCapacity.toLocaleString()} unites planifiables).`)
      }
      if (blocksBelowRequestedMin > 0 || blocksAboveRequestedMax > 0) {
        actions.push(`Le resultat sort encore de la plage demandee sur ${blocksBelowRequestedMin + blocksAboveRequestedMax} block(s), car il n'existe pas de repartition exacte avec les capacites actuelles.`)
      }
      recommendation = recommendedMinVisits > 0
        ? {
            label: `Min ${recommendedMinVisits} / Max ${recommendedMaxVisits}`,
            filters: {
              min_visits: recommendedMinVisits,
              max_visits: recommendedMaxVisits
            }
          }
        : null
      break
    }
    case 'no_working_days':
      title = 'Aucun jour planifiable sur cette periode'
      explanation = 'Le moteur ignore le dimanche. Sur la periode choisie, il ne reste donc aucun jour ouvrable exploitable.'
      actions.push('Decale la date de debut.')
      actions.push('Ou augmente la periode en jours pour inclure plus de jours ouvrables.')
      break
    case 'no_commercial_selected':
      title = 'Aucun commercial selectionne'
      explanation = 'Le plan ne peut pas etre calcule sans au moins un commercial, car chaque block est rattache a un commercial precis.'
      actions.push('Selectionne au moins un commercial dans la liste.')
      actions.push('Si tu veux tester large, garde "Tous les commerciaux".')
      break
    case 'min_block_capacity_unreachable':
      title = 'Le minimum demande est trop haut pour l\'historique disponible'
      explanation = bestHistoricalBlockCapacity > 0
        ? `Aucun block historique n'atteint le minimum de ${minVisits} clients. Le meilleur block observe sur la periode arrive seulement a ${bestHistoricalBlockCapacity} clients.`
        : `Aucun block historique n'atteint le minimum de ${minVisits} clients sur la periode choisie.`
      if (recommendedMinVisits > 0) {
        actions.push(`Essaie un minimum proche de ${recommendedMinVisits} client(s) par block.`)
      } else if (bestHistoricalBlockCapacity > 0) {
        actions.push(`Baisse "Min clients / block" a ${bestHistoricalBlockCapacity} ou moins.`)
      } else {
        actions.push('Baisse "Min clients / block".')
      }
      actions.push('Allonge la periode pour ajouter plus de jours ouvrables.')
      actions.push('Ajoute d\'autres commerciaux pour augmenter le nombre de blocks possibles.')
      if (recommendedMinVisits > 0) {
        recommendation = {
          label: `Min ${recommendedMinVisits} / Max ${recommendedMaxVisits}`,
          filters: {
            min_visits: recommendedMinVisits,
            max_visits: recommendedMaxVisits
          }
        }
      }
      break
    case 'total_demand_below_min_block':
      title = 'Pas assez de clients pour ouvrir un block strict'
      explanation = `Le nombre total de clients candidats reste inferieur au minimum requis pour un seul block (${minVisits}).`
      actions.push('Baisse "Min clients / block".')
      actions.push('Allonge la periode pour faire remonter plus de clients candidats.')
      if (recommendedMinVisits > 0) {
        recommendation = {
          label: `Min ${recommendedMinVisits} / Max ${recommendedMaxVisits}`,
          filters: {
            min_visits: recommendedMinVisits,
            max_visits: recommendedMaxVisits
          }
        }
      }
      break
    case 'strict_blocks_impossible':
      title = 'Les capacites existent, mais la regle stricte ne passe pas'
      explanation = `Le moteur a trouve des capacites historiques, mais il ne peut pas former des blocks qui respectent strictement la plage ${minVisits}-${maxVisits} pour toute la demande.`
      actions.push('Baisse le minimum par block pour donner plus de souplesse.')
      actions.push('Allonge la periode ou ajoute des commerciaux.')
      if (recommendedMinVisits > 0) {
        recommendation = {
          label: `Min ${recommendedMinVisits} / Max ${recommendedMaxVisits}`,
          filters: {
            min_visits: recommendedMinVisits,
            max_visits: recommendedMaxVisits
          }
        }
      }
      break
    case 'assignment_capacity_overflow':
      title = 'La repartition finale depasse les capacites reelles'
      explanation = 'Des blocks stricts existaient, mais en repartissant les clients un ou plusieurs blocks depassent soit la limite clients, soit la charge camion.'
      if (blockedByClientCapacity > 0) {
        actions.push('Baisse "Min clients / block" ou augmente la periode pour ajouter des blocks disponibles.')
      }
      if (blockedByTruckCapacity > 0) {
        actions.push('Revois la charge attendue en etalant la periode ou en ajoutant des commerciaux.')
      }
      actions.push('Relance avec plus de jours ouvrables pour absorber les clients restants.')
      if (recommendedMinVisits > 0 && blockedByClientCapacity > 0 && blockedByTruckCapacity === 0 && minVisits > recommendedMinVisits) {
        recommendation = {
          label: `Min ${recommendedMinVisits} / Max ${recommendedMaxVisits}`,
          filters: {
            min_visits: recommendedMinVisits,
            max_visits: recommendedMaxVisits
          }
        }
      }
      break
    case 'no_exploitable_blocks':
      title = 'Aucun block exploitable apres les controles'
      explanation = 'Le moteur a essaye de construire des blocks, puis de repartir les clients, mais aucun block n\'a pu rester valide sans depasser les contraintes reelles.'
      actions.push('Baisse le minimum par block.')
      actions.push('Allonge la periode.')
      actions.push('Ajoute d\'autres commerciaux.')
      if (recommendedMinVisits > 0) {
        recommendation = {
          label: `Min ${recommendedMinVisits} / Max ${recommendedMaxVisits}`,
          filters: {
            min_visits: recommendedMinVisits,
            max_visits: recommendedMaxVisits
          }
        }
      }
      break
    default:
      actions.push('Baisse "Min clients / block" si la contrainte est trop forte.')
      actions.push('Allonge la periode en jours pour ouvrir plus de blocks.')
      actions.push('Ajoute d\'autres commerciaux si possible.')
      break
  }

  return {
    title,
    explanation,
    metrics,
    formula,
    actions: [...new Set(actions.filter(Boolean))],
    recommendation
  }
}

export default function CoveragePlanner({ api }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [plannerFeedback, setPlannerFeedback] = useState(null)
  const [clickedClient, setClickedClient] = useState(null)
  const [validationFeedback, setValidationFeedback] = useState(null)
  const [validationLoading, setValidationLoading] = useState(false)
  const [options, setOptions] = useState({ commerciaux: [] })
  const [optionsLoading, setOptionsLoading] = useState(true)
  const [optionsError, setOptionsError] = useState(null)
  const [selectedCommercials, setSelectedCommercials] = useState([])
  const [resolvedApiBase, setResolvedApiBase] = useState(api)
  const [filters, setFilters] = useState({
    start_date: todayIsoDate(),
    period_days: '14',
    min_visits: '20',
    max_visits: '30',
    min_total_ca: ''
  })
  const [planData, setPlanData] = useState(null)
  const [selectedBlockId, setSelectedBlockId] = useState(null)
  const [routePlan, setRoutePlan] = useState({
    loading: false,
    error: null,
    origin: null,
    orderedStops: [],
    geometry: [],
    steps: [],
    summary: null
  })

  const mapRef = useRef(null)
  const leafletMapRef = useRef(null)
  const routeLayerRef = useRef(null)

  const loadOptions = async () => {
    setOptionsLoading(true)
    setOptionsError(null)
    const apiCandidates = buildApiCandidates(api)
    let lastError = null

    for (const candidate of apiCandidates) {
      try {
        const response = await axios.get(`${candidate}/api/tournees/options`, {
          timeout: OPTIONS_REQUEST_TIMEOUT_MS,
          params: { t: Date.now() }
        })
        const commerciaux = response.data?.commerciaux || []
        setResolvedApiBase(candidate)
        setOptions({ commerciaux })
        setSelectedCommercials(commerciaux.map(item => item.value))
        setOptionsLoading(false)
        return
      } catch (loadError) {
        lastError = loadError
      }
    }

    setOptions({ commerciaux: [] })
    setSelectedCommercials([])
    setOptionsError(`Impossible de charger la liste des commerciaux pour le moment.${lastError?.message ? ` (${lastError.message})` : ''}`)
    setOptionsLoading(false)
  }

  useEffect(() => {
    loadOptions()
  }, [api])

  const blocks = useMemo(() => planData?.blocks || [], [planData])
  const selectedBlock = useMemo(
    () => blocks.find(block => block.id === selectedBlockId) || blocks[0] || null,
    [blocks, selectedBlockId]
  )

  useEffect(() => {
    if (blocks.length && !selectedBlockId) {
      setSelectedBlockId(blocks[0].id)
    }
  }, [blocks, selectedBlockId])

  useEffect(() => {
    setClickedClient(null)
    setValidationFeedback(null)
  }, [selectedBlockId])

  useEffect(() => {
    if (!selectedBlock) {
      setRoutePlan({
        loading: false,
        error: null,
        origin: null,
        orderedStops: [],
        geometry: [],
        steps: [],
        summary: null
      })
      return
    }

    const candidates = (selectedBlock.detail?.itineraire_geo || [])
      .map((stop, index) => normalizeGeoStop(stop, index))
      .filter(Boolean)

    let cancelled = false

    async function buildRoutePlan() {
      if (!candidates.length) {
        setRoutePlan({
          loading: false,
          error: null,
          origin: selectedBlock.detail?.depot_origin || null,
          orderedStops: [],
          geometry: [],
          steps: [],
          summary: null
        })
        return
      }

      setRoutePlan(prev => ({ ...prev, loading: true, error: null }))

      const origin = normalizeGeoStop(selectedBlock.detail?.depot_origin, -1)

      if ((origin ? candidates.length + 1 : candidates.length) < 2) {
        setRoutePlan({
          loading: false,
          error: null,
          origin,
          orderedStops: candidates,
          geometry: [],
          steps: [],
          summary: null
        })
        return
      }

      try {
        const inputStops = origin ? [origin, ...candidates] : candidates
        const tripCoords = inputStops.map(stop => `${stop.longitude},${stop.latitude}`).join(';')
        const tripUrl = `https://router.project-osrm.org/trip/v1/driving/${tripCoords}`
        const tripParams = origin
          ? { source: 'first', roundtrip: false, geometries: 'geojson', overview: 'false' }
          : { source: 'any', roundtrip: false, geometries: 'geojson', overview: 'false' }

        const tripRes = await axios.get(tripUrl, { params: tripParams })
        const waypoints = tripRes.data?.waypoints || []
        if (!waypoints.length) {
          throw new Error("Aucun ordre de passage n'a ete trouve.")
        }

        const clientWaypoints = waypoints
          .map((waypoint, index) => ({ ...waypoint, originalIndex: index }))
          .filter(waypoint => !(origin && waypoint.originalIndex === 0))
          .sort((a, b) => (a.waypoint_index ?? 0) - (b.waypoint_index ?? 0))

        const orderedStops = clientWaypoints.map(waypoint => inputStops[waypoint.originalIndex]).filter(Boolean)
        const orderedWithOrigin = origin ? [origin, ...orderedStops] : orderedStops
        const routeCoords = orderedWithOrigin.map(stop => `${stop.longitude},${stop.latitude}`).join(';')
        const routeUrl = `https://router.project-osrm.org/route/v1/driving/${routeCoords}`

        const routeRes = await axios.get(routeUrl, {
          params: {
            steps: true,
            geometries: 'geojson',
            overview: 'full'
          }
        })

        const route = routeRes.data?.routes?.[0]
        if (!route) {
          throw new Error('Impossible de calculer un itineraire detaille.')
        }

        const geometry = (route.geometry?.coordinates || []).map(([lng, lat]) => ({
          latitude: lat,
          longitude: lng
        }))
        const steps = (route.legs || []).flatMap((leg, legIndex) =>
          (leg.steps || []).map((step, stepIndex) => ({
            id: `${legIndex}-${stepIndex}`,
            text: buildOsrmStepText(step),
            distance: step.distance || 0,
            duration: step.duration || 0
          }))
        )

        if (!cancelled) {
          setRoutePlan({
            loading: false,
            error: null,
            origin,
            orderedStops: orderedStops.map((stop, index) => ({ ...stop, step: index + 1 })),
            geometry,
            steps,
            summary: {
              distance: route.distance || 0,
              duration: route.duration || 0
            }
          })
        }
      } catch (routeError) {
        if (!cancelled) {
          setRoutePlan({
            loading: false,
            error: "Itineraire detaille indisponible pour le moment. Affichage d'un trace simplifie.",
            origin,
            orderedStops: candidates,
            geometry: [],
            steps: [],
            summary: null
          })
        }
      }
    }

    buildRoutePlan()

    return () => {
      cancelled = true
    }
  }, [selectedBlock])

  useEffect(() => {
    if (!mapRef.current || !selectedBlock) return

    if (!leafletMapRef.current) {
      leafletMapRef.current = L.map(mapRef.current, {
        zoomControl: true,
        attributionControl: false
      })
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: 'OpenStreetMap contributors'
      }).addTo(leafletMapRef.current)
    }

    const map = leafletMapRef.current
    if (!routeLayerRef.current) {
      routeLayerRef.current = L.layerGroup().addTo(map)
    }
    routeLayerRef.current.clearLayers()

    const routeMarkers = routePlan.orderedStops.length ? routePlan.orderedStops : (selectedBlock.detail?.itineraire_geo || [])
    const routeGeometry = routePlan.geometry.length ? routePlan.geometry : routeMarkers

    if (!routeMarkers.length) {
      map.setView([36.8, 10.1], 6)
      return
    }

    if (routePlan.origin) {
      const originMarker = L.circleMarker([routePlan.origin.latitude, routePlan.origin.longitude], {
        radius: 8,
        color: '#d9485f',
        fillColor: '#d9485f',
        fillOpacity: 0.95,
        weight: 1
      }).addTo(routeLayerRef.current)
      originMarker.bindPopup(`<strong>Depart</strong><br/>${routePlan.origin.adresse}`)
    }

    const latlngs = routeGeometry.map(point => [point.latitude, point.longitude])
    L.polyline(latlngs, { color: '#1c6dd0', weight: 4, opacity: 0.88 }).addTo(routeLayerRef.current)

    routeMarkers.forEach((point, index) => {
      const marker = L.circleMarker([point.latitude, point.longitude], {
        radius: index === 0 ? 8 : 6,
        color: index === 0 ? '#198754' : '#1c6dd0',
        fillColor: index === 0 ? '#198754' : '#1c6dd0',
        fillOpacity: 0.9,
        weight: 1
      }).addTo(routeLayerRef.current)

      marker.bindPopup(`<strong>${index + 1}. ${point.nom}</strong><br/>${point.adresse}`)
    })

    try {
      const boundsPoints = routePlan.origin
        ? [[routePlan.origin.latitude, routePlan.origin.longitude], ...latlngs]
        : latlngs
      const bounds = L.latLngBounds(boundsPoints)
      map.fitBounds(bounds, { padding: [36, 36] })
      setTimeout(() => map.invalidateSize(), 200)
    } catch (boundsError) {
      console.warn("Impossible d'ajuster les limites de la carte", boundsError)
    }
  }, [selectedBlock, routePlan])

  const toggleCommercial = value => {
    setSelectedCommercials(current =>
      current.includes(value)
        ? current.filter(item => item !== value)
        : [...current, value]
    )
  }

  const toggleAllCommercials = () => {
    const allValues = options.commerciaux.map(item => item.value)
    setSelectedCommercials(current => (
      current.length === allValues.length ? [] : allValues
    ))
  }

  const normalizeVisitLimits = currentFilters => {
    const nextFilters = { ...currentFilters }
    const parsedMin = Number.parseInt(nextFilters.min_visits, 10)
    const parsedMax = Number.parseInt(nextFilters.max_visits, 10)

    if (Number.isFinite(parsedMin)) {
      nextFilters.min_visits = String(Math.max(1, Math.min(250, parsedMin)))
    }

    if (Number.isFinite(parsedMax)) {
      nextFilters.max_visits = String(Math.max(1, Math.min(250, parsedMax)))
    }

    return nextFilters
  }

  const handleVisitLimitChange = (field, rawValue) => {
    setFilters(current => {
      if (rawValue === '') {
        return {
          ...current,
          [field]: ''
        }
      }

      const parsedValue = Number.parseInt(rawValue, 10)
      const boundedValue = Number.isFinite(parsedValue) ? Math.max(1, Math.min(250, parsedValue)) : ''
      return {
        ...current,
        [field]: boundedValue === '' ? '' : String(boundedValue)
      }
    })
  }

  const handleVisitLimitBlur = () => {
    setFilters(current => normalizeVisitLimits(current))
  }

  const applyPlannerRecommendation = recommendation => {
    if (!recommendation?.filters) return

    setFilters(current => normalizeVisitLimits({
      ...current,
      ...Object.fromEntries(
        Object.entries(recommendation.filters).map(([key, value]) => [key, String(value)])
      )
    }))
  }

  const runPlanner = async () => {
    try {
      const normalizedFilters = normalizeVisitLimits(filters)
      const allCommercialsSelected = selectedCommercials.length === options.commerciaux.length
      const plannerInputContext = {
        start_date: normalizedFilters.start_date,
        period_days: normalizedFilters.period_days,
        min_visits: normalizedFilters.min_visits,
        max_visits: normalizedFilters.max_visits,
        selected_commercials_count: allCommercialsSelected ? options.commerciaux.length : selectedCommercials.length
      }

      if (!selectedCommercials.length) {
        const plannerMessage = 'Selectionne au moins un commercial.'
        setError(plannerMessage)
        setPlannerFeedback(buildCoverageErrorHelp({
          message: plannerMessage,
          reason_code: 'no_commercial_selected',
          context: plannerInputContext
        }, plannerInputContext))
        return
      }
      setLoading(true)
      setError(null)
      setPlannerFeedback(null)
      setValidationFeedback(null)
      setFilters(normalizedFilters)
      const params = {
        start_date: normalizedFilters.start_date,
        period_days: normalizedFilters.period_days,
        min_visits: normalizedFilters.min_visits,
        max_visits: normalizedFilters.max_visits,
        min_total_ca: normalizedFilters.min_total_ca || undefined,
        commercials: allCommercialsSelected ? undefined : selectedCommercials
      }
      const requestTimeoutMs = computeCoverageRequestTimeoutMs(
        normalizedFilters,
        allCommercialsSelected ? options.commerciaux.length : selectedCommercials.length,
        options.commerciaux.length
      )

      const apiCandidates = buildApiCandidates(resolvedApiBase || api)
      let response = null
      let lastError = null

      for (const candidate of apiCandidates) {
        try {
          response = await axios.get(`${candidate}/api/tournees/coverage-plan`, {
            params,
            timeout: requestTimeoutMs
          })
          setResolvedApiBase(candidate)
          break
        } catch (plannerError) {
          lastError = plannerError
        }
      }

      if (!response) {
        throw lastError || new Error('Impossible de joindre le serveur API.')
      }

      if (response.data?.status === 'invalid_parameters') {
        const plannerMessage = response.data?.message || 'Le calcul du plan ne peut pas etre lance avec ces parametres.'
        setError(plannerMessage)
        setPlannerFeedback(buildCoverageErrorHelp(response.data, plannerInputContext))
        setPlanData(null)
        setSelectedBlockId(null)
        return
      }

      setPlannerFeedback(
        response.data?.planner_warning
          ? buildCoverageErrorHelp(response.data.planner_warning, plannerInputContext)
          : null
      )
      setPlanData(response.data)
      const firstBlock = response.data?.blocks?.[0]
      setSelectedBlockId(firstBlock ? firstBlock.id : null)
    } catch (plannerError) {
      const timeoutMessage = plannerError?.code === 'ECONNABORTED'
        ? "Le calcul du plan est encore en cours et a depasse le delai d'attente de l'interface. Relance dans quelques secondes: le moteur finit generalement par produire le resultat avec ces memes parametres."
        : null
      const errorMessage =
        plannerError?.response?.data?.message ||
        plannerError?.response?.data?.error ||
        timeoutMessage ||
        'Impossible de generer le plan de couverture.'
      setError(errorMessage)
      setPlannerFeedback(null)
      setPlanData(null)
      setSelectedBlockId(null)
    } finally {
      setLoading(false)
    }
  }

  const summary = planData?.summary || null
  const selectedRows = selectedBlock?.detail?.tournees || []
  const selectedCapacity = selectedBlock?.capacity || null
  const chargeTotale = selectedBlock?.detail?.chargeTotale || { agro: 0, chips: 0, bureautique: 0, detailsProduits: [] }
  const quantiteTotalCamion = Number(chargeTotale.agro || 0) + Number(chargeTotale.chips || 0) + Number(chargeTotale.bureautique || 0)
  const allCommercialsSelected = options.commerciaux.length > 0 && selectedCommercials.length === options.commerciaux.length
  const selectedCommercialsLabel = allCommercialsSelected
    ? `Tous les commerciaux (${options.commerciaux.length})`
    : selectedCommercials.length > 0
      ? `${selectedCommercials.length} commerciaux selectionnes`
      : 'Aucun commercial selectionne'
  const navigationUrl = useMemo(
    () => buildGoogleMapsUrl(routePlan.origin, routePlan.orderedStops),
    [routePlan.origin, routePlan.orderedStops]
  )
  const validationDisabledReason = validationLoading
    ? 'Validation en cours...'
    : !selectedRows.length
      ? 'Ce block ne contient aucun client exploitable a enregistrer.'
      : null
  const plannerRecommendationApplied = Boolean(
    plannerFeedback?.recommendation?.filters &&
    String(filters.min_visits || '') === String(plannerFeedback.recommendation.filters.min_visits || '') &&
    String(filters.max_visits || '') === String(plannerFeedback.recommendation.filters.max_visits || '')
  )

  const buildValidationStops = () => {
    const routeStops = routePlan.orderedStops.length
      ? routePlan.orderedStops
      : (selectedBlock?.detail?.itineraire_geo || [])

    return routeStops
      .map((stop, index) => ({
        client_code: String(stop.client_code || stop.nbr_client || '').trim(),
        client_name: stop.nom || '',
        adresse: stop.adresse || '',
        latitude: stop.latitude,
        longitude: stop.longitude,
        rang: index + 1
      }))
      .filter(stop => stop.client_code)
  }

  const validateRoutePlan = async () => {
    if (!selectedBlock) {
      const errorMessage = 'Aucun block selectionne a valider.'
      setValidationFeedback({ type: 'error', message: errorMessage })
      window.alert(errorMessage)
      return
    }

    const stops = buildValidationStops()
    if (!stops.length) {
      const errorMessage = 'Aucun client exploitable a enregistrer pour cette tournee.'
      setValidationFeedback({ type: 'error', message: errorMessage })
      window.alert(errorMessage)
      return
    }

    const confirmMessage = `Valider la tournee finale du ${selectedBlock.date} pour ${selectedBlock.proposed_commercial_label} ?\n\nL'ancienne version enregistree pour cette date et ce commercial sera remplacee.`
    if (!window.confirm(confirmMessage)) {
      return
    }

    setValidationLoading(true)
    setValidationFeedback(null)

    try {
      const payload = {
        date: selectedBlock.date,
        day_label: selectedBlock.day_label,
        commercial_code: selectedBlock.proposed_commercial,
        commercial_label: selectedBlock.proposed_commercial_label,
        route_code: selectedBlock.detail?.depot_origin?.route || '',
        depot_code: selectedBlock.detail?.depot_origin?.depot_code || '',
        depot_name: selectedBlock.detail?.depot_origin?.nom || '',
        prediction_run_code: selectedBlock.prediction_run_code || null,
        stops
      }

      const apiCandidates = buildApiCandidates(resolvedApiBase || api)
      let response = null
      let lastError = null

      for (const candidate of apiCandidates) {
        try {
          response = await axios.post(`${candidate}/api/tournees/coverage-plan/validate`, payload, {
            timeout: 20000
          })
          setResolvedApiBase(candidate)
          break
        } catch (saveError) {
          lastError = saveError
        }
      }

      if (!response) {
        const errorMessage = lastError?.response?.data?.error || "Impossible d'enregistrer la tournee finale."
        setValidationFeedback({
          type: 'error',
          message: errorMessage
        })
        window.alert(errorMessage)
        return
      }

      const successMessage = response.data?.message || 'La tournee finale a ete enregistree.'
      setValidationFeedback({
        type: 'success',
        message: successMessage
      })
      window.alert(successMessage)
    } catch (unexpectedError) {
      const errorMessage = unexpectedError?.message || "Impossible d'enregistrer la tournee finale."
      setValidationFeedback({
        type: 'error',
        message: errorMessage
      })
      window.alert(errorMessage)
    } finally {
      setValidationLoading(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, color: '#1a2b4c', fontSize: '28px' }}>Plan Couverture</h1>
          <p style={{ margin: '6px 0 0 0', color: '#667085', maxWidth: '760px' }}>
            Generation automatique des blocks de tournee avec affectation proposee, couverture client sur la periode et detail GPS.
          </p>
        </div>
        
      </div>

      <div style={{ backgroundColor: 'white', borderRadius: '16px', padding: '20px', boxShadow: '0 10px 25px rgba(15, 23, 42, 0.06)', marginBottom: '24px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', fontWeight: '700', color: '#475467' }}>Date debut</label>
            <input
              type="date"
              value={filters.start_date}
              onChange={event => setFilters(current => ({ ...current, start_date: event.target.value }))}
              style={{ padding: '11px 12px', borderRadius: '10px', border: '1px solid #d0d5dd' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', fontWeight: '700', color: '#475467' }}>Periode en jours</label>
            <input
              type="number"
              min={1}
              max={60}
              value={filters.period_days}
              onChange={event => setFilters(current => ({ ...current, period_days: event.target.value }))}
              style={{ padding: '11px 12px', borderRadius: '10px', border: '1px solid #d0d5dd' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', fontWeight: '700', color: '#475467' }}>Min clients / block</label>
            <input
              type="number"
              min={1}
              max={250}
              value={filters.min_visits}
              onChange={event => handleVisitLimitChange('min_visits', event.target.value)}
              onBlur={handleVisitLimitBlur}
              style={{ padding: '11px 12px', borderRadius: '10px', border: '1px solid #d0d5dd' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', fontWeight: '700', color: '#475467' }}>Max clients / block</label>
            <input
              type="number"
              min={1}
              max={250}
              value={filters.max_visits}
              onChange={event => handleVisitLimitChange('max_visits', event.target.value)}
              onBlur={handleVisitLimitBlur}
              style={{ padding: '11px 12px', borderRadius: '10px', border: '1px solid #d0d5dd' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', fontWeight: '700', color: '#475467' }}>Min chiffre d'affaire</label>
            <input
              type="number"
              min={0}
              step="0.1"
              value={filters.min_total_ca}
              onChange={event => setFilters(current => ({ ...current, min_total_ca: event.target.value }))}
              placeholder="Optionnel"
              style={{ padding: '11px 12px', borderRadius: '10px', border: '1px solid #d0d5dd' }}
            />
          </div>
        </div>

        <div style={{ marginBottom: '16px', padding: '10px 12px', borderRadius: '10px', backgroundColor: '#f8fafc', color: '#475467', fontSize: '12px', fontWeight: '600' }}>
          Regle cible: le moteur essaie d'abord de respecter strictement le minimum et le maximum saisis. Si ce n'est pas realiste avec l'historique, il genere le meilleur plan possible et t'explique pourquoi.
        </div>

        <div style={{ borderTop: '1px solid #eef2f7', paddingTop: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: '700', color: '#475467' }}>Commerciaux</div>
              <div style={{ fontSize: '12px', color: '#667085' }}>Selectionne ceux que tu veux utiliser pour les blocks.</div>
            </div>
            {optionsError && (
              <button
                type="button"
                onClick={loadOptions}
                style={{
                  border: '1px solid #d0d5dd',
                  backgroundColor: 'white',
                  color: '#1d2939',
                  borderRadius: '10px',
                  padding: '8px 12px',
                  fontSize: '12px',
                  fontWeight: '700',
                  cursor: 'pointer'
                }}
              >
                Recharger
              </button>
            )}
          </div>

          <details style={{ marginBottom: '16px', border: '1px solid #d0d5dd', borderRadius: '12px', backgroundColor: '#fff' }}>
            <summary
              style={{
                listStyle: 'none',
                cursor: 'pointer',
                padding: '12px 14px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
                fontSize: '13px',
                fontWeight: '700',
                color: '#1d2939'
              }}
            >
              <span>{selectedCommercialsLabel}</span>
              <span style={{ color: '#667085', fontWeight: '600' }}>Multi-select</span>
            </summary>

            <div style={{ borderTop: '1px solid #eef2f7', padding: '12px', display: 'grid', gap: '10px' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: '700', color: '#1d2939' }}>
                <input
                  type="checkbox"
                  checked={allCommercialsSelected}
                  onChange={toggleAllCommercials}
                  disabled={optionsLoading || options.commerciaux.length === 0}
                />
                Selectionner tous
              </label>

              {optionsLoading ? (
                <div style={{ fontSize: '13px', color: '#667085', fontWeight: '600' }}>
                  Chargement des commerciaux...
                </div>
              ) : options.commerciaux.length > 0 ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' }}>
                  {options.commerciaux.map(item => {
                    const checked = selectedCommercials.includes(item.value)
                    return (
                      <label
                        key={item.value}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '10px 12px',
                          borderRadius: '10px',
                          border: checked ? '1px solid #1c6dd0' : '1px solid #d0d5dd',
                          backgroundColor: checked ? '#eef5ff' : '#fff',
                          cursor: 'pointer',
                          fontSize: '13px',
                          fontWeight: '600',
                          color: '#1d2939'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCommercial(item.value)}
                        />
                        {item.label}
                      </label>
                    )
                  })}
                </div>
              ) : (
                <div style={{ fontSize: '13px', color: optionsError ? '#b42318' : '#667085', fontWeight: '600' }}>
                  {optionsError || 'Aucun commercial disponible pour le moment.'}
                </div>
              )}
            </div>
          </details>
        </div>

        <button
          onClick={runPlanner}
          disabled={loading}
          style={{
            padding: '12px 22px',
            border: 'none',
            borderRadius: '12px',
            backgroundColor: loading ? '#94a3b8' : '#1c6dd0',
            color: 'white',
            fontWeight: '700',
            cursor: loading ? 'not-allowed' : 'pointer'
          }}
        >
          {loading ? 'Generation du plan...' : 'Generer le plan couverture'}
        </button>
      </div>

      {error && (
        <div style={{ padding: '14px 16px', borderRadius: '12px', backgroundColor: '#fef3f2', color: '#b42318', marginBottom: '24px', fontWeight: '600' }}>
          {error}
        </div>
      )}

      {plannerFeedback && (
        <div
          style={{
            marginTop: error ? '-8px' : 0,
            marginBottom: '24px',
            padding: '18px',
            borderRadius: '16px',
            backgroundColor: '#fffaf5',
            border: '1px solid #fed7aa',
            boxShadow: '0 10px 24px rgba(194, 65, 12, 0.08)'
          }}
        >
          <div style={{ fontSize: '18px', fontWeight: '800', color: '#9a3412', marginBottom: '8px' }}>
            {plannerFeedback.title}
          </div>
          <div style={{ color: '#7c2d12', fontSize: '14px', lineHeight: 1.6, marginBottom: '14px' }}>
            {plannerFeedback.explanation}
          </div>

          {plannerFeedback.recommendation && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
              <div style={{ padding: '8px 12px', borderRadius: '999px', backgroundColor: '#fff', border: '1px solid #fdba74', color: '#9a3412', fontSize: '12px', fontWeight: '800' }}>
                Reglage recommande: {plannerFeedback.recommendation.label}
              </div>
              <button
                type="button"
                onClick={() => applyPlannerRecommendation(plannerFeedback.recommendation)}
                disabled={plannerRecommendationApplied}
                style={{
                  padding: '9px 14px',
                  borderRadius: '10px',
                  border: 'none',
                  backgroundColor: plannerRecommendationApplied ? '#94a3b8' : '#ea580c',
                  color: 'white',
                  fontSize: '12px',
                  fontWeight: '800',
                  cursor: plannerRecommendationApplied ? 'not-allowed' : 'pointer'
                }}
              >
                {plannerRecommendationApplied ? 'Reglage deja applique' : 'Appliquer le reglage recommande'}
              </button>
              <div style={{ color: '#9a3412', fontSize: '12px', fontWeight: '600' }}>
                Puis relance le calcul.
              </div>
            </div>
          )}

          {plannerFeedback.metrics.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '14px' }}>
              {plannerFeedback.metrics.map(metric => (
                <div
                  key={metric.label}
                  style={{
                    backgroundColor: 'white',
                    border: '1px solid #ffedd5',
                    borderRadius: '12px',
                    padding: '12px'
                  }}
                >
                  <div style={{ fontSize: '11px', textTransform: 'uppercase', color: '#9a3412', fontWeight: '700' }}>
                    {metric.label}
                  </div>
                  <div style={{ marginTop: '4px', fontSize: '20px', fontWeight: '800', color: '#7c2d12' }}>
                    {metric.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '14px', border: '1px solid #ffedd5' }}>
              <div style={{ fontSize: '13px', fontWeight: '800', color: '#9a3412', marginBottom: '8px' }}>
                Comment le calcul se fait
              </div>
              <ul style={{ margin: 0, paddingLeft: '18px', color: '#7c2d12', fontSize: '13px', lineHeight: 1.6 }}>
                {plannerFeedback.formula.map(line => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>

            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '14px', border: '1px solid #ffedd5' }}>
              <div style={{ fontSize: '13px', fontWeight: '800', color: '#9a3412', marginBottom: '8px' }}>
                Ce que tu peux faire maintenant
              </div>
              <ul style={{ margin: 0, paddingLeft: '18px', color: '#7c2d12', fontSize: '13px', lineHeight: 1.6 }}>
                {plannerFeedback.actions.map(action => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
          <div style={{ backgroundColor: 'white', borderRadius: '14px', padding: '18px', boxShadow: '0 8px 20px rgba(15, 23, 42, 0.05)', borderLeft: '5px solid #1c6dd0' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', color: '#667085', fontWeight: '700' }}>Blocks</div>
            <div style={{ fontSize: '30px', color: '#1d2939', fontWeight: '800', marginTop: '8px' }}>{summary.total_blocks}</div>
          </div>
          <div style={{ backgroundColor: 'white', borderRadius: '14px', padding: '18px', boxShadow: '0 8px 20px rgba(15, 23, 42, 0.05)', borderLeft: '5px solid #198754' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', color: '#667085', fontWeight: '700' }}>Clients couverts</div>
            <div style={{ fontSize: '30px', color: '#1d2939', fontWeight: '800', marginTop: '8px' }}>{summary.total_unique_clients}</div>
          </div>
          <div style={{ backgroundColor: 'white', borderRadius: '14px', padding: '18px', boxShadow: '0 8px 20px rgba(15, 23, 42, 0.05)', borderLeft: '5px solid #f79009' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', color: '#667085', fontWeight: '700' }}>Visites planifiees</div>
            <div style={{ fontSize: '30px', color: '#1d2939', fontWeight: '800', marginTop: '8px' }}>{summary.total_visits}</div>
          </div>
          <div style={{ backgroundColor: 'white', borderRadius: '14px', padding: '18px', boxShadow: '0 8px 20px rgba(15, 23, 42, 0.05)', borderLeft: '5px solid #d9485f' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', color: '#667085', fontWeight: '700' }}>CA predit</div>
            <div style={{ fontSize: '30px', color: '#1d2939', fontWeight: '800', marginTop: '8px' }}>{summary.total_predicted_ca.toLocaleString()} TND</div>
          </div>
        </div>
      )}

      {summary?.planner_note && (
        <div
          style={{
            padding: '14px 16px',
            borderRadius: '12px',
            backgroundColor: (summary.capacity_limited || summary.planning_mode === 'relaxed') ? '#fff7ed' : '#eff8ff',
            color: (summary.capacity_limited || summary.planning_mode === 'relaxed') ? '#b54708' : '#175cd3',
            marginBottom: '24px',
            fontWeight: '600'
          }}
        >
          {summary.planner_note}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: selectedBlock ? 'minmax(320px, 420px) minmax(0, 1fr)' : '1fr', gap: '24px' }}>
        <div style={{ backgroundColor: 'white', borderRadius: '16px', padding: '18px', boxShadow: '0 10px 25px rgba(15, 23, 42, 0.06)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
            <h3 style={{ margin: 0, color: '#1a2b4c' }}>Blocks de tournee</h3>
            {summary && (
              <span style={{ fontSize: '12px', color: '#667085', fontWeight: '700' }}>
                {summary.start_date} {'->'} {summary.end_date}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '900px', overflowY: 'auto', paddingRight: '4px' }}>
            {blocks.length === 0 ? (
              <div style={{ padding: '18px', borderRadius: '12px', backgroundColor: '#f8fafc', color: '#667085', textAlign: 'center' }}>
                {plannerFeedback
                  ? 'Aucun block n\'a pu etre genere avec ces reglages. Ajuste les parametres ci-dessus puis relance le calcul.'
                  : 'Lance la planification pour afficher les blocks.'}
              </div>
            ) : (
              blocks.map(block => {
                const selected = selectedBlock?.id === block.id
                return (
                  <div
                    key={block.id}
                    style={{
                      borderRadius: '14px',
                      border: selected ? '2px solid #1c6dd0' : '1px solid #e4e7ec',
                      backgroundColor: selected ? '#f5f9ff' : 'white',
                      padding: '16px'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', marginBottom: '10px' }}>
                      <div>
                        <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#667085', fontWeight: '800' }}>{block.day_label}</div>
                        <div style={{ marginTop: '4px', color: '#1d2939', fontSize: '18px', fontWeight: '800' }}>{block.proposed_commercial_label}</div>
                      </div>
                      <div style={{ padding: '6px 10px', borderRadius: '999px', backgroundColor: '#eef2ff', color: '#4338ca', fontSize: '12px', fontWeight: '800' }}>
                        Score moy. {block.average_score.toFixed(1)}
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px', marginBottom: '14px' }}>
                      <div style={{ padding: '10px 12px', borderRadius: '10px', backgroundColor: '#f8fafc' }}>
                        <div style={{ fontSize: '11px', color: '#667085', fontWeight: '700', textTransform: 'uppercase' }}>Nombre clients</div>
                        <div style={{ marginTop: '4px', fontSize: '22px', fontWeight: '800', color: '#101828' }}>{block.clients_count}</div>
                        {block.capacity?.max_clients ? (
                          <div style={{ marginTop: '4px', fontSize: '11px', color: '#667085', fontWeight: '700' }}>
                            Cible {block.capacity.planned_clients}/{block.capacity.target_clients || block.capacity.max_clients}
                          </div>
                        ) : null}
                        {block.capacity?.historical_max_clients && block.capacity.historical_max_clients !== (block.capacity.target_clients || block.capacity.max_clients) ? (
                          <div style={{ marginTop: '2px', fontSize: '10px', color: '#98a2b3', fontWeight: '700' }}>
                            Cap. hist {block.capacity.historical_max_clients}
                          </div>
                        ) : null}
                      </div>
                      <div style={{ padding: '10px 12px', borderRadius: '10px', backgroundColor: '#f8fafc' }}>
                        <div style={{ fontSize: '11px', color: '#667085', fontWeight: '700', textTransform: 'uppercase' }}>CA predit</div>
                        <div style={{ marginTop: '4px', fontSize: '22px', fontWeight: '800', color: '#198754' }}>{block.predicted_ca.toFixed(1)} TND</div>
                        {block.capacity?.max_truck_units ? (
                          <div style={{ marginTop: '4px', fontSize: '11px', color: '#667085', fontWeight: '700' }}>
                            Charge {Number(block.capacity.planned_truck_units || 0).toFixed(1)}/{Number(block.capacity.max_truck_units || 0).toFixed(1)}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <button
                      onClick={() => setSelectedBlockId(block.id)}
                      style={{
                        width: '100%',
                        padding: '11px 14px',
                        borderRadius: '10px',
                        border: 'none',
                        backgroundColor: selected ? '#1c6dd0' : '#1d2939',
                        color: 'white',
                        fontWeight: '700',
                        cursor: 'pointer'
                      }}
                    >
                      Voir detail
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {selectedBlock && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ backgroundColor: 'white', borderRadius: '16px', padding: '20px', boxShadow: '0 10px 25px rgba(15, 23, 42, 0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '18px' }}>
                <div>
                  <h3 style={{ margin: 0, color: '#1a2b4c' }}>Detail de la tournee</h3>
                  <div style={{ marginTop: '6px', color: '#667085', fontSize: '13px', fontWeight: '600' }}>
                    {selectedBlock.day_label} - {selectedBlock.date} - {selectedBlock.proposed_commercial_label}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ padding: '8px 12px', borderRadius: '10px', backgroundColor: '#eef5ff', color: '#1c6dd0', fontSize: '12px', fontWeight: '800' }}>
                    {selectedBlock.clients_count} clients
                  </div>
                  <div style={{ padding: '8px 12px', borderRadius: '10px', backgroundColor: '#ecfdf3', color: '#198754', fontSize: '12px', fontWeight: '800' }}>
                    {selectedBlock.predicted_ca.toFixed(1)} TND
                  </div>
                  {selectedCapacity?.max_clients ? (
                    <div style={{ padding: '8px 12px', borderRadius: '10px', backgroundColor: '#f5f3ff', color: '#6d28d9', fontSize: '12px', fontWeight: '800' }}>
                      Cible clients {selectedCapacity.planned_clients}/{selectedCapacity.target_clients || selectedCapacity.max_clients}
                    </div>
                  ) : null}
                  {selectedCapacity?.historical_max_clients && selectedCapacity.historical_max_clients !== (selectedCapacity.target_clients || selectedCapacity.max_clients) ? (
                    <div style={{ padding: '8px 12px', borderRadius: '10px', backgroundColor: '#f8fafc', color: '#475467', fontSize: '12px', fontWeight: '800' }}>
                      Cap. hist {selectedCapacity.historical_max_clients}
                    </div>
                  ) : null}
                  {selectedCapacity?.max_truck_units ? (
                    <div style={{ padding: '8px 12px', borderRadius: '10px', backgroundColor: '#fff7ed', color: '#c2410c', fontSize: '12px', fontWeight: '800' }}>
                      Charge {Number(selectedCapacity.planned_truck_units || 0).toFixed(1)}/{Number(selectedCapacity.max_truck_units || 0).toFixed(1)}
                    </div>
                  ) : null}
                </div>
              </div>

              <div style={{ overflowX: 'auto', maxHeight: '420px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead style={{ position: 'sticky', top: 0, backgroundColor: '#f8fafc' }}>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #eaecf0', color: '#475467' }}>SCORE VIP</th>
                      <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #eaecf0', color: '#475467' }}>CHARGE EST.</th>
                      <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #eaecf0', color: '#475467' }}>JOUR</th>
                      <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #eaecf0', color: '#475467' }}>CLIENT</th>
                      <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #eaecf0', color: '#475467' }}>CHIFFRE PREDIT</th>
                      <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #eaecf0', color: '#475467' }}>ZONE COMM.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRows.map((row, index) => {
                      let scoreColor = '#d9485f'
                      if (row.score_ia >= 80) scoreColor = '#198754'
                      else if (row.score_ia >= 50) scoreColor = '#f79009'

                      const isExpanded = clickedClient === `${row.nbr_client}-${index}`

                      return (
                        <tr key={`${row.nbr_client}-${index}`} style={{ backgroundColor: index % 2 === 0 ? 'white' : '#f8fafc' }}>
                          <td style={{ padding: '10px 8px', borderBottom: '1px solid #eaecf0', fontWeight: '800', color: scoreColor }}>
                            {Number(row.score_ia || 0).toFixed(1)} / 100
                          </td>
                          <td style={{ padding: '10px 8px', borderBottom: '1px solid #eaecf0' }}>
                            <div
                              onClick={() => setClickedClient(isExpanded ? null : `${row.nbr_client}-${index}`)}
                              style={{
                                display: 'inline-block',
                                padding: '4px 8px',
                                borderRadius: '6px',
                                backgroundColor: isExpanded ? '#e7f0ff' : '#eef5ff',
                                color: '#1c6dd0',
                                fontWeight: '800',
                                cursor: 'pointer'
                              }}
                            >
                              {row.qte_reco} unites estimees
                            </div>
                            {isExpanded && (
                              <div style={{ marginTop: '8px', padding: '10px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #d8e9ff', fontSize: '12px' }}>
                                <div style={{ fontWeight: '800', marginBottom: '6px', color: '#344054' }}>
                                  Produits recommandes:
                                </div>
                                {row.produits && row.produits.length > 0 ? (
                                  row.produits.map((produit, produitIndex) => (
                                    <div
                                      key={`${produit.nom}-${produitIndex}`}
                                      style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        gap: '12px',
                                        padding: '4px 0',
                                        borderBottom: produitIndex < row.produits.length - 1 ? '1px solid #eaecf0' : 'none',
                                        color: '#101828'
                                      }}
                                    >
                                      <span style={{ fontWeight: '600' }}>{produit.nom}</span>
                                      <span style={{ fontWeight: '800', color: '#1c6dd0' }}>{produit.quantite} unites</span>
                                    </div>
                                  ))
                                ) : (
                                  <div style={{ color: '#667085', fontStyle: 'italic' }}>
                                    Aucun detail produit disponible pour ce client.
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '10px 8px', borderBottom: '1px solid #eaecf0', color: '#344054', fontWeight: '700' }}>
                            {selectedBlock.day_label}
                          </td>
                          <td style={{ padding: '10px 8px', borderBottom: '1px solid #eaecf0', color: '#101828' }}>
                            {row.nom} ({row.nbr_client})
                          </td>
                          <td style={{ padding: '10px 8px', borderBottom: '1px solid #eaecf0', color: '#198754', fontWeight: '800' }}>
                            {row.chiffre}
                          </td>
                          <td style={{ padding: '10px 8px', borderBottom: '1px solid #eaecf0', color: '#101828' }}>
                            {row.commercia_zone}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ backgroundColor: '#1a2b4c', color: 'white', borderRadius: '16px', padding: '20px', boxShadow: '0 10px 25px rgba(15, 23, 42, 0.12)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
                <div>
                  <h3 style={{ margin: 0, color: '#60a5fa' }}>Estimation Chargement</h3>
                  <p style={{ margin: '8px 0 0 0', fontSize: '13px', color: '#c5d3e3' }}>
                    Estimation de chargement utilisee pour equilibrer les tournees sur ce block.
                  </p>
                </div>
                <div style={{ padding: '8px 12px', borderRadius: '10px', backgroundColor: '#2c3e5d', color: '#20c997', fontSize: '12px', fontWeight: '800' }}>
                  {quantiteTotalCamion.toFixed(1)} unites
                </div>
              </div>

              <div style={{ maxHeight: '260px', overflowY: 'auto', paddingRight: '5px' }}>
                {chargeTotale.detailsProduits && chargeTotale.detailsProduits.length > 0 ? (
                  chargeTotale.detailsProduits.map((produit, index) => (
                    <div
                      key={`${produit.nom}-${index}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        backgroundColor: '#2c3e5d',
                        padding: '10px 15px',
                        borderRadius: '8px',
                        marginBottom: '8px',
                        gap: '12px'
                      }}
                    >
                      <span style={{ fontWeight: '800', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '70%' }} title={produit.nom}>
                        {produit.nom}
                      </span>
                      <span style={{ fontSize: '16px', fontWeight: '800', color: '#20c997', whiteSpace: 'nowrap' }}>
                        {Number(produit.quantite || 0).toFixed(1)}
                      </span>
                    </div>
                  ))
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e5d', padding: '10px 15px', borderRadius: '8px', marginBottom: '10px' }}>
                      <span style={{ fontWeight: '700' }}>Agro-Alimentaire</span>
                      <span style={{ fontSize: '18px', fontWeight: '800', color: '#fff' }}>{Number(chargeTotale.agro || 0).toFixed(1)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e5d', padding: '10px 15px', borderRadius: '8px', marginBottom: '10px' }}>
                      <span style={{ fontWeight: '700' }}>Chips & Snacks</span>
                      <span style={{ fontSize: '18px', fontWeight: '800', color: '#fff' }}>{Number(chargeTotale.chips || 0).toFixed(1)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e5d', padding: '10px 15px', borderRadius: '8px' }}>
                      <span style={{ fontWeight: '700' }}>Bureautique</span>
                      <span style={{ fontSize: '18px', fontWeight: '800', color: '#fff' }}>{Number(chargeTotale.bureautique || 0).toFixed(1)}</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div style={{ backgroundColor: 'white', borderRadius: '16px', padding: '20px', boxShadow: '0 10px 25px rgba(15, 23, 42, 0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0, color: '#1a2b4c' }}>GPS et itineraire</h3>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ padding: '8px 12px', borderRadius: '10px', backgroundColor: '#eef5ff', color: '#1c6dd0', fontSize: '12px', fontWeight: '700' }}>
                    {routePlan.summary ? `${formatDistance(routePlan.summary.distance)} - ${formatDuration(routePlan.summary.duration)}` : 'Trace simplifie'}
                  </div>
                  <div style={{ padding: '8px 12px', borderRadius: '10px', backgroundColor: '#f5f7fa', color: '#475467', fontSize: '12px', fontWeight: '700' }}>
                    {routePlan.origin ? `Depart: ${routePlan.origin.nom || 'Depot'}` : 'Depart: premier client'}
                  </div>
                </div>
              </div>

              <div style={{ width: '100%', height: '360px', borderRadius: '14px', overflow: 'hidden', marginBottom: '18px', position: 'relative', backgroundColor: '#e5e7eb' }}>
                <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
                {!selectedRows.length && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475467', fontWeight: '700', backgroundColor: 'rgba(255,255,255,0.82)' }}>
                    Pas de donnees GPS disponibles pour ce block.
                  </div>
                )}
                {routePlan.loading && (
                  <div style={{ position: 'absolute', top: 12, right: 12, padding: '8px 12px', borderRadius: '10px', backgroundColor: 'rgba(28, 109, 208, 0.95)', color: 'white', fontSize: '12px', fontWeight: '700' }}>
                    Calcul de la route...
                  </div>
                )}
              </div>

              {routePlan.error && (
                <div style={{ marginBottom: '14px', padding: '10px 12px', borderRadius: '10px', backgroundColor: '#fff7e6', color: '#9a6700', fontSize: '12px', fontWeight: '700' }}>
                  {routePlan.error}
                </div>
              )}

              {validationFeedback && (
                <div
                  style={{
                    marginBottom: '14px',
                    padding: '10px 12px',
                    borderRadius: '10px',
                    backgroundColor: validationFeedback.type === 'success' ? '#ecfdf3' : '#fef3f2',
                    color: validationFeedback.type === 'success' ? '#027a48' : '#b42318',
                    fontSize: '12px',
                    fontWeight: '700'
                  }}
                >
                  {validationFeedback.message}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(260px, 1fr)', gap: '16px' }}>
                <div style={{ maxHeight: '220px', overflowY: 'auto', paddingRight: '6px' }}>
                  {routePlan.orderedStops.length ? (
                    <ol style={{ paddingLeft: '18px', margin: 0, fontSize: '14px', color: '#475467' }}>
                      {routePlan.orderedStops.map(stop => (
                        <li key={`${stop.client_code}-${stop.step}`} style={{ marginBottom: '10px' }}>
                          <strong>{stop.step}. {stop.nom}</strong><br />
                          <span style={{ color: '#667085', fontSize: '13px' }}>{stop.adresse}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div style={{ color: '#667085', fontSize: '13px' }}>Le detail de navigation n'est pas encore disponible.</div>
                  )}
                </div>

                <div style={{ backgroundColor: '#f8fbff', border: '1px solid #d8e9ff', borderRadius: '12px', padding: '14px' }}>
                  <div style={{ fontSize: '13px', fontWeight: '800', color: '#1a2b4c', marginBottom: '8px' }}>Guidage detaille</div>
                  <div style={{ maxHeight: '180px', overflowY: 'auto', paddingRight: '4px' }}>
                    {routePlan.steps.length ? routePlan.steps.map(step => (
                      <div key={step.id} style={{ marginBottom: '8px', fontSize: '13px', color: '#475467', lineHeight: 1.45 }}>
                        <strong>{step.text}</strong>
                        <div style={{ color: '#667085', fontSize: '12px' }}>
                          {formatDistance(step.distance)} - {formatDuration(step.duration)}
                        </div>
                      </div>
                    )) : (
                      <div style={{ color: '#667085', fontSize: '13px' }}>
                        Le detail tournant par tournant n'est pas disponible pour cet itineraire.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: '16px' }}>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  <a
                    href={navigationUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'inline-block',
                      padding: '12px 18px',
                      borderRadius: '10px',
                      backgroundColor: '#198754',
                      color: 'white',
                      fontWeight: '800',
                      textDecoration: 'none'
                    }}
                  >
                    Ouvrir la navigation
                  </a>

                  <button
                    type="button"
                    onClick={validateRoutePlan}
                    disabled={validationLoading}
                    title={validationDisabledReason || 'Enregistrer cette tournee finale dans la base'}
                    style={{
                      display: 'inline-block',
                      padding: '12px 18px',
                      borderRadius: '10px',
                      border: 'none',
                      backgroundColor: validationLoading ? '#94a3b8' : '#1c6dd0',
                      color: 'white',
                      fontWeight: '800',
                      cursor: validationLoading ? 'not-allowed' : 'pointer',
                      opacity: validationDisabledReason && !validationLoading ? 0.8 : 1
                    }}
                  >
                    {validationLoading ? 'Validation en cours...' : 'Valider le Plan de Route'}
                  </button>
                </div>

                {validationDisabledReason && (
                  <div style={{ marginTop: '10px', fontSize: '12px', color: '#667085', fontWeight: '600' }}>
                    {validationDisabledReason}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

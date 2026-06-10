const { execFile } = require('child_process')
const path = require('path')
const axios = require('axios')
const express = require('express')
const mysql = require('mysql2')
const cors = require('cors')
const fs = require('fs')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())

const apiDir = __dirname
const SHARED_DEPOT_ORIGIN = {
  latitude: Number(process.env.DEPOT_LATITUDE || 36.8065),
  longitude: Number(process.env.DEPOT_LONGITUDE || 10.1815),
  nom: process.env.DEPOT_NAME || 'Depot principal',
  adresse: process.env.DEPOT_ADDRESS || 'Point de depart commun'
}
const DEPOT_COORDS_BY_CODE = (() => {
  try {
    return JSON.parse(process.env.DEPOT_COORDS_BY_CODE || '{}')
  } catch (error) {
    console.warn('DEPOT_COORDS_BY_CODE invalide, fallback sur depot partage.')
    return {}
  }
})()

const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'dist_utic'
})

db.connect(err => {
  if (err) {
    console.error('Erreur SQL de connexion:', err)
    return
  }

  console.log('Connecte a la base de donnees dist_utic !')
  console.log('Le reentrainement automatique est desactive dans server.js. Utilisez le scheduler systeme.')
})

const COMMERCIAL_OPTIONS_CACHE_TTL_MS = 5 * 60 * 1000
let commercialOptionsCache = {
  data: null,
  expiresAt: 0,
  pending: null
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function buildDistanceMap(clients) {
  const geoClients = clients.filter(c => c.latitude != null && c.longitude != null && !isNaN(Number(c.latitude)) && !isNaN(Number(c.longitude)))
  if (!geoClients.length) {
    return { distanceMap: new Map(), maxDistance: 0 }
  }

  const centerLat = geoClients.reduce((sum, c) => sum + Number(c.latitude), 0) / geoClients.length
  const centerLon = geoClients.reduce((sum, c) => sum + Number(c.longitude), 0) / geoClients.length

  const distanceMap = new Map()
  let maxDistance = 0

  geoClients.forEach(c => {
    const dist = haversineKm(centerLat, centerLon, Number(c.latitude), Number(c.longitude))
    distanceMap.set(String(c.nbr_client), dist)
    if (dist > maxDistance) maxDistance = dist
  })

  return { distanceMap, maxDistance }
}

function computePriorityScore(chiffrePredit, maxChiffre, probAchat, habitScore, recencyScore, distanceKm, maxDistanceKm) {
  const venteNorm = maxChiffre > 0 ? chiffrePredit / maxChiffre : 0
  const purchaseSignal = clamp(
    (((probAchat || 0) * 0.75) + ((habitScore || 0) * 0.15) + ((recencyScore || 0) * 0.10)) / 100,
    0,
    1
  )
  const distanceNorm = maxDistanceKm > 0 ? clamp(distanceKm / maxDistanceKm, 0, 1) : 0

  const scoreNorm = (0.6 * venteNorm) + (0.35 * purchaseSignal) - (0.05 * distanceNorm)
  return roundScore(clamp(scoreNorm * 100, 0, 100))
}

function computeRecoveryScore(encoursCredit, maxEncours, plafondCredit, distanceKm, maxDistanceKm) {
  const encoursNorm = maxEncours > 0 ? encoursCredit / maxEncours : 0
  const plafondRatio = plafondCredit > 0 ? clamp(encoursCredit / plafondCredit, 0, 1.5) / 1.5 : 0
  const distanceNorm = maxDistanceKm > 0 ? clamp(distanceKm / maxDistanceKm, 0, 1) : 0
  const scoreNorm = (0.70 * encoursNorm) + (0.20 * plafondRatio) - (0.10 * distanceNorm)
  return roundScore(clamp(scoreNorm * 100, 0, 100))
}

function computeSmartRecoveryScore({
  dueBalance,
  maxDueBalance,
  likelyRecoveryAmount,
  maxLikelyRecovery,
  severeOverdueBalance,
  maxSevereOverdue,
  paymentBehaviorScore,
  distanceKm,
  maxDistanceKm
}) {
  const dueBalanceNorm = maxDueBalance > 0 ? dueBalance / maxDueBalance : 0
  const likelyRecoveryNorm = maxLikelyRecovery > 0 ? likelyRecoveryAmount / maxLikelyRecovery : 0
  const severeOverdueNorm = maxSevereOverdue > 0 ? severeOverdueBalance / maxSevereOverdue : 0
  const paymentBehaviorNorm = clamp(paymentBehaviorScore || 0, 0, 1)
  const distanceNorm = maxDistanceKm > 0 ? clamp(distanceKm / maxDistanceKm, 0, 1) : 0

  const scoreNorm =
    (0.45 * dueBalanceNorm) +
    (0.25 * severeOverdueNorm) +
    (0.20 * likelyRecoveryNorm) +
    (0.15 * paymentBehaviorNorm) -
    (0.05 * distanceNorm)

  return roundScore(clamp(scoreNorm * 100, 0, 100))
}

function roundScore(value) {
  return Math.round(value * 10) / 10
}

function normalizeClientKeys(rawValue) {
  const rawKey = String(rawValue || '').trim()
  if (!rawKey) return []

  const normalizedKeys = new Set([
    rawKey,
    rawKey.replace(/^0+/, '') || '0'
  ])

  if (/^\d+$/.test(rawKey)) {
    normalizedKeys.add(rawKey.padStart(5, '0'))
  }

  return [...normalizedKeys]
}

function setClientMapValue(map, rawValue, payload) {
  normalizeClientKeys(rawValue).forEach(key => map.set(key, payload))
}

function getClientMapValue(map, rawValue) {
  const keys = normalizeClientKeys(rawValue)
  for (const key of keys) {
    if (map.has(key)) return map.get(key)
  }
  return null
}

function getCanonicalClientKey(rawValue) {
  const rawKey = String(rawValue || '').trim()
  if (!rawKey) return ''
  return rawKey.replace(/^0+/, '') || '0'
}

function estimateLikelyRecoveryAmount({
  encoursCredit,
  avgPaymentAmount,
  maxPaymentAmount,
  totalPaid30d,
  nbPaymentsHist,
  nbDocsCredit
}) {
  const encours = Number(encoursCredit || 0)
  if (encours <= 0) return 0

  const avgPaid = Number(avgPaymentAmount || 0)
  const maxPaid = Number(maxPaymentAmount || 0)
  const paid30d = Number(totalPaid30d || 0)
  const trancheRatio = nbDocsCredit > 0 ? Number(nbPaymentsHist || 0) / nbDocsCredit : 0
  const tendsToPayByTranches = trancheRatio > 1.2

  let estimated = avgPaid

  if (tendsToPayByTranches) {
    estimated = Math.max(avgPaid, paid30d > 0 ? paid30d * 0.6 : 0)
  } else {
    estimated = Math.max(avgPaid * 1.15, maxPaid * 0.5, paid30d > 0 ? paid30d * 0.4 : 0)
  }

  if (estimated <= 0) {
    estimated = Math.min(encours, maxPaid || avgPaid || encours * 0.25)
  }

  return roundScore(clamp(estimated, 0, encours))
}

function parseSqlDate(value) {
  if (!value) return null
  const datePart = String(value).slice(0, 10)
  const [year, month, day] = datePart.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(Date.UTC(year, month - 1, day))
}

function diffDays(dateA, dateB) {
  const first = parseSqlDate(dateA)
  const second = parseSqlDate(dateB)
  if (!first || !second) return null
  return Math.max(0, Math.floor((second.getTime() - first.getTime()) / 86400000))
}

function buildDepotOrigin(depotConfig, route, commercial, depotCode) {
  if (!depotConfig || !Number.isFinite(Number(depotConfig.latitude)) || !Number.isFinite(Number(depotConfig.longitude))) {
    return null
  }

  const routeLabel = route ? `Route ${route}` : 'Toutes les routes'
  const commercialLabel = commercial ? `Commercial ${commercial}` : 'Tous les commerciaux'

  return {
    latitude: Number(depotConfig.latitude),
    longitude: Number(depotConfig.longitude),
    nom: depotConfig.nom || SHARED_DEPOT_ORIGIN.nom,
    adresse: depotConfig.adresse || SHARED_DEPOT_ORIGIN.adresse,
    type: 'depot',
    depot_code: depotCode || null,
    route: route || null,
    commercial: commercial || null,
    adresse: `${depotConfig.adresse || SHARED_DEPOT_ORIGIN.adresse} - ${routeLabel} / ${commercialLabel}`
  }
}

function getSharedDepotOrigin(route, commercial, depotCode = null) {
  return buildDepotOrigin(SHARED_DEPOT_ORIGIN, route, commercial, depotCode)
}

function queryAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => {
      if (err) reject(err)
      else resolve(rows)
    })
  })
}

async function fetchCommercialOptions() {
  const now = Date.now()
  if (commercialOptionsCache.data !== null && commercialOptionsCache.expiresAt > now) {
    return commercialOptionsCache.data
  }

  if (commercialOptionsCache.pending) {
    return commercialOptionsCache.pending
  }

  commercialOptionsCache.pending = (async () => {
    const rows = await queryAsync(`
      SELECT
        u.code AS commercial,
        NULLIF(TRIM(CONCAT(COALESCE(u.prenom, ''), ' ', COALESCE(u.nom, ''))), '') AS full_name
      FROM users u
      WHERE u.isactif = 1
        AND COALESCE(u.isadmin, 0) = 0
        AND u.deleted_at IS NULL
        AND u.role_code = 'commercial'
        AND u.type IN ('prevendeur', 'cashvan', 'cashvan_livreur')
        AND u.code IS NOT NULL
        AND u.code <> ''
        AND EXISTS (
          SELECT 1
          FROM clients c
          WHERE c.user_code = u.code
            AND c.deleted_at IS NULL
            AND c.isactif = '1'
            AND EXISTS (
              SELECT 1
              FROM entetecommercials e
              WHERE e.client_code = c.code
                AND e.deleted_at IS NULL
                AND e.type IN ('facture', 'bl', 'blf')
                AND (
                  e.commercial_code = u.code
                  OR e.user_code = u.code
                )
            )
        )
      ORDER BY COALESCE(u.ordre, 999999), u.code
    `)

    const data = (rows || [])
      .map(row => {
        const value = String(row.commercial || '').trim()
        const fullName = String(row.full_name || '').trim()
        return {
          value,
          label: fullName ? `${fullName} (${value})` : `Commercial ${value}`
        }
      })
      .filter(item => item.value)

    commercialOptionsCache.data = data
    commercialOptionsCache.expiresAt = Date.now() + COMMERCIAL_OPTIONS_CACHE_TTL_MS

    return data
  })()

  try {
    return await commercialOptionsCache.pending
  } finally {
    commercialOptionsCache.pending = null
  }
}

async function resolveDepotOrigin(route, commercial) {
  if (!route) {
    return getSharedDepotOrigin(route, commercial)
  }

  try {
    const rows = await queryAsync(
      `SELECT code, depot_code FROM routings WHERE code = ? LIMIT 1`,
      [route]
    )

    const routing = rows[0]
    if (!routing || !routing.depot_code) {
      return getSharedDepotOrigin(route, commercial)
    }

    const depotRows = await queryAsync(
      `SELECT code, nom, latitude, longitude, adresse
       FROM depots
       WHERE code = ? AND actif = 1
       LIMIT 1`,
      [routing.depot_code]
    )

    const depot = depotRows[0]
    if (depot && Number.isFinite(Number(depot.latitude)) && Number.isFinite(Number(depot.longitude))) {
      return buildDepotOrigin(depot, route, commercial, routing.depot_code)
    }

    const depotConfig = DEPOT_COORDS_BY_CODE[routing.depot_code]
    if (depotConfig) {
      return buildDepotOrigin(depotConfig, route, commercial, routing.depot_code)
    }

    return getSharedDepotOrigin(route, commercial, routing.depot_code)
  } catch (error) {
    console.error('Impossible de resoudre le depot de la route:', error.message)
    return getSharedDepotOrigin(route, commercial)
  }
}

function applyClientObjective(sortedClients, maxClients, targetChiffre) {
  const hasMaxClients = Number.isFinite(maxClients) && maxClients > 0
  const cappedClients = hasMaxClients ? sortedClients.slice(0, maxClients) : [...sortedClients]
  if (!targetChiffre || targetChiffre <= 0) {
    return cappedClients
  }

  const selected = []
  let cumulativeChiffre = 0

  for (const client of cappedClients) {
    selected.push(client)
    cumulativeChiffre += Number(client.chiffre_brut || 0)
    if (cumulativeChiffre >= targetChiffre) {
      break
    }
  }

  return selected
}

const FRENCH_DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi']

function parseLocalDate(value) {
  if (!value) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return today
  }

  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number)
  const parsed = new Date(year, (month || 1) - 1, day || 1)
  parsed.setHours(0, 0, 0, 0)
  return parsed
}

function formatLocalDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addLocalDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  next.setHours(0, 0, 0, 0)
  return next
}

function buildWorkingDays(startDateValue, periodDays) {
  const startDate = parseLocalDate(startDateValue)
  const days = []

  for (let offset = 0; offset < periodDays; offset += 1) {
    const current = addLocalDays(startDate, offset)
    if (current.getDay() === 0) continue
    days.push({
      date: formatLocalDate(current),
      dayIndex: current.getDay(),
      label: FRENCH_DAY_NAMES[current.getDay()]
    })
  }

  return days
}

function parseCommercialSelection(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue.map(value => String(value || '').trim()).filter(Boolean)
  }

  if (!rawValue) return []

  return String(rawValue)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

function buildInClause(column, values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { sql: '', params: [] }
  }

  const placeholders = values.map(() => '?').join(', ')
  return {
    sql: ` AND ${column} IN (${placeholders})`,
    params: [...values]
  }
}

function deriveFallbackProbability(visitsHist, daysSinceLastVisit, periodDays) {
  const visitSignal = clamp((Number(visitsHist || 0) / 24) * 100, 6, 70)
  const urgencySignal = clamp((Number(daysSinceLastVisit || 0) / Math.max(periodDays, 1)) * 55, 0, 55)
  return roundScore(clamp((visitSignal * 0.65) + urgencySignal, 5, 85))
}

function deriveFallbackHabitScore(visitsHist) {
  return roundScore(clamp((Number(visitsHist || 0) / 40) * 100, 5, 100))
}

function deriveFallbackRecencyScore(daysSinceLastVisit, periodDays) {
  return roundScore(clamp((Number(daysSinceLastVisit || 0) / Math.max(periodDays, 1)) * 100, 0, 100))
}

function computeCoveragePriorityScore({
  predictedCa,
  maxPredictedCa,
  probability,
  habitScore,
  recencyScore,
  distanceKm,
  maxDistanceKm,
  daysSinceLastVisit,
  periodDays,
  repetitionIndex = 0
}) {
  const urgencyRecency = Math.max(
    Number(recencyScore || 0),
    clamp((Number(daysSinceLastVisit || 0) / Math.max(periodDays, 1)) * 100, 0, 100)
  )
  const baseScore = computePriorityScore(
    Number(predictedCa || 0),
    Number(maxPredictedCa || 0),
    Number(probability || 0),
    Number(habitScore || 0),
    urgencyRecency,
    Number(distanceKm || 0),
    Number(maxDistanceKm || 0)
  )

  return roundScore(clamp(baseScore - (repetitionIndex * 7), 0, 100))
}

function computeVisitQuota(profile, periodDays) {
  let quota = 1
  const maxPredictedCa = Number(profile.predicted_ca || 0)
  const avgProbability = Number(profile.probability || 0)
  const visitsHist = Number(profile.visits_hist || 0)
  const daysSinceLastVisit = Number(profile.days_since_last_visit || 0)

  if (maxPredictedCa >= 450 || avgProbability >= 35 || visitsHist >= 24) quota += 1
  if (maxPredictedCa >= 900 || avgProbability >= 55 || visitsHist >= 48) quota += 1
  if (daysSinceLastVisit >= Math.max(periodDays * 1.5, 21) && quota < 2) quota += 1

  return Math.max(1, Math.min(3, quota))
}

function createBlockSlots(workingDays, commercials, totalVisits, minVisits) {
  const availableSlots = []
  workingDays.forEach(day => {
    commercials.forEach(commercial => {
      availableSlots.push({
        id: `${day.date}::${commercial.value}`,
        date: day.date,
        day_label: day.label,
        proposed_commercial: commercial.value,
        proposed_commercial_label: commercial.label,
        tournees: [],
        total_predicted_ca: 0,
        total_score: 0,
        uniqueClients: new Set()
      })
    })
  })

  if (availableSlots.length === 0) return []

  const safeMinVisits = Math.max(1, Number(minVisits || 1))
  let blockCount = Math.max(1, Math.ceil(totalVisits / safeMinVisits))
  blockCount = Math.min(blockCount, availableSlots.length)

  while (blockCount > 1 && Math.floor(totalVisits / blockCount) < safeMinVisits) {
    blockCount -= 1
  }

  const targetBase = Math.floor(totalVisits / blockCount)
  let remainder = totalVisits % blockCount

  return availableSlots.slice(0, blockCount).map(slot => {
    const targetSize = targetBase + (remainder > 0 ? 1 : 0)
    if (remainder > 0) remainder -= 1

    return {
      ...slot,
      target_size: targetSize
    }
  })
}

function pickBestSlotForVisit(slots, visit, cursorRef) {
  if (!slots.length) return null

  const totalSlots = slots.length
  const preferredCommercial = String(visit.proposed_commercial || '').trim()
  const preferredSlotId = String(visit.recommended_slot_id || '').trim()
  const clientKey = visit.canonical_client_key

  const scoreSlot = (slot, index) => {
    const slotSignal = visit.slot_predictions?.[slot.id] || null
    const mlAffinity = clamp(Number(slotSignal?.assignment_prob || 0), 0, 100)
    const mlPredictedCa = Math.max(0, Number(slotSignal?.weighted_predicted_ca || slotSignal?.predicted_ca || 0))
    const sameCommercial = preferredCommercial && slot.proposed_commercial === preferredCommercial ? 6 : 0
    const recommendedSlotBonus = preferredSlotId && slot.id === preferredSlotId ? 12 : 0
    const remainingCapacity = Math.max(0, slot.target_size - slot.tournees.length)
    const loadPenalty = slot.tournees.length * 2
    const cursorBonus = ((index - cursorRef.current + totalSlots) % totalSlots) === 0 ? 4 : 0
    return (mlAffinity * 0.45) + (mlPredictedCa * 0.02) + sameCommercial + recommendedSlotBonus + (remainingCapacity * 3) - loadPenalty + cursorBonus
  }

  let bestIndex = -1
  let bestScore = Number.NEGATIVE_INFINITY

  for (let i = 0; i < totalSlots; i += 1) {
    const index = (cursorRef.current + i) % totalSlots
    const slot = slots[index]
    if (slot.uniqueClients.has(clientKey)) continue
    const currentScore = scoreSlot(slot, index)
    if (currentScore > bestScore) {
      bestScore = currentScore
      bestIndex = index
    }
  }

  if (bestIndex < 0) {
    bestIndex = cursorRef.current % totalSlots
  }

  cursorRef.current = (bestIndex + 1) % totalSlots
  return slots[bestIndex]
}

function finalizeCoverageBlock(slot, depotOrigin) {
  const tournees = slot.tournees
    .sort((a, b) => (b.score_ia - a.score_ia) || (b.chiffre_brut - a.chiffre_brut))
    .map((row, index) => ({
      ...row,
      date_jour: slot.date,
      jour_label: slot.day_label,
      ordre_theorique: index + 1
    }))

  const produitsTotaux = {}
  tournees.forEach(row => {
    if (row.produits && row.produits.length > 0) {
      row.produits.forEach(produit => {
        const nom = String(produit.nom || '').trim()
        if (!nom) return
        if (!produitsTotaux[nom]) {
          produitsTotaux[nom] = 0
        }
        produitsTotaux[nom] += Number(produit.quantite || 0)
      })
    }
  })

  const detailsProduits = Object.entries(produitsTotaux)
    .map(([nom, quantite]) => ({ nom, quantite: roundScore(quantite) }))
    .sort((a, b) => b.quantite - a.quantite)

  const chargeTotale = {
    agro: tournees.reduce((sum, row) => sum + Number(row.details?.agro || 0), 0),
    chips: tournees.reduce((sum, row) => sum + Number(row.details?.chips || 0), 0),
    bureautique: tournees.reduce((sum, row) => sum + Number(row.details?.bur || 0), 0),
    detailsProduits
  }

  const itineraire = tournees.map((row, index) => `${index + 1}. ${row.nom} (${row.nbr_client}) - ${row.adresse || 'Adresse non specifiee'}`)
  const itineraire_geo = tournees.map((row, index) => ({
    step: index + 1,
    client_code: row.nbr_client,
    nom: row.nom,
    adresse: row.adresse || 'Adresse non specifiee',
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    score_ia: row.score_ia,
    qte_reco: row.qte_reco
  }))

  return {
    id: slot.id,
    date: slot.date,
    day_label: slot.day_label,
    proposed_commercial: slot.proposed_commercial,
    proposed_commercial_label: slot.proposed_commercial_label,
    clients_count: tournees.length,
    predicted_ca: roundScore(slot.total_predicted_ca),
    average_score: tournees.length ? roundScore(slot.total_score / tournees.length) : 0,
    detail: {
      tournees,
      total: tournees.length,
      jourSelectionne: slot.date,
      chargeTotale,
      itineraire,
      itineraire_geo,
      depot_origin: depotOrigin
    }
  }
}

function runManualTraining(res) {
  const scriptPath = path.join(apiDir, 'train_auto.py')
  execFile('python', [scriptPath], { cwd: apiDir }, async (error, stdout, stderr) => {
    if (error) {
      console.error(`Erreur d'execution Python: ${error.message}`)
      if (stderr) {
        console.error(stderr)
      }
      return res.status(500).json({
        status: 'error',
        message: "Le reentrainement manuel a echoue. L'application continue d'utiliser le dernier modele valide."
      })
    }

    console.log(`Resultat Python:\n${stdout}`)
    let reloadStatus = 'Reload IA non tente.'
    try {
      const reloadResponse = await axios.post('http://127.0.0.1:5001/api/reload-models')
      reloadStatus = reloadResponse.data?.message || 'Modeles IA recharges.'
    } catch (reloadError) {
      reloadStatus = `Reload IA indisponible: ${reloadError.message}`
      console.warn(reloadStatus)
    }

    return res.json({
      status: 'success',
      message: 'Reentrainement termine. Le dernier modele IA est maintenant disponible.',
      details: stdout,
      reload_status: reloadStatus
    })
  })
}

app.post('/api/train-ia', (req, res) => {
  console.log("Lancement d'un reentrainement manuel IA...")
  runManualTraining(res)
})

app.get('/api/tournees/options', async (req, res) => {
  try {
    const [routes, commerciaux] = await Promise.all([
      queryAsync(`SELECT DISTINCT routing_code AS route FROM clients WHERE routing_code IS NOT NULL AND routing_code != '' ORDER BY routing_code`),
      fetchCommercialOptions()
    ])

    res.json({
      routes: (routes || []).map(r => ({ value: r.route, label: `Route ${r.route}` })),
      commerciaux
    })
  } catch (error) {
    console.error('Erreur SQL options tournees:', error.message)
    res.status(500).json({ error: 'Erreur SQL options tournees' })
  }
})

app.get('/api/tournees/coverage-plan', async (req, res) => {
  const startDate = req.query.start_date || formatLocalDate(new Date())
  const periodDays = Math.max(1, Math.min(60, parseInt(req.query.period_days, 10) || 14))
  const minVisits = Math.max(1, Math.min(250, parseInt(req.query.min_visits, 10) || 20))
  const minTotalCa = Math.max(0, parseFloat(req.query.min_total_ca || '0') || 0)
  const selectedCommercials = parseCommercialSelection(req.query.commercials)
  const workingDays = buildWorkingDays(startDate, periodDays)

  if (workingDays.length === 0) {
    return res.status(400).json({ error: 'Aucun jour ouvrable disponible sur la periode selectionnee.' })
  }

  const allCommercials = await fetchCommercialOptions()

  const activeCommercials = selectedCommercials.length
    ? allCommercials.filter(item => selectedCommercials.includes(item.value))
    : allCommercials

  if (activeCommercials.length === 0) {
    return res.status(400).json({ error: 'Aucun commercial selectionne pour la planification.' })
  }

  const commercialFilter = buildInClause('c.user_code', activeCommercials.map(item => item.value))

  try {
    const sqlClients = `
      SELECT
        c.code AS nbr_client,
        c.nom,
        c.user_code,
        c.routing_code,
        c.delegation,
        c.region,
        c.potentiel,
        c.adresse_facturation AS adresse,
        c.latitude,
        c.longitude
      FROM clients c
      WHERE c.deleted_at IS NULL
        AND c.isactif = '1'
        ${commercialFilter.sql}
    `

    const sqlHistorique = `
      SELECT
        e.client_code,
        MAX(DATE(e.date)) AS last_visit_date,
        COUNT(*) AS visits_hist,
        AVG(CAST(COALESCE(e.net_a_payer, '0') AS DECIMAL(15,3))) AS avg_ca_hist,
        SUM(CASE
          WHEN DATE(e.date) >= DATE_SUB(?, INTERVAL 90 DAY)
          THEN CAST(COALESCE(e.net_a_payer, '0') AS DECIMAL(15,3))
          ELSE 0
        END) AS ca_90d
      FROM entetecommercials e
      WHERE e.deleted_at IS NULL
        AND e.type IN ('facture', 'bl', 'blf')
      GROUP BY e.client_code
    `

    const [clients, historiqueRows] = await Promise.all([
      queryAsync(sqlClients, commercialFilter.params),
      queryAsync(sqlHistorique, [startDate])
    ])

    if (!clients || clients.length === 0) {
      return res.json({
        summary: {
          start_date: startDate,
          end_date: workingDays[workingDays.length - 1].date,
          period_days: periodDays,
          working_days_count: workingDays.length,
          total_unique_clients: 0,
          total_visits: 0,
          total_blocks: 0,
          total_predicted_ca: 0
        },
        blocks: []
      })
    }

    const historiqueByClient = new Map()
    ;(historiqueRows || []).forEach(row => {
      setClientMapValue(historiqueByClient, row.client_code, row)
    })

    const aiPredictionByDate = new Map()
    for (const workingDay of workingDays) {
      try {
        const aiResponse = await axios.post('http://127.0.0.1:5001/api/predict', {
          date: workingDay.date,
          commercials: activeCommercials.map(item => item.value)
        })
        if (aiResponse.data?.status === 'success' && aiResponse.data?.predictions) {
          aiPredictionByDate.set(workingDay.date, aiResponse.data.predictions)
        } else {
          aiPredictionByDate.set(workingDay.date, {})
        }
      } catch (error) {
        console.error(`Prediction IA indisponible pour ${workingDay.date}:`, error.message)
        aiPredictionByDate.set(workingDay.date, {})
      }
    }

    const depotOrigin = getSharedDepotOrigin(null, activeCommercials.length === 1 ? activeCommercials[0].value : null)
    const { distanceMap, maxDistance } = buildDistanceMap(clients)

    const clientProfiles = clients.map(client => {
      const hist = getClientMapValue(historiqueByClient, client.nbr_client) || {}
      const visitsHist = Number(hist.visits_hist || 0)
      const avgCaHist = Number(hist.avg_ca_hist || 0)
      const ca90d = Number(hist.ca_90d || 0)
      const daysSinceLastVisit = diffDays(hist.last_visit_date, startDate) ?? periodDays
      const fallbackBaseCa = Math.max(25, avgCaHist, ca90d > 0 ? ca90d / 6 : 0)
      let bestAiSignal = null
      const slotPredictions = {}

      workingDays.forEach(day => {
        const predictions = aiPredictionByDate.get(day.date) || {}
        const aiData = predictions[String(client.nbr_client).padStart(5, '0')]
          || predictions[String(client.nbr_client)]
          || predictions[getCanonicalClientKey(client.nbr_client)]

        if (!aiData) return

        const commercialScores = aiData.commercial_scores && typeof aiData.commercial_scores === 'object'
          ? aiData.commercial_scores
          : {}

        activeCommercials.forEach(commercial => {
          const commercialCode = String(commercial.value || '').trim()
          const slotId = `${day.date}::${commercialCode}`
          const fallbackAssignmentProb = commercialCode === String(client.user_code || '').trim() ? 75 : 35
          const assignmentProb = clamp(Number(commercialScores[commercialCode] ?? fallbackAssignmentProb), 0, 100)
          const mlWeight = 0.7 + ((assignmentProb / 100) * 0.3)
          const weightedPredictedCa = roundScore(Math.max(1, Number(aiData.chiffre || 0) * mlWeight))
          const weightedQte = Math.max(1, Math.round(Math.max(1, Number(aiData.qte || 1)) * mlWeight))

          slotPredictions[slotId] = {
            slot_id: slotId,
            date: day.date,
            day_label: day.label,
            commercial: commercialCode,
            commercial_label: commercial.label,
            assignment_prob: assignmentProb,
            weighted_predicted_ca: weightedPredictedCa,
            weighted_qte: weightedQte,
            predicted_ca: Number(aiData.chiffre || 0),
            qte: Number(aiData.qte || 0),
            probability: Number(aiData.prob_achat || 0),
            habit_score: Number(aiData.habit_score || 0),
            recency_score: Number(aiData.recency_score || 0),
            details: aiData.details || {}
          }

          if (!bestAiSignal || weightedPredictedCa > Number(bestAiSignal.weighted_predicted_ca || 0)) {
            bestAiSignal = {
              ...aiData,
              date: day.date,
              day_label: day.label,
              commercial: commercialCode,
              commercial_label: commercial.label,
              assignment_prob: assignmentProb,
              weighted_predicted_ca: weightedPredictedCa,
              weighted_qte: weightedQte,
              slot_id: slotId
            }
          }
        })
      })

      const predictedCa = Math.max(1, Number(bestAiSignal?.weighted_predicted_ca || bestAiSignal?.chiffre || 0), fallbackBaseCa)
      const probability = Number(bestAiSignal?.prob_achat || deriveFallbackProbability(visitsHist, daysSinceLastVisit, periodDays))
      const habitScore = Number(bestAiSignal?.habit_score || deriveFallbackHabitScore(visitsHist))
      const recencyScore = Number(bestAiSignal?.recency_score || deriveFallbackRecencyScore(daysSinceLastVisit, periodDays))
      const qteReco = Math.max(1, Number(bestAiSignal?.weighted_qte || bestAiSignal?.qte || Math.round(predictedCa / 80)))
      const details = bestAiSignal?.details && typeof bestAiSignal.details === 'object'
        ? Object.entries(bestAiSignal.details)
            .map(([nom, quantite]) => ({ nom, quantite }))
            .sort((a, b) => (Number(b.quantite || 0) - Number(a.quantite || 0)))
        : []
      const distanceKm = distanceMap.get(String(client.nbr_client)) || 0

      return {
        nbr_client: client.nbr_client,
        canonical_client_key: getCanonicalClientKey(client.nbr_client),
        nom: client.nom,
        adresse: client.adresse || 'Adresse non specifiee',
        latitude: client.latitude,
        longitude: client.longitude,
        region: client.region === 'GT' ? 'Grand Tunis' : (client.region || 'Non Definie'),
        user_code: client.user_code,
        routing_code: client.routing_code,
        delegation: client.delegation,
        commercia_zone: `Comm ${client.user_code || '-'} - ${client.delegation || 'Zone inconnue'}`,
        potentiel: Number(client.potentiel || 0),
        visits_hist: visitsHist,
        avg_ca_hist: avgCaHist,
        ca_90d: ca90d,
        days_since_last_visit: daysSinceLastVisit,
        recommended_slot_id: bestAiSignal?.slot_id || null,
        recommended_commercial: bestAiSignal?.commercial || client.user_code || activeCommercials[0].value,
        recommended_commercial_label: bestAiSignal?.commercial_label || `Commercial ${bestAiSignal?.commercial || client.user_code || activeCommercials[0].value}`,
        commercial_affinity_score: Number(bestAiSignal?.assignment_prob || 0),
        slot_predictions: slotPredictions,
        probability,
        habit_score: habitScore,
        recency_score: recencyScore,
        qte_reco: qteReco,
        predicted_ca: predictedCa,
        produits: details,
        raw_details_map: bestAiSignal?.details || {},
        distance_km: roundScore(distanceKm)
      }
    })

    const maxPredictedCa = clientProfiles.reduce((max, profile) => Math.max(max, Number(profile.predicted_ca || 0)), 0)

    const visitEntries = []
    clientProfiles.forEach(profile => {
      const quota = computeVisitQuota(profile, periodDays)
      for (let repetitionIndex = 0; repetitionIndex < quota; repetitionIndex += 1) {
        const repetitionFactor = repetitionIndex === 0 ? 1 : Math.max(0.58, 1 - (repetitionIndex * 0.18))
        const predictedCa = roundScore(Number(profile.predicted_ca || 0) * repetitionFactor)
        const qteReco = Math.max(1, Math.round(Number(profile.qte_reco || 1) * (repetitionIndex === 0 ? 1 : 0.85)))
        const scoreIa = computeCoveragePriorityScore({
          predictedCa,
          maxPredictedCa,
          probability: profile.probability,
          habitScore: profile.habit_score,
          recencyScore: profile.recency_score,
          distanceKm: profile.distance_km,
          maxDistanceKm: maxDistance,
          daysSinceLastVisit: profile.days_since_last_visit,
          periodDays,
          repetitionIndex
        })

        visitEntries.push({
          ...profile,
          predicted_ca: predictedCa,
          qte_reco: qteReco,
          score_ia: scoreIa,
          repetition_index: repetitionIndex,
          proposed_commercial: profile.recommended_commercial || profile.user_code || activeCommercials[0].value
        })
      }
    })

    let totalPredictedCa = visitEntries.reduce((sum, item) => sum + Number(item.predicted_ca || 0), 0)
    if (minTotalCa > totalPredictedCa) {
      const boosters = [...clientProfiles]
        .sort((a, b) => Number(b.predicted_ca || 0) - Number(a.predicted_ca || 0))
        .slice(0, Math.max(1, activeCommercials.length * 4))

      let boosterIndex = 0
      while (totalPredictedCa < minTotalCa && boosters.length > 0 && boosterIndex < 200) {
        const profile = boosters[boosterIndex % boosters.length]
        const repetitionIndex = 3 + Math.floor(boosterIndex / boosters.length)
        const repetitionFactor = Math.max(0.45, 0.75 - ((repetitionIndex - 2) * 0.07))
        const predictedCa = roundScore(Number(profile.predicted_ca || 0) * repetitionFactor)
        const qteReco = Math.max(1, Math.round(Number(profile.qte_reco || 1) * repetitionFactor))
        const scoreIa = computeCoveragePriorityScore({
          predictedCa,
          maxPredictedCa,
          probability: profile.probability,
          habitScore: profile.habit_score,
          recencyScore: profile.recency_score,
          distanceKm: profile.distance_km,
          maxDistanceKm: maxDistance,
          daysSinceLastVisit: profile.days_since_last_visit,
          periodDays,
          repetitionIndex
        })

        visitEntries.push({
          ...profile,
          predicted_ca: predictedCa,
          qte_reco: qteReco,
          score_ia: scoreIa,
          repetition_index: repetitionIndex,
          proposed_commercial: profile.recommended_commercial || profile.user_code || activeCommercials[0].value
        })
        totalPredictedCa += predictedCa
        boosterIndex += 1
      }
    }

    visitEntries.sort((a, b) => {
      if (b.score_ia !== a.score_ia) return b.score_ia - a.score_ia
      return Number(b.predicted_ca || 0) - Number(a.predicted_ca || 0)
    })

    const slots = createBlockSlots(workingDays, activeCommercials, visitEntries.length, minVisits)
    const cursorRef = { current: 0 }

    visitEntries.forEach(entry => {
      const slot = pickBestSlotForVisit(slots, entry, cursorRef)
      if (!slot) return
      const slotSignal = entry.slot_predictions?.[slot.id] || null
      const assignedPredictedCa = roundScore(Number(slotSignal?.weighted_predicted_ca || entry.predicted_ca || 0))
      const assignedQteReco = Math.max(1, Math.round(Number(slotSignal?.weighted_qte || entry.qte_reco || 1)))
      const assignedProducts = slotSignal?.details && typeof slotSignal.details === 'object'
        ? Object.entries(slotSignal.details)
            .map(([nom, quantite]) => ({ nom, quantite }))
            .sort((a, b) => Number(b.quantite || 0) - Number(a.quantite || 0))
        : entry.produits
      const assignedScoreIa = slotSignal
        ? computeCoveragePriorityScore({
            predictedCa: assignedPredictedCa,
            maxPredictedCa,
            probability: slotSignal.probability ?? entry.probability,
            habitScore: slotSignal.habit_score ?? entry.habit_score,
            recencyScore: slotSignal.recency_score ?? entry.recency_score,
            distanceKm: entry.distance_km,
            maxDistanceKm: maxDistance,
            daysSinceLastVisit: entry.days_since_last_visit,
            periodDays,
            repetitionIndex: entry.repetition_index
          })
        : entry.score_ia

      const clientRow = {
        nbr_client: entry.nbr_client,
        canonical_client_key: entry.canonical_client_key,
        chiffre_brut: assignedPredictedCa,
        chiffre: `${Number(assignedPredictedCa || 0).toFixed(1)} TND`,
        score_ia: assignedScoreIa,
        qte_reco: assignedQteReco,
        vente_reelle: 0,
        details: {
          agro: Math.max(0, Math.round(assignedQteReco * 0.45)),
          chips: Math.max(0, Math.round(assignedQteReco * 0.35)),
          bur: Math.max(0, Math.round(assignedQteReco * 0.20))
        },
        produits: assignedProducts,
        prob_achat: Number(slotSignal?.probability ?? entry.probability),
        habit_score: Number(slotSignal?.habit_score ?? entry.habit_score),
        recency_score: Number(slotSignal?.recency_score ?? entry.recency_score),
        commercial_affinity_score: Number(slotSignal?.assignment_prob || entry.commercial_affinity_score || 0),
        distance_km: entry.distance_km,
        date_jour: slot.date,
        commercia_zone: entry.commercia_zone,
        region: entry.region,
        recouvrement: 0,
        nom: entry.nom,
        adresse: entry.adresse,
        latitude: entry.latitude,
        longitude: entry.longitude,
        repetition_index: entry.repetition_index,
        zone_comm: entry.commercia_zone
      }

      slot.tournees.push(clientRow)
      slot.uniqueClients.add(entry.canonical_client_key)
      slot.total_predicted_ca += Number(assignedPredictedCa || 0)
      slot.total_score += Number(assignedScoreIa || 0)
    })

    const blocks = slots
      .filter(slot => slot.tournees.length > 0)
      .map(slot => finalizeCoverageBlock(slot, buildDepotOrigin(SHARED_DEPOT_ORIGIN, null, slot.proposed_commercial, null)))

    const uniqueClientsCovered = new Set()
    blocks.forEach(block => {
      block.detail.tournees.forEach(row => uniqueClientsCovered.add(row.canonical_client_key || getCanonicalClientKey(row.nbr_client)))
    })

    res.json({
      summary: {
        start_date: startDate,
        end_date: formatLocalDate(addLocalDays(parseLocalDate(startDate), periodDays - 1)),
        period_days: periodDays,
        working_days_count: workingDays.length,
        total_unique_clients: uniqueClientsCovered.size,
        total_visits: blocks.reduce((sum, block) => sum + block.clients_count, 0),
        total_blocks: blocks.length,
        total_predicted_ca: roundScore(blocks.reduce((sum, block) => sum + Number(block.predicted_ca || 0), 0)),
        min_visits: minVisits,
        min_total_ca: minTotalCa,
        excluded_days: ['Dimanche'],
        selected_commerciaux: activeCommercials
      },
      blocks
    })
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
})

app.get('/api/tournees/plan', async (req, res) => {
  const date_precise = req.query.date_precise || new Date().toISOString().split('T')[0]
  const date_debut = req.query.date_debut
  const date_fin = req.query.date_fin
  const commercial = req.query.commercial
  const route = req.query.route
  const modeTournee = req.query.mode_tournee === 'recouvrement' ? 'recouvrement' : 'vente'
  const parsedTopClients = parseInt(req.query.top_clients, 10)
  const topClients = Number.isFinite(parsedTopClients) && parsedTopClients > 0
    ? Math.max(1, parsedTopClients)
    : null
  const targetChiffre = Math.max(0, parseFloat(req.query.target_chiffre || '0') || 0)

  const useRange = Boolean(date_debut && date_fin)
  const dateReference = useRange ? date_fin : date_precise
  const datePrediction = useRange ? date_debut : date_precise

  const requestDate = new Date(dateReference)
  requestDate.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const isPast = requestDate < today
  const depotOrigin = await resolveDepotOrigin(route, commercial)

  let sqlClients = `
    SELECT
      c.code AS nbr_client,
      CAST(COALESCE(c.plafond_credit, '0') AS DECIMAL(15,3)) AS plafond,
      CAST(COALESCE(c.encours_actuelement, '0') AS DECIMAL(15,3)) AS encours_credit,
      CAST(COALESCE(c.delai_paiement, '0') AS DECIMAL(15,3)) AS delai_paiement,
      c.potentiel,
      ? AS date_jour, CONCAT('Comm ', COALESCE(c.user_code, '-'), ' - ', COALESCE(c.delegation, 'Zone inconnue')) AS commercia_zone,
      COALESCE(c.region, 'Non Definie') AS region,
      (CASE WHEN CAST(COALESCE(c.encours_actuelement, '0') AS DECIMAL) > 0 THEN 1 ELSE 0 END) AS recouvrement_reel,
      c.nom, c.adresse_facturation AS adresse,
      c.latitude AS latitude, c.longitude AS longitude
    FROM clients c
    WHERE c.deleted_at IS NULL AND c.isactif = '1'
  `
  const params = [dateReference]
  if (route) { sqlClients += ' AND c.routing_code = ?'; params.push(route) }
  if (commercial) { sqlClients += ' AND c.user_code = ?'; params.push(commercial) }

  db.query(sqlClients, params, async (err, clients) => {
    if (err) return res.status(500).json({ error: err.message })
    const { distanceMap, maxDistance } = buildDistanceMap(clients)

    let totalChiffre = 0
    let iaAgro = 0
    let iaChips = 0
    let iaBur = 0
    let tourneesFormattees = []

    if (modeTournee === 'recouvrement') {
      const sqlRecouvrement = `
        SELECT
          e.client_code,
          DATE(e.date) AS credit_date,
          CAST(COALESCE(e.solde, '0') AS DECIMAL(15,3)) AS doc_solde,
          CAST(COALESCE(e.net_a_payer, '0') AS DECIMAL(15,3)) AS doc_credit_amount
        FROM entetecommercials e
        WHERE e.deleted_at IS NULL
          AND e.type IN ('facture', 'bl', 'blf')
          AND (
            LOWER(TRIM(COALESCE(e.mode_paiement, ''))) = 'credit'
            OR TRIM(COALESCE(e.mode_paiement, '')) = ''
          )
          AND CAST(COALESCE(e.solde, '0') AS DECIMAL(15,3)) > 0
          AND DATE(e.date) <= ?
      `

      const sqlDerniersAchats = `
        SELECT
          e.client_code,
          MAX(DATE(e.date)) AS last_sale_date
        FROM entetecommercials e
        WHERE e.deleted_at IS NULL
          AND e.type IN ('facture', 'bl', 'blf')
          AND DATE(e.date) <= ?
        GROUP BY e.client_code
      `

      const sqlDerniersPaiements = `
        SELECT
          p.client_code,
          MAX(DATE(p.date)) AS last_payment_date,
          COUNT(*) AS nb_payments_hist,
          COUNT(DISTINCT COALESCE(NULLIF(p.code_bl, ''), NULLIF(p.bl_code, ''), CONCAT('NOREF-', p.id))) AS nb_payment_refs,
          AVG(CASE WHEN CAST(COALESCE(p.montant, '0') AS DECIMAL(15,3)) > 0 THEN CAST(COALESCE(p.montant, '0') AS DECIMAL(15,3)) END) AS avg_payment_amount,
          MAX(CAST(COALESCE(p.montant, '0') AS DECIMAL(15,3))) AS max_payment_amount,
          SUM(CAST(COALESCE(p.montant, '0') AS DECIMAL(15,3))) AS total_paid_hist,
          SUM(
            CASE
              WHEN DATE(p.date) >= DATE_SUB(?, INTERVAL 30 DAY)
              THEN CAST(COALESCE(p.montant, '0') AS DECIMAL(15,3))
              ELSE 0
            END
          ) AS total_paid_30d,
          SUM(
            CASE
              WHEN DATE(p.date) >= DATE_SUB(?, INTERVAL 90 DAY)
              THEN 1
              ELSE 0
            END
          ) AS nb_payments_90d
        FROM paiements p
        WHERE p.deleted_at IS NULL
          AND p.date IS NOT NULL
          AND CAST(COALESCE(p.montant, '0') AS DECIMAL(15,3)) > 0
          AND DATE(p.date) <= ?
        GROUP BY p.client_code
      `

      try {
        const [soldesRows, derniersAchatsRows] = await Promise.all([
          queryAsync(sqlRecouvrement, [dateReference]),
          queryAsync(sqlDerniersAchats, [dateReference])
        ])

        let derniersPaiementsRows = []
        try {
          derniersPaiementsRows = await queryAsync(sqlDerniersPaiements, [dateReference, dateReference, dateReference])
        } catch (paiementsError) {
          console.error('Impossible de lire les paiements pour le recouvrement:', paiementsError.message)
        }

        const soldesByClient = new Map()
        ;(soldesRows || []).forEach(row => {
          const existing = getClientMapValue(soldesByClient, row.client_code) || { docs: [] }
          existing.docs.push({
            credit_date: row.credit_date,
            doc_solde: Number(row.doc_solde || 0),
            doc_credit_amount: Number(row.doc_credit_amount || 0)
          })
          setClientMapValue(soldesByClient, row.client_code, existing)
        })

        const derniersAchatsByClient = new Map()
        ;(derniersAchatsRows || []).forEach(row => {
          setClientMapValue(derniersAchatsByClient, row.client_code, {
            last_sale_date: row.last_sale_date
          })
        })

        const derniersPaiementsByClient = new Map()
        ;(derniersPaiementsRows || []).forEach(row => {
          setClientMapValue(derniersPaiementsByClient, row.client_code, {
            last_payment_date: row.last_payment_date,
            total_paid_30d: Number(row.total_paid_30d || 0),
            total_paid_hist: Number(row.total_paid_hist || 0),
            avg_payment_amount: Number(row.avg_payment_amount || 0),
            max_payment_amount: Number(row.max_payment_amount || 0),
            nb_payments_hist: Number(row.nb_payments_hist || 0),
            nb_payment_refs: Number(row.nb_payment_refs || 0),
            nb_payments_90d: Number(row.nb_payments_90d || 0)
          })
        })

        const RECOVERY_MIN_DEBT_DAYS = 2
        const RECOVERY_MIN_SALE_GAP_DAYS = 2
        const RECOVERY_MIN_PAYMENT_GAP_DAYS = 3

        const buildRecoveryClients = ({ strictMode }) => clients
          .map(c => {
            const soldeInfo = getClientMapValue(soldesByClient, c.nbr_client)

            if (!soldeInfo || !Array.isArray(soldeInfo.docs) || soldeInfo.docs.length === 0) return null

            const achatInfo = getClientMapValue(derniersAchatsByClient, c.nbr_client)
            const paiementInfo = getClientMapValue(derniersPaiementsByClient, c.nbr_client)

            const delaiPaiementJours = Math.max(0, Math.round(Number(c.delai_paiement || 0)))
            const graceDays = Math.max(2, delaiPaiementJours)

            let totalSolde = 0
            let totalCreditHist = 0
            let maxCreditAmount = 0
            let oldestCreditDate = null
            let lastCreditDate = null
            let overdue0to30 = 0
            let overdue31to60 = 0
            let overdue61to90 = 0
            let overdue90plus = 0
            let maxDocPastDue = 0

            soldeInfo.docs.forEach(doc => {
              const soldeDoc = Number(doc.doc_solde || 0)
              const creditAmount = Number(doc.doc_credit_amount || 0)
              totalSolde += soldeDoc
              totalCreditHist += creditAmount
              if (creditAmount > maxCreditAmount) maxCreditAmount = creditAmount

              if (!oldestCreditDate || String(doc.credit_date) < String(oldestCreditDate)) {
                oldestCreditDate = doc.credit_date
              }
              if (!lastCreditDate || String(doc.credit_date) > String(lastCreditDate)) {
                lastCreditDate = doc.credit_date
              }

              const rawDays = diffDays(doc.credit_date, dateReference)
              const daysPastDoc = Math.max(0, (rawDays ?? 0) - graceDays)
              if (daysPastDoc > maxDocPastDue) maxDocPastDue = daysPastDoc

              if (daysPastDoc > 90) overdue90plus += soldeDoc
              else if (daysPastDoc > 60) overdue61to90 += soldeDoc
              else if (daysPastDoc > 30) overdue31to60 += soldeDoc
              else if (daysPastDoc > 0) overdue0to30 += soldeDoc
            })

            if (totalSolde <= 0) return null

            const daysSinceOldestDebt = diffDays(oldestCreditDate, dateReference)
            const daysSinceLastSale = diffDays(achatInfo?.last_sale_date, dateReference)
            const daysSinceLastPayment = diffDays(paiementInfo?.last_payment_date, dateReference)
            const daysPastDue = maxDocPastDue

            if (strictMode) {
              if (daysSinceOldestDebt != null && daysSinceOldestDebt < RECOVERY_MIN_DEBT_DAYS) {
                return null
              }

              if (daysSinceOldestDebt != null && daysSinceOldestDebt < graceDays) {
                return null
              }

              if (daysSinceLastSale != null && daysSinceLastSale < Math.max(RECOVERY_MIN_SALE_GAP_DAYS, Math.min(graceDays, 7))) {
                return null
              }

              if (daysSinceLastPayment != null && daysSinceLastPayment < RECOVERY_MIN_PAYMENT_GAP_DAYS) {
                return null
              }
            }

            const plafondCredit = Number(c.plafond || 0)
            const distanceKm = distanceMap.get(String(c.nbr_client)) || 0
            const overdueBalance = overdue0to30 + overdue31to60 + overdue61to90 + overdue90plus
            const severeOverdueBalance = overdue61to90 + overdue90plus
            const dueBalance = strictMode
              ? overdueBalance
              : (overdueBalance > 0 ? overdueBalance : totalSolde)

            if (dueBalance <= 0) {
              return null
            }

            const daysToDue = daysSinceOldestDebt == null ? 0 : Math.max(0, graceDays - daysSinceOldestDebt)
            const isDueToday = daysToDue <= 0
            const urgentExposure = dueBalance >= Math.max(150, plafondCredit * 0.35)
            const canVisitToday = isDueToday || severeOverdueBalance > 0 || urgentExposure

            if (!strictMode && !canVisitToday) {
              return null
            }

            if (!strictMode && daysSinceLastPayment != null && daysSinceLastPayment < 1) {
              return null
            }

            if (!strictMode && daysSinceLastSale != null && daysSinceLastSale < 1) {
              return null
            }

            const avgPaymentAmount = Number(paiementInfo?.avg_payment_amount || 0)
            const maxPaymentAmount = Number(paiementInfo?.max_payment_amount || 0)
            const totalPaid30d = Number(paiementInfo?.total_paid_30d || 0)
            const totalPaidHist = Number(paiementInfo?.total_paid_hist || 0)
            const nbPaymentsHist = Number(paiementInfo?.nb_payments_hist || 0)
            const nbDocsCredit = Number(soldeInfo.docs.length || 0)
            const paymentBehaviorScore = clamp(
              (avgPaymentAmount > 0 ? 0.35 : 0) +
              (maxPaymentAmount >= Math.max(dueBalance * 0.35, 50) ? 0.25 : 0) +
              (totalPaid30d > 0 ? 0.20 : 0) +
              (nbPaymentsHist > 0 ? 0.20 : 0),
              0,
              1
            )

            const baseLikelyRecovery = estimateLikelyRecoveryAmount({
              encoursCredit: dueBalance,
              avgPaymentAmount,
              maxPaymentAmount,
              totalPaid30d,
              nbPaymentsHist,
              nbDocsCredit
            })
            const urgencyFactor = isDueToday ? 1 : (daysToDue <= 2 ? 0.85 : 0.65)
            const relationFactor = clamp(0.75 + (paymentBehaviorScore * 0.4), 0.7, 1.15)
            let collectePrevue = roundScore(clamp(baseLikelyRecovery * urgencyFactor * relationFactor, 0, dueBalance))

            if (collectePrevue <= 0) {
              collectePrevue = roundScore(clamp(dueBalance * (isDueToday ? 0.3 : 0.2), 0, dueBalance))
            }

            return {
              ...c,
              canonical_client_key: getCanonicalClientKey(c.nbr_client),
              encours_credit: dueBalance,
              encours_total: totalSolde,
              nb_docs_credit: nbDocsCredit,
              plafond: plafondCredit,
              delai_paiement: delaiPaiementJours,
              distance_km: roundScore(distanceKm),
              total_credit_hist: totalCreditHist,
              avg_credit_amount: soldeInfo.docs.length > 0 ? totalCreditHist / soldeInfo.docs.length : 0,
              max_credit_amount: maxCreditAmount,
              oldest_credit_date: oldestCreditDate,
              last_credit_date: lastCreditDate,
              last_sale_date: achatInfo?.last_sale_date || null,
              last_payment_date: paiementInfo?.last_payment_date || null,
              total_paid_30d: totalPaid30d,
              total_paid_hist: totalPaidHist,
              avg_payment_amount: avgPaymentAmount,
              max_payment_amount: maxPaymentAmount,
              nb_payments_hist: nbPaymentsHist,
              nb_payment_refs: Number(paiementInfo?.nb_payment_refs || 0),
              nb_payments_90d: Number(paiementInfo?.nb_payments_90d || 0),
              days_since_oldest_debt: daysSinceOldestDebt ?? 0,
              days_past_due: daysPastDue,
              due_balance: dueBalance,
              severe_overdue_balance: severeOverdueBalance,
              overdue_weighted_ratio: totalSolde > 0
                ? clamp(((overdue0to30 * 0.25) + (overdue31to60 * 0.55) + (overdue61to90 * 0.8) + (overdue90plus * 1.0)) / totalSolde, 0, 1)
                : 0,
              severe_overdue_ratio: totalSolde > 0
                ? clamp((overdue61to90 + overdue90plus) / totalSolde, 0, 1)
                : 0,
              days_since_last_sale: daysSinceLastSale ?? 999,
              days_since_last_payment: daysSinceLastPayment ?? 999,
              payment_behavior_score: paymentBehaviorScore,
              likely_recovery_amount: baseLikelyRecovery,
              collecte_prevue: collectePrevue,
              is_due_today: isDueToday ? 1 : 0,
              days_to_due: daysToDue
            }
          })
          .filter(Boolean)

        let recoveryFilterMode = 'strict'
        let clientsCredit = buildRecoveryClients({ strictMode: true })
        if (clientsCredit.length === 0) {
          clientsCredit = buildRecoveryClients({ strictMode: false })
          recoveryFilterMode = 'relaxed'
        }

        const maxDueBalance = clientsCredit.reduce((max, c) => Math.max(max, c.due_balance || 0), 0)
        const maxLikelyRecovery = clientsCredit.reduce((max, c) => Math.max(max, c.likely_recovery_amount || 0), 0)
        const maxSevereOverdue = clientsCredit.reduce((max, c) => Math.max(max, c.severe_overdue_balance || 0), 0)

        tourneesFormattees = clientsCredit.map(c => ({
          nbr_client: c.nbr_client,
          chiffre_brut: c.collecte_prevue,
          chiffre: `${c.collecte_prevue.toFixed(1)} TND`,
          vente_reelle: 0,
          score_ia: computeSmartRecoveryScore({
            dueBalance: c.due_balance,
            maxDueBalance,
            likelyRecoveryAmount: c.likely_recovery_amount,
            maxLikelyRecovery,
            severeOverdueBalance: c.severe_overdue_balance,
            maxSevereOverdue,
            paymentBehaviorScore: c.payment_behavior_score,
            distanceKm: c.distance_km,
            maxDistanceKm: maxDistance
          }),
          qte_reco: roundScore(c.collecte_prevue),
          details: { agro: 0, chips: 0, bur: 0 },
          produits: [],
          prob_achat: 0,
          habit_score: 0,
          recency_score: 0,
          distance_km: c.distance_km,
          date_jour: c.date_jour,
          commercia_zone: c.commercia_zone,
          region: c.region === 'GT' ? 'Grand Tunis' : c.region,
          recouvrement: 1,
          nom: c.nom,
          adresse: c.adresse || 'Adresse non specifiee',
          latitude: c.latitude,
          longitude: c.longitude,
          canonical_client_key: c.canonical_client_key,
          encours_credit: roundScore(c.due_balance),
          encours_total: roundScore(c.encours_total),
          collecte_prevue: roundScore(c.collecte_prevue),
          likely_recovery_amount: roundScore(c.likely_recovery_amount),
          plafond_credit: roundScore(c.plafond),
          nb_docs_credit: c.nb_docs_credit,
          last_sale_date: c.last_sale_date,
          last_payment_date: c.last_payment_date,
          oldest_credit_date: c.oldest_credit_date,
          total_paid_30d: roundScore(c.total_paid_30d),
          avg_payment_amount: roundScore(c.avg_payment_amount),
          max_payment_amount: roundScore(c.max_payment_amount),
          total_paid_hist: roundScore(c.total_paid_hist),
          nb_payments_hist: c.nb_payments_hist,
          nb_payment_refs: c.nb_payment_refs,
          is_due_today: c.is_due_today,
          days_to_due: c.days_to_due
        }))
        .sort((a, b) => b.score_ia - a.score_ia)

        const dedupedTournees = []
        const seenClients = new Set()
        tourneesFormattees.forEach(row => {
          const key = row.canonical_client_key || getCanonicalClientKey(row.nbr_client)
          if (!key || seenClients.has(key)) return
          seenClients.add(key)
          dedupedTournees.push(row)
        })

        tourneesFormattees = dedupedTournees

        tourneesFormattees = applyClientObjective(tourneesFormattees, topClients, targetChiffre)
        return envoyerReponse(res, tourneesFormattees, dateReference, 0, 0, 0, depotOrigin, {
          mode: modeTournee,
          recovery_filter_mode: recoveryFilterMode
        })
      } catch (errRecouvrement) {
        return res.status(500).json({ error: errRecouvrement.message })
      }
    }

    if (isPast) {
      let aiPredictions = {}
      try {
        const aiResponse = await axios.post('http://127.0.0.1:5001/api/predict', { date: datePrediction })
        if (aiResponse.data.status === 'success') {
          aiPredictions = aiResponse.data.predictions
        }
      } catch (error) {
        console.error('Serveur Python injoignable, backtesting sans IA')
      }

      const sqlReel = `
        SELECT
          e.client_code,
          e.code AS doc_code,
          e.net_a_payer,
          COALESCE(p.sousfamille_code, 'Divers') AS produit_nom,
          p.famille_code AS famille_code,
          SUM(l.quantite) AS qte_ligne
        FROM entetecommercials e
        LEFT JOIN lignecommercials l ON e.code = l.entetecommercial_code
        LEFT JOIN produits p ON l.produit_code = p.code
        WHERE DATE(e.date) ${useRange ? 'BETWEEN ? AND ?' : '= ?'} AND e.type IN ('facture', 'bl', 'blf')
        GROUP BY e.client_code, e.code, e.net_a_payer, p.sousfamille_code, p.famille_code
      `

      db.query(sqlReel, useRange ? [date_debut, date_fin] : [date_precise], (errVentes, ventes) => {
        if (errVentes) return res.status(500).json({ error: errVentes.message })

        const ventesMap = {}
        iaAgro = 0
        iaChips = 0
        iaBur = 0

        ventes.forEach(v => {
          if (!ventesMap[v.client_code]) {
            ventesMap[v.client_code] = {
              chiffre: 0,
              qte: 0,
              docs: new Set(),
              details: { agro: 0, chips: 0, bur: 0 },
              produitsMap: {}
            }
          }

          const cMap = ventesMap[v.client_code]
          if (!cMap.docs.has(v.doc_code)) {
            cMap.chiffre += v.net_a_payer
            cMap.docs.add(v.doc_code)
          }

          const qteLigne = v.qte_ligne || 0
          cMap.qte += qteLigne

          if (v.produit_nom) {
            if (!cMap.produitsMap[v.produit_nom]) {
              cMap.produitsMap[v.produit_nom] = 0
            }
            cMap.produitsMap[v.produit_nom] += qteLigne
          }

          const famille = (v.famille_code || '').toUpperCase()
          if (famille.includes('CHIPS') || famille.includes('SNACK') || famille.includes('CHAMALLOWS') || famille.includes('BISCUIT')) {
            cMap.details.chips += qteLigne
            iaChips += qteLigne
          } else if (famille.includes('BUR') || famille.includes('PAPIER')) {
            cMap.details.bur += qteLigne
            iaBur += qteLigne
          } else {
            cMap.details.agro += qteLigne
            iaAgro += qteLigne
          }
        })

        const maxPredPast = clients.reduce((max, c) => {
          const clientCodeStr = c.nbr_client.toString().padStart(5, '0')
          const iaData = aiPredictions[clientCodeStr]
          const scoreValue = iaData ? iaData.chiffre : (ventesMap[c.nbr_client] ? ventesMap[c.nbr_client].chiffre : 0)
          return Math.max(max, scoreValue || 0)
        }, 0)

        tourneesFormattees = clients.map(c => {
          const dataReelle = ventesMap[c.nbr_client]
          if (!dataReelle) return null

          const chiffreReel = dataReelle.chiffre
          const qte = dataReelle.qte
          const details = dataReelle.details

          const produitsReels = Object.entries(dataReelle.produitsMap || {})
            .map(([nom, quantite]) => ({ nom, quantite }))
            .sort((a, b) => b.quantite - a.quantite)

          const clientCodeStr = c.nbr_client.toString().padStart(5, '0')
          const iaData = aiPredictions[clientCodeStr]
          const chiffrePred = iaData ? iaData.chiffre : chiffreReel
          const probAchat = iaData ? (iaData.prob_achat || 0) : 0
          const habitScore = iaData ? (iaData.habit_score || 0) : 0
          const recencyScore = iaData ? (iaData.recency_score || 0) : 0
          const distanceKm = distanceMap.get(String(c.nbr_client)) || 0
          const finalScore = computePriorityScore(chiffrePred, maxPredPast, probAchat, habitScore, recencyScore, distanceKm, maxDistance)

          let produitsAAfficher = produitsReels
          if (iaData && iaData.details && typeof iaData.details === 'object') {
            produitsAAfficher = Object.entries(iaData.details)
              .map(([nom, quantite]) => ({ nom, quantite }))
              .sort((a, b) => b.quantite - a.quantite)
          }

          totalChiffre += chiffreReel

          return {
            nbr_client: c.nbr_client,
            chiffre: `${chiffrePred.toFixed(1)} TND`,
            chiffre_brut: chiffrePred,
            vente_reelle: chiffreReel,
            score_ia: finalScore,
            qte_reco: iaData ? iaData.qte : qte,
            details,
            produits: produitsAAfficher,
            prob_achat: probAchat,
            habit_score: habitScore,
            recency_score: recencyScore,
            distance_km: roundScore(distanceKm),
            date_jour: c.date_jour,
            commercia_zone: c.commercia_zone,
            region: c.region === 'GT' ? 'Grand Tunis' : c.region,
            recouvrement: c.recouvrement_reel,
            nom: `${c.nom} (Reel)`,
            adresse: c.adresse || 'Adresse non specifiee',
            latitude: c.latitude,
            longitude: c.longitude
          }
        }).filter(Boolean).sort((a, b) => b.score_ia - a.score_ia)

        tourneesFormattees = applyClientObjective(tourneesFormattees, topClients, targetChiffre)

        envoyerReponse(res, tourneesFormattees, dateReference, iaAgro, iaChips, iaBur, depotOrigin, { mode: modeTournee })
      })
    } else {
      let aiPredictions = {}
      try {
        const aiResponse = await axios.post('http://127.0.0.1:5001/api/predict', { date: datePrediction })
        if (aiResponse.data.status === 'success') {
          aiPredictions = aiResponse.data.predictions
        }
      } catch (error) {
        console.error('Serveur Python (api_ia.py) injoignable.')
      }

      const maxPredFuture = clients.reduce((max, c) => {
        const clientCodeStr = c.nbr_client.toString().padStart(5, '0')
        const iaData = aiPredictions[clientCodeStr]
        return Math.max(max, iaData ? (iaData.chiffre || 0) : 0)
      }, 0)

      const tousLesClients = clients.map(c => {
        const clientCodeStr = c.nbr_client.toString().padStart(5, '0')
        const iaData = aiPredictions[clientCodeStr]

        const probAchat = iaData ? (iaData.prob_achat || 0) : 0
        const habitScore = iaData ? (iaData.habit_score || 0) : 0
        const recencyScore = iaData ? (iaData.recency_score || 0) : 0
        const qteRecoIA = iaData ? iaData.qte : 0
        const vnPreditIA = iaData ? iaData.chiffre : 0
        const caIfBuyIA = iaData ? (iaData.ca_if_buy || 0) : 0
        const distanceKm = distanceMap.get(String(c.nbr_client)) || 0
        const scoreIA = iaData ? computePriorityScore(vnPreditIA, maxPredFuture, probAchat, habitScore, recencyScore, distanceKm, maxDistance) : 0
        const isViable = iaData
          ? (probAchat >= 8 || vnPreditIA >= 8 || caIfBuyIA >= 35 || qteRecoIA >= 1)
          : false

        let produits = []
        let clientAgro = 0
        let clientChips = 0
        let clientBur = 0

        if (iaData && iaData.details && typeof iaData.details === 'object') {
          produits = Object.entries(iaData.details)
            .map(([nom, quantite]) => ({ nom, quantite }))
            .sort((a, b) => (b.quantite || 0) - (a.quantite || 0))

          clientAgro = Math.floor(qteRecoIA * 0.45)
          clientChips = Math.floor(qteRecoIA * 0.35)
          clientBur = Math.floor(qteRecoIA * 0.20)
          const sommeDetails = clientAgro + clientChips + clientBur
          if (sommeDetails < qteRecoIA) clientAgro += (qteRecoIA - sommeDetails)
          else if (sommeDetails > qteRecoIA && clientAgro > 0) clientAgro -= (sommeDetails - qteRecoIA)
        } else {
          clientAgro = Math.floor(qteRecoIA * 0.45)
          clientChips = Math.floor(qteRecoIA * 0.35)
          clientBur = Math.floor(qteRecoIA * 0.20)
        }

        return {
          nbr_client: c.nbr_client,
          chiffre_brut: vnPreditIA,
          chiffre: `${vnPreditIA.toFixed(1)} TND`,
          vente_reelle: 0,
          score_ia: scoreIA,
          qte_reco: qteRecoIA,
          details: { agro: clientAgro, chips: clientChips, bur: clientBur },
          produits,
          prob_achat: probAchat,
          ca_if_buy: caIfBuyIA,
          habit_score: habitScore,
          recency_score: recencyScore,
          distance_km: roundScore(distanceKm),
          date_jour: c.date_jour,
          commercia_zone: c.commercia_zone,
          region: c.region === 'GT' ? 'Grand Tunis' : c.region,
          recouvrement: c.recouvrement_reel,
          nom: c.nom,
          adresse: c.adresse || 'Adresse non specifiee',
          latitude: c.latitude,
          longitude: c.longitude,
          is_viable: isViable
        }
      }).filter(t => t.chiffre_brut > 0 && t.is_viable)

      tourneesFormattees = tousLesClients
        .sort((a, b) => b.score_ia - a.score_ia)

      tourneesFormattees = applyClientObjective(tourneesFormattees, topClients, targetChiffre)

      iaAgro = 0
      iaChips = 0
      iaBur = 0
      totalChiffre = 0

      tourneesFormattees.forEach(t => {
        totalChiffre += t.chiffre_brut
        iaAgro += t.details.agro
        iaChips += t.details.chips
        iaBur += t.details.bur
      })

      envoyerReponse(res, tourneesFormattees, dateReference, iaAgro, iaChips, iaBur, depotOrigin, { mode: modeTournee })
    }
  })
})

function envoyerReponse(res, tournees, date_precise, agro, chips, bur, depotOrigin, extra = {}) {
  const produitsTotaux = {}
  tournees.forEach(t => {
    if (t.produits && t.produits.length > 0) {
      t.produits.forEach(p => {
        if (!produitsTotaux[p.nom]) {
          produitsTotaux[p.nom] = 0
        }
        produitsTotaux[p.nom] += p.quantite
      })
    }
  })

  const produitsMappes = Object.entries(produitsTotaux)
    .map(([nom, quantite]) => ({ nom, quantite }))
    .sort((a, b) => b.quantite - a.quantite)

  const chargeTotale = {
    agro,
    chips,
    bureautique: bur,
    detailsProduits: produitsMappes
  }

  let vraiePrecision = 0
  try {
    const precisionLue = fs.readFileSync(path.join(apiDir, 'precision.txt'), 'utf8')
    if (precisionLue && !isNaN(parseFloat(precisionLue))) {
      vraiePrecision = parseFloat(precisionLue)
    }
  } catch (e) {
    vraiePrecision = 0
  }

  const itineraire = tournees.map((r, idx) => `${idx + 1}. ${r.nom} (${r.nbr_client}) - ${r.adresse || 'Adresse non specifiee'}`)
  const itineraire_geo = tournees.map((r, idx) => ({
    step: idx + 1,
    client_code: r.nbr_client,
    nom: r.nom,
    adresse: r.adresse || 'Adresse non specifiee',
    latitude: r.latitude !== undefined && r.latitude !== null ? Number(r.latitude) : null,
    longitude: r.longitude !== undefined && r.longitude !== null ? Number(r.longitude) : null,
    score_ia: r.score_ia,
    qte_reco: r.qte_reco
  }))

  res.json({
    tournees,
    total: tournees.length,
    jourSelectionne: date_precise,
    chargeTotale,
    precision_ia: vraiePrecision,
    itineraire,
    itineraire_geo,
    depot_origin: depotOrigin,
    ...extra
  })
}

const PORT = process.env.PORT || 5000
app.listen(PORT, () => console.log(`Serveur API pret sur http://localhost:${PORT}`))

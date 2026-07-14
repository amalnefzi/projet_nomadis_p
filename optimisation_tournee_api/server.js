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

  Promise.all([
    ensureMovementSupportTables(),
    ensurePredictionLoggingTables(),
    ensurePredictionFeedbackTables()
  ])
    .catch(error => {
      console.error('Initialisation tables support impossible:', error.message)
    })
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

let movementSupportTablesPending = null
let predictionLoggingTablesPending = null
let predictionFeedbackTablesPending = null

function readCurrentIaPrecisionScore() {
  try {
    const precisionLue = fs.readFileSync(path.join(apiDir, 'precision.txt'), 'utf8')
    const parsedValue = parseFloat(precisionLue)
    return Number.isFinite(parsedValue) ? parsedValue : 0
  } catch (error) {
    return 0
  }
}

async function ensureMovementSupportTables() {
  if (movementSupportTablesPending) {
    return movementSupportTablesPending
  }

  movementSupportTablesPending = (async () => {
    await queryAsync(`
      CREATE TABLE IF NOT EXISTS stock_depots (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        produit_code VARCHAR(255) NOT NULL,
        soussociete_code VARCHAR(255) NOT NULL,
        quantite DOUBLE NOT NULL DEFAULT 0,
        retour DOUBLE NOT NULL DEFAULT 0,
        dlc DOUBLE NOT NULL DEFAULT 0,
        casse DOUBLE NOT NULL DEFAULT 0,
        reservation DOUBLE NOT NULL DEFAULT 0,
        securite DOUBLE NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT NULL,
        updated_at TIMESTAMP NULL DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY stock_depots_unique (produit_code, soussociete_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await queryAsync(`
      CREATE TABLE IF NOT EXISTS stock_depot_info (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_code VARCHAR(255) DEFAULT NULL,
        commercial_code VARCHAR(255) DEFAULT NULL,
        soussociete_code VARCHAR(255) DEFAULT NULL,
        code VARCHAR(255) DEFAULT NULL,
        produit_code VARCHAR(255) DEFAULT NULL,
        old_quantite DOUBLE DEFAULT NULL,
        diff_quantite DOUBLE DEFAULT NULL,
        new_quantite DOUBLE DEFAULT NULL,
        module_nomadis VARCHAR(255) DEFAULT NULL,
        type_mouvement VARCHAR(255) DEFAULT NULL,
        cause VARCHAR(255) DEFAULT NULL,
        etat VARCHAR(255) DEFAULT NULL,
        latitude VARCHAR(255) DEFAULT NULL,
        longitude VARCHAR(255) DEFAULT NULL,
        date DATETIME DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT NULL,
        updated_at TIMESTAMP NULL DEFAULT NULL,
        PRIMARY KEY (id),
        KEY stock_depot_info_code_idx (code),
        KEY stock_depot_info_produit_idx (produit_code),
        KEY stock_depot_info_soussociete_idx (soussociete_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await queryAsync(`
      CREATE TABLE IF NOT EXISTS mouvements_deleted (
        archive_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        id BIGINT UNSIGNED NOT NULL,
        magasinier_code VARCHAR(255) DEFAULT NULL,
        depot_code VARCHAR(255) DEFAULT NULL,
        commercial_code VARCHAR(255) DEFAULT NULL,
        caisse_code VARCHAR(191) DEFAULT NULL,
        soussociete_code VARCHAR(255) DEFAULT NULL,
        produit_code VARCHAR(255) DEFAULT NULL,
        prix_achat_ht DOUBLE DEFAULT NULL,
        prix_achat_ttc DOUBLE DEFAULT NULL,
        quantite DOUBLE DEFAULT NULL,
        qte_demande DOUBLE DEFAULT NULL,
        prix_ht DOUBLE DEFAULT NULL,
        prix_ttc DOUBLE DEFAULT NULL,
        p_tva DOUBLE DEFAULT NULL,
        taux_tva DOUBLE DEFAULT NULL,
        remise DOUBLE DEFAULT NULL,
        type VARCHAR(255) DEFAULT NULL,
        num_serie VARCHAR(255) DEFAULT NULL,
        numero VARCHAR(255) DEFAULT NULL,
        configuration VARCHAR(255) DEFAULT NULL,
        etat VARCHAR(255) DEFAULT NULL,
        isSync TINYINT(1) DEFAULT 0,
        wavesoft VARCHAR(50) DEFAULT NULL,
        num_lot VARCHAR(50) DEFAULT NULL,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT NULL,
        updated_at TIMESTAMP NULL DEFAULT NULL,
        date DATETIME DEFAULT NULL,
        date_accept DATETIME DEFAULT NULL,
        from_stock TINYINT(1) DEFAULT NULL,
        PRIMARY KEY (archive_id),
        KEY mouvements_deleted_id_idx (id),
        KEY mouvements_deleted_numero_idx (numero),
        KEY mouvements_deleted_produit_idx (produit_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    console.log('Tables support mouvements verifiees.')
  })().catch(error => {
    movementSupportTablesPending = null
    throw error
  })

  return movementSupportTablesPending
}

async function ensurePredictionLoggingTables() {
  if (predictionLoggingTablesPending) {
    return predictionLoggingTablesPending
  }

  predictionLoggingTablesPending = (async () => {
    await queryAsync(`
      CREATE TABLE IF NOT EXISTS ia_prediction_runs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        run_code VARCHAR(191) NOT NULL,
        source_context VARCHAR(191) NOT NULL,
        source_mode VARCHAR(191) DEFAULT NULL,
        request_date DATE DEFAULT NULL,
        request_payload_json LONGTEXT DEFAULT NULL,
        request_context_json LONGTEXT DEFAULT NULL,
        request_commercials_json LONGTEXT DEFAULT NULL,
        request_route_code VARCHAR(191) DEFAULT NULL,
        request_commercial_code VARCHAR(191) DEFAULT NULL,
        request_top_clients INT DEFAULT NULL,
        request_target_chiffre DOUBLE DEFAULT NULL,
        response_status VARCHAR(64) DEFAULT NULL,
        response_message TEXT DEFAULT NULL,
        response_meta_json LONGTEXT DEFAULT NULL,
        total_candidates INT DEFAULT NULL,
        selected_clients INT DEFAULT NULL,
        expected_buyers_estimate INT DEFAULT NULL,
        selection_limit INT DEFAULT NULL,
        model_version VARCHAR(255) DEFAULT NULL,
        precision_score DOUBLE DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY ia_prediction_runs_code_unique (run_code),
        KEY ia_prediction_runs_context_idx (source_context),
        KEY ia_prediction_runs_request_date_idx (request_date),
        KEY ia_prediction_runs_commercial_idx (request_commercial_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await queryAsync(`
      CREATE TABLE IF NOT EXISTS ia_prediction_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        run_code VARCHAR(191) NOT NULL,
        client_code VARCHAR(191) NOT NULL,
        prediction_rank INT DEFAULT NULL,
        best_commercial_code VARCHAR(191) DEFAULT NULL,
        predicted_score DOUBLE DEFAULT NULL,
        confidence_score DOUBLE DEFAULT NULL,
        vip_score INT DEFAULT NULL,
        predicted_qte DOUBLE DEFAULT NULL,
        predicted_ca DOUBLE DEFAULT NULL,
        predicted_ca_if_buy DOUBLE DEFAULT NULL,
        predicted_qte_if_buy DOUBLE DEFAULT NULL,
        predicted_unit_price DOUBLE DEFAULT NULL,
        prob_achat DOUBLE DEFAULT NULL,
        habit_score DOUBLE DEFAULT NULL,
        recency_score DOUBLE DEFAULT NULL,
        details_json LONGTEXT DEFAULT NULL,
        commercial_scores_json LONGTEXT DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY ia_prediction_items_run_client_unique (run_code, client_code),
        KEY ia_prediction_items_run_code_idx (run_code),
        KEY ia_prediction_items_best_commercial_idx (best_commercial_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    console.log('Tables logging IA verifiees.')
  })().catch(error => {
    predictionLoggingTablesPending = null
    throw error
  })

  return predictionLoggingTablesPending
}

async function ensurePredictionFeedbackTables() {
  if (predictionFeedbackTablesPending) {
    return predictionFeedbackTablesPending
  }

  predictionFeedbackTablesPending = (async () => {
    await queryAsync(`
      CREATE TABLE IF NOT EXISTS ia_prediction_feedback (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        run_code VARCHAR(191) NOT NULL,
        client_code VARCHAR(191) NOT NULL,
        feedback_stage VARCHAR(64) NOT NULL,
        feedback_date DATE DEFAULT NULL,
        request_date DATE DEFAULT NULL,
        source_context VARCHAR(191) DEFAULT NULL,
        source_mode VARCHAR(191) DEFAULT NULL,
        was_predicted TINYINT(1) NOT NULL DEFAULT 1,
        selected_in_final_plan TINYINT(1) NOT NULL DEFAULT 0,
        selection_source VARCHAR(64) DEFAULT NULL,
        predicted_rank INT DEFAULT NULL,
        predicted_score DOUBLE DEFAULT NULL,
        predicted_ca DOUBLE DEFAULT NULL,
        predicted_qte DOUBLE DEFAULT NULL,
        prob_achat DOUBLE DEFAULT NULL,
        best_commercial_code VARCHAR(191) DEFAULT NULL,
        final_rank INT DEFAULT NULL,
        final_commercial_code VARCHAR(191) DEFAULT NULL,
        final_route_code VARCHAR(191) DEFAULT NULL,
        final_depot_code VARCHAR(191) DEFAULT NULL,
        final_tournee_code VARCHAR(191) DEFAULT NULL,
        actual_sale_amount DOUBLE DEFAULT NULL,
        actual_sale_qty DOUBLE DEFAULT NULL,
        actual_purchase_flag TINYINT(1) DEFAULT NULL,
        actual_doc_count INT DEFAULT NULL,
        actual_checked_at DATETIME DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY ia_prediction_feedback_run_client_stage_unique (run_code, client_code, feedback_stage),
        KEY ia_prediction_feedback_run_code_idx (run_code),
        KEY ia_prediction_feedback_feedback_date_idx (feedback_date),
        KEY ia_prediction_feedback_final_commercial_idx (final_commercial_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    console.log('Table feedback IA verifiee.')
  })().catch(error => {
    predictionFeedbackTablesPending = null
    throw error
  })

  return predictionFeedbackTablesPending
}

async function recordPredictionValidationFeedback({
  predictionRunCode,
  feedbackDate,
  commercialCode,
  routeCode,
  depotCode,
  validationCode,
  stops,
  logPrefix = 'PLAN_VALIDATE'
}) {
  const normalizedRunCode = String(predictionRunCode || '').trim()
  if (!normalizedRunCode) {
    return {
      savedRows: 0,
      predictedRows: 0,
      selectedRows: 0,
      unmatchedSelectedRows: 0,
      skipped: true,
      reason: 'missing_prediction_run_code'
    }
  }

  const normalizedStops = normalizeValidatedStops(stops)
  if (!normalizedStops.length) {
    return {
      savedRows: 0,
      predictedRows: 0,
      selectedRows: 0,
      unmatchedSelectedRows: 0,
      skipped: true,
      reason: 'empty_stops'
    }
  }

  await ensurePredictionFeedbackTables()

  const runRows = await queryAsync(
    `SELECT run_code, request_date, source_context, source_mode
     FROM ia_prediction_runs
     WHERE run_code = ?
     LIMIT 1`,
    [normalizedRunCode]
  )

  const runMeta = runRows[0]
  if (!runMeta) {
    return {
      savedRows: 0,
      predictedRows: 0,
      selectedRows: normalizedStops.length,
      unmatchedSelectedRows: normalizedStops.length,
      skipped: true,
      reason: 'prediction_run_not_found'
    }
  }

  const predictedItems = await queryAsync(
    `SELECT
       client_code,
       prediction_rank,
       best_commercial_code,
       predicted_score,
       predicted_ca,
       predicted_qte,
       prob_achat
     FROM ia_prediction_items
     WHERE run_code = ?
     ORDER BY prediction_rank ASC, client_code ASC`,
    [normalizedRunCode]
  )

  const selectedByKey = new Map()
  normalizedStops.forEach((stop, index) => {
    const key = getCanonicalClientKey(stop.client_code)
    if (!key || selectedByKey.has(key)) return
    selectedByKey.set(key, {
      stop,
      finalRank: index + 1
    })
  })

  await queryAsync(
    `DELETE FROM ia_prediction_feedback
     WHERE run_code = ?
       AND feedback_stage = 'tournee_validation'`,
    [normalizedRunCode]
  )

  const predictedKeys = new Set()
  let savedRows = 0

  for (const item of predictedItems) {
    const key = getCanonicalClientKey(item.client_code)
    if (!key) continue

    predictedKeys.add(key)
    const selectedEntry = selectedByKey.get(key) || null

    await queryAsync(
      `INSERT INTO ia_prediction_feedback (
        run_code,
        client_code,
        feedback_stage,
        feedback_date,
        request_date,
        source_context,
        source_mode,
        was_predicted,
        selected_in_final_plan,
        selection_source,
        predicted_rank,
        predicted_score,
        predicted_ca,
        predicted_qte,
        prob_achat,
        best_commercial_code,
        final_rank,
        final_commercial_code,
        final_route_code,
        final_depot_code,
        final_tournee_code
      ) VALUES (?, ?, 'tournee_validation', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedRunCode,
        String(item.client_code || '').trim(),
        feedbackDate || null,
        runMeta.request_date || null,
        runMeta.source_context || null,
        runMeta.source_mode || null,
        selectedEntry ? 1 : 0,
        selectedEntry ? 'validated_selected' : 'validated_not_selected',
        item.prediction_rank != null ? Number(item.prediction_rank) : null,
        item.predicted_score != null ? Number(item.predicted_score) : null,
        item.predicted_ca != null ? Number(item.predicted_ca) : null,
        item.predicted_qte != null ? Number(item.predicted_qte) : null,
        item.prob_achat != null ? Number(item.prob_achat) : null,
        String(item.best_commercial_code || '').trim() || null,
        selectedEntry ? selectedEntry.finalRank : null,
        String(commercialCode || '').trim() || null,
        String(routeCode || '').trim() || null,
        String(depotCode || '').trim() || null,
        String(validationCode || '').trim() || null
      ]
    )

    savedRows += 1
  }

  let unmatchedSelectedRows = 0
  for (const [key, selectedEntry] of selectedByKey.entries()) {
    if (predictedKeys.has(key)) continue

    const fallbackClientCode = String(selectedEntry.stop.client_code || '').trim()
    if (!fallbackClientCode) continue

    await queryAsync(
      `INSERT INTO ia_prediction_feedback (
        run_code,
        client_code,
        feedback_stage,
        feedback_date,
        request_date,
        source_context,
        source_mode,
        was_predicted,
        selected_in_final_plan,
        selection_source,
        final_rank,
        final_commercial_code,
        final_route_code,
        final_depot_code,
        final_tournee_code
      ) VALUES (?, ?, 'tournee_validation', ?, ?, ?, ?, 0, 1, 'validated_manual_only', ?, ?, ?, ?, ?)`,
      [
        normalizedRunCode,
        fallbackClientCode,
        feedbackDate || null,
        runMeta.request_date || null,
        runMeta.source_context || null,
        runMeta.source_mode || null,
        selectedEntry.finalRank,
        String(commercialCode || '').trim() || null,
        String(routeCode || '').trim() || null,
        String(depotCode || '').trim() || null,
        String(validationCode || '').trim() || null
      ]
    )

    savedRows += 1
    unmatchedSelectedRows += 1
  }

  console.log(
    `[${logPrefix}] Feedback prediction enregistre -> run=${normalizedRunCode} rows=${savedRows} predicted=${predictedItems.length} selected=${selectedByKey.size} unmatched=${unmatchedSelectedRows}`
  )

  return {
    savedRows,
    predictedRows: predictedItems.length,
    selectedRows: selectedByKey.size,
    unmatchedSelectedRows,
    skipped: false,
    reason: null
  }
}

async function reconcilePredictionFeedbackActualSales({
  runCode = null,
  feedbackDate = null,
  dateFrom = null,
  dateTo = null,
  onlyPending = true,
  logPrefix = 'PREDICTION_RECONCILE'
}) {
  await ensurePredictionFeedbackTables()

  const whereClauses = [`feedback_stage = 'tournee_validation'`]
  const params = []

  const normalizedRunCode = String(runCode || '').trim()
  if (normalizedRunCode) {
    whereClauses.push('run_code = ?')
    params.push(normalizedRunCode)
  }

  const normalizedFeedbackDate = normalizeDateOnly(feedbackDate)
  const normalizedDateFrom = normalizeDateOnly(dateFrom)
  const normalizedDateTo = normalizeDateOnly(dateTo)

  if (normalizedFeedbackDate) {
    whereClauses.push('feedback_date = ?')
    params.push(normalizedFeedbackDate)
  } else if (normalizedDateFrom && normalizedDateTo) {
    whereClauses.push('feedback_date BETWEEN ? AND ?')
    params.push(normalizedDateFrom, normalizedDateTo)
  } else if (normalizedDateFrom) {
    whereClauses.push('feedback_date >= ?')
    params.push(normalizedDateFrom)
  } else if (normalizedDateTo) {
    whereClauses.push('feedback_date <= ?')
    params.push(normalizedDateTo)
  }

  if (onlyPending) {
    whereClauses.push('(actual_checked_at IS NULL OR actual_purchase_flag IS NULL)')
  }

  const feedbackRows = await queryAsync(
    `SELECT
       id,
       run_code,
       client_code,
       feedback_date
     FROM ia_prediction_feedback
     WHERE ${whereClauses.join(' AND ')}
     ORDER BY feedback_date ASC, client_code ASC`,
    params
  )

  if (!feedbackRows.length) {
    return {
      requestedRows: 0,
      checkedRows: 0,
      purchasedRows: 0,
      zeroSaleRows: 0,
      skippedRows: 0,
      sourceSalesRows: 0,
      skipped: true,
      reason: 'no_feedback_rows'
    }
  }

  const eligibleRows = feedbackRows.filter(row => {
    const rowDate = normalizeDateOnly(row.feedback_date)
    const clientCode = String(row.client_code || '').trim()
    return rowDate && clientCode
  })

  const skippedRows = feedbackRows.length - eligibleRows.length
  if (!eligibleRows.length) {
    return {
      requestedRows: feedbackRows.length,
      checkedRows: 0,
      purchasedRows: 0,
      zeroSaleRows: 0,
      skippedRows,
      sourceSalesRows: 0,
      skipped: true,
      reason: 'no_eligible_feedback_rows'
    }
  }

  const clientCodesForSales = [...new Set(
    eligibleRows.flatMap(row => {
      const keys = normalizeClientKeys(row.client_code)
      return keys.filter(key => /^\d+$/.test(key)).map(key => key.padStart(5, '0'))
    })
  )]

  if (!clientCodesForSales.length) {
    return {
      requestedRows: feedbackRows.length,
      checkedRows: 0,
      purchasedRows: 0,
      zeroSaleRows: 0,
      skippedRows: feedbackRows.length,
      sourceSalesRows: 0,
      skipped: true,
      reason: 'no_numeric_client_codes'
    }
  }

  const eligibleDates = eligibleRows
    .map(row => normalizeDateOnly(row.feedback_date))
    .filter(Boolean)
    .sort()

  const salesDateFrom = eligibleDates[0]
  const salesDateTo = eligibleDates[eligibleDates.length - 1]
  const clientFilter = buildInClause(`LPAD(e.client_code, 5, '0')`, clientCodesForSales)

  const salesRows = await queryAsync(
    `
      SELECT
        sales_docs.sale_date,
        sales_docs.client_code,
        COUNT(*) AS actual_doc_count,
        SUM(sales_docs.net_amount) AS actual_sale_amount,
        SUM(COALESCE(doc_quantities.total_qty, 0)) AS actual_sale_qty
      FROM (
        SELECT
          e.code AS doc_code,
          DATE(e.date) AS sale_date,
          LPAD(e.client_code, 5, '0') AS client_code,
          CAST(COALESCE(e.net_a_payer, '0') AS DECIMAL(15,3)) AS net_amount
        FROM entetecommercials e
        WHERE e.deleted_at IS NULL
          AND e.type IN ('facture', 'bl', 'blf')
          AND DATE(e.date) BETWEEN ? AND ?
          ${clientFilter.sql}
      ) sales_docs
      LEFT JOIN (
        SELECT
          l.entetecommercial_code AS doc_code,
          SUM(CAST(COALESCE(l.quantite, '0') AS DECIMAL(15,3))) AS total_qty
        FROM lignecommercials l
        GROUP BY l.entetecommercial_code
      ) doc_quantities ON doc_quantities.doc_code = sales_docs.doc_code
      GROUP BY sales_docs.sale_date, sales_docs.client_code
      ORDER BY sales_docs.sale_date ASC, sales_docs.client_code ASC
    `,
    [salesDateFrom, salesDateTo, ...clientFilter.params]
  )

  const salesByDateClient = new Map()
  ;(salesRows || []).forEach(row => {
    const salesKey = `${normalizeDateOnly(row.sale_date)}::${getCanonicalClientKey(row.client_code)}`
    salesByDateClient.set(salesKey, {
      actualDocCount: Number(row.actual_doc_count || 0),
      actualSaleAmount: Number(row.actual_sale_amount || 0),
      actualSaleQty: Number(row.actual_sale_qty || 0)
    })
  })

  let checkedRows = 0
  let purchasedRows = 0
  let zeroSaleRows = 0

  for (const row of eligibleRows) {
    const rowDate = normalizeDateOnly(row.feedback_date)
    const salesKey = `${rowDate}::${getCanonicalClientKey(row.client_code)}`
    const actualSales = salesByDateClient.get(salesKey) || null

    const actualDocCount = Math.max(0, Number(actualSales?.actualDocCount || 0))
    const actualSaleAmount = Number(actualSales?.actualSaleAmount || 0)
    const actualSaleQty = Number(actualSales?.actualSaleQty || 0)
    const actualPurchaseFlag = actualDocCount > 0 || actualSaleAmount > 0 || actualSaleQty > 0 ? 1 : 0

    await queryAsync(
      `UPDATE ia_prediction_feedback
       SET
         actual_sale_amount = ?,
         actual_sale_qty = ?,
         actual_purchase_flag = ?,
         actual_doc_count = ?,
         actual_checked_at = NOW()
       WHERE id = ?`,
      [
        Number(actualSaleAmount.toFixed(3)),
        Number(actualSaleQty.toFixed(3)),
        actualPurchaseFlag,
        actualDocCount,
        row.id
      ]
    )

    checkedRows += 1
    if (actualPurchaseFlag) purchasedRows += 1
    else zeroSaleRows += 1
  }

  console.log(
    `[${logPrefix}] Reconciliation ventes -> rows=${checkedRows} purchased=${purchasedRows} zero=${zeroSaleRows} sales=${salesRows.length}`
  )

  return {
    requestedRows: feedbackRows.length,
    checkedRows,
    purchasedRows,
    zeroSaleRows,
    skippedRows,
    sourceSalesRows: salesRows.length,
    skipped: false,
    reason: null,
    range: {
      from: salesDateFrom,
      to: salesDateTo
    }
  }
}

async function fetchLoggedAiPredictions(requestPayload, loggingContext = {}) {
  const response = await axios.post('http://127.0.0.1:5001/api/predict', requestPayload)
  return {
    response,
    loggingResult: {
      runCode: response?.data?.prediction_run_code || null,
      sourceContext: loggingContext.sourceContext || null
    }
  }
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

function splitClientObjective(sortedClients, maxClients, targetChiffre) {
  const hasMaxClients = Number.isFinite(maxClients) && maxClients > 0
  const cappedClients = hasMaxClients ? sortedClients.slice(0, maxClients) : [...sortedClients]
  if (!targetChiffre || targetChiffre <= 0) {
    return {
      selected: cappedClients,
      suggestions: hasMaxClients ? sortedClients.slice(maxClients) : []
    }
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

  return {
    selected,
    suggestions: [
      ...cappedClients.slice(selected.length),
      ...(hasMaxClients ? sortedClients.slice(maxClients) : [])
    ]
  }
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

function normalizeDateOnly(value) {
  if (!value) return ''

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatLocalDate(value)
  }

  const rawValue = String(value).trim()
  if (!rawValue) return ''

  const isoMatch = rawValue.match(/^(\d{4}-\d{2}-\d{2})/)
  if (isoMatch) {
    return isoMatch[1]
  }

  const parsed = new Date(rawValue)
  if (!Number.isNaN(parsed.getTime())) {
    return formatLocalDate(parsed)
  }

  return ''
}

function addLocalDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  next.setHours(0, 0, 0, 0)
  return next
}

function resolveFrenchDayLabel(dateValue, fallbackLabel = null) {
  const parsed = parseLocalDate(dateValue)
  const computed = FRENCH_DAY_NAMES[parsed.getDay()]
  return FRENCH_DAY_NAMES.includes(fallbackLabel) ? fallbackLabel : computed
}

function buildWorkingDays(startDateValue, periodDays) {
  const startDate = parseLocalDate(startDateValue)
  const days = []

  for (let offset = 0; offset < periodDays; offset += 1) {
    const current = addLocalDays(startDate, offset)
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

function extractNumericCapacityHint(rawValue) {
  const matches = String(rawValue || '').match(/\d+(?:[.,]\d+)?/g)
  if (!matches || matches.length === 0) return null

  const rawNumber = String(matches[matches.length - 1] || '').replace(',', '.')
  const parsed = Number(rawNumber)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

function computeQuantile(sortedValues, percentile) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0
  if (sortedValues.length === 1) return Number(sortedValues[0] || 0)

  const safePercentile = clamp(Number(percentile || 0), 0, 1)
  const position = (sortedValues.length - 1) * safePercentile
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lowerValue = Number(sortedValues[lowerIndex] || 0)
  const upperValue = Number(sortedValues[upperIndex] || 0)

  if (lowerIndex === upperIndex) return lowerValue

  const weight = position - lowerIndex
  return lowerValue + ((upperValue - lowerValue) * weight)
}

function summarizeNumericSeries(values) {
  const normalized = (Array.isArray(values) ? values : [])
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)

  if (normalized.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p75: 0,
      p90: 0
    }
  }

  const total = normalized.reduce((sum, value) => sum + value, 0)

  return {
    count: normalized.length,
    min: normalized[0],
    max: normalized[normalized.length - 1],
    avg: total / normalized.length,
    p50: computeQuantile(normalized, 0.5),
    p75: computeQuantile(normalized, 0.75),
    p90: computeQuantile(normalized, 0.9)
  }
}

function deriveClientCapacityFromStats(stats) {
  if (!stats || !stats.count) return null

  const base = Math.max(
    Number(stats.p75 || 0),
    Number(stats.p90 || 0) * 0.95,
    Number(stats.avg || 0) * 1.05,
    stats.count < 4 ? Number(stats.max || 0) : 0
  )

  return Math.max(1, Math.round(clamp(base, 1, 250)))
}

function deriveTruckCapacityFromStats(stats, routeCapacityHint = null) {
  const safeRouteHint = Number(routeCapacityHint || 0)
  let derived = 0

  if (stats && stats.count) {
    derived = Math.max(
      Number(stats.p75 || 0) * 1.05,
      Number(stats.p90 || 0) * 0.95,
      Number(stats.avg || 0) * 1.10,
      stats.count < 4 ? Number(stats.max || 0) : 0
    )
  }

  if (Number.isFinite(safeRouteHint) && safeRouteHint > 0) {
    derived = derived > 0
      ? Math.min(safeRouteHint, Math.max(derived, safeRouteHint * 0.6))
      : safeRouteHint
  }

  if (!(derived > 0)) return null
  return Math.max(1, Math.round(derived))
}

function buildCommercialCapacityProfiles(activityRows, routeHintRows) {
  const profiles = new Map()
  const routeHintsByCommercial = new Map()

  ;(routeHintRows || []).forEach(row => {
    const commercialCode = String(row.commercial_code || '').trim()
    if (!commercialCode) return

    const routeHint = extractNumericCapacityHint(row.depot_code)
    if (!Number.isFinite(routeHint) || routeHint <= 0) return

    if (!routeHintsByCommercial.has(commercialCode)) {
      routeHintsByCommercial.set(commercialCode, new Map())
    }

    const weight = Math.max(1, Number(row.nb_clients || 0))
    const commercialHints = routeHintsByCommercial.get(commercialCode)
    commercialHints.set(routeHint, (commercialHints.get(routeHint) || 0) + weight)
  })

  ;(activityRows || []).forEach(row => {
    const commercialCode = String(row.commercial_code || '').trim()
    if (!commercialCode) return

    if (!profiles.has(commercialCode)) {
      profiles.set(commercialCode, {
        commercial_code: commercialCode,
        overall: {
          clientSamples: [],
          loadSamples: []
        },
        byDayIndex: new Map()
      })
    }

    const profile = profiles.get(commercialCode)
    const dayIndex = Number(row.day_index)
    const uniqueClients = Number(row.unique_clients || 0)
    const effectiveLoad = Math.max(
      0,
      Number(row.loading_quantity || 0),
      Number(row.total_quantity || 0)
    )

    profile.overall.clientSamples.push(uniqueClients)
    profile.overall.loadSamples.push(effectiveLoad)

    if (!profile.byDayIndex.has(dayIndex)) {
      profile.byDayIndex.set(dayIndex, {
        clientSamples: [],
        loadSamples: []
      })
    }

    const dayProfile = profile.byDayIndex.get(dayIndex)
    dayProfile.clientSamples.push(uniqueClients)
    dayProfile.loadSamples.push(effectiveLoad)
  })

  profiles.forEach((profile, commercialCode) => {
    const weightedHints = routeHintsByCommercial.get(commercialCode)
    const routeCapacityHint = weightedHints
      ? [...weightedHints.entries()]
          .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))[0]?.[0] || null
      : null

    const overallClientStats = summarizeNumericSeries(profile.overall.clientSamples)
    const overallLoadStats = summarizeNumericSeries(profile.overall.loadSamples)

    profile.overall = {
      ...overallClientStats,
      client_capacity_limit: deriveClientCapacityFromStats(overallClientStats),
      load_capacity_units: deriveTruckCapacityFromStats(overallLoadStats, routeCapacityHint),
      route_capacity_hint: routeCapacityHint
    }

    profile.byDayIndex.forEach((dayProfile, dayIndex) => {
      const clientStats = summarizeNumericSeries(dayProfile.clientSamples)
      const loadStats = summarizeNumericSeries(dayProfile.loadSamples)
      profile.byDayIndex.set(dayIndex, {
        ...clientStats,
        client_capacity_limit: deriveClientCapacityFromStats(clientStats) || profile.overall.client_capacity_limit,
        load_capacity_units: deriveTruckCapacityFromStats(loadStats, routeCapacityHint) || profile.overall.load_capacity_units,
        route_capacity_hint: routeCapacityHint
      })
    })
  })

  return profiles
}

function resolveCommercialCapacityForDay(profile, dayIndex, requestedMaxVisits) {
  const requestedLimit = Math.max(1, Number(requestedMaxVisits || 1))
  const dayProfile = profile?.byDayIndex?.get(dayIndex) || null
  const overallProfile = profile?.overall || null

  const resolvedClientCapacity = Number(
    dayProfile?.client_capacity_limit ||
    overallProfile?.client_capacity_limit ||
    requestedLimit
  )
  const resolvedTruckCapacity = Number(
    dayProfile?.load_capacity_units ||
    overallProfile?.load_capacity_units ||
    0
  )

  return {
    maxClients: Math.max(1, Math.min(requestedLimit, Number.isFinite(resolvedClientCapacity) && resolvedClientCapacity > 0 ? resolvedClientCapacity : requestedLimit)),
    maxLoadUnits: Number.isFinite(resolvedTruckCapacity) && resolvedTruckCapacity > 0 ? resolvedTruckCapacity : null,
    clientSource: dayProfile?.count ? 'historique_jour' : (overallProfile?.count ? 'historique_global' : 'parametre'),
    truckSource: dayProfile?.load_capacity_units
      ? 'historique_jour'
      : (overallProfile?.load_capacity_units
          ? (overallProfile?.route_capacity_hint ? 'historique+route' : 'historique_global')
          : (overallProfile?.route_capacity_hint ? 'route' : 'aucun')),
    routeCapacityHint: overallProfile?.route_capacity_hint || null
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

function buildValidatedTourneeCode(prefix, date, commercialCode) {
  const safeDate = String(date || '').replace(/[^0-9]/g, '')
  const safeCommercial = String(commercialCode || '').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'
  const safePrefix = String(prefix || 'tournee').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'tournee'
  return `${safePrefix}-${safeDate}-${safeCommercial}`
}

function sendCoveragePlannerMessage(res, message, extra = {}) {
  return res.json({
    status: 'invalid_parameters',
    message,
    summary: null,
    blocks: [],
    ...extra
  })
}

function buildCoverageValidationCode(date, commercialCode) {
  return buildValidatedTourneeCode('coverage', date, commercialCode)
}

function normalizeValidatedStops(stops) {
  return (Array.isArray(stops) ? stops : [])
    .map((stop, index) => ({
      client_code: String(stop.client_code || stop.nbr_client || '').trim(),
      client_name: String(stop.client_name || stop.nom || '').trim(),
      adresse: String(stop.adresse || '').trim(),
      latitude: Number.isFinite(Number(stop.latitude)) ? String(Number(stop.latitude)) : null,
      longitude: Number.isFinite(Number(stop.longitude)) ? String(Number(stop.longitude)) : null,
      rang: Number.isFinite(Number(stop.rang)) && Number(stop.rang) > 0 ? Number(stop.rang) : index + 1
    }))
    .filter(stop => stop.client_code)
}

function buildValidatedLoadingCode(date, commercialCode) {
  return buildValidatedTourneeCode('prechargement', date, commercialCode)
}

function normalizeProductLookupKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim()
}

function normalizeLoadingProducts(products) {
  return (Array.isArray(products) ? products : [])
    .map((item, index) => {
      const nom = String(
        item?.nom ||
        item?.name ||
        item?.produit_nom ||
        item?.produit_code ||
        ''
      ).trim()
      const quantiteBrute = Number.parseFloat(String(
        item?.quantite ??
        item?.quantity ??
        item?.qte ??
        item?.qte_reco ??
        0
      ).replace(',', '.'))

      return {
        nom,
        quantite: Number.isFinite(quantiteBrute) ? Number(quantiteBrute.toFixed(3)) : 0,
        ordre: index + 1
      }
    })
    .filter(item => item.nom && item.quantite > 0)
}

async function resolveMovementSoussocieteCode({ commercialCode = '', depotCode = '' } = {}) {
  return null
}

async function resolveLoadingProductDefinition(productName, cache = new Map()) {
  const lookupKey = String(productName || '').trim()
  const normalizedLookupKey = normalizeProductLookupKey(lookupKey)

  if (!lookupKey) {
    return null
  }

  if (cache.has(lookupKey)) {
    return cache.get(lookupKey)
  }

  const productSelect = `
    SELECT
      code,
      prix_achat_ht,
      prix_achat_ttc,
      prix_ht,
      prix_ttc,
      tva,
      chargement,
      qte_stock,
      updated_at,
      sousfamille_code,
      famille_code,
      libelle,
      description,
      details
    FROM produits
    WHERE %ACTIF_CONDITION%
      AND %FIELD_CONDITION%
    ORDER BY
      CASE WHEN chargement = 1 THEN 0 ELSE 1 END ASC,
      qte_stock DESC,
      updated_at DESC,
      code ASC
    LIMIT %LIMIT_VALUE%
  `

  const exactFields = ['code', 'sousfamille_code', 'famille_code', 'libelle', 'description', 'details']
  const activeConditions = ['actif = 1', '1 = 1']
  let resolved = null

  exactSearch:
  for (const activeCondition of activeConditions) {
    for (const field of exactFields) {
      const sql = productSelect
        .replace('%ACTIF_CONDITION%', activeCondition)
        .replace('%FIELD_CONDITION%', `${field} = ?`)
        .replace('%LIMIT_VALUE%', '1')

      const rows = await queryAsync(sql, [lookupKey])
      if (rows.length > 0) {
        resolved = rows[0]
        break exactSearch
      }
    }
  }

  if (!resolved && normalizedLookupKey) {
    const likePattern = `%${lookupKey}%`
    const sql = productSelect
      .replace('%ACTIF_CONDITION%', 'actif = 1')
      .replace('%FIELD_CONDITION%', '(code LIKE ? OR sousfamille_code LIKE ? OR famille_code LIKE ? OR libelle LIKE ? OR description LIKE ? OR details LIKE ?)')
      .replace('%LIMIT_VALUE%', '50')

    const rows = await queryAsync(sql, Array(6).fill(likePattern))
    const scoredRows = rows
      .map(row => {
        const ranks = [
          ['code', 0],
          ['sousfamille_code', 1],
          ['famille_code', 2],
          ['libelle', 3],
          ['description', 4],
          ['details', 5]
        ]

        let bestRank = Number.POSITIVE_INFINITY
        for (const [field, rank] of ranks) {
          const candidateValue = normalizeProductLookupKey(row[field])
          if (!candidateValue) continue

          if (candidateValue === normalizedLookupKey) {
            bestRank = Math.min(bestRank, rank)
          } else if (
            candidateValue.includes(normalizedLookupKey) ||
            normalizedLookupKey.includes(candidateValue)
          ) {
            bestRank = Math.min(bestRank, rank + 10)
          }
        }

        return {
          row,
          bestRank
        }
      })
      .filter(item => Number.isFinite(item.bestRank))
      .sort((a, b) => {
        if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank
        if (Number(a.row.chargement || 0) !== Number(b.row.chargement || 0)) {
          return Number(b.row.chargement || 0) - Number(a.row.chargement || 0)
        }
        if (Number(a.row.qte_stock || 0) !== Number(b.row.qte_stock || 0)) {
          return Number(b.row.qte_stock || 0) - Number(a.row.qte_stock || 0)
        }
        return String(a.row.code || '').localeCompare(String(b.row.code || ''))
      })

    resolved = scoredRows[0]?.row || null
  }

  cache.set(lookupKey, resolved || null)
  return resolved || null
}

async function replaceValidatedLoadingPrediction({
  date,
  commercialCode,
  depotCode,
  loadingProducts,
  logPrefix = 'PLAN_VALIDATE'
}) {
  await ensureMovementSupportTables()

  const selectedDate = formatLocalDate(parseLocalDate(date))
  const loadingCode = buildValidatedLoadingCode(selectedDate, commercialCode)
  const normalizedProducts = normalizeLoadingProducts(loadingProducts)
  const movementDate = `${selectedDate} 00:00:00`
  const mouvementDepotCode = String(depotCode || '').trim() || null
  const soussocieteCode = await resolveMovementSoussocieteCode({
    commercialCode,
    depotCode: mouvementDepotCode
  })
  const magasinierCode = String(process.env.PRECHARGEMENT_MAGASINIER_CODE || 'nomadis').trim() || null
  const resolutionCache = new Map()
  const createdAt = new Date()

  await queryAsync(
    `DELETE FROM mouvements
     WHERE deleted_at IS NULL
       AND type = 'pre-chargement'
       AND from_dash = 1
       AND commercial_code = ?
       AND DATE(date) = ?
       AND (numero = ? OR group_cmd_code = ?)`,
    [commercialCode, selectedDate, loadingCode, loadingCode]
  )

  if (!normalizedProducts.length) {
    console.log(`[${logPrefix}] Aucun pre-chargement IA a enregistrer pour date=${selectedDate} commercial=${commercialCode}`)
    return {
      savedRows: 0,
      movementCode: loadingCode
    }
  }

  for (const product of normalizedProducts) {
    const definition = await resolveLoadingProductDefinition(product.nom, resolutionCache)

    if (!definition?.code) {
      const error = new Error(`Produit de chargement introuvable pour la prediction: ${product.nom}.`)
      error.statusCode = 400
      throw error
    }

    const quantite = Number(product.quantite)
    const prixAchatHt = Number.isFinite(Number(definition.prix_achat_ht)) ? Number(definition.prix_achat_ht) : 0
    const prixAchatTtc = Number.isFinite(Number(definition.prix_achat_ttc)) ? Number(definition.prix_achat_ttc) : 0
    const prixHt = Number.isFinite(Number(definition.prix_ht)) ? Number(definition.prix_ht) : null
    const prixTtc = Number.isFinite(Number(definition.prix_ttc)) ? Number(definition.prix_ttc) : null
    const tauxTva = Number.isFinite(Number(definition.tva)) ? Number(definition.tva) : null
    const pTva = prixHt != null && prixTtc != null
      ? Number(((prixTtc - prixHt) * quantite).toFixed(3))
      : null

    await queryAsync(
      `INSERT INTO mouvements (
        magasinier_code,
        depot_code,
        commercial_code,
        soussociete_code,
        produit_code,
        prix_achat_ht,
        prix_achat_ttc,
        quantite,
        qte_demande,
        prix_ht,
        prix_ttc,
        p_tva,
        taux_tva,
        remise,
        type,
        type_chargement,
        from_stock,
        from_stock_ri,
        from_dash,
        numero,
        group_cmd_code,
        configuration,
        etat,
        date,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pre-chargement', NULL, 1, 0, 1, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        magasinierCode,
        mouvementDepotCode,
        commercialCode,
        soussocieteCode,
        definition.code,
        prixAchatHt,
        prixAchatTtc,
        quantite,
        quantite,
        prixHt,
        prixTtc,
        pTva,
        tauxTva,
        loadingCode,
        loadingCode,
        product.nom,
        movementDate,
        createdAt,
        createdAt
      ]
    )
  }

  console.log(`[${logPrefix}] Pre-chargement IA enregistre -> code=${loadingCode} rows=${normalizedProducts.length}`)

  return {
    savedRows: normalizedProducts.length,
    movementCode: loadingCode
  }
}

async function saveValidatedTourneePlan({
  date,
  dayLabel,
  commercialCode,
  commercialLabel,
  routeCode,
  depotCode,
  depotName,
  stops,
  frequence,
  categorieCode,
  typeClient,
  codePrefix,
  predictionRunCode = null,
  loadingProducts = null,
  logPrefix = 'PLAN_VALIDATE'
}) {
  const selectedDate = formatLocalDate(parseLocalDate(date))
  const normalizedStops = normalizeValidatedStops(stops)

  if (!commercialCode) {
    const error = new Error('Commercial manquant pour la validation de la tournee.')
    error.statusCode = 400
    throw error
  }

  if (!normalizedStops.length) {
    const error = new Error('Aucun client valide a enregistrer pour cette tournee.')
    error.statusCode = 400
    throw error
  }

  console.log(`[${logPrefix}] Debut validation -> date=${selectedDate} commercial=${commercialCode} stops=${normalizedStops.length}`)

  const resolvedDayLabel = resolveFrenchDayLabel(selectedDate, dayLabel)
  const validationCode = buildValidatedTourneeCode(codePrefix, selectedDate, commercialCode)
  const routingCode = routeCode || commercialCode || 'plan-ia'
  const depotValue = depotCode || depotName || null
  const tourneeLabel = `${commercialLabel} - ${selectedDate}`
  let transactionStarted = false

  try {
    await queryAsync('START TRANSACTION')
    transactionStarted = true

    await queryAsync(
      `DELETE FROM tournees
       WHERE deleted_at IS NULL
         AND frequence = ?
         AND code_layer = ?
         AND date_debut = ?
         AND date_fin = ?`,
      [frequence, commercialCode, selectedDate, selectedDate]
    )

    for (const stop of normalizedStops) {
      const coordinates = stop.latitude != null && stop.longitude != null
        ? JSON.stringify({ latitude: Number(stop.latitude), longitude: Number(stop.longitude) })
        : null

      await queryAsync(
        `INSERT INTO tournees (
          code,
          libelle,
          layer,
          coordinates,
          code_jour,
          client_code,
          routing_code,
          depot_code,
          frequence,
          dates,
          actif,
          actif_client,
          date_debut,
          date_fin,
          rang,
          categorie_code,
          type_layer,
          code_layer,
          couleur,
          type_client,
          rs_client_code,
          latitude,
          longitude,
          adresse,
          activite,
          client,
          icon,
          couleur_icon,
          image
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 'tournee', ?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL)`,
        [
          validationCode,
          tourneeLabel,
          coordinates,
          resolvedDayLabel,
          stop.client_code,
          routingCode,
          depotValue,
          frequence,
          selectedDate,
          selectedDate,
          selectedDate,
          stop.rang,
          categorieCode,
          commercialCode,
          typeClient,
          stop.client_code,
          stop.latitude,
          stop.longitude,
          stop.adresse || null,
          stop.client_name || null
        ]
      )
    }

    const loadingResult = Array.isArray(loadingProducts)
      ? await replaceValidatedLoadingPrediction({
          date: selectedDate,
          commercialCode,
          depotCode: depotCode || depotName || null,
          loadingProducts,
          logPrefix
        })
      : { savedRows: 0, movementCode: null }

    await queryAsync('COMMIT')

    console.log(`[${logPrefix}] Succes -> code=${validationCode} rows=${normalizedStops.length}`)

    let feedbackResult = {
      savedRows: 0,
      predictedRows: 0,
      selectedRows: normalizedStops.length,
      unmatchedSelectedRows: 0,
      skipped: true,
      reason: 'missing_prediction_run_code'
    }

    try {
      feedbackResult = await recordPredictionValidationFeedback({
        predictionRunCode,
        feedbackDate: selectedDate,
        commercialCode,
        routeCode: routingCode,
        depotCode: depotValue,
        validationCode,
        stops: normalizedStops,
        logPrefix
      })
    } catch (feedbackError) {
      console.warn(`[${logPrefix}] Feedback prediction non enregistre: ${feedbackError.message}`)
      feedbackResult = {
        savedRows: 0,
        predictedRows: 0,
        selectedRows: normalizedStops.length,
        unmatchedSelectedRows: 0,
        skipped: true,
        reason: 'feedback_logging_error'
      }
    }

    let reconciliationResult = {
      requestedRows: 0,
      checkedRows: 0,
      purchasedRows: 0,
      zeroSaleRows: 0,
      skippedRows: 0,
      sourceSalesRows: 0,
      skipped: true,
      reason: 'feedback_not_available'
    }

    if (!feedbackResult.skipped && String(predictionRunCode || '').trim()) {
      try {
        reconciliationResult = await reconcilePredictionFeedbackActualSales({
          runCode: predictionRunCode,
          feedbackDate: selectedDate,
          onlyPending: false,
          logPrefix: `${logPrefix}_ACTUAL`
        })
      } catch (reconciliationError) {
        console.warn(`[${logPrefix}] Reconciliation ventes non terminee: ${reconciliationError.message}`)
        reconciliationResult = {
          requestedRows: 0,
          checkedRows: 0,
          purchasedRows: 0,
          zeroSaleRows: 0,
          skippedRows: 0,
          sourceSalesRows: 0,
          skipped: true,
          reason: 'reconciliation_error'
        }
      }
    }

    const loadingMessage = loadingResult.savedRows > 0
      ? ` Le pre-chargement IA (${loadingResult.savedRows} produit${loadingResult.savedRows > 1 ? 's' : ''}) a aussi ete enregistre.`
      : ''

    return {
      status: 'success',
      message: `La tournee finale du ${selectedDate} pour ${commercialLabel} a ete enregistree.${loadingMessage}`,
      saved_rows: normalizedStops.length,
      saved_loading_rows: loadingResult.savedRows,
      loading_code: loadingResult.movementCode,
      tournee_code: validationCode,
      prediction_run_code: String(predictionRunCode || '').trim() || null,
      prediction_feedback_rows: feedbackResult.savedRows,
      prediction_feedback_skipped: Boolean(feedbackResult.skipped),
      prediction_feedback_reason: feedbackResult.reason,
      prediction_feedback_unmatched_selected_rows: feedbackResult.unmatchedSelectedRows,
      prediction_actual_checked_rows: reconciliationResult.checkedRows,
      prediction_actual_purchase_rows: reconciliationResult.purchasedRows,
      prediction_actual_zero_rows: reconciliationResult.zeroSaleRows,
      prediction_actual_skipped_rows: reconciliationResult.skippedRows,
      prediction_actual_reconcile_skipped: Boolean(reconciliationResult.skipped),
      prediction_actual_reconcile_reason: reconciliationResult.reason
    }
  } catch (error) {
    if (transactionStarted) {
      try {
        await queryAsync('ROLLBACK')
      } catch (rollbackError) {
        console.error(`[${logPrefix}] Rollback impossible:`, rollbackError.message)
      }
    }

    throw error
  }
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

function createBlockSlots(workingDays, commercials, totalVisits, minVisits, maxVisits, capacityProfiles = new Map()) {
  const availableSlots = []
  const safeMinVisits = Math.max(1, Number(minVisits || 1))
  const safeMaxVisits = Math.max(safeMinVisits, Number(maxVisits || safeMinVisits))

  workingDays.forEach(day => {
    commercials.forEach(commercial => {
      const commercialCode = String(commercial.value || '').trim()
      const capacity = resolveCommercialCapacityForDay(
        capacityProfiles.get(commercialCode) || null,
        day.dayIndex,
        safeMaxVisits
      )

      availableSlots.push({
        id: `${day.date}::${commercialCode}`,
        date: day.date,
        day_label: day.label,
        day_index: day.dayIndex,
        proposed_commercial: commercialCode,
        proposed_commercial_label: commercial.label,
        tournees: [],
        total_predicted_ca: 0,
        total_score: 0,
        total_reco_units: 0,
        uniqueClients: new Set(),
        target_size: 0,
        min_size: Math.min(safeMinVisits, capacity.maxClients),
        max_size: capacity.maxClients,
        max_load_units: capacity.maxLoadUnits,
        client_capacity_source: capacity.clientSource,
        truck_capacity_source: capacity.truckSource,
        route_capacity_hint: capacity.routeCapacityHint
      })
    })
  })

  if (availableSlots.length === 0) {
    return {
      slots: [],
      totalClientCapacity: 0,
      totalTruckCapacityUnits: 0,
      totalAvailableSlots: 0
    }
  }

  const chosenSlots = []
  let totalClientCapacity = 0
  let totalTruckCapacityUnits = 0

  for (const slot of availableSlots) {
    if (slot.max_size <= 0) continue

    chosenSlots.push(slot)
    totalClientCapacity += Number(slot.max_size || 0)
    totalTruckCapacityUnits += Number(slot.max_load_units || 0)

    if (totalClientCapacity >= totalVisits) {
      break
    }
  }

  if (chosenSlots.length === 0) {
    return {
      slots: [],
      totalClientCapacity: 0,
      totalTruckCapacityUnits: 0,
      totalAvailableSlots: availableSlots.length
    }
  }

  const boundedTotalCapacity = Math.max(1, chosenSlots.reduce((sum, slot) => sum + Number(slot.max_size || 0), 0))
  let assignedTargets = 0

  chosenSlots.forEach(slot => {
    const proportionalTarget = Math.floor((totalVisits * Number(slot.max_size || 0)) / boundedTotalCapacity)
    slot.target_size = Math.min(Number(slot.max_size || 0), Math.max(0, proportionalTarget))
    assignedTargets += slot.target_size
  })

  let remainder = Math.max(0, totalVisits - assignedTargets)
  const slotOrder = chosenSlots
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => {
      const spareA = Number(a.slot.max_size || 0) - Number(a.slot.target_size || 0)
      const spareB = Number(b.slot.max_size || 0) - Number(b.slot.target_size || 0)
      if (spareB !== spareA) return spareB - spareA
      return a.index - b.index
    })

  while (remainder > 0) {
    let progressed = false
    for (const entry of slotOrder) {
      if (entry.slot.target_size >= Number(entry.slot.max_size || 0)) continue
      entry.slot.target_size += 1
      remainder -= 1
      progressed = true
      if (remainder <= 0) break
    }
    if (!progressed) break
  }

  return {
    slots: chosenSlots,
    totalClientCapacity,
    totalTruckCapacityUnits,
    totalAvailableSlots: availableSlots.length
  }
}

function pickBestSlotForVisit(slots, visit, cursorRef, diagnostics = null) {
  if (!slots.length) return null

  const totalSlots = slots.length
  const preferredCommercial = String(visit.proposed_commercial || '').trim()
  const preferredSlotId = String(visit.recommended_slot_id || '').trim()
  const clientKey = visit.canonical_client_key

  const scoreSlot = (slot, index) => {
    const slotSignal = visit.slot_predictions?.[slot.id] || null
    const mlAffinity = clamp(Number(slotSignal?.assignment_prob || 0), 0, 100)
    const mlPredictedCa = Math.max(0, Number(slotSignal?.weighted_predicted_ca || slotSignal?.predicted_ca || 0))
    const projectedUnits = Math.max(1, Math.round(Number(slotSignal?.weighted_qte || visit.qte_reco || 1)))
    const sameCommercial = preferredCommercial && slot.proposed_commercial === preferredCommercial ? 6 : 0
    const recommendedSlotBonus = preferredSlotId && slot.id === preferredSlotId ? 12 : 0
    const remainingCapacity = Math.max(0, slot.target_size - slot.tournees.length)
    const remainingTruckUnits = Number.isFinite(Number(slot.max_load_units))
      ? Math.max(0, Number(slot.max_load_units) - Number(slot.total_reco_units || 0))
      : projectedUnits
    const truckRoomBonus = Math.min(remainingTruckUnits, projectedUnits * 2) * 0.02
    const loadPenalty = slot.tournees.length * 2
    const cursorBonus = ((index - cursorRef.current + totalSlots) % totalSlots) === 0 ? 4 : 0
    return (mlAffinity * 0.45) + (mlPredictedCa * 0.02) + sameCommercial + recommendedSlotBonus + (remainingCapacity * 3) + truckRoomBonus - loadPenalty + cursorBonus
  }

  let bestIndex = -1
  let bestScore = Number.NEGATIVE_INFINITY
  let blockedByClientCapacity = 0
  let blockedByTruckCapacity = 0

  for (let i = 0; i < totalSlots; i += 1) {
    const index = (cursorRef.current + i) % totalSlots
    const slot = slots[index]
    if (slot.uniqueClients.has(clientKey)) continue
    if (slot.tournees.length >= Number(slot.max_size || Number.POSITIVE_INFINITY)) {
      blockedByClientCapacity += 1
      continue
    }

    const slotSignal = visit.slot_predictions?.[slot.id] || null
    const projectedUnits = Math.max(1, Math.round(Number(slotSignal?.weighted_qte || visit.qte_reco || 1)))
    if (Number.isFinite(Number(slot.max_load_units)) && Number(slot.max_load_units) > 0) {
      const nextLoad = Number(slot.total_reco_units || 0) + projectedUnits
      if (nextLoad > Number(slot.max_load_units)) {
        blockedByTruckCapacity += 1
        continue
      }
    }

    const currentScore = scoreSlot(slot, index)
    if (currentScore > bestScore) {
      bestScore = currentScore
      bestIndex = index
    }
  }

  if (bestIndex < 0) {
    if (diagnostics) {
      diagnostics.clientCapacityBlocks += blockedByClientCapacity > 0 ? 1 : 0
      diagnostics.truckCapacityBlocks += blockedByTruckCapacity > 0 ? 1 : 0
    }
    return null
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
    prediction_run_code: String(slot.prediction_run_code || '').trim() || null,
    clients_count: tournees.length,
    predicted_ca: roundScore(slot.total_predicted_ca),
    average_score: tournees.length ? roundScore(slot.total_score / tournees.length) : 0,
    capacity: {
      planned_clients: tournees.length,
      max_clients: Number(slot.max_size || 0),
      planned_truck_units: roundScore(Number(slot.total_reco_units || 0)),
      max_truck_units: Number.isFinite(Number(slot.max_load_units)) ? roundScore(Number(slot.max_load_units)) : null,
      client_capacity_source: slot.client_capacity_source,
      truck_capacity_source: slot.truck_capacity_source,
      route_capacity_hint: slot.route_capacity_hint
    },
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

app.post('/api/ia/prediction-feedback/reconcile', async (req, res) => {
  const payload = req.body || {}
  const runCode = String(payload.run_code || payload.prediction_run_code || req.query.run_code || '').trim() || null
  const feedbackDate = String(payload.feedback_date || req.query.feedback_date || '').trim() || null
  const dateFrom = String(payload.date_from || req.query.date_from || '').trim() || null
  const dateTo = String(payload.date_to || req.query.date_to || '').trim() || null
  const rawOnlyPending = payload.only_pending ?? req.query.only_pending
  const onlyPending = rawOnlyPending == null
    ? true
    : !['0', 'false', 'non', 'no'].includes(String(rawOnlyPending).trim().toLowerCase())

  try {
    const result = await reconcilePredictionFeedbackActualSales({
      runCode,
      feedbackDate,
      dateFrom,
      dateTo,
      onlyPending,
      logPrefix: 'PREDICTION_RECONCILE_API'
    })

    return res.json({
      status: 'success',
      message: result.skipped
        ? 'Aucune ligne feedback eligible a reconcilier pour le moment.'
        : `${result.checkedRows} ligne(s) feedback ont ete rapprochees avec les ventes reelles.`,
      filters: {
        run_code: runCode,
        feedback_date: feedbackDate,
        date_from: dateFrom,
        date_to: dateTo,
        only_pending: onlyPending
      },
      ...result
    })
  } catch (error) {
    console.error('[PREDICTION_RECONCILE_API] Erreur reconciliation feedback:', error.message)
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Impossible de rapprocher les feedbacks IA avec les ventes reelles.'
    })
  }
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

app.post('/api/tournees/coverage-plan/validate', async (req, res) => {
  const payload = req.body || {}
  const commercialCode = String(payload.commercial_code || '').trim()
  const commercialLabel = String(payload.commercial_label || `Commercial ${commercialCode}`).trim()
  const routeCode = String(payload.route_code || '').trim()
  const depotCode = String(payload.depot_code || '').trim()
  const depotName = String(payload.depot_name || '').trim()
  const stops = payload.stops

  try {
    const result = await saveValidatedTourneePlan({
      date: payload.date,
      dayLabel: payload.day_label,
      commercialCode,
      commercialLabel,
      routeCode,
      depotCode,
      depotName,
      stops,
      frequence: 'couverture_ia',
      categorieCode: 'coverage_ia',
      typeClient: 'coverage_plan',
      codePrefix: 'coverage',
      predictionRunCode: payload.prediction_run_code,
      logPrefix: 'COVERAGE_VALIDATE'
    })

    return res.json(result)
  } catch (error) {
    const statusCode = error.statusCode || 500
    console.error('[COVERAGE_VALIDATE] Erreur validation plan de route:', error.message)
    return res.status(statusCode).json({ error: error.message || "Impossible d'enregistrer la tournee finale." })
  }
})

app.post('/api/tournees/plan/validate', async (req, res) => {
  const payload = req.body || {}
  const commercialCode = String(payload.commercial_code || '').trim()
  const commercialLabel = String(payload.commercial_label || `Commercial ${commercialCode}`).trim()
  const routeCode = String(payload.route_code || '').trim()
  const depotCode = String(payload.depot_code || '').trim()
  const depotName = String(payload.depot_name || '').trim()
  const stops = payload.stops
  const modeTournee = String(payload.mode_tournee || 'vente').trim() === 'recouvrement' ? 'recouvrement' : 'vente'
  const loadingProducts = Array.isArray(payload.loading_products) ? payload.loading_products : null

  try {
    const result = await saveValidatedTourneePlan({
      date: payload.date,
      dayLabel: payload.day_label,
      commercialCode,
      commercialLabel,
      routeCode,
      depotCode,
      depotName,
      stops,
      frequence: modeTournee === 'recouvrement' ? 'plan_route_recouvrement' : 'plan_route_vente',
      categorieCode: modeTournee === 'recouvrement' ? 'plan_route_recouvrement' : 'plan_route_vente',
      typeClient: modeTournee === 'recouvrement' ? 'route_plan_recouvrement' : 'route_plan_vente',
      codePrefix: modeTournee === 'recouvrement' ? 'recouvrement' : 'vente',
      predictionRunCode: payload.prediction_run_code,
      loadingProducts: modeTournee === 'recouvrement' ? null : loadingProducts,
      logPrefix: 'ROUTE_PLAN_VALIDATE'
    })

    return res.json(result)
  } catch (error) {
    const statusCode = error.statusCode || 500
    console.error('[ROUTE_PLAN_VALIDATE] Erreur validation plan de route:', error.message)
    return res.status(statusCode).json({ error: error.message || "Impossible d'enregistrer la tournee finale." })
  }
})

app.get('/api/tournees/coverage-plan', async (req, res) => {
  const startDate = req.query.start_date || formatLocalDate(new Date())
  const periodDays = Math.max(1, Math.min(60, parseInt(req.query.period_days, 10) || 14))
  const rawMinVisits = parseInt(req.query.min_visits, 10)
  const rawMaxVisits = parseInt(req.query.max_visits, 10)
  const minVisits = Math.max(1, Math.min(250, rawMinVisits || 20))
  const maxVisits = Math.max(minVisits, Math.min(250, rawMaxVisits || 30))
  const minTotalCa = Math.max(0, parseFloat(req.query.min_total_ca || '0') || 0)
  const selectedCommercials = parseCommercialSelection(req.query.commercials)
  const workingDays = buildWorkingDays(startDate, periodDays)

  if (Number.isFinite(rawMinVisits) && Number.isFinite(rawMaxVisits) && rawMaxVisits < rawMinVisits) {
    return sendCoveragePlannerMessage(
      res,
      `Le calcul ne peut pas etre lance avec ces valeurs : Max visite (${rawMaxVisits}) doit etre superieur ou egal a Min visite (${rawMinVisits}).`
    )
  }

  if (workingDays.length === 0) {
    return sendCoveragePlannerMessage(res, 'Aucun jour ouvrable disponible sur la periode selectionnee.')
  }

  const allCommercials = await fetchCommercialOptions()

  const activeCommercials = selectedCommercials.length
    ? allCommercials.filter(item => selectedCommercials.includes(item.value))
    : allCommercials

  if (activeCommercials.length === 0) {
    return sendCoveragePlannerMessage(res, 'Aucun commercial selectionne pour la planification.')
  }

  const commercialFilter = buildInClause('c.user_code', activeCommercials.map(item => item.value))
  const capacityCommercialFilter = buildInClause(
    `COALESCE(NULLIF(TRIM(e.commercial_code), ''), NULLIF(TRIM(e.user_code), ''), NULLIF(TRIM(c.user_code), ''), 'Inconnu')`,
    activeCommercials.map(item => item.value)
  )

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

    const sqlCommercialCapacityHistory = `
      SELECT
        COALESCE(NULLIF(TRIM(e.commercial_code), ''), NULLIF(TRIM(e.user_code), ''), NULLIF(TRIM(c.user_code), ''), 'Inconnu') AS commercial_code,
        DATE(e.date) AS activity_date,
        DAYOFWEEK(DATE(e.date)) - 1 AS day_index,
        COUNT(DISTINCT LPAD(e.client_code, 5, '0')) AS unique_clients,
        SUM(CAST(COALESCE(l.quantite, '0') AS DECIMAL(15,3))) AS total_quantity,
        SUM(
          CASE
            WHEN COALESCE(p.chargement, 1) = 1
            THEN CAST(COALESCE(l.quantite, '0') AS DECIMAL(15,3))
            ELSE 0
          END
        ) AS loading_quantity
      FROM entetecommercials e
      JOIN clients c ON e.client_code = c.code
      LEFT JOIN lignecommercials l ON e.code = l.entetecommercial_code
      LEFT JOIN produits p ON l.produit_code = p.code
      WHERE e.deleted_at IS NULL
        AND e.type IN ('facture', 'bl', 'blf')
        AND DATE(e.date) <= ?
        AND DATE(e.date) >= DATE_SUB(?, INTERVAL 365 DAY)
        ${capacityCommercialFilter.sql}
      GROUP BY
        commercial_code,
        DATE(e.date),
        DAYOFWEEK(DATE(e.date)) - 1
    `

    const sqlCommercialRouteHints = `
      SELECT
        c.user_code AS commercial_code,
        r.depot_code,
        COUNT(*) AS nb_clients
      FROM clients c
      LEFT JOIN routings r ON r.code = c.routing_code
      WHERE c.deleted_at IS NULL
        AND c.isactif = '1'
        ${commercialFilter.sql}
      GROUP BY c.user_code, r.depot_code
    `

    const [clients, historiqueRows, commercialCapacityRows, commercialRouteHintRows] = await Promise.all([
      queryAsync(sqlClients, commercialFilter.params),
      queryAsync(sqlHistorique, [startDate]),
      queryAsync(sqlCommercialCapacityHistory, [startDate, startDate, ...capacityCommercialFilter.params]),
      queryAsync(sqlCommercialRouteHints, commercialFilter.params)
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
          total_predicted_ca: 0,
          min_visits: minVisits,
          max_visits: maxVisits
        },
        blocks: []
      })
    }

    const historiqueByClient = new Map()
    ;(historiqueRows || []).forEach(row => {
      setClientMapValue(historiqueByClient, row.client_code, row)
    })

    const commercialCapacityProfiles = buildCommercialCapacityProfiles(
      commercialCapacityRows || [],
      commercialRouteHintRows || []
    )

    const aiPredictionByDate = new Map()
    const predictionRunCodes = []
    for (const workingDay of workingDays) {
      try {
        const { response: aiResponse, loggingResult } = await fetchLoggedAiPredictions(
          {
            date: workingDay.date,
            commercials: activeCommercials.map(item => item.value)
          },
          {
            sourceContext: 'coverage_plan',
            sourceMode: 'coverage',
            requestCommercialCode: activeCommercials.length === 1 ? activeCommercials[0].value : null,
            requestContext: {
              planner_start_date: startDate,
              working_day: workingDay.date,
              period_days: periodDays,
              min_visits: minVisits,
              max_visits: maxVisits,
              min_total_ca: minTotalCa
            }
          }
        )

        const predictionRunCode = aiResponse.data?.prediction_run_code || loggingResult?.runCode || null
        if (predictionRunCode) {
          predictionRunCodes.push({
            date: workingDay.date,
            run_code: predictionRunCode
          })
        }

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

    const slotPlan = createBlockSlots(
      workingDays,
      activeCommercials,
      visitEntries.length,
      minVisits,
      maxVisits,
      commercialCapacityProfiles
    )

    if (visitEntries.length > Number(slotPlan.totalClientCapacity || 0)) {
      return sendCoveragePlannerMessage(
        res,
        `Le calcul ne rentre pas avec les capacites commerciales reelles. La capacite maximale estimee est ${slotPlan.totalClientCapacity} visites pour ${slotPlan.totalAvailableSlots} blocks, alors que le plan en demande ${visitEntries.length}. Reduis les visites, allonge la periode, ou ajoute des commerciaux.`
      )
    }

    const slots = slotPlan.slots
    const cursorRef = { current: 0 }
    let unassignedVisits = 0
    const assignmentDiagnostics = {
      clientCapacityBlocks: 0,
      truckCapacityBlocks: 0
    }

    visitEntries.forEach(entry => {
      const slot = pickBestSlotForVisit(slots, entry, cursorRef, assignmentDiagnostics)
      if (!slot) {
        unassignedVisits += 1
        return
      }
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
      slot.total_reco_units += Number(assignedQteReco || 0)
    })

    if (unassignedVisits > 0) {
      const plannedTruckCapacity = roundScore(Number(slotPlan.totalTruckCapacityUnits || 0))
      const requestedTruckUnits = roundScore(
        visitEntries.reduce((sum, entry) => sum + Number(entry.qte_reco || 0), 0)
      )
      const truckNote = assignmentDiagnostics.truckCapacityBlocks > 0
        ? ` La charge cumulee estimee atteint ${requestedTruckUnits} unites pour une capacite camion estimee a ${plannedTruckCapacity} unites.`
        : ''
      const clientNote = assignmentDiagnostics.clientCapacityBlocks > 0
        ? ` Les capacites journalieres reelles des commerciaux ont aussi ete atteintes.`
        : ''
      return sendCoveragePlannerMessage(
        res,
        `Le calcul ne peut pas repartir ${unassignedVisits} visite(s) sans depasser les capacites reelles.${clientNote}${truckNote} Reduis les visites, allonge la periode, ou ajoute des commerciaux.`
      )
    }

    const predictionRunCodeByDate = new Map(
      predictionRunCodes.map(item => [String(item.date || '').trim(), String(item.run_code || '').trim() || null])
    )

    const blocks = slots
      .filter(slot => slot.tournees.length > 0)
      .map(slot => finalizeCoverageBlock(
        {
          ...slot,
          prediction_run_code: predictionRunCodeByDate.get(String(slot.date || '').trim()) || null
        },
        buildDepotOrigin(SHARED_DEPOT_ORIGIN, null, slot.proposed_commercial, null)
      ))

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
        total_planned_units: roundScore(blocks.reduce((sum, block) => sum + Number(block.capacity?.planned_truck_units || 0), 0)),
        total_truck_capacity_units: roundScore(blocks.reduce((sum, block) => sum + Number(block.capacity?.max_truck_units || 0), 0)),
        total_client_capacity: Number(slotPlan.totalClientCapacity || 0),
        min_visits: minVisits,
        max_visits: maxVisits,
        min_total_ca: minTotalCa,
        excluded_days: ['Dimanche'],
        selected_commerciaux: activeCommercials
      },
      blocks,
      prediction_run_codes: predictionRunCodes
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

        const recoverySelection = splitClientObjective(tourneesFormattees, topClients, targetChiffre)
        tourneesFormattees = recoverySelection.selected
        return envoyerReponse(res, tourneesFormattees, dateReference, 0, 0, 0, depotOrigin, {
          mode: modeTournee,
          recovery_filter_mode: recoveryFilterMode,
          suggestions_ajout: recoverySelection.suggestions
        })
      } catch (errRecouvrement) {
        return res.status(500).json({ error: errRecouvrement.message })
      }
    }

    if (isPast) {
      let aiPredictions = {}
      let predictionRunCode = null
      try {
        const { response: aiResponse, loggingResult } = await fetchLoggedAiPredictions(
          { date: datePrediction },
          {
            sourceContext: 'tournees_plan_past',
            sourceMode: modeTournee,
            requestRouteCode: route || null,
            requestCommercialCode: commercial || null,
            requestTopClients: topClients,
            requestTargetChiffre: targetChiffre,
            requestContext: {
              date_reference: dateReference,
              date_prediction: datePrediction,
              use_range: useRange,
              route_code: route || null,
              commercial_code: commercial || null
            }
          }
        )
        predictionRunCode = aiResponse.data?.prediction_run_code || loggingResult?.runCode || null
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

        const pastSelection = splitClientObjective(tourneesFormattees, topClients, targetChiffre)
        tourneesFormattees = pastSelection.selected

        envoyerReponse(res, tourneesFormattees, dateReference, iaAgro, iaChips, iaBur, depotOrigin, {
          mode: modeTournee,
          suggestions_ajout: pastSelection.suggestions,
          prediction_run_code: predictionRunCode
        })
      })
    } else {
      let aiPredictions = {}
      let predictionRunCode = null
      try {
        const { response: aiResponse, loggingResult } = await fetchLoggedAiPredictions(
          { date: datePrediction },
          {
            sourceContext: 'tournees_plan_future',
            sourceMode: modeTournee,
            requestRouteCode: route || null,
            requestCommercialCode: commercial || null,
            requestTopClients: topClients,
            requestTargetChiffre: targetChiffre,
            requestContext: {
              date_reference: dateReference,
              date_prediction: datePrediction,
              use_range: useRange,
              route_code: route || null,
              commercial_code: commercial || null
            }
          }
        )
        predictionRunCode = aiResponse.data?.prediction_run_code || loggingResult?.runCode || null
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

      const futureSelection = splitClientObjective(tourneesFormattees, topClients, targetChiffre)
      tourneesFormattees = futureSelection.selected

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

      envoyerReponse(res, tourneesFormattees, dateReference, iaAgro, iaChips, iaBur, depotOrigin, {
        mode: modeTournee,
        suggestions_ajout: futureSelection.suggestions,
        prediction_run_code: predictionRunCode
      })
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

  const vraiePrecision = readCurrentIaPrecisionScore()

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

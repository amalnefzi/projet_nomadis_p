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

function roundScore(value) {
  return Math.round(value * 10) / 10
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

function runManualTraining(res) {
  const scriptPath = path.join(apiDir, 'train_auto.py')
  execFile('python', [scriptPath], { cwd: apiDir }, (error, stdout, stderr) => {
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
    return res.json({
      status: 'success',
      message: 'Reentrainement termine. Le dernier modele IA est maintenant disponible.',
      details: stdout
    })
  })
}

app.post('/api/train-ia', (req, res) => {
  console.log("Lancement d'un reentrainement manuel IA...")
  runManualTraining(res)
})

app.get('/api/tournees/options', (req, res) => {
  db.query(`SELECT DISTINCT routing_code AS route FROM clients WHERE routing_code IS NOT NULL AND routing_code != '' LIMIT 20`, (err, routes) => {
    if (err) return res.status(500).json({ error: 'Erreur SQL routes' })
    db.query(`SELECT DISTINCT user_code AS commercial FROM clients WHERE user_code IS NOT NULL AND user_code != '' LIMIT 20`, (err2, comm) => {
      if (err2) return res.status(500).json({ error: 'Erreur SQL commerciaux' })
      res.json({
        routes: (routes || []).map(r => ({ value: r.route, label: `Route ${r.route}` })),
        commerciaux: (comm || []).map(c => ({ value: c.commercial, label: `Commercial ${c.commercial}` }))
      })
    })
  })
})

app.get('/api/tournees/plan', async (req, res) => {
  const date_precise = req.query.date_precise || new Date().toISOString().split('T')[0]
  const date_debut = req.query.date_debut
  const date_fin = req.query.date_fin
  const commercial = req.query.commercial
  const route = req.query.route
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
      c.code AS nbr_client, c.plafond_credit AS plafond, c.potentiel,
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

        envoyerReponse(res, tourneesFormattees, dateReference, iaAgro, iaChips, iaBur, depotOrigin)
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

      envoyerReponse(res, tourneesFormattees, dateReference, iaAgro, iaChips, iaBur, depotOrigin)
    }
  })
})

function envoyerReponse(res, tournees, date_precise, agro, chips, bur, depotOrigin) {
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
    depot_origin: depotOrigin
  })
}

const PORT = process.env.PORT || 5000
app.listen(PORT, () => console.log(`Serveur API pret sur http://localhost:${PORT}`))

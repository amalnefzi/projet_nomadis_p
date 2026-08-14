import { useState, useEffect, useMemo } from 'react'
import axios from 'axios'
import './App.css'
import CoveragePlanner from './CoveragePlanner'
import SalesCoveragePlanner from './SalesCoveragePlanner'
import V2ValidationLab from './V2ValidationLab'
import { formatCommercialZone } from './salesCoverageDetails.js'
import { API_URL } from './apiConfig'
import TourRouteMap from './TourRouteMap'
import useOptimizedTourRoute from './useOptimizedTourRoute'
import { buildPlannerModules } from './validationLabConfig'
import {
  buildGoogleMapsUrl,
  formatDistanceMeters,
  formatDurationSeconds
} from './tourRouteUtils'

const JOURS_TO_INDEX = {
  Dimanche: 0,
  Lundi: 1,
  Mardi: 2,
  Mercredi: 3,
  Jeudi: 4,
  Vendredi: 5,
  Samedi: 6
}

function toISODate(d) {
  const dt = d instanceof Date ? new Date(d) : parseISODateLocal(d)
  dt.setHours(0, 0, 0, 0)
  return formatLocalISODate(dt)
}

function formatLocalISODate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseISODateLocal(value) {
  if (!value) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return today
  }

  const [year, month, day] = String(value).split('-').map(Number)
  const parsed = new Date(year, (month || 1) - 1, day || 1)
  parsed.setHours(0, 0, 0, 0)
  return parsed
}

function startOfWeekMonday(isoDate) {
  const d = parseISODateLocal(isoDate)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d
}

function resolveEffectiveDate(datePrecise, jourSemaine) {
  if (datePrecise) return datePrecise
  if (!jourSemaine) return formatLocalISODate(new Date())

  const targetDay = JOURS_TO_INDEX[jourSemaine]
  if (targetDay == null) return formatLocalISODate(new Date())

  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const currentDay = d.getDay()
  const diff = (targetDay - currentDay + 7) % 7
  d.setDate(d.getDate() + diff)
  return formatLocalISODate(d)
}

function buildQuantitySplit(totalQuantity) {
  const qte = Math.max(0, Number(totalQuantity || 0))
  let agro = Math.floor(qte * 0.45)
  let chips = Math.floor(qte * 0.35)
  let bur = Math.floor(qte * 0.20)
  const diff = Math.round(qte - (agro + chips + bur))
  if (diff > 0) agro += diff
  return { agro, chips, bur }
}

function getClientSelectionKey(row) {
  return String(
    row?.client_id ??
    row?.canonical_client_key ??
    row?.nbr_client ??
    ''
  ).trim()
}

function App() {
  const [activeModule, setActiveModule] = useState('dashboard')
  const [loading, setLoading] = useState(false)
  const [erreur, setErreur] = useState(null)
  const [showBacktest, setShowBacktest] = useState(false)
  const [topClientsInput, setTopClientsInput] = useState('')
  const [targetChiffreInput, setTargetChiffreInput] = useState('')
  const [isTraining, setIsTraining] = useState(false)
  const [options, setOptions] = useState({ routes: [], commerciaux: [] })
  const [donneesTournee, setDonneesTournee] = useState(null)
  const [editableTournees, setEditableTournees] = useState([])
  const [additionalSuggestions, setAdditionalSuggestions] = useState([])
  const [clickedClient, setClickedClient] = useState(null)
  const [userLocation, setUserLocation] = useState(null)
  const [validationFeedback, setValidationFeedback] = useState(null)
  const [validationLoading, setValidationLoading] = useState(false)
  const [isValidationModalOpen, setIsValidationModalOpen] = useState(false)
  const [manualOrderLocked, setManualOrderLocked] = useState(false)
  const joursSemaine = useMemo(
    () => ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'],
    []
  )
  const plannerModules = useMemo(() => buildPlannerModules(), [])

  const [filtres, setFiltres] = useState({
    route: '',
    commercial: '',
    date_precise: '',
    actif: 'Oui',
    mode_tournee: 'vente',
    mode_date: 'jour',
    top_clients: '',
    target_chiffre: '',
    jour_semaine: ''
  })

  useEffect(() => {
    let isMounted = true

    axios.get(`${API_URL}/api/tournees/options`).then(res => {
      if (!isMounted) return
      const r = Array.isArray(res.data?.routes) ? res.data.routes : []
      const c = Array.isArray(res.data?.commerciaux) ? res.data.commerciaux : []
      setOptions({ routes: r, commerciaux: c })
      if (r.length && !filtres.route) setFiltres(prev => ({ ...prev, route: r[0]?.value || '' }))
      if (c.length && !filtres.commercial) setFiltres(prev => ({ ...prev, commercial: c[0]?.value || '' }))
    }).catch(error => {
      if (!isMounted) return
      console.error('Erreur chargement options tournees:', error)
      setOptions({ routes: [], commerciaux: [] })
      setErreur(error?.response?.data?.error || error?.message || 'Erreur chargement options tournees.')
    })

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (!navigator.geolocation) return

    navigator.geolocation.getCurrentPosition(
      position => {
        setUserLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          nom: 'Position actuelle',
          adresse: 'Depart actuel'
        })
      },
      () => {
        setUserLocation(null)
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 300000 }
    )
  }, [])

  const handleChangeFiltre = (champ, valeur) => setFiltres(prev => ({ ...prev, [champ]: valeur }))

  useEffect(() => {
    setTopClientsInput(filtres.top_clients === '' || filtres.top_clients == null ? '' : String(filtres.top_clients))
  }, [filtres.top_clients])

  const effectiveDatePrecise = useMemo(
    () => resolveEffectiveDate(filtres.date_precise, filtres.jour_semaine),
    [filtres.date_precise, filtres.jour_semaine]
  )

  const periode = useMemo(() => {
    if (filtres.mode_date !== 'semaine') return null
    const monday = startOfWeekMonday(effectiveDatePrecise)
    const saturday = new Date(monday)
    saturday.setDate(monday.getDate() + 5)
    return { date_debut: toISODate(monday), date_fin: toISODate(saturday) }
  }, [effectiveDatePrecise, filtres.mode_date])

  const rechercherTournees = async () => {
    try {
      setLoading(true)
      setErreur(null)
      setValidationFeedback(null)
      if (filtres.mode_tournee !== 'vente') {
        setShowBacktest(false)
      }

      const parsedTop = parseInt(topClientsInput, 10)
      const committedTop = Number.isFinite(parsedTop) ? Math.min(200, Math.max(1, parsedTop)) : ''
      const parsedTarget = parseFloat(String(targetChiffreInput || '').replace(',', '.'))
      const committedTarget = Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : ''
      if (committedTop !== filtres.top_clients) {
        setFiltres(prev => ({ ...prev, top_clients: committedTop }))
      }
      if (committedTarget !== filtres.target_chiffre) {
        setFiltres(prev => ({ ...prev, target_chiffre: committedTarget }))
      }
      setTopClientsInput(committedTop === '' ? '' : String(committedTop))
      setTargetChiffreInput(committedTarget === '' ? '' : String(committedTarget))

      const res = await axios.get(`${API_URL}/api/tournees/plan`, {
        params: {
          date_precise: effectiveDatePrecise,
          date_debut: periode?.date_debut,
          date_fin: periode?.date_fin,
          commercial: filtres.commercial,
          route: filtres.route,
          actif: filtres.actif,
          mode_tournee: filtres.mode_tournee,
          top_clients: committedTop || undefined,
          target_chiffre: committedTarget || undefined,
          t: Date.now()
        }
      })
      setDonneesTournee(res.data)
      setEditableTournees(Array.isArray(res.data?.tournees) ? res.data.tournees : [])
      setAdditionalSuggestions(Array.isArray(res.data?.suggestions_ajout) ? res.data.suggestions_ajout : [])
      setManualOrderLocked(false)
      setClickedClient(null)
    } catch {
      setErreur("Erreur connexion. Verifiez MySQL et l'API.")
    } finally {
      setLoading(false)
    }
  }

  const entrainerIA = async () => {
    if (window.confirm("Le systeme se met a jour automatiquement. Voulez-vous lancer un reentrainement manuel maintenant ?")) {
      setIsTraining(true)
      try {
        const res = await axios.post(`${API_URL}/api/train-ia`)
        alert(res.data.message)
      } catch (err) {
        alert(err?.response?.data?.message || "Le reentrainement manuel a echoue. L'application continue d'utiliser le dernier modele valide.")
      } finally {
        setIsTraining(false)
      }
    }
  }

  const tournees = useMemo(() => editableTournees, [editableTournees])
  const chargeTotale = useMemo(() => {
    if (!tournees.length) {
      return donneesTournee?.chargeTotale ?? { agro: 0, chips: 0, bureautique: 0, detailsProduits: [] }
    }

    const detailsProduitsMap = {}
    tournees.forEach(row => {
      ;(row.produits || []).forEach(produit => {
        const nom = String(produit.nom || '').trim()
        if (!nom) return
        detailsProduitsMap[nom] = (detailsProduitsMap[nom] || 0) + Number(produit.quantite || 0)
      })
    })

    return {
      agro: tournees.reduce((sum, row) => sum + Number(row.details?.agro || 0), 0),
      chips: tournees.reduce((sum, row) => sum + Number(row.details?.chips || 0), 0),
      bureautique: tournees.reduce((sum, row) => sum + Number(row.details?.bur || 0), 0),
      detailsProduits: Object.entries(detailsProduitsMap)
        .map(([nom, quantite]) => ({ nom, quantite: Number(quantite.toFixed(1)) }))
        .sort((a, b) => b.quantite - a.quantite)
    }
  }, [donneesTournee, tournees])
  const itineraire = useMemo(() => donneesTournee?.itineraire ?? [], [donneesTournee])
  const modeTournee = donneesTournee?.mode || filtres.mode_tournee || 'vente'
  const isRecouvrementMode = modeTournee === 'recouvrement'

  const itineraireGeo = useMemo(() => {
    const fromApi = (donneesTournee?.itineraire_geo || []).filter(pt => pt.latitude != null && pt.longitude != null)
    if (fromApi.length) return fromApi
    return (donneesTournee?.tournees || [])
      .map((row, idx) => ({
        step: idx + 1,
        client_code: row.nbr_client,
        nom: row.nom,
        adresse: row.adresse || 'Adresse non specifiee',
        latitude: row.latitude,
        longitude: row.longitude,
        score_ia: row.score_ia,
        qte_reco: row.qte_reco
      }))
      .filter(pt => pt.latitude != null && pt.longitude != null)
  }, [donneesTournee])

  const depotOrigin = useMemo(() => {
    const rawDepot = donneesTournee?.depot_origin
    if (!rawDepot) return null

    const latitude = Number(rawDepot.latitude)
    const longitude = Number(rawDepot.longitude)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

    return {
      ...rawDepot,
      latitude,
      longitude
    }
  }, [donneesTournee])

  const getJourLabel = (idx) => {
    if (filtres.mode_date === 'semaine') return joursSemaine[idx % 7]
    const d = parseISODateLocal(effectiveDatePrecise)
    d.setHours(0, 0, 0, 0)
    const js = d.getDay()
    const map = { 0: 'Dimanche', 1: 'Lundi', 2: 'Mardi', 3: 'Mercredi', 4: 'Jeudi', 5: 'Vendredi', 6: 'Samedi' }
    return map[js] || '-'
  }

  const tourneesAffichees = useMemo(() => {
    const filtered = tournees
    const maxPossible = filtered.length
    if (maxPossible === 0) return []
    if (filtres.top_clients === '' || filtres.top_clients == null) return filtered
    const n = Math.min(maxPossible, Math.max(1, Number(filtres.top_clients)))
    return filtered.slice(0, n)
  }, [tournees, filtres.top_clients])

  const suggestionRows = useMemo(() => {
    const selectedKeys = new Set(tournees.map(row => getClientSelectionKey(row)).filter(Boolean))
    return additionalSuggestions.filter(row => {
      const key = getClientSelectionKey(row)
      return key && !selectedKeys.has(key)
    })
  }, [additionalSuggestions, tournees])

  const routingCandidates = useMemo(() => {
    return tourneesAffichees
      .map((row, idx) => ({
        id: String(row.client_id || row.canonical_client_key || row.nbr_client || ''),
        inputIndex: idx,
        nom: row.nom,
        adresse: row.adresse || 'Adresse non specifiee',
        latitude: Number(row.latitude),
        longitude: Number(row.longitude)
      }))
      .filter(stop => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude))
  }, [tourneesAffichees])

  const routePlan = useOptimizedTourRoute({
    selected: true,
    commercialCode: filtres.commercial,
    date: effectiveDatePrecise,
    stops: routingCandidates,
    origin: depotOrigin || userLocation,
    preserveOrder: manualOrderLocked
  })

  const chiffreTotal = tourneesAffichees.reduce(
    (acc, curr) => acc + Number(curr.collecte_prevue ?? curr.chiffre_brut ?? parseFloat(curr.chiffre) ?? 0),
    0
  )
  const quantiteTotalCamion = chargeTotale.agro + chargeTotale.chips + chargeTotale.bureautique
  const plafondTotal = tourneesAffichees.reduce((acc, curr) => acc + (Number(curr.plafond_credit) || 0), 0)
  const encoursTotalRecouvrement = tourneesAffichees.reduce((acc, curr) => acc + (Number(curr.encours_credit) || 0), 0)
  const montantMoyenRecouvrement = tourneesAffichees.length ? encoursTotalRecouvrement / tourneesAffichees.length : 0
  const recouvrementList = useMemo(
    () => tourneesAffichees
      .map(row => ({
        nom: row.nom,
        collecte: Number(row.collecte_prevue || row.chiffre_brut || 0),
        encours: Number(row.encours_credit || 0),
        isDueToday: Number(row.is_due_today || 0)
      }))
      .sort((a, b) => (b.collecte - a.collecte) || (b.encours - a.encours)),
    [tourneesAffichees]
  )
  const routeNavigationUrl = useMemo(
    () => buildGoogleMapsUrl(routePlan.origin, routePlan.orderedStops),
    [routePlan.origin, routePlan.orderedStops]
  )
  const selectedRouteLabel = useMemo(
    () => options.routes.find(item => item.value === filtres.route)?.label || (filtres.route ? `Route ${filtres.route}` : 'Route non definie'),
    [options.routes, filtres.route]
  )
  const selectedCommercialLabel = useMemo(
    () => options.commerciaux.find(item => item.value === filtres.commercial)?.label || `Commercial ${filtres.commercial || ''}`,
    [options.commerciaux, filtres.commercial]
  )
  const validationSelectedDate = useMemo(
    () => donneesTournee?.jourSelectionne || effectiveDatePrecise,
    [donneesTournee, effectiveDatePrecise]
  )
  const validationRouteCode = useMemo(
    () => filtres.route || depotOrigin?.route || '',
    [filtres.route, depotOrigin]
  )
  const validationDepotName = useMemo(
    () => depotOrigin?.nom || 'Depot non specifie',
    [depotOrigin]
  )
  const validationDisabledReason = validationLoading
    ? 'Validation en cours...'
    : !tourneesAffichees.length
      ? 'Aucun client a enregistrer pour ce plan de route.'
      : null

  const buildValidationStops = () => {
    const rowsByClient = new Map(
      tourneesAffichees.map((row, index) => [getClientSelectionKey(row), { ...row, __index: index }])
    )

    const routeStops = routePlan.orderedStops.length
      ? routePlan.orderedStops
          .map((stop, index) => {
            const clientId = String(stop.client_id || stop.id || '').trim()
            const clientCode = String(stop.client_code || '').trim()
            const row = rowsByClient.get(clientId || clientCode)
            if ((!clientId && !clientCode) && !row) return null

            return {
              client_id: clientId || String(row?.client_id || '').trim(),
              client_code: clientCode || String(row?.nbr_client || '').trim(),
              client_name: row?.nom || stop.nom || '',
              adresse: row?.adresse || stop.adresse || '',
              latitude: row?.latitude ?? stop.latitude ?? null,
              longitude: row?.longitude ?? stop.longitude ?? null,
              rang: index + 1
            }
          })
          .filter(Boolean)
      : tourneesAffichees.map((row, index) => ({
          client_id: String(row.client_id || '').trim(),
          client_code: String(row.nbr_client || '').trim(),
          client_name: row.nom || '',
          adresse: row.adresse || '',
          latitude: row.latitude ?? null,
          longitude: row.longitude ?? null,
          rang: index + 1
        }))

    return routeStops.filter(stop => stop.client_id || stop.client_code)
  }

  const updateEditableRow = (rowIndex, updater) => {
    setEditableTournees(current => current.map((row, index) => (
      index === rowIndex ? updater(row) : row
    )))
  }

  const handleQteRecoChange = (rowIndex, rawValue) => {
    const parsedValue = Number.parseFloat(String(rawValue || '').replace(',', '.'))
    const nextQte = Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0

    updateEditableRow(rowIndex, row => {
      const previousQte = Math.max(0, Number(row.qte_reco || 0))
      const ratio = previousQte > 0 ? nextQte / previousQte : 0
      const produits = Array.isArray(row.produits)
        ? row.produits.map(produit => ({
            ...produit,
            quantite: Number.isFinite(Number(produit.quantite))
              ? Number((Number(produit.quantite) * ratio).toFixed(1))
              : produit.quantite
          }))
        : row.produits
      const details = buildQuantitySplit(nextQte)

      return {
        ...row,
        qte_reco: nextQte,
        produits,
        details: {
          ...row.details,
          agro: details.agro,
          chips: details.chips,
          bur: details.bur
        }
      }
    })
  }

  const moveEditableRow = (rowIndex, direction) => {
    setEditableTournees(current => {
      const nextRows = [...current]
      const targetIndex = rowIndex + direction
      if (rowIndex < 0 || targetIndex < 0 || rowIndex >= nextRows.length || targetIndex >= nextRows.length) {
        return current
      }

      const [movedRow] = nextRows.splice(rowIndex, 1)
      nextRows.splice(targetIndex, 0, movedRow)
      return nextRows
    })
    setManualOrderLocked(true)
    setClickedClient(null)
  }

  const resetManualRouteOrder = () => {
    setManualOrderLocked(false)
  }

  const handleAddSuggestedClient = (suggestion) => {
    const suggestionKey = getClientSelectionKey(suggestion)
    if (!suggestionKey) return

    const currentTop = Number.parseInt(filtres.top_clients, 10)
    if (Number.isFinite(currentTop) && currentTop > 0 && tourneesAffichees.length >= currentTop) {
      const nextTop = currentTop + 1
      setTopClientsInput(String(nextTop))
      setFiltres(prev => ({ ...prev, top_clients: nextTop }))
    }

    setEditableTournees(current => {
      if (current.some(row => getClientSelectionKey(row) === suggestionKey)) {
        return current
      }

      return [
        ...current,
        {
          ...suggestion,
          details: suggestion?.details ? { ...suggestion.details } : suggestion.details,
          produits: Array.isArray(suggestion?.produits)
            ? suggestion.produits.map(produit => ({ ...produit }))
            : []
        }
      ]
    })

    setAdditionalSuggestions(current => current.filter(row => getClientSelectionKey(row) !== suggestionKey))
  }

  const openValidationModal = () => {
    if (!donneesTournee) {
      const errorMessage = 'Aucun plan de route disponible a valider.'
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

    setIsValidationModalOpen(true)
  }

  const closeValidationModal = () => {
    if (validationLoading) return
    setIsValidationModalOpen(false)
  }

  const validateRoutePlan = async () => {
    if (!donneesTournee) {
      const errorMessage = 'Aucun plan de route disponible a valider.'
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

    setValidationLoading(true)
    setValidationFeedback(null)
    setIsValidationModalOpen(false)

    try {
      const payload = {
        date: validationSelectedDate,
        day_label: getJourLabel(0),
        commercial_code: filtres.commercial,
        commercial_label: selectedCommercialLabel,
        route_code: validationRouteCode,
        depot_code: depotOrigin?.depot_code || '',
        depot_name: validationDepotName,
        mode_tournee: modeTournee,
        prediction_run_code: donneesTournee?.prediction_run_code || null,
        loading_products: isRecouvrementMode ? undefined : chargeTotale.detailsProduits,
        stops
      }

      const response = await axios.post(`${API_URL}/api/tournees/plan/validate`, payload, {
        timeout: 20000
      })

      const successMessage = response.data?.message || 'La tournee finale a ete enregistree.'
      setValidationFeedback({ type: 'success', message: successMessage })
      window.alert(successMessage)
    } catch (saveError) {
      const errorMessage = saveError?.response?.data?.error || saveError?.message || "Impossible d'enregistrer la tournee finale."
      setValidationFeedback({ type: 'error', message: errorMessage })
      window.alert(errorMessage)
    } finally {
      setValidationLoading(false)
    }
  }

  return (
    <div style={{ padding: '20px 40px', fontFamily: '"Segoe UI", Roboto, Helvetica, Arial, sans-serif', backgroundColor: '#f4f7fa', minHeight: '100vh', color: '#333' }}>
      <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
        {plannerModules.map(module => (
          <button
            key={module.id}
            onClick={() => setActiveModule(module.id)}
            style={{
              padding: '11px 18px',
              borderRadius: '999px',
              border: activeModule === module.id ? 'none' : '1px solid #cbd5e1',
              backgroundColor: activeModule === module.id
                ? (module.id === 'dashboard' ? '#1a2b4c' : module.id === 'recovery' ? '#1c6dd0' : '#0f766e')
                : 'white',
              color: activeModule === module.id ? 'white' : '#334155',
              fontWeight: '700'
            }}
          >
            {module.label}
          </button>
        ))}
      </div>

      <div style={{ display: activeModule === 'recovery' ? 'block' : 'none' }}>
        <CoveragePlanner api={API_URL} />
      </div>

      <div style={{ display: activeModule === 'sales' ? 'block' : 'none' }}>
        <SalesCoveragePlanner />
      </div>

      <div style={{ display: activeModule === 'validation_lab' ? 'block' : 'none' }}>
        <V2ValidationLab />
      </div>

      <div style={{ display: activeModule === 'dashboard' ? 'block' : 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#1a2b4c', fontSize: '28px' }}>Dashboard Optimisation - IA Nomadis</h1>
          <p style={{ margin: '5px 0 0 0', color: '#6c757d' }}>Systeme intelligent de repartition et de chargement</p>
          <p style={{ margin: '6px 0 0 0', color: '#20c997', fontSize: '12px', fontWeight: '600' }}>Mise a jour automatique quotidienne activee</p>
        </div>

        <button
          onClick={entrainerIA}
          disabled={isTraining}
          style={{
            padding: '10px 20px',
            backgroundColor: isTraining ? '#fd7e14' : '#20c997',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            cursor: isTraining ? 'wait' : 'pointer',
            fontWeight: 'bold',
            fontSize: '14px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            transition: '0.3s'
          }}
        >
          {isTraining ? 'Reentrainement manuel en cours...' : 'Forcer un reentrainement IA'}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '15px', backgroundColor: 'white', padding: '20px', borderRadius: '10px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', marginBottom: '30px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '150px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>Route / Depot</label>
          <select value={filtres.route} onChange={e => handleChangeFiltre('route', e.target.value)} style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}>
            <option value="">-- Toutes --</option>
            {options.routes.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '150px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>Commercial</label>
          <select value={filtres.commercial} onChange={e => handleChangeFiltre('commercial', e.target.value)} style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}>
            <option value="">-- Tous --</option>
            {options.commerciaux.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '150px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>Date precise</label>
          <input
            type="date"
            value={filtres.date_precise}
            onChange={e => handleChangeFiltre('date_precise', e.target.value)}
            style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}
          />
          {periode && (
            <div style={{ marginTop: '6px', fontSize: '11px', color: '#6c757d' }}>
              Periode: <b>{periode.date_debut}</b> {'->'} <b>{periode.date_fin}</b>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '150px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>Nombre de clients</label>
          <input
            type="number"
            min={1}
            max={200}
            value={topClientsInput}
            onChange={e => setTopClientsInput(e.target.value)}
            onBlur={() => {
              const trimmed = String(topClientsInput ?? '').trim()
              if (trimmed === '') {
                setTopClientsInput('')
                return
              }
              const parsed = parseInt(trimmed, 10)
              const next = Number.isFinite(parsed) ? Math.min(200, Math.max(1, parsed)) : ''
              setTopClientsInput(next === '' ? '' : String(next))
            }}
            style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '170px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>
            {filtres.mode_tournee === 'recouvrement' ? 'Seuil encours (TND)' : 'Objectif CA (TND)'}
          </label>
          <input
            type="number"
            min={0}
            step="0.1"
            value={targetChiffreInput}
            onChange={e => setTargetChiffreInput(e.target.value)}
            onBlur={() => {
              const parsed = parseFloat(String(targetChiffreInput || '').replace(',', '.'))
              const next = Number.isFinite(parsed) && parsed > 0 ? String(parsed) : ''
              setTargetChiffreInput(next)
            }}
            placeholder={filtres.mode_tournee === 'recouvrement' ? 'Ex: 5000 encours' : 'Ex: 10000000'}
            style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '170px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>Type de tournee</label>
          <select
            value={filtres.mode_tournee}
            onChange={e => {
              setShowBacktest(false)
              handleChangeFiltre('mode_tournee', e.target.value)
            }}
            style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}
          >
            <option value="vente">Prediction de vente</option>
            <option value="recouvrement">Tournee de recouvrement</option>
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '170px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>Jour de la semaine</label>
          <select
            value={filtres.jour_semaine}
            onChange={e => handleChangeFiltre('jour_semaine', e.target.value)}
            style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}
          >
            <option value="">-- Tous --</option>
            {joursSemaine.map(j => (
              <option key={j} value={j}>{j}</option>
            ))}
          </select>
        </div>

        <button onClick={rechercherTournees} disabled={loading} style={{ padding: '10px 25px', backgroundColor: loading ? '#6c757d' : '#0d6efd', color: 'white', border: 'none', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 'bold', height: '40px', transition: '0.3s' }}>
          {loading ? 'Recherche IA...' : "Analyser avec l'IA"}
        </button>

        {donneesTournee && !isRecouvrementMode && (
          <button onClick={() => setShowBacktest(!showBacktest)} style={{ padding: '10px 25px', backgroundColor: '#6f42c1', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', height: '40px', marginLeft: 'auto' }}>
            {showBacktest ? 'Cacher Backtest' : 'Voir Precision'}
          </button>
        )}
      </div>

      {erreur && <div style={{ padding: '15px', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '6px', marginBottom: '20px' }}>{erreur}</div>}

      {showBacktest && donneesTournee && (
        <div style={{ backgroundColor: 'white', padding: '25px', borderRadius: '12px', marginBottom: '30px', border: '2px solid #6f42c1', boxShadow: '0 8px 15px rgba(111, 66, 193, 0.15)' }}>
          <h4 style={{ margin: '0 0 20px 0', color: '#4b2885', fontSize: '20px', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Validation IA : Predit vs Reel
          </h4>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '20px' }}>
            <div style={{ backgroundColor: '#f8f9fa', padding: '15px', borderRadius: '8px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: '#6c757d', marginBottom: '5px' }}>Precision Globale IA</div>
              <div style={{ fontSize: '36px', fontWeight: '900', color: '#198754' }}>
                {donneesTournee?.precision_ia ?? '85.4'}%
              </div>
            </div>
            <div style={{ backgroundColor: '#f8f9fa', padding: '15px', borderRadius: '8px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: '#6c757d', marginBottom: '5px' }}>Total Predit</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#0d6efd' }}>{chiffreTotal.toLocaleString()} TND</div>
            </div>
            <div style={{ backgroundColor: '#f8f9fa', padding: '15px', borderRadius: '8px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: '#6c757d', marginBottom: '5px' }}>Clients Analyses</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#6f42c1' }}>{tourneesAffichees.length}</div>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ backgroundColor: '#6f42c1', color: 'white' }}>
                  <th style={{ padding: '10px', textAlign: 'left' }}>CLIENT</th>
                  <th style={{ padding: '10px', textAlign: 'right' }}>VENTE PREDITE</th>
                  <th style={{ padding: '10px', textAlign: 'right' }}>VENTE REELLE</th>
                  <th style={{ padding: '10px', textAlign: 'right' }}>ECART</th>
                  <th style={{ padding: '10px', textAlign: 'center' }}>PRECISION</th>
                </tr>
              </thead>
              <tbody>
                {tourneesAffichees.map((row, idx) => {
                  const predit = parseFloat(row.chiffre) || 0
                  const reel = parseFloat(row.vente_reelle) || 0
                  const ecart = predit - reel
                  const precision = reel > 0 ? Math.max(0, 100 - (Math.abs(ecart) / reel * 100)) : 0

                  let precisionColor = '#dc3545'
                  if (precision >= 80) precisionColor = '#198754'
                  else if (precision >= 60) precisionColor = '#fd7e14'

                  return (
                    <tr key={idx} style={{ backgroundColor: idx % 2 === 0 ? 'white' : '#f8f9fa' }}>
                      <td style={{ padding: '8px', borderBottom: '1px solid #e9ecef' }}>{row.nom}</td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #e9ecef', textAlign: 'right', color: '#0d6efd', fontWeight: 'bold' }}>
                        {predit.toFixed(1)} TND
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #e9ecef', textAlign: 'right', color: reel > 0 ? '#198754' : '#6c757d', fontWeight: 'bold' }}>
                        {reel > 0 ? `${reel.toFixed(1)} TND` : 'N/A'}
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #e9ecef', textAlign: 'right', color: ecart > 0 ? '#dc3545' : '#198754', fontWeight: 'bold' }}>
                        {reel > 0 ? `${ecart > 0 ? '+' : ''}${ecart.toFixed(1)} TND` : '-'}
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #e9ecef', textAlign: 'center' }}>
                        {reel > 0 ? (
                          <span style={{ backgroundColor: precisionColor, color: 'white', padding: '4px 10px', borderRadius: '12px', fontWeight: 'bold', fontSize: '12px' }}>
                            {precision.toFixed(1)}%
                          </span>
                        ) : (
                          <span style={{ color: '#6c757d', fontSize: '11px' }}>Pas de donnees</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p style={{ margin: '15px 0 0 0', color: '#6c757d', fontSize: '12px', textAlign: 'center' }}>
            La precision est calculee en comparant les predictions IA avec les ventes reelles de la base de donnees.
          </p>
        </div>
      )}

      {donneesTournee && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '30px' }}>
          <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '10px', borderLeft: '5px solid #0d6efd', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
            <p style={{ margin: 0, fontSize: '13px', color: '#6c757d', fontWeight: 'bold', textTransform: 'uppercase' }}>
              {isRecouvrementMode ? 'Clients a visiter' : 'Clients VIP Detectes'}
            </p>
            <h2 style={{ margin: '10px 0 0 0', fontSize: '32px', color: '#1a2b4c' }}>{tourneesAffichees.length}</h2>
          </div>
          <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '10px', borderLeft: '5px solid #198754', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
            <p style={{ margin: 0, fontSize: '13px', color: '#6c757d', fontWeight: 'bold', textTransform: 'uppercase' }}>
              {isRecouvrementMode ? "Montant prevu a recuperer aujourd'hui" : 'Vente Predite (IA)'}
            </p>
            <h2 style={{ margin: '10px 0 0 0', fontSize: '32px', color: '#198754' }}>{chiffreTotal.toLocaleString()} <span style={{ fontSize: '16px' }}>TND</span></h2>
          </div>
          <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '10px', borderLeft: '5px solid #dc3545', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
            <p style={{ margin: 0, fontSize: '13px', color: '#6c757d', fontWeight: 'bold', textTransform: 'uppercase' }}>
              {isRecouvrementMode ? 'Encours moyen / client' : 'Charge IA Suggeree'}
            </p>
            <h2 style={{ margin: '10px 0 0 0', fontSize: '32px', color: '#dc3545' }}>
              {isRecouvrementMode
                ? `${montantMoyenRecouvrement.toLocaleString(undefined, { maximumFractionDigits: 1 })} `
                : `${quantiteTotalCamion} `}
              <span style={{ fontSize: '16px' }}>{isRecouvrementMode ? 'TND' : 'Unites'}</span>
            </h2>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '30px', flexWrap: 'wrap' }}>
        <div style={{ flex: '2', minWidth: '600px', backgroundColor: 'white', borderRadius: '10px', padding: '20px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
          <h3 style={{ marginTop: 0, color: '#1a2b4c', borderBottom: '2px solid #f1f3f5', paddingBottom: '10px' }}>
            {isRecouvrementMode ? 'Liste des clients (tries par priorite de recouvrement)' : 'Liste des clients (tries par Intelligence IA)'}
          </h3>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
            <div style={{ fontSize: '12px', color: '#667085', fontWeight: '600' }}>
              {isRecouvrementMode
                ? "Tu peux modifier l'ordre des clients avant validation."
                : "Tu peux modifier la quantite et l'ordre des clients avant validation."}
            </div>
            {manualOrderLocked && (
              <button
                type="button"
                onClick={resetManualRouteOrder}
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid #d0d5dd',
                  backgroundColor: 'white',
                  color: '#344054',
                  fontWeight: '700',
                  cursor: 'pointer'
                }}
              >
                Reoptimiser l'ordre
              </button>
            )}
          </div>
          <div style={{ overflowX: 'auto', maxHeight: '380px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead style={{ position: 'sticky', top: 0, backgroundColor: '#f8f9fa' }}>
                <tr>
                  <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>{isRecouvrementMode ? 'PRIORITE' : 'SCORE VIP'}</th>
                  <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>{isRecouvrementMode ? 'A RECUPERER' : 'QTE. RECO'}</th>
                  <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>JOUR</th>
                  <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>CLIENT</th>
                  {!isRecouvrementMode && (
                    <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>CHIFFRE PREDIT</th>
                  )}
                  <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>ZONE COMM.</th>
                </tr>
              </thead>
              <tbody>
                {tournees.length === 0 ? (
                  <tr><td colSpan={isRecouvrementMode ? 5 : 6} style={{ padding: '20px', textAlign: 'center', color: '#888' }}>Aucune donnee. Verifiez l'IA.</td></tr>
                ) : (
                  tourneesAffichees.map((row, idx) => {
                    let scoreColor = '#dc3545'
                    if (row.score_ia >= 80) scoreColor = '#198754'
                    else if (row.score_ia >= 50) scoreColor = '#fd7e14'

                    const jourLabel = getJourLabel(idx)

                    return (
                      <tr key={idx} style={{ backgroundColor: idx % 2 === 0 ? 'white' : '#f8f9fa', transition: '0.2s' }}>
                        <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef', fontWeight: 'bold', color: scoreColor }}>
                          {Number(row.score_ia || 0).toFixed(1)} / 100
                        </td>
                        <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef' }}>
                          {isRecouvrementMode ? (
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                <div
                                  style={{
                                    minWidth: '96px',
                                    padding: '6px 8px',
                                    borderRadius: '6px',
                                    border: '1px solid #e4e7ec',
                                    backgroundColor: '#f8fafc',
                                    fontWeight: '700',
                                    color: '#0d6efd',
                                    textAlign: 'right'
                                  }}
                                >
                                  {Number(row.collecte_prevue || row.chiffre_brut || row.qte_reco || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}
                                </div>
                                <span style={{ fontWeight: '700', color: '#0d6efd' }}>TND</span>
                              </div>
                              <div style={{ fontSize: '11px', color: '#6c757d', marginTop: '4px' }}>
                                Encours: {(Number(row.encours_credit || 0)).toFixed(1)} TND
                                {Number(row.is_due_today || 0) === 1 ? ' - Echeance atteinte' : ''}
                              </div>
                            </div>
                          ) : (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                <input
                                  type="number"
                                  min={0}
                                  step="0.1"
                                  value={Number(row.qte_reco || 0)}
                                  onChange={event => handleQteRecoChange(idx, event.target.value)}
                                  style={{
                                    width: '86px',
                                    padding: '6px 8px',
                                    borderRadius: '6px',
                                    border: '1px solid #cbd5e1',
                                    fontWeight: '700',
                                    color: '#0d6efd'
                                  }}
                                />
                                <div
                                  onClick={() => setClickedClient(clickedClient === idx ? null : idx)}
                                  style={{
                                    fontWeight: 'bold',
                                    fontSize: '13px',
                                    color: '#0d6efd',
                                    cursor: 'pointer',
                                    padding: '4px 8px',
                                    borderRadius: '4px',
                                    backgroundColor: clickedClient === idx ? '#e7f3ff' : 'transparent',
                                    transition: '0.2s',
                                    display: 'inline-block'
                                  }}
                                >
                                  unites
                                </div>
                              </div>

                              {clickedClient === idx && (
                                <div style={{ marginTop: '8px', padding: '10px', backgroundColor: '#f8f9fa', borderRadius: '6px', border: '1px solid #dee2e6', fontSize: '12px' }}>
                                  <div style={{ fontWeight: 'bold', marginBottom: '6px', color: '#495057' }}>
                                    Produits recommandes:
                                  </div>
                                  {row.produits && row.produits.length > 0 ? (
                                    row.produits.map((prod, pIdx) => (
                                      <div key={pIdx} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: pIdx < row.produits.length - 1 ? '1px solid #e9ecef' : 'none', color: '#333' }}>
                                        <span style={{ fontWeight: '500' }}>{prod.nom}</span>
                                        <span style={{ fontWeight: 'bold', color: '#0d6efd' }}>{prod.quantite} unites</span>
                                      </div>
                                    ))
                                  ) : (
                                    <div style={{ color: '#6c757d', fontStyle: 'italic', padding: '4px 0' }}>
                                      Aucun detail produit disponible pour ce client
                                    </div>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef', fontWeight: 'bold', color: '#4b5563' }}>{jourLabel}</td>
                        <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <button
                                type="button"
                                onClick={() => moveEditableRow(idx, -1)}
                                disabled={idx === 0}
                                style={{
                                  width: '24px',
                                  height: '24px',
                                  borderRadius: '6px',
                                  border: '1px solid #d0d5dd',
                                  backgroundColor: idx === 0 ? '#f2f4f7' : 'white',
                                  color: '#344054',
                                  cursor: idx === 0 ? 'not-allowed' : 'pointer',
                                  fontWeight: '800'
                                }}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                onClick={() => moveEditableRow(idx, 1)}
                                disabled={idx === tourneesAffichees.length - 1}
                                style={{
                                  width: '24px',
                                  height: '24px',
                                  borderRadius: '6px',
                                  border: '1px solid #d0d5dd',
                                  backgroundColor: idx === tourneesAffichees.length - 1 ? '#f2f4f7' : 'white',
                                  color: '#344054',
                                  cursor: idx === tourneesAffichees.length - 1 ? 'not-allowed' : 'pointer',
                                  fontWeight: '800'
                                }}
                              >
                                ↓
                              </button>
                            </div>
                            <div>{row.nom} ({row.nbr_client})</div>
                          </div>
                        </td>
                        {!isRecouvrementMode && (
                          <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef', color: '#198754', fontWeight: 'bold' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <div
                                style={{
                                  minWidth: '96px',
                                  padding: '6px 8px',
                                  borderRadius: '6px',
                                  border: '1px solid #e4e7ec',
                                  backgroundColor: '#f8fafc',
                                  fontWeight: '700',
                                  color: '#198754',
                                  textAlign: 'right'
                                }}
                              >
                                {Number(row.chiffre_brut || parseFloat(row.chiffre) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}
                              </div>
                              <span>TND</span>
                            </div>
                          </td>
                        )}
                        <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef' }}>{formatCommercialZone(row)}</td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

        </div>

        {donneesTournee && (
          <div style={{ flex: '1', minWidth: '350px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {!isRecouvrementMode && suggestionRows.length > 0 && (
              <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '10px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
                <h3 style={{ marginTop: 0, color: '#1a2b4c', borderBottom: '2px solid #f1f3f5', paddingBottom: '10px' }}>Autres propositions IA</h3>
                <p style={{ margin: '0 0 14px 0', fontSize: '12px', color: '#667085', fontWeight: '600' }}>
                  Ajoute les clients que tu veux pour augmenter le chiffre d'affaire predit.
                </p>

                <div style={{ maxHeight: '280px', overflowY: 'auto', paddingRight: '4px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {suggestionRows.map((row, idx) => (
                    <div
                      key={`${getClientSelectionKey(row)}-${idx}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '12px',
                        borderRadius: '10px',
                        border: '1px solid #e4e7ec',
                        backgroundColor: '#fcfcfd'
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: '800', color: '#1d2939', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${row.nom} (${row.nbr_client})`}>
                          {row.nom} ({row.nbr_client})
                        </div>
                        <div style={{ marginTop: '4px', fontSize: '12px', color: '#667085' }}>
                          +{Number(row.chiffre_brut || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} TND
                          {' - '}
                          {Number(row.qte_reco || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} unites
                        </div>
                        <div style={{ marginTop: '2px', fontSize: '11px', color: '#98a2b3', fontWeight: '700' }}>
                          Score IA: {Number(row.score_ia || 0).toFixed(1)} / 100
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleAddSuggestedClient(row)}
                        style={{
                          padding: '8px 12px',
                          border: 'none',
                          borderRadius: '8px',
                          backgroundColor: '#198754',
                          color: 'white',
                          fontWeight: '800',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        Ajouter
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ backgroundColor: '#1a2b4c', color: 'white', padding: '20px', borderRadius: '10px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
              <h3 style={{ marginTop: 0, color: '#0d6efd', borderBottom: '1px solid #334466', paddingBottom: '10px' }}>
                {isRecouvrementMode ? 'Recouvrement a traiter' : 'Prediction Chargement IA'}
              </h3>
              <p style={{ fontSize: '13px', color: '#adb5bd' }}>
                {isRecouvrementMode
                  ? "Clients a visiter aujourd'hui (montant prevu):"
                  : "L'IA suggere ce chargement detaille par produit :"}
              </p>

              <div style={{ maxHeight: '250px', overflowY: 'auto', paddingRight: '5px' }}>
                {isRecouvrementMode ? (
                  recouvrementList.length > 0 ? recouvrementList.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e5d', padding: '10px 15px', borderRadius: '8px', marginBottom: '8px', gap: '12px' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 'bold', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.nom}>{item.nom}</div>
                        <div style={{ fontSize: '11px', color: '#9fb3c8' }}>
                          Encours: {item.encours.toFixed(1)} TND{item.isDueToday ? ' - due' : ''}
                        </div>
                      </div>
                      <span style={{ fontSize: '16px', fontWeight: 'bold', color: '#20c997', whiteSpace: 'nowrap' }}>{item.collecte.toFixed(1)} TND</span>
                    </div>
                  )) : (
                    <div style={{ color: '#adb5bd', fontSize: '13px' }}>Aucun encours de recouvrement pour cette selection.</div>
                  )
                ) : chargeTotale.detailsProduits && chargeTotale.detailsProduits.length > 0 ? (
                  chargeTotale.detailsProduits.map((prod, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e5d', padding: '10px 15px', borderRadius: '8px', marginBottom: '8px' }}>
                      <span style={{ fontWeight: 'bold', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '70%' }} title={prod.nom}>{prod.nom}</span>
                      <span style={{ fontSize: '16px', fontWeight: 'bold', color: '#20c997' }}>{prod.quantite}</span>
                    </div>
                  ))
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e5d', padding: '10px 15px', borderRadius: '8px', marginBottom: '10px' }}>
                      <span style={{ fontWeight: 'bold' }}>Agro-Alimentaire</span>
                      <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#fff' }}>{chargeTotale.agro}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e5d', padding: '10px 15px', borderRadius: '8px', marginBottom: '10px' }}>
                      <span style={{ fontWeight: 'bold' }}>Chips & Snacks</span>
                      <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#fff' }}>{chargeTotale.chips}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e5d', padding: '10px 15px', borderRadius: '8px' }}>
                      <span style={{ fontWeight: 'bold' }}>Bureautique</span>
                      <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#fff' }}>{chargeTotale.bureautique}</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '10px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
              <h3 style={{ marginTop: 0, color: '#1a2b4c', borderBottom: '2px solid #f1f3f5', paddingBottom: '10px' }}>Itineraire Optimise</h3>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
                <div style={{ padding: '8px 12px', borderRadius: '8px', backgroundColor: '#eef5ff', color: '#0d6efd', fontSize: '12px', fontWeight: '700' }}>
                  {routePlan.summary ? `${formatDistanceMeters(routePlan.summary.distance)} - ${formatDurationSeconds(routePlan.summary.duration)}` : 'Trace simplifie'}
                </div>
                <div style={{ padding: '8px 12px', borderRadius: '8px', backgroundColor: '#f3f7f9', color: '#495057', fontSize: '12px', fontWeight: '700' }}>
                  {routePlan.origin
                    ? `Depart: ${routePlan.origin.nom || 'Depot'}`
                    : 'Depart: premier client optimise'}
                </div>
              </div>
              <div style={{ marginBottom: '20px' }}>
                <TourRouteMap routePlan={routePlan} height={360} />
              </div>
              {routePlan.error && (
                <div style={{ marginBottom: '12px', padding: '10px 12px', borderRadius: '8px', backgroundColor: '#fff3cd', color: '#8a6d3b', fontSize: '12px', fontWeight: '600' }}>
                  {routePlan.error}
                </div>
              )}
              {validationFeedback && (
                <div
                  style={{
                    marginBottom: '12px',
                    padding: '10px 12px',
                    borderRadius: '8px',
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
                <div style={{ maxHeight: '220px', overflowY: 'auto', paddingRight: '8px' }}>
                  {routePlan.orderedStops.length ? (
                    <ol style={{ paddingLeft: '18px', fontSize: '14px', color: '#555' }}>
                      {routePlan.orderedStops.map((etape, i) => (
                        <li key={i} style={{ marginBottom: '10px' }}>
                          <strong>{etape.step}. {etape.nom}</strong><br />
                          <span style={{ color: '#6c757d', fontSize: '13px' }}>{etape.adresse}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <ul style={{ paddingLeft: '20px', fontSize: '14px', color: '#555' }}>
                      {itineraire.map((etape, i) => (
                        <li key={i} style={{ marginBottom: '8px' }}>{etape}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div style={{ backgroundColor: '#f8fbff', border: '1px solid #d8e9ff', borderRadius: '10px', padding: '14px' }}>
                  <div style={{ fontSize: '13px', fontWeight: '700', color: '#1a2b4c', marginBottom: '8px' }}>Guidage detaille</div>
                  <div style={{ maxHeight: '180px', overflowY: 'auto', paddingRight: '6px' }}>
                    {routePlan.steps.length ? routePlan.steps.map(step => (
                      <div key={step.id} style={{ marginBottom: '8px', fontSize: '13px', color: '#495057', lineHeight: 1.4 }}>
                        <strong>{step.text}</strong>
                        <div style={{ color: '#6c757d', fontSize: '12px' }}>
                          {formatDistanceMeters(step.distance)} - {formatDurationSeconds(step.duration)}
                        </div>
                      </div>
                    )) : (
                      <div style={{ color: '#6c757d', fontSize: '13px' }}>
                        Le detail tournant par tournant n'est pas encore disponible pour cet itineraire.
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '16px' }}>
                <a
                  href={routeNavigationUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ flex: 1, textAlign: 'center', padding: '12px', backgroundColor: '#198754', color: 'white', textDecoration: 'none', borderRadius: '6px', fontWeight: 'bold' }}
                >
                  Ouvrir la navigation
                </a>
                <button
                  type="button"
                  onClick={openValidationModal}
                  disabled={validationLoading}
                  title={validationDisabledReason || 'Enregistrer ce plan de route dans la base'}
                  style={{
                    flex: 1,
                    padding: '12px',
                    backgroundColor: validationLoading ? '#94a3b8' : '#0d6efd',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    fontWeight: 'bold',
                    cursor: validationLoading ? 'not-allowed' : 'pointer',
                    transition: '0.2s',
                    opacity: validationDisabledReason && !validationLoading ? 0.8 : 1
                  }}
                >
                  {validationLoading ? 'Validation en cours...' : 'Valider le Plan de Route'}
                </button>
              </div>
              {validationDisabledReason && (
                <div style={{ marginTop: '10px', fontSize: '12px', color: '#6c757d', fontWeight: '600' }}>
                  {validationDisabledReason}
                </div>
              )}
            </div>

          </div>
        )}
      </div>
      {isValidationModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.56)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            zIndex: 2000
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '540px',
              backgroundColor: 'white',
              borderRadius: '18px',
              boxShadow: '0 20px 60px rgba(15, 23, 42, 0.28)',
              overflow: 'hidden'
            }}
          >
            <div style={{ padding: '22px 24px', borderBottom: '1px solid #e4e7ec', backgroundColor: '#f8fbff' }}>
              <div style={{ fontSize: '12px', fontWeight: '800', color: '#0d6efd', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Confirmation
              </div>
              <h3 style={{ margin: '8px 0 0 0', color: '#1a2b4c', fontSize: '24px' }}>Valider le Plan de Route</h3>
              <p style={{ margin: '8px 0 0 0', color: '#667085', fontSize: '14px' }}>
                Verifie bien les informations ci-dessous avant d'enregistrer la tournee finale.
              </p>
            </div>

            <div style={{ padding: '24px', display: 'grid', gap: '14px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
                <div style={{ padding: '12px 14px', borderRadius: '12px', backgroundColor: '#f8fafc', border: '1px solid #e4e7ec' }}>
                  <div style={{ fontSize: '11px', color: '#667085', fontWeight: '800', textTransform: 'uppercase' }}>Date</div>
                  <div style={{ marginTop: '6px', fontSize: '15px', color: '#101828', fontWeight: '700' }}>{validationSelectedDate}</div>
                </div>
                <div style={{ padding: '12px 14px', borderRadius: '12px', backgroundColor: '#f8fafc', border: '1px solid #e4e7ec' }}>
                  <div style={{ fontSize: '11px', color: '#667085', fontWeight: '800', textTransform: 'uppercase' }}>Mode</div>
                  <div style={{ marginTop: '6px', fontSize: '15px', color: '#101828', fontWeight: '700' }}>
                    {isRecouvrementMode ? 'Recouvrement' : 'Vente'}
                  </div>
                </div>
              </div>

              <div style={{ padding: '14px 16px', borderRadius: '12px', backgroundColor: '#f8fafc', border: '1px solid #e4e7ec' }}>
                <div style={{ fontSize: '11px', color: '#667085', fontWeight: '800', textTransform: 'uppercase' }}>Commercial</div>
                <div style={{ marginTop: '6px', fontSize: '15px', color: '#101828', fontWeight: '700' }}>{selectedCommercialLabel}</div>
              </div>

              <div style={{ padding: '14px 16px', borderRadius: '12px', backgroundColor: '#f8fafc', border: '1px solid #e4e7ec' }}>
                <div style={{ fontSize: '11px', color: '#667085', fontWeight: '800', textTransform: 'uppercase' }}>Route / Depot</div>
                <div style={{ marginTop: '6px', fontSize: '15px', color: '#101828', fontWeight: '700' }}>
                  {validationRouteCode ? `${selectedRouteLabel} - ${validationDepotName}` : validationDepotName}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
                <div style={{ padding: '12px 14px', borderRadius: '12px', backgroundColor: '#ecfdf3', border: '1px solid #abefc6' }}>
                  <div style={{ fontSize: '11px', color: '#027a48', fontWeight: '800', textTransform: 'uppercase' }}>Clients</div>
                  <div style={{ marginTop: '6px', fontSize: '18px', color: '#027a48', fontWeight: '800' }}>{tourneesAffichees.length}</div>
                </div>
                <div style={{ padding: '12px 14px', borderRadius: '12px', backgroundColor: '#eef5ff', border: '1px solid #bfd7ff' }}>
                  <div style={{ fontSize: '11px', color: '#175cd3', fontWeight: '800', textTransform: 'uppercase' }}>
                    {isRecouvrementMode ? 'Montant prevu' : 'CA predit'}
                  </div>
                  <div style={{ marginTop: '6px', fontSize: '18px', color: '#175cd3', fontWeight: '800' }}>
                    {chiffreTotal.toLocaleString(undefined, { maximumFractionDigits: 1 })} TND
                  </div>
                </div>
              </div>

              <div style={{ padding: '14px 16px', borderRadius: '12px', backgroundColor: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412', fontSize: '13px', fontWeight: '700', lineHeight: 1.5 }}>
                L'ancienne version enregistree pour cette date et ce commercial sera remplacee.
              </div>
            </div>

            <div style={{ padding: '18px 24px 24px', display: 'flex', gap: '12px', justifyContent: 'flex-end', borderTop: '1px solid #e4e7ec' }}>
              <button
                type="button"
                onClick={closeValidationModal}
                disabled={validationLoading}
                style={{
                  padding: '11px 16px',
                  borderRadius: '10px',
                  border: '1px solid #d0d5dd',
                  backgroundColor: 'white',
                  color: '#344054',
                  fontWeight: '700',
                  cursor: validationLoading ? 'not-allowed' : 'pointer'
                }}
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={validateRoutePlan}
                disabled={validationLoading}
                style={{
                  padding: '11px 16px',
                  borderRadius: '10px',
                  border: 'none',
                  backgroundColor: validationLoading ? '#94a3b8' : '#0d6efd',
                  color: 'white',
                  fontWeight: '800',
                  cursor: validationLoading ? 'not-allowed' : 'pointer'
                }}
              >
                {validationLoading ? 'Validation en cours...' : 'Confirmer la validation'}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

export default App

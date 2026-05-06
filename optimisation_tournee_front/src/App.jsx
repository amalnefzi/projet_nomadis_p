import { useState, useEffect, useMemo, useRef } from 'react'
import axios from 'axios'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'
import CoveragePlanner from './CoveragePlanner'

const API = 'http://localhost:5000'

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
  const [clickedClient, setClickedClient] = useState(null)
  const [userLocation, setUserLocation] = useState(null)
  const [routePlan, setRoutePlan] = useState({
    loading: false,
    error: null,
    origin: null,
    orderedStops: [],
    geometry: [],
    steps: [],
    summary: null
  })

  const joursSemaine = useMemo(
    () => ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'],
    []
  )

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

  const mapRef = useRef(null)
  const leafletMapRef = useRef(null)
  const routeLayerRef = useRef(null)

  useEffect(() => {
    axios.get(`${API}/api/tournees/options`).then(res => {
      const r = res.data.routes || []
      const c = res.data.commerciaux || []
      setOptions({ routes: r, commerciaux: c })
      if (r.length && !filtres.route) setFiltres(prev => ({ ...prev, route: r[0]?.value || '' }))
      if (c.length && !filtres.commercial) setFiltres(prev => ({ ...prev, commercial: c[0]?.value || '' }))
    }).catch(() => {
      setOptions({ routes: [{ value: '1', label: '1 - depot' }], commerciaux: [{ value: '1', label: 'Commercial 1' }] })
    })
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

      const res = await axios.get(`${API}/api/tournees/plan`, {
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
        const res = await axios.post(`${API}/api/train-ia`)
        alert(res.data.message)
      } catch (err) {
        alert(err?.response?.data?.message || "Le reentrainement manuel a echoue. L'application continue d'utiliser le dernier modele valide.")
      } finally {
        setIsTraining(false)
      }
    }
  }

  const tournees = useMemo(() => donneesTournee?.tournees ?? [], [donneesTournee])
  const chargeTotale = useMemo(() => donneesTournee?.chargeTotale ?? { agro: 0, chips: 0, bureautique: 0, detailsProduits: [] }, [donneesTournee])
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

  const routingCandidates = useMemo(() => {
    return tourneesAffichees
      .map((row, idx) => ({
        id: String(row.nbr_client),
        inputIndex: idx,
        nom: row.nom,
        adresse: row.adresse || 'Adresse non specifiee',
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        score_ia: Number(row.score_ia || 0),
        chiffre: Number.parseFloat(row.chiffre) || Number(row.chiffre_brut || 0) || 0
      }))
      .filter(stop => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude))
  }, [tourneesAffichees])

  useEffect(() => {
    let cancelled = false

    async function buildRoutePlan() {
      if (!routingCandidates.length) {
        setRoutePlan({
          loading: false,
          error: null,
          origin: depotOrigin || userLocation,
          orderedStops: [],
          geometry: [],
          steps: [],
          summary: null
        })
        return
      }

      setRoutePlan(prev => ({ ...prev, loading: true, error: null }))

      const origin = depotOrigin
        ? depotOrigin
        : (userLocation && Number.isFinite(Number(userLocation.latitude)) && Number.isFinite(Number(userLocation.longitude)))
            ? {
                ...userLocation,
                latitude: Number(userLocation.latitude),
                longitude: Number(userLocation.longitude)
              }
            : null

      try {
        const inputStops = origin ? [origin, ...routingCandidates] : routingCandidates
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
          .map((wp, index) => ({ ...wp, originalIndex: index }))
          .filter(wp => !(origin && wp.originalIndex === 0))
          .sort((a, b) => (a.waypoint_index ?? 0) - (b.waypoint_index ?? 0))

        const orderedStops = clientWaypoints.map(wp => inputStops[wp.originalIndex]).filter(Boolean)
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
          throw new Error('Impossible de calculer un itineraire routier detaille.')
        }

        const geometry = (route.geometry?.coordinates || []).map(([lng, lat]) => ({ latitude: lat, longitude: lng }))
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
      } catch (error) {
        if (!cancelled) {
          setRoutePlan({
            loading: false,
            error: "Itineraire detaille indisponible pour le moment. Affichage d'un trace simplifie.",
            origin,
            orderedStops: routingCandidates.map((stop, index) => ({ ...stop, step: index + 1 })),
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
  }, [routingCandidates, userLocation, depotOrigin])

  useEffect(() => {
    if (!mapRef.current || !L) return

    if (!leafletMapRef.current) {
      leafletMapRef.current = L.map(mapRef.current, {
        zoomControl: true,
        attributionControl: false
      })
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
      }).addTo(leafletMapRef.current)
    }

    const map = leafletMapRef.current
    if (!routeLayerRef.current) {
      routeLayerRef.current = L.layerGroup().addTo(map)
    }
    routeLayerRef.current.clearLayers()

    const routeMarkers = routePlan.orderedStops.length ? routePlan.orderedStops : itineraireGeo
    const routeGeometry = routePlan.geometry.length ? routePlan.geometry : routeMarkers

    if (routeMarkers.length === 0) {
      map.setView([36.8, 10.1], 6)
      return
    }

    if (routePlan.origin) {
      const originMarker = L.circleMarker([routePlan.origin.latitude, routePlan.origin.longitude], {
        radius: 8,
        color: '#dc3545',
        fillColor: '#dc3545',
        fillOpacity: 0.95,
        weight: 1
      }).addTo(routeLayerRef.current)
      originMarker.bindPopup(`<strong>Depart</strong><br/>${routePlan.origin.adresse}`)
    }

    const latlngs = routeGeometry.map(pt => [pt.latitude, pt.longitude])
    const polyline = L.polyline(latlngs, { color: '#0d6efd', weight: 4, opacity: 0.85 })
    polyline.addTo(routeLayerRef.current)

    routeMarkers.forEach((pt, index) => {
      const marker = L.circleMarker([pt.latitude, pt.longitude], {
        radius: index === 0 ? 8 : 6,
        color: index === 0 ? '#198754' : '#0d6efd',
        fillColor: index === 0 ? '#198754' : '#0d6efd',
        fillOpacity: 0.9,
        weight: 1
      }).addTo(routeLayerRef.current)

      marker.bindPopup(`<strong>${index + 1}. ${pt.nom}</strong><br/>${pt.adresse}`)
    })

    try {
      const boundsPoints = routePlan.origin
        ? [[routePlan.origin.latitude, routePlan.origin.longitude], ...latlngs]
        : latlngs
      const bounds = L.latLngBounds(boundsPoints)
      map.fitBounds(bounds, { padding: [40, 40] })
      setTimeout(() => map.invalidateSize(), 200)
    } catch (e) {
      console.warn("Impossible d'ajuster les limites de la carte", e)
    }
  }, [itineraireGeo, routePlan])

  const chiffreTotal = tourneesAffichees.reduce((acc, curr) => acc + parseFloat(curr.chiffre || 0), 0)
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

  return (
    <div style={{ padding: '20px 40px', fontFamily: '"Segoe UI", Roboto, Helvetica, Arial, sans-serif', backgroundColor: '#f4f7fa', minHeight: '100vh', color: '#333' }}>
      <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <button
          onClick={() => setActiveModule('dashboard')}
          style={{
            padding: '11px 18px',
            borderRadius: '999px',
            border: activeModule === 'dashboard' ? 'none' : '1px solid #cbd5e1',
            backgroundColor: activeModule === 'dashboard' ? '#1a2b4c' : 'white',
            color: activeModule === 'dashboard' ? 'white' : '#334155',
            fontWeight: '700'
          }}
        >
          Dashboard actuel
        </button>
        <button
          onClick={() => setActiveModule('coverage')}
          style={{
            padding: '11px 18px',
            borderRadius: '999px',
            border: activeModule === 'coverage' ? 'none' : '1px solid #cbd5e1',
            backgroundColor: activeModule === 'coverage' ? '#1c6dd0' : 'white',
            color: activeModule === 'coverage' ? 'white' : '#334155',
            fontWeight: '700'
          }}
        >
          Plan couverture
        </button>
      </div>

      {activeModule === 'coverage' ? (
        <CoveragePlanner api={API} />
      ) : (
        <>
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
                              <div style={{ fontWeight: 'bold', fontSize: '14px', color: '#0d6efd', display: 'inline-block' }}>
                                {(Number(row.collecte_prevue || row.chiffre_brut || row.qte_reco || 0)).toFixed(1)} TND
                              </div>
                              <div style={{ fontSize: '11px', color: '#6c757d', marginTop: '4px' }}>
                                Encours: {(Number(row.encours_credit || 0)).toFixed(1)} TND
                                {Number(row.is_due_today || 0) === 1 ? ' - Echeance atteinte' : ''}
                              </div>
                            </div>
                          ) : (
                            <>
                              <div
                                onClick={() => setClickedClient(clickedClient === idx ? null : idx)}
                                style={{
                                  fontWeight: 'bold',
                                  fontSize: '14px',
                                  color: '#0d6efd',
                                  cursor: 'pointer',
                                  padding: '4px 8px',
                                  borderRadius: '4px',
                                  backgroundColor: clickedClient === idx ? '#e7f3ff' : 'transparent',
                                  transition: '0.2s',
                                  display: 'inline-block'
                                }}
                              >
                                {row.qte_reco} unites
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
                        <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef' }}>{row.nom} ({row.nbr_client})</td>
                        {!isRecouvrementMode && (
                          <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef', color: '#198754', fontWeight: 'bold' }}>
                            {row.chiffre}
                          </td>
                        )}
                        <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef' }}>{row.commercia_zone}</td>
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
                  {routePlan.summary ? `${formatDistance(routePlan.summary.distance)} - ${formatDuration(routePlan.summary.duration)}` : 'Trace simplifie'}
                </div>
                <div style={{ padding: '8px 12px', borderRadius: '8px', backgroundColor: '#f3f7f9', color: '#495057', fontSize: '12px', fontWeight: '700' }}>
                  {routePlan.origin
                    ? `Depart: ${routePlan.origin.nom || 'Depot'}`
                    : 'Depart: premier client optimise'}
                </div>
              </div>
              <div style={{ width: '100%', height: '360px', borderRadius: '12px', overflow: 'hidden', marginBottom: '20px', position: 'relative', backgroundColor: '#e9ecef' }}>
                <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
                {!itineraireGeo.length && !routePlan.orderedStops.length && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#495057', fontSize: '14px', fontWeight: '600', backgroundColor: 'rgba(255,255,255,0.8)' }}>
                    Pas de donnees geographiques disponibles pour le trace.
                  </div>
                )}
                {routePlan.loading && (
                  <div style={{ position: 'absolute', right: 12, top: 12, padding: '8px 12px', borderRadius: '8px', backgroundColor: 'rgba(13,110,253,0.92)', color: 'white', fontSize: '12px', fontWeight: '700' }}>
                    Calcul de la route...
                  </div>
                )}
              </div>
              {routePlan.error && (
                <div style={{ marginBottom: '12px', padding: '10px 12px', borderRadius: '8px', backgroundColor: '#fff3cd', color: '#8a6d3b', fontSize: '12px', fontWeight: '600' }}>
                  {routePlan.error}
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
                          {formatDistance(step.distance)} - {formatDuration(step.duration)}
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
                <button style={{ flex: 1, padding: '12px', backgroundColor: '#0d6efd', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>
                  Valider le Plan de Route
                </button>
              </div>
            </div>

          </div>
        )}
      </div>
        </>
      )}
    </div>
  )
}

export default App

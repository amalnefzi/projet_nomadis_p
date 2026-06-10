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

export default function CoveragePlanner({ api }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [clickedClient, setClickedClient] = useState(null)
  const [options, setOptions] = useState({ commerciaux: [] })
  const [optionsLoading, setOptionsLoading] = useState(true)
  const [optionsError, setOptionsError] = useState(null)
  const [selectedCommercials, setSelectedCommercials] = useState([])
  const [resolvedApiBase, setResolvedApiBase] = useState(api)
  const [filters, setFilters] = useState({
    start_date: todayIsoDate(),
    period_days: '14',
    min_visits: '20',
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
      .filter(stop => stop.latitude != null && stop.longitude != null)
      .map((stop, index) => ({
        ...stop,
        latitude: Number(stop.latitude),
        longitude: Number(stop.longitude),
        step: index + 1
      }))

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

      const origin = selectedBlock.detail?.depot_origin || null

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

  const runPlanner = async () => {
    try {
      if (!selectedCommercials.length) {
        setError('Selectionne au moins un commercial.')
        return
      }
      setLoading(true)
      setError(null)
      const allCommercialsSelected = selectedCommercials.length === options.commerciaux.length
      const params = {
        start_date: filters.start_date,
        period_days: filters.period_days,
        min_visits: filters.min_visits,
        min_total_ca: filters.min_total_ca || undefined,
        commercials: allCommercialsSelected ? undefined : selectedCommercials
      }

      const apiCandidates = buildApiCandidates(resolvedApiBase || api)
      let response = null
      let lastError = null

      for (const candidate of apiCandidates) {
        try {
          response = await axios.get(`${candidate}/api/tournees/coverage-plan`, {
            params,
            timeout: 20000
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

      setPlanData(response.data)
      const firstBlock = response.data?.blocks?.[0]
      setSelectedBlockId(firstBlock ? firstBlock.id : null)
    } catch (plannerError) {
      setError(plannerError?.response?.data?.error || 'Impossible de generer le plan de couverture.')
    } finally {
      setLoading(false)
    }
  }

  const summary = planData?.summary || null
  const selectedRows = selectedBlock?.detail?.tournees || []
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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, color: '#1a2b4c', fontSize: '28px' }}>Plan Couverture</h1>
          <p style={{ margin: '6px 0 0 0', color: '#667085', maxWidth: '760px' }}>
            Generation automatique des blocks de tournee avec affectation proposee, couverture client sur la periode et detail GPS sans dimanche.
          </p>
        </div>
        <div style={{ padding: '10px 14px', borderRadius: '10px', backgroundColor: '#fff4de', color: '#9a6700', fontSize: '12px', fontWeight: '700' }}>
          Dimanche exclu automatiquement
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
            <label style={{ fontSize: '12px', fontWeight: '700', color: '#475467' }}>Min visite</label>
            <input
              type="number"
              min={1}
              value={filters.min_visits}
              onChange={event => setFilters(current => ({ ...current, min_visits: event.target.value }))}
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
                Lance la planification pour afficher les blocks.
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
                      </div>
                      <div style={{ padding: '10px 12px', borderRadius: '10px', backgroundColor: '#f8fafc' }}>
                        <div style={{ fontSize: '11px', color: '#667085', fontWeight: '700', textTransform: 'uppercase' }}>CA predit</div>
                        <div style={{ marginTop: '4px', fontSize: '22px', fontWeight: '800', color: '#198754' }}>{block.predicted_ca.toFixed(1)} TND</div>
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
                </div>
              </div>

              <div style={{ overflowX: 'auto', maxHeight: '420px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead style={{ position: 'sticky', top: 0, backgroundColor: '#f8fafc' }}>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #eaecf0', color: '#475467' }}>SCORE VIP</th>
                      <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #eaecf0', color: '#475467' }}>QTE. RECO</th>
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
                              {row.qte_reco} unites
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
                  <h3 style={{ margin: 0, color: '#60a5fa' }}>Prediction Chargement IA</h3>
                  <p style={{ margin: '8px 0 0 0', fontSize: '13px', color: '#c5d3e3' }}>
                    L'IA suggere ce chargement detaille par produit pour ce block.
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
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

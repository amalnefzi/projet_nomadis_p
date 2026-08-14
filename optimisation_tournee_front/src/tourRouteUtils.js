export function formatDurationSeconds(seconds) {
  const totalMinutes = Math.round((Number(seconds) || 0) / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours <= 0) return `${minutes} min`
  return `${hours} h ${minutes.toString().padStart(2, '0')}`
}

export function formatDurationMinutes(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') {
    return 'Non disponible'
  }

  const totalMinutes = Math.round(Number(minutes))
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) {
    return 'Non disponible'
  }

  const hours = Math.floor(totalMinutes / 60)
  const remainingMinutes = totalMinutes % 60
  if (hours <= 0) return `${remainingMinutes} min`
  return `${hours} h ${remainingMinutes.toString().padStart(2, '0')}`
}

export function formatDistanceMeters(meters) {
  const km = (Number(meters) || 0) / 1000
  return `${km.toFixed(km >= 10 ? 0 : 1)} km`
}

export function isValidCoordinate(latitude, longitude) {
  return Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
}

export function buildOsrmStepText(step) {
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

export function buildGoogleMapsUrl(origin, stops, { returnToOrigin = true } = {}) {
  const normalizedStops = Array.isArray(stops) ? stops.filter(stop => isValidCoordinate(stop?.latitude, stop?.longitude)) : []
  if (!normalizedStops.length) return '#'

  if (origin && isValidCoordinate(origin.latitude, origin.longitude)) {
    const destination = returnToOrigin ? origin : normalizedStops[normalizedStops.length - 1]
    const waypoints = returnToOrigin
      ? normalizedStops.map(stop => `${stop.latitude},${stop.longitude}`).join('|')
      : normalizedStops.slice(0, -1).map(stop => `${stop.latitude},${stop.longitude}`).join('|')

    return `https://www.google.com/maps/dir/?api=1&origin=${origin.latitude},${origin.longitude}&destination=${destination.latitude},${destination.longitude}&travelmode=driving${waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : ''}`
  }

  const destination = normalizedStops[normalizedStops.length - 1]
  const waypoints = normalizedStops
    .slice(0, -1)
    .map(stop => `${stop.latitude},${stop.longitude}`)
    .join('|')

  return `https://www.google.com/maps/dir/?api=1&destination=${destination.latitude},${destination.longitude}&travelmode=driving${waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : ''}`
}

export function buildTourRouteCacheKey({ commercialCode = '', date = '', origin = null, stops = [] } = {}) {
  const originPart = origin && isValidCoordinate(origin.latitude, origin.longitude)
    ? `origin:${String(origin.id || origin.nom || 'depot').trim()}:${Number(origin.latitude).toFixed(6)}:${Number(origin.longitude).toFixed(6)}`
    : 'origin:none'

  const stopsPart = (Array.isArray(stops) ? stops : [])
    .map(stop => {
      const id = String(stop?.client_id || stop?.id || stop?.client_code || '').trim()
      const lat = Number(stop?.latitude)
      const lng = Number(stop?.longitude)
      return `${id}:${Number.isFinite(lat) ? lat.toFixed(6) : 'na'}:${Number.isFinite(lng) ? lng.toFixed(6) : 'na'}`
    })
    .join('|')

  return [
    String(commercialCode || '').trim(),
    String(date || '').trim(),
    originPart,
    stopsPart
  ].join('::')
}

export function buildRouteStops(rawStops = []) {
  return (Array.isArray(rawStops) ? rawStops : []).map((stop, index) => ({
    id: String(stop?.id || stop?.client_id || stop?.client_code || `stop-${index + 1}`).trim(),
    client_id: String(stop?.client_id || stop?.id || '').trim() || null,
    client_code: String(stop?.client_code || '').trim() || null,
    nom: String(stop?.nom || stop?.client_name || stop?.name || stop?.client_code || `Client ${index + 1}`).trim(),
    adresse: String(stop?.adresse || stop?.address || 'Adresse non specifiee').trim(),
    latitude: Number(stop?.latitude),
    longitude: Number(stop?.longitude),
    originalIndex: index
  }))
}

export function buildRouteOrigin(rawOrigin = null) {
  if (!rawOrigin || !isValidCoordinate(rawOrigin.latitude, rawOrigin.longitude)) {
    return null
  }

  return {
    id: String(rawOrigin.id || rawOrigin.depot_code || rawOrigin.nom || 'depot').trim(),
    nom: String(rawOrigin.nom || 'Depot').trim(),
    adresse: String(rawOrigin.adresse || 'Depot').trim(),
    latitude: Number(rawOrigin.latitude),
    longitude: Number(rawOrigin.longitude)
  }
}

export function shouldRequestOsrmRoute({ selected = false, mappedStopsCount = 0, cacheKey = '', cache = null } = {}) {
  if (!selected) return false
  if (mappedStopsCount < 2) return false
  if (!cacheKey) return true
  return !(cache instanceof Map && cache.has(cacheKey))
}

export async function resolveOptimizedTourRoute({
  stops = [],
  origin = null,
  preserveOrder = false,
  httpClient,
  cache = null,
  cacheKey = ''
} = {}) {
  const normalizedStops = buildRouteStops(stops)
  const validStops = normalizedStops.filter(stop => isValidCoordinate(stop.latitude, stop.longitude))
  const invalidStops = normalizedStops.filter(stop => !isValidCoordinate(stop.latitude, stop.longitude))
  const normalizedOrigin = buildRouteOrigin(origin)

  const baseResult = {
    status: validStops.length >= 2 ? 'idle' : 'insufficient_gps',
    loading: false,
    error: null,
    origin: normalizedOrigin,
    orderedStops: validStops.map((stop, index) => ({ ...stop, step: index + 1 })),
    geometry: [],
    steps: [],
    summary: null,
    totalStopsCount: normalizedStops.length,
    mappedStopsCount: validStops.length,
    unmappedStopsCount: invalidStops.length,
    unmappedStops: invalidStops,
    hasReturnToDepot: Boolean(normalizedOrigin),
    fromCache: false
  }

  if (validStops.length < 2) {
    return baseResult
  }

  if (cacheKey && cache instanceof Map && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)
    return {
      ...cached,
      totalStopsCount: normalizedStops.length,
      mappedStopsCount: validStops.length,
      unmappedStopsCount: invalidStops.length,
      unmappedStops: invalidStops,
      fromCache: true
    }
  }

  try {
    let orderedStops = validStops

    if (!preserveOrder) {
      const tripInputStops = normalizedOrigin ? [normalizedOrigin, ...validStops] : validStops
      const tripCoordinates = tripInputStops.map(stop => `${stop.longitude},${stop.latitude}`).join(';')
      const tripResponse = await httpClient.get(
        `https://router.project-osrm.org/trip/v1/driving/${tripCoordinates}`,
        {
          params: normalizedOrigin
            ? { source: 'first', roundtrip: false, geometries: 'geojson', overview: 'false' }
            : { source: 'any', roundtrip: false, geometries: 'geojson', overview: 'false' }
        }
      )

      const waypoints = Array.isArray(tripResponse?.data?.waypoints) ? tripResponse.data.waypoints : []
      if (waypoints.length) {
        orderedStops = waypoints
          .map((waypoint, waypointIndex) => ({ waypoint, waypointIndex }))
          .filter(item => !(normalizedOrigin && item.waypointIndex === 0))
          .sort((left, right) => (left.waypoint.waypoint_index ?? 0) - (right.waypoint.waypoint_index ?? 0))
          .map(item => tripInputStops[item.waypointIndex])
          .filter(Boolean)
      }
    }

    const routeInputStops = normalizedOrigin
      ? [normalizedOrigin, ...orderedStops, normalizedOrigin]
      : orderedStops

    const routeCoordinates = routeInputStops.map(stop => `${stop.longitude},${stop.latitude}`).join(';')
    const routeResponse = await httpClient.get(
      `https://router.project-osrm.org/route/v1/driving/${routeCoordinates}`,
      {
        params: {
          steps: true,
          geometries: 'geojson',
          overview: 'full'
        }
      }
    )

    const route = routeResponse?.data?.routes?.[0]
    if (!route) {
      throw new Error('Impossible de calculer un itineraire routier detaille.')
    }

    const resolved = {
      status: 'ready',
      loading: false,
      error: null,
      origin: normalizedOrigin,
      orderedStops: orderedStops.map((stop, index) => ({ ...stop, step: index + 1 })),
      geometry: Array.isArray(route?.geometry?.coordinates)
        ? route.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude }))
        : [],
      steps: Array.isArray(route?.legs)
        ? route.legs.flatMap((leg, legIndex) => (
          Array.isArray(leg?.steps)
            ? leg.steps.map((step, stepIndex) => ({
                id: `${legIndex}-${stepIndex}`,
                text: buildOsrmStepText(step),
                distance: Number(step?.distance || 0),
                duration: Number(step?.duration || 0)
              }))
            : []
        ))
        : [],
      summary: {
        distance: Number(route?.distance || 0),
        duration: Number(route?.duration || 0)
      },
      totalStopsCount: normalizedStops.length,
      mappedStopsCount: validStops.length,
      unmappedStopsCount: invalidStops.length,
      unmappedStops: invalidStops,
      hasReturnToDepot: Boolean(normalizedOrigin),
      fromCache: false
    }

    if (cacheKey && cache instanceof Map) {
      cache.set(cacheKey, {
        ...resolved,
        unmappedStops: []
      })
    }

    return resolved
  } catch {
    return {
      ...baseResult,
      status: 'error',
      error: 'Itineraire detaille indisponible pour le moment. La liste des clients reste disponible.'
    }
  }
}

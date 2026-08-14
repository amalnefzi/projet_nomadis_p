import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './TourRouteMap.css'

function createNumberedMarker(label, color) {
  return L.divIcon({
    className: 'tour-route-marker-wrapper',
    html: `<div class="tour-route-marker" style="background:${color}">${label}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  })
}

export default function TourRouteMap({
  routePlan,
  height = 360,
  emptyMessage = 'Pas de donnees geographiques disponibles pour le trace.'
}) {
  const mapRef = useRef(null)
  const leafletMapRef = useRef(null)
  const routeLayerRef = useRef(null)

  useEffect(() => {
    if (!mapRef.current) return undefined

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
    const routeMarkers = Array.isArray(routePlan?.orderedStops) ? routePlan.orderedStops : []
    const fallbackPolyline = routePlan?.origin && routeMarkers.length
      ? [routePlan.origin, ...routeMarkers, ...(routePlan.hasReturnToDepot ? [routePlan.origin] : [])]
      : routeMarkers
    const routeGeometry = Array.isArray(routePlan?.geometry) && routePlan.geometry.length
      ? routePlan.geometry
      : fallbackPolyline

    if (routePlan?.origin) {
      const originMarker = L.marker(
        [routePlan.origin.latitude, routePlan.origin.longitude],
        { icon: createNumberedMarker('D', '#dc3545') }
      ).addTo(routeLayerRef.current)
      originMarker.bindPopup(`<strong>Depot</strong><br/>${routePlan.origin.nom || 'Depot'}<br/>${routePlan.origin.adresse || ''}`)
    }

    if (routeGeometry.length) {
      const latlngs = routeGeometry.map(point => [point.latitude, point.longitude])
      L.polyline(latlngs, { color: '#0d6efd', weight: 4, opacity: 0.85 }).addTo(routeLayerRef.current)
    }

    routeMarkers.forEach((point, index) => {
      const marker = L.marker(
        [point.latitude, point.longitude],
        { icon: createNumberedMarker(String(index + 1), '#2563eb') }
      ).addTo(routeLayerRef.current)
      marker.bindPopup(`<strong>${index + 1}. ${point.nom}</strong><br/>${point.adresse || 'Adresse non specifiee'}`)
    })

    const boundsPoints = [
      ...(routePlan?.origin ? [[routePlan.origin.latitude, routePlan.origin.longitude]] : []),
      ...routeGeometry.map(point => [point.latitude, point.longitude])
    ]

    if (boundsPoints.length) {
      try {
        map.fitBounds(L.latLngBounds(boundsPoints), { padding: [40, 40] })
        setTimeout(() => map.invalidateSize(), 80)
      } catch {
        map.setView([36.8, 10.1], 6)
      }
    } else {
      map.setView([36.8, 10.1], 6)
    }

    return undefined
  }, [routePlan])

  const isEmpty = !routePlan?.origin && !(Array.isArray(routePlan?.orderedStops) && routePlan.orderedStops.length)

  return (
    <div className="tour-route-map-shell" style={{ height }}>
      <div ref={mapRef} className="tour-route-map-canvas" />
      {isEmpty ? (
        <div className="tour-route-map-overlay">
          {emptyMessage}
        </div>
      ) : null}
      {routePlan?.loading ? (
        <div className="tour-route-map-status">
          Calcul de la route...
        </div>
      ) : null}
    </div>
  )
}

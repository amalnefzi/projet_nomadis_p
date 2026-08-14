import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import {
  buildRouteOrigin,
  buildRouteStops,
  buildTourRouteCacheKey,
  resolveOptimizedTourRoute
} from './tourRouteUtils'

const FRONTEND_TOUR_ROUTE_CACHE = new Map()

export function getFrontendTourRouteCache() {
  return FRONTEND_TOUR_ROUTE_CACHE
}

export default function useOptimizedTourRoute({
  selected = true,
  commercialCode = '',
  date = '',
  stops = [],
  origin = null,
  preserveOrder = false,
  httpClient = axios
} = {}) {
  const normalizedStops = useMemo(() => buildRouteStops(stops), [stops])
  const normalizedOrigin = useMemo(() => buildRouteOrigin(origin), [origin])
  const cacheKey = useMemo(
    () => buildTourRouteCacheKey({
      commercialCode,
      date,
      origin: normalizedOrigin,
      stops: normalizedStops
    }),
    [commercialCode, date, normalizedOrigin, normalizedStops]
  )

  const [routePlan, setRoutePlan] = useState({
    status: 'idle',
    loading: false,
    error: null,
    origin: normalizedOrigin,
    orderedStops: [],
    geometry: [],
    steps: [],
    summary: null,
    totalStopsCount: normalizedStops.length,
    mappedStopsCount: normalizedStops.filter(stop => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude)).length,
    unmappedStopsCount: normalizedStops.filter(stop => !Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)).length,
    unmappedStops: normalizedStops.filter(stop => !Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)),
    hasReturnToDepot: Boolean(normalizedOrigin),
    fromCache: false
  })

  useEffect(() => {
    let cancelled = false
    const abortController = new AbortController()

    async function loadRoute() {
      if (!selected) {
        setRoutePlan({
          status: 'idle',
          loading: false,
          error: null,
          origin: normalizedOrigin,
          orderedStops: [],
          geometry: [],
          steps: [],
          summary: null,
          totalStopsCount: normalizedStops.length,
          mappedStopsCount: normalizedStops.filter(stop => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude)).length,
          unmappedStopsCount: normalizedStops.filter(stop => !Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)).length,
          unmappedStops: normalizedStops.filter(stop => !Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)),
          hasReturnToDepot: Boolean(normalizedOrigin),
          fromCache: false
        })
        return
      }

      setRoutePlan(prev => ({
        ...prev,
        status: 'loading',
        loading: true,
        error: null,
        origin: normalizedOrigin
      }))

      const resolved = await resolveOptimizedTourRoute({
        stops: normalizedStops,
        origin: normalizedOrigin,
        preserveOrder,
        cache: FRONTEND_TOUR_ROUTE_CACHE,
        cacheKey,
        httpClient: {
          get: (url, config = {}) => httpClient.get(url, {
            ...config,
            signal: abortController.signal
          })
        }
      })

      if (cancelled) return
      setRoutePlan({
        ...resolved,
        loading: false
      })
    }

    loadRoute()

    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [cacheKey, httpClient, normalizedOrigin, normalizedStops, preserveOrder, selected])

  return {
    ...routePlan,
    cacheKey
  }
}

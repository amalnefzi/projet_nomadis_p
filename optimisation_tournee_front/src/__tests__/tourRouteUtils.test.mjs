import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTourRouteCacheKey,
  resolveOptimizedTourRoute,
  shouldRequestOsrmRoute
} from '../tourRouteUtils.js'

test('OSRM is requested only for the selected tour with enough GPS points', () => {
  const cache = new Map()
  const cacheKey = buildTourRouteCacheKey({
    commercialCode: 'C001',
    date: '2026-08-03',
    origin: { latitude: 36.8, longitude: 10.1 },
    stops: [{ client_id: '1', latitude: 36.81, longitude: 10.11 }, { client_id: '2', latitude: 36.82, longitude: 10.12 }]
  })

  assert.equal(shouldRequestOsrmRoute({ selected: false, mappedStopsCount: 2, cacheKey, cache }), false)
  assert.equal(shouldRequestOsrmRoute({ selected: true, mappedStopsCount: 1, cacheKey, cache }), false)
  assert.equal(shouldRequestOsrmRoute({ selected: true, mappedStopsCount: 2, cacheKey, cache }), true)
})

test('returning to the same tour reuses the frontend route cache', async () => {
  const cache = new Map()
  const calls = []
  const httpClient = {
    get: async url => {
      calls.push(url)
      if (url.includes('/trip/')) {
        return {
          data: {
            waypoints: [
              { waypoint_index: 0 },
              { waypoint_index: 0 },
              { waypoint_index: 1 }
            ]
          }
        }
      }

      return {
        data: {
          routes: [{
            distance: 12500,
            duration: 1800,
            geometry: {
              coordinates: [[10.1, 36.8], [10.11, 36.81], [10.12, 36.82], [10.1, 36.8]]
            },
            legs: [{
              steps: [{
                maneuver: { type: 'depart' },
                distance: 5000,
                duration: 600
              }]
            }]
          }]
        }
      }
    }
  }

  const params = {
    stops: [
      { client_id: '1', client_code: '00152', nom: 'Client A', latitude: 36.81, longitude: 10.11 },
      { client_id: '2', client_code: '152', nom: 'Client B', latitude: 36.82, longitude: 10.12 }
    ],
    origin: { id: 'depot-1', nom: 'Depot', latitude: 36.8, longitude: 10.1 },
    cache,
    cacheKey: 'tour-1',
    httpClient
  }

  const first = await resolveOptimizedTourRoute(params)
  const second = await resolveOptimizedTourRoute(params)

  assert.equal(first.status, 'ready')
  assert.equal(second.fromCache, true)
  assert.equal(calls.length, 2)
})

test('OSRM error keeps the client list available', async () => {
  const result = await resolveOptimizedTourRoute({
    stops: [
      { client_id: '1', client_code: '00152', nom: 'Client A', latitude: 36.81, longitude: 10.11 },
      { client_id: '2', client_code: '152', nom: 'Client B', latitude: 36.82, longitude: 10.12 }
    ],
    origin: { id: 'depot-1', nom: 'Depot', latitude: 36.8, longitude: 10.1 },
    httpClient: {
      get: async () => {
        throw new Error('OSRM down')
      }
    }
  })

  assert.equal(result.status, 'error')
  assert.equal(result.orderedStops.length, 2)
  assert.match(result.error, /liste des clients reste disponible/i)
})

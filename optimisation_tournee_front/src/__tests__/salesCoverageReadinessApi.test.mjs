import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchSalesCoverageReadiness,
  normalizeSalesCoverageReadinessStartDate,
  retrySalesCoverageReadiness
} from '../salesCoverageReadinessApi.js'

test('readiness retry posts exactly one request with the selected start date', async () => {
  const calls = []
  const axiosClient = {
    post: async (...args) => {
      calls.push(args)
      return { data: { status: 'building' } }
    }
  }

  const response = await retrySalesCoverageReadiness(
    axiosClient,
    'http://localhost:5010',
    '2026-08-27',
    20000
  )

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [
    'http://localhost:5010/api/tournees/next-best-visits/readiness/retry',
    {
      start_date: '2026-08-27'
    },
    {
      timeout: 20000
    }
  ])
  assert.deepEqual(response.data, { status: 'building' })
})

test('readiness fetch reuses the same normalized date parameter', async () => {
  const calls = []
  const axiosClient = {
    get: async (...args) => {
      calls.push(args)
      return { data: { status: 'ready' } }
    }
  }

  const response = await fetchSalesCoverageReadiness(
    axiosClient,
    'http://localhost:5010',
    '2026-08-28T09:30:00.000Z',
    15000
  )

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [
    'http://localhost:5010/api/tournees/next-best-visits/readiness',
    {
      timeout: 15000,
      params: {
        start_date: '2026-08-28'
      }
    }
  ])
  assert.deepEqual(response.data, { status: 'ready' })
})

test('readiness date normalization falls back to today when start date is absent', () => {
  assert.equal(normalizeSalesCoverageReadinessStartDate('2026-08-29T13:00:00Z'), '2026-08-29')
  assert.equal(normalizeSalesCoverageReadinessStartDate(''), '2026-08-24')
})

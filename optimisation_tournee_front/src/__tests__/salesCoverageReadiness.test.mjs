import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  buildSalesProfileReadinessViewModel
} from '../salesCoverageDetails.js'

test('UI building state disables Generate and enables automatic polling', () => {
  const viewModel = buildSalesProfileReadinessViewModel({
    loading: false,
    payload: {
      status: 'building',
      profile_snapshot: {
        status: 'building'
      }
    }
  })

  assert.equal(viewModel.status, 'building')
  assert.equal(viewModel.disableGenerate, true)
  assert.equal(viewModel.shouldPoll, true)
  assert.equal(viewModel.bannerMessage, 'Preparation en cours...')
})

test('UI missing and stale states keep automatic polling active', () => {
  const missingViewModel = buildSalesProfileReadinessViewModel({
    loading: false,
    payload: {
      status: 'missing'
    }
  })
  const staleViewModel = buildSalesProfileReadinessViewModel({
    loading: false,
    payload: {
      status: 'stale'
    }
  })

  assert.equal(missingViewModel.disableGenerate, true)
  assert.equal(missingViewModel.shouldPoll, true)
  assert.equal(missingViewModel.bannerMessage, 'Preparation en cours...')
  assert.equal(staleViewModel.disableGenerate, true)
  assert.equal(staleViewModel.shouldPoll, true)
  assert.equal(staleViewModel.bannerMessage, 'Preparation en cours...')
})

test('UI ready state enables Generate automatically', () => {
  const viewModel = buildSalesProfileReadinessViewModel({
    loading: false,
    payload: {
      status: 'ready',
      profile_snapshot: {
        status: 'ready'
      }
    }
  })

  assert.equal(viewModel.status, 'ready')
  assert.equal(viewModel.disableGenerate, false)
  assert.equal(viewModel.shouldPoll, false)
  assert.equal(viewModel.bannerMessage, null)
})

test('UI building to ready polling transition enables Generate automatically', () => {
  const buildingViewModel = buildSalesProfileReadinessViewModel({
    loading: false,
    payload: {
      status: 'building',
      profile_snapshot: {
        status: 'building'
      }
    }
  })
  const pollingViewModel = buildSalesProfileReadinessViewModel({
    loading: true,
    payload: {
      status: 'building',
      profile_snapshot: {
        status: 'building'
      }
    }
  })
  const readyViewModel = buildSalesProfileReadinessViewModel({
    loading: false,
    payload: {
      status: 'ready',
      profile_snapshot: {
        status: 'ready'
      }
    }
  })

  assert.equal(buildingViewModel.shouldPoll, true)
  assert.equal(buildingViewModel.disableGenerate, true)
  assert.equal(pollingViewModel.shouldPoll, false)
  assert.equal(pollingViewModel.disableGenerate, true)
  assert.equal(readyViewModel.shouldPoll, false)
  assert.equal(readyViewModel.disableGenerate, false)
  assert.equal(readyViewModel.bannerMessage, null)
})

test('UI keeps Generate enabled when a ready payload is being refreshed', () => {
  const viewModel = buildSalesProfileReadinessViewModel({
    loading: true,
    payload: {
      status: 'ready',
      profile_snapshot: {
        status: 'ready'
      }
    }
  })

  assert.equal(viewModel.ready, true)
  assert.equal(viewModel.disableGenerate, false)
  assert.equal(viewModel.statusLabel, null)
})

test('UI failed state exposes the real error and enables retry when idle', () => {
  const viewModel = buildSalesProfileReadinessViewModel({
    loading: false,
    payload: {
      status: 'failed',
      error: 'snapshot corrupted',
      profile_snapshot: {
        status: 'failed',
        latest_error_message: 'snapshot corrupted'
      }
    }
  })

  assert.equal(viewModel.status, 'failed')
  assert.equal(viewModel.disableGenerate, true)
  assert.equal(viewModel.canRetry, true)
  assert.equal(viewModel.latestErrorMessage, 'snapshot corrupted')
  assert.equal(viewModel.bannerMessage, 'snapshot corrupted')
})

test('UI failed state disables retry while a retry request is in flight', () => {
  const viewModel = buildSalesProfileReadinessViewModel({
    loading: true,
    payload: {
      status: 'failed',
      error: 'rebuild failed again',
      profile_snapshot: {
        status: 'failed',
        latest_error_message: 'rebuild failed again'
      }
    }
  })

  assert.equal(viewModel.status, 'failed')
  assert.equal(viewModel.disableGenerate, true)
  assert.equal(viewModel.canRetry, false)
  assert.equal(viewModel.bannerMessage, 'rebuild failed again')
})

test('SalesCoveragePlanner keeps retry UX focused on business actions only', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesCoveragePlanner.jsx'),
    'utf8'
  )

  assert.equal(source.includes('buildSalesProfileReadinessViewModel'), true)
  assert.equal(source.includes('retrySalesCoverageReadiness('), true)
  assert.equal(source.includes('readinessView.shouldPoll'), true)
  assert.equal(source.includes('setTimeout(() => {'), true)
  assert.equal(source.includes('Reessayer la preparation'), true)
  assert.equal(source.includes('disabled={!readinessView.canRetry}'), true)
  assert.equal(source.includes('readinessView.statusLabel || describeProfileSnapshotStatus(readinessStatus)'), false)
  assert.equal(source.includes('Preparation des profils requise'), false)
  assert.equal(source.includes('Preparation en cours...'), true)
  assert.equal(source.includes('readinessRequestSequenceRef'), true)
  assert.equal(source.includes('readinessContextKeyRef.current'), true)
  assert.equal(source.includes('latestErrorMessage'), false)
})

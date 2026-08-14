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

test('UI failed state stays blocked with a neutral preparation message', () => {
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
  assert.equal(viewModel.canRetry, false)
  assert.equal(viewModel.bannerMessage, 'Preparation en cours...')
})

test('SalesCoveragePlanner polls readiness without exposing technical lifecycle UI', () => {
  const source = fs.readFileSync(
    path.resolve('C:/Users/asus/Desktop/Projet_Nomadis/optimisation_tournee_front/src/SalesCoveragePlanner.jsx'),
    'utf8'
  )

  assert.equal(source.includes('buildSalesProfileReadinessViewModel'), true)
  assert.equal(source.includes('/api/tournees/next-best-visits/readiness/retry'), false)
  assert.equal(source.includes('readinessView.shouldPoll'), true)
  assert.equal(source.includes('setTimeout(() => {'), true)
  assert.equal(source.includes('Relancer la preparation'), false)
  assert.equal(source.includes('readinessView.statusLabel || describeProfileSnapshotStatus(readinessStatus)'), false)
  assert.equal(source.includes('Preparation des profils requise'), false)
  assert.equal(source.includes('Preparation en cours...'), true)
  assert.equal(source.includes('readinessRequestSequenceRef'), true)
})

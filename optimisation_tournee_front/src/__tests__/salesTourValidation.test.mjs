import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  buildSalesBlockValidationPayload,
  deriveSalesBlockValidationStatus,
  shouldApplySalesValidationResponse,
  shouldStartSalesValidationRequest
} from '../salesTourValidation.js'
import {
  buildSalesVisitFeedbackRecordIndex
} from '../salesCoverageDetails.js'

test('validation payload keeps one Sales V2 block only with exact identities and snapshot fields', () => {
  const payload = buildSalesBlockValidationPayload({
    slot_id: '2026-08-28::VL1900',
    date: '2026-08-28',
    day_label: 'Jeudi',
    commercial_code: 'VL1900',
    commercial_label: 'VL1900 - Centre',
    route_code: 'R-01',
    depot_code: 'DEP-9',
    depot_name: 'Depot Central',
    clients: [
      {
        client_id: '3406',
        client_code: '00959',
        client_name: 'MOHAMED BOMBONIERE',
        address: 'Rue 1',
        latitude: 36.8,
        longitude: 10.1,
        planned_visit_id: 'sv2_visit_a',
        predicted_ca: 136.6,
        predicted_ca_if_buy: 210.2,
        recommended_quantity: 8,
        predicted_quantity_if_buy: 11,
        purchase_prediction_score: 64.6,
        purchase_probability: 72.5,
        portfolio_status: 'due_now',
        basket_prediction_source: 'historical_pattern',
        recommended_products: [
          {
            product_code: '0007',
            product_label: 'Chips paprika',
            estimated_quantity: 3
          }
        ]
      }
    ]
  }, {
    orderedStops: [
      { client_id: '3406', client_code: '00959', step: 2 }
    ]
  })

  assert.deepEqual(payload, {
    block: {
      slot_id: '2026-08-28::VL1900',
      date: '2026-08-28',
      day_label: 'Jeudi',
      commercial_code: 'VL1900',
      commercial_label: 'VL1900 - Centre',
      route_code: 'R-01',
      depot_code: 'DEP-9',
      depot_name: 'Depot Central',
      clients: [
        {
          client_id: '3406',
          client_code: '00959',
          client_name: 'MOHAMED BOMBONIERE',
          adresse: 'Rue 1',
          latitude: 36.8,
          longitude: 10.1,
          rang: 2,
          planned_visit_id: 'sv2_visit_a',
          assigned_slot_id: '2026-08-28::VL1900',
          assigned_date: '2026-08-28',
          planned_date: '2026-08-28',
          candidate_date: '2026-08-28',
          commercial_code: 'VL1900',
          basket_prediction_source: 'historical_pattern',
          predicted_ca: 136.6,
          predicted_ca_if_buy: 210.2,
          recommended_quantity: 8,
          predicted_quantity_if_buy: 11,
          purchase_prediction_score: 64.6,
          purchase_probability: 72.5,
          portfolio_status: 'due_now',
          recommended_products: [
            {
              product_code: '0007',
              product_label: 'Chips paprika',
              estimated_quantity: 3
            }
          ],
          prediction_snapshot: null
        }
      ]
    }
  })
})

test('validation payload prefers OSRM order and falls back deterministically to the current block order', () => {
  const payload = buildSalesBlockValidationPayload({
    slot_id: '2026-08-29::S01',
    date: '2026-08-29',
    commercial_code: 'S01',
    commercial_label: 'Salah Ahmed',
    clients: [
      { client_id: '10', client_code: '00152', client_name: 'Client A' },
      { client_id: '20', client_code: '152', client_name: 'Client B' },
      { client_id: '30', client_code: '00030', client_name: 'Client C' }
    ]
  }, {
    orderedStops: [
      { client_id: '20', client_code: '152', step: 1 },
      { client_id: '10', client_code: '00152', step: 2 }
    ]
  })

  assert.deepEqual(
    payload.block.clients.map(client => client.rang),
    [2, 1, 3]
  )
})

test('validation payload keeps 00152 and 152 as distinct exact fallback identities', () => {
  const payload = buildSalesBlockValidationPayload({
    slot_id: '2026-08-30::S01',
    date: '2026-08-30',
    commercial_code: 'S01',
    commercial_label: 'Salah Ahmed',
    clients: [
      { client_code: '00152', client_name: 'Client 00152' },
      { client_code: '152', client_name: 'Client 152' }
    ]
  }, {
    orderedStops: [
      { client_code: '152', step: 1 },
      { client_code: '00152', step: 2 }
    ]
  })

  assert.deepEqual(
    payload.block.clients.map(client => client.client_code),
    ['00152', '152']
  )
  assert.deepEqual(
    payload.block.clients.map(client => client.rang),
    [2, 1]
  )
})

test('validation state restores honestly from pending feedback rows carrying the same tournee code', () => {
  const feedbackIndex = buildSalesVisitFeedbackRecordIndex([
    {
      planned_visit_id: 'sv2_visit_1',
      execution_status: 'pending',
      tournee_code: 'sales-v2-0001'
    },
    {
      planned_visit_id: 'sv2_visit_2',
      execution_status: 'pending',
      tournee_code: 'sales-v2-0001'
    }
  ])

  const restored = deriveSalesBlockValidationStatus([
    { plannedVisitId: 'sv2_visit_1' },
    { plannedVisitId: 'sv2_visit_2' }
  ], feedbackIndex)

  assert.deepEqual(restored, {
    validated: true,
    matchedCount: 2,
    totalCount: 2,
    tourneeCode: 'sales-v2-0001',
    message: 'Tournee deja validee (sales-v2-0001).'
  })
})

test('validation state stays blocked when feedback rows are missing or inconsistent', () => {
  const feedbackIndex = buildSalesVisitFeedbackRecordIndex([
    {
      planned_visit_id: 'sv2_visit_1',
      execution_status: 'pending',
      tournee_code: 'sales-v2-0001'
    },
    {
      planned_visit_id: 'sv2_visit_2',
      execution_status: 'pending',
      tournee_code: 'sales-v2-0002'
    }
  ])

  assert.equal(
    deriveSalesBlockValidationStatus(
      [
        { plannedVisitId: 'sv2_visit_1' },
        { plannedVisitId: 'sv2_missing' }
      ],
      feedbackIndex
    ).validated,
    false
  )

  assert.equal(
    deriveSalesBlockValidationStatus(
      [
        { plannedVisitId: 'sv2_visit_1' },
        { plannedVisitId: 'sv2_visit_2' }
      ],
      feedbackIndex
    ).validated,
    false
  )
})

test('validation request helpers prevent double post and ignore obsolete async responses', () => {
  assert.equal(
    shouldStartSalesValidationRequest({
      isSubmitting: true,
      validationPhase: 'idle',
      isValidated: false
    }),
    false
  )

  assert.equal(
    shouldStartSalesValidationRequest({
      isSubmitting: false,
      validationPhase: 'idle',
      isValidated: false,
      isRouteLoading: true
    }),
    false
  )

  assert.equal(
    shouldStartSalesValidationRequest({
      isSubmitting: false,
      validationPhase: 'idle',
      isValidated: false,
      isRouteLoading: false
    }),
    true
  )

  assert.equal(
    shouldApplySalesValidationResponse({
      requestId: 2,
      activeRequestId: 2,
      requestScopeKey: 'plan-a::block-1',
      activeScopeKey: 'plan-b::block-2',
      isMounted: true
    }),
    false
  )

  assert.equal(
    shouldApplySalesValidationResponse({
      requestId: 3,
      activeRequestId: 3,
      requestScopeKey: 'plan-a::block-1',
      activeScopeKey: 'plan-a::block-1',
      isMounted: true
    }),
    true
  )
})

test('sales v2 validation guard blocks the button and the POST while route calculation is running', () => {
  const detailsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesTourDetails.jsx'),
    'utf8'
  )
  const handleValidateTourSection = detailsSource
    .split('const handleValidateTour = useCallback(async () => {')[1]
    .split('const response = await axios.post(')[0]

  assert.equal(detailsSource.includes("const validationBlockedByRouteLoading = Boolean(routePlan?.loading)"), true)
  assert.equal(detailsSource.includes("const validationButtonDisabled = validationRequestState.phase === 'validating' || effectiveValidated || validationBlockedByRouteLoading"), true)
  assert.equal(detailsSource.includes("disabled={validationButtonDisabled}"), true)
  assert.equal(detailsSource.includes("'Calcul de l itineraire en cours...'"), true)
  assert.equal(handleValidateTourSection.includes('isRouteLoading: routePlan?.loading'), true)
  assert.ok(
    handleValidateTourSection.indexOf('isRouteLoading: routePlan?.loading') >= 0
  )
})

test('sales v2 validation ui reopens validation as soon as route loading ends with the OSRM order', () => {
  const detailsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesTourDetails.jsx'),
    'utf8'
  )

  assert.equal(detailsSource.includes("const validationButtonLabel = validationRequestState.phase === 'validating'"), true)
  assert.equal(detailsSource.includes(": validationBlockedByRouteLoading"), true)
  assert.equal(detailsSource.includes(": 'Valider et enregistrer cette tournee'"), true)
  assert.equal(detailsSource.includes('const payload = buildSalesBlockValidationPayload(resolvedBlock, routePlan)'), true)
})

test('sales v2 validation ui allows deterministic fallback once loading is false even after OSRM or GPS issues', () => {
  const fallbackPayload = buildSalesBlockValidationPayload({
    slot_id: '2026-08-31::S01',
    date: '2026-08-31',
    commercial_code: 'S01',
    commercial_label: 'Salah Ahmed',
    clients: [
      { client_id: '10', client_code: '00152', client_name: 'Client A' },
      { client_id: '20', client_code: '152', client_name: 'Client B' }
    ]
  }, {
    loading: false,
    error: 'OSRM indisponible',
    orderedStops: []
  })

  assert.deepEqual(
    fallbackPayload.block.clients.map(client => client.rang),
    [1, 2]
  )

  assert.equal(
    shouldStartSalesValidationRequest({
      isSubmitting: false,
      validationPhase: 'idle',
      isValidated: false,
      isRouteLoading: false
    }),
    true
  )
})

test('sales v2 validation ui keeps feedback hidden before validation and activates it only from a real validated state', () => {
  const detailsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesTourDetails.jsx'),
    'utf8'
  )
  const panelSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesVisitFeedbackPanel.jsx'),
    'utf8'
  )
  const plannerSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'SalesCoveragePlanner.jsx'),
    'utf8'
  )

  assert.equal(detailsSource.includes('Valider et enregistrer cette tournee'), true)
  assert.equal(detailsSource.includes('Validation en cours...'), true)
  assert.equal(detailsSource.includes('Calcul de l itineraire en cours...'), true)
  assert.equal(detailsSource.includes("validationRequestState.phase === 'success' || restoredValidationState.validated"), true)
  assert.equal(detailsSource.includes('validated: effectiveValidated'), true)
  assert.equal(detailsSource.includes('submitGuardRef.current = true'), true)
  assert.equal(detailsSource.includes('shouldApplySalesValidationResponse'), true)
  assert.equal(panelSource.includes('Validez cette tournee avant de saisir le resultat des visites.'), true)
  assert.equal(panelSource.includes('feedbackEditable ? ('), true)
  assert.equal(plannerSource.includes('key={selectedBlockValidationKey}'), true)
})

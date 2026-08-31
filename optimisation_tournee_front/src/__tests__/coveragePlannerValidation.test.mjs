import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  buildCoverageBlockValidationPayload,
  buildCoverageBlockValidationScopeKey,
  shouldApplyCoverageValidationResponse,
  shouldStartCoverageValidationRequest
} from '../coveragePlannerDetails.js'

test('coverage validation payload matches the existing endpoint contract and keeps OSRM order', () => {
  const payload = buildCoverageBlockValidationPayload({
    slot_id: '2026-09-02::RC01',
    date: '2026-09-02',
    day_label: 'Mercredi',
    commercial_code: 'RC01',
    commercial_label: 'Recouvrement Centre',
    route_code: 'RC-09',
    clients: [
      {
        client_id: '3406',
        client_code: '00959',
        client_name: 'Client A',
        adresse: 'Rue 1',
        latitude: 36.8,
        longitude: 10.1
      },
      {
        client_id: '3407',
        client_code: '00152',
        client_name: 'Client B',
        adresse: 'Rue 2',
        latitude: 36.9,
        longitude: 10.2
      }
    ]
  }, {
    orderedStops: [
      { client_id: '3407', client_code: '00152', step: 1 },
      { client_id: '3406', client_code: '00959', step: 2 }
    ]
  }, {
    depotOrigin: {
      depot_code: 'DEP-3',
      nom: 'Depot Nord'
    },
    predictionRunCode: 'pred-coverage-77'
  })

  assert.deepEqual(payload, {
    date: '2026-09-02',
    day_label: 'Mercredi',
    commercial_code: 'RC01',
    commercial_label: 'Recouvrement Centre',
    route_code: 'RC-09',
    depot_code: 'DEP-3',
    depot_name: 'Depot Nord',
    prediction_run_code: 'pred-coverage-77',
    stops: [
      {
        client_id: '3406',
        client_code: '00959',
        client_name: 'Client A',
        adresse: 'Rue 1',
        latitude: 36.8,
        longitude: 10.1,
        rang: 2
      },
      {
        client_id: '3407',
        client_code: '00152',
        client_name: 'Client B',
        adresse: 'Rue 2',
        latitude: 36.9,
        longitude: 10.2,
        rang: 1
      }
    ]
  })
})

test('coverage validation helpers block double submit and ignore obsolete async responses', () => {
  assert.equal(
    shouldStartCoverageValidationRequest({
      isSubmitting: true,
      validationPhase: 'idle',
      isValidated: false
    }),
    false
  )

  assert.equal(
    shouldStartCoverageValidationRequest({
      isSubmitting: false,
      validationPhase: 'validating',
      isValidated: false
    }),
    false
  )

  assert.equal(
    shouldStartCoverageValidationRequest({
      isSubmitting: false,
      validationPhase: 'idle',
      isValidated: true
    }),
    false
  )

  assert.equal(
    shouldStartCoverageValidationRequest({
      isSubmitting: false,
      validationPhase: 'idle',
      isValidated: false
    }),
    true
  )

  assert.equal(
    shouldApplyCoverageValidationResponse({
      requestId: 4,
      activeRequestId: 4,
      requestScopeKey: 'scope-a',
      activeScopeKey: 'scope-b',
      isMounted: true
    }),
    false
  )

  assert.equal(
    shouldApplyCoverageValidationResponse({
      requestId: 5,
      activeRequestId: 5,
      requestScopeKey: 'scope-a',
      activeScopeKey: 'scope-a',
      isMounted: true
    }),
    true
  )
})

test('coverage validation scope keys stay distinct across blocks', () => {
  const firstKey = buildCoverageBlockValidationScopeKey({
    slot_id: 'slot-a',
    date: '2026-09-02',
    commercial_code: 'RC01',
    clients: [{ client_id: '1', client_code: '00152' }]
  })
  const secondKey = buildCoverageBlockValidationScopeKey({
    slot_id: 'slot-b',
    date: '2026-09-02',
    commercial_code: 'RC01',
    clients: [{ client_id: '1', client_code: '00152' }]
  })

  assert.notEqual(firstKey, secondKey)
})

test('coverage planner ui restores the validation button on the selected block and keeps state per block', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'CoveragePlanner.jsx'),
    'utf8'
  )

  assert.equal(source.includes("const [validationStateByBlockKey, setValidationStateByBlockKey] = useState({})"), true)
  assert.equal(source.includes('const selectedBlockValidationState = validationStateByBlockKey[selectedBlockValidationKey] || DEFAULT_COVERAGE_VALIDATION_STATE'), true)
  assert.equal(source.includes("const validationButtonDisabled = selectedBlockValidationState.phase === 'validating' || selectedBlockValidated"), true)
  assert.equal(source.includes("const validationButtonLabel = selectedBlockValidationState.phase === 'validating'"), true)
  assert.equal(source.includes('const payload = buildCoverageBlockValidationPayload('), true)
  assert.equal(source.includes('`${API_URL}/api/tournees/coverage-plan/validate`'), true)
  assert.equal(source.includes('onClick={handleValidateSelectedBlock}'), true)
  assert.equal(source.includes('selectedBlockHasClients ? ('), true)
  assert.equal(source.includes('Valider la tournee'), true)
  assert.equal(source.includes('Validation en cours...'), true)
  assert.equal(source.includes('Tournee validee'), true)
  assert.equal(source.includes('Code tournee :'), true)
})

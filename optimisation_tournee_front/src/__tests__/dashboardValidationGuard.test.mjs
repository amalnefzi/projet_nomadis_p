import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DASHBOARD_VALIDATION_COMMERCIAL_REQUIRED_MESSAGE,
  getDashboardCommercialValidationMessage,
  getDashboardValidationDisabledReason
} from '../dashboardValidationGuard.js'

test('exige un commercial pour la validation Dashboard en vente et en recouvrement', () => {
  assert.equal(
    getDashboardCommercialValidationMessage({
      modeTournee: 'vente',
      commercialCode: ''
    }),
    DASHBOARD_VALIDATION_COMMERCIAL_REQUIRED_MESSAGE
  )

  assert.equal(
    getDashboardCommercialValidationMessage({
      modeTournee: 'recouvrement',
      commercialCode: '   '
    }),
    DASHBOARD_VALIDATION_COMMERCIAL_REQUIRED_MESSAGE
  )
})

test("la validation Dashboard reste possible avec un commercial selectionne et n'affecte pas les autres modes", () => {
  assert.equal(
    getDashboardCommercialValidationMessage({
      modeTournee: 'vente',
      commercialCode: 'C-001'
    }),
    null
  )

  assert.equal(
    getDashboardCommercialValidationMessage({
      modeTournee: 'validation_lab',
      commercialCode: ''
    }),
    null
  )
})

test('le message commercial priorise le bouton final avant les autres blocages', () => {
  assert.equal(
    getDashboardValidationDisabledReason({
      validationLoading: false,
      stopCount: 0,
      modeTournee: 'vente',
      commercialCode: ''
    }),
    DASHBOARD_VALIDATION_COMMERCIAL_REQUIRED_MESSAGE
  )

  assert.equal(
    getDashboardValidationDisabledReason({
      validationLoading: false,
      stopCount: 0,
      modeTournee: 'vente',
      commercialCode: 'C-001'
    }),
    'Aucun client a enregistrer pour ce plan de route.'
  )
})

test("App garde l'ouverture du modal, le POST final et le disabled du bouton", () => {
  const source = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')
  const openValidationModalSection = source
    .split('const openValidationModal = () => {')[1]
    .split('const closeValidationModal = () => {')[0]
  const validateRoutePlanSection = source
    .split('const validateRoutePlan = async () => {')[1]
    .split('return (')[0]

  assert.equal(source.includes('disabled={Boolean(validationDisabledReason)}'), true)
  assert.equal(openValidationModalSection.includes('if (commercialValidationMessage) {'), true)
  assert.equal(openValidationModalSection.includes('setIsValidationModalOpen(true)'), true)
  assert.equal(validateRoutePlanSection.includes('if (commercialValidationMessage) {'), true)
  assert.ok(
    validateRoutePlanSection.indexOf('if (commercialValidationMessage) {') <
      validateRoutePlanSection.indexOf('axios.post(`${API_URL}/api/tournees/plan/validate`, payload, {')
  )
})

import test from 'node:test'
import assert from 'node:assert/strict'

import { PLANNER_MODULES } from '../plannerModules.js'
import {
  VALIDATION_LAB_MODULE,
  buildPlannerModules,
  resolveValidationLabEnabled
} from '../validationLabConfig.js'

test('validation lab activation is disabled by default for production-like envs', () => {
  assert.equal(resolveValidationLabEnabled({ NODE_ENV: 'production' }), false)
  assert.equal(resolveValidationLabEnabled({ MODE: 'production' }), false)
  assert.equal(resolveValidationLabEnabled({ VITE_ENABLE_V2_VALIDATION_LAB: 'false' }), false)
})

test('validation lab activation is enabled in development or by explicit flag', () => {
  assert.equal(resolveValidationLabEnabled({ NODE_ENV: 'development' }), true)
  assert.equal(resolveValidationLabEnabled({ MODE: 'development' }), true)
  assert.equal(resolveValidationLabEnabled({ VITE_ENABLE_V2_VALIDATION_LAB: 'true' }), true)
})

test('planner modules include validation lab only when enabled', () => {
  const disabledModules = buildPlannerModules(PLANNER_MODULES, false)
  const enabledModules = buildPlannerModules(PLANNER_MODULES, true)

  assert.equal(disabledModules.some(module => module.id === VALIDATION_LAB_MODULE.id), false)
  assert.equal(enabledModules.some(module => module.id === VALIDATION_LAB_MODULE.id), true)
  assert.equal(enabledModules.at(-1).id, VALIDATION_LAB_MODULE.id)
})

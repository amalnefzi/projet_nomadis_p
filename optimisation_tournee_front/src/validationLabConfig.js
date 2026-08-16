import { PLANNER_MODULES } from './plannerModules.js'

const DEFAULT_ENV = (typeof import.meta !== 'undefined' && import.meta?.env)
  ? import.meta.env
  : {}

export const VALIDATION_LAB_MODULE = Object.freeze({
  id: 'validation_lab',
  label: 'V2 Intelligence Validation Lab'
})

export function resolveValidationLabEnabled(env = DEFAULT_ENV) {
  const nodeEnv = String(env?.NODE_ENV || env?.MODE || '').trim().toLowerCase()
  const explicitFlag = String(
    env?.ENABLE_V2_VALIDATION_LAB ??
    env?.VITE_ENABLE_V2_VALIDATION_LAB ??
    ''
  ).trim().toLowerCase()

  return nodeEnv === 'development' || explicitFlag === 'true'
}

export function buildPlannerModules(baseModules = PLANNER_MODULES, enabled = resolveValidationLabEnabled()) {
  return enabled
    ? [...baseModules, VALIDATION_LAB_MODULE]
    : [...baseModules]
}

export const validationLabEnabled = resolveValidationLabEnabled()

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const NEXT_BEST_VISIT_PROFILE_SCHEMA_VERSION = '2026-08-04-d3-profile-schema-v2'
const NEXT_BEST_VISIT_CADENCE_ALGORITHM_VERSION = '2026-08-04-d3-cadence-algorithm-v1'
const NEXT_BEST_VISIT_PREDICTION_MODEL_KEY_VERSION = '2026-08-04-d3-prediction-model-v1'
const NEXT_BEST_VISIT_PREDICTION_FEATURES_KEY_VERSION = '2026-08-04-d3-prediction-features-v1'
const NEXT_BEST_VISIT_PLAN_CACHE_KEY_VERSION = '2026-08-04-d3-plan-cache-v1'
const NOMADIS_FEATURE_STORE_STATE_TABLE = 'nomadis_feature_store_state'
const NOMADIS_FEATURE_STORE_STATE_KEY = 'active'

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }

  return JSON.stringify(value)
}

function hashVersionPayload(payload) {
  return crypto
    .createHash('sha1')
    .update(stableStringify(payload))
    .digest('hex')
}

function buildNextBestVisitSourceDataVersion(sourceFingerprint = {}) {
  return `sha1:${hashVersionPayload(sourceFingerprint).slice(0, 20)}`
}

function buildNextBestVisitProfileVersion({
  sourceDataVersion,
  historicalCutoffDate = null,
  profileSchemaVersion = NEXT_BEST_VISIT_PROFILE_SCHEMA_VERSION,
  cadenceAlgorithmVersion = NEXT_BEST_VISIT_CADENCE_ALGORITHM_VERSION
} = {}) {
  return `sha1:${hashVersionPayload({
    source_data_version: sourceDataVersion || 'missing',
    profile_schema_version: profileSchemaVersion || NEXT_BEST_VISIT_PROFILE_SCHEMA_VERSION,
    cadence_algorithm_version: cadenceAlgorithmVersion || NEXT_BEST_VISIT_CADENCE_ALGORITHM_VERSION,
    historical_cutoff_date: historicalCutoffDate || null
  }).slice(0, 20)}`
}

function buildArtifactVersionFromFiles(baseDir, fileNames = []) {
  const resolvedBaseDir = path.resolve(baseDir || '.')
  return `sha1:${hashVersionPayload(
    fileNames.map(fileName => {
      const resolvedPath = path.join(resolvedBaseDir, fileName)
      if (!fs.existsSync(resolvedPath)) {
        return {
          file_name: fileName,
          exists: false
        }
      }
      const stats = fs.statSync(resolvedPath)
      const contentHash = crypto
        .createHash('sha1')
        .update(fs.readFileSync(resolvedPath))
        .digest('hex')
      return {
        file_name: fileName,
        exists: true,
        size_bytes: Number(stats.size || 0),
        content_sha1: contentHash
      }
    })
  ).slice(0, 20)}`
}

function normalizeNullableText(value) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

function buildCanonicalServingFeaturesVersion({
  featureSchemaVersion = null,
  sourceDataWatermark = null,
  featureStateVersion = null
} = {}) {
  const normalizedSchemaVersion = normalizeNullableText(featureSchemaVersion)
  const normalizedWatermark = normalizeNullableText(sourceDataWatermark)
  const normalizedStateVersion = normalizeNullableText(featureStateVersion)
  if (!normalizedSchemaVersion) return null
  if (!normalizedWatermark || !normalizedStateVersion) {
    return normalizedSchemaVersion
  }
  return `sha1:${hashVersionPayload({
    feature_schema_version: normalizedSchemaVersion,
    source_data_watermark: normalizedWatermark,
    feature_state_version: normalizedStateVersion
  }).slice(0, 20)}`
}

async function readCanonicalFeatureStoreIdentity(queryAsync, {
  stateKey = NOMADIS_FEATURE_STORE_STATE_KEY
} = {}) {
  if (typeof queryAsync !== 'function') {
    return {
      state_key: stateKey,
      status: 'missing',
      feature_schema_version: null,
      feature_state_version: null,
      source_data_watermark: null,
      source_max_date: null,
      features_version: null
    }
  }

  const rows = await queryAsync(
    `
      SELECT
        state_key,
        status,
        active_feature_schema_version,
        active_feature_state_version,
        active_source_data_watermark,
        active_source_max_date
      FROM ${NOMADIS_FEATURE_STORE_STATE_TABLE}
      WHERE state_key = ?
      LIMIT 1
    `,
    [stateKey]
  )
  const row = Array.isArray(rows) && rows.length ? rows[0] : {}
  const featureSchemaVersion = normalizeNullableText(row.active_feature_schema_version)
  const featureStateVersion = normalizeNullableText(row.active_feature_state_version)
  const sourceDataWatermark = normalizeNullableText(row.active_source_data_watermark)
  return {
    state_key: normalizeNullableText(row.state_key) || stateKey,
    status: normalizeNullableText(row.status) || 'missing',
    feature_schema_version: featureSchemaVersion,
    feature_state_version: featureStateVersion,
    source_data_watermark: sourceDataWatermark,
    source_max_date: normalizeNullableText(row.active_source_max_date),
    features_version: buildCanonicalServingFeaturesVersion({
      featureSchemaVersion,
      sourceDataWatermark,
      featureStateVersion
    })
  }
}

function buildNextBestVisitPredictionModelVersion(baseDir) {
  return buildArtifactVersionFromFiles(baseDir, [
    'modele_nomadis_achat.pkl',
    'modele_nomadis_ca.pkl',
    'modele_nomadis_qte.pkl',
    'modele_nomadis_price.pkl',
    'precision.txt',
    NEXT_BEST_VISIT_PREDICTION_MODEL_KEY_VERSION
  ])
}

function buildNextBestVisitPredictionFeaturesVersion(baseDir) {
  return buildArtifactVersionFromFiles(baseDir, [
    'colonnes_ia.pkl',
    'colonnes_affectation.pkl',
    'classes_affectation.pkl',
    'dataset_features_clients_jour.csv',
    'daily_demand_history.csv',
    'master_dataset_v3.csv',
    NEXT_BEST_VISIT_PREDICTION_FEATURES_KEY_VERSION
  ])
}

module.exports = {
  NOMADIS_FEATURE_STORE_STATE_KEY,
  NOMADIS_FEATURE_STORE_STATE_TABLE,
  NEXT_BEST_VISIT_CADENCE_ALGORITHM_VERSION,
  NEXT_BEST_VISIT_PLAN_CACHE_KEY_VERSION,
  NEXT_BEST_VISIT_PREDICTION_FEATURES_KEY_VERSION,
  NEXT_BEST_VISIT_PREDICTION_MODEL_KEY_VERSION,
  NEXT_BEST_VISIT_PROFILE_SCHEMA_VERSION,
  buildArtifactVersionFromFiles,
  buildCanonicalServingFeaturesVersion,
  buildNextBestVisitPredictionFeaturesVersion,
  buildNextBestVisitPredictionModelVersion,
  buildNextBestVisitProfileVersion,
  buildNextBestVisitSourceDataVersion,
  hashVersionPayload,
  readCanonicalFeatureStoreIdentity,
  stableStringify
}

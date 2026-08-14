const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const {
  buildArtifactVersionFromFiles,
  buildCanonicalServingFeaturesVersion,
  hashVersionPayload,
  readCanonicalFeatureStoreIdentity
} = require('./next_best_visit_versions')
const {
  fetchSalesVisitFeedbackMonitoringRecords
} = require('./sales_visit_feedback_service')

const MODEL_ARTIFACT_FILES = [
  'modele_nomadis_achat.pkl',
  'modele_nomadis_ca.pkl',
  'modele_nomadis_qte.pkl',
  'modele_nomadis_price.pkl',
  'modele_nomadis_affectation.pkl',
  'colonnes_ia.pkl',
  'colonnes_affectation.pkl',
  'classes_affectation.pkl',
  'dataset_features_clients_jour.csv',
  'daily_demand_history.csv',
  'master_dataset_v3.csv',
  'preferences_clients_produits.csv',
  'precision.txt'
]

const FEATURE_ARTIFACT_FILES = [
  'colonnes_ia.pkl',
  'colonnes_affectation.pkl',
  'classes_affectation.pkl',
  'dataset_features_clients_jour.csv',
  'daily_demand_history.csv',
  'master_dataset_v3.csv'
]

const DEFAULT_MIN_VALID_FEEDBACK_ROWS = parsePositiveIntEnv(
  'SALES_V2_LEARNING_MIN_VALID_FEEDBACK_ROWS',
  30
)
const DEFAULT_HOLDOUT_RATIO = parseRatioEnv(
  'SALES_V2_LEARNING_HOLDOUT_RATIO',
  0.2
)
const DEFAULT_MIN_HOLDOUT_ROWS = parsePositiveIntEnv(
  'SALES_V2_LEARNING_MIN_HOLDOUT_ROWS',
  5
)
const DEFAULT_PROMOTION_MIN_EVAL_OBSERVATIONS = parsePositiveIntEnv(
  'SALES_V2_LEARNING_PROMOTION_MIN_EVAL_OBSERVATIONS',
  10
)
const DEFAULT_PROMOTION_REGRESSION_ALLOWED_MAE_DEGRADATION = parseNonNegativeFloatEnv(
  'SALES_V2_LEARNING_PROMOTION_REGRESSION_ALLOWED_MAE_DEGRADATION',
  0
)
const DEFAULT_PROMOTION_REGRESSION_ALLOWED_RMSE_DEGRADATION = parseNonNegativeFloatEnv(
  'SALES_V2_LEARNING_PROMOTION_REGRESSION_ALLOWED_RMSE_DEGRADATION',
  0
)
const DEFAULT_PROMOTION_CLASSIFICATION_ALLOWED_LOGLOSS_DEGRADATION = parseNonNegativeFloatEnv(
  'SALES_V2_LEARNING_PROMOTION_CLASSIFICATION_ALLOWED_LOGLOSS_DEGRADATION',
  0
)
const DEFAULT_PROMOTION_CLASSIFICATION_ALLOWED_AUC_DEGRADATION = parseNonNegativeFloatEnv(
  'SALES_V2_LEARNING_PROMOTION_CLASSIFICATION_ALLOWED_AUC_DEGRADATION',
  0
)
const DEFAULT_PROMOTION_MIN_PRIMARY_IMPROVEMENT = parseNonNegativeFloatEnv(
  'SALES_V2_LEARNING_PROMOTION_MIN_PRIMARY_IMPROVEMENT',
  0
)
const DEFAULT_AUTO_LEARNING_CHECK_INTERVAL_MS = parsePositiveIntEnv(
  'SALES_V2_LEARNING_AUTO_CHECK_INTERVAL_MS',
  30 * 60 * 1000
)
const DEFAULT_AUTO_LEARNING_STARTUP_DELAY_MS = parsePositiveIntEnv(
  'SALES_V2_LEARNING_AUTO_STARTUP_DELAY_MS',
  15 * 1000
)

const PROMOTABLE_TARGETS = Object.freeze({
  purchase_probability: {
    candidate_file_name: 'modele_nomadis_achat_candidate.pkl',
    production_file_name: 'modele_nomadis_achat.pkl',
    metric_kind: 'classification'
  },
  ca_if_buy: {
    candidate_file_name: 'modele_nomadis_ca_candidate.pkl',
    production_file_name: 'modele_nomadis_ca.pkl',
    metric_kind: 'regression'
  },
  quantity_if_buy: {
    candidate_file_name: 'modele_nomadis_qte_candidate.pkl',
    production_file_name: 'modele_nomadis_qte.pkl',
    metric_kind: 'regression'
  }
})

let learningTablesPending = null
let automaticLearningCyclePromise = null

function parsePositiveIntEnv(name, fallbackValue) {
  const rawValue = String(process.env[name] || '').trim()
  if (!rawValue) return fallbackValue
  const parsed = Number.parseInt(rawValue, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue
}

function parseRatioEnv(name, fallbackValue) {
  const rawValue = String(process.env[name] || '').trim()
  if (!rawValue) return fallbackValue
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return fallbackValue
  }
  return parsed
}

function parseNonNegativeFloatEnv(name, fallbackValue) {
  const rawValue = String(process.env[name] || '').trim()
  if (!rawValue) return fallbackValue
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackValue
}

function normalizeDateOnly(value) {
  const normalized = String(value || '').trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null
}

function normalizeNullableText(value) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

function normalizeNullableNumber(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : null
}

function normalizeNullableIsoTimestamp(value) {
  if (value == null || value === '') return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

function normalizeNullableJsonObject(value) {
  const parsed = parsePredictionSnapshot(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function normalizeBoolean(value, fallbackValue = false) {
  if (typeof value === 'boolean') return value
  if (value == null || value === '') return fallbackValue
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'oui', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'non', 'off'].includes(normalized)) return false
  return fallbackValue
}

function parsePredictionSnapshot(value) {
  if (value == null || value === '') return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

function normalizeFeedbackLearningRecord(record = {}) {
  const snapshot = parsePredictionSnapshot(record.prediction_snapshot) || {}
  const executionStatus = normalizeNullableText(record.execution_status) || 'pending'
  const purchaseMade = record.purchase_made == null ? null : Boolean(record.purchase_made)

  return {
    planned_visit_id: normalizeNullableText(record.planned_visit_id),
    client_id: normalizeNullableText(record.client_id),
    client_code: normalizeNullableText(record.client_code),
    commercial_code: normalizeNullableText(record.commercial_code),
    planned_date: normalizeDateOnly(record.planned_date),
    created_at: normalizeNullableIsoTimestamp(record.created_at),
    updated_at: normalizeNullableIsoTimestamp(record.updated_at),
    execution_status: executionStatus,
    purchase_made: purchaseMade,
    actual_ca: normalizeNullableNumber(record.actual_ca),
    actual_quantity: normalizeNullableNumber(record.actual_quantity),
    prediction_snapshot: {
      predicted_ca: normalizeNullableNumber(snapshot.predicted_ca),
      predicted_ca_if_buy: normalizeNullableNumber(snapshot.predicted_ca_if_buy),
      recommended_quantity: normalizeNullableNumber(snapshot.recommended_quantity),
      predicted_quantity_if_buy: normalizeNullableNumber(snapshot.predicted_quantity_if_buy),
      priority: normalizeNullableNumber(snapshot.priority),
      portfolio_status: normalizeNullableText(snapshot.portfolio_status),
      planned_date: normalizeDateOnly(snapshot.planned_date),
      basket_prediction_source: normalizeNullableText(snapshot.basket_prediction_source),
      purchase_probability: normalizeNullableNumber(snapshot.purchase_probability)
    }
  }
}

function isPurchaseLearningEligible(record = {}) {
  return record.execution_status === 'visited' && record.purchase_made != null
}

function isConditionalCaLearningEligible(record = {}) {
  return record.execution_status === 'visited' &&
    record.purchase_made === true &&
    record.actual_ca != null
}

function isConditionalQuantityLearningEligible(record = {}) {
  return record.execution_status === 'visited' &&
    record.purchase_made === true &&
    record.actual_quantity != null
}

function sortLearningRecords(records = []) {
  return [...records].sort((left, right) => {
    const leftDate = String(left.planned_date || '')
    const rightDate = String(right.planned_date || '')
    if (leftDate !== rightDate) return leftDate.localeCompare(rightDate)
    return String(left.planned_visit_id || '').localeCompare(String(right.planned_visit_id || ''))
  })
}

function summarizeFeedbackAvailability(records = []) {
  const normalized = records.map(normalizeFeedbackLearningRecord)
  return normalized.reduce((summary, record) => {
    summary.feedback_rows_available += 1
    if (record.execution_status === 'pending') {
      summary.pending_rows += 1
    } else if (record.execution_status === 'not_visited') {
      summary.not_visited_rows += 1
    } else if (record.execution_status === 'visited') {
      summary.visited_rows += 1
    }

    if (isPurchaseLearningEligible(record)) {
      summary.purchase_rows += 1
    }
    if (isConditionalCaLearningEligible(record)) {
      summary.ca_rows += 1
    }
    if (isConditionalQuantityLearningEligible(record)) {
      summary.quantity_rows += 1
    }
    return summary
  }, {
    feedback_rows_available: 0,
    pending_rows: 0,
    not_visited_rows: 0,
    visited_rows: 0,
    purchase_rows: 0,
    ca_rows: 0,
    quantity_rows: 0
  })
}

function resolveLearningRecordMarker(record = {}) {
  const marker = normalizeNullableIsoTimestamp(record.updated_at) ||
    normalizeNullableIsoTimestamp(record.created_at)
  if (marker) return marker

  const plannedDate = normalizeDateOnly(record.planned_date)
  if (!plannedDate) return null
  return `${plannedDate}T00:00:00.000Z`
}

function buildLearningEligibleFeedbackState(records = [], cycleState = null) {
  const eligibleRecords = sortLearningRecords(
    records
      .map(normalizeFeedbackLearningRecord)
      .filter(isPurchaseLearningEligible)
  )
  const feedbackSignature = eligibleRecords.length
    ? hashVersionPayload(eligibleRecords.map(record => ({
        planned_visit_id: record.planned_visit_id,
        client_code: record.client_code,
        commercial_code: record.commercial_code,
        planned_date: record.planned_date,
        execution_status: record.execution_status,
        purchase_made: record.purchase_made,
        actual_ca: record.actual_ca,
        actual_quantity: record.actual_quantity,
        marker: resolveLearningRecordMarker(record)
      })))
    : null

  const feedbackCutoffUsed = eligibleRecords.reduce((latest, record) => {
    const marker = resolveLearningRecordMarker(record)
    if (!marker) return latest
    return !latest || marker > latest ? marker : latest
  }, null)

  const processedCutoff = normalizeNullableIsoTimestamp(cycleState?.feedback_cutoff_used)
  const processedSignature = normalizeNullableText(cycleState?.processed_feedback_signature)
  const failedSignature = normalizeNullableText(cycleState?.failed_feedback_signature)
  const sameProcessedFeedback = Boolean(processedSignature && feedbackSignature && processedSignature === feedbackSignature)
  const sameFailedFeedback = Boolean(failedSignature && feedbackSignature && failedSignature === feedbackSignature)
  const newValidFeedbackCount = eligibleRecords.reduce((count, record) => {
    const marker = resolveLearningRecordMarker(record)
    if (!processedCutoff) return count + 1
    if (marker && marker > processedCutoff) return count + 1
    return count
  }, 0)

  return {
    eligible_records: eligibleRecords,
    valid_feedback_rows_available: eligibleRecords.length,
    feedback_signature: feedbackSignature,
    feedback_cutoff_used: feedbackCutoffUsed,
    new_valid_feedback_count: sameProcessedFeedback ? 0 : newValidFeedbackCount,
    same_processed_feedback: sameProcessedFeedback,
    same_failed_feedback: sameFailedFeedback
  }
}

function splitLearningHoldout(records = [], {
  holdoutRatio = DEFAULT_HOLDOUT_RATIO,
  minHoldoutRows = DEFAULT_MIN_HOLDOUT_ROWS
} = {}) {
  const orderedRecords = sortLearningRecords(records)
  if (orderedRecords.length <= 1) {
    return {
      train_rows: orderedRecords,
      holdout_rows: []
    }
  }

  const requestedHoldout = Math.max(
    Number(minHoldoutRows || DEFAULT_MIN_HOLDOUT_ROWS),
    Math.ceil(orderedRecords.length * Number(holdoutRatio || DEFAULT_HOLDOUT_RATIO))
  )
  const holdoutCount = Math.min(
    Math.max(1, requestedHoldout),
    orderedRecords.length - 1
  )
  const splitIndex = orderedRecords.length - holdoutCount

  return {
    train_rows: orderedRecords.slice(0, splitIndex),
    holdout_rows: orderedRecords.slice(splitIndex)
  }
}

function deriveCurrentModelMetadataFromFeatureIdentity(baseDir, featureIdentity = {}) {
  const resolvedBaseDir = path.resolve(baseDir || __dirname)
  const featureSchemaVersion = normalizeNullableText(featureIdentity.feature_schema_version)
  const featureStateVersion = normalizeNullableText(featureIdentity.feature_state_version)
  const sourceDataWatermark = normalizeNullableText(featureIdentity.source_data_watermark)
  return {
    status: 'current',
    model_version: buildArtifactVersionFromFiles(resolvedBaseDir, MODEL_ARTIFACT_FILES),
    feature_schema_version: featureSchemaVersion,
    features_version: buildCanonicalServingFeaturesVersion({
      featureSchemaVersion,
      featureStateVersion,
      sourceDataWatermark
    }) || featureSchemaVersion,
    feature_state_version: featureStateVersion,
    source_data_watermark: sourceDataWatermark,
    source_max_date: normalizeDateOnly(featureIdentity.source_max_date),
    feature_store_status: normalizeNullableText(featureIdentity.status),
    trained_at: findLatestArtifactTimestamp(resolvedBaseDir, MODEL_ARTIFACT_FILES)
  }
}

async function loadCurrentModelMetadata(queryAsync, baseDir) {
  const featureIdentity = await readCanonicalFeatureStoreIdentity(queryAsync)
  return deriveCurrentModelMetadataFromFeatureIdentity(baseDir, featureIdentity)
}

function findLatestArtifactTimestamp(baseDir, fileNames = []) {
  const timestamps = fileNames
    .map(fileName => path.join(baseDir, fileName))
    .filter(filePath => fs.existsSync(filePath))
    .map(filePath => {
      const stats = fs.statSync(filePath)
      return new Date(stats.mtimeMs).toISOString()
    })
    .sort()
  return timestamps.length ? timestamps[timestamps.length - 1] : null
}

function buildCandidateVersion({
  currentModelVersion,
  featureSchemaVersion,
  feedbackRowsUsed,
  trainingDataCutoff
} = {}) {
  return `candidate:${hashVersionPayload({
    current_model_version: currentModelVersion || 'missing',
    feature_schema_version: featureSchemaVersion || 'missing',
    feedback_rows_used: Number(feedbackRowsUsed || 0),
    training_data_cutoff: trainingDataCutoff || null
  }).slice(0, 20)}`
}

function buildCandidateArtifactsDirectory(baseDir, candidateVersion) {
  return path.join(
    path.resolve(baseDir || __dirname),
    'candidate_models',
    encodeVersionPathSegment(candidateVersion)
  )
}

function encodeVersionPathSegment(versionValue) {
  const normalizedVersion = normalizeNullableText(versionValue) || 'unknown'
  return encodeURIComponent(normalizedVersion)
}

function buildModelArchiveDirectory(baseDir, modelVersion) {
  return path.join(
    path.resolve(baseDir || __dirname),
    'model_archives',
    encodeVersionPathSegment(modelVersion)
  )
}

function resolvePromotionPolicy(overrides = {}) {
  return {
    minimum_evaluation_observations: Math.max(
      1,
      Number.parseInt(
        overrides.minimum_evaluation_observations ?? DEFAULT_PROMOTION_MIN_EVAL_OBSERVATIONS,
        10
      ) || DEFAULT_PROMOTION_MIN_EVAL_OBSERVATIONS
    ),
    regression_allowed_mae_degradation: Math.max(
      0,
      Number(overrides.regression_allowed_mae_degradation ?? DEFAULT_PROMOTION_REGRESSION_ALLOWED_MAE_DEGRADATION) || 0
    ),
    regression_allowed_rmse_degradation: Math.max(
      0,
      Number(overrides.regression_allowed_rmse_degradation ?? DEFAULT_PROMOTION_REGRESSION_ALLOWED_RMSE_DEGRADATION) || 0
    ),
    classification_allowed_logloss_degradation: Math.max(
      0,
      Number(overrides.classification_allowed_logloss_degradation ?? DEFAULT_PROMOTION_CLASSIFICATION_ALLOWED_LOGLOSS_DEGRADATION) || 0
    ),
    classification_allowed_auc_degradation: Math.max(
      0,
      Number(overrides.classification_allowed_auc_degradation ?? DEFAULT_PROMOTION_CLASSIFICATION_ALLOWED_AUC_DEGRADATION) || 0
    ),
    minimum_primary_improvement: Math.max(
      0,
      Number(overrides.minimum_primary_improvement ?? DEFAULT_PROMOTION_MIN_PRIMARY_IMPROVEMENT) || 0
    ),
    primary_metrics: {
      purchase_probability: 'logloss',
      ca_if_buy: 'mae',
      quantity_if_buy: 'mae'
    },
    secondary_metrics: {
      purchase_probability: ['auc'],
      ca_if_buy: ['rmse'],
      quantity_if_buy: ['rmse']
    }
  }
}

function listPromotableTargets(candidate = {}) {
  const targets = Array.isArray(candidate.targets_retrained)
    ? candidate.targets_retrained.map(value => String(value).trim()).filter(Boolean)
    : []
  return targets.filter(targetName => PROMOTABLE_TARGETS[targetName])
}

function readNumericMetric(metrics = {}, metricName) {
  const value = metrics?.[metricName]
  return Number.isFinite(Number(value)) ? Number(value) : null
}

function readComparableCount(metrics = {}) {
  const comparableCount = metrics?.comparable_count
  return Number.isFinite(Number(comparableCount)) ? Number(comparableCount) : 0
}

function evaluatePromotionTarget({
  targetName,
  currentMetrics = {},
  candidateMetrics = {},
  policy = resolvePromotionPolicy()
} = {}) {
  const targetConfig = PROMOTABLE_TARGETS[targetName]
  if (!targetConfig) {
    return {
      target: targetName,
      status: 'incompatible_target',
      reason: 'unknown_target'
    }
  }

  const comparableCount = readComparableCount(candidateMetrics)
  if (comparableCount < policy.minimum_evaluation_observations) {
    return {
      target: targetName,
      status: 'insufficient_evidence',
      reason: 'not_enough_observations',
      comparable_count: comparableCount,
      required_count: policy.minimum_evaluation_observations
    }
  }

  if (readComparableCount(currentMetrics) !== comparableCount) {
    return {
      target: targetName,
      status: 'ineligible',
      reason: 'holdout_mismatch',
      current_count: readComparableCount(currentMetrics),
      candidate_count: comparableCount
    }
  }

  const primaryMetricName = policy.primary_metrics[targetName]
  const primaryCurrent = readNumericMetric(currentMetrics, primaryMetricName)
  const primaryCandidate = readNumericMetric(candidateMetrics, primaryMetricName)
  if (primaryCurrent == null || primaryCandidate == null) {
    return {
      target: targetName,
      status: 'insufficient_evidence',
      reason: 'missing_primary_metric',
      primary_metric: primaryMetricName
    }
  }

  let notWorse = false
  let improved = false
  let primaryDelta = null
  const checks = []

  if (targetConfig.metric_kind === 'classification') {
    primaryDelta = Number((primaryCandidate - primaryCurrent).toFixed(6))
    notWorse = primaryDelta <= policy.classification_allowed_logloss_degradation
    improved = primaryDelta <= -policy.minimum_primary_improvement
    checks.push({
      metric: primaryMetricName,
      current: primaryCurrent,
      candidate: primaryCandidate,
      delta: primaryDelta,
      direction: 'lower_is_better',
      tolerance: policy.classification_allowed_logloss_degradation
    })

    const currentAuc = readNumericMetric(currentMetrics, 'auc')
    const candidateAuc = readNumericMetric(candidateMetrics, 'auc')
    if (currentAuc != null && candidateAuc != null) {
      const aucDelta = Number((candidateAuc - currentAuc).toFixed(6))
      checks.push({
        metric: 'auc',
        current: currentAuc,
        candidate: candidateAuc,
        delta: aucDelta,
        direction: 'higher_is_better',
        tolerance: policy.classification_allowed_auc_degradation
      })
      notWorse = notWorse && aucDelta >= -policy.classification_allowed_auc_degradation
      improved = improved || aucDelta >= policy.minimum_primary_improvement
    }
  } else {
    primaryDelta = Number((primaryCandidate - primaryCurrent).toFixed(6))
    notWorse = primaryDelta <= policy.regression_allowed_mae_degradation
    improved = primaryDelta <= -policy.minimum_primary_improvement
    checks.push({
      metric: primaryMetricName,
      current: primaryCurrent,
      candidate: primaryCandidate,
      delta: primaryDelta,
      direction: 'lower_is_better',
      tolerance: policy.regression_allowed_mae_degradation
    })

    const currentRmse = readNumericMetric(currentMetrics, 'rmse')
    const candidateRmse = readNumericMetric(candidateMetrics, 'rmse')
    if (currentRmse != null && candidateRmse != null) {
      const rmseDelta = Number((candidateRmse - currentRmse).toFixed(6))
      checks.push({
        metric: 'rmse',
        current: currentRmse,
        candidate: candidateRmse,
        delta: rmseDelta,
        direction: 'lower_is_better',
        tolerance: policy.regression_allowed_rmse_degradation
      })
      notWorse = notWorse && rmseDelta <= policy.regression_allowed_rmse_degradation
      improved = improved || rmseDelta <= -policy.minimum_primary_improvement
    }
  }

  return {
    target: targetName,
    status: notWorse && improved ? 'eligible' : 'current_better',
    reason: notWorse
      ? (improved ? 'candidate_improves_metrics' : 'no_material_improvement')
      : 'candidate_degrades_metrics',
    comparable_count: comparableCount,
    primary_metric: primaryMetricName,
    checks
  }
}

function evaluateCandidatePromotionEligibility({
  candidate = null,
  currentModel = null,
  policy = resolvePromotionPolicy()
} = {}) {
  if (!candidate) {
    return {
      promotion_status: 'failed',
      decision_reason: 'candidate_missing',
      target_results: {}
    }
  }

  if (candidate.status !== 'candidate') {
    return {
      promotion_status: 'current_retained',
      decision_reason: 'candidate_not_promotable_status',
      target_results: {}
    }
  }

  if (candidate.comparison_status !== 'success') {
    return {
      promotion_status: 'current_retained',
      decision_reason: 'candidate_training_not_successful',
      target_results: {}
    }
  }

  if (!candidate.base_current_model_version || candidate.base_current_model_version !== currentModel?.model_version) {
    return {
      promotion_status: 'current_retained',
      decision_reason: 'current_model_version_mismatch',
      target_results: {}
    }
  }

  if (!candidate.feature_schema_version || candidate.feature_schema_version !== currentModel?.feature_schema_version) {
    return {
      promotion_status: 'current_retained',
      decision_reason: 'feature_schema_mismatch',
      target_results: {}
    }
  }

  const promotableTargets = listPromotableTargets(candidate)
  if (!promotableTargets.length) {
    return {
      promotion_status: 'insufficient_evidence',
      decision_reason: 'no_promotable_targets',
      target_results: {}
    }
  }

  const targetResults = {}
  for (const targetName of promotableTargets) {
    targetResults[targetName] = evaluatePromotionTarget({
      targetName,
      currentMetrics: candidate.current_model?.[targetName] || {},
      candidateMetrics: candidate.candidate_model?.[targetName] || {},
      policy
    })
  }

  const statuses = Object.values(targetResults).map(result => result.status)
  if (statuses.some(status => status === 'ineligible')) {
    return {
      promotion_status: 'current_retained',
      decision_reason: 'holdout_or_metric_incompatible',
      target_results: targetResults
    }
  }
  if (statuses.some(status => status === 'insufficient_evidence')) {
    return {
      promotion_status: 'insufficient_evidence',
      decision_reason: 'not_enough_target_evidence',
      target_results: targetResults
    }
  }
  if (statuses.every(status => status === 'eligible')) {
    return {
      promotion_status: 'promotable',
      decision_reason: 'all_targets_pass_policy',
      target_results: targetResults
    }
  }
  return {
    promotion_status: 'current_retained',
    decision_reason: 'one_or_more_targets_not_improved',
    target_results: targetResults
  }
}

function ensureDirectory(targetDirectory) {
  fs.mkdirSync(targetDirectory, { recursive: true })
}

function copyFile(sourcePath, targetPath) {
  ensureDirectory(path.dirname(targetPath))
  fs.copyFileSync(sourcePath, targetPath)
}

function copyArtifactBundle({ sourceDir, targetDir, fileNames = [] } = {}) {
  ensureDirectory(targetDir)
  for (const fileName of fileNames) {
    copyFile(path.join(sourceDir, fileName), path.join(targetDir, fileName))
  }
}

function listMissingArtifacts(baseDir, fileNames = []) {
  return fileNames.filter(fileName => !fs.existsSync(path.join(baseDir, fileName)))
}

function validateCandidateArtifacts(candidate = {}) {
  const artifactFiles = candidate?.artifact_manifest?.files || {}
  const missingTargets = []
  const validatedTargets = {}

  for (const targetName of listPromotableTargets(candidate)) {
    const targetConfig = PROMOTABLE_TARGETS[targetName]
    const artifactPath = artifactFiles[targetName]
    if (!artifactPath || !fs.existsSync(artifactPath)) {
      missingTargets.push(targetName)
      continue
    }
    validatedTargets[targetName] = {
      candidate_file_path: artifactPath,
      candidate_file_name: targetConfig.candidate_file_name,
      production_file_name: targetConfig.production_file_name
    }
  }

  return {
    ok: missingTargets.length === 0,
    missing_targets: missingTargets,
    validated_targets: validatedTargets
  }
}

function buildStagedProductionBundle({
  baseDir,
  currentModelVersion,
  candidate = {}
} = {}) {
  const resolvedBaseDir = path.resolve(baseDir || __dirname)
  const currentMissingArtifacts = listMissingArtifacts(resolvedBaseDir, MODEL_ARTIFACT_FILES)
  if (currentMissingArtifacts.length) {
    throw new Error(`Production artifacts missing: ${currentMissingArtifacts.join(', ')}`)
  }

  const validation = validateCandidateArtifacts(candidate)
  if (!validation.ok) {
    throw new Error(`Candidate artifacts missing: ${validation.missing_targets.join(', ')}`)
  }

  const stageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-v2-promote-stage-'))
  copyArtifactBundle({
    sourceDir: resolvedBaseDir,
    targetDir: stageDirectory,
    fileNames: MODEL_ARTIFACT_FILES
  })

  for (const targetConfig of Object.values(validation.validated_targets)) {
    copyFile(
      targetConfig.candidate_file_path,
      path.join(stageDirectory, targetConfig.production_file_name)
    )
  }

  const stagedModelVersion = buildArtifactVersionFromFiles(stageDirectory, MODEL_ARTIFACT_FILES)
  return {
    stage_directory: stageDirectory,
    current_model_version: currentModelVersion,
    staged_model_version: stagedModelVersion,
    validated_targets: validation.validated_targets
  }
}

function ensureCurrentModelArchived(baseDir, currentModelVersion) {
  const resolvedBaseDir = path.resolve(baseDir || __dirname)
  const archiveDirectory = buildModelArchiveDirectory(resolvedBaseDir, currentModelVersion)
  const missingArchivedArtifacts = listMissingArtifacts(archiveDirectory, MODEL_ARTIFACT_FILES)
  if (missingArchivedArtifacts.length) {
    copyArtifactBundle({
      sourceDir: resolvedBaseDir,
      targetDir: archiveDirectory,
      fileNames: MODEL_ARTIFACT_FILES
    })
  }

  const metadataPath = path.join(archiveDirectory, 'bundle_metadata.json')
  if (!fs.existsSync(metadataPath)) {
    fs.writeFileSync(metadataPath, JSON.stringify({
      model_version: currentModelVersion,
      archived_at: new Date().toISOString(),
      files: MODEL_ARTIFACT_FILES
    }, null, 2), 'utf8')
  }

  return archiveDirectory
}

function applyStagedProductionBundle(baseDir, stageDirectory) {
  const resolvedBaseDir = path.resolve(baseDir || __dirname)
  copyArtifactBundle({
    sourceDir: stageDirectory,
    targetDir: resolvedBaseDir,
    fileNames: MODEL_ARTIFACT_FILES
  })
}

function restoreArchivedProductionBundle(baseDir, modelVersion) {
  const resolvedBaseDir = path.resolve(baseDir || __dirname)
  const archiveDirectory = buildModelArchiveDirectory(resolvedBaseDir, modelVersion)
  const missingArchivedArtifacts = listMissingArtifacts(archiveDirectory, MODEL_ARTIFACT_FILES)
  if (missingArchivedArtifacts.length) {
    throw new Error(`Rollback archive missing artifacts for ${modelVersion}: ${missingArchivedArtifacts.join(', ')}`)
  }

  copyArtifactBundle({
    sourceDir: archiveDirectory,
    targetDir: resolvedBaseDir,
    fileNames: MODEL_ARTIFACT_FILES
  })

  return archiveDirectory
}

function cleanupDirectory(targetDirectory) {
  if (!targetDirectory || !fs.existsSync(targetDirectory)) return
  try {
    fs.rmSync(targetDirectory, { recursive: true, force: true })
  } catch {
    // Ignore cleanup issues in temp/archive staging paths.
  }
}

function createLearningRunnerPayload({
  currentModel,
  candidateVersion,
  trainRows,
  holdoutRows,
  minValidFeedbackRows,
  holdoutRatio,
  minHoldoutRows
} = {}) {
  return {
    current_model: currentModel,
    candidate_version: candidateVersion,
    train_rows: trainRows,
    holdout_rows: holdoutRows,
    config: {
      min_valid_feedback_rows: minValidFeedbackRows,
      holdout_ratio: holdoutRatio,
      min_holdout_rows: minHoldoutRows
    }
  }
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const wrappedError = new Error(stderr || stdout || error.message || 'Candidate training failed.')
        wrappedError.cause = error
        wrappedError.stdout = stdout
        wrappedError.stderr = stderr
        reject(wrappedError)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

async function runPythonCandidateTraining({
  payload,
  baseDir = __dirname,
  outputDir = null,
  pythonCommand = process.env.PYTHON_COMMAND || 'python'
} = {}) {
  const resolvedBaseDir = path.resolve(baseDir || __dirname)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-v2-candidate-'))
  const inputPath = path.join(tempDir, 'candidate_payload.json')
  const outputPath = path.join(tempDir, 'candidate_result.json')
  const scriptPath = path.join(resolvedBaseDir, 'train_candidate_feedback.py')

  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8')
  try {
    const args = [scriptPath, '--input', inputPath, '--output', outputPath]
    if (outputDir) {
      args.push('--artifacts-dir', outputDir)
    }
    await execFileAsync(pythonCommand, args, {
      cwd: resolvedBaseDir,
      maxBuffer: 10 * 1024 * 1024
    })
    const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    return parsed
  } finally {
    cleanupTempDirectory(tempDir)
  }
}

function cleanupTempDirectory(tempDir) {
  if (!tempDir || !fs.existsSync(tempDir)) return
  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // Ignore temp cleanup issues during candidate orchestration.
  }
}

function normalizeLearningResult(result = {}, fallback = {}) {
  return {
    status: normalizeNullableText(result.status) || 'failed',
    candidate_version: normalizeNullableText(result.candidate_version) || normalizeNullableText(fallback.candidate_version),
    trained_at: normalizeNullableText(result.trained_at),
    training_data_cutoff: normalizeDateOnly(result.training_data_cutoff || fallback.training_data_cutoff),
    feedback_rows_used: Number(result.feedback_rows_used || fallback.feedback_rows_used || 0),
    feedback_rows_holdout: Number(result.feedback_rows_holdout || fallback.feedback_rows_holdout || 0),
    holdout_window: result.holdout_window && typeof result.holdout_window === 'object'
      ? {
          start_date: normalizeDateOnly(result.holdout_window.start_date),
          end_date: normalizeDateOnly(result.holdout_window.end_date)
        }
      : null,
    targets_retrained: Array.isArray(result.targets_retrained)
      ? result.targets_retrained.map(value => String(value).trim()).filter(Boolean)
      : [],
    current_model: result.current_model && typeof result.current_model === 'object' ? result.current_model : null,
    candidate_model: result.candidate_model && typeof result.candidate_model === 'object' ? result.candidate_model : null,
    delta: result.delta && typeof result.delta === 'object' ? result.delta : {},
    recommendation: normalizeNullableText(result.recommendation) || 'insufficient_data',
    artifact_manifest: result.artifact_manifest && typeof result.artifact_manifest === 'object'
      ? result.artifact_manifest
      : null,
    metrics: result.metrics && typeof result.metrics === 'object' ? result.metrics : null,
    error: normalizeNullableText(result.error)
  }
}

async function ensureSalesLearningTables(queryAsync) {
  if (learningTablesPending) {
    return learningTablesPending
  }

  learningTablesPending = (async () => {
    await queryAsync(`
      CREATE TABLE IF NOT EXISTS sales_v2_learning_candidates (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        candidate_version VARCHAR(255) NOT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'candidate',
        base_current_model_version VARCHAR(255) DEFAULT NULL,
        feature_schema_version VARCHAR(255) DEFAULT NULL,
        trained_at DATETIME DEFAULT NULL,
        training_data_cutoff DATE DEFAULT NULL,
        holdout_start_date DATE DEFAULT NULL,
        holdout_end_date DATE DEFAULT NULL,
        feedback_rows_available INT DEFAULT NULL,
        feedback_rows_used INT DEFAULT NULL,
        feedback_rows_holdout INT DEFAULT NULL,
        targets_retrained_json LONGTEXT DEFAULT NULL,
        metrics_json LONGTEXT DEFAULT NULL,
        comparison_json LONGTEXT DEFAULT NULL,
        artifact_manifest_json LONGTEXT DEFAULT NULL,
        error_message TEXT DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY sales_v2_learning_candidates_version_unique (candidate_version),
        KEY sales_v2_learning_candidates_status_idx (status),
        KEY sales_v2_learning_candidates_trained_at_idx (trained_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await queryAsync(`
      CREATE TABLE IF NOT EXISTS sales_v2_learning_promotions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        action_type VARCHAR(64) NOT NULL,
        status VARCHAR(64) NOT NULL,
        candidate_version VARCHAR(255) DEFAULT NULL,
        previous_model_version VARCHAR(255) DEFAULT NULL,
        resulting_model_version VARCHAR(255) DEFAULT NULL,
        rollback_target_version VARCHAR(255) DEFAULT NULL,
        feature_schema_version VARCHAR(255) DEFAULT NULL,
        policy_json LONGTEXT DEFAULT NULL,
        evaluation_json LONGTEXT DEFAULT NULL,
        artifact_manifest_json LONGTEXT DEFAULT NULL,
        decision_reason TEXT DEFAULT NULL,
        error_message TEXT DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY sales_v2_learning_promotions_status_idx (status),
        KEY sales_v2_learning_promotions_action_idx (action_type),
        KEY sales_v2_learning_promotions_created_at_idx (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)

    await queryAsync(`
      CREATE TABLE IF NOT EXISTS sales_v2_learning_cycle_state (
        state_key VARCHAR(64) NOT NULL,
        cycle_status VARCHAR(64) NOT NULL DEFAULT 'idle',
        last_cycle_started_at DATETIME DEFAULT NULL,
        last_cycle_finished_at DATETIME DEFAULT NULL,
        last_decision VARCHAR(64) DEFAULT NULL,
        last_reason TEXT DEFAULT NULL,
        current_model_version VARCHAR(255) DEFAULT NULL,
        latest_candidate_version VARCHAR(255) DEFAULT NULL,
        latest_comparison_json LONGTEXT DEFAULT NULL,
        minimum_feedback_required INT DEFAULT NULL,
        valid_feedback_rows_available INT DEFAULT NULL,
        new_valid_feedback_count INT DEFAULT NULL,
        feedback_cutoff_used DATETIME DEFAULT NULL,
        processed_feedback_signature VARCHAR(255) DEFAULT NULL,
        processed_feedback_rows INT DEFAULT NULL,
        failed_feedback_signature VARCHAR(255) DEFAULT NULL,
        failed_feedback_rows INT DEFAULT NULL,
        last_error_message TEXT DEFAULT NULL,
        last_checked_at DATETIME DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (state_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `)
  })()

  try {
    await learningTablesPending
  } finally {
    learningTablesPending = null
  }
}

async function archiveExistingCandidateRows(queryAsync) {
  await queryAsync(`
    UPDATE sales_v2_learning_candidates
    SET status = 'archived', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'candidate'
  `)
}

async function saveCandidateLearningRecord(queryAsync, {
  currentModel,
  feedbackAvailability,
  result
} = {}) {
  const normalizedStatus = normalizeNullableText(result?.status) || 'failed'
  const normalizedRecommendation = normalizeNullableText(result?.recommendation) || 'insufficient_data'
  const persistedStatus = normalizedStatus === 'success'
    ? (normalizedRecommendation === 'candidate_better' ? 'candidate' : 'rejected')
    : 'failed'

  if (persistedStatus === 'candidate') {
    await archiveExistingCandidateRows(queryAsync)
  }

  await queryAsync(`
    DELETE FROM sales_v2_learning_candidates
    WHERE candidate_version = ?
  `, [result.candidate_version])

  await queryAsync(`
    INSERT INTO sales_v2_learning_candidates (
      candidate_version,
      status,
      base_current_model_version,
      feature_schema_version,
      trained_at,
      training_data_cutoff,
      holdout_start_date,
      holdout_end_date,
      feedback_rows_available,
      feedback_rows_used,
      feedback_rows_holdout,
      targets_retrained_json,
      metrics_json,
      comparison_json,
      artifact_manifest_json,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    result.candidate_version,
    persistedStatus,
    currentModel?.model_version || null,
    currentModel?.feature_schema_version || null,
    result.trained_at || null,
    result.training_data_cutoff || null,
    result.holdout_window?.start_date || null,
    result.holdout_window?.end_date || null,
    Number(feedbackAvailability?.feedback_rows_available || 0),
    Number(result.feedback_rows_used || 0),
    Number(result.feedback_rows_holdout || 0),
    JSON.stringify(result.targets_retrained || []),
    JSON.stringify({
      current_model: result.current_model || null,
      candidate_model: result.candidate_model || null,
      delta: result.delta || {}
    }),
    JSON.stringify({
      recommendation: normalizedRecommendation,
      status: normalizedStatus
    }),
    JSON.stringify(result.artifact_manifest || null),
    result.error || null
  ])

  return persistedStatus
}

function mapCandidateLearningRow(row = {}) {
  const metrics = parsePredictionSnapshot(row.metrics_json) || {}
  const comparison = parsePredictionSnapshot(row.comparison_json) || {}
  const targetsRetained = parsePredictionSnapshot(row.targets_retrained_json)

  return {
    candidate_version: normalizeNullableText(row.candidate_version),
    status: normalizeNullableText(row.status),
    base_current_model_version: normalizeNullableText(row.base_current_model_version),
    feature_schema_version: normalizeNullableText(row.feature_schema_version),
    trained_at: normalizeNullableIsoTimestamp(row.trained_at),
    training_data_cutoff: normalizeDateOnly(row.training_data_cutoff),
    holdout_window: {
      start_date: normalizeDateOnly(row.holdout_start_date),
      end_date: normalizeDateOnly(row.holdout_end_date)
    },
    feedback_rows_available: Number(row.feedback_rows_available || 0),
    feedback_rows_used: Number(row.feedback_rows_used || 0),
    feedback_rows_holdout: Number(row.feedback_rows_holdout || 0),
    targets_retrained: Array.isArray(targetsRetained) ? targetsRetained : [],
    current_model: metrics.current_model || null,
    candidate_model: metrics.candidate_model || null,
    delta: metrics.delta || {},
    comparison_status: normalizeNullableText(comparison.status) || 'unknown',
    recommendation: normalizeNullableText(comparison.recommendation) || null,
    artifact_manifest: normalizeNullableJsonObject(row.artifact_manifest_json),
    error: normalizeNullableText(row.error_message),
    created_at: normalizeNullableIsoTimestamp(row.created_at),
    updated_at: normalizeNullableIsoTimestamp(row.updated_at)
  }
}

async function fetchLatestCandidateLearningRecord(queryAsync) {
  const rows = await queryAsync(`
    SELECT
      candidate_version,
      status,
      base_current_model_version,
      feature_schema_version,
      trained_at,
      training_data_cutoff,
      holdout_start_date,
      holdout_end_date,
      feedback_rows_available,
      feedback_rows_used,
      feedback_rows_holdout,
      targets_retrained_json,
      metrics_json,
      comparison_json,
      artifact_manifest_json,
      error_message,
      created_at,
      updated_at
    FROM sales_v2_learning_candidates
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)

  if (!Array.isArray(rows) || !rows[0]) return null
  return mapCandidateLearningRow(rows[0])
}

async function fetchCandidateLearningRecordByVersion(queryAsync, candidateVersion) {
  const normalizedCandidateVersion = normalizeNullableText(candidateVersion)
  if (!normalizedCandidateVersion) return null

  const rows = await queryAsync(`
    SELECT
      candidate_version,
      status,
      base_current_model_version,
      feature_schema_version,
      trained_at,
      training_data_cutoff,
      holdout_start_date,
      holdout_end_date,
      feedback_rows_available,
      feedback_rows_used,
      feedback_rows_holdout,
      targets_retrained_json,
      metrics_json,
      comparison_json,
      artifact_manifest_json,
      error_message,
      created_at,
      updated_at
    FROM sales_v2_learning_candidates
    WHERE candidate_version = ?
    LIMIT 1
  `, [normalizedCandidateVersion])

  if (!Array.isArray(rows) || !rows[0]) return null
  return mapCandidateLearningRow(rows[0])
}

async function updateCandidateLearningStatus(queryAsync, candidateVersion, nextStatus) {
  const normalizedCandidateVersion = normalizeNullableText(candidateVersion)
  const normalizedNextStatus = normalizeNullableText(nextStatus)
  if (!normalizedCandidateVersion || !normalizedNextStatus) return

  await queryAsync(`
    UPDATE sales_v2_learning_candidates
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE candidate_version = ?
  `, [normalizedNextStatus, normalizedCandidateVersion])
}

async function savePromotionAuditRecord(queryAsync, payload = {}) {
  await queryAsync(`
    INSERT INTO sales_v2_learning_promotions (
      action_type,
      status,
      candidate_version,
      previous_model_version,
      resulting_model_version,
      rollback_target_version,
      feature_schema_version,
      policy_json,
      evaluation_json,
      artifact_manifest_json,
      decision_reason,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    normalizeNullableText(payload.action_type) || 'promote',
    normalizeNullableText(payload.status) || 'failed',
    normalizeNullableText(payload.candidate_version),
    normalizeNullableText(payload.previous_model_version),
    normalizeNullableText(payload.resulting_model_version),
    normalizeNullableText(payload.rollback_target_version),
    normalizeNullableText(payload.feature_schema_version),
    JSON.stringify(payload.policy || null),
    JSON.stringify(payload.evaluation || null),
    JSON.stringify(payload.artifact_manifest || null),
    normalizeNullableText(payload.decision_reason),
    normalizeNullableText(payload.error_message)
  ])
}

async function fetchLatestPromotionAuditRecord(queryAsync) {
  const rows = await queryAsync(`
    SELECT
      action_type,
      status,
      candidate_version,
      previous_model_version,
      resulting_model_version,
      rollback_target_version,
      feature_schema_version,
      policy_json,
      evaluation_json,
      artifact_manifest_json,
      decision_reason,
      error_message,
      created_at,
      updated_at
    FROM sales_v2_learning_promotions
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)

  if (!Array.isArray(rows) || !rows[0]) return null
  const row = rows[0]
  return {
    action_type: normalizeNullableText(row.action_type),
    status: normalizeNullableText(row.status),
    candidate_version: normalizeNullableText(row.candidate_version),
    previous_model_version: normalizeNullableText(row.previous_model_version),
    resulting_model_version: normalizeNullableText(row.resulting_model_version),
    rollback_target_version: normalizeNullableText(row.rollback_target_version),
    feature_schema_version: normalizeNullableText(row.feature_schema_version),
    policy: normalizeNullableJsonObject(row.policy_json),
    evaluation: normalizeNullableJsonObject(row.evaluation_json),
    artifact_manifest: normalizeNullableJsonObject(row.artifact_manifest_json),
    decision_reason: normalizeNullableText(row.decision_reason),
    error: normalizeNullableText(row.error_message),
    created_at: normalizeNullableIsoTimestamp(row.created_at),
    updated_at: normalizeNullableIsoTimestamp(row.updated_at)
  }
}

const LEARNING_CYCLE_STATE_KEY = 'default'
const LEARNING_CYCLE_STATUSES = new Set([
  'idle',
  'waiting_for_feedback',
  'training',
  'evaluating',
  'promoting',
  'current_kept',
  'promoted',
  'failed'
])

function normalizeLearningCycleStatus(value) {
  const normalized = normalizeNullableText(value)
  return LEARNING_CYCLE_STATUSES.has(normalized) ? normalized : 'idle'
}

function mapLearningCycleStateRow(row = {}) {
  return {
    state_key: normalizeNullableText(row.state_key) || LEARNING_CYCLE_STATE_KEY,
    cycle_status: normalizeLearningCycleStatus(row.cycle_status),
    last_cycle_started_at: normalizeNullableIsoTimestamp(row.last_cycle_started_at),
    last_cycle_finished_at: normalizeNullableIsoTimestamp(row.last_cycle_finished_at),
    last_decision: normalizeNullableText(row.last_decision),
    last_reason: normalizeNullableText(row.last_reason),
    current_model_version: normalizeNullableText(row.current_model_version),
    latest_candidate_version: normalizeNullableText(row.latest_candidate_version),
    latest_comparison: normalizeNullableJsonObject(row.latest_comparison_json),
    minimum_feedback_required: Number(row.minimum_feedback_required || 0),
    valid_feedback_rows_available: Number(row.valid_feedback_rows_available || 0),
    new_valid_feedback_count: Number(row.new_valid_feedback_count || 0),
    feedback_cutoff_used: normalizeNullableIsoTimestamp(row.feedback_cutoff_used),
    processed_feedback_signature: normalizeNullableText(row.processed_feedback_signature),
    processed_feedback_rows: Number(row.processed_feedback_rows || 0),
    failed_feedback_signature: normalizeNullableText(row.failed_feedback_signature),
    failed_feedback_rows: Number(row.failed_feedback_rows || 0),
    last_error_message: normalizeNullableText(row.last_error_message),
    last_checked_at: normalizeNullableIsoTimestamp(row.last_checked_at),
    created_at: normalizeNullableIsoTimestamp(row.created_at),
    updated_at: normalizeNullableIsoTimestamp(row.updated_at)
  }
}

async function fetchLearningCycleState(queryAsync) {
  const rows = await queryAsync(`
    SELECT
      state_key,
      cycle_status,
      last_cycle_started_at,
      last_cycle_finished_at,
      last_decision,
      last_reason,
      current_model_version,
      latest_candidate_version,
      latest_comparison_json,
      minimum_feedback_required,
      valid_feedback_rows_available,
      new_valid_feedback_count,
      feedback_cutoff_used,
      processed_feedback_signature,
      processed_feedback_rows,
      failed_feedback_signature,
      failed_feedback_rows,
      last_error_message,
      last_checked_at,
      created_at,
      updated_at
    FROM sales_v2_learning_cycle_state
    WHERE state_key = ?
    LIMIT 1
  `, [LEARNING_CYCLE_STATE_KEY])

  if (!Array.isArray(rows) || !rows[0]) return null
  return mapLearningCycleStateRow(rows[0])
}

async function saveLearningCycleState(queryAsync, patch = {}) {
  const current = await fetchLearningCycleState(queryAsync)
  const merged = {
    state_key: LEARNING_CYCLE_STATE_KEY,
    cycle_status: normalizeLearningCycleStatus(patch.cycle_status ?? current?.cycle_status ?? 'idle'),
    last_cycle_started_at: normalizeNullableIsoTimestamp(patch.last_cycle_started_at ?? current?.last_cycle_started_at),
    last_cycle_finished_at: normalizeNullableIsoTimestamp(patch.last_cycle_finished_at ?? current?.last_cycle_finished_at),
    last_decision: normalizeNullableText(patch.last_decision ?? current?.last_decision),
    last_reason: normalizeNullableText(patch.last_reason ?? current?.last_reason),
    current_model_version: normalizeNullableText(patch.current_model_version ?? current?.current_model_version),
    latest_candidate_version: normalizeNullableText(patch.latest_candidate_version ?? current?.latest_candidate_version),
    latest_comparison: patch.latest_comparison === undefined
      ? (current?.latest_comparison ?? null)
      : cloneJson(patch.latest_comparison),
    minimum_feedback_required: Number(
      patch.minimum_feedback_required ?? current?.minimum_feedback_required ?? DEFAULT_MIN_VALID_FEEDBACK_ROWS
    ),
    valid_feedback_rows_available: Number(
      patch.valid_feedback_rows_available ?? current?.valid_feedback_rows_available ?? 0
    ),
    new_valid_feedback_count: Number(
      patch.new_valid_feedback_count ?? current?.new_valid_feedback_count ?? 0
    ),
    feedback_cutoff_used: normalizeNullableIsoTimestamp(
      patch.feedback_cutoff_used ?? current?.feedback_cutoff_used
    ),
    processed_feedback_signature: normalizeNullableText(
      patch.processed_feedback_signature ?? current?.processed_feedback_signature
    ),
    processed_feedback_rows: Number(
      patch.processed_feedback_rows ?? current?.processed_feedback_rows ?? 0
    ),
    failed_feedback_signature: normalizeNullableText(
      patch.failed_feedback_signature ?? current?.failed_feedback_signature
    ),
    failed_feedback_rows: Number(
      patch.failed_feedback_rows ?? current?.failed_feedback_rows ?? 0
    ),
    last_error_message: normalizeNullableText(patch.last_error_message ?? current?.last_error_message),
    last_checked_at: normalizeNullableIsoTimestamp(
      patch.last_checked_at ?? current?.last_checked_at ?? new Date().toISOString()
    )
  }

  await queryAsync(`
    INSERT INTO sales_v2_learning_cycle_state (
      state_key,
      cycle_status,
      last_cycle_started_at,
      last_cycle_finished_at,
      last_decision,
      last_reason,
      current_model_version,
      latest_candidate_version,
      latest_comparison_json,
      minimum_feedback_required,
      valid_feedback_rows_available,
      new_valid_feedback_count,
      feedback_cutoff_used,
      processed_feedback_signature,
      processed_feedback_rows,
      failed_feedback_signature,
      failed_feedback_rows,
      last_error_message,
      last_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      cycle_status = VALUES(cycle_status),
      last_cycle_started_at = VALUES(last_cycle_started_at),
      last_cycle_finished_at = VALUES(last_cycle_finished_at),
      last_decision = VALUES(last_decision),
      last_reason = VALUES(last_reason),
      current_model_version = VALUES(current_model_version),
      latest_candidate_version = VALUES(latest_candidate_version),
      latest_comparison_json = VALUES(latest_comparison_json),
      minimum_feedback_required = VALUES(minimum_feedback_required),
      valid_feedback_rows_available = VALUES(valid_feedback_rows_available),
      new_valid_feedback_count = VALUES(new_valid_feedback_count),
      feedback_cutoff_used = VALUES(feedback_cutoff_used),
      processed_feedback_signature = VALUES(processed_feedback_signature),
      processed_feedback_rows = VALUES(processed_feedback_rows),
      failed_feedback_signature = VALUES(failed_feedback_signature),
      failed_feedback_rows = VALUES(failed_feedback_rows),
      last_error_message = VALUES(last_error_message),
      last_checked_at = VALUES(last_checked_at),
      updated_at = CURRENT_TIMESTAMP
  `, [
    merged.state_key,
    merged.cycle_status,
    merged.last_cycle_started_at,
    merged.last_cycle_finished_at,
    merged.last_decision,
    merged.last_reason,
    merged.current_model_version,
    merged.latest_candidate_version,
    JSON.stringify(merged.latest_comparison ?? null),
    merged.minimum_feedback_required,
    merged.valid_feedback_rows_available,
    merged.new_valid_feedback_count,
    merged.feedback_cutoff_used,
    merged.processed_feedback_signature,
    merged.processed_feedback_rows,
    merged.failed_feedback_signature,
    merged.failed_feedback_rows,
    merged.last_error_message,
    merged.last_checked_at
  ])

  return merged
}

async function getSalesLearningStatus(queryAsync, {
  baseDir = __dirname,
  feedbackFilters = {},
  minValidFeedbackRows = DEFAULT_MIN_VALID_FEEDBACK_ROWS,
  promotionPolicy = resolvePromotionPolicy()
} = {}) {
  await ensureSalesLearningTables(queryAsync)

  const { records } = await fetchSalesVisitFeedbackMonitoringRecords(queryAsync, feedbackFilters)
  const feedbackAvailability = summarizeFeedbackAvailability(records)
  const cycleState = await fetchLearningCycleState(queryAsync)
  const eligibleFeedbackState = buildLearningEligibleFeedbackState(records, cycleState)
  const currentModel = await loadCurrentModelMetadata(queryAsync, baseDir)
  const latestCandidate = await fetchLatestCandidateLearningRecord(queryAsync)
  const latestPromotion = await fetchLatestPromotionAuditRecord(queryAsync)
  const learningCycleStatus = normalizeLearningCycleStatus(cycleState?.cycle_status)
  const latestComparisonSummary = cycleState?.latest_comparison || latestPromotion?.evaluation || null

  return {
    status: learningCycleStatus || latestCandidate?.status || 'ready',
    current_model: currentModel,
    latest_candidate: latestCandidate,
    latest_promotion: latestPromotion,
    feedback: {
      ...feedbackAvailability,
      min_valid_feedback_rows: Number(minValidFeedbackRows || DEFAULT_MIN_VALID_FEEDBACK_ROWS),
      valid_feedback_rows_available: eligibleFeedbackState.valid_feedback_rows_available,
      new_valid_feedback_count: eligibleFeedbackState.new_valid_feedback_count
    },
    promotion_policy: cloneJson(promotionPolicy),
    learning_cycle_status: learningCycleStatus,
    last_cycle_started_at: cycleState?.last_cycle_started_at || null,
    last_cycle_finished_at: cycleState?.last_cycle_finished_at || null,
    new_valid_feedback_count: eligibleFeedbackState.new_valid_feedback_count,
    minimum_feedback_required: Number(minValidFeedbackRows || DEFAULT_MIN_VALID_FEEDBACK_ROWS),
    feedback_cutoff_used: cycleState?.feedback_cutoff_used || null,
    last_decision: cycleState?.last_decision || null,
    last_reason: cycleState?.last_reason || null,
    latest_comparison_summary: latestComparisonSummary,
    learning_cycle: {
      status: learningCycleStatus,
      last_cycle_started_at: cycleState?.last_cycle_started_at || null,
      last_cycle_finished_at: cycleState?.last_cycle_finished_at || null,
      new_valid_feedback_count: eligibleFeedbackState.new_valid_feedback_count,
      minimum_feedback_required: Number(minValidFeedbackRows || DEFAULT_MIN_VALID_FEEDBACK_ROWS),
      feedback_cutoff_used: cycleState?.feedback_cutoff_used || null,
      last_decision: cycleState?.last_decision || null,
      last_reason: cycleState?.last_reason || null,
      latest_comparison_summary: latestComparisonSummary,
      last_error_message: cycleState?.last_error_message || null
    }
  }
}

async function retrainSalesLearningCandidate({
  queryAsync,
  baseDir = __dirname,
  feedbackFilters = {},
  learningRunner = runPythonCandidateTraining,
  minValidFeedbackRows = DEFAULT_MIN_VALID_FEEDBACK_ROWS,
  holdoutRatio = DEFAULT_HOLDOUT_RATIO,
  minHoldoutRows = DEFAULT_MIN_HOLDOUT_ROWS
} = {}) {
  await ensureSalesLearningTables(queryAsync)

  const normalizedMinValidFeedbackRows = Number(minValidFeedbackRows || DEFAULT_MIN_VALID_FEEDBACK_ROWS)
  const normalizedHoldoutRatio = Number(holdoutRatio || DEFAULT_HOLDOUT_RATIO)
  const normalizedMinHoldoutRows = Number(minHoldoutRows || DEFAULT_MIN_HOLDOUT_ROWS)

  const { filters, records } = await fetchSalesVisitFeedbackMonitoringRecords(queryAsync, feedbackFilters)
  const normalizedRecords = records.map(normalizeFeedbackLearningRecord)
  const feedbackAvailability = summarizeFeedbackAvailability(normalizedRecords)
  const purchaseEligibleRecords = sortLearningRecords(normalizedRecords.filter(isPurchaseLearningEligible))
  const currentModel = await loadCurrentModelMetadata(queryAsync, baseDir)

  if (purchaseEligibleRecords.length < normalizedMinValidFeedbackRows) {
    return {
      status: 'insufficient_data',
      filters,
      current_model: currentModel,
      latest_candidate: await fetchLatestCandidateLearningRecord(queryAsync),
      feedback: {
        ...feedbackAvailability,
        min_valid_feedback_rows: normalizedMinValidFeedbackRows
      },
      message: `Feedback insuffisant pour un retrain candidat (${purchaseEligibleRecords.length}/${normalizedMinValidFeedbackRows}).`
    }
  }

  const split = splitLearningHoldout(purchaseEligibleRecords, {
    holdoutRatio: normalizedHoldoutRatio,
    minHoldoutRows: normalizedMinHoldoutRows
  })

  const trainingDataCutoff = split.train_rows.length
    ? split.train_rows[split.train_rows.length - 1].planned_date
    : null
  const candidateVersion = buildCandidateVersion({
    currentModelVersion: currentModel.model_version,
    featureSchemaVersion: currentModel.feature_schema_version,
    feedbackRowsUsed: split.train_rows.length,
    trainingDataCutoff
  })

  const runnerPayload = createLearningRunnerPayload({
    currentModel,
    candidateVersion,
    trainRows: split.train_rows,
    holdoutRows: split.holdout_rows,
    minValidFeedbackRows: normalizedMinValidFeedbackRows,
    holdoutRatio: normalizedHoldoutRatio,
    minHoldoutRows: normalizedMinHoldoutRows
  })

  let learningResult
  try {
    learningResult = normalizeLearningResult(await learningRunner({
      payload: runnerPayload,
      baseDir,
      outputDir: buildCandidateArtifactsDirectory(baseDir, candidateVersion)
    }), {
      candidate_version: candidateVersion,
      training_data_cutoff: trainingDataCutoff,
      feedback_rows_used: split.train_rows.length,
      feedback_rows_holdout: split.holdout_rows.length
    })
  } catch (error) {
    const failedResult = normalizeLearningResult({
      status: 'failed',
      candidate_version: candidateVersion,
      training_data_cutoff: trainingDataCutoff,
      feedback_rows_used: split.train_rows.length,
      feedback_rows_holdout: split.holdout_rows.length,
      recommendation: 'current_better',
      error: error.message || String(error)
    })
    await saveCandidateLearningRecord(queryAsync, {
      currentModel,
      feedbackAvailability,
      result: failedResult
    })
    return {
      status: 'failed',
      filters,
      current_model: currentModel,
      latest_candidate: await fetchLatestCandidateLearningRecord(queryAsync),
      feedback: {
        ...feedbackAvailability,
        min_valid_feedback_rows: normalizedMinValidFeedbackRows
      },
      error: failedResult.error,
      message: 'Le retrain candidat a echoue. Le modele courant reste inchange.'
    }
  }

  if (learningResult.status !== 'success') {
    await saveCandidateLearningRecord(queryAsync, {
      currentModel,
      feedbackAvailability,
      result: learningResult
    })
    return {
      status: learningResult.status,
      filters,
      current_model: currentModel,
      latest_candidate: await fetchLatestCandidateLearningRecord(queryAsync),
      feedback: {
        ...feedbackAvailability,
        min_valid_feedback_rows: normalizedMinValidFeedbackRows
      },
      result: learningResult
    }
  }

  const persistedStatus = await saveCandidateLearningRecord(queryAsync, {
    currentModel,
    feedbackAvailability,
    result: learningResult
  })

  return {
    status: 'success',
    filters,
    current_model: currentModel,
    candidate: {
      ...learningResult,
      status: persistedStatus
    },
    feedback: {
      ...feedbackAvailability,
      min_valid_feedback_rows: normalizedMinValidFeedbackRows
    }
  }
}

async function verifyPredictionServiceStatus({
  fetchPredictionServiceStatus,
  expectedModelVersion,
  expectedFeaturesVersion
} = {}) {
  if (typeof fetchPredictionServiceStatus !== 'function') {
    throw new Error('Prediction service status hook is missing.')
  }

  const status = await fetchPredictionServiceStatus()
  if (!normalizeBoolean(status?.ready, false)) {
    throw new Error('Prediction service is not ready after model reload.')
  }
  if (expectedModelVersion && normalizeNullableText(status?.model_version) !== expectedModelVersion) {
    throw new Error(`Prediction service loaded model version ${status?.model_version || 'unknown'} instead of ${expectedModelVersion}.`)
  }
  if (expectedFeaturesVersion && normalizeNullableText(status?.features_version) !== expectedFeaturesVersion) {
    throw new Error(`Prediction service loaded feature schema ${status?.features_version || 'unknown'} instead of ${expectedFeaturesVersion}.`)
  }
  return cloneJson(status)
}

async function promoteSalesLearningCandidate({
  queryAsync,
  baseDir = __dirname,
  candidateVersion = null,
  promotionPolicy = resolvePromotionPolicy(),
  reloadPredictionService,
  fetchPredictionServiceStatus,
  invalidateModelDependentCaches = async () => ({ status: 'not_requested' })
} = {}) {
  await ensureSalesLearningTables(queryAsync)

  const currentModel = await loadCurrentModelMetadata(queryAsync, baseDir)
  const candidate = candidateVersion
    ? await fetchCandidateLearningRecordByVersion(queryAsync, candidateVersion)
    : await fetchLatestCandidateLearningRecord(queryAsync)
  const evaluation = evaluateCandidatePromotionEligibility({
    candidate,
    currentModel,
    policy: promotionPolicy
  })

  if (evaluation.promotion_status !== 'promotable') {
    await savePromotionAuditRecord(queryAsync, {
      action_type: 'promote',
      status: evaluation.promotion_status,
      candidate_version: candidate?.candidate_version || null,
      previous_model_version: currentModel.model_version,
      resulting_model_version: currentModel.model_version,
      feature_schema_version: currentModel.feature_schema_version,
      policy: promotionPolicy,
      evaluation,
      artifact_manifest: candidate?.artifact_manifest || null,
      decision_reason: evaluation.decision_reason
    })

    return {
      status: evaluation.promotion_status,
      message: 'Le modele courant est conserve.',
      current_model: currentModel,
      candidate,
      promotion_policy: cloneJson(promotionPolicy),
      evaluation
    }
  }

  if (typeof reloadPredictionService !== 'function') {
    throw new Error('Prediction service reload hook is missing.')
  }

  let stagedBundle = null
  let archiveDirectory = null

  try {
    stagedBundle = buildStagedProductionBundle({
      baseDir,
      currentModelVersion: currentModel.model_version,
      candidate
    })
    if (stagedBundle.staged_model_version === currentModel.model_version) {
      await savePromotionAuditRecord(queryAsync, {
        action_type: 'promote',
        status: 'current_retained',
        candidate_version: candidate.candidate_version,
        previous_model_version: currentModel.model_version,
        resulting_model_version: currentModel.model_version,
        feature_schema_version: currentModel.feature_schema_version,
        policy: promotionPolicy,
        evaluation,
        artifact_manifest: {
          promoted_targets: stagedBundle.validated_targets,
          candidate_manifest: candidate.artifact_manifest || null
        },
        decision_reason: 'candidate_bundle_matches_current'
      })

      return {
        status: 'current_retained',
        message: 'Le candidat ne change pas les artefacts de production.',
        current_model: currentModel,
        candidate,
        promotion_policy: cloneJson(promotionPolicy),
        evaluation
      }
    }
    archiveDirectory = ensureCurrentModelArchived(baseDir, currentModel.model_version)
    applyStagedProductionBundle(baseDir, stagedBundle.stage_directory)
    const reloadResult = await reloadPredictionService({
      expected_model_version: stagedBundle.staged_model_version,
      action: 'promote'
    })
    const predictionServiceStatus = await verifyPredictionServiceStatus({
      fetchPredictionServiceStatus,
      expectedModelVersion: stagedBundle.staged_model_version,
      expectedFeaturesVersion: currentModel.features_version
    })
    const cacheInvalidation = await invalidateModelDependentCaches({
      action: 'promote',
      previous_model_version: currentModel.model_version,
      current_model_version: stagedBundle.staged_model_version
    })
    const promotedModel = await loadCurrentModelMetadata(queryAsync, baseDir)
    await updateCandidateLearningStatus(queryAsync, candidate.candidate_version, 'promoted')
    await savePromotionAuditRecord(queryAsync, {
      action_type: 'promote',
      status: 'successful',
      candidate_version: candidate.candidate_version,
      previous_model_version: currentModel.model_version,
      resulting_model_version: promotedModel.model_version,
      feature_schema_version: promotedModel.feature_schema_version,
      policy: promotionPolicy,
      evaluation: {
        ...evaluation,
        reload_result: reloadResult || null,
        prediction_service_status: predictionServiceStatus || null,
        cache_invalidation: cacheInvalidation || null
      },
      artifact_manifest: {
        archive_directory: archiveDirectory,
        promoted_targets: stagedBundle.validated_targets,
        candidate_manifest: candidate.artifact_manifest || null
      },
      decision_reason: 'candidate_promoted'
    })

    return {
      status: 'successful',
      message: 'Le candidat a ete promu en production.',
      previous_model: currentModel,
      current_model: promotedModel,
      candidate,
      promotion_policy: cloneJson(promotionPolicy),
      evaluation,
      cache_invalidation: cacheInvalidation || null,
      prediction_service: predictionServiceStatus
    }
  } catch (error) {
    let rollbackStatus = null
    try {
      restoreArchivedProductionBundle(baseDir, currentModel.model_version)
      await reloadPredictionService({
        expected_model_version: currentModel.model_version,
        action: 'restore_previous_after_failed_promotion'
      })
      rollbackStatus = await verifyPredictionServiceStatus({
        fetchPredictionServiceStatus,
        expectedModelVersion: currentModel.model_version,
        expectedFeaturesVersion: currentModel.features_version
      })
    } catch (restoreError) {
      rollbackStatus = {
        ready: false,
        error: restoreError.message || String(restoreError)
      }
    }

    await savePromotionAuditRecord(queryAsync, {
      action_type: 'promote',
      status: 'failed',
      candidate_version: candidate?.candidate_version || null,
      previous_model_version: currentModel.model_version,
      resulting_model_version: currentModel.model_version,
      feature_schema_version: currentModel.feature_schema_version,
      policy: promotionPolicy,
      evaluation: {
        ...evaluation,
        rollback_status: rollbackStatus
      },
      artifact_manifest: {
        archive_directory: archiveDirectory,
        promoted_targets: stagedBundle?.validated_targets || null,
        candidate_manifest: candidate?.artifact_manifest || null
      },
      decision_reason: 'promotion_failed',
      error_message: error.message || String(error)
    })

    return {
      status: 'failed',
      message: 'La promotion a echoue. Le modele courant precedent reste actif.',
      current_model: currentModel,
      candidate,
      promotion_policy: cloneJson(promotionPolicy),
      evaluation,
      error: error.message || String(error),
      rollback_status: rollbackStatus
    }
  } finally {
    cleanupDirectory(stagedBundle?.stage_directory)
  }
}

async function rollbackSalesLearningModel({
  queryAsync,
  baseDir = __dirname,
  rollbackTargetVersion = null,
  reloadPredictionService,
  fetchPredictionServiceStatus,
  invalidateModelDependentCaches = async () => ({ status: 'not_requested' })
} = {}) {
  await ensureSalesLearningTables(queryAsync)

  if (typeof reloadPredictionService !== 'function') {
    throw new Error('Prediction service reload hook is missing.')
  }

  const currentModel = await loadCurrentModelMetadata(queryAsync, baseDir)
  const latestPromotion = await fetchLatestPromotionAuditRecord(queryAsync)
  const targetVersion = normalizeNullableText(rollbackTargetVersion) ||
    normalizeNullableText(latestPromotion?.previous_model_version) ||
    normalizeNullableText(latestPromotion?.rollback_target_version)

  if (!targetVersion) {
    return {
      status: 'failed',
      message: 'Aucune version precedente connue pour le rollback.',
      current_model: currentModel,
      latest_promotion: latestPromotion
    }
  }

  if (targetVersion === currentModel.model_version) {
    return {
      status: 'current_retained',
      message: 'Le modele courant correspond deja a la version demandee.',
      current_model: currentModel,
      latest_promotion: latestPromotion
    }
  }

  ensureCurrentModelArchived(baseDir, currentModel.model_version)

  try {
    const rollbackArchiveDirectory = restoreArchivedProductionBundle(baseDir, targetVersion)
    const reloadResult = await reloadPredictionService({
      expected_model_version: targetVersion,
      action: 'rollback'
    })
    const predictionServiceStatus = await verifyPredictionServiceStatus({
      fetchPredictionServiceStatus,
      expectedModelVersion: targetVersion,
      expectedFeaturesVersion: currentModel.features_version
    })
    const cacheInvalidation = await invalidateModelDependentCaches({
      action: 'rollback',
      previous_model_version: currentModel.model_version,
      current_model_version: targetVersion
    })
    const restoredModel = await loadCurrentModelMetadata(queryAsync, baseDir)
    await savePromotionAuditRecord(queryAsync, {
      action_type: 'rollback',
      status: 'successful',
      previous_model_version: currentModel.model_version,
      resulting_model_version: restoredModel.model_version,
      rollback_target_version: targetVersion,
      feature_schema_version: restoredModel.feature_schema_version,
      evaluation: {
        latest_promotion: latestPromotion,
        reload_result: reloadResult || null,
        prediction_service_status: predictionServiceStatus || null,
        cache_invalidation: cacheInvalidation || null
      },
      artifact_manifest: {
        rollback_archive_directory: rollbackArchiveDirectory
      },
      decision_reason: 'rollback_completed'
    })

    return {
      status: 'successful',
      message: 'Rollback du modele effectue avec succes.',
      previous_model: currentModel,
      current_model: restoredModel,
      rollback_target_version: targetVersion,
      cache_invalidation: cacheInvalidation || null,
      prediction_service: predictionServiceStatus
    }
  } catch (error) {
    let restoreStatus = null
    await savePromotionAuditRecord(queryAsync, {
      action_type: 'rollback',
      status: 'failed',
      previous_model_version: currentModel.model_version,
      resulting_model_version: currentModel.model_version,
      rollback_target_version: targetVersion,
      feature_schema_version: currentModel.feature_schema_version,
      evaluation: {
        latest_promotion: latestPromotion
      },
      decision_reason: 'rollback_failed',
      error_message: error.message || String(error)
    })

    try {
      restoreArchivedProductionBundle(baseDir, currentModel.model_version)
      await reloadPredictionService({
        expected_model_version: currentModel.model_version,
        action: 'restore_previous_after_failed_rollback'
      })
      restoreStatus = await verifyPredictionServiceStatus({
        fetchPredictionServiceStatus,
        expectedModelVersion: currentModel.model_version,
        expectedFeaturesVersion: currentModel.features_version
      })
    } catch (restoreError) {
      restoreStatus = {
        ready: false,
        error: restoreError.message || String(restoreError)
      }
    }

    return {
      status: 'failed',
      message: 'Le rollback a echoue. Le modele courant precedent est conserve.',
      current_model: currentModel,
      rollback_target_version: targetVersion,
      error: error.message || String(error),
      restore_status: restoreStatus
    }
  }
}

async function executeAutomaticSalesLearningCycle({
  queryAsync,
  baseDir = __dirname,
  reloadPredictionService,
  fetchPredictionServiceStatus,
  invalidateModelDependentCaches = async () => ({ status: 'not_requested' }),
  learningRunner = runPythonCandidateTraining,
  retrainCandidate = retrainSalesLearningCandidate,
  promoteCandidate = promoteSalesLearningCandidate,
  minValidFeedbackRows = DEFAULT_MIN_VALID_FEEDBACK_ROWS,
  holdoutRatio = DEFAULT_HOLDOUT_RATIO,
  minHoldoutRows = DEFAULT_MIN_HOLDOUT_ROWS,
  promotionPolicy = resolvePromotionPolicy(),
  feedbackFilters = {},
  force = false,
  trigger = 'automatic'
} = {}) {
  await ensureSalesLearningTables(queryAsync)

  const normalizedMinValidFeedbackRows = Number(minValidFeedbackRows || DEFAULT_MIN_VALID_FEEDBACK_ROWS)
  const currentModel = await loadCurrentModelMetadata(queryAsync, baseDir)
  const cycleState = await fetchLearningCycleState(queryAsync)
  const latestCandidate = await fetchLatestCandidateLearningRecord(queryAsync)
  const latestPromotion = await fetchLatestPromotionAuditRecord(queryAsync)
  const { records } = await fetchSalesVisitFeedbackMonitoringRecords(queryAsync, feedbackFilters)
  const feedbackAvailability = summarizeFeedbackAvailability(records)
  const eligibleFeedbackState = buildLearningEligibleFeedbackState(records, cycleState)
  const cycleContextPatch = {
    current_model_version: currentModel.model_version,
    latest_candidate_version: latestCandidate?.candidate_version || null,
    valid_feedback_rows_available: eligibleFeedbackState.valid_feedback_rows_available,
    new_valid_feedback_count: eligibleFeedbackState.new_valid_feedback_count,
    minimum_feedback_required: normalizedMinValidFeedbackRows,
    last_checked_at: new Date().toISOString()
  }

  if (eligibleFeedbackState.valid_feedback_rows_available < normalizedMinValidFeedbackRows) {
    const state = await saveLearningCycleState(queryAsync, {
      ...cycleContextPatch,
      cycle_status: 'waiting_for_feedback',
      last_decision: 'insufficient_data',
      last_reason: 'not_enough_new_valid_feedback',
      last_error_message: null
    })
    return {
      status: state.cycle_status,
      message: 'Pas assez de nouveau feedback valide pour lancer un apprentissage.',
      current_model: currentModel,
      latest_candidate: latestCandidate,
      latest_promotion: latestPromotion,
      feedback: {
        ...feedbackAvailability,
        min_valid_feedback_rows: normalizedMinValidFeedbackRows,
        valid_feedback_rows_available: eligibleFeedbackState.valid_feedback_rows_available,
        new_valid_feedback_count: eligibleFeedbackState.new_valid_feedback_count
      },
      learning_cycle: state
    }
  }

  if (!force && eligibleFeedbackState.same_processed_feedback) {
    const state = await saveLearningCycleState(queryAsync, {
      ...cycleContextPatch,
      cycle_status: 'waiting_for_feedback',
      last_decision: cycleState?.last_decision || 'current_retained',
      last_reason: 'no_new_valid_feedback_since_last_completed_cycle',
      last_error_message: null
    })
    return {
      status: state.cycle_status,
      message: 'Aucun nouveau feedback valide depuis le dernier cycle complete.',
      current_model: currentModel,
      latest_candidate: latestCandidate,
      latest_promotion: latestPromotion,
      feedback: {
        ...feedbackAvailability,
        min_valid_feedback_rows: normalizedMinValidFeedbackRows,
        valid_feedback_rows_available: eligibleFeedbackState.valid_feedback_rows_available,
        new_valid_feedback_count: 0
      },
      learning_cycle: state
    }
  }

  if (!force && eligibleFeedbackState.same_failed_feedback) {
    const state = await saveLearningCycleState(queryAsync, {
      ...cycleContextPatch,
      cycle_status: 'failed',
      last_reason: cycleState?.last_reason || 'previous_cycle_failed_for_same_feedback',
      last_error_message: cycleState?.last_error_message || 'Le dernier cycle a deja echoue pour ce meme lot de feedback.'
    })
    return {
      status: state.cycle_status,
      message: 'Le dernier cycle a deja echoue pour ce meme lot de feedback. Un nouveau feedback ou un retry explicite est requis.',
      current_model: currentModel,
      latest_candidate: latestCandidate,
      latest_promotion: latestPromotion,
      feedback: {
        ...feedbackAvailability,
        min_valid_feedback_rows: normalizedMinValidFeedbackRows,
        valid_feedback_rows_available: eligibleFeedbackState.valid_feedback_rows_available,
        new_valid_feedback_count: eligibleFeedbackState.new_valid_feedback_count
      },
      learning_cycle: state
    }
  }

  await saveLearningCycleState(queryAsync, {
    ...cycleContextPatch,
    cycle_status: 'training',
    last_cycle_started_at: new Date().toISOString(),
    last_cycle_finished_at: null,
    last_decision: null,
    last_reason: normalizeNullableText(trigger) || 'automatic',
    last_error_message: null,
    latest_comparison: null
  })

  let retrainResult
  try {
    retrainResult = await retrainCandidate({
      queryAsync,
      baseDir,
      feedbackFilters,
      learningRunner,
      minValidFeedbackRows: normalizedMinValidFeedbackRows,
      holdoutRatio,
      minHoldoutRows
    })
  } catch (error) {
    const state = await saveLearningCycleState(queryAsync, {
      ...cycleContextPatch,
      cycle_status: 'failed',
      last_cycle_finished_at: new Date().toISOString(),
      last_decision: 'failed',
      last_reason: 'training_service_exception',
      failed_feedback_signature: eligibleFeedbackState.feedback_signature,
      failed_feedback_rows: eligibleFeedbackState.valid_feedback_rows_available,
      last_error_message: error.message || String(error)
    })
    return {
      status: state.cycle_status,
      message: 'Le cycle automatique d apprentissage a echoue pendant le retrain.',
      current_model: currentModel,
      latest_candidate: await fetchLatestCandidateLearningRecord(queryAsync),
      latest_promotion: latestPromotion,
      feedback: {
        ...feedbackAvailability,
        min_valid_feedback_rows: normalizedMinValidFeedbackRows,
        valid_feedback_rows_available: eligibleFeedbackState.valid_feedback_rows_available,
        new_valid_feedback_count: eligibleFeedbackState.new_valid_feedback_count
      },
      learning_cycle: state,
      error: error.message || String(error)
    }
  }

  if (retrainResult.status !== 'success') {
    const state = await saveLearningCycleState(queryAsync, {
      ...cycleContextPatch,
      cycle_status: retrainResult.status === 'insufficient_data' ? 'waiting_for_feedback' : 'failed',
      last_cycle_finished_at: new Date().toISOString(),
      last_decision: retrainResult.status === 'insufficient_data' ? 'insufficient_data' : 'failed',
      last_reason: retrainResult.status === 'insufficient_data'
        ? 'not_enough_new_valid_feedback'
        : 'candidate_training_failed',
      latest_candidate_version: retrainResult?.latest_candidate?.candidate_version || latestCandidate?.candidate_version || null,
      failed_feedback_signature: retrainResult.status === 'failed' ? eligibleFeedbackState.feedback_signature : null,
      failed_feedback_rows: retrainResult.status === 'failed' ? eligibleFeedbackState.valid_feedback_rows_available : 0,
      last_error_message: retrainResult.error || null
    })
    return {
      ...retrainResult,
      learning_cycle: state
    }
  }

  const candidateVersion = retrainResult.candidate?.candidate_version || retrainResult.candidate_version || null
  await saveLearningCycleState(queryAsync, {
    ...cycleContextPatch,
    cycle_status: 'evaluating',
    latest_candidate_version: candidateVersion
  })

  await saveLearningCycleState(queryAsync, {
    ...cycleContextPatch,
    cycle_status: 'promoting',
    latest_candidate_version: candidateVersion
  })

  const promotionResult = await promoteCandidate({
    queryAsync,
    baseDir,
    candidateVersion,
    promotionPolicy,
    reloadPredictionService,
    fetchPredictionServiceStatus,
    invalidateModelDependentCaches
  })

  const latestPromotionAfterCycle = await fetchLatestPromotionAuditRecord(queryAsync)
  const latestCandidateAfterCycle = await fetchLatestCandidateLearningRecord(queryAsync)
  const finalComparison = cloneJson(
    promotionResult?.evaluation ||
    latestPromotionAfterCycle?.evaluation ||
    retrainResult?.candidate ||
    null
  )

  if (promotionResult.status === 'successful') {
    const state = await saveLearningCycleState(queryAsync, {
      ...cycleContextPatch,
      cycle_status: 'promoted',
      last_cycle_finished_at: new Date().toISOString(),
      last_decision: 'promoted',
      last_reason: 'candidate_promoted',
      latest_candidate_version: candidateVersion,
      latest_comparison: finalComparison,
      feedback_cutoff_used: eligibleFeedbackState.feedback_cutoff_used,
      processed_feedback_signature: eligibleFeedbackState.feedback_signature,
      processed_feedback_rows: eligibleFeedbackState.valid_feedback_rows_available,
      failed_feedback_signature: null,
      failed_feedback_rows: 0,
      last_error_message: null,
      current_model_version: promotionResult?.current_model?.model_version || currentModel.model_version,
      new_valid_feedback_count: 0
    })
    return {
      ...promotionResult,
      latest_candidate: latestCandidateAfterCycle,
      latest_promotion: latestPromotionAfterCycle,
      feedback: {
        ...feedbackAvailability,
        min_valid_feedback_rows: normalizedMinValidFeedbackRows,
        valid_feedback_rows_available: eligibleFeedbackState.valid_feedback_rows_available,
        new_valid_feedback_count: 0
      },
      learning_cycle: state
    }
  }

  if (promotionResult.status === 'current_retained' || promotionResult.status === 'insufficient_evidence') {
    const state = await saveLearningCycleState(queryAsync, {
      ...cycleContextPatch,
      cycle_status: 'current_kept',
      last_cycle_finished_at: new Date().toISOString(),
      last_decision: promotionResult.status === 'insufficient_evidence' ? 'insufficient_data' : 'current_retained',
      last_reason: promotionResult?.evaluation?.decision_reason || 'current_model_retained',
      latest_candidate_version: candidateVersion,
      latest_comparison: finalComparison,
      feedback_cutoff_used: eligibleFeedbackState.feedback_cutoff_used,
      processed_feedback_signature: eligibleFeedbackState.feedback_signature,
      processed_feedback_rows: eligibleFeedbackState.valid_feedback_rows_available,
      failed_feedback_signature: null,
      failed_feedback_rows: 0,
      last_error_message: null,
      new_valid_feedback_count: 0
    })
    return {
      ...promotionResult,
      latest_candidate: latestCandidateAfterCycle,
      latest_promotion: latestPromotionAfterCycle,
      feedback: {
        ...feedbackAvailability,
        min_valid_feedback_rows: normalizedMinValidFeedbackRows,
        valid_feedback_rows_available: eligibleFeedbackState.valid_feedback_rows_available,
        new_valid_feedback_count: 0
      },
      learning_cycle: state
    }
  }

  const state = await saveLearningCycleState(queryAsync, {
    ...cycleContextPatch,
    cycle_status: 'failed',
    last_cycle_finished_at: new Date().toISOString(),
    last_decision: 'failed',
    last_reason: promotionResult?.evaluation?.decision_reason || 'promotion_failed',
    latest_candidate_version: candidateVersion,
    latest_comparison: finalComparison,
    failed_feedback_signature: eligibleFeedbackState.feedback_signature,
    failed_feedback_rows: eligibleFeedbackState.valid_feedback_rows_available,
    last_error_message: promotionResult.error || promotionResult.message || 'Le cycle automatique a echoue pendant la promotion.'
  })
  return {
    ...promotionResult,
    latest_candidate: latestCandidateAfterCycle,
    latest_promotion: latestPromotionAfterCycle,
    feedback: {
      ...feedbackAvailability,
      min_valid_feedback_rows: normalizedMinValidFeedbackRows,
      valid_feedback_rows_available: eligibleFeedbackState.valid_feedback_rows_available,
      new_valid_feedback_count: eligibleFeedbackState.new_valid_feedback_count
    },
    learning_cycle: state
  }
}

function startAutomaticSalesLearningCycle(options = {}) {
  if (automaticLearningCyclePromise) {
    return automaticLearningCyclePromise
  }

  automaticLearningCyclePromise = executeAutomaticSalesLearningCycle(options)
    .finally(() => {
      automaticLearningCyclePromise = null
    })

  return automaticLearningCyclePromise
}

module.exports = {
  DEFAULT_AUTO_LEARNING_CHECK_INTERVAL_MS,
  DEFAULT_AUTO_LEARNING_STARTUP_DELAY_MS,
  DEFAULT_HOLDOUT_RATIO,
  DEFAULT_MIN_HOLDOUT_ROWS,
  DEFAULT_MIN_VALID_FEEDBACK_ROWS,
  DEFAULT_PROMOTION_MIN_EVAL_OBSERVATIONS,
  ensureSalesLearningTables,
  executeAutomaticSalesLearningCycle,
  fetchLearningCycleState,
  getSalesLearningStatus,
  promoteSalesLearningCandidate,
  retrainSalesLearningCandidate,
  rollbackSalesLearningModel,
  saveLearningCycleState,
  startAutomaticSalesLearningCycle,
  __testables: {
    MODEL_ARTIFACT_FILES,
    FEATURE_ARTIFACT_FILES,
    PROMOTABLE_TARGETS,
    buildCandidateArtifactsDirectory,
    buildCandidateVersion,
    buildCurrentModelMetadata: deriveCurrentModelMetadataFromFeatureIdentity,
    loadCurrentModelMetadata,
    buildLearningEligibleFeedbackState,
    buildModelArchiveDirectory,
    buildFeedbackLearningObservation: normalizeFeedbackLearningRecord,
    buildStagedProductionBundle,
    createLearningRunnerPayload,
    evaluateCandidatePromotionEligibility,
    isConditionalCaLearningEligible,
    isConditionalQuantityLearningEligible,
    isPurchaseLearningEligible,
    mapLearningCycleStateRow,
    normalizeLearningResult,
    resolvePromotionPolicy,
    validateCandidateArtifacts,
    splitLearningHoldout,
    summarizeFeedbackAvailability
  }
}

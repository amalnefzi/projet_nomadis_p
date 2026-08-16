const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_PROMOTION_MIN_EVAL_OBSERVATIONS,
  getSalesLearningStatus,
  promoteSalesLearningCandidate,
  rollbackSalesLearningModel,
  __testables
} = require('../sales_learning_candidate_service')

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function createArtifactsDir() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-learning-promote-artifacts-'))
  for (const fileName of [
    ...__testables.MODEL_ARTIFACT_FILES,
    ...__testables.FEATURE_ARTIFACT_FILES
  ]) {
    const targetPath = path.join(baseDir, fileName)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, `artifact:${fileName}:base`, 'utf8')
  }
  return baseDir
}

function createFeatureIdentity(seed = 'base') {
  return {
    state_key: 'active',
    status: 'ready',
    feature_schema_version: 'sha1:test-feature-schema-v1',
    feature_state_version: `sha1:test-feature-state-${seed}`,
    source_data_watermark: `sha1:test-watermark-${seed}`,
    source_max_date: '2026-08-11',
    features_version: `sha1:test-features-version-${seed}`
  }
}

const DEFAULT_FEATURE_IDENTITY = createFeatureIdentity()

function createCandidateArtifacts(baseDir, candidateVersion, overrides = {}) {
  const artifactDir = path.join(baseDir, 'candidate_models', candidateVersion)
  fs.mkdirSync(artifactDir, { recursive: true })
  const targets = {
    purchase_probability: overrides.purchase_probability ?? 'candidate:purchase',
    ca_if_buy: overrides.ca_if_buy ?? 'candidate:ca',
    quantity_if_buy: overrides.quantity_if_buy ?? 'candidate:quantity'
  }

  const fileMap = {
    purchase_probability: 'modele_nomadis_achat_candidate.pkl',
    ca_if_buy: 'modele_nomadis_ca_candidate.pkl',
    quantity_if_buy: 'modele_nomadis_qte_candidate.pkl'
  }

  const files = {}
  for (const [targetName, fileName] of Object.entries(fileMap)) {
    const targetPath = path.join(artifactDir, fileName)
    fs.writeFileSync(targetPath, String(targets[targetName]), 'utf8')
    files[targetName] = targetPath
  }

  const metadataPath = path.join(artifactDir, 'candidate_metadata.json')
  fs.writeFileSync(metadataPath, JSON.stringify({
    candidate_version: candidateVersion
  }, null, 2), 'utf8')
  files.metadata = metadataPath

  return {
    artifacts_dir: artifactDir,
    files
  }
}

function createCandidateRow({
  baseCurrentModelVersion,
  candidateVersion,
  featureSchemaVersion,
  status = 'candidate',
  comparisonStatus = 'success',
  recommendation = 'candidate_better',
  artifactManifest,
  purchaseComparableCount = 18,
  purchaseCurrent = { auc: 0.6, logloss: 0.52, bias: 0.01 },
  purchaseCandidate = { auc: 0.66, logloss: 0.41, bias: -0.01 },
  caComparableCount = 14,
  caCurrent = { mae: 18, rmse: 24, bias: 2.5, mape: 12.1 },
  caCandidate = { mae: 14, rmse: 20, bias: 1.4, mape: 9.3 },
  quantityComparableCount = 12,
  quantityCurrent = { mae: 3.2, rmse: 4.4, bias: 0.8, mape: 15.5 },
  quantityCandidate = { mae: 2.4, rmse: 3.5, bias: 0.4, mape: 11.2 },
  createdAt = '2026-08-10 12:00:00',
  updatedAt = '2026-08-10 12:00:00'
} = {}) {
  return {
    id: 1,
    candidate_version: candidateVersion,
    status,
    base_current_model_version: baseCurrentModelVersion,
    feature_schema_version: featureSchemaVersion,
    trained_at: '2026-08-10 11:00:00',
    training_data_cutoff: '2026-08-09',
    holdout_start_date: '2026-08-08',
    holdout_end_date: '2026-08-10',
    feedback_rows_available: 30,
    feedback_rows_used: 24,
    feedback_rows_holdout: 6,
    targets_retrained_json: JSON.stringify([
      'purchase_probability',
      'ca_if_buy',
      'quantity_if_buy'
    ]),
    metrics_json: JSON.stringify({
      current_model: {
        purchase_probability: {
          comparable_count: purchaseComparableCount,
          positive_count: 8,
          negative_count: 10,
          ...purchaseCurrent
        },
        ca_if_buy: {
          comparable_count: caComparableCount,
          mape_valid_count: caComparableCount,
          ...caCurrent
        },
        quantity_if_buy: {
          comparable_count: quantityComparableCount,
          ...quantityCurrent
        }
      },
      candidate_model: {
        purchase_probability: {
          comparable_count: purchaseComparableCount,
          positive_count: 8,
          negative_count: 10,
          ...purchaseCandidate
        },
        ca_if_buy: {
          comparable_count: caComparableCount,
          mape_valid_count: caComparableCount,
          ...caCandidate
        },
        quantity_if_buy: {
          comparable_count: quantityComparableCount,
          ...quantityCandidate
        }
      },
      delta: {}
    }),
    comparison_json: JSON.stringify({
      status: comparisonStatus,
      recommendation
    }),
    artifact_manifest_json: JSON.stringify(artifactManifest || null),
    error_message: null,
    created_at: createdAt,
    updated_at: updatedAt
  }
}

function createLearningQueryAsyncMock({ feedbackRows = [], candidateRows = [], promotionRows = [], featureIdentity = createFeatureIdentity() } = {}) {
  const feedbackState = feedbackRows.map(clone)
  const candidateState = candidateRows.map(clone)
  const promotionState = promotionRows.map(clone)
  const queries = []

  async function queryAsync(sql, params = []) {
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalizedSql, params: clone(params) })

    if (
      normalizedSql.startsWith('CREATE TABLE IF NOT EXISTS sales_v2_learning_candidates') ||
      normalizedSql.startsWith('CREATE TABLE IF NOT EXISTS sales_v2_learning_promotions') ||
      normalizedSql.startsWith('CREATE TABLE IF NOT EXISTS sales_v2_learning_cycle_state')
    ) {
      return []
    }

    if (normalizedSql.startsWith('SELECT state_key, status, active_feature_schema_version')) {
      return [{
        state_key: featureIdentity.state_key,
        status: featureIdentity.status,
        active_feature_schema_version: featureIdentity.feature_schema_version,
        active_feature_state_version: featureIdentity.feature_state_version,
        active_source_data_watermark: featureIdentity.source_data_watermark,
        active_source_max_date: featureIdentity.source_max_date
      }]
    }

    if (normalizedSql.startsWith('SELECT planned_visit_id') && normalizedSql.includes('FROM sales_v2_visit_feedback')) {
      return feedbackState.map(clone)
    }

    if (normalizedSql.startsWith('SELECT candidate_version') && normalizedSql.includes('WHERE candidate_version = ?')) {
      const row = candidateState.find(item => String(item.candidate_version) === String(params[0] || ''))
      return row ? [clone(row)] : []
    }

    if (normalizedSql.startsWith('SELECT candidate_version') && normalizedSql.includes('FROM sales_v2_learning_candidates')) {
      if (!candidateState.length) return []
      const latest = [...candidateState].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0]
      return [clone(latest)]
    }

    if (normalizedSql.startsWith('UPDATE sales_v2_learning_candidates SET status = \'archived\'')) {
      for (const row of candidateState) {
        if (row.status === 'candidate') {
          row.status = 'archived'
        }
      }
      return []
    }

    if (normalizedSql.startsWith('UPDATE sales_v2_learning_candidates SET status = ?')) {
      const nextStatus = String(params[0] || '')
      const candidateVersion = String(params[1] || '')
      const row = candidateState.find(item => String(item.candidate_version) === candidateVersion)
      if (row) {
        row.status = nextStatus
        row.updated_at = '2026-08-10 13:00:00'
      }
      return []
    }

    if (normalizedSql.startsWith('DELETE FROM sales_v2_learning_candidates WHERE candidate_version = ?')) {
      const candidateVersion = String(params[0] || '')
      const remaining = candidateState.filter(row => String(row.candidate_version) !== candidateVersion)
      candidateState.length = 0
      candidateState.push(...remaining)
      return []
    }

    if (normalizedSql.startsWith('INSERT INTO sales_v2_learning_candidates')) {
      candidateState.push({
        id: candidateState.length + 1,
        candidate_version: params[0],
        status: params[1],
        base_current_model_version: params[2],
        feature_schema_version: params[3],
        trained_at: params[4],
        training_data_cutoff: params[5],
        holdout_start_date: params[6],
        holdout_end_date: params[7],
        feedback_rows_available: params[8],
        feedback_rows_used: params[9],
        feedback_rows_holdout: params[10],
        targets_retrained_json: params[11],
        metrics_json: params[12],
        comparison_json: params[13],
        artifact_manifest_json: params[14],
        error_message: params[15],
        created_at: '2026-08-10 12:30:00',
        updated_at: '2026-08-10 12:30:00'
      })
      return { insertId: candidateState.length }
    }

    if (normalizedSql.startsWith('INSERT INTO sales_v2_learning_promotions')) {
      promotionState.push({
        id: promotionState.length + 1,
        action_type: params[0],
        status: params[1],
        candidate_version: params[2],
        previous_model_version: params[3],
        resulting_model_version: params[4],
        rollback_target_version: params[5],
        feature_schema_version: params[6],
        policy_json: params[7],
        evaluation_json: params[8],
        artifact_manifest_json: params[9],
        decision_reason: params[10],
        error_message: params[11],
        created_at: `2026-08-10 14:00:0${promotionState.length + 1}`,
        updated_at: `2026-08-10 14:00:0${promotionState.length + 1}`
      })
      return { insertId: promotionState.length }
    }

    if (normalizedSql.startsWith('SELECT action_type') && normalizedSql.includes('FROM sales_v2_learning_promotions')) {
      if (!promotionState.length) return []
      const latest = [...promotionState].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0]
      return [clone(latest)]
    }

    if (normalizedSql.startsWith('SELECT state_key') && normalizedSql.includes('FROM sales_v2_learning_cycle_state')) {
      return []
    }

    throw new Error(`Unhandled SQL in promotion test mock: ${normalizedSql}`)
  }

  return {
    queryAsync,
    queries,
    feedbackState,
    candidateState,
    promotionState
  }
}

test('better candidate promotes safely and preserves rollback archive', async () => {
  const baseDir = createArtifactsDir()
  const currentModel = __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY)
  const candidateVersion = 'candidate_better_one'
  const artifactManifest = createCandidateArtifacts(baseDir, candidateVersion)
  const { queryAsync, candidateState, promotionState } = createLearningQueryAsyncMock({
    candidateRows: [
      createCandidateRow({
        baseCurrentModelVersion: currentModel.model_version,
        candidateVersion,
        featureSchemaVersion: currentModel.feature_schema_version,
        artifactManifest
      })
    ]
  })

  const reloadCalls = []
  const invalidationCalls = []
  const result = await promoteSalesLearningCandidate({
    queryAsync,
    baseDir,
    reloadPredictionService: async payload => {
      reloadCalls.push(clone(payload))
      return { status: 'success', ...payload }
    },
    fetchPredictionServiceStatus: async () => ({
      status: 'success',
      ready: true,
      model_version: __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY).model_version,
      features_version: currentModel.features_version
    }),
    invalidateModelDependentCaches: async payload => {
      invalidationCalls.push(clone(payload))
      return { status: 'cleared', ...payload }
    }
  })

  const promotedModel = __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY)
  const archiveDirectory = __testables.buildModelArchiveDirectory(baseDir, currentModel.model_version)

  assert.equal(result.status, 'successful')
  assert.notEqual(promotedModel.model_version, currentModel.model_version)
  assert.equal(candidateState[0].status, 'promoted')
  assert.equal(promotionState.at(-1).status, 'successful')
  assert.equal(reloadCalls.length, 1)
  assert.equal(invalidationCalls.length, 1)
  assert.equal(invalidationCalls[0].action, 'promote')
  assert.ok(fs.existsSync(path.join(archiveDirectory, 'modele_nomadis_achat.pkl')))

  const status = await getSalesLearningStatus(queryAsync, { baseDir })
  assert.equal(status.latest_promotion.status, 'successful')
  assert.equal(status.latest_promotion.candidate_version, candidateVersion)
})

test('worse candidate keeps the current model and never reloads production', async () => {
  const baseDir = createArtifactsDir()
  const currentModel = __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY)
  const candidateVersion = 'candidate_worse_one'
  const artifactManifest = createCandidateArtifacts(baseDir, candidateVersion)
  const { queryAsync, promotionState } = createLearningQueryAsyncMock({
    candidateRows: [
      createCandidateRow({
        baseCurrentModelVersion: currentModel.model_version,
        candidateVersion,
        featureSchemaVersion: currentModel.feature_schema_version,
        artifactManifest,
        purchaseCurrent: { auc: 0.7, logloss: 0.35, bias: 0.01 },
        purchaseCandidate: { auc: 0.62, logloss: 0.48, bias: 0.03 }
      })
    ]
  })

  let reloadCalled = false
  const result = await promoteSalesLearningCandidate({
    queryAsync,
    baseDir,
    reloadPredictionService: async () => {
      reloadCalled = true
      return { status: 'success' }
    },
    fetchPredictionServiceStatus: async () => ({
      ready: true,
      model_version: currentModel.model_version,
      features_version: currentModel.features_version
    })
  })

  assert.equal(result.status, 'current_retained')
  assert.equal(reloadCalled, false)
  assert.equal(__testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY).model_version, currentModel.model_version)
  assert.equal(promotionState.at(-1).status, 'current_retained')
})

test('insufficient evidence and incompatible schema both block promotion', async () => {
  const baseDir = createArtifactsDir()
  const currentModel = __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY)
  const candidateVersionA = 'candidate_low_evidence'
  const candidateVersionB = 'candidate_bad_schema'
  const artifactManifestA = createCandidateArtifacts(baseDir, candidateVersionA)
  const artifactManifestB = createCandidateArtifacts(baseDir, candidateVersionB, {
    purchase_probability: 'candidate:purchase:b'
  })
  const { queryAsync } = createLearningQueryAsyncMock({
    candidateRows: [
      createCandidateRow({
        baseCurrentModelVersion: currentModel.model_version,
        candidateVersion: candidateVersionA,
        featureSchemaVersion: currentModel.feature_schema_version,
        artifactManifest: artifactManifestA,
        purchaseComparableCount: DEFAULT_PROMOTION_MIN_EVAL_OBSERVATIONS - 1
      }),
      createCandidateRow({
        baseCurrentModelVersion: currentModel.model_version,
        candidateVersion: candidateVersionB,
        featureSchemaVersion: 'sha1:other-schema',
        artifactManifest: artifactManifestB,
        createdAt: '2026-08-10 13:00:00',
        updatedAt: '2026-08-10 13:00:00'
      })
    ]
  })

  const lowEvidence = await promoteSalesLearningCandidate({
    queryAsync,
    baseDir,
    candidateVersion: candidateVersionA,
    reloadPredictionService: async () => ({ status: 'success' }),
    fetchPredictionServiceStatus: async () => ({
      ready: true,
      model_version: currentModel.model_version,
      features_version: currentModel.features_version
    })
  })
  const badSchema = await promoteSalesLearningCandidate({
    queryAsync,
    baseDir,
    candidateVersion: candidateVersionB,
    reloadPredictionService: async () => ({ status: 'success' }),
    fetchPredictionServiceStatus: async () => ({
      ready: true,
      model_version: currentModel.model_version,
      features_version: currentModel.features_version
    })
  })

  assert.equal(lowEvidence.status, 'insufficient_evidence')
  assert.equal(badSchema.status, 'current_retained')
  assert.equal(__testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY).model_version, currentModel.model_version)
})

test('missing candidate artifact or failed reload never leaves production promoted', async () => {
  const baseDir = createArtifactsDir()
  const currentModel = __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY)
  const missingArtifactVersion = 'candidate_missing_artifact'
  const reloadFailVersion = 'candidate_reload_fails'
  const missingArtifactManifest = createCandidateArtifacts(baseDir, missingArtifactVersion)
  fs.rmSync(missingArtifactManifest.files.quantity_if_buy, { force: true })
  const reloadFailManifest = createCandidateArtifacts(baseDir, reloadFailVersion, {
    purchase_probability: 'candidate:reload-fail-purchase'
  })
  const { queryAsync, promotionState } = createLearningQueryAsyncMock({
    candidateRows: [
      createCandidateRow({
        baseCurrentModelVersion: currentModel.model_version,
        candidateVersion: missingArtifactVersion,
        featureSchemaVersion: currentModel.feature_schema_version,
        artifactManifest: missingArtifactManifest,
        createdAt: '2026-08-10 12:00:00',
        updatedAt: '2026-08-10 12:00:00'
      }),
      createCandidateRow({
        baseCurrentModelVersion: currentModel.model_version,
        candidateVersion: reloadFailVersion,
        featureSchemaVersion: currentModel.feature_schema_version,
        artifactManifest: reloadFailManifest,
        createdAt: '2026-08-10 13:00:00',
        updatedAt: '2026-08-10 13:00:00'
      })
    ]
  })

  const missingResult = await promoteSalesLearningCandidate({
    queryAsync,
    baseDir,
    candidateVersion: missingArtifactVersion,
    reloadPredictionService: async () => ({ status: 'success' }),
    fetchPredictionServiceStatus: async () => ({
      ready: true,
      model_version: currentModel.model_version,
      features_version: currentModel.features_version
    })
  })

  let reloadAttempt = 0
  const reloadFailureResult = await promoteSalesLearningCandidate({
    queryAsync,
    baseDir,
    candidateVersion: reloadFailVersion,
    reloadPredictionService: async () => {
      reloadAttempt += 1
      if (reloadAttempt === 1) {
        throw new Error('reload failed')
      }
      return { status: 'success' }
    },
    fetchPredictionServiceStatus: async () => ({
      ready: true,
      model_version: currentModel.model_version,
      features_version: currentModel.features_version
    })
  })

  assert.equal(missingResult.status, 'failed')
  assert.equal(reloadFailureResult.status, 'failed')
  assert.equal(reloadAttempt, 2)
  assert.equal(__testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY).model_version, currentModel.model_version)
  assert.equal(promotionState.at(-1).status, 'failed')
})

test('rollback restores the previous archived current version', async () => {
  const baseDir = createArtifactsDir()
  const currentModel = __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY)
  const candidateVersion = 'candidate_rollback_target'
  const artifactManifest = createCandidateArtifacts(baseDir, candidateVersion, {
    purchase_probability: 'candidate:rollback-purchase'
  })
  const { queryAsync } = createLearningQueryAsyncMock({
    candidateRows: [
      createCandidateRow({
        baseCurrentModelVersion: currentModel.model_version,
        candidateVersion,
        featureSchemaVersion: currentModel.feature_schema_version,
        artifactManifest
      })
    ]
  })

  await promoteSalesLearningCandidate({
    queryAsync,
    baseDir,
    reloadPredictionService: async payload => ({ status: 'success', ...payload }),
    fetchPredictionServiceStatus: async () => ({
      ready: true,
      model_version: __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY).model_version,
      features_version: currentModel.features_version
    }),
    invalidateModelDependentCaches: async () => ({ status: 'cleared' })
  })

  const promotedModel = __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY)
  assert.notEqual(promotedModel.model_version, currentModel.model_version)

  const rollbackResult = await rollbackSalesLearningModel({
    queryAsync,
    baseDir,
    rollbackTargetVersion: currentModel.model_version,
    reloadPredictionService: async payload => ({ status: 'success', ...payload }),
    fetchPredictionServiceStatus: async () => ({
      ready: true,
      model_version: __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY).model_version,
      features_version: currentModel.features_version
    }),
    invalidateModelDependentCaches: async () => ({ status: 'cleared' })
  })

  assert.equal(rollbackResult.status, 'successful')
  assert.equal(__testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY).model_version, currentModel.model_version)

  const status = await getSalesLearningStatus(queryAsync, { baseDir })
  assert.equal(status.latest_promotion.action_type, 'rollback')
  assert.equal(status.latest_promotion.status, 'successful')
})

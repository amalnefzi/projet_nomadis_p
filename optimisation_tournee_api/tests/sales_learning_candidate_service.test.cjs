const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_MIN_VALID_FEEDBACK_ROWS,
  getSalesLearningStatus,
  retrainSalesLearningCandidate,
  __testables
} = require('../sales_learning_candidate_service')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createFeedbackRow({
  plannedVisitId,
  clientCode,
  commercialCode,
  plannedDate,
  executionStatus = 'pending',
  purchaseMade = null,
  actualCa = null,
  actualQuantity = null,
  snapshot = {}
}) {
  return {
    planned_visit_id: plannedVisitId,
    assigned_slot_id: `${plannedDate}::${commercialCode}`,
    client_id: clientCode,
    client_code: clientCode,
    commercial_code: commercialCode,
    planned_date: plannedDate,
    execution_status: executionStatus,
    purchase_made: purchaseMade == null ? null : (purchaseMade ? 1 : 0),
    actual_ca: actualCa,
    actual_quantity: actualQuantity,
    visit_date_actual: null,
    note: null,
    non_visit_reason: null,
    no_purchase_reason: null,
    prediction_snapshot_json: JSON.stringify({
      predicted_ca: snapshot.predicted_ca ?? null,
      predicted_ca_if_buy: snapshot.predicted_ca_if_buy ?? null,
      recommended_quantity: snapshot.recommended_quantity ?? null,
      predicted_quantity_if_buy: snapshot.predicted_quantity_if_buy ?? null,
      priority: snapshot.priority ?? null,
      portfolio_status: snapshot.portfolio_status ?? null,
      planned_date: plannedDate,
      basket_prediction_source: snapshot.basket_prediction_source ?? null,
      purchase_probability: snapshot.purchase_probability ?? null
    }),
    created_at: '2026-08-10 09:00:00',
    updated_at: '2026-08-10 09:00:00'
  }
}

function createArtifactsDir() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-learning-artifacts-'))
  for (const fileName of [
    ...__testables.MODEL_ARTIFACT_FILES,
    ...__testables.FEATURE_ARTIFACT_FILES
  ]) {
    const targetPath = path.join(baseDir, fileName)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, `artifact:${fileName}`, 'utf8')
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

function buildCandidateRowFromParams(params, createdIndex) {
  return {
    id: createdIndex,
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
    created_at: `2026-08-10 10:00:0${createdIndex}`,
    updated_at: `2026-08-10 10:00:0${createdIndex}`
  }
}

function createLearningQueryAsyncMock(seedRows = [], { featureIdentity = createFeatureIdentity() } = {}) {
  const feedbackRows = seedRows.map(clone)
  const candidateRows = []
  const promotionRows = []
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
      let result = feedbackRows.map(clone)
      let paramIndex = 0
      if (normalizedSql.includes('planned_date >= ?')) {
        const startDate = String(params[paramIndex++] || '')
        result = result.filter(row => String(row.planned_date) >= startDate)
      }
      if (normalizedSql.includes('planned_date <= ?')) {
        const endDate = String(params[paramIndex++] || '')
        result = result.filter(row => String(row.planned_date) <= endDate)
      }
      if (normalizedSql.includes('commercial_code IN')) {
        const commercialCodes = params.slice(paramIndex).map(value => String(value))
        result = result.filter(row => commercialCodes.includes(String(row.commercial_code)))
      }
      return result
    }

    if (normalizedSql.startsWith('UPDATE sales_v2_learning_candidates SET status = \'archived\'')) {
      for (const row of candidateRows) {
        if (row.status === 'candidate') {
          row.status = 'archived'
        }
      }
      return []
    }

    if (normalizedSql.startsWith('DELETE FROM sales_v2_learning_candidates WHERE candidate_version = ?')) {
      const candidateVersion = String(params[0] || '')
      const remaining = candidateRows.filter(row => String(row.candidate_version) !== candidateVersion)
      candidateRows.length = 0
      candidateRows.push(...remaining)
      return []
    }

    if (normalizedSql.startsWith('INSERT INTO sales_v2_learning_candidates')) {
      candidateRows.push(buildCandidateRowFromParams(params, candidateRows.length + 1))
      return { insertId: candidateRows.length }
    }

    if (normalizedSql.startsWith('INSERT INTO sales_v2_learning_promotions')) {
      promotionRows.push({
        id: promotionRows.length + 1,
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
        created_at: `2026-08-10 11:00:0${promotionRows.length + 1}`,
        updated_at: `2026-08-10 11:00:0${promotionRows.length + 1}`
      })
      return { insertId: promotionRows.length }
    }

    if (normalizedSql.startsWith('SELECT candidate_version') && normalizedSql.includes('FROM sales_v2_learning_candidates')) {
      if (!candidateRows.length) return []
      return [clone(candidateRows[candidateRows.length - 1])]
    }

    if (normalizedSql.startsWith('SELECT action_type') && normalizedSql.includes('FROM sales_v2_learning_promotions')) {
      if (!promotionRows.length) return []
      return [clone(promotionRows[promotionRows.length - 1])]
    }

    if (normalizedSql.startsWith('SELECT state_key') && normalizedSql.includes('FROM sales_v2_learning_cycle_state')) {
      return []
    }

    throw new Error(`Unhandled SQL in test mock: ${normalizedSql}`)
  }

  return { queryAsync, queries, candidateRows, promotionRows, feedbackRows }
}

test('insufficient feedback returns insufficient_data and does not start training', async () => {
  const baseDir = createArtifactsDir()
  const { queryAsync, candidateRows } = createLearningQueryAsyncMock([
    createFeedbackRow({
      plannedVisitId: 'pv1',
      clientCode: '00012',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-10',
      executionStatus: 'visited',
      purchaseMade: true,
      actualCa: 120
    })
  ])

  let runnerCalled = false
  const result = await retrainSalesLearningCandidate({
    queryAsync,
    baseDir,
    minValidFeedbackRows: 2,
    learningRunner: async () => {
      runnerCalled = true
      return {}
    }
  })

  assert.equal(result.status, 'insufficient_data')
  assert.equal(runnerCalled, false)
  assert.equal(candidateRows.length, 0)
  assert.equal(result.feedback.min_valid_feedback_rows, 2)
})

test('candidate artifact directories are version-safe on Windows paths', () => {
  const baseDir = createArtifactsDir()
  const directory = __testables.buildCandidateArtifactsDirectory(baseDir, 'candidate:aeb55c9212b3ae4d1bb7')

  assert.match(directory, /candidate_models[\\\/]candidate%3Aaeb55c9212b3ae4d1bb7$/)
  assert.doesNotMatch(path.basename(directory), /:/)
})

test('eligible feedback rows are deterministic, preserve exact codes, and exclude pending/not_visited rows from training payload', async () => {
  const baseDir = createArtifactsDir()
  const { queryAsync, candidateRows } = createLearningQueryAsyncMock([
    createFeedbackRow({
      plannedVisitId: 'pv-pending',
      clientCode: '00001',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-10',
      executionStatus: 'pending'
    }),
    createFeedbackRow({
      plannedVisitId: 'pv-not-visited',
      clientCode: '00002',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-11',
      executionStatus: 'not_visited'
    }),
    createFeedbackRow({
      plannedVisitId: 'pv-a',
      clientCode: '00012',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-10',
      executionStatus: 'visited',
      purchaseMade: true,
      actualCa: 120,
      actualQuantity: 8
    }),
    createFeedbackRow({
      plannedVisitId: 'pv-b',
      clientCode: '00013',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-11',
      executionStatus: 'visited',
      purchaseMade: false
    }),
    createFeedbackRow({
      plannedVisitId: 'pv-c',
      clientCode: '00014',
      commercialCode: 'VL1901',
      plannedDate: '2026-08-12',
      executionStatus: 'visited',
      purchaseMade: true,
      actualCa: 90,
      actualQuantity: 4
    })
  ])

  const capturedPayloads = []
  const runner = async ({ payload, outputDir }) => {
    capturedPayloads.push({ payload: clone(payload), outputDir })
    return {
      status: 'success',
      candidate_version: payload.candidate_version,
      trained_at: '2026-08-10T12:00:00Z',
      training_data_cutoff: payload.train_rows.at(-1)?.planned_date ?? null,
      feedback_rows_used: payload.train_rows.length,
      feedback_rows_holdout: payload.holdout_rows.length,
      holdout_window: {
        start_date: payload.holdout_rows[0]?.planned_date ?? null,
        end_date: payload.holdout_rows.at(-1)?.planned_date ?? null
      },
      targets_retrained: ['purchase_probability'],
      current_model: {
        purchase_probability: { comparable_count: 1, auc: 0.6, logloss: 0.7, bias: 0.05 }
      },
      candidate_model: {
        purchase_probability: { comparable_count: 1, auc: 0.7, logloss: 0.6, bias: 0.02 }
      },
      delta: {
        purchase_probability: { auc: 0.1, logloss: -0.1, bias: -0.03 }
      },
      recommendation: 'candidate_better',
      artifact_manifest: { files: {} },
      metrics: { note: 'ok' },
      error: null
    }
  }

  const result = await retrainSalesLearningCandidate({
    queryAsync,
    baseDir,
    minValidFeedbackRows: 3,
    holdoutRatio: 0.2,
    minHoldoutRows: 1,
    learningRunner: runner
  })

  assert.equal(result.status, 'success')
  assert.equal(candidateRows.length, 1)
  assert.equal(capturedPayloads.length, 1)
  assert.equal(capturedPayloads[0].payload.train_rows.length, 2)
  assert.equal(capturedPayloads[0].payload.holdout_rows.length, 1)
  assert.deepEqual(
    capturedPayloads[0].payload.train_rows.map(row => row.planned_visit_id),
    ['pv-a', 'pv-b']
  )
  assert.deepEqual(
    capturedPayloads[0].payload.holdout_rows.map(row => row.planned_visit_id),
    ['pv-c']
  )
  assert.equal(capturedPayloads[0].payload.train_rows[0].client_code, '00012')
  assert.equal(capturedPayloads[0].payload.train_rows[0].commercial_code, 'VL1900')
  assert.match(capturedPayloads[0].outputDir, /candidate_models/)
})

test('candidate version is deterministic for identical inputs and distinct from current model version', () => {
  const candidateA = __testables.buildCandidateVersion({
    currentModelVersion: 'sha1:current123',
    featureSchemaVersion: 'sha1:features123',
    feedbackRowsUsed: 42,
    trainingDataCutoff: '2026-08-10'
  })
  const candidateB = __testables.buildCandidateVersion({
    currentModelVersion: 'sha1:current123',
    featureSchemaVersion: 'sha1:features123',
    feedbackRowsUsed: 42,
    trainingDataCutoff: '2026-08-10'
  })

  assert.equal(candidateA, candidateB)
  assert.notEqual(candidateA, 'sha1:current123')
})

test('failed training persists a failed candidate record and keeps current model metadata available', async () => {
  const baseDir = createArtifactsDir()
  const { queryAsync, candidateRows } = createLearningQueryAsyncMock([
    createFeedbackRow({
      plannedVisitId: 'pv-a',
      clientCode: '00012',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-10',
      executionStatus: 'visited',
      purchaseMade: true,
      actualCa: 120
    }),
    createFeedbackRow({
      plannedVisitId: 'pv-b',
      clientCode: '00013',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-11',
      executionStatus: 'visited',
      purchaseMade: false
    })
  ])

  const statusBefore = await getSalesLearningStatus(queryAsync, {
    baseDir,
    minValidFeedbackRows: 2
  })

  const result = await retrainSalesLearningCandidate({
    queryAsync,
    baseDir,
    minValidFeedbackRows: 2,
    learningRunner: async () => {
      throw new Error('training exploded')
    }
  })

  const statusAfter = await getSalesLearningStatus(queryAsync, {
    baseDir,
    minValidFeedbackRows: 2
  })

  assert.equal(result.status, 'failed')
  assert.equal(candidateRows.length, 1)
  assert.equal(statusBefore.current_model.model_version, statusAfter.current_model.model_version)
  assert.equal(statusAfter.latest_candidate.status, 'failed')
  assert.equal(statusAfter.latest_candidate.error, 'training exploded')
})

test('non-success runner results are persisted and latest candidate status is exposed', async () => {
  const baseDir = createArtifactsDir()
  const { queryAsync } = createLearningQueryAsyncMock([
    createFeedbackRow({
      plannedVisitId: 'pv-a',
      clientCode: '00012',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-10',
      executionStatus: 'visited',
      purchaseMade: true,
      actualCa: 120
    }),
    createFeedbackRow({
      plannedVisitId: 'pv-b',
      clientCode: '00013',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-11',
      executionStatus: 'visited',
      purchaseMade: false
    })
  ])

  const retrainResult = await retrainSalesLearningCandidate({
    queryAsync,
    baseDir,
    minValidFeedbackRows: 2,
    learningRunner: async ({ payload }) => ({
      status: 'insufficient_data',
      candidate_version: payload.candidate_version,
      trained_at: '2026-08-10T12:00:00Z',
      training_data_cutoff: payload.train_rows.at(-1)?.planned_date ?? null,
      feedback_rows_used: payload.train_rows.length,
      feedback_rows_holdout: payload.holdout_rows.length,
      holdout_window: null,
      targets_retrained: [],
      current_model: null,
      candidate_model: null,
      delta: {},
      recommendation: 'insufficient_data',
      artifact_manifest: null,
      metrics: null,
      error: null
    })
  })

  const status = await getSalesLearningStatus(queryAsync, {
    baseDir,
    minValidFeedbackRows: 2
  })

  assert.equal(retrainResult.status, 'insufficient_data')
  assert.equal(status.latest_candidate.status, 'failed')
  assert.equal(status.latest_candidate.recommendation, 'insufficient_data')
})

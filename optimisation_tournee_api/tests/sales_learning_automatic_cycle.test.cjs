const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_MIN_VALID_FEEDBACK_ROWS,
  executeAutomaticSalesLearningCycle,
  getSalesLearningStatus,
  startAutomaticSalesLearningCycle,
  __testables
} = require('../sales_learning_candidate_service')

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function createArtifactsDir() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-learning-auto-cycle-'))
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

function createFeedbackRow({
  plannedVisitId,
  clientCode,
  commercialCode,
  plannedDate,
  executionStatus = 'pending',
  purchaseMade = null,
  actualCa = null,
  actualQuantity = null,
  updatedAt = '2026-08-10 09:00:00'
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
      predicted_ca: 100,
      predicted_ca_if_buy: 140,
      recommended_quantity: 5,
      predicted_quantity_if_buy: 7,
      priority: 0.8,
      portfolio_status: 'due_now',
      planned_date: plannedDate,
      basket_prediction_source: 'historical_pattern',
      purchase_probability: 0.65
    }),
    created_at: updatedAt,
    updated_at: updatedAt
  }
}

function createCycleStateRow(params) {
  return {
    state_key: params[0],
    cycle_status: params[1],
    last_cycle_started_at: params[2],
    last_cycle_finished_at: params[3],
    last_decision: params[4],
    last_reason: params[5],
    current_model_version: params[6],
    latest_candidate_version: params[7],
    latest_comparison_json: params[8],
    minimum_feedback_required: params[9],
    valid_feedback_rows_available: params[10],
    new_valid_feedback_count: params[11],
    feedback_cutoff_used: params[12],
    processed_feedback_signature: params[13],
    processed_feedback_rows: params[14],
    failed_feedback_signature: params[15],
    failed_feedback_rows: params[16],
    last_error_message: params[17],
    last_checked_at: params[18],
    created_at: '2026-08-10 10:00:00',
    updated_at: '2026-08-10 10:00:00'
  }
}

function createLearningQueryAsyncMock({
  feedbackRows = [],
  candidateRows = [],
  promotionRows = [],
  cycleState = null,
  featureIdentity = createFeatureIdentity()
} = {}) {
  const feedbackState = feedbackRows.map(clone)
  const candidateState = candidateRows.map(clone)
  const promotionState = promotionRows.map(clone)
  let cycleStateRow = cycleState ? clone(cycleState) : null
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

    if (normalizedSql.startsWith('SELECT candidate_version') && normalizedSql.includes('FROM sales_v2_learning_candidates')) {
      if (!candidateState.length) return []
      const latest = [...candidateState].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0]
      return [clone(latest)]
    }

    if (normalizedSql.startsWith('SELECT action_type') && normalizedSql.includes('FROM sales_v2_learning_promotions')) {
      if (!promotionState.length) return []
      const latest = [...promotionState].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0]
      return [clone(latest)]
    }

    if (normalizedSql.startsWith('SELECT state_key') && normalizedSql.includes('FROM sales_v2_learning_cycle_state')) {
      return cycleStateRow ? [clone(cycleStateRow)] : []
    }

    if (normalizedSql.startsWith('INSERT INTO sales_v2_learning_cycle_state')) {
      cycleStateRow = createCycleStateRow(params)
      cycleStateRow.updated_at = '2026-08-10 10:05:00'
      return { insertId: 1 }
    }

    throw new Error(`Unhandled SQL in automatic cycle test mock: ${normalizedSql}`)
  }

  return {
    queryAsync,
    queries,
    feedbackState,
    candidateState,
    promotionState,
    getCycleState: () => clone(cycleStateRow)
  }
}

function buildSuccessCandidateResult(candidateVersion = 'candidate:auto') {
  return {
    status: 'success',
    candidate: {
      candidate_version: candidateVersion,
      status: 'candidate',
      recommendation: 'candidate_better',
      current_model: {
        purchase_probability: { comparable_count: 20, logloss: 0.5, auc: 0.6 },
        ca_if_buy: { comparable_count: 20, mae: 12, rmse: 18 },
        quantity_if_buy: { comparable_count: 20, mae: 2.5, rmse: 4.0 }
      },
      candidate_model: {
        purchase_probability: { comparable_count: 20, logloss: 0.42, auc: 0.67 },
        ca_if_buy: { comparable_count: 20, mae: 10, rmse: 15 },
        quantity_if_buy: { comparable_count: 20, mae: 2.0, rmse: 3.5 }
      },
      delta: {},
      artifact_manifest: { files: {} }
    }
  }
}

test('insufficient new feedback keeps waiting_for_feedback and does not retrain', async () => {
  const baseDir = createArtifactsDir()
  const { queryAsync } = createLearningQueryAsyncMock({
    feedbackRows: [
      createFeedbackRow({
        plannedVisitId: 'pv-1',
        clientCode: '00012',
        commercialCode: 'VL1900',
        plannedDate: '2026-08-10',
        executionStatus: 'visited',
        purchaseMade: true
      })
    ]
  })

  let retrainCalled = false
  const result = await executeAutomaticSalesLearningCycle({
    queryAsync,
    baseDir,
    minValidFeedbackRows: 2,
    retrainCandidate: async () => {
      retrainCalled = true
      return {}
    },
    promoteCandidate: async () => ({ status: 'successful' })
  })

  assert.equal(result.status, 'waiting_for_feedback')
  assert.equal(retrainCalled, false)
  assert.equal(result.learning_cycle.cycle_status, 'waiting_for_feedback')
  assert.equal(result.feedback.new_valid_feedback_count, 1)
})

test('enough new feedback starts one cycle and marks current retained feedback as processed', async () => {
  const baseDir = createArtifactsDir()
  const { queryAsync, getCycleState } = createLearningQueryAsyncMock({
    feedbackRows: [
      createFeedbackRow({
        plannedVisitId: 'pv-1',
        clientCode: '00012',
        commercialCode: 'VL1900',
        plannedDate: '2026-08-10',
        executionStatus: 'visited',
        purchaseMade: true,
        updatedAt: '2026-08-10 09:00:00'
      }),
      createFeedbackRow({
        plannedVisitId: 'pv-2',
        clientCode: '00013',
        commercialCode: 'VL1900',
        plannedDate: '2026-08-11',
        executionStatus: 'visited',
        purchaseMade: false,
        updatedAt: '2026-08-11 09:00:00'
      })
    ]
  })

  let retrainCalled = 0
  let promoteCalled = 0
  const result = await executeAutomaticSalesLearningCycle({
    queryAsync,
    baseDir,
    minValidFeedbackRows: 2,
    retrainCandidate: async () => {
      retrainCalled += 1
      return buildSuccessCandidateResult('candidate:retained')
    },
    promoteCandidate: async () => {
      promoteCalled += 1
      return {
        status: 'current_retained',
        current_model: __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY),
        evaluation: {
          decision_reason: 'one_or_more_targets_not_improved'
        }
      }
    }
  })

  assert.equal(retrainCalled, 1)
  assert.equal(promoteCalled, 1)
  assert.equal(result.learning_cycle.cycle_status, 'current_kept')
  assert.equal(getCycleState().processed_feedback_rows, 2)
  assert.ok(getCycleState().processed_feedback_signature)
})

test('same feedback does not retrigger endlessly after a completed cycle', async () => {
  const baseDir = createArtifactsDir()
  const feedbackRows = [
    createFeedbackRow({
      plannedVisitId: 'pv-1',
      clientCode: '00012',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-10',
      executionStatus: 'visited',
      purchaseMade: true,
      updatedAt: '2026-08-10 09:00:00'
    }),
    createFeedbackRow({
      plannedVisitId: 'pv-2',
      clientCode: '00013',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-11',
      executionStatus: 'visited',
      purchaseMade: false,
      updatedAt: '2026-08-11 09:00:00'
    })
  ]
  const { queryAsync } = createLearningQueryAsyncMock({ feedbackRows })

  let retrainCalled = 0
  const cycleOptions = {
    queryAsync,
    baseDir,
    minValidFeedbackRows: 2,
    retrainCandidate: async () => {
      retrainCalled += 1
      return buildSuccessCandidateResult('candidate:no-repeat')
    },
    promoteCandidate: async () => ({
      status: 'current_retained',
      current_model: __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY),
      evaluation: { decision_reason: 'one_or_more_targets_not_improved' }
    })
  }

  const firstResult = await executeAutomaticSalesLearningCycle(cycleOptions)
  const secondResult = await executeAutomaticSalesLearningCycle(cycleOptions)

  assert.equal(firstResult.learning_cycle.cycle_status, 'current_kept')
  assert.equal(secondResult.status, 'waiting_for_feedback')
  assert.equal(retrainCalled, 1)
})

test('concurrent automatic checks reuse a single in-flight cycle', async () => {
  const baseDir = createArtifactsDir()
  const { queryAsync } = createLearningQueryAsyncMock({
    feedbackRows: [
      createFeedbackRow({
        plannedVisitId: 'pv-1',
        clientCode: '00012',
        commercialCode: 'VL1900',
        plannedDate: '2026-08-10',
        executionStatus: 'visited',
        purchaseMade: true
      }),
      createFeedbackRow({
        plannedVisitId: 'pv-2',
        clientCode: '00013',
        commercialCode: 'VL1900',
        plannedDate: '2026-08-11',
        executionStatus: 'visited',
        purchaseMade: false
      })
    ]
  })

  let retrainCalled = 0
  const retrainCandidate = async () => {
    retrainCalled += 1
    await new Promise(resolve => setTimeout(resolve, 50))
    return buildSuccessCandidateResult('candidate:single-flight')
  }

  const [left, right] = await Promise.all([
    startAutomaticSalesLearningCycle({
      queryAsync,
      baseDir,
      minValidFeedbackRows: 2,
      retrainCandidate,
      promoteCandidate: async () => ({
        status: 'current_retained',
        current_model: __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY),
        evaluation: { decision_reason: 'one_or_more_targets_not_improved' }
      })
    }),
    startAutomaticSalesLearningCycle({
      queryAsync,
      baseDir,
      minValidFeedbackRows: 2,
      retrainCandidate,
      promoteCandidate: async () => ({
        status: 'current_retained',
        current_model: __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY),
        evaluation: { decision_reason: 'one_or_more_targets_not_improved' }
      })
    })
  ])

  assert.equal(retrainCalled, 1)
  assert.deepEqual(left, right)
})

test('failed training keeps current model untouched and new feedback can trigger a later retry', async () => {
  const baseDir = createArtifactsDir()
  const feedbackRows = [
    createFeedbackRow({
      plannedVisitId: 'pv-1',
      clientCode: '00012',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-10',
      executionStatus: 'visited',
      purchaseMade: true,
      updatedAt: '2026-08-10 09:00:00'
    }),
    createFeedbackRow({
      plannedVisitId: 'pv-2',
      clientCode: '00013',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-11',
      executionStatus: 'visited',
      purchaseMade: false,
      updatedAt: '2026-08-11 09:00:00'
    })
  ]
  const mock = createLearningQueryAsyncMock({ feedbackRows })
  const currentModelBefore = __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY)

  let firstCalls = 0
  const firstResult = await executeAutomaticSalesLearningCycle({
    queryAsync: mock.queryAsync,
    baseDir,
    minValidFeedbackRows: 2,
    retrainCandidate: async () => {
      firstCalls += 1
      throw new Error('training exploded')
    },
    promoteCandidate: async () => ({ status: 'successful' })
  })

  assert.equal(firstResult.status, 'failed')
  assert.equal(firstCalls, 1)
  assert.equal(firstResult.current_model.model_version, currentModelBefore.model_version)

  const secondResult = await executeAutomaticSalesLearningCycle({
    queryAsync: mock.queryAsync,
    baseDir,
    minValidFeedbackRows: 2,
    retrainCandidate: async () => {
      throw new Error('should not retry same failed feedback automatically')
    },
    promoteCandidate: async () => ({ status: 'successful' })
  })

  assert.equal(secondResult.status, 'failed')

  mock.feedbackState.push(createFeedbackRow({
    plannedVisitId: 'pv-3',
    clientCode: '00014',
    commercialCode: 'VL1901',
    plannedDate: '2026-08-12',
    executionStatus: 'visited',
    purchaseMade: true,
    updatedAt: '2026-08-12 09:00:00'
  }))

  let retryCalls = 0
  const thirdResult = await executeAutomaticSalesLearningCycle({
    queryAsync: mock.queryAsync,
    baseDir,
    minValidFeedbackRows: 2,
    retrainCandidate: async () => {
      retryCalls += 1
      return buildSuccessCandidateResult('candidate:retry')
    },
    promoteCandidate: async () => ({
      status: 'successful',
      current_model: __testables.buildCurrentModelMetadata(baseDir, DEFAULT_FEATURE_IDENTITY),
      evaluation: { decision_reason: 'all_targets_pass_policy' }
    })
  })

  assert.equal(retryCalls, 1)
  assert.equal(thirdResult.learning_cycle.cycle_status, 'promoted')
})

test('learning status exposes cycle state and accurate new feedback counts', async () => {
  const baseDir = createArtifactsDir()
  const feedbackRows = [
    createFeedbackRow({
      plannedVisitId: 'pv-1',
      clientCode: '00012',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-10',
      executionStatus: 'visited',
      purchaseMade: true,
      updatedAt: '2026-08-10 09:00:00'
    }),
    createFeedbackRow({
      plannedVisitId: 'pv-2',
      clientCode: '00013',
      commercialCode: 'VL1900',
      plannedDate: '2026-08-11',
      executionStatus: 'pending',
      updatedAt: '2026-08-11 09:00:00'
    })
  ]
  const cycleState = {
    state_key: 'default',
    cycle_status: 'current_kept',
    last_cycle_started_at: '2026-08-10T10:00:00.000Z',
    last_cycle_finished_at: '2026-08-10T10:10:00.000Z',
    last_decision: 'current_retained',
    last_reason: 'one_or_more_targets_not_improved',
    current_model_version: 'model-v1',
    latest_candidate_version: 'candidate:abc',
    latest_comparison_json: JSON.stringify({ decision_reason: 'one_or_more_targets_not_improved' }),
    minimum_feedback_required: DEFAULT_MIN_VALID_FEEDBACK_ROWS,
    valid_feedback_rows_available: 1,
    new_valid_feedback_count: 0,
    feedback_cutoff_used: '2026-08-10T09:00:00.000Z',
    processed_feedback_signature: 'sig-1',
    processed_feedback_rows: 1,
    failed_feedback_signature: null,
    failed_feedback_rows: 0,
    last_error_message: null,
    last_checked_at: '2026-08-10T10:10:00.000Z',
    created_at: '2026-08-10T10:00:00.000Z',
    updated_at: '2026-08-10T10:10:00.000Z'
  }
  const { queryAsync } = createLearningQueryAsyncMock({ feedbackRows, cycleState })

  const status = await getSalesLearningStatus(queryAsync, {
    baseDir,
    minValidFeedbackRows: 2
  })

  assert.equal(status.learning_cycle_status, 'current_kept')
  assert.equal(status.new_valid_feedback_count, 0)
  assert.equal(status.minimum_feedback_required, 2)
  assert.equal(status.learning_cycle.feedback_cutoff_used, '2026-08-10T09:00:00.000Z')
  assert.equal(status.feedback.valid_feedback_rows_available, 1)
  assert.equal(status.feedback.new_valid_feedback_count, 0)
})

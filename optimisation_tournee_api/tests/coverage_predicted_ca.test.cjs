const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildCoverageNonCancelledDocumentSqlCondition,
  resolveCoveragePredictedCa
} = require('../coverage_predicted_ca')

test('client with historical avg CA keeps the value and marks the source as sales history', () => {
  const result = resolveCoveragePredictedCa({ avg_ca_hist: 360.3 })

  assert.equal(result.predicted_ca, 360.3)
  assert.equal(result.predicted_ca_known, true)
  assert.equal(result.predicted_ca_source, 'sales_history')
})

test('client without historical CA does not turn a categorical potentiel into zero', () => {
  const result = resolveCoveragePredictedCa(null)

  assert.equal(result.predicted_ca, null)
  assert.equal(result.predicted_ca_known, false)
  assert.equal(result.predicted_ca_source, 'unavailable')
})

test('a real zero remains a known zero', () => {
  const result = resolveCoveragePredictedCa({ avg_ca_hist: 0 })

  assert.equal(result.predicted_ca, 0)
  assert.equal(result.predicted_ca_known, true)
  assert.equal(result.predicted_ca_source, 'sales_history')
})

test('cancelled documents are excluded by the SQL condition used for historical CA', () => {
  const sqlCondition = buildCoverageNonCancelledDocumentSqlCondition('e.annule')

  assert.match(sqlCondition, /e\.annule IS NULL/)
  assert.match(sqlCondition, /TRIM\(e\.annule\) = ''/)
  assert.match(sqlCondition, /TRIM\(e\.annule\) = '0'/)
  assert.doesNotMatch(sqlCondition, /TRIM\(e\.annule\) = '1'/)
})

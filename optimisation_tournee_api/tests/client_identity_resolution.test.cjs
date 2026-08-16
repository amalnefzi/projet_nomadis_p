const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildActiveClientIndexes,
  dedupeClientRowsById,
  normalizeHistoricalClientCode,
  resolveHistoricalClientMatch
} = require('../client_identity')

test('distinct client ids keep 00152 and 152 as two active clients with no duplicate', () => {
  const deduped = dedupeClientRowsById([
    { client_id: 1, client_code: '00152', client_name: 'Client 00152' },
    { client_id: 2, client_code: '152', client_name: 'Client 152' }
  ])

  assert.equal(deduped.rows.length, 2)
  assert.equal(deduped.duplicateRows, 0)
  assert.deepEqual(
    deduped.rows.map(row => row.client_id),
    ['1', '2']
  )
})

test('exact history code matches the exact active client only', () => {
  const indexes = buildActiveClientIndexes([
    { client_id: 1, client_code: '00152', client_name: 'Client 00152' },
    { client_id: 2, client_code: '152', client_name: 'Client 152' }
  ])

  const match = resolveHistoricalClientMatch('00152', indexes)

  assert.equal(match.status, 'exact_match')
  assert.equal(match.client_id, '1')
  assert.equal(match.client_code, '00152')
})

test('normalized history code becomes ambiguous when multiple active clients share it', () => {
  const indexes = buildActiveClientIndexes([
    { client_id: 1, client_code: '00152', client_name: 'Client 00152' },
    { client_id: 2, client_code: '152', client_name: 'Client 152' }
  ])

  const match = resolveHistoricalClientMatch('000152', indexes)

  assert.equal(match.status, 'ambiguous_match')
  assert.equal(match.normalized_code, '152')
  assert.equal(match.matches.length, 2)
  assert.deepEqual(
    match.matches.map(item => item.client_id).sort(),
    ['1', '2']
  )
})

test('a clean base without normalized collision keeps diagnostics empty', () => {
  const indexes = buildActiveClientIndexes([
    { client_id: 10, client_code: '00010', client_name: 'Client 10' },
    { client_id: 11, client_code: '00011', client_name: 'Client 11' }
  ])

  assert.equal(indexes.ambiguousNormalizedCodes.length, 0)
  assert.equal(resolveHistoricalClientMatch('00010', indexes).status, 'exact_match')
  assert.equal(resolveHistoricalClientMatch('10', indexes).status, 'unique_normalized_match')
})

test('normalized helper preserves collision space without enforcing uniqueness', () => {
  assert.equal(normalizeHistoricalClientCode('00152'), '152')
  assert.equal(normalizeHistoricalClientCode('152'), '152')
  assert.equal(normalizeHistoricalClientCode('00002'), '2')
})

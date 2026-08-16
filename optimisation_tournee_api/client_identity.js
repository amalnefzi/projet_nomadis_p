function normalizeClientId(rawValue) {
  const value = String(rawValue ?? '').trim()
  return value || ''
}

function normalizeExactClientCode(rawValue) {
  return String(rawValue ?? '').trim()
}

function normalizeHistoricalClientCode(rawValue) {
  const exactCode = normalizeExactClientCode(rawValue)
  if (!exactCode) return ''
  return exactCode.replace(/^0+/, '') || '0'
}

function fillMissingClientFields(target, source) {
  if (!target || !source) return target

  Object.entries(source).forEach(([field, value]) => {
    if (target[field] == null || target[field] === '') {
      target[field] = value
    }
  })

  return target
}

function normalizeActiveClientRow(row = {}) {
  const clientId = normalizeClientId(row.client_id ?? row.id)
  const clientCode = normalizeExactClientCode(row.client_code ?? row.code ?? row.nbr_client)
  if (!clientId || !clientCode) {
    return null
  }

  return {
    ...row,
    client_id: clientId,
    client_code: clientCode,
    client_unique_key: clientId
  }
}

function dedupeClientRowsById(rows = []) {
  const dedupedRows = []
  const rowById = new Map()
  let duplicateRows = 0

  ;(Array.isArray(rows) ? rows : []).forEach(row => {
    const normalized = normalizeActiveClientRow(row)
    if (!normalized) return

    const key = normalized.client_id
    if (!rowById.has(key)) {
      rowById.set(key, normalized)
      dedupedRows.push(normalized)
      return
    }

    duplicateRows += 1
    fillMissingClientFields(rowById.get(key), normalized)
  })

  return {
    rows: dedupedRows,
    duplicateRows
  }
}

function buildActiveClientIndexes(rows = []) {
  const deduped = dedupeClientRowsById(rows)
  const byId = new Map()
  const byExactCode = new Map()
  const byNormalizedCode = new Map()

  deduped.rows.forEach(row => {
    byId.set(row.client_id, row)
    if (!byExactCode.has(row.client_code)) {
      byExactCode.set(row.client_code, row)
    }

    const normalizedCode = normalizeHistoricalClientCode(row.client_code)
    if (!normalizedCode) return

    const existing = byNormalizedCode.get(normalizedCode) || []
    existing.push(row)
    byNormalizedCode.set(normalizedCode, existing)
  })

  const ambiguousNormalizedCodes = [...byNormalizedCode.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([normalizedCode, matches]) => ({
      normalized_code: normalizedCode,
      matches: matches.map(match => ({
        client_id: match.client_id,
        client_code: match.client_code,
        client_name: String(match.client_name ?? match.nom ?? '').trim() || match.client_code
      }))
    }))
    .sort((left, right) => left.normalized_code.localeCompare(right.normalized_code))

  return {
    activeClients: deduped.rows,
    duplicateRows: deduped.duplicateRows,
    byId,
    byExactCode,
    byNormalizedCode,
    ambiguousNormalizedCodes
  }
}

function resolveHistoricalClientMatch(rawCode, indexes = {}) {
  const exactCode = normalizeExactClientCode(rawCode)
  const normalizedCode = normalizeHistoricalClientCode(exactCode)

  if (!exactCode) {
    return {
      status: 'no_match',
      exact_code: '',
      normalized_code: ''
    }
  }

  const exactClient = indexes.byExactCode instanceof Map
    ? indexes.byExactCode.get(exactCode)
    : null
  if (exactClient) {
    return {
      status: 'exact_match',
      exact_code: exactCode,
      normalized_code: normalizedCode,
      client: exactClient,
      client_id: exactClient.client_id,
      client_code: exactClient.client_code
    }
  }

  const normalizedMatches = indexes.byNormalizedCode instanceof Map
    ? (indexes.byNormalizedCode.get(normalizedCode) || [])
    : []
  if (normalizedMatches.length === 1) {
    const matchedClient = normalizedMatches[0]
    return {
      status: 'unique_normalized_match',
      exact_code: exactCode,
      normalized_code: normalizedCode,
      client: matchedClient,
      client_id: matchedClient.client_id,
      client_code: matchedClient.client_code
    }
  }

  if (normalizedMatches.length > 1) {
    return {
      status: 'ambiguous_match',
      exact_code: exactCode,
      normalized_code: normalizedCode,
      matches: normalizedMatches.map(match => ({
        client_id: match.client_id,
        client_code: match.client_code,
        client_name: String(match.client_name ?? match.nom ?? '').trim() || match.client_code
      }))
    }
  }

  return {
    status: 'no_match',
    exact_code: exactCode,
    normalized_code: normalizedCode
  }
}

module.exports = {
  buildActiveClientIndexes,
  dedupeClientRowsById,
  normalizeClientId,
  normalizeExactClientCode,
  normalizeHistoricalClientCode,
  normalizeActiveClientRow,
  resolveHistoricalClientMatch
}

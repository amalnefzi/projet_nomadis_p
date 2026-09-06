const VALID_TOUR_STATUSES = new Set(['validated', 'in_progress', 'completed', 'replaced'])
const ACTIVE_TOUR_STATUSES = new Set(['validated', 'in_progress'])

function normalizeText(value) {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

function normalizeDateOnly(value) {
  if (value == null) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  const normalized = String(value).trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null
}

function mapValidatedTourHeaderRow(row = null) {
  if (!row) return null
  return {
    tourneeCode: normalizeText(row.tournee_code),
    commercialCode: normalizeText(row.commercial_code),
    tourType: normalizeText(row.tour_type) || 'sales_v2',
    date: normalizeDateOnly(row.planned_date),
    routeCode: normalizeText(row.route_code),
    depotCode: normalizeText(row.depot_code),
    clientsCount: Number(row.clients_count || 0),
    status: normalizeText(row.status) || 'validated',
    replacedByTourneeCode: normalizeText(row.replaced_by_tournee_code),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    createdAt: row.created_at == null ? null : String(row.created_at),
    updatedAt: row.updated_at == null ? null : String(row.updated_at)
  }
}

/**
 * Replaces (or creates) the single active header row for a (commercial, tour_type, date)
 * business key. Must run inside a transaction holding a row lock (FOR UPDATE) so the
 * uq_sales_v2_validated_tours_active constraint on the generated `active_business_key`
 * column is the last line of defense against concurrent duplicate validations.
 */
async function replaceOrCreateValidatedTourHeader(queryExecutor, {
  tourneeCode,
  commercialCode,
  tourType = 'sales_v2',
  plannedDate,
  routeCode = null,
  depotCode = null,
  clientsCount = 0
} = {}) {
  const normalizedCode = normalizeText(tourneeCode)
  const normalizedCommercial = normalizeText(commercialCode)
  const normalizedDate = normalizeDateOnly(plannedDate)
  const normalizedTourType = normalizeText(tourType) || 'sales_v2'

  if (!normalizedCode || !normalizedCommercial || !normalizedDate) {
    const error = new Error('tournee_code, commercial_code et planned_date sont requis pour enregistrer une tournee validee.')
    error.statusCode = 400
    throw error
  }

  const existingRows = await queryExecutor(
    `
      SELECT *
      FROM sales_v2_validated_tours
      WHERE commercial_code = ? AND tour_type = ? AND planned_date = ?
      ORDER BY id DESC
      FOR UPDATE
    `,
    [normalizedCommercial, normalizedTourType, normalizedDate]
  )

  const activeRow = existingRows.find(row => ACTIVE_TOUR_STATUSES.has(String(row.status)))

  if (activeRow && String(activeRow.status) === 'in_progress') {
    const error = new Error(
      `La tournee ${activeRow.tournee_code} est deja en cours d'execution pour ce commercial et cette date. Terminez-la avant de revalider un nouveau plan.`
    )
    error.statusCode = 409
    throw error
  }

  if (activeRow) {
    await queryExecutor(
      `
        UPDATE sales_v2_validated_tours
        SET status = 'replaced', replaced_by_tournee_code = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [normalizedCode, activeRow.id]
    )
  }

  // A tournee_code is deterministic (commercial + date + type). If nothing is currently
  // active for this business key but a prior (completed/replaced) row already used this
  // exact code, that history must stay uniquely addressable: version the new code instead
  // of silently colliding with it.
  const priorRowsWithSameCode = activeRow
    ? []
    : existingRows.filter(row => row.tournee_code === normalizedCode || String(row.tournee_code).startsWith(`${normalizedCode}-v`))
  const finalTourneeCode = priorRowsWithSameCode.length > 0
    ? `${normalizedCode}-v${priorRowsWithSameCode.length + 1}`
    : normalizedCode

  await queryExecutor(
    `
      INSERT INTO sales_v2_validated_tours (
        tournee_code, commercial_code, tour_type, planned_date, route_code, depot_code, clients_count, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'validated')
    `,
    [finalTourneeCode, normalizedCommercial, normalizedTourType, normalizedDate, routeCode || null, depotCode || null, Number(clientsCount || 0)]
  )

  return {
    tourneeCode: finalTourneeCode,
    replacedTourneeCode: activeRow ? normalizeText(activeRow.tournee_code) : null,
    previousStatus: activeRow ? String(activeRow.status) : null
  }
}

async function loadValidatedTourHeaderByCode(queryExecutor, tourneeCode) {
  const normalizedCode = normalizeText(tourneeCode)
  if (!normalizedCode) return null

  const rows = await queryExecutor(
    `SELECT * FROM sales_v2_validated_tours WHERE tournee_code = ? ORDER BY id DESC LIMIT 1`,
    [normalizedCode]
  )

  return Array.isArray(rows) && rows[0] ? mapValidatedTourHeaderRow(rows[0]) : null
}

async function loadValidatedTourHeaderByBusinessKey(queryExecutor, { commercialCode, tourType = 'sales_v2', plannedDate } = {}) {
  const normalizedCommercial = normalizeText(commercialCode)
  const normalizedDate = normalizeDateOnly(plannedDate)
  const normalizedTourType = normalizeText(tourType) || 'sales_v2'
  if (!normalizedCommercial || !normalizedDate) return null

  const rows = await queryExecutor(
    `
      SELECT * FROM sales_v2_validated_tours
      WHERE commercial_code = ? AND tour_type = ? AND planned_date = ? AND status IN ('validated', 'in_progress')
      ORDER BY id DESC
      LIMIT 1
    `,
    [normalizedCommercial, normalizedTourType, normalizedDate]
  )

  return Array.isArray(rows) && rows[0] ? mapValidatedTourHeaderRow(rows[0]) : null
}

async function listValidatedTourHeaders(queryExecutor, {
  date = null,
  commercialCode = null,
  tourneeCode = null,
  tourType = 'sales_v2'
} = {}) {
  const whereClauses = ['tour_type = ?', "status != 'replaced'"]
  const params = [normalizeText(tourType) || 'sales_v2']

  const normalizedDate = normalizeDateOnly(date)
  if (normalizedDate) {
    whereClauses.push('planned_date = ?')
    params.push(normalizedDate)
  }

  const normalizedCommercial = normalizeText(commercialCode)
  if (normalizedCommercial) {
    whereClauses.push('commercial_code = ?')
    params.push(normalizedCommercial)
  }

  const normalizedTourneeCode = normalizeText(tourneeCode)
  if (normalizedTourneeCode) {
    whereClauses.push('tournee_code LIKE ?')
    params.push(`%${normalizedTourneeCode}%`)
  }

  const rows = await queryExecutor(
    `
      SELECT * FROM sales_v2_validated_tours
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY planned_date DESC, commercial_code ASC, id DESC
      LIMIT 200
    `,
    params
  )

  return (Array.isArray(rows) ? rows : []).map(mapValidatedTourHeaderRow)
}

async function markValidatedTourInProgress(queryExecutor, tourneeCode) {
  const normalizedCode = normalizeText(tourneeCode)
  if (!normalizedCode) return null

  await queryExecutor(
    `
      UPDATE sales_v2_validated_tours
      SET status = 'in_progress', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE tournee_code = ? AND status = 'validated'
    `,
    [normalizedCode]
  )

  return loadValidatedTourHeaderByCode(queryExecutor, normalizedCode)
}

async function completeValidatedTour(queryExecutor, tourneeCode) {
  const normalizedCode = normalizeText(tourneeCode)
  if (!normalizedCode) {
    const error = new Error('Le code de tournee est requis.')
    error.statusCode = 400
    throw error
  }

  const existing = await loadValidatedTourHeaderByCode(queryExecutor, normalizedCode)
  if (!existing) {
    const error = new Error(`Aucune tournee validee trouvee pour le code ${normalizedCode}.`)
    error.statusCode = 404
    throw error
  }

  if (existing.status === 'completed') {
    return existing
  }

  if (existing.status === 'replaced') {
    const error = new Error(`La tournee ${normalizedCode} a ete remplacee et ne peut plus etre terminee.`)
    error.statusCode = 409
    throw error
  }

  await queryExecutor(
    `
      UPDATE sales_v2_validated_tours
      SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE tournee_code = ? AND status IN ('validated', 'in_progress')
    `,
    [normalizedCode]
  )

  return loadValidatedTourHeaderByCode(queryExecutor, normalizedCode)
}

module.exports = {
  VALID_TOUR_STATUSES,
  ACTIVE_TOUR_STATUSES,
  mapValidatedTourHeaderRow,
  replaceOrCreateValidatedTourHeader,
  loadValidatedTourHeaderByCode,
  loadValidatedTourHeaderByBusinessKey,
  listValidatedTourHeaders,
  markValidatedTourInProgress,
  completeValidatedTour
}

const { COVERAGE_CONSTRAINTS_MAPPING } = require('./coverage_constraints_mapping')

const schemaCache = new Map()

function normalizeDateOnly(value) {
  if (!value) return null
  const isoMatch = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  return isoMatch ? isoMatch[0] : null
}

function normalizeCommercialCode(value) {
  return String(value || '').trim()
}

function normalizeClientId(value) {
  const trimmed = String(value || '').trim()
  return trimmed || null
}

function normalizeCodeList(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )].sort()
}

function normalizeDayIndexList(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isFinite(value) && value >= 0 && value <= 6)
  )].sort((a, b) => a - b)
}

function normalizeDateList(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => normalizeDateOnly(value))
      .filter(Boolean)
  )].sort()
}

function normalizePositiveIntegerByDate(values = {}) {
  const normalized = {}
  if (!values || typeof values !== 'object') return normalized

  Object.entries(values).forEach(([dateKey, rawValue]) => {
    const dateIso = normalizeDateOnly(dateKey)
    const parsed = Number.parseInt(rawValue, 10)
    if (!dateIso || !Number.isFinite(parsed) || parsed <= 0) return
    normalized[dateIso] = parsed
  })

  return normalized
}

function normalizePositiveNumberByDate(values = {}) {
  const normalized = {}
  if (!values || typeof values !== 'object') return normalized

  Object.entries(values).forEach(([dateKey, rawValue]) => {
    const dateIso = normalizeDateOnly(dateKey)
    const parsed = Number(rawValue)
    if (!dateIso || !Number.isFinite(parsed) || parsed <= 0) return
    normalized[dateIso] = Math.round(parsed * 1000) / 1000
  })

  return normalized
}

function escapeIdentifier(identifier) {
  const normalized = String(identifier || '').trim()
  if (!/^[A-Za-z0-9_]+$/.test(normalized)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`)
  }
  return `\`${normalized}\``
}

function buildInClause(column, values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return { sql: '', params: [] }
  }

  const placeholders = values.map(() => '?').join(', ')
  return {
    sql: ` AND ${column} IN (${placeholders})`,
    params: [...values]
  }
}

function buildDefaultCommercialConstraint(commercialCode) {
  return {
    working_days: [],
    available_dates: [],
    unavailable_dates: [],
    hard_max_visits_by_date: {},
    max_load_units_by_date: {},
    shift_start_time_by_date: {},
    shift_end_time_by_date: {},
    max_route_minutes_by_date: {},
    break_minutes_by_date: {},
    depot_id_by_date: {},
    depot_latitude_by_date: {},
    depot_longitude_by_date: {},
    time_constraint_source_by_date: {},
    constraint_sources_by_date: {},
    commercial_code: commercialCode
  }
}

function isTruthyConstraintValue(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y' || normalized === 'oui'
}

function buildDefaultClientRestriction() {
  return {
    allowed_commercial_codes: [],
    denied_commercial_codes: [],
    source: null,
    service_minutes: null,
    service_minutes_source: null,
    estimated_stop_minutes_by_commercial_date: {}
  }
}

function normalizeNonNegativeNumber(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.round(parsed * 1000) / 1000
}

function normalizeTimeOfDay(value) {
  const normalized = String(value || '').trim()
  const match = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null

  const hours = Number.parseInt(match[1], 10)
  const minutes = Number.parseInt(match[2], 10)
  const seconds = Number.parseInt(match[3] || '0', 10)
  if (
    !Number.isFinite(hours) || hours < 0 || hours > 23 ||
    !Number.isFinite(minutes) || minutes < 0 || minutes > 59 ||
    !Number.isFinite(seconds) || seconds < 0 || seconds > 59
  ) {
    return null
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function timeOfDayToMinutes(value) {
  const normalized = normalizeTimeOfDay(value)
  if (!normalized) return null
  const [hours, minutes, seconds] = normalized.split(':').map(item => Number.parseInt(item, 10))
  return (hours * 60) + minutes + (seconds / 60)
}

function buildCommercialDateKey(commercialCode, dateIso) {
  const normalizedCommercialCode = normalizeCommercialCode(commercialCode)
  const normalizedDate = normalizeDateOnly(dateIso)
  if (!normalizedCommercialCode || !normalizedDate) return null
  return `${normalizedDate}::${normalizedCommercialCode}`
}

function resolveHardRouteMinutes({
  shiftStartTime,
  shiftEndTime,
  breakMinutes,
  maxRouteMinutes
}) {
  const normalizedBreakMinutes = normalizeNonNegativeNumber(breakMinutes) || 0
  const startMinutes = timeOfDayToMinutes(shiftStartTime)
  const endMinutes = timeOfDayToMinutes(shiftEndTime)
  const explicitMaxRoute = normalizeNonNegativeNumber(maxRouteMinutes)

  let availableRouteMinutes = null
  if (startMinutes != null && endMinutes != null) {
    const rawAvailableMinutes = endMinutes - startMinutes - normalizedBreakMinutes
    if (rawAvailableMinutes > 0) {
      availableRouteMinutes = Math.round(rawAvailableMinutes * 1000) / 1000
    } else {
      availableRouteMinutes = null
    }
  }

  if (availableRouteMinutes != null && explicitMaxRoute != null) {
    return Math.min(availableRouteMinutes, explicitMaxRoute)
  }

  if (availableRouteMinutes != null) {
    return availableRouteMinutes
  }

  if (explicitMaxRoute != null) {
    return explicitMaxRoute
  }

  return null
}

async function getTableColumns({ queryAsync, database, table }) {
  const cacheKey = `${database || ''}:${table || ''}`
  if (schemaCache.has(cacheKey)) {
    return schemaCache.get(cacheKey)
  }

  const pending = (async () => {
    if (!queryAsync || !database || !table) {
      return new Set()
    }

    const rows = await queryAsync(
      `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
      `,
      [database, table]
    )

    return new Set(
      (rows || [])
        .map(row => String(row.COLUMN_NAME || '').trim())
        .filter(Boolean)
    )
  })()

  schemaCache.set(cacheKey, pending)
  return pending
}

async function resolveMappingSection({ queryAsync, database, section }) {
  if (!section?.table) {
    return {
      configured: false,
      available: false,
      columns: new Set(),
      mapping: section || {}
    }
  }

  const columns = await getTableColumns({
    queryAsync,
    database,
    table: section.table
  })

  return {
    configured: true,
    available: true,
    columns,
    mapping: section
  }
}

function hasAllColumns(columns, names = []) {
  return names.every(name => !name || columns.has(name))
}

async function loadClientRestrictions({
  queryAsync,
  database,
  commercialCodes = [],
  clientIds = [],
  mapping = COVERAGE_CONSTRAINTS_MAPPING.client_restrictions
}) {
  const resolved = await resolveMappingSection({
    queryAsync,
    database,
    section: mapping
  })

  if (!resolved.configured || !resolved.available) {
    return {
      restrictionsByClientId: new Map(),
      loaded: false,
      source: null,
      clientsWithData: 0,
      mappingReady: false
    }
  }

  const requiredColumns = [
    mapping.client_id_column,
    mapping.allowed_commercial_codes_column
  ]
  const optionalColumns = [
    mapping.denied_commercial_codes_column,
    mapping.deleted_at_column,
    mapping.active_column
  ]

  if (!hasAllColumns(resolved.columns, [...requiredColumns, ...optionalColumns])) {
    return {
      restrictionsByClientId: new Map(),
      loaded: false,
      source: mapping.source_label || null,
      clientsWithData: 0,
      mappingReady: false
    }
  }

  const tableSql = escapeIdentifier(mapping.table)
  const clientIdSql = escapeIdentifier(mapping.client_id_column)
  const allowedSql = escapeIdentifier(mapping.allowed_commercial_codes_column)
  const deniedSql = mapping.denied_commercial_codes_column
    ? escapeIdentifier(mapping.denied_commercial_codes_column)
    : null

  const filters = []
  const params = []

  if (mapping.deleted_at_column) {
    filters.push(`${escapeIdentifier(mapping.deleted_at_column)} IS NULL`)
  }

  if (mapping.active_column) {
    filters.push(`${escapeIdentifier(mapping.active_column)} = ?`)
    params.push(mapping.active_value ?? '1')
  }

  const clientIdFilter = buildInClause(`CAST(${clientIdSql} AS CHAR)`, normalizeCodeList(clientIds))
  if (clientIdFilter.sql) {
    filters.push(clientIdFilter.sql.replace(/^ AND /, ''))
    params.push(...clientIdFilter.params)
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
  const rows = await queryAsync(
    `
      SELECT
        CAST(${clientIdSql} AS CHAR) AS client_id,
        TRIM(COALESCE(${allowedSql}, '')) AS allowed_commercial_code
        ${deniedSql ? `, TRIM(COALESCE(${deniedSql}, '')) AS denied_commercial_code` : ''}
      FROM ${tableSql}
      ${whereClause}
    `,
    params
  )

  const selectedCommercialSet = new Set(normalizeCodeList(commercialCodes))
  const restrictionsByClientId = new Map()

  ;(rows || []).forEach(row => {
    const clientId = normalizeClientId(row.client_id)
    if (!clientId) return

    const allowedCode = normalizeCommercialCode(row.allowed_commercial_code)
    const deniedCode = normalizeCommercialCode(row.denied_commercial_code)
    const restriction = restrictionsByClientId.get(clientId) || buildDefaultClientRestriction()

    if (allowedCode && (!selectedCommercialSet.size || selectedCommercialSet.has(allowedCode))) {
      restriction.allowed_commercial_codes.push(allowedCode)
    }

    if (deniedCode && (!selectedCommercialSet.size || selectedCommercialSet.has(deniedCode))) {
      restriction.denied_commercial_codes.push(deniedCode)
    }

    restriction.source = mapping.source_label || null
    restrictionsByClientId.set(clientId, restriction)
  })

  let clientsWithData = 0
  restrictionsByClientId.forEach(restriction => {
    restriction.allowed_commercial_codes = normalizeCodeList(restriction.allowed_commercial_codes)
    restriction.denied_commercial_codes = normalizeCodeList(restriction.denied_commercial_codes)
    if (restriction.allowed_commercial_codes.length || restriction.denied_commercial_codes.length) {
      clientsWithData += 1
    }
  })

  return {
    restrictionsByClientId,
    loaded: clientsWithData > 0,
    source: mapping.source_label || null,
    clientsWithData,
    mappingReady: true
  }
}

async function loadCommercialCalendar({
  queryAsync,
  database,
  commercialCodes = [],
  startDate,
  endDate,
  mapping = COVERAGE_CONSTRAINTS_MAPPING.commercial_calendar
}) {
  const resolved = await resolveMappingSection({
    queryAsync,
    database,
    section: mapping
  })

  if (!resolved.configured || !resolved.available) {
    return {
      commercialsByCode: new Map(),
      availableCommercials: 0,
      workingDaysCommercials: 0,
      loaded: false,
      source: null,
      mappingReady: false
    }
  }

  const requiredColumns = [
    mapping.commercial_column,
    mapping.date_column,
    mapping.available_column
  ]
  const optionalColumns = [mapping.working_days_column]
  if (!hasAllColumns(resolved.columns, [...requiredColumns, ...optionalColumns])) {
    return {
      commercialsByCode: new Map(),
      availableCommercials: 0,
      workingDaysCommercials: 0,
      loaded: false,
      source: mapping.source_label || null,
      mappingReady: false
    }
  }

  const tableSql = escapeIdentifier(mapping.table)
  const commercialSql = escapeIdentifier(mapping.commercial_column)
  const dateSql = escapeIdentifier(mapping.date_column)
  const availableSql = escapeIdentifier(mapping.available_column)
  const workingDaysSql = mapping.working_days_column
    ? escapeIdentifier(mapping.working_days_column)
    : null
  const commercialFilter = buildInClause(`TRIM(${commercialSql})`, normalizeCodeList(commercialCodes))
  const params = [startDate, endDate, ...commercialFilter.params]
  const rows = await queryAsync(
    `
      SELECT
        TRIM(${commercialSql}) AS commercial_code,
        DATE(${dateSql}) AS constraint_date,
        ${availableSql} AS availability_value
        ${workingDaysSql ? `, ${workingDaysSql} AS working_days_value` : ''}
      FROM ${tableSql}
      WHERE DATE(${dateSql}) >= ?
        AND DATE(${dateSql}) <= ?
        ${commercialFilter.sql}
    `,
    params
  )

  const commercialsByCode = new Map()
  ;(rows || []).forEach(row => {
    const commercialCode = normalizeCommercialCode(row.commercial_code)
    const dateIso = normalizeDateOnly(row.constraint_date)
    if (!commercialCode) return
    const entry = commercialsByCode.get(commercialCode) || buildDefaultCommercialConstraint(commercialCode)
    if (dateIso) {
      if (isTruthyConstraintValue(row.availability_value)) {
        entry.available_dates.push(dateIso)
      } else {
        entry.unavailable_dates.push(dateIso)
      }
      entry.constraint_sources_by_date[dateIso] = mapping.source_label || null
    }
    if (workingDaysSql) {
      entry.working_days.push(...normalizeDayIndexList(String(row.working_days_value || '').split(',')))
    }
    commercialsByCode.set(commercialCode, entry)
  })

  let availableCommercials = 0
  let workingDaysCommercials = 0
  commercialsByCode.forEach(entry => {
    entry.available_dates = normalizeDateList(entry.available_dates)
    entry.unavailable_dates = normalizeDateList(entry.unavailable_dates)
    entry.working_days = normalizeDayIndexList(entry.working_days)
    if (entry.available_dates.length || entry.unavailable_dates.length) {
      availableCommercials += 1
    }
    if (entry.working_days.length) {
      workingDaysCommercials += 1
    }
  })

  return {
    commercialsByCode,
    availableCommercials,
    workingDaysCommercials,
    loaded: availableCommercials > 0 || workingDaysCommercials > 0,
    source: mapping.source_label || null,
    mappingReady: true
  }
}

async function loadCommercialAbsences({
  queryAsync,
  database,
  commercialCodes = [],
  startDate,
  endDate,
  mapping = COVERAGE_CONSTRAINTS_MAPPING.commercial_absences
}) {
  const resolved = await resolveMappingSection({
    queryAsync,
    database,
    section: mapping
  })

  if (!resolved.configured || !resolved.available) {
    return {
      commercialsByCode: new Map(),
      absentCommercials: 0,
      loaded: false,
      source: null,
      mappingReady: false
    }
  }

  const requiredColumns = [
    mapping.commercial_column,
    mapping.date_column,
    mapping.absence_column
  ]
  if (!hasAllColumns(resolved.columns, requiredColumns)) {
    return {
      commercialsByCode: new Map(),
      absentCommercials: 0,
      loaded: false,
      source: mapping.source_label || null,
      mappingReady: false
    }
  }

  const tableSql = escapeIdentifier(mapping.table)
  const commercialSql = escapeIdentifier(mapping.commercial_column)
  const dateSql = escapeIdentifier(mapping.date_column)
  const absenceSql = escapeIdentifier(mapping.absence_column)
  const commercialFilter = buildInClause(`TRIM(${commercialSql})`, normalizeCodeList(commercialCodes))
  const rows = await queryAsync(
    `
      SELECT
        TRIM(${commercialSql}) AS commercial_code,
        DATE(${dateSql}) AS constraint_date,
        ${absenceSql} AS absence_value
      FROM ${tableSql}
      WHERE DATE(${dateSql}) >= ?
        AND DATE(${dateSql}) <= ?
        ${commercialFilter.sql}
    `,
    [startDate, endDate, ...commercialFilter.params]
  )

  const commercialsByCode = new Map()
  ;(rows || []).forEach(row => {
    if (!isTruthyConstraintValue(row.absence_value)) return
    const commercialCode = normalizeCommercialCode(row.commercial_code)
    const dateIso = normalizeDateOnly(row.constraint_date)
    if (!commercialCode || !dateIso) return
    const entry = commercialsByCode.get(commercialCode) || buildDefaultCommercialConstraint(commercialCode)
    entry.unavailable_dates.push(dateIso)
    entry.constraint_sources_by_date[dateIso] = mapping.source_label || null
    commercialsByCode.set(commercialCode, entry)
  })

  let absentCommercials = 0
  commercialsByCode.forEach(entry => {
    entry.unavailable_dates = normalizeDateList(entry.unavailable_dates)
    if (entry.unavailable_dates.length) {
      absentCommercials += 1
    }
  })

  return {
    commercialsByCode,
    absentCommercials,
    loaded: absentCommercials > 0,
    source: mapping.source_label || null,
    mappingReady: true
  }
}

async function loadCommercialCapacity({
  queryAsync,
  database,
  commercialCodes = [],
  startDate,
  endDate,
  mapping = COVERAGE_CONSTRAINTS_MAPPING.commercial_capacity
}) {
  const resolved = await resolveMappingSection({
    queryAsync,
    database,
    section: mapping
  })

  if (!resolved.configured || !resolved.available) {
    return {
      commercialsByCode: new Map(),
      hardVisitsCommercials: 0,
      truckCapacityCommercials: 0,
      loaded: false,
      source: null,
      mappingReady: false
    }
  }

  const requiredColumns = [
    mapping.commercial_column,
    mapping.date_column
  ]
  const optionalColumns = [
    mapping.hard_max_visits_column,
    mapping.max_load_units_column
  ]
  if (!hasAllColumns(resolved.columns, [...requiredColumns, ...optionalColumns])) {
    return {
      commercialsByCode: new Map(),
      hardVisitsCommercials: 0,
      truckCapacityCommercials: 0,
      loaded: false,
      source: mapping.source_label || null,
      mappingReady: false
    }
  }

  if (!mapping.hard_max_visits_column && !mapping.max_load_units_column) {
    return {
      commercialsByCode: new Map(),
      hardVisitsCommercials: 0,
      truckCapacityCommercials: 0,
      loaded: false,
      source: mapping.source_label || null,
      mappingReady: true
    }
  }

  const tableSql = escapeIdentifier(mapping.table)
  const commercialSql = escapeIdentifier(mapping.commercial_column)
  const dateSql = escapeIdentifier(mapping.date_column)
  const hardVisitsSql = mapping.hard_max_visits_column
    ? escapeIdentifier(mapping.hard_max_visits_column)
    : null
  const loadUnitsSql = mapping.max_load_units_column
    ? escapeIdentifier(mapping.max_load_units_column)
    : null
  const commercialFilter = buildInClause(`TRIM(${commercialSql})`, normalizeCodeList(commercialCodes))
  const rows = await queryAsync(
    `
      SELECT
        TRIM(${commercialSql}) AS commercial_code,
        DATE(${dateSql}) AS constraint_date
        ${hardVisitsSql ? `, ${hardVisitsSql} AS hard_max_visits_value` : ''}
        ${loadUnitsSql ? `, ${loadUnitsSql} AS max_load_units_value` : ''}
      FROM ${tableSql}
      WHERE DATE(${dateSql}) >= ?
        AND DATE(${dateSql}) <= ?
        ${commercialFilter.sql}
    `,
    [startDate, endDate, ...commercialFilter.params]
  )

  const commercialsByCode = new Map()
  ;(rows || []).forEach(row => {
    const commercialCode = normalizeCommercialCode(row.commercial_code)
    const dateIso = normalizeDateOnly(row.constraint_date)
    if (!commercialCode || !dateIso) return
    const entry = commercialsByCode.get(commercialCode) || buildDefaultCommercialConstraint(commercialCode)
    const hardVisits = Number.parseInt(row.hard_max_visits_value, 10)
    if (Number.isFinite(hardVisits) && hardVisits > 0) {
      entry.hard_max_visits_by_date[dateIso] = hardVisits
      entry.constraint_sources_by_date[dateIso] = mapping.source_label || null
    }
    const loadUnits = Number(row.max_load_units_value)
    if (Number.isFinite(loadUnits) && loadUnits > 0) {
      entry.max_load_units_by_date[dateIso] = Math.round(loadUnits * 1000) / 1000
      entry.constraint_sources_by_date[dateIso] = mapping.source_label || null
    }
    commercialsByCode.set(commercialCode, entry)
  })

  let hardVisitsCommercials = 0
  let truckCapacityCommercials = 0
  commercialsByCode.forEach(entry => {
    if (Object.keys(entry.hard_max_visits_by_date).length) {
      hardVisitsCommercials += 1
    }
    if (Object.keys(entry.max_load_units_by_date).length) {
      truckCapacityCommercials += 1
    }
  })

  return {
    commercialsByCode,
    hardVisitsCommercials,
    truckCapacityCommercials,
    loaded: hardVisitsCommercials > 0 || truckCapacityCommercials > 0,
    source: mapping.source_label || null,
    mappingReady: true
  }
}

async function loadCommercialShifts({
  queryAsync,
  database,
  commercialCodes = [],
  startDate,
  endDate,
  mapping = COVERAGE_CONSTRAINTS_MAPPING.commercial_shifts
}) {
  const resolved = await resolveMappingSection({
    queryAsync,
    database,
    section: mapping
  })

  if (!resolved.configured || !resolved.available) {
    return {
      commercialsByCode: new Map(),
      shiftCommercials: 0,
      invalidRows: 0,
      loaded: false,
      source: null,
      mappingReady: false
    }
  }

  const requiredColumns = [
    mapping.commercial_column,
    mapping.date_column,
    mapping.shift_start_time_column,
    mapping.shift_end_time_column
  ]
  const optionalColumns = [mapping.break_minutes_column]
  if (!hasAllColumns(resolved.columns, [...requiredColumns, ...optionalColumns])) {
    return {
      commercialsByCode: new Map(),
      shiftCommercials: 0,
      invalidRows: 0,
      loaded: false,
      source: mapping.source_label || null,
      mappingReady: false
    }
  }

  const tableSql = escapeIdentifier(mapping.table)
  const commercialSql = escapeIdentifier(mapping.commercial_column)
  const dateSql = escapeIdentifier(mapping.date_column)
  const shiftStartSql = escapeIdentifier(mapping.shift_start_time_column)
  const shiftEndSql = escapeIdentifier(mapping.shift_end_time_column)
  const breakSql = mapping.break_minutes_column
    ? escapeIdentifier(mapping.break_minutes_column)
    : null
  const commercialFilter = buildInClause(`TRIM(${commercialSql})`, normalizeCodeList(commercialCodes))
  const rows = await queryAsync(
    `
      SELECT
        TRIM(${commercialSql}) AS commercial_code,
        DATE(${dateSql}) AS constraint_date,
        ${shiftStartSql} AS shift_start_time_value,
        ${shiftEndSql} AS shift_end_time_value
        ${breakSql ? `, ${breakSql} AS break_minutes_value` : ''}
      FROM ${tableSql}
      WHERE DATE(${dateSql}) >= ?
        AND DATE(${dateSql}) <= ?
        ${commercialFilter.sql}
    `,
    [startDate, endDate, ...commercialFilter.params]
  )

  const commercialsByCode = new Map()
  let invalidRows = 0
  ;(rows || []).forEach(row => {
    const commercialCode = normalizeCommercialCode(row.commercial_code)
    const dateIso = normalizeDateOnly(row.constraint_date)
    const shiftStartTime = normalizeTimeOfDay(row.shift_start_time_value)
    const shiftEndTime = normalizeTimeOfDay(row.shift_end_time_value)
    const breakMinutes = normalizeNonNegativeNumber(row.break_minutes_value) || 0
    if (!commercialCode || !dateIso || !shiftStartTime || !shiftEndTime) {
      invalidRows += 1
      return
    }

    const hardRouteMinutes = resolveHardRouteMinutes({
      shiftStartTime,
      shiftEndTime,
      breakMinutes,
      maxRouteMinutes: null
    })
    if (hardRouteMinutes == null) {
      invalidRows += 1
      return
    }

    const entry = commercialsByCode.get(commercialCode) || buildDefaultCommercialConstraint(commercialCode)
    entry.shift_start_time_by_date[dateIso] = shiftStartTime
    entry.shift_end_time_by_date[dateIso] = shiftEndTime
    entry.break_minutes_by_date[dateIso] = breakMinutes
    entry.time_constraint_source_by_date[dateIso] = mapping.source_label || null
    commercialsByCode.set(commercialCode, entry)
  })

  let shiftCommercials = 0
  commercialsByCode.forEach(entry => {
    if (Object.keys(entry.shift_start_time_by_date).length && Object.keys(entry.shift_end_time_by_date).length) {
      shiftCommercials += 1
    }
  })

  return {
    commercialsByCode,
    shiftCommercials,
    invalidRows,
    loaded: shiftCommercials > 0,
    source: mapping.source_label || null,
    mappingReady: true
  }
}

async function loadCommercialRouteLimits({
  queryAsync,
  database,
  commercialCodes = [],
  startDate,
  endDate,
  mapping = COVERAGE_CONSTRAINTS_MAPPING.commercial_route_limits
}) {
  const resolved = await resolveMappingSection({
    queryAsync,
    database,
    section: mapping
  })

  if (!resolved.configured || !resolved.available) {
    return {
      commercialsByCode: new Map(),
      routeLimitCommercials: 0,
      invalidRows: 0,
      loaded: false,
      source: null,
      mappingReady: false
    }
  }

  const requiredColumns = [
    mapping.commercial_column,
    mapping.date_column,
    mapping.max_route_minutes_column
  ]
  const optionalColumns = [
    mapping.break_minutes_column,
    mapping.estimated_travel_minutes_column
  ]
  if (!hasAllColumns(resolved.columns, [...requiredColumns, ...optionalColumns])) {
    return {
      commercialsByCode: new Map(),
      routeLimitCommercials: 0,
      invalidRows: 0,
      loaded: false,
      source: mapping.source_label || null,
      mappingReady: false
    }
  }

  const tableSql = escapeIdentifier(mapping.table)
  const commercialSql = escapeIdentifier(mapping.commercial_column)
  const dateSql = escapeIdentifier(mapping.date_column)
  const maxRouteSql = escapeIdentifier(mapping.max_route_minutes_column)
  const breakSql = mapping.break_minutes_column
    ? escapeIdentifier(mapping.break_minutes_column)
    : null
  const commercialFilter = buildInClause(`TRIM(${commercialSql})`, normalizeCodeList(commercialCodes))
  const rows = await queryAsync(
    `
      SELECT
        TRIM(${commercialSql}) AS commercial_code,
        DATE(${dateSql}) AS constraint_date,
        ${maxRouteSql} AS max_route_minutes_value
        ${breakSql ? `, ${breakSql} AS break_minutes_value` : ''}
      FROM ${tableSql}
      WHERE DATE(${dateSql}) >= ?
        AND DATE(${dateSql}) <= ?
        ${commercialFilter.sql}
    `,
    [startDate, endDate, ...commercialFilter.params]
  )

  const commercialsByCode = new Map()
  let invalidRows = 0
  ;(rows || []).forEach(row => {
    const commercialCode = normalizeCommercialCode(row.commercial_code)
    const dateIso = normalizeDateOnly(row.constraint_date)
    const maxRouteMinutes = normalizeNonNegativeNumber(row.max_route_minutes_value)
    const breakMinutes = normalizeNonNegativeNumber(row.break_minutes_value)
    if (!commercialCode || !dateIso || maxRouteMinutes == null || maxRouteMinutes <= 0) {
      invalidRows += 1
      return
    }
    const entry = commercialsByCode.get(commercialCode) || buildDefaultCommercialConstraint(commercialCode)
    entry.max_route_minutes_by_date[dateIso] = maxRouteMinutes
    if (breakMinutes != null) {
      entry.break_minutes_by_date[dateIso] = breakMinutes
    }
    entry.time_constraint_source_by_date[dateIso] = mapping.source_label || null
    commercialsByCode.set(commercialCode, entry)
  })

  let routeLimitCommercials = 0
  commercialsByCode.forEach(entry => {
    if (Object.keys(entry.max_route_minutes_by_date).length) {
      routeLimitCommercials += 1
    }
  })

  return {
    commercialsByCode,
    routeLimitCommercials,
    invalidRows,
    loaded: routeLimitCommercials > 0,
    source: mapping.source_label || null,
    mappingReady: true
  }
}

async function loadCommercialDepots({
  queryAsync,
  database,
  commercialCodes = [],
  startDate,
  endDate,
  mapping = COVERAGE_CONSTRAINTS_MAPPING.commercial_depots
}) {
  const resolved = await resolveMappingSection({
    queryAsync,
    database,
    section: mapping
  })

  if (!resolved.configured || !resolved.available) {
    return {
      commercialsByCode: new Map(),
      depotCommercials: 0,
      loaded: false,
      source: null,
      mappingReady: false
    }
  }

  const requiredColumns = [
    mapping.commercial_column,
    mapping.date_column,
    mapping.depot_id_column,
    mapping.depot_latitude_column,
    mapping.depot_longitude_column
  ]
  if (!hasAllColumns(resolved.columns, requiredColumns)) {
    return {
      commercialsByCode: new Map(),
      depotCommercials: 0,
      loaded: false,
      source: mapping.source_label || null,
      mappingReady: false
    }
  }

  const tableSql = escapeIdentifier(mapping.table)
  const commercialSql = escapeIdentifier(mapping.commercial_column)
  const dateSql = escapeIdentifier(mapping.date_column)
  const depotIdSql = escapeIdentifier(mapping.depot_id_column)
  const depotLatSql = escapeIdentifier(mapping.depot_latitude_column)
  const depotLonSql = escapeIdentifier(mapping.depot_longitude_column)
  const commercialFilter = buildInClause(`TRIM(${commercialSql})`, normalizeCodeList(commercialCodes))
  const rows = await queryAsync(
    `
      SELECT
        TRIM(${commercialSql}) AS commercial_code,
        DATE(${dateSql}) AS constraint_date,
        TRIM(COALESCE(${depotIdSql}, '')) AS depot_id_value,
        ${depotLatSql} AS depot_latitude_value,
        ${depotLonSql} AS depot_longitude_value
      FROM ${tableSql}
      WHERE DATE(${dateSql}) >= ?
        AND DATE(${dateSql}) <= ?
        ${commercialFilter.sql}
    `,
    [startDate, endDate, ...commercialFilter.params]
  )

  const commercialsByCode = new Map()
  ;(rows || []).forEach(row => {
    const commercialCode = normalizeCommercialCode(row.commercial_code)
    const dateIso = normalizeDateOnly(row.constraint_date)
    if (!commercialCode || !dateIso) return

    const latitude = Number(row.depot_latitude_value)
    const longitude = Number(row.depot_longitude_value)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return

    const entry = commercialsByCode.get(commercialCode) || buildDefaultCommercialConstraint(commercialCode)
    entry.depot_id_by_date[dateIso] = String(row.depot_id_value || '').trim() || null
    entry.depot_latitude_by_date[dateIso] = Math.round(latitude * 1000000) / 1000000
    entry.depot_longitude_by_date[dateIso] = Math.round(longitude * 1000000) / 1000000
    entry.time_constraint_source_by_date[dateIso] = mapping.source_label || null
    commercialsByCode.set(commercialCode, entry)
  })

  let depotCommercials = 0
  commercialsByCode.forEach(entry => {
    if (Object.keys(entry.depot_latitude_by_date).length && Object.keys(entry.depot_longitude_by_date).length) {
      depotCommercials += 1
    }
  })

  return {
    commercialsByCode,
    depotCommercials,
    loaded: depotCommercials > 0,
    source: mapping.source_label || null,
    mappingReady: true
  }
}

async function loadClientServiceDurations({
  queryAsync,
  database,
  clientIds = [],
  mapping = COVERAGE_CONSTRAINTS_MAPPING.client_service_duration
}) {
  const resolved = await resolveMappingSection({
    queryAsync,
    database,
    section: mapping
  })

  if (!resolved.configured || !resolved.available) {
    return {
      clientEntriesById: new Map(),
      clientsWithServiceDuration: 0,
      clientsWithEstimatedStops: 0,
      loaded: false,
      source: null,
      mappingReady: false
    }
  }

  const requiredColumns = [
    mapping.client_id_column,
    mapping.service_minutes_column
  ]
  const optionalColumns = [
    mapping.commercial_column,
    mapping.date_column,
    mapping.estimated_stop_minutes_column
  ]
  if (!hasAllColumns(resolved.columns, [...requiredColumns, ...optionalColumns])) {
    return {
      clientEntriesById: new Map(),
      clientsWithServiceDuration: 0,
      clientsWithEstimatedStops: 0,
      loaded: false,
      source: mapping.source_label || null,
      mappingReady: false
    }
  }

  const tableSql = escapeIdentifier(mapping.table)
  const clientIdSql = escapeIdentifier(mapping.client_id_column)
  const serviceSql = escapeIdentifier(mapping.service_minutes_column)
  const commercialSql = mapping.commercial_column ? escapeIdentifier(mapping.commercial_column) : null
  const dateSql = mapping.date_column ? escapeIdentifier(mapping.date_column) : null
  const estimatedStopSql = mapping.estimated_stop_minutes_column ? escapeIdentifier(mapping.estimated_stop_minutes_column) : null
  const clientIdFilter = buildInClause(`CAST(${clientIdSql} AS CHAR)`, normalizeCodeList(clientIds))
  const rows = await queryAsync(
    `
      SELECT
        CAST(${clientIdSql} AS CHAR) AS client_id,
        ${serviceSql} AS service_minutes_value
        ${commercialSql ? `, TRIM(${commercialSql}) AS commercial_code_value` : ''}
        ${dateSql ? `, DATE(${dateSql}) AS constraint_date` : ''}
        ${estimatedStopSql ? `, ${estimatedStopSql} AS estimated_stop_minutes_value` : ''}
      FROM ${tableSql}
      WHERE 1 = 1
        ${clientIdFilter.sql}
    `,
    clientIdFilter.params
  )

  const clientEntriesById = new Map()
  ;(rows || []).forEach(row => {
    const clientId = normalizeClientId(row.client_id)
    if (!clientId) return
    const entry = clientEntriesById.get(clientId) || buildDefaultClientRestriction()
    const serviceMinutes = normalizeNonNegativeNumber(row.service_minutes_value)
    if (serviceMinutes != null) {
      entry.service_minutes = serviceMinutes
      entry.service_minutes_source = mapping.source_label || null
    }
    const estimatedStopMinutes = normalizeNonNegativeNumber(row.estimated_stop_minutes_value)
    const commercialDateKey = buildCommercialDateKey(row.commercial_code_value, row.constraint_date)
    if (commercialDateKey && estimatedStopMinutes != null) {
      entry.estimated_stop_minutes_by_commercial_date[commercialDateKey] = estimatedStopMinutes
    }
    clientEntriesById.set(clientId, entry)
  })

  let clientsWithServiceDuration = 0
  let clientsWithEstimatedStops = 0
  clientEntriesById.forEach(entry => {
    if (entry.service_minutes != null) {
      clientsWithServiceDuration += 1
    }
    if (Object.keys(entry.estimated_stop_minutes_by_commercial_date).length) {
      clientsWithEstimatedStops += 1
    }
  })

  return {
    clientEntriesById,
    clientsWithServiceDuration,
    clientsWithEstimatedStops,
    loaded: clientsWithServiceDuration > 0 || clientsWithEstimatedStops > 0,
    source: mapping.source_label || null,
    mappingReady: true
  }
}

async function loadCoverageConstraints({
  startDate,
  endDate,
  commercialCodes = [],
  clientIds = []
} = {}, options = {}) {
  const normalizedCommercialCodes = normalizeCodeList(commercialCodes)
  const normalizedClientIds = normalizeCodeList(clientIds)
  const mapping = options.mapping || COVERAGE_CONSTRAINTS_MAPPING
  const queryAsync = options.queryAsync
  const database = options.database

  const commercials = {}
  normalizedCommercialCodes.forEach(code => {
    commercials[code] = buildDefaultCommercialConstraint(code)
  })

  const clientRestrictions = {}
  normalizedClientIds.forEach(clientId => {
    clientRestrictions[clientId] = buildDefaultClientRestriction()
  })

  const [
    calendarResult,
    absencesResult,
    capacityResult,
    shiftsResult,
    routeLimitsResult,
    depotsResult,
    clientServiceDurationResult,
    clientRestrictionResult
  ] = await Promise.all([
    loadCommercialCalendar({
      queryAsync,
      database,
      commercialCodes: normalizedCommercialCodes,
      startDate,
      endDate,
      mapping: mapping.commercial_calendar
    }),
    loadCommercialAbsences({
      queryAsync,
      database,
      commercialCodes: normalizedCommercialCodes,
      startDate,
      endDate,
      mapping: mapping.commercial_absences
    }),
    loadCommercialCapacity({
      queryAsync,
      database,
      commercialCodes: normalizedCommercialCodes,
      startDate,
      endDate,
      mapping: mapping.commercial_capacity
    }),
    loadCommercialShifts({
      queryAsync,
      database,
      commercialCodes: normalizedCommercialCodes,
      startDate,
      endDate,
      mapping: mapping.commercial_shifts
    }),
    loadCommercialRouteLimits({
      queryAsync,
      database,
      commercialCodes: normalizedCommercialCodes,
      startDate,
      endDate,
      mapping: mapping.commercial_route_limits
    }),
    loadCommercialDepots({
      queryAsync,
      database,
      commercialCodes: normalizedCommercialCodes,
      startDate,
      endDate,
      mapping: mapping.commercial_depots
    }),
    loadClientServiceDurations({
      queryAsync,
      database,
      clientIds: normalizedClientIds,
      mapping: mapping.client_service_duration
    }),
    loadClientRestrictions({
      queryAsync,
      database,
      commercialCodes: normalizedCommercialCodes,
      clientIds: normalizedClientIds,
      mapping: mapping.client_restrictions
    })
  ])

  ;[
    calendarResult.commercialsByCode,
    absencesResult.commercialsByCode,
    capacityResult.commercialsByCode,
    shiftsResult.commercialsByCode,
    routeLimitsResult.commercialsByCode,
    depotsResult.commercialsByCode
  ].forEach(sourceMap => {
    sourceMap.forEach((entry, commercialCode) => {
      commercials[commercialCode] = commercials[commercialCode] || buildDefaultCommercialConstraint(commercialCode)
      commercials[commercialCode].working_days = normalizeDayIndexList([
        ...commercials[commercialCode].working_days,
        ...(entry.working_days || [])
      ])
      commercials[commercialCode].available_dates = normalizeDateList([
        ...commercials[commercialCode].available_dates,
        ...(entry.available_dates || [])
      ])
      commercials[commercialCode].unavailable_dates = normalizeDateList([
        ...commercials[commercialCode].unavailable_dates,
        ...(entry.unavailable_dates || [])
      ])
      commercials[commercialCode].hard_max_visits_by_date = {
        ...commercials[commercialCode].hard_max_visits_by_date,
        ...normalizePositiveIntegerByDate(entry.hard_max_visits_by_date)
      }
      commercials[commercialCode].max_load_units_by_date = {
        ...commercials[commercialCode].max_load_units_by_date,
        ...normalizePositiveNumberByDate(entry.max_load_units_by_date)
      }
      commercials[commercialCode].shift_start_time_by_date = {
        ...commercials[commercialCode].shift_start_time_by_date,
        ...(entry.shift_start_time_by_date || {})
      }
      commercials[commercialCode].shift_end_time_by_date = {
        ...commercials[commercialCode].shift_end_time_by_date,
        ...(entry.shift_end_time_by_date || {})
      }
      commercials[commercialCode].break_minutes_by_date = {
        ...commercials[commercialCode].break_minutes_by_date,
        ...normalizePositiveNumberByDate(entry.break_minutes_by_date)
      }
      commercials[commercialCode].depot_id_by_date = {
        ...commercials[commercialCode].depot_id_by_date,
        ...(entry.depot_id_by_date || {})
      }
      commercials[commercialCode].depot_latitude_by_date = {
        ...commercials[commercialCode].depot_latitude_by_date,
        ...(entry.depot_latitude_by_date || {})
      }
      commercials[commercialCode].depot_longitude_by_date = {
        ...commercials[commercialCode].depot_longitude_by_date,
        ...(entry.depot_longitude_by_date || {})
      }
      commercials[commercialCode].time_constraint_source_by_date = {
        ...commercials[commercialCode].time_constraint_source_by_date,
        ...(entry.time_constraint_source_by_date || {})
      }
      commercials[commercialCode].constraint_sources_by_date = {
        ...commercials[commercialCode].constraint_sources_by_date,
        ...(entry.constraint_sources_by_date || {})
      }
    })
  })

  Object.values(commercials).forEach(entry => {
    const coveredDates = new Set([
      ...Object.keys(entry.shift_start_time_by_date || {}),
      ...Object.keys(entry.shift_end_time_by_date || {}),
      ...Object.keys(entry.max_route_minutes_by_date || {}),
      ...Object.keys(entry.break_minutes_by_date || {})
    ])
    coveredDates.forEach(dateIso => {
      const hardRouteMinutes = resolveHardRouteMinutes({
        shiftStartTime: entry.shift_start_time_by_date?.[dateIso],
        shiftEndTime: entry.shift_end_time_by_date?.[dateIso],
        breakMinutes: entry.break_minutes_by_date?.[dateIso],
        maxRouteMinutes: entry.max_route_minutes_by_date?.[dateIso]
      })
      if (hardRouteMinutes != null && hardRouteMinutes > 0) {
        entry.max_route_minutes_by_date[dateIso] = hardRouteMinutes
      } else {
        delete entry.max_route_minutes_by_date[dateIso]
      }
    })
  })

  clientServiceDurationResult.clientEntriesById.forEach((entry, clientId) => {
    clientRestrictions[clientId] = {
      ...(clientRestrictions[clientId] || buildDefaultClientRestriction()),
      service_minutes: entry.service_minutes,
      service_minutes_source: entry.service_minutes_source,
      estimated_stop_minutes_by_commercial_date: {
        ...(clientRestrictions[clientId]?.estimated_stop_minutes_by_commercial_date || {}),
        ...(entry.estimated_stop_minutes_by_commercial_date || {})
      }
    }
  })
  clientRestrictionResult.restrictionsByClientId.forEach((restriction, clientId) => {
    clientRestrictions[clientId] = {
      ...(clientRestrictions[clientId] || buildDefaultClientRestriction()),
      allowed_commercial_codes: normalizeCodeList(restriction.allowed_commercial_codes),
      denied_commercial_codes: normalizeCodeList(restriction.denied_commercial_codes),
      source: restriction.source || null,
      service_minutes: clientRestrictions[clientId]?.service_minutes ?? null,
      service_minutes_source: clientRestrictions[clientId]?.service_minutes_source ?? null,
      estimated_stop_minutes_by_commercial_date: {
        ...(clientRestrictions[clientId]?.estimated_stop_minutes_by_commercial_date || {})
      }
    }
  })

  const timeCapacityKnown = (
    normalizedCommercialCodes.length > 0 &&
    routeLimitsResult.routeLimitCommercials >= normalizedCommercialCodes.length &&
    clientServiceDurationResult.clientsWithEstimatedStops >= normalizedClientIds.length &&
    (routeLimitsResult.invalidRows + shiftsResult.invalidRows) === 0
  )

  return {
    period: {
      start: normalizeDateOnly(startDate),
      end: normalizeDateOnly(endDate)
    },
    commercials,
    client_restrictions: clientRestrictions,
    diagnostic: {
      availability_loaded: calendarResult.loaded,
      absences_loaded: absencesResult.loaded,
      hard_visits_loaded: capacityResult.hardVisitsCommercials > 0,
      truck_capacity_loaded: capacityResult.truckCapacityCommercials > 0,
      client_restrictions_loaded: clientRestrictionResult.loaded,
      time_capacity_known: timeCapacityKnown
    },
    meta: {
      sources: {
        availability: calendarResult.source || null,
        absences: absencesResult.source || null,
        hard_max_visits: capacityResult.source || null,
        truck_capacity: capacityResult.source || null,
        client_restrictions: clientRestrictionResult.source || null,
        route_time: {
          shifts: shiftsResult.source || null,
          route_limits: routeLimitsResult.source || null,
          depots: depotsResult.source || null,
          service_duration: clientServiceDurationResult.source || null,
          travel_matrix: null
        }
      },
      counts: {
        availability: calendarResult.availableCommercials,
        absences: absencesResult.absentCommercials,
        hard_max_visits: capacityResult.hardVisitsCommercials,
        truck_capacity: capacityResult.truckCapacityCommercials,
        client_restrictions: clientRestrictionResult.clientsWithData,
        route_time: {
          commercials_with_shift_data: shiftsResult.shiftCommercials,
          commercials_with_route_limit: routeLimitsResult.routeLimitCommercials,
          commercials_with_depot_data: depotsResult.depotCommercials,
          clients_with_service_duration: clientServiceDurationResult.clientsWithServiceDuration,
          clients_with_estimated_stop_minutes: clientServiceDurationResult.clientsWithEstimatedStops,
          invalid_rows: shiftsResult.invalidRows + routeLimitsResult.invalidRows,
          travel_matrix_available: false
        }
      },
      mapping_status: {
        availability: calendarResult.mappingReady,
        absences: absencesResult.mappingReady,
        hard_max_visits: capacityResult.mappingReady,
        truck_capacity: capacityResult.mappingReady,
        client_restrictions: clientRestrictionResult.mappingReady,
        route_time: Boolean(
          shiftsResult.mappingReady ||
          routeLimitsResult.mappingReady ||
          depotsResult.mappingReady ||
          clientServiceDurationResult.mappingReady
        )
      }
    }
  }
}

function mergeCoverageCommercialConstraintEntries(providerEntry = {}, requestEntry = {}) {
  const providerWorkingDays = normalizeDayIndexList(providerEntry.working_days)
  const requestWorkingDays = normalizeDayIndexList(requestEntry.working_days)
  const providerAvailableDates = normalizeDateList(providerEntry.available_dates)
  const requestAvailableDates = normalizeDateList(requestEntry.available_dates)
  const providerUnavailableDates = normalizeDateList(providerEntry.unavailable_dates)
  const requestUnavailableDates = normalizeDateList(requestEntry.unavailable_dates)

  let workingDays = []
  if (providerWorkingDays.length && requestWorkingDays.length) {
    const requestSet = new Set(requestWorkingDays)
    workingDays = providerWorkingDays.filter(day => requestSet.has(day))
  } else {
    workingDays = providerWorkingDays.length ? providerWorkingDays : requestWorkingDays
  }

  let availableDates = []
  if (providerAvailableDates.length && requestAvailableDates.length) {
    const requestSet = new Set(requestAvailableDates)
    availableDates = providerAvailableDates.filter(date => requestSet.has(date))
  } else {
    availableDates = providerAvailableDates.length ? providerAvailableDates : requestAvailableDates
  }

  return {
    ...requestEntry,
    ...providerEntry,
    working_days: workingDays,
    available_dates: availableDates,
    unavailable_dates: normalizeDateList([
      ...providerUnavailableDates,
      ...requestUnavailableDates
    ]),
    max_visits_by_date: {
      ...(requestEntry.max_visits_by_date || {})
    },
    hard_max_visits_by_date: {
      ...(requestEntry.hard_max_visits_by_date || {}),
      ...normalizePositiveIntegerByDate(providerEntry.hard_max_visits_by_date)
    },
    max_load_units_by_date: {
      ...(requestEntry.max_load_units_by_date || {}),
      ...normalizePositiveNumberByDate(providerEntry.max_load_units_by_date)
    },
    shift_start_time_by_date: {
      ...(requestEntry.shift_start_time_by_date || {}),
      ...(providerEntry.shift_start_time_by_date || {})
    },
    shift_end_time_by_date: {
      ...(requestEntry.shift_end_time_by_date || {}),
      ...(providerEntry.shift_end_time_by_date || {})
    },
    max_route_minutes_by_date: {
      ...(requestEntry.max_route_minutes_by_date || {}),
      ...normalizePositiveNumberByDate(providerEntry.max_route_minutes_by_date)
    },
    break_minutes_by_date: {
      ...(requestEntry.break_minutes_by_date || {}),
      ...normalizePositiveNumberByDate(providerEntry.break_minutes_by_date)
    },
    depot_id_by_date: {
      ...(requestEntry.depot_id_by_date || {}),
      ...(providerEntry.depot_id_by_date || {})
    },
    depot_latitude_by_date: {
      ...(requestEntry.depot_latitude_by_date || {}),
      ...(providerEntry.depot_latitude_by_date || {})
    },
    depot_longitude_by_date: {
      ...(requestEntry.depot_longitude_by_date || {}),
      ...(providerEntry.depot_longitude_by_date || {})
    },
    time_constraint_source_by_date: {
      ...(requestEntry.time_constraint_source_by_date || {}),
      ...(providerEntry.time_constraint_source_by_date || {})
    },
    constraint_sources_by_date: {
      ...(requestEntry.constraint_sources_by_date || {}),
      ...(providerEntry.constraint_sources_by_date || {})
    }
  }
}

function resolveCoverageClientRestriction({
  clientId,
  constraintEntry,
  historicalCommercialCode,
  activeCommercialCodes = [],
  allowCommercialReassignment = true
}) {
  const normalizedClientId = normalizeClientId(clientId)
  const normalizedHistoricalCode = normalizeCommercialCode(historicalCommercialCode)
  const activeCodes = normalizeCodeList(activeCommercialCodes)
  const activeCodeSet = new Set(activeCodes)
  const allowedCodes = normalizeCodeList(constraintEntry?.allowed_commercial_codes).filter(code => activeCodeSet.has(code))
  const deniedCodeSet = new Set(
    normalizeCodeList(constraintEntry?.denied_commercial_codes).filter(code => activeCodeSet.has(code))
  )

  const explicitAllowedCodes = allowedCodes.filter(code => !deniedCodeSet.has(code))
  if (normalizedClientId && explicitAllowedCodes.length) {
    return {
      client_id: normalizedClientId,
      allowed_commercial_codes: explicitAllowedCodes,
      restriction_source: constraintEntry?.source || null,
      has_explicit_constraint: true,
      service_minutes: constraintEntry?.service_minutes ?? null,
      service_minutes_source: constraintEntry?.service_minutes_source || null,
      estimated_stop_minutes_by_commercial_date: {
        ...(constraintEntry?.estimated_stop_minutes_by_commercial_date || {})
      }
    }
  }

  const fallbackAllowedCodes = allowCommercialReassignment
    ? activeCodes.filter(code => !deniedCodeSet.has(code))
    : (
        normalizedHistoricalCode &&
        activeCodeSet.has(normalizedHistoricalCode) &&
        !deniedCodeSet.has(normalizedHistoricalCode)
      )
        ? [normalizedHistoricalCode]
        : activeCodes.filter(code => !deniedCodeSet.has(code))

  return {
    client_id: normalizedClientId,
    allowed_commercial_codes: fallbackAllowedCodes,
    restriction_source: constraintEntry?.source || null,
    has_explicit_constraint: false,
    service_minutes: constraintEntry?.service_minutes ?? null,
    service_minutes_source: constraintEntry?.service_minutes_source || null,
    estimated_stop_minutes_by_commercial_date: {
      ...(constraintEntry?.estimated_stop_minutes_by_commercial_date || {})
    }
  }
}

function buildCoverageConstraintsDiagnosticResponse(constraints = {}, context = {}) {
  const commercialsChecked = Number(context.commercialsChecked || 0)
  const clientsChecked = Number(context.clientsChecked || 0)
  const counts = constraints.meta?.counts || {}
  const sources = constraints.meta?.sources || {}
  const mappingStatus = constraints.meta?.mapping_status || {}
  const missingConstraints = []
  const routeTimeCounts = counts.route_time || {}

  const buildStatus = ({ count = 0, checked = 0, mappingReady = false }) => {
    if (count > 0 && checked > 0 && count >= checked) return 'complete'
    if (count > 0) return 'partial'
    return mappingReady ? 'partial' : 'absent'
  }

  const response = {
    period: constraints.period || {
      start: normalizeDateOnly(context.startDate),
      end: normalizeDateOnly(context.endDate)
    },
    commercials_checked: commercialsChecked,
    constraints: {
      availability: {
        status: buildStatus({
          count: counts.availability,
          checked: commercialsChecked,
          mappingReady: mappingStatus.availability
        }),
        source: sources.availability || null,
        commercials_with_data: Number(counts.availability || 0)
      },
      absences: {
        status: buildStatus({
          count: counts.absences,
          checked: commercialsChecked,
          mappingReady: mappingStatus.absences
        }),
        source: sources.absences || null,
        commercials_with_data: Number(counts.absences || 0)
      },
      hard_max_visits: {
        status: buildStatus({
          count: counts.hard_max_visits,
          checked: commercialsChecked,
          mappingReady: mappingStatus.hard_max_visits
        }),
        source: sources.hard_max_visits || null,
        commercials_with_data: Number(counts.hard_max_visits || 0)
      },
      truck_capacity: {
        status: buildStatus({
          count: counts.truck_capacity,
          checked: commercialsChecked,
          mappingReady: mappingStatus.truck_capacity
        }),
        source: sources.truck_capacity || null,
        commercials_with_data: Number(counts.truck_capacity || 0)
      },
      client_commercial_restrictions: {
        status: buildStatus({
          count: counts.client_restrictions,
          checked: clientsChecked,
          mappingReady: mappingStatus.client_restrictions
        }),
        source: sources.client_restrictions || null,
        clients_with_data: Number(counts.client_restrictions || 0)
      },
      route_time: {
        status: buildStatus({
          count: Math.min(
            Number(routeTimeCounts.commercials_with_route_limit || 0),
            Number(routeTimeCounts.clients_with_estimated_stop_minutes || 0)
          ),
          checked: Math.max(commercialsChecked, clientsChecked),
          mappingReady: Boolean(mappingStatus.route_time)
        }),
        commercials_with_shift_data: Number(routeTimeCounts.commercials_with_shift_data || 0),
        commercials_with_route_limit: Number(routeTimeCounts.commercials_with_route_limit || 0),
        clients_with_service_duration: Number(routeTimeCounts.clients_with_service_duration || 0),
        travel_matrix_available: Boolean(routeTimeCounts.travel_matrix_available)
      }
    },
    time_capacity_known: Boolean(constraints.diagnostic?.time_capacity_known),
    operational_capacity_known: Boolean(
      constraints.diagnostic?.time_capacity_known
    ),
    missing_constraints: missingConstraints
  }

  Object.entries(response.constraints).forEach(([constraintName, summary]) => {
    if (summary.status !== 'complete') {
      missingConstraints.push(constraintName)
    }
  })

  return response
}

module.exports = {
  buildCoverageConstraintsDiagnosticResponse,
  loadCoverageConstraints,
  mergeCoverageCommercialConstraintEntries,
  resolveCoverageClientRestriction
}

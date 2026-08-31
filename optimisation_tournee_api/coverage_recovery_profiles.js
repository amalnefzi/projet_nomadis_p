const RECOVERY_CREDIT_DOC_TYPES = Object.freeze(['facture', 'bl', 'blf'])
const RECOVERY_CREDIT_SOURCE = 'entetecommercials.client_code_exact'
const RECOVERY_PAYMENT_SOURCE = 'paiements.client_code_exact'
const RECOVERY_MIN_DEBT_DAYS = 2
const RECOVERY_MIN_SALE_GAP_DAYS = 2
const RECOVERY_MIN_PAYMENT_GAP_DAYS = 3

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function roundScore(value) {
  return Math.round(Number(value || 0) * 10) / 10
}

function parseSqlDate(value) {
  if (!value) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return new Date(Date.UTC(
      value.getFullYear(),
      value.getMonth(),
      value.getDate()
    ))
  }
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}:\d{2})?$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!year || !month || !day) return null
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null
  }
  return parsed
}

function formatSqlDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null
  return value.toISOString().slice(0, 10)
}

function normalizeSqlDate(value) {
  return formatSqlDate(parseSqlDate(value))
}

function diffDays(dateA, dateB) {
  const first = parseSqlDate(dateA)
  const second = parseSqlDate(dateB)
  if (!first || !second) return null
  return Math.max(0, Math.floor((second.getTime() - first.getTime()) / 86400000))
}

function addRoundedDays(dateValue, days) {
  const baseDate = parseSqlDate(dateValue)
  const numericDays = Number(days)
  if (!baseDate || !Number.isFinite(numericDays)) return null
  baseDate.setUTCDate(baseDate.getUTCDate() + Math.round(numericDays))
  return formatSqlDate(baseDate)
}

function median(values = []) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = values
    .map(value => Number(value))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[mid]
  }
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function average(values = []) {
  const numericValues = (Array.isArray(values) ? values : [])
    .map(value => Number(value))
    .filter(Number.isFinite)
  if (numericValues.length === 0) return null
  return numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
}

function normalizeClientId(value) {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim()
  return normalized || null
}

function normalizeExactClientCode(value) {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim()
  return normalized || null
}

function buildRecoveryNonCancelledDocumentSqlCondition(columnName = 'e.annule') {
  return `(${columnName} IS NULL OR TRIM(${columnName}) = '' OR TRIM(${columnName}) = '0')`
}

function buildValidRecoveryPaymentSqlCondition(alias = 'p') {
  return [
    `${alias}.deleted_at IS NULL`,
    `${alias}.date IS NOT NULL`,
    `CAST(COALESCE(${alias}.montant, '0') AS DECIMAL(15,3)) > 0`,
    `(${alias}.codeAnnulation IS NULL OR TRIM(${alias}.codeAnnulation) = '')`
  ].join(' AND ')
}

function buildSqlPlaceholders(values = []) {
  return values.map(() => '?').join(', ')
}

function normalizeClientRow(row = {}) {
  return {
    client_id: normalizeClientId(row.client_id ?? row.id),
    client_code: normalizeExactClientCode(row.client_code ?? row.nbr_client ?? row.code),
    plafond_credit: Number(row.plafond_credit ?? row.plafond ?? 0),
    encours_credit: Number(row.encours_credit ?? 0),
    delai_paiement: Number(row.delai_paiement ?? 0),
    nom: row.nom || null,
    adresse: row.adresse || null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    region: row.region || null,
    commercia_zone: row.commercia_zone || null,
    date_jour: row.date_jour || null
  }
}

function estimateLikelyRecoveryAmount({
  encoursCredit,
  avgPaymentAmount,
  maxPaymentAmount,
  totalPaid30d,
  nbPaymentsHist,
  nbDocsCredit
}) {
  const encours = Number(encoursCredit || 0)
  if (encours <= 0) return 0

  const avgPaid = Number(avgPaymentAmount || 0)
  const maxPaid = Number(maxPaymentAmount || 0)
  const paid30d = Number(totalPaid30d || 0)
  const trancheRatio = nbDocsCredit > 0 ? Number(nbPaymentsHist || 0) / nbDocsCredit : 0
  const tendsToPayByTranches = trancheRatio > 1.2

  let estimated = avgPaid

  if (tendsToPayByTranches) {
    estimated = Math.max(avgPaid, paid30d > 0 ? paid30d * 0.6 : 0)
  } else {
    estimated = Math.max(avgPaid * 1.15, maxPaid * 0.5, paid30d > 0 ? paid30d * 0.4 : 0)
  }

  if (estimated <= 0) {
    estimated = Math.min(encours, maxPaid || avgPaid || encours * 0.25)
  }

  return roundScore(clamp(estimated, 0, encours))
}

function computeSmartRecoveryScore({
  dueBalance,
  maxDueBalance,
  likelyRecoveryAmount,
  maxLikelyRecovery,
  severeOverdueBalance,
  maxSevereOverdue,
  paymentBehaviorScore,
  distanceKm,
  maxDistanceKm
}) {
  const dueBalanceNorm = maxDueBalance > 0 ? dueBalance / maxDueBalance : 0
  const likelyRecoveryNorm = maxLikelyRecovery > 0 ? likelyRecoveryAmount / maxLikelyRecovery : 0
  const severeOverdueNorm = maxSevereOverdue > 0 ? severeOverdueBalance / maxSevereOverdue : 0
  const paymentBehaviorNorm = clamp(paymentBehaviorScore || 0, 0, 1)
  const distanceNorm = maxDistanceKm > 0 ? clamp(distanceKm / maxDistanceKm, 0, 1) : 0

  const scoreNorm =
    (0.45 * dueBalanceNorm) +
    (0.25 * severeOverdueNorm) +
    (0.20 * likelyRecoveryNorm) +
    (0.15 * paymentBehaviorNorm) -
    (0.05 * distanceNorm)

  return roundScore(clamp(scoreNorm * 100, 0, 100))
}

function buildDefaultProfile(clientRow = {}) {
  return {
    client_id: clientRow.client_id,
    client_code: clientRow.client_code,
    credit: {
      total_balance: null,
      due_amount: null,
      oldest_credit_date: null,
      last_credit_date: null,
      days_past_due: null,
      age_bucket_0_30: null,
      age_bucket_31_60: null,
      age_bucket_61_90: null,
      age_bucket_90_plus: null
    },
    payment_behavior: {
      last_payment_date: null,
      average_payment_amount: null,
      median_payment_amount: null,
      maximum_payment_amount: null,
      total_paid_history: null,
      payment_count: null,
      average_payment_interval_days: null,
      median_payment_interval_days: null,
      expected_next_payment_date: null,
      days_since_expected_payment: null,
      payment_behavior_score: null
    },
    recovery: {
      expected_collection_amount: null,
      collection_priority_score: null
    },
    sources: {
      credit: null,
      payments: null
    },
    diagnostics: {
      historical_code_status: clientRow.client_code ? 'matched' : 'missing_client_code',
      skipped_credit_rows: 0,
      skipped_payment_rows: 0,
      payment_query_failed: false
    },
    legacy: {
      plafond_credit: Number(clientRow.plafond_credit || 0),
      encours_reference: Number(clientRow.encours_credit || 0),
      delai_paiement: Math.max(0, Math.round(Number(clientRow.delai_paiement || 0))),
      effective_due_balance: null,
      nb_docs_credit: null,
      avg_credit_amount: null,
      max_credit_amount: null,
      severe_overdue_balance: null,
      overdue_weighted_ratio: null,
      severe_overdue_ratio: null,
      days_since_oldest_debt: null,
      last_sale_date: null,
      days_since_last_sale: null,
      days_since_last_payment: null,
      total_paid_30d: null,
      nb_payment_refs: null,
      nb_payments_90d: null,
      likely_recovery_amount: null,
      is_due_today: null,
      days_to_due: null
    }
  }
}

function hasFiniteRecoveryNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function compareRecoveryProfileEntries(leftEntry, rightEntry) {
  const leftProfile = leftEntry?.profile || leftEntry || {}
  const rightProfile = rightEntry?.profile || rightEntry || {}

  const leftCode = normalizeExactClientCode(leftProfile.client_code) || ''
  const rightCode = normalizeExactClientCode(rightProfile.client_code) || ''
  const byCode = leftCode.localeCompare(rightCode)
  if (byCode !== 0) return byCode

  const leftId = normalizeClientId(leftProfile.client_id) || ''
  const rightId = normalizeClientId(rightProfile.client_id) || ''
  const byId = leftId.localeCompare(rightId)
  if (byId !== 0) return byId

  const leftReason = leftEntry?.reason || ''
  const rightReason = rightEntry?.reason || ''
  const byReason = leftReason.localeCompare(rightReason)
  if (byReason !== 0) return byReason

  const leftExpected = String(leftProfile?.payment_behavior?.expected_next_payment_date || '')
  const rightExpected = String(rightProfile?.payment_behavior?.expected_next_payment_date || '')
  const byExpected = leftExpected.localeCompare(rightExpected)
  if (byExpected !== 0) return byExpected

  const leftDue = Number(leftProfile?.credit?.due_amount || 0)
  const rightDue = Number(rightProfile?.credit?.due_amount || 0)
  if (leftDue !== rightDue) return leftDue - rightDue

  const leftBalance = Number(leftProfile?.credit?.total_balance || 0)
  const rightBalance = Number(rightProfile?.credit?.total_balance || 0)
  if (leftBalance !== rightBalance) return leftBalance - rightBalance

  return 0
}

function isRecoveryProfileRecoverable(profile = {}, strictMode = true) {
  const dueAmount = Number(profile.credit?.due_amount || 0)
  const effectiveDueBalance = Number(profile.legacy?.effective_due_balance || 0)
  const daysSinceOldestDebt = profile.legacy?.days_since_oldest_debt
  const graceDays = Math.max(2, Number(profile.legacy?.delai_paiement || 0))
  const daysSinceLastSale = profile.legacy?.days_since_last_sale
  const daysSinceLastPayment = profile.legacy?.days_since_last_payment
  const daysToDue = Number(profile.legacy?.days_to_due || 0)
  const isDueToday = Number(profile.legacy?.is_due_today || 0) === 1
  const severeOverdueBalance = Number(profile.legacy?.severe_overdue_balance || 0)
  const plafondCredit = Number(profile.legacy?.plafond_credit || 0)
  const selectedDueBalance = strictMode ? dueAmount : effectiveDueBalance

  if (selectedDueBalance <= 0) {
    return false
  }

  if (strictMode) {
    if (daysSinceOldestDebt != null && daysSinceOldestDebt < RECOVERY_MIN_DEBT_DAYS) {
      return false
    }

    if (daysSinceOldestDebt != null && daysSinceOldestDebt < graceDays) {
      return false
    }

    if (daysSinceLastSale != null && daysSinceLastSale < Math.max(RECOVERY_MIN_SALE_GAP_DAYS, Math.min(graceDays, 7))) {
      return false
    }

    if (daysSinceLastPayment != null && daysSinceLastPayment < RECOVERY_MIN_PAYMENT_GAP_DAYS) {
      return false
    }

    return dueAmount > 0
  }

  const urgentExposure = selectedDueBalance >= Math.max(150, plafondCredit * 0.35)
  const canVisitToday = isDueToday || severeOverdueBalance > 0 || urgentExposure

  if (!canVisitToday) {
    return false
  }

  if (daysSinceLastPayment != null && daysSinceLastPayment < 1) {
    return false
  }

  if (daysSinceLastSale != null && daysSinceLastSale < 1) {
    return false
  }

  return daysToDue >= 0
}

function classifyRecoveryProfilesForPeriod({
  profiles = [],
  startDate,
  endDate
} = {}) {
  const normalizedStartDate = formatSqlDate(parseSqlDate(startDate))
  const normalizedEndDate = formatSqlDate(parseSqlDate(endDate))

  if (!normalizedStartDate || !normalizedEndDate) {
    throw new Error('classifyRecoveryProfilesForPeriod requires valid startDate and endDate.')
  }
  if (normalizedStartDate > normalizedEndDate) {
    throw new Error('classifyRecoveryProfilesForPeriod requires startDate to be on or before endDate.')
  }

  const reasonCounts = Object.create(null)
  const eligibleEntries = []
  const excludedEntries = []

  function registerDecision(bucket, profile, reason) {
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1
    bucket.push({ profile, reason })
  }

  ;(Array.isArray(profiles) ? profiles : []).forEach(profile => {
    const historicalCodeStatus = profile?.diagnostics?.historical_code_status
    const clientId = normalizeClientId(profile?.client_id)
    const clientCode = normalizeExactClientCode(profile?.client_code)
    const hasExactIdentity = Boolean(clientId && clientCode) &&
      historicalCodeStatus !== 'missing_client_code' &&
      historicalCodeStatus !== 'ambiguous_exact_code'

    if (!hasExactIdentity) {
      registerDecision(excludedEntries, profile, 'missing_exact_identity')
      return
    }

    const rawTotalBalance = profile?.credit?.total_balance
    const rawDueAmount = profile?.credit?.due_amount
    const rawExpectedPaymentDate = profile?.payment_behavior?.expected_next_payment_date
    const hasTotalBalance = hasFiniteRecoveryNumber(rawTotalBalance)
    const hasDueAmount = hasFiniteRecoveryNumber(rawDueAmount)
    const hasExpectedPaymentDate = rawExpectedPaymentDate !== null &&
      rawExpectedPaymentDate !== undefined &&
      String(rawExpectedPaymentDate).trim() !== ''

    if (!hasTotalBalance || (!hasDueAmount && !hasExpectedPaymentDate)) {
      registerDecision(excludedEntries, profile, 'missing_recovery_data')
      return
    }

    const totalBalance = Number(rawTotalBalance)
    if (!(totalBalance > 0)) {
      registerDecision(excludedEntries, profile, 'non_positive_total_balance')
      return
    }

    const dueAmount = hasDueAmount ? Number(rawDueAmount) : 0
    if (dueAmount > 0) {
      registerDecision(eligibleEntries, profile, 'positive_due_amount')
      return
    }

    const relaxedRecoverable = isRecoveryProfileRecoverable(profile, false)

    const normalizedExpectedPaymentDate = formatSqlDate(parseSqlDate(rawExpectedPaymentDate))
    if (!normalizedExpectedPaymentDate) {
      if (relaxedRecoverable) {
        registerDecision(eligibleEntries, profile, 'positive_total_balance_relaxed')
        return
      }
      registerDecision(excludedEntries, profile, 'missing_recovery_data')
      return
    }

    if (normalizedExpectedPaymentDate < normalizedStartDate) {
      registerDecision(eligibleEntries, profile, 'expected_payment_overdue')
      return
    }

    if (normalizedExpectedPaymentDate <= normalizedEndDate) {
      registerDecision(eligibleEntries, profile, 'expected_payment_in_period')
      return
    }

    if (relaxedRecoverable) {
      registerDecision(eligibleEntries, profile, 'positive_total_balance_relaxed')
      return
    }

    registerDecision(excludedEntries, profile, 'payment_due_after_period')
  })

  eligibleEntries.sort(compareRecoveryProfileEntries)
  excludedEntries.sort(compareRecoveryProfileEntries)

  return {
    eligibleProfiles: eligibleEntries.map(entry => entry.profile),
    excludedProfiles: excludedEntries.map(entry => ({
      client_id: normalizeClientId(entry.profile?.client_id),
      client_code: normalizeExactClientCode(entry.profile?.client_code),
      reason: entry.reason,
      profile: entry.profile
    })),
    reasonCounts,
    eligibleCount: eligibleEntries.length,
    excludedCount: excludedEntries.length,
    totalCount: eligibleEntries.length + excludedEntries.length
  }
}

async function loadRecoveryProfiles({
  clientIds = [],
  referenceDate,
  connection = null,
  queryRows,
  clientRows = null,
  logger = console
}) {
  if (typeof queryRows !== 'function') {
    throw new Error('loadRecoveryProfiles requires a queryRows function.')
  }

  const normalizedClientIds = [...new Set(
    (Array.isArray(clientIds) ? clientIds : [])
      .map(normalizeClientId)
      .filter(Boolean)
  )]

  if (normalizedClientIds.length === 0) {
    return []
  }

  let baseClients = Array.isArray(clientRows) && clientRows.length > 0
    ? clientRows.map(normalizeClientRow)
    : []

  if (baseClients.length === 0) {
    const idPlaceholders = buildSqlPlaceholders(normalizedClientIds)
    const fetchedClients = await queryRows(`
      SELECT
        c.id AS client_id,
        c.code AS client_code,
        CAST(COALESCE(c.plafond_credit, '0') AS DECIMAL(15,3)) AS plafond_credit,
        CAST(COALESCE(c.encours_actuelement, '0') AS DECIMAL(15,3)) AS encours_credit,
        CAST(COALESCE(c.delai_paiement, '0') AS DECIMAL(15,3)) AS delai_paiement,
        c.nom,
        c.adresse_facturation AS adresse,
        c.latitude,
        c.longitude,
        c.region
      FROM clients c
      WHERE c.deleted_at IS NULL
        AND c.isactif = '1'
        AND c.id IN (${idPlaceholders})
    `, normalizedClientIds, connection)
    baseClients = fetchedClients.map(normalizeClientRow)
  }

  const clientOrder = new Map(normalizedClientIds.map((clientId, index) => [clientId, index]))
  const clientsById = new Map()
  const clientIdsByCode = new Map()

  baseClients.forEach(clientRow => {
    if (!clientRow.client_id || !clientOrder.has(clientRow.client_id)) return
    clientsById.set(clientRow.client_id, clientRow)
    const exactCode = clientRow.client_code
    if (!exactCode) return
    if (!clientIdsByCode.has(exactCode)) {
      clientIdsByCode.set(exactCode, [])
    }
    clientIdsByCode.get(exactCode).push(clientRow.client_id)
  })

  const exactClientCodes = [...new Set(
    [...clientsById.values()]
      .map(clientRow => clientRow.client_code)
      .filter(Boolean)
  )]

  const ambiguousClientCodes = new Set(
    [...clientIdsByCode.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([clientCode]) => clientCode)
  )

  const profilesById = new Map(
    [...clientsById.values()].map(clientRow => {
      const profile = buildDefaultProfile(clientRow)
      if (ambiguousClientCodes.has(clientRow.client_code)) {
        profile.diagnostics.historical_code_status = 'ambiguous_exact_code'
      }
      return [clientRow.client_id, profile]
    })
  )

  if (exactClientCodes.length === 0) {
    return normalizedClientIds
      .map(clientId => profilesById.get(clientId))
      .filter(Boolean)
  }

  const codePlaceholders = buildSqlPlaceholders(exactClientCodes)
  const nonCancelledDocumentCondition = buildRecoveryNonCancelledDocumentSqlCondition('e.annule')

  const creditRows = await queryRows(`
    SELECT
      e.client_code,
      DATE(e.date) AS credit_date,
      CAST(COALESCE(e.solde, '0') AS DECIMAL(15,3)) AS doc_solde,
      CAST(COALESCE(e.net_a_payer, '0') AS DECIMAL(15,3)) AS doc_credit_amount
    FROM entetecommercials e
    WHERE e.deleted_at IS NULL
      AND e.type IN (${RECOVERY_CREDIT_DOC_TYPES.map(() => '?').join(', ')})
      AND (
        LOWER(TRIM(COALESCE(e.mode_paiement, ''))) = 'credit'
        OR TRIM(COALESCE(e.mode_paiement, '')) = ''
      )
      AND ${nonCancelledDocumentCondition}
      AND CAST(COALESCE(e.solde, '0') AS DECIMAL(15,3)) > 0
      AND DATE(e.date) <= ?
      AND TRIM(e.client_code) IN (${codePlaceholders})
  `, [...RECOVERY_CREDIT_DOC_TYPES, referenceDate, ...exactClientCodes], connection)

  const lastSaleRows = await queryRows(`
    SELECT
      e.client_code,
      MAX(DATE(e.date)) AS last_sale_date
    FROM entetecommercials e
    WHERE e.deleted_at IS NULL
      AND e.type IN (${RECOVERY_CREDIT_DOC_TYPES.map(() => '?').join(', ')})
      AND ${nonCancelledDocumentCondition}
      AND DATE(e.date) <= ?
      AND TRIM(e.client_code) IN (${codePlaceholders})
    GROUP BY e.client_code
  `, [...RECOVERY_CREDIT_DOC_TYPES, referenceDate, ...exactClientCodes], connection)

  let paymentRows = []
  let paymentQueryFailed = false

  try {
    paymentRows = await queryRows(`
      SELECT
        p.id AS payment_id,
        p.client_code,
        DATE(p.date) AS payment_date,
        CAST(COALESCE(p.montant, '0') AS DECIMAL(15,3)) AS payment_amount,
        COALESCE(NULLIF(p.code_bl, ''), NULLIF(p.bl_code, ''), CONCAT('NOREF-', p.id)) AS payment_ref,
        p.codeAnnulation,
        p.recouvrement,
        p.impaye
      FROM paiements p
      WHERE ${buildValidRecoveryPaymentSqlCondition('p')}
        AND DATE(p.date) <= ?
        AND TRIM(p.client_code) IN (${codePlaceholders})
    `, [referenceDate, ...exactClientCodes], connection)
  } catch (error) {
    paymentQueryFailed = true
    if (logger && typeof logger.error === 'function') {
      logger.error('Impossible de lire les paiements pour le recouvrement:', error.message)
    }
  }

  const creditDocsByClientId = new Map()
  const lastSalesByClientId = new Map()
  const paymentsByClientId = new Map()

  function attachHistoricalRow(targetMap, clientCode, payload, skippedField) {
    const exactCode = normalizeExactClientCode(clientCode)
    if (!exactCode) return
    const matchedClientIds = clientIdsByCode.get(exactCode) || []

    if (matchedClientIds.length !== 1) {
      matchedClientIds.forEach(clientId => {
        const profile = profilesById.get(clientId)
        if (profile) {
          profile.diagnostics[skippedField] += 1
        }
      })
      return
    }

    const clientId = matchedClientIds[0]
    if (!targetMap.has(clientId)) {
      targetMap.set(clientId, [])
    }
    targetMap.get(clientId).push(payload)
  }

  ;(creditRows || []).forEach(row => {
    attachHistoricalRow(
      creditDocsByClientId,
      row.client_code,
      {
        credit_date: normalizeSqlDate(row.credit_date),
        doc_solde: Number(row.doc_solde || 0),
        doc_credit_amount: Number(row.doc_credit_amount || 0)
      },
      'skipped_credit_rows'
    )
  })

  ;(lastSaleRows || []).forEach(row => {
    const exactCode = normalizeExactClientCode(row.client_code)
    const matchedClientIds = clientIdsByCode.get(exactCode) || []
    if (matchedClientIds.length !== 1) return
    lastSalesByClientId.set(matchedClientIds[0], normalizeSqlDate(row.last_sale_date))
  })

  ;(paymentRows || []).forEach(row => {
    attachHistoricalRow(
      paymentsByClientId,
      row.client_code,
      {
        payment_id: normalizeClientId(row.payment_id),
        payment_date: normalizeSqlDate(row.payment_date),
        payment_amount: Number(row.payment_amount || 0),
        payment_ref: row.payment_ref ? String(row.payment_ref).trim() : null,
        codeAnnulation: row.codeAnnulation,
        recouvrement: row.recouvrement,
        impaye: row.impaye
      },
      'skipped_payment_rows'
    )
  })

  profilesById.forEach(profile => {
    profile.diagnostics.payment_query_failed = paymentQueryFailed
  })

  profilesById.forEach((profile, clientId) => {
    const clientRow = clientsById.get(clientId) || {}
    const delaiPaiementJours = Math.max(0, Math.round(Number(clientRow.delai_paiement || 0)))
    const graceDays = Math.max(2, delaiPaiementJours)
    const docs = creditDocsByClientId.get(clientId) || []
    const paymentHistory = (paymentsByClientId.get(clientId) || [])
      .filter(row => Number.isFinite(row.payment_amount) && row.payment_amount > 0 && row.payment_date)
      .sort((left, right) => String(left.payment_date).localeCompare(String(right.payment_date)))

    profile.legacy.delai_paiement = delaiPaiementJours

    if (docs.length > 0) {
      let totalSolde = 0
      let totalCreditHist = 0
      let maxCreditAmount = 0
      let oldestCreditDate = null
      let lastCreditDate = null
      let overdue0to30 = 0
      let overdue31to60 = 0
      let overdue61to90 = 0
      let overdue90plus = 0
      let maxDocPastDue = 0

      docs.forEach(doc => {
        const soldeDoc = Number(doc.doc_solde || 0)
        const creditAmount = Number(doc.doc_credit_amount || 0)

        totalSolde += soldeDoc
        totalCreditHist += creditAmount
        if (creditAmount > maxCreditAmount) maxCreditAmount = creditAmount

        if (!oldestCreditDate || String(doc.credit_date) < String(oldestCreditDate)) {
          oldestCreditDate = doc.credit_date
        }
        if (!lastCreditDate || String(doc.credit_date) > String(lastCreditDate)) {
          lastCreditDate = doc.credit_date
        }

        const rawDays = diffDays(doc.credit_date, referenceDate)
        const daysPastDoc = Math.max(0, (rawDays ?? 0) - graceDays)
        if (daysPastDoc > maxDocPastDue) maxDocPastDue = daysPastDoc

        if (daysPastDoc > 90) overdue90plus += soldeDoc
        else if (daysPastDoc > 60) overdue61to90 += soldeDoc
        else if (daysPastDoc > 30) overdue31to60 += soldeDoc
        else if (daysPastDoc > 0) overdue0to30 += soldeDoc
      })

      const dueAmount = overdue0to30 + overdue31to60 + overdue61to90 + overdue90plus
      const effectiveDueBalance = dueAmount > 0 ? dueAmount : totalSolde
      const severeOverdueBalance = overdue61to90 + overdue90plus
      const daysSinceOldestDebt = diffDays(oldestCreditDate, referenceDate)
      const daysToDue = daysSinceOldestDebt == null ? 0 : Math.max(0, graceDays - daysSinceOldestDebt)

      profile.credit = {
        total_balance: roundScore(totalSolde),
        due_amount: roundScore(dueAmount),
        oldest_credit_date: oldestCreditDate,
        last_credit_date: lastCreditDate,
        days_past_due: maxDocPastDue,
        age_bucket_0_30: roundScore(overdue0to30),
        age_bucket_31_60: roundScore(overdue31to60),
        age_bucket_61_90: roundScore(overdue61to90),
        age_bucket_90_plus: roundScore(overdue90plus)
      }
      profile.sources.credit = RECOVERY_CREDIT_SOURCE
      profile.legacy.effective_due_balance = roundScore(effectiveDueBalance)
      profile.legacy.nb_docs_credit = docs.length
      profile.legacy.avg_credit_amount = docs.length > 0 ? roundScore(totalCreditHist / docs.length) : null
      profile.legacy.max_credit_amount = roundScore(maxCreditAmount)
      profile.legacy.severe_overdue_balance = roundScore(severeOverdueBalance)
      profile.legacy.overdue_weighted_ratio = totalSolde > 0
        ? clamp(((overdue0to30 * 0.25) + (overdue31to60 * 0.55) + (overdue61to90 * 0.8) + (overdue90plus * 1.0)) / totalSolde, 0, 1)
        : null
      profile.legacy.severe_overdue_ratio = totalSolde > 0
        ? clamp(severeOverdueBalance / totalSolde, 0, 1)
        : null
      profile.legacy.days_since_oldest_debt = daysSinceOldestDebt
      profile.legacy.is_due_today = daysToDue <= 0 ? 1 : 0
      profile.legacy.days_to_due = daysToDue
    }

    profile.legacy.last_sale_date = lastSalesByClientId.get(clientId) || null
    profile.legacy.days_since_last_sale = diffDays(profile.legacy.last_sale_date, referenceDate)

    if (paymentHistory.length > 0) {
      const paymentAmounts = paymentHistory.map(row => Number(row.payment_amount || 0))
      const paymentByDate = new Map()
      const paymentRefSet = new Set()
      let totalPaid30d = 0
      let nbPayments90d = 0

      paymentHistory.forEach(payment => {
        const paymentDate = String(payment.payment_date)
        paymentByDate.set(paymentDate, (paymentByDate.get(paymentDate) || 0) + Number(payment.payment_amount || 0))
        if (payment.payment_ref) {
          paymentRefSet.add(payment.payment_ref)
        }
        const daysFromReference = diffDays(payment.payment_date, referenceDate)
        if (daysFromReference !== null && daysFromReference <= 30) {
          totalPaid30d += Number(payment.payment_amount || 0)
        }
        if (daysFromReference !== null && daysFromReference <= 90) {
          nbPayments90d += 1
        }
      })

      const paymentDates = [...paymentByDate.keys()].sort()
      const paymentIntervals = []
      for (let index = 1; index < paymentDates.length; index += 1) {
        const interval = diffDays(paymentDates[index - 1], paymentDates[index])
        if (interval !== null) {
          paymentIntervals.push(interval)
        }
      }

      const averagePaymentAmount = average(paymentAmounts)
      const medianPaymentAmount = median(paymentAmounts)
      const maximumPaymentAmount = Math.max(...paymentAmounts)
      const totalPaidHistory = paymentAmounts.reduce((sum, value) => sum + value, 0)
      const averagePaymentIntervalDays = average(paymentIntervals)
      const medianPaymentIntervalDays = median(paymentIntervals)
      const expectedIntervalDays = medianPaymentIntervalDays ?? averagePaymentIntervalDays
      const lastPaymentDate = paymentDates[paymentDates.length - 1]
      const expectedNextPaymentDate = addRoundedDays(lastPaymentDate, expectedIntervalDays)
      const daysSinceExpectedPayment = diffDays(expectedNextPaymentDate, referenceDate)
      const effectiveDueBalance = Number(profile.legacy.effective_due_balance || 0)
      const paymentBehaviorScore = effectiveDueBalance > 0
        ? clamp(
            (averagePaymentAmount > 0 ? 0.35 : 0) +
            (maximumPaymentAmount >= Math.max(effectiveDueBalance * 0.35, 50) ? 0.25 : 0) +
            (totalPaid30d > 0 ? 0.20 : 0) +
            (paymentHistory.length > 0 ? 0.20 : 0),
            0,
            1
          )
        : null

      profile.payment_behavior = {
        last_payment_date: lastPaymentDate,
        average_payment_amount: roundScore(averagePaymentAmount),
        median_payment_amount: roundScore(medianPaymentAmount),
        maximum_payment_amount: roundScore(maximumPaymentAmount),
        total_paid_history: roundScore(totalPaidHistory),
        payment_count: paymentHistory.length,
        average_payment_interval_days: averagePaymentIntervalDays,
        median_payment_interval_days: medianPaymentIntervalDays,
        expected_next_payment_date: expectedNextPaymentDate,
        days_since_expected_payment: daysSinceExpectedPayment,
        payment_behavior_score: paymentBehaviorScore
      }
      profile.sources.payments = RECOVERY_PAYMENT_SOURCE
      profile.legacy.total_paid_30d = roundScore(totalPaid30d)
      profile.legacy.nb_payment_refs = paymentRefSet.size
      profile.legacy.nb_payments_90d = nbPayments90d
      profile.legacy.days_since_last_payment = diffDays(lastPaymentDate, referenceDate)
    }

    if (Number(profile.legacy.effective_due_balance || 0) > 0) {
      const avgPaymentAmount = Number(profile.payment_behavior.average_payment_amount || 0)
      const maxPaymentAmount = Number(profile.payment_behavior.maximum_payment_amount || 0)
      const totalPaid30d = Number(profile.legacy.total_paid_30d || 0)
      const nbPaymentsHist = Number(profile.payment_behavior.payment_count || 0)
      const nbDocsCredit = Number(profile.legacy.nb_docs_credit || 0)
      const paymentBehaviorScore = Number(profile.payment_behavior.payment_behavior_score || 0)
      const baseLikelyRecovery = estimateLikelyRecoveryAmount({
        encoursCredit: Number(profile.legacy.effective_due_balance || 0),
        avgPaymentAmount,
        maxPaymentAmount,
        totalPaid30d,
        nbPaymentsHist,
        nbDocsCredit
      })
      const daysToDue = Number(profile.legacy.days_to_due || 0)
      const isDueToday = Number(profile.legacy.is_due_today || 0) === 1
      const urgencyFactor = isDueToday ? 1 : (daysToDue <= 2 ? 0.85 : 0.65)
      const relationFactor = clamp(0.75 + (paymentBehaviorScore * 0.4), 0.7, 1.15)
      let expectedCollectionAmount = roundScore(clamp(
        baseLikelyRecovery * urgencyFactor * relationFactor,
        0,
        Number(profile.legacy.effective_due_balance || 0)
      ))

      if (expectedCollectionAmount <= 0) {
        expectedCollectionAmount = roundScore(clamp(
          Number(profile.legacy.effective_due_balance || 0) * (isDueToday ? 0.3 : 0.2),
          0,
          Number(profile.legacy.effective_due_balance || 0)
        ))
      }

      profile.recovery.expected_collection_amount = expectedCollectionAmount
      profile.legacy.likely_recovery_amount = baseLikelyRecovery
    }
  })

  return normalizedClientIds
    .map(clientId => profilesById.get(clientId))
    .filter(Boolean)
}

function buildRecoveryPlanRowsFromProfiles({
  profiles = [],
  clients = [],
  distanceMap = new Map(),
  maxDistanceKm = 0
}) {
  const clientsById = new Map(
    (Array.isArray(clients) ? clients : [])
      .map(normalizeClientRow)
      .filter(clientRow => clientRow.client_id)
      .map(clientRow => [clientRow.client_id, clientRow])
  )

  const enrichedProfiles = (Array.isArray(profiles) ? profiles : [])
    .map(profile => {
      const clientRow = clientsById.get(normalizeClientId(profile?.client_id)) || {}
      const distanceKey = normalizeExactClientCode(clientRow.client_code ?? profile?.client_code)
      const distanceKm = distanceKey && distanceMap instanceof Map
        ? Number(distanceMap.get(String(distanceKey)) || 0)
        : 0
      return {
        profile,
        clientRow,
        distance_km: roundScore(distanceKm)
      }
    })
    .filter(item => item.profile && item.profile.client_id)

  function isRecoverable(item, strictMode) {
    return isRecoveryProfileRecoverable(item.profile, strictMode)
  }

  function buildRow(item, selectedDueBalance, maxDueBalance, maxLikelyRecovery, maxSevereOverdue) {
    const profile = item.profile
    const clientRow = item.clientRow
    const expectedCollectionAmount = Number(profile.recovery?.expected_collection_amount || 0)
    const likelyRecoveryAmount = Number(profile.legacy?.likely_recovery_amount || 0)
    const scoreIa = computeSmartRecoveryScore({
      dueBalance: selectedDueBalance,
      maxDueBalance,
      likelyRecoveryAmount,
      maxLikelyRecovery,
      severeOverdueBalance: Number(profile.legacy?.severe_overdue_balance || 0),
      maxSevereOverdue,
      paymentBehaviorScore: Number(profile.payment_behavior?.payment_behavior_score || 0),
      distanceKm: item.distance_km,
      maxDistanceKm
    })

    profile.recovery.collection_priority_score = scoreIa

    return {
      client_id: profile.client_id,
      nbr_client: profile.client_code,
      chiffre_brut: expectedCollectionAmount,
      chiffre: `${expectedCollectionAmount.toFixed(1)} TND`,
      vente_reelle: 0,
      score_ia: scoreIa,
      qte_reco: roundScore(expectedCollectionAmount),
      details: { agro: 0, chips: 0, bur: 0 },
      produits: [],
      prob_achat: 0,
      habit_score: 0,
      recency_score: 0,
      distance_km: item.distance_km,
      date_jour: clientRow.date_jour || null,
      commercia_zone: clientRow.commercia_zone || null,
      region: clientRow.region === 'GT' ? 'Grand Tunis' : (clientRow.region || null),
      recouvrement: 1,
      nom: clientRow.nom || null,
      adresse: clientRow.adresse || 'Adresse non specifiee',
      latitude: clientRow.latitude ?? null,
      longitude: clientRow.longitude ?? null,
      canonical_client_key: profile.client_id,
      encours_credit: roundScore(selectedDueBalance),
      encours_total: profile.credit?.total_balance,
      collecte_prevue: roundScore(expectedCollectionAmount),
      likely_recovery_amount: roundScore(likelyRecoveryAmount),
      plafond_credit: roundScore(Number(profile.legacy?.plafond_credit || 0)),
      nb_docs_credit: profile.legacy?.nb_docs_credit,
      last_sale_date: profile.legacy?.last_sale_date || null,
      last_payment_date: profile.payment_behavior?.last_payment_date || null,
      oldest_credit_date: profile.credit?.oldest_credit_date || null,
      total_paid_30d: profile.legacy?.total_paid_30d,
      avg_payment_amount: profile.payment_behavior?.average_payment_amount,
      median_payment_amount: profile.payment_behavior?.median_payment_amount,
      max_payment_amount: profile.payment_behavior?.maximum_payment_amount,
      total_paid_hist: profile.payment_behavior?.total_paid_history,
      nb_payments_hist: profile.payment_behavior?.payment_count,
      nb_payment_refs: profile.legacy?.nb_payment_refs,
      nb_payments_90d: profile.legacy?.nb_payments_90d,
      average_payment_interval_days: profile.payment_behavior?.average_payment_interval_days,
      median_payment_interval_days: profile.payment_behavior?.median_payment_interval_days,
      expected_next_payment_date: profile.payment_behavior?.expected_next_payment_date || null,
      days_since_expected_payment: profile.payment_behavior?.days_since_expected_payment,
      payment_behavior_score: profile.payment_behavior?.payment_behavior_score,
      is_due_today: profile.legacy?.is_due_today,
      days_to_due: profile.legacy?.days_to_due
    }
  }

  let recoveryFilterMode = 'strict'
  let selectedProfiles = enrichedProfiles.filter(item => isRecoverable(item, true))
  let strictMode = true

  if (selectedProfiles.length === 0) {
    selectedProfiles = enrichedProfiles.filter(item => isRecoverable(item, false))
    strictMode = false
    recoveryFilterMode = 'relaxed'
  }

  const selectedDueBalances = selectedProfiles.map(item => strictMode
    ? Number(item.profile.credit?.due_amount || 0)
    : Number(item.profile.legacy?.effective_due_balance || 0)
  )
  const maxDueBalance = selectedDueBalances.reduce((max, value) => Math.max(max, value || 0), 0)
  const maxLikelyRecovery = selectedProfiles.reduce(
    (max, item) => Math.max(max, Number(item.profile.legacy?.likely_recovery_amount || 0)),
    0
  )
  const maxSevereOverdue = selectedProfiles.reduce(
    (max, item) => Math.max(max, Number(item.profile.legacy?.severe_overdue_balance || 0)),
    0
  )

  const rows = selectedProfiles
    .map(item => buildRow(
      item,
      strictMode
        ? Number(item.profile.credit?.due_amount || 0)
        : Number(item.profile.legacy?.effective_due_balance || 0),
      maxDueBalance,
      maxLikelyRecovery,
      maxSevereOverdue
    ))
    .sort((left, right) => Number(right.score_ia || 0) - Number(left.score_ia || 0))

  return {
    rows,
    recoveryFilterMode
  }
}

module.exports = {
  RECOVERY_CREDIT_DOC_TYPES,
  RECOVERY_CREDIT_SOURCE,
  RECOVERY_PAYMENT_SOURCE,
  buildRecoveryNonCancelledDocumentSqlCondition,
  buildValidRecoveryPaymentSqlCondition,
  classifyRecoveryProfilesForPeriod,
  buildRecoveryPlanRowsFromProfiles,
  computeSmartRecoveryScore,
  estimateLikelyRecoveryAmount,
  loadRecoveryProfiles
}

import { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import './CoveragePlanner.css'
import {
  DEFAULT_COVERAGE_PERIOD_DAYS,
  DEFAULT_COVERAGE_VISIT_FREQUENCY_DAYS,
  computeBlockLoadStats,
  computeTotalEstimatedDistanceKm,
  formatDecimal,
  formatDistanceKm,
  formatInteger,
  formatNullableCurrency,
  todayIsoDate
} from './coveragePlannerUtils'
import CoverageTourClientTable from './CoverageTourClientTable'
import TourRouteMap from './TourRouteMap'
import useOptimizedTourRoute from './useOptimizedTourRoute'
import {
  buildCoverageBlockValidationPayload,
  buildCoverageDetailHeaderModel,
  buildCoverageFeasibilityMetrics,
  buildCoverageSidebarCardModel,
  buildCoverageBlockValidationScopeKey,
  resolveSelectedCoverageBlock,
  shouldApplyCoverageValidationResponse,
  shouldStartCoverageValidationRequest
} from './coveragePlannerDetails'
import {
  buildGoogleMapsUrl,
  formatDistanceMeters,
  formatDurationSeconds
} from './tourRouteUtils'
import { API_URL } from './apiConfig'

const REQUEST_TIMEOUT_MS = 240000
const OPTIONS_REQUEST_TIMEOUT_MS = 20000
const VALIDATION_REQUEST_TIMEOUT_MS = 40000
const TARGET_COLLECTION_AMOUNT_MESSAGE = "L'objectif de collecte doit etre un nombre superieur ou egal a 0."
const DEFAULT_COVERAGE_VALIDATION_STATE = Object.freeze({
  phase: 'idle',
  message: null,
  error: null,
  tourneeCode: null
})

function normalizeNullableNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatCommercialDisplayName(option = {}) {
  const value = String(option.value || '').trim()
  const rawLabel = String(option.label || value || 'Commercial').trim()
  const suffix = value ? `(${value})` : ''

  if (suffix && rawLabel.endsWith(suffix)) {
    const trimmed = rawLabel.slice(0, -suffix.length).trim()
    if (trimmed) {
      return trimmed
    }
  }

  return rawLabel
}

function normalizeCommercialOption(option = {}) {
  const value = String(option.value || '').trim()
  const displayName = formatCommercialDisplayName(option)

  return {
    value,
    code: value,
    displayName,
    searchText: `${displayName} ${value}`.toLowerCase()
  }
}

function normalizeIntegerInput(value, {
  min = 0,
  max = 250,
  defaultValue = 0,
  allowEmpty = false
} = {}) {
  if (allowEmpty && String(value || '').trim() === '') {
    return ''
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return String(defaultValue)
  }

  return String(Math.max(min, Math.min(max, parsed)))
}

function normalizeDecimalInput(value, { allowEmpty = false } = {}) {
  if (allowEmpty && String(value || '').trim() === '') {
    return ''
  }

  const normalized = String(value || '').replace(',', '.').trim()
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return allowEmpty ? '' : '0'
  }

  return String(parsed)
}

function normalizeTargetCollectionAmountInput(value) {
  if (value === null || value === undefined) {
    return ''
  }

  return String(value).replace(',', '.').trim()
}

function resolveTargetCollectionAmount(value) {
  const normalizedValue = normalizeTargetCollectionAmountInput(value)

  if (normalizedValue === '') {
    return null
  }

  const parsed = Number(normalizedValue)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(TARGET_COLLECTION_AMOUNT_MESSAGE)
  }

  return parsed
}

function normalizePlannerFilters(filters) {
  return {
    start_date: String(filters.start_date || todayIsoDate()).slice(0, 10),
    period_days: normalizeIntegerInput(filters.period_days, {
      min: 1,
      max: 60,
      defaultValue: DEFAULT_COVERAGE_PERIOD_DAYS
    }),
    min_clients: normalizeIntegerInput(filters.min_clients, {
      min: 0,
      max: 250,
      defaultValue: 1
    }),
    max_clients: normalizeIntegerInput(filters.max_clients, {
      min: 0,
      max: 250,
      defaultValue: 0,
      allowEmpty: true
    }),
    target_collection_amount: normalizeTargetCollectionAmountInput(filters.target_collection_amount)
  }
}

function buildCoveragePayload(filters, selection = {}) {
  const normalized = normalizePlannerFilters(filters)
  const targetCollectionAmount = resolveTargetCollectionAmount(normalized.target_collection_amount)
  return {
    planning_mode: 'recovery_coverage',
    start_date: normalized.start_date,
    period_days: Number.parseInt(normalized.period_days, 10),
    min_clients: Number.parseInt(normalized.min_clients, 10) || 0,
    max_clients: normalized.max_clients === '' ? 0 : Number.parseInt(normalized.max_clients, 10) || 0,
    target_collection_amount: targetCollectionAmount,
    visit_frequency_days: DEFAULT_COVERAGE_VISIT_FREQUENCY_DAYS,
    commercials: Array.isArray(selection.selectedCommercials) ? selection.selectedCommercials : [],
    clients: Array.isArray(selection.selectedClientCodes) && selection.selectedClientCodes.length
      ? selection.selectedClientCodes
      : undefined
  }
}

function normalizeNonNegativeAmount(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return Math.max(0, parsed)
}

function formatDtAmount(value, fallback = '0,00 DT') {
  const normalizedValue = normalizeNonNegativeAmount(value)
  if (normalizedValue === null) {
    return fallback
  }

  return `${normalizedValue.toLocaleString('fr-TN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} DT`
}

function resolveCollectionTargetStatus(context, plannedCollectionAmount) {
  const mode = String(context?.mode || 'target_collection').trim()
  const stopReason = String(context?.stop_reason || '').trim()

  if (mode === 'full_coverage') {
    return 'Couverture complete'
  }

  if (context?.is_target_reached === true) {
    return 'Objectif atteint'
  }

  if (stopReason === 'no_candidates') {
    return 'Aucun client recouvrable'
  }

  if (stopReason === 'target_unreachable') {
    return 'Objectif non atteignable avec la capacite disponible'
  }

  if (stopReason === 'partial_target') {
    return 'Objectif partiellement atteint'
  }

  if (plannedCollectionAmount > 0) {
    return 'Objectif partiellement atteint'
  }

  return 'Objectif non atteignable avec la capacite disponible'
}

function resolveCollectionTargetStatusTone(status) {
  if (status === 'Objectif atteint' || status === 'Couverture complete') {
    return { color: '#0f766e', background: '#ecfeff', border: '#99f6e4' }
  }

  if (status === 'Objectif partiellement atteint') {
    return { color: '#b45309', background: '#fff7ed', border: '#fdba74' }
  }

  return { color: '#9a3412', background: '#fff7ed', border: '#fed7aa' }
}

function buildCollectionTargetGlobalKpis(responseData) {
  const context = responseData?.collection_target_context
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return null
  }

  const mode = String(context.mode || 'target_collection').trim()
  const plannedCollectionAmount = normalizeNonNegativeAmount(context.selected_estimated_collection_amount)
  const targetCollectionAmount = normalizeNonNegativeAmount(context.requested_target_collection_amount)
  const estimatedRemainingAmount = normalizeNonNegativeAmount(context.estimated_remaining_amount)
  const status = resolveCollectionTargetStatus(context, plannedCollectionAmount || 0)

  return [
    {
      label: 'Objectif de collecte',
      value: mode === 'full_coverage'
        ? 'Non applicable'
        : formatDtAmount(targetCollectionAmount)
    },
    {
      label: 'Collecte planifiee',
      value: mode === 'full_coverage'
        ? (plannedCollectionAmount === null ? 'Non disponible' : formatDtAmount(plannedCollectionAmount))
        : formatDtAmount(plannedCollectionAmount)
    },
    {
      label: 'Reste estime',
      value: mode === 'full_coverage'
        ? 'Non applicable'
        : formatDtAmount(estimatedRemainingAmount)
    },
    {
      label: "Statut de l'objectif",
      value: status,
      tone: resolveCollectionTargetStatusTone(status)
    }
  ]
}

function buildAdjustmentNotes(filters, requestContext = {}) {
  const notes = []
  const inputMin = Number.parseInt(filters.min_clients, 10) || 0
  const inputMax = Number.parseInt(filters.max_clients, 10) || 0
  const resolvedMin = Number(requestContext.adjusted_user_min_visits_per_slot || requestContext.user_min_visits_per_slot || 0)
  const userMax = Number(requestContext.user_max_visits_per_slot || 0)
  const adjustedMax = Number(
    requestContext.adjusted_target_max_visits_per_slot ||
    requestContext.default_max_visits_per_slot ||
    0
  )
  const recommendedMax = Number(requestContext.recommended_max_capacity || 0)

  if (inputMin !== resolvedMin) {
    notes.push(`Le minimum cible a ete ajuste automatiquement a ${resolvedMin} client(s) par tournee.`)
  }
  if (inputMax > 0 && adjustedMax > 0 && inputMax !== adjustedMax) {
    notes.push(`Le maximum cible a ete ajuste automatiquement a ${adjustedMax} client(s) par tournee.`)
  }
  if (inputMax === 0 && adjustedMax > 0) {
    notes.push(`La capacite cible a ete calculee automatiquement a ${adjustedMax} client(s) par slot.`)
  }
  if (inputMax > 0 && userMax > 0 && userMax !== inputMax) {
    notes.push(`Le maximum saisi a ete normalise a ${userMax} client(s) par tournee.`)
  }
  if (inputMax === 0 && recommendedMax > 0 && adjustedMax === 0) {
    notes.push(`La capacite cible a ete calculee automatiquement a ${recommendedMax} client(s) par slot.`)
  }

  return notes
}

function extractAnalysisView(responseData, filters) {
  const analysis = responseData?.analysis || {}
  const diagnostics = responseData?.diagnostics || {}
  const capacityPrecheck = responseData?.capacity_precheck || {}
  const operational = responseData?.operational || {}
  const requestContext = responseData?.request_context || {}
  const blockingReasons = Array.isArray(analysis.blocking_reasons) ? analysis.blocking_reasons : []
  const adjustedNotes = buildAdjustmentNotes(filters, requestContext)
  const metrics = buildCoverageFeasibilityMetrics(responseData)
  const capacityMode = metrics.capacityMode
  const operationalCapacityKnown = metrics.operationalCapacityKnown
  const proxyMessage = "Le plan couvre les clients et repartit la charge selon l'activite de vente historique. La faisabilite terrain reste a confirmer, car les visites reelles, les durees et les temps de trajet ne sont pas encore mesures."
  const feasibilityStatus = String(
    analysis.status ||
    capacityPrecheck.feasibility_status ||
    responseData?.reason ||
    responseData?.status ||
    'unknown'
  ).trim().toLowerCase()

  return {
    raw: responseData,
    status: feasibilityStatus,
    label: feasibilityStatus ? feasibilityStatus.toUpperCase() : 'UNKNOWN',
    message: !operationalCapacityKnown && capacityMode === 'sales_activity_proxy'
      ? proxyMessage
      : responseData?.message || responseData?.user_message || '',
    metrics,
    operational,
    diagnostics,
    requestContext,
    blockingReasons,
    adjustedNotes
  }
}

function normalizeDepotOrigin(rawDepot) {
  const latitude = Number(rawDepot?.latitude)
  const longitude = Number(rawDepot?.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null
  }

  return {
    ...rawDepot,
    latitude,
    longitude
  }
}

function extractPlanView(responseData) {
  const summary = responseData?.summary || {}
  const operational = responseData?.operational || {}
  const feasibilityMetrics = buildCoverageFeasibilityMetrics(responseData)
  const blocks = (Array.isArray(responseData?.blocks) ? responseData.blocks : [])
    .filter(block => Number(block?.clients_count || 0) > 0)
    .map(block => ({
      ...block,
      expected_collection_total: normalizeNullableNumber(block?.expected_collection_total),
      overdue_balance_total: normalizeNullableNumber(block?.overdue_balance_total),
      recovery_data_known_count: Number(block?.recovery_data_known_count ?? 0),
      recovery_data_unknown_count: Number(block?.recovery_data_unknown_count ?? 0),
      recovery_completeness: Boolean(block?.recovery_completeness ?? true),
      estimated_duration_minutes: normalizeNullableNumber(block?.estimated_duration_minutes),
      clients: (Array.isArray(block?.clients) ? block.clients : []).map(client => ({
        ...client,
        recovery_total_balance: normalizeNullableNumber(client?.recovery_total_balance),
        recovery_due_amount: normalizeNullableNumber(client?.recovery_due_amount),
        recovery_expected_collection_amount: normalizeNullableNumber(client?.recovery_expected_collection_amount),
        recovery_priority_score: normalizeNullableNumber(client?.recovery_priority_score),
        recovery_payment_behavior_score: normalizeNullableNumber(client?.recovery_payment_behavior_score),
        recovery_data_known: Boolean(client?.recovery_data_known ?? client?.recovery_priority_score != null)
      }))
    }))
  const loadStats = computeBlockLoadStats(blocks)
  const capacityMode = String(summary.capacity_mode || operational.capacity_mode || 'unknown')
  const operationalCapacityKnown = Boolean(summary.operational_capacity_known ?? operational.operational_capacity_known)
  const proxyMessage = "Le plan couvre les clients et repartit la charge selon l'activite de vente historique. La faisabilite terrain reste a confirmer, car les visites reelles, les durees et les temps de trajet ne sont pas encore mesures."
  const recoverySummary = responseData?.recovery_summary || {}

  return {
    raw: responseData,
    depotOrigin: normalizeDepotOrigin(responseData?.depot),
    status: String(responseData?.status || 'error'),
    message: !operationalCapacityKnown && capacityMode === 'sales_activity_proxy'
      ? proxyMessage
      : responseData?.message || responseData?.user_message || '',
    summary: {
      activeClientsCount: feasibilityMetrics.activeClientsCount,
      recoverableClientsCount: feasibilityMetrics.recoverableClientsCount,
      plannedClientsCount: feasibilityMetrics.plannedClientsCount,
      clientsToCover: Number(summary.clients_to_cover || 0),
      uniqueClientsCovered: Number(summary.unique_clients_covered || 0),
      missingClients: Number(summary.missing_clients_count || 0),
      duplicateClients: Number(summary.duplicate_clients_count || 0),
      toursCount: Number(summary.used_slots || blocks.length),
      totalDistanceKm: Number(summary.total_estimated_km || computeTotalEstimatedDistanceKm(blocks)),
      totalCapacity: Number(summary.total_capacity || 0),
      requiredAveragePerSlot: Number(summary.required_average_per_slot || 0),
      solverStatus: String(summary.solver_status || ''),
      capacityMode,
      operationalCapacityKnown,
      salesActivityProxyTotal: Number(summary.sales_activity_proxy_total || operational.sales_activity_proxy_total || 0),
      plannedToSalesProxyRatio: Number(summary.planned_to_sales_proxy_ratio || operational.planned_to_sales_proxy_ratio || 0),
      totalHistoricalCapacity: Number(summary.total_historical_capacity || operational.total_historical_capacity || 0),
      operationalCapacityGap: Number(summary.operational_capacity_gap || operational.operational_capacity_gap || 0),
      requiredCapacityMultiplier: Number(summary.required_capacity_multiplier || operational.required_capacity_multiplier || 0),
      expectedCollectionTotalKnown: normalizeNullableNumber(recoverySummary.expected_collection_total_known),
      expectedCollectionCompleteness: Boolean(recoverySummary.expected_collection_completeness ?? true),
      estimatedExtraCommercialDays: normalizeNullableNumber(
        summary.estimated_extra_commercial_days ??
        summary.estimated_extra_commercial_days_needed ??
        operational.estimated_extra_commercial_days ??
        operational.estimated_extra_commercial_days_needed
      ),
      operationalStatus: String(summary.operational_status || operational.status || 'unknown'),
      operationalStatusLabel: String(summary.operational_status_label || operational.status_label || 'Capacite terrain non mesuree')
    },
    loadStats,
    operational,
    commercialSummaries: Array.isArray(operational.commercial_summaries) ? operational.commercial_summaries : [],
    diagnostics: responseData?.diagnostics || {},
    requestContext: responseData?.request_context || {},
    collectionTargetKpis: buildCollectionTargetGlobalKpis(responseData),
    analysis: responseData?.analysis || null,
    predictionRunCode: String(responseData?.prediction_run_code || '').trim() || null,
    blocks
  }
}

function summaryTone(value, inverted = false) {
  if ((inverted ? value > 0 : value <= 0)) return { color: '#0f766e', background: '#ecfeff', border: '#99f6e4' }
  return { color: '#b45309', background: '#fff7ed', border: '#fdba74' }
}

function MetricCard({ label, value, tone = null, helper = null }) {
  return (
    <div
      style={{
        border: `1px solid ${tone?.border || '#d7e0ea'}`,
        borderRadius: 16,
        padding: 16,
        background: tone?.background || '#ffffff'
      }}
    >
      <div style={{ fontSize: 12, color: '#607284', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: tone?.color || '#16324f' }}>
        {value}
      </div>
      {helper ? (
        <div style={{ marginTop: 8, fontSize: 13, color: '#5f7389' }}>
          {helper}
        </div>
      ) : null}
    </div>
  )
}

function BlockSummary({ block, selected, onSelect }) {
  const summary = buildCoverageSidebarCardModel(block)

  return (
    <button
      type="button"
      onClick={() => onSelect(block.slot_id)}
      className={selected ? 'coverage-tour-card coverage-tour-card-selected' : 'coverage-tour-card'}
      style={{
        width: '100%',
        textAlign: 'left',
        border: selected ? '1px solid #1d4ed8' : '1px solid #d7e0ea',
        borderRadius: 16,
        padding: 16,
        background: selected ? '#eff6ff' : '#ffffff',
        cursor: 'pointer'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <strong style={{ color: '#16324f' }}>{summary.date}</strong>
        <span style={{ color: '#607284', fontSize: 13 }}>{summary.commercialLabel}</span>
      </div>
      <div style={{ fontSize: 14, color: '#16324f', marginBottom: 4 }}>
        {summary.clientsLabel}
      </div>
      <div style={{ fontSize: 13, color: '#5f7389', display: 'grid', gap: 4 }}>
        <span>{summary.collectionLabel}</span>
        <span>{summary.completenessLabel}</span>
        <span>Distance estimee : {formatDistanceKm(block.estimated_distance_km || 0)}</span>
      </div>
      {block.recovery_data_unknown_count > 0 ? (
        <div style={{ marginTop: 6, fontSize: 12, color: '#8a5b18' }}>
          Recouvrement connu : {formatInteger(Math.max(0, Number(block.clients_count || 0) - Number(block.recovery_data_unknown_count || 0)))}/{formatInteger(block.clients_count || 0)}
        </div>
      ) : null}
    </button>
  )
}

function CommercialMultiSelect({
  options,
  selectedValues,
  onChange,
  loading = false,
  disabled = false
}) {
  const containerRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const effectiveOpen = open && !disabled

  const totalOptions = options.length
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues])
  const selectedOptions = useMemo(
    () => options.filter(option => selectedSet.has(option.value)),
    [options, selectedSet]
  )
  const allSelected = totalOptions > 0 && selectedValues.length === totalOptions
  const filteredOptions = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase()
    if (!normalizedSearch) return options
    return options.filter(option => option.searchText.includes(normalizedSearch))
  }, [options, searchTerm])

  useEffect(() => {
    if (!effectiveOpen) return undefined

    const handlePointerDown = event => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [effectiveOpen])

  useEffect(() => {
    if (!disabled || !open) return undefined
    const timeoutId = window.setTimeout(() => setOpen(false), 0)
    return () => window.clearTimeout(timeoutId)
  }, [disabled, open])

  const summaryLabel = (() => {
    if (loading) return 'Chargement des commerciaux...'
    if (!totalOptions) return 'Aucun commercial disponible'
    if (allSelected) return `Tous les commerciaux (${formatInteger(totalOptions)})`
    if (!selectedOptions.length) return 'Aucun commercial'
    if (selectedOptions.length === 1) return selectedOptions[0].displayName
    return `${formatInteger(selectedOptions.length)} commerciaux selectionnes`
  })()

  const previewNames = selectedOptions.slice(0, 3)
  const hiddenCount = Math.max(0, selectedOptions.length - previewNames.length)

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(current => !current)}
        disabled={disabled}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          border: '1px solid #c8d4df',
          borderRadius: 14,
          padding: '12px 14px',
          background: disabled ? '#f8fafc' : '#ffffff',
          color: '#16324f',
          cursor: disabled ? 'not-allowed' : 'pointer',
          boxShadow: effectiveOpen ? '0 0 0 3px rgba(37, 99, 235, 0.12)' : 'none'
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
          {summaryLabel}
        </span>
        <span style={{ color: '#607284', fontSize: 12, transform: effectiveOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>
          ▼
        </span>
      </button>

      {selectedOptions.length > 0 && !allSelected ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {previewNames.map(option => (
            <span
              key={option.value}
              style={{
                padding: '6px 10px',
                borderRadius: 999,
                background: '#eff6ff',
                color: '#1d4ed8',
                fontSize: 13,
                fontWeight: 600
              }}
            >
              {option.displayName}
            </span>
          ))}
          {hiddenCount > 0 ? (
            <span
              style={{
                padding: '6px 10px',
                borderRadius: 999,
                background: '#f1f5f9',
                color: '#516579',
                fontSize: 13,
                fontWeight: 600
              }}
            >
              +{formatInteger(hiddenCount)}
            </span>
          ) : null}
        </div>
      ) : null}

      {effectiveOpen ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 10px)',
            left: 0,
            right: 0,
            zIndex: 20,
            border: '1px solid #d7e0ea',
            borderRadius: 18,
            background: '#ffffff',
            boxShadow: '0 24px 48px rgba(15, 23, 42, 0.12)',
            padding: 16,
            display: 'grid',
            gap: 12
          }}
        >
          <input
            type="search"
            value={searchTerm}
            onChange={event => setSearchTerm(event.target.value)}
            placeholder="Rechercher par nom ou code commercial"
            style={{
              border: '1px solid #c8d4df',
              borderRadius: 12,
              padding: '11px 13px',
              outline: 'none'
            }}
          />

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => onChange(options.map(option => option.value))}
              style={{
                border: '1px solid #bfdbfe',
                borderRadius: 10,
                padding: '8px 12px',
                background: '#eff6ff',
                color: '#1d4ed8',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Tout selectionner
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              style={{
                border: '1px solid #d7e0ea',
                borderRadius: 10,
                padding: '8px 12px',
                background: '#ffffff',
                color: '#516579',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Effacer
            </button>
          </div>

          <div
            style={{
              maxHeight: 280,
              overflowY: 'auto',
              display: 'grid',
              gap: 8,
              paddingRight: 4
            }}
          >
            {filteredOptions.length ? filteredOptions.map(option => {
              const checked = selectedSet.has(option.value)
              return (
                <label
                  key={option.value}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    borderRadius: 12,
                    background: checked ? '#f8fbff' : '#f8fafc',
                    border: checked ? '1px solid #bfdbfe' : '1px solid #eef2f7',
                    cursor: 'pointer'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = checked
                        ? selectedValues.filter(value => value !== option.value)
                        : [...selectedValues, option.value]
                      onChange(next)
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: '#16324f', fontWeight: 600 }}>
                      {option.displayName}
                    </div>
                    <div style={{ color: '#7b8da1', fontSize: 12 }}>
                      Code {option.code}
                    </div>
                  </div>
                </label>
              )
            }) : (
              <div
                style={{
                  borderRadius: 12,
                  padding: 14,
                  background: '#f8fafc',
                  color: '#607284',
                  fontSize: 13
                }}
              >
                Aucun commercial ne correspond a cette recherche.
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default function CoveragePlanner() {
  const [filters, setFilters] = useState({
    start_date: todayIsoDate(),
    period_days: String(DEFAULT_COVERAGE_PERIOD_DAYS),
    min_clients: '1',
    max_clients: '',
    target_collection_amount: ''
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [analysisView, setAnalysisView] = useState(null)
  const [planView, setPlanView] = useState(null)
  const [selectedBlockId, setSelectedBlockId] = useState(null)
  const [options, setOptions] = useState({ commerciaux: [], active_clients_count: 0 })
  const [optionsLoading, setOptionsLoading] = useState(true)
  const [optionsError, setOptionsError] = useState(null)
  const [selectedCommercials, setSelectedCommercials] = useState([])
  const normalizedCommercialOptions = useMemo(
    () => (Array.isArray(options.commerciaux) ? options.commerciaux : [])
      .map(normalizeCommercialOption)
      .filter(option => option.value),
    [options.commerciaux]
  )
  const allCommercialsSelected = normalizedCommercialOptions.length > 0 && selectedCommercials.length === normalizedCommercialOptions.length
  const includedActiveClientsCount = useMemo(() => {
    return selectedCommercials.length
      ? Number(options.active_clients_count || 0)
      : 0
  }, [options.active_clients_count, selectedCommercials])

  const selectedBlock = useMemo(
    () => resolveSelectedCoverageBlock(planView?.blocks, selectedBlockId),
    [planView, selectedBlockId]
  )
  const selectedBlockStops = useMemo(
    () => (Array.isArray(selectedBlock?.clients) ? selectedBlock.clients : []).map(client => ({
      id: client.client_id,
      client_id: client.client_id,
      client_code: client.client_code,
      nom: client.client_name,
      adresse: client.client_code,
      latitude: client.latitude,
      longitude: client.longitude
    })),
    [selectedBlock]
  )
  const selectedBlockRoutePlan = useOptimizedTourRoute({
    selected: Boolean(selectedBlock),
    commercialCode: selectedBlock?.commercial_code || '',
    date: selectedBlock?.date || '',
    stops: selectedBlockStops,
    origin: planView?.depotOrigin || null
  })
  const selectedBlockRouteUrl = useMemo(
    () => buildGoogleMapsUrl(selectedBlockRoutePlan.origin, selectedBlockRoutePlan.orderedStops),
    [selectedBlockRoutePlan.origin, selectedBlockRoutePlan.orderedStops]
  )
  const selectedBlockHeader = useMemo(
    () => buildCoverageDetailHeaderModel(selectedBlock, selectedBlockRoutePlan),
    [selectedBlock, selectedBlockRoutePlan]
  )
  const selectedBlockValidationKey = useMemo(
    () => buildCoverageBlockValidationScopeKey(selectedBlock || {}),
    [selectedBlock]
  )
  const [validationStateByBlockKey, setValidationStateByBlockKey] = useState({})
  const validationRequestIdsRef = useRef({})
  const validationSubmitGuardRef = useRef({})
  const mountedRef = useRef(true)
  const selectedBlockValidationState = validationStateByBlockKey[selectedBlockValidationKey] || DEFAULT_COVERAGE_VALIDATION_STATE
  const selectedBlockHasClients = Number(selectedBlock?.clients_count || selectedBlock?.clients?.length || 0) > 0
  const selectedBlockValidated = selectedBlockValidationState.phase === 'success'
  const validationButtonDisabled = selectedBlockValidationState.phase === 'validating' || selectedBlockValidated
  const validationButtonLabel = selectedBlockValidationState.phase === 'validating'
    ? 'Validation en cours...'
    : selectedBlockValidated
      ? 'Tournee validee'
      : 'Valider la tournee'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadOptions() {
      setOptionsLoading(true)
      setOptionsError(null)

      try {
        const response = await axios.get(`${API_URL}/api/tournees/options`, {
          timeout: OPTIONS_REQUEST_TIMEOUT_MS,
          params: { t: Date.now() }
        })
        if (cancelled) return

        const commerciaux = Array.isArray(response.data?.commerciaux) ? response.data.commerciaux : []
        const activeClientsCount = Math.max(0, Number(response.data?.active_clients_count || 0))

        setOptions({
          commerciaux,
          active_clients_count: activeClientsCount
        })
        setSelectedCommercials(commerciaux.map(item => item.value))
      } catch (requestError) {
        if (cancelled) return
        setOptions({ commerciaux: [], active_clients_count: 0 })
        setSelectedCommercials([])
        setOptionsError(
          `Impossible de charger les donnees de planification.${requestError?.message ? ` (${requestError.message})` : ''}`
        )
      } finally {
        if (!cancelled) {
          setOptionsLoading(false)
        }
      }
    }

    loadOptions()
    return () => {
      cancelled = true
    }
  }, [])

  const runPlanner = async () => {
    const normalizedFilters = normalizePlannerFilters(filters)

    setFilters(normalizedFilters)
    setLoading(true)
    setError(null)
    setAnalysisView(null)
    setPlanView(null)
    setSelectedBlockId(null)
    setValidationStateByBlockKey({})
    validationRequestIdsRef.current = {}
    validationSubmitGuardRef.current = {}

    try {
      const payload = buildCoveragePayload(normalizedFilters, {
        selectedCommercials
      })

      if (optionsLoading) {
        throw new Error('La liste des commerciaux est encore en chargement.')
      }
      if (!selectedCommercials.length) {
        throw new Error('Choisis au moins un commercial.')
      }

      const generationResponse = await axios.post(`${API_URL}/api/tournees/coverage-plan`, payload, {
        timeout: REQUEST_TIMEOUT_MS
      })
      const generationData = generationResponse.data

      if (generationData?.status === 'invalid_parameters') {
        setError(generationData?.message || 'Parametres invalides pour le plan de couverture.')
        return
      }

      if (generationData?.analysis) {
        setAnalysisView(extractAnalysisView(generationData, normalizedFilters))
      }

      const nextPlanView = extractPlanView(generationData)
      setPlanView(nextPlanView)
      setSelectedBlockId(nextPlanView.blocks[0]?.slot_id || null)
    } catch (requestError) {
      const timeoutMessage = requestError?.code === 'ECONNABORTED'
        ? "Le calcul a depasse le delai d'attente de l'interface. Reessaie dans quelques secondes."
        : null
      setError(
        timeoutMessage ||
        requestError?.response?.data?.message ||
        requestError?.response?.data?.error ||
        requestError?.message ||
        'Impossible de generer le plan de couverture.'
      )
    } finally {
      setLoading(false)
    }
  }

  const handleValidateSelectedBlock = async () => {
    if (!selectedBlock || !selectedBlockHasClients) {
      return
    }

    if (!shouldStartCoverageValidationRequest({
      isSubmitting: Boolean(validationSubmitGuardRef.current[selectedBlockValidationKey]),
      validationPhase: selectedBlockValidationState.phase,
      isValidated: selectedBlockValidated
    })) {
      return
    }

    const payload = buildCoverageBlockValidationPayload(
      selectedBlock,
      selectedBlockRoutePlan,
      {
        depotOrigin: planView?.depotOrigin || null,
        predictionRunCode: planView?.predictionRunCode || null
      }
    )
    const requestScopeKey = selectedBlockValidationKey
    const requestId = Number(validationRequestIdsRef.current[requestScopeKey] || 0) + 1

    validationSubmitGuardRef.current[requestScopeKey] = true
    validationRequestIdsRef.current[requestScopeKey] = requestId
    setValidationStateByBlockKey(current => ({
      ...current,
      [requestScopeKey]: {
        phase: 'validating',
        message: null,
        error: null,
        tourneeCode: null
      }
    }))

    try {
      const response = await axios.post(
        `${API_URL}/api/tournees/coverage-plan/validate`,
        payload,
        {
          timeout: VALIDATION_REQUEST_TIMEOUT_MS
        }
      )

      const shouldApply = shouldApplyCoverageValidationResponse({
        requestId,
        activeRequestId: validationRequestIdsRef.current[requestScopeKey],
        requestScopeKey,
        activeScopeKey: requestScopeKey,
        isMounted: mountedRef.current
      })
      if (!shouldApply) {
        return
      }

      validationSubmitGuardRef.current[requestScopeKey] = false
      setValidationStateByBlockKey(current => ({
        ...current,
        [requestScopeKey]: {
          phase: 'success',
          message: response.data?.message || 'Tournee validee.',
          error: null,
          tourneeCode: String(response.data?.tournee_code || '').trim() || null
        }
      }))
    } catch (requestError) {
      const shouldApply = shouldApplyCoverageValidationResponse({
        requestId,
        activeRequestId: validationRequestIdsRef.current[requestScopeKey],
        requestScopeKey,
        activeScopeKey: requestScopeKey,
        isMounted: mountedRef.current
      })
      if (!shouldApply) {
        return
      }

      validationSubmitGuardRef.current[requestScopeKey] = false
      setValidationStateByBlockKey(current => ({
        ...current,
        [requestScopeKey]: {
          ...current[requestScopeKey],
          phase: 'error',
          message: null,
          error: requestError?.response?.data?.message || requestError?.response?.data?.error || requestError?.message || 'Erreur inattendue pendant la validation de la tournee.',
          tourneeCode: null
        }
      }))
    }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section
        style={{
          background: '#ffffff',
          border: '1px solid #d7e0ea',
          borderRadius: 20,
          padding: 24
        }}
      >
        <div style={{ marginBottom: 18 }}>
          <h2 style={{ margin: 0, fontSize: 24, color: '#16324f' }}>Plan de Recouvrement</h2>
          <p style={{ margin: '8px 0 0', color: '#5f7389', lineHeight: 1.6 }}>
            La frequence de visite reste fixe a {DEFAULT_COVERAGE_VISIT_FREQUENCY_DAYS} jours. Les clients actifs sont charges automatiquement selon les commerciaux utilises, sans liste technique ni selection manuelle massive.
          </p>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 14
          }}
        >
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#516579' }}>Date de debut</span>
            <input
              type="date"
              value={filters.start_date}
              onChange={event => setFilters(current => ({ ...current, start_date: event.target.value }))}
              style={{ border: '1px solid #c8d4df', borderRadius: 12, padding: '12px 14px' }}
            />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#516579' }}>Periode (jours)</span>
            <input
              type="number"
              min="1"
              max="60"
              value={filters.period_days}
              onChange={event => setFilters(current => ({ ...current, period_days: event.target.value }))}
              style={{ border: '1px solid #c8d4df', borderRadius: 12, padding: '12px 14px' }}
            />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#516579' }}>Objectif de collecte sur la periode (DT)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={filters.target_collection_amount}
              placeholder="Optionnel"
              onChange={event => setFilters(current => ({ ...current, target_collection_amount: event.target.value }))}
              style={{ border: '1px solid #c8d4df', borderRadius: 12, padding: '12px 14px' }}
            />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#516579' }}>Minimum clients</span>
            <input
              type="number"
              min="0"
              max="250"
              value={filters.min_clients}
              onChange={event => setFilters(current => ({ ...current, min_clients: event.target.value }))}
              style={{ border: '1px solid #c8d4df', borderRadius: 12, padding: '12px 14px' }}
            />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#516579' }}>Maximum clients</span>
            <input
              type="number"
              min="0"
              max="250"
              value={filters.max_clients}
              placeholder="Auto si vide"
              onChange={event => setFilters(current => ({ ...current, max_clients: event.target.value }))}
              style={{ border: '1px solid #c8d4df', borderRadius: 12, padding: '12px 14px' }}
            />
          </label>

        </div>

        <div
          style={{
            marginTop: 16,
            display: 'grid',
            gap: 14
          }}
        >
          <div
            style={{
              border: '1px solid #d7e0ea',
              borderRadius: 16,
              padding: 16,
              background: '#f8fbff',
              display: 'grid',
              gap: 14
            }}
          >
            <label style={{ display: 'grid', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#516579' }}>Commercial</span>
              <CommercialMultiSelect
                options={normalizedCommercialOptions}
                selectedValues={selectedCommercials}
                onChange={setSelectedCommercials}
                loading={optionsLoading}
                disabled={optionsLoading || !normalizedCommercialOptions.length}
              />
            </label>

            <div
              style={{
                borderRadius: 14,
                padding: '14px 16px',
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                color: '#16324f'
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {optionsLoading
                  ? 'Chargement du portefeuille actif...'
                  : `${formatInteger(includedActiveClientsCount)} clients actifs seront inclus automatiquement dans le plan.`}
              </div>
              <div style={{ fontSize: 13, color: '#607284', lineHeight: 1.5 }}>
                {allCommercialsSelected
                  ? 'Tous les clients actifs, y compris ceux sans commercial historique, seront pris en compte automatiquement.'
                  : 'Le moteur utilisera automatiquement les clients actifs rattaches aux commerciaux selectionnes.'}
              </div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={runPlanner}
            disabled={loading}
            style={{
              border: 'none',
              borderRadius: 14,
              padding: '14px 18px',
              background: loading ? '#93c5fd' : '#2563eb',
              color: '#ffffff',
              fontWeight: 700,
              cursor: loading ? 'wait' : 'pointer'
            }}
          >
            {loading ? 'Generation en cours...' : 'Generer le plan de couverture'}
          </button>
          <span style={{ color: '#607284', fontSize: 14 }}>
            Frequence de visite appliquee automatiquement: {DEFAULT_COVERAGE_VISIT_FREQUENCY_DAYS} jours.
          </span>
        </div>

        {optionsError ? (
          <div
            style={{
              marginTop: 18,
              border: '1px solid #fed7aa',
              background: '#fff7ed',
              color: '#9a3412',
              borderRadius: 14,
              padding: 14
            }}
          >
            {optionsError}
          </div>
        ) : null}

        {error ? (
          <div
            style={{
              marginTop: 18,
              border: '1px solid #fecaca',
              background: '#fef2f2',
              color: '#b91c1c',
              borderRadius: 14,
              padding: 14
            }}
          >
            {error}
          </div>
        ) : null}
      </section>

      {analysisView ? (
        <section
          style={{
            background: '#ffffff',
            border: '1px solid #d7e0ea',
            borderRadius: 20,
            padding: 24
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'start', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 20, color: '#16324f' }}>Analyse de faisabilite</h3>
              <p style={{ margin: '8px 0 0', color: '#5f7389' }}>{analysisView.message}</p>
            </div>
          <div
            style={{
                padding: '8px 12px',
                borderRadius: 999,
                background: !analysisView.metrics.operationalCapacityKnown ? '#eff6ff' : analysisView.status === 'feasible' ? '#ecfeff' : '#fff7ed',
                color: !analysisView.metrics.operationalCapacityKnown ? '#1d4ed8' : analysisView.status === 'feasible' ? '#0f766e' : '#b45309',
                fontWeight: 700
              }}
            >
              {analysisView.metrics.operationalCapacityKnown ? analysisView.label : analysisView.metrics.operationalStatusLabel}
            </div>
          </div>

          <div
            style={{
              marginTop: 18,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12
            }}
          >
            <MetricCard label="Clients actifs a couvrir" value={formatInteger(analysisView.metrics.clientsToCover)} />
            <MetricCard label="Commerciaux actifs" value={formatInteger(analysisView.metrics.selectedCommercialsCount)} />
            <MetricCard label="Jours actifs" value={formatInteger(analysisView.metrics.activeDaysCount)} />
            <MetricCard label="Slots disponibles" value={formatInteger(analysisView.metrics.totalSlots)} helper={`${formatInteger(analysisView.metrics.theoreticalTotalSlots)} theorique(s)`} />
            <MetricCard
              label="Maximum saisi"
              value={formatInteger(analysisView.metrics.userMaxCapacity)}
              helper={analysisView.metrics.userMaxCapacity > 0 ? null : 'auto'}
            />
            <MetricCard
              label="Maximum global ajuste"
              value={formatInteger(analysisView.metrics.adjustedTargetMaxCapacity)}
              helper="cibles heterogenes selon l'historique"
            />
            <MetricCard label="Capacite ajustee" value={formatInteger(analysisView.metrics.capacityTotal)} />
            <MetricCard label="Activite de vente historique - proxy" value={formatInteger(analysisView.metrics.salesActivityProxyTotal)} />
            <MetricCard label="Capacite necessaire" value={formatInteger(analysisView.metrics.totalRequiredClients)} />
            <MetricCard label="Charge requise / proxy" value={formatDecimal(analysisView.metrics.requiredToSalesProxyRatio || 0, 2)} />
            <MetricCard label="Moyenne necessaire / slot" value={formatDecimal(analysisView.metrics.requiredAveragePerSlot, 2)} />
            <MetricCard label="Slots retires" value={formatInteger(analysisView.metrics.unavailableSlotsRemoved)} />
          </div>

          {!analysisView.metrics.operationalCapacityKnown ? (
            <div
              style={{
                marginTop: 16,
                border: '1px solid #bfdbfe',
                background: '#eff6ff',
                color: '#1d4ed8',
                borderRadius: 14,
                padding: 14
              }}
            >
              Le plan couvre les clients et repartit la charge selon l&apos;activite de vente historique. La faisabilite terrain reste a confirmer, car les visites reelles, les durees et les temps de trajet ne sont pas encore mesures.
            </div>
          ) : analysisView.metrics.estimatedExtraCommercialDays == null ? (
            <div
              style={{
                marginTop: 16,
                border: '1px solid #d7e0ea',
                background: '#f8fafc',
                color: '#4b5d70',
                borderRadius: 14,
                padding: 14
              }}
            >
              Les jours supplementaires ne peuvent pas etre estimes avant la collecte de visites terrain validees.
            </div>
          ) : null}

          {analysisView.adjustedNotes.length ? (
            <div
              style={{
                marginTop: 16,
                border: '1px solid #bfdbfe',
                background: '#eff6ff',
                color: '#1d4ed8',
                borderRadius: 14,
                padding: 14
              }}
            >
              {analysisView.adjustedNotes.map((note, index) => (
                <div key={`${note}-${index}`}>{note}</div>
              ))}
            </div>
          ) : null}

          {analysisView.blockingReasons.length ? (
            <div style={{ marginTop: 16, display: 'grid', gap: 10 }}>
              {analysisView.blockingReasons.map(reason => (
                <div
                  key={reason.code}
                  style={{
                    border: '1px solid #fed7aa',
                    background: '#fff7ed',
                    color: '#9a3412',
                    borderRadius: 14,
                    padding: 14
                  }}
                >
                  <strong>{reason.title}</strong>
                  <div style={{ marginTop: 6 }}>{reason.detail}</div>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {planView ? (
        <section
          style={{
            background: '#ffffff',
            border: '1px solid #d7e0ea',
            borderRadius: 20,
            padding: 24,
            display: 'grid',
            gap: 18
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 20, color: '#16324f' }}>Resultat de generation</h3>
            <p style={{ margin: '8px 0 0', color: '#5f7389' }}>{planView.message}</p>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12
            }}
          >
            <MetricCard label="Clients uniques a couvrir" value={formatInteger(planView.summary.clientsToCover)} />
            <MetricCard label="Clients uniques couverts" value={formatInteger(planView.summary.uniqueClientsCovered)} />
            <MetricCard
              label="Clients manquants"
              value={formatInteger(planView.summary.missingClients)}
              tone={summaryTone(planView.summary.missingClients)}
            />
            <MetricCard
              label="Doublons"
              value={formatInteger(planView.summary.duplicateClients)}
              tone={summaryTone(planView.summary.duplicateClients)}
            />
            <MetricCard label="Nombre de tournees" value={formatInteger(planView.summary.toursCount)} />
            <MetricCard label="Charge minimale" value={formatInteger(planView.loadStats.min)} />
            <MetricCard label="Charge moyenne" value={formatDecimal(planView.loadStats.avg, 1)} />
            <MetricCard label="Charge maximale" value={formatInteger(planView.loadStats.max)} />
            <MetricCard label="Activite de vente historique - proxy" value={formatInteger(planView.summary.salesActivityProxyTotal)} />
            <MetricCard label="Charge planifiee / proxy" value={formatDecimal(planView.summary.plannedToSalesProxyRatio || 0, 2)} />
            {Array.isArray(planView.collectionTargetKpis) ? planView.collectionTargetKpis.map(metric => (
              <MetricCard
                key={metric.label}
                label={metric.label}
                value={metric.value}
                tone={metric.tone || null}
              />
            )) : null}
            <MetricCard label="Distance estimee" value={formatDistanceKm(planView.summary.totalDistanceKm)} />
            <MetricCard label="Solveur" value={planView.summary.solverStatus || '-'} />
          </div>

          {!planView.summary.operationalCapacityKnown ? (
            <div
              style={{
                border: '1px solid #bfdbfe',
                background: '#eff6ff',
                color: '#1d4ed8',
                borderRadius: 14,
                padding: 14
              }}
            >
              Le plan couvre les clients et repartit la charge selon l&apos;activite de vente historique. La faisabilite terrain reste a confirmer, car les visites reelles, les durees et les temps de trajet ne sont pas encore mesures.
            </div>
          ) : planView.summary.estimatedExtraCommercialDays == null ? (
            <div
              style={{
                border: '1px solid #d7e0ea',
                background: '#f8fafc',
                color: '#4b5d70',
                borderRadius: 14,
                padding: 14
              }}
            >
              Les jours supplementaires ne peuvent pas etre estimes avant la collecte de visites terrain validees.
            </div>
          ) : null}

          <div className="coverage-result-layout">
            <div className="coverage-tour-sidebar">
              {planView.blocks.length ? (
                planView.blocks.map(block => (
                  <BlockSummary
                    key={block.slot_id}
                    block={block}
                    selected={selectedBlock?.slot_id === block.slot_id}
                    onSelect={setSelectedBlockId}
                  />
                ))
              ) : (
                <div
                  className="coverage-empty-state"
                >
                  Aucune tournee exploitable n&apos;a ete retournee.
                </div>
              )}
            </div>

            <div className="coverage-tour-detail">
              {selectedBlock ? (
                <>
                  <div className="coverage-tour-header">
                    <div className="coverage-tour-header-title">
                      <h4 style={{ margin: 0, color: '#16324f' }}>{selectedBlockHeader.date}</h4>
                      <div style={{ color: '#5f7389' }}>
                        {selectedBlockHeader.commercialLabel}
                      </div>
                      {selectedBlockHeader.zoneLabel ? (
                        <div style={{ color: '#607284', fontSize: 13 }}>
                          Zone principale : {selectedBlockHeader.zoneLabel}
                        </div>
                      ) : null}
                      {selectedBlock.recovery_data_unknown_count > 0 ? (
                        <div style={{ color: '#8a5b18', fontSize: 12 }}>
                          {formatInteger(selectedBlock.recovery_data_unknown_count)} client(s) avec donnees recouvrement incompletes
                        </div>
                      ) : null}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <span className="coverage-inline-badge">{selectedBlockHeader.clientsLabel}</span>
                      {selectedBlock.recovery_completeness === false ? (
                        <span className="coverage-inline-badge coverage-inline-badge-warn">Collecte partielle</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="coverage-detail-metrics">
                    <div className="coverage-detail-metric">
                      <div className="coverage-detail-metric-label">Collecte prevue</div>
                      <div className="coverage-detail-metric-value">{selectedBlockHeader.expectedCollectionLabel}</div>
                    </div>
                    <div className="coverage-detail-metric">
                      <div className="coverage-detail-metric-label">Encours echu</div>
                      <div className="coverage-detail-metric-value">{selectedBlockHeader.overdueBalanceLabel}</div>
                    </div>
                    <div className="coverage-detail-metric">
                      <div className="coverage-detail-metric-label">Distance totale</div>
                      <div className="coverage-detail-metric-value">{selectedBlockHeader.distanceLabel}</div>
                    </div>
                    <div className="coverage-detail-metric">
                      <div className="coverage-detail-metric-label">Duree estimee</div>
                      <div className="coverage-detail-metric-value">{selectedBlockHeader.totalDurationLabel}</div>
                    </div>
                    <div className="coverage-detail-metric">
                      <div className="coverage-detail-metric-label">Clients cartographies</div>
                      <div className="coverage-detail-metric-value">
                        {formatInteger(selectedBlockHeader.gpsStats.mapped)}/{formatInteger(selectedBlockHeader.gpsStats.total)}
                      </div>
                    </div>
                    <div className="coverage-detail-metric">
                      <div className="coverage-detail-metric-label">Sans GPS</div>
                      <div className="coverage-detail-metric-value">{formatInteger(selectedBlockHeader.gpsStats.unavailable)}</div>
                    </div>
                  </div>

                  {selectedBlockHasClients ? (
                    <div
                      style={{
                        display: 'grid',
                        gap: 12,
                        border: '1px solid #d7e0ea',
                        borderRadius: 16,
                        padding: 16,
                        background: '#f8fafc'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                        <div>
                          <div style={{ fontSize: 15, fontWeight: 700, color: '#16324f' }}>Validation de la tournee</div>
                          <div style={{ marginTop: 4, fontSize: 13, color: '#5f7389' }}>
                            Enregistre ce bloc dans la base sans quitter la navigation courante.
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={handleValidateSelectedBlock}
                          disabled={validationButtonDisabled}
                          style={{
                            border: 'none',
                            borderRadius: 12,
                            padding: '12px 16px',
                            background: validationButtonDisabled ? '#94a3b8' : '#0d6efd',
                            color: '#ffffff',
                            fontWeight: 700,
                            cursor: validationButtonDisabled ? 'not-allowed' : 'pointer'
                          }}
                        >
                          {validationButtonLabel}
                        </button>
                      </div>

                      {selectedBlockValidationState.tourneeCode ? (
                        <div style={{ fontSize: 13, color: '#516579' }}>
                          Code tournee : {selectedBlockValidationState.tourneeCode}
                        </div>
                      ) : null}

                      {selectedBlockValidationState.message ? (
                        <div
                          style={{
                            border: '1px solid #a7f3d0',
                            background: '#ecfdf5',
                            color: '#047857',
                            borderRadius: 12,
                            padding: 12
                          }}
                        >
                          {selectedBlockValidationState.message}
                        </div>
                      ) : null}

                      {selectedBlockValidationState.error ? (
                        <div
                          style={{
                            border: '1px solid #fecaca',
                            background: '#fef2f2',
                            color: '#b91c1c',
                            borderRadius: 12,
                            padding: 12
                          }}
                        >
                          {selectedBlockValidationState.error}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="coverage-detail-grid">
                    <CoverageTourClientTable block={selectedBlock} />

                    <div className="coverage-route-panel">
                      <div className="coverage-route-summary">
                        <span className="coverage-route-pill">
                          {selectedBlockRoutePlan.summary
                            ? `${formatDistanceMeters(selectedBlockRoutePlan.summary.distance)} - ${formatDurationSeconds(selectedBlockRoutePlan.summary.duration)}`
                            : 'Trace simplifiee'}
                        </span>
                        <span className="coverage-route-pill coverage-route-pill-muted">
                          {selectedBlockRoutePlan.origin
                            ? `Depot : ${selectedBlockRoutePlan.origin.nom || 'Depot'}`
                            : 'Depot non disponible'}
                        </span>
                        <span className="coverage-route-pill coverage-route-pill-muted">
                          Service : {selectedBlockHeader.serviceDurationLabel}
                        </span>
                      </div>

                      <TourRouteMap routePlan={selectedBlockRoutePlan} height={320} />

                      {selectedBlockRoutePlan.error ? (
                        <div className="coverage-route-note">{selectedBlockRoutePlan.error}</div>
                      ) : null}
                      {selectedBlockHeader.gpsStats.mapped < 2 ? (
                        <div className="coverage-route-note">
                          GPS insuffisant pour calculer un trajet OSRM. La liste ordonnee des clients reste disponible.
                        </div>
                      ) : null}

                      <div className="coverage-route-columns">
                        <div className="coverage-scroll-box">
                          {selectedBlockRoutePlan.orderedStops.length ? (
                            <ol style={{ paddingLeft: 18, fontSize: 14, color: '#555', margin: 0 }}>
                              {selectedBlockRoutePlan.orderedStops.map(stop => (
                                <li key={`${stop.client_id || stop.id}-${stop.step}`} style={{ marginBottom: 10 }}>
                                  <strong>{stop.step}. {stop.nom}</strong><br />
                                  <span style={{ color: '#6c757d', fontSize: 13 }}>{stop.adresse}</span>
                                </li>
                              ))}
                            </ol>
                          ) : (
                            <div style={{ color: '#6c757d', fontSize: 13 }}>
                              Aucun ordre de visite detaille n&apos;est disponible.
                            </div>
                          )}
                        </div>
                        <div className="coverage-guidance-card">
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2b4c', marginBottom: 8 }}>Guidage detaille</div>
                          <div className="coverage-scroll-box" style={{ maxHeight: 180, paddingRight: 6 }}>
                            {selectedBlockRoutePlan.steps.length ? selectedBlockRoutePlan.steps.map(step => (
                              <div key={step.id} style={{ marginBottom: 8, fontSize: 13, color: '#495057', lineHeight: 1.4 }}>
                                <strong>{step.text}</strong>
                                <div style={{ color: '#6c757d', fontSize: 12 }}>
                                  {formatDistanceMeters(step.distance)} - {formatDurationSeconds(step.duration)}
                                </div>
                              </div>
                            )) : (
                              <div style={{ color: '#6c757d', fontSize: 13 }}>
                                Le detail tournant par tournant n&apos;est pas disponible pour cette tournee.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <a
                          href={selectedBlockRouteUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            flex: 1,
                            textAlign: 'center',
                            padding: '12px',
                            backgroundColor: '#198754',
                            color: 'white',
                            textDecoration: 'none',
                            borderRadius: '10px',
                            fontWeight: 'bold'
                          }}
                        >
                          Ouvrir la navigation
                        </a>
                        <div style={{ flex: 1, padding: '12px', borderRadius: '10px', background: '#f8fafc', color: '#4b5d70', fontWeight: 600 }}>
                          Conduite : {selectedBlockHeader.driveDurationLabel} | Total estime : {selectedBlockHeader.totalDurationLabel}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="coverage-empty-state">
                  Lance l&apos;analyse pour afficher le detail des tournees.
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}

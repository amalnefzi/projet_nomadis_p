import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { API_URL } from './apiConfig'
import TourRouteMap from './TourRouteMap.jsx'
import {
  formatDistanceMeters,
  formatDurationSeconds,
  buildGoogleMapsUrl
} from './tourRouteUtils.js'
import SalesTourClientTable from './SalesTourClientTable.jsx'
import SalesLoadingPrediction from './SalesLoadingPrediction.jsx'
import SalesBasketPrediction from './SalesBasketPrediction.jsx'
import SalesVisitFeedbackPanel from './SalesVisitFeedbackPanel.jsx'
import {
  buildSalesPredictionConsistency
} from './salesCoverageDetails.js'
import {
  buildSalesBlockValidationPayload,
  buildSalesBlockValidationScopeKey,
  shouldStartSalesValidationRequest,
  shouldApplySalesValidationResponse
} from './salesTourValidation.js'

const VALIDATION_REQUEST_TIMEOUT_MS = 40000

function renderCaStatus(status) {
  switch (status) {
    case 'reached':
      return 'Atteint'
    case 'not_reached':
      return 'Non atteint'
    case 'partial':
      return 'Partiel'
    default:
      return 'Inconnu'
  }
}

export default function SalesTourDetails({
  block = null,
  header = null,
  clientRows = [],
  loadingPredictionItems = [],
  routePlan = null
}) {
  const resolvedBlock = block && typeof block === 'object' ? block : {}
  const resolvedHeader = header && typeof header === 'object' ? header : {}
  const routeUrl = buildGoogleMapsUrl(routePlan?.origin, routePlan?.orderedStops)
  const predictionConsistency = buildSalesPredictionConsistency(resolvedBlock, clientRows)
  const validationScopeKey = useMemo(
    () => buildSalesBlockValidationScopeKey(resolvedBlock),
    [resolvedBlock]
  )
  const [validationRequestState, setValidationRequestState] = useState({
    phase: 'idle',
    message: null,
    error: null,
    tourneeCode: null,
    reloadNonce: 0
  })
  const [restoredValidationState, setRestoredValidationState] = useState({
    validated: false,
    tourneeCode: null,
    message: null
  })
  const activeRequestIdRef = useRef(0)
  const activeScopeKeyRef = useRef(validationScopeKey)
  const submitGuardRef = useRef(false)
  const mountedRef = useRef(true)
  const clientsCount = Array.isArray(resolvedBlock?.clients)
    ? resolvedBlock.clients.length
    : Number(resolvedBlock?.clients_count || clientRows.length || 0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    activeScopeKeyRef.current = validationScopeKey
    activeRequestIdRef.current += 1
    submitGuardRef.current = false
    setValidationRequestState({
      phase: 'idle',
      message: null,
      error: null,
      tourneeCode: null,
      reloadNonce: 0
    })
    setRestoredValidationState({
      validated: false,
      tourneeCode: null,
      message: null
    })
  }, [validationScopeKey])

  const effectiveValidated = validationRequestState.phase === 'success' || restoredValidationState.validated
  const effectiveTourneeCode = validationRequestState.tourneeCode || restoredValidationState.tourneeCode || null
  const validationSummaryMessage = validationRequestState.phase === 'success'
    ? validationRequestState.message
    : (restoredValidationState.message || null)
  const validationBlockedByRouteLoading = Boolean(routePlan?.loading)
  const validationButtonDisabled = validationRequestState.phase === 'validating' || effectiveValidated || validationBlockedByRouteLoading
  const validationButtonLabel = validationRequestState.phase === 'validating'
    ? 'Validation en cours...'
    : effectiveValidated
      ? 'Tournee validee'
      : validationBlockedByRouteLoading
        ? 'Calcul de l itineraire en cours...'
        : 'Valider et enregistrer cette tournee'

  const handleRestoredValidationStateChange = useCallback((nextState = {}) => {
    setRestoredValidationState({
      validated: Boolean(nextState?.validated),
      tourneeCode: nextState?.tourneeCode || null,
      message: nextState?.message || null
    })
  }, [])

  const handleValidateTour = useCallback(async () => {
    if (!shouldStartSalesValidationRequest({
      isSubmitting: submitGuardRef.current,
      validationPhase: validationRequestState.phase,
      isValidated: effectiveValidated,
      isRouteLoading: routePlan?.loading
    })) {
      return
    }

    const payload = buildSalesBlockValidationPayload(resolvedBlock, routePlan)
    const confirmationMessage = [
      'Confirmer la validation de cette tournee ?',
      `Date : ${resolvedHeader?.date || resolvedBlock?.date || '-'}`,
      `Commercial : ${resolvedHeader?.commercialLabel || resolvedBlock?.commercial_label || resolvedBlock?.commercial_code || '-'}`,
      `Nombre de clients : ${clientsCount}`
    ].join('\n')

    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(confirmationMessage)) {
      return
    }

    submitGuardRef.current = true
    const requestId = activeRequestIdRef.current + 1
    activeRequestIdRef.current = requestId
    const requestScopeKey = validationScopeKey

    setValidationRequestState(current => ({
      ...current,
      phase: 'validating',
      message: null,
      error: null,
      tourneeCode: null
    }))

    try {
      const response = await axios.post(
        `${API_URL}/api/tournees/next-best-visits/validate`,
        payload,
        {
          timeout: VALIDATION_REQUEST_TIMEOUT_MS
        }
      )

      const shouldApply = shouldApplySalesValidationResponse({
        requestId,
        activeRequestId: activeRequestIdRef.current,
        requestScopeKey,
        activeScopeKey: activeScopeKeyRef.current,
        isMounted: mountedRef.current
      })
      if (!shouldApply) {
        return
      }

      submitGuardRef.current = false
      setValidationRequestState(current => ({
        phase: 'success',
        message: response.data?.message || 'Tournee validee.',
        error: null,
        tourneeCode: String(response.data?.tournee_code || '').trim() || null,
        reloadNonce: current.reloadNonce + 1
      }))
    } catch (requestError) {
      const shouldApply = shouldApplySalesValidationResponse({
        requestId,
        activeRequestId: activeRequestIdRef.current,
        requestScopeKey,
        activeScopeKey: activeScopeKeyRef.current,
        isMounted: mountedRef.current
      })
      if (!shouldApply) {
        return
      }

      submitGuardRef.current = false
      setValidationRequestState(current => ({
        ...current,
        phase: 'error',
        message: null,
        error: requestError?.response?.data?.message || requestError?.message || 'Erreur inattendue pendant la validation du bloc Sales V2.',
        tourneeCode: null
      }))
    }
  }, [
    resolvedBlock,
    clientsCount,
    effectiveValidated,
    resolvedHeader,
    routePlan,
    validationRequestState.phase,
    validationScopeKey
  ])

  if (!block || !header) {
    return (
      <div className="sales-empty-state">
        Aucune tournee selectionnee pour le moment.
      </div>
    )
  }

  return (
    <div className="sales-tour-detail">
      <div className="sales-tour-summary">
        <div>
          <h3>{header.date}</h3>
          <p>{header.commercialLabel}</p>
        </div>

        <div className="sales-summary-badges">
          <span className="sales-inline-badge">{header.clientsLabel}</span>
          <span className="sales-inline-badge">Valeur attendue de visite : {header.predictedOrderLabel}</span>
          <span className="sales-inline-badge">Objectif CA : {header.minDailyCaLabel}</span>
          <span className="sales-inline-badge">Statut CA : {renderCaStatus(header.minDailyCaStatus)}</span>
          <span className="sales-inline-badge">{header.predictionCoverageLabel}</span>
          <span className="sales-inline-badge">GPS : {header.gpsStats.mapped}/{header.gpsStats.total}</span>
          <span className="sales-inline-badge">Sans GPS : {header.gpsStats.unavailable}</span>
          <span className="sales-inline-badge">Distance : {header.distanceLabel}</span>
          <span className="sales-inline-badge">Conduite : {header.driveDurationLabel}</span>
        </div>
      </div>

      {import.meta.env.DEV && !predictionConsistency.consistent ? (
        <div className="sales-route-note">
          Diagnostic predictions: {predictionConsistency.knownRows} connues / {predictionConsistency.unknownRows} inconnues sur {predictionConsistency.totalRows} ligne(s), bloc attendu {predictionConsistency.expectedKnown} / {predictionConsistency.expectedUnknown} sur {predictionConsistency.expectedTotal}.
        </div>
      ) : null}

      <div className="sales-detail-grid">
        <SalesTourClientTable rows={clientRows} />

        <div className="sales-side-panels">
          <SalesBasketPrediction rows={clientRows} />
          <div className="sales-route-panel sales-validation-panel">
            <div className="sales-panel-title">Validation de la tournee</div>

            <div className="sales-validation-summary">
              <div className="sales-validation-summary-item">
                <span>Date</span>
                <strong>{header.date}</strong>
              </div>
              <div className="sales-validation-summary-item">
                <span>Commercial</span>
                <strong>{header.commercialLabel}</strong>
              </div>
              <div className="sales-validation-summary-item">
                <span>Nombre de clients</span>
                <strong>{clientsCount}</strong>
              </div>
            </div>

            {validationSummaryMessage ? (
              <div className="sales-route-note">
                {validationSummaryMessage}
                {effectiveTourneeCode ? ` Tournee code : ${effectiveTourneeCode}` : ''}
              </div>
            ) : null}
            {validationRequestState.error ? (
              <div className="sales-route-note sales-validation-error">{validationRequestState.error}</div>
            ) : null}

            <div className="sales-feedback-actions">
              <button
                type="button"
                className="sales-coverage-submit"
                onClick={handleValidateTour}
                disabled={validationButtonDisabled}
              >
                {validationButtonLabel}
                </button>
              </div>
          </div>
          <SalesVisitFeedbackPanel
            rows={clientRows}
            validationState={{
              validated: effectiveValidated,
              validating: validationRequestState.phase === 'validating',
              tourneeCode: effectiveTourneeCode,
              reloadNonce: validationRequestState.reloadNonce
            }}
            onValidationStateChange={handleRestoredValidationStateChange}
          />
          <SalesLoadingPrediction loadingPrediction={loadingPredictionItems} />

          <div className="sales-route-panel">
            <div className="sales-panel-title">Itineraire Optimise</div>
            <div className="sales-route-summary">
              <span className="sales-route-pill">
                {routePlan?.summary
                  ? `${formatDistanceMeters(routePlan.summary.distance)} - ${formatDurationSeconds(routePlan.summary.duration)}`
                  : 'Trace simplifiee'}
              </span>
              <span className="sales-route-pill sales-route-pill-muted">
                {routePlan?.origin
                  ? `Depart : ${routePlan.origin.nom || 'Depot'}`
                  : 'Depart non disponible'}
              </span>
              <span className="sales-route-pill sales-route-pill-muted">
                Service : {header.serviceDurationLabel}
              </span>
              <span className="sales-route-pill sales-route-pill-muted">
                Total estime : {header.totalDurationLabel}
              </span>
            </div>

            <TourRouteMap routePlan={routePlan} height={320} />

            {routePlan?.loading ? (
              <div className="sales-route-note">Calcul de l'itineraire OSRM en cours...</div>
            ) : null}
            {routePlan?.error ? (
              <div className="sales-route-note">{routePlan.error}</div>
            ) : null}
            {header.gpsStats.mapped < 2 ? (
              <div className="sales-route-note">GPS insuffisant pour calculer l'itineraire.</div>
            ) : null}

            <div className="sales-route-columns">
              <div className="sales-scroll-box">
                {routePlan?.orderedStops?.length ? (
                  <ol>
                    {routePlan.orderedStops.map(stop => (
                      <li key={`${stop.client_id || stop.id}-${stop.step}`}>
                        <strong>{stop.step}. {stop.nom}</strong>
                        <span>{stop.adresse}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="sales-route-empty">Aucun ordre de visite detaille n'est disponible.</div>
                )}
              </div>

              <div className="sales-guidance-card">
                <div className="sales-guidance-title">Guidage detaille</div>
                <div className="sales-scroll-box sales-scroll-box-compact">
                  {routePlan?.steps?.length ? routePlan.steps.map(step => (
                    <div key={step.id} className="sales-guidance-step">
                      <strong>{step.text}</strong>
                      <span>{formatDistanceMeters(step.distance)} - {formatDurationSeconds(step.duration)}</span>
                    </div>
                  )) : (
                    <div className="sales-route-empty">Le detail tournant par tournant n'est pas disponible.</div>
                  )}
                </div>
              </div>
            </div>

            <div className="sales-route-actions">
              <a
                href={routeUrl}
                target="_blank"
                rel="noreferrer"
                className="sales-route-link"
              >
                Ouvrir la navigation
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

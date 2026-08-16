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
  if (!block || !header) {
    return (
      <div className="sales-empty-state">
        Aucune tournee selectionnee pour le moment.
      </div>
    )
  }

  const routeUrl = buildGoogleMapsUrl(routePlan?.origin, routePlan?.orderedStops)
  const predictionConsistency = buildSalesPredictionConsistency(block, clientRows)

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
          <SalesVisitFeedbackPanel rows={clientRows} />
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

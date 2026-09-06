import { useCallback, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { API_URL } from './apiConfig'
import TourRouteMap from './TourRouteMap.jsx'
import useOptimizedTourRoute from './useOptimizedTourRoute'
import SalesVisitFeedbackPanel from './SalesVisitFeedbackPanel.jsx'
import { formatDistanceMeters, formatDurationSeconds, buildGoogleMapsUrl } from './tourRouteUtils.js'
import {
  buildValidatedToursSearchParams,
  buildValidatedTourHeaderModel,
  buildValidatedTourRouteStops,
  buildValidatedTourRows,
  normalizeValidatedTourSummaries
} from './salesValidatedTours.js'

const REQUEST_TIMEOUT_MS = 20000

const PURCHASE_OUTCOME_LABELS = {
  pending: 'En attente',
  not_visited: 'Non visite',
  predicted_and_realized: 'Achat predit et realise',
  predicted_not_realized: 'Achat predit, non realise',
  not_predicted_but_realized: 'Achat non predit, mais realise',
  not_predicted_and_not_realized: 'Achat non predit, non realise',
  unknown: 'Non comparable'
}

function formatOptionalNumber(value) {
  return value == null ? 'Non disponible' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export default function SalesValidatedToursPanel({ commerciaux = [] }) {
  const [filters, setFilters] = useState({ date: '', commercialCode: '', tourneeCode: '' })
  const [searchState, setSearchState] = useState({ loading: false, error: null, hasSearched: false })
  const [tours, setTours] = useState([])
  const [selectedTourneeCode, setSelectedTourneeCode] = useState(null)
  const [detailState, setDetailState] = useState({ loading: false, error: null, tour: null })
  const [completionState, setCompletionState] = useState({ loading: false, error: null, message: null })
  const [comparisonState, setComparisonState] = useState({ loading: false, error: null, data: null })

  const handleFilterChange = useCallback((field, value) => {
    setFilters(current => ({ ...current, [field]: value }))
  }, [])

  const runSearch = useCallback(async () => {
    setSearchState({ loading: true, error: null, hasSearched: true })
    setSelectedTourneeCode(null)
    setDetailState({ loading: false, error: null, tour: null })
    setCompletionState({ loading: false, error: null, message: null })
    setComparisonState({ loading: false, error: null, data: null })

    try {
      const response = await axios.get(`${API_URL}/api/tournees/next-best-visits/validated-tours`, {
        timeout: REQUEST_TIMEOUT_MS,
        params: buildValidatedToursSearchParams(filters)
      })

      setTours(normalizeValidatedTourSummaries(response.data?.tours, commerciaux))
      setSearchState({ loading: false, error: null, hasSearched: true })
    } catch (error) {
      setTours([])
      setSearchState({
        loading: false,
        hasSearched: true,
        error: error?.response?.data?.message || error?.message || 'Impossible de charger les tournees validees.'
      })
    }
  }, [commerciaux, filters])

  useEffect(() => {
    runSearch()
    // Chargement initial de la liste des tournees validees, puis uniquement sur clic "Rechercher".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openTour = useCallback(async (tourneeCode) => {
    setSelectedTourneeCode(tourneeCode)
    setDetailState({ loading: true, error: null, tour: null })
    setCompletionState({ loading: false, error: null, message: null })
    setComparisonState({ loading: false, error: null, data: null })

    try {
      const response = await axios.get(
        `${API_URL}/api/tournees/next-best-visits/validated-tours/${encodeURIComponent(tourneeCode)}`,
        { timeout: REQUEST_TIMEOUT_MS }
      )
      setDetailState({ loading: false, error: null, tour: response.data?.tour || null })
    } catch (error) {
      setDetailState({
        loading: false,
        tour: null,
        error: error?.response?.data?.message || error?.message || 'Impossible de charger le detail de cette tournee.'
      })
    }
  }, [])

  const completeTour = useCallback(async () => {
    if (!selectedTourneeCode) return
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm('Terminer cette tournee ? Cette action cloture son execution.')) {
        return
      }
    }

    setCompletionState({ loading: true, error: null, message: null })
    try {
      const response = await axios.post(
        `${API_URL}/api/tournees/next-best-visits/validated-tours/${encodeURIComponent(selectedTourneeCode)}/complete`,
        {},
        { timeout: REQUEST_TIMEOUT_MS }
      )
      setCompletionState({ loading: false, error: null, message: response.data?.message || 'Tournee terminee.' })
      await openTour(selectedTourneeCode)
    } catch (error) {
      setCompletionState({
        loading: false,
        message: null,
        error: error?.response?.data?.message || error?.message || 'Impossible de terminer cette tournee.'
      })
    }
  }, [openTour, selectedTourneeCode])

  const loadComparison = useCallback(async () => {
    if (!selectedTourneeCode) return
    setComparisonState({ loading: true, error: null, data: null })
    try {
      const response = await axios.get(
        `${API_URL}/api/tournees/next-best-visits/validated-tours/${encodeURIComponent(selectedTourneeCode)}/comparison`,
        { timeout: REQUEST_TIMEOUT_MS }
      )
      setComparisonState({ loading: false, error: null, data: response.data || null })
    } catch (error) {
      setComparisonState({
        loading: false,
        data: null,
        error: error?.response?.data?.message || error?.message || 'Impossible de calculer la comparaison prevision/reel.'
      })
    }
  }, [selectedTourneeCode])

  const header = useMemo(
    () => (detailState.tour ? buildValidatedTourHeaderModel(detailState.tour, commerciaux) : null),
    [detailState.tour, commerciaux]
  )
  const rows = useMemo(
    () => (detailState.tour ? buildValidatedTourRows(detailState.tour) : []),
    [detailState.tour]
  )
  const routeStops = useMemo(() => buildValidatedTourRouteStops(rows), [rows])
  const routePlan = useOptimizedTourRoute({
    selected: Boolean(detailState.tour) && routeStops.length > 0,
    commercialCode: header?.commercialCode || '',
    date: header?.date || '',
    stops: routeStops,
    origin: null,
    preserveOrder: true
  })
  const routeUrl = buildGoogleMapsUrl(routePlan.origin, routePlan.orderedStops)

  return (
    <section className="sales-coverage-card">
      <h2>Tournees validees</h2>
      <p>
        Retrouve ici les tournees deja validees pour un commercial itinerant : clients, itineraire et
        saisie du resultat reel de chaque visite.
      </p>

      <div className="sales-coverage-form-grid">
        <div className="sales-coverage-field">
          <label htmlFor="validated-tours-date">Date</label>
          <input
            id="validated-tours-date"
            type="date"
            value={filters.date}
            onChange={event => handleFilterChange('date', event.target.value)}
          />
        </div>

        <div className="sales-coverage-field">
          <label htmlFor="validated-tours-commercial">Commercial</label>
          <select
            id="validated-tours-commercial"
            value={filters.commercialCode}
            onChange={event => handleFilterChange('commercialCode', event.target.value)}
          >
            <option value="">-- Tous --</option>
            {commerciaux.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="sales-coverage-field">
          <label htmlFor="validated-tours-code">Code de tournee</label>
          <input
            id="validated-tours-code"
            type="text"
            placeholder="Optionnel"
            value={filters.tourneeCode}
            onChange={event => handleFilterChange('tourneeCode', event.target.value)}
          />
        </div>
      </div>

      <div className="sales-coverage-form-actions">
        <button
          type="button"
          className="sales-coverage-submit"
          onClick={runSearch}
          disabled={searchState.loading}
        >
          {searchState.loading ? 'Recherche en cours...' : 'Rechercher les tournees validees'}
        </button>
      </div>

      {searchState.error ? (
        <div className="sales-status-banner sales-status-banner-error">{searchState.error}</div>
      ) : null}

      {searchState.hasSearched && !searchState.loading && !searchState.error && tours.length === 0 ? (
        <div className="sales-status-banner sales-status-banner-info">
          Aucune tournee validee ne correspond a cette recherche.
        </div>
      ) : null}

      {tours.length > 0 ? (
        <div className="sales-coverage-result-layout">
          <div className="sales-coverage-sidebar">
            {tours.map(tour => (
              <button
                key={tour.tourneeCode}
                type="button"
                className={selectedTourneeCode === tour.tourneeCode ? 'sales-coverage-block sales-coverage-block-selected' : 'sales-coverage-block'}
                onClick={() => openTour(tour.tourneeCode)}
              >
                <div className="sales-coverage-block-title">
                  <strong>{tour.date}</strong>
                  <span>{tour.commercialLabel}</span>
                </div>
                <div className="sales-coverage-block-meta">{tour.clientsCount} client(s) - {tour.statusLabel}</div>
                <div className="sales-coverage-block-value">{tour.tourneeCode}</div>
              </button>
            ))}
          </div>

          <div className="sales-side-panels">
            {detailState.loading ? (
              <div className="sales-status-banner sales-status-banner-info">Chargement de la tournee...</div>
            ) : null}
            {detailState.error ? (
              <div className="sales-status-banner sales-status-banner-error">{detailState.error}</div>
            ) : null}

            {header ? (
              <div className="sales-route-panel">
                <div className="sales-panel-title">Tournee validee</div>
                <div className="sales-summary-badges">
                  <span className="sales-inline-badge">Date : {header.date}</span>
                  <span className="sales-inline-badge">Commercial : {header.commercialLabel}</span>
                  <span className="sales-inline-badge">{header.clientsCount} client(s)</span>
                  <span className="sales-inline-badge">Code tournee : {header.tourneeCode}</span>
                  <span className="sales-inline-badge">Route : {header.routeCode}</span>
                  <span className="sales-inline-badge">Depot : {header.depotCode}</span>
                  <span className="sales-inline-badge">Statut : {header.statusLabel}</span>
                </div>

                {completionState.message ? (
                  <div className="sales-route-note">{completionState.message}</div>
                ) : null}
                {completionState.error ? (
                  <div className="sales-route-note sales-validation-error">{completionState.error}</div>
                ) : null}

                <div className="sales-feedback-actions">
                  <button
                    type="button"
                    className="sales-coverage-submit"
                    onClick={completeTour}
                    disabled={!header.canComplete || completionState.loading}
                  >
                    {completionState.loading
                      ? 'Cloture en cours...'
                      : header.isCompleted
                        ? 'Tournee terminee'
                        : 'Terminer la tournee'}
                  </button>
                </div>
              </div>
            ) : null}

            {header ? (
              <div className="sales-coverage-table-shell">
                <table className="sales-coverage-table">
                  <thead>
                    <tr>
                      <th>ORDRE</th>
                      <th>CLIENT</th>
                      <th>ADRESSE</th>
                      <th>CA PREVU</th>
                      <th>QTE PREVUE</th>
                      <th>PROBABILITE D ACHAT</th>
                      <th>STATUT DE VISITE</th>
                      <th>ACHAT REEL</th>
                      <th>CA REEL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length ? rows.map(row => (
                      <tr key={row.key}>
                        <td>{row.rang}</td>
                        <td>
                          <div className="sales-client-ident">
                            <strong>{row.clientName}</strong>
                            <span>{row.clientCode}</span>
                            {!row.gpsAvailable ? (
                              <span className="sales-inline-badge sales-inline-badge-warn">GPS indisponible</span>
                            ) : null}
                          </div>
                        </td>
                        <td>{row.address}</td>
                        <td>{formatOptionalNumber(row.predictedCaIfBuy ?? row.predictedCa)}</td>
                        <td>{formatOptionalNumber(row.predictedQuantityIfBuy ?? row.recommendedQuantity)}</td>
                        <td>{row.purchaseProbability == null ? 'Non disponible' : `${formatOptionalNumber(row.purchaseProbability)} %`}</td>
                        <td>{row.executionStatusLabel}</td>
                        <td>{row.purchaseMade == null ? 'Non disponible' : (row.purchaseMade ? 'Oui' : 'Non')}</td>
                        <td>{row.actualCa == null ? 'Non disponible' : row.actualCa}</td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={9} className="sales-empty-table-cell">Aucun client sur cette tournee.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : null}

            {header ? (
              <SalesVisitFeedbackPanel
                rows={rows}
                validationState={{
                  validated: true,
                  tourneeCode: header.tourneeCode,
                  reloadNonce: 0
                }}
              />
            ) : null}

            {header ? (
              <div className="sales-route-panel">
                <div className="sales-panel-title">Comparaison prevision / reel</div>
                <p className="sales-route-note">
                  Compare la prediction enregistree a la validation avec le resultat reellement saisi sur le terrain.
                </p>

                <div className="sales-feedback-actions">
                  <button
                    type="button"
                    className="sales-coverage-submit"
                    onClick={loadComparison}
                    disabled={comparisonState.loading}
                  >
                    {comparisonState.loading ? 'Calcul en cours...' : 'Comparer previsions et resultats reels'}
                  </button>
                </div>

                {comparisonState.error ? (
                  <div className="sales-route-note sales-validation-error">{comparisonState.error}</div>
                ) : null}

                {comparisonState.data ? (
                  <>
                    <div className="sales-summary-badges">
                      {Object.entries(comparisonState.data.outcome_counts || {}).map(([key, count]) => (
                        <span key={key} className="sales-inline-badge">
                          {PURCHASE_OUTCOME_LABELS[key] || key} : {count}
                        </span>
                      ))}
                    </div>
                    <div className="sales-coverage-metrics-grid">
                      <div className="sales-coverage-metric">
                        <span>Ecart moyen CA (MAE)</span>
                        <strong>{formatOptionalNumber(comparisonState.data.summary?.ca_expected?.mae)}</strong>
                      </div>
                      <div className="sales-coverage-metric">
                        <span>Biais CA</span>
                        <strong>{formatOptionalNumber(comparisonState.data.summary?.ca_expected?.bias)}</strong>
                      </div>
                      <div className="sales-coverage-metric">
                        <span>Ecart moyen quantite (MAE)</span>
                        <strong>{formatOptionalNumber(comparisonState.data.summary?.quantity?.mae)}</strong>
                      </div>
                      <div className="sales-coverage-metric">
                        <span>Taux de conversion reel</span>
                        <strong>
                          {comparisonState.data.summary?.purchase?.conversion_rate == null
                            ? 'Non disponible'
                            : `${formatOptionalNumber(comparisonState.data.summary.purchase.conversion_rate * 100)} %`}
                        </strong>
                      </div>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            {header ? (
              <div className="sales-route-panel">
                <div className="sales-panel-title">Itineraire</div>
                <div className="sales-route-summary">
                  <span className="sales-route-pill">
                    {routePlan.summary
                      ? `${formatDistanceMeters(routePlan.summary.distance)} - ${formatDurationSeconds(routePlan.summary.duration)}`
                      : 'Trace simplifie'}
                  </span>
                </div>

                <TourRouteMap routePlan={routePlan} height={320} />

                {routePlan.loading ? (
                  <div className="sales-route-note">Calcul de l'itineraire OSRM en cours...</div>
                ) : null}
                {routePlan.error ? (
                  <div className="sales-route-note">{routePlan.error}</div>
                ) : null}
                {rows.filter(row => row.gpsAvailable).length < 2 ? (
                  <div className="sales-route-note">GPS insuffisant pour calculer l'itineraire.</div>
                ) : null}

                <div className="sales-route-columns">
                  <div className="sales-scroll-box">
                    {routePlan.orderedStops?.length ? (
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
                </div>

                <div className="sales-route-actions">
                  <a href={routeUrl} target="_blank" rel="noreferrer" className="sales-route-link">
                    Ouvrir la navigation
                  </a>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}

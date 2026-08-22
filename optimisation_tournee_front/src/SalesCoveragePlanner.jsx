import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { API_URL } from './apiConfig'
import './SalesCoveragePlanner.css'
import useOptimizedTourRoute from './useOptimizedTourRoute'
import SalesCommercialMultiSelect from './SalesCommercialMultiSelect.jsx'
import SalesTourDetails from './SalesTourDetails.jsx'
import {
  DEFAULT_COVERAGE_PERIOD_DAYS,
  formatInteger,
  todayIsoDate
} from './coveragePlannerUtils.js'
import {
  SALES_COVERAGE_FORM_FIELDS,
  aggregateSalesLoadingPrediction,
  buildHighProbabilityMetric,
  buildSalesClientRows,
  buildSalesCoveragePayload,
  buildSalesDetailHeaderModel,
  buildSalesExecutionSummary,
  buildSalesProfileReadinessViewModel,
  buildSalesPortfolioSummary,
  buildSalesPredictionSummary,
  buildSalesSidebarBlockModel,
  computeSalesGpsStats,
  describeSalesClientScope,
  extractSalesPlanView,
  listSalesCommercialValues,
  normalizeSelectedSalesCommercialCodes,
  resolveSelectedSalesBlock
} from './salesCoverageDetails.js'

const OPTIONS_REQUEST_TIMEOUT_MS = 20000
const PLAN_REQUEST_TIMEOUT_MS = 240000

function buildRouteStops(block) {
  return (Array.isArray(block?.clients) ? block.clients : []).map(client => ({
    id: String(client?.client_id || client?.client_code || ''),
    client_id: String(client?.client_id || ''),
    client_code: String(client?.client_code || ''),
    nom: String(client?.client_name || client?.client_code || '').trim(),
    adresse: String(client?.address || '').trim() || 'Adresse non specifiee',
    latitude: client?.latitude,
    longitude: client?.longitude
  }))
}

function describeExecutionFeasibility(executionSummary) {
  const toNullableNumber = value => {
    if (value === null || value === undefined || value === '') {
      return null
    }

    const numericValue = Number(value)
    return Number.isFinite(numericValue) ? numericValue : null
  }

  const status = String(
    executionSummary?.feasibilityStatus || 'unknown'
  ).trim()

  const requiredVisits = toNullableNumber(
    executionSummary?.requiredVisitsCount
  )

  const maximumCapacity = toNullableNumber(
    executionSummary?.maximumCapacity
  )

  const deficit = toNullableNumber(
    executionSummary?.capacityDeficit
  )

  const surplus = toNullableNumber(
    executionSummary?.capacitySurplus
  )

  if (status === 'no_commercials_selected') {
    return 'Aucun commercial selectionne'
  }

  if (status === 'capacity_insufficient' || (deficit !== null && deficit > 0)) {
    return `Capacite insuffisante : deficit de ${formatInteger(deficit)} visite(s)`
  }

  if (status === 'feasible') {
    if (maximumCapacity === null) {
      return 'Capacite theorique suffisante sans maximum strict'
    }

    if (surplus !== null && surplus > 0) {
      return `Capacite theorique suffisante : surplus de ${formatInteger(surplus)} visite(s)`
    }

    if (
      requiredVisits !== null &&
      maximumCapacity === requiredVisits
    ) {
      return 'Capacite theorique a l equilibre'
    }

    return 'Capacite theorique suffisante'
  }

  return 'Faisabilite en attente de calcul'
}

export default function SalesCoveragePlanner() {
  const [optionsState, setOptionsState] = useState({
    loading: true,
    error: null,
    commerciaux: [],
    activeClientsCount: null,
    coverageDefaults: {
      objective_mode: 'balanced',
      respect_availability: 'flexible',
      minimum_confidence: 0,
      daily_max_mode: 'flexible'
    }
  })
  const [filters, setFilters] = useState({
    start_date: todayIsoDate(),
    period_days: String(DEFAULT_COVERAGE_PERIOD_DAYS),
    min_clients: '20',
    max_clients: '30',
    min_daily_ca_per_commercial: '',
    commercial_codes: [],
    objective_mode: 'balanced',
    max_days_without_contact: '',
    respect_availability: 'flexible',
    minimum_confidence: '0',
    daily_max_mode: 'flexible'
  })
  const [generationState, setGenerationState] = useState({
    loading: false,
    error: null
  })
  const [readinessState, setReadinessState] = useState({
    loading: true,
    error: null,
    payload: null
  })
  const readinessRequestSequenceRef = useRef(0)
  const [planView, setPlanView] = useState(null)
  const [selectedBlockId, setSelectedBlockId] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function loadOptions() {
      try {
        const response = await axios.get(`${API_URL}/api/tournees/options`, {
          timeout: OPTIONS_REQUEST_TIMEOUT_MS
        })
        if (cancelled) return

        const commerciaux = Array.isArray(response.data?.commerciaux) ? response.data.commerciaux : []
        const coverageDefaults = response.data?.next_best_visit_defaults && typeof response.data.next_best_visit_defaults === 'object'
          ? response.data.next_best_visit_defaults
          : {
              objective_mode: 'balanced',
              respect_availability: 'flexible',
              minimum_confidence: 0,
              daily_max_mode: 'flexible'
            }

        setOptionsState({
          loading: false,
          error: null,
          commerciaux,
          activeClientsCount: Number(response.data?.active_clients_count || 0),
          coverageDefaults
        })
        setFilters(current => {
          const selectedCodes = normalizeSelectedSalesCommercialCodes(current.commercial_codes, commerciaux)
          return {
            ...current,
            commercial_codes: selectedCodes.length ? selectedCodes : listSalesCommercialValues(commerciaux),
            objective_mode: current.objective_mode || String(coverageDefaults.objective_mode || 'balanced'),
            respect_availability: current.respect_availability || String(coverageDefaults.respect_availability || 'flexible'),
            minimum_confidence: current.minimum_confidence || String(coverageDefaults.minimum_confidence ?? 0),
            daily_max_mode: current.daily_max_mode || String(coverageDefaults.daily_max_mode || 'flexible')
          }
        })
      } catch (error) {
        if (cancelled) return
        setOptionsState({
          loading: false,
          error: error?.response?.data?.error || error?.message || 'Impossible de charger les commerciaux.',
          commerciaux: [],
          activeClientsCount: null,
          coverageDefaults: {
            objective_mode: 'balanced',
            respect_availability: 'flexible',
            minimum_confidence: 0,
            daily_max_mode: 'flexible'
          }
        })
      }
    }

    loadOptions()
    return () => {
      cancelled = true
    }
  }, [])

  const handleFilterChange = useCallback((fieldId, value) => {
    setFilters(current => ({
      ...current,
      [fieldId]: value
    }))
  }, [])

  const selectedCommercialCodes = useMemo(
    () => normalizeSelectedSalesCommercialCodes(filters.commercial_codes, optionsState.commerciaux),
    [filters.commercial_codes, optionsState.commerciaux]
  )

  const handleCommercialSelectionChange = useCallback((nextCommercialCodes) => {
    handleFilterChange('commercial_codes', normalizeSelectedSalesCommercialCodes(nextCommercialCodes, optionsState.commerciaux))
  }, [handleFilterChange, optionsState.commerciaux])

  const loadReadiness = useCallback(async () => {
    const requestSequence = readinessRequestSequenceRef.current + 1
    readinessRequestSequenceRef.current = requestSequence
    setReadinessState(current => ({
      ...current,
      loading: true,
      error: null
    }))
    try {
      const response = await axios.get(`${API_URL}/api/tournees/next-best-visits/readiness`, {
        timeout: OPTIONS_REQUEST_TIMEOUT_MS,
        params: {
          start_date: String(filters.start_date || todayIsoDate()).slice(0, 10)
        }
      })
      if (requestSequence !== readinessRequestSequenceRef.current) {
        return response.data
      }
      setReadinessState(current => ({
        ...current,
        loading: false,
        error: null,
        payload: response.data
      }))
      return response.data
    } catch (error) {
      if (requestSequence !== readinessRequestSequenceRef.current) {
        return null
      }
      setReadinessState(current => ({
        ...current,
        loading: false,
        error: error?.response?.data?.error || error?.message || 'Impossible de verifier l etat des profils V2.'
      }))
      return null
    }
  }, [filters.start_date])

  useEffect(() => {
    loadReadiness()
  }, [loadReadiness])

  const currentCoverageDefaults = useMemo(
    () => optionsState.coverageDefaults || {
      objective_mode: 'balanced',
      respect_availability: 'flexible',
      minimum_confidence: 0,
      daily_max_mode: 'flexible'
    },
    [optionsState.coverageDefaults]
  )
  const currentRequestPayload = useMemo(
    () => buildSalesCoveragePayload(filters, selectedCommercialCodes, currentCoverageDefaults),
    [currentCoverageDefaults, filters, selectedCommercialCodes]
  )
  const readinessView = useMemo(
    () => buildSalesProfileReadinessViewModel(readinessState),
    [readinessState]
  )
  const generationBlockedByReadiness = readinessView.disableGenerate
  const generationBlockedBySelection = !selectedCommercialCodes.length

  useEffect(() => {
    if (!readinessView.shouldPoll) {
      return undefined
    }

    const timeoutId = window.setTimeout(() => {
      loadReadiness()
    }, 2000)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [loadReadiness, readinessView.shouldPoll])

  const handleGeneratePlan = useCallback(async () => {
    try {
      setGenerationState({
        loading: true,
        error: null
      })

      const response = await axios.post(`${API_URL}/api/tournees/next-best-visits`, currentRequestPayload, {
        timeout: PLAN_REQUEST_TIMEOUT_MS
      })


      const nextPlanView = extractSalesPlanView(response.data)

      setPlanView(nextPlanView)
      setSelectedBlockId(nextPlanView.blocks[0]?.slot_id || null)
      await loadReadiness()
      setGenerationState({
        loading: false,
        error: null
      })
    } catch (error) {
      await loadReadiness()
      setGenerationState({
        loading: false,
        error: error?.response?.data?.message || error?.message || 'La generation du plan de tournees ventes V2 a echoue.'
      })
    }
  }, [currentRequestPayload, loadReadiness])

  const selectedBlock = useMemo(
    () => resolveSelectedSalesBlock(planView?.blocks, selectedBlockId),
    [planView?.blocks, selectedBlockId]
  )
  const selectedBlockStops = useMemo(
    () => buildRouteStops(selectedBlock),
    [selectedBlock]
  )
  const selectedBlockRoutePlan = useOptimizedTourRoute({
    selected: Boolean(selectedBlock),
    commercialCode: selectedBlock?.commercial_code || '',
    date: selectedBlock?.date || '',
    stops: selectedBlockStops,
    origin: planView?.depotOrigin || null
  })
  const selectedClientRows = useMemo(
    () => buildSalesClientRows(selectedBlock, selectedBlockRoutePlan),
    [selectedBlock, selectedBlockRoutePlan]
  )
  const selectedLoadingPrediction = useMemo(
    () => aggregateSalesLoadingPrediction(selectedBlock),
    [selectedBlock]
  )
  const highProbabilityMetric = useMemo(
    () => buildHighProbabilityMetric(planView?.summary || {}),
    [planView]
  )
  const selectedHeader = useMemo(
    () => buildSalesDetailHeaderModel(selectedBlock, selectedBlockRoutePlan),
    [selectedBlock, selectedBlockRoutePlan]
  )
  const selectedGpsStats = useMemo(
    () => computeSalesGpsStats(selectedBlock?.clients),
    [selectedBlock]
  )
  const portfolioSummary = useMemo(
    () => buildSalesPortfolioSummary(planView),
    [planView]
  )
  const executionSummary = useMemo(
    () => buildSalesExecutionSummary(planView, filters, selectedCommercialCodes),
    [filters, planView, selectedCommercialCodes]
  )
  const predictionSummary = useMemo(
    () => buildSalesPredictionSummary(planView),
    [planView]
  )
  const submitLabel = generationState.loading
    ? 'Generation V2 en cours...'
    : generationBlockedBySelection
      ? 'Selectionne au moins un commercial'
      : generationBlockedByReadiness
        ? 'Preparation en cours...'
        : 'Generer les visites recommandees'

  return (
    <div className="sales-coverage-shell">
      <section className="sales-coverage-card">
        <h2>Plan de tournees ventes</h2>
        <p>
          Tous les clients actifs restent suivis par le portefeuille Smart Portfolio.
          Le plan ci-dessous ne montre que les visites executables dans l horizon choisi.
        </p>

        <div className="sales-coverage-form-grid">
          <div className="sales-coverage-field">
            <label htmlFor="sales-start-date">{SALES_COVERAGE_FORM_FIELDS[0].label}</label>
            <input
              id="sales-start-date"
              type="date"
              value={filters.start_date}
              onChange={event => handleFilterChange('start_date', event.target.value)}
            />
          </div>

          <div className="sales-coverage-field">
            <label htmlFor="sales-period-days">{SALES_COVERAGE_FORM_FIELDS[1].label}</label>
            <input
              id="sales-period-days"
              type="number"
              min={1}
              max={60}
              value={filters.period_days}
              onChange={event => handleFilterChange('period_days', event.target.value)}
            />
          </div>

          <div className="sales-coverage-field">
            <label htmlFor="sales-min-clients">{SALES_COVERAGE_FORM_FIELDS[2].label}</label>
            <input
              id="sales-min-clients"
              type="number"
              min={0}
              max={250}
              value={filters.min_clients}
              onChange={event => handleFilterChange('min_clients', event.target.value)}
            />
          </div>

          <div className="sales-coverage-field">
            <label htmlFor="sales-max-clients">{SALES_COVERAGE_FORM_FIELDS[3].label}</label>
            <input
              id="sales-max-clients"
              type="number"
              min={0}
              max={250}
              value={filters.max_clients}
              onChange={event => handleFilterChange('max_clients', event.target.value)}
            />
          </div>

          <div className="sales-coverage-field">
            <label htmlFor="sales-min-daily-ca">{SALES_COVERAGE_FORM_FIELDS[4].label}</label>
            <input
              id="sales-min-daily-ca"
              type="number"
              min={0}
              step="0.1"
              value={filters.min_daily_ca_per_commercial}
              onChange={event => handleFilterChange('min_daily_ca_per_commercial', event.target.value)}
              placeholder="Optionnel"
            />
          </div>

          <div className="sales-coverage-field">
            <label htmlFor="sales-commercials">{SALES_COVERAGE_FORM_FIELDS[5].label}</label>
            <SalesCommercialMultiSelect
              id="sales-commercials"
              options={optionsState.commerciaux}
              selectedCodes={selectedCommercialCodes}
              onChange={handleCommercialSelectionChange}
            />
          </div>
        </div>

        <details className="sales-coverage-advanced">
          <summary>Regles avancees</summary>
          <div className="sales-coverage-form-grid sales-coverage-form-grid-advanced">
            <div className="sales-coverage-field">
              <label htmlFor="sales-objective-mode">Objectif d optimisation</label>
              <select
                id="sales-objective-mode"
                value={filters.objective_mode}
                onChange={event => handleFilterChange('objective_mode', event.target.value)}
              >
                <option value="balanced">Equilibre ventes / fidelisation / distance</option>
                <option value="maximize_sales">Maximiser les ventes attendues</option>
                <option value="reactivate_at_risk">Reactivation des clients a risque</option>
                <option value="commercial_priority">Couverture commerciale prioritaire</option>
              </select>
            </div>

            <div className="sales-coverage-field">
              <label htmlFor="sales-max-days-without-contact">Max jours sans contact</label>
              <input
                id="sales-max-days-without-contact"
                type="number"
                min={1}
                max={180}
                placeholder="Optionnel"
                value={filters.max_days_without_contact}
                onChange={event => handleFilterChange('max_days_without_contact', event.target.value)}
              />
            </div>

            <div className="sales-coverage-field">
              <label htmlFor="sales-respect-availability">Respect disponibilite</label>
              <select
                id="sales-respect-availability"
                value={filters.respect_availability}
                onChange={event => handleFilterChange('respect_availability', event.target.value)}
              >
                <option value="flexible">Flexible</option>
                <option value="strict">Strict</option>
              </select>
            </div>

            <div className="sales-coverage-field">
              <label htmlFor="sales-min-confidence">Seuil minimum de confiance</label>
              <input
                id="sales-min-confidence"
                type="number"
                min={0}
                max={100}
                step="1"
                value={filters.minimum_confidence}
                onChange={event => handleFilterChange('minimum_confidence', event.target.value)}
              />
            </div>

            <div className="sales-coverage-field">
              <label htmlFor="sales-daily-max-mode">Mode du maximum quotidien</label>
              <select
                id="sales-daily-max-mode"
                value={filters.daily_max_mode}
                onChange={event => handleFilterChange('daily_max_mode', event.target.value)}
              >
                <option value="strict">Maximum strict</option>
                <option value="flexible">Maximum flexible</option>
              </select>
            </div>
          </div>
        </details>

        <div className="sales-coverage-form-actions">
          <div className="sales-coverage-meta">
            {optionsState.loading
              ? 'Chargement des options...'
              : optionsState.activeClientsCount == null
                ? 'Clients actifs : Non disponible'
                : `Clients actifs suivis par le portefeuille : ${optionsState.activeClientsCount}`}
          </div>

          <button
            type="button"
            className="sales-coverage-submit"
            onClick={handleGeneratePlan}
            disabled={
              generationState.loading ||
              optionsState.loading ||
              generationBlockedByReadiness ||
              generationBlockedBySelection
            }
          >
            {submitLabel}
          </button>
        </div>
      </section>

      {optionsState.error ? (
        <div className="sales-status-banner sales-status-banner-error">{optionsState.error}</div>
      ) : null}
      {generationState.error ? (
        <div className="sales-status-banner sales-status-banner-error">{generationState.error}</div>
      ) : null}
      {generationBlockedBySelection ? (
        <div className="sales-status-banner sales-status-banner-info">
          Selectionne au moins un commercial avant de generer les visites.
        </div>
      ) : null}
      {generationBlockedByReadiness ? (
        <div className="sales-status-banner sales-status-banner-info">
          Preparation en cours...
        </div>
      ) : null}

      {planView ? (
        <section className="sales-coverage-card">
          <h3>Resultat Smart Portfolio</h3>
          <p>{planView.message || 'Selectionne un block pour afficher son detail.'}</p>
          {planView.clientScope && Object.keys(planView.clientScope).length ? (
            <p className="sales-coverage-scope-note">{describeSalesClientScope(planView.clientScope)}</p>
          ) : null}

          <div className="sales-summary-section">
            <h4>Portefeuille</h4>
            <div className="sales-coverage-metrics-grid">
              <div className="sales-coverage-metric">
                <span>Clients actifs suivis</span>
                <strong>{portfolioSummary.activeClientsCount}</strong>
              </div>
              {portfolioSummary.metrics.map(metric => (
                <div key={metric.key} className="sales-coverage-metric">
                  <span>{metric.label}</span>
                  <strong>{metric.count}</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="sales-summary-section">
           <h4>Faisabilite et capacite</h4>

<div className="sales-coverage-metrics-grid">
  <div className="sales-coverage-metric">
    <span>Visites planifiees dans l horizon</span>
    <strong>
      {formatInteger(executionSummary.selectedVisitsCount)}
    </strong>
  </div>


 <div className="sales-coverage-metric">
   <span>Clients uniques planifies</span>
   <strong>
    {formatInteger(
      executionSummary.selectedUniqueClientsCount
    )}
   </strong>
 </div>

  <div className="sales-coverage-metric">
    <span>Clients requis dans l horizon</span>
    <strong>
      {executionSummary.requiredVisitsCount === null
        ? 'Non disponible'
        : formatInteger(executionSummary.requiredVisitsCount)}
    </strong>
  </div>

  <div className="sales-coverage-metric">
    <span>Clients obligatoires planifies</span>
    <strong>
      {executionSummary.selectedRequiredClientsCount === null
        ? 'Non disponible'
        : formatInteger(
            executionSummary.selectedRequiredClientsCount
          )}
    </strong>
  </div>


  <div className="sales-coverage-metric">
   <span>Ecart de planification</span>
   <strong>
     {executionSummary.planningGap === null
       ? 'Non disponible'
       : formatInteger(executionSummary.planningGap)}
   </strong>
   <small>Clients requis non planifies</small>
  </div>

  <div className="sales-coverage-metric">
    <span>Commerciaux selectionnes</span>
    <strong>
      {formatInteger(executionSummary.selectedCommercialsCount)}
    </strong>
  </div>

  <div className="sales-coverage-metric">
    <span>Horizon</span>
    <strong>
      {formatInteger(executionSummary.horizonDays)} jours
    </strong>
  </div>

  <div className="sales-coverage-metric">
    <span>Charge cible totale</span>
    <strong>
      {formatInteger(executionSummary.targetCapacity)}
    </strong>
  </div>

  <div className="sales-coverage-metric">
    <span>Maximum total</span>
    <strong>
      {executionSummary.maximumCapacity === null
        ? 'Non limite'
        : formatInteger(executionSummary.maximumCapacity)}
    </strong>
  </div>

  {executionSummary.recommendedMinimumHorizonDays !== null && (
    <div className="sales-coverage-metric">
      <span>Horizon minimum recommande</span>
      <strong>
        {formatInteger(
          executionSummary.recommendedMinimumHorizonDays
        )} jours
      </strong>
    </div>
  )}

  <div className="sales-coverage-metric">
    <span>Etat de faisabilite</span>
    <strong>
      {describeExecutionFeasibility(executionSummary)}
    </strong>
  </div>
</div>
          </div>

          <div className="sales-summary-section">
            <h4>Predictions</h4>
            <div className="sales-coverage-metrics-grid">
              <div className="sales-coverage-metric">
                <span>{predictionSummary.expectedValueMetric.label}</span>
                <strong>{predictionSummary.expectedValueMetric.valueLabel}</strong>
                <small>{predictionSummary.expectedValueMetric.detailLabel}</small>
              </div>
              <div className="sales-coverage-metric">
                <span>Prediction coverage</span>
                <strong>{`${predictionSummary.knownCount} / ${predictionSummary.totalVisits}`}</strong>
                <small>{`${predictionSummary.coverageRate} % des visites planifiees`}</small>
              </div>
              <div className="sales-coverage-metric">
                <span>{highProbabilityMetric.label}</span>
                <strong>{highProbabilityMetric.valueLabel}</strong>
                <small>{highProbabilityMetric.detailLabel}</small>
              </div>
              <div className="sales-coverage-metric">
                <span>Objectif IA</span>
                <strong>{planView.summary?.objective_mode || filters.objective_mode}</strong>
              </div>
            </div>
          </div>

          {planView.blocks.length ? (
            <div className="sales-coverage-result-layout">
              <div className="sales-coverage-sidebar">
                {planView.blocks.map(block => {
                  const sidebarModel = buildSalesSidebarBlockModel(block)

                  return (
                    <button
                      key={block.slot_id}
                      type="button"
                      className={selectedBlock?.slot_id === block.slot_id ? 'sales-coverage-block sales-coverage-block-selected' : 'sales-coverage-block'}
                      onClick={() => setSelectedBlockId(block.slot_id)}
                    >
                      <div className="sales-coverage-block-title">
                        <strong>{sidebarModel.title}</strong>
                        <span>{sidebarModel.commercialLabel}</span>
                      </div>
                      <div className="sales-coverage-block-meta">{sidebarModel.clientsLabel}</div>
                      <div className="sales-coverage-block-value">{sidebarModel.predictedLabel}</div>
                    </button>
                  )
                })}
              </div>

              <SalesTourDetails
                block={selectedBlock}
                header={selectedHeader}
                clientRows={selectedClientRows}
                loadingPredictionItems={selectedLoadingPrediction}
                routePlan={selectedBlockRoutePlan}
              />
            </div>
          ) : (
            <div className="sales-status-banner sales-status-banner-info">
              Aucune visite executable n a ete planifiee dans cet horizon. Les clients restent toutefois suivis dans le portefeuille.
            </div>
          )}

          {selectedBlock ? (
            <div className="sales-status-banner sales-status-banner-info">
              {selectedBlock.exceeds_workday
                ? `Avertissement terrain: ${selectedBlock.total_estimated_minutes ?? 0} minute(s) estimee(s) pour ce block, au-dessus de la limite connue.`
                : selectedBlock.workday_limit_known === false && selectedBlock.total_estimated_minutes != null
                  ? `Temps estime du block: ${selectedBlock.total_estimated_minutes} minute(s). La limite de journee n est pas configuree, confirmation terrain necessaire.`
                  : planView.summary?.terrain_warnings?.length
                    ? `Avertissements terrain: ${planView.summary.terrain_warnings.join(', ')}.`
                    : selectedGpsStats.mapped < 2
                      ? 'GPS insuffisant pour calculer l itineraire OSRM, mais tous les clients restent visibles dans le detail.'
                      : selectedBlockRoutePlan.error
                        ? 'L itineraire detaille est indisponible pour le moment. Le tableau clients et les predictions restent accessibles.'
                        : selectedBlockRoutePlan.fromCache
                          ? 'Le trajet de ce block a ete recharge depuis le cache frontend.'
                          : 'La carte reste une vue d execution de route. Elle n explique pas, a elle seule, le besoin commercial de visite.'}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

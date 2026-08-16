import SalesCommercialMultiSelect from './SalesCommercialMultiSelect.jsx'

export default function SalesFeedbackMonitoringPanel({
  filters = {},
  options = [],
  selectedCommercialCodes = [],
  onFilterChange,
  onCommercialSelectionChange,
  onRefresh,
  panelState = {},
  learningStatusView = {},
  kpis = [],
  byCommercialRows = [],
  byPlanningDateRows = [],
  detailRows = []
}) {
  return (
    <section className="sales-coverage-card">
      <div className="sales-monitoring-header">
        <div>
          <h3>Suivi Prevu vs Reel</h3>
          <p>
            Ce suivi reste strictement en lecture seule. Il compare les predictions memorisees au moment du plan
            avec le resultat reel saisi sur le terrain.
          </p>
        </div>

        <button
          type="button"
          className="sales-coverage-submit"
          onClick={onRefresh}
          disabled={panelState.loading}
        >
          {panelState.loading ? 'Chargement...' : 'Actualiser'}
        </button>
      </div>

      <div className="sales-coverage-form-grid sales-monitoring-form-grid">
        <div className="sales-coverage-field">
          <label htmlFor="sales-monitoring-start-date">Date debut</label>
          <input
            id="sales-monitoring-start-date"
            type="date"
            value={filters.start_date || ''}
            onChange={event => onFilterChange('start_date', event.target.value)}
          />
        </div>

        <div className="sales-coverage-field">
          <label htmlFor="sales-monitoring-end-date">Date fin</label>
          <input
            id="sales-monitoring-end-date"
            type="date"
            value={filters.end_date || ''}
            onChange={event => onFilterChange('end_date', event.target.value)}
          />
        </div>

        <div className="sales-coverage-field">
          <label htmlFor="sales-monitoring-commercials">Commerciaux</label>
          <SalesCommercialMultiSelect
            id="sales-monitoring-commercials"
            options={options}
            selectedCodes={selectedCommercialCodes}
            onChange={onCommercialSelectionChange}
          />
        </div>
      </div>

      <div className="sales-monitoring-note">
        Biais positif = surestimation. Biais negatif = sous-estimation.
      </div>

      <div className="sales-summary-section">
        <h4>Apprentissage du modele</h4>
        {learningStatusView.error ? (
          <div className="sales-status-banner sales-status-banner-error">{learningStatusView.error}</div>
        ) : null}
        {learningStatusView.loading ? (
          <div className="sales-status-banner sales-status-banner-info">Chargement du statut d apprentissage...</div>
        ) : null}
        <div className="sales-coverage-metrics-grid">
          <div className="sales-coverage-metric">
            <span>Modele actuel</span>
            <strong>{learningStatusView.modelVersionLabel || 'Non disponible'}</strong>
          </div>
          <div className="sales-coverage-metric">
            <span>Nouveau feedback disponible</span>
            <strong>{learningStatusView.newFeedbackLabel || '0'}</strong>
          </div>
          <div className="sales-coverage-metric">
            <span>Etat apprentissage</span>
            <strong>{learningStatusView.stateLabel || 'Non disponible'}</strong>
          </div>
          <div className="sales-coverage-metric">
            <span>Derniere evaluation</span>
            <strong>{learningStatusView.evaluationLabel || 'Non disponible'}</strong>
          </div>
          <div className="sales-coverage-metric">
            <span>Derniere decision</span>
            <strong>{learningStatusView.decisionLabel || 'Non disponible'}</strong>
          </div>
        </div>
      </div>

      {panelState.error ? (
        <div className="sales-status-banner sales-status-banner-error">{panelState.error}</div>
      ) : null}

      {panelState.loading ? (
        <div className="sales-status-banner sales-status-banner-info">Chargement du suivi prevu vs reel...</div>
      ) : null}

      {panelState.empty ? (
        <div className="sales-status-banner sales-status-banner-info">{panelState.emptyMessage}</div>
      ) : null}

      {!panelState.empty && !panelState.error ? (
        <>
          <div className="sales-summary-section">
            <h4>Execution et achat</h4>
            <div className="sales-coverage-metrics-grid">
              {kpis.slice(0, 8).map(metric => (
                <div key={metric.key} className="sales-coverage-metric">
                  <span>{metric.label}</span>
                  <strong>{metric.valueLabel}</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="sales-summary-section">
            <h4>Ecarts CA et quantite</h4>
            <div className="sales-coverage-metrics-grid">
              {kpis.slice(8).map(metric => (
                <div key={metric.key} className="sales-coverage-metric">
                  <span>{metric.label}</span>
                  <strong>{metric.valueLabel}</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="sales-summary-section">
            <h4>Par commercial</h4>
            <div className="sales-scroll-box sales-monitoring-scroll">
              <table className="sales-monitoring-table">
                <thead>
                  <tr>
                    <th>Commercial</th>
                    <th>Planifiees</th>
                    <th>Effectuees</th>
                    <th>Achats</th>
                    <th>Taux exec.</th>
                    <th>Taux conv.</th>
                    <th>MAE CA</th>
                    <th>Biais CA</th>
                    <th>MAE qte</th>
                    <th>Biais qte</th>
                  </tr>
                </thead>
                <tbody>
                  {byCommercialRows.length ? byCommercialRows.map(row => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td>{row.planned}</td>
                      <td>{row.visited}</td>
                      <td>{row.purchases}</td>
                      <td>{row.executionRateLabel}</td>
                      <td>{row.conversionRateLabel}</td>
                      <td>{row.expectedMaeLabel}</td>
                      <td>{row.expectedBiasLabel}</td>
                      <td>{row.quantityMaeLabel}</td>
                      <td>{row.quantityBiasLabel}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={10}>Non disponible</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="sales-summary-section">
            <h4>Par date</h4>
            <div className="sales-scroll-box sales-monitoring-scroll">
              <table className="sales-monitoring-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Planifiees</th>
                    <th>Effectuees</th>
                    <th>Achats</th>
                    <th>Taux exec.</th>
                    <th>Taux conv.</th>
                    <th>MAE CA</th>
                    <th>Biais CA</th>
                    <th>MAE qte</th>
                    <th>Biais qte</th>
                  </tr>
                </thead>
                <tbody>
                  {byPlanningDateRows.length ? byPlanningDateRows.map(row => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td>{row.planned}</td>
                      <td>{row.visited}</td>
                      <td>{row.purchases}</td>
                      <td>{row.executionRateLabel}</td>
                      <td>{row.conversionRateLabel}</td>
                      <td>{row.expectedMaeLabel}</td>
                      <td>{row.expectedBiasLabel}</td>
                      <td>{row.quantityMaeLabel}</td>
                      <td>{row.quantityBiasLabel}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={10}>Non disponible</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="sales-summary-section">
            <h4>Visites suivies</h4>
            <div className="sales-scroll-box sales-monitoring-scroll">
              <table className="sales-monitoring-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Commercial</th>
                    <th>Date planifiee</th>
                    <th>Statut visite</th>
                    <th>Achat</th>
                    <th>CA prevu visite</th>
                    <th>CA reel</th>
                    <th>Ecart visite</th>
                    <th>CA prevu si achat</th>
                    <th>Qte prevue si achat</th>
                    <th>Qte reelle</th>
                    <th>Ecart qte</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.length ? detailRows.map(row => (
                    <tr key={row.plannedVisitId || `${row.clientCode}-${row.plannedDate}`}>
                      <td>{row.clientCode || row.clientId || 'Non disponible'}</td>
                      <td>{row.commercialCode || 'Non disponible'}</td>
                      <td>{row.plannedDate || 'Non disponible'}</td>
                      <td>{row.executionStatusLabel}</td>
                      <td>{row.purchaseLabel}</td>
                      <td>{row.expectedVisitCaLabel}</td>
                      <td>{row.actualCaLabel}</td>
                      <td>{row.expectedCaErrorLabel}</td>
                      <td>{row.caIfBuyLabel}</td>
                      <td>{row.estimatedQuantityLabel}</td>
                      <td>{row.actualQuantityLabel}</td>
                      <td>{row.quantityErrorLabel}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={12}>Non disponible</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </section>
  )
}

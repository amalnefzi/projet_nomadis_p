import {
  formatNullableCurrency
} from './coveragePlannerUtils.js'
import {
  formatSalesClientValue,
  formatSalesConfidencePercent
} from './salesCoverageDetails.js'

export default function SalesTourClientTable({ rows = [] }) {
  return (
    <div className="sales-coverage-table-shell">
      <table className="sales-coverage-table">
        <thead>
          <tr>
            <th>#</th>
            <th>ORDRE DE PASSAGE</th>
            <th>CLIENT</th>
            <th>PORTEFEUILLE</th>
            <th>DATE PLANIFIEE</th>
            <th>COMMERCIAL</th>
            <th>PRIORITE IA</th>
            <th>VIP</th>
            <th>QUANTITE ESTIMEE</th>
            <th>VALEUR DE VISITE</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map(row => (
            <tr key={row.key}>
              <td>{row.priorityRank}</td>
              <td>{row.visitOrder ?? 'Non disponible'}</td>
              <td>
                <div className="sales-client-ident">
                  <strong>{row.clientName}</strong>
                  <span>{row.clientCode}</span>
                  {!row.gpsAvailable ? (
                    <span className="sales-inline-badge sales-inline-badge-warn">GPS indisponible</span>
                  ) : null}
                </div>
              </td>
              <td>
                <div className="sales-client-ident">
                  <strong>{row.portfolioStatusLabel}</strong>
                  {row.mainReasonLabels.map(reason => (
                    <span key={`${row.key}-${reason}`}>{reason}</span>
                  ))}
                </div>
              </td>
              <td>
                <div className="sales-client-ident">
                  <strong>{row.plannedDate || 'Non disponible'}</strong>
                  <span>{row.dateSourceLabel}</span>
                  <span>Confiance date : {formatSalesConfidencePercent(row.dateConfidence)}</span>
                  {row.shiftedWithinRecommendedWindow ? (
                    <span>Date ajustee dans la fenetre recommandee.</span>
                  ) : null}
                </div>
              </td>
              <td>
                <div className="sales-client-ident">
                  <strong>{row.commercialLabel || 'Non disponible'}</strong>
                  <span>{row.commercialCode || 'Non disponible'}</span>
                  <span>{row.zoneLabel}</span>
                </div>
              </td>
              <td>{formatSalesClientValue(row.priorityScore)}</td>
              <td>{formatSalesClientValue(row.vipScore)}</td>
              <td>
                <div className="sales-client-ident">
                  <strong>{formatSalesClientValue(row.estimatedQuantity)}</strong>
                  <span>Estimation interne du modele</span>
                  <span>Si achat : {formatSalesClientValue(row.estimatedQuantityIfBuy)}</span>
                </div>
              </td>
              <td>
                <div className="sales-client-ident">
                  <strong>{formatNullableCurrency(row.expectedVisitValue)}</strong>
                  <span>Valeur attendue de visite</span>
                  <span>CA estime si achat : {formatNullableCurrency(row.estimatedCaIfBuy)}</span>
                </div>
              </td>
            </tr>
          )) : (
            <tr>
              <td colSpan={10} className="sales-empty-table-cell">Aucun client affecte a cette tournee.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

import {
  formatDecimal,
  formatInteger,
  formatNullableCurrency
} from './coveragePlannerUtils'
import { buildCoverageClientRows } from './coveragePlannerDetails'

function renderPriority(value) {
  if (value === null || value === undefined || value === '') {
    return 'Non disponible'
  }
  return formatDecimal(value, 1)
}

export default function CoverageTourClientTable({ block }) {
  const rows = buildCoverageClientRows(block)

  return (
    <div className="coverage-client-table-shell">
      <table className="coverage-client-table">
        <thead>
          <tr>
            <th>Ordre</th>
            <th>Priorite</th>
            <th>Client</th>
            <th>Recouvrement</th>
            <th>Collecte prevue</th>
            <th>Zone</th>
            <th>Raisons</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.clientId}>
              <td>{formatInteger(row.order)}</td>
              <td>
                <div className="coverage-priority-stack">
                  <span>Couverture: {renderPriority(row.coverageUrgency)}</span>
                  <span>Recouvrement: {renderPriority(row.recoveryPriorityScore)}</span>
                  <span>Paiement: {renderPriority(row.paymentBehaviorScore)}</span>
                </div>
              </td>
              <td>
                <div className="coverage-client-ident">
                  <strong>{row.clientName}</strong>
                  <span>{row.clientCode}</span>
                  {!row.gpsAvailable ? (
                    <span className="coverage-inline-badge coverage-inline-badge-warn">GPS indisponible</span>
                  ) : null}
                </div>
              </td>
              <td>
                <div className="coverage-priority-stack">
                  <span>Echu: {formatNullableCurrency(row.dueAmount)}</span>
                  <span>Retard: {row.overdueDays == null ? 'Non disponible' : `${formatInteger(row.overdueDays)} j`}</span>
                  <span>Comportement: {renderPriority(row.paymentBehaviorScore)}</span>
                </div>
              </td>
              <td>{formatNullableCurrency(row.expectedCollectionAmount)}</td>
              <td>{row.zoneLabel || 'Non disponible'}</td>
              <td>
                <div className="coverage-reason-list">
                  {row.reasons.length ? row.reasons.map(reason => (
                    <span key={`${row.clientId}-${reason}`} className="coverage-inline-badge">
                      {reason}
                    </span>
                  )) : (
                    <span className="coverage-inline-badge coverage-inline-badge-muted">Aucune raison detaillee</span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

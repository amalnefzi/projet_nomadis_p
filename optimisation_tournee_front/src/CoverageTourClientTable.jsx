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

function renderScoreIa(value) {
  if (value === null || value === undefined || value === '') {
    return 'Non disponible'
  }
  return `${formatDecimal(value, 0)}/100`
}

export default function CoverageTourClientTable({ block }) {
  const rows = buildCoverageClientRows(block)

  return (
    <div className="coverage-client-table-shell">
      <table className="coverage-client-table">
        <thead>
          <tr>
            <th>Ordre (score)</th>
            <th>Score IA</th>
            <th>Client</th>
            <th>Recouvrement</th>
            <th>Collecte prevue</th>
            <th>Zone</th>
            <th>Affectation commercial</th>
            <th>Raisons</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.clientId}>
              <td>
                <div className="coverage-priority-stack">
                  <strong>{formatInteger(row.order)}</strong>
                  <span className="coverage-inline-badge coverage-inline-badge-muted">
                    Visite {formatInteger(row.routeOrder)}
                  </span>
                </div>
              </td>
              <td>
                <strong>{renderScoreIa(row.recoveryPriorityScore)}</strong>
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
                  {Number(row.dueAmount) === Number(row.totalBalance) ? (
                    <span>Du (echu): {formatNullableCurrency(row.totalBalance)}</span>
                  ) : (
                    <>
                      <span>Total du: {formatNullableCurrency(row.totalBalance)}</span>
                      <span>Dont echu: {formatNullableCurrency(row.dueAmount)}</span>
                    </>
                  )}
                  <span>Retard: {row.overdueDays == null ? 'Non disponible' : `${formatInteger(row.overdueDays)} j`}</span>
                  <span>Paiement (comportement): {renderPriority(row.paymentBehaviorScore)}</span>
                  {row.hasImpaye ? (
                    <span className="coverage-inline-badge coverage-inline-badge-warn">Impaye signale</span>
                  ) : null}
                </div>
              </td>
              <td>{formatNullableCurrency(row.expectedCollectionAmount)}</td>
              <td>{row.zoneLabel || 'Non disponible'}</td>
              <td>
                <div className="coverage-reason-list" title={row.assignmentReason.reasonLabels.join(' | ')}>
                  <span className="coverage-inline-badge">{row.assignmentReason.primaryLabel}</span>
                  {row.assignmentReason.reasonLabels.slice(1).map(label => (
                    <span key={`${row.clientId}-assign-${label}`} className="coverage-inline-badge coverage-inline-badge-muted">
                      {label}
                    </span>
                  ))}
                </div>
              </td>
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

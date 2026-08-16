import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { API_URL } from './apiConfig'
import { validationLabEnabled } from './validationLabConfig'

function formatJson(value) {
  return JSON.stringify(value, null, 2)
}

function buildScenarioResultMap(results = []) {
  return new Map(
    (Array.isArray(results) ? results : [])
      .map(result => [String(result?.scenario_id || ''), result])
      .filter(([scenarioId]) => scenarioId)
  )
}

function summarizeVisits(blocks = []) {
  return (Array.isArray(blocks) ? blocks : []).flatMap(block => (
    Array.isArray(block.clients)
      ? block.clients.map(client => ({
          client_code: client.client_code,
          assigned_date: block.date,
          decision_mode: client.decision_mode,
          confidence: client.confidence,
          explanation_codes: client.explanation_codes,
          score_breakdown: client.score_breakdown
        }))
      : []
  ))
}

function summarizeDeferredClients(deferredClients = []) {
  return (Array.isArray(deferredClients) ? deferredClients : []).map(client => ({
    client_code: client.client_code,
    explanation_codes: client.explanation_codes,
    explanation_reasons: client.explanation_reasons,
    best_future_date: client.best_future_date
  }))
}

export default function V2ValidationLab() {
  const [loadingScenarios, setLoadingScenarios] = useState(false)
  const [runningAll, setRunningAll] = useState(false)
  const [runningScenarioId, setRunningScenarioId] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [scenarios, setScenarios] = useState([])
  const [report, setReport] = useState(null)
  const [scenarioResults, setScenarioResults] = useState(new Map())

  useEffect(() => {
    if (!validationLabEnabled) return

    let mounted = true
    setLoadingScenarios(true)
    setErrorMessage('')

    axios.get(`${API_URL}/api/dev/next-best-visit-validation/scenarios`)
      .then(response => {
        if (!mounted) return
        setScenarios(Array.isArray(response.data?.scenarios) ? response.data.scenarios : [])
      })
      .catch(error => {
        if (!mounted) return
        setErrorMessage(error?.response?.data?.message || error?.message || 'Impossible de charger les scenarios du validation lab.')
      })
      .finally(() => {
        if (mounted) setLoadingScenarios(false)
      })

    return () => {
      mounted = false
    }
  }, [])

  const runAllScenarios = async () => {
    try {
      setRunningAll(true)
      setErrorMessage('')
      const response = await axios.post(`${API_URL}/api/dev/next-best-visit-validation/run`)
      setReport(response.data)
      setScenarioResults(buildScenarioResultMap(response.data?.scenarios))
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || error?.message || 'Execution complete impossible.')
    } finally {
      setRunningAll(false)
    }
  }

  const runSingleScenario = async scenarioId => {
    try {
      setRunningScenarioId(scenarioId)
      setErrorMessage('')
      const response = await axios.post(`${API_URL}/api/dev/next-best-visit-validation/run/${scenarioId}`)
      setScenarioResults(current => {
        const next = new Map(current)
        next.set(scenarioId, response.data)
        return next
      })
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || error?.message || `Execution du scenario ${scenarioId} impossible.`)
    } finally {
      setRunningScenarioId('')
    }
  }

  const renderedScenarios = useMemo(() => {
    return scenarios.map(scenario => ({
      ...scenario,
      result: scenarioResults.get(scenario.scenario_id) || null
    }))
  }, [scenarios, scenarioResults])

  const summary = report?.summary || null
  const statuses = report?.statuses || null

  if (!validationLabEnabled) {
    return null
  }

  return (
    <div style={{ padding: '24px', background: 'linear-gradient(180deg, #f8fbff 0%, #eef6f3 100%)', minHeight: '100vh' }}>
      <div style={{ maxWidth: '1320px', margin: '0 auto', display: 'grid', gap: '20px' }}>
        <div style={{ backgroundColor: 'white', borderRadius: '20px', padding: '24px', boxShadow: '0 12px 30px rgba(15, 23, 42, 0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 800, color: '#0f766e', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Internal Validation
              </div>
              <h1 style={{ margin: '10px 0 8px 0', fontSize: '30px', color: '#12314a' }}>V2 Intelligence Validation Lab</h1>
              <p style={{ margin: 0, color: '#52606d', maxWidth: '840px', lineHeight: 1.6 }}>
                Fixtures synthétiques JSON vers le même moteur Next Best Visit V2 partagé avec la production, sans MySQL ni Python réel.
              </p>
            </div>

            <button
              type="button"
              onClick={runAllScenarios}
              disabled={runningAll || loadingScenarios}
              style={{
                padding: '14px 18px',
                border: 'none',
                borderRadius: '12px',
                backgroundColor: runningAll ? '#94a3b8' : '#0f766e',
                color: 'white',
                fontWeight: 800,
                cursor: runningAll || loadingScenarios ? 'not-allowed' : 'pointer',
                minWidth: '240px'
              }}
            >
              {runningAll ? 'Execution complete en cours...' : 'Executer tous les scenarios'}
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
          {[
            ['Technical', statuses?.technical_validation_status || 'not_run'],
            ['Logical', statuses?.logical_validation_status || 'not_run'],
            ['Commercial', statuses?.commercial_validation_status || 'not_validated'],
            ['Environment', statuses?.data_environment || 'synthetic_validation'],
            ['Representativeness', statuses?.data_representativeness || 'non_representative'],
            ['Scenarios', summary ? `${summary.passed}/${summary.total} PASS` : `${scenarios.length} scenario(s)`],
            ['Deterministic', summary ? String(summary.deterministic) : 'unknown'],
            ['Runtime', summary ? `${summary.total_runtime_ms} ms` : 'not_run']
          ].map(([label, value]) => (
            <div key={label} style={{ backgroundColor: 'white', borderRadius: '16px', padding: '18px', boxShadow: '0 10px 24px rgba(15, 23, 42, 0.06)' }}>
              <div style={{ fontSize: '11px', color: '#667085', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
              <div style={{ marginTop: '8px', fontSize: '20px', color: '#12314a', fontWeight: 800, wordBreak: 'break-word' }}>{value}</div>
            </div>
          ))}
        </div>

        {report?.benchmarks?.length > 0 && (
          <div style={{ backgroundColor: 'white', borderRadius: '18px', padding: '22px', boxShadow: '0 10px 24px rgba(15, 23, 42, 0.06)' }}>
            <h2 style={{ marginTop: 0, color: '#12314a' }}>Benchmarks synthétiques</h2>
            <div style={{ display: 'grid', gap: '12px' }}>
              {report.benchmarks.map(benchmark => (
                <div key={`${benchmark.client_count}-${benchmark.planning_horizon_days}`} style={{ border: '1px solid #dbe4ea', borderRadius: '14px', padding: '14px 16px', backgroundColor: '#f8fbff' }}>
                  <div style={{ fontWeight: 800, color: '#12314a' }}>{benchmark.client_count} clients / {benchmark.planning_horizon_days} jours</div>
                  <div style={{ marginTop: '6px', color: '#52606d', fontSize: '14px' }}>
                    Runtime {benchmark.runtime_ms} ms, target {benchmark.target_ms} ms, sparsity {benchmark.sparsity_ratio}%,
                    opportunités {benchmark.sparse_opportunities_count}, max/client {benchmark.max_opportunities_per_client}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {(errorMessage || loadingScenarios) && (
          <div style={{
            backgroundColor: errorMessage ? '#fef3f2' : '#eef5ff',
            color: errorMessage ? '#b42318' : '#175cd3',
            borderRadius: '14px',
            padding: '14px 16px',
            fontWeight: 700
          }}>
            {errorMessage || 'Chargement des scenarios en cours...'}
          </div>
        )}

        <div style={{ display: 'grid', gap: '14px' }}>
          {renderedScenarios.map(scenario => {
            const result = scenario.result
            const selectedVisits = summarizeVisits(result?.actual_result?.blocks)
            const deferredClients = summarizeDeferredClients(result?.actual_result?.deferred_clients)

            return (
              <div key={scenario.scenario_id} style={{ backgroundColor: 'white', borderRadius: '18px', padding: '20px', boxShadow: '0 10px 24px rgba(15, 23, 42, 0.06)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: '12px', color: '#0f766e', fontWeight: 800, textTransform: 'uppercase' }}>{scenario.objective || 'balanced'}</div>
                    <h3 style={{ margin: '8px 0 4px 0', color: '#12314a' }}>{scenario.scenario_id}</h3>
                    <div style={{ color: '#667085', fontSize: '14px' }}>
                      Début {scenario.planning_start_date}, horizon {scenario.planning_horizon_days} jour(s), critique {String(scenario.critical)}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{
                      padding: '8px 12px',
                      borderRadius: '999px',
                      backgroundColor: !result ? '#e5e7eb' : result.status === 'PASS' ? '#ecfdf3' : '#fef3f2',
                      color: !result ? '#475467' : result.status === 'PASS' ? '#027a48' : '#b42318',
                      fontWeight: 800,
                      fontSize: '12px'
                    }}>
                      {result?.status || 'NOT RUN'}
                    </span>
                    <button
                      type="button"
                      onClick={() => runSingleScenario(scenario.scenario_id)}
                      disabled={runningScenarioId === scenario.scenario_id}
                      style={{
                        padding: '10px 14px',
                        border: '1px solid #cfd8df',
                        borderRadius: '10px',
                        backgroundColor: 'white',
                        color: '#12314a',
                        fontWeight: 700,
                        cursor: runningScenarioId === scenario.scenario_id ? 'not-allowed' : 'pointer'
                      }}
                    >
                      {runningScenarioId === scenario.scenario_id ? 'Execution...' : 'Executer ce scenario'}
                    </button>
                  </div>
                </div>

                {result && (
                  <div style={{ marginTop: '16px', display: 'grid', gap: '14px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
                      {[
                        ['Runtime', `${result.runtime_ms} ms`],
                        ['Opportunities', result.opportunities_count],
                        ['Selected', result.selected_visits_count],
                        ['Technical', result.technical_validation_status],
                        ['Logical', result.logical_validation_status],
                        ['Commercial', result.commercial_validation_status]
                      ].map(([label, value]) => (
                        <div key={label} style={{ backgroundColor: '#f8fbff', border: '1px solid #dbe4ea', borderRadius: '12px', padding: '12px' }}>
                          <div style={{ fontSize: '11px', color: '#667085', fontWeight: 800, textTransform: 'uppercase' }}>{label}</div>
                          <div style={{ marginTop: '6px', fontSize: '16px', color: '#12314a', fontWeight: 800 }}>{value}</div>
                        </div>
                      ))}
                    </div>

                    {result.failures?.length > 0 && (
                      <div style={{ backgroundColor: '#fef3f2', borderRadius: '12px', padding: '14px 16px', color: '#b42318' }}>
                        <div style={{ fontWeight: 800, marginBottom: '6px' }}>Assertions échouées</div>
                        {result.failures.map(failure => (
                          <div key={failure} style={{ fontSize: '14px', lineHeight: 1.5 }}>{failure}</div>
                        ))}
                      </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px' }}>
                      <div style={{ backgroundColor: '#f8fbff', border: '1px solid #dbe4ea', borderRadius: '12px', padding: '14px' }}>
                        <div style={{ fontWeight: 800, color: '#12314a', marginBottom: '8px' }}>Visites sélectionnées</div>
                        {selectedVisits.length ? selectedVisits.map(visit => (
                          <div key={`${visit.client_code}-${visit.assigned_date}`} style={{ marginBottom: '10px', color: '#52606d', fontSize: '14px' }}>
                            <div style={{ fontWeight: 800, color: '#12314a' }}>{visit.client_code} - {visit.assigned_date}</div>
                            <div>Mode {visit.decision_mode}, confiance {visit.confidence}</div>
                            <div>Reason codes: {(visit.explanation_codes || []).join(', ') || 'aucun'}</div>
                          </div>
                        )) : (
                          <div style={{ color: '#667085', fontSize: '14px' }}>Aucune visite sélectionnée.</div>
                        )}
                      </div>

                      <div style={{ backgroundColor: '#f8fbff', border: '1px solid #dbe4ea', borderRadius: '12px', padding: '14px' }}>
                        <div style={{ fontWeight: 800, color: '#12314a', marginBottom: '8px' }}>Clients reportés</div>
                        {deferredClients.length ? deferredClients.map(client => (
                          <div key={client.client_code} style={{ marginBottom: '10px', color: '#52606d', fontSize: '14px' }}>
                            <div style={{ fontWeight: 800, color: '#12314a' }}>{client.client_code}</div>
                            <div>Reason codes: {(client.explanation_codes || []).join(', ') || 'aucun'}</div>
                            <div>Meilleure date: {client.best_future_date || 'non fournie'}</div>
                          </div>
                        )) : (
                          <div style={{ color: '#667085', fontSize: '14px' }}>Aucun client reporté.</div>
                        )}
                      </div>
                    </div>

                    <details style={{ backgroundColor: '#fcfcfd', border: '1px solid #e4e7ec', borderRadius: '12px', padding: '14px' }}>
                      <summary style={{ cursor: 'pointer', fontWeight: 800, color: '#12314a' }}>Score breakdown, expected vs actual</summary>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '14px', marginTop: '14px' }}>
                        <div>
                          <div style={{ fontWeight: 800, color: '#12314a', marginBottom: '8px' }}>Expected result</div>
                          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', color: '#344054' }}>{formatJson(result.expected_result)}</pre>
                        </div>
                        <div>
                          <div style={{ fontWeight: 800, color: '#12314a', marginBottom: '8px' }}>Actual result</div>
                          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', color: '#344054' }}>{formatJson({
                            selected_visits: selectedVisits,
                            deferred_clients: deferredClients,
                            warning_codes: result.actual_result?.diagnostics?.warning_codes || [],
                            top_opportunities_by_client_code: result.actual_result?.validation?.top_opportunities_by_client_code || {}
                          })}</pre>
                        </div>
                      </div>
                    </details>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

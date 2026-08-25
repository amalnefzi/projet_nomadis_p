import { useCallback, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { API_URL } from './apiConfig'
import {
  buildSalesVisitFeedbackDraft,
  buildSalesVisitFeedbackItems,
  buildSalesVisitFeedbackPayload,
  buildSalesVisitFeedbackRecordIndex
} from './salesCoverageDetails.js'
import {
  deriveSalesBlockValidationStatus
} from './salesTourValidation.js'

const FEEDBACK_REQUEST_TIMEOUT_MS = 20000

export default function SalesVisitFeedbackPanel({
  rows = [],
  validationState = {},
  onValidationStateChange = null
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [recordsById, setRecordsById] = useState({})
  const [draftsById, setDraftsById] = useState({})
  const [savingById, setSavingById] = useState({})
  const [savedById, setSavedById] = useState({})
  const feedbackReloadNonce = Number(validationState?.reloadNonce || 0)
  const feedbackEditable = Boolean(validationState?.validated)

  const rowIndex = useMemo(
    () => (Array.isArray(rows) ? rows : []).reduce((accumulator, row) => {
      if (row?.plannedVisitId) {
        accumulator[row.plannedVisitId] = row
      }
      return accumulator
    }, {}),
    [rows]
  )
  const plannedVisitIds = useMemo(
    () => Object.keys(rowIndex),
    [rowIndex]
  )
  const plannedVisitIdsKey = `${plannedVisitIds.join('||')}::${feedbackReloadNonce}`

  useEffect(() => {
    let cancelled = false

    async function loadFeedback() {
      if (!plannedVisitIds.length) {
        setRecordsById({})
        setDraftsById({})
        setError(null)
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)
      try {
        const response = await axios.get(`${API_URL}/api/tournees/next-best-visits/visit-feedback`, {
          timeout: FEEDBACK_REQUEST_TIMEOUT_MS,
          params: {
            planned_visit_ids: plannedVisitIds
          }
        })
        if (cancelled) return
        const nextIndex = buildSalesVisitFeedbackRecordIndex(
          Array.isArray(response.data?.records) ? response.data.records : []
        )
        setRecordsById(nextIndex)
        setDraftsById(current => {
          const nextDrafts = { ...current }
          plannedVisitIds.forEach(plannedVisitId => {
            nextDrafts[plannedVisitId] = buildSalesVisitFeedbackDraft(
              rowIndex[plannedVisitId],
              nextIndex[plannedVisitId] || null
            )
          })
          return nextDrafts
        })
        setLoading(false)
      } catch (requestError) {
        if (cancelled) return
        setLoading(false)
        setError(requestError?.response?.data?.message || requestError?.message || 'Impossible de charger le resultat de visite.')
      }
    }

    loadFeedback()
    return () => {
      cancelled = true
    }
  }, [plannedVisitIds, plannedVisitIdsKey, rowIndex])

  const restoredValidationState = useMemo(
    () => deriveSalesBlockValidationStatus(rows, recordsById),
    [recordsById, rows]
  )

  useEffect(() => {
    if (typeof onValidationStateChange === 'function') {
      onValidationStateChange(restoredValidationState)
    }
  }, [onValidationStateChange, restoredValidationState])

  const feedbackItems = useMemo(
    () => buildSalesVisitFeedbackItems(rows, recordsById),
    [recordsById, rows]
  )

  const handleDraftChange = useCallback((plannedVisitId, fieldName, value) => {
    setDraftsById(current => ({
      ...current,
      [plannedVisitId]: {
        ...(current[plannedVisitId] || {}),
        [fieldName]: value
      }
    }))
    setSavedById(current => ({
      ...current,
      [plannedVisitId]: null
    }))
  }, [])

  const handleSave = useCallback(async (plannedVisitId) => {
    if (!feedbackEditable) return

    const row = rowIndex[plannedVisitId]
    if (!row) return

    const payload = buildSalesVisitFeedbackPayload(row, draftsById[plannedVisitId] || {})
    setSavingById(current => ({
      ...current,
      [plannedVisitId]: true
    }))
    setError(null)

    try {
      const response = await axios.put(
        `${API_URL}/api/tournees/next-best-visits/visit-feedback/${encodeURIComponent(plannedVisitId)}`,
        payload,
        {
          timeout: FEEDBACK_REQUEST_TIMEOUT_MS
        }
      )
      const nextIndex = buildSalesVisitFeedbackRecordIndex([
        response.data?.record || null
      ])
      const nextRecord = nextIndex[plannedVisitId] || null
      setRecordsById(current => ({
        ...current,
        ...nextIndex
      }))
      setDraftsById(current => ({
        ...current,
        [plannedVisitId]: buildSalesVisitFeedbackDraft(row, nextRecord)
      }))
      setSavedById(current => ({
        ...current,
        [plannedVisitId]: 'Resultat enregistre.'
      }))
    } catch (requestError) {
      setError(requestError?.response?.data?.message || requestError?.message || 'Impossible d enregistrer le resultat de visite.')
    } finally {
      setSavingById(current => ({
        ...current,
        [plannedVisitId]: false
      }))
    }
  }, [draftsById, feedbackEditable, rowIndex])

  if (!feedbackItems.length) {
    return (
      <div className="sales-route-panel">
        <div className="sales-panel-title">Resultat de la visite</div>
        <div className="sales-route-empty">Aucune visite planifiee pour ce bloc.</div>
      </div>
    )
  }

  return (
    <div className="sales-route-panel">
      <div className="sales-panel-title">Resultat de la visite</div>
      {loading ? (
        <div className="sales-route-note">Chargement du resultat de visite...</div>
      ) : null}
      {error ? (
        <div className="sales-route-note">{error}</div>
      ) : null}
      {!feedbackEditable ? (
        <div className="sales-route-note">Validez cette tournee avant de saisir le resultat des visites.</div>
      ) : null}

      {feedbackEditable ? (
        <div className="sales-feedback-list">
          {feedbackItems.map(item => {
            const draft = draftsById[item.plannedVisitId] || buildSalesVisitFeedbackDraft(rowIndex[item.plannedVisitId], recordsById[item.plannedVisitId] || null)
            const saving = Boolean(savingById[item.plannedVisitId])
            const savedMessage = savedById[item.plannedVisitId] || null
            return (
              <details key={item.plannedVisitId} className="sales-feedback-card">
                <summary className="sales-feedback-summary">
                  <div>
                    <strong>{item.clientName}</strong>
                    <span>{item.clientCode}</span>
                  </div>
                  <span className="sales-inline-badge">{item.executionStatusLabel}</span>
                </summary>

                <div className="sales-feedback-fields">
                  <div className="sales-feedback-field">
                    <label htmlFor={`feedback-status-${item.plannedVisitId}`}>Statut</label>
                    <select
                      id={`feedback-status-${item.plannedVisitId}`}
                      value={draft.executionStatus}
                      onChange={event => handleDraftChange(item.plannedVisitId, 'executionStatus', event.target.value)}
                      disabled={!feedbackEditable}
                    >
                      <option value="pending">En attente</option>
                      <option value="visited">Visite effectuee</option>
                      <option value="not_visited">Non visite</option>
                    </select>
                  </div>

                  {draft.executionStatus === 'visited' ? (
                    <>
                      <div className="sales-feedback-field">
                        <label htmlFor={`feedback-purchase-${item.plannedVisitId}`}>Achat realise</label>
                        <select
                          id={`feedback-purchase-${item.plannedVisitId}`}
                          value={draft.purchaseMade}
                          onChange={event => handleDraftChange(item.plannedVisitId, 'purchaseMade', event.target.value)}
                          disabled={!feedbackEditable}
                        >
                          <option value="">Non renseigne</option>
                          <option value="true">Oui</option>
                          <option value="false">Non</option>
                        </select>
                      </div>

                      <div className="sales-feedback-field">
                        <label htmlFor={`feedback-actual-ca-${item.plannedVisitId}`}>CA reel</label>
                        <input
                          id={`feedback-actual-ca-${item.plannedVisitId}`}
                          type="number"
                          step="0.001"
                          min="0"
                          value={draft.actualCa}
                          onChange={event => handleDraftChange(item.plannedVisitId, 'actualCa', event.target.value)}
                          placeholder="Non disponible"
                          disabled={!feedbackEditable}
                        />
                      </div>

                      <div className="sales-feedback-field">
                        <label htmlFor={`feedback-actual-quantity-${item.plannedVisitId}`}>Quantite reelle</label>
                        <input
                          id={`feedback-actual-quantity-${item.plannedVisitId}`}
                          type="number"
                          step="0.001"
                          min="0"
                          value={draft.actualQuantity}
                          onChange={event => handleDraftChange(item.plannedVisitId, 'actualQuantity', event.target.value)}
                          placeholder="Non disponible"
                          disabled={!feedbackEditable}
                        />
                      </div>

                      {draft.purchaseMade === 'false' ? (
                        <div className="sales-feedback-field sales-feedback-field-wide">
                          <label htmlFor={`feedback-no-purchase-reason-${item.plannedVisitId}`}>Motif sans achat</label>
                          <input
                            id={`feedback-no-purchase-reason-${item.plannedVisitId}`}
                            type="text"
                            value={draft.noPurchaseReason}
                            onChange={event => handleDraftChange(item.plannedVisitId, 'noPurchaseReason', event.target.value)}
                            placeholder="Optionnel"
                            disabled={!feedbackEditable}
                          />
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {draft.executionStatus === 'not_visited' ? (
                    <div className="sales-feedback-field sales-feedback-field-wide">
                      <label htmlFor={`feedback-non-visit-reason-${item.plannedVisitId}`}>Motif de non visite</label>
                      <input
                        id={`feedback-non-visit-reason-${item.plannedVisitId}`}
                        type="text"
                        value={draft.nonVisitReason}
                        onChange={event => handleDraftChange(item.plannedVisitId, 'nonVisitReason', event.target.value)}
                        placeholder="Optionnel"
                        disabled={!feedbackEditable}
                      />
                    </div>
                  ) : null}

                  <div className="sales-feedback-field sales-feedback-field-wide">
                    <label htmlFor={`feedback-note-${item.plannedVisitId}`}>Note</label>
                    <textarea
                      id={`feedback-note-${item.plannedVisitId}`}
                      value={draft.note}
                      onChange={event => handleDraftChange(item.plannedVisitId, 'note', event.target.value)}
                      rows={3}
                      placeholder="Optionnel"
                      disabled={!feedbackEditable}
                    />
                  </div>
                </div>

                <div className="sales-feedback-actions">
                  <button
                    type="button"
                    className="sales-coverage-submit"
                    onClick={() => handleSave(item.plannedVisitId)}
                    disabled={saving || !feedbackEditable}
                  >
                    {saving ? 'Enregistrement...' : 'Enregistrer'}
                  </button>
                  {savedMessage ? (
                    <span className="sales-route-note">{savedMessage}</span>
                  ) : null}
                </div>
              </details>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

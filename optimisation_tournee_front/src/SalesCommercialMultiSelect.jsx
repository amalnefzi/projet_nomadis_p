import { useEffect, useMemo, useRef, useState } from 'react'
import {
  SALES_COVERAGE_ALL_COMMERCIALS_LABEL,
  areAllSalesCommercialsSelected,
  getSalesCommercialSelectionLabel,
  normalizeSelectedSalesCommercialCodes,
  toggleAllSalesCommercialsSelection,
  toggleSalesCommercialSelection
} from './salesCoverageDetails.js'

export default function SalesCommercialMultiSelect({
  id,
  options = [],
  selectedCodes = [],
  onChange
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const normalizedSelection = useMemo(
    () => normalizeSelectedSalesCommercialCodes(selectedCodes, options),
    [options, selectedCodes]
  )
  const allSelected = areAllSalesCommercialsSelected(normalizedSelection, options)
  const triggerLabel = getSalesCommercialSelectionLabel(normalizedSelection, options)

  useEffect(() => {
    if (!open) return undefined

    function handlePointerDown(event) {
      if (!containerRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }

    function handleEscape(event) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  return (
    <div className="sales-commercial-multiselect" ref={containerRef}>
      <button
        id={id}
        type="button"
        className="sales-commercial-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <span>{triggerLabel}</span>
        <span className="sales-commercial-trigger-icon" aria-hidden="true">{open ? '^' : 'v'}</span>
      </button>

      {open ? (
        <div
          className="sales-commercial-menu"
          role="listbox"
          aria-multiselectable="true"
          aria-labelledby={id}
        >
          <label className="sales-commercial-option">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => onChange(toggleAllSalesCommercialsSelection(normalizedSelection, options))}
            />
            <span>{SALES_COVERAGE_ALL_COMMERCIALS_LABEL}</span>
          </label>

          {options.map(option => {
            const optionValue = String(option?.value ?? '').trim()
            if (!optionValue) return null
            return (
              <label key={optionValue} className="sales-commercial-option">
                <input
                  type="checkbox"
                  checked={normalizedSelection.includes(optionValue)}
                  onChange={() => onChange(toggleSalesCommercialSelection(normalizedSelection, optionValue, options))}
                />
                <span>{option.label || optionValue}</span>
              </label>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

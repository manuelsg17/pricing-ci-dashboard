import { useState } from 'react'
import { Button } from '../ui/shadcn/button'
import { sanitizeDecimalInput } from '../../lib/format'

// El promedio se calcula SOLO con los bids — el mínimo es un dato de
// referencia aparte (se guarda en minimal_bid), nunca entra al promedio.
function calcIndriveAvg(bids) {
  const nums = bids.map((b) => parseFloat(b)).filter((n) => !isNaN(n) && n > 0)
  if (!nums.length) return ''
  return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)
}

// Mig 98: bid_4/bid_5 dropeados de pricing_observations — cap en 3 bids
// (ver Upload.jsx / algorithms/indrive.js, mismo criterio).
export default function InDriveCell({ avg, extra, onChange, hasError }) {
  const [open, setOpen] = useState(false)
  const bids = extra?.bids || ['']
  const minBid = extra?.minBid || ''

  function updateBid(i, val) {
    const newBids = [...bids]
    newBids[i] = val
    onChange({ bids: newBids, minBid }, calcIndriveAvg(newBids))
  }

  function updateMin(val) {
    // El mínimo no afecta el promedio — solo se actualiza su propio valor.
    onChange({ bids, minBid: val }, avg)
  }

  function addBid() {
    if (bids.length >= 3) return
    const newBids = [...bids, '']
    onChange({ bids: newBids, minBid }, calcIndriveAvg(newBids))
  }

  function removeBid(i) {
    if (bids.length <= 1) return
    const newBids = bids.filter((_, j) => j !== i)
    onChange({ bids: newBids, minBid }, calcIndriveAvg(newBids))
  }

  return (
    <div className={`indrive-cell${hasError ? ' indrive-cell--error' : ''}`}>
      <div className="indrive-cell__row">
        <input
          className="de-price-input indrive-avg"
          type="text"
          value={avg}
          readOnly
          placeholder="Promedio"
          title="Promedio calculado automáticamente"
          style={{ background: avg ? '#f0fdf4' : undefined, cursor: 'default' }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-[22px] w-[22px] shrink-0 rounded-sm border-border bg-[var(--color-bg-subtle)] p-0 text-[9px] text-muted hover:border-yango hover:bg-[var(--color-yango-mid)]"
          onClick={() => setOpen((o) => !o)}
          title={open ? 'Cerrar bids' : 'Agregar bids'}
        >
          {open ? '▲' : '▼'}
        </Button>
      </div>

      {open && (
        <div className="indrive-bids-panel">
          <div className="indrive-bid-row">
            <span className="indrive-bid-label">Mín</span>
            <input
              type="text"
              inputMode="decimal"
              className="indrive-bid-input"
              placeholder="0.00"
              value={minBid}
              onChange={(e) => updateMin(sanitizeDecimalInput(e.target.value))}
            />
          </div>
          {bids.map((b, i) => (
            <div key={i} className="indrive-bid-row">
              <span className="indrive-bid-label">Bid {i + 1}</span>
              <input
                type="text"
                inputMode="decimal"
                className="indrive-bid-input"
                placeholder="0.00"
                value={b}
                onChange={(e) => updateBid(i, sanitizeDecimalInput(e.target.value))}
              />
              {bids.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-[18px] w-[18px] shrink-0 rounded p-0 text-[10px] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)]"
                  onClick={() => removeBid(i)}
                >
                  ✕
                </Button>
              )}
            </div>
          ))}
          {bids.length < 3 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-0.5 h-auto rounded-sm border-dashed border-yango bg-transparent px-1.5 py-0.5 text-[10px] font-bold text-yango hover:bg-[var(--color-yango-mid)]"
              onClick={addBid}
            >
              + Bid
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

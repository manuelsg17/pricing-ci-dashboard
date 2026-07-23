import { useState } from 'react'
import { Button } from '../ui/shadcn/button'
import { sanitizeDecimalInput } from '../../lib/format'
import { calcIndriveAvg } from '../../lib/indriveAvg'
import { useI18n } from '../../context/LanguageContext'

// Mig 136: bid_4/bid_5 re-agregados a pricing_observations — cap en 5 bids
// (ver Upload.jsx / algorithms/indrive.js / lib/indriveAvg.js, mismo criterio).
// El promedio se calcula SOLO con los bids. El "recomendado" (rec →
// recommended_price) es el precio que sugiere la app de InDrive: NO entra al
// promedio de bids (eso sesgaría la media), pero si no hay ningún bid, el
// servidor usa el recomendado como precio efectivo de la celda
// (v_effective_price cae a recommended_price).
//
// El "mínimo" (minimal_bid) YA NO se carga a mano: los hubs solo usan el
// recomendado + los bids. La columna minimal_bid sigue viva en la BD porque la
// llenan el bot y el import de Excel — acá solo se saca el input. Si se reabre
// una sesión vieja que traía minimal_bid, ese valor se conserva (se pasa por
// onChange) pero no hay UI para editarlo.
const MAX_BIDS = 5

export default function InDriveCell({ avg, extra, onChange, hasError }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const bids = extra?.bids || ['']
  const minBid = extra?.minBid || ''
  const rec = extra?.rec || ''

  function updateBid(i, val) {
    const newBids = [...bids]
    newBids[i] = val
    onChange({ bids: newBids, minBid, rec }, calcIndriveAvg(newBids))
  }

  function updateRec(val) {
    // El recomendado no afecta el promedio de bids — solo se guarda aparte.
    onChange({ bids, minBid, rec: val }, avg)
  }

  function addBid() {
    if (bids.length >= MAX_BIDS) return
    const newBids = [...bids, '']
    onChange({ bids: newBids, minBid, rec }, calcIndriveAvg(newBids))
  }

  function removeBid(i) {
    if (bids.length <= 1) return
    const newBids = bids.filter((_, j) => j !== i)
    onChange({ bids: newBids, minBid, rec }, calcIndriveAvg(newBids))
  }

  return (
    <div className={`indrive-cell${hasError ? ' indrive-cell--error' : ''}`}>
      <div className="indrive-cell__row">
        <input
          className="de-price-input indrive-avg"
          type="text"
          value={avg || rec}
          readOnly
          placeholder={t('indrivecell.avg_placeholder')}
          title={
            avg
              ? t('indrivecell.avg_title_auto')
              : rec
                ? t('indrivecell.avg_title_rec_only')
                : t('indrivecell.avg_title_auto')
          }
          style={{ background: avg ? '#f0fdf4' : rec ? '#fffbeb' : undefined, cursor: 'default' }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-[22px] w-[22px] shrink-0 rounded-sm border-border bg-[var(--color-bg-subtle)] p-0 text-[9px] text-muted hover:border-yango hover:bg-[var(--color-yango-mid)]"
          onClick={() => setOpen((o) => !o)}
          title={open ? t('indrivecell.toggle_close') : t('indrivecell.toggle_open')}
        >
          {open ? '▲' : '▼'}
        </Button>
      </div>

      {open && (
        <div className="indrive-bids-panel">
          <div className="indrive-bids-head">
            <span className="indrive-bids-title">{t('indrivecell.bids_title')}</span>
            <button
              type="button"
              className="indrive-help-btn"
              onClick={() => setShowHelp((h) => !h)}
              title={t('indrivecell.help_title')}
            >
              {showHelp ? '✕' : '?'}
            </button>
          </div>

          {showHelp && (
            <div className="indrive-help">
              <p>{t('indrivecell.help_p1')}</p>
              <p>{t('indrivecell.help_p2')}</p>
              <div className="indrive-help-example">
                <div className="indrive-help-example-title">
                  {t('indrivecell.help_example_title')}
                </div>
                <div>{t('indrivecell.help_example_line1')}</div>
                <div>{t('indrivecell.help_example_line2')}</div>
              </div>
            </div>
          )}

          <div className="indrive-bid-row">
            <span className="indrive-bid-label" title={t('indrivecell.recommended_title')}>
              {t('indrivecell.recommended_label')}
            </span>
            <input
              type="text"
              inputMode="decimal"
              className="indrive-bid-input"
              placeholder="0.00"
              value={rec}
              onChange={(e) => updateRec(sanitizeDecimalInput(e.target.value))}
            />
          </div>
          {bids.map((b, i) => (
            <div key={i} className="indrive-bid-row">
              <span className="indrive-bid-label">{t('indrivecell.bid_label', { n: i + 1 })}</span>
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
          {bids.length < MAX_BIDS && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-0.5 h-auto rounded-sm border-dashed border-yango bg-transparent px-1.5 py-0.5 text-[10px] font-bold text-yango hover:bg-[var(--color-yango-mid)]"
              onClick={addBid}
            >
              {t('indrivecell.add_bid_btn')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

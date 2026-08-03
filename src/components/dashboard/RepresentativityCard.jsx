import { useState, useEffect, useCallback } from 'react'
import { sb } from '../../lib/supabase'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import CollapsibleSection from '../market/CollapsibleSection'
import { computeRepresentativity } from '../../lib/representativity'
import { BRACKET_LABELS } from '../../lib/constants'
import { getISOYearWeek } from '../../lib/dateUtils'

// Panel de Representatividad de la data para la ventana principal del dashboard.
// Muestra, para la SEMANA ISO en curso, cuántas celdas (ciudad × categoría ×
// competidor × bracket) tienen muestras suficientes para ser confiables,
// separando lo que aporta el BOT de lo que aportan las APPS (carga de los hubs),
// y lista las celdas SIN fuente confiable para saber dónde reforzar. Lee de la
// RPC get_representativity (mig 138). Si la RPC falla o no hay data, no renderiza
// nada (inerte, mismo criterio que BotCoverageCard).

const LEVEL_COLORS = {
  ok: { bg: '#dcfce7', fg: '#166534', dot: '#16a34a' },
  warn: { bg: '#fef9c3', fg: '#854d0e', dot: '#ca8a04' },
  bad: { bg: '#fee2e2', fg: '#991b1b', dot: '#dc2626' },
}

const MAX_RED_ROWS = 40

export default function RepresentativityCard() {
  const { country } = useCountry()
  const { t } = useI18n()
  const [rows, setRows] = useState(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      // Semana ISO en curso calculada en la zona local del analista (evita el
      // sesgo UTC del servidor en el borde domingo→lunes; ver mig 138).
      const { year, week } = getISOYearWeek()
      const { data, error } = await sb.rpc('get_representativity', {
        p_country: country,
        p_year: year,
        p_week: week,
      })
      if (error) {
        setFailed(true)
        setRows(null)
        return
      }
      setFailed(false)
      setRows(Array.isArray(data) ? data : [])
    } catch {
      setFailed(true)
      setRows(null)
    }
  }, [country])

  useEffect(() => {
    load()
    const iv = setInterval(load, 5 * 60_000)
    return () => clearInterval(iv)
  }, [load])

  // `failed` se calculaba y NUNCA se renderizaba: era estado muerto. La tarjeta
  // que responde "¿puedo confiar en este número?" se esfumaba cuando la RPC
  // fallaba, y desaparecer es indistinguible de "esta semana no hay datos".
  // Es el mismo bug que el repo ya arregló en usePriceComplianceAlerts y que
  // acá sobrevivió.
  if (failed) {
    return (
      <section className="mon-panel">
        <div className="de-msg de-msg--err">{t('dashboard.repr.failed')}</div>
      </section>
    )
  }
  if (!rows || rows.length === 0) return null

  const s = computeRepresentativity(rows)
  const colors = LEVEL_COLORS[s.level]
  const label =
    s.level === 'ok'
      ? t('dashboard.repr.status_ok', { pct: s.coveragePct })
      : t('dashboard.repr.status_warn', { pct: s.coveragePct, n: s.noSource })

  const statusPill = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        background: colors.bg,
        color: colors.fg,
        fontSize: 11,
        fontWeight: 700,
        border: `1px solid ${colors.dot}40`,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: colors.dot,
          boxShadow: `0 0 0 2px ${colors.dot}30`,
        }}
      />
      {label}
    </span>
  )

  const chip = (bg, fg, text) => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 8,
        background: bg,
        color: fg,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {text}
    </span>
  )

  return (
    <CollapsibleSection
      id="representativity"
      title={t('dashboard.repr.title')}
      subtitle={t('dashboard.repr.subtitle')}
      defaultOpen={false}
      action={statusPill}
    >
      {/* Resumen: cobertura + aporte por fuente */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
          fontSize: 13,
        }}
      >
        <strong>{t('dashboard.repr.covered', { covered: s.covered, total: s.totalCells })}</strong>
        <span style={{ color: '#cbd5e1' }}>·</span>
        {chip('#eff6ff', '#1d4ed8', `🤖 ${t('dashboard.repr.bot_covers', { n: s.botFloor })}`)}
        {chip(
          '#f0fdf4',
          '#15803d',
          `🧑 ${t('dashboard.repr.apps_essential', { n: s.appsEssential })}`
        )}
        {s.pooledOnly > 0 &&
          chip('#fffbeb', '#b45309', t('dashboard.repr.pooled_fragile', { n: s.pooledOnly }))}
        {s.attendedNoOffer > 0 &&
          chip(
            '#fef3c7',
            '#b45309',
            `🚫 ${t('dashboard.repr.attended_no_offer', { n: s.attendedNoOffer })}`
          )}
      </div>

      {/* Alerta: celdas sin fuente confiable */}
      {s.noSource === 0 ? (
        <div
          style={{
            background: '#dcfce7',
            color: '#166534',
            padding: '8px 12px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {t('dashboard.repr.all_good')}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#991b1b', marginBottom: 6 }}>
            ⚠️ {t('dashboard.repr.no_source_title', { n: s.noSource })}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="de-history-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>{t('dashboard.repr.col_city')}</th>
                  <th>{t('dashboard.repr.col_category')}</th>
                  <th>{t('dashboard.repr.col_bracket')}</th>
                  <th>{t('dashboard.repr.col_competitor')}</th>
                  <th>{t('dashboard.repr.col_samples')}</th>
                </tr>
              </thead>
              <tbody>
                {s.redCells.slice(0, MAX_RED_ROWS).map((c, i) => (
                  <tr key={`${c.city}|${c.category}|${c.bracket}|${c.comp}|${i}`}>
                    <td>{c.city}</td>
                    <td>{c.category}</td>
                    <td>{BRACKET_LABELS[c.bracket] || c.bracket}</td>
                    <td>{c.comp}</td>
                    <td>
                      <strong style={{ color: '#991b1b' }}>{c.total}</strong>
                      <span style={{ color: '#94a3b8' }}> / {c.floor}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.redCells.length > MAX_RED_ROWS && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
              {t('dashboard.repr.more', { n: s.redCells.length - MAX_RED_ROWS })}
            </div>
          )}
        </>
      )}

      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 10, fontStyle: 'italic' }}>
        {t('dashboard.repr.legend')}
      </div>
    </CollapsibleSection>
  )
}

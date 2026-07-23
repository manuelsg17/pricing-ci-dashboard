import { useState } from 'react'
import { sb } from '../../lib/supabase'
import { getCityLabel } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'
import { useCountry } from '../../context/CountryContext'
import { Button } from '../ui/shadcn/button'

// Progreso guardado ("Guardar Progreso") sin sesión Terminada — RPC
// get_unfinished_ci_sessions (mig 147). Diagnóstico BEST-EFFORT (ver
// comentario de la migración): sirve para saber a quién preguntarle, no como
// fuente de verdad absoluta (zona legacy mezclada en datos viejos puede
// generar algún falso positivo/negativo puntual).
//
// "Cerrar sesión" (mig 153, admin_close_ci_session): antes este panel era
// solo lectura — con "Terminar Sesión" ahora exigiendo siempre la grilla
// completa (Fase A), esto pasa a ser la red de seguridad real para cuando a
// un hub se le corta la sesión de verdad. NUNCA toca pricing_observations —
// solo cierra la contabilidad de la sesión (fila en ci_sessions marcada
// closed_by, limpia el latido si seguía vivo).
export default function UnfinishedSessionsPanel({ rows, onClosed }) {
  const { t, locale } = useI18n()
  const { country } = useCountry()
  const [closingKey, setClosingKey] = useState(null)
  const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(locale) : '—')

  async function handleClose(r, key) {
    if (!window.confirm(t('monitoring.close_session_confirm', { hub: r.uploaded_by }))) return
    setClosingKey(key)
    const { error } = await sb.rpc('admin_close_ci_session', {
      p_country: country,
      p_city: r.city,
      p_zone: r.zone ?? null,
      p_observed_date: r.observed_date,
      p_user_email: r.uploaded_by,
    })
    setClosingKey(null)
    if (error) {
      window.alert(t('monitoring.close_session_error'))
      return
    }
    onClosed?.()
  }

  return (
    <div className="mon-panel">
      <div className="mon-panel__head">
        <h2>{t('monitoring.unfinished_title')}</h2>
      </div>
      <div className="mon-panel__subtitle">{t('monitoring.unfinished_subtitle')}</div>

      {rows.length === 0 ? (
        <div className="mon-empty">{t('monitoring.unfinished_empty')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="de-history-table">
            <thead>
              <tr>
                <th>{t('dataentry.col_date')}</th>
                <th>{t('dataentry.col_city')}</th>
                <th>{t('monitoring.col_zone')}</th>
                <th>{t('monitoring.col_hub')}</th>
                <th>{t('monitoring.col_rows')}</th>
                <th>{t('monitoring.col_categories')}</th>
                <th>{t('monitoring.col_competitors')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const key = `${r.city}|${r.zone || ''}|${r.observed_date}|${r.uploaded_by}|${i}`
                return (
                  <tr key={key}>
                    <td>{fmtDate(r.observed_date)}</td>
                    <td>{getCityLabel(r.city)}</td>
                    <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>{r.zone || '—'}</td>
                    <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>{r.uploaded_by}</td>
                    <td>
                      <strong>{Number(r.n_rows) || 0}</strong>
                    </td>
                    <td>{Number(r.n_categories) || 0}</td>
                    <td>{Number(r.n_competitors) || 0}</td>
                    <td>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={closingKey === key}
                        onClick={() => handleClose(r, key)}
                      >
                        {closingKey === key
                          ? t('monitoring.closing_session')
                          : t('monitoring.close_session')}
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

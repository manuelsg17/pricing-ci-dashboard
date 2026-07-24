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
  // Claves ya cerradas con éxito pero que `rows` (prop) todavía no refleja
  // porque el `onClosed` (reload async del padre) sigue en vuelo — sin esto,
  // el botón se reactivaba apenas volvía la RPC y un admin apurado podía
  // volver a cerrarla antes del reload, insertando una segunda fila bogus en
  // ci_sessions (started_at=now(), duration=0) que además gana el desempate
  // en get_hub_monitoring por tener el id más alto.
  const [closedKeys, setClosedKeys] = useState(() => new Set())
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
    if (error) {
      setClosingKey(null)
      window.alert(t('monitoring.close_session_error'))
      return
    }
    setClosedKeys((prev) => new Set(prev).add(key))
    await onClosed?.()
    setClosingKey(null)
  }

  // Relevo entre hubs (mig 160, pedido user 2026-07-24): reasigna lo YA
  // GUARDADO de r.uploaded_by → el email tipeado, y cierra la sesión de
  // origen si seguía activa. Mismo patrón defensivo de closedKeys/closingKey
  // que "Cerrar sesión" arriba — reusa `closedKeys` porque una fila reasignada
  // tampoco debe seguir ofreciendo ninguna de las 2 acciones (ya no es "de"
  // ese hub).
  const [reassignInputs, setReassignInputs] = useState({})
  const [reassigningKey, setReassigningKey] = useState(null)

  async function handleReassign(r, key) {
    const to = (reassignInputs[key] || '').trim()
    if (!to) return
    if (!window.confirm(t('monitoring.reassign_confirm', { from: r.uploaded_by, to }))) return
    setReassigningKey(key)
    const { error } = await sb.rpc('admin_reassign_ci_session', {
      p_country: country,
      p_city: r.city,
      p_zone: r.zone ?? null,
      p_observed_date: r.observed_date,
      p_from_email: r.uploaded_by,
      p_to_email: to,
    })
    if (error) {
      setReassigningKey(null)
      window.alert(t('monitoring.reassign_error'))
      return
    }
    setClosedKeys((prev) => new Set(prev).add(key))
    await onClosed?.()
    setReassigningKey(null)
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
                <th>{t('monitoring.reassign_label')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const key = `${r.city}|${r.zone || ''}|${r.observed_date}|${r.uploaded_by}|${i}`
                const rowDisabled =
                  closingKey === key || reassigningKey === key || closedKeys.has(key)
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
                        disabled={rowDisabled}
                        onClick={() => handleClose(r, key)}
                      >
                        {closingKey === key
                          ? t('monitoring.closing_session')
                          : t('monitoring.close_session')}
                      </Button>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          type="text"
                          placeholder={t('monitoring.reassign_placeholder')}
                          value={reassignInputs[key] || ''}
                          disabled={rowDisabled}
                          onChange={(e) =>
                            setReassignInputs((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          style={{ width: 150, fontSize: 12 }}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={rowDisabled || !(reassignInputs[key] || '').trim()}
                          onClick={() => handleReassign(r, key)}
                        >
                          {reassigningKey === key
                            ? t('monitoring.reassigning')
                            : t('monitoring.reassign_button')}
                        </Button>
                      </div>
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

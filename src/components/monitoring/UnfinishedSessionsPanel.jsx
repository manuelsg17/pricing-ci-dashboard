import { useState } from 'react'
import { getCityLabel } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'
import { useCountry } from '../../context/CountryContext'
import { Button } from '../ui/shadcn/button'
import { useUnfinishedSessionActions } from '../../hooks/useUnfinishedSessionActions'

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
  // Las RPCs viven en useUnfinishedSessionActions.js; acá queda la UI.
  const { closeSession, reassignSession } = useUnfinishedSessionActions(country)
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
    const { data, error } = await closeSession(r)
    if (error) {
      setClosingKey(null)
      window.alert(t('monitoring.close_session_error'))
      return
    }
    // La mig 198 cambió el retorno de `void` a `{id, duplicado, cerrada}`, y
    // este cliente seguía mirando SOLO `error`. Sin esto, un `cerrada:false`
    // —que NO es un error— se leía como éxito: la fila se marcaba resuelta, el
    // botón se deshabilitaba, y la sesión nunca entraba a ci_sessions.
    //
    // Y no es un caso raro: `ci_active_sessions` tiene PK `user_email`, o sea
    // UNA fila de latido por hub. Cualquier bucket que no sea el que el hub
    // tiene abierto ahora mismo no tiene latido que cerrar — y son justo esos
    // los que este panel lista, porque `get_unfinished_ci_sessions` busca
    // observaciones sin fila en ci_sessions, sin mirar el latido.
    //
    // Fallar en silencio acá es lo peor que puede pasar: este botón es la red
    // de seguridad para cuando a un hub se le corta la sesión de verdad.
    if (data && data.cerrada === false) {
      setClosingKey(null)
      window.alert(
        data.id
          ? t('monitoring.close_session_already', { id: data.id })
          : t('monitoring.close_session_nothing')
      )
      // No se marca como cerrada: la fila TIENE que seguir en el panel.
      await onClosed?.()
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
    const { error } = await reassignSession(r, to)
    if (error) {
      setReassigningKey(null)
      // La mig 207 rechaza destinos que no existen, están dados de baja, o no
      // tienen el país. Ese caso NO es un fallo del sistema sino un dato mal
      // tipeado, y decirlo así es la diferencia entre corregir la letra y
      // llamar a soporte. El mensaje genérico queda para todo lo demás.
      const esDestinoInvalido = /invalid_input/.test(String(error.message || ''))
      window.alert(
        esDestinoInvalido
          ? t('monitoring.reassign_invalid_target', { to })
          : t('monitoring.reassign_error')
      )
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
        <div className="mon-table-scroll">
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
                      <div className="mon-reassign">
                        <input
                          type="text"
                          placeholder={t('monitoring.reassign_placeholder')}
                          value={reassignInputs[key] || ''}
                          disabled={rowDisabled}
                          onChange={(e) =>
                            setReassignInputs((prev) => ({ ...prev, [key]: e.target.value }))
                          }
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

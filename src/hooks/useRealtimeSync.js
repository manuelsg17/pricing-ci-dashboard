import { useEffect, useRef } from 'react'
import { sb, SESSION_ID } from '../lib/supabase'

// ════════════════════════════════════════════════════════════════════════
// useRealtimeSync — live-sync entre sesiones
//
// QUÉ HACE:
//   Se suscribe vía Supabase Realtime a INSERTs en audit_log (mig 62).
//   Cada vez que OTRA sesión modifica una tabla auditada, este hook:
//     1. Despacha un CustomEvent 'config:changed' con { table, country }
//        para que CountryContext / hooks de config refetcheen.
//     2. Llama a onForeignChange(meta) para que el componente raíz
//        muestre un toast localizado.
//
// POR QUÉ AUDIT_LOG (y no postgres_changes en cada tabla):
//   - Una sola suscripción cubre 17 tablas auditadas → menos WS overhead.
//   - audit_log incluye user_email y session_id → podemos filtrar
//     "mis propios cambios" de forma confiable.
//   - Postgres_changes a tablas con cambios frecuentes (ej: bracket_weights
//     bulk inserts) saturaría el canal con ruido sin metadatos.
//
// CUENTAS COMPARTIDAS:
//   Si dos browsers comparten la misma cuenta, session_id distingue.
//   El toast varía: si user_email === yo, decimos "otra sesión"; si no,
//   decimos "Admin X" (futuro con cuentas individuales).
// ════════════════════════════════════════════════════════════════════════

// Tablas que disparan refetch automático en el dashboard. Las que NO están
// acá (ej: market_events) generan audit log pero no fuerzan refetch — el
// usuario verá los cambios en la próxima navegación.
const REFETCHABLE_TABLES = new Set([
  'country_config',
  'catalog_extras',
  'bot_rules',
  'distance_thresholds',
  'bracket_weights',
  'bracket_weights_by_category',
  'semaforo_config',
  'rush_hour_windows',
  'surge_windows',
  'price_validation_rules',
  'indrive_config',
  'distance_references',
  'ci_timeslots',
  'airport_markers',
])

// Tablas que SIEMPRE muestran toast (cambios visibles inmediatamente al
// usuario actual). Si table está fuera, refetcheamos en silencio.
const TOAST_WORTHY_TABLES = new Set([
  'country_config',
  'catalog_extras',
  'bot_rules',
  'distance_thresholds',
  'bracket_weights',
  'bracket_weights_by_category',
  'semaforo_config',
])

/**
 * @param {Object}   opts
 * @param {string?}  opts.myEmail       — email del usuario logueado (para
 *                                        detectar "es mi cuenta vs otra")
 * @param {boolean}  opts.enabled       — si false, no se suscribe (útil
 *                                        antes del login)
 * @param {function} opts.onForeignChange — callback(meta) cuando OTRA
 *                                        sesión escribe. meta = {
 *                                        table, action, country,
 *                                        userEmail, sameUser, isSameSession }
 */
export function useRealtimeSync({ myEmail, enabled = true, onForeignChange }) {
  // refs para que cambios en callbacks no recreen la suscripción
  const callbackRef = useRef(onForeignChange)
  const myEmailRef = useRef(myEmail)

  useEffect(() => {
    callbackRef.current = onForeignChange
  }, [onForeignChange])
  useEffect(() => {
    myEmailRef.current = myEmail
  }, [myEmail])

  // Debounce de despacho `config:changed` por tabla: un bulk INSERT del bot
  // genera N audit_log rows que llegan en cascada. Sin debounce cada hook
  // suscrito refetchea N veces. Coalescemos eventos por tabla con timer
  // de 500ms — el toast sí se muestra inmediato (eventos visibles al user
  // no se deben demorar).
  const debounceRef = useRef(new Map())

  useEffect(() => {
    if (!enabled) return

    const timers = debounceRef.current
    const channel = sb
      .channel('audit-log-sync')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'audit_log' },
        (payload) => {
          const row = payload?.new
          if (!row) return

          // Ignorar mis propios cambios (mismo session_id) — sí lo refetcheo
          // localmente pero no muestro toast.
          const isSameSession = row.session_id === SESSION_ID

          const table = row.table_name
          const action = row.action
          const country = row.country
          const userEmail = row.user_email
          const sameUser =
            !!myEmailRef.current &&
            !!userEmail &&
            userEmail.toLowerCase() === myEmailRef.current.toLowerCase()

          // Despachar evento debounced por tabla (coalesce de bulk inserts)
          if (REFETCHABLE_TABLES.has(table)) {
            const prev = timers.get(table)
            if (prev) clearTimeout(prev)
            timers.set(
              table,
              setTimeout(() => {
                timers.delete(table)
                window.dispatchEvent(
                  new CustomEvent('config:changed', {
                    detail: { table, action, country, userEmail, isSameSession },
                  })
                )
              }, 500)
            )
          }

          // Toast inmediato si NO es mi sesión Y la tabla justifica notificación
          if (!isSameSession && TOAST_WORTHY_TABLES.has(table)) {
            callbackRef.current?.({
              table,
              action,
              country,
              userEmail,
              sameUser,
              isSameSession,
            })
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.info('[realtime] audit-log-sync subscribed')
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[realtime] subscription issue:', status)
        }
      })

    return () => {
      sb.removeChannel(channel)
      timers.forEach((t) => clearTimeout(t))
      timers.clear()
    }
  }, [enabled])
}

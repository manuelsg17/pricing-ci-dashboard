import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { upsertActiveSession } from './useDataEntryPersistence'

// Extraído de DataEntry.jsx (revisión 2026-09, segundo corte del refactor —
// ver useCiTabLease.js para el primero). Latido de sesión activa para
// Monitoreo: mientras `sessionActive`, avisa periódicamente "sigo acá, en
// tal ciudad/distrito, con tanto progreso" (mig 146 — tabla
// `ci_active_sessions` + RPC `upsert_ci_active_session`). Nunca debe afectar
// el flujo real del hub: todo en try/catch silencioso, jamás toca `setMsg`
// ni bloquea el guardado.
//
// @param {object} p
// @param {boolean} p.sessionActive
// @param {string} p.userEmail
// @param {import('react').RefObject<boolean>} p.leaseOwnerRef
// @param {import('react').RefObject<boolean>} p.hbLeaseOwnerRef
// @param {string} p.country
// @param {string} p.dbCity
// @param {string|null} p.zone
// @param {string} p.date
// @param {number} p.filledCount
// @param {number} p.totalExpected
// @param {unknown} p.fronts
// @param {unknown} p.totalExpectedPerTimeslot
// @param {unknown} p.filledByTimeslot
// @param {unknown} p.turnoTimings
// @param {unknown[]|null} p.activeAirportMembers
// @param {string[]} p.pendingScopeMembers
// @param {(uiCity: string) => string} p.bucketKeyOf
// @param {string} p.bucketKey
// @returns {{ lastHeartbeatOkAt: number|null }}
export function useCiHeartbeat({
  sessionActive,
  userEmail,
  leaseOwnerRef,
  hbLeaseOwnerRef,
  country,
  dbCity,
  zone,
  date,
  filledCount,
  totalExpected,
  fronts,
  totalExpectedPerTimeslot,
  filledByTimeslot,
  turnoTimings,
  activeAirportMembers,
  pendingScopeMembers,
  bucketKeyOf,
  bucketKey,
}) {
  const [lastHeartbeatOkAt, setLastHeartbeatOkAt] = useState(null) // solo conexión

  // Alcance declarado (mig 151, solo Aeropuerto) — para que Monitoreo
  // muestre "Aeropuerto A+B" en vez de solo la pestaña momentánea, que
  // confunde cuando el hub está alternando entre Punto A y Punto B dentro de
  // la MISMA sesión declarada como "Ambos".
  const scopeLabel = useMemo(
    () =>
      activeAirportMembers && pendingScopeMembers.length
        ? activeAirportMembers
            .filter((m) => pendingScopeMembers.includes(bucketKeyOf(m.uiCity)))
            .map((m) => m.side)
            .join('+')
        : null,
    [activeAirportMembers, pendingScopeMembers, bucketKeyOf]
  )

  const heartbeatRef = useRef(null)
  heartbeatRef.current = {
    country,
    city: dbCity,
    zone,
    date,
    filledCount,
    totalExpected,
    fronts,
    // Desglose por turno (mig 150) — para que Monitoreo muestre en qué
    // turno está cada hub, no solo el total agregado.
    // `timings` viaja en el mismo jsonb que ya usa Monitoreo (turno_progress) —
    // clave nueva, aditiva: LiveSessionsPanel solo lee .filled/.total_per_turno,
    // no rompe nada. Persiste en vivo cada heartbeat (~25s) para no perder el
    // dato si el navegador se cierra antes de Terminar Sesión.
    turnoProgress: {
      total_per_turno: totalExpectedPerTimeslot,
      filled: filledByTimeslot,
      timings: turnoTimings,
    },
    scopeLabel,
  }

  // Fallos de latido consecutivos (mig 149) — contador puramente local, se
  // reporta en el próximo latido exitoso para que Monitoreo (admin) pueda
  // distinguir "esta sesión tuvo problemas intermitentes de red" de "el hub
  // cerró la laptop" — ambos se ven idénticos si solo se mira last_seen_at.
  const heartbeatFailStreakRef = useRef(0)

  const sendHeartbeat = useCallback(async () => {
    // `ci_active_sessions` tiene PK `user_email`: UNA sola fila por hub. Dos
    // pestañas latiendo la hacen saltar entre buckets y corrompen
    // `started_at`, que es la fuente de la duración.
    //
    // Se corta el ENVÍO, NO se borra la fila: borrarla al degradarse repetiría
    // el bug P1-4 (el hub desaparece de "en vivo" y se pierde el inicio real).
    //
    // DOS candados, porque el de borrador NO alcanza: su alcance incluye la
    // vista y la fecha, así que dos pestañas del mismo hub en frentes
    // distintos lo pasan las dos. El del latido es global por hub, que es el
    // alcance de la fila que se está por escribir.
    if (!leaseOwnerRef.current || !hbLeaseOwnerRef.current) return
    const p = heartbeatRef.current
    if (!p || !p.city) return
    try {
      const failures = heartbeatFailStreakRef.current
      const { error } = await upsertActiveSession(p, failures)
      // supabase-js NO tira excepción por un error a nivel Postgres/RPC (solo
      // por fallos de red) — sin este chequeo explícito, un error del lado del
      // servidor (RLS, función ambigua, etc.) se contaba como latido exitoso.
      if (error) throw error
      heartbeatFailStreakRef.current = 0
      // Confirmación real de servidor — ver indicador "confirmado en
      // servidor" en el header. Un latido exitoso ya prueba que el backend
      // nos escucha, no hace falta esperar a un guardado explícito.
      setLastHeartbeatOkAt(Date.now())
    } catch {
      // best-effort: un fallo acá nunca debe interrumpir al hub (el
      // indicador de servidor simplemente no se refresca y va envejeciendo
      // hasta mostrar el aviso — ver umbral abajo). Sí se cuenta para
      // reportarlo en el próximo latido exitoso (ver arriba).
      heartbeatFailStreakRef.current += 1
    }
    // Refs de useLeaseState: identidad estable entre renders.
  }, [leaseOwnerRef, hbLeaseOwnerRef])

  // Piso de confiabilidad: late cada ~25s mientras la sesión esté activa,
  // sin importar si el hub está tipeando (evita que last_seen_at se vea
  // "viejo" solo porque está mirando distancias/fotos sin escribir).
  useEffect(() => {
    if (!sessionActive || !userEmail) return
    sendHeartbeat()
    const id = setInterval(sendHeartbeat, 25_000)
    return () => clearInterval(id)
  }, [sessionActive, userEmail, sendHeartbeat])

  // Ping extra con el mismo debounce que el autosave del borrador — refleja
  // un cambio de distrito/progreso más rápido que el intervalo de 25s.
  useEffect(() => {
    if (!sessionActive || !userEmail) return
    const id = setTimeout(sendHeartbeat, 1500)
    return () => clearTimeout(id)
  }, [sessionActive, userEmail, bucketKey, date, filledCount, sendHeartbeat])

  return { lastHeartbeatOkAt }
}

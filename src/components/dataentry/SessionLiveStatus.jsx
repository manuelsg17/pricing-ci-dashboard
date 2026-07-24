import { useState, useEffect, useMemo } from 'react'
import { LIVE_STALE_MS } from '../../lib/monitoring'

// Widgets del header de Ingresar CI que se actualizan cada segundo (cronómetro
// de sesión + indicadores de "guardado/confirmado hace Xs"). Viven acá, en
// componentes propios con su PROPIO setInterval, para que el tick por segundo
// re-renderice SOLO estos widgets y no todo DataEntry — antes, tener este
// estado en el componente padre reconciliaba los cientos de inputs de la grilla
// una vez por segundo durante toda la sesión activa (jank permanente al tipear
// en laptops modestas). Ver auditoría de rendimiento.

function fmtElapsed(ms) {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// Cronómetro ⏱ de la sesión activa. `sessionStart` es el timestamp (ms) de
// inicio; cuando cambia (reabrir sesión reinicia el cronómetro) el effect se
// re-corre y el reloj vuelve a 00:00 solo.
export function SessionTimer({ sessionStart, title }) {
  const [elapsed, setElapsed] = useState(() =>
    fmtElapsed(Date.now() - (sessionStart ?? Date.now()))
  )

  useEffect(() => {
    setElapsed(fmtElapsed(Date.now() - sessionStart))
    const id = setInterval(() => {
      setElapsed(fmtElapsed(Date.now() - sessionStart))
    }, 1000)
    return () => clearInterval(id)
  }, [sessionStart])

  return (
    <div className="de-timer de-timer--active" title={title}>
      ⏱ {elapsed}
    </div>
  )
}

// Indicadores de guardado: "guardado automáticamente hace Xs" (borrador local)
// y "confirmado en servidor hace Xs" / aviso de no-confirmado. Reusa el mismo
// umbral de 3 min (LIVE_STALE_MS) que Monitoreo. Comportamiento idéntico al que
// estaba inline en DataEntry.
export function SaveStatusIndicators({
  sessionActive,
  sessionStart,
  lastDraftSavedAt,
  lastServerOkAt,
  t,
}) {
  const [nowTick, setNowTick] = useState(() => Date.now())

  // Corre también con sessionActive solo (sin timestamp aún): si el PRIMER
  // latido nunca se confirma, el reloj debe avanzar para que el aviso de "no
  // confirmado" escale a los 3 min. Mismo criterio que el effect original.
  useEffect(() => {
    if (!sessionActive && lastDraftSavedAt == null && lastServerOkAt == null) return
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [sessionActive, lastDraftSavedAt, lastServerOkAt])

  const serverConfirmState = useMemo(() => {
    if (!sessionActive) return null
    const ref = lastServerOkAt ?? sessionStart
    if (ref == null) return null
    const age = nowTick - ref
    if (age <= LIVE_STALE_MS) {
      return lastServerOkAt != null ? { kind: 'ok', s: Math.max(0, Math.floor(age / 1000)) } : null
    }
    return { kind: 'warn', m: Math.max(1, Math.floor(age / 60_000)) }
  }, [sessionActive, lastServerOkAt, sessionStart, nowTick])

  return (
    <>
      {lastDraftSavedAt != null && (
        <span className="de-autosave-indicator">
          {t('dataentry.autosaved_ago', {
            s: Math.max(0, Math.floor((nowTick - lastDraftSavedAt) / 1000)),
          })}
        </span>
      )}
      {serverConfirmState?.kind === 'ok' && (
        <span className="de-server-ok-indicator">
          {t('dataentry.server_confirmed_ago', { s: serverConfirmState.s })}
        </span>
      )}
      {serverConfirmState?.kind === 'warn' && (
        <span className="de-server-warn-indicator">
          {t('dataentry.server_unconfirmed_warn', { m: serverConfirmState.m })}
        </span>
      )}
    </>
  )
}

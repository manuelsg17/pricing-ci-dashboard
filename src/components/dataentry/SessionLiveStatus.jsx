import { useState, useEffect } from 'react'
import { estadoDeGuardado, estadoDeServidor } from '../../lib/sessionPersistence'

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
  // `sessionStart` puede llegar null: al cerrar la sesión (cambio de fecha o
  // de país) se limpia el ref de forma SÍNCRONA, mientras que el
  // `setSessionActive(false)` que desmonta este componente es asíncrono — hay
  // un render en el medio con la sesión todavía activa y el inicio ya en null.
  //
  // Sin el guard, `Date.now() - null` es `Date.now()`: el cronómetro mostraría
  // ~56 años. El estado inicial ya lo contemplaba, el efecto no.
  const desde = sessionStart ?? Date.now()

  const [elapsed, setElapsed] = useState(() => fmtElapsed(Date.now() - desde))

  useEffect(() => {
    const base = sessionStart ?? Date.now()
    setElapsed(fmtElapsed(Date.now() - base))
    const id = setInterval(() => {
      setElapsed(fmtElapsed(Date.now() - base))
    }, 1000)
    return () => clearInterval(id)
  }, [sessionStart])

  return (
    <div className="de-timer de-timer--active" title={title}>
      ⏱ {elapsed}
    </div>
  )
}

// Indicadores de guardado.
//
// EL PUNTO DE ESTE COMPONENTE: decirle al hub la VERDAD sobre dónde está su
// trabajo. Antes había un solo timestamp que el LATIDO también refrescaba, así
// que "✓ Confirmado en servidor hace 4s" podía verse toda la sesión sin haber
// guardado una sola celda (SESIONES_HALLAZGOS.md P2-14). Un latido prueba que
// hay conexión; no prueba durabilidad.
//
// Toda la decisión de qué mostrar vive en src/lib/sessionPersistence.js, que
// tiene test propio (scripts/test-session-persistence.mjs) — acá solo se
// traduce a pantalla.
export function SaveStatusIndicators({
  sessionActive,
  lastDraftSavedAt,
  lastSaveOkAt,
  lastHeartbeatOkAt,
  filledCount = 0,
  savableCount = 0,
  editSeqRef,
  savedSeqRef,
  t,
}) {
  const [nowTick, setNowTick] = useState(() => Date.now())

  // Corre también con sessionActive solo: si el primer latido nunca se
  // confirma, el reloj debe avanzar para que el aviso escale.
  useEffect(() => {
    if (!sessionActive && lastDraftSavedAt == null && lastSaveOkAt == null) return
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [sessionActive, lastDraftSavedAt, lastSaveOkAt])

  // Los contadores de edición viajan por REF para no re-renderizar la grilla
  // en cada tecleo (CLAUDE.md §5). Se leen en el tick de 1s: un segundo de
  // atraso es irrelevante para este cartel.
  const guardado = estadoDeGuardado({
    filledCount,
    savableCount,
    editSeq: editSeqRef?.current ?? 0,
    savedSeq: savedSeqRef?.current ?? -1,
  })

  const servidor = estadoDeServidor({
    sessionActive,
    lastSaveOkAt,
    lastHeartbeatOkAt,
    hayCambiosSinGuardar: guardado.hayCambiosSinGuardar,
    soloLocal: guardado.soloLocal,
    now: nowTick,
  })

  return (
    <>
      {lastDraftSavedAt != null && (
        <span className="de-autosave-indicator" title={t('dataentry.draft_only_hint')}>
          {t('dataentry.autosaved_ago', {
            s: Math.max(0, Math.floor((nowTick - lastDraftSavedAt) / 1000)),
          })}
        </span>
      )}

      {servidor?.kind === 'guardado' && (
        <span className="de-server-ok-indicator">
          {t('dataentry.saved_on_server_ago', { s: servidor.segundos })}
        </span>
      )}

      {servidor?.kind === 'guardado_parcial' && (
        <span className="de-server-partial-indicator" title={t('dataentry.only_local_hint')}>
          {t('dataentry.saved_but_local', { n: servidor.soloLocal })}
        </span>
      )}

      {servidor?.kind === 'sin_guardar' && (
        <span className="de-server-pending-indicator">{t('dataentry.unsaved_changes')}</span>
      )}

      {servidor?.kind === 'nada_guardado' && (
        <span className="de-server-pending-indicator">{t('dataentry.nothing_saved_yet')}</span>
      )}

      {servidor?.kind === 'sin_conexion' && (
        <span className="de-server-warn-indicator">
          {servidor.minutos == null
            ? t('dataentry.no_server_contact')
            : t('dataentry.no_server_contact_min', { m: servidor.minutos })}
        </span>
      )}
    </>
  )
}

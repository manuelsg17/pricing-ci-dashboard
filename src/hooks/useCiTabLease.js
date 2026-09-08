import { useState, useRef, useEffect, useCallback } from 'react'
import { SESSION_ID } from '../lib/supabase'
import {
  evaluateLease,
  serializeLease,
  ownsLease,
  leaseKey,
  heartbeatLeaseKey,
  LEASE_RENEW_MS,
} from '../lib/tabLease'

// Extraído de DataEntry.jsx (revisión 2026-09): dos candados independientes
// (borrador por bucket, latido global por hub) que antes vivían mezclados en
// medio del componente de 5.000 líneas. Misma lógica, sin cambios de
// comportamiento — ver la migración original para el detalle de cada regla.
//
// Partido en DOS hooks, no uno, por una razón de orden de declaración: el
// resto de DataEntry.jsx lee `leaseOwnerRef.current`/`hbLeaseOwnerRef.current`
// en efectos que aparecen ANTES, en el archivo, de donde hay datos
// suficientes (`filledCount`) para calcular `leaseEngaged`. `useLeaseState`
// se llama temprano (da los refs ya disponibles); `useCiTabLeaseEffects` se
// llama donde antes vivía el efecto real, más abajo.
//
// ── Por qué "marcar ocioso" y NUNCA borrar en `pagehide` ──────────────────
// Un `removeItem` en pagehide (F5, cerrar pestaña) es tentador pero repite un
// bug ya encontrado y corregido: si hay una SEGUNDA pestaña real y activa, el
// `removeItem` dispara su evento `storage` de inmediato y esa otra pestaña
// reclama el candado ANTES de que la pestaña que se recarga termine de
// montar React — la que tiene el trabajo de verdad queda en modo lectura.
// Marcarlo "ocioso" (mismo SID, `engaged:false`) en cambio deja el candado
// reconocible: como SESSION_ID sobrevive un F5 real (vive en
// `sessionStorage`), la propia pestaña recargada se re-reclama a sí misma en
// el primer tick (`lease.sid === mySid` → 'renew'), y solo cede el paso si
// OTRA pestaña con trabajo real la reclama a propósito.
function markIdle(key) {
  try {
    if (ownsLease(localStorage.getItem(key), SESSION_ID)) {
      localStorage.setItem(
        key,
        serializeLease({ sid: SESSION_ID, now: Date.now(), engaged: false })
      )
    }
  } catch {
    /* sin storage no hay candado que marcar */
  }
}

/** Estado + refs de los dos candados. Llamar temprano en el componente. */
export function useLeaseState() {
  const [leaseOwner, setLeaseOwner] = useState(true)
  const leaseOwnerRef = useRef(true)
  leaseOwnerRef.current = leaseOwner

  const [hbLeaseOwner, setHbLeaseOwner] = useState(true)
  const hbLeaseOwnerRef = useRef(true)
  hbLeaseOwnerRef.current = hbLeaseOwner

  return {
    leaseOwner,
    setLeaseOwner,
    leaseOwnerRef,
    hbLeaseOwner,
    setHbLeaseOwner,
    hbLeaseOwnerRef,
  }
}

/**
 * Efectos de los dos candados. Llamar donde ya se conoce `filledCount`.
 *
 * @param {object} p
 * @param {string} p.draftKey
 * @param {string} p.userEmail
 * @param {boolean} p.sessionActive
 * @param {number} p.filledCount
 * @param {boolean} p.leaseOwner
 * @param {(v: boolean) => void} p.setLeaseOwner
 * @param {(v: boolean) => void} p.setHbLeaseOwner
 * @returns {() => void} claimDraftLease — "Usar esta pestaña"
 */
export function useCiTabLeaseEffects({
  draftKey,
  userEmail,
  sessionActive,
  filledCount,
  leaseOwner,
  setLeaseOwner,
  setHbLeaseOwner,
}) {
  // `engaged` = esta pestaña tiene trabajo de verdad. Una pestaña abierta
  // solo para mirar no puede bloquear a la pestaña donde el hub va a
  // trabajar.
  //
  // BUG REAL encontrado en navegador (2026-09-07, verificado con dos
  // pestañas reales del mismo hub sobre el mismo bucket): `filledCount > 0`
  // a secas NO distingue "yo tengo trabajo" de "estoy mirando el borrador
  // compartido de otra pestaña" — la hidratación del borrador llena
  // `entries` (y por lo tanto `filledCount`) en CUALQUIER pestaña que abra
  // ese bucket, sea o no la dueña del candado. Repro: pestaña A dueña y
  // trabajando, pestaña B abre el mismo bucket (sin iniciar sesión, sin
  // escribir nada) y hereda `filledCount > 0` del borrador restaurado → B
  // se cuenta "engaged" solo por mirar. Si A hace F5 justo en la ventana en
  // que su candado queda marcado ocioso (ver `markIdle`), B lo reclama antes
  // de que A se re-reclame a sí misma, y la pestaña que SÍ tiene el trabajo
  // queda en modo lectura después de su propio F5.
  //
  // Fix: además de `sessionActive`, `filledCount` solo cuenta como trabajo
  // propio si esta pestaña YA es (o acaba de ser) la dueña del candado.
  // Una pestaña que nunca ganó el candado no puede volverse "engaged" solo
  // por haber restaurado datos ajenos.
  const leaseEngaged = sessionActive || (filledCount > 0 && leaseOwner)

  // "Usar esta pestaña": el hub reclama el candado a mano (la otra pestaña
  // se degrada sola por el evento `storage`, así que nunca escriben las
  // dos). Es la salida para el caso más común — la otra pestaña ya está
  // cerrada y el lease todavía no venció — sin obligar a recargar.
  const claimDraftLease = useCallback(() => {
    const lKey = leaseKey(draftKey)
    try {
      localStorage.setItem(
        lKey,
        serializeLease({ sid: SESSION_ID, now: Date.now(), engaged: leaseEngaged })
      )
      setLeaseOwner(ownsLease(localStorage.getItem(lKey), SESSION_ID))
    } catch {
      setLeaseOwner(true)
    }
  }, [draftKey, leaseEngaged, setLeaseOwner])

  useEffect(() => {
    const lKey = leaseKey(draftKey)
    let vivo = true

    const tick = () => {
      if (!vivo) return
      let raw = null
      try {
        raw = localStorage.getItem(lKey)
      } catch {
        // Sin localStorage no hay candado posible. Se sigue como dueño: el
        // guard de servidor (mig 191) es el backstop, y degradar acá dejaría
        // a una pestaña única sin autosave — una forma NUEVA de perder datos.
        setLeaseOwner(true)
        return
      }

      const { action } = evaluateLease({
        raw,
        mySid: SESSION_ID,
        now: Date.now(),
        myEngaged: leaseEngaged,
      })
      if (action === 'demote') {
        setLeaseOwner(false)
        return
      }
      try {
        localStorage.setItem(
          lKey,
          serializeLease({ sid: SESSION_ID, now: Date.now(), engaged: leaseEngaged })
        )
        // RELECTURA obligatoria: dos pestañas restauradas en el mismo tick por
        // el crash-recovery de Chrome leen la clave vacía las dos y escriben
        // las dos. Sin releer, ambas se creen dueñas y el bug vuelve entero.
        setLeaseOwner(ownsLease(localStorage.getItem(lKey), SESSION_ID))
      } catch {
        setLeaseOwner(true)
      }
    }

    tick()
    const id = setInterval(tick, LEASE_RENEW_MS)

    // Otra pestaña escribió el lease: reaccionar YA. Sin esto la degradación
    // tarda hasta 30s, y en esa ventana las dos escriben el borrador.
    const onStorage = (e) => {
      if (e.key === lKey) tick()
    }
    window.addEventListener('storage', onStorage)
    // F5 / cerrar pestaña: marcar ocioso, NUNCA borrar (ver comentario del
    // archivo). El flush de borrador en DataEntry.jsx hace la misma marca
    // sobre esta misma clave — repetirlo acá es idempotente.
    const onPageHide = () => markIdle(lKey)
    window.addEventListener('pagehide', onPageHide)

    return () => {
      vivo = false
      clearInterval(id)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('pagehide', onPageHide)
      // Cleanup normal (cambio de bucket, NO cierre de pestaña): acá sí se
      // libera del todo — el hub se fue de este bucket, no solo recargó.
      try {
        if (ownsLease(localStorage.getItem(lKey), SESSION_ID)) localStorage.removeItem(lKey)
      } catch {
        /* sin storage no hay nada que liberar */
      }
    }
  }, [draftKey, leaseEngaged, setLeaseOwner])

  // ── Lease del LATIDO, global por hub ──────────────────────────────────
  // El lease de arriba protege el BORRADOR y su alcance —(usuario, país,
  // vista, fecha)— es el correcto para eso. El latido escribe otra cosa:
  // `ci_active_sessions`, con PK `user_email`, UNA fila por hub. Dos
  // pestañas en frentes distintos son dueñas cada una de su borrador, las
  // dos pasan el guard de arriba, y las dos laten sobre esa única fila: se
  // pisan el bucket y corrompen `started_at`. Y es el caso MÁS probable, no
  // el raro — el hub abre la segunda pestaña justamente porque está en otro
  // frente.
  //
  // Recurso distinto, alcance distinto. Ver `heartbeatLeaseKey` para por qué
  // esto se disputa SOLO entre pestañas que ya son dueñas de su borrador (si
  // no, hay un empate en el que nadie late y el hub desaparece de "en
  // vivo").
  useEffect(() => {
    const hbKey = heartbeatLeaseKey(userEmail)
    // Sin email todavía no hay a quién atribuirle el latido; `sendHeartbeat`
    // igual no manda nada sin `sessionActive`.
    if (!hbKey) return
    // No soy dueño de mi propio borrador: no compito por el latido. Es la
    // precondición que evita el empate en el que nadie late.
    if (!leaseOwner) {
      setHbLeaseOwner(false)
      return
    }

    let vivo = true
    const tick = () => {
      if (!vivo) return
      let raw = null
      try {
        raw = localStorage.getItem(hbKey)
      } catch {
        // Mismo criterio que el lease de borrador: sin localStorage no hay
        // candado posible, y degradar dejaría al hub sin latido — o sea,
        // invisible en Monitoreo. Se sigue como dueño.
        setHbLeaseOwner(true)
        return
      }

      const { action } = evaluateLease({
        raw,
        mySid: SESSION_ID,
        now: Date.now(),
        // Para el latido, "engaged" es tener la sesión activa: una pestaña
        // sin sesión no tiene nada que reportar y le cede el turno a la que
        // sí.
        myEngaged: sessionActive,
      })
      if (action === 'demote') {
        setHbLeaseOwner(false)
        return
      }
      try {
        localStorage.setItem(
          hbKey,
          serializeLease({ sid: SESSION_ID, now: Date.now(), engaged: sessionActive })
        )
        // Misma relectura obligatoria que arriba: dos pestañas restauradas
        // en el mismo tick leen la clave vacía las dos y escriben las dos.
        setHbLeaseOwner(ownsLease(localStorage.getItem(hbKey), SESSION_ID))
      } catch {
        setHbLeaseOwner(true)
      }
    }

    tick()
    const id = setInterval(tick, LEASE_RENEW_MS)
    const onStorage = (e) => {
      if (e.key === hbKey) tick()
    }
    window.addEventListener('storage', onStorage)
    // Mismo criterio que el candado de borrador: marcar ocioso en pagehide,
    // nunca borrar (ver comentario largo arriba del archivo).
    const onPageHide = () => markIdle(hbKey)
    window.addEventListener('pagehide', onPageHide)

    return () => {
      vivo = false
      clearInterval(id)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('pagehide', onPageHide)
      try {
        if (ownsLease(localStorage.getItem(hbKey), SESSION_ID)) localStorage.removeItem(hbKey)
      } catch {
        /* sin storage no hay nada que liberar */
      }
    }
  }, [userEmail, leaseOwner, sessionActive, setHbLeaseOwner])

  return claimDraftLease
}

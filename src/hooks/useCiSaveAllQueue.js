import { useState, useRef, useEffect } from 'react'
import { frontLabel } from '../lib/sessionFronts'
import { frentesSinGuardar } from '../lib/frentesPendientes'

const EMPTY_ARR = []

// Extraído de DataEntry.jsx (revisión 2026-09, octavo corte del refactor —
// ver useCiTabLease.js, useCiHeartbeat.js, useCiDraftAutosave.js,
// useCiDraftHydration.js, useCiSessionActions.js, useCiSessionHistory.js y
// useCiDraftManagement.js para los siete anteriores). "Guardar todo": recorre
// los frentes con trabajo sin asegurar, uno por uno, PARÁNDOSE en cada uno y
// reusando `handleSaveProgress` — nunca parametriza `buildRows`/`performSave`
// directamente, que es el camino por el que pasa todo guardado y concentra
// los bugs más caros del proyecto. Sin cambios de comportamiento.
//
// `frentesAbiertos`/`hayOtrosFrentes` se QUEDAN en DataEntry.jsx: además de
// alimentar esta cola, se usan para renderizar (el botón "Guardar todo" solo
// aparece si hay más de un frente, y `FrentesSinGuardar` los recibe como
// prop) — moverlos acá los hubiera duplicado o forzado a devolverlos de
// vuelta sin necesidad.
//
// @param {object} p
// @param {string} p.bucketKey
// @param {boolean} p.saving
// @param {boolean} p.refsLoading
// @param {string|null} p.refsDbCity
// @param {string} p.dbCity
// @param {number} p.savableCount
// @param {(bucketKey: string) => boolean} p.irAFrente
// @param {() => Promise<boolean>} p.handleSaveProgress
// @param {string[]} p.frentesAbiertos
// @param {object} p.llenoPorFrente
// @param {import('react').RefObject<object>} p.editSeqRef
// @param {import('react').RefObject<object>} p.savedSeqRef
// @param {import('react').RefObject<Set<string>>} p.hydratedCitiesRef
// @param {Function} p.setMsg
// @param {(t: string, params?: object) => string} p.t
// @param {(type: string, key: string, params?: object, opts?: object) => void} p.notify
// @returns {{ guardandoTodo: boolean, handleGuardarTodo: () => void }}
export function useCiSaveAllQueue({
  bucketKey,
  saving,
  refsLoading,
  refsDbCity,
  dbCity,
  savableCount,
  irAFrente,
  handleSaveProgress,
  frentesAbiertos,
  llenoPorFrente,
  editSeqRef,
  savedSeqRef,
  hydratedCitiesRef,
  setMsg,
  t,
  notify,
}) {
  const [colaGuardarTodo, setColaGuardarTodo] = useState(EMPTY_ARR)
  const guardandoTodo = colaGuardarTodo.length > 0
  // Reentrada: el efecto de abajo se re-dispara con cada tick mientras la cola
  // avanza, y sin este candado dispararía un segundo guardado del mismo frente
  // encima del primero.
  const colaOcupadaRef = useRef(false)
  // Dónde estaba parado el hub al apretar el botón, para devolverlo ahí. Que
  // "guardar" te mueva de pestaña sola es desorientador, y peor todavía si te
  // deja en un frente que no estabas mirando.
  const colaOrigenRef = useRef(null)
  const colaResultadoRef = useRef({ guardados: 0, sinFilas: [] })

  // Los contadores de edición viven en refs para no re-renderizar la grilla en
  // cada tecleo (CLAUDE.md §5), así que un cambio en ellos no despierta a
  // React. Mientras la cola avanza hace falta un pulso propio para volver a
  // mirar si el frente ya terminó de cargar. Solo corre mientras hay cola:
  // es una acción deliberada de unos segundos, no un sondeo de fondo.
  const [tickCola, setTickCola] = useState(0)
  useEffect(() => {
    if (!guardandoTodo) return
    const id = setInterval(() => setTickCola((n) => n + 1), 300)
    return () => clearInterval(id)
  }, [guardandoTodo])

  useEffect(() => {
    if (!colaGuardarTodo.length || colaOcupadaRef.current || saving) return

    const objetivo = colaGuardarTodo[0]
    if (bucketKey !== objetivo) {
      // Si el destino no existe en el catálogo, `irAFrente` no mueve nada: hay
      // que sacarlo de la cola igual o se queda girando para siempre.
      if (!irAFrente(objetivo)) setColaGuardarTodo((c) => c.slice(1))
      return
    }

    // Parados en el objetivo, pero puede que todavía esté cargando. Los tres
    // chequeos son distintos y los tres hacen falta: las rutas se piden por
    // ciudad (React Query), `refsDbCity` confirma que las que hay en mano son
    // las de ESTA ciudad y no las de la anterior, y la hidratación es la que
    // vuelca el borrador de localStorage a la grilla.
    if (refsLoading || refsDbCity !== dbCity) return
    if (!hydratedCitiesRef.current.has(bucketKey)) return

    colaOcupadaRef.current = true
    ;(async () => {
      try {
        let ok = true
        if (savableCount > 0) {
          ok = await handleSaveProgress()
          if (ok) colaResultadoRef.current.guardados += 1
        } else {
          // Tiene celdas cargadas pero ninguna FILA completa: "Guardar
          // progreso" nunca manda filas a medias. No es un fallo, pero
          // callarlo sería decirle al hub "guardé todo" sobre un frente que
          // quedó entero en localStorage.
          colaResultadoRef.current.sinFilas.push(bucketKey)
        }
        if (!ok) {
          // Frenar en seco. Seguir con el siguiente frente terminaría en un
          // cartel de éxito con un frente sin guardar en el medio, que es
          // exactamente el engaño que esta función vino a eliminar. El
          // mensaje de error de `performSave` ya está en pantalla.
          setColaGuardarTodo(EMPTY_ARR)
          return
        }
        setColaGuardarTodo((c) => c.slice(1))
      } finally {
        colaOcupadaRef.current = false
      }
    })()
    // `handleSaveProgress` se redefine en cada render (no es useCallback) —
    // meterlo acá re-dispararía este efecto sin parar. Se lo llama, no se lo
    // observa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    colaGuardarTodo,
    tickCola,
    bucketKey,
    saving,
    refsLoading,
    refsDbCity,
    dbCity,
    savableCount,
    irAFrente,
  ])

  // Cierre de la cola: volver a donde estaba el hub y contarle qué pasó.
  useEffect(() => {
    if (guardandoTodo || !colaOrigenRef.current) return
    const origen = colaOrigenRef.current
    const { guardados, sinFilas } = colaResultadoRef.current
    colaOrigenRef.current = null
    colaResultadoRef.current = { guardados: 0, sinFilas: [] }
    if (origen !== bucketKey) irAFrente(origen)
    if (guardados > 0) {
      setMsg({
        type: 'ok',
        emphasize: true,
        text: sinFilas.length
          ? t('dataentry.save_all_done_partial', {
              n: guardados,
              list: sinFilas.map(frontLabel).join(', '),
            })
          : guardados === 1
            ? t('dataentry.save_all_done_one')
            : t('dataentry.save_all_done', { n: guardados }),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardandoTodo])

  /**
   * Arma la cola con TODO lo que tenga trabajo sin asegurar. Se calcula al
   * apretar el botón (leyendo los refs en ese instante) y no en render: el
   * usuario tiene que guardar lo que hay AHORA, no lo que se vio hace un tick.
   */
  function handleGuardarTodo() {
    const pendientes = frentesSinGuardar({
      fronts: frentesAbiertos,
      llenoPorFrente,
      editSeq: editSeqRef.current,
      savedSeq: savedSeqRef.current,
    }).map((f) => f.bucket)
    if (!pendientes.length) {
      notify('ok', 'dataentry.save_all_nothing')
      return
    }
    colaOrigenRef.current = bucketKey
    colaResultadoRef.current = { guardados: 0, sinFilas: [] }
    // El frente actual primero: es el que el hub está mirando, y si algo falla
    // conviene que falle sobre lo que tiene delante.
    setColaGuardarTodo(
      pendientes.includes(bucketKey)
        ? [bucketKey, ...pendientes.filter((b) => b !== bucketKey)]
        : pendientes
    )
  }

  return { guardandoTodo, handleGuardarTodo }
}

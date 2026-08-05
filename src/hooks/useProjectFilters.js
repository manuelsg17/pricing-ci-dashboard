import { useState, useCallback, useMemo, useEffect } from 'react'
import { EMPTY_TASK_FILTERS } from '../lib/projectTasks'

// Estado de la barra de filtros de Proyectos, con persistencia.
//
// POR QUÉ localStorage Y NO EL HASH DE LA URL
// El resto de la app persiste filtros en el hash (useFilters.js), y a primera
// vista lo coherente sería copiar eso. No se puede: `useFilters` reescribe el
// hash ENTERO con `writeHash()` cada vez que cambia alguno de sus 13 valores, y
// `FilterProvider` envuelve TODAS las rutas — también /projects. Dos dueños
// para un mismo hash significa que el último en escribir le borra los filtros
// al otro, que es exactamente el bug que apareció al migrar al router real
// (los filtros del Dashboard se perdían al cambiar de pestaña).
//
// localStorage no comparte espacio con nadie y sobrevive un F5 igual, que es
// lo que pedía CLAUDE.md §2. Lo único que se pierde es el link compartible —
// y un link a "Proyectos filtrado por Ana" no es un caso de uso que haya
// aparecido en ninguna de las 4 rondas de simulación.
//
// Se guarda POR PAÍS: los proyectos y las ciudades de Perú no existen en
// Colombia, y restaurar un `projectId` de otro país dejaría la vista vacía sin
// explicación — el usuario vería "no hay nada" con un filtro que no puede ver.

const CLAVE = 'projects:ui'

function leer() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE) || '{}')
  } catch {
    // Un JSON corrupto no puede dejar la pantalla sin abrir.
    return {}
  }
}

function guardar(estado) {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(estado))
  } catch {
    // Cuota llena o modo privado: los filtros dejan de persistir, la pantalla
    // sigue funcionando. Nunca al revés.
  }
}

/**
 * @param country  país activo — namespacea el estado guardado
 *
 * `view` sale sin validar a propósito: quién puede abrir qué pestaña depende
 * de `isAdmin`, que llega ASÍNCRONO. Validar acá, en el primer render, daría
 * siempre "no puede" y un admin nunca recuperaría su pestaña. La decisión la
 * toma el componente, que sí sabe cuándo el rol resolvió.
 */
export function useProjectFilters(country) {
  const guardado = useMemo(() => leer()[country] || {}, [country])

  const [filters, setFilters] = useState(() => ({
    ...EMPTY_TASK_FILTERS,
    ...(guardado.filters || {}),
  }))

  const [view, setView] = useState(() => guardado.view || null)

  // El país cambia sin desmontar el componente (CountryContext), así que hay
  // que re-sembrar a mano: si no, los filtros de Perú quedarían aplicados
  // sobre los proyectos de Colombia.
  useEffect(() => {
    const g = leer()[country] || {}
    setFilters({ ...EMPTY_TASK_FILTERS, ...(g.filters || {}) })
    setView(g.view || null)
  }, [country])

  useEffect(() => {
    if (!country) return
    const todo = leer()
    todo[country] = { filters, view }
    guardar(todo)
  }, [country, filters, view])

  const setFilter = useCallback((key, value) => {
    setFilters((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }))
  }, [])

  const clearFilters = useCallback(() => setFilters({ ...EMPTY_TASK_FILTERS }), [])

  const activos = useMemo(
    () => Object.values(filters).filter((v) => v !== '' && v != null).length,
    [filters]
  )

  return { filters, setFilter, clearFilters, activos, view, setView }
}

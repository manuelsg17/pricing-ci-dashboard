import { useRef, useCallback } from 'react'

/**
 * Evita que un clic impaciente dispare la misma acción dos veces.
 *
 * POR QUÉ NO ALCANZA UN `useState` DE "cargando"
 * El estado de React se aplica en el render SIGUIENTE. Dos clics muy seguidos
 * —lo normal cuando la respuesta tarda— ven los dos `busy === false` y los dos
 * salen. Un ref se actualiza en el acto, así que es lo único que corta al
 * segundo antes de que llegue al servidor.
 *
 * Este patrón apareció CUATRO veces en el módulo de Proyectos antes de tener
 * nombre: el arrastre del Kanban, el del Gantt, los botones de estado y el
 * alta inline de tareas. La última costó dos tareas idénticas con el mismo
 * `sort_order` en la base, reproducidas en la ronda 2 de simulación.
 *
 * ES POR CLAVE, NO GLOBAL: con un solo candado por componente, borrar la
 * tarea A bloquearía editar la tarea B. La clave es lo que identifica a la
 * acción concreta (`del:<id>`, `patch:<id>:due_date`, …).
 *
 * @returns {(clave: string, fn: () => Promise<any>) => Promise<any|undefined>}
 *          `undefined` si la acción se descartó por estar ya en vuelo.
 */
export function useAccionEnVuelo() {
  const enVuelo = useRef(null)
  if (enVuelo.current === null) enVuelo.current = new Set()

  return useCallback(async (clave, fn) => {
    if (enVuelo.current.has(clave)) return undefined
    enVuelo.current.add(clave)
    try {
      return await fn()
    } finally {
      // `finally`: si la acción revienta, el candado TIENE que soltarse igual.
      // Si no, la fila queda muerta hasta recargar la página y el usuario no
      // tiene forma de saber por qué dejó de responder.
      enVuelo.current.delete(clave)
    }
  }, [])
}

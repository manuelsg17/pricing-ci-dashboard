// Trae TODAS las filas de una consulta de PostgREST, paginando.
//
// POR QUÉ HACE FALTA
// PostgREST tiene un "Max Rows" (1000 por defecto) y cuando lo alcanza NO
// devuelve error: manda 1000 filas y un `Content-Range: 0-999/1212`. El
// cliente ve una respuesta válida y no tiene forma de notar que le faltan 212.
// Medido en local con la consulta real de Proyectos.
//
// Es el truncado silencioso que CLAUDE.md §5 prohíbe, y ya costó un P0 en la
// auditoría de 2026-07-24. `fetchAllObservations.js` resuelve lo mismo para
// `pricing_observations`; este es el equivalente genérico. No se unificaron a
// propósito: el otro está en el camino caliente de los reportes y ya tiene sus
// pruebas, y meterle un refactor para ahorrar quince líneas es cambiar algo que
// funciona sin ganar nada hoy.
//
// EL ORDEN TIENE QUE SER ÚNICO
// Paginar con `.range()` sobre una columna con repetidos (por ejemplo
// `sort_order`, que arranca en 0 en cada proyecto) hace que Postgres pueda
// devolver las filas empatadas en cualquier orden entre página y página: se
// pierden filas y se repiten otras, otra vez en silencio. Por eso el llamador
// pasa una columna única —normalmente `id`— y ordena para mostrar DESPUÉS.

const PAGINA = 1000

/** Techo de seguridad. Con el volumen real de este proyecto (cientos de filas)
 *  no se toca nunca; existe para que un filtro mal armado no cuelgue el
 *  navegador pidiendo páginas para siempre. Si se alcanza, se avisa. */
const MAXIMO = 20000

/**
 * @param construir  (desde, hasta, pedirTotal) => query de supabase-js ya
 *                   filtrada, ordenada por una columna ÚNICA y con .range().
 * @returns {{ filas: any[], truncado: boolean, total: number }}
 *          `truncado` solo puede ser true si se alcanzó el techo — nunca por
 *          el límite de PostgREST, que es justamente lo que esto resuelve.
 */
export async function paginarTodo(construir) {
  let desde = 0
  let total = null
  const filas = []

  while (total === null || filas.length < total) {
    const { data, error, count } = await construir(desde, desde + PAGINA - 1, total === null)
    if (error) throw error
    if (total === null) total = count || 0
    // El count decía que había más pero no vino nada: cortar en vez de girar
    // en el vacío. Puede pasar si otra sesión borró filas entre página y
    // página.
    if (!data || data.length === 0) break
    filas.push(...data)
    desde += data.length
    if (filas.length >= MAXIMO) return { filas, truncado: true, total }
  }

  return { filas, truncado: false, total: total ?? filas.length }
}

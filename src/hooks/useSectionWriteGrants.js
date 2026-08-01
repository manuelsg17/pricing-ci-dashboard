import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { sb } from '../lib/supabase'

export const SECTION_WRITE_GRANTS_QUERY_KEY = ['section-write-grants']

async function fetchGrants() {
  const { data, error } = await sb
    .from('section_write_grants')
    .select('section, table_name, gate, note')
    .order('section')
    .order('table_name')
  if (error) throw error
  return data || []
}

// El mapa (sección → tabla) que usan las políticas RLS, migs 187/192.
//
// POR QUÉ SE LEE DE LA BASE Y NO DE UNA CONSTANTE DEL FRONT: es exactamente el
// mismo error que este modelo vino a arreglar. Una copia en el cliente se
// desincroniza del día que alguien agregue una fila —que es justo lo que la
// tabla permite hacer sin migración— y la pantalla de Accesos pasaría a
// prometer permisos que la base no da, o a esconder los que sí da.
export function useSectionWriteGrants() {
  const query = useQuery({ queryKey: SECTION_WRITE_GRANTS_QUERY_KEY, queryFn: fetchGrants })

  // sección → { section: [tablas], owner: [...], admin: [...] }
  const bySection = useMemo(() => {
    const map = {}
    for (const row of query.data || []) {
      const bucket = (map[row.section] ||= { section: [], owner: [], admin: [] })
      const gate = row.gate || 'section'
      if (bucket[gate]) bucket[gate].push(row.table_name)
    }
    return map
  }, [query.data])

  return { ...query, bySection }
}

// Qué va a poder escribir DE VERDAD un rol con estas secciones.
//
// Solo cuentan las filas con gate='section': son las únicas que
// `can_write_table()` mira. Las de gate 'owner' (la política filtra por dueño)
// y 'admin' (reservadas, p. ej. `roles` y `user_profiles`) están en el mapa
// para que quede declarado que esa pantalla las escribe y con qué criterio —
// no para conceder. Mezclarlas acá le mentiría al usuario en la dirección más
// cara: creyendo que delegó algo que sigue cerrado.
export function tablesGrantedBy(sections, bySection) {
  const list = sections || []
  const all = list.includes('all')
  const tables = new Set()
  for (const [section, buckets] of Object.entries(bySection || {})) {
    if (!all && !list.includes(section)) continue
    for (const t of buckets.section) tables.add(t)
  }
  return [...tables].sort()
}

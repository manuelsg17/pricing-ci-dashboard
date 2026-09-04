import { sb } from '../lib/supabase'

// ════════════════════════════════════════════════════════════════════════
// Persistencia de Ingresar CI — TODOS los accesos a Supabase de DataEntry.jsx
// en un solo archivo (patrón único de datos, 2026-09).
//
// QUÉ ES Y QUÉ NO ES
// Es una extracción CONSERVADORA: cada función reproduce la consulta que
// DataEntry.jsx hacía inline — mismas tablas, mismos filtros, mismo orden de
// cláusulas, mismos guards de dueño (`uploaded_by`, mig 139) y de zona. No
// hay cache (React Query) a propósito: nada de esto es una lectura
// cacheable — cada consulta responde a una acción o a un contexto que acaba
// de cambiar, y un cache con staleTime cambiaría cuándo se ve qué.
//
// Las funciones reciben TODO por parámetro y no leen estado de React: así
// los efectos y callbacks del componente conservan exactamente las mismas
// dependencias que tenían (CLAUDE.md §5 — la grilla no debe re-renderizar
// de más), y el orden de operaciones sigue decidiéndose en el componente,
// que es donde viven los guards anti-resurrección y de "recién terminado".
//
// Las lecturas que el componente consumía con `.then(...)` dentro de un
// efecto con flag `cancelled` devuelven el builder de supabase-js (es
// thenable): el llamador sigue encadenando `.then` igual que antes.
//
// Los comentarios largos con el PORQUÉ de cada consulta siguen en
// DataEntry.jsx, junto al punto de llamada — acá solo va lo que hace falta
// para entender la consulta en sí.
// ════════════════════════════════════════════════════════════════════════

// ── ci_active_sessions (latido en vivo, mig 146) ──────────────────────

// Borra el latido del hub SIN acotar por bucket. Es correcto SOLO donde se
// quiere descartar cualquier resto (Iniciar Sesión, cambio de país/fecha,
// cierre final). Devuelve el builder: el llamador hace `.then(noop, noop)`
// (fire-and-forget) o `await` según el caso.
export function deleteActiveSession(userEmail) {
  return sb.from('ci_active_sessions').delete().eq('user_email', userEmail)
}

// Re-limpieza tardía acotada a la sesión EXACTA que se cerró (país/ciudad/
// zona/fecha): si el hub ya arrancó otra sesión, no le borra el latido nuevo.
export function deleteActiveSessionScoped({ userEmail, country, city, zone, date }) {
  let q = sb
    .from('ci_active_sessions')
    .delete()
    .eq('user_email', userEmail)
    .eq('country', country)
    .eq('city', city)
    .eq('observed_date', date)
  q = zone != null ? q.eq('zone', zone) : q.is('zone', null)
  return q
}

// Latido (RPC upsert_ci_active_session). Devuelve `{ error }`: supabase-js NO
// lanza por un error de Postgres/RPC, el llamador lo chequea.
export function upsertActiveSession(p, recentFailures) {
  return sb.rpc('upsert_ci_active_session', {
    p_country: p.country,
    p_city: p.city,
    p_zone: p.zone,
    p_observed_date: p.date,
    p_filled_count: p.filledCount,
    p_total_expected: p.totalExpected,
    p_recent_failures: recentFailures,
    p_turno_progress: p.turnoProgress,
    p_scope_label: p.scopeLabel,
    p_fronts: p.fronts && p.fronts.length ? p.fronts : null,
  })
}

// Presencia: quién más está en el país ahora (RPC mig 152, SECURITY DEFINER
// — el RLS normal solo deja ver la fila propia). Thenable.
export function fetchPresence(country) {
  return sb.rpc('get_active_sessions_presence', { p_country: country })
}

// ── pricing_observations (lo ya guardado de ESTE hub) ─────────────────

function ownSavedQuery(select, { country, dbCity, date, userEmail, zone }) {
  let q = sb
    .from('pricing_observations')
    .select(select.columns, select.options)
    .eq('country', country)
    .eq('city', dbCity)
    .eq('observed_date', date)
    .eq('uploaded_by', userEmail)
    .eq('data_source', 'manual')
  q = zone != null ? q.eq('zone', zone) : q.is('zone', null)
  return q
}

// "Ver lo guardado": filas propias de la vista/fecha. Devuelve `{ data }`.
export function fetchSavedObservations(params) {
  return ownSavedQuery(
    {
      columns:
        'category, competition_name, price_without_discount, price_with_discount, observed_time, timeslot',
    },
    params
  )
    .order('timeslot')
    .order('category')
    .order('competition_name')
}

// Contador liviano (count-only, sin traer filas). Devuelve `{ count }`.
export function countSavedObservations(params) {
  return ownSavedQuery({ columns: 'id', options: { count: 'exact', head: true } }, params)
}

// Observaciones manuales para volcar al formulario. Solo las filas propias
// (+ legacy sin dueño): cargar las de otro hub y re-guardarlas las duplicaría
// como propias (mig 139). Devuelve el builder (thenable).
export function fetchManualObservations({ country, city, date, zone, userEmail }) {
  let obsQuery = sb
    .from('pricing_observations')
    .select(
      'category, competition_name, observed_time, timeslot, distance_bracket, point_a, point_b, zone, price_without_discount, price_with_discount, recommended_price, eta_min, minimal_bid, bid_1, bid_2, bid_3, bid_4, bid_5, no_data, surge'
    )
    .eq('country', country)
    .eq('city', city)
    .eq('observed_date', date)
    .eq('data_source', 'manual')
  // TukTuk: acotar al distrito (zone). Vistas normales: sin filtro de zona.
  if (zone != null) obsQuery = obsQuery.eq('zone', zone)
  obsQuery = userEmail
    ? obsQuery.or(`uploaded_by.eq.${userEmail},uploaded_by.is.null`)
    : obsQuery.is('uploaded_by', null)
  return obsQuery
}

// ── ci_bucket_writes (marca de agua de concurrencia, mig 191) ─────────

// `withTime` agrega `last_write_at` (lo necesita la re-sincronización desde
// un borrador restaurado). Devuelve `{ data, error }` de `.maybeSingle()`.
export function fetchBucketWriteMark({ userEmail, country, city, zone, date, withTime = false }) {
  return sb
    .from('ci_bucket_writes')
    .select(withTime ? 'write_seq, last_write_at' : 'write_seq')
    .eq('user_email', userEmail)
    .eq('country', country)
    .eq('city', city)
    .eq('zone_key', zone ?? '')
    .eq('observed_date', date)
    .maybeSingle()
}

// ── Guardado y cierre (RPCs, migs 182/186/191/197) ────────────────────

// DELETE + INSERT en UNA transacción del servidor. SECURITY INVOKER: las
// políticas RLS de pricing_observations aplican igual que con acceso directo.
export function saveCiBatch({
  country,
  dbCity,
  date,
  zone,
  userEmail,
  routes,
  rows,
  sessionId,
  expectedSeq,
  force,
}) {
  return sb.rpc('save_ci_batch', {
    p_country: country,
    p_city: dbCity,
    p_date: date,
    p_zone: zone ?? null,
    p_user_email: userEmail || null,
    p_routes: routes,
    p_rows: rows,
    p_session_id: sessionId,
    p_expected_seq: expectedSeq,
    p_force: force === true,
  })
}

// Registro del cierre en ci_sessions, idempotente por token (mig 197).
export function closeCiSession(closeToken, session) {
  return sb.rpc('close_ci_session', { p_close_token: closeToken, p_session: session })
}

// ── ci_sessions (historial) y relevo entre hubs ───────────────────────

export function fetchSessionHistory({ country, histFrom, histTo, histCity, histEmail }) {
  let q = sb
    .from('ci_sessions')
    .select('*')
    .eq('country', country)
    .order('started_at', { ascending: false })
    .limit(200)
  if (histFrom) q = q.gte('observed_date', histFrom)
  if (histTo) q = q.lte('observed_date', histTo)
  if (histCity) q = q.eq('city', histCity)
  if (histEmail) q = q.ilike('user_email', `%${histEmail}%`)
  return q
}

// turno_timings más reciente del contexto SIN IMPORTAR quién lo generó (RPC
// de solo lectura, mig 160). Thenable.
export function fetchTurnoTimings({ country, city, zone, date }) {
  return sb.rpc('get_ci_session_turno_timings', {
    p_country: country,
    p_city: city,
    p_zone: zone,
    p_observed_date: date,
  })
}

// ── distance_references (distritos de TukTuk) ─────────────────────────

// Zonas cargadas en Distancias de Referencia para la ciudad con TukTuk.
// Thenable; el llamador dedupe/ordena.
export function fetchTukTukZones(country, dbCity) {
  return sb
    .from('distance_references')
    .select('zone')
    .eq('country', country)
    .eq('city', dbCity)
    .eq('category', 'TukTuk')
    .not('zone', 'is', null)
}

// Acceso agrupado para quien prefiera un solo objeto. DataEntry.jsx importa
// las funciones por nombre (el checker de section-grants resuelve por
// símbolo, CLAUDE.md §3), pero la API "hook" queda disponible.
const PERSISTENCE = Object.freeze({
  deleteActiveSession,
  deleteActiveSessionScoped,
  upsertActiveSession,
  fetchPresence,
  fetchSavedObservations,
  countSavedObservations,
  fetchManualObservations,
  fetchBucketWriteMark,
  saveCiBatch,
  closeCiSession,
  fetchSessionHistory,
  fetchTurnoTimings,
  fetchTukTukZones,
})

export function useDataEntryPersistence() {
  return PERSISTENCE
}

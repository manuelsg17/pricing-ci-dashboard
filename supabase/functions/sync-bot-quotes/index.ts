// ════════════════════════════════════════════════════════════════════════
// Edge Function: sync-bot-quotes
//
// Puente entre la BD externa del bot (fudobi.helioho.st / quotes_output) y
// la BD del dashboard (Supabase / pricing_observations).
//
// Modos de invocación (POST con body JSON):
//
//   { "action": "probe" }
//      Devuelve la lista de columnas y 5 filas de ejemplo de quotes_output.
//      Úsalo la primera vez para confirmar el esquema y ajustar el mapping
//      antes de activar el sync.
//
//   { "action": "sync", "country": "Peru", "limit": 5000 }
//      Lee filas nuevas (created_at > watermark), las normaliza con las
//      mismas reglas que ingestionFilters.js, descarta vacías/outliers, e
//      inserta en pricing_observations. Actualiza el watermark.
//
//   { "action": "sync", "country": "Peru", "from": "2026-04-01", "to": "2026-04-25" }
//      Modo backfill manual. Ignora el watermark, solo lee el rango pedido.
//
// Variables de entorno (configurar en Supabase Dashboard → Edge Functions
// → secrets):
//   BOT_PG_HOST       fudobi.helioho.st
//   BOT_PG_PORT       5432
//   BOT_PG_DATABASE   fudobi_boheme
//   BOT_PG_USER       fudobi_admin_boheme
//   BOT_PG_PASSWORD   ********  ← NUNCA en código
//   BOT_PG_TABLE      quotes_output
//   BOT_PG_SCHEMA     public
//   BOT_PG_SSLMODE    prefer
// ════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// postgres.js — soporta certs autofirmados vía ssl:{ rejectUnauthorized:false }
// (deno-postgres no lo soporta; helioho.st usa cert autofirmado).
// Usamos npm: specifier (soportado por Supabase Edge Functions) en lugar de
// esm.sh para máxima estabilidad en el runtime de Deno.
// @ts-ignore npm specifier resolved at runtime
import postgres from 'npm:postgres@3.4.4'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

// ── Diccionarios de normalización (deben coincidir con
//     src/algorithms/ingestionFilters.js — ÚNICA fuente de verdad).
const CATEGORY_NORMALIZE: Record<string, string> = {
  'Economy/Comfort':  'Economy/Comfort',
  'Comfort+':         'Comfort+',
  'Comfort/Comfort+': 'Comfort+',
  'Comfort+/Premier': 'Premier',
  'Economy':          'Economy/Comfort',
  'Comfort':          'Comfort+',
}
const COMPETITOR_NORMALIZE: Record<string, string> = {
  'Indrive':         'InDrive',
  'DiDi':            'Didi',
  'Yango premier':   'Yango',
  'Yango  premier':  'Yango',
  'YangoPremier':    'Yango',
  'YangoComfort+':   'Yango',
}

// ── Reglas del bot — data-driven desde tabla bot_rules en Supabase.
//     Cada país tiene su propio set de reglas. La función las carga
//     en cada invocación filtrando por country (loadBotRules).
type BotRule = {
  app: string; vc: string; ovc: string;
  name: string; category: string; cities?: string[];
}

let BOT_RULES: BotRule[] = []

async function loadBotRules(admin: any, country: string): Promise<BotRule[]> {
  const { data, error } = await admin
    .from('bot_rules')
    .select('app, vc, ovc, competition_name, category, cities')
    .eq('country', country)
    .eq('active', true)
  if (error) {
    console.error('[loadBotRules] error', error)
    return []
  }
  return (data || []).map((r: any): BotRule => ({
    app:      String(r.app || '').toLowerCase(),
    vc:       String(r.vc || '').toLowerCase(),
    ovc:      String(r.ovc || '').toLowerCase(),
    name:     r.competition_name,
    category: r.category,
    cities:   (r.cities && r.cities.length > 0) ? r.cities : undefined,
  }))
}

function resolveByRules(appKey: string, vc: string, ovc: string, dbCity: string) {
  const a = (appKey || '').toLowerCase()
  const v = (vc || '').toLowerCase()
  const o = (ovc || '').toLowerCase()
  for (const r of BOT_RULES) {
    if (r.app !== a) continue
    if (r.vc !== v) continue
    if (r.ovc !== '*' && r.ovc !== o) continue
    if (r.cities && !r.cities.includes(dbCity)) continue
    return r
  }
  return null
}

const BOT_CITY_MAP: Record<string, string> = {
  // Perú
  lima: 'Lima', trujillo: 'Trujillo', arequipa: 'Arequipa',
  lima_airport: 'Lima_Airport', trujillo_airport: 'Trujillo_Airport', arequipa_airport: 'Arequipa_Airport',
  // Colombia
  bogota: 'Bogota', 'bogotá': 'Bogota',
  cali: 'Cali',
  barranquilla: 'Barranquilla', baq: 'Barranquilla',
  // Otros LATAM
  kathmandu: 'Kathmandu',
  santa_cruz: 'Santa Cruz',
  caracas: 'Caracas',
  lusaka: 'Lusaka',
}
function normalizeCity(c: string | null | undefined): string | null {
  if (!c) return null
  const k = c.toLowerCase().replace(/[\s-]/g, '_')
  return BOT_CITY_MAP[k] ?? c
}

// ── Conexión PG externa ─────────────────────────────────────────────────
// Devuelve una instancia de postgres.js (sql tagged-template).
//
// helioho.st presenta un cert autofirmado emitido para otro hostname —
// hay que saltarse DOS validaciones:
//   1. cadena de CA       → rejectUnauthorized: false
//   2. nombre del host    → checkServerIdentity: () => undefined
//
// La conexión sigue siendo encriptada con TLS, solo no validamos el cert.
// Esto es seguro porque conocemos el host por configuración.
function connectBotDb(): any {
  const tlsMode = (Deno.env.get('BOT_PG_SSLMODE') || 'require').toLowerCase()
  const ssl =
    tlsMode === 'disable'      ? false :
    tlsMode === 'verify-full'  ? 'verify-full' :
    {
      rejectUnauthorized:  false,
      checkServerIdentity: () => undefined,   // skip hostname check
    }

  return postgres({
    host:            Deno.env.get('BOT_PG_HOST')!,
    port:            Number(Deno.env.get('BOT_PG_PORT') || '5432'),
    database:        Deno.env.get('BOT_PG_DATABASE')!,
    username:        Deno.env.get('BOT_PG_USER')!,
    password:        Deno.env.get('BOT_PG_PASSWORD')!,
    ssl,
    max:             1,
    idle_timeout:    5,
    connect_timeout: 15,
  })
}

// ── Handler principal ───────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')    return json(405, { error: 'Method not allowed' })

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  // Auth: solo usuarios autenticados pueden disparar el sync (no es público)
  const authHeader = req.headers.get('Authorization') || ''
  const jwt = authHeader.replace('Bearer ', '').trim()
  const { data: { user: caller }, error: callerError } = await admin.auth.getUser(jwt)
  if (callerError || !caller) return json(401, { error: 'No autorizado' })

  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  const action = body.action || 'sync'

  // ── Modo PING — sanity check sin tocar la BD del bot ──────────────
  if (action === 'ping') {
    return json(200, {
      ok: true, action: 'ping',
      caller: caller.email,
      env: {
        BOT_PG_HOST_set:     !!Deno.env.get('BOT_PG_HOST'),
        BOT_PG_USER_set:     !!Deno.env.get('BOT_PG_USER'),
        BOT_PG_PASSWORD_set: !!Deno.env.get('BOT_PG_PASSWORD'),
        BOT_PG_TABLE_set:    !!Deno.env.get('BOT_PG_TABLE'),
        BOT_PG_SSLMODE:      Deno.env.get('BOT_PG_SSLMODE') || '(unset)',
      },
    })
  }

  const schema = Deno.env.get('BOT_PG_SCHEMA') || 'public'
  const table  = Deno.env.get('BOT_PG_TABLE')  || 'quotes_output'
  const fqTable = `"${schema}"."${table}"`

  // ── Modo PROBE ─────────────────────────────────────────────────────
  if (action === 'probe') {
    let bot: any = null
    try {
      bot = connectBotDb()
      const cols = await bot`
        SELECT column_name, data_type
          FROM information_schema.columns
         WHERE table_schema = ${schema} AND table_name = ${table}
         ORDER BY ordinal_position
      `
      const sample = await bot.unsafe(`SELECT * FROM ${fqTable} ORDER BY 1 DESC LIMIT 5`)
      return json(200, {
        ok: true, action: 'probe',
        schema, table,
        columns: cols,
        sample,
      })
    } catch (e) {
      return json(500, { ok: false, error: String((e as Error).message), stack: (e as Error).stack })
    } finally {
      try { await bot?.end({ timeout: 2 }) } catch { /* ignore */ }
    }
  }

  // ── Modo SYNC ──────────────────────────────────────────────────────
  if (action !== 'sync') return json(400, { error: `Unknown action: ${action}` })

  const country = body.country || 'Peru'
  const limit   = Math.min(Number(body.limit || 5000), 50000)
  const from    = body.from   // 'YYYY-MM-DD' opcional
  const to      = body.to     // 'YYYY-MM-DD' opcional

  // Cargar bot_rules para el país. Si no hay, abortamos antes de tocar
  // la BD del bot — sin reglas no hay nada útil que ingerir.
  BOT_RULES = await loadBotRules(admin, country)
  if (BOT_RULES.length === 0) {
    return json(400, {
      ok: false,
      error: `No hay reglas activas en bot_rules para country='${country}'. ` +
             `Inserta filas vía supabase/45_colombia_setup.sql o el equivalente.`,
    })
  }

  // Crear log entry
  const { data: logRow } = await admin.from('bot_sync_log').insert({
    country, status: 'running', notes: { action, limit, from, to, caller: caller.email, rules_loaded: BOT_RULES.length },
  }).select().single()
  const logId = logRow?.id

  let bot: any = null
  let stats = { read: 0, accepted: 0, dropped: 0, outliers: 0, inserted: 0 }

  try {
    bot = connectBotDb()

    // Si es backfill (from/to dado) ignoramos watermark.
    // Si no, usamos el watermark del país.
    let whereClause = ''
    let params: unknown[] = []
    if (from && to) {
      whereClause = `WHERE created_at::date BETWEEN $1 AND $2`
      params = [from, to]
    } else {
      const { data: wm } = await admin
        .from('bot_sync_watermark')
        .select('last_synced_at')
        .eq('country', country)
        .maybeSingle()
      const since = wm?.last_synced_at || '1970-01-01T00:00:00Z'
      whereClause = `WHERE created_at > $1`
      params = [since]
    }

    // ⚠ ESTA QUERY ASUME LA EXISTENCIA DE LAS COLUMNAS:
    //   created_at, country, city, observed_date, observed_time, app,
    //   vehicle_category, observed_vehicle_category,
    //   price_recommended, price_with_discount, price_without_discount,
    //   distance_km, eta_min, surge, rush_hour
    // Si el bot usa nombres distintos, primero corre `action: "probe"`
    // y ajusta el SELECT debajo (o crea una vista en fudobi que renombre).
    const queryText = `
      SELECT * FROM ${fqTable}
      ${whereClause}
      ORDER BY created_at ASC
      LIMIT ${limit}
    `
    const rows: Record<string, unknown>[] = await bot.unsafe(queryText, params)
    stats.read = rows.length

    // Pre-cargar reglas de validación de precios (para outliers)
    const { data: priceRules } = await admin
      .from('price_validation_rules')
      .select('city, category, competition, max_price')
      .eq('country', country)

    // Normalizar
    const accepted: Record<string, unknown>[] = []
    let maxCreatedAt = '1970-01-01T00:00:00Z'

    for (const raw of rows) {
      const createdAtVal = raw.created_at
      const created = createdAtVal instanceof Date
        ? createdAtVal.toISOString()
        : String(createdAtVal ?? '')
      if (created > maxCreatedAt) maxCreatedAt = created

      const dbCity = normalizeCity(raw.city as string)
      const appKey = String(raw.app ?? '').toLowerCase()
      const vc     = String(raw.vehicle_category ?? '').toLowerCase()
      const ovc    = String(raw.observed_vehicle_category ?? '').toLowerCase()

      if (!dbCity || !raw.observed_date || !appKey) {
        stats.dropped++; continue
      }
      const rule = resolveByRules(appKey, vc, ovc, dbCity)
      if (!rule) { stats.dropped++; continue }

      let category = rule.category
      let competition_name = rule.name
      // Aplicar normalización adicional (por si el bot manda "Comfort" legacy)
      if (raw.category) category = CATEGORY_NORMALIZE[String(raw.category)] ?? category

      const recommended_price       = num(raw.price_recommended)
      const price_with_discount     = num(raw.price_with_discount)
      const price_without_discount  = num(raw.price_without_discount)
      const effective = recommended_price ?? price_without_discount ?? price_with_discount
      if (effective == null) { stats.dropped++; continue }

      // Validación de precio máximo
      const threshold = findThreshold(priceRules || [], dbCity, category, competition_name)
      if (threshold != null && effective > threshold) {
        stats.outliers++
        continue
      }

      // Normalizar bracket — colapsa variantes zone-aware a los 6 canónicos.
      // Mismo algoritmo que normalize_distance_bracket() en SQL (mig 47)
      // y bot_sync_push.py.
      const norm_bracket = (() => {
        const raw_b = raw.distance_bracket
        if (!raw_b) return null
        let s = String(raw_b).toLowerCase().replace(/[\s-]+/g, '_')
        s = s.replace(/^airport_/, '')
        s = s.replace(/_(madrid|funza|mosquera|cota|chia|soacha|cajica|tenjo|sopo|sibate)$/, '')
        s = s.replace(/_(zona_sur|zona_norte|zona_centro|zona_este|zona_oeste|sur|norte|centro|este|oeste)$/, '')
        s = s.replace(/_(a|b)$/, '')
        if (s === 'medium')     s = 'median'
        if (s === 'very short') s = 'very_short'
        if (s === 'very long')  s = 'very_long'
        return ['very_short','short','median','average','long','very_long'].includes(s) ? s : null
      })()

      // Distance: aceptar distance_km directo o caer a distance_meters/1000.
      let distance_km = num(raw.distance_km)
      if (distance_km == null && raw.distance_meters != null) {
        const dm = num(raw.distance_meters)
        distance_km = dm != null ? dm / 1000 : null
      }

      accepted.push({
        country,
        city: dbCity,
        observed_date: raw.observed_date,
        observed_time: raw.observed_time ?? null,
        category,
        competition_name,
        recommended_price,
        price_with_discount,
        price_without_discount,
        distance_km,
        distance_bracket: norm_bracket,
        eta_min:      num(raw.eta_min),
        surge:        toBool(raw.surge),
        rush_hour:    toBool(raw.rush_hour),
        data_source:  'bot',
      })
    }
    stats.accepted = accepted.length

    // Insert en lotes
    const BATCH = 1000
    for (let i = 0; i < accepted.length; i += BATCH) {
      const chunk = accepted.slice(i, i + BATCH)
      const { error } = await admin.from('pricing_observations').insert(chunk)
      if (error) throw new Error(`Insert chunk ${i}: ${error.message}`)
      stats.inserted += chunk.length
    }

    // Actualizar watermark
    if (!from && !to && stats.read > 0) {
      await admin.from('bot_sync_watermark').upsert({
        country,
        last_synced_at: maxCreatedAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'country' })
    }

    // Cerrar log
    if (logId) {
      await admin.from('bot_sync_log').update({
        status: 'ok',
        finished_at: new Date().toISOString(),
        read_count: stats.read,
        inserted_count: stats.inserted,
        dropped_count: stats.dropped,
        outlier_count: stats.outliers,
      }).eq('id', logId)
    }

    return json(200, { ok: true, action: 'sync', country, stats, watermark: maxCreatedAt })
  } catch (e) {
    const msg = String((e as Error).message)
    if (logId) {
      await admin.from('bot_sync_log').update({
        status: 'error', finished_at: new Date().toISOString(),
        error_msg: msg,
        read_count: stats.read, inserted_count: stats.inserted,
        dropped_count: stats.dropped, outlier_count: stats.outliers,
      }).eq('id', logId)
    }
    return json(500, { ok: false, error: msg })
  } finally {
    try { await bot?.end({ timeout: 2 }) } catch { /* ignore */ }
  }
})

// ── Helpers ─────────────────────────────────────────────────────────────
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'))
  return isFinite(n) ? n : null
}
function toBool(v: unknown): boolean | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'boolean') return v
  const s = String(v).toLowerCase().trim()
  if (['true','t','1','yes','si','sí','rush hour'].includes(s)) return true
  if (['false','f','0','no','valley'].includes(s)) return false
  return null
}
function findThreshold(rules: any[], city: string, category: string, comp: string): number | null {
  const m = rules.find(r => r.city === city && r.category === category && r.competition === comp)
  if (m) return m.max_price
  const cc = rules.find(r => r.city === city && r.category === category && r.competition === 'all')
  if (cc) return cc.max_price
  const ca = rules.find(r => r.city === city && r.category === 'all' && r.competition === 'all')
  if (ca) return ca.max_price
  return null
}

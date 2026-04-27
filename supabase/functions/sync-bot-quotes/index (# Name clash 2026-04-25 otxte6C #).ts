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
// @ts-ignore esm.sh provides types at runtime
import postgres from 'https://esm.sh/postgres@3.4.4?target=deno'

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

// ── Reglas del bot (Perú). Mismo contenido que constants.js → botRules.
//     Cuando se confirme el esquema real de quotes_output, esto se
//     puede mover a una tabla bot_rules en Supabase para que sea
//     editable desde Config → Países sin redeployar la función.
const BOT_RULES: Array<{
  app: string; vc: string; ovc: string;
  name: string; category: string; cities?: string[];
}> = [
  { app: 'yango_api', vc: 'economy',  ovc: 'economy',  name: 'Yango',       category: 'Economy/Comfort' },
  { app: 'yango_api', vc: 'comfort',  ovc: 'comfort',  name: 'YangoComfort',category: 'Economy/Comfort' },
  { app: 'yango_api', vc: 'comfort',  ovc: 'comfort+', name: 'Yango',       category: 'Comfort+' },
  { app: 'yango_api', vc: 'premier',  ovc: 'premier',  name: 'Yango',       category: 'Premier',      cities: ['Lima','Lima_Airport'] },
  { app: 'yango_api', vc: 'xl',       ovc: 'xl',       name: 'Yango',       category: 'XL' },
  { app: 'yango_api', vc: 'tuktuk',   ovc: '*',        name: 'Yango',       category: 'TukTuk',       cities: ['Lima'] },
  { app: 'uber',      vc: 'economy',  ovc: 'uberx',    name: 'Uber',        category: 'Economy/Comfort' },
  { app: 'uber',      vc: 'comfort',  ovc: 'comfort',  name: 'Uber',        category: 'Comfort+' },
  { app: 'uber',      vc: 'premium',  ovc: 'black',    name: 'Uber',        category: 'Premier',      cities: ['Lima','Lima_Airport'] },
  { app: 'uber',      vc: 'xl',       ovc: 'xl',       name: 'Uber',        category: 'XL' },
  { app: 'uber',      vc: 'tuktuk',   ovc: '*',        name: 'Uber',        category: 'TukTuk',       cities: ['Lima'] },
  { app: 'indrive',   vc: 'economy',  ovc: 'viaje',    name: 'InDrive',     category: 'Economy/Comfort' },
  { app: 'indrive',   vc: 'comfort',  ovc: 'confort',  name: 'InDrive',     category: 'Comfort+' },
  { app: 'indrive',   vc: 'xl',       ovc: 'xl',       name: 'InDrive',     category: 'XL' },
  { app: 'didi',      vc: 'economy',  ovc: 'express',  name: 'Didi',        category: 'Economy/Comfort' },
]

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
  lima: 'Lima', trujillo: 'Trujillo', arequipa: 'Arequipa',
  lima_airport: 'Lima_Airport', trujillo_airport: 'Trujillo_Airport', arequipa_airport: 'Arequipa_Airport',
  bogota: 'Bogota', medellin: 'Medellin', cali: 'Cali',
}
function normalizeCity(c: string | null | undefined): string | null {
  if (!c) return null
  const k = c.toLowerCase().replace(/[\s-]/g, '_')
  return BOT_CITY_MAP[k] ?? c
}

// ── Conexión PG externa ─────────────────────────────────────────────────
// Devuelve una instancia de postgres.js (sql tagged-template).
// Para helioho.st (cert autofirmado) usamos rejectUnauthorized:false.
function connectBotDb(): any {
  const tlsMode = (Deno.env.get('BOT_PG_SSLMODE') || 'require').toLowerCase()
  const ssl =
    tlsMode === 'disable' ? false :
    tlsMode === 'verify-full' ? 'verify-full' :
    { rejectUnauthorized: false }   // 'prefer' | 'require' | otro → confiamos en host pero saltamos validación de cert

  return postgres({
    host:      Deno.env.get('BOT_PG_HOST')!,
    port:      Number(Deno.env.get('BOT_PG_PORT') || '5432'),
    database:  Deno.env.get('BOT_PG_DATABASE')!,
    username:  Deno.env.get('BOT_PG_USER')!,
    password:  Deno.env.get('BOT_PG_PASSWORD')!,
    ssl,
    max: 1,
    idle_timeout: 5,
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

  // Crear log entry
  const { data: logRow } = await admin.from('bot_sync_log').insert({
    country, status: 'running', notes: { action, limit, from, to, caller: caller.email },
  }).select().single()
  const logId = logRow?.id

  let bot: PgClient | null = null
  let stats = { read: 0, accepted: 0, dropped: 0, outliers: 0, inserted: 0 }

  try {
    bot = await connectBotDb()

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
    const sql = `
      SELECT * FROM ${fqTable}
      ${whereClause}
      ORDER BY created_at ASC
      LIMIT ${limit}
    `
    const result = await bot.queryObject<Record<string, unknown>>(sql, params)
    stats.read = result.rows.length

    // Pre-cargar reglas de validación de precios (para outliers)
    const { data: priceRules } = await admin
      .from('price_validation_rules')
      .select('city, category, competition, max_price')
      .eq('country', country)

    // Normalizar
    const accepted: Record<string, unknown>[] = []
    let maxCreatedAt = '1970-01-01T00:00:00Z'

    for (const raw of result.rows) {
      const created = String(raw.created_at ?? '')
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
        distance_km:  num(raw.distance_km),
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
    try { await bot?.end() } catch { /* ignore */ }
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

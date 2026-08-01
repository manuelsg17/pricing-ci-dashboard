#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// check-section-grants-drift.mjs — ¿el mapa de permisos cubre lo que la app
// realmente escribe?
//
// EL PROBLEMA QUE RESUELVE
// `section_write_grants` (mig 187) se sembró A MANO. Si mañana una pantalla
// empieza a escribir una tabla nueva, o se agrega una sección, el mapa queda
// corto y NADIE se entera: la pantalla se abre y la escritura rebota con
// "new row violates row-level security policy" — exactamente el bug original
// que el modelo genérico vino a matar, solo que ahora en silencio y dependiendo
// de que alguien se acuerde de actualizar una tabla.
//
// Este script convierte "espero que esté bien" en "el sistema me avisa".
//
// CÓMO FUNCIONA
//   1. Lee la constante ROUTES de src/App.jsx  → sección ↔ página.
//   2. Camina el grafo de imports desde cada página (hooks, componentes,
//      libs…). Así una pantalla nueva o un hook nuevo quedan cubiertos SIN
//      tocar este archivo — no hay una lista que mantener a mano.
//   3. De cada archivo alcanzable extrae:
//        · escrituras   `.from('tabla').insert/update/delete/upsert(`
//        · llamadas RPC `.rpc('funcion'`
//      La cadena se parsea con un scanner de paréntesis balanceados, no con
//      una ventana de N caracteres: una cadena larga no se confunde con la
//      siguiente.
//   4. Contrasta contra la BASE (no contra una copia en el repo, que se
//      desincronizaría):
//        FASE A — toda (sección, tabla) que la app escribe tiene fila en
//                 section_write_grants.
//        FASE B — toda RPC que una sección NO-admin llama es alcanzable por
//                 esa sección: si su cuerpo exige is_admin() sin ofrecer un
//                 camino por can_access_section(), la pantalla se abre y la
//                 llamada rebota. Mismo bug, distinta puerta.
//
// USO
//   npm run check:section-grants
//   SUPABASE_DB_CONTAINER=otro npm run check:section-grants
//
// Sale con código 1 si hay drift — sirve tanto a mano como en CI.
// ════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_JSX = resolve(ROOT, 'src/App.jsx')
const CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_pricing-ci-dashboard'

// ── RPCs que son solo-admin A PROPÓSITO dentro de una pantalla compartida ──
// No son huecos: la UI ya esconde el control para el resto, y el permiso es
// una acción administrativa puntual, no "lo que hace la pantalla". Cada
// excepción lleva el motivo escrito — si algún día deja de ser cierto, se
// borra de acá y el checker vuelve a gritar.
const ADMIN_ONLY_RPCS = {
  reassign_task:
    'Reasignar tareas es acción de admin por diseño (mig 184 §15.2). ' +
    'Projects.jsx solo muestra la pestaña "admin" si isAdmin.',
}

// ── Utilidades ────────────────────────────────────────────────────────
const RED = (s) => `\x1b[31m${s}\x1b[0m`
const YEL = (s) => `\x1b[33m${s}\x1b[0m`
const GRN = (s) => `\x1b[32m${s}\x1b[0m`
const DIM = (s) => `\x1b[2m${s}\x1b[0m`

// Devuelve las filas como objetos. Se pide JSON y no columnas separadas por un
// carácter: `prosrc` trae cuerpos de función con pipes, tabs y saltos de línea
// adentro, y cualquier separador elegido a dedo aparece tarde o temprano
// DENTRO de un dato y parte la fila en silencio — un checker que se equivoca
// callado es peor que no tenerlo.
function psqlJson(sql) {
  try {
    const out = execFileSync(
      'docker',
      [
        'exec', '-i', CONTAINER,
        'psql', '-U', 'postgres', '-X', '-q', '-t', '-A',
        '-c', `SELECT coalesce(json_agg(x)::text, '[]') FROM (${sql}) x`,
      ],
      { encoding: 'utf8' }
    ).trim()
    return JSON.parse(out)
  } catch (e) {
    console.error(RED('\n✗ No se pudo consultar la base local.'))
    console.error(
      `  Contenedor esperado: ${CONTAINER}\n` +
        `  Levantalo con \`npx supabase start\` (o pasá SUPABASE_DB_CONTAINER).\n`
    )
    console.error(DIM(String(e.stderr || e.message).slice(0, 400)))
    process.exit(2)
  }
}

// ── 1. ROUTES de App.jsx ──────────────────────────────────────────────
// Se lee del archivo real y no se duplica acá: una ruta nueva entra sola.
function readRoutes() {
  const src = readFileSync(APP_JSX, 'utf8')

  // Component → path del import lazy
  const lazyPaths = {}
  for (const m of src.matchAll(
    /const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g
  )) {
    lazyPaths[m[1]] = m[2]
  }

  const block = src.match(/const ROUTES = \[([\s\S]*?)\n\]/)
  if (!block) {
    console.error(RED('✗ No encontré la constante ROUTES en src/App.jsx.'))
    console.error('  Si se renombró o cambió de forma, actualizá este parser — no lo ignores.')
    process.exit(2)
  }

  const routes = []
  for (const m of block[1].matchAll(/\{([^{}]*)\}/g)) {
    const body = m[1]
    const path = body.match(/path:\s*['"]([^'"]+)['"]/)?.[1]
    const comp = body.match(/Component:\s*(\w+)/)?.[1]
    const section = body.match(/section:\s*['"]([^'"]+)['"]/)?.[1] || null
    const adminOnly = /adminOnly:\s*true/.test(body)
    if (!path || !comp) continue
    routes.push({ path, comp, section, adminOnly, file: lazyPaths[comp] })
  }
  if (routes.length === 0) {
    console.error(RED('✗ ROUTES quedó vacío al parsear — el formato cambió.'))
    process.exit(2)
  }
  return routes
}

// ── 2. Grafo de imports ───────────────────────────────────────────────
const EXTS = ['', '.js', '.jsx', '/index.js', '/index.jsx']

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null // paquete de node_modules: no nos interesa
  const base = resolve(dirname(fromFile), spec)
  for (const ext of EXTS) {
    const cand = base + ext
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

function reachableFiles(entryFile) {
  const seen = new Set()
  const stack = [entryFile]
  while (stack.length) {
    const f = stack.pop()
    if (!f || seen.has(f)) continue
    seen.add(f)
    const src = readFileSync(f, 'utf8')
    const specs = [
      ...[...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...src.matchAll(/^\s*export\s+[^'"]*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ]
    for (const s of specs) {
      const r = resolveImport(f, s)
      if (r) stack.push(r)
    }
  }
  return seen
}

// ── 3. Extracción de escrituras y RPCs ────────────────────────────────
// Scanner de cadena con paréntesis balanceados. Una ventana de N caracteres
// se comería el `.insert(` de la SIGUIENTE consulta y reportaría la tabla
// equivocada; un falso positivo acá rompe el build de otro por una razón
// inventada, así que vale la pena hacerlo bien.
const WRITE_OPS = new Set(['insert', 'update', 'delete', 'upsert'])

function scanChainMethods(src, startIdx) {
  const methods = []
  let i = startIdx
  const skipTrivia = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++
      if (src.startsWith('//', i)) {
        while (i < src.length && src[i] !== '\n') i++
      } else if (src.startsWith('/*', i)) {
        const end = src.indexOf('*/', i)
        i = end === -1 ? src.length : end + 2
      } else return
    }
  }
  for (;;) {
    skipTrivia()
    if (src[i] !== '.') return methods
    i++
    const name = /^\w+/.exec(src.slice(i))?.[0]
    if (!name) return methods
    i += name.length
    methods.push(name)
    skipTrivia()
    if (src[i] !== '(') continue // p.ej. `.data` — sigue la cadena
    // paréntesis balanceados, respetando strings y templates
    let depth = 0
    let quote = null
    for (; i < src.length; i++) {
      const c = src[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (depth === 0) {
          i++
          break
        }
      }
    }
  }
}

function extractFromFile(file) {
  const src = readFileSync(file, 'utf8')
  const writes = [] // { table, ops, line }
  const rpcs = [] // { fn, line }
  const lineOf = (idx) => src.slice(0, idx).split('\n').length

  for (const m of src.matchAll(/\.from\(\s*['"`]([A-Za-z0-9_]+)['"`]\s*\)/g)) {
    const after = m.index + m[0].length
    const ops = scanChainMethods(src, after).filter((x) => WRITE_OPS.has(x))
    if (ops.length) writes.push({ table: m[1], ops: [...new Set(ops)], line: lineOf(m.index) })
  }
  for (const m of src.matchAll(/\.rpc\(\s*['"`]([A-Za-z0-9_]+)['"`]/g)) {
    rpcs.push({ fn: m[1], line: lineOf(m.index) })
  }
  return { writes, rpcs }
}

// ── Main ──────────────────────────────────────────────────────────────
const routes = readRoutes()

// sección → { tables: Map<table, [origen]>, rpcs: Map<fn, [origen]> }
const bySection = new Map()
for (const r of routes) {
  // `monitoring` no tiene `section` (se gatea por isAdmin directo): se lo
  // trata como una sección adminOnly con el nombre de su ruta, para que sus
  // escrituras igual se auditen y no queden en un punto ciego.
  const key = r.section || r.path
  if (!r.file) {
    console.error(RED(`✗ La ruta '${r.path}' no tiene un import lazy resoluble en App.jsx.`))
    process.exit(2)
  }
  const entry = resolveImport(APP_JSX, r.file)
  if (!entry) {
    console.error(RED(`✗ No pude resolver '${r.file}' (ruta '${r.path}').`))
    process.exit(2)
  }
  const acc = bySection.get(key) || {
    adminOnly: r.adminOnly,
    tables: new Map(),
    rpcs: new Map(),
  }
  acc.adminOnly = acc.adminOnly && r.adminOnly
  for (const f of reachableFiles(entry)) {
    const { writes, rpcs } = extractFromFile(f)
    const where = (line) => `${relative(ROOT, f)}:${line}`
    for (const w of writes) {
      const list = acc.tables.get(w.table) || []
      list.push(`${where(w.line)} (${w.ops.join('/')})`)
      acc.tables.set(w.table, list)
    }
    for (const c of rpcs) {
      const list = acc.rpcs.get(c.fn) || []
      list.push(where(c.line))
      acc.rpcs.set(c.fn, list)
    }
  }
  bySection.set(key, acc)
}

// ── Estado de la base ─────────────────────────────────────────────────
const grantRows = psqlJson(
  `SELECT section, table_name, coalesce(gate,'section') AS gate
     FROM public.section_write_grants ORDER BY 1,2`
)
const KEY = (section, table) => `${section}::${table}`
const granted = new Set(grantRows.map((r) => KEY(r.section, r.table_name)))
const gateOf = new Map(grantRows.map((r) => [KEY(r.section, r.table_name), r.gate]))

const fnRows = psqlJson(
  `SELECT p.proname AS name, p.prosecdef AS secdef,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS can_exec,
          p.prosrc AS src
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'`
)
const fns = new Map()
for (const row of fnRows) {
  // Una función puede estar SOBRECARGADA. El criterio se toma sobre el
  // conjunto: alcanza con que UNA firma sea llamable (canExec) o genérica
  // (generic) para que la pantalla funcione; en cambio "exige admin" solo
  // vale si lo exigen TODAS — si una sola firma no lo exige, hay camino.
  const prev = fns.get(row.name)
  const src = row.src || ''
  const cur = {
    secdef: row.secdef === true,
    canExec: row.can_exec === true,
    generic: /can_access_section\s*\(/.test(src),
    requiresAdmin: /\bis_admin\s*\(\s*\)/.test(src),
  }
  if (prev) {
    cur.secdef = prev.secdef || cur.secdef
    cur.canExec = prev.canExec || cur.canExec
    cur.generic = prev.generic || cur.generic
    cur.requiresAdmin = prev.requiresAdmin && cur.requiresAdmin
  }
  fns.set(row.name, cur)
}

// ── FASE A — escrituras de tabla sin fila en el mapa ──────────────────
const failures = []
const warnings = []

for (const [section, acc] of [...bySection].sort()) {
  for (const [table, origins] of [...acc.tables].sort()) {
    if (granted.has(KEY(section, table))) continue
    failures.push({
      kind: 'A',
      section,
      subject: table,
      origins,
      why:
        `la sección '${section}' escribe '${table}' y NO hay fila en section_write_grants. ` +
        `Si un rol no-admin recibe esta sección, la pantalla se abre y el guardado rebota.`,
      fix:
        `INSERT INTO section_write_grants (section, table_name, gate, note) VALUES ` +
        `('${section}', '${table}', 'section', '<por qué>');  -- o gate 'admin'/'owner' si el ` +
        `gate real no es la sección`,
    })
  }
}

// Filas del mapa que ya nadie escribe: no rompen nada, pero conceden permiso
// sobre una tabla que la pantalla dejó de tocar. Se avisa, no se falla.
for (const key of granted) {
  const [section, table] = key.split('::')
  const acc = bySection.get(section)
  if (!acc) {
    warnings.push(
      `sección '${section}' no existe en ROUTES (mapea '${table}') — ¿se renombró o se borró la pantalla?`
    )
    continue
  }
  if (!acc.tables.has(table)) {
    warnings.push(
      `'${section}' → '${table}' está en el mapa pero ningún archivo de esa sección la escribe (gate='${gateOf.get(key)}').`
    )
  }
}

// ── FASE B — RPCs inalcanzables desde su propia sección ───────────────
for (const [section, acc] of [...bySection].sort()) {
  for (const [fn, origins] of [...acc.rpcs].sort()) {
    const info = fns.get(fn)
    if (!info) {
      failures.push({
        kind: 'B',
        section,
        subject: `${fn}()`,
        origins,
        why: `la app llama la RPC '${fn}' y NO existe en la base local. Es una llamada muerta: siempre falla.`,
        fix: `Crear la función o sacar la llamada.`,
      })
      continue
    }
    if (!info.canExec) {
      failures.push({
        kind: 'B',
        section,
        subject: `${fn}()`,
        origins,
        why: `'${fn}' no tiene EXECUTE para 'authenticated': ningún usuario de la app puede llamarla.`,
        fix: `GRANT EXECUTE ON FUNCTION public.${fn}(...) TO authenticated;`,
      })
      continue
    }
    if (acc.adminOnly) continue // la pantalla ya es solo-admin: coherente
    if (ADMIN_ONLY_RPCS[fn]) continue // excepción declarada y justificada
    if (info.secdef && info.requiresAdmin && !info.generic) {
      failures.push({
        kind: 'B',
        section,
        subject: `${fn}()`,
        origins,
        why:
          `la sección '${section}' NO es adminOnly, pero '${fn}' exige is_admin() y no ofrece ` +
          `camino por can_access_section(). Un rol con esta sección ve la pantalla y la llamada rebota.`,
        fix:
          `Cambiar el guard a can_access_section('${section}') + require_country_access(...), ` +
          `o declararlo en ADMIN_ONLY_RPCS de este script con el motivo.`,
      })
    }
  }
}

// ── Reporte ───────────────────────────────────────────────────────────
console.log('')
console.log('  Secciones auditadas: ' + [...bySection.keys()].sort().join(', '))
console.log(
  `  Escrituras encontradas: ${[...bySection.values()].reduce((n, a) => n + a.tables.size, 0)} · ` +
    `RPCs: ${[...bySection.values()].reduce((n, a) => n + a.rpcs.size, 0)} · ` +
    `filas en el mapa: ${grantRows.length}`
)
console.log('')

if (warnings.length) {
  console.log(YEL('  ⚠ Avisos (no fallan el checker):'))
  for (const w of warnings) console.log(`    · ${w}`)
  console.log('')
}

if (failures.length) {
  console.log(RED(`  ✗ ${failures.length} hueco(s) de permisos:\n`))
  for (const f of failures) {
    console.log(RED(`  [${f.kind}] ${f.section} → ${f.subject}`))
    console.log(`      ${f.why}`)
    for (const o of f.origins.slice(0, 4)) console.log(DIM(`      ← ${o}`))
    if (f.origins.length > 4) console.log(DIM(`      ← … y ${f.origins.length - 4} más`))
    console.log(DIM(`      arreglo: ${f.fix}`))
    console.log('')
  }
  process.exit(1)
}

console.log(GRN('  ✓ Sin drift: todo lo que la app escribe está declarado y es alcanzable.'))
console.log('')

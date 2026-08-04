#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// check-section-grants-drift.mjs — ¿el mapa de permisos cubre lo que la app
// realmente escribe?
//
// EL PROBLEMA QUE RESUELVE
// `section_write_grants` (migs 187/192) se sembró A MANO. Si mañana una
// pantalla empieza a escribir una tabla nueva, o se agrega una sección, el
// mapa queda corto y NADIE se entera: la pantalla se abre y la escritura
// rebota con "new row violates row-level security policy" — exactamente el bug
// que el modelo genérico vino a matar, solo que ahora en silencio y
// dependiendo de que alguien se acuerde de actualizar una tabla.
//
// Este script convierte "espero que esté bien" en "el sistema me avisa".
//
// CÓMO FUNCIONA
//   1. Lee la constante ROUTES de src/App.jsx  → sección ↔ página.
//   2. Camina el grafo de imports desde cada página. Una pantalla nueva o un
//      hook nuevo quedan cubiertos SIN tocar este archivo: no hay una lista
//      que mantener a mano, que es justo lo que falla.
//   3. Extrae de cada archivo alcanzable:
//        · escrituras   `.from('tabla').insert/update/delete/upsert(`
//        · llamadas RPC `.rpc('funcion'`
//   4. Contrasta contra la BASE (no contra una copia en el repo, que se
//      desincronizaría):
//        FASE A — toda (sección, tabla) que la app escribe tiene fila en
//                 section_write_grants.
//        FASE B — toda RPC que llama una sección NO-admin es alcanzable por
//                 esa sección: si su cuerpo exige is_admin() sin ofrecer un
//                 camino por can_access_section(), la pantalla se abre y la
//                 llamada rebota. Mismo bug, otra puerta.
//
// POR QUÉ EL ANÁLISIS ES POR SÍMBOLO Y NO POR ARCHIVO
// La primera versión atribuía a una sección TODA escritura de cualquier
// archivo alcanzable. Reportó tres huecos que no existían: Rentabilidad
// importa `useCompetitorCommissions` solo para LEER (destructura `commissions`,
// nunca `saveCommission`), y DataEntry importa de `useDistanceRefs` solo el
// fetch. Un falso positivo acá no es ruido inocente: empuja a declarar una
// fila en el mapa "para que pase el checker", y esa fila CONCEDE escritura que
// la pantalla no necesita. El checker terminaría abriendo permisos.
//
// Por eso se resuelve a nivel de símbolo, y siempre hacia el lado conservador:
//   · Regla 1 — de un módulo solo entran los símbolos que el importador
//     nombra en su `import { … }`, más el código de nivel de módulo.
//   · Regla 2 — si el importador destructura el resultado de un hook
//     (`const { a, b } = useX()`), solo cuentan las escrituras que viven en
//     las funciones que el hook devuelve bajo ESOS nombres.
//   · Ante cualquier duda (uso indirecto, alias, `return` que no se puede
//     mapear) se cuenta TODO. Sobre-reportar cuesta una revisión; no reportar
//     devuelve el bug original en silencio.
//
// USO
//   npm run check:section-grants
//   SUPABASE_DB_CONTAINER=otro npm run check:section-grants
//
// Sale con código 1 si hay drift — sirve a mano y en CI.
// ════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_JSX = resolve(ROOT, 'src/App.jsx')
const CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_pricing-ci-dashboard'

// ── RPCs solo-admin A PROPÓSITO dentro de una pantalla compartida ─────
// No son huecos: la UI ya esconde el control para el resto, y el permiso es
// una acción administrativa puntual, no "lo que hace la pantalla". Cada
// excepción lleva el motivo escrito — si deja de ser cierto, se borra de acá
// y el checker vuelve a gritar.
const ADMIN_ONLY_RPCS = {
  reassign_task:
    'Reasignar tareas es acción de admin por diseño (mig 184 §15.2). ' +
    'Projects.jsx solo muestra la pestaña de administración si isAdmin.',
}

const RED = (s) => `\x1b[31m${s}\x1b[0m`
const YEL = (s) => `\x1b[33m${s}\x1b[0m`
const GRN = (s) => `\x1b[32m${s}\x1b[0m`
const DIM = (s) => `\x1b[2m${s}\x1b[0m`

// ── Acceso a la base ──────────────────────────────────────────────────
// Se pide JSON y no columnas separadas por un carácter: `prosrc` trae cuerpos
// de función con pipes, tabs y saltos de línea adentro, y cualquier separador
// elegido a dedo aparece tarde o temprano DENTRO de un dato y parte la fila en
// silencio. Un checker que se equivoca callado es peor que no tenerlo.
function psqlJson(sql) {
  try {
    const out = execFileSync(
      'docker',
      [
        'exec',
        '-i',
        CONTAINER,
        'psql',
        '-U',
        'postgres',
        '-X',
        '-q',
        '-t',
        '-A',
        '-c',
        `SELECT coalesce(json_agg(x)::text, '[]') FROM (${sql}) x`,
      ],
      { encoding: 'utf8' }
    ).trim()
    return JSON.parse(out)
  } catch (e) {
    console.error(RED('\n  No se pudo consultar la base local.'))
    console.error(
      `  Contenedor esperado: ${CONTAINER}\n` +
        '  Levantalo con `npx supabase start` (o pasá SUPABASE_DB_CONTAINER).\n'
    )
    console.error(DIM(String(e.stderr || e.message).slice(0, 500)))
    process.exit(2)
  }
}

// ── Scanner: paréntesis y llaves balanceados ──────────────────────────
// Se respetan strings y templates para no cortar en un `{` que vive adentro de
// un texto. Es la diferencia entre atribuir la escritura a la tabla correcta y
// comerse la consulta siguiente.
function matchDelimiter(src, openIdx, open, close) {
  let depth = 0
  let quote = null
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i)
      i = end === -1 ? src.length : end + 1
    } else if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return src.length
}

// Dado el final de una declaración (`function f`, `const x =`), devuelve el
// rango [inicio, fin] de su cuerpo.
//
// No alcanza con "la primera llave que aparece": `async function fillIfMissing(sb,
// { country, city })` abre una llave DENTRO de los paréntesis, y tomarla daba un
// rango de un solo carácter — con lo cual las dos escrituras de esa función
// quedaban huérfanas, caían en "nivel de módulo" y se le atribuían a cualquier
// sección que importara algo del archivo. Así nació un hueco inventado.
//
// Reglas: se ignora todo lo que esté dentro de ()/[], salvo el cuerpo de una
// arrow (`=> {`), que es exactamente el caso de `useCallback(async () => {…})`.
function findBody(src, from) {
  let depth = 0
  let quote = null
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i)
      i = end === -1 ? src.length : end + 1
      continue
    }
    if (c === '=' && src[i + 1] === '>') {
      let j = i + 2
      while (j < src.length && /\s/.test(src[j])) j++
      if (src[j] === '{') return [j, matchDelimiter(src, j, '{', '}')]
      i = j - 1
      continue
    }
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === '{' && depth <= 0) return [i, matchDelimiter(src, i, '{', '}')]
    else if (depth <= 0 && (c === ';' || c === '\n')) {
      // Fin de sentencia, salvo que la línea quede claramente colgada.
      let k = i - 1
      while (k > from && /\s/.test(src[k])) k--
      if (!'=+,(&|?:.'.includes(src[k])) return [from, i]
    }
  }
  return [from, src.length]
}

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
    if (src[i] !== '(') continue // p.ej. `.data` — la cadena sigue
    i = matchDelimiter(src, i, '(', ')') + 1
  }
}

// ── Análisis de un archivo ────────────────────────────────────────────
const WRITE_OPS = new Set(['insert', 'update', 'delete', 'upsert'])
const MODULE_SCOPE = '__module__'

const fileCache = new Map()

function analyze(file) {
  if (fileCache.has(file)) return fileCache.get(file)
  const src = readFileSync(file, 'utf8')
  const lineOf = (idx) => src.slice(0, idx).split('\n').length

  // — declaraciones de primer nivel y su rango —
  // Incluye las NO exportadas a propósito: `fillIfMissing` en
  // distanceRefsReplication.js es privada y hace el INSERT/UPDATE. Si solo se
  // miraran las exportadas, esa escritura caería en "nivel de módulo" y se le
  // atribuiría a TODA sección que importe cualquier cosa del archivo — que es
  // como el checker inventó un hueco de 'dataentry' sobre distance_references.
  const symbols = new Map() // nombre -> [inicio, fin]
  const declRe =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=|let\s+(\w+)\s*=|class\s+(\w+))/gm
  for (const m of src.matchAll(declRe)) {
    const name = m[1] || m[2] || m[3] || m[4]
    if (!name) continue
    const [, end] = findBody(src, m.index + m[0].length)
    symbols.set(name, [m.index, end])
  }

  const owner = (idx) => {
    for (const [name, [a, b]] of symbols) if (idx >= a && idx <= b) return name
    return MODULE_SCOPE
  }

  // — escrituras y RPCs —
  const writes = []
  const rpcs = []
  for (const m of src.matchAll(/\.from\(\s*['"`]([A-Za-z0-9_]+)['"`]\s*\)/g)) {
    const ops = scanChainMethods(src, m.index + m[0].length).filter((x) => WRITE_OPS.has(x))
    if (ops.length)
      writes.push({
        table: m[1],
        ops: [...new Set(ops)],
        line: lineOf(m.index),
        idx: m.index,
        symbol: owner(m.index),
      })
  }
  for (const m of src.matchAll(/\.rpc\(\s*['"`]([A-Za-z0-9_]+)['"`]/g)) {
    rpcs.push({ fn: m[1], line: lineOf(m.index), idx: m.index, symbol: owner(m.index) })
  }

  // — Regla 2: qué función local implementa cada propiedad devuelta —
  // `return { allRows, saveCommission, reload: load }` dentro del símbolo, y
  // el rango de cada función local nombrada ahí. Una escritura que cae en ese
  // rango "pertenece" a esa propiedad; si el importador no la destructura, no
  // la puede ejecutar.
  const propRanges = new Map() // símbolo -> Map<prop, [inicio, fin]>
  for (const [sym, [a, b]] of symbols) {
    const body = src.slice(a, b)
    let last = null
    for (const rm of body.matchAll(/\breturn\s*\{/g)) last = rm
    if (!last) continue
    const openIdx = a + last.index + last[0].length - 1
    const closeIdx = matchDelimiter(src, openIdx, '{', '}')
    const objSrc = src.slice(openIdx + 1, closeIdx)
    if (/\.{3}/.test(objSrc)) continue // spread: no se puede mapear, conservador
    const props = new Map()
    let mappable = true
    for (const part of objSrc.split(',')) {
      const p = part.trim()
      if (!p) continue
      const mm = /^(\w+)\s*(?::\s*(\w+))?$/.exec(p)
      if (!mm) {
        mappable = false
        break
      }
      props.set(mm[1], mm[2] || mm[1])
    }
    if (!mappable) continue

    const ranges = new Map()
    for (const [prop, local] of props) {
      const dm =
        new RegExp(`\\b(?:async\\s+)?function\\s+${local}\\s*\\(`).exec(body) ||
        new RegExp(`\\bconst\\s+${local}\\s*=`).exec(body)
      if (!dm) continue
      const [bs, be] = findBody(body, dm.index + dm[0].length)
      ranges.set(prop, [a + bs, a + be])
    }
    if (ranges.size) propRanges.set(sym, ranges)
  }

  // — imports —
  const imports = []
  const addImport = (spec, names, all) => imports.push({ spec, names, all })
  for (const m of src.matchAll(/^\s*import\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
    const clause = m[1].trim()
    const named = clause.match(/\{([^}]*)\}/)?.[1]
    const names = new Set()
    let all = false
    if (named) {
      for (const part of named.split(',')) {
        const n = part.trim().split(/\s+as\s+/)[0].trim()
        if (n) names.add(n)
      }
    }
    // default o namespace (`import X from` / `import * as X`): puede tocar
    // cualquier cosa del módulo → conservador.
    if (/^\w/.test(clause) || /\*\s+as/.test(clause)) all = true
    addImport(m[2], names, all)
  }
  for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) addImport(m[1], new Set(), false)
  for (const m of src.matchAll(/^\s*export\s+[^'"]*from\s*['"]([^'"]+)['"]/gm))
    addImport(m[1], new Set(), true)
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))
    addImport(m[1], new Set(), true)

  // — Regla 2 (lado importador): props que este archivo destructura de cada
  //   símbolo importado. `null` = el símbolo se usa de un modo que no se puede
  //   analizar → contar todo.
  const usedProps = new Map()
  // Las líneas de import se blanquean antes de contar usos: el nombre del hook
  // aparece TAMBIÉN dentro de la ruta del módulo ('../hooks/useCompetitorBonuses'),
  // así que contarlas hacía que ningún hook diera "todos sus usos analizados" y
  // el análisis caía siempre al lado conservador sin decirlo.
  const srcNoImports = src.replace(/^\s*(?:import|export)\s[^\n]*from\s*['"][^'"]+['"]/gm, '')
  for (const imp of imports) {
    for (const name of imp.names) {
      if (!/^use[A-Z]/.test(name)) {
        usedProps.set(name, null)
        continue
      }
      const callRe = new RegExp(`\\b${name}\\b`, 'g')
      const destrRe = new RegExp(`(?:const|let)\\s*\\{([^}]*)\\}\\s*=\\s*${name}\\s*\\(`, 'g')
      const totalUses = [...srcNoImports.matchAll(callRe)].length
      const destr = [...srcNoImports.matchAll(destrRe)]
      // Si TODO uso del hook es un destructuring analizable, se sabe con qué se
      // quedó el importador. Si aparece de cualquier otra forma, se cuenta todo.
      if (destr.length === 0 || totalUses !== destr.length) {
        usedProps.set(name, null)
        continue
      }
      const props = new Set()
      for (const d of destr) {
        for (const part of d[1].split(',')) {
          const p = part.trim()
          if (!p) continue
          if (/\.{3}/.test(p)) {
            props.add('*')
            continue
          }
          props.add(p.split(':')[0].trim())
        }
      }
      usedProps.set(name, props.has('*') ? null : props)
    }
  }

  const res = { file, src, symbols, writes, rpcs, propRanges, imports, usedProps }
  fileCache.set(file, res)
  return res
}

const EXTS = ['', '.js', '.jsx', '/index.js', '/index.jsx']
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null // node_modules: fuera de alcance
  const base = resolve(dirname(fromFile), spec)
  for (const ext of EXTS) {
    const cand = base + ext
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

// ── Recorrido por (archivo, símbolo, props permitidas) ────────────────
function collect(entryFile) {
  const tables = new Map() // tabla -> [origen]
  const rpcs = new Map() // rpc   -> [origen]
  const seen = new Set()
  const queue = [{ file: entryFile, symbol: '*', props: null }]

  while (queue.length) {
    const { file, symbol, props } = queue.pop()
    const key = `${file}|${symbol}|${props ? [...props].sort().join(',') : '*'}`
    if (seen.has(key)) continue
    seen.add(key)

    const a = analyze(file)
    const range = symbol === '*' ? null : a.symbols.get(symbol)
    if (symbol !== '*' && symbol !== MODULE_SCOPE && !range) continue

    // Entrar a un símbolo arrastra los helpers locales que ese símbolo llama,
    // y los que esos llaman a su vez: `applyFillIfMissingCascade` no escribe
    // nada por sí misma, escribe `fillIfMissing`. Sin esto el análisis sería
    // preciso de más y dejaría pasar el hueco real.
    const scopeRanges = []
    if (range) {
      const reached = new Set([symbol])
      const pending = [symbol]
      while (pending.length) {
        const s = pending.pop()
        const r = a.symbols.get(s)
        if (!r) continue
        scopeRanges.push(r)
        const body = a.src.slice(r[0], r[1])
        for (const other of a.symbols.keys()) {
          if (reached.has(other)) continue
          if (new RegExp(`\\b${other}\\b`).test(body)) {
            reached.add(other)
            pending.push(other)
          }
        }
      }
    }

    const inScope = (idx, sym) => {
      if (symbol === '*') return true
      if (symbol === MODULE_SCOPE) return sym === MODULE_SCOPE
      return scopeRanges.some(([x, y]) => idx >= x && idx <= y)
    }

    // Regla 2: la escritura vive en una función que el hook devuelve bajo un
    // nombre que el importador NO destructuró → no la puede ejecutar.
    const blockedByProps = (idx) => {
      if (!props || symbol === '*') return false
      const ranges = a.propRanges.get(symbol)
      if (!ranges) return false
      for (const [prop, [x, y]] of ranges) {
        if (idx >= x && idx <= y) return !props.has(prop)
      }
      return false
    }

    const where = (line) => `${relative(ROOT, file)}:${line}`
    for (const w of a.writes) {
      if (!inScope(w.idx, w.symbol) || blockedByProps(w.idx)) continue
      const list = tables.get(w.table) || []
      list.push(`${where(w.line)} (${w.ops.join('/')})`)
      tables.set(w.table, list)
    }
    for (const c of a.rpcs) {
      if (!inScope(c.idx, c.symbol) || blockedByProps(c.idx)) continue
      const list = rpcs.get(c.fn) || []
      list.push(where(c.line))
      rpcs.set(c.fn, list)
    }

    // Se siguen TODOS los imports del archivo (no solo los que usa el símbolo
    // entrado): distinguir eso exigiría un grafo de llamadas completo, y el
    // error de sobra es el barato.
    for (const imp of a.imports) {
      const target = resolveImport(file, imp.spec)
      if (!target) continue
      const dep = analyze(target)
      queue.push({ file: target, symbol: MODULE_SCOPE, props: null })
      if (imp.all || imp.names.size === 0) {
        queue.push({ file: target, symbol: '*', props: null })
        continue
      }
      for (const name of imp.names) {
        queue.push({ file: target, symbol: name, props: a.usedProps.get(name) ?? null })
      }
      // Un `export … from` intermedio puede re-exportar el símbolo: si el
      // módulo no lo declara localmente, se entra entero.
      for (const name of imp.names) {
        if (!dep.symbols.has(name)) queue.push({ file: target, symbol: '*', props: null })
      }
    }
  }
  return { tables, rpcs }
}

// ── 1. ROUTES de App.jsx ──────────────────────────────────────────────
function readRoutes() {
  const src = readFileSync(APP_JSX, 'utf8')
  const lazyPaths = {}
  // `lazy(` o `lazyConReintento(` (mig del 2026-08-04: los 17 imports se
  // envolvieron para curar una pestaña vieja tras un deploy). El wrapper lleva
  // un SEGUNDO argumento, así que el cierre no puede exigirse pegado al
  // `import(...)`.
  //
  // ⚠️ ESTE REGEX SE ROMPIÓ UNA VEZ Y EL CHEQUEO QUEDÓ CIEGO UNA SEMANA.
  // Al renombrar o envolver los imports de App.jsx, actualizarlo ACÁ. El guard
  // de abajo existe para que ese olvido no vuelva a pasar en silencio.
  for (const m of src.matchAll(
    /const\s+(\w+)\s*=\s*lazy(?:ConReintento)?\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g
  ))
    lazyPaths[m[1]] = m[2]

  // Si el parser no encontró NINGUNA página, el problema es el parser, no los
  // datos. Sin esto, el script moría más adelante con "No pude resolver la
  // página de la ruta 'dashboard'" — un mensaje que manda a buscar al lado
  // equivocado y que ocultó durante una semana que el gate obligatorio de
  // CLAUDE.md §7.4b no estaba validando nada.
  if (Object.keys(lazyPaths).length === 0) {
    console.error(
      '\n  ✗ El parser de App.jsx no encontró ningún import perezoso.\n' +
        '    NO es un problema de permisos: es que este script quedó desactualizado\n' +
        `    respecto de ${APP_JSX}. Revisar el regex de readRoutes().\n`
    )
    process.exit(2)
  }

  const block = src.match(/const ROUTES = \[([\s\S]*?)\n\]/)
  if (!block) {
    console.error(RED('  No encontré la constante ROUTES en src/App.jsx.'))
    console.error('  Si se renombró o cambió de forma, actualizá este parser — no lo ignores.')
    process.exit(2)
  }
  const routes = []
  for (const m of block[1].matchAll(/\{([^{}]*)\}/g)) {
    const body = m[1]
    const path = body.match(/path:\s*['"]([^'"]+)['"]/)?.[1]
    const comp = body.match(/Component:\s*(\w+)/)?.[1]
    if (!path || !comp) continue
    routes.push({
      path,
      comp,
      section: body.match(/section:\s*['"]([^'"]+)['"]/)?.[1] || null,
      adminOnly: /adminOnly:\s*true/.test(body),
      file: lazyPaths[comp],
    })
  }
  if (!routes.length) {
    console.error(RED('  ROUTES quedó vacío al parsear — el formato cambió.'))
    process.exit(2)
  }
  return routes
}

// ── Main ──────────────────────────────────────────────────────────────
const routes = readRoutes()
const bySection = new Map()

for (const r of routes) {
  // `monitoring` no tiene `section` (se gatea por isAdmin directo): se lo trata
  // como sección adminOnly con el nombre de su ruta, para que sus escrituras
  // igual se auditen y no queden en un punto ciego.
  const key = r.section || r.path
  const entry = r.file && resolveImport(APP_JSX, r.file)
  if (!entry) {
    console.error(RED(`  No pude resolver la página de la ruta '${r.path}'.`))
    process.exit(2)
  }
  const { tables, rpcs } = collect(entry)
  const acc = bySection.get(key) || { adminOnly: r.adminOnly, tables: new Map(), rpcs: new Map() }
  acc.adminOnly = acc.adminOnly && r.adminOnly
  for (const [t, o] of tables) acc.tables.set(t, [...(acc.tables.get(t) || []), ...o])
  for (const [f, o] of rpcs) acc.rpcs.set(f, [...(acc.rpcs.get(f) || []), ...o])
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
const fnSrc = new Map() // nombre -> cuerpo concatenado de todas sus firmas
for (const row of fnRows) {
  fnSrc.set(row.name, (fnSrc.get(row.name) || '') + '\n' + (row.src || ''))
  // Una función puede estar SOBRECARGADA. El criterio se toma sobre el
  // conjunto: alcanza con que UNA firma sea llamable o genérica para que la
  // pantalla funcione; "exige admin" solo vale si lo exigen TODAS.
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

const failures = []
const warnings = []

// ── FASE A — escrituras de tabla sin fila en el mapa ──────────────────
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
        'Si un rol no-admin recibe esta sección, la pantalla se abre y el guardado rebota.',
      fix:
        "INSERT INTO section_write_grants (section, table_name, gate, note) VALUES " +
        `('${section}', '${table}', 'section', '<por qué>');   ` +
        "-- gate 'admin'/'owner' si el permiso real NO es la sección",
    })
  }
}

// Filas del mapa que ya nadie escribe: no rompen nada, pero una con
// gate='section' concede escritura sobre una tabla que la pantalla dejó de
// tocar — permiso regalado. Se avisa, no se falla.
//
// Dos casos NO son sobrante y no deben avisar, o el aviso se vuelve ruido de
// fondo y se deja de leer, que es como muere un checker:
//   · la tabla se escribe DENTRO de una RPC que esa sección llama (el cliente
//     nunca hace `.from(...).insert(...)`, pero la pantalla sí la escribe);
//   · gate='admin', que existe justamente para dejar constancia de una tabla
//     que la sección NO puede conceder.
for (const key of granted) {
  const [section, table] = key.split('::')
  const acc = bySection.get(section)
  if (!acc) {
    warnings.push(
      `sección '${section}' no existe en ROUTES (mapea '${table}') — ¿se renombró o se borró la pantalla?`
    )
    continue
  }
  if (acc.tables.has(table)) continue
  if (gateOf.get(key) === 'admin') continue
  const viaRpc = [...acc.rpcs.keys()].some((fn) =>
    new RegExp(`\\b${table}\\b`).test(fnSrc.get(fn) || '')
  )
  if (viaRpc) continue
  warnings.push(
    `'${section}' → '${table}': está en el mapa pero nada de esa sección la escribe ` +
      `(gate='${gateOf.get(key)}') — es un permiso que se concede de más.`
  )
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
        why: `la app llama la RPC '${fn}' y NO existe en la base local: es una llamada muerta, siempre falla.`,
        fix: 'Crear la función o sacar la llamada.',
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
          'camino por can_access_section(). Un rol con esta sección ve la pantalla y la llamada rebota.',
        fix:
          `Cambiar el guard a can_access_section('${section}') + require_country_access(...), ` +
          'o declararlo en ADMIN_ONLY_RPCS de este script con el motivo.',
      })
    }
  }
}

// ── Reporte ───────────────────────────────────────────────────────────
console.log('')
console.log('  Secciones auditadas: ' + [...bySection.keys()].sort().join(', '))
console.log(
  `  Escrituras: ${[...bySection.values()].reduce((n, a) => n + a.tables.size, 0)} · ` +
    `RPCs: ${[...bySection.values()].reduce((n, a) => n + a.rpcs.size, 0)} · ` +
    `filas en el mapa: ${grantRows.length}`
)
console.log('')

if (warnings.length) {
  console.log(YEL('  Avisos (no fallan el checker):'))
  for (const w of warnings) console.log(`    · ${w}`)
  console.log('')
}

if (failures.length) {
  console.log(RED(`  ${failures.length} hueco(s) de permisos:\n`))
  for (const f of failures) {
    console.log(RED(`  [${f.kind}] ${f.section} -> ${f.subject}`))
    console.log(`      ${f.why}`)
    for (const o of f.origins.slice(0, 4)) console.log(DIM(`      <- ${o}`))
    if (f.origins.length > 4) console.log(DIM(`      <- … y ${f.origins.length - 4} más`))
    console.log(DIM(`      arreglo: ${f.fix}`))
    console.log('')
  }
  process.exit(1)
}

console.log(GRN('  OK — todo lo que la app escribe está declarado y es alcanzable.'))
console.log('')

#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// check-nav-sections-drift.mjs — ¿el menú (Topbar) puede quedar mudo para
// un rol que SÍ tiene acceso a la pantalla?
//
// EL PROBLEMA QUE RESUELVE
// Topbar.getNav() decide qué mostrar preguntando canAccess(item.section ??
// item.id). ROUTES (App.jsx) es la fuente real de qué sección gatea cada
// página. Si un ítem de nav no declara `section` y su `id` no coincide con
// una sección real (porque la ruta reusa OTRA sección a propósito, como
// RouteMonitor reusando 'competitividad'), canAccess() pregunta por una
// sección que no existe en ningún rol salvo admin — el link desaparece del
// menú aunque la página sí sea alcanzable por URL. Bug real, 2026-09-12
// (routemonitor), cazado por auditoría manual, no por un test — este script
// existe para que la próxima vez lo cace un test.
//
// TAMBIÉN VERIFICA: toda sección no-admin de ROUTES tiene claves de i18n
// `nav.<id>` en los 3 locales (si tiene entrada de menú) — un hueco ahí es
// el mismo síntoma con causa distinta (texto sin traducir, no permiso).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RED = (s) => `\x1b[31m${s}\x1b[0m`
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`

function readRoutes() {
  const src = readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8')
  const block = src.match(/const ROUTES = \[([\s\S]*?)\n\]/)?.[1]
  if (!block) throw new Error('No encontré ROUTES en src/App.jsx — ¿cambió el formato?')
  const routes = []
  for (const m of block.matchAll(/\{([^}]*)\}/g)) {
    const body = m[1]
    const routePath = body.match(/path:\s*['"]([^'"]+)['"]/)?.[1]
    if (!routePath) continue
    routes.push({
      path: routePath,
      section: body.match(/section:\s*['"]([^'"]+)['"]/)?.[1] || null,
      adminOnly: /adminOnly:\s*true/.test(body),
    })
  }
  if (routes.length === 0) throw new Error('ROUTES quedó vacío al parsear.')
  return routes
}

function readAllSections() {
  const src = readFileSync(path.join(ROOT, 'src/hooks/useAccessControl.js'), 'utf8')
  const block = src.match(/export const ALL_SECTIONS = \[([\s\S]*?)\]/)?.[1]
  if (!block) throw new Error('No encontré ALL_SECTIONS en useAccessControl.js.')
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

// Extrae todos los objetos { id: 'x', ..., section: 'y' } dentro de getNav(),
// incluyendo los anidados en `children`. No distingue nivel — no hace falta,
// canShow() aplica la misma regla (section ?? id) a padres e hijos.
function readNavItems() {
  const src = readFileSync(path.join(ROOT, 'src/components/layout/Topbar.jsx'), 'utf8')
  const block = src.match(/const getNav = \(t\) => \[([\s\S]*?)\n\]\n/)?.[1]
  if (!block) throw new Error('No encontré getNav() en Topbar.jsx.')
  const items = []
  for (const m of block.matchAll(/\{\s*id:\s*'([^']+)'[^}]*\}/g)) {
    const body = m[0]
    // Los grupos del menú (ej. { id: 'analisis', children: [...] }) nunca
    // pasan por canShow() en Topbar — solo sus hijos. Se filtran por no
    // tener `children:` en su propio cuerpo (el regex no baja recursivo,
    // así que un grupo matchea hasta su primer '}' interno... por eso
    // basta con excluir cualquier match cuyo body sea un objeto que la
    // fuente real declara con `children:` — ver abajo, chequeo directo
    // contra la línea completa del ítem en el source.
    if (new RegExp(`id:\\s*'${m[1]}'[^}]*children:`).test(block)) continue
    items.push({
      id: m[1],
      section: body.match(/section:\s*['"]([^'"]+)['"]/)?.[1] || null,
      adminOnly: /adminOnly:\s*true/.test(body),
      hasLabel: /label:\s*t\(/.test(body),
    })
  }
  if (items.length === 0) throw new Error('No extraje ningún ítem de getNav().')
  return items
}

function readI18nKeys(locale) {
  const src = readFileSync(path.join(ROOT, `src/lib/i18n/${locale}.js`), 'utf8')
  return new Set([...src.matchAll(/'([a-zA-Z0-9_.]+)':/g)].map((m) => m[1]))
}

const routes = readRoutes()
const allSections = new Set(readAllSections())
const navItems = readNavItems()
const locales = ['es', 'en', 'ru']
const i18nKeys = Object.fromEntries(locales.map((l) => [l, readI18nKeys(l)]))

const errors = []

// 1. Todo nav item no-adminOnly debe resolver canAccess() contra una
//    sección real de ALL_SECTIONS.
for (const item of navItems) {
  if (item.adminOnly) continue
  const gate = item.section ?? item.id
  if (!allSections.has(gate)) {
    errors.push(
      `nav '${item.id}': canAccess('${gate}') nunca es true para ningún rol no-admin ` +
        `(esa sección no existe en ALL_SECTIONS). Si la página reusa la sección de otra ` +
        `ruta a propósito, agregar 'section' explícito al ítem de nav, como se hizo con routemonitor.`
    )
  }
}

// 2. Toda ruta no-admin con `section` debe tener esa sección en ALL_SECTIONS
//    (si no, ProtectedRoute jamás deja pasar a nadie salvo admin).
for (const r of routes) {
  if (r.adminOnly || !r.section) continue
  if (!allSections.has(r.section)) {
    errors.push(
      `ROUTES '${r.path}': section '${r.section}' no está en ALL_SECTIONS — ` +
        `ningún rol no-admin puede acceder aunque se le conceda esa sección en Accesos.`
    )
  }
}

// 3. Todo nav item con label vía t('nav.<id>') debe tener esa clave en los 3 locales.
for (const item of navItems) {
  if (!item.hasLabel) continue
  const key = `nav.${item.id}`
  for (const locale of locales) {
    if (!i18nKeys[locale].has(key)) {
      errors.push(`i18n: falta la clave '${key}' en src/lib/i18n/${locale}.js`)
    }
  }
}

if (errors.length > 0) {
  console.error(RED(`✗ check-nav-sections-drift: ${errors.length} problema(s)\n`))
  errors.forEach((e) => console.error(`  - ${e}`))
  process.exit(1)
}

console.log(
  GREEN(
    `✓ check-nav-sections-drift: ${navItems.length} ítems de nav, ${routes.length} rutas, ` +
      `${allSections.size} secciones — todo consistente`
  )
)

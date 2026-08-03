#!/usr/bin/env node
// Paridad de los 3 locales de src/lib/i18n.js.
//
// POR QUÉ EXISTE: CLAUDE.md §6 pide que toda clave nueva entre en los 3 bloques
// EN EL MISMO COMMIT. Hasta ahora eso dependía de que alguien se acordara; una
// clave que existe solo en español no rompe nada visible para quien trabaja en
// español, y aparece rota recién del lado del hub que usa inglés o ruso.
//
// Chequea cuatro cosas, todas con antecedente real en este repo:
//   1. Ninguna clave falta en ningún locale.
//   2. Ningún locale tiene una clave duplicada (la segunda pisa a la primera en
//      silencio — un objeto literal de JS no se queja).
//   3. Los placeholders `{x}` coinciden entre locales. Una traducción que se
//      come un `{n}` muestra la frase sin el número y parece un texto genérico.
//   4. Ninguna clave se quedó sin traducir de verdad: mismo texto EXACTO en los
//      3 locales cuando el texto tiene letras (los símbolos y las marcas
//      —'GMV', 'Bot', '%'— se repiten con razón y quedan exentos).
//      Este último se reporta como AVISO, no como falla.
//
// Run: node scripts/test-i18n-parity.mjs

import { TRANSLATIONS, LANGUAGES } from '../src/lib/i18n.js'
import { readFileSync } from 'node:fs'

let fail = 0
const problemas = []

const locales = Object.keys(TRANSLATIONS)
const declarados = LANGUAGES.map((l) => l.code ?? l)

// ── 0 · los locales del diccionario son los que la app ofrece ───────────
for (const code of declarados) {
  if (!locales.includes(code)) {
    fail++
    problemas.push(`  ✗ el selector ofrece "${code}" pero TRANSLATIONS no lo tiene`)
  }
}

// ── 1 · ninguna clave falta ────────────────────────────────────────────
const todas = new Set(locales.flatMap((l) => Object.keys(TRANSLATIONS[l])))
for (const loc of locales) {
  const faltan = [...todas].filter((k) => !(k in TRANSLATIONS[loc]))
  if (faltan.length) {
    fail++
    problemas.push(
      `  ✗ [${loc}] faltan ${faltan.length} claves:\n` +
        faltan
          .slice(0, 20)
          .map((k) => `      ${k}`)
          .join('\n') +
        (faltan.length > 20 ? `\n      … y ${faltan.length - 20} más` : '')
    )
  }
}

// ── 2 · sin duplicados ─────────────────────────────────────────────────
// El objeto ya colapsó los duplicados, así que hay que leer el archivo crudo.
const src = readFileSync(new URL('../src/lib/i18n.js', import.meta.url), 'utf8')
{
  // Un bloque por locale: se corta en las líneas `  xx: {` de primer nivel.
  const bordes = [...src.matchAll(/^ {2}([a-z]{2}): \{$/gm)]
  for (let i = 0; i < bordes.length; i++) {
    const loc = bordes[i][1]
    const desde = bordes[i].index
    const hasta = i + 1 < bordes.length ? bordes[i + 1].index : src.length
    const vistas = new Map()
    for (const m of src.slice(desde, hasta).matchAll(/^ {4}'([^']+)':/gm)) {
      vistas.set(m[1], (vistas.get(m[1]) || 0) + 1)
    }
    const dup = [...vistas].filter(([, n]) => n > 1)
    if (dup.length) {
      fail++
      problemas.push(
        `  ✗ [${loc}] ${dup.length} claves duplicadas (la última gana, en silencio):\n` +
          dup.map(([k, n]) => `      ${k} ×${n}`).join('\n')
      )
    }
  }
}

// ── 3 · los placeholders coinciden ─────────────────────────────────────
// UNIQUE, no la lista cruda: una clave con plural es un objeto con una variante
// por forma gramatical, y el ruso tiene cuatro (one/few/many/other) contra dos
// del español. Contando por variante, `{n}` aparecía 2 veces en es y 4 en ru y
// las 18 claves con plural del repo salían reportadas como error — la primera
// versión de este script las marcó a todas, y el problema era el script.
const phs = (v) => {
  const txt = typeof v === 'string' ? v : Object.values(v || {}).join(' ')
  return [...new Set([...String(txt).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()
}

// ── 3b · las claves con plural tienen las formas que su idioma necesita ──
// Un ruso con solo {one, other} cae al fallback de `translate` y muestra la
// forma equivocada para 2, 3 o 4 — que en ruso es una forma distinta, no un
// matiz.
const FORMAS = { es: ['one', 'other'], en: ['one', 'other'], ru: ['one', 'few', 'many', 'other'] }
for (const loc of locales) {
  for (const [k, v] of Object.entries(TRANSLATIONS[loc])) {
    if (typeof v !== 'object' || v == null) continue
    const faltan = (FORMAS[loc] || ['one', 'other']).filter((f) => !(f in v))
    if (faltan.length) {
      fail++
      problemas.push(`  ✗ [${loc}] ${k} sin las formas plurales: ${faltan.join(', ')}`)
    }
  }
}
const base = locales[0]
for (const k of Object.keys(TRANSLATIONS[base])) {
  const esperado = phs(TRANSLATIONS[base][k]).join(',')
  for (const loc of locales.slice(1)) {
    if (!(k in TRANSLATIONS[loc])) continue
    const actual = phs(TRANSLATIONS[loc][k]).join(',')
    if (actual !== esperado) {
      fail++
      problemas.push(
        `  ✗ [${k}] placeholders distintos — ${base}: {${esperado}} · ${loc}: {${actual}}`
      )
    }
  }
}

// ── 4 · sin traducir (AVISO, no falla) ─────────────────────────────────
const sinTraducir = []
for (const k of Object.keys(TRANSLATIONS[base])) {
  const vals = locales.map((l) => TRANSLATIONS[l][k])
  if (vals.some((v) => typeof v !== 'string')) continue
  if (!vals.every((v) => v === vals[0])) continue
  // Un texto sin letras (números, símbolos, '%') o de una sola palabra corta
  // que suele ser marca o sigla ('GMV', 'Bot', 'Rank') se repite con razón.
  if (!/\p{L}{4,}/u.test(vals[0])) continue
  if (!/\s/.test(vals[0].trim())) continue
  sinTraducir.push(k)
}

const totalClaves = Object.keys(TRANSLATIONS[base]).length
console.log(`\nLocales: ${locales.join(', ')} · ${totalClaves} claves en "${base}"`)
if (sinTraducir.length) {
  console.log(
    `\nAviso · ${sinTraducir.length} claves con el MISMO texto en los 3 locales ` +
      `(puede ser correcto — nombre propio, fórmula — o una traducción olvidada):`
  )
  sinTraducir.slice(0, 15).forEach((k) => console.log(`   · ${k}`))
  if (sinTraducir.length > 15) console.log(`   … y ${sinTraducir.length - 15} más`)
}

if (fail > 0) {
  console.log('\nFallidos:')
  problemas.forEach((p) => console.log(p))
  console.log(`\nResultado: ${fail} problemas de paridad`)
  process.exit(1)
}
console.log('\nParidad de locales OK ✓')

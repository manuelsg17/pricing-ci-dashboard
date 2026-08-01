// Guard: dos migraciones no pueden compartir versión.
//
// POR QUÉ EXISTE
// El 2026-08-01, dos frentes de trabajo en paralelo crearon
// `20250101027300_ci_duration_single_source.sql` y
// `20250101027300_complete_section_write_map.sql`. Se resolvió moviendo una a
// `...027400` — y el otro frente, sin saberlo, eligió ESE mismo número para su
// migración siguiente. La colisión se reprodujo sola en menos de una hora.
//
// La CLI de Supabase indexa las migraciones por el prefijo numérico: dos
// archivos con la misma versión no son dos migraciones, son una versión
// duplicada. `supabase db push` falla, o —peor— aplica una sola y la otra
// queda fuera del historial versionado, que es el "drift inexplicable" que
// CLAUDE.md §9 pide evitar. Y se descubre durante el deploy, que es el peor
// momento posible.
//
// Este chequeo cuesta milisegundos y corre en `test:all`, así que la colisión
// se ve al commitear en vez de al desplegar.

import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')

let fallos = 0

// Agrupa archivos .sql por el prefijo de versión (todo lo anterior al primer
// guion bajo) y reporta cualquier prefijo con más de un archivo.
function revisar(dir, etiqueta, extraerVersion) {
  let archivos
  try {
    archivos = readdirSync(join(RAIZ, dir)).filter((f) => f.endsWith('.sql'))
  } catch {
    console.error(`  ✗ no se pudo leer ${dir}`)
    fallos++
    return
  }

  const porVersion = new Map()
  for (const f of archivos) {
    const v = extraerVersion(f)
    if (v == null) continue
    if (!porVersion.has(v)) porVersion.set(v, [])
    porVersion.get(v).push(f)
  }

  const choques = [...porVersion.entries()].filter(([, fs]) => fs.length > 1)
  if (choques.length === 0) {
    console.log(`  ✓ ${etiqueta}: ${porVersion.size} versiones, ninguna duplicada`)
    return
  }

  for (const [v, fs] of choques) {
    console.error(`  ✗ ${etiqueta}: la versión "${v}" la usan ${fs.length} archivos:`)
    for (const f of fs) console.error(`      · ${f}`)
    fallos++
  }
}

console.log('[1] supabase/migrations — versiones con timestamp')
// `20250101027400_lo_que_sea.sql` → "20250101027400"
revisar('supabase/migrations', 'migrations', (f) => {
  const m = /^(\d+)_/.exec(f)
  return m ? m[1] : null
})

console.log('[2] supabase/ — gemelos numerados (histórico del repo)')
// `193_lo_que_sea.sql` → "193". `seed.sql` y otros sin número se ignoran.
revisar('supabase', 'numerados', (f) => {
  const m = /^(\d+)_/.exec(f)
  return m ? m[1] : null
})

if (fallos > 0) {
  console.error(
    `\n✗ ${fallos} colisión(es) de versión.\n` +
      '  Dos migraciones con la misma versión rompen `supabase db push` o dejan\n' +
      '  una fuera del historial en silencio (CLAUDE.md §9).\n' +
      '  Fix: renombrar la migración MÁS NUEVA (la que todavía no se commiteó)\n' +
      '  a la versión siguiente libre, en supabase/ y en supabase/migrations/.'
  )
  process.exit(1)
}

console.log('\n✓ sin colisiones de versión de migración')

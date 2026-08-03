#!/usr/bin/env node
// Tests para isYangoBrand / rivalsOf — quién es rival de quién en el dashboard.
//
// POR QUÉ EXISTE: los KPI del dashboard (Líder de mercado, Posición Yango, Yango
// vs Competencia, % Liderazgo) excluían del set rival solo al string exacto de
// `compareVs`. Como el catálogo de Economy/Comfort trae 'YangoComfort' como
// competidor, Yango competía contra una marca propia: el líder de mercado podía
// ser YangoComfort, el ranking contaba una posición de más, y el promedio de la
// competencia quedaba contaminado.
//
// La base nunca tuvo ese problema — arma el lado rival con `!~~* 'Yango%'`
// (mig 163). Estos tests fijan que el cliente use el MISMO criterio.
//
// Run: node scripts/test-yango-brand.mjs

import { isYangoBrand, rivalsOf } from '../src/lib/normalize.js'

let pass = 0
let fail = 0
const failures = []

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    failures.push(`  ✗ ${label}\n      esperaba ${e}\n      obtuvo   ${a}`)
  }
}

// ── isYangoBrand: espejo de NOT ILIKE 'Yango%' ──────────────────────────
const marcasYango = [
  'Yango',
  'YangoComfort',
  'YangoComfort+',
  'YangoPlus',
  'YangoPremier',
  'YangoXL',
  'YangoEconomy',
  // La convención de Corp usa espacios — el ILIKE del SQL las agarra igual.
  'Yango Comfort',
  'Yango Comfort+',
  'Yango Premier',
  'Yango XL',
  // ILIKE no distingue mayúsculas.
  'yango',
  'YANGO',
  'yangocomfort',
  'YANGOPLUS',
  // El trim replica el btrim que el resto del pipeline ya aplica.
  '  Yango  ',
]
for (const m of marcasYango) {
  check(`isYangoBrand(${JSON.stringify(m)}) es marca propia`, isYangoBrand(m), true)
}

const rivalesReales = [
  'Uber',
  'InDrive',
  'Didi',
  'Cabify',
  'CabifyLite',
  'CabifyExtraComfort',
  'CabifyXL',
  'uber',
  // No es prefijo: 'Yango' tiene que estar AL PRINCIPIO, igual que el LIKE.
  'MiYango',
  'Super Yango',
]
for (const c of rivalesReales) {
  check(`isYangoBrand(${JSON.stringify(c)}) es rival`, isYangoBrand(c), false)
}

check('isYangoBrand(null)', isYangoBrand(null), false)
check('isYangoBrand(undefined)', isYangoBrand(undefined), false)
check('isYangoBrand("")', isYangoBrand(''), false)

// ── rivalsOf: el bug concreto que motivó todo esto ──────────────────────
const CATALOGO_EC = ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify']

check(
  'base Yango: ninguna sub-marca Yango es rival',
  rivalsOf(CATALOGO_EC, 'Yango'),
  ['Uber', 'Didi', 'InDrive', 'Cabify']
)

check(
  'base YangoComfort: Yango tampoco es su rival',
  rivalsOf(CATALOGO_EC, 'YangoComfort'),
  ['Uber', 'Didi', 'InDrive', 'Cabify']
)

// Contracara deliberada: si el usuario elige un competidor real como base,
// las marcas Yango SÍ son sus rivales. "Uber vs el resto" tiene que ver a Yango
// del otro lado o no significa nada.
check(
  'base Uber: las marcas Yango sí son rivales',
  rivalsOf(CATALOGO_EC, 'Uber'),
  ['Yango', 'YangoComfort', 'Didi', 'InDrive', 'Cabify']
)

check(
  'la base nunca es rival de sí misma',
  rivalsOf(['Uber', 'Didi'], 'Uber'),
  ['Didi']
)

// Corp: nombres con espacio, mismo resultado.
check(
  'Corp: las sub-marcas con espacio también salen del set',
  rivalsOf(['Yango', 'Yango Comfort', 'Yango Premier', 'Cabify', 'CabifyXL'], 'Yango'),
  ['Cabify', 'CabifyXL']
)

// Un catálogo de puras marcas Yango deja el set rival vacío — y eso es correcto:
// mejor "sin comparables" que inventar un rival que no existe.
check(
  'catálogo solo Yango → sin rivales',
  rivalsOf(['Yango', 'YangoComfort', 'YangoXL'], 'Yango'),
  []
)

check('rivalsOf con no-array', rivalsOf(null, 'Yango'), [])
check('rivalsOf con lista vacía', rivalsOf([], 'Yango'), [])

// Base que no está en el catálogo: no rompe, y no se auto-agrega.
check(
  'base ausente del catálogo',
  rivalsOf(['Uber', 'Didi'], 'Yango'),
  ['Uber', 'Didi']
)

// ── La regresión, escrita como test ─────────────────────────────────────
// Precios SINTÉTICOS (elegidos acá, no medidos en producción) que muestran la
// forma del error: una sub-marca Yango más cara que los rivales infla el
// promedio "de la competencia" y hace parecer que Yango está mucho más cerca
// del mercado de lo que está.
{
  const wa = { Yango: 13.09, YangoComfort: 15.2, Uber: 9.8, Didi: 10.1, InDrive: 10.11 }
  const promedio = (comps) => comps.reduce((s, c) => s + wa[c], 0) / comps.length
  const redondear = (n) => Math.round(n * 100) / 100

  const rivales = rivalsOf(Object.keys(wa), 'Yango')
  const deltaCorrecto = ((wa.Yango - promedio(rivales)) / promedio(rivales)) * 100

  const rivalesViejo = Object.keys(wa).filter((c) => c !== 'Yango') // el bug
  const deltaViejo = ((wa.Yango - promedio(rivalesViejo)) / promedio(rivalesViejo)) * 100

  check('el set rival correcto excluye a YangoComfort', rivales.includes('YangoComfort'), false)
  check('delta con el set rival correcto', redondear(deltaCorrecto), 30.86)
  check('delta con el bug: casi la mitad', redondear(deltaViejo), 15.82)
  // Y el líder de mercado: con el bug, el más barato del set podía ser propio.
  check(
    'líder de mercado sale del set rival, no del catálogo entero',
    rivales.every((c) => !isYangoBrand(c)),
    true
  )
  // Caso "Yango pierde contra sí misma": si la sub-marca es la MÁS BARATA, el
  // % Liderazgo la marcaba como derrota. Con el set correcto, gana.
  {
    const p = { Yango: 10.0, YangoComfort: 9.5, Uber: 11.0, Didi: 12.0 }
    const rivs = rivalsOf(Object.keys(p), 'Yango')
    const masBaratoViejo = Object.keys(p).sort((a, b) => p[a] - p[b])[0]
    const masBaratoNuevo = [...rivs, 'Yango'].sort((a, b) => p[a] - p[b])[0]
    check('con el bug el líder era la sub-marca propia', masBaratoViejo, 'YangoComfort')
    check('con el set correcto el líder es Yango', masBaratoNuevo, 'Yango')
  }
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(f))
  process.exit(1)
}
console.log('Todo OK ✓')

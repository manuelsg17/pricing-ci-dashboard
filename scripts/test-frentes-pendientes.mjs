// ════════════════════════════════════════════════════════════════════════
// Frentes con trabajo sin guardar.
//
// El caso real que motivó esto (2026-08-11): Raisa y Mafer midieron
// Corporativo, apretaron "Guardar progreso" estando paradas en la pestaña de
// TukTuk, y el guardado se llevó TukTuk. Corp se quedó sin guardar y ellas no
// tenían forma de enterarse.
//
// Los dos errores posibles duelen en direcciones opuestas:
//   · Listar de menos → el aviso no aparece y se repite exactamente el
//     incidente que esto vino a evitar. Es el caro.
//   · Listar de más → el hub ve "tenés pendientes" sobre frentes ya guardados,
//     deja de creerle al aviso, y volvemos al punto de partida.
// Run: node scripts/test-frentes-pendientes.mjs
// ════════════════════════════════════════════════════════════════════════

import { frentesSinGuardar, frenteGuardado } from '../src/lib/frentesPendientes.js'

let pass = 0
let fail = 0
const fallos = []
function ok(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    fallos.push(label)
    console.log(`  ✗ ${label}`)
  }
}

const buckets = (r) => r.map((f) => f.bucket)

console.log('\n══ frentes pendientes ══')

{
  console.log('\n[1] frenteGuardado: el contador de ediciones vs. el de guardados')

  ok(frenteGuardado({ editSeq: 5, savedSeq: 5 }), 'guardado justo después de editar → guardado')
  ok(frenteGuardado({ editSeq: 3, savedSeq: 7 }), 'guardado más veces que editado → guardado')
  ok(!frenteGuardado({ editSeq: 6, savedSeq: 5 }), 'una edición después del guardado → pendiente')

  // EL BORDE QUE IMPORTA: tras un F5 los dos contadores arrancan de cero. Un
  // borrador rescatado de localStorage tiene que caer del lado PENDIENTE.
  ok(!frenteGuardado({ editSeq: 0, savedSeq: -1 }), 'recién recargada la página → pendiente')
  ok(!frenteGuardado({}), 'sin datos → pendiente (nunca "ya está")')
  ok(frenteGuardado({ editSeq: 0, savedSeq: 0 }), 'guardado sin ediciones nuevas → guardado')
}

{
  console.log('\n[2] frentesSinGuardar: EL incidente del 2026-08-11')

  // Mafer: midió Corp, apretó Guardar parada en TukTuk. TukTuk quedó guardado,
  // Corp no.
  const r = frentesSinGuardar({
    fronts: ['Corp', 'TT~Lima~Comas'],
    llenoPorFrente: { Corp: 162, 'TT~Lima~Comas': 54 },
    editSeq: { Corp: 162, 'TT~Lima~Comas': 54 },
    savedSeq: { 'TT~Lima~Comas': 54 },
  })
  ok(buckets(r).join() === 'Corp', 'Corp aparece como pendiente y TukTuk no')
  ok(r[0].lleno === 162, 'y dice CUÁNTAS celdas están en juego')
}

{
  console.log('\n[3] frentesSinGuardar: cuándo NO hay que avisar')

  ok(
    frentesSinGuardar({
      fronts: ['Corp'],
      llenoPorFrente: { Corp: 162 },
      editSeq: { Corp: 162 },
      savedSeq: { Corp: 162 },
    }).length === 0,
    'todo guardado → no se avisa nada'
  )
  ok(
    frentesSinGuardar({
      fronts: ['Corp'],
      llenoPorFrente: { Corp: 0 },
      editSeq: {},
      savedSeq: {},
    }).length === 0,
    'un frente abierto pero vacío no es trabajo sin guardar'
  )

  // `null` = el hub no volvió a abrir ese frente en esta carga de página, así
  // que no hay rebanada en memoria. No se puede prometer guardar lo que no se
  // tiene, ni afirmar un número que no se midió.
  ok(
    frentesSinGuardar({
      fronts: ['Corp', 'Lima'],
      llenoPorFrente: { Corp: 162, Lima: null },
      editSeq: { Corp: 5 },
      savedSeq: {},
    }).length === 1,
    'un frente de contenido DESCONOCIDO no se lista'
  )

  ok(frentesSinGuardar({}).length === 0, 'sin frentes no rompe')
  ok(frentesSinGuardar({ fronts: null }).length === 0, 'fronts null tampoco')
}

{
  console.log('\n[4] frentesSinGuardar: varios frentes a la vez')

  const r = frentesSinGuardar({
    fronts: ['Corp', 'Lima', 'TT~Lima~Comas', 'Arequipa'],
    llenoPorFrente: { Corp: 162, Lima: 108, 'TT~Lima~Comas': 54, Arequipa: 12 },
    editSeq: { Corp: 162, Lima: 108, 'TT~Lima~Comas': 54, Arequipa: 12 },
    savedSeq: { Lima: 108 },
  })
  ok(r.length === 3, 'lista los 3 que faltan, no el ya guardado')
  ok(
    buckets(r).join() === 'Corp,TT~Lima~Comas,Arequipa',
    'y conserva el orden en que se abrieron'
  )

  // El array de frentes puede traer repetidos (`buildFronts` une alcance
  // declarado + extras + el actual). Avisar dos veces del mismo frente haría
  // que "Guardar todo" lo guarde dos veces.
  const dup = frentesSinGuardar({
    fronts: ['Corp', 'Corp', 'Corp'],
    llenoPorFrente: { Corp: 162 },
    editSeq: { Corp: 162 },
    savedSeq: {},
  })
  ok(dup.length === 1, 'un frente repetido en la lista se cuenta UNA vez')
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} pasaron, ${fail} fallaron`)
if (fail) console.error('Fallaron:\n  - ' + fallos.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)

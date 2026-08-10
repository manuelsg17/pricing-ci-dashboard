// ════════════════════════════════════════════════════════════════════════
// Presencia — "quién más está en este bucket ahora".
//
// El aviso se agregó el 2026-08-10 porque se puso a TRES hubs a medir
// Corporativo el mismo día para triplicar la muestra, y no se veían entre sí.
//
// Los dos casos que este test protege son opuestos y los dos duelen:
//   · Si `mismaPresencia` devuelve false de más → la grilla de Ingresar CI
//     (108-324 celdas SIN React.memo) reconcilia entera cada 20 segundos para
//     mostrar el mismo texto. Es el caso que CLAUDE.md §5 prohíbe.
//   · Si devuelve true de más → entra un hub nuevo al bucket y el aviso nunca
//     aparece. La función queda "optimizando" a costa de no servir para nada.
// Run: node scripts/test-presencia.mjs
// ════════════════════════════════════════════════════════════════════════

import { mismaPresencia, presenciaEnBucket, EMPTY_PRESENCE } from '../src/lib/presencia.js'

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

const hub = (email, city, zone = null, scope = null) => ({
  user_email: email,
  city,
  zone,
  scope_label: scope,
  // Cambia en CADA latido. Si la comparación lo mirara, siempre daría
  // "cambió" y no habría ahorro alguno.
  last_seen_at: new Date().toISOString(),
})

console.log('\n══ presencia ══')

{
  console.log('\n[1] mismaPresencia: cuándo NO hay que re-renderizar')

  const a = [hub('edu@x.com', 'Corp'), hub('rai@x.com', 'Corp')]
  const b = [hub('edu@x.com', 'Corp'), hub('rai@x.com', 'Corp')]
  ok(mismaPresencia(a, b), 'mismos hubs, objetos distintos → es la misma presencia')

  // EL CASO QUE JUSTIFICA LA FUNCIÓN: el sondeo devuelve lo mismo pero con
  // latidos nuevos, 3 veces por minuto, todo el día.
  const conLatidoNuevo = a.map((p) => ({ ...p, last_seen_at: '2099-01-01T00:00:00Z' }))
  ok(mismaPresencia(a, conLatidoNuevo), 'un latido nuevo NO cuenta como cambio')

  ok(mismaPresencia([], []), 'dos vacías son iguales')
  ok(mismaPresencia(null, undefined), 'null y undefined no rompen')
  ok(mismaPresencia(null, []), 'null vs vacía son iguales')

  // El orden no está garantizado por la RPC.
  ok(mismaPresencia(a, [b[1], b[0]]), 'el orden no cuenta')
}

{
  console.log('\n[2] mismaPresencia: cuándo SÍ hay que re-renderizar')

  const base = [hub('edu@x.com', 'Corp')]
  ok(!mismaPresencia(base, []), 'el otro hub se fue → cambió')
  ok(!mismaPresencia([], base), 'llegó un hub → cambió')
  ok(
    !mismaPresencia(base, [hub('edu@x.com', 'Corp'), hub('rai@x.com', 'Corp')]),
    'llegó un SEGUNDO hub → cambió'
  )
  ok(!mismaPresencia(base, [hub('rai@x.com', 'Corp')]), 'es otra persona → cambió')
  ok(!mismaPresencia(base, [hub('edu@x.com', 'Lima')]), 'se movió de ciudad → cambió')
  ok(
    !mismaPresencia([hub('edu@x.com', 'Lima', 'Chorrillos')], [hub('edu@x.com', 'Lima', 'Surco')]),
    'cambió de distrito → cambió'
  )
  ok(
    !mismaPresencia([hub('e@x.com', 'Lima_Airport_A', null, 'A')], [hub('e@x.com', 'Lima_Airport_A', null, 'A+B')]),
    'amplió su alcance declarado → cambió'
  )

  // Mismo largo pero gente distinta: el atajo de comparar solo length dejaría
  // pasar esto, y el aviso mostraría a quien ya se fue.
  ok(
    !mismaPresencia(
      [hub('a@x.com', 'Corp'), hub('b@x.com', 'Corp')],
      [hub('a@x.com', 'Corp'), hub('c@x.com', 'Corp')]
    ),
    'mismo largo pero se cambió una persona → cambió'
  )
}

{
  console.log('\n[3] presenciaEnBucket: solo los que están en MI bucket')

  const todos = [
    hub('edu@x.com', 'Corp'),
    hub('rai@x.com', 'Corp'),
    hub('ana@x.com', 'Lima'),
    hub('luz@x.com', 'Lima', 'Chorrillos'),
    hub('max@x.com', 'Lima_Airport_A'),
  ]

  ok(presenciaEnBucket(todos, 'Corp', null).length === 2, 'Corp ve a sus 2')
  ok(presenciaEnBucket(todos, 'Lima', null).length === 1, 'Lima normal ve 1, no al de Chorrillos')
  ok(presenciaEnBucket(todos, 'Lima', 'Chorrillos').length === 1, 'Chorrillos ve al suyo')
  ok(presenciaEnBucket(todos, 'Lima', 'Surco').length === 0, 'un distrito vacío no ve a nadie')
  ok(presenciaEnBucket(todos, 'Arequipa', null).length === 0, 'otra ciudad no ve a nadie')

  // Corp es EL caso del ejercicio: la RPC devuelve zone NULL, el cliente puede
  // tener '' o undefined. Si no se normalizaran, el aviso no saldría nunca
  // justo donde se lo necesita.
  ok(presenciaEnBucket(todos, 'Corp', '').length === 2, "zone '' se trata como null")
  ok(presenciaEnBucket(todos, 'Corp', undefined).length === 2, 'zone undefined también')
  ok(
    presenciaEnBucket([{ user_email: 'z@x.com', city: 'Corp', zone: '' }], 'Corp', null).length === 1,
    "y del otro lado: zone '' en la fila también"
  )

  ok(presenciaEnBucket(null, 'Corp', null).length === 0, 'sin presencia no rompe')
  ok(presenciaEnBucket(EMPTY_PRESENCE, 'Corp', null).length === 0, 'lista vacía tampoco')
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} pasaron, ${fail} fallaron`)
if (fail) console.error('Fallaron:\n  - ' + fallos.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)

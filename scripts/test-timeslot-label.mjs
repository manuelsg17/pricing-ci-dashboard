#!/usr/bin/env node
// Tests para timeslotLabel() en src/lib/constants.js — etiqueta ESTABLE del
// turno (mig 148) derivada de la hora CANÓNICA, usada para desacoplar el
// DELETE/reload de la grilla de la hora REAL de captura.
// Run: node scripts/test-timeslot-label.mjs

import { timeslotLabel } from '../src/lib/constants.js'

let pass = 0,
  fail = 0,
  failures = []
function assert(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗ ${label}`)
  }
}

console.log('\n══ timeslotLabel tests ══')

{
  console.log('\n[1] Los 3 turnos canónicos de ci_timeslots (mig 10)')
  assert(timeslotLabel('08:00') === 'Morning', "08:00 (Mañana) → 'Morning'")
  assert(timeslotLabel('13:00') === 'Midday', "13:00 (Tarde) → 'Midday'")
  assert(timeslotLabel('18:00') === 'Evening', "18:00 (Noche) → 'Evening'")
}

{
  console.log('\n[2] Bordes exactos de los 5 cortes (mismos que get_time_of_day() SQL)')
  assert(timeslotLabel('05:59') === 'Early_morning', '05:59 → Early_morning')
  assert(timeslotLabel('06:00') === 'Morning', '06:00 (borde inclusive) → Morning')
  assert(timeslotLabel('11:59') === 'Morning', '11:59 → Morning')
  assert(timeslotLabel('12:00') === 'Midday', '12:00 (borde inclusive) → Midday')
  assert(timeslotLabel('13:59') === 'Midday', '13:59 → Midday')
  assert(timeslotLabel('14:00') === 'Afternoon', '14:00 (borde inclusive) → Afternoon')
  assert(timeslotLabel('17:59') === 'Afternoon', '17:59 → Afternoon')
  assert(timeslotLabel('18:00') === 'Evening', '18:00 (borde inclusive) → Evening')
  assert(timeslotLabel('23:59') === 'Evening', '23:59 → Evening')
}

{
  console.log('\n[3] Hora REAL tardía dentro del mismo turno no cambia el label')
  // El punto entero de la mig: aunque el HP guarde Tarde a las 18:05 (hora
  // real de captura, cruzando el corte de Evening), el LABEL sigue
  // derivándose de la hora CANÓNICA del turno (13:00 = Midday) — el
  // caller nunca le pasa la hora real a timeslotLabel(), solo ts.start_time.
  assert(timeslotLabel('13:00') === 'Midday', 'la hora canónica de Tarde siempre da Midday')
}

{
  console.log('\n[4] Entradas inválidas no crashean')
  assert(timeslotLabel(null) === null, 'null → null')
  assert(timeslotLabel('') === null, "'' → null")
  assert(timeslotLabel(undefined) === null, 'undefined → null')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')

#!/usr/bin/env node
// Tests para src/lib/format.js — separadores de miles y decimales.
// Run: node scripts/test-format.mjs

import { formatPrice, formatCurrency, formatCount, sanitizeDecimalInput } from '../src/lib/format.js'

let pass = 0, fail = 0, failures = []
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}`) }
}

console.log('\n══ format.js tests ══')

// — formatPrice: separador de miles con 2 decimales
{
  console.log('\n[1] formatPrice — separador de miles')
  assert(formatPrice(60000)    === '60,000.00',    '60000 → 60,000.00')
  assert(formatPrice(1234.5)   === '1,234.50',     '1234.5 → 1,234.50')
  assert(formatPrice(100)      === '100.00',       '100 → 100.00')
  assert(formatPrice(0)        === '0.00',         '0 → 0.00')
  assert(formatPrice(-1500)    === '-1,500.00',    'Negativo: -1500 → -1,500.00')
  assert(formatPrice(20386.94) === '20,386.94',    '20386.94 → 20,386.94 (caso real Bogota)')
  assert(formatPrice(1000000)  === '1,000,000.00', 'Millón con doble coma')
  assert(formatPrice(null)         === '—', 'null → —')
  assert(formatPrice(undefined)    === '—', 'undefined → —')
  assert(formatPrice(NaN)          === '—', 'NaN → —')
  assert(formatPrice('not_number') === '—', 'string no numérico → —')
  assert(formatPrice('1500')       === '1,500.00', 'string numérico parseable funciona')
}

// — formatPrice noDecimals
{
  console.log('\n[2] formatPrice noDecimals')
  assert(formatPrice(60000, { noDecimals: true })   === '60,000',   'sin decimales')
  assert(formatPrice(1234.7, { noDecimals: true })  === '1,235',    'sin decimales redondea')
  assert(formatPrice(1000000, { noDecimals: true }) === '1,000,000','millón sin decimales')
}

// — formatCurrency
{
  console.log('\n[3] formatCurrency')
  assert(formatCurrency(60000, 'COP') === 'COP 60,000.00', 'con currency: COP 60,000.00')
  assert(formatCurrency(60000, '')    === '60,000.00',     'sin currency: 60,000.00')
  assert(formatCurrency(60000)        === '60,000.00',     'currency undefined: sin prefijo')
  assert(formatCurrency(null, 'COP')  === '—',             'null aún con currency: —')
}

// — formatCount
{
  console.log('\n[4] formatCount — enteros con separador de miles')
  assert(formatCount(12345)   === '12,345',  '12345 → 12,345')
  assert(formatCount(1000000) === '1,000,000','millón')
  assert(formatCount(0)       === '0',       '0 → 0')
  assert(formatCount(null)    === '—',       'null → —')
}

// — sanitizeDecimalInput: decimal siempre en punto (Ingresar CI)
{
  console.log('\n[5] sanitizeDecimalInput — solo puntos, como el Excel viejo')
  assert(sanitizeDecimalInput('13,2') === '13.2', 'coma tipeada → punto: 13,2 → 13.2')
  assert(sanitizeDecimalInput('13.2') === '13.2', 'punto ya correcto se mantiene')
  assert(sanitizeDecimalInput('13')   === '13',   'entero se mantiene')
  assert(sanitizeDecimalInput('')     === '',     'vacío se mantiene vacío')
  assert(sanitizeDecimalInput('1.2.3') === '1.23', 'puntos de más se colapsan: 1.2.3 → 1.23')
  assert(sanitizeDecimalInput('13,2abc') === '13.2', 'letras se descartan: 13,2abc → 13.2')
  assert(sanitizeDecimalInput('  13,50  ') === '13.50', 'espacios se descartan (no son dígito ni punto)')
  assert(sanitizeDecimalInput(null) === '', 'null → vacío, no crashea')
  assert(sanitizeDecimalInput(undefined) === '', 'undefined → vacío, no crashea')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach(f => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')

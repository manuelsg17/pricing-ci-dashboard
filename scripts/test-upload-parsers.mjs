#!/usr/bin/env node
// Tests para la capa de parseo del upload de Excel (src/lib/uploadParsers.js),
// extraída de Upload.jsx en 2026-07-31. Es el camino de ingesta masiva a
// producción y hasta ahora no tenía NINGÚN test — no por decisión, sino
// porque vivía dentro del .jsx y no se podía importar.
//
// Los casos de abajo no son inventados: son los formatos que realmente
// aparecen en los Excel de los hubs (fechas serial, precios con S/., coma
// decimal, "Rush hour"/"Valley", celdas combinadas) y los bugs ya documentados
// en el propio código (Corp con Yango anónimo, "corp lima (1)" detectado como
// Lima, mig 69/71/94).
// Run: node scripts/test-upload-parsers.mjs

import {
  excelSerialToDate,
  parseExcelDate,
  parseExcelTime,
  toNumeric,
  toInt,
  parseBool,
  cleanStr,
  parseRows,
  detectCity,
} from '../src/lib/uploadParsers.js'

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

console.log('\n══ uploadParsers tests ══')

{
  console.log('\n[1] Fechas: serial de Excel')
  // El serial cuenta días desde 1899-12-30 — de ahí el offset 25569 contra la
  // época Unix. Valores verificados: si alguien "corrige" ese 25569, estas 4
  // aserciones se caen (que es justo el punto).
  assert(excelSerialToDate(46023) === '2026-01-01', '46023 → 2026-01-01')
  assert(excelSerialToDate(45658) === '2025-01-01', '45658 → 2025-01-01 (año anterior)')
  assert(parseExcelDate(46023) === '2026-01-01', 'número serial directo')
  assert(parseExcelDate('46023') === '2026-01-01', 'serial como string numérico')
  assert(parseExcelDate(46023.75) === '2026-01-01', 'serial con parte decimal (hora) → se trunca')
}

{
  console.log('\n[2] Fechas: formatos de texto')
  assert(parseExcelDate('01/02/2026') === '2026-02-01', 'DD/MM/YYYY (no MM/DD): 01/02 → 1 de feb')
  assert(parseExcelDate('1/2/2026') === '2026-02-01', 'sin ceros a la izquierda se rellena')
  assert(parseExcelDate('01-02-2026') === '2026-02-01', 'DD-MM-YYYY')
  assert(parseExcelDate('2026-02-01') === '2026-02-01', 'ISO se conserva')
  assert(parseExcelDate('2026-02-01T10:30:00') === '2026-02-01', 'ISO con hora → se corta el día')
}

{
  console.log('\n[3] Fechas: entradas inválidas → null (nunca una fecha inventada)')
  assert(parseExcelDate(null) === null, 'null')
  assert(parseExcelDate('') === null, 'string vacío')
  assert(parseExcelDate(undefined) === null, 'undefined')
  assert(parseExcelDate('mañana') === null, 'texto libre')
  assert(parseExcelDate('31/31/2026') === '2026-31-31', 'fecha imposible: pasa (validación es de la BD)')
}

{
  console.log('\n[4] Horas')
  assert(parseExcelTime('08:30') === '08:30', 'HH:MM se conserva')
  assert(parseExcelTime('08:30:15') === '08:30:15', 'HH:MM:SS se conserva')
  // 0.5 = mediodía. Este es el caso que generó la categoría basura
  // "0.7694444444444445" en producción: una hora fraccionaria que terminó en
  // la columna equivocada.
  assert(parseExcelTime(0.5) === '12:00:00', 'fracción 0.5 → mediodía')
  assert(parseExcelTime(0.25) === '06:00:00', 'fracción 0.25 → 06:00')
  assert(parseExcelTime(0.7694444444444445) === '18:28:00', 'la fracción del bug real → 18:28')
  assert(parseExcelTime(null) === null, 'null → null')
  assert(parseExcelTime('tarde') === null, 'texto libre → null')
}

{
  console.log('\n[5] Números: moneda y coma decimal')
  assert(toNumeric('S/.9.00') === 9, 'prefijo S/. se descarta')
  assert(toNumeric('$8.50') === 8.5, 'prefijo $ se descarta')
  assert(toNumeric('13,2') === 13.2, 'coma decimal → punto')
  assert(toNumeric(12.5) === 12.5, 'número pasa tal cual')
  assert(toNumeric('-5') === -5, 'negativo se conserva (el signo no es prefijo de moneda)')
  assert(toNumeric('') === null, 'vacío → null')
  assert(toNumeric(null) === null, 'null → null')
  assert(toNumeric('abc') === null, 'texto → null, no NaN')
  assert(!Number.isNaN(toNumeric('abc')), 'nunca devuelve NaN (rompería el INSERT)')
}

{
  console.log('\n[6] Enteros')
  assert(toInt('31') === 31, 'string → entero')
  assert(toInt(30.6) === 31, 'redondea, no trunca')
  assert(toInt(null) === null, 'null → null')
}

{
  console.log('\n[7] Booleanos: las variantes reales de los Excel')
  assert(parseBool('si') === true, '"si"')
  assert(parseBool('sí') === true, '"sí" con tilde')
  assert(parseBool('yes') === true, '"yes"')
  assert(parseBool('TRUE') === true, 'mayúsculas')
  assert(parseBool('Rush Hour') === true, '"Rush Hour"')
  assert(parseBool('no') === false, '"no"')
  assert(parseBool(1) === true, 'número 1')
  assert(parseBool(0) === false, 'número 0')
  assert(parseBool(true) === true, 'booleano pasa tal cual')
  assert(parseBool('') === null, 'vacío → null (NO false: "sin dato" ≠ "no")')
  assert(parseBool('n/a') === null, '"n/a" → null')
  assert(parseBool('null') === null, '"null" literal → null')
}

{
  console.log('\n[8] Strings')
  assert(cleanStr('  Uber  ') === 'Uber', 'recorta espacios')
  assert(cleanStr('   ') === null, 'solo espacios → null')
  assert(cleanStr(null) === null, 'null → null')
  assert(cleanStr(0) === '0', 'el cero NO se pierde')
}

{
  console.log('\n[9] detectCity: "corp" gana sobre el nombre de ciudad embebido')
  // Bug real (mig 69): "corp lima (1)" se detectaba como Lima y el flatten de
  // Yango-master borraba las sub-marcas, perdiendo 1190 filas.
  const cfg = { botCityMap: {} }
  assert(detectCity('corp lima (1)', cfg) === 'Corp', '"corp lima (1)" → Corp, no Lima')
  assert(detectCity('lima_pricing_ci_corp', cfg) === 'Corp', 'sufijo corp → Corp')
  assert(detectCity('lima_pricing_ci_final', cfg) === 'Lima', 'Lima normal')
  assert(detectCity('tru_pricing_ci_final', cfg) === 'Trujillo', 'Trujillo')
  assert(detectCity('arq_pricing_ci_final', cfg) === 'Arequipa', 'Arequipa')
}

{
  console.log('\n[10] detectCity: aeropuerto cae a la ciudad BASE (mig 78-85)')
  // Las cities *_Airport legacy ya no existen: la clasificación A/B la hace la
  // columna Zone + el trigger. Si esto empezara a devolver 'Lima_Airport_A',
  // el ruteo por zona quedaría cortocircuitado.
  const cfg = { botCityMap: {} }
  assert(detectCity('lima_airport_ci_final', cfg) === 'Lima', 'aeropuerto Lima → Lima base')
  assert(detectCity('arq_airport_ci_final', cfg) === 'Arequipa', 'aeropuerto ARQ → Arequipa base')
  assert(detectCity('airport', cfg) === 'Lima', '"airport" sin ciudad → Lima')
  assert(detectCity('cualquier_cosa', cfg) === null, 'sin match → null (no adivina)')
}

{
  console.log('\n[11] detectCity: botCityMap de la BD tiene prioridad sobre el fallback')
  // Un país onboardeado por el wizard debe funcionar sin tocar este archivo.
  const cfg = { botCityMap: { bogota: 'Bogota', chia: 'Chia' } }
  assert(detectCity('bogota', cfg) === 'Bogota', 'botKey exacto')
  assert(detectCity('bogota_ci_final', cfg) === 'Bogota', 'botKey como prefijo')
  assert(detectCity('chia', cfg) === 'Chia', 'ciudad nueva sin tocar código')
}

{
  console.log('\n[12] parseRows: encuentra la cabecera salteando metadata')
  const hoja = [
    ['colocar lista de eleccion', null, null],
    ['InDrive', null, null],
    ['Date', 'Competition Name', 'Category'],
    ['01/02/2026', 'Uber', 'Economy/Comfort'],
  ]
  const r = parseRows(hoja, 'Lima')
  assert(r.rows.length === 1, 'ignora las 2 filas de metadata y parsea 1 fila')
  assert(r.rows[0].observed_date === '2026-02-01', 'fecha parseada')
  assert(r.rows[0].city === 'Lima', 'ciudad inyectada')
  assert(parseRows([], 'Lima').length === 0, 'hoja vacía → []')
  assert(parseRows([['sin', 'cabecera']], 'Lima').length === 0, 'sin cabecera conocida → []')
}

{
  console.log('\n[13] parseRows: fill-down de celdas combinadas')
  // Patrón real: el hub combina celdas y solo escribe el valor en la primera.
  const hoja = [
    ['Date', 'Competition Name', 'Category', 'PriceW/ODiscount'],
    ['01/02/2026', 'Uber', 'Economy/Comfort', '10'],
    [null, null, null, '11'],
    [null, null, null, '12'],
  ]
  const r = parseRows(hoja, 'Lima')
  assert(r.rows.length === 3, 'las 3 filas sobreviven')
  assert(
    r.rows.every((x) => x.observed_date === '2026-02-01'),
    'la fecha se hereda hacia abajo'
  )
  assert(
    r.rows.every((x) => x.competition_name === 'Uber'),
    'el competidor se hereda'
  )
  assert(r.rows[2].price_without_discount === 12, 'el precio propio de cada fila NO se hereda')
}

{
  console.log('\n[14] parseRows: la fila vacía corta el fill-down entre secciones')
  const hoja = [
    ['Date', 'Competition Name', 'Category'],
    ['01/02/2026', 'Uber', 'Economy/Comfort'],
    [null, null, null], // fila vacía = separador de sección
    [null, 'Yango', 'Comfort+'], // sin fecha y sin nada que heredar
  ]
  const r = parseRows(hoja, 'Lima')
  assert(r.droppedNoDate === 1, 'la fila post-separador se descarta por falta de fecha')
  assert(r.rows.length === 1, 'solo sobrevive la fila completa')
}

{
  console.log('\n[15] parseRows: normalización de categoría y competidor')
  const hoja = [
    ['Date', 'Competition Name', 'Category', 'Distance bracket'],
    ['01/02/2026', 'Indrive', 'Economy', 'Very short'],
    ['01/02/2026', 'DiDi', 'Comfort', 'Very Long'],
  ]
  const r = parseRows(hoja, 'Lima')
  assert(r.rows[0].competition_name === 'InDrive', 'casing: Indrive → InDrive')
  assert(r.rows[1].competition_name === 'Didi', 'casing: DiDi → Didi')
  assert(r.rows[0].category === 'Economy/Comfort', 'legacy Economy → Economy/Comfort')
  assert(r.rows[1].category === 'Comfort+', 'legacy Comfort → Comfort+')
  assert(r.rows[0].distance_bracket === 'very_short', 'bracket a snake_case')
  assert(r.rows[1].distance_bracket === 'very_long', 'bracket con casing distinto')
}

{
  console.log('\n[16] parseRows: el flatten de Yango NO aplica en Corp (mig 69)')
  // Fuera de Corp, YangoPremier es una sub-marca y se aplasta a Yango.
  // En Corp son competidores legítimos separados: aplastarlos perdió 1190 filas.
  const hoja = [
    ['Date', 'Competition Name', 'Category'],
    ['01/02/2026', 'YangoPremier', 'Economy/Comfort'],
  ]
  assert(parseRows(hoja, 'Lima').rows[0].competition_name === 'Yango', 'en Lima: aplasta a Yango')

  const hojaCorp = [
    ['Date', 'Competition Name', 'Category'],
    ['01/02/2026', 'YangoPremier', 'Corp'],
  ]
  assert(
    parseRows(hojaCorp, 'Corp').rows[0].competition_name === 'YangoPremier',
    'en Corp: conserva YangoPremier'
  )
  // El chequeo es por city Y por category — un archivo mal detectado como Lima
  // pero con filas de categoría Corp tampoco debe aplastarse.
  assert(
    parseRows(hojaCorp, 'Lima').rows[0].competition_name === 'YangoPremier',
    'category=Corp protege aunque la city esté mal detectada'
  )
}

{
  console.log('\n[17] parseRows: Corp rechaza "Yango" anónimo (mig 71)')
  // La BD tiene un guard que tira 23514; se filtra acá para no romper el batch.
  const hoja = [
    ['Date', 'Competition Name', 'Category'],
    ['01/02/2026', 'Yango', 'Corp'],
    ['01/02/2026', ' YANGO ', 'Corp'],
    ['01/02/2026', 'YangoEconomy', 'Corp'],
  ]
  const r = parseRows(hoja, 'Corp')
  assert(r.droppedCorpYango === 2, 'descarta el Yango anónimo en cualquier casing/espaciado')
  assert(r.rows.length === 1, 'la sub-marca explícita sobrevive')
  assert(r.rows[0].competition_name === 'YangoEconomy', 'YangoEconomy se conserva')
}

{
  console.log('\n[18] parseRows: booleanos de rush_hour y surge')
  const hoja = [
    ['Date', 'Competition Name', 'Category', 'Rush Hour', 'Surge'],
    ['01/02/2026', 'Uber', 'Economy/Comfort', 'Rush hour', 'si'],
    ['01/02/2026', 'Uber', 'Economy/Comfort', 'Valley', 'no'],
    ['01/02/2026', 'Uber', 'Economy/Comfort', 'cualquier cosa', ''],
  ]
  const r = parseRows(hoja, 'Lima')
  assert(r.rows[0].rush_hour === true, '"Rush hour" → true')
  assert(r.rows[1].rush_hour === false, '"Valley" → false')
  assert(r.rows[2].rush_hour === null, 'texto no reconocido → null, no false')
  assert(r.rows[0].surge === true, 'surge "si" → true')
  assert(r.rows[1].surge === false, 'surge "no" → false')
  assert(r.rows[2].surge === null, 'surge vacío → null')
  assert(
    r.rows.every((x) => x.rush_hour === null || typeof x.rush_hour === 'boolean'),
    'rush_hour SIEMPRE es boolean o null'
  )
}

{
  console.log('\n[19] parseRows: TukTuk canonicaliza el distrito de la columna Zone')
  const hoja = [
    ['Date', 'Competition Name', 'Category', 'Zone'],
    ['01/02/2026', 'Yango', 'TukTuk', 'villa el salvador'],
    ['01/02/2026', 'Yango', 'TukTuk', 'san juan de miraflores'],
    ['01/02/2026', 'Yango', 'TukTuk', 'un barrio inventado'],
  ]
  const r = parseRows(hoja, 'Lima')
  assert(r.rows[0].zone === 'VES', 'alias "villa el salvador" → VES')
  assert(r.rows[1].zone === 'SJM', 'alias "san juan de miraflores" → SJM')
  assert(r.tuktukRows === 3, 'cuenta las filas TukTuk')
  assert(r.tuktukNoDistrict === 1, 'reporta la que no matchea ningún distrito')
  assert(r.rows[2].zone === 'un barrio inventado', 'no inventa distrito: deja el valor crudo')
}

{
  console.log('\n[20] parseRows: Year/Week del Excel se ignoran a propósito (mig 94)')
  // Los Excel traían WEEKNUM con offset distinto al ISO 8601 y contaminaban la
  // columna week. Se derivan en la BD desde observed_date.
  const hoja = [
    ['Date', 'Competition Name', 'Category', 'Year', 'Week'],
    ['01/02/2026', 'Uber', 'Economy/Comfort', 2025, 99],
  ]
  const r = parseRows(hoja, 'Lima')
  assert(r.rows[0].year === undefined, 'Year del Excel NO se mapea')
  assert(r.rows[0].week === undefined, 'Week del Excel NO se mapea')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')

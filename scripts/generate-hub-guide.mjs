// Genera "Guía rápida — Ingresar CI" para los hub experts, en PDF.
// No se corre en CI ni se importa desde la app — es una utilidad puntual
// (node scripts/generate-hub-guide.mjs) que usa las mismas librerías que ya
// usa el export de Reporte Semanal (jsPDF + jspdf-autotable), solo que acá
// corren en Node en vez del navegador.
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'docs', 'export')
const OUT_FILE = join(OUT_DIR, 'Guia_Ingresar_CI_Hubs.pdf')

const YANGO_RED = [229, 57, 53]
const GRAY = [100, 100, 100]
const DARK = [30, 41, 59]
const PAGE_W = 210 // A4 mm, portrait

const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
let y = 20

function addPageIfNeeded(minSpace = 20) {
  if (y > 297 - minSpace) {
    doc.addPage()
    y = 20
  }
}

function h1(text) {
  // Bug real: la barra roja se dibuja como un rectángulo OPACO de ancho
  // completo empezando 8mm ARRIBA de `y` — sin este margen extra, cuando
  // `y` quedaba a solo ~7mm de la última línea del párrafo anterior (el
  // espaciado normal entre párrafos), el rectángulo pintaba encima de esa
  // línea y la tapaba (visible como texto cortado justo antes de cada
  // título de sección). Este margen garantiza separación real sin importar
  // qué haya justo antes.
  y += 6
  addPageIfNeeded(30)
  doc.setFillColor(...YANGO_RED)
  doc.rect(0, y - 8, PAGE_W, 12, 'F')
  doc.setFontSize(13)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(255, 255, 255)
  doc.text(text, 14, y)
  y += 12
  doc.setTextColor(...DARK)
}

function h2(text) {
  addPageIfNeeded(16)
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...YANGO_RED)
  doc.text(text, 14, y)
  y += 6
  doc.setTextColor(...DARK)
}

function p(text, opts = {}) {
  addPageIfNeeded(14)
  doc.setFontSize(10)
  doc.setFont('helvetica', opts.bold ? 'bold' : 'normal')
  const lines = doc.splitTextToSize(text, PAGE_W - 28)
  for (const line of lines) {
    addPageIfNeeded(8)
    doc.text(line, 14, y)
    y += 5
  }
  y += 2
}

function bullets(items) {
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  for (const item of items) {
    addPageIfNeeded(10)
    const lines = doc.splitTextToSize(`•  ${item}`, PAGE_W - 32)
    for (const line of lines) {
      addPageIfNeeded(8)
      doc.text(line, 18, y)
      y += 5
    }
  }
  y += 2
}

function table(head, body, opts = {}) {
  addPageIfNeeded(30)
  autoTable(doc, {
    startY: y,
    head: [head],
    body,
    styles: { fontSize: 9, cellPadding: 3, textColor: DARK },
    headStyles: { fillColor: YANGO_RED, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { left: 14, right: 14 },
    ...opts,
  })
  y = doc.lastAutoTable.finalY + 8
}

function calloutBox(title, text, color = [254, 243, 199]) {
  // Mismo margen defensivo que h1() — el recuadro también es un fondo
  // opaco que arranca arriba de `y`.
  y += 4
  addPageIfNeeded(24)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'bold')
  const bodyLines = doc.splitTextToSize(text, PAGE_W - 36)
  const boxH = 8 + bodyLines.length * 5 + 4
  doc.setFillColor(...color)
  doc.roundedRect(14, y - 5, PAGE_W - 28, boxH, 2, 2, 'F')
  doc.setTextColor(...DARK)
  doc.text(title, 18, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  for (const line of bodyLines) {
    doc.text(line, 18, y)
    y += 5
  }
  y += 6
}

// ════════════════════════════════════════════════════════════════════════
// PORTADA
// ════════════════════════════════════════════════════════════════════════
doc.setFillColor(...YANGO_RED)
doc.rect(0, 0, PAGE_W, 55, 'F')
doc.setFontSize(22)
doc.setFont('helvetica', 'bold')
doc.setTextColor(255, 255, 255)
doc.text('Guía rápida', 14, 28)
doc.setFontSize(16)
doc.text('Ingresar CI', 14, 40)
doc.setFontSize(10)
doc.setFont('helvetica', 'normal')
doc.text('Para hub experts — Lima · Trujillo · Arequipa', 14, 49)
doc.setTextColor(...DARK)
y = 68

p(
  'Esta guía resume cómo cargar la Inteligencia Competitiva (CI) manual en el dashboard, y las reglas nuevas de la pantalla "Ingresar CI" — pensadas para que trabajemos de forma coordinada entre ciudades, sin pisarnos.'
)

calloutBox(
  '¿Por qué reglas nuevas?',
  'Cada vez vamos a ayudarnos más seguido entre ciudades — estas reglas existen para que eso funcione sin confusión ni trabajo duplicado.'
)

// ════════════════════════════════════════════════════════════════════════
h1('1. Cómo navegar la pantalla')
// ════════════════════════════════════════════════════════════════════════

p('Arriba de la grilla vas a ver, en este orden:')
bullets([
  'Tu país y ciudad (Lima, Trujillo, Arequipa).',
  'Las pestañas de esa ciudad: Normal, Corp (si aplica), Aeropuerto, TukTuk (si aplica).',
  'La fecha que estás cargando (por defecto, hoy).',
])
p(
  'La grilla en sí está organizada por TURNO primero: Mañana, después Tarde, después Noche. Dentro de cada turno vas a ver los brackets (de Very Short a Very Long), y dentro de cada bracket, las rutas con sus competidores y categorías.'
)
calloutBox(
  'Regla de oro',
  'Completá un turno ENTERO antes de pasar al siguiente. Podés colapsar/expandir cada turno o cada bracket tocando su cabecera, para no perderte.',
  [219, 234, 254]
)

// ════════════════════════════════════════════════════════════════════════
h1('2. Cómo llenar una fila')
// ════════════════════════════════════════════════════════════════════════

p('Para cada competidor de una ruta, categoría y turno, cargá:')
bullets([
  'ETA en minutos (opcional) — cuánto tarda en llegar el conductor.',
  'Precio — el que ves en la app del competidor en ese momento.',
])
p(
  'Si un competidor NO ofrece ese servicio en esa ruta, marcá la celda como "Sin data" (S/D) — no la dejes vacía sin marcar, porque eso cuenta como pendiente y no te va a dejar Terminar la Sesión.'
)

h2('InDrive es distinto: recomendado + hasta 5 bids')
p(
  'InDrive no tiene un precio fijo — te muestra un precio RECOMENDADO y podés ver varias ofertas de conductores (bids). Cargá el recomendado y hasta 5 bids; el promedio se calcula SOLO con los bids (el recomendado no entra al promedio). Si no hay ningún bid disponible, se usa el recomendado como precio de la celda.'
)
table(
  ['Campo', 'Ejemplo', 'Resultado'],
  [
    ['Recomendado', '14', 'No entra al promedio'],
    ['Bid 1 / Bid 2 / Bid 3', '15 / 13 / 17', 'Promedio = 15.00'],
    ['Sin ningún bid', '—', 'Se usa el recomendado (14) como precio'],
  ]
)

// ════════════════════════════════════════════════════════════════════════
h1('3. Iniciar, Guardar y Terminar sesión')
// ════════════════════════════════════════════════════════════════════════

table(
  ['Botón', 'Qué hace', 'Cuándo usarlo'],
  [
    [
      'Iniciar Sesión',
      'Arranca el cronómetro y habilita Guardar/Terminar.',
      'Al empezar a cargar una ciudad/fecha.',
    ],
    [
      'Guardar progreso',
      'Guarda TODAS las filas que ya completaste, aunque el resto de la grilla esté a medias.',
      'Cuantas veces quieras, sin límite — es tu red de seguridad.',
    ],
    [
      'Terminar Sesión',
      'Cierra la sesión de verdad. Exige que TODA la grilla esté completa (los 3 turnos) — no se puede terminar a medias.',
      'Solo cuando terminaste TODO lo que ibas a cargar hoy en esa vista.',
    ],
  ]
)

calloutBox(
  'Tu progreso nunca se pierde solo',
  'Mientras trabajás, tu progreso se autoguarda en tu navegador — si actualizás la página, cambiás de pestaña o se corta la luz, al volver todo sigue cargado. Igual, guardá seguido con "Guardar progreso" para que también quede confirmado en el servidor (vas a ver un aviso "Confirmado en servidor hace Xs" arriba).',
  [220, 252, 231]
)

// ════════════════════════════════════════════════════════════════════════
h1('4. Aeropuerto: elegí tu alcance ANTES de empezar')
// ════════════════════════════════════════════════════════════════════════

p(
  'Aeropuerto tiene dos puntos de medición: Punto A y Punto B. Es importante que se completen en el MISMO rango horario (no conviene que Punto A se llene a las 9am y Punto B recién a las 11am), así que ANTES de tocar "Iniciar Sesión" vas a tener que elegir qué vas a completar:'
)
table(
  ['Opción', 'Qué pasa'],
  [
    ['Punto A', 'Trabajás solo ahí. Punto B queda bloqueado (candado) durante esta sesión.'],
    ['Punto B', 'Trabajás solo ahí. Punto A queda bloqueado durante esta sesión.'],
    [
      'Ambos puntos',
      'El cronómetro sigue corriendo mientras alternás entre Punto A y Punto B, sin cortarse. Al completar el primero, el botón dice "Terminar este punto" y saltás automático al otro — recién al completar el segundo se cierra la sesión de verdad.',
    ],
  ]
)
p(
  'Tip para cargar rápido y ordenado: cargá un competidor entero en Punto A (todas sus categorías/turnos) y después ese MISMO competidor en Punto B, antes de pasar al siguiente competidor — así ambos puntos quedan siempre parejos en el tiempo.'
)
calloutBox(
  '¿Podés ampliar el alcance a mitad de camino?',
  'Sí — si empezaste con "Punto A" y después necesitás sumar Punto B a la misma sesión, tocá "+ agregar el otro punto" (aparece junto a las pestañas de Punto A/B) sin perder tu cronómetro.',
  [219, 234, 254]
)

// ════════════════════════════════════════════════════════════════════════
h1('5. Trabajar varias pestañas en la misma sesión (novedad)')
// ════════════════════════════════════════════════════════════════════════

p(
  'Ya no hay pestañas bloqueadas mientras tenés una sesión abierta. Si estás con Aeropuerto y también necesitás avanzar TukTuk, Corp, Normal, o incluso otra ciudad, podés saltar libremente entre todas — sin terminar una para poder tocar la otra, y sin perder el cronómetro.'
)
p(
  'El sistema lleva la cuenta por vos: apenas escribís algo en una pestaña, esa pestaña queda anotada como pendiente. "Terminar Sesión" no cierra de verdad hasta que cierres TODAS las que empezaste — así ninguna queda a medias sin que nadie se entere.'
)
calloutBox(
  '¿Cómo sé qué me falta?',
  'Mientras tengas algo pendiente, el botón principal dice "Terminar este punto" en vez de "Terminar Sesión", y arriba de la grilla aparece un aviso que lista exactamente qué pestañas te falta cerrar. Cerrá cada una con su propio "Terminar" (recordá que exige la grilla completa de esa pestaña).',
  [219, 234, 254]
)
calloutBox(
  '¿Y si toqué una pestaña por error?',
  'Si escribiste algo sin querer y lo borrás, esa pestaña deja de contar como pendiente automáticamente — no te va a trabar la sesión.',
  [220, 252, 231]
)

// ════════════════════════════════════════════════════════════════════════
h1('6. TukTuk: un distrito por sesión')
// ════════════════════════════════════════════════════════════════════════

p(
  'TukTuk se completa por distrito — cada distrito es su propia sesión independiente (su propio borrador, su propio "Iniciar/Guardar/Terminar"). Solo vas a ver habilitados los distritos que el equipo confirmó — los demás aparecen con candado.'
)
p(
  'Si varios hub experts están cargando TukTuk al mismo tiempo, lo ideal es que cada uno tome un distrito y lo termine antes de pasar a otro.'
)

// ════════════════════════════════════════════════════════════════════════
h1('7. ¿Quién más está trabajando?')
// ════════════════════════════════════════════════════════════════════════

p(
  'Como cualquiera puede ayudar cargando la ciudad de un compañero sin restricción (si él está ocupado con otra cosa), vas a ver un pequeño punto verde en las sub-pestañas de Aeropuerto y en las píldoras de distrito de TukTuk cuando OTRO hub está trabajando ahí mismo en ese momento — pasá el mouse sobre esa pestaña para ver quién es (mejor desde compu; en celular puede no mostrarse el nombre al tocar).'
)
calloutBox(
  'Esto es solo informativo',
  'No te bloquea nada — es para que puedas coordinarte y evitar cargar dos veces lo mismo, no para competir. Si ves que un compañero ya está en un punto/distrito, mejor tomá otro.',
  [254, 243, 199]
)

// ════════════════════════════════════════════════════════════════════════
h1('8. Corregir un error después de Terminar Sesión')
// ════════════════════════════════════════════════════════════════════════

p(
  'Si te diste cuenta de un error después de haber terminado una sesión (tuya o de un compañero — cualquiera puede corregir cualquier ciudad), abrí "Historial de sesiones" abajo de la grilla, buscá la sesión y tocá "Abrir". Vas a poder editar y volver a guardar; tu cronómetro de esta corrección arranca de cero, y "Terminar Sesión" te va a pedir de nuevo que la grilla esté completa.'
)

// ════════════════════════════════════════════════════════════════════════
h1('9. Ver lo que ya guardaste')
// ════════════════════════════════════════════════════════════════════════

p(
  'Debajo de la grilla, junto al Historial, hay un botón "Ver lo guardado" — te muestra, para la ciudad/fecha que tenés abierta, exactamente lo que YA quedó guardado en el servidor (competidor, categoría, precio, hora). Usalo para comparar contra lo que ves en pantalla si algo te genera dudas, y avisanos si algo no cuadra.'
)

// ════════════════════════════════════════════════════════════════════════
h1('10. Si se corta la sesión')
// ════════════════════════════════════════════════════════════════════════

p(
  'A veces pasa: se va la luz, se corta el internet, te llaman con algo urgente. Lo que ya guardaste con "Guardar progreso" está seguro en el servidor pase lo que pase. Si tu sesión queda "colgada" (nunca la terminaste), el admin la puede cerrar desde su panel de Monitoreo sin tocar nada de lo que ya cargaste — solo cierra la contabilidad de esa sesión. Cuando puedas, volvé a esa ciudad/fecha y segui donde quedaste.'
)
calloutBox(
  'Si no vas a poder volver (novedad)',
  'Si te pasa algo a mitad de turno y otro compañero tiene que seguir por vos, avisale a un admin — puede reasignarle lo que ya guardaste. Tu compañero va a ver ese trabajo cargado automáticamente al entrar a esa misma ciudad/fecha, sin tener que volver a cargarlo de cero.',
  [220, 252, 231]
)

// ════════════════════════════════════════════════════════════════════════
h1('11. Situaciones que se pueden dar (con ejemplos)')
// ════════════════════════════════════════════════════════════════════════

h2('¿Un competidor no tiene oferta en esa ruta?')
p(
  'Marcá la celda como "Sin data" (S/D). Es distinto de un error de carga: S/D significa "lo revisé y no hay oferta", no "todavía no lo revisé". Una celda vacía sin marcar SÍ cuenta como pendiente y no te va a dejar Terminar la Sesión.'
)

h2('¿La app del competidor muestra un precio con "promo" o descuento raro?')
p(
  'Cargá el precio que la app te muestra en ese momento para llegar de A a B — el que efectivamente pagaría un pasajero ahora mismo, promo incluida. No intentes "corregir" el precio a mano restando o calculando el valor sin descuento; nosotros analizamos con el precio real que ve el usuario, no con el de lista. Si el precio te parece un error del competidor (no una promo real, por ejemplo $0 o vacío raro), tratalo como el caso siguiente.'
)

h2('¿Dos hubs cargan la misma ruta el mismo día por error?')
p(
  'No pasa nada grave: cada fila que guardás queda asociada a vos y a la hora exacta en que la cargaste, así que no se sobrescriben ni se mezclan datos de forma silenciosa. Si te das cuenta de la duplicación, avisale al equipo de Pricing para que decidan cuál de las dos cargas dejar (normalmente la más reciente, si el precio cambió entre una y otra). Para evitarlo antes de que pase: revisá el punto verde de "quién más está trabajando" (sección 7) y el Historial de sesiones antes de arrancar una ruta que ya viste cargada por otro compañero.'
)

h2('¿Un precio parece un error de tipeo evidente (ej. S/2 en vez de S/20)?')
p(
  'No lo cargues "a ojo" corrigiéndolo vos mismo — puede que el precio raro sea real (rutas cortas, promos agresivas). Volvé a mirar la app del competidor y confirmá el precio correcto ahí mismo antes de guardar. Si ya guardaste un precio y después notás que fue un typo tuyo, corregilo: abrí "Historial de sesiones", buscá esa sesión y tocá "Abrir" para editar esa fila puntual (ver sección 8).'
)

h2('¿Se cae la conexión a mitad de un turno?')
p(
  'Tranquilo: mientras trabajás, tu progreso se autoguarda en tu navegador (aunque no hayas tocado "Guardar progreso" todavía), y todo lo que sí llegaste a guardar con ese botón ya está confirmado en el servidor pase lo que pase. Cuando vuelva la conexión, entrá de nuevo a esa misma ciudad/fecha/pestaña y vas a ver todo tal como lo dejaste. Si la caída te va a tener offline por un buen rato y necesitás que otro compañero siga por vos, es el caso siguiente.'
)

h2('¿Elegiste avanzar Aeropuerto Punto A y ahora querés avanzar el Punto B también?')
p(
  'Tocá "+ agregar el otro punto", junto a las pestañas de Punto A/B (sección 4) — sin perder tu cronómetro ni tener que reiniciar nada. A partir de ahí podés alternar libremente entre A y B dentro de la misma sesión.'
)

h2('¿Elegiste Aeropuerto Punto A y ahora querés avanzar TukTuk y Corp, sin tocar el Punto B?')
p(
  'Podés — no hace falta declarar nada de antemano para eso. Simplemente andá a la pestaña de TukTuk o Corp y empezá a cargar: el sistema anota automáticamente que ese frente quedó pendiente (sección 5). "Terminar Sesión" te va a pedir cerrar cada pestaña que tocaste (Punto A, TukTuk, Corp), pero el Punto B queda afuera sin problema — nunca lo tocaste, así que nunca se te va a exigir.'
)

h2('¿Perdiste la conexión a mitad de turno y necesitás que otro hub continúe tu trabajo?')
p(
  'Avisale a un admin (por el canal habitual del equipo) que necesitás una reasignación. El admin puede transferir tu sesión abierta a otro hub desde su panel — tu compañero, al entrar a esa misma ciudad/fecha/pestaña, va a ver automáticamente todo lo que ya guardaste (no tiene que volver a cargarlo de cero) y sigue desde ahí con su propio cronómetro para lo que falte.'
)

// ════════════════════════════════════════════════════════════════════════
h1('Preguntas frecuentes')
// ════════════════════════════════════════════════════════════════════════

table(
  ['Pregunta', 'Respuesta'],
  [
    [
      '¿Puedo cargar la ciudad de un compañero?',
      'Sí, sin restricción — es justamente el objetivo de estas reglas nuevas.',
    ],
    [
      '¿Qué pasa si dejo una fila a medias?',
      '"Terminar Sesión" no te va a dejar mientras haya filas a medias (marcadas en rojo) — completalas o marcalas "Sin data".',
    ],
    [
      '¿Tengo que elegir el alcance en Normal/Corp/TukTuk también?',
      'No, el selector de alcance es solo para Aeropuerto (Punto A/B). En el resto, "Iniciar Sesión" funciona como siempre.',
    ],
    [
      '¿Perdí mi trabajo si cierro el navegador sin querer?',
      'No — tu progreso se autoguarda en el navegador. Al volver a entrar, todo sigue cargado.',
    ],
    [
      '¿Puedo cambiar de "Punto A" a "Ambos puntos" a mitad de sesión?',
      'Sí, con el botón "+ agregar el otro punto" junto a las pestañas de Aeropuerto.',
    ],
    [
      '¿Puedo avanzar varias pestañas (Aeropuerto, TukTuk, Corp, otra ciudad) en la misma sesión?',
      'Sí — saltá libremente entre todas. "Terminar Sesión" va a exigir que cierres cada una de las que empezaste.',
    ],
  ]
)

p('Ante cualquier duda que no esté en esta guía, consultá directamente con el equipo de Pricing.', {
  bold: true,
})

// ── Pie de página con número de página en todas las hojas ──────────────
const pageCount = doc.internal.getNumberOfPages()
for (let i = 1; i <= pageCount; i++) {
  doc.setPage(i)
  doc.setFontSize(8)
  doc.setTextColor(...GRAY)
  doc.text(`Guía Ingresar CI — página ${i} de ${pageCount}`, 14, 290)
}

mkdirSync(OUT_DIR, { recursive: true })
const buf = Buffer.from(doc.output('arraybuffer'))
writeFileSync(OUT_FILE, buf)
console.log(`✓ PDF generado: ${OUT_FILE} (${buf.byteLength} bytes, ${pageCount} páginas)`)

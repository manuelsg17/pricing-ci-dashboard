# Informe ejecutivo — Calidad de datos del dashboard de Pricing Competitivo (CI)

_Yango LATAM · Julio 2026 · para reunión de gerencia_

> **Cómo se hizo este informe:** revisamos uno por uno los cambios técnicos de los últimos meses que podían mover los números del tablero, y verificamos cada afirmación contra el código real y contra la base de datos de producción. Solo incluimos lo que quedó confirmado; lo que no se sostuvo se descartó.

---

## 1. Resumen ejecutivo

En los últimos meses detectamos y corregimos una serie de problemas que afectaban dos cosas a la vez: **cuántas muestras de precios capturábamos** y **qué números veía finalmente la gerencia en el dashboard**.

Los dos más graves explican por qué el tablero se veía "congelado":

1. El sistema traía como máximo **5.000 filas por hora** cuando Perú producía más, y así se acumuló un **atraso silencioso de 43 días** (mostraba precios de más de un mes atrás).
2. Por separado, el resumen que alimenta el dashboard **dejó de actualizarse** y llegó a mostrar **78 muestras cuando en realidad había 2.515** (apenas el 3 % de la evidencia real).

Ambos ya están resueltos y verificados en producción. También corregimos varias fórmulas de promedio —entre ellas, un promedio de InDrive que salía demasiado bajo y hacía ver a Yango **menos competitivo de lo que realmente es**— y tapamos fugas por las que cargas manuales enteras de Perú y Colombia se descartaban en silencio.

Queda **un frente abierto** —el filtro de TukTuk, que hoy infla su precio promedio en ~55 %— y **un factor externo** que no controlamos —el bot de scraping, que a veces deja de producir datos—, que ahora sí es visible gracias a un nuevo panel de frescura.

---

## 2. Qué podía estar distorsionando los números

### (a) Cuántas muestras capturábamos

**La lista de reglas quedó vacía y descartaba el 100 % de las cargas manuales de Perú y Colombia.**
Para decidir qué filas de una carga manual se aceptan, el sistema usa una lista de reglas. Para Perú y Colombia esa lista había quedado guardada en blanco, y una lista vacía no daba error: simplemente rechazaba **cada** fila con el motivo "Sin regla".

- _Impacto:_ las subidas semanales de data de hubs no aportaban **ninguna** muestra al dashboard, en silencio.
- _Qué se hizo:_ se rellenó la lista con las reglas reales y vivas del bot (22 para Perú, 27 para Colombia). Además, la carga manual ahora lee las reglas **en vivo** en vez de una "foto" que podía quedar desactualizada, para que el problema no vuelva.
- _Estado:_ ✅ en producción, verificado.

**El tope de filas por corrida estaba en 5.000 y Perú quedó 43 días atrasado.**
Cada corrida automática (una por hora) traía como máximo 5.000 filas, pero el bot de Perú produce más que eso por hora. Se fue acumulando un atraso: cada corrida terminaba en "OK", pero siempre procesando datos de semanas atrás (última fecha sincronizada 6-jun, con el sync corriendo el 19-jul).

- _Impacto:_ los precios y la competitividad mostrados no eran del día sino de más de un mes atrás, y el conteo de muestras "de hoy" era casi cero. Eso es lo que se veía como dashboard "congelado".
- _Qué se hizo:_ se subió el tope a 20.000 filas por corrida en el proceso automático que realmente rige la ingesta.
- _Estado:_ ✅ en producción.

**Se perdían de forma permanente las muestras que el bot inserta "fuera de hora".**
El sistema recuerda hasta qué momento ya trajo datos (una "marca de agua") y solo pide lo más nuevo. Pero el bot no inserta en orden: los viajes largos y de aeropuerto tardan más en calcularse y entraban con una hora **anterior** a la marca, así que quedaban "antes" del corte y no se traían nunca.

- _Impacto:_ se perdía, en cada ciclo, parte de las muestras de tramos largos y de aeropuerto —justo los de mayor valor para pricing—, sesgando los promedios por tramo hacia los viajes cortos y medios. El sesgo era estructural y recurrente.
- _Qué se hizo:_ cada corrida ahora relee una ventana de 6 horas hacia atrás para rescatar las que llegaron tarde. Releer no duplica (si la fila ya estaba, no se re-inserta).
- _Estado:_ ✅ en producción.

**Una misma regla ahora cubre varios nombres que la app usa para el mismo producto.**
Las apps de la competencia (ej. InDrive) renombran un mismo producto con el tiempo ("viaje" → "viajes económicos" → "viaje+"). Antes cada texto nuevo necesitaba su propia regla; hasta que alguien la creara, esas filas se descartaban.

- _Impacto:_ el registro ya mostraba **529 observaciones** de la variante "viaje+" sin capturar. Ahora, al listar varios textos en una sola regla, esas muestras vuelven a entrar.
- _Estado:_ ✅ en producción.

**Recuperación de historia bajo demanda (backfill).** Habilitamos pedir la recarga de un rango de fechas desde la interfaz (antes solo era posible corriendo un script a mano, algo que casi nadie del equipo puede hacer) y arreglamos un problema técnico que hacía que un backfill de 3 meses se cortara por tiempo y trajera 0 filas. También evitamos que un backfill ancho falle entero por un choque interno de filas duplicadas.

- _Estado:_ ✅ en producción (afecta la recuperación de historia, no la corrida horaria de rutina).

### (b) Cómo se calculaban los promedios

**El número resumen pasó de "Promedio Ponderado" a "Promedio Simple" desde el 15-jun-2026, y se blindó el histórico de Perú.**
El número que compara a Yango con la competencia se calculaba dando más peso a los tramos más frecuentes. El equipo decidió cambiar a promedio simple (cada tramo cuenta igual). Aparte, en Perú la tabla de pesos había sido "parchada" de emergencia a 16,6 % parejo, lo que deformaba el histórico.

- _Impacto:_ cambia el **valor** del número titular de comparación desde el 15-jun (las semanas hasta el 8-jun conservan el ponderado histórico). En Perú se evitó una distorsión mayor: el parche subestimaba los tramos largos (28,5 % real vs 16,6 % parchado), lo que bajaba artificialmente el promedio histórico.
- _Estado:_ ✅ en producción, con 30 pruebas automáticas cubriendo el corte.

**El promedio de InDrive se calculaba metiendo el "Mínimo" y salía demasiado bajo.**
En la carga manual, InDrive tiene varias ofertas ("bids") y aparte un valor "Mínimo". El sistema metía ese Mínimo dentro del promedio. Como el Mínimo suele ser el valor más bajo, arrastraba el promedio hacia abajo.

- _Impacto:_ distorsión de hasta **~25 %** en el precio de InDrive registrado (ej.: ofertas 20 y 22 con Mínimo 5 daban 15,67 en vez de 21). Un InDrive artificialmente barato hacía ver a Yango **menos competitivo de lo que realmente es**. Aplica a las cargas manuales nuevas; las filas ya guardadas conservan su valor previo.
- _Qué se hizo:_ el promedio ahora usa **solo** las ofertas; el Mínimo se sigue guardando aparte como referencia.
- _Estado:_ ✅ en producción.

**El promedio "congelado" al ajustar InDrive salía deformado (y no guardaba).**
Al ajustar InDrive, el sistema toma una "foto" de los promedios antes de reescribir precios. Un cruce de tablas mal armado multiplicaba filas: cada tramo se contaba varias veces, deformando el promedio ponderado guardado; encima el proceso se colgaba por lentitud.

- _Impacto:_ el promedio congelado quedaba mal y el guardado fallaba. _Matiz:_ como se colgaba, la mayoría de esas fotos deformadas no llegaban a escribirse, así que el efecto en pantalla fue acotado.
- _Qué se hizo:_ se resuelve el peso una sola vez por combinación y se lee de un resumen rápido pre-calculado. En paralelo, se separó el guardado de la reescritura de precios para que guardar sea instantáneo y se aplique en ≤10 min.
- _Estado:_ ✅ en producción.

**"Ref. reciente" de InDrive.** El editor de ajuste mostraba una referencia que promediaba **toda** la historia, quedando desalineada con la realidad (ej.: Arequipa Económico marcaba +28 % histórico vs ~17 % de las últimas 2 semanas). Ahora la referencia mira las últimas N semanas (configurable). Es una herramienta de decisión: solo mueve el precio cuando el analista la aplica y guarda. _Estado:_ ✅ en producción.

_Cambios de solo presentación (no mueven ningún número):_ se renombró la etiqueta a "Promedio General", se agregó un banner que explica el corte Ponderado→Simple, y se centralizó la fórmula de InDrive en un único archivo con pruebas para que no vuelva a divergir entre pantallas.

### (c) A qué ciudad / tramo se asignaban

**Emparejamiento de rutas en "Ingresar CI".** Cuando una categoría tenía 2 o más rutas en el mismo tramo (caso real de TukTuk, que carga varias rutas por distrito), la herramienta las emparejaba por **posición** en la lista, no por su relación real. Un precio real podía terminar mostrándose bajo la ruta de otro distrito.

- _Impacto:_ riesgo de mala atribución a nivel ruta/zona, **prevenido antes de liberar el feature** (cazado por una revisión adversarial la misma sesión). No afecta los cortes principales por tramo ni el número de muestras.
- _Estado:_ ✅ corregido, con 15 pruebas que reproducen el caso.

**Etiqueta de zona rellenada en 2.376 muestras de aeropuerto.** Muchas muestras de aeropuerto ya cargadas habían quedado sin etiqueta de zona, así que al filtrar por zona no aparecían. _Impacto:_ la ciudad ya era correcta, por lo que los promedios por ciudad **no cambian**; solo cambia el conteo al filtrar por zona. _Estado:_ ✅ aplicado, 0 discrepancias.

**Regla automática que estandariza el "tramo de distancia".** Se extendió la normalización de la base para que cualquier origen (carga manual, bot) guarde siempre el tramo canónico. _Impacto:_ hoy ~0 filas para mover (la divergencia medida ya era cero en 1,45 M de filas); el valor es **preventivo**. _Estado:_ ✅ en producción.

### (d) Frescura de lo que se veía

**El dashboard mostraba conteos y precios congelados porque el refresh de la "foto" se caía entero.**
Para ir rápido, el dashboard no lee los datos crudos: lee un resumen pre-calculado (una "foto" que se refresca cada tanto). Un trabajo programado refrescaba **todas** las fotos juntas en un mismo bloque; la más pesada superaba el límite de tiempo y fallaba, y al estar todas juntas, su falla deshacía también la foto **semanal**, que es la que alimenta el dashboard.

- _Impacto:_ caso verificado — semana 27, Lima, Económico, Yango: el dashboard mostraba **78 observaciones cuando en realidad había 2.515** (un sub-conteo de ~97 %), con precios promedio pegados en un valor viejo, aunque la data cruda estuviera al día.
- _Qué se hizo:_ se partió en 3 trabajos independientes (si uno falla, no arrastra a los demás) y se le dio el presupuesto de tiempo en el nivel correcto. La foto semanal ahora se refresca cada ~15 minutos.
- _Estado:_ ✅ en producción, verificado (la foto vuelve a coincidir con el dato crudo).

**El detalle de observaciones decía "500" como si fuera el total.**
Al abrir el detalle detrás de un número, la ventana lista hasta 500 filas y mostraba literalmente "500", haciendo pensar que solo había 500 muestras cuando podían ser miles.

- _Impacto:_ el usuario sub-contaba la evidencia que respalda cada precio.
- _Qué se hizo:_ ahora consulta el conteo verdadero y muestra "2.515 filas · mostrando 500", aclarando que el promedio visible es una muestra.
- _Estado:_ ✅ en producción.

### (e) Calidad de la carga manual de los hubs

**Precios tipeados con coma se malformaban.** Los navegadores en español usan coma como separador decimal; un hub que tipeaba "13,2" podía terminar guardando "13" (perdiendo el decimal) o dejando la celda vacía (muestra perdida). _Qué se hizo:_ los campos de precio ahora limpian lo tipeado y fuerzan el punto ("13,2" → "13.2"), con 9 pruebas. _Estado:_ ✅ en producción.

**Se bajó a 3 el tope de ofertas de InDrive en la pantalla.** La base había dejado de guardar la 4.ª y 5.ª oferta, pero la pantalla seguía permitiendo hasta 5, lo que podía bloquear el guardado de esa carga. Se alineó todo a 3 ofertas. _Estado:_ ✅ corregido.

**Visibilidad en la pantalla de reglas.** Botones que no se dibujaban en filas altas (no se podían clicar) y un banner de "combos no matcheados" que quedaba hasta 7 días desactualizado, dando la falsa impresión de que una regla nueva no funcionaba. _Impacto:_ no cambia cuántas muestras entran; corrige lo que el operador **ve** (el banner ahora se autocorrige en ~1h). _Estado:_ ✅ en producción.

---

## 3. Tabla resumen

| Problema                                                                        | Impacto en los números                                            | Estado           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------- |
| Lista de reglas vacía descartaba el 100 % de cargas manuales de Perú y Colombia | **Alto** — 0 muestras de esas subidas semanales                   | ✅ En producción |
| Tope de 5.000 filas/hora → Perú 43 días atrasado ("dashboard congelado")        | **Alto** — precios y conteos de más de un mes atrás               | ✅ En producción |
| Refresh de la "foto" se caía entero → dashboard congelado                       | **Alto** — mostraba 78 muestras vs 2.515 reales (~97 % menos)     | ✅ En producción |
| Muestras de tramos largos/aeropuerto perdidas por la marca de agua              | **Alto** — sub-conteo y sesgo por tramo, recurrente               | ✅ En producción |
| "Promedio Ponderado" → "Promedio Simple" + blindaje de pesos de Perú            | **Alto** — cambia el número titular Yango vs competencia          | ✅ En producción |
| Promedio de InDrive incluía el "Mínimo"                                         | **Alto** — hasta ~25 % más bajo; Yango se veía menos competitivo  | ✅ En producción |
| Carga manual usa reglas en vivo (no una foto vieja)                             | **Medio** — evita que reaparezca el descarte del 100 %            | ✅ En producción |
| Regla multi-variante (nombres nuevos del mismo producto)                        | **Medio** — recupera ~529 observaciones sin capturar              | ✅ En producción |
| Backfill por rango de fechas + dedup (recuperación de historia)                 | **Medio** — habilita recargar meses de historia                   | ✅ En producción |
| Promedio "congelado" de InDrive deformado por cruce de tablas                   | **Medio** — foto acotada (casi nunca llegaba a escribirse)        | ✅ En producción |
| "Ref. reciente" de InDrive (últimas semanas vs toda la historia)                | **Medio** — recalibra el ajuste (al aplicarlo el analista)        | ✅ En producción |
| Detalle de observaciones decía "500" como total                                 | **Medio** — corrige el tamaño de muestra reportado                | ✅ En producción |
| Precios con coma se malformaban (separador decimal)                             | **Medio** — evita precios en cero o muestras vacías               | ✅ En producción |
| Emparejamiento de rutas por posición (caso TukTuk)                              | **Bajo** — riesgo de mala atribución, prevenido antes de liberar  | ✅ Corregido     |
| Etiqueta de zona en 2.376 muestras de aeropuerto                                | **Bajo** — no cambia promedios por ciudad, solo el corte por zona | ✅ Aplicado      |
| Renombres, banners y normalizaciones preventivas                                | Ninguno — presentación / anti-regresión                           | ✅ En producción |
| **Filtro de TukTuk (viajes largos irreales)**                                   | **Abierto** — infla el promedio de TukTuk ~55 %                   | ⚠️ **Pendiente** |

---

## 4. Lo que sigue / lo que no depende de nosotros

### Filtro de TukTuk — abierto (depende de nosotros)

El TukTuk son viajes cortos dentro de un mismo distrito, pero el bot viene muestreando viajes de TukTuk en tramos "largo/muy largo" que en la vida real no existen. Se diseñó un filtro para descartar esas muestras, pero **quedó colocado en un componente que en la práctica no es el que corre en producción**. Verificado hoy contra la base de producción (muestras de TukTuk desde el 14-jul):

| Tramo         | Muestras | Precio promedio | ¿Con distrito? |
| ------------- | -------- | --------------- | -------------- |
| very_short    | 280      | S/ 2,66         | 0 %            |
| short         | 393      | S/ 3,77         | 0 %            |
| median        | 392      | S/ 5,66         | 0 %            |
| average       | 136      | S/ 6,43         | 0 %            |
| **long**      | **282**  | **S/ 8,07**     | 0 %            |
| **very_long** | **370**  | **S/ 13,90**    | 0 %            |

- Los tramos **long** y **very_long** (irreales para un TukTuk) inflan el promedio de **~S/ 4,4 a ~S/ 6,9 (+55 %)**.
- El **100 % de las muestras de TukTuk quedan sin distrito**, así que no se pueden filtrar por zona.
- **Este problema NO está cerrado.** El próximo paso es portar el filtro (y el guardado del distrito) a la pieza que realmente ingesta la data cada hora. Lo señalamos explícitamente para no presentarlo como resuelto.

### El scraper externo a veces no produce data (no lo controlamos)

El bot que scrapea los precios de la competencia es 100 % externo a este sistema. Si deja de producir para una ciudad o tramo —por ejemplo, si Lima deja de scrapear varios tramos después del barrido de la mañana—, no podemos forzarlo a traer esa data. El indicador "Bot hace X min" solo dice cuándo corrió **nuestro** sync, no qué tan fresca es la data por ciudad/tramo, así que estos cortes quedaban invisibles.

- **Novedad:** agregamos un **panel de frescura** (matriz ciudad × tramo) que muestra la última observación de cada celda, coloreada por atraso (verde/amarillo/rojo). Una celda roja = ese tramo se congeló mientras el resto sigue fresco. Es de solo lectura (no cambia ningún número) y **ya está activo en producción**. Nos da alerta temprana de cortes del bot que antes pasaban desapercibidos.

---

## 5. Cierre

La gran mayoría de lo que estaba distorsionando los números y el volumen de muestras **ya está corregido y verificado en producción**: el dashboard volvió a estar al día, los conteos reflejan la evidencia real y el número de comparación Yango vs competencia se calcula con la metodología acordada.

Quedan **dos frentes claros y accionables**: cerrar el filtro de TukTuk en el pipeline real (bajo nuestro control, con camino ya definido) y seguir vigilando los cortes del scraper externo con el nuevo panel de frescura. Ambos ya están identificados.

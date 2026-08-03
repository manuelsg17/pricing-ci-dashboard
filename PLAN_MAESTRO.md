# Plan maestro — todo lo encontrado, y en qué orden se arregla

> **Actualizado 2026-08-03 (tarde) — cuarta ronda cerrada.**
>
> **✅ EN PRODUCCIÓN:** migraciones **200–210** y el frontend.
> Las 206/207/208/209 se aplicaron con autorización explícita una por una, en el
> orden 208 (P0) → 209 → 207 → 206, y la **210** cerró el último P1 abierto.
>
> **No queda ninguna migración esperando autorización.** Sí queda pendiente
> **desplegar el frontend** con los dos fixes de cliente de esta tanda (el lease
> global del latido y `latidoDelegado`).
>
> ### Correcciones a lo que este mismo documento afirmaba
>
> Dos cosas que decía y el dato desmintió. Van arriba porque el patrón —dar por
> buena una conclusión sin volver a medirla— es el que más caro sale acá:
>
> - **"La 208 no hizo daño porque no hubo sesiones después del deploy."** Falso al
>   momento de aplicarla: había **3 hubs trabajando en vivo**. El daño medido igual
>   era cero (0 grupos con la firma del bug), así que el fix llegó antes que el
>   daño — pero por suerte, no porque no hubiera sesiones.
> - **"El piso de plausibilidad solo defiende el lado bajo; falta un techo."** El
>   diagnóstico estaba **al revés**: no hay duraciones infladas. Ver la 210 abajo.

## Cuarta ronda — qué encontró

4 finders + panel de escépticos, todo reproducido contra Supabase local con roles
reales. **13 hallazgos, 12 sobrevivieron al panel, 1 refutado.**

| #      | Qué                                                                                                | Estado                                                     |
| ------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **P0** | La mig 203 rompió el reclamo de filas legacy de `save_ci_batch`: el hub duplica filas, en silencio | ✅ mig **208**                                             |
| P1     | Re-subir un Excel de aeropuerto duplica: el DELETE mira la ciudad de antes del trigger             | ✅ mig **209**                                             |
| P1     | Ver Datos: borrar y editar fallaban en silencio (HTTP 204 sin error)                               | ✅ `useRawDataMutations`                                   |
| P1     | `toISODate` corría la fecha un día al este de Greenwich                                            | ✅ `dateUtils` + test en 5 husos                           |
| P1     | `\|\| DEFAULT_WEIGHTS` era código muerto (`{}` es truthy)                                          | ✅ `useRentabilidadPrices`                                 |
| P1     | `handleFinishSession` hacía `setUiCity` con un bucketKey                                           | ✅ (6.4, unificado a bucketKey)                            |
| P2     | `pricing_wa_frozen` sin paginar contra el tope de 1.000                                            | ✅ `tablaCompleta`                                         |
| P2     | El panel de outliers congelaba el lote y destildar una hoja no tenía efecto                        | ✅ `invalidarLoteCongelado`                                |
| P2     | `simulate-durability` pasaba con los fixes arrancados                                              | ✅ invariantes de forma + mutación                         |
| P1     | El piso de plausibilidad solo defiende el lado bajo                                                | ✅ mig **210** (ver abajo: el diagnóstico estaba al revés) |
| P2     | El candado de pestañas no cubre el latido                                                          | ✅ `heartbeatLeaseKey` + `latidoDelegado`                  |
| —      | `upload_pricing_batch` contra el statement_timeout                                                 | ❌ refutado por el panel                                   |

### Lo que la consolidación corrigió de mi propio trabajo

Dos cosas que yo había dado por cerradas y no lo estaban. Las dos ya están
arregladas, pero vale dejarlas escritas porque el patrón se repite:

- **El fix de 6.4 tapaba solo el aeropuerto.** Puse
  `dbCityToUiCity[nextBucket] ?? nextBucket`, y para TukTuk la clave es
  `TT~Lima~Comas`, que no está en ese mapa: el `??` devolvía el bucketKey crudo y
  el bug quedaba idéntico por el camino MÁS fácil de alcanzar. Ahora desarma la
  clave con `parseBucketKey`, igual que `openHistorySession`.
- **`canEditRow` en Ver Datos documentaba el modelo viejo.** Su comentario decía
  que las filas sin dueño siguen editables por cualquiera con el país — falso
  desde la mig 203. El botón quedaba habilitado para filas que el hub nunca iba a
  poder tocar.

Y una corrección a este propio repo: **`npm run lint` SÍ está en CI** desde el
2026-08-01 (`deploy.yml`). CLAUDE.md §9 decía lo contrario; ya está corregido.

### Los dos que estaban abiertos — cerrados, y qué se aprendió

**El "techo" de plausibilidad: el diagnóstico estaba al revés (mig 210).**
Este documento pedía un TECHO que le sacara la confianza a una duración
demasiado grande. Se miró el dato antes de escribirlo y era lo contrario: la
duración está bien y lo que está mal es la ventana. El caso peor —211.0 minutos
declarados en una ventana de 13 segundos— tiene `turno_timings` que suman
**exactamente 211.0** (113.4 + 44.0 + 53.6). Un techo habría tirado a la basura
**19 mediciones legítimas**, que son justo el reporte de productividad que se
quería proteger. Es el mismo error que ya se cometió con el piso (mig 201 §3),
en la otra dirección.

La causa real: el cliente viejo tomaba `started_at` del reloj de pared en el
instante del cierre, y en una sesión multi-frente cada cierre reseteaba el reloj
— el `started_at` de cada frente terminaba siendo el `ended_at` del anterior. Y
**no era un bug vivo, era residuo**: PRE-deploy 14 de 65 filas violan, bundle
intermedio 5 de 19, **POST-deploy 0 de 4**. `sessionDuration.js` ya lo había
arreglado; la mig 196 backfilleó `duration_minutes` y se olvidó de la ventana
que lo tiene que contener. La 210 backfillea la ventana (19 → 0) y pone un
guard en los dos triggers. `LEAST`, nunca asignación directa: la ventana solo
se ensancha, porque un hub que abrió la sesión 40 min antes de su primera celda
tiene una ventana legítimamente más ancha.

**El candado de pestañas y el latido: `heartbeatLeaseKey` + `latidoDelegado`.**
El lease de borrador protege el recurso correcto con el alcance correcto; el
latido escribe OTRO recurso —`ci_active_sessions`, PK `user_email`— y por eso
necesita su propio lease, global por hub. El latido ahora exige los dos.

Dos cosas que no eran obvias al implementarlo:

- **El empate.** El lease global se disputa SOLO entre pestañas que ya son
  dueñas de su borrador. Sin esa precondición, A podía ganar el latido y A' el
  borrador del mismo bucket, y entonces ninguna late: el hub desaparece de
  "en vivo".
- **La alarma falsa que este documento anticipaba, y tenía razón.** La pestaña
  que delega nunca recibe un `lastHeartbeatOkAt`, así que el cartel de "sin
  contacto con el servidor" quedaría encendido para siempre con la conexión
  sana. Se resolvió por el lado honesto: una pestaña sin sonda de vida propia
  **no puede afirmar** que el servidor no responde, así que se calla sobre la
  conexión y muestra los estados de guardado, que sí son ciertos. El aviso no
  desaparece del sistema — lo da la pestaña que sí late, y hay una sola por hub.

Probado A/B en navegador con 2 pestañas reales y dos sesiones activas en buckets
distintos: con el gate desarmado la fila queda en el bucket de la pestaña que NO
tiene el candado; con el fix, en el del dueño legítimo y estable.

**El modelo de `simulate-durability` es PRE-fix y se contradice con sus propias
invariantes.** Endurecí las invariantes (ahora exigen la forma de la cuenta, no
la presencia del identificador, y una mutación lint-clean las pone en rojo), pero
el modelo de `tipear` sigue siendo un debounce puro sin techo: afirma en verde
pérdidas de 60 y 30 celdas donde el planificador real deja 0-2. Las dos mitades
del archivo pasan. El arreglo de fondo es sacar la decisión del god-component a
un módulo puro (`esperaAutosave`, `mergearBorrador`) y que el modelo lo IMPORTE
en vez de re-implementarlo — mismo criterio con el que ya salieron
`debeHidratarBorrador` y `debeReanudarTramo`.

---

## Lo implementado en la corrida nocturna

| Bloque              | Qué se cerró                                                                                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3 · Upload**      | El `DELETE` sin transacción (RPC nueva), `parseExcelDate` que convertía un año suelto en 1905 y ensanchaba el borrado, `toNumeric` que dividía precios por mil y divergía del bot, y el panel de outliers que corregía la fila equivocada |
| **4 · Dashboard**   | Los pesos que se mezclaban entre países (4,02% de error, no determinístico) y el tope de 1.000 filas que hacía desaparecer competidores enteros                                                                                           |
| **5 · Monitoreo**   | El error de `ci_sessions` que no se destructuraba, el truncado silencioso en 300 sesiones, y la tarjeta de representatividad que desaparecía al fallar                                                                                    |
| **6 · Ingresar CI** | El candado de pestañas que quedaba degradado para siempre, la traza de actividad que no sobrevivía al F5, `discardDraft` con el namespace equivocado, y el `surge` que el auto-load pisaba                                                |
| **Extra**           | Un hub sin secciones podía borrar los 150.000 registros del bot (mig 203); la clave i18n cruda visible al usuario; Monitoreo desbordaba 315px a 390px                                                                                     |

Todo con `test:all` en 0, lint sin warnings, build OK y las **8 simulaciones SQL
en verde**.

---

## Estado, sin adornos

Lo que se arregló hoy es real y está probado. Lo que queda es más de lo que se
arregló, y una parte no la introdujo nadie esta semana: son huecos viejos que
recién ahora se miraron con la lupa correcta.

Tres cosas que conviene tener presentes antes de leer el resto:

- **Producción tiene una fuga abierta ahora mismo.** Cualquiera con la clave
  pública del bundle se baja 72.741 filas de precios de competencia. El fix está
  escrito y probado en local; falta aplicarlo.
- **Las herramientas de chequeo mentían en verde.** `check:rls-drift` era ciego a
  las políticas `FOR ALL`, `check:section-grants` no puede ver una RPC huérfana,
  y dos simulaciones tenían el agujero codificado como comportamiento esperado.
  Eso significa que "la suite está verde" valía menos de lo que parecía.
- **Varios bugs los introduje yo hoy**, al aplicar las migraciones 195/197/198.
  Están corregidos en la 201, pero es el dato más importante del día: el trabajo
  de seguridad de la mañana abrió agujeros nuevos que solo aparecieron cuando
  alguien atacó específicamente ese trabajo.

---

## ✅ Ya hecho y verificado (no vuelve al plan)

| Qué                                                                      | Dónde                                        |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| Pérdida del borrador en el F5 — la identidad llegaba tarde               | `debeHidratarBorrador` + 9 pruebas           |
| 3 RPCs alcanzables por `anon` sin login                                  | mig **200**                                  |
| 3 regresiones de las migs 195/197/198                                    | mig **201**                                  |
| Piso de plausibilidad (el `0.1` confiable) y coherencia duración/ventana | mig **201**                                  |
| 3 políticas de INSERT sin dueño ni país                                  | mig **202**                                  |
| Mi propia regresión: el latido congelado al cambiar de país              | mig **202**                                  |
| El botón "Cerrar sesión" que decía que cerró y no cerraba                | `UnfinishedSessionsPanel.jsx`                |
| `check:rls-drift` ciego a `FOR ALL`                                      | `check-rls-policy-drift.sql`                 |
| Detector nuevo de RPCs alcanzables por anon                              | `check:anon-rpcs`                            |
| Simulaciones que validaban la fuga                                       | `simulate-adversarial`, `simulate-hub-daily` |
| **Bloque 3 entero** — los 4 defectos de Upload                           | migs **203/204** + `uploadParsers.js`        |
| **Bloque 4.1 y 4.2** — tope de 1.000 filas y pesos por país              | `usePricingData.js`, `weightedAverage.js`    |
| Un hub sin secciones borraba los ~150.000 registros del bot              | mig **203**                                  |
| La clave cruda `dashboard.chart.week` mostrada al usuario                | `i18n.js`, 3 locales                         |

**Las migs 200/201/202 están aplicadas en LOCAL, no en producción.**

---

## BLOQUE 1 — Aplicar a producción lo que ya está probado

**Por qué primero:** es lo único que cierra una fuga que está abierta _ahora_, y
el trabajo ya está hecho y verificado. No aplicarlo no es neutral.

1. **mig 200** — cierra las 3 RPCs alcanzables por `anon`. La grave expone el
   histórico completo de inteligencia competitiva: 15 competidores, 10 ciudades,
   56 semanas.
2. **mig 201** — cierra la fuga de minutos entre hubs, el cruce de países en
   `close_ci_session`, y las duraciones de juguete marcadas como confiables.
3. **mig 202** — cierra la falsificación de dueño y los cruces de país por
   escritura directa a la tabla.

**Verificación:** `npm run check:anon-rpcs` (nivel 1 en 0), `check:rls-drift`,
y la matriz de 7 casos que ya está en el pie de cada migración.

**Riesgo:** bajo. Las tres pasaron mutación inversa (revertirlas reabre los
agujeros) y el flujo normal del hub se probó entero: batch de 200 filas,
`DELETE+INSERT` idempotente, upload y bot.

---

## Tercera ronda (workflow) — qué agregó

Cuatro finders en paralelo + panel de escépticos. **25 hallazgos crudos, 16
P0/P1, todos con repro ejecutado.** El workflow se cortó por límite de sesión
antes de terminar de refutar y de consolidar, así que los veredictos del panel
están incompletos — lo que sigue son los hallazgos crudos, ya verificados por
quien los encontró pero sin la segunda opinión.

Dos apuntaban a arreglos que yo había hecho **esa misma tarde**, y tenían razón:

- **El piso de plausibilidad descartaba una medición legítima.** Ponía el valor
  en NULL y caía al reloj del latido: 45 segundos reales de trabajo se
  guardaban como **360 minutos** si el latido venía viejo. Cambiar un número
  chico y honesto por uno grande e inventado es peor que el problema original.
  _Corregido:_ el valor medido se conserva y solo pierde la marca de confianza.
- **El piso solo existía en el cierre del admin.** El camino normal —el hub
  apretando Terminar— entra por `close_ci_session` y toma `duration_confiable`
  del cliente, que no tiene piso. La invariante que yo mismo declaré en la
  migración era falsa para la puerta más transitada. _Corregido:_ el piso vive
  ahora en el trigger, que corre en todo INSERT a `ci_sessions` sin importar
  quién lo haga.

Queda pendiente de la misma familia: **`validate_country_setup` sigue filtrando
entre países** con el gate por sección que le puse, y el motivo que escribí para
omitir el chequeo de país es discutible. Hay que decidir si un rol con `config`
de Perú debe ver el diagnóstico de Colombia.

---

## BLOQUE 2 — Los tres agujeros de escritura que quedan abiertos

**Por qué acá:** son pérdida o corrupción de datos, alcanzables desde la UI, y
el fix es de una sola clase (políticas RLS + un guard de sección).

### 2.1 · ✅ RESUELTO — mig 203

`pricing_observations` permite `UPDATE` y `DELETE` sobre filas con
`uploaded_by IS NULL` a cualquiera que tenga el país. **Verificado: el DELETE
pasó y no sobrevivió ninguna fila.** En producción son ~150.000 filas.

Peor: esa tabla **no usa `can_write_table()`**, así que el modelo genérico de
permisos de las migs 187/192 no la cubre. Y `useRawDataMutations.js` borra y
edita por `id` sin predicado de dueño, desde una ruta que no es `adminOnly`.

_Fix:_ sumar `can_write_table('pricing_observations')` al `USING` de UPDATE y
DELETE, conservando la escotilla `uploaded_by IS NULL` solo para quien tenga el
permiso. Hay que confirmar que el bot corre con `service_role` (bypasea RLS)
antes de cerrarlo.

### 2.2 · `get_ci_session_turno_timings` entrega los horarios de otro hub

`SECURITY DEFINER`, sin filtro por `user_email`, llamada desde una página que no
es `adminOnly`. Son los mismos timestamps de los que sale "cuántos minutos
trabajó".

### 2.3 · `get_active_sessions_presence` sin `is_admin()`

Devuelve el email, la ciudad y la zona de los compañeros. Matiza la premisa de
la 201: los emails ya eran visibles por diseño. Decidir si es intencional.

---

## BLOQUE 3 — ✅ RESUELTO (migs 203/204 + parsers)

**Por qué acá:** es el único camino de escritura masiva que **no** usa RPC, y
por lo tanto el único sin transacción. Cuatro defectos que se componen.

| #   | Qué pasa                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | El `DELETE` corre **antes** de INSERTs que pueden fallar, **sin transacción**. Si el lote falla, lo borrado no vuelve. Hay caminos alcanzables desde la UI que lo hacen fallar (cambiar la ciudad a Corp salta el filtro anti-Yango). |
| 3.2 | `parseExcelDate` convierte `"2026"` en `1905-07-18`, y el rango del DELETE se calcula sobre min/max de las filas: **una sola celda con un año suelto borra toda la historia de esa ciudad**.                                          |
| 3.3 | `toNumeric("1,234.50")` → `1.234`. Divide precios por mil, sin error y sin outlier. Y `botMapping.js` hace lo **contrario**, así que el mismo string da distinto según el camino de entrada.                                          |
| 3.4 | El panel de outliers corrige la fila **equivocada** cuando `sanitizeBatch` descartó filas antes: los índices son de arrays distintos. Se dispara siempre que haya ≥1 fila descartada.                                                 |

_Fix del 3.1:_ mover el `DELETE+INSERT` a una RPC `SECURITY DEFINER`
transaccional, como ya hace `save_ci_batch`. Es el patrón canónico del repo
(§1) y resuelve el problema de raíz en vez de parchar el orden.

---

## BLOQUE 4 — El Dashboard muestra números equivocados

### 4.1 · ✅ RESUELTO — paginación de RPC

3.120 filas pedidas contra el tope de 1.000 de PostgREST, sin paginar. Yango no
entra. Los KPIs muestran `—` o el líder equivocado, indistinguible de "no hay
datos". El repo **ya tiene** el patrón correcto en `fetchAllObservations.js`.

### 4.2 · ✅ RESUELTO — `buildWeightsMap` filtra por país

`buildWeightsMap` no recibe `country` y `ConfigProvider` trae los pesos de los 6
países sin filtrar ni ordenar. Gana el último que devuelva Postgres. **4,02% de
diferencia medida**, y no determinístico. La función SQL espejo (`freeze_pricing_wa`)
sí filtra por país: las semanas congeladas y las vivas usan metodologías
distintas.

### 4.3 · "Yango vs Competencia" cuenta a YangoComfort como competencia

`+16,25%` mostrado contra `+30,85%` real. Afecta también "Líder de mercado" y
"Posición Yango". La base define rival al revés (`competition_name !~~* 'Yango%'`).

### 4.4 · El drill-down no reproduce la celda que dice explicar

Para InDrive la MV usa el promedio de bids y el modal usa `recommended_price`.

---

## BLOQUE 5 — ✅ RESUELTO en su mayor parte

Arreglados: el `error` de `ci_sessions` que no se destructuraba (un fallo de red
se pintaba como "ningún hub terminó nunca"), el truncado silencioso en 300
sesiones (ahora dice cuántas hay y sugiere acotar el rango), y la
`RepresentativityCard` que desaparecía cuando fallaba en vez de decirlo.

Queda pendiente de este bloque: la validación del email al reasignar, y que
`TurnoTimesPanel` esconde la línea de "sesiones excluidas" si el count falla.

### Detalle original

Todos comparten una causa: **un error de infraestructura se renderiza como un
dato de negocio**.

- **Un fallo de `ci_sessions` se muestra como "ningún hub terminó nunca"** — el
  `error` de la query del medio no se destructura, `failed` sigue en `false`.
- **Truncado silencioso en 300 sesiones**, sin `count` ni aviso. §5 lo prohíbe
  explícitamente, y el patrón correcto ya existe en `ClientErrorsPanel`.
- **`RepresentativityCard` desaparece cuando falla** — el estado `failed` se
  calcula y nunca se renderiza.
- **Reasignar a un email inexistente no valida nada** — un typo deja filas
  huérfanas que ningún hub carga.
- **`TurnoTimesPanel` esconde la línea de "sesiones excluidas"** si el count
  falla — justo la línea que separa "confiá en este número" de "confiá y acá
  está por qué".

---

## BLOQUE 6 — Los bugs de cliente de Ingresar CI

**Por qué después:** son reales y algunos pierden datos, pero el archivo es un
god-component de 4.200 líneas y cada cambio ahí arriesga los fixes de re-render
ya hechos (§5). Merecen una sesión propia, con verificación en navegador.

| #   | Qué pasa                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6.1 | ✅ RESUELTO — **El candado de pestañas quedaba degradado para siempre** si el hub hace alt-tab al simulador del competidor. Sin autosave, sin flush: lo que teclee se pierde. Hay banner, pero el trabajo ya no está en disco.             |
| 6.2 | ✅ RESUELTO — **La traza de actividad no sobrevivía al F5** y todo lo anterior se reporta como ocio, marcado como medición buena. Un F5 a las 12:30 de 3 horas escribe `active=30 / idle=150`.                                             |
| 6.3 | ✅ RESUELTO — **`discardDraft` filtraba por `uiCity`** donde el alcance vive en `bucketKey`. Rompe TukTuk y toda ciudad con `uiName ≠ dbName` (Bogotá). La sesión no cierra nunca. _Aeropuerto funciona_ — corrección a un reporte previo. |
| 6.4 | **`handleFinishSession` hace `setUiCity` con un `bucketKey`** → grilla vacía y una ciudad inexistente escrita en el latido.                                                                                                                |
| 6.5 | **`resolvedStartMembers` declara el alcance en `uiCity`** y se cierra en `bucketKey`. Latente hoy; P1 el día que se onboardee un aeropuerto con acento.                                                                                    |
| 6.6 | **El auto-load pisa el flag `surge`** del hub — el mismo P2-12 arreglado para las celdas, sin arreglar para `surge`.                                                                                                                       |
| 6.7 | **P1-9**: el auto-reload por deploy a los 60s. La mitad grave ya la cubre el fix del F5; queda la molestia.                                                                                                                                |

---

## BLOQUE 7 — i18n y responsive

- **57 strings hardcodeados en JSX**, en 8 archivos. `BotVsHubs.jsx` tiene 3
  llamadas a `t()` en toda la página: está esencialmente sin traducir.
- **`dashboard.chart.week` y `dashboard.chart.period` no existen** en ningún
  locale, y se le muestra **la clave cruda al usuario** en los tooltips de 14
  gráficos, en los 3 idiomas.
- **Monitoreo desborda 315px a 390px** — una URL sin `word-break` y un header
  sin `flex-wrap`. Dashboard y Proyectos están en 0.

**Lo bueno:** 1.898 claves en los 3 locales, **0 faltantes, 0 duplicadas**. La
paridad de locales está impecable.

---

## Deuda estructural — no son bugs puntuales

Esto es lo que más me preocupa, porque explica por qué los bugs de arriba
sobrevivieron tanto.

1. **`pricing_observations` está fuera del modelo genérico de permisos.** Es la
   tabla más grande del proyecto y sus políticas no llaman `can_write_table()`.
2. **`check:section-grants` solo ve lo que la app llama.** Una RPC huérfana es
   invisible para él por diseño. Ya se agregó `check:anon-rpcs`; falta el
   simétrico para RPCs que devuelven datos ajenos.
3. **Las simulaciones pueden validar agujeros.** Pasó dos veces hoy. Toda
   simulación de un camino de escritura del hub tiene que correr con
   `SET LOCAL ROLE authenticated`.
4. **No hay E2E de navegador.** CLAUDE.md §1 ya dice que la clase de bug más
   cara del proyecto es justo la que un E2E caza. Hoy se cubre a mano.
5. **Sin CHECK constraints en `pricing_observations`.** Ciudad fuera de
   catálogo, categoría inexistente, precio negativo: todo entra sin ruido.
6. **`lint` no está en CI.** Hasta que esté, correrlo a mano es obligatorio.

---

## Lo que sigue sin verificarse

- **El corte real de PostgREST en 1.000 filas** — se midió la cardinalidad
  (3.120), no el truncado sobre el endpoint con un JWT autenticado.
- **Proyectos a 390px con tareas cargadas** — la tabla está vacía en local.
- **El impacto del 4.3 con datos reales** — se midió con precios sintéticos
  porque no había filas de YangoComfort en local.
- **El flujo completo de "Terminar" en navegador**, incluido Aeropuerto "Ambos"
  y TukTuk por distrito.
- **La recalibración del umbral de inactividad de 5 minutos**, que necesita una
  semana de `activity_trace` real — y que hoy estaría contaminada por el 6.2.

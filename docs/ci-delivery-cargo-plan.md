# CI de Delivery y Cargo — plan de implementación

Fecha de diseño: 2026-09-07. Rama de trabajo: `feat/ci-delivery-cargo`.
Referencia de reglas: `CLAUDE.md` (obligatorio en todo este trabajo).

## 1. Alcance acordado

- Ciudad: **solo Lima** por ahora (Trujillo/Arequipa quedan para el futuro).
- Categorías nuevas: **Delivery** y **Cargo**, cada una con su propia pestaña en
  Ingresar CI (mismo mecanismo que TukTuk hoy: sesión propia, contador propio,
  "Terminar este punto" propio).
- Competidores:
  - Delivery: Yango, InDrive, PedidosYa, Rappi.
  - Cargo: Yango, InDrive.
  - Didi y Uber quedan en `bot_rules` para el bot, pero NO se cargan a mano
    (no entran al catálogo de competidores manuales de estas categorías).
- Campos por celda: **precio obligatorio**, **precio con descuento disponible
  pero opcional** (se deja el campo, no se oculta), **sin ETA** (el campo ya es
  opcional en la base — es un cambio de pantalla, no de datos). InDrive sigue
  con contraofertas (hasta 5 bids + recomendado), igual que en ride-hailing.
- Turnos: los 3 de siempre (Mañana/Tarde/Noche).
- Rutas: **dos juegos independientes de 12 rutas** (uno para Delivery, otro
  para Cargo), aunque hoy tengan el mismo contenido — pueden divergir sin
  tocar código. Origen: Vía Principal 129, San Isidro. 12 destinos de 1 a 12 km
  (confirmar/corregir la lista exacta con el user antes de cargar en BD).
- Umbrales de distancia (nuevos, no existían): **2 / 4 / 6 / 8 / 10 / ∞ km**
  para Lima/Delivery y Lima/Cargo → exactamente 2 rutas por bracket con la
  malla de 1-12 km, que es lo que hace comparable el análisis.
- Pesos por bracket: **iguales (1/6 cada uno)** al arrancar — los pesos
  actuales de Lima están calibrados para ride-hailing (very_long pesa 28.5%,
  pensado para viajes largos, no para una malla uniforme 1-12km). Ajustar más
  adelante con distribución real de pedidos.
- Semáforo: Delivery y Cargo arrancan **sin semáforo propio** — las bandas
  verde/amarillo/rojo actuales están calibradas para ride-hailing. Definir
  bandas cuando haya 3-4 semanas de datos reales.

## 2. Decisión técnica clave: identidad del frente

Cada pestaña de Ingresar CI necesita su propia "marca de agua" de guardado
(`ci_bucket_writes`, mig 191) o Delivery pisaría el control de concurrencia de
Lima Normal y aparecerían conflictos falsos (el mismo síntoma que sufrió un hub
el 2026-09-07 con Corp).

Solución: usar el campo `zone` para marcar el frente — `zone='Delivery'` /
`zone='Cargo'` — igual que TukTuk usa el distrito y Aeropuerto usa el marcador.
Verificado: `ci_zona_efectiva()` (mig 211) respeta una zona explícita sin
pisarla, y es la MISMA función que usan el trigger de escritura y el DELETE de
`save_ci_batch` — no pueden divergir por diseño.

## 3. Qué se crea en datos (todo primero en LOCAL)

1. Competidor **PedidosYa** en `src/lib/catalogs.js` (CATALOG_COMPETITORS) con
   color propio y aliases (`pedidosya`, `pedidos ya`, `peya`) → forma canónica
   única desde el día uno (mismo criterio que la normalización de Yango, mig 239).
2. Competidores por categoría en `country_config` de Lima (Delivery/Cargo).
3. `distance_thresholds`: 12 filas (6 brackets × 2 categorías).
4. `distance_references`: 24 filas (12 rutas × 2 categorías).
5. `bracket_weights` para Lima/Delivery y Lima/Cargo: 1/6 cada bracket.

## 4. Riesgos identificados y su mitigación

| #   | Riesgo                                                                                     | Mitigación                                                                                  |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 1   | Sin umbrales → todo cae en very_long                                                       | Se crean en la misma migración; test que verifica 2 rutas por bracket                       |
| 2   | Marca de agua compartida con Lima Normal → conflictos falsos                               | zone separa los frentes (ver §2); prueba con 2 hubs simultáneos                             |
| 3   | **Rentabilidad tomaría PedidosYa/Rappi sin comisión configurada → cae al 20% en SILENCIO** | Excluir explícitamente Delivery/Cargo del catálogo de competidores de Rentabilidad          |
| 4   | Nombres de competidor sin normalizar (\"Pedidos Ya\" vs \"PedidosYa\")                     | Forma canónica + alias desde el día uno                                                     |
| 5   | Zona inconsistente entre guardar y borrar → filas duplicadas                               | Misma función `ci_zona_efectiva()` para ambos caminos (ya garantizado por diseño existente) |
| 6   | 216 celdas/día nuevas por hub → fatiga                                                     | Frentes independientes: se puede cargar Delivery hoy y Cargo mañana sin bloquearse          |
| 7   | El bot trae Delivery de Didi/Uber mezclado con lo manual                                   | Ya se distinguen por `data_source`; el dashboard los separa                                 |
| 8   | Lima con 6 pestañas → saturación visual                                                    | Agrupación visual + prueba a 390px                                                          |

## 5. Fases de implementación

- **Fase 0** — Rama `feat/ci-delivery-cargo` + vista previa propia de Vercel.
  Versión semántica (`package.json` → 1.1.0), `CHANGELOG.md`, versión visible
  en la app.
- **Fase 1** — Datos y catálogo (§3) + tests de normalización de PedidosYa.
- **Fase 2** — Pestañas Delivery/Cargo en Ingresar CI: construcción de
  clusters/tabs, `zone` como identidad de frente, nombres legibles para
  Monitoreo, grilla sin ETA con descuento opcional.
- **Fase 3** — Resto del sistema: alta de rutas (Distance Refs), Monitoreo,
  y EXCLUIR Delivery/Cargo del catálogo de Rentabilidad (riesgo #3).
- **Fase 4** — Dashboard: nada nuevo por ahora (ver §6). Las MVs y RPCs
  `_fast` agrupan por category, así que Delivery/Cargo entran solos sin tocar
  código de agregación. Verificar que no degraden performance.
- **Fase 5** — Pruebas: 2 hubs simultáneos, F5 real, terminar cada frente por
  separado, comprobación en BD de que no quedan duplicados. Revisión
  adversarial + batería obligatoria (lint/build/test/section-grants).
- **Fase 6** — Publicación: fusión a `main`, migraciones a prod con OK
  explícito del user (una por una), verificación del bundle real, aviso a hubs.

## 6. Dashboard — CON LO QUE YA EXISTE (decisión 2026-09-07)

El user decidió arrancar SOLO con las vistas que ya existen (Dashboard,
Competitividad) sin construir pantallas nuevas. Las categorías nuevas entran
solas a las MVs existentes porque agrupan por `category`.

**Pendiente para el futuro — NO IMPLEMENTAR AHORA, retomar cuando haya 2-3
semanas de datos reales de Delivery/Cargo:**

1. **Curva de precio por distancia**: una línea por competidor sobre los 12 km
   exactos de la malla. Más informativo que un promedio ponderado porque la
   malla es uniforme y no dispersa como en ride-hailing — se puede ver
   exactamente en qué tramo de distancia Yango es o no competitivo.
2. **"¿Quién es más barato en cada kilómetro?"**: en delivery el usuario
   decide por precio (no hay ETA compensando), así que la métrica que importa
   es en cuántas rutas exactas Yango es el más barato y por cuánto pierde
   cuando no lo es.
3. Revisar en ese momento si conviene: pesos por bracket calibrados con
   distribución real de pedidos, y semáforo propio para Delivery/Cargo.

## 7. Decisiones confirmadas por el user (2026-09-07, segunda ronda)

- Precio con descuento: disponible pero NO obligatorio (ya era así en el
  resto de categorías — cero cambios de código necesarios).
- Umbrales 2/4/6/8/10/∞ km confirmados, agrupando 2 rutas por bracket.
- Dashboard: arrancar SOLO con lo que ya existe (curva de precio/distancia y
  ranking por km quedan documentados en §6 para retomar más adelante).
- Mejoras adicionales pedidas: pruebas de navegador automatizadas, aviso
  temprano de pestaña duplicada, alerta de sesión a medias, revisión de
  volumen de datos, y una pasada de UX en Ingresar CI probando como hub
  experto — pendientes de implementar (ver §8).

## 8. Estado de implementación (actualizado en vivo)

**Hecho y verificado en Supabase LOCAL** (commit(s) en `feat/ci-delivery-cargo`):

- Fase 0 (versionado semántico + CHANGELOG): OK.
- Fase 1 (datos): mig 242 aplicada en local — country_config.Lima gana las
  categorías Delivery (Yango/InDrive/PedidosYa/Rappi) y Cargo (Yango/InDrive);
  distance_thresholds 2/4/6/8/10/∞; bracket_weights 1/6 parejo; 24 filas de
  distance_references (12 por categoría, 2 por bracket, verificado por el DO
  block de la propia migración). PedidosYa agregado al catálogo
  (`src/lib/catalogs.js`, `src/lib/constants.js`) con forma canónica pegada.
- Fase 2 (Ingresar CI): **decisión de diseño clave, revisada dos veces** —
  Delivery/Cargo NO son una ciudad nueva (se descartó `Lima_Delivery` como
  dbCity separado, que hubiera ensuciado el selector de ciudad de Dashboard/
  Rentabilidad/Market/Competitividad/RawData con una entrada sin sentido
  fuera de Ingresar CI). En cambio siguen EXACTAMENTE el precedente de
  TukTuk: misma `city='Lima'` en toda la base, categoría propia
  (`category='Delivery'`/`'Cargo'`), con `zone` como discriminador SOLO para
  darle a la pestaña su propia marca de agua de guardado
  (`ci_bucket_writes`) sin pisar la de "Lima Normal". Nuevo prefijo de
  bucketKey `CAT~` (paralelo a `TT~` de TukTuk, nunca colisionan) en
  `src/lib/dataEntry/keys.js` y `src/lib/sessionFronts.js` (con `kind` en
  `parseBucketKey` para que Monitoreo etiquete "Lima · Delivery" y no
  confunda con un distrito). Estado nuevo `activeSpecialCat` en
  `DataEntry.jsx`, paralelo a `activeTukTuk` pero sin distrito — se
  actualizaron los 3 mecanismos de reanudación (borradores en localStorage,
  historial de sesiones `ci_sessions`, `irAFrente`) para reconocer el nuevo
  `kind: 'category'` en vez de tratarlo como TukTuk. Sin ETA
  (`categoryTracksEta()` en `constants.js`, ocultamiento en
  `BracketRouteGroup.jsx`). InDrive con contraofertas y precio con descuento
  opcional funcionan SIN cambios (ya eran genéricos).
  - Verificado en navegador contra Supabase local: las pestañas Delivery y
    Cargo aparecen, con los competidores correctos y 0 inputs de ETA;
    guardado parcial de Delivery confirmado en BD (`city='Lima'`,
    `category='Delivery'`, `zone='Delivery'`, sin pisar Lima Normal);
    recuperación de borrador tras F5 real con el label correcto ("Lima ·
    Delivery"); **sesión completa de Cargo cerrada de punta a punta: 72
    registros (12 rutas × 2 competidores × 3 turnos), sesión historizada,
    `ci_active_sessions` en 0**. Datos de prueba borrados.
  - Tests nuevos/actualizados: `test-data-entry-keys.mjs` (bucketKeyFor/
    viewIdFor con CAT~), `test-session-fronts.mjs` (parseBucketKey/frontLabel
    con `kind`), `test-data-entry-derived.mjs` (buildCityClusters con tabs
    delivery/cargo). `npm run lint`, `build`, `test:all`,
    `check:section-grants`, paridad i18n: todos en verde.

**Pendiente** (siguiente sesión de trabajo):

- Fase 3: excluir Delivery/Cargo de Rentabilidad (no aplica más — al NO ser
  una ciudad separada, el selector de Rentabilidad nunca las ofrece; esta
  tarea quedó resuelta por el cambio de diseño, no por código nuevo).
  Verificar Monitoreo muestra bien el frente "Lima · Delivery"/"Lima · Cargo"
  en la lista de sesiones (no solo el label del front, también el detalle).
- Fase 4: revisar RawData/exportables no rompan con las categorías nuevas
  (debería ser automático, confirmar).
- Fase 5 (mejoras pedidas 2026-09-07): pruebas de navegador automatizadas del
  flujo (2 hubs simultáneos, F5, terminar cada frente); aviso temprano de
  pestaña duplicada; alerta de sesión a medias; revisión de volumen/índices;
  pasada de UX "hub experto" en Ingresar CI (colapsar instructivo tras la
  primera sesión, salto al siguiente campo vacío).
- Revisión adversarial completa antes de fusionar a `main`.
- Aplicar mig 242 a producción con OK explícito del user (falta también
  decidir si el bot alguna vez debe alimentar estas categorías — hoy no hay
  bot_rules para ellas en ningún entorno, dormant).

## 9. Pruebas de navegador automatizadas (2026-09-07, segunda ronda)

Primera pieza REAL de la suite E2E que CLAUDE.md marca como "pendiente de
adopción, ya no es un no" — hasta hoy no existía ninguna. Instalado
`@playwright/test` + `pg` (dev deps), config en `playwright.config.js`.

- `e2e/global-setup.mjs`: autentica contra Supabase LOCAL con el mismo
  flujo que se usa a mano (Admin API `generateLink` → `verifyOtp`), guarda
  la sesión en `e2e/.auth/admin.json` (gitignored) bajo la clave real
  `sb-127-auth-token` — nunca se manipula `auth.users` a mano (CLAUDE.md §2).
  Las claves ANON/SERVICE_ROLE hardcodeadas son las DEMO fijas y públicas
  que `supabase start` genera siempre en local — no son secretos, solo
  sirven contra 127.0.0.1:54321.
- `e2e/ci-delivery-cargo.spec.js`: 3 tests, corridos 2 veces seguidas sin
  flakiness, sin residuos en BD al terminar (`beforeEach`/`afterEach` limpian
  siempre):
  1. F5 REAL (`page.reload()`, no navegación de React) conserva el borrador
     de Delivery y lo guardado sigue en el servidor.
  2. Sesión completa de Cargo cierra de punta a punta: exactamente 72 filas
     (12×2×3), sesión historizada, sin latido colgado.
  3. Delivery y Cargo no comparten marca de agua de guardado — el segundo
     guardado no dispara el panel de conflicto (mig 191).
- Correr: `npm run test:e2e` (requiere Supabase local arriba + `npm run dev`
  corriendo, o Playwright lo levanta solo vía `webServer`).
- Fuera de esta ronda, a propósito: NO se automatizó el caso de 2 hubs
  simultáneos (necesita 2 BrowserContext) ni el flujo de Aeropuerto/TukTuk —
  quedan como próxima expansión natural ahora que el harness ya existe y
  funciona.

## 10. Volumen e índices (revisado 2026-09-07, sin cambios necesarios)

Delivery/Cargo escriben en la MISMA tabla particionada `pricing_observations`
(city='Lima', category nueva) — no hay partición ni índice nuevo que crear:
los índices compuestos existentes (`country_city_category_idx`,
`country_data_source_city_categ_idx`, etc., ver
`docs/index-usage-baseline-2026-09-03.md`) ya son genéricos por category, no
están hardcodeados a las categorías de ride-hailing. El particionado mensual
(migs 168-169) absorbe el crecimiento sin cambios.

Volumen estimado (worst case, ambas categorías completas todos los días):
12 rutas × 6 competidores (4+2) × 3 turnos = 216 celdas/día por hub — en la
práctica menos, porque son pestañas OPCIONALES que un hub llena cuando
corresponde, no un tercer frente obligatorio. Sin acción hoy; incluir estas
categorías al comparar `idx_scan` en la re-medición ya agendada del
2026-10-03 (por si el patrón de acceso real difiere de ride-hailing).

## 11. UX "hub experto" (2026-09-07) — hecho: colapso automático del instructivo

Ya existía persistencia del instructivo colapsado (localStorage), pero solo
si el hub lo cerraba a mano — un hub nuevo lo ve abierto ocupando toda la
primera pantalla en cada sesión hasta que decide cerrarlo. Ahora se colapsa
SOLO apenas termina la primera sesión de verdad (`isFinalInScope` en
`handleFinishSession`), sin acción del hub — desde la segunda sesión en
adelante ya no lo ve. Verificado en navegador: instructivo abierto al
entrar, sesión de Cargo completa y cerrada, instructivo colapsado en la
MISMA carga de página sin recargar.

**Fuera de esta ronda, documentado para más adelante:** "salto al siguiente
campo vacío" — toca el manejo de foco de la grilla, que CLAUDE.md §5 marca
como zona sensible a re-render (ya hubo un fix P0/P1 de rendimiento ahí).
Mejor abordarlo en una pasada propia, con su propio profiling, no apurado
al final de esta.

## 12. Revisión adversarial (2026-09-07, tercera ronda) — 3 agentes en paralelo

Lógica de cliente, SQL (migs 242/243), y piezas nuevas (E2E/i18n/CSS/CHANGELOG).

**Descartado tras verificación propia**: el agente de SQL reportó un P0 en la
mig 243 (falsos positivos de "sesión sin cerrar" para TODA sesión de
Delivery/Cargo, por supuesta inconsistencia entre `pricing_observations.zone`
y `ci_sessions.zone`). Repetí su repro pero con la RPC REAL (`save_ci_batch`)
en vez de un INSERT manual — `zone='Delivery'` se escribe correctamente en
ambas tablas (`save_ci_batch` usa `v_zone`, la zona efectiva del lote, para
TODAS las filas insertadas, no el `zone` por-ruta de `distance_references`
que sí es NULL). El repro del agente no representaba el camino real de
escritura. No era un bug.

**Corregidos:**

- P1 (E2E): los tests usaban `admin@local.test`, la misma cuenta de las
  pruebas manuales — un `afterEach` corriendo en paralelo con alguien
  probando a mano podía borrarle el trabajo. `e2e/global-setup.mjs` ahora
  crea (si no existe) una cuenta propia `e2e-ci@local.test` vía Admin API.
- P2 (SQL, mig 242): el guard de `country_config` exigía que faltaran LAS
  DOS categorías para disparar — un estado a medias (Delivery sin Cargo)
  quedaba así para siempre al re-correr. Corregido a "falta cualquiera de
  las dos" + inserción independiente por categoría. Probado en local: con
  Delivery presente y Cargo ausente, la migración corregida agrega solo
  Cargo (`UPDATE 1`); con las dos presentes, `UPDATE 0` (no duplica).
- P2 (cliente): `irAFrente` ahora valida que la categoría siga en
  `countryConfig.categoriesByCity` antes de saltar — si se borrara Delivery/
  Cargo del catálogo después de tener sesiones guardadas, "Ir ahí" ya no
  lleva a una grilla vacía en silencio.
- P2 (i18n): el tooltip "Versión de la app" del Topbar estaba hardcodeado en
  español — ahora pasa por `t()` en los 3 locales.
- P2 (CSS): `--sem-blue-*` se usaba en `data-entry.css` (y ya antes en
  `projects.css`) sin estar definida en ningún lado — el fallback inline
  coincidía por casualidad. Ahora existe de verdad en `global.css`.
- CHANGELOG completado con las 4 entradas que faltaban (aviso temprano,
  alerta de sesión a medias, colapso de instructivo, suite E2E).

**Aceptado sin cambio** (P2, bajo riesgo/probabilidad, documentado en el
propio código): un admin podría nombrar un distrito de TukTuk literalmente
"Delivery" o "Cargo" en Distancias de Referencia, lo que confundiría
`SPECIAL_CATEGORY_ZONES`. Requiere una acción manual fuera del flujo normal
(la UI de Config no ofrece TukTuk y Delivery/Cargo como opciones
intercambiables); no se agregó validación extra por ahora.

Validación final tras los fixes: lint 0 warnings, build, test:all,
check:section-grants, y la suite E2E (3/3) — todo en verde. Sin residuos de
la cuenta e2e-ci@local.test en BD.

## 13. Cargo: subcategorías de vehículo (2026-09-07, pedido posterior al merge)

Cargo deja de ser "Yango vs InDrive" a secas: cada marca tiene 4 tamaños de
vehículo, cada uno con su propia columna en la grilla (ver mig 244). Volumen
resultante: 12 rutas × 8 subcategorías × 3 turnos = 288 celdas/día (el
turno de mediodía se carga marcando "sin oferta" — decisión explícita del
user para no tocar el mecanismo de turnos, que es global).

| Marca   | Competidor interno    | Columna    | Nombre completo                |
| ------- | --------------------- | ---------- | ------------------------------ |
| Yango   | `YangoCargoXP`        | XP         | Camión Extra Pequeño           |
| Yango   | `YangoCargoPickup`    | Pickup     | Minivan/Pickup                 |
| Yango   | `YangoCargoM`         | Mediano    | Camión Mediano                 |
| Yango   | `YangoCargoXL`        | Grande     | Camión Grande                  |
| InDrive | `InDriveCargoPickup`  | Pickup/SUV | Pickup y SUV (contraofertas)   |
| InDrive | `InDriveCargoVan`     | Van        | Van (contraofertas)            |
| InDrive | `InDriveCargoLiviano` | Liviano    | Camión Liviano (contraofertas) |
| InDrive | `InDriveCargoGrande`  | Camión     | Camión (contraofertas)         |

**Bug real encontrado y corregido ANTES de mergear** (probado en navegador, no
solo revisado en el código): el mecanismo de contraofertas de InDrive
identificaba la celda por `(uiCat, refId, timeslot)` SIN el competidor —
funcionaba porque hasta ahora solo existía UN InDrive por fila. Con 4
subcategorías de InDrive compartiendo la misma fila, las 4 pisaban el mismo
estado de bids/recomendado (P0 de corrupción de datos, nunca llegó a
producción). Corregido en 3 capas:

- `indKey()` (`lib/dataEntry/keys.js`) ahora incluye `comp`, igual que
  `priceKey()` — mismo formato exacto entre las dos.
- `setIndrive()` y los 7 puntos de uso de `indKey()` en `DataEntry.jsx`/
  `rows.js`/`BracketRouteGroup.jsx` actualizados para pasar `comp`.
- Un segundo bug relacionado en el mismo componente: `avg={getEntry(...,
'InDrive')}` tenía el nombre de competidor HARDCODEADO en vez de usar
  `comp` — mismo síntoma, otra causa.

Verificado en navegador contra Supabase local: 4 valores DISTINTOS
(11/22/33/44) escritos en las 4 celdas de contraofertas de InDrive de la
MISMA fila, guardados y confirmados en `pricing_observations.recommended_price`
sin colisión; las 4 de Yango con sus propios precios (100/200/300/400).
`isInDriveVariant()` (nuevo, `constants.js`) generaliza el chequeo
`comp === 'InDrive'` a las 4 subcategorías en los 6 puntos donde existía.

Nombres cortos en pantalla con nombre completo en el tooltip
(`COMPETITOR_SHORT_LABEL`/`COMPETITOR_FULL_LABEL` en `catalogs.js`,
`CompBadge.jsx`).

E2E actualizado: el test de cierre de sesión de Cargo ahora espera 288 filas
(antes 72) — sigue pasando (3/3) y de paso confirma el volumen nuevo
automáticamente en cada corrida futura.

Migración 244 aplicada en LOCAL, probada dos veces seguidas (segunda
corrida `UPDATE 0`, idempotente).

## 14. Revisión adversarial de las subcategorías de Cargo (2026-09-07)

2 agentes en paralelo (lógica de cliente, SQL/datos de la mig 244). Sin
hallazgos P0/P1 en ninguno de los dos.

**SQL/datos — confirmado sin cambios necesarios:** mig 244 idéntica a su
espejo; idempotente incluso ante corrupción manual del array de competidores
(probado insertando un estado a medias y confirmando que la migración lo
corrige); los 8 nombres nuevos no colisionan con el diccionario de
`normalize_competitor_name` (mig 239, probado insertando cada uno); sin
reglas de bot huérfanas para Cargo; `check:section-grants` verde; sin límite
de tamaño de batch para las 288 filas (probado con un INSERT real de 288).

**Cliente — 5 P2 corregidos:** la generalización de `comp === 'InDrive'` a
`isInDriveVariant()` se había hecho bien en el camino de ESCRITURA
(`DataEntry.jsx`, `rows.js`, `BracketRouteGroup.jsx`) pero quedó a medias en
el camino de LECTURA/dashboard:

- `src/lib/representativity.js`: el umbral de representatividad (14/55 en
  vez de 10/40) ahora aplica a las 4 subcategorías de InDrive en Cargo, no
  solo a "InDrive" a secas.
- `src/components/dashboard/DrillDownModal.jsx`: el predicado que decide si
  buscar por bids o por precio simple ahora reconoce las 4 subcategorías —
  antes una fila de Cargo InDrive con bids pero sin `recommended_price`
  hubiera quedado invisible en el drill-down (mismo bug que el propio
  comentario del archivo documenta para InDrive puro).
- `src/components/market/DiscountIntensity.jsx`: la nota "precio con
  contraoferta" ahora aparece también para las 4 subcategorías (cosmético).
- `src/algorithms/indrive.js`: **NO se generalizó a propósito** — es "espejo
  exacto" de la vista SQL `v_effective_price`, que sigue comparando
  `competition_name = 'InDrive'` literal. Cambiar solo el JS habría creado
  una divergencia nueva entre JS y SQL, exactamente la clase de bug que el
  propio archivo advierte que ya pasó dos veces. Hoy es inofensivo porque
  Cargo es 100% manual y el cliente siempre precalcula el promedio de bids
  en `price_without_discount` antes de guardar. Se dejó documentado en el
  archivo: si Cargo alguna vez gana un camino de ingesta que no precalcule
  ese promedio (bot, import de Excel), la función y la vista SQL hay que
  generalizarlas JUNTAS, en la misma migración.

Validación: lint 0 warnings, build, test:all, suite E2E 3/3.

## 15. Revisión UX/UI de la grilla de Ingresar CI (2026-09-07)

Pedido del user: "veo varias rutas y brackets y todos son del mismo color y es
complicado de entender y mantener un orden". Con 12 rutas × 3 turnos son 36
tarjetas idénticas: el hub no sabía en qué turno estaba, cuánto le faltaba, ni
qué tarjeta seguía. Cambios (solo cliente, sin migración):

- **Escala de color por bracket** (`BRACKET_COLORS` en `src/lib/constants.js`,
  azul → rojo de very_short a very_long). Cada bracket tiene una **banda**
  con su color, rango de km y progreso de rutas (`.de-bracket-band`); las
  tarjetas de adentro heredan el color en el borde izquierdo y en la
  etiqueta del bracket (antes siempre rojo Yango).
- **Cabecera de turno sticky** (`TurnoSection.jsx`, `top: 52px` = topbar).
  Lleva un **minimapa** con un chip por bracket (`VS 2/2`, `S 0/2`…) que al
  clickear salta a esa banda. `.de-turno-section` pasó de `overflow: hidden`
  a `overflow: clip` — `hidden` mata el sticky.
- **Cada tarjeta muestra `Ruta i/12` y un estado** ✓ completa / ● a medias /
  ○ vacía (`groupStatus()` en DataEntry.jsx, mismo `rowState` que usa el
  contador). La completa se atenúa en verde, la parcial en ámbar.
- **Origen común una sola vez** arriba de la grilla (`.de-common-origin`)
  cuando todas las rutas comparten punto A (Delivery/Cargo); las tarjetas
  dejan de repetirlo. En Normal/TukTuk, con orígenes distintos, se sigue
  mostrando por tarjeta.
- Se quitó el encabezado turno/hora repetido dentro de cada tarjeta (ya está
  en la cabecera sticky).

Validación: lint 0 warnings, build, test:all, E2E 3/3 (los selectores
`.de-cat-row`, `.de-sd-row-btn`, `.de-nodata-badge` no cambiaron), navegador
a 1366px sobre la pestaña Cargo (sticky + minimapa + bandas verificados).
Fuera de alcance responsive por diseño (CLAUDE.md §1).

## 16. Segunda ronda UX + código (2026-09-07, pedido "arreglar todo")

UX (todo solo cliente):

- **Enter salta al próximo precio vacío** (`handleGridKeyDown` en
  DataEntry.jsx, delegado en `.de-grid`, resuelve sobre el DOM en el momento
  del Enter — no toca el render de la grilla). Solo `input.de-price-input`;
  ETA/descuento siguen por Tab.
- **Auto-colapso de ruta completa** (`BracketRouteGroup`): se pliega cuando el
  foco SALE de la tarjeta (por `onBlur` + `relatedTarget`, nunca mientras se
  tipea adentro). Reabrirla a mano se respeta hasta que deje de estar
  completa. Los E2E que iteraban filas por índice se reescribieron para tomar
  siempre la primera fila sin resolver (las filas de una tarjeta plegada
  salen del DOM).
- **Pestaña duplicada**: el lease se libera en `pagehide` (un F5 no corre el
  cleanup del efecto y la pestaña recargada se veía a sí misma como "otra"
  durante 150 s) y el aviso pasó de rojo a ámbar con botón **"Usar esta
  pestaña"** (`claimDraftLease`: escribe el lease propio; la otra pestaña se
  degrada sola por `storage`). Verificado con una segunda pestaña real.
- **Pills de turno** de la barra de fecha ahora son atajos que saltan a la
  cabecera del turno (`id="de-turno-<label>"` en TurnoSection).
- **Contador**: sin sesión ni trabajo muestra "12 rutas · 3 turnos" en vez de
  "0 / 0 campos"; oculto si no hay rutas.
- **Guía**: 3 pasos visibles + "Ver más" para InDrive/guardado/cierre.

Código:

- `notify(type, key, params, opts)` en DataEntry.jsx reemplaza 13 `setMsg`
  de una línea; los multilínea con params quedaron como estaban.
- CSS: 5 bloques huérfanos borrados (`de-timeslot-heading`, `de-ts-pill`,
  `de-ts-time`, `de-other-draft*`, `de-city-tab--locked`, `de-ctrl--surge`).
  Método: clases `.de-*`/`.indrive-*` del CSS que no aparecen en ningún
  `.jsx/.js` ni en `e2e/`, descontando sufijos `--estado` dinámicos.
- E2E nuevos (`e2e/ci-tuktuk-y-dos-hubs.spec.js`): TukTuk (distrito Comas,
  ETA visible, F5, cierre con `zone='Comas'` en BD) y **dos hubs a la vez**
  sobre Delivery (dos contextos con dos cuentas, guardan casi a la vez, sin
  conflicto, cada uno sus filas, cartel de presencia visible). global-setup
  ahora crea dos cuentas (`e2e-ci@` y `e2e-ci-2@local.test`).
  Estabilidad: 10 corridas, 9 verdes; la única falla no dejó traza
  (test-results se limpia por corrida) — vigilar si se repite.

Pendiente grande (no arrancado a propósito): partir `DataEntry.jsx`
(5.000 líneas, 135 hooks) en `useCiSession` / `useCiDraft` / avisos. Es una
tarea propia, después del merge, con esta suite E2E como red.

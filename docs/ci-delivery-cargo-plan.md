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

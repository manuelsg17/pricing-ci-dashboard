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

## 7. Pendiente de confirmación del user antes de cargar datos reales

- Lista exacta de los 12 destinos (origen: Vía Principal 129, San Isidro) —
  ver captura de pantalla del 2026-09-07 para la lista tentativa.
- Si el "precio con descuento" debe tener algún tratamiento especial en el
  cálculo (por ahora: mismo criterio que ride-hailing, opcional).

# Pricing CI Dashboard

Dashboard interno de competitive intelligence (CI) de pricing para Yango LATAM.
Muestra precios promedio ponderados por bracket de distancia, comparados contra
Uber, Didi, InDrive, Cabify, etc., en 6 países: Perú, Colombia, Bolivia, Nepal,
Venezuela, Zambia.

> Stack: React 18 + Vite, Supabase (Postgres + Edge Functions), Recharts,
> jsPDF, html2canvas. Sin framework de testing ni TypeScript.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # produce ./dist
npm run test:bot-mapping   # corre tests del pipeline del bot
```

`.env.local` (ya existe en el repo, no commitear nuevas credenciales):

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

---

## Arquitectura — qué hace cada página

| Tab | Archivo | Para qué sirve |
|---|---|---|
| **Dashboard** | [src/pages/Dashboard.jsx](src/pages/Dashboard.jsx) | La vista principal. Matriz Yango vs competidores por bracket de distancia. Soporta vista semanal / diaria / histórica. |
| **Análisis · Ganancias** | [src/pages/DriverEarnings.jsx](src/pages/DriverEarnings.jsx) | Simulador de earnings del conductor según escenarios de comisión y bonos. |
| **Análisis · Reporte** | [src/pages/WeeklyReport.jsx](src/pages/WeeklyReport.jsx) | Genera PDF semanal de pricing CI por ciudad/categoría. |
| **Gestión · Ingresar CI** | [src/pages/DataEntry.jsx](src/pages/DataEntry.jsx) | Captura manual de observaciones (cuando el equipo de campo levanta data). |
| **Gestión · Cargar Data** | [src/pages/Upload.jsx](src/pages/Upload.jsx) | 4 sub-tabs: Excel/CSV manual, Bot Data (CSV del bot), Bot→Excel, Bot DB Sync (live). |
| **Gestión · Data Raw** | [src/pages/RawData.jsx](src/pages/RawData.jsx) | Browser de filas crudas en `pricing_observations`. Filtros para encontrar y borrar outliers. |
| **Gestión · Bot vs Hubs** | [src/pages/BotVsHubs.jsx](src/pages/BotVsHubs.jsx) | Compara la data del bot contra la captura manual de los hubs (calidad). |
| **Config · Eventos** | [src/pages/MarketEvents.jsx](src/pages/MarketEvents.jsx) | Marca eventos de mercado (huelgas, copas, etc.) que aparecen como anotaciones en charts diarios. |
| **Config · Distancias Ref.** | [src/pages/DistanceRefs.jsx](src/pages/DistanceRefs.jsx) | Edita los umbrales de km que definen brackets por ciudad+categoría. |
| **Config · Configuración** | [src/pages/Config.jsx](src/pages/Config.jsx) | Pesos de bracket, semáforo, comisiones, países, reglas de validación de precio, rush hour. |
| **Config · Accesos** | [src/pages/AccessManagement.jsx](src/pages/AccessManagement.jsx) | RBAC — qué emails pueden ver qué tabs y qué países. |

---

## De dónde viene la data

Tres fuentes, todas terminan en la tabla `pricing_observations`:

1. **Bot scraper** (fudobi.helioho.st) — corre 24/7 levantando precios desde
   las apps de los competidores. La sincronización incremental al dashboard
   es vía GitHub Actions cada 30 min:
   - Workflow: `.github/workflows/bot-sync.yml`
   - Script: [scripts/bot-sync/bot_sync_push.py](scripts/bot-sync/bot_sync_push.py)
   - Mapeo de filas: [src/lib/botMapping.js](src/lib/botMapping.js)
     (recordá que esto se evalúa contra `botRules` en [constants.js](src/lib/constants.js))
   - Watermark / log: tablas `bot_sync_watermark`, `bot_sync_log`.
   - El badge en el header (semáforo verde/amarillo/rojo) indica frescura
     de la última corrida exitosa.
2. **Excel / CSV manual** — el equipo de campo sube Excels desde
   `Gestión > Cargar Data > Manual`. Se aplica el mismo saneamiento que el
   bot (`src/algorithms/ingestionFilters.js`).
3. **Captura manual** desde `Gestión > Ingresar CI` — para casos puntuales.

> Importante: las inserciones desde Excel **borran y reemplazan** filas del
> mismo (ciudad + rango fecha + data_source='manual'). No genera duplicados
> aunque subas el mismo Excel dos veces.

---

## Migraciones de base de datos

Vivas en `supabase/`, numeradas. Aplicarlas en orden contra Supabase
(la SQL editor sirve, o `supabase db push` si tenés CLI). Las que importan
para entender el modelo:

- `01_schema.sql` — tabla principal `pricing_observations`.
- `02_views.sql` — vistas de agregación (`v_bracket_weekly_avg`, daily).
- `27_country_isolation_schema.sql` — multi-país.
- `35_bot_sync_watermark.sql` — log/watermark del bot.
- `36_bot_fdw_pipeline.sql` + `38_sync_bot_quotes_fn.sql` — pipeline del bot.
- `42_time_of_day_filter.sql` — franjas horarias.
- `43_wa_snapshot.sql` — congelar promedios cuando cambia config.

---

## Cómo agregar un país

El flujo es enteramente self-service desde la UI (sin tocar código ni redeploy):

1. **Andá a `Config → Países`** y clickeá **"Nuevo país"** para abrir el wizard
   ([src/components/config/CountryWizard.jsx](src/components/config/CountryWizard.jsx)).
2. **Completá el wizard** con:
   - `uiName` / `dbName` (cómo se llama en la UI y en `pricing_observations.country`).
   - Ciudades + `botKey` por ciudad (la clave que usa el scraper para identificar la ciudad).
   - Categorías por ciudad (`Economy`, `Comfort`, `ComfortPlus`, etc.).
   - Competidores por ciudad+categoría (Uber, Didi, InDrive, Cabify, …).
3. **El wizard siembra automáticamente** las siguientes tablas en Supabase:
   `country_config`, `bracket_weights`, `semaforo_config`, `bot_rules`,
   `rush_hour_windows`, `distance_thresholds`, `indrive_config`, `ci_timeslots`.
4. **Activá el país**: marcá `status = 'active'` en `Config → Países` para que
   aparezca en el selector global del topbar y en el workflow de
   GitHub Actions del bot.
5. **(Opcional)** Configurá permisos en `Config → Accesos` si querés restringir
   qué usuarios pueden ver el país nuevo.

---

## Tips de debugging

| Síntoma | Por dónde empezar |
|---|---|
| "Sin observaciones para esta celda" en el modal | El query a `pricing_observations` falló — abrí Network tab y mirá el error. Probable: columna inexistente o filtro de categoría incorrecto. |
| Bot dejó de meter data | Header del dashboard muestra el badge en rojo (>90 min). Andá a `Gestión > Cargar Data > Bot DB Sync` para ver el log y disparar manualmente. |
| Precios raros se cuelan | Reglas en Config > Límites Precio (`price_validation_rules`). Outlier count en KPI bar te dice cuántos descartó el bot en los últimos 7 días. |
| Vista rompió | El error está contenido por `<ErrorBoundary>`. Abrí consola para el stack. |
| WoW callout no aparece | Solo se muestra cuando hay >1 período visible y al menos un competidor con cambio ≥5%. |

---

## Cosas que no son obvias del código

- El **WA (Promedio Ponderado)** se calcula en `src/algorithms/weightedAverage.js`
  con los pesos de `bracket_weights`. Los pesos pueden ser globales (`city='all'`)
  o ciudad-específicos.
- Cuando cambiás pesos o thresholds, el dashboard puede congelar promedios
  históricos en `pricing_wa_frozen` para que las vistas históricas no muten.
  Ver `supabase/43_wa_snapshot.sql` y los íconos 🔒 en headers de columnas.
- **InDrive** no tiene precio fijo — se calcula como promedio de los `bid_*`
  o se usa `recommended_price`/`minimal_bid`. Ver
  [src/algorithms/indrive.js](src/algorithms/indrive.js).
- El badge `Bot 12 min` en el header se actualiza cada 30s (clock tick) y
  re-consulta cada 5 min. Verde ≤30min, amarillo ≤90min, rojo >90min.
- El sort de columnas en la matriz de precios es **3-estado**: asc → desc →
  reset al orden default. Click en otra columna también resetea.

---

## Archivos importantes para tocar

- Filtros del dashboard: [src/hooks/useFilters.js](src/hooks/useFilters.js) +
  [src/context/FilterContext.jsx](src/context/FilterContext.jsx).
- Carga de datos del dashboard: [src/hooks/usePricingData.js](src/hooks/usePricingData.js).
- Render principal de tablas: [src/components/dashboard/BracketSection.jsx](src/components/dashboard/BracketSection.jsx).
- Auth/RBAC: [src/lib/auth.js](src/lib/auth.js) + [src/hooks/useAccessControl.js](src/hooks/useAccessControl.js).
- i18n (es/en/ru): [src/lib/i18n.js](src/lib/i18n.js) — todos los strings van acá.

---

## Self-service config — estado actual

El wizard de onboarding (`Config → Países → Nuevo país`) ya cubre el flujo
completo descrito en la sección "Cómo agregar un país" más arriba. Las
siguientes tablas se siembran automáticamente al completar el wizard:

| Tabla                  | UI dedicada                       |
|------------------------|-----------------------------------|
| `country_config`       | Config > Países                   |
| `bracket_weights`      | Config > Pesos                    |
| `distance_thresholds`  | Config > Distancias               |
| `price_validation_rules` | Config > Límites Precio         |
| `semaforo_config`      | Config > Semáforo                 |
| `bot_rules`            | (siembra automática del wizard)   |
| `rush_hour_windows`    | (siembra automática del wizard)   |
| `indrive_config`       | (siembra automática del wizard)   |
| `ci_timeslots`         | (siembra automática del wizard)   |

Peru y Colombia están sembrados en `country_config` desde la mig 67. El
selector de país en el topbar y la matriz dinámica del workflow
`bot-sync.yml` se construyen 100% desde `country_config` con `status='active'`.

### Pendiente menor

- `constants.js` aún tiene `COUNTRY_CONFIG.Nepal/Bolivia/Venezuela/Zambia`
  hardcoded para mantener compatibilidad. Cuando alguno se onboardee de
  verdad, el wizard los promueve a DB y se puede limpiar.
- `botMapping.js` y `Upload.detectCity()` consumen `country_config.cities`
  con fallback a Peru/Colombia hardcoded — mismo patrón que el SQL
  `sync_bot_quotes` (mig 64).

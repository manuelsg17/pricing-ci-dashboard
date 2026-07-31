# ROADMAP — Pricing CI Dashboard

Documento de handoff entre sesiones. Última actualización: **2026-07-31**.

> Regla de mantenimiento: este archivo se queda obsoleto rápido si no se toca.
> La versión anterior quedó **296 commits y ~2 meses atrás** sin actualizarse.
> Antes de cerrar una sesión grande de trabajo, actualizar la sección
> "Estado actual" y mover ítems de Pendientes a Completado — no dejarlo para
> "la próxima vez".

---

## Estado actual

**Última migración aplicada**: `176_optimize_rls_pricing_observations_write.sql`.
177 migraciones totales en `supabase/`. `pricing_observations` está particionada
por mes (migs 168-169) y sus políticas RLS fueron rediseñadas para performance
(migs 175-176: SELECT 16.5s → 39-60ms).

**Working directory canónico**: `~/Projects/pricing-ci-dashboard` (esta carpeta).
La copia previa en ProtonDrive quedó obsoleta — ProtonDrive no preserva exec
bits y rompe `npm install`. Si trabajás desde otra laptop, `git clone` fresco
ahí, nunca dentro de una carpeta sincronizada por Drive/Proton/Dropbox.

**Deploy**: GitHub Pages + Vercel en paralelo (Vercel agregado 2026-07-26,
con Speed Insights activo).

**Reglas de implementación obligatorias**: ver `CLAUDE.md` (creado 2026-07-25).
Es de cumplimiento estricto, no opcional — cada regla ahí nació de un bug real
ya ocurrido. Este ROADMAP es sobre *qué* falta; `CLAUDE.md` es sobre *cómo* se
implementa sin romper nada.

---

## Lo que pasó entre el ROADMAP viejo (2026-05-31) y hoy (resumen por área)

El ROADMAP anterior terminaba en "Sprint 3". Lo que seguía no se documentó en
su momento — reconstruido acá desde el git log para que no se vuelva a perder.

### Sistema de sesiones de CI ("Ingresar CI") — la feature más grande del período

Pasó de una grilla simple a un sistema completo de sesiones de trabajo para
los hubs, con mucho endurecimiento contra bugs reales de pérdida de datos:

- Sesiones con checkpoint ("Guardar Progreso" sin bloquear parciales), borradores
  con tope de 2, marcado explícito de "sin data" (S/D) por celda/fila.
- Multi-frente: Aeropuerto (Punto A/B/Ambos) y TukTuk por distrito en paralelo
  dentro de la misma sesión, navegación libre entre frentes.
- Relevo entre hubs (reasignar sesión guardada), presencia ("quién más está
  trabajando esto ahora"), rastro de ediciones en Historial.
- Monitoreo admin: sesiones en vivo, salud de datos, detección de latidos que
  fallan en silencio, cierre administrativo de sesiones colgadas, matriz
  semanal de cobertura por bracket, medición de tiempo por turno.
- Tres bugs de datos reales corregidos y ahora documentados como reglas en
  `CLAUDE.md` §2: auto-load resucitando puntos recién terminados, cronómetro
  reseteado incorrectamente al reanudar, guard anti-resurrección que no
  sobrevivía un F5 real.
- Migraciones: 140 a 161 (18 migraciones solo para este sistema).

### Seguridad — rondas reales de cierre de fugas RLS

No teóricas, explotables: RPCs sin autenticación, fuga cross-país en 3+ tablas,
fuga de edición cross-hub en RawData, bug de bracket cross-país, bonos/tiers/bot
log/watermark/`user_profiles` expuestos. Migraciones 158, 164-167, 170-171.
Esto es exactamente el patrón que `CLAUDE.md` §3 documenta como recurrente
("políticas permisivas con OR ganan en silencio") — ya pasó 3+ rondas.

- `xlsx` parcheado vía CDN oficial de SheetJS (prototype pollution + ReDoS HIGH).
- Tope duro de 100.000 filas en export de RawData.
- CVEs de prod cerrados (`vite`, `react-router-dom`, dependencias menores).

### Performance de base de datos

- Particionado de `pricing_observations` por mes (migs 168-169), tabla vieja
  borrada después de validar (mig 174).
- Rediseño de políticas RLS para performance real, no solo seguridad — SELECT
  de 16.5s a 39-60ms, mismo tratamiento aplicado a INSERT/UPDATE/DELETE
  (migs 175-176).
- Recalibración de jobs `pg_cron` — ~78% menos Disk IO (mig 162).
- Agregados del Dashboard con refresco incremental (mig 163).

### Arquitectura frontend

- **Router real**: `react-router-dom` reemplaza el `activeTab` manual que
  existía antes.
- **React Query** introducido, eliminó 3 casos reales de queries duplicadas.
- Recharts y jsPDF aislados del bundle de arranque (code-splitting real).

### UI — "Fase 2" (rollout de design system, ~20 commits en lotes)

Reemplazo sistemático en todo el codebase: botones nativos → `<Button>`
compartido, emojis → íconos `lucide-react`, colores hex sueltos → tokens.
Cubrió Dashboard, Config, RawData, Upload, layout, primitivas compartidas
(ErrorBoundary/ConfirmDialog/Toast) — prácticamente todas las páginas.

### Fixes recientes (últimos 3-5 días al momento de este update)

Tooltip instantáneo en Dashboard (no nativo), vista Diaria ya no salta días
sin datos, error boundary por sub-tab en Config, PAGE_SIZE de RawData
100→50 como medida barata mientras se confirma el LCP.

---

## Sprints previos (Sprint 1-3, ya en ROADMAP viejo — sin cambios, referencia)

<details>
<summary>Detalle Sprint 1-3 (click para expandir — ya completados, sin acción pendiente)</summary>

### Sprint 1 — Quick Wins (10 items, 2 commits)

- Componentes muertos eliminados, live-sync con dirty-row preservation,
  iconos de semáforo con contraste WCAG AA, FilterProvider en App.jsx,
  `src/lib/timing.js`, ESLint+Prettier+husky, CACHE_KEY con canary check.

### Sprint 2 — Tailwind + shadcn/ui + Reorg (6 sub-fases)

- Tailwind 3.4 sin preflight (no rompe legacy). shadcn/ui en
  `src/components/ui/shadcn/`: button, card, badge, input, select, tabs,
  sheet, popover, command, combobox.
- `/config` reorganizado en 5 categorías. `ConfigProvider` centraliza
  configs read-only. Head-to-Head 1:1 view. Charts analíticos (Leadership +
  Position Timeline).

### Sprint 3 — Hardening + Polish + Security (5 commits)

- Mig 105 — Materialized Views (infra), luego cutover confirmado
  (`get_dashboard_data_weekly_fast`/`_daily_fast`, refresh vía pg_cron
  horario, no desde el cliente). a11y pass. Defensa CSV formula injection.

</details>

---

## Decisiones tomadas (NO revisitar sin razón)

1. **Tailwind + shadcn/ui SÍ**. Look "Linear/Vercel" — componentes en
   `src/components/ui/shadcn/`. La Fase 2 (arriba) extendió esto a casi
   toda la UI con `<Button>` compartido.
2. **NO responsive design**. Hubs trabajan desde PC de escritorio.
3. **NO dark mode**.
4. **NO tests E2E de navegador todavía**. Esperar a tener 2+ devs. Sí hay
   24 scripts `test:*` de lógica pura (parseo/normalización/cálculo) — correr
   `npm run test:all` antes de cerrar cambios que toquen esa capa.
5. **NO migrar a TypeScript**. JSDoc en `lib/`/`algorithms/` alcanza.
6. **NO refactor de URL hash vs FilterContext**. Funciona, hash share-link es
   feature útil.
7. **Index InDrive marginal — deferred**. Sin urgencia real.

---

## Pendientes (orden recomendado)

### Alto leverage

1. **Refactor `Upload.jsx`** (1113 LOC) y **`DataEntry.jsx`** (**3516 LOC** —
   creció ~2.6x desde el ROADMAP viejo por todo el sistema de sesiones CI).
   Sigue siendo el god-component documentado en `CLAUDE.md` §1 — deuda P2 sin
   fecha, no es excusa para seguir apilando lógica sin criterio, pero tampoco
   se justifica una refactorización grande a mitad de un fix puntual. Si se
   hace, sesión dedicada, alto riesgo si sale mal (es el flujo más crítico
   para los hubs).
2. **Reemplazar `xlsx` (CDN parcheado) por `exceljs`**. El parche vía SheetJS
   CDN cerró el CVE inmediato pero sigue siendo una dependencia no mantenida
   oficialmente vía npm. Depende de #1 — Upload/DataEntry son los principales
   consumidores.
3. **MultiCityCompare chart** (pendiente desde Sprint 2.6). Requiere nuevo
   RPC `get_dashboard_summary_by_city` que agregue todas las ciudades del
   país sin cambiar el filtro `dbCity` del Dashboard.

### Mediano leverage

4. **i18n completo en componentes de config + mensajes de error**. Repasar
   con el criterio de `CLAUDE.md` §6 — cualquier string nuevo debe ir a los
   3 locales en el mismo commit; auditar los que quedaron hardcodeados de
   antes.
5. **Confirmar LCP de RawData** tras el cambio de PAGE_SIZE 100→50
   (commit `16b39cf`) — es una medida barata provisional, falta verificar
   con datos reales si resolvió el problema o si hace falta algo más
   estructural (paginación server-side distinta, virtualización).
6. **Polish visual KPI bar + FilterBar** con Tailwind utilities — quedaron
   con bastantes inline styles fuera del alcance de la Fase 2 de UI.

### Bajo leverage (defer salvo motivación específica)

7. **A11y completo** fuera de `/config` — outline:none cleanup, más
   aria-labels en botones-icono.
8. **Self-host Google Fonts + flagcdn** para eliminar dependencias externas
   y mejorar CSP.
9. **Dark mode** si en algún momento se quiere el look "Linear total".

---

## Estructura relevante (no exhaustiva — ver árbol real con `tree`/`find`)

```
src/
├── components/
│   ├── ui/shadcn/         # shadcn/ui primitives + <Button> compartido (Fase 2)
│   ├── dashboard/         # BracketSection (legacy, 862 LOC), H2H, Analytics
│   └── config/            # Tablas con live-sync (patrón: AirportMarkersTable.jsx)
├── context/
│   ├── ConfigProvider.jsx    # configs read-only compartidas
│   ├── CountryContext.jsx
│   └── FilterContext.jsx     # vive en App.jsx
├── lib/
│   ├── utils.js, timing.js, csvSafety.js, format.js
├── pages/
│   ├── DataEntry.jsx      # 3516 LOC — god-component, ver Pendientes #1
│   ├── Upload.jsx         # 1113 LOC — idem
│   ├── Dashboard.jsx, Config.jsx, Market.jsx, Coverage.jsx, ...
├── App.jsx, main.jsx      # react-router-dom real, providers incl. ConfigProvider

supabase/
└── 001..176_*.sql         # próxima migración libre: 177

scripts/
├── test-*.mjs             # 24 scripts, correr vía `npm run test:*` o test:all
├── check-rls-policy-drift.sql
└── check-normalization-drift.sql

.eslintrc.json, .prettierrc.json, .husky/pre-commit (lint-staged activo)
CLAUDE.md                  # reglas obligatorias — leer antes de codear
```

---

## Convenciones del repo (sin cambios respecto a antes)

### Para nuevos componentes

- Usar shadcn primitives (`src/components/ui/shadcn/*`) y `<Button>`
  compartido — no reinventar.
- Tailwind utility classes preferido sobre CSS inline.
- Read-only configs: `useConfigContext()`. CRUD de configs: `useConfig()` o
  fetcher interno con dirty-row preservation (`AirportMarkersTable.jsx` como
  canónico).

### Para nuevas migraciones DB

- Numerar correlativamente — próxima es `177_...`.
- Header en comentario con CONTEXTO + APPROACH + VERIFICACIÓN.
- RPCs nuevas con `require_country_access` al inicio si aplica.
- `SET search_path = public, pg_temp` para toda función `SECURITY DEFINER`.
- Antes de cerrar: `check:rls-drift` si tocó políticas (ver `CLAUDE.md` §3/§7).

### Para commits

- `tipo(scope): título corto` + body con CONTEXTO + QUÉ HACE + POR QUÉ.
- Co-authored-by Claude.
- Pre-commit hook corre `eslint --fix --max-warnings 0` + `prettier --write`.
  Si bloquea, fixear el warning — nunca `--no-verify`.
- Push después de cada sub-fase validada, no acumular cambios grandes.

---

## Cómo retomar en una sesión nueva

Abrí Claude Code en `~/Projects/pricing-ci-dashboard` (clonar fresco si es
una laptop nueva — nunca dentro de una carpeta sincronizada por
Drive/Proton/Dropbox). Para arrancar con contexto:

```
Estoy retomando el proyecto. Leé ROADMAP.md para el estado real y CLAUDE.md
para las reglas obligatorias antes de codear cualquier cosa.

Quiero trabajar en [X — describí]. Antes de codear, revisá si entra en algún
pendiente ya identificado en el ROADMAP y respetá las decisiones tomadas
(NO responsive, NO dark mode, etc.) y las reglas de CLAUDE.md (particularmente
si toca RLS, sesiones de CI, o namespaces de bucket en DataEntry).
```

Si es un tema completamente nuevo, igual vale la pena que lea ambos archivos
como referencia — evita reintroducir bugs ya resueltos y documentados.

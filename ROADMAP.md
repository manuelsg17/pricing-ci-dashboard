# ROADMAP — Pricing CI Dashboard

Documento de handoff entre sesiones. Última actualización: **2026-05-31**.

Estado de la app y dirección estratégica decididas en la sesión de auditoría
multi-dimensión (15 agentes paralelos) + 3 sprints de quick wins, refactor
y polish.

---

## Estado actual

**Última build estable**: cutover Mig 105 mergeado a `main` (2026-06-01) —
el dashboard lee los RPC `_fast` (Materialized Views) y un pg_cron refresca
las MVs cada hora (mig 106). Sprint 1+2+3 previos desplegados a GitHub Pages.

**Working directory canónico**: `~/Projects/pricing-ci-dashboard`.
La copia en ProtonDrive (`/Users/.../Library/CloudStorage/.../pricing-ci-dashboard`)
quedó obsoleta — fue útil hasta esta sesión pero no debe usarse más para dev
(ProtonDrive no preserva exec bits → `npm install` falla).

---

## Sprints completados

### Sprint 1 — Quick Wins (10 items, 2 commits)

- `1bac851` feat(sprint-1): quick wins UX/perf — live-sync, a11y, dead code, lint setup
- `8079dbd` fix(sprint-1-hotfix): i18n key card + React key spread warning

**Highlights**:

- 4 componentes muertos eliminados (SampleMatrix/PriceMatrix/DeltaMatrix/BracketChart) — 349 LOC.
- Live-sync con dirty-row preservation en ThresholdsTable/PriceRulesTable/RushHourConfig/InDriveConfig.
- Iconos ✓⚠✗ en MatrixCell + contraste WCAG AA en tokens semáforo.
- Card "Yango vs Promedio Competencia" en KPI bar.
- FilterProvider movido a App.jsx (filtros persisten entre tabs).
- Tooltips de charts con contexto (vs Yango, moneda, período).
- `src/lib/timing.js` para constantes de timeouts.
- Default `'Peru'` silencioso removido de `usePriceRules`/`useRushHourConfig`.
- ESLint + Prettier + husky pre-commit hook (`prepare: husky`).
- CACHE_KEY auto-invalida con canary check (`REQUIRED_KEYS`).

### Sprint 2 — Tailwind + shadcn/ui + Reorg (6 sub-fases)

- `b887550` feat(sprint-2.1): setup Tailwind 3.4 sin preflight
- `54e2b9b` feat(sprint-2.2): shadcn/ui foundation — 7 primitives
- `e6821c2` feat(sprint-2.3): reorganizar /config — 5 categorías top-level
- `250bb21` feat(sprint-2.4): ConfigProvider centraliza configs read-only
- `65cb5b5` feat(sprint-2.5): Head-to-Head 1:1 view
- `21d60ba` feat(sprint-2.6): charts analíticos — Leadership + Position Timeline

**Decisión clave**: Tailwind 3.4 con `corePlugins.preflight: false` para NO
romper componentes legacy. shadcn/ui copy-pasted al proyecto en
`src/components/ui/shadcn/`.

**shadcn primitives disponibles** (extender según necesidad):

- `button.jsx`, `card.jsx`, `badge.jsx`, `input.jsx`, `select.jsx`
- `tabs.jsx`, `sheet.jsx`, `popover.jsx`, `command.jsx`, `combobox.jsx`

**Tokens Tailwind** mapeados a CSS variables: `bg-yango`, `text-sem-green-fg`,
`bg-muted`, `bg-primary/secondary/accent/destructive`. Ver `tailwind.config.js`.

### Sprint 3 — Hardening + Polish + Security (5 commits)

- `8036510` feat(sprint-3.1): mig 105 — Materialized Views (infra-ready, sin cutover)
- `b1ff43a` fix(sprint-3.3): a11y pass — contraste, semantic HTML, labels, scope
- `c8d6d77` fix(sprint-3.5): CSV formula injection defense

---

## Decisiones tomadas (NO revisitar sin razón)

1. **Tailwind + shadcn/ui SÍ** (vs solo CSS tokens). El usuario quiso el look
   "Linear/Vercel" — vale la inversión de tiempo. shadcn components viven
   en `src/components/ui/shadcn/`.
2. **NO responsive design**. El usuario no usa dashboard en móvil/tablet.
   Mobile-first es deuda técnica acumulada pero NO bloquea. Audit score F.
3. **NO dark mode**. Lindo pero analistas trabajan de día.
4. **NO tests E2E todavía**. Esperar a tener 2+ devs.
5. **NO migrar a TypeScript**. 1-3 usuarios; JSDoc en `lib/` y `algorithms/`
   alcanza para tipos.
6. **NO refactor de URL hash vs FilterContext**. Funciona, hash share-link
   es feature útil. Defer hasta que cause un bug real.
7. **Index InDrive + DEFAULT Peru deferred**. El bug del DEFAULT
   'Peru' YA fue resuelto en mig 101 (verificado). El cambio de index es
   marginal vs `idx_po_indrive_manual` existente. NOTA: `106` lo tomó el cron
   refresh (cutover Mig 105) y `107` el fix de `get_available_zones`. Si este
   index se hace, sería la próxima libre (`108`).

---

## Pendientes (orden recomendado)

### Alto leverage (deberías priorizar)

1. ✅ **Cutover Mig 105 — HECHO (2026-06-01)**. `usePricingData.js` llama
   `get_dashboard_data_weekly_fast` / `_daily_fast`. Parity garantizada por
   construcción (defs de view regular ≡ defs de MV, carácter por carácter) +
   EXPLAIN ANALYZE confirma read por request ~0.5-3s → ~50-100ms. Refresh
   automático vía **pg_cron horario @ :10** (mig 106 `8faa992`), NO desde el
   cliente: el rol `authenticated` tiene `statement_timeout` 8s ≪ refresh
   completo ~70-120s. Cargas manuales se reflejan en ≤1h (próximo tick).
2. **Refactor `Upload.jsx`** (921 LOC → 4 sub-componentes <250 LOC). Audit
   strategic #6. Necesita sesión dedicada — alto riesgo si hace mal.
3. **Refactor `DataEntry.jsx`** (961 LOC → useReducer + hook + lib). Audit
   strategic #7. Mismo problema que Upload.

### Mediano leverage (cuando haya tiempo)

4. **Reemplazar xlsx@0.18.5 por exceljs** (CVE-2023-30533 + xlsx no
   maintained). Depende de #2 y #3 — son los principales consumidores.
5. **Polish visual KPI bar + FilterBar** con Tailwind utilities + shadcn
   Button/Input. Audit strategic #8. Refactor de bastantes inline styles.
6. **MultiCityCompare chart**. Sprint 2.6 lo dejó pendiente — requiere
   nuevo RPC `get_dashboard_summary_by_city` que agregue todas las
   ciudades del país sin cambiar el `dbCity` filter del Dashboard.
7. **i18n completo en componentes config + error messages**. Hoy 57
   archivos JSX con strings hardcoded en ES. Migrar a `t()`.

### Bajo leverage (defer salvo motivación específica)

8. **A11y completo** — outline:none cleanup, más aria-labels en botones-
   icono fuera de `/config`.
9. **Index InDrive optimizado** (marginal) — sería la próxima migración libre
   (108). Los números 106 y 107 ya se usaron: 106 = cron refresh (mig 105),
   107 = fix de `get_available_zones` (lee de la MV, fix timeout 8s).
10. **Self-host Google Fonts + flagcdn** para eliminar dependencias externas
    y mejorar CSP. Audit L3.
11. **Dark mode** si querés el look "Linear total".

---

## Estructura post-sprints

```
src/
├── components/
│   ├── ui/shadcn/         # shadcn/ui primitives (Sprint 2.2)
│   │   ├── button.jsx
│   │   ├── card.jsx
│   │   ├── badge.jsx
│   │   ├── input.jsx
│   │   ├── select.jsx
│   │   ├── tabs.jsx       ← usado en /config
│   │   ├── sheet.jsx      ← usado en H2H + Analytics
│   │   ├── popover.jsx
│   │   ├── command.jsx
│   │   └── combobox.jsx   ← usado en H2H
│   ├── dashboard/
│   │   ├── BracketSection.jsx       (legacy — 862 LOC, refactor a futuro)
│   │   ├── HeadToHeadView.jsx       (Sprint 2.5) ← shadcn
│   │   ├── LeadershipChart.jsx      (Sprint 2.6)
│   │   ├── PositionTimeline.jsx     (Sprint 2.6)
│   │   ├── AdvancedAnalyticsView.jsx (Sprint 2.6) ← shadcn Tabs
│   │   └── ... (resto legacy)
│   └── config/
│       ├── ThresholdsTable.jsx      (live-sync via useConfig hook)
│       ├── PriceRulesTable.jsx      (live-sync interno)
│       ├── RushHourConfig.jsx       (live-sync interno)
│       ├── InDriveConfig.jsx        (live-sync interno)
│       ├── AirportMarkersTable.jsx  (patrón canonico de live-sync)
│       └── ... (resto)
├── context/
│   ├── ConfigProvider.jsx           (Sprint 2.4) — read-only configs
│   ├── CountryContext.jsx           (CACHE_KEY canary check)
│   ├── FilterContext.jsx            (vive en App.jsx ahora)
│   └── ... (resto)
├── lib/
│   ├── utils.js                     (Sprint 2.2) — cn() helper
│   ├── timing.js                    (Sprint 1.7) — TOAST_DURATION_MS, etc.
│   ├── csvSafety.js                 (Sprint 3.5) — sanitizeForSpreadsheet
│   ├── format.js                    (sin formatPercent — dead code purgado)
│   └── ... (resto)
├── pages/
│   ├── Config.jsx                   (Sprint 2.3) — 5 categorías shadcn Tabs
│   ├── Dashboard.jsx                (incluye H2H + Analytics buttons)
│   ├── Market.jsx                   (usa ConfigProvider)
│   ├── Coverage.jsx                 (usa ConfigProvider)
│   └── ... (resto)
├── styles/
│   ├── tailwind.css                 (Sprint 2.1) — @tailwind directives
│   ├── global.css                   (tokens — color-muted oscurecido en 3.3)
│   └── ... (resto legacy)
├── App.jsx                          (sin dbWeights/dbSemaforo props)
└── main.jsx                         (provider order incluye ConfigProvider)

supabase/
├── 105_dashboard_materialized_views.sql  ← infra ready, NO cutover yet
└── ... (104 anteriores)

.eslintrc.json
.prettierrc.json
.husky/pre-commit                    ← lint-staged hook (activo)
tailwind.config.js
postcss.config.js
package.json                         ← scripts: lint, format, prepare
```

---

## Convenciones del repo (importante para futuras sesiones)

### Para nuevos componentes

- **Usar shadcn primitives** (`src/components/ui/shadcn/*`) en lugar de
  reinventar Button/Card/Tabs/Sheet.
- **Tailwind utility classes** preferido sobre CSS inline.
- **Para read-only configs en una page**: `useConfigContext()` de
  `src/context/ConfigProvider.jsx`. NO crear un nuevo fetcher.
- **Para edit/CRUD de configs**: el patrón es `useConfig()` hook de
  `src/hooks/useConfig.js` o un fetcher interno con dirty-row preservation
  (ver `AirportMarkersTable.jsx` como canónico).

### Para nuevas migraciones DB

- Numerar correlativamente: próxima sería `106_...`.
- Header en comentario con CONTEXTO + APPROACH + VERIFICACIÓN.
- Si toca RPCs con `require_country_access`, agregarlo al inicio del body.
- `SET search_path = public, pg_temp` para SECURITY DEFINER (mig 100 pattern).

### Para commits

- Mensaje: `tipo(scope): título corto` + body con CONTEXTO + QUÉ HACE.
- Co-authored-by Claude.
- Pre-commit hook corre `eslint --fix --max-warnings 0` + `prettier --write`.
- Si el hook bloquea, NO usar `--no-verify` — fixear el warning y retry.

---

## Cómo retomar en una sesión nueva

Abrí Claude Code en `~/Projects/pricing-ci-dashboard`. Para arrancar con
contexto, pegá este prompt:

```
Estoy retomando el proyecto. Leé ROADMAP.md para entender estado y
decisiones. Mis memories de Claude Code están en
~/.claude/projects/-Users-masantillanag-Projects-pricing-ci-dashboard/memory/
— léelas también.

Quiero trabajar en [X — describí]. Antes de codear, andá al ROADMAP y
checkeá si lo que voy a hacer entra en algún sub-pendiente identificado
y respetá las decisiones tomadas (NO responsive, NO dark mode, etc.).
```

Si tu nueva sesión es para un tema completamente nuevo (no continuación
de los sprints), simplemente decile a Claude qué querés y va a poder leer
ROADMAP como referencia cuando lo necesite.

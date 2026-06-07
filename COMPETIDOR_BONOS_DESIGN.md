# Diseño — Modelo realista de bonos de competidor (Rentabilidad)

> Estado: **propuesta** (no implementado). Decisión del usuario (2026-06-07):
> dejar como propuesta por ahora; cuando se construya, InDrive 1% se cuantifica
> con un **parámetro "% de viajes en ventana" tuneable**.
> Contexto: complementa el feature Rentabilidad ya en `main` y la columna
> `competitor_bonuses.category` (mig 109). Origen: capturas reales de incentivos
> Uber/Cabify/InDrive/Didi en Lima/Trujillo/Arequipa + el summary por-día del equipo.

---

## 1. Principio central (MSE)

Todo incentivo, por distinto que se vea, es **una de 3 palancas** sobre la
economía del driver:

1. **Baja la comisión efectiva** — InDrive 1% por ventana/zona; monedas para pagar comisión.
2. **Suma cash condicionado a volumen** — quests Uber/Cabify/Didi, flash, reconexión.
3. **Pone un piso garantizado** — Didi "garantizado".

La pregunta "¿el driver gana más con ellos o con nosotros?" se responde con el
**take-home semanal evaluado al volumen y perfil real del driver**, NO con el
número del cartel. Movida clave: normalizar todo a _"S/ incremental esta semana
para ESTE driver"_ y recién ahí comparar.

## 2. Tres trampas a evitar

- **#1 Escalera ≠ suma (bug del modelo actual):** los quests son escalonados →
  te pagan el **peldaño alcanzado**, no la suma. Uber "8→S/20, 20→S/60 … 220→S/1000"
  = S/1000 _total_ si llegás a 220. Hoy, cargar los peldaños como N bonos "viajes"
  los **SUMA** → sobreestima enorme. Modelar "escalonado = máximo peldaño".
- **#2 Recurrente vs one-off:** activación/reactivación (Cabify reconexión S/150,
  Uber welcome S/1000) son **una sola vez**. Los recurrentes (activo) definen el
  largo plazo. Separarlos.
- **#3 Mismo segmento:** comparar activo vs activo. Un welcome no le aplica a un activo.

## 3. Taxonomía → cómo se cuantifica cada mecanismo

| Mecanismo                              | Ejemplo real                            | Cuantificación                                                       |
| -------------------------------------- | --------------------------------------- | -------------------------------------------------------------------- |
| **tiered** (escalera)                  | Uber 8→20…220→1000; Cabify 25→55,50→310 | reward del **peldaño más alto** alcanzado a los viajes/sem           |
| **flat** (plano por viajes)            | Cabify 28→46; reconexión 50→150         | +monto si viajes ≥ umbral (one-off si reactivación)                  |
| **guarantee** (piso)                   | Didi 15 viajes → S/120                  | `max(0, garantía − fares_de_esos_viajes)`                            |
| **comm_discount** (descuento comisión) | InDrive 1% en pico                      | `(comm_normal − 1%) × fare × (% viajes en ventana)` ← **% tuneable** |
| **comm_credit** (monedas)              | InDrive coins                           | = cash equivalente (baja costo de comisión)                          |
| **streak** (racha)                     | Didi peaks (Día1 16…+24)                | S//sem = Σ ventanas × días logrados (parámetro)                      |

**InDrive 1% (decisión cerrada):** descuento de comisión por ventana, NO bono cash.
Con datos del usuario (~10.3% comisión InDrive, ventanas 7-8am y 6-7pm ≈ 2h + zonas
centro/mall), si ~25% de viajes caen ahí → extra ≈ `(10.3−1)% × fare × 0.25 ≈ 2.3%`
del fare. El **% en ventana es un slider tuneable** con sensibilidad mostrada.

## 4. Cambios al modelo de datos (`competitor_bonuses`)

Hoy: `(bonus_type ∈ viajes/horas/zona, threshold, amount, category, city, country)`.
Extender con:

- `mechanism`: tiered · flat · guarantee · comm_discount · comm_credit · streak
- `tiers` jsonb: `[{threshold, reward}]` (escalera)
- `segment`: active · new · reactivated · all
- `recurring`: bool (recurrente vs gancho one-off)
- `day_window` (L–D) + `time_window` (horas) + `zone` (opcional)
- params: `comm_pct` (descuento), `share_in_window` (default tuneable)

## 5. El parámetro que hace justa la comparación: "arquetipo de driver"

Sliders arriba de la vista: **viajes/sem, horas/sem, % viajes en pico, % en zona
InDrive, segmento, distribución L–D**. El motor resuelve TODOS los carteles a
"S/ incremental para este driver esta semana" y produce:

**Tabla Yango vs cada competidor** → take-home semanal · comisión efectiva % ·
**Δ vs Yango**, separando **recurrente (sostenible)** de **one-off (gancho)**, al
volumen real (no al máximo del cartel).

## 6. Fases de construcción (cuando el usuario diga "dale")

- **F1** — `tiered` (peldaño máximo) + arreglar sum→max + `segment` + `recurring`.
  Cubre ~80% (Uber/Cabify/Didi quests). Incremental, bajo riesgo.
- **F2** — `guarantee` + `comm_discount` (InDrive 1%, Didi garantizado) con
  `% viajes en ventana` tuneable.
- **F3** — arquetipo de driver + tabla comparativa recurrente/one-off + `streak` Didi.

## 8. Yango (nuestro lado): bono por % de GMV — brandeo / sin brandeo

Yango también da un **bono por % del GMV**, en escalera por # de viajes, con dos
tablas según el auto esté **brandeado** o **sin brandear**. Decisión del usuario:
**toggle brandeado/sin brandeo**, **default = SIN BRANDEO**.

**CON BRANDEO** (Lima, gana hasta S/640):
| Nº viajes ≥ | % bono GMV | Gana hasta (tope S/) |
|---|---|---|
| 190 | 24% | 640 |
| 150 | 22% | 480 |
| 125 | 20% | 390 |
| 100 | 18% | 320 |
| 75 | 17% | 260 |
| 50 | 16% | 220 |
| 30 | 15% | 145 |
| <30 | 0% | 0 |

**SIN BRANDEO** (Lima, gana hasta S/400) — _default_:
| Nº viajes ≥ | % bono GMV | Gana hasta (tope S/) |
|---|---|---|
| 150 | 18% | 400 |
| 125 | 16% | 340 |
| 100 | 14% | 280 |
| 75 | 12% | 200 |
| 50 | 11% | 150 |
| 30 | 10% | 110 |
| 10 | 9% | 50 |
| <10 | 0% | 0 |

> ⚠️ **OJO segmento — Lima es ESTÁNDAR; provincias son REACTIVACIÓN.** La tabla de
> Lima es "NUEVO SISTEMA DE BONOS POR %" (aplica a conductor **activo**). Las de
> Trujillo/Arequipa abajo son "BONO ESPECIAL DE **REACTIVACIÓN**" (nota: _reactivado
> si no condujo en 45+ días_) → **segmento = reactivado**, NO aplica a un driver
> activo. PENDIENTE: ¿existe una tabla ESTÁNDAR (activo) de % GMV para provincias, o
> el driver activo en provincia NO tiene bono GMV? (define qué se suma al take-home
> de un activo fuera de Lima).

**TRUJILLO — reactivación** (segmento reactivado). CON brandeo (hasta S/690):
`230→37%/690 · 190→35%/612 · 155→33%/513 · 125→31%/435 · 95→30%/340 · 65→29%/210 · 35→28%/120 · <35→0`.
SIN brandeo (hasta S/550):
`190→33%/550 · 155→31%/400 · 125→29%/330 · 95→27%/250 · 65→26%/190 · 35→25%/115 · 10→24%/60 · <10→0`.

**AREQUIPA — reactivación** (segmento reactivado). CON brandeo (hasta S/955):
`195→33%/955 · 155→31%/852 · 125→29%/662 · 100→28%/517 · 75→27%/405 · 50→26%/283 · 25→25%/163 · <25→0`.
SIN brandeo (hasta S/560):
`155→31%/560 · 125→29%/495 · 100→27%/335 · 75→25%/275 · 50→24%/226 · 25→23%/145 · 10→22%/80 · <10→0`.

**Modelo (✅ confirmado 2026-06-07):** escalera = **peldaño más alto alcanzado**
por # de viajes/sem; bono = **`mín(%bono_peldaño × GMV_sem, tope_peldaño)`**, con
`GMV_sem = fare × viajes`. El % se aplica sobre el GMV de la semana y se topea en
el "Gana hasta" del peldaño. Toggle **brandeo/sin brandeo, default sin brandeo**.

**Impacto:** hoy la vista muestra a Yango **sin** este bono → subestima el
take-home de Yango. El take-home real de Yango = `fares×(1−comisión_total) +
bono_GMV(viajes, brandeo)`. Es la contraparte directa de los bonos de competidor.

---

## 7. Datos crudos de referencia (capturas del usuario, Lima salvo nota)

- **Uber** — Weekend Volume Quest (Vie-Dom), varias quests personalizadas (ej.
  80→S/181 +10→+S/45; 40→S/31 +10→+S/14). Flash: 30→S/45, +10→+S/27 (Vie-Dom);
  30→S/24, +10→+S/28 (Lun-Jue). Welcome escalera 8→S/20…220→S/1000 (nuevo).
  28 viajes→S/46. Trujillo/Arequipa: bonos chicos (10→S/13, 19→S/24, finde 107→S/87).
- **Cabify** — Reconexión S/150 @50 viajes (Jue-Dom, reactivado). 25→S/55, 50→S/310
  (sem, total S/365). 20→40 PEN (sin extras).
- **InDrive** — 1% comisión en ventanas (7-8am, 6-7pm Lima; 6:30-7:30 Trujillo) y
  zonas (centro/mall). Comisión efectiva ~10.3% para driver de 10h. + monedas para
  pagar comisión (variable por conductor).
- **Didi** — Garantizado S/120 @15 viajes (25-31 may). Racha peaks (AM/PM, 4 viajes/
  ventana, Día1 16…Día5 +24, hasta 100/ventana, 200 total). 25→S/55, 40→S/310.
  Flash por hora (TAD 30%): ej. dom 16-20h hasta S/88.

---

## 9. PLAN REFINADO — revisión ultracode (2026-06-07)

Revisión multi-agente (5 lentes + verificación adversarial). Veredicto: modelo
**sound**, integración **mostly-sound**. Todo verificado contra código + DB en vivo.

### 9.1 Hallazgos críticos

- ✅ **Bug confirmado**: `bonusFor` (Rentabilidad.jsx:240-241) y `calcCell`
  (DriverEarnings.jsx:183-188) **SUMAN** todo bono 'viajes' que cumple umbral →
  una escalera cargada como N filas se sobreestima (Cabify @50 daría 365 en vez de 310).
- 🚧 **BLOQUEANTE**: mig 33 creó UNIQUE `(country, competitor_name, bonus_type,
threshold, city)`. Filas nuevas colisionan (Uber Flash Vie-Dom 30 vs Lun-Jue 30).
  Hay que rehacer ese índice (incluir mechanism/segment/day_window o dropearlo).
- 🚧 **Bug de guardado**: `useCompetitorBonuses.saveBonus` (43-55) tiene un whitelist
  fijo de columnas → descartaría silenciosamente mechanism/tiers/segment. Reescribir
  saveBonus+addRow es **parte atómica** de la migración (sin esto la UI guarda vacío).
- ⚠️ **3 rutas de neto Yango** deben tocarse juntas: `netFor` (255), `yangoNetAt`
  (269, matriz E1/E4), `netPerTrip` (287, break-even). Tocar solo una desincroniza.
- ⚠️ **Doble motor**: bonusFor y calcCell duplican lógica → extraer helper único
  `src/lib/competitorBonus.js` (`resolveBonusWeekly`). Tabla VACÍA (0 filas) → el
  refactor es no-op hasta cargar data (riesgo de regresión ~nulo).

### 9.2 Fórmulas FIJADAS (cash SEMANAL; per-trip = ÷trips en netFor, un solo lugar)

`fare`=precio tier/viaje, `n`=viajes/sem, `c`=comisión.

- **tiered** (escalera): `reward del peldaño MÁS ALTO con threshold≤n` (NO suma).
  reward = cash ACUMULADO a ese nivel.
- **flat**: `+amount si n≥threshold`.
- **guarantee** (Didi): `max(0, garantía − fare·min(n,n_gar)·(1−c))` — piso sobre el
  NETO, cubre solo los n_gar viajes garantizados.
- **comm_discount** (InDrive 1%): `(c − 0.01)·fare·n·share` ; equivale a
  `c_eff = c − (c−0.01)·share`. share = % viajes en ventana (slider, default 0.25).
- **comm_credit** (monedas InDrive): cash semanal (variable por driver → mejor slider
  del arquetipo, default 0).
- **streak** (Didi): `min(Σ reward_dia(d) d=1..días, tope_semanal=200)`.
- **Yango GMV**: `min(%peldaño · fare·n, tope)`, peldaño máx por n, tabla según brandeo
  (default sin brandeo). Es CASH aditivo, NO comisión → suma al take-home, nunca a la comisión.
- **TAKE-HOME**: competidor = `fare·n·(1−c_eff) + Σ bonos recurrentes`. Yango =
  `fare·n·(1−comisión_total) + yangoGmvBonus`. Per-trip = take-home/n.

### 9.3 Schema (mig 110, aditiva — tabla vacía, sin backfill)

Una fila = un bono. La escalera va en `tiers jsonb` (NO N filas → mata el bug por
construcción y evita la colisión del UNIQUE).

```
mechanism text NOT NULL DEFAULT 'flat'   -- tiered|flat|guarantee|comm_discount|comm_credit|streak(|surge?)
tiers jsonb                              -- [{threshold, reward}] (reward acumulado)
segment text DEFAULT 'all'               -- active|new|reactivated|all
recurring boolean DEFAULT true           -- false = gancho one-off (no entra al semanal)
comm_pct numeric                         -- comm_discount (1.0)
share_in_window numeric                  -- (o en el arquetipo)
cap_amount numeric
```

- rehacer el UNIQUE de mig 33. NO tocar el CHECK de bonus_type (mechanism es ortogonal).

### 9.4 Mecanismos del §7 que faltan en la taxonomía (decisión de alcance)

- **surge_mult** (Didi TAD +30% topeado S/88): no hay mecanismo "% sobre fare con tope".
- **streak** (Didi racha por DÍAS): la dimensión DÍA no existe en `tiers`; necesita
  `streak_spec jsonb` + parámetro `días_logrados`.
  → Decidir si entran en v1 o quedan fuera-de-alcance ANTES de congelar mig 110.

### 9.5 UX de configuración (mockups en chat / artifacts del workflow)

Cambio central: de la grilla plana (1 fila = 1 bono que el motor suma mal) a
**TARJETAS por bono con MECANISMO explícito**; el formulario muestra SOLO los campos
del mecanismo elegido. Piezas: (a) tarjeta con cabecera común + chips de mecanismo;
(b) **editor de peldaños** con preview "a X viajes ganás S/Y" (resuelve el bug a la
vista del analista); (c) selectores segmento/recurrencia/ventana como chips; (d) bono
GMV Yango = grilla colapsada read-only + toggle Brandeado (default OFF); (e) panel
**Arquetipo de driver** (sliders: viajes/sem, %pico, %zona, segmento); (f) tabla
comparativa Yango vs competidor con take-home, comisión efectiva, Δ, separando
**recurrente vs one-off**. Estilo actual (chips, pills rojas, recharts, inputs nativos,
sin libs nuevas, i18n es/en/ru).

### 9.6 Fases (reordenadas: el MVP NO es la F1 del doc)

- **F0 (MVP) — Bono Yango GMV** (esfuerzo S, riesgo BAJO): mayor impacto, dato nuestro,
  auto-contenido. HOY subestima a Yango en cada barra. Solo Lima en v0.
- **Prereq — mig 110 + saveBonus/addRow + UNIQUE** (S, BAJO): sin esto nada se carga.
- **F1 — tiered + fix SUM→max + helper único** (M, MEDIO): arregla el bug, schema, editor.
- **F2 — guarantee + comm_discount** (M, MEDIO) con share slider.
- **F3 — arquetipo + tabla recurrente/one-off + streak** (L, MEDIO-ALTO).

### 9.7 Decisiones (✅ resueltas 2026-06-07)

1. **Uber quests** → **el analista elige** la quest activa. Schema: `group_key text`
   (agrupa alternativas) + marca de "elegida" (ej. `is_chosen bool` o selección en UI);
   el motor usa SOLO la elegida del grupo (no suma, no max automático).
2. **"25→55, 50→310"** → **depende del competidor**: lo modela el analista por bono.
   Escalera (excluyente, max) = UN bono tiered; "suman" = DOS bonos flat. El editor
   soporta ambos; sin regla global.
3. **Bono GMV Yango provincias** → **conseguir las tablas de provincia primero**.
   F0 queda gatillada por las escaleras de Trujillo/Arequipa (pendiente: el usuario las pasa).
4. **Alcance v1** → **incluir TODO**, también surge_mult y streak. Schema suma:
   `mult_pct numeric`, `cap_amount` (surge, ya está) + `streak_spec jsonb`
   (trips_per_window, windows_per_day, per_day_reward[], cap_per_window, cap_total) +
   parámetro de arquetipo `streak_days_achieved`. mechanism CHECK incluye `surge`,`streak`.

### 9.8 Decisiones menores (recomendación, confirmar al construir)

- **InDrive monedas** → slider del arquetipo `indrive_coins_per_week` (default 0), NO fila
  global (el valor es por-driver).
- **share_in_window** → default 0.25, rango de sensibilidad mostrado 15–35%.

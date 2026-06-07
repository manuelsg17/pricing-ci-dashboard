# Diseño — Vista "Rentabilidad" (Unit Economics + Escenarios de herramientas Yango)

> Documento de diseño. NO es código todavía. Estado: **borrador para revisión**.
> Decisión: diseñar todo antes de construir · vista NUEVA al lado de "Ganancias" ·
> escala de viajes = segmentos configurables + slider.
> Última actualización: 2026-06-01.

---

## 1. Objetivo

Una vista nueva en **Análisis → Rentabilidad** que modele la **ganancia neta del
driver por tier** (categoría), compare **Yango vs competidores**, y permita
**apilar herramientas Yango** (Mi Zona, Mi Casa, Mis Destinos, Flex) para ver
cómo cambia la economía del driver. Formato = las slides que les encantaron a los
gerentes ("02 Unit Economics by Tier" + "04 My Zone + Combined Scenario Matrix").

Herramienta para que **la use todo el equipo** (comercial, pricing, gerencia).

**NO reemplaza** la vista "Ganancias" actual (tabla) — convive. Reusa por debajo
toda la lógica y datos que ya existen.

---

## 2. Qué ya existe (no rehacer)

`src/pages/DriverEarnings.jsx` (menú Análisis → Ganancias) ya tiene el motor:

- **Fórmula**: `netRides = price_without_discount × n × (1 − comisión%/100)` +
  bonos ([DriverEarnings.jsx:158-185](src/pages/DriverEarnings.jsx#L158)).
- **`competitor_commissions`** (mig 12): `competitor_name, city, commission_pct,
country`. Defaults Peru: Yango 20%, Uber 25%, InDrive 10%, Cabify 20%, Didi 20%.
  Editable en Config → CommissionsConfig.
- **`competitor_bonuses`** (mig 13): `competitor_name, city, bonus_type
('viajes'|'horas'|'zona'), threshold, bonus_amount, is_active`. Hoy `zona` se
  lee pero **NO se aplica** ("informational only").
- **`earnings_scenarios`**: guardar/cargar snapshots.
- Precios por categoría desde `pricing_observations.price_without_discount`
  (o vía `get_dashboard_data_weekly_fast` → MV, `avg_price`).
- Categorías por ciudad en `src/lib/constants.js` + `country_config`.

**Lo que falta = exactamente los 3 pedidos**: formato visual de barras, escala de
viajes configurable, y los escenarios de herramientas Yango.

---

## 3. La ecuación (corazón del modelo)

Para una categoría `c`, competidor `k`, a un volumen `v` viajes/semana:

```
ganancia_semana(k,c,v) = v · fare(k,c) · (1 − comisión_total(k,c)) + bonos(k,v,horas)
ganancia_viaje(k,c,v)  = ganancia_semana / v
                       = fare(k,c) · (1 − comisión_total) + (Σ bonos)/v
```

- `fare(k,c)`: precio promedio del tier (de los datos CI; editable por celda como hoy).
- `bonos`: de `competitor_bonuses` (viajes/horas). Por eso 60 vs 90 viajes/semana
  da distinta ganancia/viaje (la slide "02" muestra justo esto: el bono se amortiza
  por viaje).
- **`comisión_total`**:
  - Competidores: `comisión_base(k,c)` (de `competitor_commissions`).
  - **Yango**: `comisión_base(c) + Σ_herramienta comisión_extra(herramienta, params)`.

Todo lo demás (UI, config) es presentación de esta ecuación.

### 3.1 Herramientas Yango como modificadores apilables

Cada herramienta prendida suma un término a `comisión_total` de Yango (o un fee fijo):

| Herramienta      | Efecto en la ecuación                                                     | Fuente de la regla   |
| ---------------- | ------------------------------------------------------------------------- | -------------------- |
| **Mi Zona**      | +comisión según cobertura de zonas (curva, modelo B), EXTRA sobre la base | `Lima_map.html` (§4) |
| **Mi Casa**      | **+5%** comisión extra                                                    | ✅ confirmado        |
| **Mis Destinos** | **+5%** comisión extra                                                    | ✅ confirmado        |
| **Flex**         | **+6%** comisión extra — ⏳ TEMPORAL (se elimina pronto)                  | ✅ confirmado        |

> El framework no depende de los números exactos — son parámetros. Cuando los
> definas, se cargan en config y la ecuación los usa.

---

## 4. Modelo "Mi Zona" (extraído de `Lima_map.html`)

13 zonas en Lima (los polígonos `lima_*`). El driver "se cierra" a N zonas y solo
recibe viajes ahí; a cambio paga **comisión extra** (menos cobertura = más comisión).
El archivo trae **dos modelos** — hay que elegir cuál es el oficial:

**A) Escalera por # de zonas** (`oldLadder`):

| # zonas | comisión extra |
| ------- | -------------- |
| 2       | 9%             |
| 3       | 7%             |
| 4       | 5%             |
| 5       | 3%             |
| 6       | 1%             |
| 7+      | 0%             |

**B) Curva por `gmv_inside_ratio`** (`commissionForRatio`): comisión depende de qué
fracción del GMV queda _dentro_ de las zonas elegidas. `ratio ≤ 0.251 → 9%`;
`ratio ≥ 1 → 0%`; intermedio `= 9 − 9·t^γ`, `t=(ratio−0.251)/0.749`, `γ≈1.087`.

Efecto secundario que menciona la slide 04: **"cada zona removida ≈ −S/0.17 por
viaje"** → además de comisión, menos zonas baja el fare/eficiencia. Para v1 modelamos
la **comisión** (concreta); el efecto de calidad/volumen de viaje queda como
parámetro opcional `penalidad_por_zona_removida` (default S/0.17).

✅ **Decisiones Mi Zona (confirmadas)**: (1) **Modelo B** — curva por
`gmv_inside_ratio`. (2) La comisión es **EXTRA sobre la base**. (3) La penalidad por
zona removida (~S/0.17/viaje) es un **toggle on/off** en la UI (default OFF hasta
validar el número).

✅ **Fase 3 confirmada (interactivo)**: importar el GMV/orders por zona del
`Lima_map.html` a una tabla → elegís zonas en un mini-mapa y la curva (modelo B)
recalcula el `gmv_inside_ratio` en vivo.

---

## 5. Modelo de datos

### 5.1 Existente (reusar)

- `competitor_commissions`, `competitor_bonuses`, `earnings_scenarios`, precios.

### 5.2 Nuevo (para Fase 2)

- **`yango_tools`** (config): `tool_key` (`mi_zona|mi_casa|mis_destinos|flex`),
  `country`, `label`, `params` jsonb (ej. la escalera de Mi Zona, el fee de Mi Casa),
  `is_active`, `updated_at`. Editable en Config (patrón CommissionsConfig).
- ✅ **Comisión por tier** (resuelto): Yango cobra el **mismo % en todas las
  categorías** → NO hace falta columna `category`. Lo que cambia es la base **por
  ciudad**, que `competitor_commissions.city` ya soporta:
  - **Comisión base Yango**: Lima **12%**, provincias (Trujillo/Arequipa) **9%**.
  - **Comisión partner**: **3%** en todo Perú (componente aparte; ver §5.3).
    (Hay que actualizar los datos — hoy Yango figura 20% en `competitor_commissions`.)

### 5.3 Composición de la comisión de Yango (validado con la matriz E1-E4)

```
comisión_total(Yango) = base_ciudad + partner(3%) + Flex(6% si on) + Mi Zona(curva)
                        + Mi Casa(5% si on) + Mis Destinos(5% si on)
```

Esto **valida** la matriz de la slide "04":

- **E1 mejor caso = 15%** = 12% (Lima) + 3% (partner) + 0 Flex + 0 Mi Zona (7 zonas).
- **E4 peor caso = 30%** = 12% + 3% + 6% (Flex) + ~9% (Mi Zona, 2 zonas). ✓

Cada componente = un parámetro/toggle apilable.

---

## 6. UI / UX

Vista nueva `src/pages/Rentabilidad.jsx`, entrada nueva en Topbar → Análisis →
"Rentabilidad", ruteo en App.jsx (patrón del recon de arquitectura). Recharts
(ya está) para las barras.

### 6.1 Filtros (arriba)

`Semana` · `Ciudad` · `Competidores` (multiselect) · `Tiers a mostrar` (multiselect
de categorías; por defecto todas). Reusar `FilterBar` donde aplique.

### 6.2 Control de escala de viajes (segmentos + slider)

- **Segmentos configurables**: chips que tipeás y agregás/quitás (ej. `60`, `90`,
  `120` viajes/semana). Cada segmento = un panel de barras (small-multiples, como
  las slides muestran 60 y 90 lado a lado).
- **Slider** arrastrable (0→N) con input numérico: define un valor "vivo" que
  resalta/recalcula un panel extra en tiempo real. (`@radix-ui/react-slider` — nueva
  dep; recordar: `package.json` + `package-lock.json` en el mismo commit.)

### 6.3 Gráfico principal (formato slide "02")

- **Barras agrupadas por tier**: eje X = categorías (Economy/Comfort, Comfort+,
  Premier, XL…); dentro de cada tier una barra por competidor (Yango rojo, Uber
  negro, etc. — colores de `constants.js`).
- **Label de ganancia neta encima de cada barra**.
- Un panel por segmento de viajes configurado.
- **Selector por viaje / por semana** (✅ confirmado): el cálculo es semanal
  (`v·fare·(1−comisión)+bonos`) y se divide entre `v` para "por viaje". Un toggle
  arriba del gráfico cambia la métrica mostrada (por viaje | semana completa).

### 6.4 Panel de escenarios Yango (formato slide "04")

- Toggles por herramienta: **Mi Zona** (con selector/slider de # de zonas), **Mi
  Casa**, **Mis Destinos**, **Flex**. Al prender/ajustar, las barras de Yango
  recalculan en vivo.
- **Matriz de escenarios** (tabla E1-E4): filas = presets (mejor caso / actual /
  peor caso), columnas = Flex %, Zonas, Comisión total, Ganancia (por mix), con
  Uber/Cabify de referencia. Parametrizable.

### 6.5 Sección de análisis (abajo)

Insights auto-generados a partir de los resultados: en qué tier Yango es más/menos
profitable para el driver, gap vs cada competidor, **costo en S/ y % de cada
herramienta**, y break-even (a cuántos viajes/semana Yango supera a X).

### 6.6 Guardar/cargar

Reusar `earnings_scenarios` (extender el snapshot con la config de herramientas).

---

## 7. Fix lateral (no es parte de Rentabilidad pero salió en el smoke test)

**`get_bot_vs_hubs_summary` 500** (Gestión de Datos → Bot vs Hubs): medido **13.520
ms** — agregaba toda la historia bot+manual sin filtro de fecha → excedía el
`statement_timeout` 8s de `authenticated`. **Fix aplicado (mig 108)**: MV dedicada
`v_bot_vs_manual_mv` que materializa la agregación EXACTA del RPC (mismo COALESCE de
precio), con UNIQUE index y refrescada por el cron horario (se sumó a
`refresh_dashboard_mv()`). El RPC ahora lee de la MV → ms, semántica idéntica.

---

## 8. Plan de implementación (cuando aprobemos el diseño)

- **P0** — Fix `get_bot_vs_hubs_summary` (mig 108). Independiente, rápido.
- **P1** — Vista `Rentabilidad` nueva: barras por tier + labels + filtros + escala
  configurable (segmentos + slider) + análisis. Sobre comisiones/bonos/precios que
  YA existen. Sin herramientas Yango todavía. **No bloquea por reglas de negocio.**
- **P2** — Herramientas Yango: tabla `yango_tools` + Mi Zona (modelo de §4) +
  selector de escenarios + matriz E1-E4 + config UI. **Requiere las reglas de §9.**
- **P3** (opcional) — Importar zonas de `Lima_map.html` para Mi Zona interactivo
  (modelo B con mini-mapa).

---

## 9. Decisiones — estado

✅ **Resueltas (2026-06-02)**:

1. **Mi Zona**: modelo **B** (curva gmv_ratio), comisión **extra sobre la base**,
   penalidad por zona = **toggle** (default off). Interactivo (Fase 3) = SÍ.
2. **Mi Casa** = **+5%** · **Mis Destinos** = **+5%**.
3. **Flex** = **+6%** extra, ⏳ temporal (se elimina pronto).
4. **Comisión**: mismo % por categoría; base por **ciudad** (Lima 12% / provincias
   9%) + **partner 3%**. Sin columna `category`.
5. **Por viaje / por semana**: selector (toggle) en el gráfico.
6. **`get_bot_vs_hubs_summary`**: fix aplicado (mig 108, MV dedicada, semántica exacta).

✅ **Cerradas (2026-06-02)**:

- **Partner 3%**: **siempre activo** (no es toggle).
- **Penalidad Mi Zona** (~S/0.17/zona): **apagada** — no se modela por ahora.
- **Matriz de escenarios**: precargar solo **mejor (E1)** y **peor (E4)**.

Diseño cerrado → en construcción (Fase 1 primero).

```

```

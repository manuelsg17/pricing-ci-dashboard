# Diseño — Modelo de permisos genérico (UI ↔ RLS)

Estado: **PLAN, sin implementar**. Escrito 2026-07-31.
Prerrequisito de nada; se puede implementar cuando haya una ventana tranquila.

---

## El problema

La app y la base de datos deciden permisos con criterios distintos:

- **La app** pregunta _"¿el rol del usuario tiene esta sección?"_
  (`useAccessControl.canAccess()` lee `roles.permissions.sections`).
- **La base** pregunta _"¿es admin?"_ (`can_edit()` = `is_admin()` = `r.name='admin'`).

Mientras las secciones se concedan solo a admins, nadie lo nota. En cuanto se
delega una sección a un rol operativo, la pantalla se abre pero la escritura
rebota con `new row violates row-level security policy`. El usuario ve un error
técnico donde debería ver o bien la pantalla funcionando, o bien ningún acceso.

**Casos reales ya ocurridos:**

| Rol                       | Sección     | Tabla que la página escribe                    | Resultado                                             |
| ------------------------- | ----------- | ---------------------------------------------- | ----------------------------------------------------- |
| `hub_expert` (4 usuarios) | `distances` | `distance_references`                          | Reportado por un hub. Parcheado en mig 181.           |
| `ms&e` (2 usuarios)       | `earnings`  | `competitor_commissions`, `competitor_bonuses` | Confirmado con JWT simulado: BLOQUEADO. Sin parchear. |

**Por qué parchear caso por caso no sirve** (la observación que originó este
documento): cada parche codifica en SQL la foto de roles de _hoy_. Si mañana se
crea un rol nuevo, se le agrega una sección a uno existente, o se le quita otra,
hay que volver a tocar políticas RLS. El permiso pasa a vivir en dos lugares que
se desincronizan — que es exactamente el bug original, solo que más disperso.

**Riesgo latente adicional**: la sección `config` NO es `adminOnly` en la app
(`App.jsx:47` usa `section:'config'`). Hoy ningún rol no-admin la tiene, así que
no hay bug activo; el día que se conceda, el mismo problema aparece multiplicado
por ~15 tablas de configuración.

---

## El objetivo

Una sola fuente de verdad para los permisos: `roles.permissions`.
Cambiar qué puede hacer un rol debe ser **solo** editar esa fila desde la
pantalla de Accesos — nunca escribir una migración.

Criterios de aceptación:

1. Crear un rol nuevo con cualquier combinación de secciones funciona sin SQL.
2. Agregar o quitar una sección a un rol existente funciona sin SQL.
3. Si la UI muestra una pantalla, sus escrituras funcionan. Si no debe poder
   escribir, la pantalla no se muestra. Nunca el estado intermedio actual.
4. El aislamiento por país se mantiene en todos los casos.

---

## Diseño propuesto

### 1. Tabla de mapeo `section_write_grants`

Declara qué tabla puede escribir cada sección. Es el contrato explícito entre
la app y la BD, y el único lugar que hay que tocar cuando una pantalla nueva
empieza a escribir una tabla nueva.

```sql
CREATE TABLE section_write_grants (
  section    text NOT NULL,   -- 'distances', 'earnings', 'config', …
  table_name text NOT NULL,   -- 'distance_references', …
  PRIMARY KEY (section, table_name)
);
```

Seed inicial derivado del mapa de la auditoría (sección §"Mapa actual" abajo).

Ventaja sobre hardcodear la sección en cada política: si una tabla pasa a
editarse desde dos pantallas (ya pasa hoy — comisiones se editan desde Config y
desde Ingresos), se agrega una fila, no se reescribe una política.

### 2. Función genérica `can_write_table(text)`

```sql
CREATE OR REPLACE FUNCTION can_write_table(p_table text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT is_admin() OR EXISTS (
    SELECT 1
    FROM user_profiles up
    JOIN roles r          ON r.id = up.role_id
    JOIN section_write_grants g ON g.table_name = p_table
    WHERE up.email = (select auth.email())
      AND up.is_active = true
      AND (
        r.permissions->'sections' ? g.section OR
        r.permissions->'sections' ? 'all'
      )
  );
$$;
```

No nombra ningún rol ni ninguna sección concreta: se adapta sola a cualquier
configuración de `roles.permissions`.

### 3. Política uniforme

Toda tabla de configuración/operación con columna `country`:

```sql
USING      (can_write_table('<tabla>') AND can_access_country(country))
WITH CHECK (can_write_table('<tabla>') AND can_access_country(country))
```

Sin columna `country` (catálogos globales): solo `can_write_table('<tabla>')`.

### 4. Patrones que NO cambian

- **Tablas por dueño** (`ci_sessions`, `ci_active_sessions`,
  `user_filter_presets`): siguen gateadas por `auth.uid()`/`auth.email()`. El
  permiso no es "qué sección tenés" sino "es tuyo".
- **`pricing_observations`**: mantiene su lógica de país **en línea**. NO
  uniformar. Las migs 175/176 la reescribieron a propósito para calcular los
  países permitidos una vez por consulta en vez de por fila (SELECT 16,5s →
  39-60ms). Meterla en el patrón genérico reintroduce el costo por fila sobre
  1,6M+ filas. Si se quiere unificar, primero medir.
- **Funciones `SECURITY DEFINER`**: ya validan permisos internamente (auditado
  2026-07-31: las 15 que escriben y son llamables por `authenticated` validan;
  el resto están restringidas o son triggers). Se pueden migrar a
  `can_write_table()` por consistencia, sin urgencia.

---

## Decisión de producto pendiente (bloquea el seed)

Por cada sección hay que decidir si **escribe** o es **solo lectura**. La
auditoría dejó el mapa; falta la intención de negocio en los casos ambiguos:

| Sección    | Escribe hoy                                                          | ¿Debe?                                                                                                         |
| ---------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `earnings` | `competitor_commissions`, `competitor_bonuses`, `earnings_scenarios` | **A definir.** Alternativa: sacar los editores de DriverEarnings y dejarlos solo en Config.                    |
| `config`   | ~15 tablas de configuración                                          | ¿Se delega alguna vez a un no-admin, o se marca `adminOnly` en la app y se cierra el tema?                     |
| `rawdata`  | `pricing_observations` (edición y borrado inline)                    | Ya funciona (país + dueño). Confirmar que la edición inline es intencional para todos los roles que la tienen. |
| `upload`   | `pricing_observations`, `bot_sync_watermark`                         | Hoy solo admin la tiene. ¿Se delegará a hubs?                                                                  |
| `events`   | `market_events`                                                      | Hoy solo admin. ¿Se delegará?                                                                                  |

Si la respuesta a `config` es "nunca se delega", lo más barato y seguro es
marcarla `adminOnly: true` en `App.jsx` y dejar sus tablas en `is_admin()` —
menos superficie que mantener.

---

## Mapa actual (auditoría 2026-07-31) — insumo para el seed

Secciones que **escriben**:

| Sección                         | Tablas                                                                                                                                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataentry`                     | `pricing_observations`, `ci_sessions`, `ci_active_sessions`                                                                                                                                                                                                                            |
| `rawdata`                       | `pricing_observations`                                                                                                                                                                                                                                                                 |
| `upload`                        | `pricing_observations`, `bot_sync_watermark`                                                                                                                                                                                                                                           |
| `distances`                     | `distance_references`                                                                                                                                                                                                                                                                  |
| `earnings`                      | `earnings_scenarios`, `competitor_commissions`, `competitor_bonuses`                                                                                                                                                                                                                   |
| `events`                        | `market_events`                                                                                                                                                                                                                                                                        |
| `access`                        | `user_profiles`, `roles`                                                                                                                                                                                                                                                               |
| `config`                        | `distance_thresholds`, `bracket_weights`, `semaforo_config`, `price_validation_rules`, `rush_hour_windows`, `ci_timeslots`, `competitor_commissions`, `competitor_bonuses`, `yango_gmv_tiers`, `indrive_config`, `competitive_bands`, `bot_rules`, `airport_markers`, `country_config` |
| `dashboard`/`market`/`coverage` | `user_filter_presets` (por dueño, no por sección)                                                                                                                                                                                                                                      |

Secciones de **solo lectura**: `competitividad`, `rentabilidad`, `report`,
`botvshubs`.

---

## Hallazgos laterales a corregir en el mismo trabajo

**Lectura sin filtrar por país.** Tres tablas tienen columna `country` pero su
política de SELECT es `USING (true)`:

- `distance_references`
- `catalog_extras`
- `upload_batches`

Cualquier usuario autenticado lee las rutas, los overrides de catálogo y el
historial de cargas de **todos** los países. Es metadata, no precios, pero rompe
el aislamiento que el resto del sistema sí mantiene. Pasarlas a
`can_access_country(country)`.

(`ci_timeslots` y `roles` también son `USING (true)` pero NO tienen columna
`country`: son globales por diseño, se dejan.)

---

## Verificación del plan

1. **Genérico, no por rol**: crear un rol de prueba `qa_temp` con
   `sections:['distances']`, verificar que escribe `distance_references` y nada
   más. Agregarle `earnings`, verificar que gana esas tablas **sin tocar SQL**.
   Quitarle `distances`, verificar que las pierde. Borrar el rol.
2. **Aislamiento de país**: el mismo rol con `countries:['Peru']` no puede
   escribir filas de otro país en ninguna tabla.
3. **Admin intacto**: admin sigue pudiendo todo.
4. **Sin drift**: `npm run check:rls-drift` — una política por comando por tabla.
5. **Sin regresión de rendimiento**: `EXPLAIN ANALYZE` de la consulta caliente
   del dashboard antes y después (debe seguir en decenas de ms, no cientos).
6. **Los dos casos reales**: `hub_expert` guarda una ruta de referencia; `ms&e`
   guarda una comisión (si la decisión de producto es que pueda).

---

## Orden sugerido

1. Decidir los casos ambiguos de la tabla de arriba (bloquea todo lo demás).
2. Migración: tabla `section_write_grants` + seed + `can_write_table()`.
3. Migración: reemplazar las políticas de escritura tabla por tabla, con
   `DROP POLICY IF EXISTS` explícito antes de cada `CREATE` (CLAUDE.md §3 —
   dos políticas permisivas para el mismo comando se combinan con OR y la vieja
   gana en silencio; ya pasó en las migs 60-66, 130 y 164-165).
4. Migración: cerrar las tres lecturas cross-país.
5. Retirar `can_edit()` cuando no queden usos, o dejarla como alias de
   `is_admin()` documentado.
6. Actualizar CLAUDE.md §3 con el patrón nuevo como estándar del proyecto.

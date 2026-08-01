# Diseño — Modelo de permisos genérico (UI ↔ RLS)

Estado: **IMPLEMENTADO en local, sin subir a producción**. Escrito 2026-07-31,
implementado 2026-08-01 en las migs **187** (tabla + `can_write_table()`), **188**
(políticas uniformes en 20 tablas), **189** (lecturas cross-país), **192**
(mapa completo + columna `gate`) y **193** (RPCs genéricas).

Las decisiones de producto que bloqueaban el seed se tomaron con defaults
razonables y quedan documentadas en el encabezado de la mig 187 — todas son
reversibles con un INSERT/DELETE en `section_write_grants`, sin migración.

Validación: `npm run simulate:permissions` (58 aserciones sobre RLS real) y
`npm run check:section-grants` (detección automática de drift).
Orden de despliegue: ver `DESPLIEGUE_PENDIENTE.md`.

---

## Segunda pasada (2026-08-01): los tres huecos que quedaban

Las migs 187/188/189 dejaron el modelo funcionando pero **incompleto en tres
frentes**. Los tres tenían la misma forma: el permiso genérico existía, y al
lado quedaba un camino que seguía decidiendo con la foto de roles de ayer.

### 1. El mapa no cubría todo lo que la app escribe (mig 192)

`section_write_grants` se sembró a mano y solo declaraba las secciones cuyas
tablas se gatean por `can_write_table()`. Quedaban afuera **Proyectos, Ingresar
CI, Data Raw, Cargar Data y Accesos** — no porque su permiso estuviera mal, sino
porque nadie lo había escrito. Un mapa incompleto no es documentación floja:

- nadie puede responder "¿qué va a poder escribir este rol?" mirando un solo
  lugar — y la pantalla de Accesos tampoco, porque lee de ahí;
- un chequeo automático no puede distinguir "esta tabla se olvidó" de "esta
  tabla se gatea por dueño a propósito": o inventa huecos, o se acostumbra a
  ignorarlos y deja pasar el verdadero.

Además, la protección de `access` era una **ausencia**: la fila no estaba, y
por eso no concedía. Una ausencia no se defiende sola — un admin que agregara
de buena fe `('mi_seccion','roles')` creería estar dando un permiso más.

La 192 agrega la columna **`gate`**, que declara CÓMO se gatea cada escritura:

| gate        | Significado                                                     | ¿Concede?                    |
| ----------- | --------------------------------------------------------------- | ---------------------------- |
| `'section'` | La política llama `can_write_table()`: tener la sección alcanza | **Sí**                       |
| `'owner'`   | La política filtra por dueño (+país); el criterio es "es tuyo"  | No — documenta               |
| `'admin'`   | Solo admin por diseño (escalación o acción administrativa)      | No — documenta y **protege** |

`can_write_table()` pasa a mirar **solo** las filas `'section'`. Con eso, agregar
filas al mapa deja de poder abrir un agujero por accidente, que es exactamente
lo que uno quiere de una tabla pensada para editarse sin migración.

La 192 también retiró tres grants que sobraban (`bot_sync_watermark`,
`upload_batches`, `catalog_extras`): ninguna pantalla las escribe, las escriben
funciones `SECURITY DEFINER` que no necesitan el grant.

### 2. Nada detectaba el drift (`npm run check:section-grants`)

Lo anterior no puede depender de que alguien se acuerde. `scripts/check-section-grants-drift.mjs`:

1. lee la constante `ROUTES` de `App.jsx` → sección ↔ página;
2. camina el **grafo de imports** de cada página (una pantalla nueva o un hook
   nuevo quedan cubiertos sin tocar el script);
3. extrae escrituras (`.from().insert/update/delete/upsert`) y llamadas `.rpc()`;
4. contrasta contra la **base**, no contra una copia en el repo:
   - **Fase A**: toda `(sección, tabla)` que la app escribe tiene fila en el mapa.
   - **Fase B**: toda RPC que llama una sección no-admin es alcanzable por esa
     sección.

**El análisis es por símbolo, no por archivo, y eso importa.** La primera
versión atribuía a una sección toda escritura de cualquier archivo alcanzable, y
reportó tres huecos que no existían (Rentabilidad importa
`useCompetitorCommissions` solo para leer; DataEntry importa de
`useDistanceRefs` solo el fetch). Un falso positivo acá no es ruido inocente:
empuja a declarar una fila "para que pase el checker", y esa fila **concede
escritura que la pantalla no necesita**. El checker terminaría abriendo
permisos. Ante cualquier ambigüedad se cuenta todo: sobre-reportar cuesta una
revisión, no reportar devuelve el bug original en silencio.

### 3. Las RPCs seguían nombrando "admin" (mig 193)

Seis funciones alcanzables desde `config` y `upload` preguntaban `is_admin()`.
Para un rol al que se le delegara esa sección, el resultado era el bug original
por otra puerta: la pantalla se abre, los formularios guardan (RLS ya lo permite
desde la 188) y el botón de al lado tira `access_denied: … es solo para admin`.
Un permiso a medias es peor que uno negado.

Pasaron a `can_access_section('<sección>')`, que ya existía (mig 181) y es
genérica igual que `can_write_table()`.

**Lo que habría sido un agujero, y por eso va en el mismo cambio**: `is_admin()`
hacía **doble trabajo**. Estas funciones son `SECURITY DEFINER` —bypasean RLS— y
ninguna verificaba el país: el aislamiento se sostenía por accidente, porque el
admin tiene todos los países. Aflojar el guard sin agregar
`require_country_access(p_country)` habría dejado a cualquier rol con `config`
congelar promedios de Colombia desde Perú.

`list_audit_log` no toma país por parámetro: filtra por fila. Admin sigue
viendo todo (incluidas las globales con `country` NULL); un rol con `config` ve
solo las de sus países.

Excepción declarada y con motivo: `reassign_task` sigue siendo solo-admin
(acción administrativa por diseño, mig 184 §15.2), anotada en
`ADMIN_ONLY_RPCS` dentro del checker.

### 4. La pantalla de Accesos ya no elige a ciegas

`AccessManagement.jsx` lee `section_write_grants` **de la base** (no una
constante del front, que se desincronizaría el día que se agregue una fila) y
muestra:

- una etiqueta por sección: `Escribe: N` / `Solo lo propio` / `Solo admin` /
  `Solo lectura`, con el detalle completo de las tres categorías en el tooltip;
- un resumen en vivo mientras se edita: "con esta selección, el rol podrá
  escribir: …";
- lo mismo en la tarjeta cerrada, para revisar un rol sin entrar a editarlo —
  entrar a editar es justo el momento en que es fácil guardar sin querer.

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

## Decisión de producto pendiente (bloquea el seed) — RESUELTA en la mig 187

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

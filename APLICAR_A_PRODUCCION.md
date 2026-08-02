# Migraciones pendientes de producción

Estado al **2026-08-01, fin de sesión**. Cada bloque se aplica **entero y en
orden**; los bloques entre sí son independientes salvo donde se indica.

Forma de aplicar: Supabase Dashboard → SQL Editor → pegar el archivo completo
→ Run. Cada archivo trae su bloque de VERIFICACIÓN al pie: correr esas queries
después de cada bloque, antes de pasar al siguiente.

---

## ✅ Ya aplicadas

| Mig     | Qué hizo                                   | Verificado                                      |
| ------- | ------------------------------------------ | ----------------------------------------------- |
| **186** | Arregló `save_ci_batch` (fallaba el 100%)  | `inserted: 1` con payload real                  |
| **191** | Guard de dos pestañas + firma de 10 params | 1 sola firma, INVOKER, anon sin EXECUTE         |
| **190** | 2 RPCs del Market que estaban rotas        | descuentos 3 filas, rush/valle 6, volatilidad 5 |
| **185** | Bitácora de errores del cliente            | RLS activa, 1 política, anon sin acceso         |

---

## Bloque A — Permisos genéricos ✅ APLICADO (187, 188, 189, 192, 193)

Aplicadas y verificadas: 187, 188, 189, 192. Drift verificado en 0.

### 193 · las RPCs dejan de nombrar "admin"

Las 6 pasaron de `is_admin()` a `can_access_section()` y —en el mismo cambio—
sumaron el chequeo de país que **nunca tuvieron**: son `SECURITY DEFINER`,
bypasean RLS, y el aislamiento entre países se sostenía por accidente porque el
admin los tiene todos.

Las 6 quedaron con **firma única** (sin `PGRST203`), `search_path` fijo y sin
`EXECUTE` para `anon`. Cinco ya no mencionan `is_admin()` y todas chequean país.
`list_audit_log` lo conserva a propósito: filtra **por fila**, no rechaza — el
admin ve todo (incluidas las filas globales con `country` NULL) y un rol con
`config` ve solo sus países.

Probado con usuarios reales de producción:

| Quien                    | RPC                       | Resultado            |
| ------------------------ | ------------------------- | -------------------- |
| `analyst` (sin `config`) | snapshots                 | **DENEGADO** (42501) |
| `analyst`                | bitácora                  | 0 filas              |
| admin                    | snapshots Perú y Colombia | permitido            |
| admin                    | bitácora                  | 500 filas (el tope)  |

**Hoy no cambia nada operativo**: ningún rol tiene todavía `config` ni `upload`,
así que estas funciones siguen siendo de admin en la práctica. Lo que cambia es
que el día que delegues `config`, los botones funcionan **y** el aislamiento por
país se sostiene solo.

---

## Bloque B — ✅ APLICADO (194, 195, 199)

Aplicadas y verificadas: **194** y **195**.

- La duración nueva contra datos reales: promedio **49,4 min** (antes 92,7),
  máximo **212 min** (antes 721,6 — doce horas de reloj de pared).
- Backfill: **0 filas sin clasificar** (48 confiables, 26 `sin_timings`).
- `ci_hub_daily_minutes`: la suma ingenua resultó **mayor en todas las filas**,
  nunca menor. Peor caso real: 827,5 min → **48,4 reales**.
- Aislamiento por país verificado como hub real: Colombia **DENEGADO** (42501),
  Perú permitido.

### `supabase/199_fix_trigger_calidad_permisos.sql` — también aplicada

La 195 crea el trigger `trg_ci_close_fill_quality` como `SECURITY INVOKER`. El
fix que lo pasa a `DEFINER` estaba escrito… dentro de la **mig 197**, que es
del Bloque D. Aplicar B sin D dejó a los hubs sin poder cerrar sesión durante
unos minutos: el bundle desplegado inserta directo en `ci_sessions` con
`turno_timings` y **sin** `duration_confiable`, así que el trigger ejecutaba
`ci_ts_or_null` —sin `EXECUTE` para `authenticated` desde la 194— y moría con
`42501`.

Sin pérdida de datos: los precios se guardan antes y el código no limpia el
borrador ni borra el latido cuando ese INSERT falla.

Verificado en producción con el INSERT literal del bundle viejo, como rol
`authenticated`, en transacción revertida: **"EL HUB PUEDE CERRAR →
confiable=true, dur=40.0"**. Y `ci_ts_or_null` **sigue sin `EXECUTE`** para
`authenticated`: la higiene de la 194 se conservó.

**Lección, ya escrita en el archivo de la 199**: una simulación que valida un
camino de ESCRITURA del hub tiene que hacer `SET LOCAL ROLE authenticated`.
Corriendo como `postgres` solo prueba que el SQL compila. Misma familia que la
mig 182.

---

## Bloque C — ✅ APLICADO (196 + backfill autorizado)

Aplicado en dos pasos a propósito: la 196 **ejecuta el backfill dentro del
propio archivo**, así que primero se aplicó la estructura (columnas, función,
procedimiento, vistas) y recién después se corrió el ensayo y el backfill real.

Ensayo (sin escribir nada) → backfill completo, autorizado por el user viendo
esos números:

|                                          | Antes   | Después            |
| ---------------------------------------- | ------- | ------------------ |
| Minutos totales                          | 6.863,4 | **2.370,7** (−65%) |
| Máximo                                   | 721,6   | **212,1**          |
| Promedio                                 | 92,7    | **49,4**           |
| Filas en 0                               | 6       | **0**              |
| Filas de juguete (<2 min con +20 celdas) | 20      | **0**              |
| Por encima del techo de 720 min          | 1       | **0**              |

74 filas corregidas · 29 estaban infladas · 19 estaban cortas · 26 quedaron en
NULL · **0 pendientes**. Idempotencia verificada: la segunda corrida no tocó
nada.

Las 26 en NULL no tenían `turno_timings` medibles (casi todas del 20 al 24 de
julio). Ya estaban marcadas `duration_confiable = false` por la 195 y el panel
de turnos ya las excluía, así que la métrica no cambia — solo el historial, que
ahora muestra `—` en vez de un número sin sustento. El bundle desplegado ya lo
renderiza así (`CompletedSessionsTable.jsx:59`).

**Vuelta atrás completa**, si en algún momento querés los números viejos:

```sql
UPDATE ci_sessions
   SET duration_minutes = duration_minutes_legacy,
       duration_minutes_legacy = NULL,
       duration_backfilled_at  = NULL
 WHERE duration_backfilled_at IS NOT NULL;
```

Ninguna materialized view lee `ci_sessions`, así que no hay agregados que
refrescar.

---

## Bloque D — ✅ APLICADO (197, 198)

Probado en producción por el **rol real** (`SET LOCAL ROLE authenticated`), todo
en transacciones revertidas que no dejaron ni una fila.

**197 · el reintento de red deja de duplicar**

| Caso                         | Resultado                                   |
| ---------------------------- | ------------------------------------------- |
| Primer cierre                | `duplicado=false`, inserta                  |
| Reintento con el MISMO token | `duplicado=true`, **mismo id**              |
| Revisión con token nuevo     | `duplicado=false`, inserta                  |
| Filas totales                | **2** (el rastro de revisiones se conserva) |

El riesgo de esta migración era su `REVOKE` sobre `ci_close_fill_quality`:
Postgres **no** re-chequea `EXECUTE` al disparar un trigger, verificado contra
producción con el INSERT literal del bundle viejo → `confiable=true`.

**198 · el doble clic del admin deja de duplicar**

| Caso          | Resultado                                       |
| ------------- | ----------------------------------------------- |
| Primer clic   | `cerrada=true`, `duplicado=false`               |
| Segundo clic  | `cerrada=false`, `duplicado=true`, **mismo id** |
| Filas totales | **1**                                           |

`admin_close_ci_session`: una sola firma (sin `PGRST203`), retorna `jsonb`,
`DEFINER` con `search_path` fijo, y **`anon` ya no tiene `EXECUTE`** — la
superficie que estaba abierta quedó cerrada.

**Drift de políticas RLS: 0.**

### Evidencia con datos reales (CLAUDE.md §7.8)

Un hub cerró una sesión de verdad mientras se aplicaba el bloque:
`educespe` · Corp · 162/162 celdas · **46,8 min** · `duration_confiable = true`,
clasificada sola por el trigger. Sin `close_token` porque el bundle nuevo
todavía no está desplegado — que es exactamente lo esperado.

### Los 3 grupos duplicados históricos siguen ahí

La 197 evita duplicados NUEVOS; no borra los viejos. Son datos, y borrar filas
de producción necesita autorización explícita nombrando tabla y motivo
(CLAUDE.md §8). El impacto en la métrica ya está contenido: `ci_hub_daily_minutes`
une los tramos en vez de sumar duraciones.

```sql
SELECT city, zone, observed_date, user_email, count(*)
  FROM ci_sessions GROUP BY 1,2,3,4 HAVING count(*) > 1;
```

---

## Bloque E — Proyectos ✅ YA ESTABA APLICADO (183, 184)

**Esta guía estaba desactualizada**: la 183 y la 184 ya estaban en producción
antes de esta sesión. No se aplicó nada; se verificó que estuviera completo y
sin drift.

- Las **5 tablas** existen con RLS activa: `projects`, `project_tasks`,
  `task_comments`, `task_status_log`, `section_last_seen`.
- **14 políticas**, idénticas a local una a una en nombre, comando, rol y
  expresión (`can_access_country` para leer; `is_admin() AND
can_access_country` para escribir; `section_last_seen` filtra por dueño).
- Las **4 RPCs** (`set_task_status`, `reassign_task`, `add_task_comment`,
  `_task_guard`) son `SECURITY DEFINER` con `search_path` fijo, sin `EXECUTE`
  para `anon`.
- `country_config.timezone` poblado: Lima, Bogotá, La Paz, Katmandú.
- 0 filas en `projects` y `project_tasks` — nadie lo usó todavía.

---

## Estado global de seguridad (verificado al cierre)

| Chequeo                                               | Resultado |
| ----------------------------------------------------- | --------- |
| Tablas con 2+ políticas para el mismo comando         | **0**     |
| `SECURITY DEFINER` sin `search_path` en todo `public` | **0**     |
| `anon` con `EXECUTE` en las RPCs tocadas esta sesión  | **0**     |

---

## ⚠️ Lo único que queda: el merge a main

Todas las migraciones están aplicadas. `main` dispara deploy automático, y el
frontend de `feat/duracion-confiable` llama a funciones de las migs **195, 197
y 198** — que ya están en producción, así que el merge es seguro **ahora**.

Ya pasó una vez: un push a main desplegó el frontend nuevo contra la base vieja
y los hubs no pudieron guardar durante la mañana. Ahora el orden es el correcto.

Al desplegar, el cliente empieza a mandar `close_token`: la idempotencia de la
197 pasa a ejercitarse de verdad (hoy está aplicada pero ningún cliente la usa).

---

## Después del deploy

- Mirar **Monitoreo → "Cuánto tarda cada corte"** con datos reales.
- Dejar correr **una semana** y recalibrar el umbral de inactividad (5 min) con
  la columna `activity_trace`, que guarda el detalle crudo justamente para eso.
- Confirmar que el panel de errores del cliente empieza a recibir algo (si
  queda vacío una semana, verificar que `log_client_error` se esté llamando).

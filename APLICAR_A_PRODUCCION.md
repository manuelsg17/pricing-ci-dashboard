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

## Bloque A — Permisos genéricos ✅ APLICADO (falta solo la 193)

Aplicadas y verificadas: 187, 188, 189, 192. Drift verificado en 0.

**Queda pendiente `supabase/193_generic_rpc_gates.sql`**, que afloja 6 RPCs de
`is_admin()` a `can_access_section()` y —en el mismo cambio— les agrega el
chequeo de país que NUNCA tuvieron: son SECURITY DEFINER, bypasean RLS, y el
aislamiento se sostenía por accidente porque el admin tiene todos los países.

No aplicarla deja esas 6 funciones como estaban (solo admin), que es un estado
válido. Aplicarla sola es seguro: no depende de nada más del bloque.

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

## Bloque D — Fin de los duplicados ← SIGUE ESTE

1. `supabase/197_ci_session_close_idempotency.sql`
2. `supabase/198_admin_close_idempotente.sql`

La 197 vuelve a crear `ci_close_fill_quality` como `DEFINER`: es el mismo
estado que ya dejó la 199, así que aplicarla no revierte nada. Además le
REVOCA el `EXECUTE` que Postgres le da a PUBLIC por defecto, que hoy sigue
abierto.

La 198 cambia el tipo de retorno de `admin_close_ci_session` de `void` a
`jsonb`, por eso lleva `DROP FUNCTION` — los parámetros no cambian, así que no
crea overload. De paso cierra el `EXECUTE` que `anon` tiene sobre esa función
en producción (no es explotable: es `SECURITY DEFINER` y abre con `is_admin()`

- `require_country_access()`, pero es superficie que no hace falta).

---

## Bloque E — Proyectos

1. `supabase/183_projects_and_tasks.sql`
2. `supabase/184_projects_rpcs.sql`

---

## ⚠️ El merge a main va AL FINAL

`main` dispara deploy automático. El frontend de la rama
`feat/duracion-confiable` llama a funciones de las migs **195, 197 y 198**: si
el bundle sale antes, esas pantallas se rompen.

**Orden**: bloques A-E → verificar → merge.

Ya pasó una vez hoy: un push a main desplegó el frontend nuevo contra la base
vieja y los hubs no pudieron guardar durante la mañana.

---

## Después del deploy

- Mirar **Monitoreo → "Cuánto tarda cada corte"** con datos reales.
- Dejar correr **una semana** y recalibrar el umbral de inactividad (5 min) con
  la columna `activity_trace`, que guarda el detalle crudo justamente para eso.
- Confirmar que el panel de errores del cliente empieza a recibir algo (si
  queda vacío una semana, verificar que `log_client_error` se esté llamando).

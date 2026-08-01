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

## Bloque B — Duración confiable

**Orden obligatorio**: la 195 necesita las funciones de la 194.

1. `supabase/194_ci_duration_single_source.sql`
2. `supabase/195_ci_duration_trust_and_daily.sql`

**Ojo**: la 195 trae un backfill que clasifica el histórico. Después:

```sql
SELECT duration_confiable, duration_motivo, count(*)
  FROM ci_sessions GROUP BY 1,2 ORDER BY 3 DESC;
```

---

## Bloque C — El histórico inflado (¡ENSAYO PRIMERO!)

Requiere el Bloque B aplicado.

1. `supabase/196_ci_duration_backfill_historico.sql`
2. **ANTES de confiar en el resultado**, correr el ensayo, que NO escribe nada:

```sql
CALL ci_backfill_duration_minutes(p_dry_run => true);
```

Te dice cuántas filas cambiarían y cuántas quedarían en NULL. Las filas viejas
sin `turno_timings` medibles quedan en **NULL**, no se les inventa un número —
si hay muchas de antes de julio, van a quedar sin dato. Decidilo con ese
número a la vista.

3. Recién ahí, el backfill real. Los valores originales quedan en
   `duration_minutes_legacy`: se puede volver atrás.

---

## Bloque D — Fin de los duplicados

1. `supabase/197_ci_session_close_idempotency.sql`
2. `supabase/198_admin_close_idempotente.sql`

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

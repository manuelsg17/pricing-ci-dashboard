# Despliegue pendiente — orden de migraciones

Estado al **2026-08-01**. Todo lo de acá está aplicado y validado en **local**;
**nada** está en producción. Cada migración necesita tu autorización explícita
nombrándola (CLAUDE.md §3), aunque hayas dado un OK general antes.

---

## ⚠️ Lo único que tiene orden obligatorio

**La 186 va ANTES del deploy del frontend.**

La `save_ci_batch` de la mig 182 **ya está en producción y está rota** — falla el
100% de las llamadas. Hoy no hace daño porque nadie la llama. Pero el bundle
nuevo **sí la llama**: si desplegás el frontend antes de aplicar la 186, el
guardado de Ingresar CI se rompe para todos los hubs a la vez.

El resto de las migraciones no tiene acoplamiento con el deploy: sus pantallas
simplemente no funcionan hasta que estén.

---

## Orden recomendado

| #   | Migración                           | Qué hace                                                                                          | Riesgo                                                        | Reversible                                    |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------- |
| 1   | **186** `fix_save_ci_batch_insert`  | Arregla la RPC rota que el frontend nuevo va a llamar                                             | Bajo — reemplaza una función que hoy falla siempre            | Sí, `CREATE OR REPLACE` a la versión previa   |
| 2   | **190** `fix_broken_and_dead_rpcs`  | Arregla 2 RPCs **rotas en producción hoy** (paneles del Market vacíos) y retira 3 objetos muertos | Bajo-medio — incluye 3 `DROP FUNCTION`                        | Los DROP no, hay que recrear desde el archivo |
| 3   | **185** `client_error_log`          | Bitácora de errores del cliente                                                                   | Bajo — tabla nueva                                            | Sí, `DROP TABLE`                              |
| 4   | **183** `projects_and_tasks`        | 5 tablas de Proyectos                                                                             | Bajo — tablas nuevas                                          | Sí                                            |
| 5   | **184** `projects_rpcs`             | RPCs de Proyectos                                                                                 | Bajo — depende de la 183                                      | Sí                                            |
| 6   | **187** `section_write_grants`      | Tabla de mapeo + `can_write_table()`                                                              | Bajo — no cambia ninguna política todavía                     | Sí                                            |
| 7   | **188** `uniform_write_policies`    | **20 tablas** cambian de `can_edit()` al modelo genérico                                          | **El más alto de la tanda**                                   | Sí, pero hay que reponer 60 políticas         |
| 8   | **189** `close_cross_country_reads` | Cierra 3 lecturas entre países                                                                    | Bajo-medio — puede ocultar filas a un usuario mal configurado | Sí                                            |

**Después de la 188**, correr `npm run check:rls-drift` contra producción antes
de dar nada por cerrado. Es la migración que más superficie toca.

**El deploy del frontend** va después de la 186 (obligatorio) y, en la práctica,
conviene después de la 190 — si no, los paneles del Market siguen vacíos.

---

## Por qué la 188 es la delicada

Reemplaza 60 políticas RLS en 20 tablas. Está escrita con `DROP POLICY IF
EXISTS` explícito antes de cada `CREATE` justamente porque en Postgres las
políticas permisivas se combinan con OR: una vieja que sobreviva junto a la
nueva **gana en silencio**, sin error y sin log. Es lo que causó las fugas de
las migs 60-66, 130 y 164-165.

Qué mirar inmediatamente después de aplicarla:

```sql
-- Ninguna tabla con 2+ políticas para el mismo comando
SELECT tablename, cmd, count(*) FROM pg_policies WHERE schemaname='public'
GROUP BY tablename, cmd HAVING count(*) > 1;
```

Y un caso real de cada lado: que un `hub_expert` guarde una ruta de referencia,
y que un usuario de `ms&e` guarde una comisión (hoy está bloqueado).

---

## Decisiones de producto que van dentro de la 187

Son **reversibles con un `INSERT`/`DELETE` en `section_write_grants`**, sin
migración — ese es el punto del diseño. Las tomé con defaults razonables:

- **`earnings` escribe.** Hay 2 usuarios de `ms&e` bloqueados hoy con la
  pantalla visible. Si preferís que sea solo lectura, se borran 3 filas y hay
  que sacar los editores de la UI.
- **`config` escribe sus 15 tablas.** Ningún rol no-admin la tiene hoy, así que
  no cambia nada; queda listo por si algún día se delega.
- **`access` NO entra, y esto sí es de seguridad.** Escribe `roles` y
  `user_profiles`: un rol con esa sección podría concederse cualquier permiso a
  sí mismo. La pantalla además pasó a `adminOnly` en `App.jsx`.

---

## Cómo verificar antes de subir

```bash
npx supabase start
npx supabase db reset          # las 193 migraciones desde cero
npm run simulate:permissions   # 22 aserciones sobre RLS real
npm run check:rls-drift
npm run lint && npm run build && npm run test:all
```

---

## Lo que NO está listo y no debe subirse

Nada de lo de arriba depende de esto, pero conviene tenerlo presente:

- El **diagnóstico completo del contador de sesión** encontró 16 problemas. En
  esta tanda se arreglaron los **dos P0** (la causa del reinicio) y quedan 14
  documentados sin tocar — ver `SESIONES_HALLAZGOS.md`.
- El responsive de **Monitoreo, Accesos, Reporte Semanal y Eventos** quedó
  identificado pero no implementado.

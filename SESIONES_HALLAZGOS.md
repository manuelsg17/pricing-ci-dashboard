# Ingresar CI — hallazgos del control de sesión

Auditoría del 2026-08-01, motivada por el reporte: _"sigo viendo a mis hubs que
el contador se les reinicia y no me funciona ese controlador de sesión"_.

Se encontraron **16 problemas**. En esa sesión se arreglaron los **dos P0**, que
son la causa del síntoma reportado. Los otros 14 quedan acá documentados con
repro concreto, sin tocar.

Regla de lectura: lo que más importa no es el cronómetro en sí, sino los casos
donde el hub **pierde datos** o **cree que guardó y no guardó**.

---

## 🔎 Auditoría del 2026-08-02 — estado REAL de los 14 pendientes

El cuerpo de este documento quedó viejo: describe como pendientes cosas que ya
se arreglaron entre el 1 y el 2 de agosto. Se auditó **cada uno** contra el
código de `main` y contra producción. Resultado: **13 de 14 cerrados, 1 abierto.**

| Issue                                    | Estado         | Evidencia                                                     |
| ---------------------------------------- | -------------- | ------------------------------------------------------------- |
| P1-3 · nunca siembra desde el latido     | ✅             | `ci_started_from_timings` + `earliestTurnoStart`              |
| P1-4 · desmontar borra el latido         | ✅             | `markBucketJustFinished` / `isBucketJustFinished`             |
| P1-5 · `started_at` heredado de ayer     | ✅             | `debeReanudarTramo` + techo de 12 h (mig 194)                 |
| P1-6 · laptop cerrada infla la duración  | ✅             | techo de 4 h + `turno_recortado` + `activity_trace`           |
| P1-7 · cambiar la fecha no toca el reloj | ✅             | `hydratedCitiesRef` + cascada de contexto                     |
| P1-8 · `turnoTimingsByCity` no se limpia | ✅             | `setTurnoTimingsByCity` en el cierre                          |
| **P1-9 · auto-reload por deploy**        | ⚠️ **ABIERTO** | ver abajo                                                     |
| P1-10 · dos pestañas se pisan            | ✅             | candado + 86 aserciones + **verificado en 2 pestañas reales** |
| P2-11 · reintento duplica la sesión      | ✅             | `close_token` (mig 197) — 0 duplicados reales en producción   |
| P2-12 · el auto-load pisa lo tipeado     | ✅             | `conservarTecleado`                                           |
| P2-13 · el botón promete de más          | ✅             | `savableCount`                                                |
| P2-14 · el indicador miente              | ✅             | `estadoDeServidor`                                            |
| P2-15 · tras Terminar queda muda         | ✅             | `just_finished_note`                                          |
| P2-16 · "Guardando…" colgado             | ✅             | `fetchConTimeout` (45 s)                                      |

### P1-9, lo único abierto — y lo que cambió

`RealtimeSyncProvider.jsx:70` **recarga la página sola a los 60 segundos** de
detectar un deploy. El toast se puede cerrar y ocultar la pestaña lo cancela,
pero si el hub está tipeando y no toca nada, la recarga ocurre.

Su mitad grave —perder el trabajo sin guardar— **ya está cubierta**: el borrador
sobrevive la recarga (flush en `pagehide` + caso `[2] A · F5` de
`simulate-durability.mjs`), y desde el fix del F5 de más abajo la recarga ya no
puede hacer que el servidor pise el borrador. Lo que queda es de experiencia:
una recarga inesperada a mitad de una celda.

---

## 🐛 Bug NUEVO encontrado y arreglado el 2026-08-02 — pérdida de datos en el F5

No estaba en los 16 originales. Apareció probando el flujo real en navegador
contra local, y era **la peor clase de bug del proyecto**: silencioso y en el
camino más transitado.

**Repro medido**: borrador con 7 celdas → **4** después de un F5. Un valor
editado a mano (88.88) volvió al del servidor (11.01). El trabajo desaparecía
también del disco, no solo de la pantalla.

**Causa raíz** (confirmada instrumentando, no deduciendo): `draftKey` lleva el
email adentro y `userEmail` llega **asíncrono**. La hidratación corría en el
primer render con la clave `de:draft::Peru:Lima:…` —segmento del email vacío—,
no encontraba nada, **igual marcaba el bucket como hidratado** (bloqueando el
reintento bueno cuando el email llegaba), y al no haber borrador aplicado
agendaba el auto-load del servidor, que encontraba la grilla vacía y
**reemplazaba entero** en vez de fusionar. El autosave terminaba escribiendo el
estado del servidor encima del borrador.

**Fix**: `debeHidratarBorrador()` en `src/lib/sessionPersistence.js` — sin
identidad no se lee ni se marca nada. Es una función pura con 9 pruebas propias,
para que la regla no vuelva a perderse en una línea suelta del componente.

**Verificado en navegador**: con borrador, lo local gana y sobrevive el F5; sin
borrador, el auto-load del servidor sigue trayendo lo guardado.

---

## ✅ Arreglados (commit `846881e`)

### P0-1 — Un cambio de config le cerraba la sesión a todos los hubs

Los dos efectos de `DataEntry.jsx` que reaccionan a `countryConfig` —uno de ellos
mata la sesión y borra el latido— se disparaban sin que nadie cambiara de país.
`countryConfig` es un `useMemo` sobre `dbConfigs`, y `fetchAllConfigs()` setea un
objeto **nuevo** con el mismo contenido: al arrancar la app, y cada vez que
cualquier usuario edita `country_config` / `bot_rules` / `catalog_extras` (el
evento realtime `config:changed` llega a **todas** las sesiones abiertas).

Es exactamente el patrón que advierte CLAUDE.md §2 sobre efectos que dependen de
objetos recreados en cada render, aplicado al efecto más destructivo del
componente. **Fix**: comparar el valor del país, no la identidad del objeto.

### P0-2 — El flush del borrador escribía un payload mutilado

El flush síncrono guardaba 7 campos y pisaba los 10 del autosave. Se perdían:

- `turnoTimings` → al rehidratar, `sessionStartRef` caía a `Date.now()`:
  **cronómetro en 00:00**. Es el bug histórico #2 de ese campo, reintroducido
  por otro camino.
- `pendingScopeMembers` → un Aeropuerto con alcance "Ambos" volvía a un solo
  punto: el hub terminaba en A y la sesión cerraba como final **sin avisar que
  faltaba B**, que quedaba sin medir.

**Fix**: mergear sobre lo ya escrito en vez de reemplazar, así un campo que se
agregue mañana tampoco se pierde.

---

## Pendientes — pérdida de datos (lo más grave)

### P1-10 · Dos pestañas del mismo hub se pisan entre sí

Tres puntos de colisión sin protección: el borrador (misma clave de
localStorage), el latido (`ci_active_sessions` tiene PK `user_email`, una sola
fila) y **el servidor**.

El peor: si el hub toca **una sola celda** de una ruta que la otra pestaña ya
guardó, esa ruta entra al DELETE de `save_ci_batch` y se reinserta solo con lo
que tiene esa pestaña en memoria. **Se pierden en BD las filas de la otra
pestaña, sin ningún error visible.**

_Dirección de fix_: identidad de sesión por pestaña (no por email), o un lock
optimista sobre el borrador.

### P2-13 · El botón promete más de lo que guarda

"Guardar progreso (108)" usa `filledCount`, pero `handleSaveProgress` solo
manda las filas con `rowState === 'full'`. Con 12 filas a medias, el botón dice
108 y el mensaje de éxito dice 96. **Esas 12 celdas viven solo en localStorage**
— si esa laptop se rompe, se pierden.

_Dirección de fix_: que el botón cuente lo que realmente va a persistir, y que
el mensaje distinga "guardado en servidor" de "queda en borrador".

### P2-16 · "Guardando…" puede quedar colgado para siempre

El cliente de Supabase se crea sin timeout. Un request que nunca resuelve (red
que se cae a mitad, no que rechaza) deja los botones deshabilitados
indefinidamente y sin mensaje.

_Dirección de fix_: `AbortSignal.timeout` en el cliente.

---

## Pendientes — el indicador miente

### P2-14 · "✓ Confirmado en servidor hace 4s" puede ser falso

`lastServerOkAt` se actualiza tanto por un guardado real **como por un latido**.
Un latido solo prueba que hay conexión; no guardó ni una celda. El hub puede ver
ese cartel toda la sesión sin haber guardado nada.

En el mismo renglón, "Guardado automáticamente hace Xs" se refiere solo al
borrador local, y el texto no lo aclara en ninguno de los 3 locales. Juntos
comunican "está todo en el servidor" cuando puede no haber nada.

_Es el pendiente que más contradice el pedido de "que estén seguros de que su
data se guardó". Candidato al próximo turno._

### P2-15 · Tras Terminar, la grilla queda vacía y muda 5 minutos

El guard anti-resurrección funciona como se diseñó, pero visualmente es
indistinguible de "perdí todo mi trabajo". Falta un cartel que lo explique.

---

## Pendientes — el cronómetro miente

### P1-3 · Nunca se siembra desde `ci_active_sessions.started_at`

El servidor **ya guarda** el inicio real y lo preserva entre latidos. El cliente
nunca lo lee: las 4 rutas de siembra caen a `Date.now()` cuando el borrador
falla. Además `sessionStartRef` es un `useRef`, violación directa de la regla
"nada de estado solo en memoria para algo que debe sobrevivir un F5".

_Es el fix de fondo del cronómetro: una fuente de verdad server-side que ya
existe._

### P1-4 · Desmontar la página borra la fila entera del latido

El DELETE no está acotado por país/ciudad/zona/fecha — borra la única fila del
hub. Se dispara en **cualquier navegación interna**, no solo al salir: el hub
desaparece de "en vivo" y se pierde el único registro server-side del inicio.
Contradice el criterio que la mig 156 ya estableció server-side.

### P1-5 · Sesión de ayer hereda su `started_at` a la de hoy

El `ON CONFLICT DO UPDATE` actualiza `observed_date` pero deja `started_at`
intacto a propósito. Una sesión que quedó abierta ayer hace que hoy Monitoreo
muestre ~24h, y si un admin la cierra, escribe esa duración en `ci_sessions`.

### P1-6 · Cerrar la laptop infla la duración

No hay detección de inactividad: `elapsed` es reloj de pared puro. 10:00 a
16:30 con la laptop cerrada de 12 a 16 marca 06:30 por ~150 min reales. **Los
dos bugs históricos de `sessionStartRef` conviven hoy, cada uno por su camino.**

### P1-7 · Cambiar la FECHA no toca el cronómetro

Se limpia todo el estado pero `sessionActive` y `sessionStartRef` quedan como
estaban: el próximo "Terminar" inserta una duración que incluye trabajo de otra
fecha.

### P1-8 · `turnoTimingsByCity` no se limpia al Terminar

Volver a la misma ciudad más tarde y tipear una celda revive los timings viejos:
5 minutos de corrección pueden quedar registrados como 360.

### P1-9 · Auto-reload por deploy a mitad de sesión

Cada deploy programa un `location.reload()` a los 60s en la pestaña de todos los
hubs. React **no corre cleanups al descargar la página**, así que el flush no
protege un F5 y se pierden hasta ~1.5s de tipeo (la ventana del debounce).

---

## Pendientes — otros

### P2-11 · Conexión caída al Terminar → filas duplicadas en `ci_sessions`

El INSERT no es atómico con `save_ci_batch`. Si el servidor lo ejecuta pero la
respuesta se pierde, el hub reintenta y quedan dos filas: la duración se cuenta
dos veces en cualquier agregado.

### P2-12 · El auto-load silencioso pisa lo que el hub esté tipeando

`loadObservationsIntoForm` hace reemplazo total, sin fusión. Si el hub empieza a
tipear mientras el auto-load viaja, a los segundos desaparece lo tipeado.

---

## Verificable con 4 queries en producción

Confirman o descartan buena parte de lo de arriba, barato:

```sql
-- 1. Cronómetro reseteado: mucho trabajo en "nada de tiempo"
SELECT * FROM ci_sessions WHERE duration_minutes < 2 AND rows_saved > 20;
-- 2. Laptop cerrada o started_at heredado
SELECT * FROM ci_sessions WHERE duration_minutes > 600;
-- 3. P1-5 confirmado
SELECT * FROM ci_active_sessions WHERE date(started_at) <> observed_date;
-- 4. P2-11: duplicados por reintento
SELECT city, zone, observed_date, user_email, count(*) FROM ci_sessions
GROUP BY 1,2,3,4 HAVING count(*) > 1;
```

---

## Sugerencia de orden

1. **P2-14** (el indicador que miente) — es lo que más contradice "que estén
   seguros de que su data se guardó", y es barato.
2. **P1-3 + P1-4 juntos** — sembrar de `ci_active_sessions.started_at` y dejar
   de borrar esa fila. Arreglan el cronómetro de raíz, no por síntoma.
3. **P1-10** (dos pestañas) — es el único con pérdida de datos en BD.
4. El resto, por severidad.

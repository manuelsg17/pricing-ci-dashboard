# ROADMAP — índice de documentación y cómo retomar

> **Reescrito 2026-09-12.** La versión anterior (última actualización real
> 2026-08-05) tenía una sección "Estado actual"/"Pendientes" que se volvió
> falsa con el tiempo — ej. listaba el refactor de `DataEntry.jsx` como
> pendiente cuando ya se hizo (3516→3307 líneas, 8 hooks propios), y
> `Upload.jsx` a 1113 líneas cuando hoy tiene 696. Es la prueba en carne
> propia de la regla que el archivo mismo advertía: un doc de estado que no
> se toca cada sesión miente, no informa.
>
> La solución no es prometer tocarlo más seguido — ya se prometió antes y no
> pasó dos veces. Es dejar de usarlo para lo que se desactualiza solo (estado,
> pendientes, números de migración) y quedarse solo con lo que no cambia:
> un mapa de qué documento mirar para qué, y cómo arrancar una sesión nueva.
> El estado real de HOY vive en `git log --oneline` y en la memoria de sesión
> del agente — no en un archivo Markdown que nadie actualiza en el momento.

---

## Mapa de documentación de la raíz

| Archivo                      | Qué es                                                                                                   | Vigencia                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                  | Reglas de implementación obligatorias — arquitectura, seguridad, checklist de cierre, proceso.           | **Viva.** Se edita cada vez que un bug real enseña una regla nueva. Es la única fuente de verdad sobre "cómo".                                                               |
| `README.md`                  | Setup del proyecto, cómo correrlo local.                                                                 | Viva, cambia poco.                                                                                                                                                           |
| `CHANGELOG.md`               | Historial de cambios notables por versión.                                                               | Viva.                                                                                                                                                                        |
| `PLAN_MAESTRO.md`            | Auditoría y cierre de la serie de migraciones 183–214 (cuatro rondas adversariales, 2026-08).            | **Histórico, congelado a propósito** — tiene su propio banner de desactualizado. El razonamiento de esa ronda sigue siendo válido como referencia, no como estado de hoy.    |
| `SESIONES_HALLAZGOS.md`      | Los 16 hallazgos del control de sesión de "Ingresar CI" (2026-08-01/02), con repro concreto de cada uno. | **Histórico, cerrado** — los 16 están arreglados (el último, P1-9, el 2026-09-12). Se conserva por el repro documentado de cada bug.                                         |
| `DESPLIEGUE_PENDIENTE.md`    | Por qué dos migraciones puntuales (186, 194) tenían que ir antes que cierto deploy.                      | **Histórico, congelado a propósito** — el propio archivo lo declara: se conserva como ejemplo canónico de acoplamiento migración↔bundle, no por su checklist (ya ejecutado). |
| `COMPETIDOR_BONOS_DESIGN.md` | Diseño del modelo realista de bonos de competidor (Rentabilidad).                                        | Diseño de una feature — vigente como racionalidad, con fases marcadas shipped/pendiente dentro del propio doc.                                                               |
| `PERMISOS_DESIGN.md`         | Diseño del modelo de permisos por sección (`section_write_grants`).                                      | Ídem — diseño de feature, no tracker de estado global.                                                                                                                       |
| `PROYECTOS_DESIGN.md`        | Diseño del módulo Proyectos.                                                                             | Ídem.                                                                                                                                                                        |
| `RENTABILIDAD_DESIGN.md`     | Diseño del rediseño de la vista Rentabilidad.                                                            | Ídem.                                                                                                                                                                        |

**Regla para el futuro**: un doc de diseño de UNA feature (los 4 `*_DESIGN.md`)
puede vivir mucho tiempo sin tocarse porque describe una decisión, no un
estado — eso está bien. Un doc que promete ser "el estado actual del proyecto
entero" (lo que este ROADMAP intentaba ser) se desactualiza en semanas porque
nadie se acuerda de tocarlo a mitad de una sesión de trabajo real. No crear
otro de ese segundo tipo — si hace falta un estado agregado, es una pregunta
para `git log` o para la memoria de sesión, no un archivo nuevo.

---

## Cómo retomar en una sesión nueva

Clonar en `~/Projects/pricing-ci-dashboard` — nunca dentro de una carpeta
sincronizada por Drive/Proton/Dropbox (no preservan exec bits, rompe
`npm install`).

```
Estoy retomando el proyecto. Antes de codear cualquier cosa, leé CLAUDE.md
completo (reglas obligatorias) y confirmá el estado real con `git log
--oneline -20` — no asumas nada de un doc de estado viejo.

Quiero trabajar en [X — describí]. Decime si ya existe una regla o decisión
relevante en CLAUDE.md antes de empezar.
```

Si el tema toca una feature con doc de diseño propio (bonos de competidor,
permisos, proyectos, rentabilidad), leerlo también — son la fuente de la
racionalidad original, aunque no reflejen el código línea por línea de hoy.

# Diseño — Gestión de Proyectos y Tareas (Gantt + Kanban)

Estado: **PLAN, sin implementar**. Escrito 2026-07-31.
Ubicación propuesta: **Gestión de Datos → Proyectos** (junto a Ingresar CI).

---

## 1. Qué problema resuelve

Dos personas distintas con dos necesidades distintas:

|                     | Manuel (PM)                                       | Hub expert                                       |
| ------------------- | ------------------------------------------------- | ------------------------------------------------ |
| **Pregunta diaria** | ¿Quién avanzó, quién está trabado, qué se atrasa? | ¿Qué tengo que hacer hoy?                        |
| **Frecuencia**      | 1 vez por día, en la reunión                      | Varias veces por día                             |
| **Dolor actual**    | No hay visibilidad; hay que preguntar uno por uno | No hay claridad de prioridades ni de "qué sigue" |

El sistema falla si optimiza para uno y castiga al otro. En particular: **si
actualizar el estado le cuesta al hub más de 10 segundos, no lo va a hacer, y
el tablero va a mentir.** Ese es el riesgo número uno de este proyecto, más que
cualquier decisión técnica.

---

## 2. La decisión de diseño más importante

**La pantalla principal NO es el Gantt.** Es una vista "Hoy".

Un Gantt responde "¿cómo viene el proyecto contra el calendario?" — sirve para
planificar y para que el hub vea el panorama de su proyecto. Pero en una
reunión diaria de 15 minutos, leer barras en una línea de tiempo es lento: hay
que buscar visualmente qué cambió.

La reunión diaria necesita un **digest**: qué se movió desde ayer, qué vence
hoy, qué está trabado, qué está por atrasarse. Eso es una lista agrupada por
persona, no un diagrama.

El Gantt y el Kanban existen, pero como vistas secundarias. La app abre en
"Hoy" y desde ahí se navega.

---

## 3. Simulación del día a día

Lo que sigue es el recorrido real de cada persona. Las fricciones que
aparecieron cambiaron el diseño — quedan anotadas porque explican por qué las
cosas son como son.

### 3.1 — Manuel arma un proyecto nuevo (lunes, 20 min)

1. Gestión de Datos → Proyectos → **Nuevo proyecto**.
2. Modal corto: nombre, ciudad, fecha inicio, fecha fin objetivo. Nada más.
3. Cae en la vista del proyecto vacía, con el cursor ya puesto en la primera
   fila de tarea.
4. Escribe el título, `Tab`, elige owner, `Tab`, fechas, `Enter` → se crea la
   tarea y aparece una fila nueva lista para escribir.

> **Fricción encontrada:** el primer diseño abría un modal por cada tarea.
> Cargar 15 tareas eran 15 modales, ~60 clics. Insostenible.
> **Cambio:** alta inline tipo planilla, con `Tab`/`Enter`. El modal queda solo
> para el proyecto (que se crea una vez).

> **Fricción encontrada:** elegir owner con un `<select>` de 30 usuarios es
> lento.
> **Cambio:** combobox con búsqueda (ya existe en `ui/shadcn/combobox.jsx`),
> y los últimos 3 owners usados aparecen primero.

5. Opcional: duplicar un proyecto anterior como plantilla ("Onboarding hub
   nuevo" se repite con cada hub).

### 3.2 — El hub abre la app (martes 8:00, 30 segundos)

1. Entra a Proyectos. Como no es admin, cae directo en **Mis tareas**, no en
   la lista de proyectos.
2. Ve sus tareas ordenadas por vencimiento. Arriba, un renglón: _"3 para hoy ·
   1 vencida · 1 trabada"_.
3. Toca el estado de una tarea → control segmentado
   `Por hacer | En curso | Trabada | Lista`. Un clic, sin modal, sin guardar.
4. Escribe en el campo de comentario de esa fila: _"Terminé las rutas de VES,
   me falta SJM"_ → `Enter`.

> **Fricción encontrada:** en el primer diseño el comentario vivía dentro del
> detalle de la tarea, a 2 clics. Un hub apurado no entra.
> **Cambio:** campo de comentario inline en la fila, siempre visible, con
> placeholder _"¿Qué avanzaste?"_. El detalle completo sigue existiendo para
> quien quiera leer el historial.

> **Fricción encontrada:** marcar "Trabada" sin decir por qué no le sirve a
> nadie.
> **Cambio:** al elegir "Trabada" se pide el motivo en el mismo campo inline
> (obligatorio, una línea). Es el único caso donde se fuerza texto.

### 3.3 — La reunión diaria (miércoles 9:00, 15 min)

1. Manuel abre **Hoy**. Ve, agrupado por persona:
   - **Movido ayer** — tareas que cambiaron de estado, con el último comentario.
   - **Vence hoy**.
   - **Trabadas** — con el motivo, arriba de todo y en rojo.
   - **En riesgo** — vence en ≤2 días y no está "Lista".
2. Recorre hub por hub. Cada bloque es una persona, en orden de urgencia
   (trabadas primero).
3. Si algo necesita replanificarse, cambia la fecha ahí mismo sin salir de la
   vista.

> **Fricción encontrada:** el primer diseño mostraba todas las tareas de todos.
> Con 5 hubs × 10 tareas son 50 filas y la reunión se hace larga.
> **Cambio:** "Hoy" muestra SOLO lo que cambió, vence, está trabado o en
> riesgo. Lo que está tranquilo no aparece. Si un hub no tiene nada, su bloque
> dice "sin novedades" en una línea.

> **Fricción encontrada:** ¿y si un hub no actualizó nada?
> **Cambio:** su bloque muestra _"sin actualizaciones desde el {fecha}"_ en
> ámbar. La ausencia de datos se vuelve visible en vez de parecer "todo bien".

### 3.4 — Manuel revisa el panorama (viernes, 10 min)

1. Va al **Gantt**. Ve todos los proyectos en el tiempo, con línea de "hoy".
2. Filtra por ciudad para ver cómo viene Arequipa.
3. Detecta que dos tareas de un hub se solapan y mueve una arrastrando la barra.

---

## 4. Las cuatro vistas

Un selector arriba, siempre visible: `Hoy · Gantt · Kanban · Mis tareas`.
Los filtros (proyecto, owner, ciudad, estado) viven en una barra común y
**persisten al cambiar de vista** — el mismo patrón que ya usa el Dashboard.

### 4.1 Hoy (pantalla por defecto del admin)

Agrupada por persona. Secciones: Trabadas → Vence hoy → En riesgo → Movido
ayer. Cada fila: tarea, proyecto, estado, último comentario, fecha.

### 4.2 Gantt

- Filas agrupadas por proyecto (colapsables). Cada tarea es una barra.
- Eje temporal con zoom: semana / mes / trimestre. Línea vertical de "hoy".
- Color por estado (mismos tokens que el semáforo del dashboard, para no
  inventar un lenguaje visual nuevo).
- Hover: tooltip con título, owner, fechas, último comentario.
- Arrastrar para mover, borde para redimensionar. **Solo admin** puede.
- **Sin dependencias entre tareas** — decisión deliberada, ver §9.

### 4.3 Kanban

Columnas = los 4 estados. Tarjetas arrastrables. Agrupación conmutable por
proyecto o por persona. Es la vista natural para el hub que trabaja "en lo que
sigue".

### 4.4 Mis tareas (pantalla por defecto del hub)

Lista simple ordenada por vencimiento, con el resumen arriba y el comentario
inline. Es donde el hub va a vivir.

---

## 5. Modelo de datos

```sql
projects (
  id uuid PK, country text NOT NULL, city text NULL,   -- NULL = multi-ciudad
  name text NOT NULL, description text,
  start_date date, end_date date,
  status text NOT NULL DEFAULT 'active',   -- active | done | archived
  created_by text NOT NULL, created_at timestamptz
)

project_tasks (
  id uuid PK, project_id uuid FK ON DELETE CASCADE,
  title text NOT NULL, description text,
  owner_email text NULL,                    -- NULL = sin asignar
  start_date date, due_date date,
  status text NOT NULL DEFAULT 'todo',      -- todo | doing | blocked | done
  sort_order int NOT NULL DEFAULT 0,
  created_by text, created_at, updated_at
)

task_comments (
  id uuid PK, task_id uuid FK ON DELETE CASCADE,
  author_email text NOT NULL, body text NOT NULL,
  kind text NOT NULL DEFAULT 'progress',    -- progress | blocker | system
  created_at timestamptz
)

task_status_log (                            -- alimenta "Movido ayer"
  id bigserial PK, task_id uuid FK ON DELETE CASCADE,
  from_status text, to_status text,
  changed_by text NOT NULL, changed_at timestamptz
)
```

**Por qué "en riesgo" NO es un estado**: es derivado (`due_date - today <= 2 AND
status <> 'done'`). Si fuera un estado, alguien tendría que mantenerlo a mano y
quedaría desactualizado. Se calcula al vuelo.

**Por qué `owner_email` y no `user_id`**: todo el resto del proyecto identifica
por email (`uploaded_by`, `user_email` en `ci_sessions`, las políticas RLS con
`auth.email()`). Cambiar de criterio acá crearía dos identidades conviviendo.

**Escala**: 5 hubs × 5 proyectos × 30 tareas ≈ 750 filas. Consultas directas,
sin vistas materializadas ni agregados. No hace falta nada de la maquinaria del
dashboard.

---

## 6. Permisos

Encaja exactamente con el problema documentado en `PERMISOS_DESIGN.md`, así que
conviene diseñarlo desde el principio con ese modelo en mente.

| Acción                             | Quién                                       |
| ---------------------------------- | ------------------------------------------- |
| Crear/editar/borrar proyectos      | Admin                                       |
| Crear/editar/borrar/asignar tareas | Admin                                       |
| Cambiar estado de una tarea        | Admin, o el **owner** de esa tarea          |
| Comentar                           | Admin, o el owner de esa tarea              |
| Ver                                | Cualquiera con la sección, acotado por país |

RLS (patrón estándar de CLAUDE.md §3):

- `SELECT`: `can_access_country(country)`.
- Escritura de `projects` / `project_tasks`: sección + país.
- **Excepción por dueño**: el `UPDATE` de `project_tasks` limitado a
  `status` y el `INSERT` en `task_comments` se permiten si
  `owner_email = auth.email()`. Un hub no puede cambiar el título, las fechas
  ni el owner de su tarea — solo reportar avance. Esto se hace con una RPC
  acotada (`set_task_status`, `add_task_comment`), no abriendo el UPDATE
  entero, porque una política de columna es más frágil que una función con
  una firma chica.

Sección nueva: `projects`. Se agrega a `ALL_SECTIONS` y a los roles que
correspondan.

---

## 7. Alertas en Monitoreo

Panel nuevo "Tareas en riesgo", con el mismo formato que los paneles que ya
existen ahí:

- **Vencidas** (rojo): `due_date < today AND status <> 'done'`.
- **En riesgo** (ámbar): vence en ≤2 días y no está lista.
- **Trabadas** (rojo): estado `blocked`, con el motivo y desde cuándo.
- **Sin novedades** (ámbar): tarea `doing` sin comentarios hace >3 días.

El umbral de 2 días queda configurable en Config, no hardcodeado.

---

## 8. Telegram — mi recomendación

Planteaste que el detalle vaya por Telegram y el Gantt sea solo el mapa. **No
lo haría así**, por una razón: partir la fuente de verdad. Si el avance se
cuenta en Telegram y el estado vive en la app, en dos semanas no coinciden y
vas a terminar confiando en el chat, que no se puede filtrar ni ordenar.

Pero el instinto detrás es correcto y hay que atenderlo: **el hub ya vive en
Telegram, y entrar a un dashboard para escribir dos líneas es fricción real.**
Se agrava porque este proyecto no tiene diseño responsive (decisión deliberada,
CLAUDE.md §1) — un hub en la calle no puede actualizar desde el celular.

**La forma correcta es Telegram como canal de ENTRADA, no como canal paralelo.**

Un bot que a las 18:00 le escribe a cada hub:

> _Cierre del día. Tenés 2 tareas en curso:_
> _1. Validar rutas TukTuk SJM — ¿avanzaste?_
> _[✅ Lista] [🔄 Sigo] [🚧 Trabada]_

La respuesta escribe en `task_comments` y en `project_tasks.status` igual que
si lo hubiera hecho desde la app. Una sola fuente de verdad, cero fricción, y
el Gantt se actualiza solo.

**Pero va en fase 2**, porque necesita: bot de Telegram, endpoint público para
el webhook, vincular chat_id ↔ email, y manejo de secretos. Es tanto trabajo
como el resto del sistema junto. Primero validemos que el flujo en la app se
usa; si el problema real resulta ser la fricción, el bot se justifica solo y ya
tendrá el modelo de datos listo para escribir.

---

## 9. Fuera de alcance (deliberado)

- **Dependencias entre tareas** ("esta no arranca hasta que termine aquella").
  Es lo que hace complejos a los Gantt de verdad. Con equipos de este tamaño el
  costo de mantenerlas supera el beneficio. Si hace falta, se pone en la
  descripción.
- **% de avance por tarea.** Invita a "estoy al 70%" que no significa nada.
  Cuatro estados y un comentario dicen más.
- **Adjuntos.** Que vayan por Telegram o Drive con el link en el comentario.
- **Notificaciones por email.** Telegram cubre el caso mejor.
- **Responsive.** Coherente con la decisión existente del proyecto. El acceso
  móvil se resuelve con Telegram en fase 2.

---

## 10. Fases

**Fase 1 — El núcleo (lo que hace útil el sistema)**
Migración con las 4 tablas + RLS + las 2 RPCs acotadas. Vistas "Hoy" y "Mis
tareas". Alta inline de proyectos y tareas. Estados y comentarios.
→ Con esto ya podés hacer la reunión diaria. Es el corte mínimo que sirve.

**Fase 2 — Las vistas visuales**
Gantt (con arrastre) y Kanban. Filtros persistentes. Panel en Monitoreo.
→ Acá entra lo "bonito de ver". Va después a propósito: si el núcleo no se
usa, el Gantt no lo salva.

**Fase 3 — Telegram**
Bot, webhook, vinculación de identidad, mensaje de cierre del día.

**Fase 4 — Refinamientos**
Plantillas de proyecto, duplicar proyecto, exportar a PDF para actas.

---

## 11. Detalles de implementación

- **El Gantt se construye con CSS grid**, sin librería nueva. Las barras son
  divs posicionados por aritmética de fechas. El proyecto ya evita
  dependencias pesadas y una librería de Gantt trae su propio sistema de
  estilos que pelearía con Tailwind + shadcn.
- **Drag & drop**: HTML5 nativo, igual que el reordenamiento de secciones que
  ya existe en el Dashboard.
- **Colores por estado**: reutilizar los tokens del semáforo
  (`--sem-green-*`, `--sem-yellow-*`, `--sem-red-*`), no inventar una paleta.
- **i18n obligatorio**: todo string por `t()` en español, inglés y ruso, en el
  mismo commit (CLAUDE.md §6).
- **Realtime**: `RealtimeSyncProvider` ya existe. Suscribir la vista "Hoy" para
  que durante la reunión los cambios aparezcan solos.
- **Tests**: la lógica pura (cálculo de "en riesgo", agrupación por persona,
  aritmética de fechas del Gantt) va a `lib/` con su test, siguiendo lo que
  acabamos de hacer con los parsers de Upload.

---

## 12. Decisiones confirmadas (2026-07-31)

1. **Los hubs ven las tareas de todos**, pero solo pueden tocar las suyas.
   → RLS de `SELECT` solo por país; el gate de dueño va en las RPCs de
   escritura.
2. **Los proyectos son multi-ciudad.** → cambia el modelo, ver §13.1.
3. **Umbral de "en riesgo": 2 días**, configurable.
4. **Se arranca por la Fase 1 completa.**

---

## 13. Segunda ronda de simulaciones

La primera ronda validó el flujo feliz. Esta busca lo que lo rompe: casos
borde, uso sostenido en el tiempo y el efecto de las decisiones de arriba.

### 13.1 — Multi-ciudad rompe el filtro de ciudad ⚠️

Confirmado que los proyectos son multi-ciudad, el modelo original
(`city text NULL`, donde NULL = multi) tiene un agujero: **si filtrás por
"Arequipa", los proyectos multi-ciudad desaparecen** aunque tengan tareas de
Arequipa. Justo los proyectos más importantes se vuelven invisibles al filtrar.

**Cambio al modelo:**

```sql
projects.cities  text[] NOT NULL DEFAULT '{}'   -- {} = todas las ciudades del país
project_tasks.city text NULL                    -- de qué ciudad es ESTA tarea
```

Y el filtro por ciudad matchea si: la tarea es de esa ciudad, **o** el proyecto
la incluye, **o** el proyecto es de alcance total (`cities = '{}'`).

La ciudad a nivel tarea no es un capricho: en un proyecto como "Auditoría de
rutas Q3" las tareas SON por ciudad ("revisar Lima", "revisar Arequipa"), y sin
ese campo no podés preguntarle al tablero "¿cómo viene Arequipa?".

### 13.2 — Actualizar en vivo durante la reunión es contraproducente ⚠️

El diseño original suscribía "Hoy" a realtime para que los cambios aparecieran
solos. Simulando la reunión con pantalla compartida: **una fila que se reordena
o desaparece mientras estás hablando de ella desorienta a todos.**

**Cambio:** "Hoy" NO se auto-actualiza. Cuando llegan cambios muestra un botón
discreto arriba: _"3 actualizaciones nuevas — actualizar"_. Vos decidís cuándo.
En "Mis tareas" y Kanban sí puede ser en vivo, no hay una reunión en curso.

### 13.3 — Tareas sin fecha se vuelven invisibles ⚠️

Una tarea sin `due_date` nunca entra en "vence hoy" ni en "en riesgo" ni en
"vencidas". Desaparece del radar sin que nadie lo note — el mismo patrón de
truncado silencioso que CLAUDE.md §5 prohíbe en los listados.

**Cambio:** se permiten tareas sin fecha (hacen falta para backlog), pero
"Hoy" y "Mis tareas" tienen una sección explícita **"Sin fecha (N)"**, siempre
visible aunque esté vacía. Nada se esconde por omisión.

### 13.4 — "Vence hoy" depende de la zona horaria ⚠️

Con países de Perú (UTC-5) a Nepal (UTC+5:45), calcular "hoy" con `current_date`
del servidor (UTC) hace que a las 19:00 de Lima el sistema ya crea que es
mañana: tareas marcadas como vencidas un día antes. Con un umbral de 2 días,
un error de ±1 día es la mitad de la ventana.

**Cambio:** agregar `timezone` a `country_config` (hoy tiene `locale` pero no
zona horaria) y calcular el "hoy" de cada país con esa zona, tanto en la vista
como en el panel de Monitoreo. Es una columna nueva en una tabla que ya se
edita desde Config.

### 13.5 — Un hub marca "Lista" algo que no lo está

**No agrego aprobación.** Un flujo de aprobación mete fricción y burocracia
para un equipo de 5 personas, y la reunión diaria ya es la verificación: la
tarea aparece en "Movido ayer" con su comentario y ahí se conversa.

**Cambio:** Manuel puede reabrir una tarea (volverla a "En curso"), y cuando
alguien cambia el estado de una tarea ajena se agrega un **comentario de
sistema** automático: _"Manuel reabrió esta tarea"_. Transparencia sin
burocracia — el hub se entera sin que nadie tenga que avisarle.

### 13.6 — Reasignar una tarea

Los comentarios son historia de la **tarea**, no de la persona: se quedan. Se
agrega comentario de sistema _"reasignada de X a Y"_. La tarea sale sola de
"Mis tareas" del anterior porque esa vista filtra por owner.

### 13.7 — Un hub se desactiva y quedan tareas huérfanas

Si `user_profiles.is_active = false`, sus tareas siguen asignadas a alguien que
ya no entra. **No** se bloquea la desactivación (acoplaría dos sistemas), pero
el panel de Monitoreo suma una línea: **"tareas asignadas a usuarios
inactivos"**. Se ve en vez de pudrirse.

### 13.8 — Un hub con 25 tareas en 3 proyectos

Una lista plana ordenada por fecha son 25 filas: un muro.

**Cambio:** "Mis tareas" agrupa en **Vencidas · Hoy · Esta semana · Después ·
Sin fecha**, con las dos primeras abiertas y el resto colapsado. El hub ve 4-6
filas al entrar, que es lo que le importa.

### 13.9 — El primer día, sin datos

Los estados vacíos deciden la adopción. Un tablero en blanco el día 1 se siente
roto.

**Cambio:** estados vacíos que guían, con el patrón de `EmptyState` que ya
existe. Para el admin: _"Todavía no hay proyectos. Creá el primero…"_ con el
botón. Para el hub sin tareas: _"No tenés tareas asignadas"_ — mensaje neutro,
no un error.

### 13.10 — Borrar un proyecto con tareas en curso

`ON DELETE CASCADE` se lleva tareas y comentarios sin aviso, y el historial de
trabajo de los hubs se pierde.

**Cambio:** el borrado desde la UI **archiva** (`status = 'archived'`), no
borra. Los proyectos archivados salen de todas las vistas salvo un filtro
explícito "incluir archivados". El `DELETE` real queda solo para SQL directo.
Mismo criterio que CLAUDE.md §8 sobre no borrar filas de producción a la
ligera.

### 13.11 — Dos personas en la misma tarea

Un solo `owner_email`. **Se mantiene así**: dueño único es lo que hace que "¿de
quién es esto?" tenga respuesta en la reunión. Si un trabajo es de dos, son dos
tareas — y eso además obliga a partirlo, que suele ser lo correcto.

### 13.12 — Edición concurrente

Manuel mueve la fecha mientras el hub cambia el estado. **Ya está resuelto por
el diseño**: las RPCs son acotadas (`set_task_status` solo toca `status`), así
que escriben columnas distintas y no se pisan. Era un riesgo del `UPDATE`
abierto que descartamos en §6.

---

## 14. Cambios al modelo de datos tras la ronda 2

```sql
-- projects
cities      text[] NOT NULL DEFAULT '{}'    -- {} = todas las del país (§13.1)
status      text   NOT NULL DEFAULT 'active' -- active | done | archived (§13.10)

-- project_tasks
city        text   NULL                      -- ciudad de ESTA tarea (§13.1)
due_date    date   NULL                      -- permitido, pero visible (§13.3)

-- country_config
timezone    text   NOT NULL DEFAULT 'UTC'    -- para calcular "hoy" (§13.4)

-- task_comments.kind ya contempla 'system' — se usa para reaperturas y
-- reasignaciones (§13.5, §13.6)
```

---

## 15. Tercera ronda de simulaciones — el paso del tiempo

Las rondas 1 y 2 miraron el flujo y los casos borde. Esta mira qué pasa cuando
el sistema lleva semanas corriendo, que es donde aparece lo que no se ve en una
demo.

### 15.1 — El problema del lunes 🔴 (el más grave de las tres rondas)

"Movido ayer" significa literalmente ayer. **El lunes, "ayer" es domingo: no se
movió nada.** Todo lo que los hubs avanzaron y comentaron el viernes NUNCA
aparece en la reunión del lunes — que es probablemente la reunión más
importante de la semana.

Peor: el bug es silencioso. La pantalla no dice "faltan datos", dice "sin
novedades". Vas a creer que nadie hizo nada el viernes.

**Cambio:** la sección deja de ser "ayer" y pasa a ser **"desde la última
reunión"**, con una ventana que salta los días no hábiles: un lunes muestra
desde el viernes. El encabezado dice explícitamente el rango
(_"Movido desde el viernes 28"_) para que nunca haya que adivinar qué estás
viendo. Y queda un selector `24h · 3 días · 7 días` por si volvés de un feriado
largo o de vacaciones.

Esto también resuelve solo el caso de la reunión salteada: si no te reuniste en
3 días, ampliás la ventana y no perdés nada.

### 15.2 — Asignar a alguien que no puede ver la tarea 🔴

El selector de owner lista usuarios. Pero las políticas RLS filtran por país:
si asignás una tarea de un proyecto de Perú a un hub que solo tiene acceso a
Colombia, **esa persona no puede ver su propia tarea**. La tarea existe, figura
asignada, y es un agujero negro: el hub nunca se entera y vos creés que está
asignada.

**Cambio:** el selector de owner solo lista usuarios activos cuyo rol da acceso
al país del proyecto. Es la misma consulta que ya usa `can_access_country`, del
lado del cliente para el listado y revalidada en la RPC de asignación (nunca
confiar solo en que la UI filtró).

### 15.3 — La tarea marcada "Lista" desaparece al instante ⚠️

El hub termina algo, lo marca, y la fila se esfuma de "Mis tareas". Dos
efectos malos: pierde la sensación de avance del día (que es lo que sostiene el
hábito), y si se equivocó de fila no tiene cómo deshacerlo.

**Cambio:** las tareas marcadas "Lista" **se quedan visibles el resto del día**,
en gris y con un check, bajo un encabezado _"Completadas hoy (N)"_. Al día
siguiente salen solas. El hub cierra la jornada viendo lo que logró, y puede
revertir un clic equivocado.

### 15.4 — Nadie avisa cuando asignás algo nuevo ⚠️

Hasta que exista Telegram (fase 3), el hub se entera de una tarea nueva solo
cuando entra. Si le asignás algo un martes a la tarde, puede que lo vea el
jueves.

**Cambio (barato, sin notificaciones):** un indicador en el ítem de menú y
arriba de "Mis tareas": _"2 tareas nuevas"_, calculado contra la última vez que
el hub abrió la sección. No reemplaza a Telegram, pero cierra el peor caso —
que algo asignado quede sin ver por días.

### 15.5 — Cinco tareas vencen hoy, ¿cuál primero? ⚠️

Sin un criterio, el hub elige por su cuenta y no necesariamente lo que a vos
más te urge.

**Cambio, sin agregar un campo de prioridad:** dentro de cada grupo se ordena
por `sort_order`, que es el orden en que VOS pusiste las tareas en el proyecto.
Así tu orden significa prioridad, se arrastra para reordenar, y no hay un campo
más que mantener ni un "alta/media/baja" que todos marcan en alta.

### 15.6 — Tareas repetitivas ("revisar CI todas las semanas")

Un PM las necesita, pero crear 52 tareas iguales es absurdo y un motor de
recurrencia es un proyecto en sí mismo.

**Decisión: fuera de alcance, y creo que no hace falta.** Lo repetitivo de este
equipo (la carga de CI) ya se controla en Monitoreo, que para eso existe. Este
sistema es para proyectos con principio y fin. Para lo trimestral alcanza con
**duplicar el proyecto anterior** (fase 4), que además deja replanificar fechas
de una.

### 15.7 — Fechas inválidas o en el pasado

Nada impide poner `due_date` anterior a `start_date`, o crear una tarea ya
vencida.

**Cambio:** validación al guardar. `due_date < start_date` se rechaza. Una
fecha de vencimiento en el pasado **se permite** (a veces cargás algo atrasado
a propósito) pero se avisa en el momento: _"esta tarea nace vencida"_. Avisar
en vez de prohibir.

### 15.8 — El hub se toma vacaciones

Sus tareas se vuelven vencidas y ensucian la vista con alarmas que nadie va a
atender.

**Decisión: no agrego un sistema de ausencias** — es un campo, una UI y una
regla más para un caso que se resuelve conversando. Lo que sí ayuda es poder
**correr fechas en lote**: seleccionar varias tareas y desplazarlas N días.
Entra en fase 2. Mientras tanto, "sin novedades desde el X" ya te lo hace
visible en la reunión.

### 15.9 — Una tarea lleva 3 semanas "En curso"

Suele significar que está mal dimensionada, no que el hub sea lento. Es la
señal más útil que puede darte un tablero y ninguna vista la muestra.

**Cambio:** en "Hoy", una tarea con más de 10 días hábiles en `doing` se marca
como **estancada** con un ícono y el conteo de días. No es un estado nuevo, es
un cálculo — igual que "en riesgo". Te da el pie para partirla en la reunión.

### 15.10 — Corregir un comentario mal escrito

**Decisión: los comentarios no se editan ni se borran.** Son una bitácora, y
una bitácora editable no sirve como evidencia de qué se dijo cuándo — mismo
criterio que el `audit_log` del proyecto. Si algo salió mal, se agrega otro
comentario corrigiendo. Si en la práctica molesta, se revisa.

---

## 16. Cambios acumulados de la ronda 3

```sql
-- project_tasks: nada nuevo. "Estancada" y "en riesgo" son cálculos, no
-- columnas — mismo criterio que se aplicó en la ronda 1.

-- Nueva tabla, chica, para 15.4:
section_last_seen (
  user_email text NOT NULL,
  section    text NOT NULL,          -- 'projects'
  seen_at    timestamptz NOT NULL,
  PRIMARY KEY (user_email, section)
)
```

Reglas nuevas del lado del cliente (todas con test, van a `lib/`):

- Ventana "desde la última reunión" que salta días no hábiles (§15.1).
- Filtro de owners elegibles por país del proyecto (§15.2).
- "Completadas hoy" con corte por día en la zona horaria del país (§15.3).
- Detección de tarea estancada: >10 días hábiles en `doing` (§15.9).
- Validación `due_date >= start_date` + aviso de tarea nacida vencida (§15.7).

---

## 17. Fase 1 — alcance cerrado

Con las tres rondas de simulación, esto es lo que entra:

1. Migración: `projects`, `project_tasks`, `task_comments`, `task_status_log`,
   `section_last_seen`, `country_config.timezone`, RLS y las RPCs acotadas
   `set_task_status`, `add_task_comment`, `reassign_task`.
2. Sección `projects` en el router y en `ALL_SECTIONS`.
3. Vista **Hoy** (admin), agrupada por persona, con actualización manual (nunca
   en vivo, §13.2) y secciones: Trabadas → Vence hoy → En riesgo → Estancadas →
   **Movido desde la última reunión** (ventana que salta días no hábiles,
   §15.1) → Sin fecha.
4. Vista **Mis tareas** (hub), agrupada en Vencidas · Hoy · Esta semana ·
   Después · Sin fecha, con **Completadas hoy** (§15.3) e indicador de tareas
   nuevas desde la última visita (§15.4).
5. Alta inline de proyectos y tareas, con el selector de owner **acotado a
   quienes tienen acceso al país del proyecto** (§15.2) y validación de fechas
   (§15.7).
6. Estados de un clic + comentario inline + motivo obligatorio al trabar +
   comentarios de sistema al reabrir o reasignar (§13.5, §13.6).
7. Estados vacíos que guían, i18n en los 3 locales, y tests de la lógica pura
   en `lib/`: ventana de "última reunión", owners elegibles, corte de
   "completadas hoy" por zona horaria, detección de estancadas y validación de
   fechas.

Fuera de la Fase 1: Gantt, Kanban, panel de Monitoreo, Telegram, correr fechas
en lote y duplicar proyecto.

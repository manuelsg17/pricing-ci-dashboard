# Reglas de implementación — pricing-ci-dashboard

Este documento es de cumplimiento obligatorio para cualquier cambio de código en este
repo. No es una lista de sugerencias: cada regla existe porque un bug real, ya
ocurrido y documentado, la hizo necesaria. Cuando una regla y la conveniencia del
momento choquen, gana la regla — o se para y se pregunta antes de romperla.

Antes de implementar algo nuevo: leer la sección relevante de este archivo. Al cerrar
un cambio: repasar el checklist de la sección 7 completo, no una versión abreviada.

---

## 1. Arquitectura del proyecto

- **Stack**: Vite + React (JS, no TS) + Tailwind + shadcn/ui. Supabase (Postgres +
  Auth + RLS) como único backend. Sin framework SSR, sin capa de API intermedia — el
  cliente habla directo con Supabase (`src/lib/supabase.js`) o con RPCs.
- **Decisión de alcance deliberada** (no son huecos, no "arreglar" sin que lo pida el
  user): sin dark mode, sin TypeScript. Los hubs hacen la carga de datos desde PC de
  escritorio.
- **Responsive: alcance ACOTADO, revisado 2026-07-31.** La decisión original era "sin
  responsive" porque los hubs trabajan desde PC. Sigue siendo cierto para la carga de
  datos — nadie llena una grilla de 108-324 celdas desde un teléfono — pero dejó de
  serlo para las vistas de lectura y de marcado rápido (Proyectos, Monitoreo,
  Dashboard): marcar una rutina diaria o mirar quién está atrasado antes de una
  reunión son acciones de celular. Regla:
  - **Entra en responsive**: Proyectos, Monitoreo, Dashboard y cualquier vista nueva
    de lectura o de interacción liviana. Objetivo: legible y operable a 390px.
  - **Queda fuera a propósito**: la grilla de Ingresar CI y Upload. Un layout
    responsive ahí arriesga los fixes P0/P1 de re-render ya hechos (§5) a cambio de un
    caso de uso que no existe.
  - Todo lo nuevo nace responsive. Lo viejo se migra cuando se toca, no en un barrido.
  - `tailwind.config.js` tiene **preflight deshabilitado** — los breakpoints (`sm:`,
    `md:`…) funcionan igual, pero no hay reset de estilos base: verificar en navegador,
    no asumir.
- **Tests E2E de navegador: pendiente de adopción, ya no es un "no".** La decisión
  original se tomó cuando no había un entorno local reproducible; desde que
  `supabase start` funciona (2026-07-31) el motivo desapareció. La clase de bug más
  cara y más repetida de este proyecto (supervivencia de estado a un F5 real,
  guards anti-resurrección, sesiones compartidas) es exactamente la que un E2E caza y
  un test unitario no. Ver §7.6: hoy ese flujo se cubre a mano y depende de que alguien
  se acuerde de hacerlo.
- **RPCs como patrón canónico** para lógica de negocio no trivial o que cruza tablas —
  no lógica de negocio duplicada en el cliente si ya existe una RPC equivalente.
  Los RPCs de dashboard con sufijo `_fast` leen materialized views (MV), no las tablas
  crudas — no agregar una query directa a `pricing_observations` para algo que el
  dashboard ya resuelve vía MV, se rompe la paridad de rendimiento.
- **`ConfigProvider`** para configuración de solo lectura compartida entre páginas
  (países, categorías, brackets) — no volver a fetchear lo que el provider ya expone.
- **Namespaces de identidad de "bucket" en `DataEntry.jsx`**: `uiCity` (lo que ve el
  hub) vs `dbCity`/`bucketKey` (lo que persiste en BD) vs `viewId` (clave de
  localStorage) NO son intercambiables — Aeropuerto y TukTuk tienen un `uiCity` que no
  coincide 1:1 con `bucketKey`. Bug real cuando se mezclaron (pérdida silenciosa de
  trabajo del hub, sesión 2026-07-24) — cualquier estado nuevo de sesión/alcance debe
  vivir explícitamente en el namespace correcto, y si hay ambigüedad, unificar temprano
  en vez de traducir en cada punto de uso.
- **`DataEntry.jsx` es un god-component conocido** (deuda P2 documentada, sin fecha).
  No es excusa para seguir apilando lógica ahí sin criterio, pero tampoco se justifica
  una refactorización grande no pedida a mitad de un fix — si el cambio es
  estructuralmente grande, plantearlo aparte antes de mezclarlo con un bugfix.

---

## 2. Buenas prácticas de código (React / JS)

- **Nada de estado "solo en memoria" para algo que debe sobrevivir un F5.** Un
  `useRef`/`useState` se pierde en cualquier recarga real de página. Si un dato debe
  persistir (progreso de sesión, timestamps de inicio, flags de "recién terminado"),
  espejarlo en `localStorage` explícitamente. Bug real (2026-07-24/25): un guard
  anti-resurrección vivía solo en un `useRef` y no protegía contra un F5 real — el
  ataque/escenario que más probablemente lo disparaba.
- **Nunca resetear un timestamp de "inicio" a `Date.now()` al reanudar trabajo
  existente.** Si hay una fuente de verdad más antigua disponible (otro timestamp ya
  estampado, un registro en BD), sembrar desde ahí y caer a `Date.now()` SOLO si de
  verdad es un arranque nuevo. Confundir "continuar" con "empezar de cero" ya causó
  dos bugs de dirección opuesta en el mismo campo (`sessionStartRef`): nunca resetear
  (inflaba duración) y resetear siempre (la vaciaba a segundos).
- **Auto-loads/refrescos "silenciosos" nunca deben pisar una acción explícita reciente
  del usuario.** Si el usuario acaba de cerrar/terminar/borrar algo a propósito, un
  efecto en segundo plano que repuebla estado desde el servidor puede "resucitarlo" —
  hay que guardar una marca de "esto se cerró a propósito, no lo repueble por un rato"
  con ventana explícita, no asumir que el estado vacío siempre significa "nunca se tocó".
- **Cuidado con los efectos que dependen de `Object`/`Set`/`Array` recreados cada
  render.** Comparar `nuevo !== viejo` tras un spread siempre da `true` (nueva
  referencia) — usar un booleano explícito de "cambió" o comparar por valor, no por
  identidad, si la lógica depende de detectar cambios reales.
- **DELETE + INSERT idempotente por ruta exacta**, nunca por categoría/franja
  completa — dos rutas pueden compartir categoría+franja+bracket (TukTuk por
  distrito) y un borrado demasiado amplio se lleva puesta una ruta hermana con
  trabajo parcial ya guardado.
- **Guardado con dueño explícito (`uploaded_by`)** en cualquier flujo de
  guardar/recargar compartido entre usuarios — sin esto, un auto-load puede traer
  filas de OTRO hub y, al re-guardar, duplicarlas (mig 139).
- **No usar `Date.now()` / `Math.random()` / `new Date()` sin argumentos en código que
  corre dentro de un Workflow** (rompe el resume) — no aplica a `DataEntry.jsx` en
  producción normal, pero si se automatiza algo de este repo vía Workflow, tenerlo
  presente.
- **Nunca fabricar filas de `auth.users` a mano vía SQL directo** para pruebas —
  faltan columnas/relaciones internas que GoTrue necesita y rompe el login con errores
  opacos ("Database error querying schema"). Usar siempre el Admin API
  (`POST /auth/v1/admin/users`) o el flujo normal de invitación.

---

## 3. Seguridad — para ser inhackeables

Este proyecto tuvo fugas de RLS reales y explotables (no teóricas) en al menos 3
rondas de migraciones (mig 60-66, mig 130, mig 164-165). El patrón se repite porque
Postgres combina políticas RLS **permisivas con OR** — una política vieja y laxa
conviviendo con la nueva y correcta gana en silencio, sin error, sin log.

- **Antes de cerrar CUALQUIER trabajo que toque políticas RLS**, correr
  `npm run check:rls-drift` (o el equivalente ya existente en
  `scripts/check-rls-policy-drift.sql`) contra local Y contra producción. Una tabla
  con 2+ políticas para el mismo comando (`cmd`) no es automáticamente un bug, pero
  exige revisión manual antes de asumir que es intencional.
- **Al reemplazar una política vieja, `DROP POLICY IF EXISTS` explícito antes de
  `CREATE POLICY`** — nunca asumir que la nueva "gana". Mismo criterio para RPCs:
  `CREATE OR REPLACE FUNCTION` con una firma de parámetros distinta NO reemplaza la
  función vieja, crea un OVERLOAD — PostgREST no puede elegir entre las dos
  (`PGRST203`) y el camino que dependía de esa función se rompe en silencio para
  cualquier cliente con bundle viejo en caché. Siempre `DROP FUNCTION` de la firma
  vieja al cambiar parámetros de una RPC ya expuesta.
- **Toda tabla/vista/materialized view NUEVA hereda por defecto permisos amplios para
  `anon`/`authenticated`** en este proyecto (`ALTER DEFAULT PRIVILEGES` histórico
  demasiado laxo, ya cerrado hacia adelante pero el hábito de verificar debe
  mantenerse). Después de crear cualquier objeto nuevo: verificar `pg_class.relacl`
  directamente — **`information_schema` NO lista materialized views**, un `\d` normal
  no alcanza.
- **Toda vista plana debe tener `security_invoker = true`** salvo que corra
  deliberadamente con privilegios del dueño (y esa excepción debe estar documentada
  con el motivo). Sin esto, una vista bypasea RLS de las tablas que consulta.
- **Toda función `SECURITY DEFINER` debe fijar `search_path`** (`SET search_path TO
'public', 'pg_temp'` o equivalente) — un `search_path` mutable es una vía de
  escalación de privilegios clásica.
- **Patrón de gating estándar para políticas RLS de este proyecto**: `SELECT` filtra
  por `can_access_country(country)`; escritura (`INSERT`/`UPDATE`/`DELETE`) filtra por
  `can_access_country(country)` si cualquier hub con acceso al país debe poder
  escribir, o por `can_edit()` (solo admin) si es una tabla administrativa. Nunca
  dejar una tabla nueva con `USING (true)` sin justificar por qué es un catálogo
  legítimamente compartido entre países (y documentarlo en el mismo archivo de
  migración).
- **Envolver `auth.email()`/`auth.uid()` en `(select ...)`** dentro de políticas RLS
  nuevas — evita que Postgres los reevalúe fila por fila (InitPlan una sola vez por
  consulta) y es tanto una optimización de rendimiento como una práctica de higiene.
- **Nunca ejecutar una migración de producción sin haberla validado antes en local**
  (`supabase db reset` limpio + verificación manual de las políticas resultantes) — y
  nunca aplicar una migración a producción sin una confirmación explícita del user
  para ESA migración puntual, aunque ya haya dado un OK general más amplio antes.
- **Rotación/exposición de credenciales**: nunca commitear tokens, service role keys,
  ni contraseñas — ni en código, ni en archivos de config trackeados, ni en mensajes
  de commit. Si una acción requiere el Admin API con `service_role`, mantenerla fuera
  del bundle del cliente. **Una credencial expuesta se considera comprometida desde el
  segundo cero**: rotarla de inmediato y revisar el uso. Borrarla del último commit NO
  alcanza — queda en el historial, en los forks y en cualquier caché de la plataforma.
- **Deny by default en toda tabla nueva expuesta por la Data API**: habilitar RLS en el
  MISMO cambio que crea la tabla, y conceder a `anon`/`authenticated` solo los grants
  mínimos. RLS y GRANT son controles complementarios, no alternativos — el permiso se
  evalúa ANTES que la política, así que una tabla con RLS impecable y un grant amplio
  sigue estando abierta.
- **Una política por operación, con `TO` explícito.** `USING` filtra las filas que ya
  existen; `WITH CHECK` valida el estado nuevo. Un `UPDATE` sin `WITH CHECK` deja
  mover una fila fuera del alcance del propio usuario.
- **Una política RLS no puede restringir por COLUMNA.** Si el usuario solo debe poder
  cambiar un campo, la política no alcanza: va por RPC `SECURITY DEFINER` que valide y
  escriba solo lo permitido. La UI muestra un botón; la API no es la UI (patrón ya
  usado en mig 183/184 para que un hub cambie estado sin poder tocar título ni dueño).
- **Nunca autorizar con `user_metadata`** — es editable por el propio usuario. Usar
  tablas de roles protegidas o claims administrativos.
- **Matriz mínima al tocar RLS**: `anon`, autenticado dueño, autenticado NO dueño, y
  cruce de país. Verificar tanto lo permitido como lo denegado, y que una consulta
  denegada no filtre la EXISTENCIA de datos ajenos (un `count` o un error distinto ya
  es una fuga).
- **Nunca usar `service_role` para que pase una prueba que pretende validar RLS.** Es
  la forma más eficiente de tener una suite verde sobre una base abierta.
- **Validar toda entrada en el límite del servidor**, no solo en el formulario. Y no
  filtrar SQL, stack traces ni nombres de políticas en errores visibles al usuario.

---

## 4. Optimización de base de datos

- **El dashboard vive de materialized views, no de queries en vivo sobre datos
  crudos.** `pg_cron` las refresca en un horario fijo — cualquier feature nueva de
  analítica debe apoyarse en una MV existente o proponer una nueva, no hacer joins
  pesados en cada carga de página.
- **Índices alineados al patrón de consulta real**, no genéricos — antes de agregar
  una tabla grande a un flujo caliente, confirmar qué WHERE/ORDER BY se va a usar y
  indexar eso específicamente.
- **Inserts en lote, no fila por fila.** El patrón ya usado (`performSave` en
  `DataEntry.jsx`) inserta en batches de 200 — cualquier flujo nuevo de escritura
  masiva debe seguir el mismo criterio, no un loop de inserts individuales.
- **Antes de escalar el compute o el plan de Supabase, medir primero** —
  `pg_stat_statements` por `shared_blks_read` para saber si el costo real es de la app
  o de un proceso en segundo plano (pg_cron resultó ser el 100% del Disk IO en una
  ocasión, no la app — mig 162).
- **Particionar tablas grandes ANTES de que crezcan, no cuando ya duelen.** Migrar la
  estructura de una tabla de 1-2M filas es barato; hacerlo con 20-30M es caro y
  riesgoso. Si se detecta que una tabla va a esa escala, plantear el particionado como
  tarea propia, no esperar a que sea urgente.
- **Ningún trigger de normalización debe vivir en un solo lugar si el dato entra por
  múltiples caminos.** `competition_name`/`distance_bracket` tuvieron divergencia real
  entre el trigger SQL, el sync del bot, y el upload manual — cualquier lógica de
  normalización nueva debe auditarse contra TODOS los caminos de entrada de datos, no
  solo el que se está tocando. Hay un script de chequeo
  (`scripts/check-normalization-drift.sql`) — correrlo si se toca normalización.
- **Cambios incompatibles de esquema: expandir → desplegar → backfill → verificar →
  contraer**, en releases separadas. Renombrar o borrar una columna en el mismo deploy
  que la deja de usar rompe a cualquier cliente con el bundle viejo todavía cargado —
  y en esta app el hub puede tener la pestaña abierta desde ayer. Primero se agrega lo
  nuevo, después se migra el dato, y solo cuando nadie lee lo viejo se borra.
- **Preferir migraciones correctivas hacia adelante** antes que un rollback de SQL. Un
  rollback solo es aceptable si fue diseñado y probado como parte del cambio.
- **Un backfill debe ser reanudable, acotado y observable** — nada de un UPDATE sin
  WHERE sobre una tabla de millones de filas. Y en producción, con autorización
  explícita para ESE backfill (§3, §8).

---

## 5. Optimización de navegador / frontend

- **Nunca vaciar el estado en memoria de forma más agresiva de lo necesario** solo
  para "prevenir" un bug — si el guard real (ej. anti-resurrección) ya protege el
  síntoma, no hace falta descartar datos que el usuario podría seguir necesitando ver.
- **Debounce + flush explícito en cambios de contexto.** El patrón ya usado
  (autosave con debounce de ~1.5s + flush síncrono en el cleanup del efecto al
  cambiar de ciudad/fecha o salir de la página) debe respetarse para cualquier
  autosave nuevo — sin el flush, cambiar de contexto rápido pierde los últimos
  cambios sin guardar.
- **Todo array/objeto que se pasa como dependencia de un efecto y no cambia entre
  renders debe tener identidad estable** (constante a nivel de módulo, tipo
  `EMPTY_OBJ`/`EMPTY_SET`) — si no, el efecto se re-dispara en cada render aunque el
  dato "lógicamente" sea el mismo.
- **Paginación sin truncado silencioso.** Cualquier listado que pueda crecer debe
  paginar explícitamente o avisar cuando hay más datos de los mostrados — nunca cortar
  en un límite fijo sin dejarlo visible al usuario (bug real P0 corregido en la
  auditoría arquitectónica 2026-07-24).
- **Grillas grandes (la de Ingresar CI, 108-324 celdas): evitar re-render de toda la
  grilla por un cambio en una sola celda** — ya hubo un fix P0/P1 de rendimiento ahí,
  cualquier cambio nuevo a ese componente debe verificar que no reintroduce
  re-renders masivos (usar el profiler de React si hay duda).
- **Dependencias de terceros parcheadas (ej. xlsx vía CDN de SheetJS) no se
  actualizan "de paso"** — si hay que tocar esa área, confirmar primero por qué está
  parcheada antes de asumir que un `npm update` es seguro.

---

## 6. i18n — obligatorio, sin excepciones

- **Todo string visible para el usuario pasa por `t()` (`src/lib/i18n.js`), en los 3
  locales activos: español, inglés, ruso.** Nunca hardcodear texto en JSX, ni "por
  ahora", ni en un mensaje de error nuevo, ni en un tooltip.
- Al agregar una clave nueva, agregarla en los 3 bloques de `i18n.js` en el mismo
  commit — no dejar un locale pendiente "para después". Un texto sin traducir en
  inglés/ruso se nota inmediato para cualquier hub que no use español.
- **Excepción ya documentada y aceptada**: los nombres de brackets/turnos que vienen
  de `Config` (datos, no strings de UI) no pasan por i18n — son configuración, no
  texto de interfaz. No confundir ese caso con un string de UI real que sí necesita
  traducción.
- Antes de dar un feature de UI por terminado: buscar en el diff cualquier string
  literal en español metido directo en JSX (`grep` rápido por comillas con texto
  capitalizado ayuda) y confirmar que no quedó ninguno.

---

## 7. Checklist obligatorio antes de mandar algo a producción

Ejecutar TODO lo aplicable al cambio, en este orden. No es opcional recortarlo porque
"es un cambio chico" — los bugs más caros de este proyecto fueron cambios que parecían
chicos.

1. **`npm run lint`** — cero warnings, no solo cero errores (`--max-warnings 0`).
2. **`npm run build`** — sin errores de compilación.
3. **`npm run test:all`** — las 21 suites en verde. Si el cambio afecta lógica pura
   (parseo, normalización, cálculo), agregar un test nuevo al set en vez de confiar
   solo en verificación manual.
4. **Si el cambio toca RLS/políticas/permisos**: `check:rls-drift` local Y prod,
   `pg_class.relacl` para objetos nuevos, `pg_proc.proconfig` para funciones
   `SECURITY DEFINER` nuevas.
5. **Si el cambio toca una migración SQL**: `supabase db reset` limpio en local
   primero, verificación manual de las políticas/funciones resultantes, y recién
   después aplicar a producción — con una confirmación explícita del user para ESA
   migración puntual.
6. **Si el cambio toca UI de Ingresar CI/Monitoreo (o cualquier flujo de sesión)**:
   reproducir en navegador contra Supabase LOCAL (nunca contra producción) el flujo
   real de un hub, incluyendo:
   - Completar y guardar/terminar normalmente.
   - **F5 real de página** en cada punto donde el estado debería sobrevivir (no solo
     navegación interna de React) — la clase de bug más repetida en este proyecto
     ocurre específicamente en el camino de recarga real.
   - Si el cambio toca sesiones compartidas entre hubs (relevo, reasignación): probar
     con 2 usuarios reales (creados vía Admin API, nunca INSERT manual a
     `auth.users`), no solo con el usuario admin.
   - Confirmar en la base de datos (no solo en la UI) que no quedaron filas
     duplicadas ni datos huérfanos tras el flujo completo.
7. **Revisión adversarial** para cualquier feature no trivial o fix de bug con
   impacto real: al menos un agente/pasada independiente que intente refutar el
   fix o encontrarle un caso borde, ANTES de dar el trabajo por cerrado — el patrón de
   "un agente de lógica cliente + uno de SQL + uno de componentes nuevos, cada uno
   buscando bugs con repro concreto" encontró bugs reales que lint/build nunca iban a
   cazar. No cerrar una sesión de trabajo grande sin esta pasada.
8. **Barrido de datos reales post-deploy** cuando el bug tenía evidencia en
   producción: confirmar con una query directa que el patrón del bug no sigue
   ocurriendo (no asumir que el fix funcionó solo porque el código "se ve bien").
9. **i18n**: confirmar que ningún string nuevo quedó sin las 3 traducciones.
   9b. **Si el cambio toca una vista dentro del alcance responsive (§1)**: verificarla a
   390px además de escritorio — que no haya scroll horizontal, texto cortado ni
   controles inalcanzables.
10. **Limpieza de entorno de prueba**: si se usó Supabase local con datos/usuarios de
    prueba, borrarlos y `supabase stop` al terminar — nunca dejar residuos que
    puedan confundir la próxima sesión de trabajo.

---

## 8. Proceso — reglas de trabajo en este repo

- Paths absolutos al editar archivos.
- Commits incrementales, con mensaje que explique el POR QUÉ del cambio (causa raíz,
  no solo qué se tocó) — el estilo de mensaje ya usado en este repo (contexto +
  causa raíz + fix + validación) es el estándar a seguir.
- Push después de cada sub-fase de trabajo terminada y validada, no acumular cambios
  grandes sin subir.
- `package.json` y `package-lock.json` se commitean SIEMPRE juntos — el deploy usa
  `npm ci`, que es estricto y falla si divergen.
- Nunca borrar filas de producción sin que el user lo haya autorizado nombrando la
  acción específica (tabla, filas, motivo) — una autorización general ("arreglá todo")
  no cubre por sí sola un DELETE en una tabla compartida; confirmar la acción puntual
  antes de ejecutarla.

---

## 9. Entornos, despliegue y rollback

Este proyecto tiene DOS entornos reales: **local** (Supabase en Docker) y
**producción**. No hay Preview ni Staging, y no hace falta inventarlos para un
proyecto de un solo desarrollador — pero eso significa que **local es la única red de
seguridad que existe**, así que no es opcional.

- **Local es el destino por defecto** de desarrollo, migraciones y pruebas.
  `npx supabase start` levanta el stack; `npx supabase stop` lo apaga conservando los
  datos. Nunca probar contra producción algo que local puede responder.
- **`supabase db reset` es local; `--linked` es producción.** No son variantes del
  mismo comando: uno reconstruye la base de Docker y el otro destruye la base remota.
  **`db reset --linked` está prohibido en este proyecto, sin excepciones.** Escribir
  siempre el flag explícito, no confiar en el default del subcomando.
- **Antes de CUALQUIER comando remoto, verificar a qué proyecto está enlazada la CLI.**
  No confiar en el link que la CLI recuerda de la sesión anterior — es exactamente el
  camino por el que una migración de prueba termina en producción.
- **Un rollback del deploy NO revierte la base de datos.** Volver al build anterior
  deja el esquema nuevo intacto, y con él cualquier columna borrada o constraint
  agregada. Por eso los cambios incompatibles se parten en releases (§4) y la ventana
  de rollback exige que la versión anterior de la app siga funcionando contra el
  esquema nuevo.
- **Una sola autoridad aplica migraciones.** Nunca a la vez desde la CLI y desde el
  Dashboard de Supabase — un cambio hecho a mano en el Dashboard queda fuera del
  historial versionado y aparece después como drift inexplicable.
- **El deploy corre `npm ci`, `npm run test:all` y `npm run build`** antes de publicar
  (`.github/workflows/deploy.yml`). Si un test falla, el deploy se aborta: eso es
  deliberado y no se saltea. `npm run lint` todavía NO está en CI — hasta que lo esté,
  correrlo a mano es obligatorio (§7.1).

---

## 10. Seguridad operativa e incidentes

Si se detecta pérdida o corrupción de datos, exposición de credenciales, acceso
indebido o una regresión grave en producción:

1. **Parar** las mutaciones y deploys relacionados. No seguir "arreglando" a ciegas.
2. **Informar de inmediato** qué se sabe: alcance, entorno, hora aproximada y qué
   todavía no se sabe. Un reporte incompleto y a tiempo vale más que uno completo y
   tarde.
3. **Preservar la evidencia** — logs, filas afectadas, queries de diagnóstico — antes
   de tocar nada. Nunca copiar secretos como parte de esa evidencia.
4. **Contener** con el mínimo daño: deshabilitar el flujo, revertir la app o revocar la
   credencial. Rotar cualquier secreto involucrado (§3).
5. **Medir el impacto real** con una query directa, no por inspección del código.
6. **Recuperar**, verificar el servicio y los controles de acceso, y recién ahí cerrar.
7. **Documentar** cronología, causa raíz y qué lo previene la próxima vez — en el
   commit y en este archivo si genera una regla nueva.

**La urgencia no elimina la confirmación para una operación destructiva.** Un incidente
es precisamente cuando más caro sale un DELETE apurado sobre la tabla equivocada. Si
hace falta destruir algo para contener, se pide igual — solo que primero.

---

## 11. Cómo se entrega un cambio

No usar "todo funciona" como sustituto de evidencia. Si algo no se pudo ejecutar, se
dice cuál y por qué — nunca se omite ni se da por hecho.

```text
Resultado      — qué se logró y para qué.
Cambios        — archivos/áreas principales y las decisiones que importan.
BD y seguridad — migraciones, RLS, RPCs, permisos. "No aplica" si corresponde.
Validación     — comando o prueba : resultado REAL. Verificación manual : resultado.
Despliegue     — pasos, orden, y cómo se revierte (o "no aplica").
Pendientes     — lo no ejecutado, el motivo, los supuestos y qué sigue.
```

Reglas de honestidad, todas con antecedente en este proyecto:

- **No afirmar que una prueba pasó si no se ejecutó**, ni que un fix funciona porque el
  código "se ve bien" (§7.8 pide el barrido de datos reales por esto).
- **No ocultar advertencias, drift ni trabajo incompleto** para cerrar más rápido.
- **No inventar comandos, archivos, métricas ni estados de despliegue.** Si un script
  no existe, se informa el hueco.
- **Corregirse rápido y sin ceremonia** cuando un diagnóstico resultó equivocado: ya
  pasó con una fuga de RLS que era un falso positivo del advisory y con una supuesta
  discrepancia del dashboard que era un artefacto de la query de verificación. El costo
  de un diagnóstico equivocado que se sostiene es mucho mayor que el de admitirlo.

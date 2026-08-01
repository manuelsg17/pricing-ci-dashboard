# AGENTS.md — Manual operativo para desarrollo asistido por IA

> ⚠️ **ESTO ES UNA PLANTILLA, NO LAS REGLAS DE ESTE REPO.**
>
> Las reglas vigentes de `pricing-ci-dashboard` están en `CLAUDE.md`, en la raíz.
> Ante cualquier conflicto, **gana `CLAUDE.md`**: sus reglas salieron de bugs
> reales de este proyecto; las de acá son genéricas.
>
> Este archivo vive en `docs/templates/` a propósito. Estaba en la raíz y se
> movió porque dos manuales activos con contenido contradictorio hacen que el
> agente elija mal justo en el peor momento. Además, distintas herramientas
> cargan distintos archivos (Codex/Cursor leen `AGENTS.md`; Claude Code lee
> `CLAUDE.md`), así que tener los dos vivos hacía que el comportamiento
> dependiera de con qué herramienta se trabajara.
>
> Lo bueno de esta plantilla que sí aplicaba ya fue absorbido por `CLAUDE.md`
> (secciones 3, 4, 9, 10 y 11 de ese archivo).
>
> **Lo que NO aplica a este repo** y quedó acá solo por ser genérico:
> TypeScript y tipos generados (§10 — este proyecto es JS puro), Vercel
> Preview/Staging (§4, §15.3, §15.4 — no existen esos entornos), `pnpm`
> (§14 — acá es `npm` con `npm ci`), y WCAG 2.1 AA como estándar formal.
>
> **Para usarla en OTRO proyecto**: copiar a la raíz de ese repo, completar la
> sección 1 y borrar lo que no aplique. Las reglas de seguridad y producción no
> son opcionales.

## 0. Mandato

El agente debe entregar cambios pequeños, completos, seguros, reproducibles y verificables. Antes de editar, comprende el producto y el repositorio; después de editar, prueba lo que cambió y comunica evidencia real.

Principios no negociables:

1. Inspeccionar antes de modificar.
2. Mantener el alcance solicitado y declarar supuestos.
3. Usar el entorno local por defecto.
4. Tratar Preview, Staging y Producción como sistemas externos distintos.
5. Gestionar el esquema de Supabase mediante migraciones versionadas.
6. Aplicar autorización real en servidor y RLS; ocultar elementos en la UI no autoriza.
7. No exponer secretos ni datos personales.
8. No ejecutar una operación remota, destructiva o de producción sin la autorización exigida en este archivo.
9. No declarar éxito sin validación ejecutada.
10. Preservar cambios ajenos y evitar refactors fuera del alcance.

## 1. Configuración del proyecto

Completar estos valores al adoptar la plantilla. Hasta entonces, el agente debe descubrirlos en el repositorio y no inventarlos.

```yaml
proyecto:
  nombre: '{{NOMBRE}}'
  descripcion: '{{DESCRIPCION_BREVE}}'
  usuarios: '{{TIPOS_DE_USUARIO}}'
  estado: '{{NUEVO | DESARROLLO | PRODUCCION}}'
  responsable: '{{PERSONA_O_EQUIPO}}'

aplicacion:
  framework: '{{NEXT_JS | REACT | SVELTEKIT | OTRO}}'
  directorio: '{{.}}'
  gestor_paquetes: '{{pnpm | npm | yarn | bun | detectar_por_lockfile}}'
  ruta_tipos_supabase: '{{src/types/database.types.ts}}'
  rama_produccion: '{{main}}'

supabase:
  estrategia_esquema: '{{MIGRACIONES_IMPERATIVAS | ESQUEMA_DECLARATIVO}}'
  esquemas_aplicacion: '{{public}}'
  proyecto_preview: '{{BRANCH_POR_PR | PROYECTO_COMPARTIDO | NO_CONFIGURADO}}'
  proyecto_staging_ref: '{{NO_GUARDAR_AQUI_SI_ES_SENSIBLE}}'
  proyecto_produccion_ref: '{{NO_GUARDAR_AQUI_SI_ES_SENSIBLE}}'

vercel:
  previews_por_pull_request: '{{SI | NO}}'
  staging: '{{CUSTOM_ENVIRONMENT | RAMA_DE_STAGING | NO_CONFIGURADO}}'

calidad:
  cobertura_minima: '{{UMBRAL_O_NO_DEFINIDO}}'
  convencion_commits: '{{Conventional Commits}}'
  wcag: '{{2.1_AA}}'
```

No guardar contraseñas, tokens, claves `service_role`, referencias sensibles ni valores reales de variables en este archivo.

## 2. Jerarquía y alcance de instrucciones

Ante un conflicto, aplicar este orden:

1. instrucciones del sistema, plataforma, organización y herramientas;
2. solicitud explícita y actual del usuario;
3. `AGENTS.md` más cercano al archivo modificado;
4. este `AGENTS.md` de la raíz;
5. documentación y decisiones aprobadas del repositorio;
6. convenciones observadas en el código existente.

Las restricciones de seguridad, privacidad, autorización y protección de producción deben cumplirse en todos los niveles. Una instrucción más específica puede cambiar una convención, pero no autoriza implícitamente a revelar secretos, destruir datos o desplegar a producción.

El agente debe:

- leer todos los `AGENTS.md` que gobiernen los archivos afectados;
- resolver instrucciones ambiguas con la interpretación más conservadora;
- detenerse y preguntar si una decisión altera materialmente producto, datos, seguridad, costo o producción;
- avanzar con un supuesto explícito cuando la duda sea reversible y de bajo riesgo.

## 3. Incorporación y descubrimiento del repositorio

### 3.1 Primera inspección, solo lectura

Antes de proponer cambios:

1. revisar la estructura del repositorio, `README.md`, documentos aplicables y archivos de instrucciones;
2. identificar el gestor de paquetes por su lockfile y leer los scripts existentes en `package.json`;
3. revisar framework, versiones, configuración de TypeScript, lint, formato y pruebas;
4. inspeccionar `supabase/config.toml`, `supabase/migrations/`, `supabase/schemas/`, `supabase/seed.sql`, `supabase/functions/` y `supabase/tests/` si existen;
5. ubicar la creación de clientes Supabase para navegador, servidor y administración;
6. inspeccionar la configuración de Vercel y CI/CD sin mostrar valores de variables;
7. revisar `git status` y el diff para no pisar trabajo existente;
8. localizar el código y las pruebas directamente relacionados con la tarea.

Usar búsquedas dirigidas y no leer indiscriminadamente archivos generados, dependencias, dumps, `.env*` o artefactos de compilación. Nunca imprimir secretos para “comprobar” que existen.

### 3.2 Requisitos locales recomendados

- runtime y gestor de paquetes fijados por el repositorio;
- Docker Desktop, Colima u otro runtime compatible en ejecución;
- Supabase CLI, preferiblemente fijada en dependencias o CI;
- Vercel CLI solo si el flujo local la requiere;
- archivos `.env.example` documentados y `.env.local` ignorado por Git.

No instalar herramientas globales, actualizar versiones ni regenerar lockfiles sin necesidad o autorización.

Si el proyecto aún no contiene `supabase/config.toml` y la tarea incluye inicializar Supabase, ejecutar `supabase init` una sola vez y revisar los archivos creados. No usar opciones de sobrescritura sobre una configuración existente.

### 3.3 Arranque local reproducible

Una vez confirmados los comandos del proyecto:

1. instalar dependencias con el lockfile congelado;
2. iniciar Supabase Local con `supabase start`;
3. consultar `supabase status` solo para configurar el entorno local, sin copiar sus claves a respuestas o logs;
4. ejecutar `supabase db reset --local` cuando sea necesario comprobar la reconstrucción completa;
5. generar tipos de la base local;
6. iniciar la aplicación y, si corresponde, las Edge Functions;
7. ejecutar una comprobación mínima de salud.

`supabase db reset --local` elimina y reconstruye únicamente la base local. Es destructivo para datos locales, por lo que debe avisarse si hay trabajo local no reproducible. No es equivalente ni concede permiso para `supabase db reset --linked`.

Supabase Local es solo para desarrollo: no debe asumirse que reproduce TLS, rate limiting, endurecimiento de credenciales, backups o controles de red del servicio alojado. Mantenerlo accesible únicamente desde la máquina/red de desarrollo autorizada; jamás publicarlo en Internet, abrir sus puertos públicamente ni exponerlo mediante túneles como si fuera un entorno real.

## 4. Modelo de entornos

Cada entorno debe usar URLs, claves, base de datos, Storage y configuración de Auth propios.

| Entorno    | Uso                                   | Supabase recomendado                                                                       | Vercel                                                        | Datos permitidos          |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------- |
| Local      | Desarrollo y pruebas frecuentes       | Stack local en Docker                                                                      | Servidor local; `vercel dev` solo si hace falta emular Vercel | Fixtures sintéticos       |
| Preview    | QA por rama o PR                      | Branch aislada por PR; como alternativa, proyecto Preview compartido con límites estrictos | Preview Deployment                                            | Sintéticos o anonimizados |
| Staging    | Validación integrada previa a release | Proyecto dedicado                                                                          | Custom Environment o rama dedicada                            | Sintéticos o anonimizados |
| Producción | Usuarios reales                       | Proyecto dedicado y protegido                                                              | Production Deployment                                         | Datos reales protegidos   |

Reglas:

- Local es el destino por defecto de desarrollo, migraciones y pruebas.
- Una Preview jamás debe apuntar al proyecto Supabase de Producción.
- Si Preview comparte una base, serializar migraciones, aislar fixtures y prohibir resets o pruebas destructivas.
- Preferir una Supabase Branch por PR cuando el plan y el flujo del equipo lo permitan.
- Staging no es Producción y no debe compartir sus secretos ni su base.
- Toda acción remota debe identificar explícitamente el entorno y el proyecto objetivo.
- Antes de una mutación remota, verificar el proyecto enlazado; no confiar en el enlace recordado por la CLI.
- Producción requiere confirmación explícita e inmediata para la acción concreta. Una petición general de “arreglar” o “terminar” no autoriza despliegues, migraciones, rotación de secretos ni cambios de datos.

## 5. Flujo obligatorio por tarea

### 5.1 Entender

- Reformular el objetivo y los criterios de aceptación.
- Identificar rutas afectadas, contratos, datos, roles y entornos.
- Revisar la implementación y las pruebas existentes.
- Clasificar el riesgo: bajo, medio o alto.
- Señalar cambios de esquema, RLS, Auth, Storage, variables, Edge Functions o despliegue.

### 5.2 Definition of Ready

Una tarea está lista para implementarse cuando se conocen, en proporción a su tamaño:

- problema, resultado esperado y fuera de alcance;
- criterios de aceptación observables;
- roles y permisos involucrados;
- datos y contratos afectados;
- entorno de prueba y fixtures necesarios;
- impacto de migración, compatibilidad y rollback;
- decisiones de producto o seguridad que requieren confirmación.

Si falta una decisión bloqueante, detenerse. Si falta información no crítica, documentar el supuesto y continuar de forma reversible.

### 5.3 Planificar

Para tareas no triviales, crear un plan corto con:

1. cambio mínimo completo;
2. archivos o módulos previstos;
3. migración y compatibilidad, si aplica;
4. pruebas por capa;
5. riesgos y estrategia de reversión.

Mantener una sola etapa activa y actualizar el plan ante hallazgos que cambien el alcance.

### 5.4 Implementar

- Seguir patrones existentes y modificar solo lo necesario.
- Separar UI, lógica de negocio, acceso a datos e infraestructura.
- Validar entradas en el límite confiable del servidor o función.
- Actualizar tipos, migraciones, RLS, pruebas y documentación en el mismo cambio lógico.
- Preservar compatibilidad durante despliegues graduales.
- No dejar TODO, mocks, bypasses o código temporal salvo acuerdo explícito y rastreable.

### 5.5 Validar

Ejecutar primero la validación más específica y luego los quality gates del proyecto. Registrar qué se ejecutó, el resultado y qué no pudo ejecutarse.

### 5.6 Revisar y entregar

- revisar diff, estado Git y archivos nuevos;
- buscar secretos, logs de depuración, cambios accidentales y artefactos generados;
- comprobar criterios de aceptación y Definition of Done;
- entregar el reporte definido en la sección 17.

## 6. Reglas generales de implementación

- Preferir la solución más simple que preserve la arquitectura.
- Reutilizar componentes, utilidades, consultas y convenciones existentes.
- Mantener funciones y componentes con una responsabilidad clara.
- Evitar duplicación real y abstracciones prematuras.
- Usar tipos explícitos en límites públicos, datos externos y lógica crítica.
- Manejar carga, vacío, éxito, error y permisos insuficientes en la UI.
- No filtrar detalles internos o datos sensibles en errores visibles.
- No introducir dependencias si el stack ya resuelve la necesidad.
- Justificar dependencias nuevas y evaluar mantenimiento, licencia, seguridad y peso.
- No alterar contratos públicos, rutas, eventos o formatos persistidos silenciosamente.
- Comentar intención y restricciones no evidentes, no traducir literalmente el código.
- Eliminar únicamente el código muerto creado por la tarea.

## 7. Supabase Local y Docker

Supabase Local es la fuente de verdad para el ciclo diario. El directorio `supabase/` debe permitir reconstruir el backend desde cero.

### 7.1 Archivos versionados

Versionar normalmente:

- `supabase/config.toml`, sin secretos incrustados;
- `supabase/migrations/`;
- `supabase/schemas/` solo si el proyecto eligió esquema declarativo;
- `supabase/seed.sql` o los seed files configurados;
- `supabase/functions/`;
- `supabase/tests/`.

No versionar `.vercel/`, `supabase/.temp/`, `supabase/.branches/`, estado interno de CLI, dumps sensibles, backups, `.env` ni volúmenes de Docker. Confirmar que estas rutas estén en `.gitignore`. Si `config.toml` necesita un secreto, referenciarlo mediante una variable de entorno.

### 7.2 Operación diaria

- `supabase start`: inicia o recupera el stack local y aplica configuración.
- `supabase status`: muestra endpoints y credenciales locales; tratar su salida como sensible.
- `supabase stop`: detiene el stack conservando datos locales.
- `supabase db reset --local`: elimina la base local, reaplica migraciones y seed; usar para verificar reproducibilidad.
- `supabase stop --no-backup`: elimina estado local; no ejecutar por defecto.

Si Docker falla, diagnosticar runtime, recursos, puertos y logs antes de eliminar estado. No usar un reinicio destructivo como primer intento.

## 8. Base de datos, esquemas, migraciones y seeds

### 8.1 Fuente de verdad

Elegir una estrategia a nivel de proyecto y no alternarla por tarea:

- **Migraciones imperativas:** crear una migración con `supabase migration new <descripcion>` y escribir/revisar SQL.
- **Esquema declarativo:** editar `supabase/schemas/`, generar un borrador con `supabase db diff --local -f <descripcion>` y revisar el SQL resultante.

Toda modificación de tablas, vistas, funciones, triggers, índices, extensiones, grants, RLS, Storage o datos de referencia debe ser versionada cuando corresponda.

`db diff` es un generador de borradores, no una autoridad infalible: puede omitir o representar incorrectamente ciertos cambios. La migración SQL revisada y versionada es la unidad que se prueba y despliega. Si se usa esquema declarativo, `supabase/schemas/` es además su fuente declarativa; no hacer cambios paralelos en Studio que queden fuera de ese flujo.

### 8.2 Flujo de migración

1. revisar migraciones y modelo actuales;
2. crear o generar una migración con nombre semántico;
3. inspeccionar el SQL completo: locks, pérdida de datos, defaults, nulabilidad, índices, permisos y costo;
4. ejecutar `supabase db reset --local` para validar la cadena desde cero;
5. ejecutar pruebas de base de datos y RLS;
6. regenerar tipos y comprobar el diff;
7. probar la aplicación contra Supabase Local;
8. documentar orden de despliegue y rollback si existe impacto remoto.

No editar una migración aplicada en un entorno compartido. Solo puede corregirse una migración aún no compartida ni aplicada tras comprobarlo; en otro caso, crear una migración nueva.

### 8.3 Diseño y compatibilidad

- Declarar claves, relaciones, nulabilidad, defaults, restricciones e índices deliberadamente.
- Indexar columnas usadas por claves foráneas, filtros críticos y políticas RLS cuando la carga lo justifique.
- Evitar N+1, lecturas sin límite y funciones costosas por fila.
- Usar transacciones para invariantes atómicas.
- Para cambios incompatibles, usar **expandir → desplegar compatibilidad → backfill → verificar → contraer** en releases separadas.
- No asumir que revertir Vercel revierte la base de datos.
- Preferir migraciones hacia adelante para corregir; un rollback SQL debe estar diseñado y probado.
- Un backfill debe ser reanudable, observable y acotado; en Producción requiere plan y autorización.

### 8.4 Seeds y fixtures

- Mantener seeds deterministas, mínimos y útiles para escenarios reales.
- Incluir datos, no cambios de esquema.
- Usar identificadores estables cuando faciliten pruebas.
- No copiar datos de Producción sin un proceso aprobado de anonimización.
- Nunca incluir secretos, tokens, PII ni credenciales reales.
- `--include-seed` solo puede usarse en un remoto efímero de Preview/Staging con autorización; nunca en Producción.

### 8.5 Frontera local/remota

| Comando                                  | Destino                           | Regla                                                        |
| ---------------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `supabase db reset --local`              | Base local Docker                 | Permitido tras proteger trabajo local no reproducible        |
| `supabase db push --linked --dry-run`    | Proyecto remoto enlazado          | Solo después de verificar identidad y entorno                |
| `supabase db push --linked`              | Proyecto remoto enlazado          | Mutación remota; autorización y un único actor de despliegue |
| `supabase db reset --linked`             | Proyecto remoto enlazado          | Destructivo; prohibido por defecto y nunca en Producción     |
| `supabase migration repair --linked ...` | Historial de migraciones remoto   | Solo con diagnóstico, evidencia, plan y autorización         |
| `supabase db pull --linked`              | Lee remoto y crea migración local | Verificar entorno; revisar drift y contenido antes de commit |

Antes de cualquier comando remoto: identificar proyecto y entorno, revisar migraciones pendientes, usar dry-run cuando exista, comprobar respaldo/recuperación y registrar el resultado. No encadenar automáticamente un dry-run con la ejecución real.

### 8.6 Conexiones Postgres desde Vercel u ORM

- Preferir `supabase-js` y Data API para acceso normal cuando encaje con el proyecto; conserva el contexto Auth y RLS.
- Si se usa ORM o driver Postgres desde funciones serverless/edge, usar el pooler en modo transacción recomendado para conexiones efímeras.
- El modo transacción no admite prepared statements; desactivarlos en el driver o usar el modo compatible documentado por el ORM.
- Usar conexión directa para migraciones, `pg_dump`, restore y tareas que requieren sesión; usar pooler en modo sesión como alternativa para clientes persistentes o limitaciones IPv4.
- Separar `DATABASE_URL` de runtime y la conexión directa de migraciones cuando la herramienta lo requiera. Ambas son secretos de servidor.
- Limitar el pool del cliente y vigilar conexiones; cada instancia serverless puede multiplicarlas.
- No ejecutar migraciones durante el build o arranque de cada función Vercel.

## 9. Supabase Auth, RLS, Storage y Edge Functions

### 9.1 Auth y autorización

- Tratar autenticación y autorización como controles distintos.
- Verificar sesión y permisos en servidor; nunca confiar solo en estado del cliente.
- En SSR, separar clientes de navegador/servidor, validar el token o claims en el servidor y manejar cookies con alcance, expiración, `Secure`, `SameSite` y `HttpOnly` cuando el flujo lo permita.
- Usar PKCE y canjear el código en el callback para SSR/OAuth; mantener una allowlist exacta de redirects por entorno, sin comodines amplios.
- No revelar si una cuenta existe mediante mensajes, estados o diferencias evitables de comportamiento; aplicar límites antiabuso en flujos sensibles.
- No inventar ni manipular usuarios reales para pruebas.
- Probar sesión ausente, expirada, renovada, revocada y rol insuficiente cuando aplique.
- Una clave pública/publishable puede estar en el cliente, pero su seguridad depende de RLS.
- La clave `service_role` o equivalente administrativo solo puede existir en servidores confiables; jamás en navegador, bundle, variable pública, logs o respuestas.

### 9.2 RLS: deny by default

- Para toda tabla expuesta por Data API, habilitar RLS en el mismo cambio y conceder a `anon`/`authenticated` únicamente los grants mínimos; RLS y grants son controles complementarios.
- Definir políticas por operación con `TO` explícito: `SELECT`, `INSERT`, `UPDATE`, `DELETE`. Un `UPDATE` necesita también una política `SELECT` aplicable.
- Usar `USING` para filas existentes y `WITH CHECK` para el estado nuevo.
- Restringir por propietario, tenant y rol; evitar políticas amplias como `true` sin justificación explícita.
- No autorizar con `user_metadata`, que el usuario puede modificar; usar claims administrativos controlados o tablas de roles protegidas y considerar la vigencia del JWT.
- Probar al menos: `anon`, autenticado propietario, autenticado no propietario, cruce de tenant y rol privilegiado aplicable.
- Verificar tanto casos permitidos como denegados y que una consulta no filtre existencia de datos ajenos.
- Las vistas expuestas deben usar `security_invoker = true` cuando esté disponible; en otro caso, revocar acceso a `anon`/`authenticated` o moverlas fuera de esquemas expuestos.
- Revisar grants de vistas, secuencias, RPC y funciones `security definer`; mantener estas últimas fuera de esquemas expuestos y fijar un `search_path` seguro.
- No usar `service_role` para hacer pasar una prueba que pretende validar RLS.

### 9.3 Storage

- Buckets privados por defecto; hacerlos públicos solo por requisito documentado.
- Definir políticas en `storage.objects` para cada operación necesaria.
- Restringir bucket y ruta; validar tamaño, contenido/MIME real y nombre normalizado, sin confiar solo en extensión o `Content-Type` del cliente.
- El `owner_id` es metadato, no autorización por sí solo: aplicarlo dentro de políticas y reglas de negocio verificadas.
- Para `upsert`, además de `INSERT`, conceder las políticas `SELECT` y `UPDATE` requeridas; probar creación y reemplazo por separado.
- Usar URLs firmadas con expiración para contenido privado.
- Operar archivos mediante la API de Storage; no modificar directamente sus tablas de metadatos.
- Probar lectura, listado, subida, reemplazo y borrado según los permisos reales.

### 9.4 Edge Functions

- Validar método, cuerpo, esquema, autenticación, autorización y tamaño de entrada.
- Declarar el modo de acceso de cada función: pública, autenticada, interna/service o webhook.
- Si `verify_jwt = false`, implementar y probar una verificación equivalente o documentar expresamente por qué el endpoint es público.
- Aplicar CORS con allowlist de orígenes, métodos y headers; nunca combinar credenciales con `Access-Control-Allow-Origin: *`.
- En webhooks, verificar firma y timestamp sobre el raw body antes de parsearlo, rechazar replay y procesar de forma idempotente mediante un identificador único.
- Configurar secretos por entorno; no incluir `.env` de funciones en Git.
- Ejecutar localmente con `supabase functions serve` y un archivo de entorno local ignorado.
- Probar respuestas de éxito, errores esperados, reintentos e idempotencia cuando haya efectos externos.
- Desplegar funciones individualmente cuando reduzca el riesgo; toda ejecución de `supabase functions deploy --project-ref <ref>` es una mutación remota y debe nombrar el proyecto objetivo.

### 9.5 Realtime, cron y colas — si aplican

- Realtime: publicar solo tablas/eventos necesarios, mantener RLS y comprobar que payloads y presencia no filtren filas o datos ajenos.
- Cron y colas: usar roles de mínimo privilegio, jobs idempotentes, locks contra solapamiento, reintentos acotados y manejo de mensajes fallidos.
- Definir métricas, alertas y runbook para lag, errores repetidos o jobs detenidos; no habilitar estas capacidades si la tarea no las necesita.

## 10. Tipos generados de Supabase

- Generar tipos desde la base local después de cada cambio de esquema.
- Guardarlos en la ruta canónica de la sección 1 y versionarlos si ese es el patrón del proyecto.
- Ejecutar typecheck después de regenerarlos.
- Revisar el diff: una modificación inesperada revela drift o una migración incompleta.
- No editar manualmente un archivo generado.
- En CI, regenerar a un archivo temporal o comprobar que Git queda limpio para detectar tipos desactualizados.
- Generar desde un remoto solo cuando la tarea lo requiera y tras verificar el `project-ref`; para trabajo diario, usar `--local`.

Comando recomendado:

```bash
supabase gen types typescript --local > {{RUTA_TIPOS_SUPABASE}}
```

Sustituir el marcador antes de ejecutar y preferir el script canónico del repositorio si existe.

## 11. Variables de entorno y secretos

### 11.1 Clasificación

- **Públicas:** pueden llegar deliberadamente al navegador, por ejemplo URL de Supabase y clave publishable. Aun así, no son autorización.
- **Privadas:** claves administrativas, contraseñas DB, tokens de proveedores, webhooks y secretos de firma. Solo servidor/CI autorizado.
- **Locales:** valores del stack local y credenciales ficticias; no reutilizar valores remotos.

### 11.2 Reglas

- Mantener `.env.example` con nombres, comentarios y placeholders, nunca valores reales.
- Ignorar `.env`, `.env.local`, archivos de funciones y descargas de Vercel que contengan secretos.
- No leer, imprimir, pegar, registrar ni devolver valores de secretos.
- No prefijar como pública una variable privada (`NEXT_PUBLIC_`, `VITE_` o equivalente).
- Configurar variables de Vercel por ámbito: Development, Preview, Staging/Custom y Production.
- Tras cambiar variables en Vercel, crear un deployment nuevo cuando sea necesario; no asumir que un rollback reconstruye con valores nuevos.
- Rotar inmediatamente una credencial expuesta y revisar logs/historial; eliminarla del último commit no basta.
- `vercel env pull .env.local` solo después de confirmar proyecto y ámbito, y verificando que el archivo esté ignorado.
- Los secretos de Edge Functions se gestionan por entorno; `supabase secrets set --project-ref <ref> ...` es una mutación remota y requiere autorización.

## 12. UI, UX y accesibilidad

- Reutilizar el sistema de diseño, componentes y tokens del proyecto.
- Cubrir carga, vacío, error, éxito, deshabilitado y permisos insuficientes.
- Mostrar errores accionables sin revelar SQL, stack traces, IDs sensibles ni políticas internas.
- Formularios con etiqueta, ayuda, validación clara, foco en errores y preservación razonable de datos.
- Cumplir el objetivo WCAG configurado: semántica, teclado, foco visible, contraste, nombres accesibles y objetivos táctiles.
- Diseñar responsive y probar textos largos, datos ausentes y traducciones.
- No usar solo color para transmitir estado.
- No hacer cambios visuales globales fuera del alcance.

## 13. Estrategia de pruebas

Toda prueba debe ser determinista, aislada y ejecutable de forma repetida. No reemplazar pruebas importantes con mocks cuando Supabase Local permite validar el comportamiento real.

### 13.1 Capas mínimas

- **Unitarias:** lógica pura, validadores, transformaciones y componentes aislados.
- **Integración:** aplicación contra Supabase Local; consultas, RPC, Auth, Storage y Edge Functions relevantes.
- **Base de datos:** esquema, constraints, triggers, funciones y migraciones con pgTAP mediante `supabase test db`.
- **RLS:** matriz permitida/denegada por rol, propietario y tenant.
- **End-to-end:** rutas críticas desde UI/API contra un entorno controlado con seed determinista.
- **Build:** compilación en condiciones equivalentes a Vercel.
- **Manual:** smoke test enfocado en el flujo cambiado, solo como complemento.

### 13.2 Casos obligatorios según cambio

| Cambio              | Validación mínima                                                        |
| ------------------- | ------------------------------------------------------------------------ |
| Corrección de bug   | Prueba de regresión que falle antes y pase después                       |
| Migración           | `db reset --local`, pruebas DB/RLS, tipos y compatibilidad               |
| Política RLS        | Caso autorizado, denegado y cruce de tenant/propietario                  |
| Auth                | Sin sesión, sesión válida, expirada y permisos insuficientes             |
| Storage             | Tipo/tamaño/ruta válidos e inválidos; acceso ajeno denegado              |
| Edge Function       | Validación, Auth, errores, secretos y efectos idempotentes               |
| UI                  | Estados, responsive, teclado y accesibilidad básica                      |
| Integración externa | Contrato, timeout, reintento y error; sin llamadas reales no autorizadas |

### 13.3 Migraciones

- Probar reconstrucción desde cero con `supabase db reset --local`.
- Para cambios de riesgo medio/alto, probar también el camino de upgrade sobre datos representativos; un reset vacío no detecta todos los fallos.
- Verificar que seeds se ejecutan y no dependen de orden accidental.
- Inspeccionar locks, tiempo esperado y compatibilidad con la versión anterior de la aplicación.

### 13.4 Prohibiciones en pruebas

- No apuntar pruebas locales o CI a Producción.
- No usar datos reales ni snapshots con PII.
- No deshabilitar, saltar o suavizar pruebas para obtener verde.
- No usar esperas arbitrarias ni reintentos indiscriminados para ocultar flakiness.
- No reducir cobertura sin justificarlo.
- No afirmar que una prueba pasó si no se ejecutó.

### 13.5 CI efímero recomendado

Cada job de validación debe construir un entorno desechable y reproducible:

1. instalar con lockfile congelado;
2. iniciar Supabase Local en el runner;
3. ejecutar `supabase db reset --local`;
4. ejecutar `supabase db lint --local` y `supabase test db`;
5. regenerar tipos desde `--local` y fallar si el diff esperado no está versionado;
6. ejecutar lint, typecheck, unitarias, integración, E2E aplicables y build;
7. destruir el runner al finalizar.

Los PR desde forks no deben recibir secretos remotos. CI no debe depender de un Supabase compartido para pruebas que puedan resolverse con Docker. Si una prueba requiere Preview/Staging, separarla, limitar permisos y exigir aprobación según el entorno.

## 14. Comandos canónicos y quality gates

Los scripts del repositorio prevalecen. Configurar esta tabla al iniciar el proyecto; los valores recomendados son punto de partida, no permiso para inventar scripts.

| Acción                      | Variable                    | Valor recomendado                                                 |
| --------------------------- | --------------------------- | ----------------------------------------------------------------- |
| Instalar                    | `{{CMD_INSTALL}}`           | `pnpm install --frozen-lockfile` o equivalente del lockfile       |
| Desarrollo app              | `{{CMD_DEV}}`               | `pnpm dev`                                                        |
| Formato                     | `{{CMD_FORMAT_CHECK}}`      | `pnpm format:check`                                               |
| Lint                        | `{{CMD_LINT}}`              | `pnpm lint`                                                       |
| Tipos                       | `{{CMD_TYPECHECK}}`         | `pnpm typecheck`                                                  |
| Unitarias                   | `{{CMD_TEST_UNIT}}`         | `pnpm test:unit`                                                  |
| Integración                 | `{{CMD_TEST_INTEGRATION}}`  | `pnpm test:integration`                                           |
| E2E                         | `{{CMD_TEST_E2E}}`          | `pnpm test:e2e`                                                   |
| Cobertura                   | `{{CMD_COVERAGE}}`          | `pnpm test:coverage`                                              |
| Build                       | `{{CMD_BUILD}}`             | `pnpm build`                                                      |
| Validación completa         | `{{CMD_VALIDATE}}`          | `pnpm validate`                                                   |
| Supabase iniciar            | `{{CMD_SB_START}}`          | `supabase start`                                                  |
| Supabase estado             | `{{CMD_SB_STATUS}}`         | `supabase status`                                                 |
| Supabase detener            | `{{CMD_SB_STOP}}`           | `supabase stop`                                                   |
| Supabase inicializar        | `{{CMD_SB_INIT}}`           | `supabase init`; solo si no existe configuración                  |
| Reset local                 | `{{CMD_DB_RESET_LOCAL}}`    | `supabase db reset --local`                                       |
| Nueva migración             | `{{CMD_DB_MIGRATION_NEW}}`  | `supabase migration new <descripcion>`                            |
| Diff de esquema             | `{{CMD_DB_DIFF}}`           | `supabase db diff --local -f <descripcion>`; tratar como borrador |
| Lint DB                     | `{{CMD_DB_LINT}}`           | `supabase db lint --local`                                        |
| Pruebas DB/RLS              | `{{CMD_DB_TEST}}`           | `supabase test db`                                                |
| Tipos Supabase              | `{{CMD_DB_TYPES}}`          | `supabase gen types typescript --local > <ruta>`                  |
| Functions local             | `{{CMD_FUNCTIONS_SERVE}}`   | `supabase functions serve --env-file <archivo-local>`             |
| Enlazar Supabase remoto     | `{{CMD_SB_LINK}}`           | `supabase link --project-ref <ref>`; confirmar entorno            |
| Estado migraciones remoto   | `{{CMD_DB_MIGRATION_LIST}}` | `supabase migration list --linked`                                |
| Dry-run remoto              | `{{CMD_DB_PUSH_DRY}}`       | `supabase db push --linked --dry-run` tras verificar el enlace    |
| Aplicar migraciones remotas | `{{CMD_DB_PUSH}}`           | `supabase db push --linked`; sensible                             |
| Enlazar Vercel              | `{{CMD_VERCEL_LINK}}`       | `vercel link`; confirmar proyecto                                 |
| Variables Vercel local      | `{{CMD_VERCEL_ENV_PULL}}`   | `vercel env pull .env.local`; confirmar ámbito y `.gitignore`     |
| Preview local Vercel        | `{{CMD_VERCEL_DEV}}`        | `vercel dev` si el framework lo necesita                          |
| Build Vercel local          | `{{CMD_VERCEL_BUILD}}`      | `vercel build` si forma parte del flujo                           |
| Deploy Preview              | `{{CMD_VERCEL_PREVIEW}}`    | `vercel`; acción externa, solo autorizada                         |
| Deploy Producción           | `{{CMD_VERCEL_PROD}}`       | `vercel --prod`; confirmación explícita obligatoria               |

Reglas de ejecución:

- Detectar el gestor por lockfile; no sustituirlo por `pnpm` automáticamente.
- Preferir scripts fijados en el repositorio a binarios globales.
- No actualizar dependencias o lockfile salvo que la tarea lo exija.
- No ignorar códigos de salida, truncar errores relevantes ni fabricar resultados.
- Ejecutar validaciones específicas durante el desarrollo y gates completos antes de entregar.
- Si un comando no existe, informar el hueco; no afirmar que fue ejecutado.

### 14.1 Quality gates por defecto

**Cambio de bajo riesgo:** formato/lint afectados, typecheck, pruebas específicas y revisión del diff.

**Cambio de riesgo medio:** lo anterior más unitarias/integración relevantes, build y smoke test.

**Cambio de alto riesgo** — esquema, RLS, Auth, Storage, secretos, pagos, producción o infraestructura:

1. lint y formato;
2. typecheck;
3. unitarias e integración;
4. `supabase db reset --local`;
5. `supabase db lint --local`;
6. `supabase test db` y matriz RLS;
7. regeneración y comprobación de tipos;
8. E2E del flujo crítico;
9. build equivalente a Vercel;
10. revisión de seguridad, migración, observabilidad y rollback;
11. aprobación humana requerida por el flujo del proyecto.

Una tabla expuesta nueva sin RLS, una política sin casos negativos o tipos de base desactualizados bloquean la entrega.

### 14.2 Comandos sensibles

| Nivel                      | Ejemplos                                                                                   | Política                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Local reversible           | `supabase start`, lint, tests, build                                                       | Permitido dentro de la tarea                                                                             |
| Docker destructivo         | `docker compose down -v`, `docker volume rm`, `docker volume prune`, `docker system prune` | Resolver volúmenes exactos; los comandos amplios requieren confirmación y pueden afectar otros proyectos |
| Supabase local destructivo | `db reset --local`, `stop --no-backup`                                                     | Proteger/avisar sobre datos locales no reproducibles; no usar como primer diagnóstico                    |
| Supabase remoto            | `db pull/push/reset --linked`, `migration repair`, `secrets set/unset`, `functions deploy` | Verificar proyecto; toda mutación requiere autorización. Reset linked nunca en Producción                |
| Vercel configuración       | `vercel link`, `env pull/add/rm`, `alias`, `remove`                                        | Verificar proyecto y ámbito; puede descargar secretos o cambiar/eliminar estado remoto                   |
| Vercel release             | `vercel`, `promote`, `rollback`, `--prod`                                                  | Acción externa; Producción exige confirmación inmediata y rollback no revierte DB/variables              |
| Producción/datos           | migración, restore, truncate/drop, backfill, rotación de secretos                          | Plan, respaldo y confirmación explícita para la acción concreta                                          |

Los flags `--local` y `--linked` deben escribirse cuando el comando los admita; no confiar en defaults que varían entre subcomandos.

## 15. Git, pull requests, Preview y despliegue

### 15.1 Git

- Revisar estado y diff antes y después de trabajar.
- No sobrescribir, revertir ni “limpiar” cambios ajenos.
- Mantener commits enfocados y usar la convención configurada.
- No crear ramas, commits, tags, pushes o PR salvo que se solicite o el flujo autorizado lo exija.
- No reescribir historial, hacer force-push, borrar ramas ni omitir hooks sin autorización explícita.
- No mezclar refactors, upgrades o formato masivo con una funcionalidad.
- Revisar que migraciones simultáneas tengan orden coherente y resolver conflictos sin alterar historial aplicado.

### 15.2 Contenido mínimo de un PR

- problema y solución;
- alcance y fuera de alcance;
- capturas o evidencia para cambios visuales;
- pruebas ejecutadas y resultados;
- migraciones, RLS, tipos y variables afectadas;
- impacto por entorno;
- orden de despliegue y rollback;
- riesgos y seguimiento pendiente.

### 15.3 Vercel Preview

- La integración Git debe crear una Preview por PR cuando esté configurada.
- Una Preview es externa: el agente no debe dispararla manualmente con `vercel` salvo solicitud o flujo autorizado.
- Confirmar que usa variables Preview y un Supabase aislado o explícitamente aprobado.
- Aplicar migraciones de PR solo a una branch/proyecto aislado; no mutar Producción.
- Ejecutar smoke/E2E sobre la URL inmutable del commit cuando corresponda.
- No aprobar una Preview solo porque compiló: validar Auth, RLS, datos y flujos críticos.

### 15.4 Staging y Producción

Flujo recomendado:

1. pasar quality gates locales y CI;
2. validar en Preview/Staging;
3. revisar `supabase db push --linked --dry-run` contra el proyecto correcto;
4. confirmar compatibilidad, respaldo, observabilidad y rollback;
5. obtener aprobación explícita para Producción;
6. aplicar migraciones con un único actor controlado;
7. desplegar o promover la aplicación;
8. desplegar Edge Functions necesarias;
9. ejecutar smoke tests y vigilar métricas/logs;
10. registrar resultado y versión desplegada.

El orden exacto depende de compatibilidad. Los cambios de base incompatibles deben dividirse en releases. `vercel --prod`, promociones a Producción, `supabase db push --linked` a Producción, `supabase functions deploy --project-ref <ref>`, cambios de secretos y backfills remotos requieren autorización explícita para el objetivo concreto.

Debe existir una sola autoridad para aplicar migraciones por entorno: integración oficial de Supabase, pipeline CI/CD o responsable humano designado. Nunca habilitar dos a la vez. No ejecutar `db push` dentro del build de Vercel: los builds pueden repetirse, concurrir o ejecutarse para Previews. Serializar releases y registrar la versión de migración aplicada.

## 16. Seguridad, observabilidad, rollback e incidentes

### 16.1 Seguridad y privacidad

- Tratar toda entrada externa como no confiable.
- Prevenir inyección SQL, XSS, CSRF, SSRF, traversal, cargas inseguras y ejecución de comandos no controlada.
- Usar consultas parametrizadas y validación del lado servidor.
- Aplicar mínimo privilegio en Postgres, RLS, Vercel, Supabase y CI.
- No registrar cuerpos, headers, JWT, cookies, URLs firmadas ni errores con secretos/PII.
- Revisar amenazas para Auth, permisos, archivos, datos personales, webhooks, pagos e infraestructura.
- No desactivar controles de seguridad para resolver un fallo.

### 16.2 Observabilidad

Para cambios relevantes, definir antes de desplegar:

- señal de éxito y métricas de negocio/técnicas;
- errores y logs seguros que permiten diagnosticar;
- paneles o alertas disponibles en Vercel, Supabase y la herramienta configurada;
- ventana de observación y responsable;
- umbrales que activan rollback o mitigación.

Incluir un identificador de correlación cuando ayude, sin convertirlo en dato sensible. Verificar tanto errores de aplicación como logs de Postgres, Auth, Storage y Edge Functions aplicables.

### 16.3 Rollback

- Registrar el deployment de Vercel anterior conocido como estable.
- Un rollback de Vercel revierte código desplegado, no migraciones, datos ni necesariamente variables.
- Preferir migraciones correctivas hacia adelante.
- Restaurar una base o ejecutar SQL inverso solo con responsable, evidencia, respaldo y autorización explícita.
- En cambios expand/contract, conservar compatibilidad con la versión anterior hasta cerrar la ventana de rollback.
- Rotación de secretos puede exigir redeploy y revocación coordinada.

### 16.4 Protocolo de incidentes

Si se detecta pérdida/corrupción de datos, exposición de secretos, acceso indebido o regresión grave:

1. detener nuevas mutaciones y despliegues relacionados;
2. no ocultar evidencia ni “arreglar” Producción a ciegas;
3. informar de inmediato qué se sabe, alcance, entorno y hora aproximada;
4. preservar logs y datos diagnósticos sin copiar secretos;
5. contener: deshabilitar flujo, revertir app o revocar credencial según el plan autorizado;
6. evaluar impacto en datos y usuarios;
7. recuperar mediante el procedimiento aprobado;
8. verificar servicio, integridad y controles de acceso;
9. documentar cronología, causa, acciones y prevención.

La urgencia no elimina la confirmación para una operación destructiva. Si un secreto aparece en código o historial, considerarlo comprometido: revocar/rotar, revisar uso y limpiar el historial mediante un procedimiento coordinado.

## 17. Definition of Done e informe final

### 17.1 Definition of Done

Una tarea está terminada solo cuando:

- cumple criterios de aceptación y no amplía el alcance;
- respeta arquitectura, convenciones y compatibilidad;
- valida entradas, errores, permisos y estados de UI pertinentes;
- migraciones, RLS, seeds y tipos están sincronizados;
- incluye pruebas proporcionales al riesgo y gates aplicables en verde;
- no contiene secretos, PII, logs temporales ni artefactos accidentales;
- documenta variables, operación, migración y rollback necesarios;
- el diff final fue revisado;
- todo lo no validado o pendiente está declarado con precisión.

### 17.2 Formato del informe final

```text
Resultado
- Qué se logró y para qué.

Cambios
- Archivos o áreas principales y decisiones relevantes.

Base de datos y seguridad
- Migraciones, RLS, Auth, Storage, Functions, tipos o variables afectadas.
- "No aplica" si corresponde.

Validación
- Comando/prueba: resultado real.
- Revisión manual: resultado real.

Despliegue y rollback
- Pasos requeridos, entorno y orden.
- Estrategia de reversión o "no aplica".

Pendientes y riesgos
- Lo no ejecutado, motivo, supuestos y próximos pasos.
```

No usar “todo funciona” como sustituto de evidencia. Si una prueba no pudo ejecutarse, indicar causa y comando pendiente.

## 18. Conductas prohibidas

El agente no debe:

- programar sin inspeccionar el contexto relevante;
- inventar requisitos, archivos, APIs, comandos, resultados, métricas o estados de despliegue;
- ampliar el alcance, reescribir módulos o cambiar arquitectura por preferencia;
- editar migraciones ya aplicadas o cambiar la base remota directamente desde Dashboard como flujo normal;
- ejecutar `supabase db reset --linked` en Producción bajo ninguna circunstancia;
- ejecutar resets remotos, `migration repair`, dumps/restores, borrados, truncados o backfills destructivos sin autorización y plan;
- confundir `supabase db reset --local` con una operación remota;
- apuntar Local, CI, Preview o E2E a Producción;
- exponer Supabase Local o sus puertos a Internet;
- ejecutar `vercel --prod`, promover deployments o mutar Supabase de Producción sin confirmación explícita;
- sembrar Producción con `--include-seed`;
- exponer `service_role`, tokens, contraseñas, JWT, cookies, PII o archivos `.env`;
- poner una clave administrativa en código cliente o variable pública;
- deshabilitar RLS, Auth, validación, lint, tipos, pruebas, hooks o alertas para hacer pasar el cambio;
- usar `service_role` para eludir una prueba RLS;
- modificar directamente tablas internas de Auth o metadatos de Storage salvo procedimiento oficial, justificado y probado;
- ocultar fallos, advertencias, drift, trabajo incompleto o validaciones no ejecutadas;
- borrar/revertir cambios ajenos, reescribir historial o hacer force-push sin autorización;
- dejar código temporal, credenciales, logs de depuración o archivos innecesarios;
- asumir que rollback de Vercel revierte base de datos, secretos o datos.

## 19. Documentos de referencia

Leer solo lo relevante para la tarea. Si no existe, no inventar su contenido.

| Ruta                               | Propósito                                      |
| ---------------------------------- | ---------------------------------------------- |
| `README.md`                        | Instalación, scripts y visión general          |
| `docs/PRODUCT.md`                  | Usuarios, alcance y reglas del producto        |
| `docs/ARCHITECTURE.md`             | Componentes, límites y flujos                  |
| `docs/DATABASE.md`                 | Modelo, migraciones, RLS y operación           |
| `docs/ENVIRONMENTS.md`             | Mapeo Local/Preview/Staging/Producción         |
| `docs/DEPLOYMENT.md`               | Release, responsables y rollback               |
| `docs/SECURITY.md` o `SECURITY.md` | Amenazas, secretos e incidentes                |
| `docs/runbooks/`                   | Operación, alertas, rollback e incidentes      |
| `docs/DESIGN_SYSTEM.md`            | UI, tokens y accesibilidad                     |
| `docs/decisions/`                  | ADR y decisiones vigentes                      |
| `docs/features/`                   | Especificaciones y aceptación                  |
| `CONTRIBUTING.md`                  | Flujo Git y PR                                 |
| `.env.example`                     | Nombres y propósito de variables, sin secretos |

Referencias oficiales para mantener comandos y políticas al día:

- [Supabase: flujo de desarrollo local](https://supabase.com/docs/guides/local-development/cli-workflows)
- [Supabase: migraciones](https://supabase.com/docs/guides/deployment/database-migrations)
- [Supabase: pruebas de base de datos](https://supabase.com/docs/guides/database/testing)
- [Supabase: Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase: conexiones directas y poolers](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase: secretos de Edge Functions](https://supabase.com/docs/guides/functions/secrets)
- [Vercel: entornos](https://vercel.com/docs/deployments/environments)
- [Vercel: variables de entorno](https://vercel.com/docs/environment-variables)
- [Vercel: rollback](https://vercel.com/docs/instant-rollback)

## 20. Checklist de inicio rápido

```text
[ ] Leí las instrucciones aplicables y la documentación relevante.
[ ] Revisé estructura, scripts, Supabase, pruebas y estado Git.
[ ] Definí objetivo, aceptación, fuera de alcance y riesgo.
[ ] Confirmé que trabajo contra Local salvo autorización distinta.
[ ] Planeé migración, permisos, tipos, pruebas y rollback si aplican.
[ ] Implementé el cambio mínimo completo.
[ ] Validé contra Supabase Local y ejecuté gates proporcionales.
[ ] Revisé diff, secretos, PII, logs y archivos accidentales.
[ ] No realicé acciones remotas o de Producción no autorizadas.
[ ] Entregué evidencia, pasos de despliegue, riesgos y pendientes.
```

---

**Mantenimiento:** revisar este archivo cuando cambien el stack, las versiones de CLI, la arquitectura, los entornos, los responsables o el proceso de release. Mantener las reglas estables aquí y mover detalles extensos a los documentos enlazados.

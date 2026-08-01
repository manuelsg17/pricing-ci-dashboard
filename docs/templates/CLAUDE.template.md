# Reglas de implementación — {{NOMBRE_DEL_PROYECTO}}

> **Cómo usar esta plantilla** (borrar este bloque al adoptarla)
>
> Copiar como `CLAUDE.md` en la raíz del repo. Después:
> `ln -s CLAUDE.md AGENTS.md` — Codex y Cursor leen `AGENTS.md`, Claude Code lee
> `CLAUDE.md`. Con un symlink los dos leen lo mismo y no hay forma de que el
> comportamiento cambie según la herramienta.
>
> **La sección 0 se cumple desde el día cero y no se negocia.** El resto arranca
> casi vacío y se llena con TU experiencia. Un manual de 40 KB en el día uno es
> ruido que nadie lee; uno de 5 KB donde cada regla nombra un bug real se
> respeta.
>
> **Regla de oro para escribir reglas nuevas**: no agregues una regla que no te
> haya mordido, salvo las de la sección 0. Y cuando la agregues, escribí _por
> qué_ — la regla sin la cicatriz se borra en el primer apuro.

Este documento es de cumplimiento obligatorio para cualquier cambio de código.
No es una lista de sugerencias. Cuando una regla y la conveniencia del momento
choquen, gana la regla — o se para y se pregunta antes de romperla.

---

## 0. Núcleo no negociable

Esto aplica desde el primer commit, antes de tener cicatrices. Son las cosas
donde "aprender por experiencia" significa una fuga de datos, una credencial
quemada o una tabla borrada.

### 0.1 Acciones destructivas y de producción

- **Ninguna acción destructiva o de producción sin autorización explícita para
  ESA acción puntual.** Un "arreglá todo" no autoriza un DELETE, una migración a
  producción, un deploy ni una rotación de secretos. La autorización se pide
  nombrando tabla, filas y motivo.
- **La urgencia no elimina la confirmación.** Un incidente es cuando más caro
  sale un borrado apurado sobre la tabla equivocada.
- **Verificar SIEMPRE contra qué entorno apunta el comando** antes de correrlo.
  No confiar en el link que la CLI recuerda de la sesión anterior: es el camino
  clásico por el que una prueba termina en producción.
- **Antes de borrar o sobrescribir, mirar qué hay ahí.**

### 0.2 Secretos

- Nunca commitear tokens, claves administrativas ni contraseñas — ni en código,
  ni en config trackeada, ni en un mensaje de commit.
- **Una credencial expuesta está comprometida desde el segundo cero**: rotarla ya
  y revisar su uso. Borrarla del último commit no alcanza — queda en el
  historial, en los forks y en cachés de la plataforma.
- Nunca imprimir un secreto "para comprobar que existe".
- Una clave administrativa jamás en el bundle del cliente ni en una variable
  con prefijo público.

### 0.3 Autorización

- **Autenticación y autorización son controles distintos.** Ocultar un botón en
  la UI no autoriza nada: la API no es la UI.
- **Deny by default.** Toda tabla nueva expuesta nace con las reglas de acceso
  en el MISMO cambio que la crea, y con los permisos mínimos.
- **Los permisos y las políticas de fila son complementarios, no alternativos.**
  En Postgres el GRANT se evalúa ANTES que la política: una tabla con RLS
  impecable y un grant amplio sigue abierta.
- **Las políticas permisivas se combinan con OR.** Una política vieja y laxa
  conviviendo con la nueva y correcta gana en silencio — sin error y sin log. Al
  reemplazar una política, borrarla explícitamente primero; nunca asumir que la
  nueva "gana".
- **Una política de fila no puede restringir por COLUMNA.** Si el usuario solo
  debe poder cambiar un campo, va por función del servidor que valide y escriba
  solo eso.
- **Nunca autorizar con metadatos que el propio usuario puede editar.**
- **Probar lo denegado, no solo lo permitido** — y que un acceso denegado no
  filtre la EXISTENCIA de datos ajenos (un conteo o un error distinto ya es una
  fuga).
- **Nunca usar una credencial administrativa para que pase un test que pretende
  validar permisos.** Es la forma más eficiente de tener la suite en verde sobre
  una base abierta.

### 0.4 Datos y migraciones

- **El esquema se cambia solo por migraciones versionadas**, nunca a mano en una
  consola de administración. Un cambio manual queda fuera del historial y
  reaparece después como drift inexplicable.
- **Validar toda migración en local primero**, con una reconstrucción desde
  cero, y recién después aplicarla a producción.
- **Cambios incompatibles: expandir → desplegar → backfill → verificar →
  contraer**, en releases separadas. Borrar una columna en el mismo deploy que
  la deja de usar rompe a cualquier cliente con el bundle viejo cargado.
- **Preferir migraciones correctivas hacia adelante** antes que un rollback SQL.
- **Un rollback de la app NO revierte la base de datos.**
- **Un backfill debe ser reanudable, acotado y observable.**

### 0.5 Alcance y honestidad

- **Mantener el alcance pedido.** No ampliarlo, no reescribir módulos ni cambiar
  arquitectura por preferencia. Si el cambio necesario es estructuralmente
  grande, plantearlo aparte en vez de mezclarlo con un fix.
- **No dejar TODOs, mocks ni bypasses** salvo acuerdo explícito y rastreable.
- **No declarar éxito sin validación ejecutada.** Si una prueba no se pudo
  correr, se dice cuál y por qué.
- **No afirmar que un fix funciona porque el código "se ve bien"** — cuando el
  bug tenía evidencia en producción, confirmar con una consulta directa que el
  patrón dejó de ocurrir.
- **No ocultar advertencias, drift ni trabajo incompleto** para cerrar más
  rápido.
- **Corregirse rápido y sin ceremonia** cuando un diagnóstico resultó
  equivocado. Sostener un diagnóstico errado cuesta mucho más que admitirlo.

---

## 1. Arquitectura

> Completar con lo real. Lo importante no es describir el stack (eso se lee en
> el `package.json`) sino lo que un agente NO puede deducir mirando el código.

- **Stack**: {{...}}
- **Decisiones de alcance deliberadas** — lo que se decidió NO hacer y por qué.
  Esto evita que alguien "arregle" un hueco intencional. Anotar también la fecha,
  porque una decisión puede dejar de tener sentido:
  {{ej: sin dark mode; sin SSR; sin i18n}}
- **Dónde vive canónicamente la lógica de negocio** — y qué NO se duplica en el
  cliente. Si hay una función del servidor que ya resuelve algo, no se
  reimplementa al lado.
- **Deuda conocida y aceptada**: {{qué componente/módulo es un problema
  conocido, para que nadie lo "descubra" y lance un refactor no pedido}}
- **Conceptos con dos representaciones distintas**: cualquier cosa que se llame
  parecido pero signifique cosas distintas según la capa (lo que ve el usuario
  vs. lo que se persiste vs. la clave de caché). Es una fuente de bugs
  silenciosos con pérdida de datos. Nombrarlos explícitamente acá.
  {{ej: `uiName` vs `dbKey` vs `storageId` — NO son intercambiables}}

## 2. Buenas prácticas de código

> Empezar vacía. Se llena con lo que te muerde. Arranques posibles, si aplican:

- **Nada de estado solo en memoria para algo que debe sobrevivir una recarga.**
- **Los procesos en segundo plano nunca deben pisar una acción explícita y
  reciente del usuario** — si el usuario acaba de cerrar algo a propósito, un
  refresco automático puede resucitarlo.
- **Escrituras idempotentes por clave exacta**, nunca por un criterio más amplio
  que el que identifica la fila.
- **Cuidado con los efectos que dependen de objetos recreados en cada render.**

## 3. Seguridad específica del proyecto

> La sección 0.3 cubre lo universal. Acá va lo propio: qué función controla el
> acceso, cuál es el patrón estándar de política para una tabla nueva, qué
> script de verificación correr y contra qué entornos.

- **Patrón estándar de acceso para una tabla nueva**: {{...}}
- **Verificación obligatoria al tocar permisos**: {{comando}}, en local Y en
  producción.

## 4. Base de datos y rendimiento

> Se llena cuando el rendimiento empieza a doler. Candidatos:

- De dónde lee cada vista pesada, y qué NO se consulta en vivo.
- Índices alineados al patrón de consulta real, no genéricos.
- Escrituras en lote, no fila por fila.
- **Medir antes de escalar el plan o el compute.**
- **Particionar tablas grandes ANTES de que duelan**, no cuando ya duelen.
- **Ninguna lógica de normalización en un solo lugar si el dato entra por varios
  caminos** — auditarla contra TODOS los caminos de entrada.

## 5. Frontend

> Candidatos, si aplican:

- Estados de carga, vacío, error, éxito y permiso insuficiente en toda vista.
- **Paginación sin truncado silencioso**: nunca cortar en un límite fijo sin
  dejarlo visible.
- **Autosave con debounce + flush explícito al cambiar de contexto** — sin el
  flush, cambiar rápido de pantalla pierde lo último sin avisar.
- **Identidad estable** para arrays/objetos que van como dependencia de un
  efecto.
- No filtrar detalles internos ni datos sensibles en errores visibles.

## 6. i18n — {{obligatorio | no aplica}}

> Si el producto tiene más de un idioma, esta sección es dura: todo string
> visible pasa por la capa de traducción, en TODOS los locales activos, en el
> mismo commit. Un locale "para después" no se completa nunca.

## 7. Checklist antes de producción

Ejecutar todo lo aplicable, en orden. No se recorta porque "es un cambio
chico" — los bugs más caros suelen parecer chicos.

1. **Lint** — cero warnings, no solo cero errores.
2. **Build** — sin errores.
3. **Tests** — en verde. Si el cambio toca lógica pura, **agregar un test nuevo**
   en vez de confiar en la verificación manual.
4. **Si toca permisos**: verificación de políticas en local Y producción, y
   revisión manual de los objetos nuevos.
5. **Si toca una migración**: reconstrucción limpia en local, verificación
   manual del resultado, y recién después producción — con autorización
   explícita para ESA migración.
6. **Si toca un flujo de usuario**: reproducirlo en navegador contra el entorno
   LOCAL, incluyendo **una recarga real de página** en cada punto donde el
   estado debería sobrevivir. Confirmar en la base — no solo en la UI — que no
   quedaron filas duplicadas ni datos huérfanos.
7. **Revisión adversarial** para cualquier feature no trivial: al menos una
   pasada independiente que intente REFUTAR el fix o encontrarle un caso borde,
   antes de darlo por cerrado. Encuentra bugs que el lint y el build no van a
   cazar nunca.
8. **Barrido de datos reales** cuando el bug tenía evidencia en producción.
9. **Revisar el diff completo**: secretos, logs de depuración, archivos
   accidentales.
10. **Limpiar el entorno de prueba** — datos y usuarios de prueba borrados.

## 8. Proceso

- Paths absolutos al editar.
- Commits incrementales, con mensaje que explique el **por qué** (causa raíz),
  no solo el qué.
- Push después de cada sub-fase terminada y validada.
- Los manifiestos de dependencias y sus lockfiles se commitean SIEMPRE juntos.
- No reescribir historial, force-push ni borrar ramas sin autorización.
- No mezclar un refactor, un upgrade o un formateo masivo con una funcionalidad.

## 9. Entornos, despliegue y rollback

> Describir los entornos REALES, no los que un manual genérico asume. Si sos una
> persona sola con local y producción, escribí eso — inventar un Staging que no
> existe solo genera instrucciones que nadie puede seguir.

- **Entornos reales**: {{...}}
- **Qué corre automáticamente en CI antes de publicar**: {{...}}
- **Qué NO corre en CI y hay que hacer a mano**: {{...}} ← el más importante,
  porque es lo que depende de que alguien se acuerde.
- **Una sola autoridad aplica migraciones.** Nunca CLI y consola web a la vez.

## 10. Incidentes

Ante pérdida de datos, exposición de credenciales, acceso indebido o regresión
grave:

1. **Parar** las mutaciones y deploys relacionados.
2. **Informar de inmediato** qué se sabe: alcance, entorno, hora y qué todavía
   no se sabe. Un reporte incompleto y a tiempo vale más que uno completo tarde.
3. **Preservar la evidencia** antes de tocar nada — sin copiar secretos.
4. **Contener** con el mínimo daño; rotar lo que haya que rotar.
5. **Medir el impacto real** con una consulta directa, no leyendo el código.
6. **Recuperar**, verificar servicio y accesos.
7. **Documentar** cronología, causa raíz y qué lo previene — y si genera una
   regla nueva, escribirla en este archivo.

## 11. Cómo se entrega un cambio

"Todo funciona" no es evidencia.

```text
Resultado      — qué se logró y para qué.
Cambios        — archivos/áreas principales y las decisiones que importan.
Datos/seguridad— migraciones, permisos, variables. "No aplica" si corresponde.
Validación     — comando o prueba : resultado REAL. Verificación manual : resultado.
Despliegue     — pasos, orden, y cómo se revierte (o "no aplica").
Pendientes     — lo no ejecutado, el motivo, los supuestos y qué sigue.
```

---

## Mantenimiento de este archivo

**Después de cada bug real, preguntarse: ¿qué regla lo habría evitado?** Si hay
una, escribirla acá con el contexto (qué pasó, cuándo, por qué). Ese es el único
mecanismo que hace que este documento valga algo con el tiempo.

Revisar también cuando cambien el stack, los entornos o el proceso de release.
Y **releer las decisiones de alcance de la sección 1 cada tanto**: se toman con
la información de ese momento, y algunas dejan de tener sentido — un "no" que
era correcto con dos usuarios puede ser un error con veinte.

Mantener las reglas acá y mover los detalles largos a documentos enlazados. Si
este archivo pasa de ~25 KB, algo que está adentro debería estar afuera.

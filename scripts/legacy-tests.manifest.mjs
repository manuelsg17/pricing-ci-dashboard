// ════════════════════════════════════════════════════════════════════════
// Manifiesto de scripts de test legacy — usado por scripts/legacy-tests.test.js
// (Vitest) para correrlos todos como un solo test runner real.
//
// POR QUÉ EXISTE (2026-09-12): antes de esto, `npm run test:all` era una
// cadena de 47 `&&` — 41 alias de npm + 4 llamadas directas a node + 1 script
// Python + 1 check. Funcionaba (cada script fija su exit code según pase o
// falle), pero como test runner tenía 3 problemas reales:
//   1. Un solo fallo corta la cadena — los 46 scripts que venían DESPUÉS del
//      que rompió ni se ejecutan, así que un fallo temprano oculta cuántos
//      hay realmente rotos.
//   2. Cero paralelismo — 47 procesos Node arrancando uno detrás del otro.
//   3. Sin reporte estructurado — para saber cuál de los 47 falló había que
//      leer el nombre del script en el scroll de la terminal.
//
// Este archivo NO reescribe la lógica de ningún test — cada script sigue
// siendo la fuente de verdad de sus propias aserciones (muchos ya tienen su
// propio `assert()` con mensaje). Vitest los corre como procesos hijos y
// verifica el exit code, exactamente el mismo contrato que ya usaba `&&`,
// pero SIN el corte en cadena y CON reporte por test.
//
// Agregar un script nuevo: una línea acá. Si el script necesita Supabase
// local corriendo (ninguno de los actuales lo necesita — todos corren sin
// red, ver comentario de cada uno), documentarlo en su entrada.
// ════════════════════════════════════════════════════════════════════════

export const LEGACY_TESTS = [
  { name: 'bot-mapping', cmd: ['node', 'scripts/test-bot-mapping.mjs'] },
  { name: 'bracket-normalize', cmd: ['node', 'scripts/test-bracket-normalize.mjs'] },
  { name: 'bracket-parity', cmd: ['node', 'scripts/test-bracket-parity.mjs'] },
  { name: 'get-country-config', cmd: ['node', 'scripts/test-getcountryconfig.mjs'] },
  { name: 'catalogs', cmd: ['node', 'scripts/test-catalogs.mjs'] },
  { name: 'weights-cascade', cmd: ['node', 'scripts/test-weights-cascade.mjs'] },
  { name: 'simple-avg-cutoff', cmd: ['node', 'scripts/test-simple-avg-cutoff.mjs'] },
  { name: 'indrive-recent-ref', cmd: ['node', 'scripts/test-indrive-recent-ref.mjs'] },
  { name: 'format', cmd: ['node', 'scripts/test-format.mjs'] },
  { name: 'normalize-competitor', cmd: ['node', 'scripts/test-normalize-competitor.mjs'] },
  { name: 'ingestion-corp', cmd: ['node', 'scripts/test-ingestion-corp.mjs'] },
  {
    name: 'distance-refs-replication',
    cmd: ['node', 'scripts/test-distance-refs-replication.mjs'],
  },
  { name: 'bracket-order', cmd: ['node', 'scripts/test-bracket-order.mjs'] },
  { name: 'bracket-grouping', cmd: ['node', 'scripts/test-bracket-grouping.mjs'] },
  { name: 'indrive-avg', cmd: ['node', 'scripts/test-indrive-avg.mjs'] },
  { name: 'bot-coverage', cmd: ['node', 'scripts/test-bot-coverage.mjs'] },
  { name: 'representativity', cmd: ['node', 'scripts/test-representativity.mjs'] },
  { name: 'ci-competitors', cmd: ['node', 'scripts/test-ci-competitors.mjs'] },
  { name: 'monitoring', cmd: ['node', 'scripts/test-monitoring.mjs'] },
  { name: 'timeslot-label', cmd: ['node', 'scripts/test-timeslot-label.mjs'] },
  { name: 'session-fronts', cmd: ['node', 'scripts/test-session-fronts.mjs'] },
  { name: 'competitor-bonus', cmd: ['node', 'scripts/test-competitor-bonus.mjs'] },
  { name: 'yango-gmv-bonus', cmd: ['node', 'scripts/test-yango-gmv-bonus.mjs'] },
  { name: 'upload-parsers', cmd: ['node', 'scripts/test-upload-parsers.mjs'] },
  { name: 'project-tasks', cmd: ['node', 'scripts/test-project-tasks.mjs'] },
  { name: 'gantt', cmd: ['node', 'scripts/test-gantt.mjs'] },
  { name: 'paginar-todo', cmd: ['node', 'scripts/test-paginar-todo.mjs'] },
  { name: 'yango-brand', cmd: ['node', 'scripts/test-yango-brand.mjs'] },
  { name: 'effective-price', cmd: ['node', 'scripts/test-effective-price.mjs'] },
  { name: 'i18n-parity', cmd: ['node', 'scripts/test-i18n-parity.mjs'] },
  { name: 'date-iso', cmd: ['node', 'scripts/test-date-iso.mjs'] },
  { name: 'error-fingerprint', cmd: ['node', 'scripts/test-error-fingerprint.mjs'] },
  { name: 'session-persistence', cmd: ['node', 'scripts/test-session-persistence.mjs'] },
  { name: 'tab-lease', cmd: ['node', 'scripts/test-tab-lease.mjs'] },
  { name: 'durability', cmd: ['node', 'scripts/simulate-durability.mjs'] },
  { name: 'session-duration', cmd: ['node', 'scripts/test-session-duration.mjs'] },
  { name: 'idle-detection', cmd: ['node', 'scripts/test-idle-detection.mjs'] },
  { name: 'close-token', cmd: ['node', 'scripts/test-session-close-token.mjs'] },
  { name: 'chunk-retry', cmd: ['node', 'scripts/test-chunk-retry.mjs'] },
  { name: 'presencia', cmd: ['node', 'scripts/test-presencia.mjs'] },
  { name: 'frentes-pendientes', cmd: ['node', 'scripts/test-frentes-pendientes.mjs'] },
  { name: 'data-entry-counts', cmd: ['node', 'scripts/test-data-entry-counts.mjs'] },
  { name: 'data-entry-keys', cmd: ['node', 'scripts/test-data-entry-keys.mjs'] },
  { name: 'data-entry-rows', cmd: ['node', 'scripts/test-data-entry-rows.mjs'] },
  { name: 'data-entry-derived', cmd: ['node', 'scripts/test-data-entry-derived.mjs'] },
  { name: 'config-table', cmd: ['node', 'scripts/test-config-table.mjs'] },
  { name: 'migration-collisions', cmd: ['node', 'scripts/check-migration-collisions.mjs'] },
  { name: 'nav-sections-drift', cmd: ['node', 'scripts/check-nav-sections-drift.mjs'] },
  // Único no-Node: corre sin red/DB/psycopg2 (ver cabecera del script propio).
  { name: 'bot-sync-py', cmd: ['python3', 'scripts/bot-sync/test_bot_sync.py'] },
]

// ════════════════════════════════════════════════════════════════════════
// Test runner real para los 47 scripts legacy de scripts/*.mjs + el Python
// de bot-sync — ver scripts/legacy-tests.manifest.mjs para el porqué.
//
// Cada entrada del manifiesto se corre como proceso hijo independiente
// (exactamente el mismo comando que antes se invocaba con `npm run test:x` /
// `node scripts/x.mjs`), así que la lógica de cada test no cambia — lo que
// cambia es el harness: Vitest corre los 47 en paralelo, no corta en el
// primer fallo, y reporta cada uno con su propio nombre en el árbol de
// resultados.
// ════════════════════════════════════════════════════════════════════════
import { describe, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { LEGACY_TESTS } from './legacy-tests.manifest.mjs'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('legacy scripts (scripts/*.mjs + bot-sync python)', () => {
  for (const { name, cmd } of LEGACY_TESTS) {
    it(name, async () => {
      const [bin, ...args] = cmd
      try {
        await execFileAsync(bin, args, {
          cwd: ROOT,
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        })
      } catch (err) {
        // execFile lanza en exit code != 0 — el error trae stdout/stderr
        // del script, que es justo lo que hacía falta ver cuando `&&`
        // cortaba la cadena sin mostrar nada más. Se propaga tal cual para
        // que el reporte de Vitest muestre la salida real del script.
        const detail = [err.stdout, err.stderr].filter(Boolean).join('\n')
        throw new Error(`${cmd.join(' ')} → exit ${err.code}\n${detail}`)
      }
    })
  }
})

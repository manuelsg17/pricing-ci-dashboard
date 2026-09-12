import { defineConfig } from 'vitest/config'

// Test runner real para el proyecto (2026-09-12) — ver scripts/legacy-tests.
// manifest.mjs para el porqué. `include` apunta solo a scripts/*.test.js:
// los tests de componentes/UI no existen todavía (fuera de alcance de este
// cambio), así que no hace falta jsdom ni configuración de React acá.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.js'],
    testTimeout: 60_000,
    reporters: ['default'],
  },
})

// ════════════════════════════════════════════════════════════════════════
// Playwright — E2E de Ingresar CI (pendiente de adopción desde CLAUDE.md,
// primera pieza real: 2026-09-07). Corre SIEMPRE contra Supabase LOCAL
// (127.0.0.1:54321) — nunca contra producción, ver e2e/global-setup.mjs.
//
// Requisitos antes de correr `npx playwright test`:
//   1. `colima start` (o el runtime de Docker que uses) + `npx supabase start`
//   2. Las cuentas e2e-ci@local.test y e2e-ci-2@local.test se crean solas
//      (Admin API) la primera vez — ver e2e/global-setup.mjs.
// ════════════════════════════════════════════════════════════════════════
import { defineConfig, devices } from '@playwright/test'

const BASE_URL = 'http://localhost:5173/pricing-ci-dashboard/'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // los tests comparten Supabase local; evitar carreras de datos
  retries: 0,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.mjs',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    storageState: './e2e/.auth/admin.json',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL + 'dashboard',
    reuseExistingServer: true,
    timeout: 30_000,
  },
})

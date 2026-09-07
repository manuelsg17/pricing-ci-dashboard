// ════════════════════════════════════════════════════════════════════════
// E2E — Ingresar CI: Delivery/Cargo (primer test real de la suite, 2026-09-07)
//
// Cubre la clase de bug más cara y repetida del proyecto (CLAUDE.md §1):
// que el trabajo sobreviva a un F5 REAL, no solo a una navegación de React.
// Corre contra Supabase LOCAL — nunca contra producción (ver playwright.config.js
// y e2e/global-setup.mjs).
//
// Antes de correr: `colima start` (o el runtime que uses) + `npx supabase start`.
// Deja el ambiente sucio a propósito si algo falla a mitad de camino, para
// poder inspeccionar — el afterEach limpia SIEMPRE que el test haya llegado
// al final (éxito o fallo controlado), nunca en un crash de Playwright.
// ════════════════════════════════════════════════════════════════════════
import { test, expect } from '@playwright/test'
import pg from 'pg'

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

async function withDb(fn) {
  const client = new pg.Client({ connectionString: DB_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function cleanupTestData() {
  await withDb(async (db) => {
    await db.query(`DELETE FROM pricing_observations WHERE uploaded_by = 'e2e-ci@local.test'`)
    await db.query(`DELETE FROM ci_bucket_writes WHERE user_email = 'e2e-ci@local.test'`)
    await db.query(`DELETE FROM ci_sessions WHERE user_email = 'e2e-ci@local.test'`)
    await db.query(`DELETE FROM ci_active_sessions WHERE user_email = 'e2e-ci@local.test'`)
  })
}

test.beforeEach(async () => {
  await cleanupTestData()
})
test.afterEach(async () => {
  await cleanupTestData()
})

// Marca TODAS las filas visibles como "sin oferta". El botón de cada fila NO
// desaparece al resolverla (sigue ahí por si el hub se arrepiente), así que
// hay que iterar por índice y verificar el estado real de cada fila (sus
// badges de "no data"), no la cantidad de botones — eso fue el primer bug de
// este mismo test.
async function markAllRowsNoOffer(page) {
  const rowCount = await page.locator('.de-cat-row').count()
  for (let i = 0; i < rowCount; i++) {
    const row = page.locator('.de-cat-row').nth(i)
    const cells = await row.locator('.de-cell').count()
    const resolved = await row.locator('.de-nodata-badge').count()
    if (resolved < cells) {
      await row.locator('.de-sd-row-btn').click()
    }
  }
}

test('Delivery: F5 real conserva el borrador sin perder lo tipeado', async ({ page }) => {
  await page.goto('dataentry')
  await page.getByRole('button', { name: 'Delivery', exact: true }).click()
  await page.getByRole('button', { name: '▶ Start Session' }).first().click()

  // Marcar la primera fila completa como "sin oferta" — la forma más rápida
  // de tener una fila 100% resuelta (rowState='full') sin depender de que el
  // layout de columnas cambie con el tiempo.
  await page.locator('.de-sd-row-btn').first().click()
  await expect(page.locator('.de-cat-row--partial')).toHaveCount(0)

  await page
    .getByRole('button', { name: /Save progress/ })
    .first()
    .click()
  await expect(page.locator('.de-msg')).toContainText('saved')

  // ── F5 REAL — no history.pushState, una recarga de verdad del navegador ──
  await page.reload()

  // El borrador de Delivery debe aparecer en el aviso de "sin terminar" y
  // "Ir ahí" debe devolver a la pestaña correcta con el trabajo intacto.
  await expect(page.locator('text=/unfinished draft/i')).toBeVisible()
  await page.getByRole('button', { name: 'Go there' }).first().click()
  await expect(page.getByRole('button', { name: 'Delivery', exact: true })).toHaveClass(/active/)

  // La fila que se guardó sigue reflejada en el servidor (no solo en la UI):
  // esto es lo que un F5 sin este mecanismo perdería.
  const { rows } = await withDb((db) =>
    db.query(
      `SELECT count(*)::int AS n FROM pricing_observations
       WHERE uploaded_by = 'e2e-ci@local.test' AND category = 'Delivery'`
    )
  )
  expect(rows[0].n).toBeGreaterThan(0)
})

test('Cargo: sesión completa cierra de punta a punta sin duplicar filas', async ({ page }) => {
  await page.goto('dataentry')
  await page.getByRole('button', { name: 'Cargo', exact: true }).click()
  await page.getByRole('button', { name: '▶ Start Session' }).first().click()

  // 12 rutas × 2 competidores × 3 turnos = 36 filas de categoría.
  await markAllRowsNoOffer(page)
  await expect(page.locator('.de-cat-row--partial')).toHaveCount(0)

  await page
    .getByRole('button', { name: /End Session/ })
    .first()
    .click()
  await expect(page.locator('.de-msg')).toContainText(/72 records saved/)

  // Sin duplicados: 12 rutas × 2 competidores × 3 turnos = 72, ni una fila más.
  const { rows } = await withDb((db) =>
    db.query(
      `SELECT count(*)::int AS n FROM pricing_observations
       WHERE uploaded_by = 'e2e-ci@local.test' AND category = 'Cargo'`
    )
  )
  expect(rows[0].n).toBe(72)

  // La sesión quedó historizada y no hay latido colgado.
  const { rows: sessionRows } = await withDb((db) =>
    db.query(
      `SELECT rows_saved FROM ci_sessions WHERE user_email = 'e2e-ci@local.test' ORDER BY id DESC LIMIT 1`
    )
  )
  expect(sessionRows[0]?.rows_saved).toBe(72)
  const { rows: activeRows } = await withDb((db) =>
    db.query(
      `SELECT count(*)::int AS n FROM ci_active_sessions WHERE user_email = 'e2e-ci@local.test'`
    )
  )
  expect(activeRows[0].n).toBe(0)
})

test('Delivery y Cargo no comparten marca de agua de guardado (sin conflicto falso)', async ({
  page,
}) => {
  await page.goto('dataentry')

  await page.getByRole('button', { name: 'Delivery', exact: true }).click()
  await page.getByRole('button', { name: '▶ Start Session' }).first().click()
  await page.locator('.de-sd-row-btn').first().click()
  await page
    .getByRole('button', { name: /Save progress/ })
    .first()
    .click()
  await expect(page.locator('.de-msg')).toContainText('saved')

  // Cambiar de pestaña NO cierra la sesión (el hub puede saltar libremente,
  // pedido 2026-07-24) — no hace falta "Start Session" de nuevo para Cargo.
  await page.getByRole('button', { name: 'Cargo', exact: true }).click()
  await page.locator('.de-sd-row-btn').first().click()
  await page
    .getByRole('button', { name: /Save progress/ })
    .first()
    .click()

  // Si compartieran marca de agua, este segundo guardado hubiera disparado
  // el panel de conflicto (mig 191) en vez de guardar.
  await expect(page.locator('.de-conflict')).toHaveCount(0)
  await expect(page.locator('.de-msg')).toContainText('saved')

  const { rows } = await withDb((db) =>
    db.query(
      `SELECT zone_key, write_seq FROM ci_bucket_writes
       WHERE user_email = 'e2e-ci@local.test' ORDER BY zone_key`
    )
  )
  expect(rows.map((r) => r.zone_key).sort()).toEqual(['Cargo', 'Delivery'])
})

// ════════════════════════════════════════════════════════════════════════
// E2E — Ingresar CI: reabrir una sesión del historial + auto-load silencioso
// (2026-09, sexto corte del refactor de DataEntry.jsx). Cubre
// useCiSessionHistory.js: `openHistorySession` (botón "Abrir" del
// historial) y `loadObservationsIntoForm` (el mismo camino, disparado
// automáticamente cuando el hub vuelve a un bucket ya guardado sin
// borrador local). Corre SIEMPRE contra Supabase LOCAL (ver
// playwright.config.js).
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

test.beforeEach(cleanupTestData)
test.afterEach(cleanupTestData)

// Mismo helper que el resto de la suite: siempre la PRIMERA fila sin
// resolver, porque una ruta completa se pliega sola (auto-colapso) y corre
// los índices.
async function markAllRowsNoOffer(page) {
  for (let guard = 0; guard < 500; guard++) {
    const pending = page
      .locator('.de-cat-row')
      .filter({ has: page.locator('.de-cell:not(.de-cell--na):not(.de-cell--nodata)') })
    if ((await pending.count()) === 0) return
    await pending.first().locator('.de-sd-row-btn').click()
  }
  throw new Error('markAllRowsNoOffer: quedaron filas sin resolver')
}

test('Reabrir una sesión terminada desde el Historial recarga la grilla', async ({ page }) => {
  await page.goto('dataentry')
  await page.getByRole('button', { name: 'Delivery', exact: true }).click()
  await page.getByRole('button', { name: '▶ Start Session' }).first().click()
  await markAllRowsNoOffer(page)
  await page
    .getByRole('button', { name: /End Session/ })
    .first()
    .click()
  await expect(page.locator('.de-msg')).toContainText(/records saved/)

  // La grilla queda vacía a propósito tras Terminar (evita que el autosave
  // la resucite) — sin Historial, no hay forma de volver a ver esos datos
  // sin recorrer "Ver lo guardado".
  await expect(page.locator('.de-cat-row--partial')).toHaveCount(0)

  // Reabrir la MISMA sesión que ya está en pantalla es un no-op adrede
  // (openHistorySession lo detecta y avisa "ya estás viendo esto" en vez de
  // recargar) — cambiar de pestaña primero para que el "Abrir" de abajo
  // ejercite el camino real de recarga.
  await page.getByRole('button', { name: 'Cargo', exact: true }).click()

  await page.getByRole('button', { name: '📋 Session History' }).click()
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByRole('button', { name: 'Open' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Open' }).first().click()

  await expect(page.locator('.de-msg')).toContainText(/session loaded/i)
  // Las 144 celdas quedan restauradas y ninguna ruta a medias — las tarjetas
  // completas se auto-colapsan (revisión UX 2026-09), así que el pill de
  // progreso es la señal confiable, no las celdas individuales.
  await expect(page.locator('.de-progress-pill')).toContainText('144/144')
  await expect(page.locator('.de-cat-row--partial')).toHaveCount(0)
})

test('Volver a un bucket ya guardado sin borrador local lo recarga solo (auto-load silencioso)', async ({
  page,
}) => {
  await page.goto('dataentry')
  await page.getByRole('button', { name: 'Delivery', exact: true }).click()
  await page.getByRole('button', { name: '▶ Start Session' }).first().click()
  await markAllRowsNoOffer(page)
  await page
    .getByRole('button', { name: /End Session/ })
    .first()
    .click()
  await expect(page.locator('.de-msg')).toContainText(/records saved/)

  // Sin draft local (Terminar lo borró) y sin sesión activa: un F5 real
  // vuelve a este mismo bucket con la grilla vacía en memoria, así que el
  // efecto de auto-load debe traer lo guardado sin que el hub pida nada.
  //
  // Borra la marca "recién terminado" (P2-15, 5 min de ventana) a mano: esa
  // marca existe justamente para que un auto-load NO resucite un bucket que
  // el hub acaba de cerrar a propósito — comportamiento correcto y ya
  // cubierto por otros tests, no lo que este test quiere ejercitar (el
  // auto-load en sí, para cuando el hub vuelve más tarde o desde otro
  // dispositivo).
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('de:finished:')) localStorage.removeItem(k)
    }
  })
  await page.reload()
  await page.getByRole('button', { name: 'Delivery', exact: true }).click()
  // Las tarjetas completas se auto-colapsan (revisión UX 2026-09): el pill de
  // progreso es la señal confiable de que el auto-load trajo las 144 celdas,
  // no las celdas individuales (quedan fuera del DOM mientras están colapsadas).
  await expect(page.locator('.de-progress-pill')).toContainText('144/144', { timeout: 10_000 })
  await expect(page.locator('.de-cat-row--partial')).toHaveCount(0)

  // Y la sesión se reactivó sola (Guardar/Terminar visibles, no "Start Session").
  await expect(page.getByRole('button', { name: /End Session/ }).first()).toBeVisible()
})

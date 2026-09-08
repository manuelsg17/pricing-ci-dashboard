// ════════════════════════════════════════════════════════════════════════
// E2E — Ingresar CI: TukTuk (frente por distrito, con ETA) y dos hubs a la
// vez sobre el mismo frente (2026-09-07, revisión UX/código).
//
// Complementa e2e/ci-delivery-cargo.spec.js: aquel cubre los frentes nuevos;
// este cubre un frente "viejo" (TukTuk: distrito + ETA + zona en BD) y el
// escenario que más miedo da en producción — dos hubs cargando el mismo
// frente el mismo día — que hasta hoy solo se había probado a mano
// (memoria del proyecto: "Corp con varios hubs", 2026-08-10).
// Corre SIEMPRE contra Supabase LOCAL (ver playwright.config.js).
// ════════════════════════════════════════════════════════════════════════
import { test, expect } from '@playwright/test'
import pg from 'pg'

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HUB1 = 'e2e-ci@local.test'
const HUB2 = 'e2e-ci-2@local.test'

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
    for (const email of [HUB1, HUB2]) {
      await db.query(`DELETE FROM pricing_observations WHERE uploaded_by = $1`, [email])
      await db.query(`DELETE FROM ci_bucket_writes WHERE user_email = $1`, [email])
      await db.query(`DELETE FROM ci_sessions WHERE user_email = $1`, [email])
      await db.query(`DELETE FROM ci_active_sessions WHERE user_email = $1`, [email])
    }
  })
}

test.beforeEach(cleanupTestData)
test.afterEach(cleanupTestData)

// Igual que en ci-delivery-cargo.spec.js: siempre la PRIMERA fila sin
// resolver, porque una ruta completa se pliega sola y corre los índices.
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

test('TukTuk: distrito propio, F5 real y cierre completo con zona en BD', async ({ page }) => {
  await page.goto('dataentry')
  await page.getByRole('button', { name: 'TukTuk', exact: true }).click()
  // Distrito habilitado (TUKTUK_ENABLED_DISTRICTS) — el primero por defecto
  // puede variar, así que se elige uno explícito.
  await page.getByRole('button', { name: 'Comas', exact: true }).click()
  await page.getByRole('button', { name: '▶ Start Session' }).first().click()

  // Con ETA visible (TukTuk sí lo lleva) el S/D de fila debe resolver la
  // fila igual: el ETA es opcional y no puede dejarla "a medias".
  await expect(page.locator('.de-eta-input').first()).toBeVisible()
  await page.locator('.de-sd-row-btn').first().click()
  await expect(page.locator('.de-cat-row--partial')).toHaveCount(0)
  await page
    .getByRole('button', { name: /Save progress/ })
    .first()
    .click()
  await expect(page.locator('.de-msg')).toContainText('saved')

  // ── F5 REAL: el distrito activo y el borrador deben sobrevivir ──
  await page.reload()
  await expect(page.locator('text=/unfinished draft/i')).toBeVisible()
  await page.getByRole('button', { name: 'Go there' }).first().click()
  await expect(page.getByRole('button', { name: 'Comas', exact: true })).toHaveClass(/active/)

  await markAllRowsNoOffer(page)
  await page
    .getByRole('button', { name: /End Session/ })
    .first()
    .click()
  await expect(page.locator('.de-msg')).toContainText(/records saved/)

  // 4 rutas × 2 competidores × 3 turnos = 24 filas, todas con zone='Comas'
  // (la mig 135 persiste el distrito; sin zone la fila cae en "Lima" a secas
  // y el dashboard la mezcla con otro distrito).
  const { rows } = await withDb((db) =>
    db.query(
      `SELECT zone, count(*)::int AS n FROM pricing_observations
       WHERE uploaded_by = $1 AND category = 'TukTuk' GROUP BY zone`,
      [HUB1]
    )
  )
  expect(rows).toEqual([{ zone: 'Comas', n: 24 }])
})

test('Dos hubs a la vez sobre Delivery: cada uno guarda lo suyo, sin conflicto ni pisadas', async ({
  browser,
}) => {
  const ctx1 = await browser.newContext({ storageState: './e2e/.auth/admin.json' })
  const ctx2 = await browser.newContext({ storageState: './e2e/.auth/hub2.json' })
  const p1 = await ctx1.newPage()
  const p2 = await ctx2.newPage()
  try {
    for (const p of [p1, p2]) {
      await p.goto('dataentry')
      await p.getByRole('button', { name: 'Delivery', exact: true }).click()
      await p.getByRole('button', { name: '▶ Start Session' }).first().click()
    }
    // Los dos resuelven la MISMA primera fila y guardan casi a la vez.
    await p1.locator('.de-sd-row-btn').first().click()
    await p2.locator('.de-sd-row-btn').first().click()
    await Promise.all([
      p1
        .getByRole('button', { name: /Save progress/ })
        .first()
        .click(),
      p2
        .getByRole('button', { name: /Save progress/ })
        .first()
        .click(),
    ])
    await expect(p1.locator('.de-msg')).toContainText('saved')
    await expect(p2.locator('.de-msg')).toContainText('saved')
    // El conflicto (mig 191) es por hub: otro hub en el mismo frente NO es
    // un conflicto — son dos muestras (memoria "Corp con varios hubs").
    await expect(p1.locator('.de-conflict')).toHaveCount(0)
    await expect(p2.locator('.de-conflict')).toHaveCount(0)

    // El segundo hub también ve al primero "en vivo" en el frente (cartel de
    // presencia) — es el aviso que evita que dos hubs carguen sin saberlo.
    // Tras un F5 el segundo hub sigue en Delivery (borrador) y el cartel se
    // arma con el nombre corto del email (parte antes de la @).
    await p2.reload()
    await p2.getByRole('button', { name: 'Go there' }).first().click()
    await expect(p2.locator('.de-presence-banner')).toContainText(HUB1.split('@')[0], {
      timeout: 15_000,
    })

    const { rows } = await withDb((db) =>
      db.query(
        `SELECT uploaded_by, count(*)::int AS n FROM pricing_observations
         WHERE uploaded_by = ANY($1) AND category = 'Delivery'
         GROUP BY uploaded_by ORDER BY uploaded_by`,
        [[HUB1, HUB2]]
      )
    )
    expect(rows.map((r) => r.uploaded_by).sort()).toEqual([HUB1, HUB2].sort())
    expect(rows[0].n).toBe(rows[1].n)
    expect(rows[0].n).toBeGreaterThan(0)

    const { rows: writes } = await withDb((db) =>
      db.query(
        `SELECT user_email FROM ci_bucket_writes WHERE user_email = ANY($1) ORDER BY user_email`,
        [[HUB1, HUB2]]
      )
    )
    expect(writes.map((w) => w.user_email).sort()).toEqual([HUB1, HUB2].sort())
  } finally {
    await ctx1.close()
    await ctx2.close()
  }
})

test('Mismo hub, dos pestañas: la que trabaja de verdad no pierde el candado tras su propio F5', async ({
  browser,
}) => {
  // Bug real encontrado en navegador (2026-09-07, revisión de código):
  // `leaseEngaged` contaba `filledCount > 0` como "trabajo propio" aunque el
  // filledCount viniera de un borrador RESTAURADO que la pestaña nunca creó
  // (localStorage es compartido entre pestañas del mismo origen). Una
  // segunda pestaña abierta solo para mirar heredaba ese filledCount y podía
  // robarle el candado a la pestaña dueña justo en la ventana en que su
  // candado queda "ocioso" tras un F5 real — la pestaña que sí tenía el
  // trabajo quedaba en modo lectura después de recargar.
  //
  // Mismo CONTEXTO (mismo storage, como dos pestañas reales del mismo hub),
  // NO dos contextos como el test de "dos hubs" de arriba.
  const ctx = await browser.newContext({ storageState: './e2e/.auth/admin.json' })
  const pA = await ctx.newPage()
  const pB = await ctx.newPage()
  try {
    // A abre Cargo, inicia sesión y resuelve una fila — A es la dueña real.
    await pA.goto('dataentry')
    await pA.getByRole('button', { name: 'Cargo', exact: true }).click()
    await pA.getByRole('button', { name: '▶ Start Session' }).first().click()
    await pA.locator('.de-sd-row-btn').first().click()
    await expect(pA.locator('.de-msg--warn')).toHaveCount(0)

    // B abre el MISMO frente sin iniciar sesión — solo mirar. Restaura el
    // mismo borrador compartido (mismo localStorage) y debe quedar en modo
    // lectura de inmediato: A ya lo tiene.
    await pB.goto('dataentry')
    await pB.getByRole('button', { name: 'Cargo', exact: true }).click()
    await expect(pB.locator('.de-msg--warn')).toBeVisible({ timeout: 10_000 })

    // ── F5 REAL de la pestaña DUEÑA ── — acá reproducía el bug.
    await pA.reload()
    await pA.getByRole('button', { name: 'Go there' }).first().click()
    await expect(pA.getByRole('button', { name: 'Cargo', exact: true })).toHaveClass(/active/)
    await expect(pA.locator('.de-msg--warn')).toHaveCount(0)
    // B sigue correctamente en modo lectura — el candado no le llegó por accidente.
    await expect(pB.locator('.de-msg--warn')).toBeVisible()
  } finally {
    await ctx.close()
  }
})

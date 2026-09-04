import { useCallback, useMemo } from 'react'
import { canonicalCompetitorName } from '../lib/normalize'
import { useConfigTable } from './useConfigTable'

// CRUD de competitor_commissions sobre useConfigTable (carga por país,
// edits por fila, live-sync). Consumidores: CommissionsConfig (editor),
// Rentabilidad y BonusesConfig (solo `commissions` / `allRows`).
export function useCompetitorCommissions(city, country) {
  const tbl = useConfigTable({
    table: 'competitor_commissions',
    // null = "todavía sin país": el hook no fetchea hasta recibir uno.
    country: country || null,
    query: (q) => q.order('competitor_name'),
    newRow: () => ({ competitor_name: '', city: null, commission_pct: 0 }),
    toPayload: (row) => ({
      competitor_name: canonicalCompetitorName(row.competitor_name),
      city: row.city || null,
      country,
      commission_pct: Number(row.commission_pct),
      updated_at: new Date().toISOString(),
    }),
  })
  const { rows: allRows, loading, error, saveRow, deleteRow, addRow, reload } = tbl

  // Returns commission_pct for a competitor, preferring city-specific over global (city=null).
  // Defense-in-depth: el nombre del competidor en competitor_commissions
  // tiene que matchear el de pricing_observations al hacer commissions[comp].
  // Si en la tabla quedó un nombre legacy ('Yango Comfort' vs 'YangoComfort'),
  // ambos lados (lookup en Rentabilidad y este map) terminan con el mismo
  // canónico y la búsqueda funciona. La BD también lo garantiza (mig 239).
  const commissions = useMemo(() => {
    const result = {}
    for (const row of allRows) {
      if (row._new) continue
      const name = canonicalCompetitorName(row.competitor_name) || row.competitor_name
      if (row.city === null || row.city === undefined) {
        if (result[name] === undefined) result[name] = row.commission_pct
      }
    }
    for (const row of allRows) {
      if (row._new) continue
      const name = canonicalCompetitorName(row.competitor_name) || row.competitor_name
      if (row.city === city) result[name] = row.commission_pct
    }
    return result
  }, [allRows, city])

  // Devuelve { ok, code, error }: `code` es un identificador estable para
  // que la UI traduzca ('invalid_competitor' | 'invalid_pct' | 'db') y
  // `error` el objeto crudo de Supabase cuando lo hay (la UI lo pasa por
  // dbErrorText, nunca lo muestra tal cual).
  const saveCommission = useCallback(
    async (row) => {
      const pct = Number(row.commission_pct)
      if (!row.competitor_name?.trim())
        return { ok: false, code: 'invalid_competitor', error: null }
      if (!Number.isFinite(pct) || pct < 0 || pct > 100)
        return { ok: false, code: 'invalid_pct', error: null }
      return saveRow(row)
    },
    [saveRow]
  )

  const deleteCommission = useCallback(async (id) => (await deleteRow(id)).ok, [deleteRow])

  return {
    allRows,
    commissions,
    loading,
    error,
    saveCommission,
    deleteCommission,
    addRow,
    reload,
    // Para el editor: edits/dirty por fila.
    getField: tbl.getField,
    setField: tbl.setField,
    isDirty: tbl.isDirty,
    isNew: tbl.isNew,
    saving: tbl.saving,
  }
}

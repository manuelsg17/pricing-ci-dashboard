import { useCallback } from 'react'
import { useConfigTable } from './useConfigTable'

// CRUD de competitive_bands (mig 124) — espejo de useCompetitorCommissions.js
// pero sin dimensión de ciudad (la banda aplica a TODAS las ciudades/brackets
// del país a la vez, por diseño). Carga, edits y live-sync vienen de
// useConfigTable.
export function useCompetitiveBands(country) {
  const tbl = useConfigTable({
    table: 'competitive_bands',
    country: country || null,
    query: (q) => q.order('competitor_name').order('category'),
    newRow: () => ({
      competitor_name: '',
      category: '',
      min_pct: -15,
      max_pct: -5,
      note: '',
      is_active: true,
    }),
    toPayload: (row) => ({
      country,
      competitor_name: row.competitor_name,
      category: row.category,
      min_pct: Number(row.min_pct),
      max_pct: Number(row.max_pct),
      note: row.note || null,
      is_active: row.is_active !== false,
      updated_at: new Date().toISOString(),
    }),
  })
  const { rows: allRows, loading, error, saveRow, deleteRow, addRow, reload } = tbl

  // { ok, code, error } — `error` es el objeto crudo de Supabase; la UI lo
  // traduce con dbErrorText (antes devolvía err.message y se mostraba tal cual).
  const saveBand = useCallback((row) => saveRow(row), [saveRow])
  const deleteBand = useCallback(async (id) => (await deleteRow(id)).ok, [deleteRow])

  return {
    allRows,
    loading,
    error,
    saveBand,
    deleteBand,
    addRow,
    reload,
    getField: tbl.getField,
    setField: tbl.setField,
    isDirty: tbl.isDirty,
    isNew: tbl.isNew,
    saving: tbl.saving,
  }
}

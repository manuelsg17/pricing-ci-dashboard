import { useState } from 'react'
import { countRawData, fetchAllRawData } from './useRawData'
import { exportRawDataXlsx } from '../lib/rawDataExport'

// Extraído de RawData.jsx (Fase 1.2) — agrupa el flujo de export a .xlsx
// (conteo fresco + confirmación por volumen + fetch paginado con progreso).

// Por encima de esto, se pide confirmación antes de exportar (el fetch
// paginado + armado del xlsx puede tardar). Por encima del threshold "grande"
// se agrega una advertencia más fuerte — ciudades sin filtrar pueden tener
// cientos de miles de filas (ej. Bogotá/Lima).
const EXPORT_CONFIRM_THRESHOLD = 5000
const EXPORT_LARGE_WARNING_THRESHOLD = 50000

export function useRawDataExport({ filters, dbCity, dbCategory, toast, confirm }) {
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(null) // { loaded, total }

  const handleExport = async () => {
    if (exporting) return
    setExporting(true)
    try {
      // snapshotIso: mismo instante para el conteo y para el fetch completo,
      // así el número del diálogo de confirmación coincide con lo que
      // realmente se exporta aunque entre data nueva (sync del bot) durante
      // los varios minutos que puede tardar un export grande.
      const snapshotIso = new Date().toISOString()
      // Conteo fresco (no el `total` del hook paginado, que puede estar
      // stale un instante si el usuario acaba de cambiar un filtro).
      const freshTotal = await countRawData(filters, { snapshotIso })
      if (freshTotal === 0) {
        toast.err('No hay filas para exportar con los filtros actuales.')
        return
      }
      if (freshTotal > EXPORT_CONFIRM_THRESHOLD) {
        const ok = await confirm({
          title: 'Exportar data raw',
          message:
            freshTotal > EXPORT_LARGE_WARNING_THRESHOLD
              ? `Vas a exportar ${freshTotal.toLocaleString()} filas a Excel. Esto puede tardar varios minutos y usar bastante memoria del navegador — si podés, acotá por categoría o rango de fechas primero. ¿Exportar de todos modos?`
              : `Vas a exportar ${freshTotal.toLocaleString()} filas a Excel. Puede tardar unos segundos. ¿Continuar?`,
          confirmText: 'Exportar',
        })
        if (!ok) return
      }
      setExportProgress({ loaded: 0, total: freshTotal })
      const allRows = await fetchAllRawData(filters, {
        snapshotIso,
        onProgress: (loaded, totalCount) => setExportProgress({ loaded, total: totalCount }),
      })
      exportRawDataXlsx({ rows: allRows, dbCity, dbCategory })
      toast.ok(`${allRows.length.toLocaleString()} filas exportadas.`)
    } catch (e) {
      toast.err('Error al exportar: ' + e.message)
    } finally {
      setExporting(false)
      setExportProgress(null)
    }
  }

  return { exporting, exportProgress, handleExport }
}

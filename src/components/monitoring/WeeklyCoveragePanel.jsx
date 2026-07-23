import { useMemo } from 'react'
import { BRACKET_LABELS } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

// Matriz semanal de cobertura (pedido 9): filas = (ciudad × tipo de CI),
// columnas = los 6 brackets, celda = datapoints manuales acumulados en la
// semana ISO activa. Deliberadamente SIN ningún cálculo de "esperado"/color
// de cumplimiento — el admin pidió ver los números crudos para mapear un
// mínimo aceptable él mismo; el tinte de fondo acá es puramente relativo
// (más oscuro = más datapoints que el resto de la tabla), no un veredicto.
function tipoLabel(t, tipo, baseCity) {
  switch (tipo) {
    case 'Corp':
      return 'Corp'
    case 'TukTuk':
      return 'TukTuk'
    case 'Airport_A':
      return `${baseCity} ${t('monitoring.coverage_airport_a')}`
    case 'Airport_B':
      return `${baseCity} ${t('monitoring.coverage_airport_b')}`
    default:
      return baseCity
  }
}

function heatStyle(n, max) {
  if (!n || !max) return {}
  const alpha = Math.min(0.85, 0.12 + (n / max) * 0.6)
  return { background: `rgba(34, 197, 94, ${alpha.toFixed(2)})` }
}

export default function WeeklyCoveragePanel({
  year,
  week,
  rowKeys,
  cellByRowBracket,
  brackets,
  loading,
  failed,
  onPrevWeek,
  onNextWeek,
  onCurrentWeek,
}) {
  const { t } = useI18n()

  const maxCell = useMemo(() => {
    let m = 0
    for (const v of Object.values(cellByRowBracket)) if (v > m) m = v
    return m
  }, [cellByRowBracket])

  return (
    <div className="mon-panel">
      <div className="mon-panel__head" style={{ justifyContent: 'space-between' }}>
        <h2>{t('monitoring.coverage_title')}</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button size="sm" variant="outline" onClick={onPrevWeek} disabled={loading}>
            ◀
          </Button>
          <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
            {t('monitoring.coverage_week', { year, week })}
          </span>
          <Button size="sm" variant="outline" onClick={onNextWeek} disabled={loading}>
            ▶
          </Button>
          <Button size="sm" variant="outline" onClick={onCurrentWeek} disabled={loading}>
            {t('monitoring.coverage_this_week')}
          </Button>
        </div>
      </div>
      <div className="mon-panel__subtitle">{t('monitoring.coverage_subtitle')}</div>

      {failed ? (
        <div className="de-msg de-msg--err">{t('monitoring.failed')}</div>
      ) : loading ? (
        <div className="mon-empty">{t('dataentry.searching')}</div>
      ) : rowKeys.length === 0 ? (
        <div className="mon-empty">{t('monitoring.coverage_empty')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="de-history-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>{t('monitoring.coverage_col_type')}</th>
                {brackets.map((b) => (
                  <th key={b}>{BRACKET_LABELS[b]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowKeys.map(({ base_city, tipo }) => (
                <tr key={`${base_city}|${tipo}`}>
                  <td style={{ textAlign: 'left', fontWeight: 600 }}>
                    {tipoLabel(t, tipo, base_city)}
                  </td>
                  {brackets.map((b) => {
                    const n = cellByRowBracket[`${base_city}|${tipo}|${b}`] || 0
                    return (
                      <td key={b} style={heatStyle(n, maxCell)}>
                        {n || '—'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

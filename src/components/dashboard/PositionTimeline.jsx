/**
 * PositionTimeline — Sprint 2.6
 *
 * Pregunta que responde: "¿Cómo evoluciona la posición de Yango en el
 * tiempo?" — para cada período, calculamos el rank de Yango (1° = más
 * barato) en el WA y graficamos la línea.
 *
 * Y-axis está INVERTIDO: posición 1 arriba (mejor), posición N abajo.
 * Esto se siente más intuitivo — subir = subir en el ranking.
 *
 * Coloreado: verde donde Yango = 1°, amarillo si 2°-3°, rojo si ≥4°.
 */
import { useMemo } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import { useI18n } from '../../context/LanguageContext'
import { rivalsOf } from '../../lib/normalize'

export default function PositionTimeline({ priceMatrix, periods, competitors, compareVs }) {
  const { t } = useI18n()
  const data = useMemo(() => {
    if (!priceMatrix || !periods?.length) return []
    const yangoComp = compareVs
    // Sin esto, la "posición de Yango" contaba a YangoComfort como un rival más:
    // un puesto de más en el total y, si la sub-marca era más barata, un puesto
    // peor para Yango contra sí misma. Ver `rivalsOf` en lib/normalize.
    const universo = new Set([yangoComp, ...rivalsOf(competitors, yangoComp)])

    return periods.map((p) => {
      // Para cada período, ordenamos competidores por WA
      const ranked = competitors
        .filter((c) => universo.has(c))
        .map((c) => ({ comp: c, wa: priceMatrix[c]?.[p.key]?.['_wa'] }))
        .filter((x) => x.wa != null && x.wa > 0)
        .sort((a, b) => a.wa - b.wa)

      const yangoIdx = ranked.findIndex((x) => x.comp === yangoComp)
      const rank = yangoIdx >= 0 ? yangoIdx + 1 : null
      return {
        period: p.label ?? p.key,
        rank,
        total: ranked.length,
        yangoWA: priceMatrix[yangoComp]?.[p.key]?.['_wa'] ?? null,
      }
    })
  }, [priceMatrix, periods, competitors, compareVs])

  const hasData = data.some((d) => d.rank != null)
  const maxRank = useMemo(() => Math.max(2, ...data.map((d) => d.total || 0)), [data])

  // Conclusión automática: dónde estamos hoy y si mejoramos o empeoramos.
  const conclusion = useMemo(() => {
    const valid = data.filter((d) => d.rank != null)
    if (valid.length < 1) return null
    const first = valid[0]
    const last = valid[valid.length - 1]
    const now = t('dashboard.position_timeline.conclusion_now', {
      rank: last.rank,
      total: last.total,
    })
    if (valid.length < 2 || first.rank === last.rank)
      return t('dashboard.position_timeline.conclusion_stable', { now })
    if (last.rank < first.rank)
      return t('dashboard.position_timeline.conclusion_improving', { now, first: first.rank })
    return t('dashboard.position_timeline.conclusion_worsening', { now, first: first.rank })
  }, [data, t])

  if (!hasData) {
    return (
      <div className="p-6 text-center text-sm text-muted">
        {t('dashboard.position_timeline.no_data')}
      </div>
    )
  }

  return (
    <div className="w-full">
      {conclusion && (
        <div className="mb-3 rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs leading-relaxed">
          <strong>{t('dashboard.position_timeline.quick_read_label')}</strong> {conclusion}
        </div>
      )}
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
          <XAxis dataKey="period" tick={{ fontSize: 10 }} />
          <YAxis
            tick={{ fontSize: 10 }}
            // Invertir el eje: posición 1 arriba, N abajo.
            reversed
            domain={[1, maxRank]}
            allowDecimals={false}
            ticks={Array.from({ length: maxRank }, (_, i) => i + 1)}
            tickFormatter={(v) => `#${v}`}
            label={{
              value: t('dashboard.position_timeline.axis_label'),
              angle: -90,
              position: 'insideLeft',
              style: { fontSize: 10, fill: 'var(--color-muted)' },
            }}
          />
          <Tooltip
            contentStyle={{ fontSize: 11 }}
            formatter={(value, _name, props) => {
              if (value == null)
                return [
                  t('dashboard.position_timeline.tooltip_no_data'),
                  t('dashboard.position_timeline.axis_label'),
                ]
              return [
                t('dashboard.position_timeline.tooltip_value', {
                  rank: value,
                  total: props.payload.total,
                }),
                t('dashboard.position_timeline.tooltip_position_label'),
              ]
            }}
            labelFormatter={(label) =>
              t('dashboard.position_timeline.tooltip_period_label', { label })
            }
          />
          {/* Línea de "podio" (top 3) */}
          <ReferenceLine y={3} stroke="var(--sem-yellow-fg)" strokeDasharray="2 4" />
          <Line
            type="monotone"
            dataKey="rank"
            stroke="var(--color-yango, #E53935)"
            strokeWidth={2.5}
            dot={{ r: 4, fill: 'var(--color-yango, #E53935)' }}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="text-xs text-muted mt-2">{t('dashboard.position_timeline.footer')}</p>
    </div>
  )
}

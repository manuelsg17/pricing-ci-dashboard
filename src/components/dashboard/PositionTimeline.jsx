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

export default function PositionTimeline({ priceMatrix, periods, competitors, compareVs }) {
  const data = useMemo(() => {
    if (!priceMatrix || !periods?.length) return []
    const yangoComp = compareVs

    return periods.map((p) => {
      // Para cada período, ordenamos competidores por WA
      const ranked = competitors
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
    const now = `Hoy Yango es el ${last.rank}° más barato de ${last.total}`
    if (valid.length < 2 || first.rank === last.rank)
      return `${now} — posición estable en el rango.`
    if (last.rank < first.rank) return `${now}, mejorando: arrancó el rango en ${first.rank}°.`
    return `${now}, empeorando: arrancó el rango en ${first.rank}°.`
  }, [data])

  if (!hasData) {
    return (
      <div className="p-6 text-center text-sm text-muted">
        Sin data suficiente para el timeline de posición.
      </div>
    )
  }

  return (
    <div className="w-full">
      {conclusion && (
        <div className="mb-3 rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs leading-relaxed">
          <strong>Lectura rápida:</strong> {conclusion}
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
            tickFormatter={(v) => `${v}°`}
            label={{
              value: 'Posición',
              angle: -90,
              position: 'insideLeft',
              style: { fontSize: 10, fill: 'var(--color-muted)' },
            }}
          />
          <Tooltip
            contentStyle={{ fontSize: 11 }}
            formatter={(value, _name, props) => {
              if (value == null) return ['Sin data', 'Posición']
              return [`${value}° de ${props.payload.total}`, 'Posición Yango']
            }}
            labelFormatter={(label) => `Período: ${label}`}
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
      <p className="text-xs text-muted mt-2">
        Ranking de precio de Yango semana a semana (1° = el más barato del mercado). La línea
        punteada amarilla marca el podio (top 3). Subir en el gráfico = mejorar.
      </p>
    </div>
  )
}

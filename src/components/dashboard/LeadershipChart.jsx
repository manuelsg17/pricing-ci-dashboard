/**
 * LeadershipChart — Sprint 2.6
 *
 * Pregunta que responde: "¿En qué brackets de distancia Yango es más
 * competitivo en precio?" — % de períodos donde Yango fue el más barato
 * en cada bracket. Bar chart horizontal.
 *
 * Cálculo: por cada bracket, contamos cuántos períodos Yango tuvo el
 * precio MÁS BAJO de todos los competidores. Dividimos entre el total
 * de períodos con data válida = liderazgo %.
 *
 * Mostrar:
 *  - Bar horizontal con el % de leadership.
 *  - Color: verde si ≥60%, amarillo si 30-60%, rojo si <30%.
 *  - Etiqueta con count (ej "3/6 períodos").
 */
import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts'
import { BRACKETS } from '../../lib/constants'

const BRACKET_LABELS = {
  _wa: 'WA',
  very_short: 'Very Short',
  short: 'Short',
  median: 'Median',
  average: 'Average',
  long: 'Long',
  very_long: 'Very Long',
}

function leadershipColor(pct) {
  if (pct >= 60) return 'var(--sem-green-fg)'
  if (pct >= 30) return 'var(--sem-yellow-fg)'
  return 'var(--sem-red-fg)'
}

export default function LeadershipChart({ priceMatrix, periods, competitors, compareVs }) {
  const data = useMemo(() => {
    if (!priceMatrix || !periods?.length) return []
    const yangoComp = compareVs
    const rivals = competitors.filter((c) => c !== yangoComp)

    return BRACKETS.map((b) => {
      let leadCount = 0
      let totalValid = 0
      for (const p of periods) {
        const yPrice = priceMatrix[yangoComp]?.[p.key]?.[b]
        if (yPrice == null || yPrice <= 0) continue
        const rivalPrices = rivals
          .map((c) => priceMatrix[c]?.[p.key]?.[b])
          .filter((v) => v != null && v > 0)
        if (rivalPrices.length === 0) continue
        totalValid++
        if (yPrice <= Math.min(...rivalPrices)) leadCount++
      }
      const pct = totalValid > 0 ? (leadCount / totalValid) * 100 : null
      return {
        bracket: BRACKET_LABELS[b],
        leadership: pct,
        leadCount,
        totalValid,
      }
    })
  }, [priceMatrix, periods, competitors, compareVs])

  const hasData = data.some((d) => d.totalValid > 0)

  // Conclusión automática en lenguaje simple: dónde dominamos y dónde no.
  const conclusion = useMemo(() => {
    const valid = data.filter((d) => d.leadership != null)
    if (!valid.length) return null
    const strong = valid.filter((d) => d.leadership >= 60).map((d) => d.bracket)
    const weak = valid.filter((d) => d.leadership < 30).map((d) => d.bracket)
    const parts = []
    if (strong.length) parts.push(`Yango casi siempre es el más barato en ${strong.join(', ')}`)
    if (weak.length) parts.push(`rara vez lidera en ${weak.join(', ')}`)
    if (!parts.length)
      return 'Yango compite parejo en todas las distancias: lidera entre el 30% y 60% de las semanas.'
    return parts.join('; pero ') + '.'
  }, [data])

  if (!hasData) {
    return (
      <div className="p-6 text-center text-sm text-muted">
        Sin data suficiente para calcular liderazgo. Cargá más períodos.
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
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
          <XAxis
            type="number"
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fontSize: 10 }}
          />
          <YAxis type="category" dataKey="bracket" tick={{ fontSize: 11 }} width={80} />
          <Tooltip
            contentStyle={{ fontSize: 11 }}
            formatter={(value, _name, props) => {
              if (value == null) return ['Sin data', 'Liderazgo']
              const { leadCount, totalValid } = props.payload
              return [`${value.toFixed(0)}% (${leadCount}/${totalValid} períodos)`, 'Yango líder']
            }}
            labelFormatter={(label) => `Bracket: ${label}`}
          />
          <ReferenceLine x={50} stroke="var(--color-muted)" strokeDasharray="3 3" />
          <Bar dataKey="leadership" radius={[0, 4, 4, 0]} barSize={18}>
            {data.map((entry, idx) => (
              <Cell
                key={idx}
                fill={entry.leadership == null ? '#cbd5e1' : leadershipColor(entry.leadership)}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="text-xs text-muted mt-2">
        Cada barra = % de las semanas del rango en que Yango fue el competidor más barato en esa
        distancia. Verde = casi siempre líder (≥60%), amarillo = a veces (30-60%), rojo = casi nunca
        (&lt;30%). La línea punteada marca el 50%.
      </p>
    </div>
  )
}

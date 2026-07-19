/**
 * HeadToHeadView — Sprint 2.5 — Comparación 1:1 Yango vs un competidor.
 *
 * QUÉ RESUELVE (audit 09):
 *   El selector "Compare vs" del dashboard confunde porque cambia la BASE
 *   (frente a quién Yango se mide), no el TARGET. Si analista quiere ver
 *   "Yango vs Cabify" tiene que ignorar mentalmente los otros competidores.
 *
 *   Acá: vista DEDICADA 1:1. Elegís 1 competidor, ves bracket-por-bracket
 *   precio Yango / precio Competidor / Δ% / Diff$, con best/worst bracket
 *   auto-resaltado y KPI "Yango líder en X / Y brackets vs este competidor".
 *
 * UX:
 *   Se abre como Sheet lateral derecho desde un botón en el Dashboard. No
 *   navega — el contexto del dashboard (city, category, period) se preserva.
 *
 * DATA:
 *   Usa el priceMatrix del Dashboard (último período) — no hace fetch propio.
 *   El Dashboard pasa todo lo necesario por props.
 */
import { useEffect, useMemo, useState } from 'react'
import { Combobox } from '../ui/shadcn/combobox'
import { Badge } from '../ui/shadcn/badge'
import { Card, CardContent } from '../ui/shadcn/card'
import { prettyCompetitor } from '../../lib/normalize'
import { BRACKETS } from '../../lib/constants'
import { formatPrice } from '../../lib/format.js'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { useI18n } from '../../context/LanguageContext'

const BRACKET_LABELS = {
  _wa: 'WA',
  very_short: 'Very Short',
  short: 'Short',
  median: 'Median',
  average: 'Average',
  long: 'Long',
  very_long: 'Very Long',
}

export default function HeadToHeadView({
  priceMatrix,
  periods,
  competitors,
  compareVs,
  currency = '',
}) {
  const { t } = useI18n()
  const yangoComp = compareVs
  const latestKey = periods?.[periods.length - 1]?.key
  const latestLabel = periods?.[periods.length - 1]?.label

  // Lista de competidores rivales (excluye Yango)
  const rivalOptions = useMemo(
    () =>
      competitors
        .filter((c) => c !== yangoComp)
        .map((c) => ({ value: c, label: prettyCompetitor(c) })),
    [competitors, yangoComp]
  )

  // Default: el primer rival disponible. Las opciones llegan async (cuando
  // carga el priceMatrix), así que si la selección actual ya no existe en la
  // lista (o quedó vacía del primer render) la corregimos al primer rival.
  const [selectedRival, setSelectedRival] = useState(rivalOptions[0]?.value || '')
  useEffect(() => {
    if (rivalOptions.length && !rivalOptions.some((o) => o.value === selectedRival)) {
      setSelectedRival(rivalOptions[0].value)
    }
  }, [rivalOptions, selectedRival])

  // Computación de la matriz comparativa por bracket
  const rows = useMemo(() => {
    if (!latestKey || !selectedRival) return []
    const yangoRow = priceMatrix?.[yangoComp]?.[latestKey] || {}
    const rivalRow = priceMatrix?.[selectedRival]?.[latestKey] || {}
    const allBrackets = ['_wa', ...BRACKETS]
    return allBrackets.map((b) => {
      const y = yangoRow[b]
      const r = rivalRow[b]
      const valid = y != null && r != null && y > 0 && r > 0
      const deltaPct = valid ? ((y - r) / r) * 100 : null
      const diff = valid ? y - r : null
      return {
        bracket: b,
        label: BRACKET_LABELS[b],
        yango: y,
        rival: r,
        deltaPct,
        diff,
        yangoLeads: valid && y <= r,
      }
    })
  }, [priceMatrix, yangoComp, selectedRival, latestKey])

  // KPIs: cuántos brackets lidera Yango + best/worst para Yango
  const summary = useMemo(() => {
    const valid = rows.filter((r) => r.deltaPct != null && r.bracket !== '_wa')
    const leadCount = valid.filter((r) => r.yangoLeads).length
    const total = valid.length
    if (total === 0)
      return { leadCount: 0, total: 0, bestKey: null, worstKey: null, avgDelta: null }

    // Best Yango: bracket donde Yango está MÁS barato (deltaPct más negativo)
    // Worst Yango: bracket donde Yango está MÁS caro (deltaPct más positivo)
    const sortedAsc = [...valid].sort((a, b) => a.deltaPct - b.deltaPct)
    const bestKey = sortedAsc[0]?.bracket
    const worstKey = sortedAsc[sortedAsc.length - 1]?.bracket
    const avgDelta = valid.reduce((s, r) => s + r.deltaPct, 0) / total

    return { leadCount, total, bestKey, worstKey, avgDelta }
  }, [rows])

  if (rivalOptions.length === 0) {
    return <div className="p-6 text-sm text-muted">{t('dashboard.head_to_head.no_rivals')}</div>
  }

  return (
    <div className="flex flex-col gap-4 p-2">
      {/* Para qué sirve esta vista — en una frase */}
      <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs leading-relaxed text-muted">
        <strong className="text-foreground">{t('dashboard.what_for_label')}</strong>{' '}
        {t('dashboard.head_to_head.what_for_body')}{' '}
        <em>“{t('dashboard.head_to_head.what_for_example')}”</em>
      </div>

      {/* Selector competidor + período actual */}
      <div className="flex flex-col gap-2">
        <label className="text-xs font-semibold uppercase text-muted">
          {t('dashboard.head_to_head.yango_vs_label')}
        </label>
        <Combobox
          items={rivalOptions}
          value={selectedRival}
          onValueChange={setSelectedRival}
          placeholder={t('dashboard.head_to_head.placeholder_competitor')}
          searchPlaceholder={t('dashboard.head_to_head.search_competitor')}
        />
        <p className="text-xs text-muted">
          {t('dashboard.head_to_head.comparing_period_prefix')}{' '}
          <span className="font-semibold text-foreground">{latestLabel}</span>{' '}
          {t('dashboard.head_to_head.comparing_period_suffix', { currency })}
        </p>
      </div>

      {/* KPI bar compacto */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-3 p-4">
          <div>
            <div className="text-xs uppercase text-muted">
              {t('dashboard.head_to_head.kpi_leader_label')}
            </div>
            <div className="text-2xl font-bold text-foreground">
              {summary.leadCount}
              <span className="ml-1 text-base font-normal text-muted">/ {summary.total}</span>
            </div>
            <div className="text-xs text-muted">
              {t('dashboard.head_to_head.kpi_leader_hint', {
                competitor: prettyCompetitor(selectedRival),
              })}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted">
              {t('dashboard.head_to_head.kpi_avg_delta_label')}
            </div>
            <div
              className="text-2xl font-bold"
              style={{
                color:
                  summary.avgDelta == null
                    ? undefined
                    : Math.abs(summary.avgDelta) < 0.5
                      ? 'var(--color-muted)'
                      : summary.avgDelta > 0
                        ? 'var(--sem-red-fg)'
                        : 'var(--sem-green-fg)',
              }}
            >
              {summary.avgDelta == null
                ? '—'
                : `${summary.avgDelta > 0 ? '+' : ''}${summary.avgDelta.toFixed(1)}%`}
            </div>
            <div className="text-xs text-muted">
              {summary.avgDelta == null
                ? ''
                : summary.avgDelta > 0
                  ? t('dashboard.head_to_head.kpi_avg_more_expensive')
                  : t('dashboard.head_to_head.kpi_avg_cheaper')}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabla bracket × precio */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase text-muted">
              <th className="py-2 pr-2">{t('dashboard.head_to_head.col_bracket')}</th>
              <th className="py-2 pr-2 text-right">Yango</th>
              <th className="py-2 pr-2 text-right">{prettyCompetitor(selectedRival)}</th>
              <th className="py-2 pr-2 text-right">Δ %</th>
              <th className="py-2 pl-2 text-right">
                {t('dashboard.head_to_head.col_diff', { currency })}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isBest = r.bracket === summary.bestKey
              const isWorst = r.bracket === summary.worstKey
              const isWA = r.bracket === '_wa'
              return (
                <tr
                  key={r.bracket}
                  className={
                    'border-b border-border/50 ' + (isWA ? 'bg-secondary/30 font-semibold ' : '')
                  }
                >
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-2">
                      <span>{r.label}</span>
                      {isBest && !isWA && (
                        <Badge variant="success" className="gap-1 text-[10px]">
                          <TrendingDown className="h-3 w-3" />{' '}
                          {t('dashboard.head_to_head.badge_best')}
                        </Badge>
                      )}
                      {isWorst && !isWA && (
                        <Badge variant="danger" className="gap-1 text-[10px]">
                          <TrendingUp className="h-3 w-3" />{' '}
                          {t('dashboard.head_to_head.badge_worst')}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {r.yango != null ? formatPrice(r.yango) : '—'}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {r.rival != null ? formatPrice(r.rival) : '—'}
                  </td>
                  <td
                    className="py-2 pr-2 text-right tabular-nums"
                    style={{
                      color:
                        r.deltaPct == null
                          ? undefined
                          : Math.abs(r.deltaPct) < 0.5
                            ? 'var(--color-muted)'
                            : r.deltaPct > 0
                              ? 'var(--sem-red-fg)'
                              : 'var(--sem-green-fg)',
                      fontWeight: 600,
                    }}
                  >
                    {r.deltaPct == null
                      ? '—'
                      : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`}
                  </td>
                  <td
                    className="py-2 pl-2 text-right tabular-nums"
                    style={{
                      color:
                        r.diff == null
                          ? undefined
                          : Math.abs(r.diff) < 0.01
                            ? 'var(--color-muted)'
                            : r.diff > 0
                              ? 'var(--sem-red-fg)'
                              : 'var(--sem-green-fg)',
                    }}
                  >
                    {r.diff == null ? '—' : `${r.diff > 0 ? '+' : ''}${formatPrice(r.diff)}`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-muted">
        <Minus className="inline h-3 w-3" /> <strong>Δ %</strong>{' '}
        {t('dashboard.head_to_head.delta_formula', {
          competitor: prettyCompetitor(selectedRival),
        })}
        <strong> {t('dashboard.head_to_head.badge_best')}</strong>{' '}
        {t('dashboard.head_to_head.best_def')}
        <strong> {t('dashboard.head_to_head.badge_worst')}</strong>{' '}
        {t('dashboard.head_to_head.worst_def')}
      </div>
    </div>
  )
}

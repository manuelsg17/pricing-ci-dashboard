/**
 * AdvancedAnalyticsView — Sprint 2.6 — Tabs con charts analíticos extra.
 *
 * Vive dentro del Sheet "📈 Analytics" que abre desde el KPI bar del
 * Dashboard. Charts disponibles:
 *  - Leadership %: % de períodos donde Yango fue líder por bracket.
 *  - Position Timeline: evolución del rank de Yango en el tiempo.
 *
 * Multi-city Compare queda diferido a Sprint 3 (requiere fetch multi-city
 * que no está en el priceMatrix actual del dashboard).
 */
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/shadcn/tabs'
import LeadershipChart from './LeadershipChart'
import PositionTimeline from './PositionTimeline'

export default function AdvancedAnalyticsView({ priceMatrix, periods, competitors, compareVs }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs leading-relaxed text-muted">
        <strong className="text-foreground">¿Para qué sirve?</strong> Mientras el dashboard muestra
        los precios de <em>esta</em> semana, acá ves la <strong>tendencia</strong>:{' '}
        <strong>% Liderazgo</strong> responde{' '}
        <em>“¿en qué distancias solemos ser los más baratos?”</em> y{' '}
        <strong>Posición en el tiempo</strong> responde{' '}
        <em>“¿estamos mejorando o empeorando contra la competencia?”</em>
      </div>
      <Tabs defaultValue="leadership" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="leadership">% Liderazgo</TabsTrigger>
          <TabsTrigger value="position">Posición en el tiempo</TabsTrigger>
        </TabsList>

        <TabsContent value="leadership" className="mt-4">
          <LeadershipChart
            priceMatrix={priceMatrix}
            periods={periods}
            competitors={competitors}
            compareVs={compareVs}
          />
        </TabsContent>

        <TabsContent value="position" className="mt-4">
          <PositionTimeline
            priceMatrix={priceMatrix}
            periods={periods}
            competitors={competitors}
            compareVs={compareVs}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

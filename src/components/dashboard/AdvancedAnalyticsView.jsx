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

export default function AdvancedAnalyticsView({
  priceMatrix,
  periods,
  competitors,
  compareVs,
}) {
  return (
    <Tabs defaultValue="leadership" className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="leadership">% Liderazgo</TabsTrigger>
        <TabsTrigger value="position">Timeline posición</TabsTrigger>
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
  )
}

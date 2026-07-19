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
import { useI18n } from '../../context/LanguageContext'

export default function AdvancedAnalyticsView({ priceMatrix, periods, competitors, compareVs }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs leading-relaxed text-muted">
        <strong className="text-foreground">{t('dashboard.what_for_label')}</strong>{' '}
        {t('dashboard.advanced_analytics.what_for_body')}
      </div>
      <Tabs defaultValue="leadership" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="leadership">
            {t('dashboard.advanced_analytics.tab_leadership')}
          </TabsTrigger>
          <TabsTrigger value="position">
            {t('dashboard.advanced_analytics.tab_position')}
          </TabsTrigger>
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

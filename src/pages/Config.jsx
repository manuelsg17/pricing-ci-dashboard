/**
 * Config — Sprint 2.3 — Reorganización en 5 categorías con shadcn Tabs.
 *
 * ANTES: 13 tabs planos horizontales → scroll horizontal en pantallas
 * <1600px y desorientación ("¿qué tab toca?"). Auditor 06 marcó esto como
 * #1 friction de UX.
 *
 * AHORA: 5 categorías top-level + sub-tabs internos.
 *   1. Pricing Rules → Thresholds, Weights, Semaforo, PriceRules
 *   2. Timing       → RushHour, CITimeslots
 *   3. Competidores → Commissions, Bonuses, InDrive
 *   4. Bot & Data   → BotRules, Airports, Snapshots
 *   5. Admin        → Countries, Audit (solo admins)
 *
 * MANTIENE compatibilidad total con los componentes legacy (ThresholdsTable,
 * BotRulesTable, etc.) — sólo cambia el shell de navegación.
 */
import { useMemo, useState } from 'react'
import { useConfig } from '../hooks/useConfig'
import ThresholdsTable from '../components/config/ThresholdsTable'
import WeightsTable from '../components/config/WeightsTable'
import SemaforoEditor from '../components/config/SemaforoEditor'
import PriceRulesTable from '../components/config/PriceRulesTable'
import RushHourConfig from '../components/config/RushHourConfig'
import CITimeslotsConfig from '../components/config/CITimeslotsConfig'
import CommissionsConfig from '../components/config/CommissionsConfig'
import BonusesConfig from '../components/config/BonusesConfig'
import InDriveConfig from '../components/config/InDriveConfig'
import CountriesConfig from '../components/config/CountriesConfig'
import BotRulesTable from '../components/config/BotRulesTable'
import AirportMarkersTable from '../components/config/AirportMarkersTable'
import SnapshotsManager from '../components/config/SnapshotsManager'
import AuditLogViewer from '../components/config/AuditLogViewer'
import { useI18n } from '../context/LanguageContext'
import { useCountry } from '../context/CountryContext'
import { useAccessControl } from '../hooks/useAccessControl'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/shadcn/tabs'
import { SlidersHorizontal, Clock, Users, Bot, Shield } from 'lucide-react'
import '../styles/config.css'

export default function Config() {
  const { country } = useCountry()
  const { t } = useI18n()
  const { isAdmin } = useAccessControl()

  const {
    thresholds,
    weights,
    semaforo,
    loading,
    saving,
    error,
    saveThresholds,
    saveWeights,
    saveSemaforo,
  } = useConfig(country)

  // 5 categorías con sus sub-tabs. Cada item['component'] es una factory
  // (no JSX directo) para evitar mount eager de componentes inactivos.
  const CATEGORIES = useMemo(() => {
    const cats = [
      {
        id: 'pricing',
        label: t('config.category.pricing'),
        desc: t('config.category.pricing.desc'),
        Icon: SlidersHorizontal,
        items: [
          {
            id: 'thresholds',
            label: t('config.distances'),
            render: () => (
              <ThresholdsTable
                thresholds={thresholds}
                onSave={saveThresholds}
                saving={saving}
                country={country}
              />
            ),
          },
          {
            id: 'weights',
            label: t('config.weights'),
            render: () => (
              <WeightsTable
                weights={weights}
                onSave={saveWeights}
                saving={saving}
                country={country}
              />
            ),
          },
          {
            id: 'semaforo',
            label: t('config.semaforo'),
            render: () => (
              <SemaforoEditor
                semaforo={semaforo}
                onSave={saveSemaforo}
                saving={saving}
                country={country}
              />
            ),
          },
          {
            id: 'pricerules',
            label: t('config.price_limits'),
            render: () => <PriceRulesTable country={country} />,
          },
        ],
      },
      {
        id: 'timing',
        label: t('config.category.timing'),
        desc: t('config.category.timing.desc'),
        Icon: Clock,
        items: [
          {
            id: 'rushhour',
            label: t('config.rush_hour'),
            render: () => <RushHourConfig country={country} />,
          },
          {
            id: 'timeslots',
            label: t('config.timeslots'),
            render: () => <CITimeslotsConfig country={country} />,
          },
        ],
      },
      {
        id: 'competitors',
        label: t('config.category.competitors'),
        desc: t('config.category.competitors.desc'),
        Icon: Users,
        items: [
          {
            id: 'commissions',
            label: t('config.commissions'),
            render: () => <CommissionsConfig country={country} />,
          },
          {
            id: 'bonuses',
            label: t('config.bonuses'),
            render: () => <BonusesConfig country={country} />,
          },
          {
            id: 'indrive',
            label: t('config.indrive'),
            render: () => <InDriveConfig country={country} />,
          },
        ],
      },
      {
        id: 'data',
        label: t('config.category.data'),
        desc: t('config.category.data.desc'),
        Icon: Bot,
        items: [
          {
            id: 'botrules',
            label: t('config.botrules'),
            render: () => <BotRulesTable country={country} />,
          },
          {
            id: 'airports',
            label: t('config.airports'),
            render: () => <AirportMarkersTable country={country} />,
          },
          {
            id: 'snapshots',
            label: t('config.snapshots'),
            render: () => <SnapshotsManager country={country} />,
          },
        ],
      },
      {
        id: 'admin',
        label: t('config.category.admin'),
        desc: t('config.category.admin.desc'),
        Icon: Shield,
        items: [
          { id: 'countries', label: t('config.countries'), render: () => <CountriesConfig /> },
          // Audit log solo para admins. La RPC también filtra por is_admin()
          // en DB, pero ocultarlo de la UI mejora la experiencia.
          ...(isAdmin
            ? [{ id: 'audit', label: '📋 ' + t('audit.title'), render: () => <AuditLogViewer /> }]
            : []),
        ],
      },
    ]
    return cats
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, isAdmin, thresholds, weights, semaforo, saving, country])

  // State: categoría activa + sub-tab activo por categoría
  const [activeCategory, setActiveCategory] = useState('pricing')
  // Map { categoryId → activeItemId } — recuerda el último sub-tab visitado
  // por cada categoría (UX: si saliste del editor de Weights, volver a la
  // categoría Pricing te lo abre directo, no te lleva al primero).
  const [activeItemByCategory, setActiveItemByCategory] = useState(() => {
    const init = {}
    for (const c of CATEGORIES) init[c.id] = c.items[0]?.id
    return init
  })

  const currentCategory = CATEGORIES.find((c) => c.id === activeCategory) ?? CATEGORIES[0]
  const currentItemId = activeItemByCategory[currentCategory.id] ?? currentCategory.items[0]?.id

  if (loading) {
    return (
      <div className="config-page">
        <div className="state-box">{t('config.loading')}</div>
      </div>
    )
  }
  if (error) {
    return (
      <div className="config-page">
        <div className="state-box state-box--error">
          {t('app.error')}: {error}
        </div>
      </div>
    )
  }

  return (
    <div className="config-page">
      <h1>{t('config.title')}</h1>

      {/* Nivel 1: Categoría principal (5 grupos). Cada Trigger tiene icono + label. */}
      <Tabs value={activeCategory} onValueChange={setActiveCategory} className="w-full">
        <TabsList className="h-auto p-1 bg-secondary flex-wrap gap-1">
          {CATEGORIES.map(({ id, label, Icon }) => (
            <TabsTrigger
              key={id}
              value={id}
              className="flex items-center gap-2 px-4 py-2 data-[state=active]:bg-panel data-[state=active]:text-yango"
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        {CATEGORIES.map(({ id, desc, items }) => (
          <TabsContent key={id} value={id} className="mt-4">
            <p className="text-sm text-muted mb-3">{desc}</p>

            {/* Nivel 2: Sub-tabs dentro de la categoría. */}
            <Tabs
              value={activeItemByCategory[id] ?? items[0]?.id}
              onValueChange={(itemId) =>
                setActiveItemByCategory((prev) => ({ ...prev, [id]: itemId }))
              }
              className="w-full"
            >
              <TabsList className="bg-secondary/50">
                {items.map((item) => (
                  <TabsTrigger key={item.id} value={item.id} className="text-xs">
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              {items.map((item) => (
                <TabsContent key={item.id} value={item.id} className="mt-3">
                  {/* Render lazy: solo el sub-tab activo. Esto preserva el
                      comportamiento anterior (no carga TODOS los componentes
                      en mount). El conditional con currentCategory evita render
                      cuando este sub-tab no pertenece a la categoría activa. */}
                  {activeCategory === id && currentItemId === item.id && item.render()}
                </TabsContent>
              ))}
            </Tabs>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

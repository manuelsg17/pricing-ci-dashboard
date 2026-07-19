import { useMemo } from 'react'
import { Combobox } from '../ui/shadcn/combobox'
import { COMPETITOR_COLORS } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'

// Selector de banda configurada (competitor_name + category) — viene de
// useConfigContext().competitiveBands, ya filtrado por país en el caller.
export default function BandSelector({ bands, selectedId, onSelect }) {
  const { t } = useI18n()
  const items = useMemo(
    () =>
      bands.map((b) => ({
        value: String(b.id),
        label: `${b.competitor_name} — ${b.category}`,
        color: COMPETITOR_COLORS[b.competitor_name],
      })),
    [bands]
  )

  if (bands.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
        {t('competitiveBands.band_selector.no_bands')}
      </div>
    )
  }

  return (
    <Combobox
      items={items}
      value={selectedId != null ? String(selectedId) : undefined}
      onValueChange={(v) => {
        const band = bands.find((b) => String(b.id) === v)
        if (band) onSelect(band)
      }}
      placeholder={t('competitiveBands.band_selector.placeholder')}
      searchPlaceholder={t('competitiveBands.band_selector.search_placeholder')}
      emptyText={t('common.no_results')}
      triggerClassName="w-auto min-w-[260px]"
    />
  )
}

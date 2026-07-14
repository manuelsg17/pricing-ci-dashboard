import { useMemo } from 'react'
import { Combobox } from '../ui/shadcn/combobox'
import { COMPETITOR_COLORS } from '../../lib/constants'

// Selector de banda configurada (competitor_name + category) — viene de
// useConfigContext().competitiveBands, ya filtrado por país en el caller.
export default function BandSelector({ bands, selectedId, onSelect }) {
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
        No hay bandas configuradas todavía. Creá una en Config → Competidores → Bandas competitivas.
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
      placeholder="Elegí una banda…"
      searchPlaceholder="Buscar competidor o categoría…"
      emptyText="Sin resultados."
      triggerClassName="w-auto min-w-[260px]"
    />
  )
}

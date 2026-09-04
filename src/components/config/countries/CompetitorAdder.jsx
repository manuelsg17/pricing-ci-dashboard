import { useState } from 'react'
import { COMPETITOR_COLORS, LEGACY_SPACE_FORM_COMPETITORS } from '../../../lib/constants'
import { Button } from '../../ui/shadcn/button'
import { useI18n } from '../../../context/LanguageContext'
import { CORP_ONLY_COMPETITORS } from './countriesStyles'

const ALL_COMPETITORS = Object.keys(COMPETITOR_COLORS)

// Dropdown "+ Agregar…" de competidores para una categoría. Filtra las
// formas legacy con espacio y, salvo en Perú/Corp, los tiers exclusivos
// del negocio Corp (ver CORP_ONLY_COMPETITORS).
export default function CompetitorAdder({ existing, onAdd, allowCorpTiers }) {
  const { t } = useI18n()
  const [val, setVal] = useState('')
  const available = ALL_COMPETITORS.filter(
    (c) =>
      !existing.includes(c) &&
      !LEGACY_SPACE_FORM_COMPETITORS.has(c) &&
      (allowCorpTiers || !CORP_ONLY_COMPETITORS.has(c))
  )
  return (
    <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <select
        value={val}
        onChange={(e) => setVal(e.target.value)}
        style={{
          fontSize: 11,
          padding: '2px 4px',
          border: '1px dashed var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--color-panel)',
        }}
      >
        <option value="">{t('config.countries_config.add_adder_placeholder')}</option>
        {available.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {val && (
        <Button
          size="sm"
          className="h-[22px] px-2 text-[10px]"
          onClick={() => {
            onAdd(val)
            setVal('')
          }}
        >
          OK
        </Button>
      )}
    </div>
  )
}

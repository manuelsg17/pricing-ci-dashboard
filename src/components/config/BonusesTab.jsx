import { useState } from 'react'
import { useI18n } from '../../context/LanguageContext'
import BonusesConfig from './BonusesConfig'
import YangoGmvConfig from './YangoGmvConfig'
import { Button } from '../ui/shadcn/button'

// Consolida en el tab "Bonos" todo lo de bonos, en sub-pestañas: los bonos de
// competidores + el bono Yango por % de GMV. Antes "Bono Yango GMV" era un tab
// suelto en Config; ahora todo se configura acá. Cada editor es autocontenido
// (carga/guarda a su propia tabla: competitor_bonuses vs yango_gmv_tiers), así
// que solo alternamos cuál se renderiza.
const SUBTABS = [
  { id: 'competidores', labelKey: 'config.bonuses_tab.subtab_competitors' },
  { id: 'yango_gmv', labelKey: 'config.bonuses_tab.subtab_yango_gmv' },
]

export default function BonusesTab({ country }) {
  const [sub, setSub] = useState('competidores')
  const { t } = useI18n()
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {SUBTABS.map((s) => {
          const active = sub === s.id
          return (
            <Button
              key={s.id}
              variant={active ? 'default' : 'outline'}
              size="sm"
              className="rounded-full"
              onClick={() => setSub(s.id)}
            >
              {t(s.labelKey)}
            </Button>
          )
        })}
      </div>
      {sub === 'competidores' ? (
        <BonusesConfig country={country} />
      ) : (
        <YangoGmvConfig country={country} />
      )}
    </div>
  )
}

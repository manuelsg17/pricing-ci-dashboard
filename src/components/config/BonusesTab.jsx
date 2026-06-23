import { useState } from 'react'
import BonusesConfig from './BonusesConfig'
import YangoGmvConfig from './YangoGmvConfig'

// Consolida en el tab "Bonos" todo lo de bonos, en sub-pestañas: los bonos de
// competidores + el bono Yango por % de GMV. Antes "Bono Yango GMV" era un tab
// suelto en Config; ahora todo se configura acá. Cada editor es autocontenido
// (carga/guarda a su propia tabla: competitor_bonuses vs yango_gmv_tiers), así
// que solo alternamos cuál se renderiza.
const SUBTABS = [
  { id: 'competidores', label: 'Bonos de competidores' },
  { id: 'yango_gmv', label: 'Bono Yango (% GMV)' },
]

export default function BonusesTab({ country }) {
  const [sub, setSub] = useState('competidores')
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {SUBTABS.map((s) => {
          const active = sub === s.id
          return (
            <button
              key={s.id}
              onClick={() => setSub(s.id)}
              style={{
                padding: '6px 14px',
                borderRadius: 999,
                fontSize: 13,
                cursor: 'pointer',
                fontWeight: active ? 600 : 400,
                border:
                  '1px solid ' +
                  (active ? 'var(--color-yango, #E53935)' : 'var(--color-border, #e2e8f0)'),
                background: active ? 'var(--color-yango, #E53935)' : '#fff',
                color: active ? '#fff' : 'var(--color-muted)',
              }}
            >
              {s.label}
            </button>
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

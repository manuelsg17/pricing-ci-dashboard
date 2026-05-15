import { memo } from 'react'
import { useCountUp } from '../../hooks/useCountUp'

// Animated WoW badge. Aislado del padre para que la animación a 60fps
// no re-renderee el dashboard completo. Mismo motivo que AnimatedKpiValue.

function AnimatedWowBadgeImpl({ target, duration = 500 }) {
  const value = useCountUp(target, duration)
  if (value == null) return null
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
      background: value > 0 ? '#fee2e2' : value < 0 ? '#dcfce7' : '#f1f5f9',
      color:      value > 0 ? '#b91c1c' : value < 0 ? '#15803d' : '#64748b',
    }}>
      {value > 0 ? '↑' : value < 0 ? '↓' : '→'}{' '}
      {value > 0 ? '+' : ''}{value.toFixed(2)}
    </span>
  )
}

export default memo(AnimatedWowBadgeImpl)

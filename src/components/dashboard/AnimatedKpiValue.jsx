import { memo } from 'react'
import { useCountUp } from '../../hooks/useCountUp'

// ════════════════════════════════════════════════════════════════════════
// AnimatedKpiValue
//
// POR QUÉ EXISTE:
//   useCountUp dispara setState a ~60fps durante 500ms. Si el hook vive en
//   DashboardContent (que es el componente padre del dashboard entero),
//   esos 30 setState re-renderean TODO el dashboard — incluidos los charts
//   pesados, las 6+ BracketSection, etc. Aislándolo en su propio componente
//   pequeño, solo este nodo se re-renderea durante la animación.
//
// Side effect: el padre (Dashboard) no necesita llamar useCountUp y ya no
// se re-renderea por el tick.
// ════════════════════════════════════════════════════════════════════════

function AnimatedKpiValueImpl({
  target,           // valor objetivo (number o null)
  prefix = '',
  suffix = '',
  fractionDigits = 2,
  fallback = '—',
  duration = 500,
}) {
  const value = useCountUp(target, duration)
  if (value == null) return fallback
  return `${prefix}${value.toFixed(fractionDigits)}${suffix}`
}

export default memo(AnimatedKpiValueImpl)

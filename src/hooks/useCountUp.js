import { useState, useEffect, useRef } from 'react'

export function useCountUp(target, duration = 500) {
  const [value, setValue] = useState(target)
  const prevRef = useRef(target)
  const rafRef  = useRef(null)

  useEffect(() => {
    if (target == null) { setValue(null); prevRef.current = null; return }
    const from = prevRef.current ?? target
    if (from === target) return
    cancelAnimationFrame(rafRef.current)
    const start = performance.now()
    const delta = target - from
    function tick(now) {
      const t = Math.min((now - start) / duration, 1)
      const ease = 1 - Math.pow(1 - t, 3) // ease-out cubic
      setValue(from + delta * ease)
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
      else { setValue(target); prevRef.current = target }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, duration])

  return value
}

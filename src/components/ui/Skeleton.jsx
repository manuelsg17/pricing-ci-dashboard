export function Skeleton({ width = '100%', height = 14, rounded = 6, style }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width, height,
        borderRadius: rounded,
        background: 'linear-gradient(90deg, #e5e7eb 0%, #f3f4f6 50%, #e5e7eb 100%)',
        backgroundSize: '200% 100%',
        animation: 'skeletonShimmer 1.4s ease-in-out infinite',
        ...style,
      }}
    />
  )
}

export function SkeletonRow({ cols = 6, cellHeight = 14, gap = 12 }) {
  return (
    <div style={{ display: 'flex', gap, alignItems: 'center', padding: '8px 0' }}>
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} height={cellHeight} width={`${100 / cols}%`} />
      ))}
    </div>
  )
}

export function SkeletonTable({ rows = 6, cols = 6 }) {
  return (
    <div style={{ width: '100%' }}>
      <SkeletonRow cols={cols} cellHeight={11} />
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} cols={cols} />
      ))}
    </div>
  )
}

export function SkeletonDashboard() {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} width={160} height={64} rounded={10} />
        ))}
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} style={{ marginBottom: 16, padding: 12, background: '#fff', borderRadius: 10 }}>
          <Skeleton width={180} height={18} style={{ marginBottom: 12 }} />
          <SkeletonTable rows={3} cols={6} />
        </div>
      ))}
    </div>
  )
}

import { useI18n } from '../../context/LanguageContext'

// Alertas de precio (pedido 11) — se apoya en las bandas de competitividad
// YA configuradas (Config → Competitividad); solo aparece si algún par
// configurado (ej. Económico vs InDrive, Comfort+/Premier vs Uber) está por
// debajo del 30% dentro de banda esta semana. Si no hay bandas configuradas
// o todas están bien, no se muestra nada — no es un panel de estado, es una
// alerta.
export default function PriceComplianceAlerts({ alerts, loading }) {
  const { t } = useI18n()
  if (loading || !alerts.length) return null

  return (
    <div className="mon-panel" style={{ borderColor: 'var(--sem-red-fg)' }}>
      <div className="mon-panel__head">
        <h2>{t('monitoring.price_alerts_title')}</h2>
      </div>
      <div className="mon-panel__subtitle">{t('monitoring.price_alerts_subtitle')}</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
        {alerts.map((a) => (
          <li key={`${a.competitor}|${a.category}`} style={{ marginBottom: 4 }}>
            {t('monitoring.price_alert_line', {
              category: a.category,
              competitor: a.competitor,
              pct: a.withinPct,
            })}
          </li>
        ))}
      </ul>
    </div>
  )
}

import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

/**
 * Aviso inline de "hay cambios sin guardar" con botón de descartar. Antes
 * vivía copiado (mismo objeto de estilos) en ThresholdsTable, WeightsTable y
 * SemaforoEditor. El estilo está en src/styles/config.css
 * (.config-unsaved-banner).
 *
 * Uso:
 *   {hasUnsavedChanges && (
 *     <UnsavedChangesBanner onDiscard={handleDiscard}>
 *       {t('config.thresholds.unsaved_prefix')} <strong>{scope}</strong>
 *     </UnsavedChangesBanner>
 *   )}
 */
export default function UnsavedChangesBanner({ children, onDiscard, discardLabel }) {
  const { t } = useI18n()
  return (
    <div className="config-unsaved-banner" role="status">
      <span>⚠ {children}</span>
      {onDiscard && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="bg-transparent border-[#b45309] text-[#78350f]"
          onClick={onDiscard}
        >
          {discardLabel || t('config.discard_changes')}
        </Button>
      )}
    </div>
  )
}

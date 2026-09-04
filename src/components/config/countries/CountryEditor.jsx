import { CURRENCY_PRESETS } from '../../../lib/constants'
import { Button } from '../../ui/shadcn/button'
import { fieldLabelStyle, inputStyle, panelHeadingStyle, infoIconStyle } from './countriesStyles'

// Mitad superior del panel 2: datos del país (label, moneda, escala, zona
// horaria, status) + botones Guardar / Cancelar / Eliminar.
export default function CountryEditor({
  t,
  selectedKey,
  activeRow,
  readonly,
  savingKey,
  msg,
  activeRuleCount,
  isDirty,
  isDbManaged,
  setDraftField,
  setCurrency,
  onSave,
  onCancel,
  onDelete,
  onMakeEditable,
}) {
  const saving = savingKey === selectedKey
  return (
    <div
      style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--color-border)',
        overflowY: 'auto',
      }}
    >
      <div style={{ ...panelHeadingStyle, marginBottom: 6 }}>
        {readonly
          ? t('config.countries_config.readonly_preview_heading')
          : t('config.countries_config.editable_heading')}
      </div>

      {readonly && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 10px',
            borderRadius: 6,
            background: '#dbeafe',
            border: '1px solid #93c5fd',
            fontSize: 11,
            color: '#1e3a8a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span>{t('config.countries_config.readonly_banner_text')}</span>
          <Button
            size="sm"
            onClick={onMakeEditable}
            disabled={saving}
            className="h-auto whitespace-nowrap rounded-[4px] bg-blue-600 px-2.5 py-1 text-[11px] hover:bg-blue-700"
            title={t('config.countries_config.make_editable_btn_title')}
          >
            {saving
              ? t('config.countries_config.promoting_btn')
              : `📥 ${t('config.countries_config.promote_btn')}`}
          </Button>
        </div>
      )}

      <label style={fieldLabelStyle}>{t('config.countries_config.name_label_label')}</label>
      <input
        style={inputStyle(readonly)}
        value={activeRow?.label || ''}
        disabled={readonly}
        onChange={(e) => setDraftField(selectedKey, 'label', e.target.value)}
      />

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle}>{t('config.countries_config.currency_label')}</label>
          <input
            style={inputStyle(readonly)}
            disabled={readonly}
            value={activeRow?.currency || ''}
            onChange={(e) => setCurrency(selectedKey, e.target.value)}
            placeholder="USD"
            list="currency-presets-list"
            title={t('config.countries_config.currency_title_hint')}
          />
          <datalist id="currency-presets-list">
            {Object.keys(CURRENCY_PRESETS).map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle}>{t('config.country_wizard.locale_label')}</label>
          <input
            style={inputStyle(readonly)}
            disabled={readonly}
            value={activeRow?.locale || ''}
            onChange={(e) => setDraftField(selectedKey, 'locale', e.target.value)}
            placeholder="en-US"
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle}>{t('config.countries_config.outlier_label')}</label>
          <input
            type="number"
            style={inputStyle(readonly)}
            disabled={readonly}
            value={activeRow?.outlier_threshold ?? 100}
            onChange={(e) => setDraftField(selectedKey, 'outlier_threshold', e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle}>{t('config.countries_config.max_price_label')}</label>
          <input
            type="number"
            style={inputStyle(readonly)}
            disabled={readonly}
            value={activeRow?.max_price ?? 1000}
            onChange={(e) => setDraftField(selectedKey, 'max_price', e.target.value)}
          />
        </div>
      </div>

      {/* Zona horaria y umbral de riesgo. Las dos columnas existían en
          la base (migs 183 y 216) sin forma de editarlas: un país
          onboardeado por el wizard quedaba en 'UTC' para siempre, y con
          eso "vence hoy" en Proyectos se desfasaba un día. */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle}>
            {t('config.countries_config.timezone_label')}{' '}
            <span title={t('config.countries_config.timezone_tooltip')} style={infoIconStyle}>
              ⓘ
            </span>
          </label>
          <input
            style={inputStyle(readonly)}
            disabled={readonly}
            placeholder="America/Lima"
            value={activeRow?.timezone ?? 'UTC'}
            onChange={(e) => setDraftField(selectedKey, 'timezone', e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle}>
            {t('config.countries_config.risk_days_label')}{' '}
            <span title={t('config.countries_config.risk_days_tooltip')} style={infoIconStyle}>
              ⓘ
            </span>
          </label>
          <input
            type="number"
            min={1}
            max={30}
            style={inputStyle(readonly)}
            disabled={readonly}
            value={activeRow?.projects_risk_days ?? 2}
            onChange={(e) => setDraftField(selectedKey, 'projects_risk_days', e.target.value)}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle}>
            {t('config.countries_config.status_label')}{' '}
            <span title={t('config.countries_config.status_tooltip')} style={infoIconStyle}>
              ⓘ
            </span>
          </label>
          <select
            style={inputStyle(readonly)}
            disabled={readonly}
            value={activeRow?.status || 'active'}
            onChange={(e) => setDraftField(selectedKey, 'status', e.target.value)}
          >
            <option value="draft">{t('config.countries_config.status_draft_option')}</option>
            <option value="active">{t('config.countries_config.status_active_option')}</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle}>
            {t('config.countries_config.bot_rules_label')}{' '}
            <span title={t('config.countries_config.bot_rules_tooltip')} style={infoIconStyle}>
              ⓘ
            </span>
          </label>
          <div
            style={{
              ...inputStyle(true),
              display: 'flex',
              alignItems: 'center',
              fontWeight: 600,
              color: activeRuleCount === 0 ? 'var(--color-warning-fg)' : 'var(--color-text)',
            }}
          >
            {activeRuleCount === 0
              ? t('config.countries_config.bot_rules_zero')
              : t('config.countries_config.bot_rules_count', {
                  n: activeRuleCount,
                  count: activeRuleCount,
                })}
          </div>
        </div>
      </div>

      {!readonly && (
        <div
          style={{
            marginTop: 10,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Button size="sm" disabled={saving} onClick={onSave}>
            {saving ? t('account.saving') : t('config.countries_config.save_country_btn')}
          </Button>
          {/* Cancelar — descarta cambios o el país en memoria.
              Disabled si no hay nada que cancelar (defensivo). */}
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={!isDirty(selectedKey) && !selectedKey.startsWith('NewCountry_')}
            title={
              selectedKey.startsWith('NewCountry_')
                ? t('config.countries_config.cancel_new_title')
                : isDirty(selectedKey)
                  ? t('config.countries_config.cancel_dirty_title')
                  : t('config.countries_config.cancel_clean_title')
            }
          >
            {t('app.cancel')}
          </Button>
          {isDbManaged(selectedKey) && (
            <Button
              variant="outline"
              size="sm"
              className="border-red-300 text-red-600 hover:bg-red-100"
              onClick={onDelete}
            >
              {t('app.delete')}
            </Button>
          )}
          {msg && (
            <span
              style={{
                fontSize: 11,
                color: msg.type === 'ok' ? '#16a34a' : '#dc2626',
              }}
            >
              {msg.text}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

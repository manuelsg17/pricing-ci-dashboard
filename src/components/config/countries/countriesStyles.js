// Estilos inline y constantes compartidas por los paneles de Países
// (CountriesConfig). Sin CSS nuevo: el refactor no cambia cómo se ve.

export const fieldLabelStyle = {
  display: 'block',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--color-muted)',
  marginBottom: 3,
  marginTop: 8,
}

export function inputStyle(disabled) {
  return {
    width: '100%',
    padding: '4px 6px',
    border: '1.5px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    background: disabled ? 'var(--color-bg)' : 'var(--color-panel)',
    color: disabled ? 'var(--color-muted)' : 'var(--color-text)',
    boxSizing: 'border-box',
    outline: 'none',
  }
}

export const competitorTagStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  fontSize: 11,
  background: 'rgba(229,57,53,0.08)',
  border: '1px solid rgba(229,57,53,0.25)',
  borderRadius: 12,
  color: '#b71c1c',
  fontWeight: 600,
}

export const panelHeadingStyle = {
  fontWeight: 700,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--color-muted)',
}

export const infoIconStyle = { cursor: 'help', opacity: 0.6, textTransform: 'none' }

// COMPETITOR_COLORS mezcla, a propósito (ver constants.js), 3 grupos:
// competidores normales (Uber, Didi, InDrive...), tiers exclusivos del
// negocio B2B "Corp" de Perú (YangoEconomy/Premier/XL/Plus, CabifyLite/
// ExtraComfort/XL), y formas legacy con espacio pre-mig-72 (retrocompat
// para leer reportes viejos, nunca válidas para elegir de nuevo). El
// dropdown de "agregar competidor" no debe ofrecer ninguno de los dos
// últimos grupos salvo que se esté editando la ciudad "Corp" de Perú —
// si no, cualquier país nuevo ve una lista de 29 opciones sin sentido
// para su caso (bug reportado onboardeando Bolivia).
export const CORP_ONLY_COMPETITORS = new Set([
  'YangoEconomy',
  'YangoComfort+',
  'YangoPremier',
  'YangoXL',
  'YangoPlus',
  'CabifyLite',
  'CabifyExtraComfort',
  'CabifyXL',
])

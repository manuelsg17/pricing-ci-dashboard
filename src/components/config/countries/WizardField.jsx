// Campo con etiqueta chica del wizard. Sin label renderiza solo el input
// (se usa para las filas 2..n de la grilla de ciudades).
export default function WizardField({ label, required, children }) {
  return (
    <div>
      {label && (
        <label
          style={{
            display: 'block',
            fontSize: 10,
            fontWeight: 600,
            color: '#475569',
            marginBottom: 3,
          }}
        >
          {label}
          {required && <span style={{ color: '#dc2626' }}> *</span>}
        </label>
      )}
      {children}
    </div>
  )
}

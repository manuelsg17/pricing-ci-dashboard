import { useState, useEffect, useCallback } from 'react'
import { toISODate } from '../../lib/dateUtils'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import { sb } from '../../lib/supabase'

// Cuánto tarda REALMENTE cada corte (mig 195).
//
// Responde la pregunta que originó todo el trabajo de duración: "quiero saber
// cuánto tiempo real les toma cada corte, en la mañana, tarde y noche, y
// quiero estar muy seguro de que puedo confiar en esto".
//
// DOS DECISIONES QUE HACEN QUE EL NÚMERO SEA CONFIABLE:
//
//   · Solo entra lo MEDIDO BIEN. La RPC filtra por duration_confiable: un
//     promedio que mezcla tramos capados por el techo de 4h con tramos
//     exactos es justamente el número en el que no se puede confiar. Acá se
//     dice cuántas sesiones quedaron afuera, no se las esconde.
//   · Se muestra la MEDIANA además del promedio. Con pocas muestras, un solo
//     día raro mueve el promedio entero; la mediana no. Si las dos difieren
//     mucho, es señal de que hay dispersión y el promedio solo no alcanza.

const RANGOS = [
  { key: '7', dias: 7 },
  { key: '30', dias: 30 },
  { key: '90', dias: 90 },
]

function fmtMin(n) {
  if (n == null) return '—'
  const m = Number(n)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h}h ${Math.round(m - h * 60)}min`
}

export default function TurnoTimesPanel() {
  const { country } = useCountry()
  const { t } = useI18n()
  const [dias, setDias] = useState(30)
  const [filas, setFilas] = useState([])
  const [excluidas, setExcluidas] = useState(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setFailed(false)
    // Sin este reset, cambiar el rango de 30 a 7 días y que la consulta falle
    // dejaba en pantalla el número de excluidas del rango ANTERIOR, atribuido
    // al nuevo. Un dato viejo con etiqueta nueva es peor que ningún dato.
    setExcluidas(null)

    const hasta = new Date()
    const desde = new Date(hasta.getTime() - dias * 86400000)
    const iso = (d) => toISODate(d)

    const [turnos, calidad] = await Promise.all([
      sb.rpc('ci_turno_minutes', { p_country: country, p_from: iso(desde), p_to: iso(hasta) }),
      // Cuántas sesiones quedaron FUERA del cálculo. Sin este número, el
      // panel podría estar promediando 3 muestras de 40 y el usuario no
      // tendría cómo saberlo.
      sb
        .from('ci_sessions')
        .select('duration_confiable', { count: 'exact', head: true })
        .eq('country', country)
        .gte('observed_date', iso(desde))
        .not('duration_confiable', 'is', true),
    ])

    if (turnos.error) {
      setFailed(true)
      setFilas([])
    } else {
      setFilas(turnos.data || [])
      // `false` ≠ `null`: si el conteo falla, la tabla de arriba SIGUE mostrando
      // medianas y promedios, así que callarse cuántas sesiones quedaron afuera
      // es justo lo contrario de lo que este panel promete. Se distingue
      // "no se pudo calcular" de "todavía no cargó".
      setExcluidas(calidad.error ? false : (calidad.count ?? 0))
    }
    setLoading(false)
  }, [country, dias])

  useEffect(() => {
    load()
  }, [load])

  // Sin sesiones confiables todavía no hay nada honesto que mostrar. Un panel
  // con ceros se leería como "los cortes tardan 0 minutos".
  if (!loading && !failed && filas.length === 0 && !excluidas) return null

  return (
    <section className="mon-panel">
      <div className="mon-panel__head">
        <h2>{t('turnos.title')}</h2>
        <div className="turnos__rangos">
          {RANGOS.map((r) => (
            <button
              key={r.key}
              type="button"
              className={dias === r.dias ? 'is-active' : ''}
              onClick={() => setDias(r.dias)}
            >
              {t('turnos.last_days', { n: r.dias })}
            </button>
          ))}
        </div>
      </div>
      <p className="mon-panel__subtitle">{t('turnos.subtitle')}</p>

      {failed && <div className="de-msg de-msg--err">{t('turnos.failed')}</div>}
      {loading && filas.length === 0 && <p className="mon-panel__empty">{t('app.loading')}</p>}

      {filas.length > 0 && (
        <table className="turnos__tabla">
          <thead>
            <tr>
              <th>{t('turnos.col_turno')}</th>
              <th>{t('turnos.col_mediana')}</th>
              <th>{t('turnos.col_promedio')}</th>
              <th>{t('turnos.col_rango')}</th>
              <th>{t('turnos.col_muestras')}</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.turno}>
                <td className="turnos__nombre">{f.turno}</td>
                {/* La mediana primero: es la que mejor representa "lo normal"
                    cuando hay pocas muestras. */}
                <td className="turnos__destacado">{fmtMin(f.min_mediana)}</td>
                <td>{fmtMin(f.min_prom)}</td>
                <td className="turnos__rango">
                  {fmtMin(f.min_min)} – {fmtMin(f.min_max)}
                </td>
                <td>{f.muestras}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Lo excluido se dice SIEMPRE, incluso cuando es 0 y cuando no se pudo
          contar. Es la diferencia entre "confiá en este número" y "confiá en
          este número y acá está por qué". */}
      {excluidas === false && (
        <p className="turnos__excluidas is-warn">{t('turnos.excluded_unknown')}</p>
      )}
      {typeof excluidas === 'number' && (
        <p className={`turnos__excluidas${excluidas > 0 ? ' is-warn' : ''}`}>
          {excluidas > 0 ? t('turnos.excluded', { n: excluidas }) : t('turnos.none_excluded')}
        </p>
      )}
    </section>
  )
}

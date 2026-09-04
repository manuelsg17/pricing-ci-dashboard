import { useCallback } from 'react'
import { sb } from '../lib/supabase'

// Acciones administrativas sobre un combo guardado sin sesión Terminada
// (UnfinishedSessionsPanel). Antes las RPCs se llamaban inline en el panel;
// acá solo se mueve el acceso a Supabase — la confirmación, los avisos y el
// estado de "ya cerrada" siguen siendo del componente.
//
//   · closeSession → admin_close_ci_session (mig 153/198). NUNCA toca
//     pricing_observations: solo cierra la contabilidad de la sesión.
//     Devuelve `{ data, error }`: desde la mig 198 `data` es
//     `{ id, duplicado, cerrada }` y `cerrada: false` NO es un error.
//   · reassignSession → admin_reassign_ci_session (mig 160/207). La mig 207
//     rechaza destinos inválidos con `invalid_input` en el mensaje.
export function useUnfinishedSessionActions(country) {
  const closeSession = useCallback(
    (r) =>
      sb.rpc('admin_close_ci_session', {
        p_country: country,
        p_city: r.city,
        p_zone: r.zone ?? null,
        p_observed_date: r.observed_date,
        p_user_email: r.uploaded_by,
      }),
    [country]
  )

  const reassignSession = useCallback(
    (r, toEmail) =>
      sb.rpc('admin_reassign_ci_session', {
        p_country: country,
        p_city: r.city,
        p_zone: r.zone ?? null,
        p_observed_date: r.observed_date,
        p_from_email: r.uploaded_by,
        p_to_email: toEmail,
      }),
    [country]
  )

  return { closeSession, reassignSession }
}

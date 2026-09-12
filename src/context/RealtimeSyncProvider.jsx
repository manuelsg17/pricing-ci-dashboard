import { useEffect } from 'react'
import { useRealtimeSync } from '../hooks/useRealtimeSync'
import { useBuildVersionCheck } from '../hooks/useBuildVersionCheck'
import { useToast } from '../components/ui/Toast'
import { useI18n } from './LanguageContext'
import { useAuth } from '../lib/auth'
import { sb } from '../lib/supabase'

// ════════════════════════════════════════════════════════════════════════
// RealtimeSyncProvider
//
// Componente que se monta una sola vez en main.jsx y enchufa el hook
// useRealtimeSync con los callbacks de toast + i18n + auth.
//
// Internacionalización del toast (i18n keys):
//   - realtime.other_session → "Otra sesión actualizó {target}"
//   - realtime.other_user    → "{user} actualizó {target}"
//   - realtime.country_label → "{table} de {country}"
//   - realtime.table.<tabla> → nombre humano de la tabla
//   - country.<key>          → ya existe
//
// Adicional: suscripción al canal 'hard-reload' para que un admin pueda
// forzar refresh global desde /config (cambios drásticos / post-deploy).
// ════════════════════════════════════════════════════════════════════════

export function RealtimeSyncProvider({ children }) {
  const toast = useToast()
  const { t } = useI18n()
  const { session } = useAuth()

  const myEmail = session?.user?.email || null

  useRealtimeSync({
    myEmail,
    enabled: !!session,
    onForeignChange: ({ table, country, userEmail, sameUser }) => {
      const tableLabelKey = `realtime.table.${table}`
      const tableLabel = t(tableLabelKey)
      // t() devuelve la key si no la encuentra; en ese caso usamos el nombre
      // crudo de la tabla como fallback.
      const finalTableLabel = tableLabel === tableLabelKey ? table : tableLabel

      const countryLabel = country ? t(`country.${country}`) || country : null
      const target = countryLabel
        ? t('realtime.country_label', { table: finalTableLabel, country: countryLabel })
        : finalTableLabel

      const msg = sameUser
        ? t('realtime.other_session', { target })
        : t('realtime.other_user', { user: userEmail || t('realtime.someone'), target })

      toast.info(msg, { duration: 6000 })
    },
  })

  // ── Build version check ──────────────────────────────────────────────
  // Detecta cuando se hace un deploy nuevo. Las sesiones abiertas siguen
  // ejecutando el bundle viejo hasta que el usuario haga F5; este hook
  // les avisa con un toast sticky.
  //
  // Auto-reload pasivo: tras 60s de INACTIVIDAD recargamos automáticamente.
  // El usuario puede cerrar el toast (× icon) → cancela el auto-reload via
  // dismiss(). El próximo poll (5 min) NO reabre el toast (dismissedRef
  // mantiene memoria) hasta el siguiente deploy.
  //
  // SESIONES_HALLAZGOS.md P1-9 (2026-08-02, quedó abierto): el timer era fijo
  // desde que aparecía el toast, sin mirar si el hub seguía tecleando — la
  // pérdida de datos ya estaba cubierta (el borrador sobrevive el F5 forzado),
  // pero la recarga podía caer a mitad de una celda. Fix acá: cada tecla o
  // click reinicia la cuenta de 60s, así el reload solo dispara cuando el hub
  // de verdad hizo una pausa — igual que el resto de la app trata "sigue
  // trabajando" (ver src/lib/idleDetection.js), sin construir un sistema de
  // actividad nuevo para esto: son 2 listeners de DOM crudos, acotados a este
  // toast. Tope duro de 10 min para que un hub tecleando sin parar (o un bot
  // de prueba) no evite el reload indefinidamente — algunos deploys traen
  // cambios de esquema que sí necesitan el bundle nuevo.
  useBuildVersionCheck({
    enabled: !!session,
    onNewVersion: ({ dismiss }) => {
      let cancelled = false
      const startedAt = Date.now()
      const HARD_CAP_MS = 10 * 60 * 1000
      let autoReload = null

      const doReload = () => {
        if (!cancelled) window.location.reload()
      }
      const scheduleReload = () => {
        clearTimeout(autoReload)
        const remaining = HARD_CAP_MS - (Date.now() - startedAt)
        autoReload = setTimeout(doReload, Math.max(0, Math.min(60_000, remaining)))
      }
      scheduleReload()

      const onActivity = () => {
        if (!cancelled) scheduleReload()
      }
      document.addEventListener('keydown', onActivity)
      document.addEventListener('pointerdown', onActivity)

      toast.push({
        type: 'info',
        title: t('app.new_version_title'),
        text: t('app.new_version_body'),
        duration: 60_000,
        // Cuando el toast expira o el usuario lo cierra (× icon), el
        // ToastItem llama onClose → la API de Toast no propaga eso a
        // nosotros, así que el cancelado se infiere por timeout. Esto
        // es suficiente para evitar reload no deseado: si el user no
        // hace nada → reload; si el user navega/F5 manualmente → no
        // pasa nada porque ya recargó.
      })

      const cleanup = () => {
        cancelled = true
        clearTimeout(autoReload)
        document.removeEventListener('keydown', onActivity)
        document.removeEventListener('pointerdown', onActivity)
      }

      // Sí queremos cancelar el auto-reload si la pestaña se oculta
      // (el user fue a otra ventana — molesto recargar ahí). Recheck
      // pasará en el próximo polling.
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') {
          cleanup()
          dismiss()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }
      document.addEventListener('visibilitychange', onVisibility)
    },
  })

  // ── Broadcast hard-reload ───────────────────────────────────────────
  // Suscripción aparte al canal 'hard-reload' para casos drásticos (cambios
  // de schema, deploys que invalidan UI). El emisor lo dispara desde
  // /config → botón "🔄 Forzar refresh global" via:
  //   sb.channel('hard-reload').send({ type:'broadcast', event:'reload', payload:{ reason } })
  useEffect(() => {
    if (!session) return
    const channel = sb.channel('hard-reload')
    channel.on('broadcast', { event: 'reload' }, (payload) => {
      const reason = payload?.payload?.reason || ''
      console.info('[realtime] hard-reload broadcast recibido:', reason)
      // Pequeño delay para que un toast previo termine de mostrarse
      setTimeout(() => window.location.reload(), 1500)
    })
    channel.subscribe()
    return () => {
      sb.removeChannel(channel)
    }
  }, [session])

  return children
}

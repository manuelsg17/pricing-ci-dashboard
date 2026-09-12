// Edge Function: delete-user
// Elimina un usuario de Supabase Auth + su fila en user_profiles.
// Requiere SUPABASE_SERVICE_ROLE_KEY (disponible automáticamente en Edge Functions).
// IMPORTANTE: Desactivar "Verify JWT" en Settings de esta función en el dashboard
// (mismo criterio que create-user — el JWT del caller se valida a mano abajo).
//
// POR QUÉ EXISTE (auditoría 2026-09-12): el botón "Eliminar" de Accesos solo
// borraba `user_profiles` desde el cliente (`sb.from('user_profiles').delete()`)
// — la cuenta de Supabase Auth (auth.users) quedaba viva para siempre: la
// persona seguía pudiendo iniciar sesión (veía la pantalla de "perfil no
// encontrado" y no accedía a ninguna sección, así que no era un agujero de
// seguridad explotable), pero el offboarding quedaba incompleto: la
// credencial nunca se revocaba, la cuenta seguía contando en auth.users/MFA,
// y si el email se reasignaba después a otra persona real, quedaba el
// riesgo de reusar una cuenta vieja en vez de una nueva. Con 32 usuarios y
// 0 con MFA verificado, cerrar accesos de verdad al eliminar es la mejora
// de seguridad de mayor impacto por esfuerzo de esta auditoría.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace('Bearer ', '').trim()
    const { data: { user: caller }, error: callerError } = await admin.auth.getUser(jwt)
    if (callerError || !caller) {
      return new Response(JSON.stringify({ error: 'No autorizado' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Mismo guard que create-user: solo admin activo puede eliminar cuentas.
    const { data: callerProfile, error: callerProfileErr } = await admin
      .from('user_profiles')
      .select('is_active, roles(name)')
      .eq('email', (caller.email || '').toLowerCase())
      .maybeSingle()

    const callerRole = (callerProfile as any)?.roles?.name as string | undefined
    if (callerProfileErr || !callerProfile || !callerProfile.is_active || callerRole !== 'admin') {
      return new Response(
        JSON.stringify({ error: 'Solo los administradores pueden eliminar usuarios.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { user_profile_id } = await req.json()
    if (!user_profile_id) {
      return new Response(JSON.stringify({ error: 'user_profile_id es requerido' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: target, error: targetErr } = await admin
      .from('user_profiles')
      .select('email')
      .eq('id', user_profile_id)
      .maybeSingle()
    if (targetErr || !target) {
      return new Response(JSON.stringify({ error: 'Usuario no encontrado' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // No hay columna user_id en user_profiles (identidad por email, ver
    // create-user) — hay que resolver el id de auth.users buscando por
    // email. listUsers() está paginado; con la escala real de este
    // proyecto (~30 cuentas) una sola página alcanza siempre, pero se
    // recorre por si acaso para no dejar cuentas huérfanas silenciosamente.
    const targetEmail = (target.email || '').toLowerCase()
    let authUserId: string | null = null
    for (let page = 1; page <= 20 && !authUserId; page++) {
      const { data: pageData, error: listErr } = await admin.auth.admin.listUsers({
        page,
        perPage: 200,
      })
      if (listErr) {
        return new Response(JSON.stringify({ error: listErr.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      const match = pageData.users.find((u) => (u.email || '').toLowerCase() === targetEmail)
      if (match) authUserId = match.id
      if (pageData.users.length < 200) break
    }

    // Si no hay cuenta de Auth (ya se había borrado, o nunca existió) no es
    // un error — igual hay que borrar el perfil huérfano.
    if (authUserId) {
      const { error: delAuthErr } = await admin.auth.admin.deleteUser(authUserId)
      if (delAuthErr) {
        return new Response(JSON.stringify({ error: delAuthErr.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    const { error: delProfileErr } = await admin
      .from('user_profiles')
      .delete()
      .eq('id', user_profile_id)
    if (delProfileErr) {
      return new Response(JSON.stringify({ error: delProfileErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ ok: true, auth_user_deleted: !!authUserId }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

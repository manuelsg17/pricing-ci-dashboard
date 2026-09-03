// ════════════════════════════════════════════════════════════════════════
// Edge Function: trigger-bot-sync
//
// Permite disparar el workflow de GitHub Actions "Bot Sync" desde el
// dashboard, sin que el usuario tenga que ir a github.com cada vez.
//
// Arquitectura:
//   Browser ──fetch──> Supabase Edge Function ──REST──> GitHub Actions API
//                              │
//                       (PAT vive como secret de Supabase, nunca en el browser)
//
// Variables de entorno (Supabase Dashboard → Edge Functions → Secrets):
//   GITHUB_PAT       Personal Access Token con scope "workflow"
//   GITHUB_REPO      "manuelsg17/pricing-ci-dashboard"
//   GITHUB_WORKFLOW  "bot-sync.yml" (default)
//   GITHUB_REF       "main" (default)
//
// Body POST:
//   { "limit": 5000, "probe_only": false }
// ════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')    return json(405, { error: 'Method not allowed' })

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  // Dos llamadores legítimos:
  //   (a) pg_cron (mig 233): respaldo del cron de GitHub. Se identifica con el
  //       header `x-cron-secret`, cuyo valor vive SOLO en Vault; se valida
  //       contra la base con `cron_trigger_secret_matches` (service_role).
  //   (b) un admin desde el dashboard (botón "Sincronizar ahora").
  let callerLabel: string
  const cronSecret = req.headers.get('x-cron-secret')
  if (cronSecret) {
    const { data: matches, error: rpcError } = await admin.rpc('cron_trigger_secret_matches', {
      p_secret: cronSecret,
    })
    if (rpcError || matches !== true) return json(401, { error: 'No autorizado' })
    callerLabel = 'pg_cron'
  } else {
    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace('Bearer ', '').trim()
    const { data: { user: caller }, error: callerError } = await admin.auth.getUser(jwt)
    if (callerError || !caller) return json(401, { error: 'No autorizado' })

    // El flujo automático corre solo, así que el botón manual es power-user
    // only. Sin este check, cualquier viewer podía gastar minutos de GitHub
    // Actions con disparos repetidos (vector de DoS).
    const { data: profile } = await admin
      .from('user_profiles')
      .select('is_active, roles(name)')
      .eq('email', (caller.email || '').toLowerCase())
      .maybeSingle()
    const role = (profile as any)?.roles?.name as string | undefined
    if (!profile || !profile.is_active || role !== 'admin') {
      return json(403, { error: 'Solo los administradores pueden disparar el sync manualmente.' })
    }
    callerLabel = caller.email || 'admin'
  }

  // Inputs
  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  const limit     = Number(body.limit || 5000)
  const probeOnly = !!body.probe_only

  // Config GitHub
  const pat      = Deno.env.get('GITHUB_PAT')
  const repo     = Deno.env.get('GITHUB_REPO')     || 'manuelsg17/pricing-ci-dashboard'
  const workflow = Deno.env.get('GITHUB_WORKFLOW') || 'bot-sync.yml'
  const ref      = Deno.env.get('GITHUB_REF')      || 'main'

  if (!pat) {
    return json(500, {
      ok: false,
      error: 'GITHUB_PAT no configurado en los secrets de la Edge Function. Ve a Supabase Dashboard → Edge Functions → trigger-bot-sync → Secrets y agrégalo.',
    })
  }

  // Disparar el workflow
  const ghRes = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Accept':                'application/vnd.github+json',
        'Authorization':         `Bearer ${pat}`,
        'X-GitHub-Api-Version':  '2022-11-28',
        'Content-Type':          'application/json',
      },
      body: JSON.stringify({
        ref,
        inputs: {
          limit:      String(limit),
          probe_only: String(probeOnly),
        },
      }),
    }
  )

  // GitHub responde 204 No Content si el dispatch fue aceptado
  if (ghRes.status === 204) {
    return json(200, {
      ok: true,
      mode: probeOnly ? 'probe' : 'sync',
      limit,
      caller: callerLabel,
      message: 'Workflow disparado en GitHub Actions. La corrida aparecerá en "Últimas corridas" en ~30-60s.',
    })
  }

  const txt = await ghRes.text().catch(() => '')
  let detail = ''
  try {
    const j = JSON.parse(txt)
    detail = j.message || JSON.stringify(j)
  } catch {
    detail = txt
  }

  return json(ghRes.status, {
    ok: false,
    error: `GitHub API ${ghRes.status}: ${detail}`,
    hint:
      ghRes.status === 401 ? 'El GITHUB_PAT está mal o expiró.' :
      ghRes.status === 404 ? 'Verifica GITHUB_REPO y GITHUB_WORKFLOW (¿existe el archivo .github/workflows/bot-sync.yml en main?)' :
      ghRes.status === 422 ? 'Inputs inválidos para el workflow.' : undefined,
  })
})

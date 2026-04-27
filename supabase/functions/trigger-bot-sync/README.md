# trigger-bot-sync

Edge Function que dispara el workflow de GitHub Actions "Bot Sync"
desde el dashboard, así no hay que ir a github.com cada vez.

## Setup — paso a paso

### 1. Crear un GitHub Personal Access Token (PAT)

1. https://github.com/settings/tokens?type=beta (fine-grained, recomendado)
2. **Generate new token**
3. **Token name**: `pricing-ci-dashboard-trigger`
4. **Expiration**: 90 days (o lo que prefieras — recuerda renovar)
5. **Repository access**: Only select repositories → `pricing-ci-dashboard`
6. **Repository permissions**:
   - **Actions**: Read and write
   - **Metadata**: Read (auto)
7. **Generate token**
8. **Copia el valor** (`github_pat_...`) — solo se muestra una vez

> Alternativa con classic token: https://github.com/settings/tokens/new
> Solo necesita el scope `workflow`.

### 2. Crear los secrets en Supabase

Supabase Dashboard → Edge Functions → `trigger-bot-sync` → Secrets:

| Name | Value |
|---|---|
| `GITHUB_PAT` | _el token del paso 1_ |
| `GITHUB_REPO` | `manuelsg17/pricing-ci-dashboard` |
| `GITHUB_WORKFLOW` | `bot-sync.yml` |
| `GITHUB_REF` | `main` |

### 3. Deploy de la función

Supabase Dashboard → Edge Functions → **Deploy a new function** → **Via Editor**:
- Function name: `trigger-bot-sync`
- Pega el contenido de `index.ts`
- **Deploy**
- Settings → **Verify JWT**: ON

### 4. Probar desde el dashboard

`/upload` → 🔌 Bot DB Sync → click **⚡ Disparar sync ahora**.

Toast verde: "Workflow disparado en GitHub Actions. La corrida aparecerá en 30-60s."

Refresca la tabla "Últimas corridas" en 1 min — debería aparecer la nueva entrada.

## Troubleshooting

| Error | Causa | Fix |
|---|---|---|
| "GITHUB_PAT no configurado" | Falta secret | Crear en Supabase Dashboard |
| "GitHub API 401" | PAT inválido o expiró | Generar nuevo PAT, actualizar secret |
| "GitHub API 404" | Repo o workflow path malo | Verificar `GITHUB_REPO` y `GITHUB_WORKFLOW` |
| "GitHub API 422" | Inputs inválidos del workflow | Verificar que el workflow .yml acepta `limit` y `probe_only` |

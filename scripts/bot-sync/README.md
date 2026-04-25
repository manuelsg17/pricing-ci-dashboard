# bot-sync — push-mode

Script Python que **se ejecuta en la misma máquina del bot** y empuja
filas nuevas de `quotes_output` a Supabase aplicando los mismos filtros
que el upload manual (filas vacías, montos fuera de rango).

## ¿Por qué push y no la Edge Function de Supabase?

helioho.st presenta un cert TLS autofirmado emitido para otro hostname.
Deno/rustls (runtime de Supabase Edge Functions) valida el hostname a
nivel de TLS handshake y no permite saltarse esa validación de forma
fiable. Resultado: el modelo PULL desde Supabase falla con
`invalid peer certificate: NotValidForName`.

En cambio el push:
- **Outbound HTTPS desde fudobi a `*.supabase.co` siempre funciona** (la
  red de helioho no bloquea conexiones salientes).
- **Conexión local a la BD del bot no requiere TLS** (mismo host).
- **Supabase tiene certs válidos**, así que no hay drama de validación.

## Setup en la máquina del bot

```bash
# 1. Dependencias (una sola vez)
pip install psycopg2-binary requests

# 2. Variables de entorno — guardalas en un archivo .env protegido
#    (chmod 600) o en el systemd unit / cron config.
#    NO las commitees a ningún repo.
cp .env.example .env
# editar .env con los valores reales
```

`.env` esperado:

```
LOCAL_PG_HOST=localhost
LOCAL_PG_PORT=5432
LOCAL_PG_DATABASE=fudobi_boheme
LOCAL_PG_USER=fudobi_admin_boheme
LOCAL_PG_PASSWORD=...
LOCAL_PG_TABLE=quotes_output
LOCAL_PG_SCHEMA=public

SUPABASE_URL=https://boewlfpbkegthrpcksbv.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # ¡NO el anon key — el service_role!

BOT_SYNC_COUNTRY=Peru
```

> ⚠ El `SUPABASE_SERVICE_ROLE_KEY` permite bypassear RLS en TODA tu
> base. Trátalo con el mismo cuidado que el password de PG. Lo
> obtienes en: Supabase Dashboard → Project Settings → API → Service
> Role Key.

## Uso

```bash
# Cargar el .env y correr
set -a; source .env; set +a
python bot_sync_push.py
```

Comandos:

```bash
python bot_sync_push.py                         # incremental (usa watermark)
python bot_sync_push.py --probe                 # solo lista columnas + 3 filas de ejemplo
python bot_sync_push.py --from 2026-04-01 --to 2026-04-25 --limit 50000  # backfill
python bot_sync_push.py --limit 10000           # más filas por corrida
```

## Cron (cada 30 min)

```cron
*/30 * * * * cd /opt/bot-sync && set -a && . ./.env && set +a && \
    /usr/bin/python3 bot_sync_push.py >> /var/log/bot_sync.log 2>&1
```

O con systemd timer (recomendado en distros modernas):

```ini
# /etc/systemd/system/bot-sync.service
[Service]
Type=oneshot
WorkingDirectory=/opt/bot-sync
EnvironmentFile=/opt/bot-sync/.env
ExecStart=/usr/bin/python3 bot_sync_push.py

# /etc/systemd/system/bot-sync.timer
[Unit]
Description=Push bot quotes to Supabase every 30 min
[Timer]
OnBootSec=2min
OnUnitActiveSec=30min
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now bot-sync.timer
sudo systemctl list-timers | grep bot-sync
```

## Probe primero

Antes de activar el incremental, corre `--probe` para confirmar el
esquema real de `quotes_output`:

```bash
python bot_sync_push.py --probe
```

Imprime las columnas + 3 filas de ejemplo. Si los nombres de columna
no son los que el script espera (`created_at`, `city`, `observed_date`,
`app`, `vehicle_category`, `observed_vehicle_category`,
`price_recommended`, `price_with_discount`, `price_without_discount`,
`distance_km`, `eta_min`, `surge`, `rush_hour`), dos opciones:

1. **Crear una vista en fudobi** que renombre, y apuntar
   `LOCAL_PG_TABLE` a la vista:
   ```sql
   CREATE VIEW v_quotes_for_yango AS
   SELECT
     created_at,
     city,
     observed_date,
     ... AS price_recommended,   -- mapping
     ... AS distance_km,
     ...
   FROM quotes_output;
   ```
2. **Editar el SELECT y el bloque de mapeo** en `bot_sync_push.py`.

## Verificación post-corrida

En el dashboard:

- `/upload` → tab **🔌 Bot DB Sync** → tabla "Últimas corridas" muestra
  cada ejecución con read/inserted/dropped/outliers.
- `/rawdata` filtrar por `data_source = 'bot'` → ver las filas
  insertadas.
- Dashboard principal → debería empezar a verse data nueva en los días
  recientes.

## Troubleshooting

| Error | Causa probable | Fix |
|---|---|---|
| `Falta dependencia: psycopg2-binary` | pip install incompleto | `pip install psycopg2-binary requests` |
| `psycopg2.OperationalError: connection refused` | LOCAL_PG_HOST mal configurado | Probar `localhost` o `127.0.0.1` |
| `HTTP 401: Invalid JWT` | SERVICE_ROLE_KEY equivocado | Re-copiar desde Project Settings → API |
| `HTTP 23505: duplicate key` | Filas re-insertadas | Normal en backfill solapado, ignorable; o agregar UNIQUE INDEX en `pricing_observations` por `(city, observed_date, observed_time, competition_name, distance_km)` |
| `column "X" does not exist` | Nombres de columna distintos en `quotes_output` | Correr `--probe` y ajustar |

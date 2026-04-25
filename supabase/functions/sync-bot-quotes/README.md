# sync-bot-quotes

Edge Function que conecta directamente con la BD externa del bot
(`fudobi.helioho.st`) y vuelca filas nuevas en `pricing_observations`,
aplicando la misma normalización + filtros que el upload manual.

---

## 1. Setup inicial — secrets

Las credenciales de la BD del bot **nunca van al repo**. Se cargan como
secrets de la Edge Function en Supabase. Desde la CLI:

```bash
supabase secrets set \
  BOT_PG_HOST=fudobi.helioho.st \
  BOT_PG_PORT=5432 \
  BOT_PG_DATABASE=fudobi_boheme \
  BOT_PG_USER=fudobi_admin_boheme \
  BOT_PG_PASSWORD='<el-password-real>' \
  BOT_PG_TABLE=quotes_output \
  BOT_PG_SCHEMA=public \
  BOT_PG_SSLMODE=prefer
```

Alternativa por UI: Supabase Dashboard → Edge Functions → `sync-bot-quotes`
→ Secrets.

> ⚠ **Verifica que helioho.st permite conexiones desde las IPs de Supabase
> Edge Functions.** Si bloquean por IP, hay que pedirle al admin de
> fudobi que abra la firewall o usar un FDW + cron desde la propia BD del
> bot hacia Supabase.

---

## 2. Deploy

```bash
supabase functions deploy sync-bot-quotes
```

En Supabase Dashboard → Settings de la función:
- **Verify JWT**: ✅ activado (la función verifica el JWT del usuario que
  llama; solo usuarios autenticados pueden disparar el sync).

---

## 3. Probar el esquema de quotes_output (modo PROBE)

Antes de activar el sync hay que confirmar que las columnas que la
función espera existen en `quotes_output`. Llamada desde la app o curl:

```bash
curl -X POST 'https://<your-project>.supabase.co/functions/v1/sync-bot-quotes' \
  -H "Authorization: Bearer <user-jwt>" \
  -H "apikey: <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"action":"probe"}'
```

Devuelve:
```json
{
  "ok": true,
  "columns": [{"column_name":"id","data_type":"bigint"}, ...],
  "sample":  [{"id":1,"created_at":"...", ...}, ...]
}
```

Compara la lista con lo que `sync-bot-quotes/index.ts` consume:

| columna esperada              | uso |
|-------------------------------|-----|
| `created_at` (timestamptz)    | watermark para no re-leer |
| `country`                     | filtro |
| `city`                        | normalizado a dbCity (Lima, Lima_Airport, …) |
| `observed_date`               | fecha de la observación |
| `observed_time`               | hora |
| `app`                         | yango_api / uber / indrive / didi |
| `vehicle_category`            | economy / comfort / premier / xl / tuktuk |
| `observed_vehicle_category`   | desambiguación (comfort vs comfort+) |
| `price_recommended`           | precio efectivo principal |
| `price_with_discount`         | fallback |
| `price_without_discount`      | fallback |
| `distance_km`                 | para asignar bracket |
| `eta_min`                     | opcional |
| `surge`, `rush_hour`          | flags |

Si `quotes_output` usa otros nombres, dos opciones:
- **(a)** crear una vista en fudobi (`CREATE VIEW v_quotes_for_yango AS SELECT … AS price_recommended, …`) y apuntar `BOT_PG_TABLE=v_quotes_for_yango`.
- **(b)** editar el `SELECT *` y el bloque de mapeo en `index.ts`.

---

## 4. Sync incremental

Una vez confirmado el esquema, llamar desde la UI o cron:

```json
{ "action": "sync", "country": "Peru", "limit": 5000 }
```

La función:
1. Lee `last_synced_at` de `bot_sync_watermark` (o `1970-01-01` si es la primera vez).
2. SELECT de `quotes_output` donde `created_at > watermark`, hasta `limit` filas.
3. Normaliza con `botRules` (mismo array que `constants.js`).
4. Asigna `category` + `competition_name` por (`app`, `vc`, `ovc`).
5. Descarta filas vacías o con precio mayor al `price_validation_rules.max_price`.
6. Inserta en `pricing_observations` con `data_source='bot'`.
7. Actualiza `bot_sync_watermark.last_synced_at` al `MAX(created_at)` procesado.
8. Inserta una fila en `bot_sync_log` (visible en /upload/bot-sync).

Backfill manual (ignora watermark):
```json
{ "action": "sync", "country": "Peru", "from": "2026-04-01", "to": "2026-04-25", "limit": 50000 }
```

---

## 5. Cron automático (opcional)

Una vez que el sync funciona manualmente, programarlo cada 30 min con
`pg_cron` (extension habilitada por default en Supabase):

```sql
SELECT cron.schedule(
  'sync-bot-quotes-peru',
  '*/30 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://<project>.supabase.co/functions/v1/sync-bot-quotes',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer <service-role-jwt>"}'::jsonb,
      body := '{"action":"sync","country":"Peru","limit":10000}'::jsonb
    );
  $$
);
```

---

## 6. Troubleshooting

- **TLS error / SSL handshake**: probar `BOT_PG_SSLMODE=disable` (helioho
  a veces no soporta TLS en el plan free); si pasa, advierte al usuario
  que la conexión va en plano y considera mover el bot a un host con TLS.
- **Connection refused**: helioho probablemente bloquea conexiones desde
  IPs de Supabase. Workaround: levantar un proxy en una VM con IP fija
  whitelisted, y apuntar `BOT_PG_HOST` al proxy.
- **column "X" does not exist**: corre `action:"probe"` y ajusta el
  mapping en `index.ts` o crea una vista en fudobi.
- **Filas duplicadas**: `pricing_observations` no tiene UNIQUE sobre
  (city, observed_date, observed_time, competition_name, distance_km),
  así que si re-corres con backfill solapado puede haber duplicados. Si
  esto pasa, agregar un partial UNIQUE INDEX o usar un `INSERT ... ON
  CONFLICT DO NOTHING` cambiando `pricing_observations` para tener un
  `external_row_id` que viene del bot.

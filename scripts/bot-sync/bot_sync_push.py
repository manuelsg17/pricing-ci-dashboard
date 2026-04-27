#!/usr/bin/env python3
"""
bot_sync_push.py — push-mode sync desde la máquina del bot a Supabase.

POR QUÉ ESTE SCRIPT (y no la Edge Function sync-bot-quotes):
    helioho.st presenta un cert TLS autofirmado emitido para otro
    hostname. Deno (runtime de Supabase Edge Functions) usa rustls que
    valida el hostname a nivel de TLS handshake y no permite saltar
    esta validación de forma confiable. Por eso el modelo PULL falla.

    En cambio el bot YA está en la misma máquina que la BD del bot —
    se conecta a localhost (sin TLS) sin problema. Y outbound HTTPS
    desde fudobi a Supabase también funciona siempre.

QUÉ HACE:
    1. SELECT de quotes_output (BD local del bot) desde el último
       watermark guardado en Supabase.
    2. Normaliza con las MISMAS reglas que usan el upload manual y la
       Edge Function (botRules, CATEGORY_NORMALIZE, etc.).
    3. Filtra:
        - filas incompletas (sin city / observed_date / app)
        - filas que no matchean ninguna botRule
        - filas con precio mayor al threshold de price_validation_rules
    4. POST a Supabase REST: pricing_observations con data_source='bot'.
    5. Actualiza watermark + escribe fila en bot_sync_log.

INSTALACIÓN (en la máquina donde corre el bot):
    pip install psycopg2-binary requests

CONFIGURACIÓN — variables de entorno:
    LOCAL_PG_HOST                 (ej: localhost o 127.0.0.1)
    LOCAL_PG_PORT                 (ej: 5432)
    LOCAL_PG_DATABASE             (ej: fudobi_boheme)
    LOCAL_PG_USER                 (ej: fudobi_admin_boheme)
    LOCAL_PG_PASSWORD             (la contraseña local)
    LOCAL_PG_TABLE                (default: quotes_output)
    LOCAL_PG_SCHEMA               (default: public)
    SUPABASE_URL                  https://<project-ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY     service_role JWT (NO el anon key) —
                                  permite bypassear RLS para insertar.
    BOT_SYNC_COUNTRY              default: Peru

USO:
    python bot_sync_push.py                        # incremental (usa watermark)
    python bot_sync_push.py --probe                # solo lista columnas
    python bot_sync_push.py --from 2026-04-01 --to 2026-04-25  # backfill manual
    python bot_sync_push.py --limit 10000          # más filas por corrida

CRON (cada 30 min):
    */30 * * * * cd /path/to/scripts/bot-sync && \
        /usr/bin/env -S /path/to/.env python bot_sync_push.py >> /var/log/bot_sync.log 2>&1
"""
from __future__ import annotations
import os
import sys
import json
import argparse
import datetime as dt

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("Falta dependencia: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(2)

try:
    import requests
except ImportError:
    print("Falta dependencia: pip install requests", file=sys.stderr)
    sys.exit(2)

try:
    from zoneinfo import ZoneInfo  # Python 3.9+
except ImportError:
    print("Falta dependencia (zoneinfo, viene con Python 3.9+)", file=sys.stderr)
    sys.exit(2)


# Normalización de distance_bracket: el bot usa Title Case, nosotros snake_case
BRACKET_NORMALIZE = {
    'very short': 'very_short',
    'very long':  'very_long',
    'short':      'short',
    'median':     'median',
    'average':    'average',
    'long':       'long',
}


# ── Reglas y diccionarios ───────────────────────────────────────────────
# Deben coincidir con:
#   src/algorithms/ingestionFilters.js
#   supabase/functions/sync-bot-quotes/index.ts

CATEGORY_NORMALIZE = {
    'Economy/Comfort':  'Economy/Comfort',
    'Comfort+':         'Comfort+',
    'Comfort/Comfort+': 'Comfort+',
    'Comfort+/Premier': 'Premier',
    'Economy':          'Economy/Comfort',
    'Comfort':          'Comfort+',
}

# (app, vc, ovc, competition_name, ui_category, allowed_cities or None)
BOT_RULES = [
    ('yango_api', 'economy',  'economy',  'Yango',        'Economy/Comfort', None),
    ('yango_api', 'comfort',  'comfort',  'YangoComfort', 'Economy/Comfort', None),
    ('yango_api', 'comfort',  'comfort+', 'Yango',        'Comfort+',        None),
    ('yango_api', 'premier',  'premier',  'Yango',        'Premier',         {'Lima', 'Lima_Airport'}),
    ('yango_api', 'xl',       'xl',       'Yango',        'XL',              None),
    ('yango_api', 'tuktuk',   '*',        'Yango',        'TukTuk',          {'Lima'}),
    ('uber',      'economy',  'uberx',    'Uber',         'Economy/Comfort', None),
    ('uber',      'comfort',  'comfort',  'Uber',         'Comfort+',        None),
    ('uber',      'premium',  'black',    'Uber',         'Premier',         {'Lima', 'Lima_Airport'}),
    ('uber',      'xl',       'xl',       'Uber',         'XL',              None),
    ('uber',      'tuktuk',   '*',        'Uber',         'TukTuk',          {'Lima'}),
    ('indrive',   'economy',  'viaje',    'InDrive',      'Economy/Comfort', None),
    ('indrive',   'comfort',  'confort',  'InDrive',      'Comfort+',        None),
    ('indrive',   'xl',       'xl',       'InDrive',      'XL',              None),
    ('didi',      'economy',  'express',  'Didi',         'Economy/Comfort', None),
]

BOT_CITY_MAP = {
    'lima': 'Lima', 'trujillo': 'Trujillo', 'arequipa': 'Arequipa',
    'lima_airport': 'Lima_Airport',
    'trujillo_airport': 'Trujillo_Airport',
    'arequipa_airport': 'Arequipa_Airport',
    'bogota': 'Bogota', 'medellin': 'Medellin', 'cali': 'Cali',
}


def normalize_city(c):
    if not c:
        return None
    k = c.lower().replace(' ', '_').replace('-', '_')
    return BOT_CITY_MAP.get(k, c)


def resolve_rule(app, vc, ovc, db_city):
    a = (app or '').lower()
    v = (vc or '').lower()
    o = (ovc or '').lower()
    for r_app, r_vc, r_ovc, name, category, cities in BOT_RULES:
        if r_app != a:
            continue
        if r_vc != v:
            continue
        if r_ovc != '*' and r_ovc != o:
            continue
        if cities and db_city not in cities:
            continue
        return name, category
    return None, None


# ── Supabase REST helpers ───────────────────────────────────────────────
def sb_headers(extra=None):
    h = {
        'apikey':        SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type':  'application/json',
    }
    if extra:
        h.update(extra)
    return h


def get_watermark(country):
    res = requests.get(
        f'{SUPABASE_URL}/rest/v1/bot_sync_watermark',
        params={'country': f'eq.{country}', 'select': 'last_synced_at'},
        headers=sb_headers(),
        timeout=15,
    )
    if not res.ok:
        return '1970-01-01T00:00:00+00:00'
    rows = res.json()
    return rows[0]['last_synced_at'] if rows else '1970-01-01T00:00:00+00:00'


def upsert_watermark(country, ts):
    requests.post(
        f'{SUPABASE_URL}/rest/v1/bot_sync_watermark',
        params={'on_conflict': 'country'},
        headers=sb_headers({'Prefer': 'resolution=merge-duplicates,return=minimal'}),
        json=[{
            'country': country,
            'last_synced_at': ts,
            'updated_at': dt.datetime.utcnow().isoformat() + '+00:00',
        }],
        timeout=15,
    )


def insert_log(country, started_at, **notes):
    res = requests.post(
        f'{SUPABASE_URL}/rest/v1/bot_sync_log',
        headers=sb_headers({'Prefer': 'return=representation'}),
        json=[{
            'country':    country,
            'started_at': started_at,
            'status':     'running',
            'notes':      notes,
        }],
        timeout=15,
    )
    if not res.ok:
        return None
    data = res.json()
    return data[0]['id'] if data else None


def update_log(log_id, **fields):
    if not log_id:
        return
    requests.patch(
        f'{SUPABASE_URL}/rest/v1/bot_sync_log',
        params={'id': f'eq.{log_id}'},
        headers=sb_headers({'Prefer': 'return=minimal'}),
        json=fields,
        timeout=15,
    )


def get_price_rules(country):
    res = requests.get(
        f'{SUPABASE_URL}/rest/v1/price_validation_rules',
        params={
            'country': f'eq.{country}',
            'select':  'city,category,competition,max_price',
        },
        headers=sb_headers(),
        timeout=15,
    )
    return res.json() if res.ok else []


def find_threshold(rules, city, category, comp):
    for r in rules:
        if r['city'] == city and r['category'] == category and r['competition'] == comp:
            return r['max_price']
    for r in rules:
        if r['city'] == city and r['category'] == category and r['competition'] == 'all':
            return r['max_price']
    for r in rules:
        if r['city'] == city and r['category'] == 'all' and r['competition'] == 'all':
            return r['max_price']
    return None


# ── Main ────────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(description='Push-mode sync del bot → Supabase')
    p.add_argument('--probe', action='store_true', help='Solo listar columnas y 3 filas de ejemplo')
    p.add_argument('--from', dest='date_from', help='Backfill: fecha desde (YYYY-MM-DD)')
    p.add_argument('--to',   dest='date_to',   help='Backfill: fecha hasta (YYYY-MM-DD)')
    p.add_argument('--limit', type=int, default=5000, help='Máximo de filas por corrida')
    args = p.parse_args()

    country = os.environ.get('BOT_SYNC_COUNTRY', 'Peru')
    table   = os.environ.get('LOCAL_PG_TABLE',  'quotes_output')
    schema  = os.environ.get('LOCAL_PG_SCHEMA', 'public')
    fq_table = f'"{schema}"."{table}"'

    conn = psycopg2.connect(
        host=os.environ['LOCAL_PG_HOST'],
        port=int(os.environ.get('LOCAL_PG_PORT', '5432')),
        dbname=os.environ['LOCAL_PG_DATABASE'],
        user=os.environ['LOCAL_PG_USER'],
        password=os.environ['LOCAL_PG_PASSWORD'],
        sslmode=os.environ.get('LOCAL_PG_SSLMODE', 'require'),  # helioho exige SSL
        connect_timeout=15,
    )
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # ── PROBE ────────────────────────────────────────────────────────
    if args.probe:
        cur.execute("""
            SELECT column_name, data_type
              FROM information_schema.columns
             WHERE table_schema = %s AND table_name = %s
             ORDER BY ordinal_position
        """, (schema, table))
        cols = cur.fetchall()
        print('-- COLUMNS --')
        print(json.dumps(cols, indent=2, default=str))
        cur.execute(f'SELECT * FROM {fq_table} LIMIT 3')
        sample = cur.fetchall()
        print('\n-- SAMPLE --')
        print(json.dumps(sample, indent=2, default=str))
        cur.close(); conn.close()
        return

    # ── SYNC ─────────────────────────────────────────────────────────
    started_at = dt.datetime.utcnow().isoformat() + '+00:00'
    notes = {'limit': args.limit, 'date_from': args.date_from, 'date_to': args.date_to,
             'host': os.environ.get('LOCAL_PG_HOST', '?')}
    log_id = insert_log(country, started_at, **notes)

    inserted = 0
    stats = {'read': 0, 'dropped': 0, 'outliers': 0}

    try:
        # Filtros de la query: status='ok' + business_unit='ridehailing' +
        # solo el país pedido. Los hacemos lower() para tolerar variantes.
        if args.date_from and args.date_to:
            cur.execute(
                f'SELECT * FROM {fq_table} '
                f'WHERE timestamp_utc::date BETWEEN %s AND %s '
                f'  AND lower(status) = %s '
                f'  AND lower(business_unit) = %s '
                f'  AND country = %s '
                f'ORDER BY timestamp_utc LIMIT %s',
                (args.date_from, args.date_to, 'ok', 'ridehailing', country, args.limit),
            )
        else:
            wm = get_watermark(country)
            cur.execute(
                f'SELECT * FROM {fq_table} '
                f'WHERE timestamp_utc > %s '
                f'  AND lower(status) = %s '
                f'  AND lower(business_unit) = %s '
                f'  AND country = %s '
                f'ORDER BY timestamp_utc LIMIT %s',
                (wm, 'ok', 'ridehailing', country, args.limit),
            )
        rows = cur.fetchall()
        stats['read'] = len(rows)

        price_rules = get_price_rules(country)

        accepted = []
        max_created = '1970-01-01T00:00:00+00:00'

        for raw in rows:
            # Watermark: timestamp_utc es la columna de incremento del bot
            ts_utc = raw.get('timestamp_utc')
            if ts_utc is None:
                stats['dropped'] += 1; continue
            ts_str = ts_utc.isoformat() if hasattr(ts_utc, 'isoformat') else str(ts_utc)
            if ts_str > max_created:
                max_created = ts_str

            db_city = normalize_city(raw.get('city'))
            if not db_city or not raw.get('app'):
                stats['dropped'] += 1; continue

            # Resolver regla del bot
            name, category = resolve_rule(
                raw.get('app'),
                raw.get('vehicle_category'),
                raw.get('observed_vehicle_category'),
                db_city,
            )
            if not name:
                stats['dropped'] += 1; continue

            # Precios — el bot usa price_regular_value y price_discounted_value
            rec = raw.get('price_regular_value')      # precio sin descuento
            pwd = raw.get('price_discounted_value')   # precio con descuento (puede ser NULL)
            eff = rec if rec is not None else pwd
            if eff is None:
                stats['dropped'] += 1; continue

            threshold = find_threshold(price_rules, db_city, category, name)
            if threshold is not None and float(eff) > float(threshold):
                stats['outliers'] += 1; continue

            # observed_date / observed_time: convertir timestamp_utc a la
            # zona horaria local del registro para obtener la fecha/hora
            # correcta como la ve el usuario en el dashboard.
            tz_name = raw.get('timezone') or 'UTC'
            try:
                tz = ZoneInfo(tz_name)
            except Exception:
                tz = ZoneInfo('UTC')
            local_dt = ts_utc.astimezone(tz) if hasattr(ts_utc, 'astimezone') else ts_utc
            observed_date = local_dt.date().isoformat()
            observed_time = local_dt.strftime('%H:%M:%S')

            # distance_bracket: el bot ya viene con bracket en Title Case
            raw_bracket = raw.get('distance_bracket')
            norm_bracket = None
            if raw_bracket:
                norm_bracket = BRACKET_NORMALIZE.get(raw_bracket.lower()) \
                            or raw_bracket.lower().replace(' ', '_')

            accepted.append({
                'country':                country,
                'city':                   db_city,
                'observed_date':          observed_date,
                'observed_time':          observed_time,
                'category':               category,
                'competition_name':       name,
                'recommended_price':      float(rec) if rec is not None else None,
                'price_with_discount':    float(pwd) if pwd is not None else None,
                # también lo guardamos en price_without_discount para que
                # las queries del dashboard que prefieren ese campo lo encuentren
                'price_without_discount': float(rec) if rec is not None else None,
                'eta_min':                float(raw['eta_mins']) if raw.get('eta_mins') is not None else None,
                'surge':                  raw.get('surge'),
                'distance_bracket':       norm_bracket,
                'data_source':            'bot',
            })

        # Insert en lotes
        BATCH = 500
        for i in range(0, len(accepted), BATCH):
            chunk = accepted[i:i + BATCH]
            res = requests.post(
                f'{SUPABASE_URL}/rest/v1/pricing_observations',
                headers=sb_headers({'Prefer': 'return=minimal'}),
                json=chunk,
                timeout=60,
            )
            if not res.ok:
                raise RuntimeError(f'Insert chunk {i}: HTTP {res.status_code} → {res.text[:300]}')
            inserted += len(chunk)

        if not (args.date_from and args.date_to) and stats['read'] > 0:
            upsert_watermark(country, max_created)

        update_log(log_id,
                   status='ok',
                   finished_at=dt.datetime.utcnow().isoformat() + '+00:00',
                   read_count=stats['read'],
                   inserted_count=inserted,
                   dropped_count=stats['dropped'],
                   outlier_count=stats['outliers'])
        print(f'OK · read={stats["read"]} inserted={inserted} '
              f'dropped={stats["dropped"]} outliers={stats["outliers"]} '
              f'watermark={max_created}')

    except Exception as e:
        update_log(log_id,
                   status='error',
                   finished_at=dt.datetime.utcnow().isoformat() + '+00:00',
                   error_msg=str(e),
                   read_count=stats['read'],
                   inserted_count=inserted,
                   dropped_count=stats['dropped'],
                   outlier_count=stats['outliers'])
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)
    finally:
        cur.close()
        conn.close()


# ── Bootstrap ──────────────────────────────────────────────────────────
def _required(var):
    val = os.environ.get(var)
    if not val:
        print(f'Falta variable de entorno: {var}', file=sys.stderr)
        sys.exit(2)
    return val


SUPABASE_URL = _required('SUPABASE_URL')
SUPABASE_KEY = _required('SUPABASE_SERVICE_ROLE_KEY')

if __name__ == '__main__':
    main()

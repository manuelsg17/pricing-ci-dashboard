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
       watermark guardado en Supabase, con un MARGEN DE RE-LECTURA hacia
       atrás (BOT_SYNC_LOOKBACK_HOURS, default 6h) para rescatar filas que
       el bot inserta fuera de orden de timestamp (rutas lentas de computar
       como very_long/aeropuerto llegan tarde y el watermark ya pasó su
       timestamp). El UPSERT idempotente hace que re-leer sea inofensivo.
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
import time
import random
import functools
import argparse
import datetime as dt
from collections import Counter

try:
    import psycopg2
    import psycopg2.extras
    from psycopg2 import OperationalError
except ImportError:
    print("Falta dependencia: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(2)


# ── Retry helper para conexión a helioho (shared hosting con max_connections bajo) ──
# Errores transitorios: el script reintenta con exponential backoff + jitter.
# Sin esto, un único timing colision con otro tenant (o un timeout de red)
# tumba la corrida entera.
#
# Bug real (2026-09-03): helioho tuvo degradación intermitente — en una
# misma corrida, 3 de 5 países conectaron bien y 2 fallaron con
# "connection ... failed: timeout expired" contra las 3 IPs del host. Ese
# mensaje NO estaba en esta lista (pensada solo para el escenario de
# "se agotaron los slots"), así que el wrapper de 8 reintentos con backoff
# nunca se activaba: fallaba en el primer intento sin reintentar ni una vez.
# "timeout expired" es el mensaje real que psycopg2 da cuando el TCP connect
# no responde a tiempo — agregado explícitamente.
SLOT_EXHAUSTED_MARKERS = (
    "remaining connection slots",
    "too many connections",
    "could not connect",
    "server closed the connection",
    "timeout expired",
)


def retry_on_pg_unavailable(retries: int = 5, base: float = 5.0, cap: float = 60.0):
    """Decorator: reintenta OperationalError transitorios con backoff exponencial."""
    def deco(fn):
        @functools.wraps(fn)
        def wrap(*args, **kwargs):
            for attempt in range(retries):
                try:
                    result = fn(*args, **kwargs)
                    if attempt > 0:
                        print(f"[bot_sync] connected after {attempt} retries", flush=True)
                    return result
                except OperationalError as e:
                    msg = str(e).lower()
                    transient = any(m in msg for m in SLOT_EXHAUSTED_MARKERS)
                    if not transient or attempt == retries - 1:
                        raise
                    delay = min(cap, base * (2 ** attempt))
                    delay += random.uniform(0, delay * 0.3)  # jitter para desincronizar
                    print(
                        f"[bot_sync] retry {attempt+1}/{retries} pg unavailable, "
                        f"sleeping {delay:.1f}s: {e}",
                        flush=True,
                    )
                    time.sleep(delay)
        return wrap
    return deco

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

# 6 brackets canónicos que entiende el dashboard. Cualquier variante
# (long_a, airport_short_b, median_zona_sur, *_madrid, etc.) tiene que
# colapsar a uno de estos o a None.
import re as _re
_CANONICAL = {'very_short', 'short', 'median', 'average', 'long', 'very_long'}
_SATELLITE_RE = _re.compile(r'_(madrid|funza|mosquera|cota|chia|soacha|cajica|tenjo|sopo|sibate)$')
_ZONE_RE      = _re.compile(r'_(zona_(sur|norte|centro|este|oeste)|sur|norte|centro|este|oeste)$')
_AB_RE        = _re.compile(r'_(a|b)$')

# Qué bracket significa 'medium' según el país. NO es un typo universal: es
# nomenclatura de cada simulador y significa cosas distintas.
#
#   · Perú  → 'average'. Confirmado por el dueño del simulador (2026-07-31):
#     escribió "Medium" donde quería decir la banda `average`. Se ve en los
#     datos: `average` tenía ~13k filas contra 22-30k de todos los demás
#     brackets, y `median` era el más alto de todos — estaba absorbiendo lo
#     que correspondía a `average`. El simulador se está corrigiendo para
#     emitir "Average"; este mapeo cubre las rutas que queden sin actualizar
#     durante la transición.
#   · Resto → 'median' (comportamiento histórico, sin cambios).
#     OJO: Colombia muestra la MISMA forma sospechosa (71.079 en `median`
#     contra 1.659 en `average`), pero nadie confirmó qué significa "Medium"
#     en ese simulador y una vez normalizado el valor crudo es
#     irrecuperable. Cambiarlo a ciegas mandaría ~71k filas/mes al bracket
#     equivocado, así que se deja como está hasta que alguien lo confirme.
MEDIUM_MEANS_BY_COUNTRY = {'Peru': 'average'}
MEDIUM_MEANS = 'median'  # se ajusta en main() según BOT_SYNC_COUNTRY


def normalize_distance_bracket(raw):
    """Mapea variantes zone-aware del bot al canónico, o None."""
    if not raw:
        return None
    s = _re.sub(r'[\s\-]+', '_', str(raw).lower())
    s = _re.sub(r'^airport_', '', s)
    s = _SATELLITE_RE.sub('', s)
    s = _ZONE_RE.sub('', s)
    s = _AB_RE.sub('', s)
    if s == 'medium':     s = MEDIUM_MEANS   # ver MEDIUM_MEANS_BY_COUNTRY
    if s == 'very short': s = 'very_short'
    if s == 'very long':  s = 'very_long'
    return s if s in _CANONICAL else None


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

# BOT_RULES se carga desde Supabase (tabla bot_rules) para que cada país
# tenga su propio set de reglas sin tocar este script. Ver load_bot_rules().
# El array global se llena en main() después de leer BOT_SYNC_COUNTRY.
BOT_RULES = []
# None = guard de ciudad desconocida desactivado (country_config ilegible).
KNOWN_CITIES = None

# AIRPORT_MARKERS se carga desde la tabla airport_markers (mig 78). Cada
# marker mapea (country, base_city) → (city_from, city_to, keywords[]) y
# es lo que permite separar viajes desde-aeropuerto y hacia-aeropuerto en
# pricing_observations. Se popula en main() después de BOT_RULES.
AIRPORT_MARKERS = []

# Zonas de aeropuerto de los markers activos, indexadas por CLAVE NORMALIZADA
# ({'airport_b': 'Airport_B', …}). Se usa para dos cosas: decidir el ruteo y
# decidir qué zone PERSISTIR (mig 178).
#
# La clave normalizada existe porque la comparación era EXACTA y sensible a
# mayúsculas: un simulador que mandara 'airport_b', 'AIRPORT_B' o 'Airport B'
# no matcheaba, la zona se descartaba EN SILENCIO y el viaje caía en la ciudad
# base mezclado con el CI normal. Pasó en producción (2026-07-31: una ruta
# nueva de Arequipa hacia el aeropuerto entró sin zona y contaminó Arequipa).
# Siempre se PERSISTE el valor canónico del marker, nunca lo que vino crudo —
# si no, el dashboard tendría 'airport_b' y 'Airport_B' como zonas distintas.
AIRPORT_ZONES_BY_KEY = {}


def _zone_key(v):
    """Clave tolerante para comparar zonas: minúsculas y separadores unificados."""
    if v is None:
        return None
    k = _re.sub(r'[\s\-]+', '_', str(v).strip().lower())
    return k or None

# botCityMap de respaldo. Si la tabla country_config existe en Supabase,
# se prefiere ese; si no, este dict cubre los casos conocidos.
#
# NOTA aeropuerto (post mig 78-85): los nombres legacy *_Airport ya NO
# son cities válidas. Si el scraper aún envía city='lima_airport', lo
# mapeamos a 'Lima' (base) y dejamos que resolve_airport_route() rutee
# por raw.zone (mig 178: SOLO zona, ya no keywords). El trigger BEFORE INSERT (mig 83) es red de
# seguridad si algo se cuela.
BOT_CITY_MAP = {
    # Perú
    'lima': 'Lima', 'trujillo': 'Trujillo', 'arequipa': 'Arequipa',
    'lima_airport': 'Lima',         # → trigger/resolve_airport_route rutea a A/B
    'trujillo_airport': 'Trujillo',
    'arequipa_airport': 'Arequipa',
    # Splits directos (si el scraper los emite con A/B)
    'lima_airport_a': 'Lima_Airport_A',
    'lima_airport_b': 'Lima_Airport_B',
    'trujillo_airport_a': 'Trujillo_Airport_A',
    'trujillo_airport_b': 'Trujillo_Airport_B',
    'arequipa_airport_a': 'Arequipa_Airport_A',
    'arequipa_airport_b': 'Arequipa_Airport_B',
    # Colombia
    'bogota': 'Bogota', 'bogotá': 'Bogota',
    'cali': 'Cali',
    'barranquilla': 'Barranquilla', 'baq': 'Barranquilla',
    # Otros países LATAM (single-city)
    'kathmandu': 'Kathmandu',
    'santa_cruz': 'Santa Cruz', 'santa cruz': 'Santa Cruz',
    'caracas': 'Caracas',
    'lusaka': 'Lusaka',
}


def load_bot_rules(country):
    """
    Carga botRules desde la tabla bot_rules de Supabase para el country
    activo. Retorna una lista de tuplas compatible con resolve_rule().

    Ventajas vs hardcodear:
    - Agregar un país nuevo NO requiere editar este script.
    - Si el equipo ajusta una regla en SQL/UI, el bot la levanta en la
      próxima corrida sin necesidad de redeploy.
    """
    try:
        res = requests.get(
            f'{SUPABASE_URL}/rest/v1/bot_rules',
            headers=sb_headers(),
            params={
                'country':  f'eq.{country}',
                'active':   'eq.true',
                'select':   'app,vc,ovc,competition_name,category,cities',
            },
            timeout=20,
        )
        res.raise_for_status()
        rows = res.json() or []
    except Exception as e:
        print(f"[load_bot_rules] error: {e}", file=sys.stderr)
        return []

    rules = []
    for r in rows:
        cities = set(r.get('cities') or [])
        # ovc admite variantes separadas por coma (ej. "viaje, viajes
        # económicos, viaje+") para que una sola regla cubra distintos
        # labels que la misma app manda con el tiempo — se guarda como
        # set, no como string, para no repetir el split en cada fila
        # entrante de resolve_rule().
        ovc_variants = frozenset(
            v.strip() for v in (r.get('ovc') or '').lower().split(',') if v.strip()
        )
        rules.append((
            (r.get('app') or '').lower(),
            (r.get('vc') or '').lower(),
            ovc_variants,
            r.get('competition_name'),
            r.get('category'),
            cities if cities else None,
        ))
    return rules


def normalize_city(c):
    if not c:
        return None
    k = c.lower().replace(' ', '_').replace('-', '_')
    return BOT_CITY_MAP.get(k, c)


def load_airport_markers(country):
    """
    Carga airport_markers desde Supabase (mig 78). Retorna lista de dicts
    {base_city, city_from, city_to, keywords:[lowercased]}.

    Si la tabla aún no existe (mig 78 sin aplicar) o no hay markers para
    el país, retorna []. La detección de aeropuerto queda desactivada y
    el sync funciona como antes — backward compatible.
    """
    try:
        res = requests.get(
            f'{SUPABASE_URL}/rest/v1/airport_markers',
            headers=sb_headers(),
            params={
                'country': f'eq.{country}',
                'active':  'eq.true',
                'select':  'base_city,city_from,city_to,keywords,zone_from_value,zone_to_value',
            },
            timeout=20,
        )
        # 404/406 = tabla no existe todavía — silencioso
        if res.status_code in (404, 406):
            return []
        res.raise_for_status()
        rows = res.json() or []
    except Exception as e:
        print(f"[load_airport_markers] error: {e}", file=sys.stderr)
        return []

    markers = []
    for r in rows:
        kws = [k.lower() for k in (r.get('keywords') or []) if k]
        markers.append({
            'base_city':        r.get('base_city'),
            'city_from':        r.get('city_from'),
            'city_to':          r.get('city_to'),
            'keywords':         kws,
            # zone_from/zone_to son la ÚNICA señal de ruteo desde mig 178.
            'zone_from_value':  (r.get('zone_from_value') or '').strip() or None,
            'zone_to_value':    (r.get('zone_to_value')   or '').strip() or None,
        })
    return markers


def load_known_cities(country):
    """
    Ciudades reconocidas del país según country_config.cities (dbName), más
    los destinos de aeropuerto (city_from/city_to de airport_markers).

    GUARD "ciudad desconocida" (2026-08-29): el sync NO tiene lista blanca de
    ciudades — normalize_city() deja pasar tal cual cualquier nombre que
    mande la fuente. Caso real: Chía acumuló ~90k filas durante 4 MESES sin
    estar en country_config — la data entraba bien pero era invisible en el
    dashboard (ningún selector la ofrecía) y nadie lo notó hasta una
    auditoría manual. Este guard no la habría bloqueado (bloquear data
    legítima sería peor), pero la habría hecho visible en bot_sync_log.notes
    desde la primera corrida.

    Devuelve None si country_config no se pudo leer (guard desactivado esa
    corrida — mejor sin chequeo que un falso "todo desconocido").
    """
    try:
        res = requests.get(
            f'{SUPABASE_URL}/rest/v1/country_config',
            headers=sb_headers(),
            params={'country_key': f'eq.{country}', 'select': 'cities'},
            timeout=20,
        )
        res.raise_for_status()
        rows = res.json() or []
    except Exception as e:
        print(f"[load_known_cities] error: {e}", file=sys.stderr)
        return None
    if not rows:
        return None
    known = set()
    for c in (rows[0].get('cities') or []):
        if c.get('dbName'):
            known.add(c['dbName'])
    for m in AIRPORT_MARKERS:
        for k in ('city_from', 'city_to', 'base_city'):
            if m.get(k):
                known.add(m[k])
    return known or None


def resolve_airport_route(db_city, point_a, point_b, raw_zone=None):
    """
    Decide si una observación debe re-rutearse a city_from / city_to.

    SOURCE-OF-TRUTH — SOLO la zona (mig 178, 2026-07-31):
      1. raw.zone == marker.zone_from_value  → city_from
      2. raw.zone == marker.zone_to_value    → city_to
      3. Sin match:
           - db_city era legacy "<base>_Airport" → base_city
           - db_city ya era base_city            → sin cambios

    Las keywords sobre point_a/point_b se ELIMINARON como señal de ruteo.
    Eran un match por substring y producían falsos positivos reales: una
    calle "Av. Jorge Chavez 42" (colegio en Villa El Salvador) matcheaba la
    keyword del Aeropuerto Jorge Chávez y mandó 320 filas —279 de TukTuk y
    41 de categorías normales— al bucket Lima_Airport_A. Verificado antes de
    quitarlas: de 59.661 filas que matcheaban "jorge ch", 59.341 ya
    matcheaban además una keyword específica; solo esas 320 dependían de la
    genérica y ninguna era un aeropuerto real.

    CONSECUENCIA ACEPTADA: un viaje de aeropuerto que llegue SIN zona ya no
    se atrapa y se queda en la ciudad base. Por eso el sync ahora cuenta las
    filas sin zona (`airport_sin_zone` en las notas del log) — para que un
    Excel mal etiquetado se vea, en vez de degradar en silencio.
    """
    if not AIRPORT_MARKERS or not db_city:
        return db_city

    marker = None
    is_legacy = False
    for m in AIRPORT_MARKERS:
        if db_city == m['base_city']:
            marker = m
            break
        if db_city == f"{m['base_city']}_Airport":
            marker = m
            is_legacy = True
            break
    if marker is None:
        return db_city

    # 1-2. Zone-based — única señal de ruteo (mig 178)
    zk = _zone_key(raw_zone)
    if zk:
        if marker.get('zone_from_value') and zk == _zone_key(marker['zone_from_value']):
            return marker['city_from']
        if marker.get('zone_to_value') and zk == _zone_key(marker['zone_to_value']):
            return marker['city_to']

    # 3. Sin zona de aeropuerto: legacy → base; ya-base → sin cambios.
    return marker['base_city'] if is_legacy else db_city


def looks_like_airport_without_zone(db_city, point_a, point_b, raw_zone):
    """
    Red de seguridad de observabilidad (mig 178).

    Desde que el ruteo es zone-only, un viaje de aeropuerto que llegue sin
    etiquetar se queda en la ciudad base y se mezcla con el CI normal —
    silenciosamente. Esta función NO rutea nada: solo detecta ese caso
    (la dirección huele a aeropuerto pero no vino zona de aeropuerto) para
    contarlo en las notas del log y que el Excel mal etiquetado se note.
    """
    if _zone_key(raw_zone) in AIRPORT_ZONES_BY_KEY:
        return False
    marker = next(
        (m for m in AIRPORT_MARKERS
         if db_city in (m['base_city'], f"{m['base_city']}_Airport")),
        None,
    )
    if marker is None:
        return False
    blob = f"{point_a or ''} {point_b or ''}".lower()
    return any(k in blob for k in marker['keywords'])


def resolve_rule(app, vc, ovc, db_city):
    a = (app or '').lower()
    v = (vc or '').lower()
    o = (ovc or '').lower()
    for r_app, r_vc, r_ovc_variants, name, category, cities in BOT_RULES:
        if r_app != a:
            continue
        if r_vc != v:
            continue
        if '*' not in r_ovc_variants and o not in r_ovc_variants:
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


def _build_dropped_combos(tracker, top_n=30):
    """Convierte el Counter en la lista top-N que consume el UI.

    Shape esperada por src/components/upload/BotDbSync.jsx:
        [{ reason, app, vc, ovc, db_city, n }, ...]

    El UI ya renderea esa sección amarilla cuando notes.dropped_combos
    tiene filas, así que el user puede ver QUÉ se está descartando y
    decidir si querer agregarlo a bot_rules. El filtro NO cambia — esto
    es solo visibilidad.
    """
    return [
        {
            'reason':  reason,
            'app':     app,
            'vc':      vc,
            'ovc':     ovc,
            'db_city': db_city,
            'n':       n,
        }
        for (reason, app, vc, ovc, db_city), n in tracker.most_common(top_n)
    ]


def _detectar_escala_sospechosa(accepted, umbral=8.0, min_muestras=3):
    """
    GUARD "escala/moneda rota" (2026-08-29): alerta cuando el precio promedio
    de un competidor difiere >umbral× de la mediana de su propia
    ciudad+categoría dentro del batch.

    Caso real que lo motiva: InDrive en Bogotá/Cali entró meses en una
    escala ~1000× menor que Yango/Uber/Didi de las mismas ciudades (12.73 vs
    17.824 — USD vs pesos, o factor /1000; la fuente nunca lo aclaró). El
    100% de esas filas estaba roto y nadie lo notó hasta que un pct_diff de
    1.499.004% apareció en una MV. Hubo que excluirlas a posteriori
    (mig 223); este guard lo habría mostrado en la PRIMERA corrida.

    Umbral 8×: los spreads legítimos entre competidores rondan 1.1-1.7×
    (peor caso observado: Didi +68% vs Yango); un error de moneda/escala es
    ≥10×. min_muestras=3 evita alertar por una cotización suelta.

    SOLO OBSERVA — nunca descarta: un falso positivo que bloquee data
    legítima es peor que una alerta de más. La fila entra igual; la alerta
    va a bot_sync_log.notes.escala_sospechosa.
    """
    from statistics import median
    por_grupo = {}
    for row in accepted:
        p = row.get('price_without_discount')
        if p is None:
            p = row.get('recommended_price')
        if p is None or p <= 0:
            continue
        clave = (row['city'], row['category'])
        por_grupo.setdefault(clave, {}).setdefault(
            row['competition_name'], []).append(float(p))

    alertas = []
    for (city, cat), comps in por_grupo.items():
        avgs = {c: sum(v) / len(v) for c, v in comps.items()
                if len(v) >= min_muestras}
        if len(avgs) < 2:
            continue  # sin otro competidor no hay contra qué comparar
        med = median(avgs.values())
        if med <= 0:
            continue
        for comp, avg in avgs.items():
            ratio = avg / med
            if ratio > umbral or ratio < 1.0 / umbral:
                # _severidad va SIN redondear: un ratio de 0.0006 (caso
                # InDrive-Colombia real) redondeado a 2 decimales da 0.0 y
                # 1/0 revienta el sort — bug cazado por el test sintético.
                alertas.append({
                    'city':           city,
                    'category':       cat,
                    'competitor':     comp,
                    'avg_competidor': round(avg, 2),
                    'mediana_ciudad': round(med, 2),
                    'ratio':          round(ratio, 4),
                    'n':              len(comps[comp]),
                    '_severidad':     max(ratio, 1.0 / ratio),
                })
    alertas.sort(key=lambda a: a['_severidad'], reverse=True)
    for a in alertas:
        del a['_severidad']
    return alertas[:10]


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
    p.add_argument('--limit', type=int, default=20000, help='Máximo de filas por corrida')
    args = p.parse_args()

    country = os.environ.get('BOT_SYNC_COUNTRY', 'Peru')
    table   = os.environ.get('LOCAL_PG_TABLE',  'quotes_output')
    schema  = os.environ.get('LOCAL_PG_SCHEMA', 'public')
    fq_table = f'"{schema}"."{table}"'

    # Anti-stampede: si corremos en GitHub Actions, agregamos 0-8s de jitter
    # antes de tocar helioho. Como el cron */30 dispara TODAS las jobs al
    # mismo segundo, desincronizar evita que Peru + Colombia + otros
    # tenants choquen en el mismo connection slot.
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        jitter = random.uniform(0, 8)
        print(f"[bot_sync] startup jitter {jitter:.1f}s", flush=True)
        time.sleep(jitter)

    # Cargar BOT_RULES desde Supabase (data-driven multi-país)
    global BOT_RULES, AIRPORT_MARKERS, AIRPORT_ZONES_BY_KEY, MEDIUM_MEANS, KNOWN_CITIES

    # 'medium' significa cosas distintas segun el simulador de cada pais —
    # ver MEDIUM_MEANS_BY_COUNTRY arriba. Se loguea para que quede en el
    # output de la corrida qué interpretación se usó.
    MEDIUM_MEANS = MEDIUM_MEANS_BY_COUNTRY.get(country, 'median')
    print(f"✓ 'medium' se interpreta como '{MEDIUM_MEANS}' para country={country}",
          file=sys.stderr)

    BOT_RULES = load_bot_rules(country)
    if not BOT_RULES:
        print(f"⚠ No hay bot_rules activas para country={country}. "
              f"Verifica que la tabla bot_rules tenga filas para este país.",
              file=sys.stderr)
        sys.exit(3)
    print(f"✓ Loaded {len(BOT_RULES)} bot rules for country={country}", file=sys.stderr)

    # Cargar AIRPORT_MARKERS (mig 78). Si no hay, el sync sigue funcionando
    # como antes — la detección de aeropuerto queda inactiva.
    AIRPORT_MARKERS = load_airport_markers(country)
    AIRPORT_ZONES_BY_KEY = {
        _zone_key(v): v
        for m in AIRPORT_MARKERS
        for v in (m.get('zone_from_value'), m.get('zone_to_value'))
        if v
    }
    print(f"✓ Loaded {len(AIRPORT_MARKERS)} airport markers for country={country} "
          f"(zonas de aeropuerto: {sorted(AIRPORT_ZONES_BY_KEY.values()) or 'ninguna'})",
          file=sys.stderr)

    # Guard "ciudad desconocida" — depende de AIRPORT_MARKERS ya cargados.
    global KNOWN_CITIES
    KNOWN_CITIES = load_known_cities(country)
    if KNOWN_CITIES is None:
        print("⚠ country_config ilegible — guard de ciudad desconocida "
              "desactivado esta corrida", file=sys.stderr)
    else:
        print(f"✓ {len(KNOWN_CITIES)} ciudades reconocidas para "
              f"country={country}", file=sys.stderr)

    # Identificador de la conexión en pg_stat_activity del helioho — clave
    # para debug cuando hay saturación de slots.
    run_id = os.environ.get('GITHUB_RUN_ID', 'local')
    app_name = f"bot_sync_push_{country.lower()}_{run_id}"

    # Budget de retry configurable vía env vars (para tunear sin redeploy).
    # Defaults: 8 retries, base 8s, cap 90s → wait total ~10 min worst case
    # (geometric series 8+16+32+64+90+90+90+90 + jitter 30%).
    # Si helioho recupera en ese rango, la corrida pasa transparente.
    retries = int(os.environ.get('BOT_SYNC_RETRIES', '8'))
    base    = float(os.environ.get('BOT_SYNC_RETRY_BASE', '8.0'))
    cap     = float(os.environ.get('BOT_SYNC_RETRY_CAP', '90.0'))

    @retry_on_pg_unavailable(retries=retries, base=base, cap=cap)
    def _connect():
        return psycopg2.connect(
            host=os.environ['LOCAL_PG_HOST'],
            port=int(os.environ.get('LOCAL_PG_PORT', '5432')),
            dbname=os.environ['LOCAL_PG_DATABASE'],
            user=os.environ['LOCAL_PG_USER'],
            password=os.environ['LOCAL_PG_PASSWORD'],
            sslmode=os.environ.get('LOCAL_PG_SSLMODE', 'require'),  # helioho exige SSL
            connect_timeout=10,
            application_name=app_name,
            # statement_timeout 60s previene queries colgadas que retienen slot.
            # idle_in_transaction 30s mata transacciones abandonadas.
            options="-c statement_timeout=60000 -c idle_in_transaction_session_timeout=30000",
            # TCP keepalives: detecta conexiones zombi (NAT GitHub Actions ↔ helioho).
            keepalives=1,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=3,
        )

    conn = _connect()
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
    stats = {'read': 0, 'dropped': 0, 'outliers': 0, 'airport_sin_zone': 0}
    # Zonas que llegan con valor pero no matchean ninguna zona de aeropuerto
    # ni son TukTuk. Antes se anulaban en silencio y era imposible saber si
    # el simulador no mandó nada o mandó algo mal escrito.
    zonas_desconocidas = Counter()
    # Ciudades que la fuente manda y country_config no lista (guard Chía,
    # 2026-08-29). La fila ENTRA igual — el problema a cazar es la
    # invisibilidad en el dashboard, no el dato en sí.
    ciudades_desconocidas = Counter()
    # Tracker de combos descartados: key=(reason, app, vc, ovc, db_city) → n.
    # Va a notes.dropped_combos al final para que el UI muestre QUÉ se tiró.
    # Reasons posibles:
    #   no_timestamp — sin timestamp_utc (no se puede watermarkear)
    #   incomplete   — sin city normalizable o sin app
    #   no_rule      — (app, vc, ovc, db_city) no matchea ningún bot_rule
    #   tuktuk_route_wrong_category — ruta diseñada para TukTuk
    #                (main_category='tuktuk') pero la cotización resolvió a
    #                categoría de taxi (Economy/Comfort, Uber, Cabify...)
    #   no_price     — ni price_regular_value ni price_discounted_value
    #   outlier      — supera max_price de price_validation_rules (no es dropped en stats pero lo logueamos igual)
    dropped_tracker: Counter = Counter()
    # Inicializada ANTES del try: el camino de error también la referencia
    # (notes.escala_sospechosa) — si el SELECT inicial revienta, un
    # NameError acá enmascararía el error real de la corrida.
    accepted = []

    try:
        # Filtros de la query: status='ok' + business_unit='ridehailing' +
        # solo el país pedido. Los hacemos lower() para tolerar variantes.
        if args.date_from and args.date_to:
            # timestamp_utc >= / < (rango medio-abierto), NUNCA
            # timestamp_utc::date BETWEEN — un cast sobre la columna hace
            # el predicado no-sargable (Postgres no puede usar el índice de
            # timestamp_utc, tiene que evaluar el cast fila por fila).
            # Reproducido en vivo: un backfill de 3 meses con esa forma
            # tiró "canceling statement due to statement timeout" (60s) en
            # helioho — el mismo shared host que el sync incremental usa
            # sin problema porque su WHERE timestamp_utc > %s sí es sargable.
            cur.execute(
                f'SELECT * FROM {fq_table} '
                f'WHERE timestamp_utc >= %s::date '
                f'  AND timestamp_utc < (%s::date + INTERVAL \'1 day\') '
                f'  AND lower(status) = %s '
                f'  AND lower(business_unit) = %s '
                f'  AND country = %s '
                f'ORDER BY timestamp_utc LIMIT %s',
                (args.date_from, args.date_to, 'ok', 'ridehailing', country, args.limit),
            )
        else:
            wm = get_watermark(country)
            # MARGEN DE RE-LECTURA (lookback). No basta con `timestamp_utc >
            # wm`: el watermark avanza al MÁXIMO timestamp_utc leído, pero el
            # bot NO inserta en orden estricto de timestamp. Una ruta lenta de
            # computar (ETA largo → típico en very_long, y rutas de aeropuerto)
            # se inserta en quotes_output DESPUÉS que una ruta corta scrapeada
            # más tarde, pero con un timestamp_utc ANTERIOR. Si el sync corrió
            # entremedio y avanzó el watermark más allá de ese timestamp, la
            # fila lenta cae en `timestamp_utc > wm` = falso y se pierde PARA
            # SIEMPRE — se ve como "very_long/very_short tienen menos data que
            # short/median" aunque el bot sí las produjo.
            #
            # Fix: releer una ventana hacia atrás desde el watermark. Como el
            # insert final es un UPSERT idempotente sobre la natural key (RPC
            # bot_upsert_observations), re-leer filas ya sincronizadas es un
            # no-op — nunca duplica, solo rescata las que llegaron tarde. El
            # watermark nunca retrocede (la fila que lo fijó cae dentro de la
            # ventana y se re-lee), así que no hay riesgo de loop.
            #
            # LOOKBACK_HOURS configurable (default 6h): cubre de sobra el lag
            # de inserción intra-ciclo (minutos), con cron horario. Subirlo si
            # alguna vez se detecta que el bot inserta con >6h de atraso.
            lookback_h = float(os.environ.get('BOT_SYNC_LOOKBACK_HOURS', '6'))
            cur.execute(
                f'SELECT * FROM {fq_table} '
                f'WHERE timestamp_utc > (%s::timestamptz - (%s * INTERVAL \'1 hour\')) '
                f'  AND lower(status) = %s '
                f'  AND lower(business_unit) = %s '
                f'  AND country = %s '
                f'ORDER BY timestamp_utc LIMIT %s',
                (wm, lookback_h, 'ok', 'ridehailing', country, args.limit),
            )
        rows = cur.fetchall()
        stats['read'] = len(rows)

        price_rules = get_price_rules(country)

        accepted = []
        max_created = '1970-01-01T00:00:00+00:00'

        for raw in rows:
            # Lowercase de keys para tracker — coincide con lo que el UI
            # muestra cuando el user va a agregar la combo a bot_rules.
            raw_app = (raw.get('app') or '').strip().lower()
            raw_vc  = (raw.get('vehicle_category') or '').strip().lower()
            raw_ovc = (raw.get('observed_vehicle_category') or '').strip().lower()

            # Watermark: timestamp_utc es la columna de incremento del bot
            ts_utc = raw.get('timestamp_utc')
            if ts_utc is None:
                stats['dropped'] += 1
                dropped_tracker[('no_timestamp', raw_app, raw_vc, raw_ovc, '')] += 1
                continue
            ts_str = ts_utc.isoformat() if hasattr(ts_utc, 'isoformat') else str(ts_utc)
            if ts_str > max_created:
                max_created = ts_str

            db_city = normalize_city(raw.get('city'))
            if not db_city or not raw.get('app'):
                stats['dropped'] += 1
                dropped_tracker[('incomplete', raw_app, raw_vc, raw_ovc,
                                 db_city or (raw.get('city') or ''))] += 1
                continue

            # Direcciones (necesitamos antes de resolve_rule para detectar
            # aeropuerto). Preferimos start_address/end_address (descriptivos
            # con nombre + dirección); fallback a observed_* (geocodificadas).
            point_a = raw.get('start_address') or raw.get('observed_start_address')
            point_b = raw.get('end_address')   or raw.get('observed_end_address')

            # Re-rutear si es viaje de aeropuerto. Devuelve db_city sin
            # cambios si AIRPORT_MARKERS está vacío (backward compat) o si
            # el viaje no tiene rastro de aeropuerto.
            # Pasamos raw.zone para zone-based detection (mig 82) — si el
            # bot etiqueta explícitamente, tiene precedencia sobre keywords.
            if looks_like_airport_without_zone(
                db_city, point_a, point_b, raw.get('zone')
            ):
                stats['airport_sin_zone'] += 1

            db_city = resolve_airport_route(
                db_city, point_a, point_b, raw.get('zone')
            )

            # Guard "ciudad desconocida": alerta, nunca descarta.
            if KNOWN_CITIES is not None and db_city not in KNOWN_CITIES:
                ciudades_desconocidas[db_city] += 1

            # Resolver regla del bot
            name, category = resolve_rule(
                raw.get('app'),
                raw.get('vehicle_category'),
                raw.get('observed_vehicle_category'),
                db_city,
            )
            if not name:
                stats['dropped'] += 1
                dropped_tracker[('no_rule', raw_app, raw_vc, raw_ovc, db_city)] += 1
                continue

            # ── Gate de TukTuk (mig 113, AHORA en el camino real de prod) ─────
            # TukTuk opera intra-distrito (viajes cortos): solo entran filas
            # curadas con main_category='tuktuk' Y zone (distrito). Sin este
            # gate el bot cuela rutas long/very_long irreales que inflan el
            # promedio (~S/6.9 vs ~S/4.4 real) y, al venir sin distrito, no se
            # pueden filtrar por zona. El gate vivía SOLO en la función SQL
            # sync_bot_quotes (mig 113) y en el Edge Function — ninguno corre
            # en producción; el sync real es ESTE script. Mismo predicado que
            # mig 113: el `or None` es obligatorio (main_category o zone vacíos
            # → se descarta; nunca dejar pasar TukTuk sin distrito).
            main_cat_lc = (raw.get('main_category') or '').strip().replace(' ', '').lower() or None
            zone_val = (raw.get('zone') or '').strip() or None
            if (zone_val and category != 'TukTuk'
                    and _zone_key(zone_val) not in AIRPORT_ZONES_BY_KEY):
                zonas_desconocidas[f'{db_city}|{zone_val}'] += 1
            if category == 'TukTuk' and not (main_cat_lc == 'tuktuk' and zone_val):
                stats['dropped'] += 1
                dropped_tracker[('tuktuk_no_zone', raw_app, raw_vc, raw_ovc, db_city)] += 1
                continue

            # ── Gate INVERSO (2026-08-28) ──────────────────────────────────
            # El gate de arriba (mig 113) solo cubre TukTuk sin distrito. El
            # caso inverso —ruta diseñada para TukTuk (main_category='tuktuk',
            # confirmado presente en TODAS las filas de quotes_output de esa
            # ruta, sin importar qué vehículo cotizó el simulador ahí) pero
            # resuelta a categoría de taxi (Economy/Comfort, Comfort+,
            # Premier, XL, Uber, Cabify, Didi, InDrive...)— NUNCA tuvo
            # control. Las distancias/configuración de esa ruta son de
            # mototaxi; el precio de taxi ahí no representa un viaje real.
            #
            # Encontrado en producción (2026-08-28): 58.594 filas
            # contaminadas acumuladas desde el 24-jul, 100% con este origen
            # (bot). Se limpiaron con respaldo (pricing_observations_
            # backup_tuktuk_taxi_20260827) y se blindó v_effective_price del
            # lado de la BD (tabla tuktuk_routes + filtro), pero sin este
            # gate acá la tabla cruda sigue acumulando basura indefinidamente
            # hasta la próxima limpieza manual.
            if main_cat_lc == 'tuktuk' and category != 'TukTuk':
                stats['dropped'] += 1
                dropped_tracker[('tuktuk_route_wrong_category', raw_app, raw_vc, raw_ovc, db_city)] += 1
                continue

            # Precios — el bot usa price_regular_value y price_discounted_value
            rec = raw.get('price_regular_value')      # precio sin descuento
            pwd = raw.get('price_discounted_value')   # precio con descuento (puede ser NULL)
            eff = rec if rec is not None else pwd
            if eff is None:
                stats['dropped'] += 1
                dropped_tracker[('no_price', raw_app, raw_vc, raw_ovc, db_city)] += 1
                continue

            threshold = find_threshold(price_rules, db_city, category, name)
            if threshold is not None and float(eff) > float(threshold):
                stats['outliers'] += 1
                dropped_tracker[('outlier', raw_app, raw_vc, raw_ovc, db_city)] += 1
                continue

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

            # distance_bracket: usa el normalizador robusto que colapsa
            # variantes zone-aware (long_a, airport_short_b, *_zona_sur,
            # *_madrid, etc.) a uno de los 6 canónicos. Si no matchea
            # → None y el trigger intenta computar desde distance_km.
            raw_bracket = raw.get('distance_bracket')
            norm_bracket = normalize_distance_bracket(raw_bracket)

            # distance_km: si el bot lo emite directo úsalo, si no probá
            # con distance_meters/1000. Sin esto, el trigger de la BD no
            # puede computar bracket cuando raw_bracket viene NULL —
            # cae al fallback NULL→'very_long' y rompe el dashboard.
            distance_km = raw.get('distance_km')
            if distance_km is None and raw.get('distance_meters') is not None:
                try:
                    distance_km = float(raw['distance_meters']) / 1000.0
                except (TypeError, ValueError):
                    distance_km = None
            if distance_km is not None:
                try:
                    distance_km = float(distance_km)
                except (TypeError, ValueError):
                    distance_km = None

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
                # zone se PERSISTE en los dos casos que la necesitan (mig 178):
                #   · TukTuk    → distrito (Comas, VES, SJM…) — desde mig 113/135
                #   · Aeropuerto→ 'Airport_A'/'Airport_B' — NUEVO. Antes se
                #     descartaba y el 100% de la data de aeropuerto quedaba con
                #     zone NULL: no se podía filtrar Punto A/B en el dashboard
                #     ni distinguir la fila de una normal. La mig 117 quiso
                #     arreglarlo pero lo hizo sobre sync_bot_quotes, que NO
                #     corre en producción; el camino real es este script.
                # Resto de categorías → None (una zona suelta ahí solo
                # ensuciaría el selector de Zona sin aportar nada).
                # Aeropuerto: se guarda el valor CANÓNICO del marker (no lo que
                # vino crudo), así 'airport_b'/'Airport B'/'AIRPORT_B' quedan
                # todos como 'Airport_B' y el dashboard no los ve como zonas
                # distintas. TukTuk: el distrito tal cual.
                'zone':                   (
                    zone_val if category == 'TukTuk'
                    else AIRPORT_ZONES_BY_KEY.get(_zone_key(zone_val))
                ),
                'distance_km':            distance_km,
                'point_a':                point_a,
                'point_b':                point_b,
                'data_source':            'bot',
            })

        # Dedupe por la misma natural key que usa el ON CONFLICT de la RPC
        # (mig 90/91): country, city, observed_date, observed_time, category,
        # competition_name, distance_bracket, surge, data_source. Sin esto,
        # si dos filas de quotes_output colapsan a la misma key DENTRO del
        # mismo chunk de 500 (ej. dos scrapes casi simultáneos del mismo
        # combo), Postgres tira 21000 "ON CONFLICT DO UPDATE command cannot
        # affect row a second time" y el chunk entero falla — visto en vivo
        # haciendo un backfill ancho (watermark reseteado varios meses atrás)
        # para Nepal. Nos quedamos con la última ocurrencia (mismo criterio
        # de "última escritura gana" que ya aplica la RPC entre corridas).
        deduped = {}
        for row in accepted:
            key = (
                row['country'], row['city'], row['observed_date'], row['observed_time'],
                row['category'], row['competition_name'], row['distance_bracket'],
                row['surge'], row['data_source'],
            )
            deduped[key] = row
        n_dupes = len(accepted) - len(deduped)
        if n_dupes:
            print(f'[bot_sync] deduped {n_dupes} rows with colliding natural key', flush=True)
        accepted = list(deduped.values())

        # Insert en lotes — UPSERT idempotente vía RPC `bot_upsert_observations`
        # (mig 91). Por qué RPC y no POST directo con ?on_conflict=:
        #   PostgreSQL exige que para inferir un UNIQUE INDEX **parcial** desde
        #   ON CONFLICT, la sentencia incluya el predicado WHERE del índice.
        #   PostgREST NO permite enviar ese predicado vía `?on_conflict=` — sólo
        #   manda la lista de columnas. Resultado: 42P10 "no unique constraint
        #   matching the ON CONFLICT specification". La RPC hace el
        #   `ON CONFLICT (...) WHERE data_source='bot' DO UPDATE` explícito.
        #   Ver supabase/91_bot_upsert_observations_rpc.sql para el contexto.
        BATCH = 500
        for i in range(0, len(accepted), BATCH):
            chunk = accepted[i:i + BATCH]
            res = requests.post(
                f'{SUPABASE_URL}/rest/v1/rpc/bot_upsert_observations',
                headers=sb_headers({'Prefer': 'return=minimal'}),
                json={'p_rows': chunk},
                timeout=60,
            )
            if not res.ok:
                raise RuntimeError(f'Insert chunk {i}: HTTP {res.status_code} → {res.text[:300]}')
            inserted += len(chunk)

        if not (args.date_from and args.date_to) and stats['read'] > 0:
            upsert_watermark(country, max_created)

        notes['dropped_combos'] = _build_dropped_combos(dropped_tracker)
        # mig 178: filas con pinta de aeropuerto que llegaron sin zona.
        # >0 significa Excel mal etiquetado — esas filas se quedaron en la
        # ciudad base mezcladas con el CI normal.
        notes['airport_sin_zone'] = stats['airport_sin_zone']
        # Zonas con valor que no se reconocieron (top 20). Si aparece algo acá,
        # el simulador está mandando una zona que el ruteo no entiende.
        notes['zonas_desconocidas'] = [
            {'zona': k, 'n': n} for k, n in zonas_desconocidas.most_common(20)
        ]
        # Guard Chía (2026-08-29): ciudades que la fuente manda y
        # country_config no lista. La data ENTRÓ igual — pero es invisible
        # en el dashboard hasta que alguien la agregue a country_config.
        notes['ciudades_desconocidas'] = [
            {'ciudad': k, 'n': n}
            for k, n in ciudades_desconocidas.most_common(10)
        ]
        # Guard InDrive-Colombia (2026-08-29): competidores cuyo precio
        # promedio difiere >8x de la mediana de su ciudad+categoría en este
        # batch — patrón típico de moneda/escala rota en la fuente.
        notes['escala_sospechosa'] = _detectar_escala_sospechosa(accepted)
        update_log(log_id,
                   status='ok',
                   finished_at=dt.datetime.utcnow().isoformat() + '+00:00',
                   read_count=stats['read'],
                   inserted_count=inserted,
                   dropped_count=stats['dropped'],
                   outlier_count=stats['outliers'],
                   notes=notes)
        print(f'OK · read={stats["read"]} inserted={inserted} '
              f'dropped={stats["dropped"]} outliers={stats["outliers"]} '
              f'watermark={max_created}')

    except Exception as e:
        notes['dropped_combos'] = _build_dropped_combos(dropped_tracker)
        # mig 178: filas con pinta de aeropuerto que llegaron sin zona.
        # >0 significa Excel mal etiquetado — esas filas se quedaron en la
        # ciudad base mezcladas con el CI normal.
        notes['airport_sin_zone'] = stats['airport_sin_zone']
        # Zonas con valor que no se reconocieron (top 20). Si aparece algo acá,
        # el simulador está mandando una zona que el ruteo no entiende.
        notes['zonas_desconocidas'] = [
            {'zona': k, 'n': n} for k, n in zonas_desconocidas.most_common(20)
        ]
        # Guard Chía (2026-08-29): ciudades que la fuente manda y
        # country_config no lista. La data ENTRÓ igual — pero es invisible
        # en el dashboard hasta que alguien la agregue a country_config.
        notes['ciudades_desconocidas'] = [
            {'ciudad': k, 'n': n}
            for k, n in ciudades_desconocidas.most_common(10)
        ]
        # Guard InDrive-Colombia (2026-08-29): competidores cuyo precio
        # promedio difiere >8x de la mediana de su ciudad+categoría en este
        # batch — patrón típico de moneda/escala rota en la fuente.
        notes['escala_sospechosa'] = _detectar_escala_sospechosa(accepted)
        update_log(log_id,
                   status='error',
                   finished_at=dt.datetime.utcnow().isoformat() + '+00:00',
                   error_msg=str(e),
                   read_count=stats['read'],
                   inserted_count=inserted,
                   dropped_count=stats['dropped'],
                   outlier_count=stats['outliers'],
                   notes=notes)
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


def _normalize_url(u):
    u = u.strip().rstrip('/')
    if not u.startswith(('http://', 'https://')):
        u = 'https://' + u
    return u


SUPABASE_URL = _normalize_url(_required('SUPABASE_URL'))
SUPABASE_KEY = _required('SUPABASE_SERVICE_ROLE_KEY').strip()

if __name__ == '__main__':
    main()

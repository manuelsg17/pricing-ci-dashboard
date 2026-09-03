"""
bot_sync_core.py — funciones PURAS del pipeline del bot, sin dependencias
externas (ni psycopg2 ni requests).

POR QUÉ EXISTE (Fase 2 de la revisión de arquitectura, 2026-09-03):
    bot_sync_push.py es un script de ~1.200 líneas donde la lógica de
    normalización/matching/guards vivía mezclada con la conexión a helioho y
    los POST a Supabase. Consecuencias reales:
      · Cero tests sobre el código de producción: importar el módulo exigía
        psycopg2 y variables de entorno, así que nadie lo testeaba (los tests
        JS cubren un espejo, no este archivo).
      · sb_headers() y las opciones de conexión estaban copiadas a mano en
        ops_alerts_sync.py — dos copias que se despegan en silencio.
      · La lista de errores transitorios (SLOT_EXHAUSTED_MARKERS) creció dos
        veces el mismo día por casos que un test habría cazado antes.

    Todo lo que hay acá se puede importar y probar con `python3 -m unittest`
    sin red ni base. bot_sync_push.py y ops_alerts_sync.py importan de acá y
    conservan wrappers finos para no cambiar sus call sites.
"""
from __future__ import annotations
import re
from collections import Counter
from statistics import median

# ── Errores transitorios de helioho (shared hosting) ────────────────────
# Solo estos mensajes disparan el retry con backoff. Un error de credencial
# ("password authentication FAILED") o de config NO está acá a propósito:
# reintentar ahí solo pierde tiempo.
#
# Historial (todo cazado en producción):
#   · "remaining connection slots" / "too many connections": agotamiento de
#     slots del shared host (incidente original, max-parallel=1).
#   · "timeout expired": TCP connect sin respuesta (2026-09-03 a.m.).
#   · "authentication did not complete": el pooler (pgbouncer) tan saturado
#     que no termina el handshake de login — NO es credencial mala, es
#     "did not COMPLETE", no "FAILED" (2026-09-03 p.m.).
#   · "canceling statement due to statement timeout": la consulta sí corrió
#     pero helioho no la terminó en 60 s. Retryable desde este cambio.
TRANSIENT_PG_MARKERS = (
    "remaining connection slots",
    "too many connections",
    "could not connect",
    "server closed the connection",
    "timeout expired",
    "authentication did not complete",
    "canceling statement due to statement timeout",
)


def is_transient_pg_error(message: str) -> bool:
    """True si el mensaje de psycopg2 corresponde a un fallo transitorio."""
    m = (message or '').lower()
    return any(marker in m for marker in TRANSIENT_PG_MARKERS)


# ── Normalización de distance_bracket ───────────────────────────────────
# El bot manda variantes zone-aware (long_a, airport_short_b,
# median_zona_sur, *_madrid…). Todo tiene que colapsar a uno de los 6
# canónicos o a None.
CANONICAL_BRACKETS = frozenset(
    {'very_short', 'short', 'median', 'average', 'long', 'very_long'})
_SATELLITE_RE = re.compile(r'_(madrid|funza|mosquera|cota|chia|soacha|cajica|tenjo|sopo|sibate)$')
_ZONE_RE = re.compile(r'_(zona_(sur|norte|centro|este|oeste)|sur|norte|centro|este|oeste)$')
_AB_RE = re.compile(r'_(a|b)$')

# Qué bracket significa 'medium' según el país. NO es un typo universal: es
# nomenclatura de cada simulador. Perú → 'average' (confirmado por el dueño
# del simulador, 2026-07-31). Resto → 'median' (histórico). Colombia muestra
# la misma forma sospechosa pero nadie lo confirmó: no se toca a ciegas.
MEDIUM_MEANS_BY_COUNTRY = {'Peru': 'average'}


def medium_means_for(country: str | None) -> str:
    return MEDIUM_MEANS_BY_COUNTRY.get(country or '', 'median')


def normalize_distance_bracket(raw, medium_means: str = 'median'):
    """Mapea variantes zone-aware del bot al canónico, o None."""
    if not raw:
        return None
    s = re.sub(r'[\s\-]+', '_', str(raw).lower())
    s = re.sub(r'^airport_', '', s)
    s = _SATELLITE_RE.sub('', s)
    s = _ZONE_RE.sub('', s)
    s = _AB_RE.sub('', s)
    if s == 'medium':
        s = medium_means
    if s == 'very short':
        s = 'very_short'
    if s == 'very long':
        s = 'very_long'
    return s if s in CANONICAL_BRACKETS else None


# ── Reglas del bot (bot_rules) ──────────────────────────────────────────
def build_rules(rows):
    """
    Convierte las filas crudas de bot_rules en la lista de tuplas que consume
    resolve_rule(). `ovc` admite variantes separadas por coma ("viaje, viajes
    económicos, estándar") — se guarda como frozenset en minúsculas para no
    repetir el split en cada fila entrante.
    """
    rules = []
    for r in rows or []:
        cities = set(r.get('cities') or [])
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


def resolve_rule(rules, app, vc, ovc, db_city):
    """(competition_name, category) de la primera regla que matchea, o (None, None).

    Matchea por app + vc exactos, ovc dentro de las variantes (o '*'), y
    ciudad dentro de `cities` si la regla las restringe.
    """
    a = (app or '').lower()
    v = (vc or '').lower()
    o = (ovc or '').lower()
    for r_app, r_vc, r_ovc_variants, name, category, cities in rules:
        if r_app != a or r_vc != v:
            continue
        if '*' not in r_ovc_variants and o not in r_ovc_variants:
            continue
        if cities and db_city not in cities:
            continue
        return name, category
    return None, None


# ── Umbral de outliers (price_validation_rules) ─────────────────────────
def find_threshold(rules, city, category, comp):
    """Cascada: (city, cat, comp) → (city, cat, 'all') → (city, 'all', 'all')."""
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


# ── Observabilidad ──────────────────────────────────────────────────────
def build_dropped_combos(tracker: Counter, top_n: int = 30):
    """Counter[(reason, app, vc, ovc, db_city)] → lista top-N para la UI
    (shape que consume src/components/upload/BotDbSync.jsx)."""
    return [
        {'reason': reason, 'app': app, 'vc': vc, 'ovc': ovc, 'db_city': db_city, 'n': n}
        for (reason, app, vc, ovc, db_city), n in tracker.most_common(top_n)
    ]


def detectar_escala_sospechosa(accepted, umbral: float = 8.0, min_muestras: int = 3):
    """
    GUARD "escala/moneda rota": alerta cuando el precio promedio de un
    competidor difiere >umbral× de la mediana de su ciudad+categoría en el
    batch. Caso real: InDrive Bogotá/Cali entró meses ~1000× por debajo del
    resto (USD vs pesos) y nadie lo notó hasta un pct_diff de 1.499.004%.

    SOLO OBSERVA — nunca descarta. Umbral 8×: los spreads legítimos rondan
    1.1-1.7×; un error de moneda es ≥10×. min_muestras=3 evita alertar por
    una cotización suelta.
    """
    por_grupo = {}
    for row in accepted:
        p = row.get('price_without_discount')
        if p is None:
            p = row.get('recommended_price')
        if p is None or p <= 0:
            continue
        clave = (row['city'], row['category'])
        por_grupo.setdefault(clave, {}).setdefault(row['competition_name'], []).append(float(p))

    alertas = []
    for (city, cat), comps in por_grupo.items():
        avgs = {c: sum(v) / len(v) for c, v in comps.items() if len(v) >= min_muestras}
        if len(avgs) < 2:
            continue
        med = median(avgs.values())
        if med <= 0:
            continue
        for comp, avg in avgs.items():
            ratio = avg / med
            if ratio > umbral or ratio < 1.0 / umbral:
                # _severidad SIN redondear: un ratio de 0.0006 redondeado a
                # 2 decimales da 0.0 y 1/0 revienta el sort.
                alertas.append({
                    'city': city, 'category': cat, 'competitor': comp,
                    'avg_competidor': round(avg, 2), 'mediana_ciudad': round(med, 2),
                    'ratio': round(ratio, 4), 'n': len(comps[comp]),
                    '_severidad': max(ratio, 1.0 / ratio),
                })
    alertas.sort(key=lambda a: a['_severidad'], reverse=True)
    for a in alertas:
        del a['_severidad']
    return alertas[:10]


# ── Config compartida por los dos scripts ───────────────────────────────
def sb_headers(service_key: str, extra=None):
    h = {
        'apikey': service_key,
        'Authorization': f'Bearer {service_key}',
        'Content-Type': 'application/json',
    }
    if extra:
        h.update(extra)
    return h


def pg_connect_kwargs(env, app_name: str):
    """
    Opciones de conexión a helioho, ÚNICA fuente de verdad para los dos
    scripts. statement_timeout 60 s evita consultas colgadas reteniendo un
    slot; idle_in_transaction 30 s mata transacciones abandonadas; los
    keepalives detectan conexiones zombi (NAT de GitHub Actions ↔ helioho).
    """
    return dict(
        host=env['LOCAL_PG_HOST'],
        port=int(env.get('LOCAL_PG_PORT', '5432')),
        dbname=env['LOCAL_PG_DATABASE'],
        user=env['LOCAL_PG_USER'],
        password=env['LOCAL_PG_PASSWORD'],
        sslmode=env.get('LOCAL_PG_SSLMODE', 'require'),  # helioho exige SSL
        connect_timeout=10,
        application_name=app_name,
        options='-c statement_timeout=60000 -c idle_in_transaction_session_timeout=30000',
        keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3,
    )

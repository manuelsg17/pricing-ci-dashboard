#!/usr/bin/env python3
"""
ops_alerts_sync.py — espeja ridehailing.ops_alerts (base del scraper) hacia
public.ops_alerts en Supabase, para el panel de alertas operativas del
Dashboard (mig 227).

POR QUÉ ESTE SCRIPT EXISTE (y no una foreign table):
    Supabase NO puede conectarse a fudobi.helioho.st — helioho bloquea sus
    IPs. Verificado el 2026-08-29 sobre la foreign table ya existente
    `bot_quotes_remote`: `SELECT 1 ... LIMIT 1` cuelga a los 25s/75s sin
    devolver siquiera un error de conexión. Es la misma razón por la que
    existe el workflow bot-sync.yml: GitHub Actions sí llega.

POR QUÉ ES UN SCRIPT APARTE Y NO UN PASO DE bot_sync_push.py:
    ops_alerts es GLOBAL (un watchdog), no por país. bot_sync_push corre una
    vez POR PAÍS (matriz de 5), así que meterlo ahí abriría 5 conexiones para
    traer exactamente las mismas filas. Además mantiene el camino crítico del
    sync de precios sin cambios.

REGLA CLAVE — la resolución es LOCAL:
    `resolved` en Supabase la escribe el usuario desde el panel (vía la RPC
    resolve_ops_alert). Este script NUNCA baja un `resolved` local de true a
    false: manda `resolved = remoto OR local`. Sin eso, la primera corrida
    después de que alguien resuelve una alerta la haría reaparecer.
    Tampoco toca resolved_at/resolved_by (no van en el payload, así que el
    UPDATE del upsert no los pisa).
"""
import os
import sys
import json
import argparse
import datetime as dt

import psycopg2
import psycopg2.extras
import requests


def _required(var):
    v = os.environ.get(var)
    if not v:
        print(f'✗ Falta la variable de entorno {var}', file=sys.stderr)
        sys.exit(2)
    return v


def _normalize_url(u):
    return u.rstrip('/')


SUPABASE_URL = _normalize_url(_required('SUPABASE_URL'))
SUPABASE_KEY = _required('SUPABASE_SERVICE_ROLE_KEY').strip()

REMOTE_SCHEMA = os.environ.get('OPS_ALERTS_SCHEMA', 'ridehailing')
REMOTE_TABLE = os.environ.get('OPS_ALERTS_TABLE', 'ops_alerts')


def sb_headers(extra=None):
    h = {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
    }
    if extra:
        h.update(extra)
    return h


def fetch_locally_resolved_ids():
    """Ids ya resueltos en Supabase. Se usan para no revivir una alerta que
    alguien cerró desde el panel (ver 'REGLA CLAVE' arriba)."""
    ids = set()
    step = 1000
    offset = 0
    while True:
        res = requests.get(
            f'{SUPABASE_URL}/rest/v1/ops_alerts',
            headers=sb_headers({'Range-Unit': 'items',
                                'Range': f'{offset}-{offset + step - 1}'}),
            params={'select': 'id', 'resolved': 'eq.true'},
            timeout=30,
        )
        if not res.ok:
            raise RuntimeError(
                f'No pude leer los resueltos locales: HTTP {res.status_code} → {res.text[:300]}')
        rows = res.json()
        ids.update(r['id'] for r in rows)
        if len(rows) < step:
            break
        offset += step
    return ids


def main():
    p = argparse.ArgumentParser(description='Sync de alertas operativas → Supabase')
    p.add_argument('--probe', action='store_true',
                   help='Solo listar columnas y filas de ejemplo de la tabla remota')
    p.add_argument('--limit', type=int, default=2000,
                   help='Máximo de alertas a traer por corrida (más nuevas primero)')
    args = p.parse_args()

    fq = f'"{REMOTE_SCHEMA}"."{REMOTE_TABLE}"'

    conn = psycopg2.connect(
        host=os.environ['LOCAL_PG_HOST'],
        port=int(os.environ.get('LOCAL_PG_PORT', '5432')),
        dbname=os.environ['LOCAL_PG_DATABASE'],
        user=os.environ['LOCAL_PG_USER'],
        password=os.environ['LOCAL_PG_PASSWORD'],
        sslmode=os.environ.get('LOCAL_PG_SSLMODE', 'require'),
        connect_timeout=10,
        application_name=f"ops_alerts_sync_{os.environ.get('GITHUB_RUN_ID', 'local')}",
        options='-c statement_timeout=60000 -c idle_in_transaction_session_timeout=30000',
        keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3,
    )
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    if args.probe:
        cur.execute("""
            SELECT column_name, data_type
              FROM information_schema.columns
             WHERE table_schema = %s AND table_name = %s
             ORDER BY ordinal_position
        """, (REMOTE_SCHEMA, REMOTE_TABLE))
        print('-- COLUMNS --')
        print(json.dumps(cur.fetchall(), indent=2, default=str))
        cur.execute(f'SELECT * FROM {fq} ORDER BY id DESC LIMIT 5')
        print('\n-- SAMPLE --')
        print(json.dumps(cur.fetchall(), indent=2, default=str))
        cur.close(); conn.close()
        return

    # Las más nuevas primero: si algún día la tabla crece más que --limit,
    # preferimos perder las viejas (probablemente ya resueltas) antes que las
    # recientes, que son las que el panel necesita mostrar.
    cur.execute(f"""
        SELECT id, created_at_utc, source, severity, message, resolved
          FROM {fq}
         ORDER BY id DESC
         LIMIT %s
    """, (args.limit,))
    remote_rows = cur.fetchall()

    cur.execute(f'SELECT count(*) AS n FROM {fq}')
    remote_total = cur.fetchone()['n']
    cur.close(); conn.close()

    # Nunca truncar en silencio (CLAUDE.md §5): si la tabla remota tiene más
    # filas que el límite, tiene que quedar dicho en el log de la corrida.
    if remote_total > len(remote_rows):
        print(f'⚠ La tabla remota tiene {remote_total} alertas y el límite es '
              f'{args.limit}: quedaron {remote_total - len(remote_rows)} sin '
              f'sincronizar (las más viejas). Subí --limit si hace falta.',
              file=sys.stderr)

    already_resolved = fetch_locally_resolved_ids()

    payload = []
    skipped_sin_fecha = 0
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    for r in remote_rows:
        # created_at_utc es NOT NULL en el espejo local; una fila remota sin
        # fecha reventaría el upsert entero, así que se descarta y se cuenta.
        if r.get('created_at_utc') is None:
            skipped_sin_fecha += 1
            continue
        created = r['created_at_utc']
        payload.append({
            'id': r['id'],
            'created_at_utc': created.isoformat() if hasattr(created, 'isoformat') else str(created),
            'source': r.get('source'),
            # severity NOT NULL local; si el watchdog manda null, lo marcamos
            # explícito en vez de perder la alerta.
            'severity': r.get('severity') or 'unknown',
            'message': r.get('message'),
            'resolved': bool(r.get('resolved')) or (r['id'] in already_resolved),
            'synced_at': now_iso,
        })

    if skipped_sin_fecha:
        print(f'⚠ {skipped_sin_fecha} alertas remotas sin created_at_utc: descartadas.',
              file=sys.stderr)

    upserted = 0
    BATCH = 500
    for i in range(0, len(payload), BATCH):
        chunk = payload[i:i + BATCH]
        res = requests.post(
            f'{SUPABASE_URL}/rest/v1/ops_alerts',
            headers=sb_headers({
                'Prefer': 'resolution=merge-duplicates,return=minimal',
            }),
            params={'on_conflict': 'id'},
            json=chunk,
            timeout=60,
        )
        if not res.ok:
            raise RuntimeError(
                f'Upsert chunk {i}: HTTP {res.status_code} → {res.text[:300]}')
        upserted += len(chunk)

    # ── Supersede: el ciclo más nuevo REEMPLAZA a los anteriores ─────────
    # El watchdog re-reporta los problemas VIGENTES en cada ciclo (verificado
    # en prod 2026-08-29: "emulator con 173MB/178MB/179MB/182MB libres" son la
    # MISMA condición medida en 4 ciclos distintos). Sin esto, cada ciclo
    # suma una alerta casi idéntica y el panel se llena de duplicados
    # (pedido del user: "que se reemplacen, no se acumulen").
    #
    # Regla: por cada source, toda alerta ABIERTA más vieja que el último
    # ciclo se auto-resuelve. "Mismo ciclo" se define con una tolerancia de
    # 5 minutos porque un ciclo inserta sus alertas con timestamps levemente
    # distintos (observado en prod: 16s de dispersión entre 8 alertas del
    # ciclo de las 12:57) — sin la tolerancia, la última hermana del ciclo
    # mataría a las anteriores. Los ciclos reales van ≥30 min aparte.
    #
    # Solo toca filas con resolved=false (el filtro del PATCH), así que jamás
    # pisa una resolución hecha por un usuario desde el panel.
    #
    # Limitación conocida y aceptada: si el watchdog pasa a estar 100% sano
    # (deja de reportar), el último ciclo queda abierto hasta que alguien lo
    # resuelva a mano — desde este lado no se puede distinguir "silencio
    # porque está todo bien" de "el watchdog murió".
    TOLERANCIA_MISMO_CICLO = dt.timedelta(minutes=5)
    ultimo_ciclo = {}
    for r in remote_rows:
        ts = r.get('created_at_utc')
        if ts is None:
            continue
        src = r.get('source') or ''
        if src not in ultimo_ciclo or ts > ultimo_ciclo[src]:
            ultimo_ciclo[src] = ts

    reemplazadas = 0
    for src, ts in ultimo_ciclo.items():
        corte = (ts - TOLERANCIA_MISMO_CICLO).isoformat()
        res = requests.patch(
            f'{SUPABASE_URL}/rest/v1/ops_alerts',
            headers=sb_headers({'Prefer': 'return=representation'}),
            params={
                'resolved': 'eq.false',
                'source': f'eq.{src}',
                'created_at_utc': f'lt.{corte}',
                'select': 'id',
            },
            json={
                'resolved': True,
                'resolved_at': now_iso,
                'resolved_by': 'watchdog (reemplazada por un ciclo más nuevo)',
            },
            timeout=30,
        )
        if not res.ok:
            raise RuntimeError(
                f'Supersede source={src}: HTTP {res.status_code} → {res.text[:300]}')
        reemplazadas += len(res.json())

    # Conteo final desde la base (no desde el payload): el supersede de arriba
    # acaba de cerrar filas, así que el payload ya no refleja la verdad.
    res = requests.get(
        f'{SUPABASE_URL}/rest/v1/ops_alerts',
        headers=sb_headers(),
        params={'select': 'severity', 'resolved': 'eq.false'},
        timeout=30,
    )
    finales = res.json() if res.ok else []
    abiertas = len(finales)
    problems = sum(1 for r in finales if r.get('severity') == 'problem')
    print(f'✓ ops_alerts: {upserted} sincronizadas '
          f'({abiertas} abiertas, {problems} de severidad problem, '
          f'{reemplazadas} reemplazadas por un ciclo más nuevo). '
          f'Remotas totales: {remote_total}.')


if __name__ == '__main__':
    main()

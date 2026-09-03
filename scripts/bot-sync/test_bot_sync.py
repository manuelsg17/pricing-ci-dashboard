#!/usr/bin/env python3
"""
Tests del pipeline del bot — corren sin red, sin base y sin psycopg2:
    python3 scripts/bot-sync/test_bot_sync.py

Cubren el código de PRODUCCIÓN (bot_sync_core.py, importado por
bot_sync_push.py), no un espejo. Cada caso proviene de un bug real o de un
mensaje real visto en producción — ver comentarios.
"""
import os
import sys
import unittest
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot_sync_core as core  # noqa: E402


class TransientErrors(unittest.TestCase):
    def test_reintenta_los_tres_mensajes_reales_de_helioho(self):
        # Los tres aparecieron en producción el 2026-09-03; los dos últimos
        # no estaban cubiertos y el sync fallaba sin reintentar.
        for msg in (
            'connection to server at "x" (44.216.29.125), port 5432 failed: timeout expired',
            'FATAL:  Failed to connect to database: authentication did not complete within 15000ms',
            'ERROR: canceling statement due to statement timeout',
            'FATAL: remaining connection slots are reserved for non-replication superuser connections',
        ):
            self.assertTrue(core.is_transient_pg_error(msg), msg)

    def test_no_reintenta_errores_permanentes(self):
        # Credencial mala o config rota: reintentar solo pierde tiempo.
        for msg in (
            'FATAL: password authentication failed for user "x"',
            'FATAL: authentication method not supported',
            'FATAL: database "wrong_db" does not exist',
            '',
        ):
            self.assertFalse(core.is_transient_pg_error(msg), msg)


class Brackets(unittest.TestCase):
    def test_variantes_zone_aware_colapsan_al_canonico(self):
        casos = {
            'Short': 'short', 'very long': 'very_long', 'Very-Short': 'very_short',
            'long_a': 'long', 'airport_short_b': 'short', 'median_zona_sur': 'median',
            'short_madrid': 'short', 'average_norte': 'average',
        }
        for raw, esperado in casos.items():
            self.assertEqual(core.normalize_distance_bracket(raw), esperado, raw)

    def test_medium_depende_del_pais(self):
        # Perú: 'Medium' del simulador significa `average` (confirmado por su
        # dueño); el resto conserva `median`.
        self.assertEqual(core.normalize_distance_bracket('Medium', core.medium_means_for('Peru')), 'average')
        self.assertEqual(core.normalize_distance_bracket('Medium', core.medium_means_for('Colombia')), 'median')
        self.assertEqual(core.normalize_distance_bracket('Medium'), 'median')

    def test_basura_devuelve_none(self):
        for raw in (None, '', 'xxl', 'shortish', 'zona_sur'):
            self.assertIsNone(core.normalize_distance_bracket(raw), raw)


class Reglas(unittest.TestCase):
    RULES = core.build_rules([
        {'app': 'indrive', 'vc': 'economy', 'ovc': 'viaje, viajes económicos, estándar',
         'competition_name': 'InDrive', 'category': 'Economy/Comfort', 'cities': []},
        {'app': 'indrive', 'vc': 'comfort_plus', 'ovc': 'viaje',
         'competition_name': 'InDrive', 'category': 'Viaje', 'cities': []},
        {'app': 'indrive', 'vc': 'wait_save', 'ovc': 'espera y ahorra',
         'competition_name': 'InDrive', 'category': 'Espera y Ahorra', 'cities': []},
        {'app': 'uber', 'vc': 'tuktuk', 'ovc': 'mototaxi',
         'competition_name': 'Uber', 'category': 'TukTuk', 'cities': ['Lima']},
        {'app': 'yango_api', 'vc': 'economy', 'ovc': '*',
         'competition_name': 'Yango', 'category': 'Economy/Comfort', 'cities': []},
    ])

    def test_matchea_por_app_vc_y_variante_ovc(self):
        self.assertEqual(core.resolve_rule(self.RULES, 'InDrive', 'Economy', 'Viajes Económicos', 'Lima'),
                         ('InDrive', 'Economy/Comfort'))

    def test_mismo_ovc_con_vc_distinto_es_otra_regla(self):
        # Bug real (mig 228): "viaje" con vc=comfort_plus se descartaba porque
        # la regla existente tenía vc=economy. Son reglas distintas.
        self.assertEqual(core.resolve_rule(self.RULES, 'indrive', 'comfort_plus', 'viaje', 'Arequipa'),
                         ('InDrive', 'Viaje'))
        self.assertEqual(core.resolve_rule(self.RULES, 'indrive', 'wait_save', 'Espera Y Ahorra', 'Arequipa'),
                         ('InDrive', 'Espera y Ahorra'))

    def test_cities_restringe_y_wildcard_no(self):
        self.assertEqual(core.resolve_rule(self.RULES, 'uber', 'tuktuk', 'mototaxi', 'Lima'), ('Uber', 'TukTuk'))
        self.assertEqual(core.resolve_rule(self.RULES, 'uber', 'tuktuk', 'mototaxi', 'Trujillo'), (None, None))
        self.assertEqual(core.resolve_rule(self.RULES, 'yango_api', 'economy', 'lo que sea', 'X'),
                         ('Yango', 'Economy/Comfort'))

    def test_sin_match_ni_cruce_de_apps(self):
        self.assertEqual(core.resolve_rule(self.RULES, 'didi', 'wait_save', 'espera y ahorra', 'Lima'), (None, None))
        self.assertEqual(core.resolve_rule([], 'x', 'y', 'z', 'w'), (None, None))


class Umbrales(unittest.TestCase):
    RULES = [
        {'city': 'Lima', 'category': 'Economy/Comfort', 'competition': 'Uber', 'max_price': 100},
        {'city': 'Lima', 'category': 'Economy/Comfort', 'competition': 'all', 'max_price': 80},
        {'city': 'Lima', 'category': 'all', 'competition': 'all', 'max_price': 60},
    ]

    def test_cascada_de_especifico_a_generico(self):
        self.assertEqual(core.find_threshold(self.RULES, 'Lima', 'Economy/Comfort', 'Uber'), 100)
        self.assertEqual(core.find_threshold(self.RULES, 'Lima', 'Economy/Comfort', 'Didi'), 80)
        self.assertEqual(core.find_threshold(self.RULES, 'Lima', 'XL', 'Didi'), 60)
        self.assertIsNone(core.find_threshold(self.RULES, 'Trujillo', 'XL', 'Didi'))


class EscalaSospechosa(unittest.TestCase):
    @staticmethod
    def _rows(city, comp, precios, cat='Economy/Comfort'):
        return [{'city': city, 'category': cat, 'competition_name': comp,
                 'price_without_discount': p} for p in precios]

    def test_detecta_moneda_rota_sin_reventar_por_ratio_minusculo(self):
        # Caso InDrive-Colombia real: ~1000× por debajo. Ratio ≈ 0.0007 — un
        # round(…, 2) previo daba 0.0 y 1/0 reventaba el sort.
        rows = (self._rows('Bogota', 'Yango', [17000, 18000, 17500])
                + self._rows('Bogota', 'Uber', [16000, 17000, 16500])
                + self._rows('Bogota', 'InDrive', [12.5, 13.0, 12.7]))
        alertas = core.detectar_escala_sospechosa(rows)
        self.assertEqual([a['competitor'] for a in alertas], ['InDrive'])
        self.assertLess(alertas[0]['ratio'], 0.01)

    def test_spread_legitimo_no_alerta_y_pocas_muestras_se_ignoran(self):
        rows = (self._rows('Lima', 'Yango', [10, 11, 12])
                + self._rows('Lima', 'Didi', [16, 17, 18])          # +60%: legítimo
                + self._rows('Lima', 'Cabify', [900]))              # 1 muestra: no cuenta
        self.assertEqual(core.detectar_escala_sospechosa(rows), [])

    def test_sin_segundo_competidor_no_hay_comparacion(self):
        self.assertEqual(core.detectar_escala_sospechosa(self._rows('Lima', 'Yango', [1, 2, 3])), [])


class Observabilidad(unittest.TestCase):
    def test_dropped_combos_top_n_con_shape_de_la_ui(self):
        t = Counter({('no_rule', 'uber', 'pet', 'uber pet', 'Lima'): 42,
                     ('outlier', 'didi', 'economy', 'express', 'Arequipa'): 1})
        out = core.build_dropped_combos(t, top_n=1)
        self.assertEqual(out, [{'reason': 'no_rule', 'app': 'uber', 'vc': 'pet',
                                'ovc': 'uber pet', 'db_city': 'Lima', 'n': 42}])


class ConfigCompartida(unittest.TestCase):
    def test_headers_y_connect_kwargs(self):
        h = core.sb_headers('KEY', {'Prefer': 'return=minimal'})
        self.assertEqual(h['Authorization'], 'Bearer KEY')
        self.assertEqual(h['Prefer'], 'return=minimal')
        kw = core.pg_connect_kwargs(
            {'LOCAL_PG_HOST': 'h', 'LOCAL_PG_DATABASE': 'd', 'LOCAL_PG_USER': 'u', 'LOCAL_PG_PASSWORD': 'p'},
            'app')
        self.assertEqual((kw['port'], kw['sslmode'], kw['connect_timeout']), (5432, 'require', 10))
        self.assertIn('statement_timeout=60000', kw['options'])


if __name__ == '__main__':
    unittest.main(verbosity=1)

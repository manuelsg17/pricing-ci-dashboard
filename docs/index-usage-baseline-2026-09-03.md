# Línea base de uso de índices — 2026-09-03

Tomada con `scripts/check-index-usage.sql` contra producción (`boewlfpbkegthrpcksbv`).
Ventana de estadísticas: desde el reset del 2026-07-29 (≈37 días).

**Decisión pendiente (revisión de arquitectura, punto #5):** volver a medir el
**2026-10-03** y dropear los índices cuyo `idx_scan` no haya despegado. La
partición que importa es la del **mes en curso** (es la que recibe las
inserciones del sync horario y paga cada índice); las viejas ya no crecen.

## Partición caliente al momento de la medición: `pricing_observations_2026_08` (380 MB)

| Índice                               | idx_scan | Tamaño | Lectura                                                           |
| ------------------------------------ | -------: | -----: | ----------------------------------------------------------------- |
| `city_year_week_idx`                 |   **46** |  12 MB | Candidato #1 a drop: 12 MB pagados en cada insert para ~1 uso/día |
| `city_category_distance_bracket_idx` |      351 | 8.4 MB | Bajo uso                                                          |
| `country_city_category_time_of__idx` |      580 |  10 MB | Bajo uso                                                          |
| `competition_name_idx`               |      700 | 7.2 MB | Bajo uso                                                          |
| `country_city_category_distance_idx` |    1 079 | 8.5 MB | Medio                                                             |
| `uploaded_by_idx`                    |    2 753 | 336 kB | OK (chico)                                                        |
| `country_observed_date_idx`          |    4 135 |  19 MB | Caliente — lo usa `v_effective_price`/RPCs                        |
| `country_year_week_idx`              |    4 226 | 112 kB | Caliente (chico)                                                  |
| `observed_date_idx`                  |    4 818 |  17 MB | Caliente — ventana de `refresh_ci_aggregates`                     |
| `country_data_source_city_categ_idx` |   13 982 |   9 MB | Caliente                                                          |
| `country_city_category_idx`          |   20 481 | 704 kB | Caliente (chico)                                                  |

Patrón consistente en jul/jun/may: `city_year_week_idx`, `city_category_distance_bracket_idx`
y `competition_name_idx` sí se usaron mucho **en meses cerrados** (3-5k), lo que sugiere
que los consumen lecturas históricas puntuales (Análisis, exportes), no el camino
caliente. Antes de dropear, confirmar qué RPC los usa con `EXPLAIN` sobre las
consultas de Competitividad y RawData.

## Tablas agregadas

| Tabla                     | Índice                        | idx_scan | Tamaño |
| ------------------------- | ----------------------------- | -------: | -----: |
| `v_yango_rival_diff_mv`   | `idx_yango_rival_diff_window` |      163 |  44 MB |
| `v_yango_rival_diff_mv`   | `idx_yango_rival_diff_lookup` |      179 |  43 MB |
| `v_bracket_daily_avg_mv`  | `idx_bda_mv_dashboard`        |      894 | 9.8 MB |
| `v_bracket_daily_avg_mv`  | `idx_bda_mv_window`           |    2 634 |  10 MB |
| `v_bracket_weekly_avg_mv` | `idx_bwa_mv_dashboard`        |    4 193 | 3.1 MB |
| `v_bracket_weekly_avg_mv` | `idx_bwa_mv_window`           |    5 927 | 3.8 MB |

Los dos índices de `v_yango_rival_diff_mv` (87 MB, ~5 usos/día) se resuelven con el
rediseño de esa tabla (Fase 4 de la revisión), no con un drop aislado.

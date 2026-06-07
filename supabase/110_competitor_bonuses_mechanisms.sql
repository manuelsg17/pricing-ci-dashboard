-- ============================================================
-- 110 — competitor_bonuses: mecanismos de bono (modelo realista)
-- ============================================================
-- CONTEXTO
--   Hoy un bono es plano (bonus_type viajes/horas/zona + threshold + amount) y el
--   motor SUMA todo bono 'viajes' cuyo umbral se cumple → una escalera cargada como
--   N filas se sobreestima. Faltan, además, los mecanismos reales de los competidores
--   (escalera, garantía, descuento de comisión, monedas, racha, surge) y la dimensión
--   de segmento (activo/nuevo/reactivado) y recurrente/one-off.
--
-- APPROACH (aditivo; tabla VACÍA → sin backfill, sin riesgo de datos)
--   - mechanism: CÓMO se cuantifica el bono (ortogonal a bonus_type, que se deja intacto).
--   - tiers jsonb: la escalera en UNA fila [{threshold,reward}] (reward ACUMULADO) →
--     mata el bug suma≠escalera por construcción (no más N filas por peldaño).
--   - segment / recurring: comparar activo-vs-activo y separar gancho one-off del semanal.
--   - group_key / is_chosen: quests ALTERNATIVAS (Uber); el analista elige la activa.
--   - comm_pct / share_in_window: descuento de comisión (InDrive 1%).
--   - cap_amount: tope (escalera/surge). mult_pct: surge (Didi TAD). streak_spec: racha Didi.
--   - day_window / time_from / time_to / zone: ventana de aplicación.
--   - Se REEMPLAZA el UNIQUE de negocio de mig 33 (country,competitor,bonus_type,
--     threshold,city) que impedía varias filas por competidor (mecanismos/segmentos/
--     quests distintas). Queda la PK serial + un índice de lookup no-único.
--
-- VERIFICACIÓN
--   information_schema confirma las 15 columnas nuevas; los 2 índices UNIQUE de
--   negocio quedan dropeados; competitor_bonuses_lookup_idx creado.
-- ============================================================

alter table public.competitor_bonuses
  add column if not exists mechanism       text    not null default 'flat',
  add column if not exists tiers           jsonb,          -- [{threshold, reward}] (acumulado)
  add column if not exists segment         text    not null default 'all',
  add column if not exists recurring       boolean not null default true,
  add column if not exists group_key       text,           -- agrupa alternativas (Uber quests)
  add column if not exists is_chosen       boolean not null default true, -- la elegida del grupo
  add column if not exists comm_pct        numeric,        -- comm_discount (% en ventana, ej 1.0)
  add column if not exists share_in_window numeric,        -- opcional por fila (si null → arquetipo)
  add column if not exists cap_amount      numeric,        -- tope (escalera / surge)
  add column if not exists mult_pct        numeric,        -- surge (+30)
  add column if not exists streak_spec     jsonb,          -- racha Didi
  add column if not exists day_window      text,           -- ej 'L-D','V-D','L-J'
  add column if not exists time_from       text,
  add column if not exists time_to         text,
  add column if not exists zone            text;

-- mechanism es ortogonal a bonus_type (NO se toca el CHECK viejo de bonus_type).
alter table public.competitor_bonuses drop constraint if exists competitor_bonuses_mechanism_chk;
alter table public.competitor_bonuses add constraint competitor_bonuses_mechanism_chk
  check (mechanism in ('flat','tiered','guarantee','comm_discount','comm_credit','streak','surge'));

alter table public.competitor_bonuses drop constraint if exists competitor_bonuses_segment_chk;
alter table public.competitor_bonuses add constraint competitor_bonuses_segment_chk
  check (segment in ('active','new','reactivated','all'));

-- Reemplazar el UNIQUE bloqueante de mig 33 (impedía varias filas por competidor).
drop index if exists competitor_bonuses_ctry_comp_type_thr_city_idx;
drop index if exists competitor_bonuses_ctry_comp_type_thr_null_idx;
create index if not exists competitor_bonuses_lookup_idx
  on public.competitor_bonuses (country, competitor_name, city);

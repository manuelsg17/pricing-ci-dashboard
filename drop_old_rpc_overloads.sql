-- Migration: Drop old function overloads that lack the p_country parameter.
-- These cause PostgREST to throw "Could not choose the best candidate function"
-- because both the old (8-param) and new (9-param with p_country) versions exist.
--
-- Run this once in the Supabase SQL Editor.

-- Weekly: old signature without p_country (8 params)
DROP FUNCTION IF EXISTS public.get_dashboard_data_weekly(
  p_city        text,
  p_category    text,
  p_zone        text,
  p_surge       boolean,
  p_week_start  integer,
  p_year_start  integer,
  p_week_end    integer,
  p_year_end    integer
);

-- Daily: old signature without p_country (6 params)
DROP FUNCTION IF EXISTS public.get_dashboard_data_daily(
  p_city        text,
  p_category    text,
  p_zone        text,
  p_surge       boolean,
  p_date_start  text,
  p_date_end    text
);

-- ═══════════════════════════════════════════════════════════════════════════════
--  КОМИК · 2026-09-26 · правило видимости сеттингов пишет только владелец (hinoma)
--
--  Запуск:  docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < migrate/2026-09-26-projects-owner.sql
--       (push.sh применяет её сам на шаге 5/5). Идемпотентно; можно до и после 2026-09-21-rls.sql.
--
--  Ключ comik:projects:v1 — кто видит какой сеттинг (страница «Сеттинги» на сайте). Читают все,
--  а писать разрешительные политики пускают любого разработчика (kv_write_dev), до RLS-миграции —
--  вообще любого вошедшего. Здесь — ОГРАНИЧИВАЮЩИЕ (restrictive) политики: они складываются
--  с разрешительными через И, поэтому эту строку меняет только hinoma, остальные ключи — как было.
--  Отдельно на insert/update/delete: restrictive «for all» задела бы и чтение.
--  Нужна public.my_tag() (2026-09-21-rls.sql или 2026-09-25-email-domain.sql) — создаём, если её нет.
-- ═══════════════════════════════════════════════════════════════════════════════
begin;

create or replace function public.my_tag() returns text
language sql stable as $$
  select case
    when lower(coalesce(auth.jwt()->>'email','')) ~ '^[^@]+@komikdnd\.ru$'
      then lower(split_part(auth.jwt()->>'email','@',1))
    else ''
  end
$$;
grant execute on function public.my_tag() to authenticated, service_role;

set local client_min_messages = warning;   -- «policy … does not exist, skipping» при первом запуске — не шумим
drop policy if exists kv_projects_owner_ins on public.kv;
create policy kv_projects_owner_ins on public.kv as restrictive for insert to authenticated
  with check (key <> 'comik:projects:v1' or public.my_tag() = 'hinoma');
drop policy if exists kv_projects_owner_upd on public.kv;
create policy kv_projects_owner_upd on public.kv as restrictive for update to authenticated
  using      (key <> 'comik:projects:v1' or public.my_tag() = 'hinoma')
  with check (key <> 'comik:projects:v1' or public.my_tag() = 'hinoma');
drop policy if exists kv_projects_owner_del on public.kv;
create policy kv_projects_owner_del on public.kv as restrictive for delete to authenticated
  using (key <> 'comik:projects:v1' or public.my_tag() = 'hinoma');

commit;

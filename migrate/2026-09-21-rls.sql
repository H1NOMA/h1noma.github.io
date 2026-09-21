-- ═══════════════════════════════════════════════════════════════════════════════
--  КОМИК · 2026-09-21 · права записи в kv по ролям (RLS) и снос серверных функций
--
--  Запуск:  psql "$DB_URL" -v ON_ERROR_STOP=1 -f migrate/2026-09-21-rls.sql
--       или на сервере: docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < migrate/2026-09-21-rls.sql
--       или целиком вставить в Supabase Studio → SQL Editor → Run.
--  Идемпотентно: повторный запуск ничего не ломает и приводит базу к тому же состоянию.
--
--  ВАЖНО: СНАЧАЛА выложить сборку сайта с этим же набором ключей (см. migrate/README.md),
--  ПОТОМ выполнять миграцию — иначе старый клиент игрока получит отказ на записи.
-- ═══════════════════════════════════════════════════════════════════════════════
begin;

-- 1. Серверные функции (RPC) больше не нужны: клиент пишет строку доски через CAS-UPDATE
--    (kvCasUpdate в index.html), а security definer обходил RLS — убираем. Сигнатуры — из setup.sh.
drop function if exists public.kv_deep_merge(text, jsonb);
drop function if exists public.trk_card_patch(text, text, text, jsonb);
drop function if exists public.trk_log_push(text, text, jsonb, integer);
drop function if exists public.jsonb_deep_merge(jsonb, jsonb);

-- 2. Список разработчиков — те же теги, что DEV_TAGS в index.html.
create table if not exists public.devs (tag text primary key);
insert into public.devs(tag) values ('hinoma'), ('herr_teo'), ('arlissss') on conflict do nothing;
-- Таблица в схеме public видна через PostgREST; дефолтные привилегии Supabase дают anon/authenticated
-- ALL ON TABLES — без RLS любой с anon-ключом дописал бы свой тег и стал «разработчиком».
alter table public.devs enable row level security;
revoke insert, update, delete, truncate on public.devs from anon, authenticated;
grant select on public.devs to anon, authenticated;
drop policy if exists devs_read on public.devs;
-- подзапрос в kv_write_dev выполняется от роли authenticated и тоже проходит RLS — чтение нужно
create policy devs_read on public.devs for select using (true);

-- 3. Тег текущего пользователя — локальная часть e-mail из JWT
--    (index.html: loginToEmail → <тег>@komikdnd.ru, emailToLogin/normTag → нижний регистр).
create or replace function public.my_tag() returns text
language sql stable as $$
  select lower(split_part(coalesce(auth.jwt()->>'email',''),'@',1))
$$;
grant execute on function public.my_tag() to authenticated, service_role;

-- 4. Политики записи kv. Чтение (kv_read: select using true) не меняется.
drop policy if exists kv_write on public.kv;          -- старая: любой вошедший писал любой ключ

drop policy if exists kv_write_dev on public.kv;      -- разработчик — всё
create policy kv_write_dev on public.kv for all to authenticated
  using      (exists (select 1 from public.devs d where d.tag = public.my_tag()))
  with check (exists (select 1 from public.devs d where d.tag = public.my_tag()));

-- игрок — ровно те ключи, которые пишет клиент без прав ГМ (аудит sset/cloudSet/insert/update в index.html):
--   comik:tracker:shared:v1  доска ходов (kvCasUpdate)        comik:games:v1  запись на игру / отмена
--   comik:users:v1           реестр логинов при входе          push:subs       пуш-подписки
--   comik:chars:<тег>        свои листы персонажей (persistChars)
--   comik:bm:<тег>           свои закладки (toggleBookmark, bmCloudSync)
-- Фон карты (comik:trk:bg:<доска>) пишет только ГМ, а ГМ — это dev-тег (ADMIN выставляется из isDev),
-- поэтому отдельного разрешения игрокам не нужно: строку покрывает политика kv_write_dev.
-- Если когда-нибудь вернётся режим «игрок-ГМ», сюда добавится и этот префикс.
drop policy if exists kv_write_player on public.kv;
create policy kv_write_player on public.kv for all to authenticated
  using (
       key in ('comik:tracker:shared:v1', 'comik:games:v1', 'comik:users:v1', 'push:subs')
    or (public.my_tag() <> '' and key in ('comik:chars:' || public.my_tag(), 'comik:bm:' || public.my_tag()))
  )
  with check (
       key in ('comik:tracker:shared:v1', 'comik:games:v1', 'comik:users:v1', 'push:subs')
    or (public.my_tag() <> '' and key in ('comik:chars:' || public.my_tag(), 'comik:bm:' || public.my_tag()))
  );

commit;

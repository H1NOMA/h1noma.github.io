-- ═══════════════════════════════════════════════════════════════════════════════
--  КОМИК · 2026-09-27 · укрепление прав: права команды — у аккаунтов, а не у текста логина;
--                        игроки не удаляют строки и не раздувают их; адрес аккаунта не меняется
--
--  Запуск:  docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < migrate/2026-09-27-hardening.sql
--       (push.sh применяет её сам на шаге 5/5 — последней, после 09-21, 09-25 и 09-26).
--  Идемпотентно. Верна и без предыдущих миграций, но push.sh каждый раз гонит все четыре подряд:
--  09-21/09-25/09-26 пересоздают свои (более слабые) версии функций и политик, эта — возвращает строгие.
--
--  Дыры, которые закрывает:
--   1) логин «v1»: my_tag() принимал любой адрес @komikdnd.ru, а строка comik:chars:v1 — старое общее
--      хранилище листов, которому клиенты верят. Теперь тег — только 4–32 знака a-z, 0-9, _ (как validTag
--      на сайте), и тот же шаблон проверяет триггер при регистрации;
--   2) смена адреса: с автоподтверждением игрок мог переименовать свой аккаунт в свободный логин команды
--      (GoTrue меняет e-mail сразу). Теперь адрес меняет только владелец сервера из SQL (postgres/supabase_admin);
--   3) права команды шли по тексту логина: удалённый или ещё не заведённый логин команды мог занять кто угодно.
--      Теперь public.devs.uid привязывает тег к конкретному аккаунту (id в auth.users). Привязываются только
--      непривязанные строки и только к существующему аккаунту; нет аккаунта — нет прав. Удалённый аккаунт
--      оставляет в uid свой старый id — его никто больше не получит. Снять человека с команды — uid = нули
--      (migrate/RESTORE.md); строку НЕ удалять: 09-21 при каждом push.sh возвращает hinoma/herr_teo/arlissss;
--   4) игрок мог удалить общую строку (расписание, доску, пуш-подписки) и записать в неё сколько угодно.
--      Теперь у игроков отдельные INSERT и UPDATE, без DELETE (клиент строки kv не удаляет вовсе),
--      и потолок размера на каждый ключ — pg_column_size(value), байт jsonb:
--        ключ                     наибольшее в снапшотах   потолок
--        comik:tracker:shared:v1  1 020 559 ¹                8 МБ  (8 388 608)
--        comik:games:v1                 378                512 КБ  (524 288)
--        comik:users:v1                 554                256 КБ  (262 144)
--        push:subs                    3 241 (7 подписок)   512 КБ  (524 288, ~1000 подписок)
--        comik:chars:<тег>        1 103 232 (hinoma)        10 МБ  (10 485 760) — в листах картинки
--        comik:bm:<тег>                 758                256 КБ  (262 144)
--      ¹ 27.08, когда в строке ещё жил фон карты; с 03.09 фон в отдельной строке, и доска — до 5 000.
--      Замер: все 30 снапшотов ветки backups (27.08–25.09) и ещё 19 из её прежней истории.
--      Разработчиков потолки не касаются (kv_write_dev).
--   5) comik:projects:v1 пишет только аккаунт, привязанный к тегу hinoma (а не любой с логином «hinoma»).
-- ═══════════════════════════════════════════════════════════════════════════════
begin;
set local client_min_messages = warning;   -- «… does not exist, skipping» при первом запуске — не шумим

-- 0. База, на которую опираются правила (если 09-21 ещё не запускали): RLS на kv, чтение для всех,
--    без старых RPC в обход RLS и без старой политики «любой вошедший пишет всё».
alter table public.kv enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'kv' and policyname = 'kv_read') then
    create policy kv_read on public.kv for select using (true);
  end if;
end $$;
drop function if exists public.kv_deep_merge(text, jsonb);
drop function if exists public.trk_card_patch(text, text, text, jsonb);
drop function if exists public.trk_log_push(text, text, jsonb, integer);
drop function if exists public.jsonb_deep_merge(jsonb, jsonb);
drop policy if exists kv_write on public.kv;

-- 1. Тег пользователя — только с адреса <тег>@komikdnd.ru, тег по правилам сайта (validTag: /^[a-z0-9_]{4,32}$/).
--    «v1», «ab», «a.b», «x@evil@komikdnd.ru» — пустой тег, а с ним ни одного ключа игрока.
--    Все теги строк comik:chars:<тег> / comik:bm:<тег> во всех снапшотах под этот шаблон подходят.
create or replace function public.my_tag() returns text
language sql stable as $$
  select case
    when lower(coalesce(auth.jwt()->>'email','')) ~ '^[a-z0-9_]{4,32}@komikdnd\.ru$'
      then split_part(lower(auth.jwt()->>'email'),'@',1)
    else ''
  end
$$;
grant execute on function public.my_tag() to authenticated, service_role;

-- 2. Адрес аккаунта. Регистрация — только тег@komikdnd.ru по тому же шаблону. Смена адреса — только из SQL
--    владельцем сервера: GoTrue (и его API, и Studio → Users) работает от supabase_auth_admin и получит отказ.
--    GoTrue часто переписывает строку целиком с тем же адресом — это не смена, пропускаем.
create or replace function public.komik_email_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if lower(new.email) is not distinct from lower(old.email) then return new; end if;
    if current_user not in ('postgres', 'supabase_admin')
       and not exists (select 1 from pg_roles where rolname = current_user and rolsuper) then
      raise exception 'Адрес аккаунта КОМИК сменить нельзя (логин меняет только владелец сервера)'
        using errcode = '42501';
    end if;
  end if;
  if new.email is null or lower(new.email) !~ '^[a-z0-9_]{4,32}@komikdnd\.ru$' then
    raise exception 'Аккаунты КОМИК заводятся только через сайт (адрес вида тег@komikdnd.ru, тег — 4–32 знака: a-z, 0-9, _)'
      using errcode = '22023';
  end if;
  return new;
end
$$;
-- create or replace, а не drop + create: снять триггер может только владелец auth.users
create or replace trigger komik_email_guard before insert or update of email on auth.users
  for each row execute function public.komik_email_guard();

-- 3. Команда: тег → аккаунт. Таблица та же, что в 09-21 (если её ещё нет — создаём такой же).
create table if not exists public.devs (tag text primary key);
insert into public.devs(tag) values ('hinoma'), ('herr_teo'), ('arlissss') on conflict do nothing;
alter table public.devs enable row level security;
alter table public.devs add column if not exists uid uuid;   -- без внешнего ключа: удалённый аккаунт оставляет свой id
revoke insert, update, delete, truncate on public.devs from anon, authenticated;
-- подзапросы политик ниже выполняются от роли authenticated — ей нужны оба столбца;
-- гостю (anon) id аккаунтов незачем — только теги
revoke select on public.devs from anon;
grant select (tag) on public.devs to anon;
grant select on public.devs to authenticated, service_role;
drop policy if exists devs_read on public.devs;
create policy devs_read on public.devs for select using (true);

-- привязываем только непривязанные строки и только к существующему аккаунту
set local client_min_messages = notice;
do $$
declare r record;
begin
  for r in
    update public.devs d set uid = u.id from auth.users u
     where d.uid is null and lower(u.email) = d.tag || '@komikdnd.ru'
    returning d.tag, u.created_at
  loop
    raise notice 'Команда: % — привязан к аккаунту (заведён %). Если это не твой человек — сними его (migrate/RESTORE.md)',
      r.tag, to_char(r.created_at, 'DD.MM.YYYY');
  end loop;
end
$$;
set local client_min_messages = warning;

-- 4. Разработчик — всё, но только аккаунт, привязанный к своему тегу.
drop policy if exists kv_write_dev on public.kv;
create policy kv_write_dev on public.kv for all to authenticated
  using      (exists (select 1 from public.devs d where d.uid = auth.uid() and d.tag = public.my_tag()))
  with check (exists (select 1 from public.devs d where d.uid = auth.uid() and d.tag = public.my_tag()));

-- правило видимости сеттингов — только аккаунт, привязанный к hinoma (ограничивающие, как в 09-26)
drop policy if exists kv_projects_owner_ins on public.kv;
create policy kv_projects_owner_ins on public.kv as restrictive for insert to authenticated
  with check (key <> 'comik:projects:v1'
    or exists (select 1 from public.devs d where d.tag = 'hinoma' and d.uid = auth.uid() and public.my_tag() = 'hinoma'));
drop policy if exists kv_projects_owner_upd on public.kv;
create policy kv_projects_owner_upd on public.kv as restrictive for update to authenticated
  using      (key <> 'comik:projects:v1'
    or exists (select 1 from public.devs d where d.tag = 'hinoma' and d.uid = auth.uid() and public.my_tag() = 'hinoma'))
  with check (key <> 'comik:projects:v1'
    or exists (select 1 from public.devs d where d.tag = 'hinoma' and d.uid = auth.uid() and public.my_tag() = 'hinoma'));
drop policy if exists kv_projects_owner_del on public.kv;
create policy kv_projects_owner_del on public.kv as restrictive for delete to authenticated
  using (key <> 'comik:projects:v1'
    or exists (select 1 from public.devs d where d.tag = 'hinoma' and d.uid = auth.uid() and public.my_tag() = 'hinoma'));

-- 5. Игрок: потолок размера строки (байт) для ключа, который ему можно писать; null — писать нельзя.
--    Список ключей — тот же, что в 09-21 (аудит записи в index.html), размеры — в шапке файла.
create or replace function public.kv_player_cap(k text) returns integer
language sql stable as $$
  select case
    when public.my_tag() !~ '^[a-z0-9_]{4,32}$'        then null
    when k = 'comik:tracker:shared:v1'                  then 8388608    -- доска ходов (kvCasUpdate)
    when k = 'comik:games:v1'                           then 524288     -- запись на игру / отмена
    when k = 'comik:users:v1'                           then 262144     -- реестр логинов
    when k = 'push:subs'                                then 524288     -- пуш-подписки
    when k = 'comik:chars:' || public.my_tag()          then 10485760   -- свои листы персонажей
    when k = 'comik:bm:'    || public.my_tag()          then 262144     -- свои закладки
  end
$$;
revoke all on function public.kv_player_cap(text) from public, anon;
grant execute on function public.kv_player_cap(text) to authenticated, service_role;

-- вместо одной «for all» — вставка и правка; удаления у игроков нет
drop policy if exists kv_write_player on public.kv;
drop policy if exists kv_write_player_ins on public.kv;
create policy kv_write_player_ins on public.kv for insert to authenticated
  with check (pg_column_size(value) <= public.kv_player_cap(key));
drop policy if exists kv_write_player_upd on public.kv;
create policy kv_write_player_upd on public.kv for update to authenticated
  using      (public.kv_player_cap(key) is not null)
  with check (pg_column_size(value) <= public.kv_player_cap(key));

-- 6. Итог — коротко, по-русски.
set local client_min_messages = notice;
do $$
declare n int; list text; r record; s text := ''; pol text; odd text;
begin
  -- аккаунты с адресом не по шаблону: входить могут, но тега (а с ним и прав записи) у них нет
  select count(*) into n from auth.users where lower(coalesce(email,'')) !~ '^[a-z0-9_]{4,32}@komikdnd\.ru$';
  select string_agg(coalesce(email, '<без адреса>'), ', ') into list
    from (select email from auth.users where lower(coalesce(email,'')) !~ '^[a-z0-9_]{4,32}@komikdnd\.ru$' order by email limit 20) q;
  if n > 0 then raise notice 'Адреса не по шаблону тег@komikdnd.ru (% шт., первые 20) — у них больше нет прав записи: %', n, list;
  else raise notice 'Все адреса аккаунтов — тег@komikdnd.ru ✓'; end if;

  -- строки листов/закладок с тегом не по шаблону (например, старое общее comik:chars:v1) — теперь их пишет только команда
  select string_agg(key, ', ' order by key) into list from public.kv
   where (key like 'comik:chars:%' and substr(key, 13) !~ '^[a-z0-9_]{4,32}$')
      or (key like 'comik:bm:%'    and substr(key, 10) !~ '^[a-z0-9_]{4,32}$');
  if list is not null then raise notice 'Строки с тегом не по шаблону (пишет только команда): %', list; end if;

  for r in select d.tag, d.uid, u.email from public.devs d left join auth.users u on u.id = d.uid order by d.tag loop
    s := s || case
      when r.uid is null then r.tag || ' — нет аккаунта (прав нет)'
      when r.uid = '00000000-0000-0000-0000-000000000000' then r.tag || ' ✗ снят с команды'
      when r.email is null then r.tag || ' ✗ аккаунт удалён (прав нет)'
      when lower(r.email) <> r.tag || '@komikdnd.ru' then r.tag || ' ✗ у аккаунта другой адрес (прав нет)'
      else r.tag || ' ✓'
    end || '; ';
  end loop;
  raise notice 'Команда: %', rtrim(s, '; ');

  select string_agg(policyname, ', ' order by policyname) into pol from pg_policies where schemaname = 'public' and tablename = 'kv';
  raise notice 'Правила kv: %', pol;
  select string_agg(policyname, ', ' order by policyname) into odd from pg_policies
   where schemaname = 'public' and tablename = 'kv'
     and policyname not in ('kv_read', 'kv_write_dev', 'kv_write_player_ins', 'kv_write_player_upd',
                            'kv_projects_owner_ins', 'kv_projects_owner_upd', 'kv_projects_owner_del');
  if odd is not null then raise warning 'Лишние правила на kv (разрешительное правило открывает запись всем — проверь): %', odd; end if;
end
$$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
--  КОМИК · 2026-09-25 · тег пользователя — только с адреса @komikdnd.ru
--
--  Запуск:  docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < migrate/2026-09-25-email-domain.sql
--       или целиком вставить в Supabase Studio → SQL Editor → Run.
--  Идемпотентно. Можно запускать и до, и после 2026-09-21-rls.sql.
--
--  Дыра: my_tag() брал часть e-mail до «@» и не смотрел домен, а регистрация открыта
--  (сайт сам зовёт signUp, автоподтверждение включено, анон-ключ публичный). Любой мог
--  зарегистрироваться напрямую через API как hinoma@gmail.com и получить права разработчика
--  (запись любого ключа kv: приветствие, архив, новости — а это хранимый XSS у всех посетителей),
--  или как roman@gmail.com — запись в чужие листы comik:chars:roman.
--  Сайт заводит аккаунты только как <тег>@komikdnd.ru, поэтому:
--   1) my_tag() отдаёт тег лишь для адреса вида <тег>@komikdnd.ru, иначе пустую строку;
--   2) триггер на auth.users не даёт завести (или сменить на) адрес с другим доменом.
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

create or replace function public.komik_email_guard() returns trigger
language plpgsql as $$
begin
  if new.email is null or lower(new.email) !~ '^[^@]+@komikdnd\.ru$' then
    raise exception 'Аккаунты КОМИК заводятся только через сайт (адрес вида тег@komikdnd.ru)'
      using errcode = '22023';
  end if;
  return new;
end
$$;
set local client_min_messages = warning;   -- «trigger … does not exist, skipping» при первом запуске — не шумим
drop trigger if exists komik_email_guard on auth.users;
create trigger komik_email_guard before insert or update of email on auth.users
  for each row execute function public.komik_email_guard();

-- уже заведённые адреса с другим доменом (если есть) — показываем: прав записи у них больше нет
set local client_min_messages = notice;
do $$
declare n int; list text;
begin
  select count(*), string_agg(email, ', ') into n, list
    from (select email from auth.users where lower(coalesce(email,'')) !~ '^[^@]+@komikdnd\.ru$' limit 20) q;
  if n > 0 then raise notice 'Адреса не на @komikdnd.ru (% шт., первые 20): %', n, list;
  else raise notice 'Все адреса на @komikdnd.ru ✓'; end if;
end
$$;

commit;

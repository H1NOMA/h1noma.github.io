-- ═══════════════════════════════════════════════════════════════════════════════
--  КОМИК · 2026-10-30 · игрок сам удаляет свой аккаунт
--
--  Запуск:  push.sh применяет её сам — последней, в той же транзакции, что и остальные миграции.
--           Вручную: docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < migrate/2026-10-30-self-delete.sql
--  Идемпотентно. Опирается на 10-29 (komik_is_team, komik_num, схема komik_priv) — идёт после неё.
--  10-29 при каждом push.sh ставит версию API 3, эта возвращает 4.
--
--  Что делает:
--   1) public.komik_delete_me(confirm) — сайт вызывает её после повторного ввода пароля (signInWithPassword):
--      проверяет вход, подтверждение (свой логин), что это не аккаунт команды и что пароль вводили не раньше
--      10 минут назад (claim amr в токене); затем одной транзакцией:
--        · свои строки comik:chars:<тег>, comik:bm:<тег>, push:sub:<тег>;
--        · портреты comik:img:<хэш>, на которые ссылались только его листы и карточки (на картинку из любой
--          другой строки — нет);
--        · свои записи на ещё не сыгранные игры (с отметкой gone[тег], чтобы старая вкладка не вернула запись),
--          со своих карточек на доске — тег ownTag (карточка становится ничьей: «-») и портрет (версия доски rev + 1),
--          себя из реестра логинов, свои листы из замороженной comik:chars:v1, свои подписки из старой общей push:subs;
--        · аккаунт: auth.users (identities, sessions, mfa — каскадом), refresh_tokens без сессии — отдельно.
--      Надгробия сыгранных игр, журнал доски, тексты архива и хроники не трогает. Журнал правок kv_history и
--      ежедневные копии хранят прежнее ещё до 7 дней (сеть безопасности при угоне аккаунта).
--      Ошибки — 42501 с кодом в тексте: komik:auth, komik:confirm, komik:team, komik:reauth.
--   2) komik_priv.komik_gone(uid, tag, at) — удалённые аккаунты (без прав у API). По ней:
--        · триггер komik_kv_gone: токен удалённого аккаунта живёт ещё до часа — запись в kv с ним не проходит
--          (иначе другое устройство игрока снова создало бы его строки);
--        · триггер komik_signup_gone: логин 90 дней нельзя зарегистрировать заново (столько сайт помнит отметки
--          gone и надгробия игр; у ГМа в памяти остаются листы с этим владельцем);
--        · restore.sh accounts кладёт список в копию аккаунтов, setup.sh после загрузки копии удаляет эти аккаунты,
--          backup.sh раз в сутки дочищает следы и забывает записи старше 90 дней.
--   3) komik_priv.komik_forget(тег) — вся уборка строк kv (её же зовут restore.sh, setup.sh и backup.sh).
-- ═══════════════════════════════════════════════════════════════════════════════
begin;
set local client_min_messages = warning;

-- 1. Удалённые аккаунты. Схема komik_priv наружу не отдаётся (PostgREST видит только public); прав у API нет
create schema if not exists komik_priv;
create table if not exists komik_priv.komik_gone (
  uid uuid primary key,
  tag text not null,
  at  timestamptz not null default now()
);
alter table komik_priv.komik_gone enable row level security;
revoke all on komik_priv.komik_gone from public, anon, authenticated;

-- тег, как normTag на сайте: без пробелов и «@» в начале, строчными
create or replace function komik_priv.komik_ntag(t text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(coalesce(t, '')), '^@+', ''))
$$;

-- 2. Уборка следов тега в kv. Не definer: её зовут komik_delete_me (от владельца) и скрипты сервера (postgres).
--    Повторный вызов ничего не меняет — строки переписываются, только если в них есть что снять
create or replace function komik_priv.komik_forget(me text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  now_ms numeric := floor(extract(epoch from now()) * 1000);
  v jsonb; nv jsonb; gk text; gv jsonb; flat boolean;
  cand text[];
  n_rows int := 0; n_imgs int := 0;
begin
  me := komik_priv.komik_ntag(me);
  if me !~ '^[a-z0-9_]{4,32}$' then raise exception 'komik_forget: тег «%» не по правилам сайта', me; end if;

  -- портреты из своих строк — кандидаты: удаляются в конце, если на них не ссылается никто другой
  select coalesce(array_agg(m[1]), '{}') into cand
    from public.kv k, regexp_matches(k.value::text, 'kvimg:([0-9a-f]{32})', 'g') m
   where k.key in ('comik:chars:' || me, 'comik:bm:' || me);

  -- свои строки
  delete from public.kv where key in ('comik:chars:' || me, 'comik:bm:' || me, 'push:sub:' || me);
  get diagnostics n_rows = row_count;

  -- замороженное общее хранилище листов: свои листы — по владельцу (старый формат — просто массив)
  select value into v from public.kv where key = 'comik:chars:v1' for update;
  if jsonb_typeof(v) in ('object', 'array') then
    flat := jsonb_typeof(v) = 'array';
    nv := case when flat then jsonb_build_object('', v) else v end;
    for gk, gv in select e.key, e.value from jsonb_each(nv) e where jsonb_typeof(e.value) = 'array' loop
      continue when not exists (select 1 from jsonb_array_elements(gv) s
                                 where jsonb_typeof(s) = 'object' and komik_priv.komik_ntag(s->>'owner') = me);
      cand := cand || coalesce((select array_agg(m[1]) from jsonb_array_elements(gv) s, regexp_matches(s::text, 'kvimg:([0-9a-f]{32})', 'g') m
                                 where jsonb_typeof(s) = 'object' and komik_priv.komik_ntag(s->>'owner') = me), '{}');
      nv := jsonb_set(nv, array[gk], (select coalesce(jsonb_agg(s order by i), '[]') from jsonb_array_elements(gv) with ordinality t(s, i)
                                       where not (jsonb_typeof(s) = 'object' and komik_priv.komik_ntag(s->>'owner') = me)));
    end loop;
    if flat then nv := nv->''; end if;
    if nv is distinct from v then update public.kv set value = nv where key = 'comik:chars:v1'; end if;
  end if;

  -- расписание: свои записи на живые (ещё не сыгранные) игры снимаются с отметкой gone[тег] — не раньше «сейчас»
  -- и строго новее самой записи (как gameDropPlayer на сайте): иначе её копия из старой вкладки вернулась бы.
  -- Надгробия (удалённые и сыгранные игры) не трогаем
  select value into v from public.kv where key = 'comik:games:v1' for update;
  if jsonb_typeof(v) = 'array' then
    nv := (select coalesce(jsonb_agg(case
        when jsonb_typeof(s) = 'object' and s->'deleted' is distinct from 'true'::jsonb and jsonb_typeof(s->'players') = 'array'
             and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(s->'players') = 'array' then s->'players' else '[]'::jsonb end) p
                          where jsonb_typeof(p) = 'object' and komik_priv.komik_ntag(p->>'tag') = me)
        then jsonb_set(jsonb_set(s, '{players}',
               (select coalesce(jsonb_agg(p order by j), '[]') from jsonb_array_elements(s->'players') with ordinality q(p, j)
                 where not (jsonb_typeof(p) = 'object' and komik_priv.komik_ntag(p->>'tag') = me))),
               '{gone}', (case when jsonb_typeof(s->'gone') = 'object' then s->'gone' else '{}'::jsonb end)
                 || jsonb_build_object(me, greatest(now_ms, coalesce(public.komik_num(s->'gone'->me), 0), 1 + (
                      select max(greatest(coalesce(public.komik_num(p->'upd'), 0), coalesce(public.komik_num(p->'at'), 0)))
                        from jsonb_array_elements(s->'players') p where jsonb_typeof(p) = 'object' and komik_priv.komik_ntag(p->>'tag') = me))))
        else s end order by i), '[]')
      from jsonb_array_elements(v) with ordinality t(s, i));
    if nv is distinct from v then update public.kv set value = nv where key = 'comik:games:v1'; end if;
  end if;

  -- доска ходов: свои карточки остаются у ГМа, но ничьими — ownTag «-» (не тег и не пусто). Без тега карточку
  -- присвоил бы по id листа любой, кто впишет этот id в свой лист: его листа больше нет, id ни за кем.
  -- Портрет с карточки снимаем — он тоже кандидат. Версия rev + 1 — иначе условная запись ГМа (kvCasUpdate)
  -- по прежней версии вернула бы тег из его памяти
  select value into v from public.kv where key = 'comik:tracker:shared:v1' for update;
  if jsonb_typeof(v) = 'object' then
    cand := cand || coalesce((select array_agg(m[1]) from jsonb_each(v) e(bk, bv),
                                jsonb_array_elements(case when jsonb_typeof(bv->'list') = 'array' then bv->'list' else '[]'::jsonb end) c,
                                regexp_matches(coalesce(c->>'ava', ''), 'kvimg:([0-9a-f]{32})', 'g') m
                               where jsonb_typeof(c) = 'object' and komik_priv.komik_ntag(c->>'ownTag') = me), '{}');
    nv := coalesce((select jsonb_object_agg(bk, case
        when jsonb_typeof(bv) = 'object' and jsonb_typeof(bv->'list') = 'array'
             and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(bv->'list') = 'array' then bv->'list' else '[]'::jsonb end) c
                          where jsonb_typeof(c) = 'object' and komik_priv.komik_ntag(c->>'ownTag') = me)
        then jsonb_set(bv, '{list}', (select jsonb_agg(case when jsonb_typeof(c) = 'object' and komik_priv.komik_ntag(c->>'ownTag') = me
                                                            then (c - 'ava') || '{"ownTag": "-"}'::jsonb else c end order by i)
                                        from jsonb_array_elements(bv->'list') with ordinality t(c, i)))
        else bv end)
      from jsonb_each(v) e(bk, bv)), '{}');
    if nv is distinct from v then
      update public.kv set value = nv || jsonb_build_object('rev', case when coalesce(v->>'rev', '') ~ '^\d{1,15}$' then (v->>'rev')::bigint + 1 else 1 end)
       where key = 'comik:tracker:shared:v1';
    end if;
  end if;

  -- реестр логинов и старая общая строка пуш-подписок (рассылка читает и её)
  select value into v from public.kv where key = 'comik:users:v1' for update;
  if jsonb_typeof(v) = 'array' then
    nv := (select coalesce(jsonb_agg(u order by i), '[]') from jsonb_array_elements(v) with ordinality t(u, i)
            where not (jsonb_typeof(u) = 'object' and komik_priv.komik_ntag(u->>'tag') = me));
    if nv is distinct from v then update public.kv set value = nv where key = 'comik:users:v1'; end if;
  end if;
  select value into v from public.kv where key = 'push:subs' for update;
  if jsonb_typeof(v) = 'array' then
    nv := (select coalesce(jsonb_agg(u order by i), '[]') from jsonb_array_elements(v) with ordinality t(u, i)
            where not (jsonb_typeof(u) = 'object' and komik_priv.komik_ntag(u->>'tag') = me));
    if nv is distinct from v then update public.kv set value = nv where key = 'push:subs'; end if;
  end if;

  -- портреты: ссылка kvimg:<хэш> в любой другой строке (лист другого игрока, архив, доска) — картинка остаётся
  if cardinality(cand) > 0 then
    with used as (
      select distinct m[1] as h
        from public.kv o, regexp_matches(o.value::text, 'kvimg:([0-9a-f]{32})', 'g') m
       where o.key not like 'comik:img:%')
    delete from public.kv k
     where k.key in (select 'comik:img:' || c from unnest(cand) c where not exists (select 1 from used where used.h = c));
    get diagnostics n_imgs = row_count;
  end if;

  return jsonb_build_object('rows', n_rows, 'imgs', n_imgs);
end
$$;
revoke all on function komik_priv.komik_ntag(text) from public, anon, authenticated;
revoke all on function komik_priv.komik_forget(text) from public, anon, authenticated;

-- 3. Удалить свой аккаунт. security definer: игрок не удаляет строки kv и аккаунты сам (09-27). Входных данных,
--    кроме confirm, у функции нет — всё, что она пишет, она собирает сама
create or replace function public.komik_delete_me(confirm text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  me_uid uuid := auth.uid();
  me     text := public.my_tag();
  pw_at  numeric;
  r jsonb; n int;
begin
  if me_uid is null or coalesce(me, '') = '' then
    raise exception 'komik:auth' using errcode = '42501', detail = 'нужно войти';
  end if;
  if lower(btrim(coalesce(confirm, ''))) is distinct from me then
    raise exception 'komik:confirm' using errcode = '42501', detail = 'подтверждение не совпадает с логином';
  end if;
  if not exists (select 1 from auth.users u where u.id = me_uid and lower(u.email) = (me || '@komikdnd.ru')) then
    raise exception 'komik:auth' using errcode = '42501', detail = 'аккаунта нет';
  end if;
  -- команду так не удалить: логин освободился бы, а он зашит в DEV_TAGS сайта и в рассылке (RESTORE.md, пункт 6)
  if public.komik_is_team() or exists (select 1 from public.devs d where d.tag = me or d.uid = me_uid) then
    raise exception 'komik:team' using errcode = '42501', detail = 'аккаунт команды удаляет только владелец сервера';
  end if;
  -- пароль вводили только что: GoTrue пишет в токен amr [{method: password, timestamp: секунды}], при обновлении
  -- токена время входа не меняется. Сайт перед вызовом входит заново (signInWithPassword) — у входа есть лимит попыток
  select max(public.komik_num(a->'timestamp')) into pw_at
    from jsonb_array_elements(case when jsonb_typeof(auth.jwt()->'amr') = 'array' then auth.jwt()->'amr' else '[]'::jsonb end) a
   where jsonb_typeof(a) = 'object' and a->>'method' = 'password';
  if pw_at is null or pw_at < extract(epoch from now()) - 600 then
    raise exception 'komik:reauth' using errcode = '42501', detail = 'введите пароль ещё раз';
  end if;

  insert into komik_priv.komik_gone (uid, tag) values (me_uid, me)
  on conflict (uid) do update set tag = excluded.tag, at = now();
  r := komik_priv.komik_forget(me);

  -- refresh_tokens старых входов бывают без сессии — каскад их не заберёт
  if to_regclass('auth.refresh_tokens') is not null then
    if has_table_privilege('auth.refresh_tokens', 'DELETE') then
      execute 'delete from auth.refresh_tokens where user_id = $1' using me_uid::text;
    end if;
  end if;
  delete from auth.users where id = me_uid;
  get diagnostics n = row_count;
  -- не удалился (нет права или правило строк на auth.users) — откатываем всё, а не «удалили данные, аккаунт жив»
  if n <> 1 then
    raise exception 'komik:server' using detail = 'аккаунт не удалился: проверь права владельца функции на auth.users (push.sh check)';
  end if;
  return jsonb_build_object('ok', true, 'tag', me, 'rows', (r->>'rows')::int, 'imgs', (r->>'imgs')::int);
end
$$;
revoke all on function public.komik_delete_me(text) from public, anon, service_role;
grant execute on function public.komik_delete_me(text) to authenticated;

-- 4. Токен удалённого аккаунта живёт ещё до часа: запись в kv с ним — отказ. Срабатывает раньше стража общих строк
--    (триггеры идут по имени) — расписание и доску он и не разбирает
create or replace function komik_priv.komik_uid_gone() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from komik_priv.komik_gone g where g.uid = auth.uid())
$$;
revoke all on function komik_priv.komik_uid_gone() from public, anon;
grant execute on function komik_priv.komik_uid_gone() to authenticated;

create or replace function public.komik_kv_gone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') and auth.uid() is not null then
    if komik_priv.komik_uid_gone() then
      raise exception 'komik:gone' using errcode = '42501', detail = 'аккаунт удалён';
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists komik_kv_gone on public.kv;
create trigger komik_kv_gone before insert or update on public.kv
  for each row execute function public.komik_kv_gone();

-- 5. Логин удалённого аккаунта 90 дней не занять. Регистрирует GoTrue (supabase_auth_admin) — триггер работает от него,
--    а список удалённых читает помощник от владельца. Триггер — create or replace, как komik_email_guard в 09-27: снять
--    триггер с auth.users может только владелец таблицы. Вернуть человека раньше — RESTORE.md, раздел 13
create or replace function komik_priv.komik_tag_gone(t text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from komik_priv.komik_gone g where g.tag = komik_priv.komik_ntag(t) and g.at > now() - interval '90 days')
$$;
revoke all on function komik_priv.komik_tag_gone(text) from public, anon, authenticated;
grant usage on schema komik_priv to supabase_auth_admin;
grant execute on function komik_priv.komik_tag_gone(text) to supabase_auth_admin;

create or replace function public.komik_signup_gone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if komik_priv.komik_tag_gone(split_part(coalesce(new.email, ''), '@', 1)) then
    raise exception 'komik:gone' using errcode = '42501', detail = 'логин недавно удалён — занять его можно через 90 дней';
  end if;
  return new;
end
$$;
create or replace trigger komik_signup_gone before insert on auth.users
  for each row execute function public.komik_signup_gone();

-- 6. Версия набора прав — сайт показывает «Удалить аккаунт» только с 4
create or replace function public.komik_api_version() returns integer
language sql immutable set search_path = '' as $$ select 4 $$;
grant execute on function public.komik_api_version() to anon, authenticated, service_role;
notify pgrst, 'reload schema';

-- 7. Итог
set local client_min_messages = notice;
do $$
declare n int;
begin
  select count(*) into n from komik_priv.komik_gone where at > now() - interval '90 days';
  raise notice 'Удаление аккаунта игроком (API 4): удалено за 90 дней — %', n;
end
$$;

commit;

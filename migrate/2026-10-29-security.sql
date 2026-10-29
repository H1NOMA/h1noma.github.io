-- ═══════════════════════════════════════════════════════════════════════════════
--  КОМИК · 2026-10-29 · игрок меняет только своё, видит только своё; журнал правок
--
--  Запуск:  push.sh применяет её сам — последней, в той же транзакции, что и остальные миграции.
--           Вручную: docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < migrate/2026-10-29-security.sql
--  Идемпотентно. Предыдущие миграции при каждом push.sh пересоздают свои (более слабые) версии kv_read,
--  devs_read и kv_player_cap — эта идёт последней и возвращает строгие.
--
--  Дыры, которые закрывает (аудит 29.10.2026):
--   1) Любой, кто сам зарегистрировался, переписывал общие строки целиком: расписание с записями всех
--      игроков (comik:games:v1), доску ходов вместе с досками ГМа (comik:tracker:shared:v1), реестр логинов
--      (comik:users:v1), пуш-подписки (push:subs). Права RLS проверяли только размер строки.
--      Теперь триггер komik_kv_guard перед записью игрока (не команды) собирает новое значение из СТАРОГО
--      и переносит в него только то, что игрок вправе менять:
--        · расписание — свою запись в сессии (имя, персонаж, цвет) и свою отметку снятия gone[тег];
--          новых сессий, чужих записей, полей сессии игрок не меняет; записаться сверх мест нельзя;
--        · доска — у карточек СВОИХ персонажей (id из своей строки comik:chars:<тег>) ХП, временные ХП,
--          инициативу, спасброски от смерти, состояния, концентрацию; позицию своей фишки на карте; журнал
--          доски (его читает только ГМ); отметку «постучался» joinAt. Досок, чужих карточек, состава,
--          раунда, фона игрок не трогает;
--        · реестр логинов — только дописать себя.
--      Клиенту ничего переделывать не нужно: он и так пишет «прочитать → слить → записать», лишнее просто
--      не доезжает. Подделка, стирание, вандализм — не доезжают тоже.
--   2) Пуш-подписки — личные строки push:sub:<тег> (читает и пишет владелец, читает команда и рассылка).
--      Старая общая строка push:subs раскладывается по личным и очищается; игрокам она больше не доступна.
--   3) Чтение. Раньше всё читалось без входа (kv_read using true): чужие листы персонажей целиком,
--      архив игр ГМа с заметками (спойлеры), старый чат, пуш-подписки. Теперь читать без входа можно только
--      то, что показывает сайт: архив, новости, хронику, расписание, доску, правила видимости, фото, фоны
--      досок, реестр логинов, правки справочника. Свои листы/закладки/подписки — владелец. Всё — команда.
--      Чужие листы остальным — через «витрину» kv_chars_pub: имя, игрок, портрет (ссылка kvimg:), класс,
--      уровень, ХП, КД, инициатива — то, что нужно доске ходов и анонсам; биография, инвентарь, заметки — нет.
--   4) id аккаунтов команды (devs.uid) видел любой вошедший — теперь каждый видит только свою строку.
--   5) Журнал kv_history: кто (аккаунт и тег) и когда менял строку; прежнее значение — для всего, кроме
--      доски ходов (её переписывает каждый тап по ХП) и фото; у больших строк (> 64 КБ: листы, архив, фоны) —
--      не чаще раза в 15 минут. Хранится 7 дней, читает только команда.
--      Восстановить строку: migrate/RESTORE.md, «Откат строки из журнала».
-- ═══════════════════════════════════════════════════════════════════════════════
begin;
set local client_min_messages = warning;

-- 0. Кто пишет. Команда — аккаунт, привязанный к своему тегу в public.devs (как kv_write_dev в 09-27).
--    security definer: правила ниже вызывают её от anon/authenticated, а devs им читать незачем.
create or replace function public.komik_is_team() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.devs d where d.uid = auth.uid() and d.tag = public.my_tag())
$$;
revoke all on function public.komik_is_team() from public;
grant execute on function public.komik_is_team() to anon, authenticated, service_role;

-- число из jsonb (число или строка с числом), иначе null — значения приходят от клиента как есть
create or replace function public.komik_num(j jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(j) = 'number' then (j #>> '{}')::numeric
    when jsonb_typeof(j) = 'string' and (j #>> '{}') ~ '^\s*-?\d{1,15}(\.\d{1,6})?\s*$' then trim(j #>> '{}')::numeric
  end
$$;
-- строка из jsonb (строка или число), обрезанная до n знаков; иначе null
create or replace function public.komik_str(j jsonb, n integer) returns text
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(j) in ('string', 'number') then left(j #>> '{}', n) end
$$;

-- 1. Расписание: запись игрока в сессии — только известные поля, безопасные значения (как gameClean на сайте)
create or replace function public.komik_san_entry(p jsonb, me text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'tag',      case when lower(coalesce(p->>'tag','')) = me then p->>'tag' else me end,
    'name',     public.komik_str(p->'name', 80),
    'charId',   case when coalesce(p->>'charId','') ~ '^[A-Za-z0-9_-]{1,64}$' then p->>'charId' else '' end,
    'charName', public.komik_str(p->'charName', 80),
    'bg',       case when coalesce(p->>'bg','')  ~ '^(#[0-9a-fA-F]{3,8}|var\(--[a-z0-9-]{1,30}\))$' then p->>'bg'  end,
    'ink',      case when coalesce(p->>'ink','') ~ '^(#[0-9a-fA-F]{3,8}|var\(--[a-z0-9-]{1,30}\))$' then p->>'ink' end,
    'at',       public.komik_num(p->'at'),
    'upd',      public.komik_num(p->'upd')))
$$;

create or replace function public.komik_san_games(o jsonb, n jsonb, me text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  res jsonb := '[]'; s jsonb; ns jsonb; mine jsonb; was jsonb; others jsonb;
  seats integer; gone_o numeric; gone_n numeric; fresh_was numeric; fresh_mine numeric;
  now_ms numeric := floor(extract(epoch from now()) * 1000);
begin
  if jsonb_typeof(o) is distinct from 'array' then o := '[]'; end if;
  if jsonb_typeof(n) is distinct from 'array' then n := '[]'; end if;
  for s in select x from jsonb_array_elements(o) x loop
    -- надгробия и битые записи — как были
    if jsonb_typeof(s) <> 'object' or s->'deleted' = 'true'::jsonb or coalesce(s->>'id','') = '' then
      res := res || jsonb_build_array(s); continue;
    end if;
    select x into ns from jsonb_array_elements(n) x
      where jsonb_typeof(x) = 'object' and x->>'id' = s->>'id' and x->'deleted' is distinct from 'true'::jsonb limit 1;
    if ns is null then res := res || jsonb_build_array(s); continue; end if;   -- клиент этой сессии ещё не видел
    others := coalesce((select jsonb_agg(p) from jsonb_array_elements(case when jsonb_typeof(s->'players') = 'array' then s->'players' else '[]' end) p
                        where lower(coalesce(p->>'tag','')) <> me), '[]');
    select p into was from jsonb_array_elements(case when jsonb_typeof(s->'players') = 'array' then s->'players' else '[]' end) p
      where lower(coalesce(p->>'tag','')) = me limit 1;
    select p into mine from jsonb_array_elements(case when jsonb_typeof(ns->'players') = 'array' then ns->'players' else '[]' end) p
      where jsonb_typeof(p) = 'object' and lower(coalesce(p->>'tag','')) = me limit 1;
    gone_o := coalesce(public.komik_num(s->'gone'->me), 0);
    gone_n := public.komik_num(case when jsonb_typeof(ns->'gone') = 'object' then ns->'gone'->me end);
    if gone_n is not null and gone_n > now_ms + 86400000 then gone_n := null; end if;   -- отметка «из будущего» — не принимаем
    fresh_was := greatest(coalesce(public.komik_num(was->'upd'),0), coalesce(public.komik_num(was->'at'),0));
    if mine is not null then
      mine := public.komik_san_entry(mine, me);
      if was is not null then mine := mine || jsonb_build_object('at', coalesce(was->'at', mine->'at'));   -- место в очереди своё, не переставить
      elsif coalesce(public.komik_num(mine->'at'), 0) > now_ms + 86400000 then mine := mine || jsonb_build_object('at', now_ms);
      end if;
      fresh_mine := greatest(coalesce(public.komik_num(mine->'upd'),0), coalesce(public.komik_num(mine->'at'),0));
      if fresh_mine <= greatest(gone_o, coalesce(gone_n,0)) then mine := null; end if;   -- запись не новее снятия — устаревшая копия
    end if;
    if mine is not null and was is null then                                          -- новая запись — только на свободное место
      seats := nullif(regexp_replace(coalesce(s->>'seats',''), '\D', '', 'g'), '')::integer;
      if seats is not null and seats > 0 and jsonb_array_length(others) >= seats then mine := null; end if;
    end if;
    if mine is null and was is not null and coalesce(gone_n, 0) <= fresh_was then
      mine := was;                                                                    -- снять запись — только с отметкой новее неё
    end if;
    s := jsonb_set(s, '{players}', others || case when mine is null then '[]'::jsonb else jsonb_build_array(mine) end);
    if gone_n is not null and gone_n > gone_o then
      s := jsonb_set(s, '{gone}', (case when jsonb_typeof(s->'gone') = 'object' then s->'gone' else '{}' end) || jsonb_build_object(me, gone_n));
    end if;
    res := res || jsonb_build_array(s);
  end loop;
  return res;
end
$$;

-- 2. Реестр логинов: только дописать себя
create or replace function public.komik_san_users(o jsonb, n jsonb, me text) returns jsonb
language sql stable set search_path = '' as $$
  select case
    when exists (select 1 from jsonb_array_elements(oo) u where lower(coalesce(u->>'tag','')) = me) then oo
    when jsonb_typeof(n) = 'array' and exists (select 1 from jsonb_array_elements(n) u where jsonb_typeof(u) = 'object' and lower(coalesce(u->>'tag','')) = me)
      then oo || jsonb_build_array(jsonb_build_object('tag', me, 'createdAt', floor(extract(epoch from now()) * 1000)))
    else oo end
  from (select case when jsonb_typeof(o) = 'array' then o else '[]'::jsonb end as oo) z
$$;

-- 3. Доска ходов. id своих персонажей — из своей строки листов (без копий-alias и удалённых); тег — из токена
create or replace function public.komik_my_chars() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct s->>'id'), '{}')
    from public.kv k,
         jsonb_each(case when jsonb_typeof(k.value) = 'object' then k.value else '{}'::jsonb end) g(gk, gv),
         jsonb_array_elements(case when jsonb_typeof(gv) = 'array' then gv else '[]'::jsonb end) s
   where public.my_tag() <> '' and k.key = 'comik:chars:' || public.my_tag()
     and jsonb_typeof(s) = 'object' and coalesce(s->>'id','') <> '' and coalesce(s->>'alias','') = ''
     and (s->>'owner' is null or lower(s->>'owner') = public.my_tag()) and s->'deleted' is distinct from 'true'::jsonb
$$;
revoke all on function public.komik_my_chars() from public, anon;
grant execute on function public.komik_my_chars() to authenticated, service_role;

-- карточка своего персонажа: «живые» поля — из новой версии (нет поля — снято, как ds:null у клиента), остальное — старое
create or replace function public.komik_san_card(oc jsonb, nc jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare r jsonb := oc; f text; x numeric;
begin
  if nc is null or jsonb_typeof(nc) <> 'object' then return oc; end if;
  -- ХП, временные ХП, инициатива — числа в разумных пределах
  foreach f in array array['hp', 'thp', 'init'] loop
    if nc ? f then
      x := public.komik_num(nc->f);
      if x is not null and abs(x) <= 1000000 then r := r || jsonb_build_object(f, x); end if;
    else r := r - f; end if;
  end loop;
  -- спасброски от смерти {s,f,st}
  if nc ? 'ds' then
    if jsonb_typeof(nc->'ds') = 'object' then
      r := r || jsonb_build_object('ds', jsonb_strip_nulls(jsonb_build_object(
        's',  least(3, greatest(0, coalesce(public.komik_num(nc->'ds'->'s'), 0)))::integer,
        'f',  least(3, greatest(0, coalesce(public.komik_num(nc->'ds'->'f'), 0)))::integer,
        'st', case when public.komik_num(nc->'ds'->'st') in (0, 1) then public.komik_num(nc->'ds'->'st')::integer end)));
    end if;
  else r := r - 'ds'; end if;
  -- состояния [{t, b?}]
  if nc ? 'conds' then
    if jsonb_typeof(nc->'conds') = 'array' and jsonb_array_length(nc->'conds') <= 40 then
      r := r || jsonb_build_object('conds', coalesce((
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('t', left(c->>'t', 60), 'b', case when c->'b' in ('1'::jsonb, 'true'::jsonb) then 1 end)) order by i)
          from jsonb_array_elements(nc->'conds') with ordinality t(c, i)
         where jsonb_typeof(c) = 'object' and jsonb_typeof(c->'t') = 'string'), '[]'));
    end if;
  else r := r - 'conds'; end if;
  -- концентрация
  if nc ? 'conc' then
    if jsonb_typeof(nc->'conc') = 'boolean' then r := r || jsonb_build_object('conc', nc->'conc'); end if;
  else r := r - 'conc'; end if;
  return r;
end
$$;

create or replace function public.komik_san_tracker(o jsonb, n jsonb, me text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  res jsonb; k text; ob jsonb; nb jsonb; b jsonb; mp jsonb; pk text; pv jsonb;
  mine text[] := public.komik_my_chars();
begin
  res := case when jsonb_typeof(o) = 'object' then o else '{}'::jsonb end;
  if jsonb_typeof(n) is distinct from 'object' then return res; end if;
  -- версия строки и штамп — от клиента: на них держится compare-and-swap (kvCasUpdate)
  if public.komik_num(n->'rev') is not null then res := res || jsonb_build_object('rev', public.komik_num(n->'rev')); end if;
  if public.komik_num(n->'at')  is not null then res := res || jsonb_build_object('at',  public.komik_num(n->'at'));  end if;
  for k, ob in select * from jsonb_each(res) loop
    continue when jsonb_typeof(ob) <> 'object';
    nb := n->k;
    continue when nb is null or jsonb_typeof(nb) <> 'object';
    b := ob;
    if jsonb_typeof(ob->'list') = 'array' and jsonb_typeof(nb->'list') = 'array' and cardinality(mine) > 0 then
      b := jsonb_set(b, '{list}', coalesce((
        select jsonb_agg(case when jsonb_typeof(c) = 'object' and c->>'charId' = any(mine)
                              then public.komik_san_card(c, (select x from jsonb_array_elements(nb->'list') x
                                                              where jsonb_typeof(x) = 'object' and x->>'charId' = c->>'charId' limit 1))
                              else c end order by i)
          from jsonb_array_elements(ob->'list') with ordinality t(c, i)), '[]'));
    end if;
    if jsonb_typeof(nb->'mapPos') = 'object' and cardinality(mine) > 0 then
      mp := case when jsonb_typeof(ob->'mapPos') = 'object' then ob->'mapPos' else '{}'::jsonb end;
      for pk, pv in select * from jsonb_each(nb->'mapPos') loop
        if left(pk, 2) = 'c:' and substr(pk, 3) = any(mine) and jsonb_typeof(pv) = 'object'
           and public.komik_num(pv->'x') is not null and public.komik_num(pv->'y') is not null then
          mp := mp || jsonb_build_object(pk, jsonb_build_object('x', public.komik_num(pv->'x'), 'y', public.komik_num(pv->'y')));
        end if;
      end loop;
      b := jsonb_set(b, '{mapPos}', mp);
    end if;
    -- журнал доски: игроки дописывают в него свои действия, читает только ГМ (клиент держит хвост ≤ 24)
    if jsonb_typeof(nb->'log') = 'array' and jsonb_array_length(nb->'log') <= 40 and pg_column_size(nb->'log') <= 65536 then
      b := jsonb_set(b, '{log}', nb->'log');
    end if;
    if public.komik_num(nb->'joinAt') is not null then b := b || jsonb_build_object('joinAt', public.komik_num(nb->'joinAt')); end if;
    if public.komik_num(nb->'at')     is not null then b := b || jsonb_build_object('at',     public.komik_num(nb->'at'));     end if;
    res := jsonb_set(res, array[k], b);
  end loop;
  return res;
end
$$;

-- 4. Триггер-страж: игрок (не команда) пишет общую строку — собираем значение из старого + его разрешённых правок.
--    Upsert сайта (insert … on conflict do update) сначала проходит BEFORE INSERT: если строка уже есть,
--    там не трогаем — разберёт BEFORE UPDATE со старым значением (иначе excluded уже был бы «урезан до пустого»).
create or replace function public.komik_kv_guard() returns trigger
language plpgsql set search_path = '' as $$
declare me text; o jsonb;
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;     -- сервер, restore.sh, Studio — как есть
  if new.key not in ('comik:games:v1', 'comik:tracker:shared:v1', 'comik:users:v1') then return new; end if;
  if public.komik_is_team() then return new; end if;
  me := public.my_tag();
  if me = '' then return new; end if;                                            -- без тега RLS запись и так не пустит
  if tg_op = 'INSERT' then
    if exists (select 1 from public.kv where key = new.key) then return new; end if;
    o := null;
  else
    o := old.value;
  end if;
  new.value := case new.key
    when 'comik:games:v1'          then public.komik_san_games(o, new.value, me)
    when 'comik:tracker:shared:v1' then public.komik_san_tracker(o, new.value, me)
    when 'comik:users:v1'          then public.komik_san_users(o, new.value, me)
  end;
  return new;
end
$$;
drop trigger if exists komik_kv_guard on public.kv;
create trigger komik_kv_guard before insert or update on public.kv
  for each row execute function public.komik_kv_guard();

-- 5. Журнал правок
create table if not exists public.kv_history (
  id bigserial primary key,
  at timestamptz not null default now(),
  key text not null,
  op text not null,
  uid uuid,
  tag text,
  role text,
  old_value jsonb,
  old_size integer,
  new_size integer
);
create index if not exists kv_history_at on public.kv_history (at);
create index if not exists kv_history_key_at on public.kv_history (key, at desc);
alter table public.kv_history enable row level security;
revoke all on public.kv_history from anon, authenticated;
grant select on public.kv_history to authenticated;
grant all on public.kv_history to service_role;
drop policy if exists kv_history_team on public.kv_history;
create policy kv_history_team on public.kv_history for select to authenticated using (public.komik_is_team());

create or replace function public.komik_kv_journal() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text := coalesce(new.key, old.key);
begin
  if k like 'comik:img:%' then return null; end if;                               -- фото неизменны (ключ = хэш)
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then return null; end if;
  insert into public.kv_history (key, op, uid, tag, role, old_value, old_size, new_size)
  values (k, tg_op, auth.uid(), nullif(public.my_tag(), ''), coalesce(nullif(current_setting('role', true), 'none'), session_user),
          case when tg_op <> 'INSERT' and k <> 'comik:tracker:shared:v1'
                     and (pg_column_size(old.value) <= 65536
                          or not exists (select 1 from public.kv_history h where h.key = k and h.old_value is not null
                                                                             and h.at > now() - interval '15 minutes'))
               then old.value end,
          case when tg_op <> 'INSERT' then pg_column_size(old.value) end,
          case when tg_op <> 'DELETE' then pg_column_size(new.value) end);
  if random() < 0.02 then delete from public.kv_history where at < now() - interval '7 days'; end if;
  return null;
end
$$;
drop trigger if exists komik_kv_journal on public.kv;
create trigger komik_kv_journal after insert or update or delete on public.kv
  for each row execute function public.komik_kv_journal();

-- 6. Что игрок может писать (поверх 09-27): push:subs — больше нет, вместо неё своя push:sub:<тег>
create or replace function public.kv_player_cap(k text) returns integer
language sql stable as $$
  select case
    when public.my_tag() !~ '^[a-z0-9_]{4,32}$'        then null
    when k = 'comik:tracker:shared:v1'                  then 8388608    -- доска ходов (свои карточки — см. komik_kv_guard)
    when k = 'comik:games:v1'                           then 524288     -- своя запись на игру
    when k = 'comik:users:v1'                           then 262144     -- дописать себя в реестр
    when k = 'push:sub:'    || public.my_tag()          then 65536      -- свои пуш-подписки
    when k = 'comik:chars:' || public.my_tag()          then 10485760   -- свои листы персонажей
    when k = 'comik:bm:'    || public.my_tag()          then 262144     -- свои закладки
  end
$$;
revoke all on function public.kv_player_cap(text) from public, anon;
grant execute on function public.kv_player_cap(text) to authenticated, service_role;

-- 7. Чтение — белый список того, что показывает сайт; своё — владельцу; всё — команде
drop policy if exists kv_read on public.kv;
create policy kv_read on public.kv for select using (
  key in ('comik:archive:v1', 'comik:news:v1', 'comik:chrono:v1', 'comik:hero:v1', 'comik:projects:v1',
          'comik:games:v1', 'comik:tracker:shared:v1', 'comik:users:v1', 'comik:coreover:v1', 'comik:corehid:v1')
  or key like 'comik:img:%'
  or key like 'comik:trk:bg:%'
  or (public.my_tag() <> '' and key in ('comik:chars:' || public.my_tag(), 'comik:bm:' || public.my_tag(), 'push:sub:' || public.my_tag()))
  or public.komik_is_team()
);

-- витрина чужих листов: только то, что нужно доске и анонсам. Портрет — только ссылкой (kvimg:/файл сайта),
-- base64 внутри листа сюда не идёт. Вид работает от владельца (postgres) — видит все строки, но отдаёт только эти поля
create or replace function public.komik_char_pub(c jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(c) <> 'object' then null else jsonb_strip_nulls(jsonb_build_object(
    'id', c->'id', 'owner', c->'owner', 'alias', c->'alias', 'name', c->'name', 'player', c->'player',
    'ava', case when coalesce(c->>'ava','') ~ '^(kvimg:[0-9a-f]{32}|img/[A-Za-z0-9_./-]{1,200})$' then c->'ava' end,
    'role', c->'role', 'subcls', c->'subcls', 'origin', c->'origin', 'subrace', c->'subrace', 'level', c->'level',
    'hp', c->'hp', 'ac', c->'ac', 'init', c->'init', 'speed', c->'speed',
    'deleted', c->'deleted', 'createdAt', c->'createdAt', 'updatedAt', c->'updatedAt')) end
$$;
create or replace view public.kv_chars_pub with (security_barrier) as
  select k.key,
         jsonb_build_object('at', k.value->'at') || coalesce((
           select jsonb_object_agg(g.gk, (select coalesce(jsonb_agg(public.komik_char_pub(s)) filter (where jsonb_typeof(s) = 'object'), '[]'::jsonb)
                                            from jsonb_array_elements(g.gv) s))
             from jsonb_each(k.value) g(gk, gv) where jsonb_typeof(g.gv) = 'array'), '{}'::jsonb) as value
    from public.kv k
   where k.key like 'comik:chars:%' and jsonb_typeof(k.value) = 'object';
revoke all on public.kv_chars_pub from public;
grant select on public.kv_chars_pub to anon, authenticated, service_role;

-- 8. Пуш-подписки: общая строка → личные. Новые подписки сайт пишет в push:sub:<тег>; рассылка читает обе.
--    Один адрес (endpoint) — одна запись, самая свежая
insert into public.kv as t (key, value)
select 'push:sub:' || d.tag, jsonb_agg(d.s order by coalesce(public.komik_num(d.s->'at'), 0))
  from (select distinct on (lower(s->>'tag'), coalesce(s->>'endpoint', s::text)) lower(s->>'tag') as tag, s
          from public.kv k, jsonb_array_elements(case when jsonb_typeof(k.value) = 'array' then k.value else '[]'::jsonb end) s
         where k.key = 'push:subs' and jsonb_typeof(s) = 'object' and lower(coalesce(s->>'tag', '')) ~ '^[a-z0-9_]{4,32}$'
         order by lower(s->>'tag'), coalesce(s->>'endpoint', s::text), coalesce(public.komik_num(s->'at'), 0) desc) d
 group by d.tag
on conflict (key) do update set value = (
  select coalesce(jsonb_agg(x order by coalesce(public.komik_num(x->'at'), 0)), '[]')
    from (select distinct on (coalesce(x->>'endpoint', x::text)) x
            from jsonb_array_elements(case when jsonb_typeof(t.value) = 'array' then t.value else '[]'::jsonb end || excluded.value) x
           order by coalesce(x->>'endpoint', x::text), coalesce(public.komik_num(x->'at'), 0) desc) e);
update public.kv set value = '[]'::jsonb where key = 'push:subs' and value is distinct from '[]'::jsonb;

-- 9. Команда: каждый видит только свою строку devs (id чужих аккаунтов незачем). Правила kv ходят в devs
--    подзапросом от имени вошедшего — им нужна ровно своя строка
drop policy if exists devs_read on public.devs;
create policy devs_read on public.devs for select using (uid = auth.uid());

-- 10. Версия набора прав — сайт по ней понимает, что личные пуш-подписки уже есть
create or replace function public.komik_api_version() returns integer
language sql immutable set search_path = '' as $$ select 3 $$;
grant execute on function public.komik_api_version() to anon, authenticated, service_role;

-- 11. Итог
set local client_min_messages = notice;
do $$
declare n_sub int; n_hist int;
begin
  select count(*) into n_sub from public.kv where key like 'push:sub:%';
  select count(*) into n_hist from public.kv_history;
  raise notice 'Права 10-29: игрок меняет только своё; чтение — белым списком; личные пуш-подписки: % строк; журнал правок: % записей', n_sub, n_hist;
end
$$;

commit;

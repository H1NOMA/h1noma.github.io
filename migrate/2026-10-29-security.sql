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
--        · доска — у карточек СВОИХ персонажей ХП, временные ХП, инициативу, спасброски от смерти, состояния,
--          концентрацию; позицию своей фишки; дописать свои записи в журнал доски (читает только ГМ) — всё это
--          только за столом, где сидит его персонаж; отметку «постучался» joinAt — и на доске игры, на которую
--          записан. Чья карточка — по тегу ownTag, который ставит на неё ГМ при публикации (строку доски игрок
--          не меняет), у карточек без тега — по id листа, который есть только в его строке. Версию строки rev
--          ведёт сервер (прежняя + 1). Досок, чужих карточек, состава, раунда, фона игрок не трогает;
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
--      Витрина — только для чтения (права Supabase по умолчанию дали бы через неё писать в kv в обход правил).
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

-- Помощники стража — в своей схеме: PostgREST отдаёт наружу только public, так что вызвать их через API (и нагрузить
-- базу огромными аргументами) нельзя. Страж работает от имени пишущего — ему нужно право на схему и на вызов
create schema if not exists komik_priv;
revoke all on schema komik_priv from public;
grant usage on schema komik_priv to authenticated, service_role;
-- (черновые версии в public — если остались от проб)
drop function if exists public.komik_san_entry(jsonb, text), public.komik_san_games(jsonb, jsonb, text),
  public.komik_san_users(jsonb, jsonb, text), public.komik_my_chars(), public.komik_my_chars(text), public.komik_ids_alone(text[]),
  public.komik_san_card(jsonb, jsonb), public.komik_log_merge(jsonb, jsonb), public.komik_san_tracker(jsonb, jsonb, text);

-- 1. Расписание: запись игрока в сессии — только известные поля, безопасные значения (как gameClean на сайте)
create or replace function komik_priv.komik_san_entry(p jsonb, me text) returns jsonb
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

create or replace function komik_priv.komik_san_games(o jsonb, n jsonb, me text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  res jsonb := '[]'; s jsonb; ns jsonb; mine jsonb; was jsonb; others jsonb; nm jsonb; ntomb jsonb; otomb jsonb;
  seats integer; gone_o numeric; gone_n numeric; fresh_was numeric; fresh_mine numeric;
  now_ms numeric := floor(extract(epoch from now()) * 1000);
  day numeric := 86400000;
begin
  if jsonb_typeof(o) is distinct from 'array' then o := '[]'; end if;
  if jsonb_typeof(n) is distinct from 'array' then n := '[]'; end if;
  -- новая версия: id → живая сессия (первая), id надгробий; старая — id надгробий. Один проход, без поиска в цикле
  select coalesce(jsonb_object_agg(id, x), '{}') into nm
    from (select distinct on (x->>'id') x->>'id' as id, x from jsonb_array_elements(n) with ordinality t(x, i)
           where jsonb_typeof(x) = 'object' and coalesce(x->>'id', '') <> '' and x->'deleted' is distinct from 'true'::jsonb
           order by x->>'id', i) z;
  select coalesce(jsonb_object_agg(x->>'id', true), '{}') into ntomb from jsonb_array_elements(n) x
   where jsonb_typeof(x) = 'object' and x->'deleted' = 'true'::jsonb and coalesce(x->>'id', '') <> '';
  select coalesce(jsonb_object_agg(x->>'id', true), '{}') into otomb from jsonb_array_elements(o) x
   where jsonb_typeof(x) = 'object' and x->'deleted' = 'true'::jsonb and coalesce(x->>'id', '') <> '';
  for s in select x from jsonb_array_elements(o) x loop
    if jsonb_typeof(s) <> 'object' or coalesce(s->>'id', '') = '' then res := res || jsonb_build_array(s); continue; end if;
    if s->'deleted' = 'true'::jsonb then
      -- надгробие старше 90 дней (GAME_TOMB_TTL) сайт уже не пишет — уходит, если и новая версия его не несёт:
      -- иначе сайт игрока вечно видел бы «облако не такое, как у меня» и переписывал строку по кругу
      if coalesce(public.komik_num(s->'updatedAt'), 0) <= now_ms - 90 * day and not ntomb ? (s->>'id') then continue; end if;
      res := res || jsonb_build_array(s); continue;
    end if;
    if otomb ? (s->>'id') then continue; end if;      -- живая копия удалённой сессии: сайт её не показывает и не пишет
    ns := nm -> (s->>'id');
    if ns is null then res := res || jsonb_build_array(s); continue; end if;   -- клиент этой сессии ещё не видел
    others := coalesce((select jsonb_agg(p) from jsonb_array_elements(case when jsonb_typeof(s->'players') = 'array' then s->'players' else '[]' end) p
                        where lower(coalesce(p->>'tag', '')) <> me), '[]');
    was := (select p from jsonb_array_elements(case when jsonb_typeof(s->'players') = 'array' then s->'players' else '[]' end) p
             where lower(coalesce(p->>'tag', '')) = me limit 1);
    mine := (select p from jsonb_array_elements(case when jsonb_typeof(ns->'players') = 'array' then ns->'players' else '[]' end) p
              where jsonb_typeof(p) = 'object' and lower(coalesce(p->>'tag', '')) = me limit 1);
    gone_o := coalesce(public.komik_num(case when jsonb_typeof(s->'gone') = 'object' then s->'gone'->me end), 0);
    gone_n := public.komik_num(case when jsonb_typeof(ns->'gone') = 'object' then ns->'gone'->me end);
    fresh_was := greatest(coalesce(public.komik_num(was->'upd'), 0), coalesce(public.komik_num(was->'at'), 0));
    -- отметка снятия «из будущего» (часы устройства спешат) — считаем её «сейчас», если запись старше
    if gone_n is not null and gone_n > now_ms + day then gone_n := case when fresh_was < now_ms then now_ms end; end if;
    if mine is not null then
      mine := komik_priv.komik_san_entry(mine, me);
      if coalesce(public.komik_num(mine->'upd'), 0) > now_ms + day then mine := mine || jsonb_build_object('upd', now_ms); end if;
      if was is not null then mine := mine || jsonb_build_object('at', coalesce(was->'at', mine->'at'));   -- место в очереди своё, не переставить
      elsif coalesce(public.komik_num(mine->'at'), 0) > now_ms + day then mine := mine || jsonb_build_object('at', now_ms);
      end if;
      fresh_mine := greatest(coalesce(public.komik_num(mine->'upd'), 0), coalesce(public.komik_num(mine->'at'), 0));
      if fresh_mine <= greatest(gone_o, coalesce(gone_n, 0)) then mine := null; end if;   -- запись не новее снятия — устаревшая копия
    end if;
    if mine is not null and was is null then                                          -- новая запись — только на свободное место
      seats := nullif(left(regexp_replace(coalesce(s->>'seats', ''), '\D', '', 'g'), 4), '')::integer;
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
create or replace function komik_priv.komik_san_users(o jsonb, n jsonb, me text) returns jsonb
language sql stable set search_path = '' as $$
  select case
    when exists (select 1 from jsonb_array_elements(oo) u where lower(coalesce(u->>'tag','')) = me) then oo
    when jsonb_typeof(n) = 'array' and exists (select 1 from jsonb_array_elements(n) u where jsonb_typeof(u) = 'object' and lower(coalesce(u->>'tag','')) = me)
      then oo || jsonb_build_array(jsonb_build_object('tag', me, 'createdAt', floor(extract(epoch from now()) * 1000)))
    else oo end
  from (select case when jsonb_typeof(o) = 'array' then o else '[]'::jsonb end as oo) z
$$;

-- 3. Доска ходов. Чья карточка — решает тег ownTag на ней: его ставит ГМ при публикации доски (по владельцу листа),
--    а строку доски игрок не меняет. У карточек без тега (доска, опубликованная сайтом до 29.10) — id листа из своей
--    строки, которого нет ни в чьей другой строке листов: свою строку игрок пишет сам, и чужой id, вписанный туда,
--    так не пройдёт (а владелец листа при этом свою карточку тоже не правит — до первой публикации доски ГМом).
create or replace function komik_priv.komik_my_chars() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct s->>'id'), '{}')
    from public.kv k,
         jsonb_each(case when jsonb_typeof(k.value) = 'object' then k.value else '{}'::jsonb end) g(gk, gv),
         jsonb_array_elements(case when jsonb_typeof(gv) = 'array' then gv else '[]'::jsonb end) s
   where public.my_tag() <> '' and k.key = 'comik:chars:' || public.my_tag()
     and jsonb_typeof(s) = 'object' and coalesce(s->>'id','') <> '' and coalesce(s->>'alias','') = ''
     and (s->>'owner' is null or lower(s->>'owner') = public.my_tag()) and s->'deleted' is distinct from 'true'::jsonb
$$;
create or replace function komik_priv.komik_ids_alone(ids text[]) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(i), '{}') from unnest(ids[1:100]) i   -- страж передаёт несколько id; больше — не разбираем
   where public.my_tag() <> '' and not exists (
     select 1 from public.kv k
      where k.key like 'comik:chars:%' and k.key <> 'comik:chars:' || public.my_tag() and jsonb_typeof(k.value) = 'object'
        and jsonb_path_exists(k.value, '$.*[*] ? (@.id == $id)', jsonb_build_object('id', i)))
$$;

-- карточка своего персонажа: «живые» поля — из новой версии (нет поля — снято, как ds:null у клиента), остальное — старое
create or replace function komik_priv.komik_san_card(oc jsonb, nc jsonb) returns jsonb
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

-- журнал доски: прежние записи остаются, новые — дописываются (только известные поля); хвост — 24 последних по времени,
-- повторы (время + текст) — один раз, как в архиве ГМа (trkLogArc)
create or replace function komik_priv.komik_log_merge(ol jsonb, nl jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(e order by a nulls first), '[]') from (
    select e, a from (
      select distinct on (a, t) e, a, t from (
        select x as e, public.komik_num(x->'at') as a, x->>'t' as t
          from jsonb_array_elements(case when jsonb_typeof(ol) = 'array' then ol else '[]'::jsonb end) x
         where jsonb_typeof(x) = 'object'
        union all
        select jsonb_strip_nulls(jsonb_build_object('at', public.komik_num(x->'at'), 'k', left(x->>'k', 16), 't', left(x->>'t', 160))),
               public.komik_num(x->'at'), left(x->>'t', 160)
          from jsonb_array_elements(case when jsonb_typeof(nl) = 'array' then nl else '[]'::jsonb end) x
         where jsonb_typeof(x) = 'object' and public.komik_num(x->'at') is not null and jsonb_typeof(x->'t') = 'string') u
      order by a, t) d
    order by a desc nulls last limit 24) z
$$;

create or replace function komik_priv.komik_san_tracker(o jsonb, n jsonb, me text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  res jsonb; k text; ob jsonb; nb jsonb; b jsonb; mp jsonb; pk text; pv jsonb; nl jsonb;
  myids text[]; mine text[]; unst text[];
  now_ms numeric := floor(extract(epoch from now()) * 1000);
begin
  res := case when jsonb_typeof(o) = 'object' then o else '{}'::jsonb end;
  if jsonb_typeof(n) is distinct from 'object' then return res; end if;
  -- версию строки ведёт сервер: ровно прежняя + 1. Сайт (kvCasUpdate) пишет то же самое, а кривая версия от игрока
  -- (0, 6.5, 1e23) сломала бы условную запись всем, и ГМу тоже
  res := res || jsonb_build_object('rev', case when coalesce(res->>'rev', '') ~ '^\d{1,15}$' then (res->>'rev')::bigint + 1 else 1 end);
  if public.komik_num(n->'at') is not null then res := res || jsonb_build_object('at', least(public.komik_num(n->'at'), now_ms + 86400000)); end if;
  for k, ob in select * from jsonb_each(res) loop
    continue when jsonb_typeof(ob) <> 'object' or jsonb_typeof(ob->'list') <> 'array' or jsonb_array_length(ob->'list') > 300;
    nb := n->k;
    continue when nb is null or jsonb_typeof(nb) <> 'object' or nb = ob;
    -- свои карточки этой доски
    select coalesce(array_agg(c->>'charId') filter (where lower(c->>'ownTag') = me), '{}'),
           coalesce(array_agg(c->>'charId') filter (where coalesce(c->>'ownTag', '') = ''), '{}')
      into mine, unst
      from jsonb_array_elements(ob->'list') c
     where jsonb_typeof(c) = 'object' and coalesce(c->>'charId', '') <> '' and c->'foe' is distinct from 'true'::jsonb;
    if cardinality(unst) > 0 then
      if myids is null then myids := komik_priv.komik_my_chars(); end if;
      unst := array(select unnest(unst) intersect select unnest(myids));
      if cardinality(unst) > 0 then mine := mine || komik_priv.komik_ids_alone(unst); end if;
    end if;
    b := ob;
    -- «постучался»: записался на игру этой доски, а карточки ещё нет — ГМ досадит (trkPartyCatchup)
    if public.komik_num(nb->'joinAt') is not null and (cardinality(mine) > 0 or exists (
         select 1 from public.kv g, jsonb_array_elements(case when jsonb_typeof(g.value) = 'array' then g.value else '[]'::jsonb end) s,
                       jsonb_array_elements(case when jsonb_typeof(s->'players') = 'array' then s->'players' else '[]'::jsonb end) p
          where g.key = 'comik:games:v1' and coalesce(ob->>'party', '') <> '' and s->>'id' = ob->>'party'
            and jsonb_typeof(p) = 'object' and lower(coalesce(p->>'tag', '')) = me)) then
      b := b || jsonb_build_object('joinAt', least(public.komik_num(nb->'joinAt'), now_ms + 86400000));
    end if;
    if cardinality(mine) > 0 then
      -- живые поля своих карточек
      if jsonb_typeof(nb->'list') = 'array' and jsonb_array_length(nb->'list') <= 300 then
        nl := coalesce((select jsonb_object_agg(id, x) from (
                select distinct on (x->>'charId') x->>'charId' as id, x from jsonb_array_elements(nb->'list') with ordinality t(x, i)
                 where jsonb_typeof(x) = 'object' and x->>'charId' = any(mine) order by x->>'charId', i) z), '{}');
        b := jsonb_set(b, '{list}', (select jsonb_agg(case when jsonb_typeof(c) = 'object' and c->>'charId' = any(mine) and nl ? (c->>'charId')
                                                           then komik_priv.komik_san_card(c, nl->(c->>'charId')) else c end order by i)
                                       from jsonb_array_elements(ob->'list') with ordinality t(c, i)));
      end if;
      -- своя фишка на карте (ключ c:<id> — только своей карточки этой доски)
      if jsonb_typeof(nb->'mapPos') = 'object' then
        mp := case when jsonb_typeof(ob->'mapPos') = 'object' then ob->'mapPos' else '{}'::jsonb end;
        foreach pk in array mine loop
          pv := nb->'mapPos'->('c:' || pk);
          if jsonb_typeof(pv) = 'object' and public.komik_num(pv->'x') is not null and public.komik_num(pv->'y') is not null then
            mp := mp || jsonb_build_object('c:' || pk, jsonb_build_object('x', public.komik_num(pv->'x'), 'y', public.komik_num(pv->'y')));
          end if;
        end loop;
        b := jsonb_set(b, '{mapPos}', mp);
      end if;
      -- журнал доски: игрок дописывает свои действия (урон, броски), читает только ГМ
      if jsonb_typeof(nb->'log') = 'array' and jsonb_array_length(nb->'log') <= 40 then
        b := jsonb_set(b, '{log}', komik_priv.komik_log_merge(ob->'log', nb->'log'));
      end if;
      if public.komik_num(nb->'at') is not null then b := b || jsonb_build_object('at', least(public.komik_num(nb->'at'), now_ms + 86400000)); end if;
    end if;
    res := jsonb_set(res, array[k], b);
  end loop;
  return res;
end
$$;

-- помощники стража вызываются только из него (от имени пишущего игрока)
do $$
declare f text;
begin
  foreach f in array array['komik_priv.komik_san_entry(jsonb,text)', 'komik_priv.komik_san_games(jsonb,jsonb,text)', 'komik_priv.komik_san_users(jsonb,jsonb,text)',
                           'komik_priv.komik_my_chars()', 'komik_priv.komik_ids_alone(text[])', 'komik_priv.komik_san_card(jsonb,jsonb)',
                           'komik_priv.komik_log_merge(jsonb,jsonb)', 'komik_priv.komik_san_tracker(jsonb,jsonb,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end
$$;

-- 4. Триггер-страж: игрок (не команда) пишет общую строку — собираем значение из ТЕКУЩЕГО + его разрешённых правок.
--    Upsert сайта (insert … on conflict do update) проходит и BEFORE INSERT, и BEFORE UPDATE: в обоих чистим
--    относительно текущей строки (повторная чистка ничего не меняет), а строки ещё нет — относительно пустой.
create or replace function public.komik_kv_guard() returns trigger
language plpgsql set search_path = '' as $$
declare me text; o jsonb;
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;     -- сервер, restore.sh, Studio — как есть
  if new.key not in ('comik:games:v1', 'comik:tracker:shared:v1', 'comik:users:v1') then return new; end if;
  if public.komik_is_team() then return new; end if;
  me := public.my_tag();
  if me = '' then return new; end if;                                            -- без тега RLS запись и так не пустит
  -- раздутое значение не разбираем вовсе (правило записи проверяет размер уже очищенного): иначе один запрос на
  -- несколько мегабайт держал бы процессор базы секундами
  if pg_column_size(new.value) > coalesce(public.kv_player_cap(new.key), 0)
     or (jsonb_typeof(new.value) = 'array' and jsonb_array_length(new.value) > 2000) then
    raise exception 'kv: слишком большое значение для %', new.key using errcode = '54000';
  end if;
  if tg_op = 'INSERT' then o := (select value from public.kv where key = new.key); else o := old.value; end if;
  new.value := case new.key
    when 'comik:games:v1'          then komik_priv.komik_san_games(o, new.value, me)
    when 'comik:tracker:shared:v1' then komik_priv.komik_san_tracker(o, new.value, me)
    when 'comik:users:v1'          then komik_priv.komik_san_users(o, new.value, me)
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
-- только чтение: вид из одной таблицы Postgres считает «обновляемым», а права Supabase по умолчанию (ALL для anon и
-- authenticated на всё новое в public) пустили бы через него удаление и запись строк kv в обход правил — вид работает
-- от владельца. Поэтому права — только select, а любая запись в вид — ошибка
revoke all on public.kv_chars_pub from public, anon, authenticated;
grant select on public.kv_chars_pub to anon, authenticated, service_role;
create or replace function public.komik_read_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'kv_chars_pub — только для чтения' using errcode = '42501';
end
$$;
drop trigger if exists kv_chars_pub_ro on public.kv_chars_pub;
create trigger kv_chars_pub_ro instead of insert or update or delete on public.kv_chars_pub
  for each row execute function public.komik_read_only();

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

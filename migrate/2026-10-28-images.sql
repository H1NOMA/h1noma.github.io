-- ═══════════════════════════════════════════════════════════════════════════════
--  КОМИК · 2026-10-28 · фото отдельными строками comik:img:<хэш>
--
--  Запуск:  docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < migrate/2026-10-28-images.sql
--       (push.sh применяет её сам на шаге 5/5 — последней, после 09-27, в той же транзакции).
--  Идемпотентно.
--
--  Зачем. Фото карточек архива, новостей и портреты листов лежали base64 прямо в общих строках: архив весил
--  5,9 МБ (98 % — картинки), и каждый посетитель качал его целиком при каждом заходе. Теперь сайт кладёт
--  картинку в отдельную строку comik:img:<хэш>, а в карточку — ссылку «kvimg:<хэш>»; качается картинка,
--  только когда попала на экран, и один раз на устройство.
--
--  Что делает:
--   1) kv_img_ok(key, value): строка comik:img:<хэш> — это строка data:image/(jpeg|png|webp|gif);base64,…
--      и <хэш> — первые 32 знака SHA-256 от неё. Подменить картинку под чужим хэшем нельзя никому
--      (ограничительные правила kv_img_hash_ins/_upd — для всех ролей API, и для команды тоже);
--   2) игрок может писать строки comik:img:* (свои портреты) — вставка и правка, до 1,5 МБ на строку,
--      без удаления. Правка такой строки ничего не меняет: под тем же хэшем то же содержимое.
--  Команда пишет их и без этой миграции (kv_write_dev), но без проверки хэша.
-- ═══════════════════════════════════════════════════════════════════════════════
begin;
set local client_min_messages = warning;

create or replace function public.kv_img_ok(k text, v jsonb) returns boolean
language sql immutable as $$
  select k not like 'comik:img:%'
      or (jsonb_typeof(v) = 'string'
          and (v #>> '{}') ~ '^data:image/(jpeg|png|webp|gif);base64,'
          and k = 'comik:img:' || left(encode(sha256(convert_to(v #>> '{}', 'UTF8')), 'hex'), 32))
$$;
grant execute on function public.kv_img_ok(text, jsonb) to anon, authenticated, service_role;

-- 1. Проверка хэша — ограничительная (AND с любыми разрешающими правилами), для всех ролей API
drop policy if exists kv_img_hash_ins on public.kv;
create policy kv_img_hash_ins on public.kv as restrictive for insert to anon, authenticated
  with check (public.kv_img_ok(key, value));
drop policy if exists kv_img_hash_upd on public.kv;
create policy kv_img_hash_upd on public.kv as restrictive for update to anon, authenticated
  using (true) with check (public.kv_img_ok(key, value));

-- 2. Игроку — строки картинок (тег по правилам сайта, как в kv_player_cap; потолок 1,5 МБ)
drop policy if exists kv_img_player_ins on public.kv;
create policy kv_img_player_ins on public.kv for insert to authenticated
  with check (key like 'comik:img:%' and public.my_tag() ~ '^[a-z0-9_]{4,32}$' and pg_column_size(value) <= 1572864);
drop policy if exists kv_img_player_upd on public.kv;
create policy kv_img_player_upd on public.kv for update to authenticated
  using      (key like 'comik:img:%' and public.my_tag() ~ '^[a-z0-9_]{4,32}$')
  with check (key like 'comik:img:%' and pg_column_size(value) <= 1572864);

-- 3. Итог
set local client_min_messages = notice;
do $$
declare n int; bad int;
begin
  select count(*), count(*) filter (where not public.kv_img_ok(key, value)) into n, bad from public.kv where key like 'comik:img:%';
  raise notice 'Фото отдельными строками: % шт.%', n, case when bad > 0 then ' ⚠ с неверным хэшем: ' || bad else '' end;
end
$$;

commit;

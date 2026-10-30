-- Минимальная «Supabase» для проверки миграций migrate/*.sql на чистом Postgres (tests/sql/run.sh):
-- роли API, auth.jwt()/auth.uid() из request.jwt.claims, auth.users (и что на него ссылается), таблица kv, публикация realtime.
-- роли общие на весь кластер: при повторном прогоне уже есть
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then create role supabase_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end $$;
-- как в Supabase: всё новое в public (таблицы, виды, функции, последовательности) сразу получает права anon и
-- authenticated — миграции обязаны отбирать лишнее сами (без этого здесь не видно дыр вроде записи через вид)
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create schema auth;
create table auth.users (id uuid primary key, email text, created_at timestamptz default now());
-- то, что ссылается на аккаунт, как в GoTrue: identities, sessions, mfa — каскадом от users; refresh_tokens — от сессии,
-- а user_id у них строкой без внешнего ключа (у старых токенов сессии нет)
create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'email', identity_data jsonb);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now());
create table auth.mfa_amr_claims (id uuid primary key default gen_random_uuid(), session_id uuid not null references auth.sessions(id) on delete cascade,
  authentication_method text not null);
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade);
create table auth.refresh_tokens (id bigserial primary key, token varchar(255), user_id varchar(255), revoked boolean,
  session_id uuid references auth.sessions(id) on delete cascade);
-- таблицы auth — у GoTrue (supabase_auth_admin): регистрация идёт от него, и триггеры на auth.users работают от него
do $$ declare t text; begin
  foreach t in array array['users', 'identities', 'sessions', 'mfa_amr_claims', 'mfa_factors', 'refresh_tokens'] loop
    execute format('alter table auth.%I owner to supabase_auth_admin', t);
  end loop;
end $$;
grant usage on schema auth to supabase_auth_admin;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt()->>'sub', '')::uuid $$;
grant usage on schema auth, public to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create table public.kv (key text primary key, value jsonb);
grant all on public.kv to anon, authenticated, service_role;
create publication supabase_realtime;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'hinoma@komikdnd.ru'),
  ('00000000-0000-0000-0000-0000000000a2', 'herr_teo@komikdnd.ru'),
  ('00000000-0000-0000-0000-0000000000a3', 'arlissss@komikdnd.ru'),
  ('00000000-0000-0000-0000-0000000000b1', 'testplayer@komikdnd.ru'),
  ('00000000-0000-0000-0000-0000000000b2', 'player_two@komikdnd.ru');

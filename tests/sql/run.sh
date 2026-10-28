#!/usr/bin/env bash
# Проверка миграций migrate/*.sql на чистом Postgres: применяем все одной транзакцией (как push.sh), дважды
# (идемпотентность), и пробуем записи от имени аноним/игрок/команда.
#   PGHOST=… PGPORT=… PGUSER=postgres bash tests/sql/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=komik_mig_test
MIGS=$(sed -n 's/^MIGS="\(.*\)"$/\1/p' migrate/push.sh)
psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
q(){ psql -q -X -v ON_ERROR_STOP=1 -d $DB "$@"; }
q -f tests/sql/supabase_stub.sql >/dev/null
mig_sql(){ echo 'begin;'; for f in $MIGS; do sed -e '/^begin;$/d' -e '/^commit;$/d' "migrate/$f"; done; echo 'commit;'; }
echo "· миграции ($MIGS) — первый запуск"; mig_sql | q 2>&1 | sed 's/^/  /'
echo "· повторный запуск"; mig_sql | q 2>&1 | grep -v 'already exists\|does not exist' | sed 's/^/  /' || true

FAILS=0
# try <ожидание ok|fail> <кто: anon|тег> <описание> <sql>
# update/delete, отфильтрованные правилами, проходят «успешно», не задев строк, — поэтому их пишем через
# «with x as (… returning 1) select 1/count(*)»: ноль строк = деление на ноль = fail
try(){
  local want=$1 who=$2 what=$3 sql=$4 claims role got
  if [ "$who" = anon ]; then role=anon; claims='{"role":"anon"}'
  else role=authenticated; claims=$(q -tAc "select json_build_object('role','authenticated','email',email,'sub',id)::text from auth.users where email='$who@komikdnd.ru'"); fi
  if out=$(q -tA -c "begin; set local role $role; select set_config('request.jwt.claims', '$claims', true); $sql; commit;" 2>&1); then got=ok; else got=fail; fi
  if [ "$got" = "$want" ]; then echo "  ✓ $what"; else echo "  ✗ $what (ждали $want, вышло $got: $(tail -1 <<< "$out"))"; FAILS=$((FAILS+1)); fi
}
IMG="'data:image/png;base64,iVBORw0KGgo='"
IMG2="'data:image/png;base64,AAAAAAAA'"
K="'comik:img:' || left(encode(sha256(convert_to($IMG, 'UTF8')), 'hex'), 32)"
K2="'comik:img:' || left(encode(sha256(convert_to($IMG2, 'UTF8')), 'hex'), 32)"
echo "· права записи"
try ok   testplayer "игрок: фото под верным хэшем" "insert into kv values ($K, to_jsonb($IMG::text))"
try ok   testplayer "игрок: то же фото повторно (upsert)" "insert into kv values ($K, to_jsonb($IMG::text)) on conflict (key) do update set value = excluded.value"
try fail testplayer "игрок: фото под чужим хэшем" "insert into kv values ('comik:img:0123456789abcdef0123456789abcdef', to_jsonb($IMG::text))"
try fail testplayer "игрок: подменить содержимое строки фото" "update kv set value = to_jsonb($IMG2::text) where key = $K"
try fail testplayer "игрок: не картинка под ключом фото" "insert into kv values ('comik:img:' || left(encode(sha256(convert_to('hello', 'UTF8')), 'hex'), 32), to_jsonb('hello'::text))"
try fail testplayer "игрок: фото больше 1,5 МБ" "insert into kv select 'comik:img:' || left(encode(sha256(convert_to(v, 'UTF8')), 'hex'), 32), to_jsonb(v) from (select 'data:image/png;base64,' || string_agg(md5(i::text), '') v from generate_series(1, 60000) i) s"
try fail testplayer "игрок: удалить строку фото" "with x as (delete from kv where key = $K returning 1) select 1/count(*) from x"
try ok   testplayer "игрок: свои листы" "insert into kv values ('comik:chars:testplayer', '{\"at\":1}')"
try fail testplayer "игрок: чужие листы" "insert into kv values ('comik:chars:hinoma', '{\"at\":1}')"
try fail testplayer "игрок: архив" "insert into kv values ('comik:archive:v1', '{}')"
try ok   hinoma     "команда: архив" "insert into kv values ('comik:archive:v1', '{}')"
try ok   hinoma     "команда: фото под верным хэшем" "insert into kv values ($K2, to_jsonb($IMG2::text))"
try fail hinoma     "команда: фото под чужим хэшем" "insert into kv values ('comik:img:fedcba9876543210fedcba9876543210', to_jsonb($IMG::text))"
try ok   hinoma     "команда: чужие листы (условная запись портретов)" "with x as (update kv set value = '{\"at\":1,\"classic\":[]}' where key = 'comik:chars:testplayer' and value->>'at' = '1' returning 1) select 1/count(*) from x"
try fail hinoma     "команда: условная запись, если строку уже поменяли" "with x as (update kv set value = '{\"at\":2}' where key = 'comik:chars:testplayer' and value->>'at' = '0' returning 1) select 1/count(*) from x"
try fail anon       "аноним: фото" "insert into kv values ($K2 || 'x', to_jsonb($IMG2::text))"
try fail anon       "аноним: листы" "insert into kv values ('comik:chars:anon', '{}')"
echo
[ $FAILS = 0 ] && echo "ИТОГ: всё прошло" || { echo "ИТОГ: провалов $FAILS"; exit 1; }

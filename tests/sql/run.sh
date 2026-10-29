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
# общая строка пуш-подписок до миграций — 10-29 раскладывает её по личным push:sub:<тег>
q -c "insert into kv values ('push:subs', '[{\"tag\":\"testplayer\",\"endpoint\":\"e1\",\"at\":1},{\"tag\":\"TestPlayer\",\"endpoint\":\"e1\",\"at\":2},{\"tag\":\"hinoma\",\"endpoint\":\"e2\"},{\"tag\":\"../x\",\"endpoint\":\"e3\"}]')" >/dev/null
mig_sql(){ echo 'begin;'; for f in $MIGS; do sed -e '/^begin;$/d' -e '/^commit;$/d' "migrate/$f"; done; echo 'commit;'; }
echo "· миграции ($MIGS) — первый запуск"; mig_sql | q 2>&1 | sed 's/^/  /'
echo "· повторный запуск"; mig_sql | q 2>&1 | grep -v 'already exists\|does not exist' | sed 's/^/  /' || true

FAILS=0
# try <ожидание ok|fail> <кто: anon|тег> <описание> <sql>
# update/delete, отфильтрованные правилами, проходят «успешно», не задев строк, — поэтому их пишем через
# «with x as (… returning 1) select 1/count(*)»: ноль строк = деление на ноль = fail
as(){   # «войти» от имени: роль API и токен
  local who=$1 claims role
  if [ "$who" = anon ]; then role=anon; claims='{"role":"anon"}'
  else role=authenticated; claims=$(q -tAc "select json_build_object('role','authenticated','email',email,'sub',id)::text from auth.users where email='$who@komikdnd.ru'"); fi
  echo "set local role $role; set local request.jwt.claims to '$claims';"
}
try(){
  local want=$1 who=$2 what=$3 sql=$4 got
  if out=$(q -tA -c "begin; $(as "$who") $sql; commit;" 2>&1); then got=ok; else got=fail; fi
  if [ "$got" = "$want" ]; then echo "  ✓ $what"; else echo "  ✗ $what (ждали $want, вышло $got: $(tail -1 <<< "$out"))"; FAILS=$((FAILS+1)); fi
}
# val <кто: anon|тег|postgres> <sql> — что вернёт запрос; eq <описание> <получили> <ждали>
val(){ if [ "$1" = postgres ]; then q -tA -c "$2" 2>&1; else q -tA -c "begin; $(as "$1") $2; commit;" 2>&1; fi; }
eq(){ if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1 (ждали «$3», вышло «$2»)"; FAILS=$((FAILS+1)); fi; }
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

# ── 10-29: игрок меняет в общих строках только своё; чтение белым списком; журнал ──
NOW="(extract(epoch from now()) * 1000)::bigint"
UPS="on conflict (key) do update set value = excluded.value"
q -c "insert into kv values ('comik:chars:testplayer', '{\"at\":1,\"classic\":[{\"id\":\"pc1\",\"owner\":\"testplayer\",\"name\":\"Тест\",\"bio\":\"тайна\",\"ava\":\"data:image/png;base64,AAAA\",\"hp\":10,\"level\":3}]}') $UPS" \
  -c "insert into kv values ('comik:chars:hinoma', '{\"at\":1,\"classic\":[{\"id\":\"npc1\",\"name\":\"Гоблин\",\"notes\":\"спойлер\",\"ava\":\"kvimg:0123456789abcdef0123456789abcdef\"}]}') $UPS" \
  -c "insert into kv values ('comik:games:v1', '[{\"id\":\"g1\",\"title\":\"Игра\",\"seats\":\"2\",\"players\":[{\"tag\":\"herr_teo\",\"name\":\"Тео\",\"at\":100}]},{\"id\":\"g2\",\"seats\":\"1\",\"players\":[{\"tag\":\"herr_teo\",\"at\":100}]}]') $UPS" \
  -c "insert into kv values ('comik:tracker:shared:v1', '{\"rev\":1,\"at\":1,\"classic::hinoma\":{\"list\":[{\"charId\":\"pc1\",\"name\":\"Тест\",\"hp\":10,\"ds\":{\"s\":1,\"f\":0}},{\"charId\":\"npc1\",\"name\":\"Гоблин\",\"hp\":7}],\"round\":1,\"mapPos\":{\"c:npc1\":{\"x\":1,\"y\":1}}}}') $UPS" \
  -c "insert into kv values ('comik:users:v1', '[{\"tag\":\"hinoma\",\"createdAt\":1}]') $UPS" >/dev/null
G="(select value v from kv where key = 'comik:games:v1') z"
T="(select value v from kv where key = 'comik:tracker:shared:v1') z"

echo "· расписание: игрок — только своя запись"
try ok testplayer "игрок: записаться (весь массив, заодно правит чужое)" "insert into kv values ('comik:games:v1', '[{\"id\":\"g1\",\"title\":\"ВЗЛОМ\",\"seats\":\"9\",\"players\":[{\"tag\":\"testplayer\",\"name\":\"Т\",\"charId\":\"pc1\",\"at\":2000,\"upd\":2000,\"evil\":1,\"bg\":\"red;x:url(y)\"}]},{\"id\":\"g3\",\"players\":[]}]') $UPS"
eq "запись есть, чужая цела, поля сессии и новые сессии не прошли" \
   "$(val postgres "select v->0->>'title', v->0->>'seats', v->0->'players'->0->>'tag', v->0->'players'->1->>'tag', v->0->'players'->1 ? 'evil', v->0->'players'->1 ? 'bg', jsonb_array_length(v), jsonb_array_length(v->1->'players') from $G")" \
   "Игра|2|herr_teo|testplayer|f|f|2|1"
try ok testplayer "игрок: записаться в полную игру" "insert into kv select key, jsonb_set(value, '{1,players}', (value->1->'players') || '[{\"tag\":\"testplayer\",\"at\":3000,\"upd\":3000}]') from kv where key = 'comik:games:v1' $UPS"
eq "сверх мест не записался" "$(val postgres "select jsonb_array_length(v->1->'players') from $G")" "1"
try ok testplayer "игрок: снять чужую запись своей отметкой gone" "insert into kv select key, jsonb_set(jsonb_set(value, '{0,players}', '[]'), '{0,gone}', jsonb_build_object('herr_teo', $NOW)) from kv where key = 'comik:games:v1' $UPS"
eq "чужая запись на месте, чужой отметки нет" "$(val postgres "select jsonb_array_length(v->0->'players'), coalesce(v->0->'gone' ? 'herr_teo', false) from $G")" "2|f"
try ok testplayer "игрок: стереть расписание update'ом" "update kv set value = '[]' where key = 'comik:games:v1'"
eq "расписание цело" "$(val postgres "select jsonb_array_length(v) from $G")" "2"
try ok testplayer "игрок: снять свою запись" "insert into kv select key, jsonb_set(jsonb_set(value, '{0,players}', '[{\"tag\":\"herr_teo\",\"name\":\"Тео\",\"at\":100}]'), '{0,gone}', jsonb_build_object('testplayer', $NOW)) from kv where key = 'comik:games:v1' $UPS"
eq "своя снята, отметка стоит" "$(val postgres "select jsonb_array_length(v->0->'players'), v->0->'gone' ? 'testplayer' from $G")" "1|t"
try ok testplayer "игрок: старая копия записи (старее отметки)" "insert into kv select key, jsonb_set(value, '{0,players}', (value->0->'players') || '[{\"tag\":\"testplayer\",\"at\":2000,\"upd\":2000}]') from kv where key = 'comik:games:v1' $UPS"
eq "не воскресла" "$(val postgres "select jsonb_array_length(v->0->'players') from $G")" "1"
try ok herr_teo "команда: пишет расписание как есть" "update kv set value = jsonb_set(value, '{0,title}', '\"Новая\"') where key = 'comik:games:v1'"
eq "правка команды прошла" "$(val postgres "select v->0->>'title' from $G")" "Новая"

echo "· доска ходов: игрок — только живые поля своих карточек"
try ok testplayer "игрок: пишет доску целиком (своя карточка, чужая, раунд, новая доска, фишки, журнал)" "update kv set value = '{\"rev\":2,\"at\":5,\"classic::hinoma\":{\"list\":[{\"charId\":\"pc1\",\"name\":\"ВЗЛОМ\",\"hp\":3,\"conds\":[{\"t\":\"Отравлен\",\"b\":true,\"x\":1}],\"conc\":true},{\"charId\":\"npc1\",\"hp\":0}],\"round\":9,\"mapPos\":{\"c:pc1\":{\"x\":2,\"y\":3},\"c:npc1\":{\"x\":9,\"y\":9}},\"log\":[{\"at\":1,\"t\":\"урон\"}],\"joinAt\":77},\"evil::board\":{\"list\":[]}}' where key = 'comik:tracker:shared:v1' and value->>'rev' = '1'"
eq "своя: ХП, состояния, концентрация, спасброски сняты; имя прежнее" \
   "$(val postgres "select v->>'rev', v#>>'{classic::hinoma,list,0,hp}', v#>>'{classic::hinoma,list,0,name}', v#>'{classic::hinoma,list,0}' ? 'ds', v#>>'{classic::hinoma,list,0,conds}', v#>>'{classic::hinoma,list,0,conc}' from $T")" \
   '2|3|Тест|f|[{"b": 1, "t": "Отравлен"}]|true'
eq "чужая карточка, раунд, чужая фишка — прежние; своя фишка, журнал, стук — прошли; новой доски нет" \
   "$(val postgres "select v#>>'{classic::hinoma,list,1,hp}', v#>>'{classic::hinoma,round}', v#>>'{classic::hinoma,mapPos,c:pc1,x}', v#>>'{classic::hinoma,mapPos,c:npc1,x}', jsonb_array_length(v#>'{classic::hinoma,log}'), v#>>'{classic::hinoma,joinAt}', v ? 'evil::board' from $T")" \
   "7|1|2|1|1|77|f"
try ok testplayer "игрок: ХП строкой-мусором" "update kv set value = jsonb_set(jsonb_set(value, '{rev}', '3'), '{classic::hinoma,list,0,hp}', '\"много\"') where key = 'comik:tracker:shared:v1'"
eq "мусор не прошёл" "$(val postgres "select v->>'rev', v#>>'{classic::hinoma,list,0,hp}' from $T")" "3|3"
try ok herr_teo "команда: раунд" "update kv set value = jsonb_set(value, '{classic::hinoma,round}', '2') where key = 'comik:tracker:shared:v1'"
eq "правка команды прошла" "$(val postgres "select v#>>'{classic::hinoma,round}' from $T")" "2"

echo "· реестр логинов: игрок только дописывает себя"
try ok testplayer "игрок: пишет реестр из себя одного (+лишнее поле)" "insert into kv values ('comik:users:v1', '[{\"tag\":\"testplayer\",\"isAdmin\":true}]') $UPS"
eq "все на месте, лишнего нет" "$(val postgres "select string_agg(u->>'tag', ',' order by u->>'tag'), bool_or(u ? 'isAdmin') from kv, jsonb_array_elements(value) u where key = 'comik:users:v1'")" "hinoma,testplayer|f"
q -c "delete from kv where key = 'comik:users:v1'" >/dev/null
try ok testplayer "игрок: создаёт реестр с чужим тегом" "insert into kv values ('comik:users:v1', '[{\"tag\":\"testplayer\"},{\"tag\":\"evil\"}]')"
eq "только он сам" "$(val postgres "select string_agg(u->>'tag', ',') from kv, jsonb_array_elements(value) u where key = 'comik:users:v1'")" "testplayer"

echo "· пуш-подписки"
eq "общая строка разложена по личным (без дублей, кривой тег отброшен) и очищена" \
   "$(val postgres "select string_agg(key || '=' || jsonb_array_length(value), ',' order by key) from kv where key like 'push:sub%'")" \
   "push:sub:hinoma=1,push:sub:testplayer=1,push:subs=0"
try ok   testplayer "игрок: своя push:sub" "insert into kv values ('push:sub:testplayer', '[{\"endpoint\":\"e9\"}]') $UPS"
try fail testplayer "игрок: чужая push:sub" "insert into kv values ('push:sub:hinoma', '[]') $UPS"
try fail testplayer "игрок: общая push:subs" "insert into kv values ('push:subs', '[{\"endpoint\":\"e9\"}]') $UPS"

echo "· чтение"
eq "аноним: чужие листы — нет" "$(val anon "select count(*) from kv where key like 'comik:chars:%'")" "0"
eq "аноним: расписание, доска, реестр — да" "$(val anon "select count(*) from kv where key in ('comik:games:v1', 'comik:tracker:shared:v1', 'comik:users:v1')")" "3"
eq "аноним: пуш-подписки — нет" "$(val anon "select count(*) from kv where key like 'push:%'")" "0"
eq "игрок: свои листы и подписки — да, чужие — нет" "$(val testplayer "select string_agg(key, ',' order by key) from kv where key like 'comik:chars:%' or key like 'push:%'")" "comik:chars:testplayer,push:sub:testplayer"
eq "команда: всё" "$(val herr_teo "select count(*) from kv where key like 'comik:chars:%' or key like 'push:%'")" "5"
eq "витрина: имя и уровень есть; биографии, заметок, base64-портрета нет; kvimg-портрет есть" \
   "$(val anon "select string_agg(value#>>'{classic,0,name}' || ':' || coalesce(value#>>'{classic,0,level}','-') || ':' || (value#>'{classic,0}' ? 'bio' or value#>'{classic,0}' ? 'notes') || ':' || coalesce(value#>>'{classic,0,ava}','-'), ',' order by key) from kv_chars_pub")" \
   "Гоблин:-:false:kvimg:0123456789abcdef0123456789abcdef,Тест:3:false:-"
eq "аноним: devs — ничего" "$(val anon "select count(*) from devs")" "0"
eq "игрок: devs — ничего" "$(val testplayer "select count(*) from devs")" "0"
eq "команда: devs — только своя строка" "$(val hinoma "select string_agg(tag, ',') from devs")" "hinoma"
eq "версия прав" "$(val anon "select public.komik_api_version()")" "3"

echo "· журнал правок"
eq "команда: видит журнал; запись игрока с тегом и ролью, прежнее значение расписания сохранено" \
   "$(val hinoma "select count(*) > 0, bool_or(tag = 'testplayer' and role = 'authenticated' and old_value is not null) from kv_history where key = 'comik:games:v1'")" "t|t"
eq "доска — без прежнего значения" "$(val hinoma "select bool_and(old_value is null) from kv_history where key = 'comik:tracker:shared:v1'")" "t"
eq "игрок: журнала не видит" "$(val testplayer "select count(*) from kv_history")" "0"
try fail anon "аноним: журнал" "select count(*) from kv_history"
try fail testplayer "игрок: писать в журнал" "insert into kv_history (key, op) values ('x', 'y')"

echo
[ $FAILS = 0 ] && echo "ИТОГ: всё прошло" || { echo "ИТОГ: провалов $FAILS"; exit 1; }

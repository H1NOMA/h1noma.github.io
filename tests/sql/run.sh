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
as(){   # «войти» от имени: роль API и токен. Пароль вводили 5 с назад (amr, как у GoTrue); «тег:old» — час назад,
        # «тег:noamr» — без amr; «{…}» — готовый токен (например, снятый до удаления аккаунта)
  local who=${1%%:*} how="" claims role ago=5
  case $1 in \{*) who=$1 ;; *:*) how=${1#*:} ;; esac
  [ "$how" = old ] && ago=3600
  if [ "$who" = anon ]; then role=anon; claims='{"role":"anon"}'
  elif [[ "$who" == \{* ]]; then role=authenticated; claims=$who
  else role=authenticated; claims=$(q -tAc "select (jsonb_build_object('role','authenticated','email',email,'sub',id)
      || case when '$how' = 'noamr' then '{}'::jsonb else jsonb_build_object('amr', jsonb_build_array(jsonb_build_object(
           'method','password','timestamp', extract(epoch from now())::bigint - $ago))) end)::text from auth.users where email='$who@komikdnd.ru'"); fi
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
# err <кто> <sql> — код ошибки и первое слово её текста («42501 komik:confirm»); пусто — ошибки не было
err(){ q -tA -v VERBOSITY=verbose -c "begin; $(as "$1") $2; commit;" 2>&1 | sed -n 's/^ERROR:  \([0-9A-Z]\{5\}\): \([^ ]*\).*/\1 \2/p' | head -1; }
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
  -c "insert into kv values ('comik:chars:player_two', '{\"at\":1,\"classic\":[{\"id\":\"vpc1\",\"owner\":\"player_two\",\"name\":\"Жертва\",\"level\":2,\"inv\":[\"меч\"]}]}') $UPS" \
  -c "insert into kv values ('comik:games:v1', '[{\"id\":\"g1\",\"title\":\"Игра\",\"seats\":\"2\",\"players\":[{\"tag\":\"herr_teo\",\"name\":\"Тео\",\"at\":100}]},{\"id\":\"g2\",\"seats\":\"1\",\"players\":[{\"tag\":\"herr_teo\",\"at\":100}]}]') $UPS" \
  -c "insert into kv values ('comik:tracker:shared:v1', '{\"rev\":1,\"at\":1,\"classic::hinoma\":{\"list\":[{\"charId\":\"pc1\",\"name\":\"Тест\",\"hp\":10,\"ds\":{\"s\":1,\"f\":0}},{\"charId\":\"npc1\",\"name\":\"Гоблин\",\"hp\":7},{\"charId\":\"vpc1\",\"name\":\"Жертва\",\"hp\":9,\"ownTag\":\"player_two\"}],\"round\":1,\"mapPos\":{\"c:npc1\":{\"x\":1,\"y\":1}}},\"legacy::hinoma\":{\"party\":\"g1\",\"list\":[{\"charId\":\"zz1\",\"name\":\"Чужой\",\"hp\":1,\"ownTag\":\"herr_teo\"}],\"log\":[{\"at\":5,\"t\":\"старое\"}]}}') $UPS" \
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
NOWV=$(val postgres "select $NOW")
q -c "update kv set value = value || '[{\"id\":\"gold\",\"deleted\":true,\"updatedAt\":1},{\"id\":\"gdup\",\"deleted\":true,\"updatedAt\":$NOWV},{\"id\":\"gdup\",\"game\":\"classic\",\"players\":[]},{\"id\":\"g4\",\"game\":\"classic\",\"seats\":\"5\",\"players\":[]}]'::jsonb where key = 'comik:games:v1'" >/dev/null
try ok testplayer "игрок: пишет то, что пишет сайт (без надгробий старше 90 дней и живых копий удалённых)" "insert into kv select key, (select jsonb_agg(x) from jsonb_array_elements(value) x where x->>'id' <> 'gold' and not (x->>'id' = 'gdup' and x->'deleted' is null)) from kv where key = 'comik:games:v1' $UPS"
eq "облако стало таким же: старого надгробия и живой копии нет" "$(val postgres "select count(*) filter (where x->>'id' = 'gold'), count(*) filter (where x->>'id' = 'gdup') from $G, jsonb_array_elements(v) x")" "0|1"
try ok testplayer "часы спешат: запись с at/upd из будущего" "insert into kv select key, (select jsonb_agg(case when x->>'id' = 'g4' then jsonb_set(x, '{players}', '[{\"tag\":\"testplayer\",\"at\":1e15,\"upd\":1e15}]') else x end) from jsonb_array_elements(value) x) from kv where key = 'comik:games:v1' $UPS"
eq "записан, время — не дальше суток вперёд" "$(val postgres "select count(*), bool_and((p->>'at')::numeric < $NOW + 86400000 and (p->>'upd')::numeric < $NOW + 86400000) from $G, jsonb_array_elements(v) x, jsonb_array_elements(x->'players') p where x->>'id' = 'g4'")" "1|t"
try ok testplayer "и снимает запись отметкой из будущего" "insert into kv select key, (select jsonb_agg(case when x->>'id' = 'g4' then jsonb_set(jsonb_set(x, '{players}', '[]'), '{gone}', '{\"testplayer\":1000000000000001}') else x end) from jsonb_array_elements(value) x) from kv where key = 'comik:games:v1' $UPS"
eq "снята" "$(val postgres "select jsonb_array_length(x->'players') from $G, jsonb_array_elements(v) x where x->>'id' = 'g4'")" "0"
try fail testplayer "игрок: расписание из 3000 пустышек (не разбирается вовсе)" "update kv set value = (select jsonb_agg(jsonb_build_object('id', 'x' || i)) from generate_series(1, 3000) i) where key = 'comik:games:v1'"
try fail anon "аноним: помощники стража (схема komik_priv)" "select komik_priv.komik_san_games('[]', '[]', 'x')"
eq "в public помощников стража нет — PostgREST их наружу не отдаёт" "$(val postgres "select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname ~ '^komik_(san_|my_chars|ids_alone|log_merge)'")" "0"
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

echo "· доска: чужие карточки не присвоить, версию ведёт сервер, журнал только дописывается"
q -c "update kv set value = jsonb_set(value, '{classic}', (value->'classic') || '[{\"id\":\"npc1\"},{\"id\":\"vpc1\",\"owner\":\"testplayer\"}]') where key = 'comik:chars:testplayer'" >/dev/null
try ok testplayer "игрок: вписал в свою строку id чужих листов, пишет им ХП и фишки (+ сотня фишек-пустышек)" "update kv set value = jsonb_set(jsonb_set(jsonb_set(jsonb_set(value, '{classic::hinoma,list,1,hp}', '0'), '{classic::hinoma,list,2,hp}', '0'), '{classic::hinoma,list,0,hp}', '4'), '{classic::hinoma,mapPos}', (select jsonb_object_agg('c:fake' || i, jsonb_build_object('x', i, 'y', i)) from generate_series(1, 100) i) || '{\"c:vpc1\":{\"x\":50,\"y\":50},\"c:npc1\":{\"x\":50,\"y\":50},\"c:pc1\":{\"x\":4,\"y\":4}}') where key = 'comik:tracker:shared:v1'"
eq "своя прошла; гоблин ГМа и чужой персонаж — нет; из фишек — только своя" \
   "$(val postgres "select v#>>'{classic::hinoma,list,0,hp}', v#>>'{classic::hinoma,list,1,hp}', v#>>'{classic::hinoma,list,2,hp}', (select count(*) from jsonb_object_keys(v#>'{classic::hinoma,mapPos}')), v#>>'{classic::hinoma,mapPos,c:pc1,x}', v#>>'{classic::hinoma,mapPos,c:npc1,x}' from $T")" \
   "4|7|9|2|4|1"
try ok player_two "владелец по тегу ГМа (ownTag): ХП своего персонажа" "update kv set value = jsonb_set(value, '{classic::hinoma,list,2,hp}', '5') where key = 'comik:tracker:shared:v1'"
eq "прошло, хотя чужой вписал этот id в свою строку" "$(val postgres "select v#>>'{classic::hinoma,list,2,hp}' from $T")" "5"
REV=$(val postgres "select v->>'rev' from $T")
try ok testplayer "игрок: портит версию доски (0, 6.5, 1e23)" "update kv set value = jsonb_set(value, '{rev}', '0') where key = 'comik:tracker:shared:v1'; update kv set value = jsonb_set(value, '{rev}', '6.5') where key = 'comik:tracker:shared:v1'; update kv set value = jsonb_set(value, '{rev}', '1e23') where key = 'comik:tracker:shared:v1'"
eq "версия — прежняя + 3: сервер считает сам" "$(val postgres "select v->>'rev' from $T")" "$((REV + 3))"
try ok hinoma "ГМ: условная запись по версии (как kvCasUpdate) проходит" "with x as (update kv set value = jsonb_set(value, '{rev}', to_jsonb($((REV + 4)))) where key = 'comik:tracker:shared:v1' and value->>'rev' = '$((REV + 3))' returning 1) select 1/count(*) from x"
try ok testplayer "игрок за столом: журнал [] и запись задним числом с лишним полем" "update kv set value = jsonb_set(value, '{classic::hinoma,log}', '[{\"at\":0,\"t\":\"раньше всех\",\"k\":\"dmg\",\"x\":\"лишнее\"}]') where key = 'comik:tracker:shared:v1'"
eq "прежнее осталось, новое дописано без лишнего" "$(val postgres "select jsonb_array_length(v#>'{classic::hinoma,log}'), v#>>'{classic::hinoma,log,0,t}', v#>'{classic::hinoma,log,0}' ? 'x' from $T")" "2|раньше всех|f"
try ok testplayer "игрок не за этим столом: журнал, стук, ХП чужой доски" "update kv set value = jsonb_set(jsonb_set(jsonb_set(value, '{legacy::hinoma,log}', '[]'), '{legacy::hinoma,joinAt}', '123'), '{legacy::hinoma,list,0,hp}', '0') where key = 'comik:tracker:shared:v1'"
eq "ничего не прошло" "$(val postgres "select jsonb_array_length(v#>'{legacy::hinoma,log}'), coalesce(v#>>'{legacy::hinoma,joinAt}', '-'), v#>>'{legacy::hinoma,list,0,hp}' from $T")" "1|-|1"
q -c "update kv set value = jsonb_set(value, '{0,players}', (value->0->'players') || '[{\"tag\":\"testplayer\",\"at\":9000,\"upd\":9000}]') where key = 'comik:games:v1'" >/dev/null
try ok testplayer "записался на игру этой доски — «стучится»" "update kv set value = jsonb_set(value, '{legacy::hinoma,joinAt}', '124') where key = 'comik:tracker:shared:v1'"
eq "стук прошёл" "$(val postgres "select v#>>'{legacy::hinoma,joinAt}' from $T")" "124"
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
eq "команда: всё" "$(val herr_teo "select count(*) from kv where key like 'comik:chars:%' or key like 'push:%'")" "6"
eq "витрина: имя и уровень есть; биографии, заметок, base64-портрета нет; kvimg-портрет есть" \
   "$(val anon "select string_agg(value#>>'{classic,0,name}' || ':' || coalesce(value#>>'{classic,0,level}','-') || ':' || (value#>'{classic,0}' ? 'bio' or value#>'{classic,0}' ? 'notes') || ':' || coalesce(value#>>'{classic,0,ava}','-'), ',' order by key) from kv_chars_pub")" \
   "Гоблин:-:false:kvimg:0123456789abcdef0123456789abcdef,Жертва:2:false:-,Тест:3:false:-"
try fail anon       "аноним: удалить листы через витрину" "with x as (delete from kv_chars_pub where key like 'comik:chars:%' returning 1) select 1/count(*) from x"
try fail testplayer "игрок: удалить листы через витрину" "with x as (delete from kv_chars_pub where key like 'comik:chars:%' returning 1) select 1/count(*) from x"
try fail anon       "аноним: запись через витрину" "insert into kv_chars_pub (key) values ('zz')"
try fail testplayer "игрок: правка через витрину" "with x as (update kv_chars_pub set key = key where key like 'comik:chars:%' returning 1) select 1/count(*) from x"
eq "листы на месте" "$(val postgres "select count(*) from kv where key like 'comik:chars:%'")" "3"
eq "аноним: devs — ничего" "$(val anon "select count(*) from devs")" "0"
eq "игрок: devs — ничего" "$(val testplayer "select count(*) from devs")" "0"
eq "команда: devs — только своя строка" "$(val hinoma "select string_agg(tag, ',') from devs")" "hinoma"
eq "версия прав" "$(val anon "select public.komik_api_version()")" "4"

echo "· журнал правок"
eq "команда: видит журнал; запись игрока с тегом и ролью, прежнее значение расписания сохранено" \
   "$(val hinoma "select count(*) > 0, bool_or(tag = 'testplayer' and role = 'authenticated' and old_value is not null) from kv_history where key = 'comik:games:v1'")" "t|t"
eq "доска — без прежнего значения" "$(val hinoma "select bool_and(old_value is null) from kv_history where key = 'comik:tracker:shared:v1'")" "t"
eq "игрок: журнала не видит" "$(val testplayer "select count(*) from kv_history")" "0"
try fail anon "аноним: журнал" "select count(*) from kv_history"
try fail testplayer "игрок: писать в журнал" "insert into kv_history (key, op) values ('x', 'y')"

# ── 10-30: игрок сам удаляет аккаунт ──
# h <буква> — хэш-«портрет» из одной буквы (строки comik:img: пишет postgres — проверка хэша его не касается)
h(){ printf "$1%.0s" $(seq 32); }
# leaver <тег> <uid> — уходящий игрок: аккаунт со всем, что на него ссылается в auth, свои строки, портреты:
# A — только в его листе, B — ещё у player_two, C — ещё на доске, E — ещё в архиве, D — в его листе в старом comik:chars:v1
leaver(){ local t=$1 id=$2
  q -c "insert into auth.users (id, email) values ('$id', '$t@komikdnd.ru')" \
    -c "insert into auth.identities (user_id) values ('$id')" -c "insert into auth.mfa_factors (user_id) values ('$id')" \
    -c "insert into auth.sessions (id, user_id) select gen_random_uuid(), '$id' from generate_series(1, 2)" \
    -c "insert into auth.mfa_amr_claims (session_id, authentication_method) select id, 'password' from auth.sessions where user_id = '$id'" \
    -c "insert into auth.refresh_tokens (token, user_id, session_id) select 't', '$id', id from auth.sessions where user_id = '$id' union all select 't0', '$id', null" \
    -c "insert into kv values ('comik:chars:$t', '{\"at\":1,\"classic\":[{\"id\":\"${t}_c1\",\"owner\":\"$t\",\"ava\":\"kvimg:$(h a)\",\"inv\":[{\"img\":\"kvimg:$(h b)\"},{\"img\":\"kvimg:$(h c)\"}]},{\"id\":\"${t}_c2\",\"owner\":\"$t\",\"ava\":\"kvimg:$(h e)\"}]}'),
                            ('comik:bm:$t', '[\"x\"]'), ('push:sub:$t', '[{\"endpoint\":\"e-$t\"}]') $UPS" >/dev/null
}
LID=00000000-0000-0000-0000-0000000000c1
leaver leaver_one $LID
q -c "insert into kv select 'comik:img:' || x, to_jsonb('data:image/png;base64,' || x) from unnest(array['$(h a)', '$(h b)', '$(h c)', '$(h d)', '$(h e)', '$(h f)']) x $UPS" \
  -c "update kv set value = jsonb_set(value, '{classic,0,ava}', '\"kvimg:$(h b)\"') where key = 'comik:chars:player_two'" \
  -c "insert into kv values ('comik:archive:v1', '{\"news\":[{\"id\":\"n1\",\"img\":\"kvimg:$(h e)\"}]}') $UPS" \
  -c "insert into kv values ('comik:chars:v1', '{\"at\":5,\"classic\":[{\"id\":\"lv1\",\"owner\":\"@Leaver_One\",\"ava\":\"kvimg:$(h d)\"},{\"id\":\"ov1\",\"owner\":\"player_two\"}]}') $UPS" \
  -c "update kv set value = value || jsonb_build_array(
        jsonb_build_object('id', 'g5', 'game', 'classic', 'players', '[{\"tag\":\"herr_teo\",\"at\":100},{\"tag\":\"Leaver_One\",\"at\":200,\"upd\":300}]'::jsonb),
        jsonb_build_object('id', 'g6', 'game', 'classic', 'gone', '{\"testplayer\":5}'::jsonb,
                           'players', jsonb_build_array(jsonb_build_object('tag', 'leaver_one', 'at', 1, 'upd', $NOW + 864000000))),
        '{\"id\":\"gt1\",\"deleted\":true,\"updatedAt\":7,\"played\":{\"t\":\"Игра\",\"chars\":[\"leaver_one_c1\"]}}'::jsonb) where key = 'comik:games:v1'" \
  -c "update kv set value = jsonb_set(value, '{classic::hinoma,list}', (value#>'{classic::hinoma,list}') || '[{\"charId\":\"leaver_one_c1\",\"hp\":4,\"ownTag\":\"leaver_one\",\"ava\":\"kvimg:$(h c)\"}]') where key = 'comik:tracker:shared:v1'" \
  -c "update kv set value = value || '[5, {\"id\":\"gbad\",\"game\":\"classic\",\"players\":{\"tag\":\"leaver_one\"}}]' where key = 'comik:games:v1'" \
  -c "update kv set value = value || '{\"bad::x\":{\"list\":{\"ownTag\":\"leaver_one\"}}}' where key = 'comik:tracker:shared:v1'" \
  -c "update kv set value = value || '[{\"tag\":\"leaver_one\",\"createdAt\":1}]' where key = 'comik:users:v1'" \
  -c "update kv set value = '[{\"tag\":\"leaver_one\",\"endpoint\":\"e5\"},{\"tag\":\"hinoma\",\"endpoint\":\"e2\"}]' where key = 'push:subs'" >/dev/null
DEL="select public.komik_delete_me"
AUTHN="select (select count(*) from auth.users where id = '$LID') || '/' || (select count(*) from auth.identities where user_id = '$LID')
  || '/' || (select count(*) from auth.sessions where user_id = '$LID') || '/' || (select count(*) from auth.mfa_amr_claims)
  || '/' || (select count(*) from auth.mfa_factors where user_id = '$LID') || '/' || (select count(*) from auth.refresh_tokens where user_id = '$LID')"
OWN="select count(*) from kv where key in ('comik:chars:leaver_one', 'comik:bm:leaver_one', 'push:sub:leaver_one')"

echo "· удаление аккаунта игроком: отказы"
eq "аноним — нет права на функцию" "$(err anon "$DEL('leaver_one')")" "42501 permission"
eq "подтверждение — чужой логин" "$(err leaver_one "$DEL('player_two')")" "42501 komik:confirm"
eq "чужой аккаунт так не удалить" "$(err testplayer "$DEL('leaver_one')")" "42501 komik:confirm"
eq "команда" "$(err hinoma "$DEL('hinoma')")" "42501 komik:team"
eq "пароль вводили час назад" "$(err leaver_one:old "$DEL('leaver_one')")" "42501 komik:reauth"
eq "в токене нет amr" "$(err leaver_one:noamr "$DEL('leaver_one')")" "42501 komik:reauth"
eq "аккаунта нет (токен с чужим id)" "$(err '{"role":"authenticated","email":"ghost_one@komikdnd.ru","sub":"00000000-0000-0000-0000-0000000000f1","amr":[{"method":"password","timestamp":9999999999}]}' "$DEL('ghost_one')")" "42501 komik:auth"
eq "после отказов всё на месте" "$(val postgres "$OWN") $(val postgres "$AUTHN") $(val postgres "select count(*) from komik_priv.komik_gone")" "3 1/1/2/2/1/3 0"
eq "права: функцию вызывает только вошедший; уборка, список удалённых — не через API" \
   "$(val postgres "select has_function_privilege('anon', 'public.komik_delete_me(text)', 'execute'), has_function_privilege('authenticated', 'public.komik_delete_me(text)', 'execute'),
      has_function_privilege('authenticated', 'komik_priv.komik_forget(text)', 'execute'), has_table_privilege('authenticated', 'komik_priv.komik_gone', 'select'),
      p.prosecdef, array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'public.komik_delete_me(text)'::regprocedure")" 'f|t|f|f|t|search_path=""'

echo "· удаление аккаунта игроком: удалось"
LCL=$(as leaver_one | sed -n "s/.*request.jwt.claims to '\(.*\)';$/\1/p")   # токен ещё жив после удаления — до часа
REV=$(val postgres "select v->>'rev' from $T")
TOMB=$(val postgres "select x::text from $G, jsonb_array_elements(v) x where x->>'id' = 'gt1'")
UPD6=$(val postgres "select x->'players'->0->>'upd' from $G, jsonb_array_elements(v) x where x->>'id' = 'g6'")
T0=$(val postgres "select $NOW")
eq "ответ: ok, тег, удалено строк и портретов" "$(val leaver_one "select r->>'ok', r->>'tag', r->>'rows', r->>'imgs' from ($DEL('Leaver_One ') r) z")" "true|leaver_one|3|2"
eq "свои строки удалены" "$(val postgres "$OWN")" "0"
eq "портреты: только его (A, D) удалены; B (лист player_two), C (доска), E (архив), F (ничей) — на месте" \
   "$(val postgres "select string_agg(left(substr(key, 11), 1), '' order by key) from kv where key ~ '^comik:img:(.)\1{31}$'")" "bcef"
eq "расписание: запись снята, отметка gone не раньше «сейчас» и новее записи; чужая запись и надгробие — как были" \
   "$(val postgres "select string_agg(p->>'tag', ','), bool_and((x->'gone'->>'leaver_one')::numeric >= $T0) from $G, jsonb_array_elements(v) x, jsonb_array_elements(x->'players') p where x->>'id' = 'g5'")" "herr_teo|t"
eq "запись «из будущего» (часы спешили) — отметка строго новее неё; чужая отметка цела" \
   "$(val postgres "select jsonb_array_length(x->'players'), (x->'gone'->>'leaver_one')::numeric = $UPD6 + 1, x->'gone'->>'testplayer' from $G, jsonb_array_elements(v) x where x->>'id' = 'g6'")" "0|t|5"
eq "надгробие сыгранной игры не тронуто" "$(val postgres "select x::text from $G, jsonb_array_elements(v) x where x->>'id' = 'gt1'")" "$TOMB"
eq "кривые записи (не объект, players/list не массив) не мешают и остаются как были" \
   "$(val postgres "select (select count(*) from $G, jsonb_array_elements(v) x where x = '5' or x->'players' = '{\"tag\":\"leaver_one\"}'), (select v#>>'{bad::x,list,ownTag}' from $T)")" "2|leaver_one"
eq "доска: карточка осталась без ownTag, чужой тег на месте, версия + 1" \
   "$(val postgres "select (select count(*) from jsonb_array_elements(v#>'{classic::hinoma,list}') c where c->>'charId' = 'leaver_one_c1' and not c ? 'ownTag'),
      (select string_agg(c->>'ownTag', ',') from jsonb_array_elements(v#>'{classic::hinoma,list}') c), v->>'rev' from $T")" "1|player_two|$((REV + 1))"
eq "реестр логинов — без него" "$(val postgres "select string_agg(u->>'tag', ',' order by u->>'tag') from kv, jsonb_array_elements(value) u where key = 'comik:users:v1'")" "testplayer"
eq "старое хранилище листов — без его листа, остальное как было" "$(val postgres "select value::text from kv where key = 'comik:chars:v1'")" '{"at": 5, "classic": [{"id": "ov1", "owner": "player_two"}]}'
eq "старая общая push:subs — без его подписки" "$(val postgres "select string_agg(s->>'tag', ',') from kv, jsonb_array_elements(value) s where key = 'push:subs'")" "hinoma"
eq "аккаунт: users/identities/sessions/mfa_amr_claims/mfa_factors/refresh_tokens (и без сессии)" "$(val postgres "$AUTHN")" "0/0/0/0/0/0"
eq "в списке удалённых" "$(val postgres "select uid || ' ' || tag from komik_priv.komik_gone")" "$LID leaver_one"
eq "журнал: удаление его строк записано с его тегом и ролью authenticated" \
   "$(val postgres "select count(*) from kv_history where op = 'DELETE' and key like '%:leaver_one' and tag = 'leaver_one' and role = 'authenticated'")" "3"
eq "тем же токеном: свои листы — отказ" "$(err "$LCL" "insert into kv values ('comik:chars:leaver_one', '{\"at\":2}')")" "42501 komik:gone"
eq "тем же токеном: записаться на игру — отказ" \
   "$(err "$LCL" "insert into kv select key, jsonb_set(value, '{0,players}', (value->0->'players') || '[{\"tag\":\"leaver_one\",\"at\":2}]') from kv where key = 'comik:games:v1' $UPS")" "42501 komik:gone"
eq "тем же токеном: удалить ещё раз — аккаунта нет" "$(err "$LCL" "$DEL('leaver_one')")" "42501 komik:auth"
REG="begin; set local role supabase_auth_admin; insert into auth.users (id, email) values (gen_random_uuid(), "
eq "тот же логин зарегистрировать заново — отказ (и в другом регистре)" \
   "$(q -tA -v VERBOSITY=verbose -c "$REG'leaver_one@komikdnd.ru'); commit;" 2>&1 | grep -o '42501: komik:gone' | head -1) $(q -tA -c "$REG'Leaver_One@KomikDnD.ru'); commit;" 2>&1 | grep -o 'komik:gone' | head -1)" "42501: komik:gone komik:gone"
try ok player_two "другой игрок пишет свои листы" "insert into kv values ('comik:chars:player_two', '{\"at\":3}') $UPS"
q -c "$REG'newbie_one@komikdnd.ru'); commit;" >/dev/null 2>&1 && R=ok || R=fail
eq "новый логин регистрируется как обычно" "$R" "ok"
q -c "update komik_priv.komik_gone set at = now() - interval '91 days'" >/dev/null
q -c "$REG'leaver_one@komikdnd.ru'); commit;" >/dev/null 2>&1 && R=ok || R=fail
eq "через 90 дней логин свободен" "$R" "ok"
q -c "delete from auth.users where email in ('newbie_one@komikdnd.ru', 'leaver_one@komikdnd.ru')" -c "update komik_priv.komik_gone set at = now()" >/dev/null
SUM="select md5(string_agg(key || value::text, '' order by key)) from kv"
S1=$(val postgres "$SUM")
eq "уборка повторно — ничего не меняет" "$(val postgres "select komik_priv.komik_forget('leaver_one')::text")" '{"imgs": 0, "rows": 0}'
eq "строки kv те же" "$(val postgres "$SUM")" "$S1"
mig_sql | q >/dev/null 2>&1 && R=ok || R=fail
eq "повторный запуск миграций после удаления" "$R" "ok"
eq "список удалённых и триггеры на месте" \
   "$(val postgres "select (select count(*) from komik_priv.komik_gone), (select count(*) from pg_trigger where tgrelid = 'public.kv'::regclass and tgname = 'komik_kv_gone'),
      (select count(*) from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'komik_signup_gone')")" "1|1|1"
eq "тем же токеном после повторного запуска — всё ещё отказ" "$(err "$LCL" "insert into kv values ('comik:chars:leaver_one', '{\"at\":2}')")" "42501 komik:gone"

# владелец функции на сервере — postgres без суперпользователя (BYPASSRLS, права на auth.* выдал образ Supabase):
# здесь — такая же роль. И аккаунт, который не удалился (правило, триггер), откатывает всё
echo "· удаление аккаунта: владелец функции — не суперпользователь"
q -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'komik_owner') then create role komik_owner nologin bypassrls; end if; end \$\$" \
  -c "grant usage on schema auth, komik_priv to komik_owner" -c "grant select, delete on auth.users, auth.refresh_tokens to komik_owner" \
  -c "grant select, insert, update, delete on public.kv to komik_owner" -c "grant select on public.devs to komik_owner" \
  -c "grant select, insert, update on komik_priv.komik_gone to komik_owner" \
  -c "grant execute on function public.komik_is_team(), komik_priv.komik_ntag(text) to komik_owner" \
  -c "alter function public.komik_delete_me(text) owner to komik_owner" -c "alter function komik_priv.komik_forget(text) owner to komik_owner" >/dev/null
eq "у владельца есть DELETE на auth.users (как проверяет push.sh check)" \
   "$(val postgres "select r.rolname, r.rolsuper, has_table_privilege(p.proowner, 'auth.users', 'DELETE') from pg_proc p join pg_roles r on r.oid = p.proowner where p.oid = 'public.komik_delete_me(text)'::regprocedure")" "komik_owner|f|t"
LID2=00000000-0000-0000-0000-0000000000c2
leaver leaver_two $LID2
q -c "create or replace function public.komik_test_keep() returns trigger language plpgsql as \$\$ begin return null; end \$\$" \
  -c "create trigger komik_test_keep before delete on auth.users for each row execute function public.komik_test_keep()" >/dev/null
eq "аккаунт не удалился — отказ" "$(err leaver_two "$DEL('leaver_two')" | cut -d' ' -f2)" "komik:server"
eq "и ничего не тронуто: строки, список удалённых" "$(val postgres "select count(*) from kv where key like '%:leaver_two'") $(val postgres "select count(*) from komik_priv.komik_gone where uid = '$LID2'")" "3 0"
q -c "drop trigger komik_test_keep on auth.users" -c "drop function public.komik_test_keep()" >/dev/null
eq "удалился: ответ" "$(val leaver_two "select r->>'ok', r->>'rows' from ($DEL('leaver_two') r) z")" "true|3"
eq "строк и аккаунта нет" "$(val postgres "select count(*) from kv where key like '%:leaver_two'") $(val postgres "select count(*) from auth.users where id = '$LID2'")/$(val postgres "select count(*) from auth.refresh_tokens where user_id = '$LID2'")" "0 0/0"

echo
[ $FAILS = 0 ] && echo "ИТОГ: всё прошло" || { echo "ИТОГ: провалов $FAILS"; exit 1; }

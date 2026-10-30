#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  КОМИК · главная команда обслуживания облака:
#    пуши — починка VAPID-ключей + обновление notify-game; защита входа (GoTrue) и правил базы
#    (все миграции migrate/*.sql); шлюз Supabase только на 127.0.0.1; Caddy — наружу только API сайта
#    (Studio — через SSH-туннель), HSTS, без стандартного «:80»; свои ключи S3 вместо ключей из примера;
#    ежедневная зашифрованная копия базы на сервере (migrate/backup.sh, таймер komik-backup.timer).
#  Запуск на сервере: bash <(curl -fsS https://komikdnd.ru/migrate/push.sh)
#  Только проверить защиту, ничего не меняя: bash <(curl -fsS https://komikdnd.ru/migrate/push.sh) check
#  Только показать, каким станет Caddyfile (без root, ничего не меняет): bash push.sh render
#  Когда нужен: тест уведомлений отвечает 500 «Vapid public key should be
#  65 bytes long» / «VAPID_PRIVATE повреждён» / «не задан»; после обновления сайта;
#  после добавления человека в команду (привязка прав). Повторный запуск безопасен.
#  Спросит одно: приватный VAPID-ключ (Enter — оставить текущий, «new» — новая пара).
#  Публичный ключ вычисляется из приватного, а сайт берёт его у самой функции —
#  поэтому даже при новой паре сайт править не нужно: устройства переподпишутся сами.
#  В первый раз создаст и покажет парольную фразу копий базы — её надо сохранить в менеджер паролей.
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
say(){ printf '\n\033[1;32m══ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
bad(){ printf '\033[1;31m✗ %s\033[0m\n' "$*"; }
SB_DIR=/opt/supabase/docker
OVR="$SB_DIR/docker-compose.override.yml"
REF="${KOMIK_REF:-main}"   # ветка репозитория, откуда брать index.ts
CLOUD_DOMAIN=cloud.komikdnd.ru
CADDYFILE="${KOMIK_CADDYFILE:-/etc/caddy/Caddyfile}"
BK_WWW=/var/www/komik-backup            # зашифрованные копии (migrate/backup.sh), Caddy отдаёт их по /backup/
BK_PASS=/root/.komik-backup-pass
# публичный ключ пары, под которую оформлены подписки игроков (VAPID_PUBLIC в index.html)
SITE_PUB="BJjgF7Dfj-PGEBho4AK_eec8YivMgnT5Oux8KdfLOx3sDcqpEBJ22tYzdsQ0fhx3S5IlRr-y3zTqsnOszzEpFI4"

# ── Caddy для облака: наружу только API сайта, HSTS; стандартный «:80» убираем ──
# ТОТ ЖЕ блок пишет setup.sh: правишь здесь — правь и там (tests/README.md сверяет их render).
# Путь сверяем «сырым» — таким, каким он уйдёт на шлюз: только /rest|auth|functions|realtime/v1/…, с учётом
# регистра, без %-кодов, «.», «..» и «//». Иначе шлюз (Envoy) понял бы путь не так, как Caddy, и запрос вроде
# /REST/v1/ или /x/..%2frest/v1/ ушёл бы мимо API — на Studio (корень /, полный доступ к базе)
API_RE='^/(rest|auth|functions|realtime)/v1/([A-Za-z0-9_~-][A-Za-z0-9._~-]*(/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*/?)?([?].*)?$'
cloud_block(){
  cat <<EOF
# komik-cloud:begin — облако КОМИК (migrate/push.sh, setup.sh). Руками не править: скрипт перезапишет
$CLOUD_DOMAIN {
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
	# зашифрованные копии базы (migrate/backup.sh): только эти имена, списка файлов нет
	@backup path_regexp ^/backup/(latest[.]json[.]gz[.]gpg|latest[.]txt|kv-[0-9-]+[.]json[.]gz[.]gpg)\$
	handle @backup {
		uri strip_prefix /backup
		root * $BK_WWW
		header Cache-Control "no-cache"
		file_server
	}
	# наружу — только API, которым пользуется сайт: supabase-js (rest, auth, realtime) и пуши (functions).
	# Studio (корень /), /pg/, /storage/, /graphql/ — нет: Studio только через SSH-туннель (migrate/RESTORE.md, раздел 9)
	@api expression \`{http.request.uri}.matches("$API_RE")\`
	handle @api {
		reverse_proxy 127.0.0.1:8000
	}
	handle {
		respond 404
	}
}
# komik-cloud:end
EOF
}
# новый Caddyfile: наш блок облака — свежий и на прежнем месте (нет его — в конец); стандартный «:80» (страница
# «Caddy works!» по IP) и «cloud.komikdnd.ru { reverse_proxy localhost:8000 }» прежних версий setup.sh — вон.
# Повторный запуск даёт тот же файл (Caddy не перечитывается зря)
caddy_cloud_new(){
  local f="$CADDYFILE"; [ -f "$f" ] || f=/dev/null
  BLK="$(cloud_block)" DOM="$CLOUD_DOMAIN {" awk '
    index($0, "# komik-cloud:begin") == 1 { if (!done) print ENVIRON["BLK"]; done = 1; skip = "mark"; next }
    skip == "mark" { if (index($0, "# komik-cloud:end") == 1) skip = ""; next }
    skip == "blk"  { if ($0 == "}") skip = ""; next }
    $0 == ":80 {" || $0 == ENVIRON["DOM"] { skip = "blk"; next }
    { print }
    END { if (!done) print "\n" ENVIRON["BLK"] }' "$f" | cat -s
}
caddy_apply(){ # caddy_apply <новый Caddyfile>: проверить, подложить, перечитать; не прошло — вернуть прежний
  local new=$1 bak=""
  if [ -f "$CADDYFILE" ] && cmp -s "$new" "$CADDYFILE"; then echo "  настройки Caddy уже такие ✓"; return 0; fi
  if ! caddy validate --adapter caddyfile --config "$new" >/dev/null 2>"$new.err"; then
    bad "новый Caddyfile не прошёл проверку — ничего не меняю:"; tail -5 "$new.err"; return 1; fi
  if [ -f "$CADDYFILE" ]; then bak="$CADDYFILE.before-cloud-$(date +%Y%m%d-%H%M%S)"; cp "$CADDYFILE" "$bak"; fi
  cp "$new" "$CADDYFILE"
  # reload — без обрыва соединений; Caddy не запущен — restart
  if systemctl reload caddy 2>/dev/null || systemctl restart caddy; then echo "  Caddy перечитал настройки ✓${bak:+ (прежний файл: $bak)}"
  else
    if [ -n "$bak" ]; then cp "$bak" "$CADDYFILE"; systemctl restart caddy || true; fi
    bad "Caddy не принял настройки — вернул прежние"; return 1
  fi
}
# для проверки (tests/README.md): каким станет Caddyfile — без root, ничего не меняя
if [ "${1:-}" = render ]; then caddy_cloud_new; exit 0; fi

[ "$(id -u)" = 0 ] || { echo "Запусти от root: ssh root@<IP>"; exit 1; }
[ -f "$SB_DIR/.env" ] || { warn "нет $SB_DIR/.env — облако не установлено (сначала setup.sh)"; exit 1; }
cd "$SB_DIR"
# шлюз Supabase (Envoy; в старых ревизиях — Kong). Его порт 8000 публикуем только на 127.0.0.1: Docker открывает
# порты мимо ufw, и на 0.0.0.0 Studio был бы виден по http://IP:8000 в обход Caddy. Нужен он только Caddy
GW_SVC=$(grep -oE '^  (api-gw|kong):' docker-compose.yml 2>/dev/null | head -n 1 | tr -d ' :' || true); GW_SVC=${GW_SVC:-api-gw}
gw_ports(){ local id; id=$(docker compose ps -q "$GW_SVC" 2>/dev/null || true); [ -z "$id" ] || docker port "$id" 8000/tcp 2>/dev/null || true; }
# ключи S3 для Storage: в публичном .env.example они одни на всех — заменяем случайными. Storage у нас
# остановлен, но включи его кто-нибудь — с ключами из примера в файлы зашёл бы любой.
# REALTIME_DB_ENC_KEY (тоже из примера) не трогаем: его смена ломает уже сохранённые настройки Realtime
s3_keys(){ local k v def new changed=""
  for k in S3_PROTOCOL_ACCESS_KEY_ID S3_PROTOCOL_ACCESS_KEY_SECRET; do
    v=$(grep "^$k=" .env | cut -d= -f2- || true)
    def=$(grep "^$k=" .env.example 2>/dev/null | cut -d= -f2- || true)
    if [ -z "$v" ] || [ "$v" = "$def" ]; then
      if [ "$k" = S3_PROTOCOL_ACCESS_KEY_ID ]; then new=$(openssl rand -hex 16); else new=$(openssl rand -hex 32); fi
      if grep -q "^$k=" .env; then sed -i "s|^$k=.*|$k=$new|" .env; else echo "$k=$new" >> .env; fi
      changed=1
    fi
  done
  if [ -n "$changed" ]; then echo "  ключи S3 (Storage) были из публичного примера — заменены случайными ✓"
  else echo "  ключи S3 (Storage) свои, не из примера ✓"; fi
}

# длина ключа после base64url-декодирования (65 — публичный, 32 — приватный)
b64len(){ python3 -c "import base64,sys;s=sys.argv[1];print(len(base64.urlsafe_b64decode(s+'='*(-len(s)%4))))" "$1" 2>/dev/null || echo -1; }
# вычистить кавычки/пробелы, которые попадают в ключ при ручной вставке
clean(){ printf '%s' "$1" | tr -d '"\r\n\t '"'"; }
# публичный ключ P-256 (65 байт, base64url) из приватного: Q = d·G — та же формула, что в index.ts.
# Так пара не может «разойтись»: ключ, который видят устройства, всегда от этого приватного.
pubof(){ python3 -c '
import base64, sys
P=0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff
N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551
G=(0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296,0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5)
def add(a,b):
    if a is None: return b
    if b is None: return a
    if a[0]==b[0]:
        if (a[1]+b[1])%P==0: return None
        l=(3*a[0]*a[0]-3)*pow(2*a[1],P-2,P)%P
    else: l=(b[1]-a[1])*pow(b[0]-a[0],P-2,P)%P
    x=(l*l-a[0]-b[0])%P
    return (x,(l*(a[0]-x)-a[1])%P)
s=sys.argv[1]; raw=base64.urlsafe_b64decode(s+"="*(-len(s)%4)); d=int.from_bytes(raw,"big")
if len(raw)!=32 or not 0<d<N: sys.exit(0)
R=None; Q=G
while d:
    if d&1: R=add(R,Q)
    Q=add(Q,Q); d>>=1
print(base64.urlsafe_b64encode(bytes([4])+R[0].to_bytes(32,"big")+R[1].to_bytes(32,"big")).rstrip(b"=").decode())
' "$1" 2>/dev/null || true; }

# ── Проверка защиты базы и входа: в конце каждого запуска и отдельно (push.sh check) ──
q(){ docker exec supabase-db psql -U postgres -d postgres -tAc "$1" 2>/dev/null || true; }
verify(){
  say "Проверка защиты"
  local OK=1 POL p RPC X T S EXTRA
  POL=" $(q "select string_agg(policyname, ' ' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'kv'") "
  if [ -z "${POL// /}" ]; then
    bad "не смог прочитать правила таблицы kv — база не отвечает? (docker compose ps)"; OK=0
  else
    echo "  правила kv:${POL% }"
    for p in kv_read kv_write_dev kv_write_player_ins kv_write_player_upd kv_projects_owner_ins kv_projects_owner_upd kv_projects_owner_del \
             kv_img_hash_ins kv_img_hash_upd kv_img_player_ins kv_img_player_upd; do
      if [[ "$POL" != *" $p "* ]]; then bad "нет правила $p"; OK=0; fi
    done
    if [[ "$POL" == *" kv_write "* ]]; then bad "ОСТАЛОСЬ старое правило kv_write: ЛЮБОЙ вошедший может переписать и стереть ЛЮБУЮ строку сайта!"; OK=0; fi
    if [[ "$POL" == *" kv_write_player "* ]]; then bad "осталось старое kv_write_player: игроки могут удалять общие строки и писать без ограничения размера"; OK=0; fi
    EXTRA=""; X=" kv_read kv_write kv_write_player kv_write_dev kv_write_player_ins kv_write_player_upd kv_projects_owner_ins kv_projects_owner_upd kv_projects_owner_del kv_img_hash_ins kv_img_hash_upd kv_img_player_ins kv_img_player_upd "
    for p in $POL; do [[ "$X" == *" $p "* ]] || EXTRA="$EXTRA $p"; done
    if [ -n "$EXTRA" ]; then bad "лишние правила на kv:$EXTRA — они могут открыть запись всем, покажи программисту"; OK=0; fi
    # правила действуют, только пока RLS включён: «Disable RLS» в Studio открывает запись всем (права таблиц
    # Supabase по умолчанию — ALL для anon и authenticated), а список правил при этом остаётся прежним
    X=$(q "select string_agg(c.relname || '=' || c.relrowsecurity, ' ' order by c.relname) from pg_class c
           where c.oid in (to_regclass('public.kv'), to_regclass('public.devs'))")
    if [ "$X" = 'devs=true kv=true' ]; then echo "  правила строк (RLS) на kv и devs включены ✓"
    else bad "RLS выключен (таблицы kv/devs: ${X:-нет ответа}): правила не действуют, запись открыта всем — запусти push.sh (без check)"; OK=0; fi
    # в devs через API — только чтение: иначе игрок дописал бы себя в команду или перепривязал чужой тег
    X=$(q "select 'ok:' || coalesce(string_agg(r || ' ' || p, ', ' order by r, p), '')
             from unnest(array['anon', 'authenticated']) r, unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
            where case when p in ('INSERT', 'UPDATE') then has_any_column_privilege(r, 'public.devs', p)
                       else has_table_privilege(r, 'public.devs', p) end")
    if [ "$X" != 'ok:' ]; then bad "в таблицу команды (devs) можно писать через API (${X#ok:}) — запусти push.sh (без check)"; OK=0; fi
    RPC=$(q "select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('kv_deep_merge','trk_card_patch','trk_log_push','jsonb_deep_merge')")
    if [ "$RPC" != 0 ]; then bad "остались старые функции записи в обход правил (kv_deep_merge и др.)"; OK=0; fi
    X=$(q "select count(*) from pg_trigger t join pg_proc f on f.oid = t.tgfoid where t.tgrelid = to_regclass('public.kv') and t.tgname = 'kv_key_fixed' and t.tgenabled <> 'D' and f.prosrc ~ 'менять нельзя'")
    if [ "$X" != 1 ]; then bad "нет запрета переименовывать строки kv (триггер kv_key_fixed): игрок может «увести» расписание или доску в свою строку"; OK=0; fi
    X=$(q "select count(*) from pg_trigger where tgrelid = to_regclass('public.kv') and tgname in ('komik_kv_guard', 'komik_kv_journal') and tgenabled <> 'D'")
    if [ "$X" = 2 ]; then echo "  общие строки: игрок меняет только своё, журнал правок ведётся ✓"
    else bad "нет стража общих строк или журнала (триггеры komik_kv_guard/komik_kv_journal): игрок может переписать расписание и доску целиком"; OK=0; fi
    X=$(q "select qual ~ 'komik_is_team' from pg_policies where schemaname = 'public' and tablename = 'kv' and policyname = 'kv_read'")
    if [ "$X" = t ]; then echo "  чтение: чужие листы и пуш-подписки — только команде ✓"
    else bad "чтение kv открыто всем (старое правило kv_read): чужие листы персонажей и пуш-подписки видны без входа"; OK=0; fi
    # 09-21…09-27 пересоздают свои, более слабые devs_read и kv_player_cap — строгие возвращает только 10-29, идущая последней
    X=$(q "select qual ~ 'auth\.uid\(\)' and qual !~ '^\(?true\)?$' from pg_policies where schemaname = 'public' and tablename = 'devs' and policyname = 'devs_read'")
    if [ "$X" != t ]; then bad "правило devs_read старое: любой вошедший видит id аккаунтов команды — запусти push.sh (без check)"; OK=0; fi
    X=$(q "select prosrc ~ 'push:sub:' from pg_proc where oid = to_regprocedure('public.kv_player_cap(text)')")
    if [ "$X" != t ]; then bad "kv_player_cap старая: игроки не могут сохранить пуш-подписку — запусти push.sh (без check)"; OK=0; fi
    # витрина листов работает от владельца: запись через неё обошла бы правила kv (удалить чужие листы с ключом гостя)
    X=$(q "select 'ok:' || coalesce(string_agg(r || ' ' || p, ', ' order by r, p), '')
             from unnest(array['anon', 'authenticated']) r, unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
            where to_regclass('public.kv_chars_pub') is not null and has_table_privilege(r, 'public.kv_chars_pub', p)")
    if [ "$X" != 'ok:' ]; then bad "через витрину листов kv_chars_pub можно писать (${X#ok:}) — запусти push.sh (без check)"; OK=0; fi
    X=$(q "select prosrc ~ '4,32' from pg_proc where oid = to_regprocedure('public.my_tag()')")
    if [ "$X" != t ]; then bad "функция my_tag() старая: логины вроде «v1» получают права игрока"; OK=0; fi
    X=$(q "select count(*) from pg_trigger t join pg_proc f on f.oid = t.tgfoid where t.tgrelid = to_regclass('auth.users') and t.tgname = 'komik_email_guard' and t.tgenabled <> 'D' and f.prosrc ~ 'сменить нельзя'")
    if [ "$X" = 1 ]; then echo "  аккаунты: только тег@komikdnd.ru, сменить адрес нельзя ✓"
    else bad "нет защиты адресов аккаунтов (триггер komik_email_guard): игрок может переименоваться в логин команды"; OK=0; fi
    # 10-30: игрок удаляет свой аккаунт сам — функция работает от владельца (postgres), и ему нужно право удалить строку
    # auth.users (и пройти её правила строк, если они включены): иначе функция откатывается и удалиться нельзя
    X=$(q "select p.prosecdef and public.komik_api_version() >= 4 and has_table_privilege(p.proowner, 'auth.users', 'DELETE')
                  and (r.rolsuper or r.rolbypassrls or c.relowner = p.proowner or not c.relrowsecurity)
             from pg_proc p join pg_roles r on r.oid = p.proowner, pg_class c
            where p.oid = to_regprocedure('public.komik_delete_me(text)') and c.oid = to_regclass('auth.users')")
    if [ "$X" = t ]; then echo "  удаление аккаунта игроком: работает (API 4) ✓"
    else bad "игрок не может удалить свой аккаунт: нет функции komik_delete_me (API 4) или у её владельца нет права удалять из auth.users — запусти push.sh (без check); не помогло — покажи программисту"; OK=0; fi
    # (страж общих строк и журнал выше считаются по именам — третий триггер на kv их не сбивает)
    X=$(q "select count(*) from pg_trigger where tgenabled <> 'D' and ((tgrelid = to_regclass('public.kv') and tgname = 'komik_kv_gone')
                                                                   or (tgrelid = to_regclass('auth.users') and tgname = 'komik_signup_gone'))")
    if [ "$X" != 2 ]; then bad "нет триггеров komik_kv_gone/komik_signup_gone: удалённый аккаунт ещё час пишет в базу, а его логин сразу занимают — запусти push.sh (без check)"; OK=0; fi
    # копия аккаунтов старше удаления хранит удалённого: при переезде setup.sh его вернул бы
    T=$(find /root -maxdepth 1 -name 'auth-*.sql.gz' -printf '%T@\n' 2>/dev/null | sort -nr | head -n 1 | cut -d. -f1)
    if [ -n "$T" ]; then
      X=$(q "select count(*) from komik_priv.komik_gone where at > to_timestamp($T)")
      if [ -n "$X" ] && [ "$X" != 0 ]; then warn "после последней копии аккаунтов игроки удалили аккаунтов: $X — сделай свежую копию (migrate/RESTORE.md, пункт 1)"; fi
    fi
    echo "  команда (права — у аккаунта, не у логина):"
    X=""
    while IFS='|' read -r T S; do
      [ -n "$T" ] || continue
      case "$S" in
        ok)       echo "    $T ✓" ;;
        none)     echo "    $T — нет аккаунта: прав нет. Если это человек команды — пусть зарегистрируется, потом запусти push.sh ещё раз" ;;
        off)      echo "    $T — снят с команды" ;;
        deleted)  echo "    $T — аккаунт удалён: прав нет (вернуть — migrate/RESTORE.md, «Новый человек в команде»)" ;;
        *)        echo "    $T — адрес аккаунта не совпадает с тегом: прав нет" ;;
      esac
      [ "$T" = hinoma ] && [ "$S" = ok ] && X=1
    done <<< "$(q "select d.tag || '|' || case when d.uid is null then 'none' when d.uid = '00000000-0000-0000-0000-000000000000' then 'off'
                    when u.id is null then 'deleted' when lower(u.email) <> d.tag || '@komikdnd.ru' then 'mismatch' else 'ok' end
                  from public.devs d left join auth.users u on u.id = d.uid order by d.tag")"
    if [ -z "$X" ]; then bad "hinoma не привязан к аккаунту — у владельца нет прав на запись и на правила сайта"; OK=0; fi
  fi
  X=$(docker inspect supabase-auth --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true)
  if grep -qx 'GOTRUE_RATE_LIMIT_HEADER=X-Forwarded-For' <<< "$X" && grep -qx 'GOTRUE_PASSWORD_MIN_LENGTH=8' <<< "$X"; then
    echo "  вход: ограничение попыток по IP и пароль от 8 символов ✓"
  else bad "вход (контейнер supabase-auth) без ограничения попыток / длины пароля — запусти push.sh (без check)"; OK=0; fi
  if grep -q '^DISABLE_SIGNUP=true' "$SB_DIR/.env" 2>/dev/null; then echo "  регистрация: закрыта (новых игроков заводишь в Studio, migrate/RESTORE.md)"
  else echo "  регистрация: открыта"; fi
  # снаружи — только API: шлюз на 127.0.0.1, в Caddy — наш блок, корень домена (Studio) отвечает 404
  X=$(gw_ports)
  if [ -n "$X" ] && ! grep -qv '^127\.0\.0\.1:' <<< "$X"; then echo "  шлюз :8000 слушает только 127.0.0.1 ✓"
  else bad "шлюз :8000 открыт наружу (${X:-контейнер не отвечает}) — Studio виден по http://IP:8000 мимо Caddy: запусти push.sh (без check)"; OK=0; fi
  if grep -q '^# komik-cloud:begin' "$CADDYFILE" 2>/dev/null; then
    X=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$CLOUD_DOMAIN:443:127.0.0.1" "https://$CLOUD_DOMAIN/" 2>/dev/null || true)
    if [ "$X" = 404 ]; then echo "  наружу — только API сайта; Studio — через SSH-туннель ✓"
    else bad "https://$CLOUD_DOMAIN/ ответил ${X:-ничего} вместо 404 — проверь Caddy: journalctl -u caddy -n 30"; OK=0; fi
  else bad "Caddy отдаёт наружу весь шлюз — Studio (полный доступ к базе) открыт в интернет под одним паролем: запусти push.sh (без check)"; OK=0; fi
  if grep -q '^:80 {' "$CADDYFILE" 2>/dev/null; then warn "в Caddyfile остался стандартный блок :80 (страница «Caddy works!» по IP) — запусти push.sh"; fi
  for X in S3_PROTOCOL_ACCESS_KEY_ID S3_PROTOCOL_ACCESS_KEY_SECRET; do
    if [ "$(grep "^$X=" "$SB_DIR/.env" | cut -d= -f2-)" = "$(grep "^$X=" "$SB_DIR/.env.example" 2>/dev/null | cut -d= -f2-)" ]; then
      bad "$X — из публичного примера Supabase: запусти push.sh (без check)"; OK=0; fi
  done
  # копии: таймер работает, последняя — не старше 30 часов
  X=$(sed -n 's/^created=//p' "$BK_WWW/latest.txt" 2>/dev/null || true)
  if systemctl is-active -q komik-backup.timer && [ -n "$X" ] && [ $(( $(date -u +%s) - $(date -u -d "$X" +%s 2>/dev/null || echo 0) )) -lt 108000 ]; then
    echo "  зашифрованная копия базы: последняя $X ✓"
  else bad "ежедневной зашифрованной копии нет или она старая (${X:-нет}) — запусти push.sh; журнал: journalctl -u komik-backup -n 30"; OK=0; fi
  if [ $OK = 1 ]; then printf '\n\033[1;32mИтог: защита базы включена ✓\033[0m\n'
  else printf '\n\033[1;31mИтог: ⚠ защита базы включена НЕ полностью — запусти push.sh ещё раз; не помогло — пришли этот вывод программисту\033[0m\n'; return 1; fi
}
if [ "${1:-}" = check ]; then verify || exit 1; exit 0; fi

say "1/7 · Что сейчас в docker-compose.override.yml"
VPUB=""; VPRIV=""
if [ -f "$OVR" ]; then
  VPUB=$(clean "$(grep 'VAPID_PUBLIC:' "$OVR" | sed 's/.*VAPID_PUBLIC://' || true)")
  VPRIV=$(clean "$(grep 'VAPID_PRIVATE:' "$OVR" | sed 's/.*VAPID_PRIVATE://' || true)")
fi
PUB_OK=0; PRIV_OK=0
[ "$(b64len "$VPUB")" = 65 ] && PUB_OK=1
[ "$(b64len "$VPRIV")" = 32 ] && PRIV_OK=1
echo "  VAPID_PUBLIC : ${VPUB:-<пусто>} → $([ $PUB_OK = 1 ] && echo 'ок (65 байт)' || echo "битый ($(b64len "$VPUB") байт вместо 65)")"
[ $PUB_OK = 1 ] || echo "  (публичный ключ в настройках больше не используется — функция вычисляет его из приватного)"
echo "  VAPID_PRIVATE: $([ -n "$VPRIV" ] && echo "${VPRIV:0:6}…${VPRIV: -4} ($(b64len "$VPRIV") байт)" || echo '<пусто>') → $([ $PRIV_OK = 1 ] && echo 'ок' || echo 'битый или пустой')"
if [ $PRIV_OK = 1 ]; then
  if [ "$(pubof "$VPRIV")" = "$SITE_PUB" ]; then echo "  приватный ключ — от пары сайта: прежние подписки игроков останутся рабочими ✓"
  else warn "текущий приватный ключ НЕ от пары сайта — после починки устройства переподпишутся сами при открытии сайта"; fi
fi

say "2/7 · Приватный ключ"
echo "Enter — оставить текущий приватный ключ (если выше он «ок»)."
echo "Вставить ключ — если сохранился приватный ключ пары сайта (43 символа, без кавычек):"
echo "  тогда прежние подписки игроков заработают сразу, без переподписки."
echo "new — выпустить НОВУЮ пару. Сайт править не нужно: он берёт ключ у функции,"
echo "  и устройства переподпишутся сами при следующем открытии сайта."
read -rp "VAPID_PRIVATE: " IN </dev/tty || true
IN=$(clean "${IN:-}")
NEWPAIR=0
if [ "$IN" = "new" ]; then
  # пара P-256: приватный — 32 байта скаляра, публичный — 65 байт несжатой точки (04|X|Y)
  PEM=$(openssl ecparam -name prime256v1 -genkey -noout)
  TXT=$(printf '%s' "$PEM" | openssl ec -text -noout 2>/dev/null)
  PRIV_HEX=$(printf '%s\n' "$TXT" | awk '/^priv:/{f=1;next}/^pub:/{f=0}f' | tr -d ' :\n')
  PUB_HEX=$(printf '%s\n' "$TXT" | awk '/^pub:/{f=1;next}/ASN1 OID|NIST CURVE/{f=0}f' | tr -d ' :\n')
  # openssl печатает скаляр то с лишним ведущим 00, то короче 32 байт (если он начинается с нулей) —
  # приводим ровно к 64 hex-символам, иначе ключ в ~1 случае из 256 отвергался как «не 32 байта»
  PRIV_HEX=$(python3 -c "import sys;print(sys.argv[1][-64:].rjust(64,'0'))" "$PRIV_HEX")
  VPRIV=$(python3 -c "import base64,sys;print(base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1])).rstrip(b'=').decode())" "$PRIV_HEX")
  VPUB=$(python3 -c "import base64,sys;print(base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1])).rstrip(b'=').decode())" "$PUB_HEX")
  NEWPAIR=1
elif [ -n "$IN" ]; then
  VPRIV="$IN"
else
  [ $PRIV_OK = 1 ] || { warn "текущий приватный ключ битый, а новый не введён — отмена (введи ключ или new)"; exit 1; }
fi
# публичный — всегда вычисляем из приватного, а не берём вписанный рядом
[ $NEWPAIR = 1 ] || VPUB=$(pubof "$VPRIV")
[ "$(b64len "$VPRIV")" = 32 ] || { warn "приватный ключ после декодирования $(b64len "$VPRIV") байт вместо 32 — это не VAPID-ключ, проверь вставку"; exit 1; }
[ "$(b64len "$VPUB")" = 65 ] || { warn "не удалось вычислить публичный ключ из приватного — это не ключ P-256? отмена"; exit 1; }
[ "$(pubof "$VPRIV")" = "$VPUB" ] || { warn "проверка пары не сошлась: публичный ключ не от этого приватного — отмена"; exit 1; }

say "3/7 · Записываю ключи и обновляю функцию"
# тот же формат, что пишет setup.sh — повторный запуск setup.sh его подхватит.
# Файл пишется целиком: всё, что должно в нём жить (в том числе настройки входа ниже), — только здесь и в setup.sh.
# auth: логины команды публичны, поэтому GoTrue ограничивает попытки входа по IP игрока (заголовок ставит Caddy,
# подделать его снаружи нельзя) и не принимает новые пароли короче 8 символов (старые пароли продолжают работать).
# Шлюз (порт 8000) и пулер Postgres — только на 127.0.0.1: снаружи к ним путь один — через Caddy (и только к API).
{
  echo 'services:'
  echo '  supavisor:'
  echo '    ports: !override'
  echo '      - "127.0.0.1:5432:5432"'
  echo '      - "127.0.0.1:6543:6543"'
  echo "  $GW_SVC:"
  echo '    ports: !override'
  echo '      - "127.0.0.1:8000:8000/tcp"'
  echo '  auth:'
  echo '    environment:'
  echo '      GOTRUE_RATE_LIMIT_HEADER: "X-Forwarded-For"'
  echo '      GOTRUE_PASSWORD_MIN_LENGTH: "8"'
  echo '  functions:'
  echo '    environment:'
  echo "      VAPID_PUBLIC: \"$VPUB\""
  echo "      VAPID_PRIVATE: \"$VPRIV\""
  echo '      VAPID_SUBJECT: "mailto:admin@komikdnd.ru"'
} > "$OVR"
chmod 600 "$OVR"
grep -q '^COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml' .env \
  || sed -i 's|^COMPOSE_FILE=.*|COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml|' .env
s3_keys
mkdir -p volumes/functions/notify-game
# сначала с сайта (он же отдал этот скрипт), потом с GitHub: raw.githubusercontent.com из России открывается не всегда.
# Качаем во временный файл и проверяем, что пришла наша функция, а не страница ошибки.
# Явно заданная ветка (KOMIK_REF=…) — первой: сайт всегда отдаёт main, и проверить ветку до слияния иначе нельзя.
# Маркер свежей версии проверяем у каждого источника: старая index.ts с одного не должна отменять другой.
FN_TMP=$(mktemp)
GH_URL="https://raw.githubusercontent.com/H1NOMA/h1noma.github.io/$REF/supabase/functions/notify-game/index.ts"
SITE_URL="https://komikdnd.ru/supabase/functions/notify-game/index.ts"
if [ -n "${KOMIK_REF:-}" ]; then FN_SRC="$GH_URL $SITE_URL"; else FN_SRC="$SITE_URL $GH_URL"; fi
FN_OK=""
for u in $FN_SRC; do
  curl -sSf --max-time 30 -o "$FN_TMP" "$u" && grep -q 'vapidPublicFromPrivate' "$FN_TMP" && { FN_OK=1; break; }
done
if [ -n "$FN_OK" ]; then
  mv "$FN_TMP" volumes/functions/notify-game/index.ts
  echo "  notify-game обновлена ✓"
else
  rm -f "$FN_TMP"
  warn "не смог скачать свежую index.ts — оставил прежнюю версию (она падает на битом ключе!)"
fi
# изменение переменных окружения подхватывается только пересозданием контейнера (restart не поможет)
docker compose up -d --force-recreate functions >/dev/null
echo "  контейнер functions пересоздан ✓"
# auth пересоздаётся, только если его настройки изменились (первый запуск) — иначе не трогаем; --no-deps: базу не задевать
if docker compose up -d --no-deps auth >/dev/null 2>&1; then echo "  настройки входа (auth) применены ✓"
else warn "контейнер auth не обновился — логи: docker compose logs --tail=50 auth"; fi
# шлюз пересоздаётся, только если изменился порт (первый запуск после правки): API на несколько секунд замолкнет
GW_BEFORE=$(gw_ports | paste -sd' ')
if docker compose up -d --no-deps "$GW_SVC" >/dev/null 2>&1; then
  GW_AFTER=$(gw_ports | paste -sd' ')
  if [ -n "$GW_AFTER" ] && ! grep -qv '^127\.0\.0\.1:' <<< "$(gw_ports)"; then
    echo "  шлюз :8000 — только на 127.0.0.1 ✓${GW_BEFORE:+ (было: $GW_BEFORE)}"
  else warn "шлюз слушает: ${GW_AFTER:-ничего} — покажи программисту (docker compose ps $GW_SVC)"; fi
else warn "шлюз ($GW_SVC) не пересоздался — логи: docker compose logs --tail=50 $GW_SVC"; fi

say "4/7 · Проверка"
ANON=$(grep '^ANON_KEY=' .env | cut -d= -f2-)
sleep 4
# без пользовательского токена функция обязана ответить 403 forbidden:
# это значит, что модуль загрузился и ключи приняты. 500 — ключи всё ещё не те.
CHK=$(mktemp)
CODE=$(curl -s -o "$CHK" -w '%{http_code}' -X POST \
  http://127.0.0.1:8000/functions/v1/notify-game \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" -d '{}' || echo 000)
if [ "$CODE" = 403 ]; then
  echo "  функция отвечает 403 без токена — ключи приняты ✓"
else
  warn "функция ответила $CODE: $(head -c 300 "$CHK")"
  echo "  логи: docker compose logs --tail=50 functions"
fi
rm -f "$CHK"
# ключ, который функция отдаёт сайту, обязан быть от этого приватного
GOT=$(curl -s -H "apikey: $ANON" -H "Authorization: Bearer $ANON" http://127.0.0.1:8000/functions/v1/notify-game \
      | python3 -c "import json,sys;print(json.load(sys.stdin).get('publicKey',''))" 2>/dev/null || true)
if [ "$GOT" = "$VPUB" ]; then echo "  функция отдаёт сайту верный публичный ключ ✓"
else warn "функция отдаёт ключ «${GOT:-<ничего>}», ожидался $VPUB"; fi

say "5/7 · Защита аккаунтов и правил сайта"
# Все миграции базы, строго по порядку, при каждом запуске (каждая идемпотентна):
#   09-21 — права записи по ролям (снимает kv_write «любой пишет всё» и RPC в обход правил);
#   09-25 — тег только с адреса @komikdnd.ru;  09-26 — comik:projects:v1 пишет только hinoma;
#   09-27 — права команды у аккаунтов, игроки без удаления, переименования и с потолком размера, адрес не меняется;
#   10-28 — фото отдельными строками comik:img:<хэш> (сервер проверяет хэш, игрок пишет свои портреты);
#   10-29 — в общих строках игрок меняет только своё, чтение белым списком, журнал правок;
#   10-30 — игрок сам удаляет свой аккаунт (komik_delete_me, API 4).
# 09-21..09-26 пересоздают свои (более мягкие) версии, 09-27 возвращает строгие — поэтому она после них,
# а применяем только если скачались ВСЕ: иначе повторный запуск ослабил бы уже укреплённую базу.
# И применяем ОДНОЙ транзакцией (mig_sql): снаружи мягкого промежуточного состояния никто не видит,
# а сбой или Ctrl+C в любом месте откатывает всё — база остаётся как была.
MIGS="2026-09-21-rls.sql 2026-09-25-email-domain.sql 2026-09-26-projects-owner.sql 2026-09-27-hardening.sql 2026-10-28-images.sql 2026-10-29-security.sql 2026-10-30-self-delete.sql"
# скачанный файл годится, если он наш и целый: ровно одна строка «begin;» и одна «commit;» — последней
# (обрезанный файл её не содержит; по этим строкам mig_sql и склеивает файлы в одну транзакцию)
mig_ok(){ sed -i 's/\r$//' "$1" && grep -q 'комик\|КОМИК' "$1" && [ "$(grep -cx 'begin;' "$1")" = 1 ] \
  && [ "$(grep -cx 'commit;' "$1")" = 1 ] && [ "$(grep -v '^[[:space:]]*$' "$1" | tail -1)" = 'commit;' ]; }
# все файлы — в одну транзакцию: свои begin;/commit; снимаем, оборачиваем один раз. Перед каждым файлом —
# его имя (видно, на каком упало) и уровень сообщений по умолчанию, как при отдельном запуске
mig_sql(){ local f
  echo 'begin;'
  for f in "$@"; do
    echo "set local client_min_messages = notice;"
    echo "do \$komik\$ begin raise notice '· %', '$f'; end \$komik\$;"
    sed -e '/^begin;$/d' -e '/^commit;$/d' "$MIG_DIR/$f"
  done
  echo 'commit;'
}
# NOTICE/WARNING от базы — без служебных приставок и без «… does not exist / already exists, skipping»
# (первый и повторный запуски)
apply_migs(){ mig_sql "$@" | docker exec -i supabase-db psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres 2>&1 \
  | sed -e '/does not exist, skipping/d' -e '/already exists, skipping/d' -e 's/^NOTICE:  //' -e 's/^WARNING:  /⚠ /' -e 's/^/  /'; }
MIG_DIR=$(mktemp -d); MIG_ALL=1
for MIG_NAME in $MIGS; do
  MIG="$MIG_DIR/$MIG_NAME"; MIG_OK=""
  MIG_GH="https://raw.githubusercontent.com/H1NOMA/h1noma.github.io/$REF/migrate/$MIG_NAME"
  MIG_SITE="https://komikdnd.ru/migrate/$MIG_NAME"
  if [ -n "${KOMIK_REF:-}" ]; then MIG_SRC="$MIG_GH $MIG_SITE"; else MIG_SRC="$MIG_SITE $MIG_GH"; fi
  for u in $MIG_SRC; do
    curl -sSf --max-time 30 -o "$MIG" "$u" && mig_ok "$MIG" && { MIG_OK=1; break; }
  done
  [ -n "$MIG_OK" ] || { warn "не смог скачать $MIG_NAME"; MIG_ALL=""; }
done
if [ -n "$MIG_ALL" ]; then
  # снимок таблицы перед миграциями (только root, неделю): если после них что-то не так, прежнее состояние
  # возвращается одной командой. Миграции меняют данные редко, но 10-29, например, раскладывает push:subs
  KV_SNAP="/root/kv-before-push-$(date +%Y%m%d-%H%M%S).json.gz"
  if ( umask 077; docker exec supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At -c \
         "select coalesce(json_agg(json_build_object('key', key, 'value', value) order by key), '[]'::json) from public.kv" | gzip -9 > "$KV_SNAP" ) \
     && [ "$(gzip -dc "$KV_SNAP" | head -c 1)" = '[' ]; then
    echo "  снимок базы до миграций: $KV_SNAP"
    echo "  (вернуть: bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh) $KV_SNAP)"
  else
    rm -f "$KV_SNAP"; warn "снимок базы до миграций не снялся — продолжаю (ежедневные копии есть)"
  fi
  # shellcheck disable=SC2086   # MIGS — список имён через пробел
  if apply_migs $MIGS; then
    echo "  все миграции применены ✓ (одной транзакцией: ${MIGS// / → })"
  else
    warn "миграции НЕ применены — база осталась как была (транзакция откатилась). Пришли вывод выше программисту"
  fi
else
  warn "миграции базы в этот раз НЕ применялись (ни одна) — проверь интернет и запусти push.sh ещё раз"
fi
rm -rf "$MIG_DIR"

say "6/7 · Caddy: наружу только API сайта, HSTS"
# Studio (полный доступ к базе) больше не в интернете — только через SSH-туннель (migrate/RESTORE.md, раздел 9)
install -d -m 755 "$BK_WWW"
CF_NEW=$(mktemp)
caddy_cloud_new > "$CF_NEW"
caddy_apply "$CF_NEW" || warn "Caddy остался с прежними настройками — пришли вывод выше программисту"
rm -f "$CF_NEW" "$CF_NEW.err"

say "7/7 · Ежедневная зашифрованная копия базы"
# Копию снимает сам сервер (komik-backup, раз в сутки): прямо из базы, всю таблицу, и шифрует её; GitHub забирает
# только зашифрованный файл (https://cloud.komikdnd.ru/backup/latest.json.gz.gpg). Ставим скрипт только отсюда —
# владелец запускает push.sh сам; сам себя komik-backup не обновляет.
command -v gpg >/dev/null || apt-get install -yq gnupg >/dev/null
PASS_NEW=""; [ -s "$BK_PASS" ] || PASS_NEW=1
BK_TMP=$(mktemp); BK_OK=""
BK_GH="https://raw.githubusercontent.com/H1NOMA/h1noma.github.io/$REF/migrate/backup.sh"
BK_SITE="https://komikdnd.ru/migrate/backup.sh"
if [ -n "${KOMIK_REF:-}" ]; then BK_SRC="$BK_GH $BK_SITE"; else BK_SRC="$BK_SITE $BK_GH"; fi
for u in $BK_SRC; do
  curl -sSf --max-time 30 -o "$BK_TMP" "$u" && bash -n "$BK_TMP" && grep -q 'komik-backup' "$BK_TMP" && { BK_OK=1; break; }
done
if [ -n "$BK_OK" ]; then
  install -m 755 -o root -g root "$BK_TMP" /usr/local/bin/komik-backup
  /usr/local/bin/komik-backup init
  # переход на шифрование: прежние открытые копии из ветки backups — на сервер, зашифрованными (сама ветка с первого
  # же запуска GitHub держит только .gpg). Так точки возврата за прошлую неделю не пропадают. Пока не перенесли все —
  # пробуем при каждом запуске push.sh (повтор безопасен: уже перенесённые даты пропускаются)
  BK_IMPORTED=/root/.komik-backup-imported
  if [ ! -e "$BK_IMPORTED" ]; then
    OLD_BK=$(mktemp -d); IMP_OK=1
    if GIT_TERMINAL_PROMPT=0 timeout 300 git clone -q --depth 1 --branch backups https://github.com/H1NOMA/h1noma.github.io.git "$OLD_BK/r" 2>/dev/null; then
      for f in "$OLD_BK"/r/backups/kv-*.json.gz; do
        [ -f "$f" ] || continue
        D=$(basename "$f" .json.gz); D=${D#kv-}
        if ! { gzip -t "$f" 2>/dev/null && /usr/local/bin/komik-backup import "$f" "$D"; }; then warn "$(basename "$f") не перенесена"; IMP_OK=""; fi
      done
    else IMP_OK=""; fi
    if [ -n "$IMP_OK" ]; then date -u +%FT%TZ > "$BK_IMPORTED"
    else warn "прежние копии из ветки backups перенесены не все — запусти push.sh ещё раз сегодня, до 06:17 МСК (потом GitHub уберёт их из ветки)"; fi
    rm -rf "$OLD_BK"
  fi
  cat > /etc/systemd/system/komik-backup.service <<'EOF'
[Unit]
Description=КОМИК: зашифрованная копия таблицы kv (migrate/backup.sh)
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/komik-backup
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=30min
PrivateTmp=yes
NoNewPrivileges=yes
ProtectSystem=full
EOF
  # 02:37 UTC (05:37 МСК) — за полчаса до того, как GitHub придёт за копией (backup-kv.yml, 03:17 UTC)
  cat > /etc/systemd/system/komik-backup.timer <<'EOF'
[Unit]
Description=КОМИК: зашифрованная копия базы раз в сутки
[Timer]
OnCalendar=*-*-* 02:37:00 UTC
RandomizedDelaySec=5min
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now komik-backup.timer >/dev/null 2>&1
  T0=$(date '+%Y-%m-%d %H:%M:%S')
  if systemctl start komik-backup.service; then
    journalctl -u komik-backup --since "$T0" -o cat --no-pager 2>/dev/null | tail -n 2 | sed 's/^/  /'
    X=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$CLOUD_DOMAIN:443:127.0.0.1" "https://$CLOUD_DOMAIN/backup/latest.json.gz.gpg" || true)
    if [ "$X" = 200 ]; then echo "  https://$CLOUD_DOMAIN/backup/latest.json.gz.gpg отдаётся (зашифрованной) ✓"
    else warn "Caddy не отдаёт копию (ответ ${X:-нет}) — GitHub не сможет её забрать; journalctl -u caddy -n 30"; fi
  else
    bad "копия не снялась:"; journalctl -u komik-backup --since "$T0" -o cat --no-pager 2>/dev/null | tail -n 15 | sed 's/^/  /'
  fi
else
  warn "не смог скачать migrate/backup.sh — ежедневная копия НЕ настроена; проверь интернет и запусти push.sh ещё раз"
fi
rm -f "$BK_TMP"
if [ -n "$PASS_NEW" ] && [ -s "$BK_PASS" ]; then
  echo
  warn "Парольная фраза копий показана выше (и: cat $BK_PASS). Без неё копии не расшифровать."
  read -rp "  Сохрани её в менеджер паролей и нажми Enter… " _ </dev/tty || true
fi

if [ "$VPUB" != "$SITE_PUB" ]; then
  say "Пара ключей отличается от прежней"
  echo "Ничего делать не нужно: сайт берёт ключ у функции, и каждое устройство переподпишется"
  echo "само, как только его владелец откроет сайт (на айфоне сайт может попросить нажать «Включить»)."
  echo "Приватный ключ хранится только в $OVR — сохрани копию в надёжном месте."
fi
echo "Готово. На сайте (аккаунт разработчика) → Настройки → «Тест уведомления» — должно прийти."
verify || true

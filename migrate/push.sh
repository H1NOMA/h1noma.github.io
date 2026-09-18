#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  КОМИК · пуши: починка VAPID-ключей на сервере + обновление notify-game
#  Запуск на сервере: bash <(curl -fsS https://komikdnd.ru/migrate/push.sh)
#  Когда нужен: тест уведомлений отвечает 500 «Vapid public key should be
#  65 bytes long» / «VAPID_PRIVATE повреждён» / «не задан».
#  Спросит одно: приватный VAPID-ключ (или «new», чтобы выпустить новую пару).
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
say(){ printf '\n\033[1;32m══ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
SB_DIR=/opt/supabase/docker
OVR="$SB_DIR/docker-compose.override.yml"
REF="${KOMIK_REF:-main}"   # ветка репозитория, откуда брать index.ts
# публичный ключ пары, под которую оформлены подписки игроков (VAPID_PUBLIC в index.html)
SITE_PUB="BJjgF7Dfj-PGEBho4AK_eec8YivMgnT5Oux8KdfLOx3sDcqpEBJ22tYzdsQ0fhx3S5IlRr-y3zTqsnOszzEpFI4"

[ "$(id -u)" = 0 ] || { echo "Запусти от root: ssh root@<IP>"; exit 1; }
[ -f "$SB_DIR/.env" ] || { warn "нет $SB_DIR/.env — облако не установлено (сначала setup.sh)"; exit 1; }
cd "$SB_DIR"

# длина ключа после base64url-декодирования (65 — публичный, 32 — приватный)
b64len(){ python3 -c "import base64,sys;s=sys.argv[1];print(len(base64.urlsafe_b64decode(s+'='*(-len(s)%4))))" "$1" 2>/dev/null || echo -1; }
# вычистить кавычки/пробелы, которые попадают в ключ при ручной вставке
clean(){ printf '%s' "$1" | tr -d '"\r\n\t '"'"; }

say "1/4 · Что сейчас в docker-compose.override.yml"
VPUB=""; VPRIV=""
if [ -f "$OVR" ]; then
  VPUB=$(clean "$(grep 'VAPID_PUBLIC:' "$OVR" | sed 's/.*VAPID_PUBLIC://' || true)")
  VPRIV=$(clean "$(grep 'VAPID_PRIVATE:' "$OVR" | sed 's/.*VAPID_PRIVATE://' || true)")
fi
PUB_OK=0; PRIV_OK=0
[ "$(b64len "$VPUB")" = 65 ] && PUB_OK=1
[ "$(b64len "$VPRIV")" = 32 ] && PRIV_OK=1
echo "  VAPID_PUBLIC : ${VPUB:-<пусто>} → $([ $PUB_OK = 1 ] && echo 'ок (65 байт)' || echo "битый ($(b64len "$VPUB") байт вместо 65)")"
[ -n "$VPUB" ] && [ "$VPUB" != "$SITE_PUB" ] && warn "публичный ключ на сервере НЕ совпадает с вшитым в сайт — подписи не примутся"
echo "  VAPID_PRIVATE: $([ -n "$VPRIV" ] && echo "${VPRIV:0:6}…${VPRIV: -4} ($(b64len "$VPRIV") байт)" || echo '<пусто>') → $([ $PRIV_OK = 1 ] && echo 'ок' || echo 'битый или пустой')"

say "2/4 · Приватный ключ"
echo "Нужен ПРИВАТНЫЙ ключ той же пары, что публичный на сайте (43 символа, без кавычек)."
echo "Где взять: старый проект supabase.com → Edge Functions → Secrets → VAPID_PRIVATE."
echo "Enter — оставить текущий (если он ок). Слово new — выпустить НОВУЮ пару"
echo "(тогда публичный ключ надо будет вшить в сайт, а игрокам — переподписаться)."
read -rp "VAPID_PRIVATE: " IN </dev/tty || true
IN=$(clean "${IN:-}")
NEWPAIR=0
if [ "$IN" = "new" ]; then
  # пара P-256: приватный — 32 байта скаляра, публичный — 65 байт несжатой точки (04|X|Y)
  PEM=$(openssl ecparam -name prime256v1 -genkey -noout)
  TXT=$(printf '%s' "$PEM" | openssl ec -text -noout 2>/dev/null)
  PRIV_HEX=$(printf '%s\n' "$TXT" | awk '/^priv:/{f=1;next}/^pub:/{f=0}f' | tr -d ' :\n')
  PUB_HEX=$(printf '%s\n' "$TXT" | awk '/^pub:/{f=1;next}/ASN1 OID|NIST CURVE/{f=0}f' | tr -d ' :\n')
  # ведущий 00 в priv — артефакт вывода openssl, скаляр всегда 32 байта
  PRIV_HEX=${PRIV_HEX#00}
  VPRIV=$(python3 -c "import base64,sys;print(base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1])).rstrip(b'=').decode())" "$PRIV_HEX")
  VPUB=$(python3 -c "import base64,sys;print(base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1])).rstrip(b'=').decode())" "$PUB_HEX")
  NEWPAIR=1
elif [ -n "$IN" ]; then
  VPRIV="$IN"; VPUB="$SITE_PUB"
else
  [ $PRIV_OK = 1 ] || { warn "текущий приватный ключ битый, а новый не введён — отмена"; exit 1; }
  VPUB="$SITE_PUB"
fi
[ "$(b64len "$VPRIV")" = 32 ] || { warn "приватный ключ после декодирования $(b64len "$VPRIV") байт вместо 32 — это не VAPID-ключ, проверь вставку"; exit 1; }
[ "$(b64len "$VPUB")" = 65 ] || { warn "публичный ключ битый — отмена"; exit 1; }

say "3/4 · Записываю ключи и обновляю функцию"
# тот же формат, что пишет setup.sh — повторный запуск setup.sh его подхватит
{
  echo 'services:'
  echo '  supavisor:'
  echo '    ports: !override'
  echo '      - "127.0.0.1:5432:5432"'
  echo '      - "127.0.0.1:6543:6543"'
  echo '  functions:'
  echo '    environment:'
  echo "      VAPID_PUBLIC: \"$VPUB\""
  echo "      VAPID_PRIVATE: \"$VPRIV\""
  echo '      VAPID_SUBJECT: "mailto:admin@komikdnd.ru"'
} > "$OVR"
chmod 600 "$OVR"
grep -q '^COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml' .env \
  || sed -i 's|^COMPOSE_FILE=.*|COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml|' .env
mkdir -p volumes/functions/notify-game
curl -sSf -o volumes/functions/notify-game/index.ts \
  "https://raw.githubusercontent.com/H1NOMA/h1noma.github.io/$REF/supabase/functions/notify-game/index.ts" \
  && echo "  notify-game скачана (ветка $REF) ✓" || warn "не смог скачать index.ts — оставил прежнюю версию"
# изменение переменных окружения подхватывается только пересозданием контейнера (restart не поможет)
docker compose up -d --force-recreate functions >/dev/null
echo "  контейнер functions пересоздан ✓"

say "4/4 · Проверка"
ANON=$(grep '^ANON_KEY=' .env | cut -d= -f2-)
sleep 4
# без пользовательского токена функция обязана ответить 403 forbidden:
# это значит, что модуль загрузился и ключи приняты. 500 — ключи всё ещё не те.
CODE=$(curl -s -o /tmp/komik-push-check.txt -w '%{http_code}' -X POST \
  http://127.0.0.1:8000/functions/v1/notify-game \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" -d '{}' || echo 000)
if [ "$CODE" = 403 ]; then
  echo "  функция отвечает 403 без токена — ключи приняты ✓"
else
  warn "функция ответила $CODE: $(head -c 300 /tmp/komik-push-check.txt)"
  echo "  логи: docker compose logs --tail=50 functions"
fi
if [ $NEWPAIR = 1 ]; then
  say "ВЫПУЩЕНА НОВАЯ ПАРА"
  echo "Публичный ключ (его надо вшить в сайт вместо VAPID_PUBLIC — отправь Клоду ТОЛЬКО эту строку):"
  echo "$VPUB"
  echo "Приватный остаётся в $OVR. После обновления сайта игрокам нужно один раз"
  echo "выключить и включить уведомления — сайт сам переоформит подписку под новый ключ."
else
  echo "Готово. На сайте (аккаунт разработчика) нажми тест уведомлений — должно прийти."
fi

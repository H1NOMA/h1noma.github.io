#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  КОМИК · пуши: починка VAPID-ключей на сервере + обновление notify-game
#  Запуск на сервере: bash <(curl -fsS https://komikdnd.ru/migrate/push.sh)
#  Когда нужен: тест уведомлений отвечает 500 «Vapid public key should be
#  65 bytes long» / «VAPID_PRIVATE повреждён» / «не задан».
#  Спросит одно: приватный VAPID-ключ (Enter — оставить текущий, «new» — новая пара).
#  Публичный ключ вычисляется из приватного, а сайт берёт его у самой функции —
#  поэтому даже при новой паре сайт править не нужно: устройства переподпишутся сами.
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

say "1/5 · Что сейчас в docker-compose.override.yml"
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

say "2/5 · Приватный ключ"
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

say "3/5 · Записываю ключи и обновляю функцию"
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

say "4/5 · Проверка"
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
# ключ, который функция отдаёт сайту, обязан быть от этого приватного
GOT=$(curl -s -H "apikey: $ANON" -H "Authorization: Bearer $ANON" http://127.0.0.1:8000/functions/v1/notify-game \
      | python3 -c "import json,sys;print(json.load(sys.stdin).get('publicKey',''))" 2>/dev/null || true)
if [ "$GOT" = "$VPUB" ]; then echo "  функция отдаёт сайту верный публичный ключ ✓"
else warn "функция отдаёт ключ «${GOT:-<ничего>}», ожидался $VPUB"; fi

say "5/5 · Защита аккаунтов: тег — только с адреса @komikdnd.ru"
# Регистрация открыта, и без этой миграции аккаунт hinoma@<любой домен> получал права разработчика в базе
# (migrate/2026-09-25-email-domain.sql). Идемпотентна: повторный запуск ничего не ломает.
MIG=$(mktemp); MIG_OK=""
MIG_GH="https://raw.githubusercontent.com/H1NOMA/h1noma.github.io/$REF/migrate/2026-09-25-email-domain.sql"
MIG_SITE="https://komikdnd.ru/migrate/2026-09-25-email-domain.sql"
if [ -n "${KOMIK_REF:-}" ]; then MIG_SRC="$MIG_GH $MIG_SITE"; else MIG_SRC="$MIG_SITE $MIG_GH"; fi
for u in $MIG_SRC; do
  curl -sSf --max-time 30 -o "$MIG" "$u" && grep -q 'komik_email_guard' "$MIG" && { MIG_OK=1; break; }
done
if [ -n "$MIG_OK" ] && docker exec -i supabase-db psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$MIG" 2>&1 | sed 's/^/  /'; then
  echo "  миграция применена ✓"
else
  warn "миграцию не применил — выполни вручную (migrate/README.md, раздел 2026-09-25)"
fi
rm -f "$MIG"
if [ "$VPUB" != "$SITE_PUB" ]; then
  say "Пара ключей отличается от прежней"
  echo "Ничего делать не нужно: сайт берёт ключ у функции, и каждое устройство переподпишется"
  echo "само, как только его владелец откроет сайт (на айфоне сайт может попросить нажать «Включить»)."
  echo "Приватный ключ хранится только в $OVR — сохрани копию в надёжном месте."
fi
echo "Готово. На сайте (аккаунт разработчика) → Настройки → «Тест уведомления» — должно прийти."

#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
#  КОМИК · автоустановка облака на свой сервер (Ubuntu 22.04+, root)
#  Ставит Docker, swap, self-hosted Supabase (ревизия запинована),
#  схему БД и все миграции прав (migrate/*.sql), Caddy (HTTPS),
#  возвращает данные kv из свежей ежедневной копии (ветка backups на GitHub)
#  и аккаунты из /root/auth-*.sql.gz, разворачивает пуш-функцию notify-game.
#  Переезд/восстановление: сначала положи в /root сохранённые файлы (migrate/RESTORE.md):
#    komik-env.backup, komik-override.backup, auth-ДАТА.sql.gz — тогда ключи и пароли прежние.
#  Запуск:  bash <(curl -fsS https://komikdnd.ru/migrate/setup.sh)
#  Своя копия данных вместо свежей: KOMIK_KV_FILE=/root/kv-2026-09-20.json.gz bash <(curl …setup.sh)
#  Повторный запуск безопасен: готовые шаги пропускаются,
#  непустые kv и auth.users повторно НЕ перезаписываются.
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

CLOUD_DOMAIN="cloud.komikdnd.ru"
REF="${KOMIK_REF:-main}"   # ветка репозитория, откуда брать миграции (как в push.sh)
# проверенная ревизия supabase/supabase (структура compose сверена именно с ней)
SB_SHA="6c3e8a6a4e1668d71c53cdca2359893ebf106e6a"
SB_DIR=/opt/supabase/docker
INFO=/root/komik-cloud-info.txt

say(){ printf '\n\033[1;32m══ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Запусти от root: ssh root@<IP>"; exit 1; }

say "1/9 · Система: базовые пакеты"
export DEBIAN_FRONTEND=noninteractive
# битый список Caddy от прежней версии скрипта ломал apt — подчищаем
rm -f /etc/apt/sources.list.d/caddy.list
apt-get update -q
apt-get install -yq curl git nano ca-certificates gnupg python3 >/dev/null

say "2/9 · Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
docker --version

say "3/9 · Swap 3 ГБ (обязателен при 2 ГБ RAM)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 3G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
free -h | grep -i swap

say "4/9 · Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  # файл источников от Cloudsmith уже содержит [signed-by=…caddy-stable-archive-keyring.gpg]
  curl -1sSLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sSLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
fi

say "5/9 · Supabase: дистрибутив, секреты, конфигурация"
if [ ! -d /opt/supabase ]; then
  git clone --filter=blob:none https://github.com/supabase/supabase /opt/supabase
fi
git -C /opt/supabase checkout -q "$SB_SHA"
cd "$SB_DIR"
# настройки прежнего сервера (migrate/RESTORE.md): тот же JWT-секрет → тот же анон-ключ → сайт править не нужно
ENV_RESTORED=""; ENV_NEW=""
if [ ! -f .env ] && [ -f /root/komik-env.backup ]; then
  install -m 600 /root/komik-env.backup .env && sed -i 's/\r$//' .env && ENV_RESTORED=1
  echo "  .env взят из /root/komik-env.backup — ключи прежние ✓"
fi
if [ ! -f docker-compose.override.yml ] && [ -f /root/komik-override.backup ]; then
  install -m 600 /root/komik-override.backup docker-compose.override.yml && sed -i 's/\r$//' docker-compose.override.yml
  echo "  docker-compose.override.yml взят из /root/komik-override.backup — VAPID-ключи прежние ✓"
fi
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  ENV_NEW=1
  PGPASS=$(openssl rand -hex 20)
  JWTSEC=$(openssl rand -hex 20)
  DASHPASS=$(openssl rand -hex 10)
  jwt(){ python3 - "$JWTSEC" "$1" <<'PY'
import hmac,hashlib,base64,json,time,sys
b=lambda x: base64.urlsafe_b64encode(x).rstrip(b'=').decode()
sec,role=sys.argv[1],sys.argv[2]; now=int(time.time())
h=b(json.dumps({"alg":"HS256","typ":"JWT"},separators=(',',':')).encode())
p=b(json.dumps({"role":role,"iss":"supabase","iat":now,"exp":now+315360000},separators=(',',':')).encode())
print(h+'.'+p+'.'+b(hmac.new(sec.encode(),(h+'.'+p).encode(),hashlib.sha256).digest()))
PY
  }
  ANON=$(jwt anon); SERVICE=$(jwt service_role)
  sedvar(){ sed -i "s|^$1=.*|$1=$2|" .env; }
  sedvar POSTGRES_PASSWORD "$PGPASS"
  sedvar JWT_SECRET "$JWTSEC"
  sedvar ANON_KEY "$ANON"
  sedvar SERVICE_ROLE_KEY "$SERVICE"
  sedvar DASHBOARD_USERNAME supabase
  sedvar DASHBOARD_PASSWORD "$DASHPASS"
  sedvar SITE_URL "https://komikdnd.ru"
  sedvar API_EXTERNAL_URL "https://$CLOUD_DOMAIN/auth/v1"
  sedvar SUPABASE_PUBLIC_URL "https://$CLOUD_DOMAIN"
  # регистрация на сайте идёт с синтетическими email — подтверждать их некому
  sedvar ENABLE_EMAIL_AUTOCONFIRM true
  # шлюз наружу не выставляем: доступ только через Caddy (TLS)
  sedvar API_GW_HTTP_PORT "127.0.0.1:8000"
  # дефолтные криптоключи из публичного примера заменяем случайными
  sedvar SECRET_KEY_BASE "$(openssl rand -hex 32)"
  sedvar VAULT_ENC_KEY "$(openssl rand -hex 16)"
  sedvar PG_META_CRYPTO_KEY "$(openssl rand -hex 16)"
  sedvar LOGFLARE_PUBLIC_ACCESS_TOKEN "$(openssl rand -hex 16)"
  sedvar LOGFLARE_PRIVATE_ACCESS_TOKEN "$(openssl rand -hex 16)"
  sedvar POOLER_TENANT_ID komik
else
  echo ".env уже есть — секреты не трогаю"
fi
# перечитываем значения (важно при повторном запуске)
PGPASS=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
ANON=$(grep '^ANON_KEY=' .env | cut -d= -f2-)
SERVICE=$(grep '^SERVICE_ROLE_KEY=' .env | cut -d= -f2-)
DASHPASS=$(grep '^DASHBOARD_PASSWORD=' .env | cut -d= -f2-)

# override: порты Postgres-пулера прячем на loopback; настройки входа (auth); сюда же — VAPID для пушей.
# Тот же формат, что пишет push.sh: файл пишется целиком — всё, что в нём должно жить, только здесь и там.
VPUB=""; VPRIV=""
if [ -f docker-compose.override.yml ]; then
  VPUB=$(grep 'VAPID_PUBLIC:' docker-compose.override.yml | sed 's/.*: *"//;s/"//' || true)
  VPRIV=$(grep 'VAPID_PRIVATE:' docker-compose.override.yml | sed 's/.*: *"//;s/"//' || true)
fi
# публичный ключ и так вшит в сайт — спрашиваем только приватный; кавычки и пробелы
# при вставке ломали ключ («should be 65 bytes long») — вычищаем и проверяем длину
SITE_VPUB="BJjgF7Dfj-PGEBho4AK_eec8YivMgnT5Oux8KdfLOx3sDcqpEBJ22tYzdsQ0fhx3S5IlRr-y3zTqsnOszzEpFI4"
b64len(){ python3 -c "import base64,sys;s=sys.argv[1];print(len(base64.urlsafe_b64decode(s+'='*(-len(s)%4))))" "$1" 2>/dev/null || echo -1; }
VPUB=$(printf '%s' "$VPUB" | tr -d '"\r\n\t '"'"); VPRIV=$(printf '%s' "$VPRIV" | tr -d '"\r\n\t '"'")
[ "$(b64len "$VPUB")" = 65 ] || VPUB="$SITE_VPUB"
if [ "$(b64len "$VPRIV")" != 32 ]; then
  echo
  echo "Приватный VAPID-ключ пушей (строка VAPID_PRIVATE в сохранённом docker-compose.override.yml, migrate/RESTORE.md)."
  echo "Enter — пропустить (потом: bash <(curl -fsS https://komikdnd.ru/migrate/push.sh), там можно выпустить новую пару — «new»)."
  read -rp "VAPID_PRIVATE: " VPRIV </dev/tty || true
  VPRIV=$(printf '%s' "$VPRIV" | tr -d '"\r\n\t '"'")
  if [ -n "$VPRIV" ] && [ "$(b64len "$VPRIV")" != 32 ]; then
    warn "ключ после декодирования $(b64len "$VPRIV") байт вместо 32 — не VAPID-ключ, пропускаю (донастроишь push.sh)"; VPRIV=""
  fi
fi
{
  echo 'services:'
  echo '  supavisor:'
  echo '    ports: !override'
  echo '      - "127.0.0.1:5432:5432"'
  echo '      - "127.0.0.1:6543:6543"'
  # вход: ограничение попыток по IP (заголовок ставит Caddy) и новые пароли от 8 символов
  echo '  auth:'
  echo '    environment:'
  echo '      GOTRUE_RATE_LIMIT_HEADER: "X-Forwarded-For"'
  echo '      GOTRUE_PASSWORD_MIN_LENGTH: "8"'
  if [ -n "$VPUB" ] && [ -n "$VPRIV" ]; then
    echo '  functions:'
    echo '    environment:'
    echo "      VAPID_PUBLIC: \"$VPUB\""
    echo "      VAPID_PRIVATE: \"$VPRIV\""
    echo '      VAPID_SUBJECT: "mailto:admin@komikdnd.ru"'
  fi
} > docker-compose.override.yml
chmod 600 docker-compose.override.yml
# в этом .env задан COMPOSE_FILE — override сам не подхватится, прописываем явно
sed -i 's|^COMPOSE_FILE=.*|COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml|' .env

say "6/9 · Запуск Supabase (первый раз — 5-10 минут на загрузку образов)"
docker compose pull -q || true
docker compose up -d
echo "жду готовности базы…"
DB_OK=""
for i in $(seq 1 90); do
  docker exec supabase-db pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && { DB_OK=1; break; }
  sleep 5
done
[ -n "$DB_OK" ] || { warn "база не поднялась за 7 минут — смотри docker compose logs db"; exit 1; }
echo "жду готовности API-шлюза…"
# корень /rest/v1/ в этой ревизии Envoy пускает только сервисный ключ — им и проверяем
GW_OK=""
for i in $(seq 1 60); do
  curl -sf -o /dev/null http://127.0.0.1:8000/rest/v1/ -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" && { GW_OK=1; break; }
  sleep 5
done
[ -n "$GW_OK" ] || { warn "шлюз :8000 не отвечает — смотри docker compose logs api-gw rest"; exit 1; }
echo "стек поднят ✓"

say "7/9 · Схема БД (таблица kv, realtime) и все миграции прав"
docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
create table if not exists public.kv (key text primary key, value jsonb);
alter table public.kv enable row level security;
do $$ begin
  create policy kv_read  on public.kv for select using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.kv;
exception when duplicate_object then null; end $$;
SQL
# Права записи — те же четыре файла и в том же порядке, что применяет push.sh при каждом запуске:
# конечное состояние у свежего и у давно работающего сервера одинаковое, а правится оно в одном месте (migrate/*.sql).
# Не скачались/не применились — запись в kv закрыта всем (RLS без разрешающих правил), сайт только читает;
# это чинит push.sh. Ставить дальше Caddy и функции это не мешает — поэтому не выходим.
MIGS="2026-09-21-rls.sql 2026-09-25-email-domain.sql 2026-09-26-projects-owner.sql 2026-09-27-hardening.sql"
MIG_DIR=$(mktemp -d); MIG_ALL=1
for MIG_NAME in $MIGS; do
  MIG_OK=""
  MIG_GH="https://raw.githubusercontent.com/H1NOMA/h1noma.github.io/$REF/migrate/$MIG_NAME"
  MIG_SITE="https://komikdnd.ru/migrate/$MIG_NAME"
  if [ -n "${KOMIK_REF:-}" ]; then MIG_SRC="$MIG_GH $MIG_SITE"; else MIG_SRC="$MIG_SITE $MIG_GH"; fi
  for u in $MIG_SRC; do
    curl -sSf --max-time 30 -o "$MIG_DIR/$MIG_NAME" "$u" && grep -q 'комик\|КОМИК' "$MIG_DIR/$MIG_NAME" \
      && grep -q 'commit;' "$MIG_DIR/$MIG_NAME" && { MIG_OK=1; break; }
  done
  [ -n "$MIG_OK" ] || { warn "не смог скачать $MIG_NAME"; MIG_ALL=""; }
done
# NOTICE/WARNING от базы — без служебных приставок и без «… does not exist, skipping» первого запуска
apply_mig(){ docker exec -i supabase-db psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$MIG_DIR/$1" 2>&1 \
  | sed -e '/does not exist, skipping/d' -e 's/^NOTICE:  //' -e 's/^WARNING:  /⚠ /' -e 's/^/  /'; }
if [ -n "$MIG_ALL" ]; then
  for MIG_NAME in $MIGS; do
    if apply_mig "$MIG_NAME"; then echo "  $MIG_NAME ✓"; else warn "$MIG_NAME не применена"; MIG_ALL=""; fi
  done
fi
if [ -n "$MIG_ALL" ]; then echo "схема и права применены ✓"
else warn "права записи настроены не полностью — после установки запусти push.sh (bash <(curl -fsS https://komikdnd.ru/migrate/push.sh))"; fi

say "8/9 · Данные и аккаунты"
# 8а. данные kv — ТОЛЬКО в пустую таблицу, из свежей ежедневной копии (ветка backups на GitHub)
#     или из своего файла (KOMIK_KV_FILE=…). Старое облако supabase.co больше не источник: там могут
#     лежать устаревшие или испорченные данные.
KVCNT=$(docker exec supabase-db psql -U postgres -d postgres -tAc "select count(*) from public.kv" || echo 0)
if [ "${KVCNT:-0}" -gt 0 ]; then
  echo "  kv уже содержит $KVCNT ключей — восстановление пропускаю (данные не трогаю)"
else
  BK_DIR=$(mktemp -d); KV_SRC=""
  if [ -n "${KOMIK_KV_FILE:-}" ]; then
    if [ -f "$KOMIK_KV_FILE" ]; then KV_SRC="$KOMIK_KV_FILE"; echo "  копия: $KOMIK_KV_FILE"; else warn "файла $KOMIK_KV_FILE нет"; fi
  elif git clone -q --depth 1 --filter=blob:none --no-checkout --branch backups \
         https://github.com/H1NOMA/h1noma.github.io "$BK_DIR/bk" 2>/dev/null; then
    # частичный клон: список файлов, а скачивается одна — самая свежая — копия
    LAST=$(git -C "$BK_DIR/bk" ls-tree --name-only HEAD backups/ | grep -E '^backups/kv-[0-9-]+\.json\.gz$' | sort | tail -1 || true)
    if [ -n "$LAST" ] && git -C "$BK_DIR/bk" show "HEAD:$LAST" > "$BK_DIR/snap.json.gz" 2>/dev/null; then
      KV_SRC="$BK_DIR/snap.json.gz"; echo "  свежая копия: $(basename "$LAST")"
    fi
  fi
  # в копии оставляем только key и value (в старых есть лишний столбец updated_at)
  if [ -n "$KV_SRC" ] && python3 - "$KV_SRC" "$BK_DIR/payload.json" <<'PY'
import gzip, json, sys
try:
    rows = json.load(gzip.open(sys.argv[1], 'rt', encoding='utf-8'))
    assert isinstance(rows, list) and rows
except Exception:
    print('  копия повреждена или пуста'); sys.exit(1)
rows = [{'key': r['key'], 'value': r.get('value')} for r in rows if isinstance(r, dict) and isinstance(r.get('key'), str)]
json.dump(rows, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)
print('  строк в копии:', len(rows))
PY
  then
    # сервисный ключ — файлом заголовков: не светится ни на экране, ни в списке процессов
    ( umask 077; printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SERVICE" "$SERVICE" > "$BK_DIR/hdr" )
    CODE=$(curl -sS -o "$BK_DIR/resp" -w '%{http_code}' --max-time 180 -X POST http://127.0.0.1:8000/rest/v1/kv \
      -H @"$BK_DIR/hdr" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" \
      --data-binary @"$BK_DIR/payload.json" 2>/dev/null || echo 000)
    if [[ "$CODE" == 2?? ]]; then
      echo "  kv восстановлен: $(docker exec supabase-db psql -U postgres -d postgres -tAc 'select count(*) from public.kv') ключей ✓"
    else
      warn "заливка kv не удалась (ответ $CODE: $(head -c 200 "$BK_DIR/resp" 2>/dev/null)) — позже: bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh)"
    fi
  else
    warn "данные kv НЕ восстановлены (нет копии) — позже: bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh)"
  fi
  rm -rf "$BK_DIR"
fi

# 8б. аккаунты игроков — из последней копии /root/auth-*.sql.gz (restore.sh accounts; пароли — bcrypt-хэши)
CNT=$(docker exec supabase-db psql -U postgres -d postgres -tAc "select count(*) from auth.users" || echo 0)
if [ "${CNT:-0}" -gt 0 ]; then
  echo "  в auth.users уже $CNT записей — аккаунты не трогаю"
else
  DUMP=$(ls -1 /root/auth-*.sql.gz 2>/dev/null | sort | tail -1 || true)
  if [ -n "$DUMP" ]; then
    echo "  загружаю аккаунты из $DUMP…"
    # одной транзакцией и с выключенными триггерами (проверка адреса, внешние ключи): это уже проверенные аккаунты.
    # session_replication_role для postgres разрешает supautils; не вышло — пробуем суперпользователем образа.
    ERRF=$(mktemp)
    load_auth(){ { echo 'SET session_replication_role = replica;'; gzip -dc "$DUMP"; } \
      | docker exec -i supabase-db psql -1 -q -v ON_ERROR_STOP=1 -U "$1" -d postgres >/dev/null 2>>"$ERRF"; }
    if load_auth postgres || load_auth supabase_admin; then
      echo "  аккаунтов загружено: $(docker exec supabase-db psql -U postgres -d postgres -tAc 'select count(*) from auth.users') ✓"
      # права команды привязываются к аккаунтам — та же 09-27, теперь аккаунты есть
      if [ -f "$MIG_DIR/2026-09-27-hardening.sql" ]; then apply_mig 2026-09-27-hardening.sql || warn "привязка команды не прошла — запусти push.sh"; fi
    else
      warn "аккаунты не загрузились: $(tail -3 "$ERRF")"
      echo "  пришли этот вывод программисту; до тех пор игроки не смогут войти"
    fi
    rm -f "$ERRF"
  else
    warn "копии аккаунтов (/root/auth-*.sql.gz) нет — всем игрокам придётся зарегистрироваться заново"
    echo "  СРАЗУ после установки зарегистрируй на сайте hinoma, herr_teo и arlissss (пока эти логины не занял кто-то другой),"
    echo "  затем запусти bash <(curl -fsS https://komikdnd.ru/migrate/push.sh) — он привяжет права команды к этим аккаунтам."
  fi
fi
rm -rf "$MIG_DIR"

say "9/9 · Пуш-функция и Caddy"
mkdir -p "$SB_DIR/volumes/functions/notify-game"
curl -sSf -o "$SB_DIR/volumes/functions/notify-game/index.ts" \
  https://raw.githubusercontent.com/H1NOMA/h1noma.github.io/main/supabase/functions/notify-game/index.ts \
  && echo "  notify-game скачана ✓" || warn "не смог скачать notify-game — пуши не заработают"
docker compose up -d functions >/dev/null 2>&1 || docker compose up -d

if ! grep -q "$CLOUD_DOMAIN" /etc/caddy/Caddyfile 2>/dev/null; then
  cat >> /etc/caddy/Caddyfile <<EOF2

$CLOUD_DOMAIN {
    reverse_proxy localhost:8000
}
EOF2
fi
# restart, не reload: поднимает сервис и если он не был запущен
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy || warn "Caddy не стартовал — пришли вывод: systemctl status caddy --no-pager | head -20"

# необязательная экономия памяти: файлохранилище сайту не нужно
for s in storage imgproxy; do docker compose stop "$s" >/dev/null 2>&1 || true; done
for c in supabase-storage supabase-imgproxy; do docker update --restart=no "$c" >/dev/null 2>&1 || true; done

IP=$(curl -s4 ifconfig.me || hostname -I | awk '{print $1}')
cat > "$INFO" <<EOF2
══ КОМИК · параметры нового облака ══
Адрес API:        https://$CLOUD_DOMAIN
Studio (панель):  https://$CLOUD_DOMAIN  · логин: supabase · пароль: $DASHPASS
ANON_KEY — публичный ключ сайта (он же вписан в index.html и .github/workflows/backup-kv.yml):
$ANON

SERVICE_ROLE_KEY — СЕКРЕТ. Никому и никуда не отправлять:
$SERVICE
EOF2
chmod 600 "$INFO"
say "ГОТОВО"
echo "Все параметры сохранены в $INFO (посмотреть: cat $INFO)"
echo
echo "Проверь в браузере: https://$CLOUD_DOMAIN — должен ответить JSON (нужна DNS-запись cloud → $IP)."
if [ -n "$ENV_RESTORED" ]; then
  echo "Ключи прежние (из /root/komik-env.backup) — сайт править не нужно."
elif [ -n "$ENV_NEW" ]; then
  echo "Ключи НОВЫЕ: старый анон-ключ на сайте больше не подходит. Замени его на ANON_KEY из $INFO"
  echo "в двух файлах репозитория — index.html и .github/workflows/backup-kv.yml (на GitHub: файл → карандаш;"
  echo "старый ключ — длинная строка, начинается с eyJ). Чтобы в следующий раз обойтись без этого — migrate/RESTORE.md."
fi
echo "Сохрани копии ключей и аккаунтов у себя на компьютере — migrate/RESTORE.md, раздел 1."
echo "Проверить защиту базы и входа: bash <(curl -fsS https://komikdnd.ru/migrate/push.sh) check"

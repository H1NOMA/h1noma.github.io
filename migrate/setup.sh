#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
#  КОМИК · автоустановка облака на свой сервер (Ubuntu 22.04+, root)
#  Ставит Docker, swap, self-hosted Supabase (ревизия запинована),
#  схему БД, Caddy (HTTPS), переносит данные kv и аккаунты игроков,
#  разворачивает пуш-функцию notify-game.
#  Запуск:  bash <(curl -fsS https://komikdnd.ru/migrate/setup.sh)
#  Повторный запуск безопасен: готовые шаги пропускаются,
#  перенесённые данные повторно НЕ перезаписываются.
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

CLOUD_DOMAIN="cloud.komikdnd.ru"
OLD_URL="https://xstrdpoxwbkbumigspdv.supabase.co"
# анон-ключ старого облака (он и так публичный — вшит в сайт)
OLD_ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzdHJkcG94d2JrYnVtaWdzcGR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMjg1ODIsImV4cCI6MjA5OTYwNDU4Mn0.En-AP7WJh8AZkylbM44yhhJyNcFf0-ra6M3Yu8ZxAhs"
# проверенная ревизия supabase/supabase (структура compose сверена именно с ней)
SB_SHA="6c3e8a6a4e1668d71c53cdca2359893ebf106e6a"
SB_DIR=/opt/supabase/docker
INFO=/root/komik-cloud-info.txt

say(){ printf '\n\033[1;32m══ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Запусти от root: ssh root@<IP>"; exit 1; }

say "1/9 · Система: базовые пакеты"
export DEBIAN_FRONTEND=noninteractive
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
  curl -1sSLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --yes --dearmor -o /usr/share/keyrings/caddy.gpg
  curl -1sSLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sed 's|deb |deb [signed-by=/usr/share/keyrings/caddy.gpg] |' > /etc/apt/sources.list.d/caddy.list
  apt-get update -q && apt-get install -yq caddy
fi

say "5/9 · Supabase: дистрибутив, секреты, конфигурация"
if [ ! -d /opt/supabase ]; then
  git clone --filter=blob:none https://github.com/supabase/supabase /opt/supabase
fi
git -C /opt/supabase checkout -q "$SB_SHA"
cd "$SB_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
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

# override: порты Postgres-пулера прячем на loopback; сюда же — VAPID для пушей
VPUB=""; VPRIV=""
if [ -f docker-compose.override.yml ]; then
  VPUB=$(grep 'VAPID_PUBLIC:' docker-compose.override.yml | sed 's/.*: *"//;s/"//' || true)
  VPRIV=$(grep 'VAPID_PRIVATE:' docker-compose.override.yml | sed 's/.*: *"//;s/"//' || true)
fi
if [ -z "$VPUB" ] || [ -z "$VPRIV" ]; then
  echo
  echo "VAPID-секреты пушей из старого проекта (supabase.com → Edge Functions → Secrets)."
  echo "Нужны ТЕ ЖЕ значения, иначе подписки игроков умрут. Enter — пропустить (донастроишь повторным запуском)."
  read -rp "VAPID_PUBLIC: " VPUB </dev/tty || true
  read -rp "VAPID_PRIVATE: " VPRIV </dev/tty || true
fi
{
  echo 'services:'
  echo '  supavisor:'
  echo '    ports: !override'
  echo '      - "127.0.0.1:5432:5432"'
  echo '      - "127.0.0.1:6543:6543"'
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

say "7/9 · Схема БД (таблица kv, политики, realtime, RPC доски ходов)"
docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
create table if not exists public.kv (key text primary key, value jsonb);
alter table public.kv enable row level security;
do $$ begin
  create policy kv_read  on public.kv for select using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy kv_write on public.kv for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.kv;
exception when duplicate_object then null; end $$;

create or replace function public.kv_deep_merge(p_key text, p_patch jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.kv(key, value) values (p_key, p_patch)
  on conflict (key) do update set value = kv.value || excluded.value;
$$;

create or replace function public.trk_card_patch(p_key text, p_board text, p_cardkey text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.kv set value = jsonb_set(value, array[p_board,'cards',p_cardkey],
    coalesce(value#>array[p_board,'cards',p_cardkey],'{}'::jsonb) || p_patch, true)
  where key = p_key;
end $$;

create or replace function public.trk_log_push(p_key text, p_board text, p_entry jsonb, p_cap int default 80)
returns void language plpgsql security definer set search_path = public as $$
declare cur jsonb;
begin
  cur := coalesce((select value#>array[p_board,'log'] from public.kv where key=p_key), '[]'::jsonb);
  cur := cur || jsonb_build_array(p_entry);
  if jsonb_array_length(cur) > p_cap then
    cur := (select jsonb_agg(e) from (select e from jsonb_array_elements(cur) e
            offset jsonb_array_length(cur)-p_cap) t);
  end if;
  update public.kv set value = jsonb_set(value, array[p_board,'log'], cur, true) where key=p_key;
end $$;

-- RPC пишут в обход RLS (security definer) — анониму их звать нельзя
revoke execute on function public.kv_deep_merge(text,jsonb) from public, anon;
revoke execute on function public.trk_card_patch(text,text,text,jsonb) from public, anon;
revoke execute on function public.trk_log_push(text,text,jsonb,int) from public, anon;
grant execute on function public.kv_deep_merge(text,jsonb) to authenticated, service_role;
grant execute on function public.trk_card_patch(text,text,text,jsonb) to authenticated, service_role;
grant execute on function public.trk_log_push(text,text,jsonb,int) to authenticated, service_role;
SQL
echo "схема применена ✓"

say "8/9 · Перенос данных и аккаунтов"
# 8а. данные kv: ТОЛЬКО в пустую базу — повторный запуск не перетрёт свежие данные
KVCNT=$(docker exec supabase-db psql -U postgres -d postgres -tAc "select count(*) from public.kv" || echo 0)
if [ "${KVCNT:-0}" -gt 0 ]; then
  echo "  kv уже содержит $KVCNT ключей — импорт пропускаю (данные не трогаю)"
else
  echo "  скачиваю kv из старого облака…"
  curl -sSf "$OLD_URL/rest/v1/kv?select=key,value&limit=10000" \
    -H "apikey: $OLD_ANON" -H "Authorization: Bearer $OLD_ANON" -o /root/kv_backup.json \
    || { warn "старое облако не отвечает (проект на паузе? зайди в Dashboard и разбуди) — kv не перенесён"; exit 1; }
  python3 -c "import json;d=json.load(open('/root/kv_backup.json'));assert isinstance(d,list) and d,'бэкап пуст или ошибка';print('  строк в бэкапе:',len(d))"
  curl -sSf -X POST "http://127.0.0.1:8000/rest/v1/kv" \
    -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" \
    -H "Content-Type: application/json" -H "Prefer: resolution=ignore-duplicates" \
    --data-binary @/root/kv_backup.json >/dev/null \
    || { warn "заливка kv не удалась — данные НЕ перенесены"; exit 1; }
  echo "  kv залит: $(docker exec supabase-db psql -U postgres -d postgres -tAc 'select count(*) from public.kv') ключей ✓"
fi

# 8б. аккаунты игроков (пароли переезжают bcrypt-хэшами)
CNT=$(docker exec supabase-db psql -U postgres -d postgres -tAc "select count(*) from auth.users" || echo 0)
if [ "${CNT:-0}" -gt 0 ]; then
  echo "  в auth.users уже $CNT записей — перенос аккаунтов пропускаю"
else
  echo
  echo "Вставь строку подключения к СТАРОЙ базе (Dashboard → Database → Connection string,"
  echo "вкладка Session pooler; вид: postgresql://postgres.xstrd...:пароль@aws-0-...pooler.supabase.com:5432/postgres)."
  echo "Просто Enter — пропустить и перенести позже повторным запуском."
  read -rp "Строка: " OLDDB </dev/tty || true
  if [ -n "${OLDDB:-}" ]; then
    if docker exec -e OLDDB="$OLDDB" supabase-db sh -c 'pg_dump "$OLDDB" --data-only -t auth.users -t auth.identities' \
       | docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres; then
      echo "  аккаунтов перенесено: $(docker exec supabase-db psql -U postgres -d postgres -tAc 'select count(*) from auth.users') ✓"
    else
      warn "перенос аккаунтов не удался — проверь строку (нужен Session pooler, не Transaction) и запусти скрипт ещё раз"
    fi
  else
    warn "аккаунты не перенесены — игроки не смогут войти, пока не выполнишь этот шаг"
  fi
fi

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
  systemctl reload caddy
fi

# необязательная экономия памяти: файлохранилище сайту не нужно
for s in storage imgproxy; do docker compose stop "$s" >/dev/null 2>&1 || true; done
for c in supabase-storage supabase-imgproxy; do docker update --restart=no "$c" >/dev/null 2>&1 || true; done

IP=$(curl -s4 ifconfig.me || hostname -I | awk '{print $1}')
cat > "$INFO" <<EOF2
══ КОМИК · параметры нового облака ══
Адрес API:        https://$CLOUD_DOMAIN
Studio (панель):  https://$CLOUD_DOMAIN  · логин: supabase · пароль: $DASHPASS
ANON_KEY — этот ключ пойдёт в сайт, его можно отправить Клоду:
$ANON

SERVICE_ROLE_KEY — СЕКРЕТ. Никому и никуда не отправлять:
$SERVICE
EOF2
chmod 600 "$INFO"
say "ГОТОВО"
echo "Все параметры сохранены в $INFO (посмотреть: cat $INFO)"
echo
echo "Проверь в браузере: https://$CLOUD_DOMAIN — должен ответить JSON (нужна DNS-запись cloud → $IP)."
echo "Дальше: отправь Клоду ТОЛЬКО ANON_KEY (первый ключ выше) — он переключит сайт."

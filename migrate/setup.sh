#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
#  КОМИК · автоустановка облака на свой сервер (Ubuntu 22.04+, root)
#  Ставит Docker, swap, self-hosted Supabase, схему БД, Caddy (HTTPS),
#  переносит данные kv и аккаунты игроков, разворачивает пуш-функцию.
#  Запуск:  bash <(curl -s https://komikdnd.ru/migrate/setup.sh)
#  Повторный запуск безопасен: готовые шаги пропускаются.
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

CLOUD_DOMAIN="cloud.komikdnd.ru"
OLD_URL="https://xstrdpoxwbkbumigspdv.supabase.co"
# анон-ключ старого облака (он и так публичный — вшит в сайт)
OLD_ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzdHJkcG94d2JrYnVtaWdzcGR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMjg1ODIsImV4cCI6MjA5OTYwNDU4Mn0.En-AP7WJh8AZkylbM44yhhJyNcFf0-ra6M3Yu8ZxAhs"
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
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sed 's|deb |deb [signed-by=/usr/share/keyrings/caddy.gpg] |' > /etc/apt/sources.list.d/caddy.list
  apt-get update -q && apt-get install -yq caddy
fi

say "5/9 · Supabase: дистрибутив и секреты"
if [ ! -d /opt/supabase ]; then
  git clone --depth 1 https://github.com/supabase/supabase /opt/supabase
fi
cd "$SB_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
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
  sedvar API_EXTERNAL_URL "https://$CLOUD_DOMAIN"
  sedvar SUPABASE_PUBLIC_URL "https://$CLOUD_DOMAIN"
else
  echo ".env уже есть — секреты не трогаю"
fi
# перечитываем значения (важно при повторном запуске)
PGPASS=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
ANON=$(grep '^ANON_KEY=' .env | cut -d= -f2-)
SERVICE=$(grep '^SERVICE_ROLE_KEY=' .env | cut -d= -f2-)
DASHPASS=$(grep '^DASHBOARD_PASSWORD=' .env | cut -d= -f2-)

say "6/9 · Запуск Supabase (первый раз — 5-10 минут на загрузку образов)"
docker compose pull -q || true
docker compose up -d
echo "жду готовности базы…"
for i in $(seq 1 60); do
  docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 5
done
docker exec supabase-db pg_isready -U postgres

say "7/9 · Схема БД (таблица kv, политики, realtime, RPC доски ходов)"
docker exec -i supabase-db psql -U postgres -d postgres <<'SQL'
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
returns void language sql security definer as $$
  insert into public.kv(key, value) values (p_key, p_patch)
  on conflict (key) do update set value = kv.value || excluded.value;
$$;

create or replace function public.trk_card_patch(p_key text, p_board text, p_cardkey text, p_patch jsonb)
returns void language plpgsql security definer as $$
begin
  update public.kv set value = jsonb_set(value, array[p_board,'cards',p_cardkey],
    coalesce(value#>array[p_board,'cards',p_cardkey],'{}'::jsonb) || p_patch, true)
  where key = p_key;
end $$;

create or replace function public.trk_log_push(p_key text, p_board text, p_entry jsonb, p_cap int default 80)
returns void language plpgsql security definer as $$
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
SQL

say "8/9 · Перенос данных и аккаунтов"
# 8а. данные kv: старое облако → новое (идемпотентно, merge-duplicates)
echo "скачиваю kv из старого облака…"
curl -sf "$OLD_URL/rest/v1/kv?select=key,value" \
  -H "apikey: $OLD_ANON" -H "Authorization: Bearer $OLD_ANON" -o /root/kv_backup.json
python3 -c "import json;d=json.load(open('/root/kv_backup.json'));assert isinstance(d,list) and d, 'бэкап пуст';print('  строк:',len(d))"
curl -sf -X POST "http://localhost:8000/rest/v1/kv" \
  -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" \
  -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates" \
  --data-binary @/root/kv_backup.json >/dev/null && echo "  kv залит ✓"

# 8б. аккаунты игроков (пароли переезжают bcrypt-хэшами)
CNT=$(docker exec supabase-db psql -U postgres -d postgres -tAc "select count(*) from auth.users" || echo 0)
if [ "${CNT:-0}" -gt 0 ]; then
  echo "  в auth.users уже $CNT записей — перенос аккаунтов пропускаю"
else
  echo
  echo "Вставь строку подключения к СТАРОЙ базе (Dashboard → Database → Connection string,"
  echo "лучше вкладка Session pooler; строка вида postgresql://postgres...@...:5432/postgres)."
  echo "Просто Enter — пропустить и перенести позже."
  read -rp "Строка: " OLDDB
  if [ -n "${OLDDB:-}" ]; then
    docker exec supabase-db sh -c "pg_dump '$OLDDB' --data-only -t auth.users -t auth.identities" > /root/auth_dump.sql \
      && docker exec -i supabase-db psql -U postgres -d postgres < /root/auth_dump.sql \
      && echo "  аккаунтов перенесено: $(docker exec supabase-db psql -U postgres -d postgres -tAc 'select count(*) from auth.users') ✓" \
      || warn "перенос аккаунтов не удался — проверь строку (нужен Session pooler, не Transaction) и запусти скрипт ещё раз"
  else
    warn "аккаунты не перенесены — игроки не смогут войти, пока не выполнишь этот шаг"
  fi
fi

say "9/9 · Пуш-функция и Caddy"
mkdir -p "$SB_DIR/volumes/functions/notify-game"
curl -sf -o "$SB_DIR/volumes/functions/notify-game/index.ts" \
  https://raw.githubusercontent.com/H1NOMA/h1noma.github.io/main/supabase/functions/notify-game/index.ts \
  && echo "  notify-game скачана ✓" || warn "не смог скачать notify-game"
if [ ! -f "$SB_DIR/docker-compose.override.yml" ]; then
  echo
  echo "VAPID-секреты пушей из старого проекта (Dashboard → Edge Functions → Secrets)."
  echo "Просто Enter — пропустить (пуши можно донастроить позже)."
  read -rp "VAPID_PUBLIC: " VPUB
  read -rp "VAPID_PRIVATE: " VPRIV
  if [ -n "${VPUB:-}" ] && [ -n "${VPRIV:-}" ]; then
    cat > "$SB_DIR/docker-compose.override.yml" <<EOF2
services:
  functions:
    environment:
      VAPID_PUBLIC: "$VPUB"
      VAPID_PRIVATE: "$VPRIV"
      VAPID_SUBJECT: "mailto:admin@komikdnd.ru"
EOF2
    docker compose up -d functions
    echo "  VAPID вшиты ✓"
  else
    warn "VAPID пропущены — пуши заработают после повторного запуска скрипта с ключами"
  fi
fi

if ! grep -q "$CLOUD_DOMAIN" /etc/caddy/Caddyfile 2>/dev/null; then
  cat >> /etc/caddy/Caddyfile <<EOF2

$CLOUD_DOMAIN {
    reverse_proxy localhost:8000
}
EOF2
  systemctl reload caddy
fi

# необязательная экономия памяти: аналитика и файлохранилище сайту не нужны
docker compose stop analytics vector storage imgproxy >/dev/null 2>&1 || true
for c in supabase-analytics supabase-vector supabase-storage supabase-imgproxy; do
  docker update --restart=no "$c" >/dev/null 2>&1 || true
done

IP=$(curl -s4 ifconfig.me || hostname -I | awk '{print $1}')
cat > "$INFO" <<EOF2
══ КОМИК · параметры нового облака ══
Адрес API:        https://$CLOUD_DOMAIN
Studio (панель):  http://$IP:8000  · логин: supabase · пароль: $DASHPASS
ANON_KEY (пойдёт в сайт):
$ANON
SERVICE_ROLE_KEY (секрет! никому не отправлять):
$SERVICE
EOF2
say "ГОТОВО"
echo "Все параметры сохранены в $INFO"
echo
echo "Проверка: https://$CLOUD_DOMAIN должен отвечать JSON-ом (когда DNS-запись cloud → $IP разойдётся)."
echo "Дальше: отправь Клоду ТОЛЬКО ANON_KEY (строку выше) — он переключит сайт."
echo "SERVICE_ROLE_KEY не отправляй никому и никуда."

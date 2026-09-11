#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  КОМИК · перенос аккаунтов игроков со старого облака (только auth)
#  Запуск на сервере: bash <(curl -fsS https://komikdnd.ru/migrate/accounts.sh)
#  Спросит один пароль — от старой базы (Dashboard → Database).
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
say(){ printf '\n\033[1;32m══ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
POOLER="aws-0-eu-central-1.pooler.supabase.com"
PGUSER="postgres.xstrdpoxwbkbumigspdv"

say "Перенос аккаунтов игроков"
CNT=$(docker exec supabase-db psql -U postgres -d postgres -tAc "select count(*) from auth.users" 2>/dev/null || echo ERR)
[ "$CNT" = "ERR" ] && { warn "новое облако не отвечает — docker запущен?"; exit 1; }
if [ "$CNT" -gt 0 ]; then
  warn "в новой базе уже есть аккаунты ($CNT) — переносить поверх нельзя:"
  docker exec supabase-db psql -U postgres -d postgres -tAc "select email from auth.users limit 10"
  echo "Пришли Клоду этот список — он подскажет следующий шаг."
  exit 1
fi

echo "Нужен пароль от СТАРОЙ базы: supabase.com → проект → Project Settings →"
echo "Database → Reset database password → скопируй показанный ПОСЛЕ сброса."
read -rp "Пароль: " PW </dev/tty
[ -n "${PW:-}" ] || { warn "пусто — отмена"; exit 1; }
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$PW")
OLDDB="postgresql://$PGUSER:$ENC@$POOLER:5432/postgres"

echo "проверяю подключение к старой базе…"
if ! docker exec -e OLDDB="$OLDDB" supabase-db sh -c 'psql "$OLDDB" -tAc "select 1"' >/dev/null 2>&1; then
  warn "не пускает: пароль неверный или ещё не применился."
  echo "Сделай Reset database password, подожди минуту и запусти скрипт снова."
  exit 1
fi
echo "подключение есть ✓ — переношу (сначала users, затем identities)…"
docker exec -e OLDDB="$OLDDB" supabase-db sh -c \
  'pg_dump "$OLDDB" --data-only -t auth.users && pg_dump "$OLDDB" --data-only -t auth.identities' \
  | docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null

N=$(docker exec supabase-db psql -U postgres -d postgres -tAc "select count(*) from auth.users")
say "ГОТОВО: перенесено аккаунтов — $N"
echo "Все входят старыми логинами и паролями, ничего менять не нужно."

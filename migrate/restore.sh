#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  КОМИК · вернуть данные сайта (таблица kv) из ежедневной копии + копия аккаунтов
#  Запуск на сервере (root):
#    bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh)                           — какие есть копии
#    bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh) 2026-09-25                — вернуть ВСЮ таблицу
#    bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh) 2026-09-25 comik:games:v1 — вернуть один ключ
#    bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh) /root/kv-before-restore-….json.gz — отменить возврат
#    bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh) accounts                  — копия аккаунтов в /root
#  Копии делает GitHub раз в сутки (~06:17 МСК) в ветку backups, хранятся около месяца.
#  Строки из копии записываются поверх текущих; строк, которых в копии нет, скрипт не удаляет.
#  Перед записью спрашивает «да» и сохраняет текущую таблицу в /root/kv-before-restore-<время>.json.gz.
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
say(){ printf '\n\033[1;32m══ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
bad(){ printf '\033[1;31m✗ %s\033[0m\n' "$*"; }
SB_DIR=/opt/supabase/docker
REPO="${KOMIK_BACKUPS_REPO:-https://github.com/H1NOMA/h1noma.github.io}"
ME="bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh)"

[ "$(id -u)" = 0 ] || { echo "Запусти от root: ssh root@<IP>"; exit 1; }
[ -f "$SB_DIR/.env" ] || { warn "нет $SB_DIR/.env — облако не установлено (сначала setup.sh)"; exit 1; }
docker exec supabase-db pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null || { warn "база не отвечает: cd $SB_DIR && docker compose up -d"; exit 1; }
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
A1="${1:-}"; A2="${2:-}"
server_ip(){ local ip; ip=$(curl -s4 --max-time 5 ifconfig.me 2>/dev/null || true)
  [[ "$ip" =~ ^[0-9.]+$ ]] || ip=$(hostname -I 2>/dev/null | awk '{print $1}'); echo "${ip:-<IP-сервера>}"; }

# ── копия аккаунтов: логины и хэши паролей (auth.users + auth.identities) ──
if [ "$A1" = accounts ]; then
  say "Копия аккаунтов"
  F="/root/auth-$(date +%F).sql.gz"
  # grep -c, а не -q: -q бросает чтение на первом совпадении, gzip получает SIGPIPE, и pipefail считает это ошибкой
  if docker exec supabase-db pg_dump -U postgres -d postgres --data-only -t auth.users -t auth.identities | gzip -9 > "$F.part" \
     && [ "$(gzip -dc "$F.part" | grep -c '^COPY auth.users')" -gt 0 ]; then
    mv "$F.part" "$F"; chmod 600 "$F"
    echo "  сохранено: $F — аккаунтов $(docker exec supabase-db psql -U postgres -d postgres -tAc 'select count(*) from auth.users'), $(du -h "$F" | cut -f1)"
  else
    rm -f "$F.part"; bad "копия не получилась — пришли этот вывод программисту"; exit 1
  fi
  IP=$(server_ip)
  echo
  echo "Скачай её на компьютер — в PowerShell на Windows (НЕ на сервере):"
  echo "  mkdir \$HOME\\komik-backup -Force"
  echo "  scp root@$IP:$F \$HOME\\komik-backup\\"
  echo "В файле хэши паролей всех игроков: храни у себя, никому не пересылай и не выкладывай."
  echo "На новом сервере файл кладут в /root/ до запуска setup.sh (migrate/RESTORE.md) — игроки войдут старыми паролями."
  exit 0
fi

# ── откуда брать копию: дата из ветки backups или свой файл (.json.gz) ──
SNAP="$WORK/snap.json.gz"
if [ -n "$A1" ] && [ -f "$A1" ]; then
  cp "$A1" "$SNAP"; LABEL="файла $A1"
else
  say "Ежедневные копии (GitHub, ветка backups)"
  # частичный клон: сначала только список файлов, нужная копия скачается одна (~2,5 МБ)
  git clone -q --depth 1 --filter=blob:none --no-checkout --branch backups "$REPO" "$WORK/bk" 2>/dev/null \
    || { bad "не смог получить список копий с GitHub (нет интернета?)"; exit 1; }
  DATES=$(git -C "$WORK/bk" ls-tree --name-only HEAD backups/ | sed -n 's|^backups/kv-\([0-9-]*\)\.json\.gz$|\1|p' | sort)
  [ -n "$DATES" ] || { bad "копий в ветке backups нет"; exit 1; }
  if [ -z "$A1" ]; then
    echo "$DATES" | paste -sd' ' | fold -s -w 78 | sed 's/^/  /'
    echo
    echo "Вернуть один ключ (например, расписание):  $ME $(echo "$DATES" | tail -1) comik:games:v1"
    echo "Вернуть всю таблицу:                        $ME $(echo "$DATES" | tail -1)"
    echo "Ключи: comik:games:v1 — расписание, comik:tracker:shared:v1 — доска ходов, comik:chars:<тег> — листы игрока,"
    echo "       comik:news:v1 — новости, comik:archive:v1 — архив, comik:hero:v1 — приветствие, push:subs — пуш-подписки."
    exit 0
  fi
  grep -qx -- "$A1" <<< "$DATES" || { bad "копии за «$A1» нет. Есть: $(echo "$DATES" | head -1) … $(echo "$DATES" | tail -1) (список: $ME)"; exit 1; }
  git -C "$WORK/bk" show "HEAD:backups/kv-$A1.json.gz" > "$SNAP" || { bad "не смог скачать копию за $A1"; exit 1; }
  LABEL="копии от $A1"
fi

# ── текущая таблица — сначала в файл: из него же можно всё вернуть назад ──
BEFORE="/root/kv-before-restore-$(date +%Y%m%d-%H%M%S).json.gz"
if ! docker exec supabase-db psql -U postgres -d postgres -tAc \
     "select coalesce(json_agg(json_build_object('key', key, 'value', value) order by key), '[]'::json) from public.kv" \
     | gzip -9 > "$BEFORE"; then
  rm -f "$BEFORE"; bad "не смог сохранить текущую таблицу — ничего не трогаю"; exit 1
fi
chmod 600 "$BEFORE"
say "Что вернётся из $LABEL"

# что именно запишем: только key и value (в старых копиях есть лишний столбец updated_at) + что изменится
set +e
python3 - "$SNAP" "$A2" "$BEFORE" "$WORK/payload.json" <<'PY'
import gzip, json, sys
snap, key, before, out = sys.argv[1:5]
try:
    rows = json.load(gzip.open(snap, 'rt', encoding='utf-8'))
    assert isinstance(rows, list) and rows
except Exception:
    print('  копия повреждена или пуста'); sys.exit(2)
try:
    cur = {r['key']: r['value'] for r in json.load(gzip.open(before, 'rt', encoding='utf-8'))}
except Exception:
    print('  не смог сохранить текущую таблицу — ничего не трогаю'); sys.exit(4)
rows = [{'key': r['key'], 'value': r.get('value')} for r in rows if isinstance(r, dict) and isinstance(r.get('key'), str)]
if key:
    one = [r for r in rows if r['key'] == key]
    if not one:
        pre = ':'.join(key.split(':')[:2]) + ':'
        near = sorted(r['key'] for r in rows if r['key'].startswith(pre))[:30]
        print('  в копии нет ключа ' + key + ('. Похожие: ' + ', '.join(near) if near else ''))
        sys.exit(3)
    rows = one
size = lambda v: len(json.dumps(v, ensure_ascii=False).encode())
new = [r['key'] for r in rows if r['key'] not in cur]
chg = [r['key'] for r in rows if r['key'] in cur and cur[r['key']] != r['value']]
same = len(rows) - len(new) - len(chg)
if key:
    r = rows[0]
    print('  ключ %s: сейчас %s → в копии %s байт — %s' % (key, (str(size(cur[key])) + ' байт') if key in cur else 'строки нет',
          size(r['value']), 'совпадает, менять нечего' if same else 'будет заменён'))
else:
    print('  в копии строк: %d (в базе сейчас: %d)' % (len(rows), len(cur)))
    print('  изменится: %d%s' % (len(chg), (' — ' + ', '.join(chg[:15]) + (' …' if len(chg) > 15 else '')) if chg else ''))
    print('  появится:  %d%s' % (len(new), (' — ' + ', '.join(new[:15]) + (' …' if len(new) > 15 else '')) if new else ''))
    print('  без изменений: %d; строки, которых в копии нет, останутся как есть' % same)
json.dump(rows, open(out, 'w', encoding='utf-8'), ensure_ascii=False)
sys.exit(0 if (new or chg) else 5)
PY
RC=$?
set -e
case $RC in
  0) ;;
  5) rm -f "$BEFORE"; echo "Всё уже как в копии — ничего не делаю."; exit 0 ;;
  *) rm -f "$BEFORE"; bad "ничего не изменено"; exit 1 ;;
esac

echo
read -rp "Напиши «да», чтобы записать это в базу: " YES </dev/tty || true
if [ "${YES:-}" != "да" ]; then rm -f "$BEFORE"; echo "Отменено — база не тронута."; exit 0; fi

# запись через API сервисным ключом (обходит правила строк — как и должен восстановитель);
# ключ читаем из .env и передаём curl файлом, чтобы он не мелькал ни на экране, ни в списке процессов
SERVICE=$(grep '^SERVICE_ROLE_KEY=' "$SB_DIR/.env" | cut -d= -f2-)
( umask 077; printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SERVICE" "$SERVICE" > "$WORK/hdr" )
CODE=$(curl -sS -o "$WORK/resp" -w '%{http_code}' --max-time 120 -X POST "http://127.0.0.1:8000/rest/v1/kv" \
  -H @"$WORK/hdr" -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" \
  --data-binary @"$WORK/payload.json" 2>/dev/null || echo 000)
if [[ "$CODE" == 2?? ]]; then
  say "Готово ✓"
  echo "Данные записаны; у открытых вкладок они обновятся сами, остальным — при следующем открытии сайта."
  echo "Если что-то вернулось не так — отменить одной командой (вернёт то, что было до этого запуска):"
  echo "  $ME $BEFORE"
else
  bad "база ответила $CODE: $(head -c 300 "$WORK/resp" 2>/dev/null) — ничего не записано"
  echo "  текущая таблица сохранена в $BEFORE"
  exit 1
fi

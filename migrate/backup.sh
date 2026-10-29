#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  КОМИК · komik-backup — ежедневная копия таблицы kv, зашифрованная, на самом сервере
#  Ставит migrate/push.sh: /usr/local/bin/komik-backup и таймер komik-backup.timer (раз в сутки, ~05:40 МСК).
#  Руками (root):  komik-backup                — снять копию сейчас (или: systemctl start komik-backup)
#                  komik-backup allow-shrink   — сохранить, даже если строк стало меньше половины (удалили нарочно)
#                  komik-backup init           — создать парольную фразу, если её ещё нет (это делает push.sh)
#                  komik-backup import ФАЙЛ.json.gz ГГГГ-ММ-ДД — зашифровать прежнюю открытую копию в копию этого дня
#                                              (push.sh так переносит копии из ветки backups при переходе на шифрование)
#  Как устроено:
#   · снимок — прямо из Postgres (docker exec … psql): вся таблица, без потолка PostgREST в 1000 строк
#     и без анонимного ключа; формат прежний — JSON-массив {key, value};
#   · проверка: это массив строк kv, и строк не меньше половины прошлой копии (стёртая база не вытеснит копии);
#   · gzip, затем gpg --symmetric (AES256) парольной фразой из /root/.komik-backup-pass (0600, только root);
#     перед публикацией копия пробно расшифровывается — без фразы файл бесполезен, с ней — проверен;
#   · в /var/www/komik-backup — kv-ГГГГ-ММ-ДД.json.gz.gpg за 7 последних дней, latest.json.gz.gpg и latest.txt
#     (дата, имя, sha256, размер). Caddy отдаёт их по https://cloud.komikdnd.ru/backup/<имя> (без списка файлов);
#     GitHub (.github/workflows/backup-kv.yml) забирает latest в ветку backups. Открытого текста там больше нет.
#   · заодно — уборка копий в /root старше недели (kv-before-restore-*, kv-before-push-*, auth-* кроме самой свежей).
#  Расшифровать вручную — migrate/RESTORE.md, раздел 10.
#  Песочница (без root и без docker; tests/README.md):
#    KOMIK_BK_DIR=… KOMIK_BK_PASS=… KOMIK_BK_DUMP_CMD='cat kv.json' KOMIK_BK_NOPRUNE=1 bash migrate/backup.sh
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
OUT="${KOMIK_BK_DIR:-/var/www/komik-backup}"
PASSF="${KOMIK_BK_PASS:-/root/.komik-backup-pass}"
KEEP=7
MODE="${1:-}"
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
bad(){ printf '\033[1;31m✗ %s\033[0m\n' "$*"; }
ok(){ printf '  %s ✓\n' "$*"; }
umask 022

# ── парольная фраза: создаётся один раз и показывается владельцу (по таймеру — никогда: журнал читают и другие) ──
if [ "$MODE" = init ]; then
  if [ -s "$PASSF" ]; then chmod 600 "$PASSF"; ok "парольная фраза копий уже есть ($PASSF)"; exit 0; fi
  # 48 случайных байт → 64 знака base64 (одна строка); файл виден только root
  ( umask 077; head -c 48 /dev/urandom | base64 -w0 > "$PASSF.tmp"; echo >> "$PASSF.tmp"; mv -f "$PASSF.tmp" "$PASSF" )
  printf '\n\033[1;41;97m%s\033[0m\n' "  ВАЖНО: ПАРОЛЬНАЯ ФРАЗА РЕЗЕРВНЫХ КОПИЙ — СОХРАНИ ЕЁ В МЕНЕДЖЕР ПАРОЛЕЙ  "
  echo
  printf '    \033[1m%s\033[0m\n' "$(cat "$PASSF")"
  echo
  echo "  Копии базы теперь шифруются этой фразой. Без неё их НЕ расшифровать никак — ни тебе, ни программисту."
  echo "  Она лежит и на сервере ($PASSF), но умрёт сервер — умрёт и она. Скопируй её целиком (64 знака)"
  echo "  в менеджер паролей (Bitwarden, KeePass, 1Password…) под именем «КОМИК: копии базы» — прямо сейчас."
  echo "  Посмотреть ещё раз (на сервере): cat $PASSF"
  exit 0
fi
[ -s "$PASSF" ] || { bad "нет парольной фразы $PASSF — запусти push.sh: он создаст её и покажет"; exit 1; }
[ "$(stat -c %a "$PASSF")" = 600 ] || chmod 600 "$PASSF"

install -d -m 755 "$OUT"
exec 9>"$OUT/.lock"; flock -n 9 || { echo "копия уже снимается — выхожу"; exit 0; }
WORK=$(mktemp -d)
GH="$WORK/gnupg"; mkdir -m 700 "$GH"
cleanup(){ gpgconf --homedir "$GH" --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
# gpg — со своей временной папкой: не трогаем /root/.gnupg, фраза только из файла (в списке процессов её нет).
# Параметры s2k — явно: иначе gpg спрашивает их у gpg-agent, а тот в изоляции systemd может не запуститься
gpg_enc(){ GNUPGHOME="$GH" gpg --batch --yes --quiet --pinentry-mode loopback --no-symkey-cache --passphrase-file "$PASSF" \
  --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 --compress-algo none -o "$2" "$1"; }
gpg_dec(){ GNUPGHOME="$GH" gpg --batch --yes --quiet --pinentry-mode loopback --no-symkey-cache --passphrase-file "$PASSF" \
  -o "$2" -d "$1"; }
# число строк в копии (json.gz) или пусто, если это не таблица kv
rows_of(){ gzip -dc "$1" | python3 -I -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not (isinstance(rows, list) and rows and all(isinstance(r, dict) and isinstance(r.get("key"), str) and "value" in r for r in rows)):
    sys.exit(1)
print(len(rows))' 2>/dev/null || true; }

# ── перенос прежней открытой копии (import): только файл дня, latest не трогаем ──
if [ "$MODE" = import ]; then
  SRC="${2:-}"; D="${3:-}"
  [[ "$D" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [ -f "$SRC" ] || { bad "import: нужен файл .json.gz и дата ГГГГ-ММ-ДД"; exit 1; }
  [ ! -e "$OUT/kv-$D.json.gz.gpg" ] || { echo "  kv-$D.json.gz.gpg уже есть — пропускаю"; exit 0; }
  N=$(rows_of "$SRC"); [ -n "$N" ] || { bad "import: $SRC — не копия таблицы kv"; exit 1; }
  gpg_enc "$SRC" "$WORK/kv.gpg"
  { gpg_dec "$WORK/kv.gpg" "$WORK/check.json.gz" && cmp -s "$SRC" "$WORK/check.json.gz"; } || { bad "import: пробная расшифровка не сошлась"; exit 1; }
  install -m 644 "$WORK/kv.gpg" "$OUT/.kv-$D.tmp"; mv -f "$OUT/.kv-$D.tmp" "$OUT/kv-$D.json.gz.gpg"
  echo "  kv-$D.json.gz.gpg: строк $N — перенесена и зашифрована"
  exit 0
fi

# ── снимок ──
if [ -n "${KOMIK_BK_DUMP_CMD:-}" ]; then
  # песочница: готовый JSON вместо базы
  bash -c "$KOMIK_BK_DUMP_CMD" > "$WORK/kv.json" || { bad "снимок не снят (KOMIK_BK_DUMP_CMD упал)"; exit 1; }
else
  docker exec supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At -c \
    "select coalesce(json_agg(json_build_object('key', key, 'value', value) order by key), '[]'::json) from public.kv" \
    > "$WORK/kv.json" || { bad "база не ответила (docker exec supabase-db psql) — копия не снята"; exit 1; }
fi
gzip -9 -n -c "$WORK/kv.json" > "$WORK/kv.json.gz"
ROWS=$(rows_of "$WORK/kv.json.gz")
[ -n "$ROWS" ] || { bad "снимок — не таблица kv (пусто или не JSON-массив {key, value}) — копию не сохраняю, прежние целы"; exit 1; }

# ── не меньше половины прошлой копии: иначе стёртая база за неделю вытеснила бы все настоящие копии ──
PREV=""
# прошлая — latest; при первом запуске её ещё нет, но могут быть перенесённые из ветки (import) — свежайшая из них
PREVF="$OUT/latest.json.gz.gpg"
[ -s "$PREVF" ] || PREVF="$OUT/$(find "$OUT" -maxdepth 1 -name 'kv-*.json.gz.gpg' -printf '%f\n' 2>/dev/null | sort | tail -n 1)"
if [ -f "$PREVF" ] && [ -s "$PREVF" ]; then
  if gpg_dec "$PREVF" "$WORK/prev.json.gz" 2>/dev/null; then PREV=$(rows_of "$WORK/prev.json.gz"); fi
  [ -n "$PREV" ] || warn "прошлую копию не удалось прочитать (другая парольная фраза?) — сравнение числа строк пропускаю"
fi
if [ -n "$PREV" ] && [ $((ROWS * 2)) -lt "$PREV" ]; then
  if [ "$MODE" = allow-shrink ]; then warn "строк $ROWS вместо $PREV — сохраняю: запущено с allow-shrink"
  else
    bad "строк в базе $ROWS вместо $PREV (меньше половины) — копию НЕ сохраняю, прежние целы."
    echo "  Проверь сайт: не стёрты ли данные. Удалили нарочно — komik-backup allow-shrink"
    exit 1
  fi
fi

# ── шифрование и пробная расшифровка ──
gpg_enc "$WORK/kv.json.gz" "$WORK/kv.gpg"
if ! { gpg_dec "$WORK/kv.gpg" "$WORK/check.json.gz" && cmp -s "$WORK/kv.json.gz" "$WORK/check.json.gz"; }; then
  bad "пробная расшифровка не сошлась — копию не сохраняю"; exit 1
fi

# ── публикация: файл дня, затем latest.json.gz.gpg и latest.txt (по ним GitHub проверяет свежесть и целость) ──
DATE=$(date -u +%F)
F="kv-$DATE.json.gz.gpg"
install -m 644 "$WORK/kv.gpg" "$OUT/.$F.tmp"; mv -f "$OUT/.$F.tmp" "$OUT/$F"
ln -f "$OUT/$F" "$OUT/.latest.tmp"; mv -f "$OUT/.latest.tmp" "$OUT/latest.json.gz.gpg"
SHA=$(sha256sum "$OUT/$F" | cut -d' ' -f1)
printf 'date=%s\nfile=%s\nsha256=%s\nsize=%s\ncreated=%s\n' "$DATE" "$F" "$SHA" "$(stat -c %s "$OUT/$F")" "$(date -u +%FT%TZ)" > "$OUT/.latest.txt.tmp"
chmod 644 "$OUT/.latest.txt.tmp"; mv -f "$OUT/.latest.txt.tmp" "$OUT/latest.txt"

# ── хранятся 7 последних копий ──
mapfile -t OLD < <(find "$OUT" -maxdepth 1 -name 'kv-*.json.gz.gpg' -printf '%f\n' | sort -r | tail -n +$((KEEP + 1)))
for f in "${OLD[@]}"; do rm -f -- "${OUT:?}/$f"; done
N=$(find "$OUT" -maxdepth 1 -name 'kv-*.json.gz.gpg' | wc -l)
echo "Копия $F: строк $ROWS${PREV:+ (в прошлой $PREV)}, $(du -h "$OUT/$F" | cut -f1), зашифрована; копий на сервере: $N"

# ── уборка в /root: копии старше недели (последняя копия аккаунтов остаётся всегда — её берёт setup.sh) ──
if [ -z "${KOMIK_BK_NOPRUNE:-}" ]; then
  find /root -maxdepth 1 \( -name 'kv-before-restore-*.json.gz' -o -name 'kv-before-push-*.json.gz' \) -mtime +6 -delete 2>/dev/null || true
  NEWEST=$(find /root -maxdepth 1 -name 'auth-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)
  find /root -maxdepth 1 -name 'auth-*.sql.gz' -mtime +6 2>/dev/null | while IFS= read -r f; do [ "$f" = "$NEWEST" ] || rm -f "$f"; done
fi

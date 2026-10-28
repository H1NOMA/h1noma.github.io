#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  КОМИК · komik-site-sync — сайт с нашего сервера: свежий main с GitHub → /var/www/komik
#  Ставит его migrate/site.sh в /usr/local/bin/komik-site-sync и запускает таймером раз в минуту.
#  Руками:  komik-site-sync          — выложить, если на GitHub новая версия
#           komik-site-sync force    — выложить заново, даже если версия та же
#  Как устроено:
#   · дёшево спрашиваем у GitHub, какой сейчас коммит в main (git ls-remote); тот же — ничего не делаем;
#   · новый — забираем только его (git fetch --depth 1) и раскладываем в отдельную папку releases/<коммит>;
#   · текстовые файлы (index.html, data/*.json, …) сжимаем заранее — .br, .zst, .gz рядом с файлом;
#     Caddy отдаёт готовое (precompressed), а не жмёт 8 МБ справочника на каждый запрос. Сжатое кэшируется
#     по содержимому файла: при обычной правке пережимается только index.html и sw.js;
#   · время файла — по его содержимому, а не по коммиту: у неизменных файлов ETag тот же от выкладки
#     к выкладке, и браузер не перекачивает справочник после каждой правки кода;
#   · подменяем сайт одной операцией (ссылка /var/www/komik → новая папка): ни один посетитель не получит
#     половину старой и половину новой версии. Хранятся текущая и предыдущая выкладки.
#   GitHub недоступен или что-то упало — сайт остаётся прежним, в следующую минуту попробуем снова.
#   Раз в сутки — уборка: копии на сервере старше недели (как в restore.sh) и мусор git.
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
REPO="${KOMIK_SITE_REPO:-https://github.com/H1NOMA/h1noma.github.io.git}"
BRANCH="${KOMIK_SITE_BRANCH:-main}"
BASE="${KOMIK_SITE_BASE:-/var/lib/komik-site}"
LIVE="${KOMIK_SITE_LIVE:-/var/www/komik}"
SELF="${KOMIK_SITE_SELF:-/usr/local/bin/komik-site-sync}"
GITD="$BASE/repo.git"; REL="$BASE/releases"; ZC="$BASE/zcache"
mkdir -p "$REL" "$ZC"
exec 9>"$BASE/lock"; flock -n 9 || exit 0          # прошлый запуск ещё идёт
[ -d "$GITD" ] || git init -q --bare "$GITD"

SHA=$(timeout 60 git ls-remote "$REPO" "refs/heads/$BRANCH" 2>/dev/null | cut -f1) || SHA=""
if [ ${#SHA} != 40 ]; then echo "GitHub не ответил — сайт остаётся прежним"; exit 0; fi
CUR=$(basename "$(readlink "$LIVE" 2>/dev/null || echo none)")
if [ "$CUR" = "$SHA" ] && [ "${1:-}" != force ]; then exit 0; fi

timeout 900 git -C "$GITD" fetch -q --depth 1 "$REPO" "+refs/heads/$BRANCH:refs/heads/$BRANCH"
SHA=$(git -C "$GITD" rev-parse "refs/heads/$BRANCH")   # main мог уйти вперёд между ls-remote и fetch
NEW="$REL/.part-$SHA"
rm -rf "$NEW"; mkdir -p "$NEW"
git -C "$GITD" archive "$SHA" | tar -x -C "$NEW"

# сжатие и время файлов: идём по дереву коммита (blob — хэш содержимого)
HAVE_BR=$(command -v brotli || true); HAVE_ZST=$(command -v zstd || true)
pack(){ # pack <blob> <файл> <расш> <команда…>: сжатое — в кэш по содержимому, в выкладку — жёсткой ссылкой
  local blob=$1 f=$2 ext=$3; shift 3
  if [ ! -s "$ZC/$blob.$ext" ]; then "$@" < "$f" > "$ZC/$blob.$ext.tmp" && mv "$ZC/$blob.$ext.tmp" "$ZC/$blob.$ext"; fi
  ln -f "$ZC/$blob.$ext" "$f.$ext"
}
while IFS= read -r -d '' rec; do
  meta=${rec%%$'\t'*}; path=${rec#*$'\t'}
  read -r _mode type blob <<< "$meta"
  [ "$type" = blob ] || continue
  f="$NEW/$path"; [ -f "$f" ] && [ ! -L "$f" ] || continue
  t=$((1600000000 + 16#${blob:0:6}))
  case "$path" in
    *.html|*.js|*.css|*.json|*.webmanifest|*.svg|*.txt|*.md|*.xml)
      if [ "$(stat -c %s "$f")" -ge 1024 ]; then
        pack "$blob" "$f" gz gzip -9 -n -c
        [ -z "$HAVE_BR" ]  || pack "$blob" "$f" br brotli -q 11 -c
        [ -z "$HAVE_ZST" ] || pack "$blob" "$f" zst zstd -19 -q -c
        for x in gz br zst; do [ ! -e "$f.$x" ] || touch -h -d "@$t" "$f.$x"; done
      fi ;;
  esac
  touch -h -d "@$t" "$f"
done < <(git -C "$GITD" -c core.quotePath=false ls-tree -r -z "$SHA")
chmod -R a+rX "$NEW"

# подмена одной операцией: ссылка на новую папку
rm -rf "${REL:?}/$SHA"; mv -T "$NEW" "$REL/$SHA"
mkdir -p "$(dirname "$LIVE")"
ln -sfn "$REL/$SHA" "$LIVE.tmp"; mv -Tf "$LIVE.tmp" "$LIVE"
echo "Сайт обновлён: ${SHA:0:7} ($(git -C "$GITD" log -1 --format=%s "$SHA" | cut -c1-80))"

# хранится текущая и предыдущая выкладка; сжатое, которым никто не пользуется, — в утиль
find "$REL" -mindepth 1 -maxdepth 1 -type d -name '.part-*' -mmin +60 -exec rm -rf {} +
mapfile -t OLD < <(find "$REL" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %p\n' | sort -nr | tail -n +3 | cut -d' ' -f2-)
for d in "${OLD[@]}"; do [ "$d" = "$REL/$SHA" ] || rm -rf "$d"; done
find "$ZC" -type f -links 1 -delete

# сам себя обновляет из выложенной версии (если новая проходит проверку синтаксиса)
NEWSELF="$REL/$SHA/migrate/site-sync.sh"
if [ -f "$NEWSELF" ] && [ -w "$(dirname "$SELF")" ] && ! cmp -s "$NEWSELF" "$SELF" && bash -n "$NEWSELF"; then
  install -m 755 "$NEWSELF" "$SELF" && echo "komik-site-sync обновлён"
fi

# раз в сутки: копии на сервере старше недели (последняя копия аккаунтов остаётся) и мусор git
STAMP="$BASE/daily"
if [ -z "${KOMIK_SITE_NOPRUNE:-}" ] && { [ ! -e "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +1440)" ]; }; then
  touch "$STAMP"
  find /root -maxdepth 1 -name 'kv-before-restore-*.json.gz' -mtime +6 -delete 2>/dev/null || true
  NEWEST=$(find /root -maxdepth 1 -name 'auth-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)
  find /root -maxdepth 1 -name 'auth-*.sql.gz' -mtime +6 2>/dev/null | while IFS= read -r f; do [ "$f" = "$NEWEST" ] || rm -f "$f"; done
  git -C "$GITD" reflog expire --expire=now --all 2>/dev/null || true
  git -C "$GITD" gc -q --prune=now 2>/dev/null || true
fi

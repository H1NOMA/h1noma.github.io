#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  КОМИК · komik-site-sync — сайт с нашего сервера: свежий main с GitHub → /var/lib/komik-site/live
#  Ставит его migrate/site.sh (владелец, от root) в /usr/local/bin/komik-site-sync; таймер komik-site.timer
#  запускает его раз в минуту от служебного пользователя komik-site — без шелла, без sudo, писать может только
#  в /var/lib/komik-site. Caddy отдаёт /var/www/komik — постоянную ссылку root на /var/lib/komik-site/live.
#  Сам себя НЕ обновляет: новую версию синка ставит только site.sh, запущенный владельцем. Раньше синк от root
#  ставил себя из выкладки — и любой пуш в main через минуту исполнялся на сервере от root.
#  Руками (от root):  systemctl start komik-site          — выложить, если на GitHub новая версия
#                     systemctl start komik-site-force    — выложить заново, даже если версия та же
#                     (или komik-site-sync [force] — от root сам переключится на пользователя komik-site)
#  Как устроено:
#   · дёшево спрашиваем у GitHub, какой сейчас коммит в main (git ls-remote); тот же — ничего не делаем;
#   · новый — забираем только его (git fetch --depth 1) и раскладываем в отдельную папку releases/<коммит>;
#   · текстовые файлы (index.html, data/*.json, …) сжимаем заранее — .br, .zst, .gz рядом с файлом;
#     Caddy отдаёт готовое (precompressed), а не жмёт 8 МБ справочника на каждый запрос. Сжатое кэшируется
#     по содержимому файла: при обычной правке пережимается только index.html и sw.js;
#   · время файла — по его содержимому, а не по коммиту: у неизменных файлов ETag тот же от выкладки
#     к выкладке, и браузер не перекачивает справочник после каждой правки кода;
#   · подменяем сайт одной операцией (ссылка live → новая папка): ни один посетитель не получит
#     половину старой и половину новой версии. Хранятся текущая и предыдущая выкладки.
#   GitHub недоступен или что-то упало — сайт остаётся прежним, в следующую минуту попробуем снова.
#   Раз в сутки — уборка мусора git (копии в /root чистит komik-backup: сюда /root не виден).
#  Песочница (без root, tests/README.md): KOMIK_SITE_BASE=… KOMIK_SITE_LIVE=… KOMIK_SITE_NOPRUNE=1 bash migrate/site-sync.sh
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
REPO="${KOMIK_SITE_REPO:-https://github.com/H1NOMA/h1noma.github.io.git}"
BRANCH="${KOMIK_SITE_BRANCH:-main}"
BASE="${KOMIK_SITE_BASE:-/var/lib/komik-site}"
LIVE="${KOMIK_SITE_LIVE:-$BASE/live}"
# то, что отдаёт Caddy; синк его не трогает — кроме перехода со старой схемы (ниже)
WEBROOT="${KOMIK_SITE_ROOT:-/var/www/komik}"
GITD="$BASE/repo.git"; REL="$BASE/releases"; ZC="$BASE/zcache"
umask 022

# от root — только пока сервер не переведён на служебного пользователя: файлы root в его каталоге он потом
# не смог бы менять. Каталог уже чужой (site.sh отдал его komik-site) — работаем от его хозяина
if [ "$(id -u)" = 0 ] && [ -d "$BASE" ] && [ "$(stat -c %u "$BASE")" != 0 ]; then
  exec runuser -u "$(stat -c %U "$BASE")" -- bash "$0" "$@"
fi
# git читает ~/.gitconfig: в /root служебному пользователю нельзя — тогда «дом» = его каталог
if [ ! -r "${HOME:-/nonexistent}" ] || [ ! -x "${HOME:-/nonexistent}" ]; then export HOME="$BASE"; fi

mkdir -p "$REL" "$ZC"
exec 9>"$BASE/lock"
# прошлый запуск ещё идёт — выходим; force (его ждут site.sh и владелец) — ждёт его конца
if [ "${1:-}" = force ]; then flock -w 900 9; else flock -n 9 || exit 0; fi
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
# ссылки из репозитория не выкладываем: Caddy пошёл бы по ним за пределы сайта (в репозитории их нет)
find "$NEW" -type l -delete

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
chmod -R a+rX "$NEW"   # Caddy (пользователь caddy) должен читать всё

# подмена одной операцией: ссылка на новую папку. Та же версия заново (force) — прежнюю папку не стираем,
# а отодвигаем (переименование мгновенно): сайт ни на миг не остаётся без файлов
rm -rf "${REL:?}/.old-$SHA"
if [ -e "$REL/$SHA" ]; then mv -T "$REL/$SHA" "$REL/.old-$SHA"; fi
mv -T "$NEW" "$REL/$SHA"
mkdir -p "$(dirname "$LIVE")"
ln -sfn "$REL/$SHA" "$LIVE.tmp"; mv -Tf "$LIVE.tmp" "$LIVE"
# переход со старой схемы (до 29.10.2026 синк от root переключал саму /var/www/komik на папку выкладки):
# пока site.sh не перевёл сервер на пользователя komik-site, переключаем и её — иначе сайт застыл бы,
# а потом уборка ниже стёрла бы папку, на которую она указывает
if [ -L "$WEBROOT" ] && [[ "$(readlink "$WEBROOT")" == "$REL/"* ]] && [ -w "$(dirname "$WEBROOT")" ]; then
  ln -sfn "$REL/$SHA" "$WEBROOT.tmp" && mv -Tf "$WEBROOT.tmp" "$WEBROOT"
fi
rm -rf "${REL:?}/.old-$SHA"
echo "Сайт обновлён: ${SHA:0:7} ($(git -C "$GITD" log -1 --format="%<(80,trunc)%s" "$SHA" | sed "s/ *$//"))"

# хранится текущая и предыдущая выкладка; сжатое, которым никто не пользуется, — в утиль
find "$REL" -mindepth 1 -maxdepth 1 -type d \( -name '.part-*' -o -name '.old-*' \) -mmin +60 -exec rm -rf {} +
mapfile -t OLD < <(find "$REL" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %p\n' | sort -nr | tail -n +3 | cut -d' ' -f2-)
for d in "${OLD[@]}"; do [ "$d" = "$REL/$SHA" ] || rm -rf "$d"; done
find "$ZC" -type f -links 1 -delete

# раз в сутки: мусор git
STAMP="$BASE/daily"
if [ -z "${KOMIK_SITE_NOPRUNE:-}" ] && { [ ! -e "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +1440)" ]; }; then
  touch "$STAMP"
  git -C "$GITD" reflog expire --expire=now --all 2>/dev/null || true
  git -C "$GITD" gc -q --prune=now 2>/dev/null || true
fi

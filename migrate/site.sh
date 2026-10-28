#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  КОМИК · сайт komikdnd.ru — с нашего сервера (в России), а не с GitHub Pages
#  Зачем: облако уже здесь, а сам сайт (страница, справочник, шрифты) шёл с серверов GitHub за границей —
#  без VPN это медленно или не открывается вовсе. Отсюда он идёт быстро и сжатый brotli (на треть меньше).
#  GitHub остаётся «источником»: правки по-прежнему попадают в main, сервер забирает их сам раз в минуту.
#
#  Запуск на сервере (root):
#    bash <(curl -fsS https://komikdnd.ru/migrate/site.sh)         — поставить/обновить; ждёт, пока DNS укажет сюда
#    bash <(curl -fsS https://komikdnd.ru/migrate/site.sh) check   — проверить, всё ли работает
#    bash <(curl -fsS https://komikdnd.ru/migrate/site.sh) off     — убрать сайт из Caddy (если DNS вернули на GitHub)
#  Повторный запуск безопасен.
#  Что ставит: git, brotli, zstd, dnsutils; /usr/local/bin/komik-site-sync (migrate/site-sync.sh) и таймер
#  komik-site.timer (раз в минуту); блок komikdnd.ru в /etc/caddy/Caddyfile между строками «# komik-site».
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
DOMAIN=komikdnd.ru
CLOUD_DOMAIN=cloud.komikdnd.ru
REF="${KOMIK_REF:-main}"
CADDYFILE="${KOMIK_CADDYFILE:-/etc/caddy/Caddyfile}"
LIVE="${KOMIK_SITE_LIVE:-/var/www/komik}"
SYNC="${KOMIK_SITE_SELF:-/usr/local/bin/komik-site-sync}"
UNITS="${KOMIK_SYSTEMD_DIR:-/etc/systemd/system}"
NS=ns1.timeweb.ru                 # DNS komikdnd.ru — у Timeweb: спрашиваем сам источник, без кэшей провайдера
GH_IPS="185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153"
ME="bash <(curl -fsS https://komikdnd.ru/migrate/site.sh)"
say(){ printf '\n\033[1;32m══ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
bad(){ printf '\033[1;31m✗ %s\033[0m\n' "$*"; }
ok(){ printf '  %s ✓\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Запусти от root: ssh root@$CLOUD_DOMAIN"; exit 1; }
[ -f "$CADDYFILE" ] || { bad "нет $CADDYFILE — Caddy не установлен (сначала setup.sh)"; exit 1; }

# адрес этого сервера = адрес облака (cloud.komikdnd.ru уже смотрит сюда), сверяем с адресами машины
# (|| true: пустой ответ DNS — не ошибка, а «записи нет»; иначе set -e молча обрывал скрипт)
server_ip(){ local ip; ip=$(dig +short A "$CLOUD_DOMAIN" @"$NS" 2>/dev/null | grep -E '^[0-9.]+$' | tail -n 1 || true)
  if [ -n "$ip" ] && hostname -I | tr ' ' '\n' | grep -x "$ip" >/dev/null; then echo "$ip"; else hostname -I | awk '{print $1}'; fi; }
# что сейчас отдаёт DNS (у самого Timeweb): все A-записи имени, через пробел
dns_a(){ dig +short A "$1" @"$NS" 2>/dev/null | grep -E '^[0-9.]+$' | sort | tr '\n' ' ' | sed 's/ $//' || true; }

# блок сайта для Caddy. www — только если и он уже смотрит сюда (иначе Caddy зря долбит выдачу сертификата)
site_block(){ local www=$1
  cat <<EOF
# komik-site:begin — сайт КОМИК с этого сервера (migrate/site.sh). Руками не править: скрипт перезапишет
$DOMAIN {
	root * $LIVE
	# служебные файлы (.github и т.п.) не отдаём
	@hidden path /.*
	respond @hidden 404
	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
	# как было на GitHub Pages — 10 минут; страница и воркер — всегда сверяются (обновление доезжает сразу);
	# картинки и шрифты — сутки (имена фото в img/content содержат хэш)
	# (правила не пересекаются: общее правило Caddy применяет последним, и оно перебило бы частные)
	@fresh path / /index.html /sw.js
	header @fresh Cache-Control "no-cache"
	@media path /img/* /fonts/*
	header @media Cache-Control "public, max-age=86400"
	@rest not path / /index.html /sw.js /img/* /fonts/*
	header @rest Cache-Control "public, max-age=600"
	@mf path *.webmanifest
	header @mf Content-Type "application/manifest+json"
	@woff path *.woff2
	header @woff Content-Type "font/woff2"
	encode zstd gzip
	file_server {
		precompressed br zstd gzip
	}
}
EOF
  if [ "$www" = 1 ]; then printf 'www.%s {\n\tredir https://%s{uri} permanent\n}\n' "$DOMAIN" "$DOMAIN"; fi
  echo "# komik-site:end"
}
# убрать наш блок из Caddyfile (всё между метками), вывести остальное
caddy_without_block(){ sed '/^# komik-site:begin/,/^# komik-site:end/d' "$CADDYFILE"; }
caddy_apply(){ # caddy_apply <новый Caddyfile>: проверить, подложить, перечитать; не прошло — вернуть прежний
  local new=$1 bak; bak="$CADDYFILE.before-site-$(date +%Y%m%d-%H%M%S)"
  if ! caddy validate --adapter caddyfile --config "$new" >/dev/null 2>"$new.err"; then
    bad "новый Caddyfile не прошёл проверку — ничего не меняю:"; tail -5 "$new.err"; return 1; fi
  cp "$CADDYFILE" "$bak"; cp "$new" "$CADDYFILE"
  if systemctl reload caddy; then echo "  Caddy перечитал настройки ✓ (прежний файл: $bak)"
  else cp "$bak" "$CADDYFILE"; systemctl reload caddy || true; bad "Caddy не принял настройки — вернул прежние"; return 1; fi
}
https_ok(){ curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 15 --resolve "$1:443:127.0.0.1" "https://$1/sw.js" 2>/dev/null | grep -qx 200; }

check(){
  say "Проверка"
  local IP A GH LIVE_SHA S=0
  IP=$(server_ip); A=$(dns_a "$DOMAIN")
  if systemctl is-active -q komik-site.timer; then ok "обновление с GitHub раз в минуту (komik-site.timer) работает"
  else bad "таймер обновления не запущен — запусти $ME"; S=1; fi
  LIVE_SHA=$(basename "$(readlink "$LIVE" 2>/dev/null || echo нет)")
  GH=$(timeout 30 git ls-remote "https://github.com/H1NOMA/h1noma.github.io.git" refs/heads/main 2>/dev/null | cut -f1 || true)
  if [ -n "$GH" ] && [ "$LIVE_SHA" = "$GH" ]; then ok "на сервере свежая версия сайта (${GH:0:7})"
  elif [ -z "$GH" ]; then warn "GitHub не ответил — версию не сверить (на сервере ${LIVE_SHA:0:7})"
  else warn "на сервере ${LIVE_SHA:0:7}, на GitHub ${GH:0:7} — обычно догоняет за минуту (journalctl -u komik-site -n 20)"; fi
  if grep -q '^# komik-site:begin' "$CADDYFILE"; then ok "сайт есть в настройках Caddy"; else warn "сайта нет в настройках Caddy"; S=1; fi
  if [ "$A" = "$IP" ]; then ok "DNS: $DOMAIN → этот сервер ($IP)"
  else warn "DNS: $DOMAIN → ${A:-ничего}, а сервер — $IP (пока посетители идут на GitHub Pages)"; S=1; fi
  if https_ok "$DOMAIN"; then ok "https://$DOMAIN отвечает с этого сервера (сертификат есть)"
  else warn "https://$DOMAIN с этого сервера пока не отвечает (сертификата ещё нет — нужен DNS)"; S=1; fi
  free -h | awk '/^Mem|^Swap/ {printf "  память: %s %s занято из %s\n", $1, $3, $2}'
  if [ $S = 0 ]; then printf '\n\033[1;32mИтог: сайт идёт с этого сервера ✓\033[0m\n'; else printf '\n\033[1;33mИтог: не всё готово (см. выше)\033[0m\n'; fi
}

if [ "${1:-}" = check ]; then check; exit 0; fi
if [ "${1:-}" = off ]; then
  say "Убираю сайт из Caddy"
  T=$(mktemp); caddy_without_block > "$T"; caddy_apply "$T"
  echo "Сайт с этого сервера больше не отдаётся. Таймер обновления оставлен (выключить: systemctl disable --now komik-site.timer)."
  exit 0
fi

say "1/4 · Пакеты"
export DEBIAN_FRONTEND=noninteractive
need=""; for c in git:git brotli:brotli zstd:zstd dig:dnsutils flock:util-linux; do command -v "${c%%:*}" >/dev/null || need="$need ${c#*:}"; done
if [ -n "$need" ]; then apt-get update -q >/dev/null && apt-get install -yq $need >/dev/null; fi
ok "git, brotli, zstd, dig"

say "2/4 · Копия сайта с GitHub (первый раз — минуты две: качаем ~80 МБ и сжимаем)"
T=$(mktemp)
if curl -fsS --max-time 60 -o "$T" "https://raw.githubusercontent.com/H1NOMA/h1noma.github.io/$REF/migrate/site-sync.sh" \
   || curl -fsS --max-time 60 -o "$T" "https://$DOMAIN/migrate/site-sync.sh"; then
  bash -n "$T" && install -m 755 "$T" "$SYNC"
fi
[ -x "$SYNC" ] || { bad "не смог скачать migrate/site-sync.sh — проверь интернет и запусти ещё раз"; exit 1; }
# прежняя ручная папка /var/www/komik (не ссылка) — в сторону: дальше это ссылка на текущую выкладку
if [ -d "$LIVE" ] && [ ! -L "$LIVE" ]; then mv "$LIVE" "$LIVE.old-$(date +%Y%m%d-%H%M%S)"; fi
KOMIK_SITE_BRANCH="$REF" "$SYNC" force
[ -f "$LIVE/index.html" ] || { bad "сайт не выложился — пришли вывод выше"; exit 1; }
ok "сайт выложен: $(readlink "$LIVE")"

say "3/4 · Обновление раз в минуту"
cat > "$UNITS/komik-site.service" <<EOF
[Unit]
Description=КОМИК: забрать свежий сайт с GitHub (migrate/site-sync.sh)
After=network-online.target
[Service]
Type=oneshot
Environment=KOMIK_SITE_BRANCH=$REF
ExecStart=$SYNC
Nice=10
IOSchedulingClass=idle
EOF
cat > "$UNITS/komik-site.timer" <<'EOF'
[Unit]
Description=КОМИК: проверять новую версию сайта раз в минуту
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now komik-site.timer >/dev/null 2>&1
ok "таймер komik-site.timer включён (журнал: journalctl -u komik-site -n 20)"

say "4/4 · Caddy и DNS"
IP=$(server_ip)
echo "  адрес этого сервера: $IP"
A=$(dns_a "$DOMAIN")
if [ "$A" != "$IP" ]; then
  cat <<EOF

  Сейчас $DOMAIN указывает на: ${A:-ничего}
  Осталось переключить DNS — в панели Timeweb (домен $DOMAIN → DNS):
    1) у записи A для «$DOMAIN» (@) поставь значение $IP,
       а четыре старые A-записи GitHub ($GH_IPS) удали;
    2) запись для «www»: CNAME → $DOMAIN (вместо h1noma.github.io).
  Скрипт ждёт до 30 минут и сам включит сайт, как только DNS поменяется. Окно можно не закрывать.
  Закрыл — не страшно: после смены DNS просто запусти эту команду ещё раз.
EOF
  for i in $(seq 1 120); do
    sleep 15; A=$(dns_a "$DOMAIN")
    if [ "$A" = "$IP" ]; then echo; break; fi
    case " $A " in *" $IP "*) printf '\r  DNS: %s — видно и сервер, и GitHub: удали записи GitHub   ' "$A" ;;
      *) printf '\r  жду DNS… (%s мин) сейчас: %s   ' "$((i / 4))" "${A:-ничего}" ;; esac
  done
  if [ "$A" != "$IP" ]; then echo; warn "DNS так и не указал на этот сервер. Поменяй записи и запусти: $ME"; exit 0; fi
fi
ok "DNS: $DOMAIN → $IP"
WWW=0; W=$(dns_a "www.$DOMAIN"); [ "$W" = "$IP" ] && WWW=1
[ $WWW = 1 ] && ok "DNS: www.$DOMAIN → $IP" || warn "www.$DOMAIN пока не смотрит сюда (${W:-ничего}) — www включу при следующем запуске"
T=$(mktemp); { caddy_without_block; echo; site_block $WWW; } > "$T"
caddy_apply "$T"
printf '  жду сертификат https'
for i in $(seq 1 40); do if https_ok "$DOMAIN"; then echo; ok "https://$DOMAIN отвечает с этого сервера"; break; fi; printf '.'; sleep 3; done
https_ok "$DOMAIN" || { echo; warn "сертификат ещё не выдан — подожди пару минут и проверь: $ME check (журнал: journalctl -u caddy -n 30)"; }
check

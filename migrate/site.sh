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
#    bash site.sh render <папка>  — только записать в папку блок Caddy и юниты, ничего не ставя (проверка, без root)
#  Повторный запуск безопасен; он же переводит прежнюю установку (синк от root) на служебного пользователя.
#  Что ставит: git, brotli, zstd, dnsutils; служебного пользователя komik-site (без шелла и sudo) — хозяина
#  /var/lib/komik-site (выкладки и ссылка live); /usr/local/bin/komik-site-sync (migrate/site-sync.sh, владелец
#  root — сам себя не обновляет: новую версию ставит только этот скрипт); юниты komik-site.service (от komik-site,
#  с защитой systemd), komik-site-force.service (выложить заново) и таймер komik-site.timer (раз в минуту);
#  ссылку /var/www/komik → /var/lib/komik-site/live; блок komikdnd.ru в /etc/caddy/Caddyfile между строками «# komik-site».
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
DOMAIN=komikdnd.ru
CLOUD_DOMAIN=cloud.komikdnd.ru
REF="${KOMIK_REF:-main}"
CADDYFILE="${KOMIK_CADDYFILE:-/etc/caddy/Caddyfile}"
SITE_USER="${KOMIK_SITE_USER:-komik-site}"
BASE="${KOMIK_SITE_BASE:-/var/lib/komik-site}"     # каталог служебного пользователя: выкладки, git, кэш сжатия
LIVE="$BASE/live"                                   # её переключает синк при каждой выкладке
WEBROOT="${KOMIK_SITE_ROOT:-/var/www/komik}"        # её отдаёт Caddy: постоянная ссылка (root) → $LIVE
SYNC="${KOMIK_SITE_SELF:-/usr/local/bin/komik-site-sync}"
UNITS="${KOMIK_SYSTEMD_DIR:-/etc/systemd/system}"
NS=ns1.timeweb.ru                 # DNS komikdnd.ru — у Timeweb: спрашиваем сам источник, без кэшей провайдера
GH_IPS="185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153"
ME="bash <(curl -fsS https://komikdnd.ru/migrate/site.sh)"
say(){ printf '\n\033[1;32m══ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
bad(){ printf '\033[1;31m✗ %s\033[0m\n' "$*"; }
ok(){ printf '  %s ✓\n' "$*"; }

# блок сайта для Caddy. www — только если и он уже смотрит сюда (иначе Caddy зря долбит выдачу сертификата)
site_block(){ local www=$1
  cat <<EOF
# komik-site:begin — сайт КОМИК с этого сервера (migrate/site.sh). Руками не править: скрипт перезапишет
$DOMAIN {
	root * $WEBROOT
	# служебные файлы (.github и т.п.) не отдаём
	@hidden path /.*
	respond @hidden 404
	header {
		# браузер год ходит сюда только по https (без preload: из списка браузеров потом не выйти быстро)
		Strict-Transport-Security "max-age=31536000"
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
  if [ "$www" = 1 ]; then
    printf 'www.%s {\n\theader Strict-Transport-Security "max-age=31536000"\n\tredir https://%s{uri} permanent\n}\n' "$DOMAIN" "$DOMAIN"
  fi
  echo "# komik-site:end"
}

# юнит синка: от пользователя komik-site; писать — только в свой каталог, /root и /home не видно.
# unit_service <аргумент синка: пусто или force> <strict|base>. base — запасной набор (без тонких ограничений
# ядра и системных вызовов) на случай, если systemd этого сервера полный не примет; пользователь и «система
# только для чтения» есть в обоих
unit_service(){ local arg=$1 prof=$2
  cat <<EOF
[Unit]
Description=КОМИК: забрать свежий сайт с GitHub (migrate/site-sync.sh${arg:+ $arg})
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=$SITE_USER
Group=$SITE_USER
Environment=KOMIK_SITE_BRANCH=$REF
Environment=KOMIK_SITE_BASE=$BASE
Environment=KOMIK_SITE_LIVE=$LIVE
Environment=HOME=$BASE
ExecStart=$SYNC${arg:+ $arg}
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=30min
UMask=0022
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$BASE
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
CapabilityBoundingSet=
RestrictSUIDSGID=yes
EOF
  if [ "$prof" = strict ]; then
    cat <<'EOF'
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
EOF
  fi
}
unit_timer(){
  cat <<'EOF'
[Unit]
Description=КОМИК: проверять новую версию сайта раз в минуту
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
EOF
}

# для проверки (tests/README.md): что запишется — без root и ничего не трогая
if [ "${1:-}" = render ]; then
  D="${2:?куда писать: site.sh render <папка>}"
  site_block 1 > "$D/komik-site.caddy"
  unit_service "" strict > "$D/komik-site.service"
  unit_service force strict > "$D/komik-site-force.service"
  unit_service "" base > "$D/komik-site.base.service"
  unit_timer > "$D/komik-site.timer"
  echo "записано в $D: komik-site.caddy, komik-site.service, komik-site-force.service, komik-site.base.service, komik-site.timer"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "Запусти от root: ssh root@$CLOUD_DOMAIN"; exit 1; }
[ -f "$CADDYFILE" ] || { bad "нет $CADDYFILE — Caddy не установлен (сначала setup.sh)"; exit 1; }

# адрес этого сервера = адрес облака (cloud.komikdnd.ru уже смотрит сюда), сверяем с адресами машины
# (|| true: пустой ответ DNS — не ошибка, а «записи нет»; иначе set -e молча обрывал скрипт)
server_ip(){ local ip; ip=$(dig +short A "$CLOUD_DOMAIN" @"$NS" 2>/dev/null | grep -E '^[0-9.]+$' | tail -n 1 || true)
  if [ -n "$ip" ] && hostname -I | tr ' ' '\n' | grep -x "$ip" >/dev/null; then echo "$ip"; else hostname -I | awk '{print $1}'; fi; }
# что сейчас отдаёт DNS (у самого Timeweb): все A-записи имени, через пробел
dns_a(){ dig +short A "$1" @"$NS" 2>/dev/null | grep -E '^[0-9.]+$' | sort | tr '\n' ' ' | sed 's/ $//' || true; }

# убрать наш блок из Caddyfile (всё между метками), вывести остальное
caddy_without_block(){ sed '/^# komik-site:begin/,/^# komik-site:end/d' "$CADDYFILE"; }
caddy_apply(){ # caddy_apply <новый Caddyfile>: проверить, подложить, перечитать; не прошло — вернуть прежний
  local new=$1 bak; bak="$CADDYFILE.before-site-$(date +%Y%m%d-%H%M%S)"
  if cmp -s "$new" "$CADDYFILE"; then echo "  настройки Caddy уже такие ✓"; return 0; fi
  if ! caddy validate --adapter caddyfile --config "$new" >/dev/null 2>"$new.err"; then
    bad "новый Caddyfile не прошёл проверку — ничего не меняю:"; tail -5 "$new.err"; return 1; fi
  cp "$CADDYFILE" "$bak"; cp "$new" "$CADDYFILE"
  if systemctl reload caddy; then echo "  Caddy перечитал настройки ✓ (прежний файл: $bak)"
  else cp "$bak" "$CADDYFILE"; systemctl reload caddy || true; bad "Caddy не принял настройки — вернул прежние"; return 1; fi
}
https_ok(){ curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 15 --resolve "$1:443:127.0.0.1" "https://$1/sw.js" 2>/dev/null | grep -qx 200; }

check(){
  say "Проверка"
  local IP A GH LIVE_SHA U S=0
  IP=$(server_ip); A=$(dns_a "$DOMAIN")
  if systemctl is-active -q komik-site.timer; then ok "обновление с GitHub раз в минуту (komik-site.timer) работает"
  else bad "таймер обновления не запущен — запусти $ME"; S=1; fi
  U=$(systemctl show -p User --value komik-site.service 2>/dev/null || true)
  if [ -n "$U" ] && [ "$U" != root ]; then ok "обновление идёт от пользователя $U, не от root"
  else bad "обновление сайта идёт от root — запусти $ME (переведёт на пользователя $SITE_USER)"; S=1; fi
  if systemctl is-failed -q komik-site.service; then bad "последнее обновление упало: journalctl -u komik-site -n 20"; S=1; fi
  LIVE_SHA=$(basename "$(readlink -f "$WEBROOT" 2>/dev/null || echo нет)")
  GH=$(timeout 30 git ls-remote "https://github.com/H1NOMA/h1noma.github.io.git" refs/heads/main 2>/dev/null | cut -f1 || true)
  if [ -n "$GH" ] && [ "$LIVE_SHA" = "$GH" ]; then ok "на сервере свежая версия сайта (${GH:0:7})"
  elif [ -z "$GH" ]; then warn "GitHub не ответил — версию не сверить (на сервере ${LIVE_SHA:0:7})"
  else warn "на сервере ${LIVE_SHA:0:7}, на GitHub ${GH:0:7} — обычно догоняет за минуту (journalctl -u komik-site -n 20)"; fi
  # синк сам себя больше не обновляет: новая версия в репозитории — повод запустить site.sh
  if [ -f "$WEBROOT/migrate/site-sync.sh" ] && ! cmp -s "$WEBROOT/migrate/site-sync.sh" "$SYNC"; then
    warn "в репозитории новая версия komik-site-sync — поставить её: $ME"; fi
  if grep -q '^# komik-site:begin' "$CADDYFILE"; then ok "сайт есть в настройках Caddy"; else warn "сайта нет в настройках Caddy"; S=1; fi
  if grep -q 'Strict-Transport-Security' <(sed -n '/^# komik-site:begin/,/^# komik-site:end/p' "$CADDYFILE"); then ok "HSTS включён"
  else warn "в блоке сайта нет HSTS — запусти $ME"; S=1; fi
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

say "1/5 · Пакеты"
export DEBIAN_FRONTEND=noninteractive
need=""; for c in git:git brotli:brotli zstd:zstd dig:dnsutils flock:util-linux runuser:util-linux; do command -v "${c%%:*}" >/dev/null || need="$need ${c#*:}"; done
# shellcheck disable=SC2086   # need — список пакетов через пробел
if [ -n "$need" ]; then apt-get update -q >/dev/null && apt-get install -yq $need >/dev/null; fi
ok "git, brotli, zstd, dig"

say "2/5 · Служебный пользователь $SITE_USER (без шелла и sudo)"
if ! id -u "$SITE_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$BASE" --no-create-home --shell /usr/sbin/nologin --comment "KOMIK site sync" "$SITE_USER"
  ok "пользователь $SITE_USER создан"
fi
[ "$(id -u "$SITE_USER")" != 0 ] || { bad "у $SITE_USER uid 0 (это root) — отмена"; exit 1; }
GRP=" $(id -nG "$SITE_USER") "
for g in root sudo admin wheel adm docker lxd; do
  [[ "$GRP" != *" $g "* ]] || { bad "$SITE_USER в группе $g — так нельзя: gpasswd -d $SITE_USER $g, потом запусти ещё раз"; exit 1; }
done
[ "$(getent passwd "$SITE_USER" | cut -d: -f7)" = /usr/sbin/nologin ] || usermod -s /usr/sbin/nologin "$SITE_USER"
ok "$SITE_USER: без шелла, без sudo и docker"
# пока переводим — таймер стоит (иначе он запустил бы синк посреди переезда); уже идущий синк — дожидаемся.
# Что бы ни случилось дальше, на выходе таймер снова запущен: сайт не должен перестать обновляться
systemctl stop komik-site.timer 2>/dev/null || true
trap 'systemctl start komik-site.timer 2>/dev/null || true' EXIT
install -d -m 755 "$BASE"
flock -w 900 "$BASE/lock" true 2>/dev/null || true

say "3/5 · Синк и защита systemd"
T=$(mktemp); SYNC_OK=""
if curl -fsS --max-time 60 -o "$T" "https://raw.githubusercontent.com/H1NOMA/h1noma.github.io/$REF/migrate/site-sync.sh" \
   || curl -fsS --max-time 60 -o "$T" "https://$DOMAIN/migrate/site-sync.sh"; then
  # хозяин — root: служебный пользователь свою программу поменять не может
  bash -n "$T" && grep -q 'komik-site-sync' "$T" && install -m 755 -o root -g root "$T" "$SYNC" && SYNC_OK=1
fi
rm -f "$T"
[ -n "$SYNC_OK" ] || { bad "не смог скачать migrate/site-sync.sh — ничего не менял; проверь интернет и запусти ещё раз"; exit 1; }
# выкладки прежней схемы (их делал root) — новому хозяину; -h: ссылки меняем сами, а не то, куда они ведут
chown -R -h "$SITE_USER:$SITE_USER" "$BASE"
chmod 755 "$BASE"
ok "$BASE принадлежит $SITE_USER"
units(){ # units <strict|base>: записать юниты и перечитать
  unit_service "" "$1" > "$UNITS/komik-site.service"
  unit_service force "$1" > "$UNITS/komik-site-force.service"
  unit_timer > "$UNITS/komik-site.timer"
  systemctl daemon-reload
}
# выкладка заново — через тот же юнит, с той же защитой: так сразу видно, что git, tar, brotli и zstd в ней работают
run_force(){ local t0 rc=0; t0=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl start komik-site-force.service || rc=$?
  journalctl -u komik-site-force --since "$t0" -o cat --no-pager 2>/dev/null | tail -n "$([ $rc = 0 ] && echo 3 || echo 15)" | sed 's/^/  /'
  return $rc
}
units strict
ok "юниты записаны: komik-site.service, komik-site-force.service, komik-site.timer"

say "4/5 · Копия сайта с GitHub (первый раз — минуты две: качаем ~80 МБ и сжимаем)"
if run_force; then ok "выложено от пользователя $SITE_USER с полной защитой systemd"
else
  warn "systemd этого сервера не принял полную защиту — пробую запасную (тот же пользователь, система только для чтения)"
  units base
  run_force || { bad "выкладка от пользователя $SITE_USER не прошла — сайт остался прежним. Пришли вывод выше программисту"; exit 1; }
  ok "выложено от пользователя $SITE_USER (запасная защита)"
fi
[ -f "$LIVE/index.html" ] || { bad "сайт не выложился — пришли вывод выше"; exit 1; }
# прежняя ручная папка /var/www/komik (не ссылка) — в сторону; дальше это постоянная ссылка на $LIVE
if [ -d "$WEBROOT" ] && [ ! -L "$WEBROOT" ]; then mv "$WEBROOT" "$WEBROOT.old-$(date +%Y%m%d-%H%M%S)"; fi
if [ "$(readlink "$WEBROOT" 2>/dev/null || true)" != "$LIVE" ]; then
  mkdir -p "$(dirname "$WEBROOT")"
  ln -sfn "$LIVE" "$WEBROOT.tmp"; mv -Tf "$WEBROOT.tmp" "$WEBROOT"
fi
[ -f "$WEBROOT/index.html" ] || { bad "сайт не виден по $WEBROOT — пришли вывод выше"; exit 1; }
# Caddy читает файлы от своего пользователя — проверяем его глазами
if id caddy >/dev/null 2>&1; then
  if runuser -u caddy -- test -r "$WEBROOT/index.html"; then ok "Caddy видит файлы сайта"
  else bad "пользователь caddy не может прочитать $WEBROOT/index.html — пришли вывод программисту"; exit 1; fi
fi
ok "сайт выложен: $(readlink -f "$WEBROOT")"
systemctl enable --now komik-site.timer >/dev/null 2>&1
if systemctl start komik-site.service; then ok "обновление раз в минуту (komik-site.timer) включено (журнал: journalctl -u komik-site -n 20)"
else bad "проверочный запуск komik-site.service упал: journalctl -u komik-site -n 20 — пришли программисту"; fi

say "5/5 · Caddy и DNS"
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
if [ $WWW = 1 ]; then ok "DNS: www.$DOMAIN → $IP"; else warn "www.$DOMAIN пока не смотрит сюда (${W:-ничего}) — www включу при следующем запуске"; fi
T=$(mktemp); { caddy_without_block; echo; site_block $WWW; } | cat -s > "$T"
caddy_apply "$T"
rm -f "$T" "$T.err"
printf '  жду сертификат https'
for i in $(seq 1 40); do if https_ok "$DOMAIN"; then echo; ok "https://$DOMAIN отвечает с этого сервера"; break; fi; printf '.'; sleep 3; done
https_ok "$DOMAIN" || { echo; warn "сертификат ещё не выдан — подожди пару минут и проверь: $ME check (журнал: journalctl -u caddy -n 30)"; }
check

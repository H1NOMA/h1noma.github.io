# Проверки КОМИК

Локальный стенд: сайт и имитация облака на одном адресе (`tests/mock_cloud.py`), браузерные проверки на
Playwright. Облако настоящее не трогается: страница ходит в стенд через `localStorage['comik:cloud']`.

```bash
# данные для стенда — любой снапшот kv или выгрузка таблицы. С 29.10.2026 копии в ветке backups зашифрованы
# (kv-ДАТА.json.gz.gpg, migrate/RESTORE.md, раздел 10): расшифровать может только владелец парольной фразы
git fetch origin backups && git show origin/backups:backups/kv-2026-10-29.json.gz.gpg > /tmp/kv.json.gz.gpg
gpg -o /tmp/kv.json.gz -d /tmp/kv.json.gz.gpg                # спросит фразу
python3 tests/mock_cloud.py --seed /tmp/kv.json.gz &        # http://127.0.0.1:8765

node tests/syntax.js     # синтаксис всех <script> и sw.js
node tests/smoke.js      # все разделы: гость / игрок / команда, телефон 390 и десктоп 1440, ошибок в консоли нет
node tests/images.js     # фото отдельными строками comik:img:<хэш>: перенос, загрузка, кэш, права, копии, zip
node tests/flaky.js      # плохая сеть (обрывы, задержки): данные доезжают, правки не теряются
node tests/offline.js    # второй заход без сети: воркер, архив с устройства, фото из IndexedDB
node tests/formulas.js   # формулы бросков (кнопка «#» ГМа): таблицы по группам, раскрытие, поиск, ширина экрана
```

`images.js` ждёт снапшот, где фото ещё внутри строк (до 28.10.2026); `smoke.js` и `flaky.js` — любой;
`offline.js` — после выноса (стенд сам переносит, если войти командой).

Учётки стенда: `hinoma`, `herr_teo`, `arlissss` (команда), `testplayer`, `player_two` — пароль `password123`.
Ручки стенда: `GET/POST /__mock/rows` (строки kv), `GET/DELETE /__mock/log` (журнал запросов),
`POST /__mock/fail {"rate":0.25,"slow":300,"player_img":false}` (обрывы, задержка, сервер без миграции 10-28).

Миграции сервера на чистом Postgres (нужен `postgres`/`initdb` 16):

```bash
PGHOST=/путь/к/сокету PGPORT=55432 PGUSER=postgres bash tests/sql/run.sh
```

Серверные скрипты проверяются в песочнице, без root и без настоящего сервера — пути через переменные,
папки — `mktemp -d`:

```bash
S=$(mktemp -d)
# выкладка сайта (migrate/site-sync.sh): забирает main с GitHub, сжимает, подменяет ссылку; себя никуда не ставит.
# KOMIK_SITE_LIVE — ссылка, которую он переключает (на сервере /var/lib/komik-site/live); KOMIK_SITE_SELF больше не нужен
KOMIK_SITE_BASE=$S/lib KOMIK_SITE_LIVE=$S/www/komik KOMIK_SITE_NOPRUNE=1 bash migrate/site-sync.sh

# блоки Caddy и юниты: site.sh пишет их в папку, push.sh/setup.sh печатают Caddyfile облака
# (оба должны дать один и тот же файл; повторный render готового файла его не меняет)
mkdir $S/r && bash migrate/site.sh render $S/r
cp /etc/caddy/Caddyfile $S/Caddyfile 2>/dev/null || touch $S/Caddyfile
KOMIK_CADDYFILE=$S/Caddyfile bash migrate/push.sh render > $S/cloud.caddy
KOMIK_CADDYFILE=$S/Caddyfile bash migrate/setup.sh render | cmp - $S/cloud.caddy
cat $S/cloud.caddy $S/r/komik-site.caddy > $S/all.caddy && caddy validate --adapter caddyfile --config $S/all.caddy
systemd-analyze security --offline=yes $S/r/komik-site.service          # у полной защиты ~1.5

# зашифрованная копия (migrate/backup.sh): вместо docker exec — готовый JSON
KOMIK_BK_DIR=$S/bk KOMIK_BK_PASS=$S/pass bash migrate/backup.sh init
KOMIK_BK_DIR=$S/bk KOMIK_BK_PASS=$S/pass KOMIK_BK_NOPRUNE=1 KOMIK_BK_DUMP_CMD="gzip -dc /tmp/kv.json.gz" bash migrate/backup.sh
gpg --batch --pinentry-mode loopback --passphrase-file $S/pass -d $S/bk/latest.json.gz.gpg | gzip -dc | head -c 200

# вход только по ключу (migrate/harden.sh ssh-keys) — от root, но на своём sshd_config, системный не трогается
#   KOMIK_SSH_AUTHKEYS=$S/authorized_keys KOMIK_SSHD_CONFIG=$S/sshd_config KOMIK_SSHD_DROPIN=$S/d/00-komik.conf \
#   bash migrate/harden.sh ssh-keys

# workflow бэкапа: actionlint .github/workflows/backup-kv.yml (его bash-шаг можно прогнать против
# python3 -m http.server над $S/bk и голого git-репозитория вместо origin)
```

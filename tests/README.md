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
node tests/newsfx.js     # новости на телефоне: приветствие уходит в пилюлю сеттинга, «Ближайшая игра» плавает; без анимаций
                         # и на десктопе — как было (подменяет строки стенда своей игрой; папка аргументом — кадры прокрутки)
node tests/images.js     # фото отдельными строками comik:img:<хэш>: перенос, загрузка, кэш, права, копии, zip
node tests/flaky.js      # плохая сеть (обрывы, задержки): данные доезжают, правки не теряются
node tests/offline.js    # второй заход без сети: воркер, архив с устройства, фото из IndexedDB
node tests/formulas.js   # формулы бросков (кнопка «#» ГМа): таблицы по группам, раскрытие, поиск, ширина экрана
node tests/masonry.js    # листы игроков без пробелов: 375–1920, порядок, разделитель ГМа, открытый лист, смена ширины (листы кладёт сам)
node tests/access.js     # права 10-29 со стороны сайта: чужие листы — витриной, свои — целиком; личные пуш-подписки; только свои картинки
node tests/account.js    # профиль (закладки, уведомления, пароль, выход); игрок сам удаляет аккаунт (API 4): строки, вход, устройство
```

`images.js` ждёт снапшот, где фото ещё внутри строк (до 28.10.2026); `smoke.js` и `flaky.js` — любой;
`offline.js` — после выноса (стенд сам переносит, если войти командой).

Учётки стенда: `hinoma`, `herr_teo`, `arlissss` (команда), `testplayer`, `player_two` — пароль `password123`.
Ручки стенда: `GET/POST /__mock/rows` (строки kv), `GET/DELETE /__mock/log` (журнал запросов),
`POST /__mock/fail {"rate":0.25,"slow":300,"player_img":false,"v3":false,"v4":false}` (обрывы, задержка, сервер без миграции
10-28 / 10-29 / без удаления аккаунта). Стенд по умолчанию — сервер с миграцией 10-29: чужие листы игроку и гостю — только через
витрину `kv_chars_pub`; API 4: `rpc/komik_delete_me` (в режиме `--pg` — функция из базы), смена пароля `PUT /auth/v1/user`.

Миграции сервера на чистом Postgres (нужен `postgres`/`initdb` 16):

```bash
PGHOST=/путь/к/сокету PGPORT=55432 PGUSER=postgres bash tests/sql/run.sh
```

Тот же сайт против **настоящих** прав и триггеров: база со всеми миграциями и стенд в режиме `--pg` — запросы сайта
переводятся в SQL и идут через `psql` от имени anon/authenticated с токеном, как у PostgREST (стенд сам сервер не
имитирует: правила RLS, витрина, санитайзер общих строк — из миграций):

```bash
export PGHOST=/путь/к/сокету PGPORT=55432 PGUSER=postgres
bash tests/sql/stand.sh                                               # база komik_stand
python3 tests/mock_cloud.py --port 8766 --pg komik_stand --seed /tmp/kv.json.gz &
KOMIK_BASE=http://127.0.0.1:8766 node tests/shared.js   # общие строки: ХП только своей карточки, ГМ ставит тег владельца,
                                                        # двое на последнее место — сайты сходятся с облаком
KOMIK_BASE=http://127.0.0.1:8766 node tests/access.js   # и любые другие проверки (smoke.js, flaky.js…)
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

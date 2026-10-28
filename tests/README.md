# Проверки КОМИК

Локальный стенд: сайт и имитация облака на одном адресе (`tests/mock_cloud.py`), браузерные проверки на
Playwright. Облако настоящее не трогается: страница ходит в стенд через `localStorage['comik:cloud']`.

```bash
# данные для стенда — любой снапшот kv (ветка backups) или выгрузка таблицы
git fetch origin backups && git show origin/backups:backups/kv-2026-10-28.json.gz > /tmp/kv.json.gz
python3 tests/mock_cloud.py --seed /tmp/kv.json.gz &        # http://127.0.0.1:8765

node tests/syntax.js     # синтаксис всех <script> и sw.js
node tests/smoke.js      # все разделы: гость / игрок / команда, телефон 390 и десктоп 1440, ошибок в консоли нет
node tests/images.js     # фото отдельными строками comik:img:<хэш>: перенос, загрузка, кэш, права, копии, zip
node tests/flaky.js      # плохая сеть (обрывы, задержки): данные доезжают, правки не теряются
node tests/offline.js    # второй заход без сети: воркер, архив с устройства, фото из IndexedDB
```

`images.js` и `smoke.js` ждут снапшот, где фото ещё внутри строк (до 28.10.2026) или уже вынесены —
неважно; `offline.js` — после выноса (стенд сам переносит, если войти командой).

Учётки стенда: `hinoma`, `herr_teo`, `arlissss` (команда), `testplayer`, `player_two` — пароль `password123`.
Ручки стенда: `GET/POST /__mock/rows` (строки kv), `GET/DELETE /__mock/log` (журнал запросов),
`POST /__mock/fail {"rate":0.25,"slow":300,"player_img":false}` (обрывы, задержка, сервер без миграции 10-28).

Миграции сервера на чистом Postgres (нужен `postgres`/`initdb` 16):

```bash
PGHOST=/путь/к/сокету PGPORT=55432 PGUSER=postgres bash tests/sql/run.sh
```

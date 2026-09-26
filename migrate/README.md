# КОМИК · миграции облака (Supabase, cloud.komikdnd.ru)

**Что делать, если сервер умер, данные испортили, кто-то ушёл из команды или надо закрыть регистрацию —
[RESTORE.md](RESTORE.md)** (памятка владельца, по шагам).

| Файл | Что делает | Как запускать |
|---|---|---|
| `push.sh` | Главная команда обслуживания: VAPID-ключи и функция notify-game, защита входа (GoTrue: лимит попыток по IP, пароль от 8 символов), **все четыре миграции базы по порядку** и в конце проверка «Итог: защита базы включена ✓». Повторный запуск безопасен. | `bash <(curl -fsS https://komikdnd.ru/migrate/push.sh)` (на вопрос о ключе — Enter) |
| `push.sh check` | Только проверка защиты базы и входа, ничего не меняет. | `bash <(curl -fsS https://komikdnd.ru/migrate/push.sh) check` |
| `setup.sh` | Полная установка облака на чистый сервер (Docker, Supabase, те же миграции, Caddy); данные — из свежей копии в ветке `backups`, аккаунты — из `/root/auth-*.sql.gz`, ключи — из `/root/komik-env.backup`. Повторный запуск безопасен. | `bash <(curl -fsS https://komikdnd.ru/migrate/setup.sh)` |
| `restore.sh` | Вернуть данные `kv` (всю таблицу или один ключ) из ежедневной копии; `accounts` — копия аккаунтов в `/root`. | `bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh)` — список дат |
| `harden.sh` | По желанию, один раз: fail2ban для SSH, автообновления безопасности, список открытых портов, как перейти на вход по ключу. | `bash <(curl -fsS https://komikdnd.ru/migrate/harden.sh)` |
| `accounts.sh` | Перенос аккаунтов со старого облака supabase.co (история переезда; для нового сервера — `RESTORE.md`). | — |
| `2026-09-21-rls.sql` | **Права записи в `kv` по ролям** (эта страница). | `push.sh` применяет сам |
| `2026-09-25-email-domain.sql` | Тег пользователя — только с адреса `@komikdnd.ru` + запрет заводить аккаунты на другие домены. | `push.sh` применяет сам |
| `2026-09-26-projects-owner.sql` | Правило видимости сеттингов (`comik:projects:v1`) пишет только hinoma. | `push.sh` применяет сам |
| `2026-09-27-hardening.sql` | Права команды — у аккаунтов, а не у логинов; игроки без удаления и с потолком размера строк; тег только по правилам сайта; адрес аккаунта не меняется. | `push.sh` применяет сам |

`push.sh` при **каждом** запуске применяет все четыре `*.sql` строго по порядку 21 → 25 → 26 → 27 (и только если
скачались все четыре); `setup.sh` на свежем сервере — те же файлы. Руками их запускать не нужно: 09-21…09-26
пересоздают свои, более мягкие версии правил, а 09-27 последней возвращает строгие. Любую правку прав —
новым файлом `migrate/ДАТА-*.sql`, добавленным в конец списков `MIGS` в `push.sh` и `setup.sh`.

---

## 2026-09-21 · права записи в kv по ролям (RLS)

### Что было

Одна политика `kv_write`: **любой вошедший** пользователь мог записать **любую** строку `kv` —
в том числе архив сеттинга, новости, хронологию, чужие листы персонажей. Плюс три функции
`security definer` (`kv_deep_merge`, `trk_card_patch`, `trk_log_push`), которые писали в обход RLS;
клиент их давно не вызывает (доска ходов пишется через `kvCasUpdate` — обычный `UPDATE` с проверкой версии).

### Что меняет миграция

1. Удаляет `public.kv_deep_merge`, `public.trk_card_patch`, `public.trk_log_push`, `public.jsonb_deep_merge`.
2. Создаёт таблицу `public.devs(tag)` и кладёт в неё `hinoma`, `herr_teo`, `arlissss` — те же теги,
   что `DEV_TAGS` в `index.html`. Таблица закрыта RLS: через API её можно только читать
   (иначе с anon-ключом любой дописал бы себя в разработчики).
3. Создаёт `public.my_tag()` — тег текущего пользователя из JWT (`lower(split_part(email,'@',1))`;
   логины на сайте — `<тег>@komikdnd.ru`).
4. Снимает `kv_write` и ставит две политики записи (`for all to authenticated`; чтение `kv_read` не трогает):
   * `kv_write_dev` — тег есть в `devs` → любой ключ;
   * `kv_write_player` — ровно те ключи, которые клиент пишет без прав ГМ:

     | Ключ | Кто/когда пишет (index.html) |
     |---|---|
     | `comik:tracker:shared:v1` | доска ходов: `kvCasUpdate` (insert/update), `trkFlush` |
     | `comik:games:v1` | запись на игру / отмена (`persistGames`), миграция тегов при старте |
     | `comik:users:v1` | реестр логинов при входе/регистрации/старте |
     | `push:subs` | пуш-подписки (`pushSaveSub`/`pushRemoveSub`) |
     | `comik:chars:<мой тег>` | свои листы персонажей (`persistChars`) |
     | `comik:bm:<мой тег>` | свои закладки (`toggleBookmark`, `bmCloudSync`) |

   Всё остальное (`comik:archive:v1`, `comik:coreover:v1`, `comik:news:v1`, `comik:chrono:v1`,
   `comik:chrono:games:v1`, `comik:hero:v1`, чужие `comik:chars:*` / `comik:bm:*`) — только разработчикам.
   В клиенте эти пути и так закрыты `isDev()`/`ADMIN`; теперь это проверяет и сервер.

Миграция идемпотентна: `drop … if exists` / `create … if not exists` / `on conflict do nothing`,
всё в одной транзакции.

### Порядок: сначала сайт, потом база

**Сборка сайта с этим же набором ключей должна быть выложена ДО выполнения миграции.**
Старый клиент, который пишет что-то вне списка, после миграции получит `42501` и покажет
«Нет прав на запись». Обратный порядок (сайт позже базы) проблем не создаёт.
Если список ключей, которые пишет игрок, когда-нибудь изменится в `index.html`, — сначала правится
функция `kv_player_cap` (новая миграция после 09-27, см. ниже), затем выкладывается сайт.

### Как выполнить

На сервере (файл сначала скопировать, например `scp migrate/2026-09-21-rls.sql root@<IP>:/root/`):

```bash
docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < /root/2026-09-21-rls.sql
```

Или через `psql` напрямую (строка подключения — из `/root/komik-cloud-info.txt` / `.env`):

```bash
psql "postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5432/postgres" -v ON_ERROR_STOP=1 -f migrate/2026-09-21-rls.sql
```

Или в Studio (`https://cloud.komikdnd.ru` → SQL Editor): вставить содержимое файла целиком и нажать Run.
Ошибок быть не должно; при повторном запуске — тоже.

### Как проверить

**В SQL (безопасно, всё откатывается):**

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","email":"roman@komikdnd.ru"}';   -- любой НЕ-разработчик
select public.my_tag();                                                -- roman
update public.kv set value = value where key = 'comik:archive:v1';     -- UPDATE 0  (строка есть, но RLS её не показал)
update public.kv set value = value where key = 'comik:chars:roman';    -- UPDATE 1  (если у roman есть лист)
insert into public.kv(key, value) values ('comik:rls:check', '1');     -- ERROR 42501 new row violates row-level security policy
rollback;
```

Для разработчика (`"email":"hinoma@komikdnd.ru"`) первый `update` даёт `UPDATE 1`, а `insert` проходит
(транзакция всё равно откатывается). После 2026-09-27 права команды проверяются по аккаунту: в claims нужен
ещё `"sub"` — id аккаунта (пример — в разделе 2026-09-27 ниже).

**Из браузера, войдя на сайт как игрок** (консоль DevTools на komikdnd.ru):

```js
// архив: обновление «той же самой» строки — 0 строк = запись отклонена (данные не меняются)
const a = await supa.from('kv').select('value').eq('key','comik:archive:v1').maybeSingle();
(await supa.from('kv').update({value:a.data.value}).eq('key','comik:archive:v1').select('key')).data   // → []
// свой лист — 1 строка
(await supa.from('kv').update({value:(await supa.from('kv').select('value').eq('key','comik:chars:'+currentTag()).maybeSingle()).data.value}).eq('key','comik:chars:'+currentTag()).select('key')).data   // → [{key:'comik:chars:<тег>'}]
// вставка чужого ключа — ошибка 42501 (HTTP 403)
(await supa.from('kv').insert({key:'comik:rls:check', value:1})).error.code   // → '42501'
```

Через `curl` с JWT игрока (`(await supa.auth.getSession()).data.session.access_token`):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cloud.komikdnd.ru/rest/v1/kv \
  -H "apikey: $ANON" -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"key":"comik:rls:check","value":1}'        # 403 (тело: code 42501)
```

Живая проверка: как игрок — записаться на игру, поправить лист, нажать «урон» на доске ходов,
поставить закладку, включить пуши: всё должно сохраняться без тостов «Нет прав на запись».

### Откат

Не нужен и опасен (возвращает «любой вошедший пишет всё»); `push.sh` при следующем запуске всё равно вернёт правила.

```sql
begin;
drop policy if exists kv_write_dev        on public.kv;
drop policy if exists kv_write_player     on public.kv;
drop policy if exists kv_write_player_ins on public.kv;
drop policy if exists kv_write_player_upd on public.kv;
create policy kv_write on public.kv for all to authenticated using (true) with check (true);
commit;
```

Таблица `devs` и функция `my_tag()` могут остаться — они безвредны. RPC-функции клиенту не нужны
и не восстанавливаются (их текст — в истории git `migrate/setup.sh` до этой миграции).

### Клиент

`sset()` различает отказ в правах (`42501`/403) и сетевой сбой: при отказе показывается
«⚠ Нет прав на запись — в облако не сохранено» (не чаще раза в 8 с), а не «Облако недоступно»;
`persistChars`/`persistGames` в этом случае не обещают «отправим, когда связь вернётся».
Доска ходов уже отдельно обрабатывает `noperm` в `trkFlush`.

---

## 2026-09-25 · тег пользователя — только с адреса @komikdnd.ru

**Дыра.** `my_tag()` брал часть e-mail до `@` и не смотрел домен, а регистрация открыта (сайт сам вызывает
`signUp`, автоподтверждение включено, анон-ключ публичный). Любой мог завести через API аккаунт
`hinoma@gmail.com` — и получить права разработчика на запись любого ключа `kv` (приветствие выводится как HTML →
хранимый XSS у всех посетителей), или `roman@gmail.com` — запись в чужие листы. То же в функции `notify-game`:
разослать пуш всем подписчикам мог «hinoma» с любого домена.

**Что меняет.** `my_tag()` отдаёт тег только для адреса вида `<тег>@komikdnd.ru` (иначе пустая строка — у такого
аккаунта нет прав записи ни на что, кроме общих ключей игроков); триггер `komik_email_guard` на `auth.users` не даёт
завести аккаунт (или сменить адрес) на другой домен. Функция `notify-game` проверяет домен сама (обновится вместе с `push.sh`).
В конце миграция печатает адреса не на `@komikdnd.ru`, если такие уже есть (`NOTICE`).

Идемпотентна, запускается и до, и после `2026-09-21-rls.sql`:

```bash
curl -fsS https://komikdnd.ru/migrate/2026-09-25-email-domain.sql | docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres
```

**Проверка** (откатывается):

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","email":"hinoma@gmail.com"}';
select public.my_tag();                                              -- '' (пусто)
update public.kv set value = value where key = 'comik:hero:v1';      -- UPDATE 0
rollback;
```

---

## 2026-09-26 · правило видимости сеттингов — только владелец

На сайте у hinoma есть страница «Сеттинги»: для каждого сеттинга — «Всем» / «Команде» / «Только мне».
Правило лежит в `kv` под ключом `comik:projects:v1` (`{v, at, by, lv:{classic:'all', …}}`), его читают все.
Разрешительные политики пускают писать любой ключ любого разработчика (`kv_write_dev`), поэтому миграция
добавляет три **ограничивающие** (`as restrictive`) политики — на insert, update и delete отдельно (restrictive
`for all` задела бы и чтение): строку `comik:projects:v1` меняет только `my_tag() = 'hinoma'`, остальные ключи —
как раньше. `push.sh` применяет её на шаге 5/5; вручную:

```bash
curl -fsS https://komikdnd.ru/migrate/2026-09-26-projects-owner.sql | docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres
```

Скрытие — это скрытие в интерфейсе: данные сеттинга (архив, новости) по-прежнему читаются анонимным ключом.

---

## 2026-09-27 · права у аккаунтов, потолки размера, неизменный адрес

Закрывает то, что осталось после 09-21…09-26 (аудит безопасности):

1. **Тег по правилам сайта.** `my_tag()` отдаёт тег только для `^[a-z0-9_]{4,32}@komikdnd\.ru$` (как `validTag`
   на сайте). Раньше аккаунт `v1@komikdnd.ru` (заводится прямо через API) получал ключ `comik:chars:v1` — старое
   общее хранилище листов, которому клиенты верят. Все теги строк `comik:chars:*`/`comik:bm:*` во всех снапшотах
   под шаблон подходят; аккаунты не по шаблону миграция перечисляет (`NOTICE`) — войти они могут, писать — нет.
2. **Адрес аккаунта не меняется.** Триггер `komik_email_guard`: при регистрации — тот же шаблон; сменить e-mail
   может только владелец из SQL (`postgres`/`supabase_admin`). GoTrue (и его API, и Studio → Users) работает от
   `supabase_auth_admin` и получит отказ — иначе игрок с автоподтверждением переименовался бы в свободный логин команды.
3. **Права команды — у аккаунта.** `public.devs.uid` = id аккаунта из `auth.users`. Привязываются только пустые
   `uid` и только к существующему аккаунту `тег@komikdnd.ru`; нет аккаунта — нет прав; аккаунт удалён — в `uid`
   остаётся его старый id, и новый владелец логина прав не получает. `kv_write_dev` требует **и** `uid = auth.uid()`,
   **и** `tag = my_tag()`; `comik:projects:v1` пишет только аккаунт, привязанный к `hinoma`. Новая привязка печатается
   громко («привязан к аккаунту (заведён …)»). Снять с команды — `uid` = нули (строку не удалять: 09-21 её вернёт),
   см. `RESTORE.md`. Гостю (`anon`) из `devs` виден только столбец `tag`.
4. **Игроки не удаляют и не раздувают.** Вместо `kv_write_player` (`for all`) — `kv_write_player_ins` и
   `kv_write_player_upd`, удаления у игроков нет (клиент строки `kv` не удаляет). Размер новой строки ограничивает
   `kv_player_cap(key)` — `pg_column_size(value)`, байт:

   | Ключ | Наибольшее в снапшотах | Потолок |
   |---|---|---|
   | `comik:tracker:shared:v1` | 1 020 559 (27.08, ещё с фоном карты) | 8 МБ |
   | `comik:games:v1` | 378 | 512 КБ |
   | `comik:users:v1` | 554 | 256 КБ |
   | `push:subs` | 3 241 | 512 КБ |
   | `comik:chars:<тег>` | 1 103 232 | 10 МБ |
   | `comik:bm:<тег>` | 758 | 256 КБ |

   На команду потолки не действуют. Превышение — ошибка `42501`, клиент покажет «Нет прав на запись».

В конце миграция печатает итог: адреса не по шаблону, команду (`✓` / `— нет аккаунта` / `✗ снят с команды`)
и список правил `kv`. Проверка в SQL (откатывается; `sub` — id аккаунта):

```sql
begin;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'email', 'roman@komikdnd.ru',
  'sub', (select id from auth.users where email = 'roman@komikdnd.ru'))::text, true);
set local role authenticated;
delete from public.kv where key = 'comik:games:v1';                              -- DELETE 0
update public.kv set value = to_jsonb(repeat('x', 600000)) where key = 'push:subs'; -- ERROR 42501 (потолок)
rollback;
```

Проверить всё сразу: `bash <(curl -fsS https://komikdnd.ru/migrate/push.sh) check`.

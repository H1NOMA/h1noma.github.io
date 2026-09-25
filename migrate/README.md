# КОМИК · миграции облака (Supabase, cloud.komikdnd.ru)

| Файл | Что делает | Как запускать |
|---|---|---|
| `setup.sh` | Полная установка облака на чистый сервер (Docker, Supabase, схема, Caddy, перенос данных). Повторный запуск безопасен. | `bash <(curl -fsS https://komikdnd.ru/migrate/setup.sh)` |
| `accounts.sh` | Перенос аккаунтов игроков со старого облака. | `bash <(curl -fsS https://komikdnd.ru/migrate/accounts.sh)` |
| `push.sh` | Починка VAPID-ключей пушей и обновление функции notify-game. | `bash <(curl -fsS https://komikdnd.ru/migrate/push.sh)` |
| `2026-09-21-rls.sql` | **Права записи в `kv` по ролям** (эта страница). | см. ниже |
| `2026-09-25-email-domain.sql` | Тег пользователя — только с адреса `@komikdnd.ru` + запрет заводить аккаунты на другие домены. | см. ниже |

`setup.sh` создаёт схему сразу в конечном состоянии последней миграции — на свежем сервере
отдельные `*.sql` запускать не нужно. На уже работающем сервере применяют только новые `*.sql`.

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
политика `kv_write_player` (новая миграция + `setup.sh`), затем выкладывается сайт.

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
(транзакция всё равно откатывается).

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

```sql
begin;
drop policy if exists kv_write_dev    on public.kv;
drop policy if exists kv_write_player on public.kv;
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


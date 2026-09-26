# КОМИК · что делать, если… (памятка владельца)

Все команды ниже — копируй целиком. «На сервере» — после `ssh root@IP-сервера`.
«В PowerShell» — на своём компьютере с Windows (Пуск → PowerShell), **не** на сервере.
Вместо `IP` подставь адрес сервера, вместо `ТЕГ` — логин человека (например, `roman`).

Проверить, что защита базы включена (можно в любой момент, ничего не меняет), на сервере:

```bash
bash <(curl -fsS https://komikdnd.ru/migrate/push.sh) check
```

В конце должно быть **«Итог: защита базы включена ✓»**. Красный итог — запусти `push.sh` без `check`
(на вопрос о ключе — Enter); не помогло — покажи вывод программисту.

---

## 1. Что хранить у себя (не только на сервере)

Данные сайта (таблица `kv`) GitHub копирует сам, раз в сутки, в ветку `backups` — примерно за последний месяц.
А вот эти файлы есть **только на сервере** — умрёт сервер, умрут и они:

| Файл на сервере | Что в нём | Без него |
|---|---|---|
| `/opt/supabase/docker/.env` | ключи облака (JWT-секрет, анон- и сервисный ключ, пароли) | новые ключи → править сайт |
| `/opt/supabase/docker/docker-compose.override.yml` | VAPID-ключ пушей | устройства переподпишутся сами, но не сразу |
| `/root/komik-cloud-info.txt` | логин/пароль панели Studio | пароль лежит и в `.env` |
| `/root/auth-ДАТА.sql.gz` (раз в месяц) | аккаунты игроков (логины + хэши паролей) | **все** регистрируются заново |

Раз в месяц (и после каждой настройки сервера):

1. На сервере — свежая копия аккаунтов:
   ```bash
   bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh) accounts
   ```
   Скрипт сам напечатает команду `scp` для скачивания.
2. В PowerShell — забрать всё в папку `komik-backup`:
   ```powershell
   mkdir $HOME\komik-backup -Force
   scp root@IP:/opt/supabase/docker/.env $HOME\komik-backup\komik-env.backup
   scp root@IP:/opt/supabase/docker/docker-compose.override.yml $HOME\komik-backup\komik-override.backup
   scp root@IP:/root/komik-cloud-info.txt $HOME\komik-backup\
   scp root@IP:/root/auth-2026-09-26.sql.gz $HOME\komik-backup\
   ```
   (дату в последней строке — ту, что напечатал скрипт).

Это **секреты**: не пересылай их в чаты, не клади в GitHub. Хорошее место — зашифрованная флешка
или облако с двухфакторным входом.

## 2. Сервер умер (или переезд на новый)

1. Купи новый VPS: Ubuntu 22.04 или 24.04, от 2 ГБ памяти. Запиши его IP.
2. У регистратора домена поменяй запись `cloud.komikdnd.ru` (тип A) на новый IP.
3. В PowerShell — положи сохранённые файлы на новый сервер (имена важны):
   ```powershell
   scp $HOME\komik-backup\komik-env.backup root@IP:/root/komik-env.backup
   scp $HOME\komik-backup\komik-override.backup root@IP:/root/komik-override.backup
   scp $HOME\komik-backup\auth-2026-09-26.sql.gz root@IP:/root/
   ```
4. На сервере — установка (10–20 минут; повторный запуск безопасен):
   ```bash
   bash <(curl -fsS https://komikdnd.ru/migrate/setup.sh)
   ```
   Она сама возьмёт прежние ключи, вернёт данные сайта из самой свежей копии GitHub,
   загрузит аккаунты и привяжет права команды.
5. На сервере — пуши и итоговая проверка (на вопрос о ключе — Enter):
   ```bash
   bash <(curl -fsS https://komikdnd.ru/migrate/push.sh)
   ```
   В конце — «Итог: защита базы включена ✓».
6. По желанию — защита самого сервера: `bash <(curl -fsS https://komikdnd.ru/migrate/harden.sh)`.
7. Открой сайт, войди, проверь листы и расписание.

Если чего-то из сохранённого нет:
* нет `komik-env.backup` — ключи будут новые: `setup.sh` в конце скажет, какой ключ вписать в `index.html`
  и `.github/workflows/backup-kv.yml` (это правка кода);
* нет дампа аккаунтов — всем придётся зарегистрироваться заново. **Сразу** после установки сам зарегистрируй
  `hinoma`, `herr_teo`, `arlissss` на сайте, потом запусти `push.sh` — он привяжет им права команды.

## 3. Кто-то испортил данные

Посмотреть, за какие дни есть копии (копия делается раз в сутки около 06:17 по Москве):

```bash
bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh)
```

Вернуть **один ключ** на выбранную дату (лучше так — остальное не трогается):

```bash
bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh) 2026-09-25 comik:games:v1
```

Вернуть **всю таблицу**: `bash <(curl -fsS https://komikdnd.ru/migrate/restore.sh) 2026-09-25`.

Скрипт покажет, что изменится, и спросит — напиши `да`. Перед записью он сохраняет текущую таблицу
и печатает команду отмены (`restore.sh /root/kv-before-restore-….json.gz`). Строки, которых нет в копии,
не удаляются. Всё, что поменялось в этом ключе после копии, пропадёт.

| Ключ | Что это |
|---|---|
| `comik:games:v1` | расписание и запись на игры |
| `comik:tracker:shared:v1` | доска ходов |
| `comik:chars:ТЕГ` | листы персонажей игрока |
| `comik:news:v1`, `comik:archive:v1`, `comik:hero:v1` | новости, архив, приветствие |
| `push:subs` | пуш-подписки |

Если испорченное возвращается само — значит, кто-то продолжает портить: закрой регистрацию (пункт 4)
и позови программиста.

## 4. Срочно: закрыть регистрацию

Когда портит кто-то, кто сам зарегистрировался. На сервере:

```bash
cd /opt/supabase/docker && sed -i 's/^DISABLE_SIGNUP=.*/DISABLE_SIGNUP=true/' .env && docker compose up -d auth
```

Уже зарегистрированные входят как прежде; кнопка «Регистрация» на сайте будет выдавать ошибку.
Новых игроков заводишь сам: Studio (`https://cloud.komikdnd.ru`, логин и пароль — в `/root/komik-cloud-info.txt`)
→ Authentication → **Add user** → Create new user: e-mail `ТЕГ@komikdnd.ru` (тег — 4–32 знака: латиница, цифры, `_`),
пароль от 8 символов, галочка **Auto Confirm User**. Логин и пароль передай игроку.

Открыть регистрацию обратно — та же команда с `DISABLE_SIGNUP=false`. `push.sh` эту настройку не трогает.

## 5. Сменить пароль игроку (или себе)

Сменить пароль и выкинуть все входы этого аккаунта — на сервере:

```bash
docker exec -it supabase-db psql -U postgres -d postgres
```

```sql
update auth.users set encrypted_password = extensions.crypt('НОВЫЙ-ПАРОЛЬ', extensions.gen_salt('bf', 10))
 where email = 'ТЕГ@komikdnd.ru';
delete from auth.sessions where user_id = (select id from auth.users where email = 'ТЕГ@komikdnd.ru');
\q
```

Первая строка должна ответить `UPDATE 1`. Уже открытая вкладка проживёт ещё до часа, потом выйдет.
Меняй пароль, только если уверен, что пишет сам игрок (новый пароль лучше передать голосом или лично).

## 6. Человек уходит из команды

**Аккаунт не удаляй**: его логин освободится, и кто угодно зарегистрируется под ним.
Вместо этого — случайный пароль, выход со всех устройств и снятие прав. На сервере:

```bash
docker exec -it supabase-db psql -U postgres -d postgres
```

```sql
update auth.users set encrypted_password = extensions.crypt(encode(extensions.gen_random_bytes(24), 'base64'), extensions.gen_salt('bf', 10))
 where email = 'ТЕГ@komikdnd.ru';
delete from auth.sessions where user_id = (select id from auth.users where email = 'ТЕГ@komikdnd.ru');
update public.devs set uid = '00000000-0000-0000-0000-000000000000' where tag = 'ТЕГ';
\q
```

Строку из `public.devs` **не удаляй**: `push.sh` при каждом запуске возвращает в список `hinoma`, `herr_teo`,
`arlissss` и заново привязал бы права к ещё живому аккаунту. Нули в `uid` — «снят с команды»,
так и покажет `push.sh check`. Права в базе пропадают сразу (открытая вкладка — до часа).

Ещё его логин записан в коде: `DEV_TAGS` в `index.html` (режим команды на сайте) и `DEV` в
`supabase/functions/notify-game/index.ts` (рассылка пушей). Убрать оттуда — правка кода, нужен программист.

## 7. Новый человек в команде

1. Человек **сам** регистрируется на сайте (логин = его тег).
2. На сервере добавь тег в команду:
   ```bash
   docker exec supabase-db psql -U postgres -d postgres -c "insert into public.devs(tag) values ('ТЕГ') on conflict (tag) do update set uid = null"
   ```
   (эта же команда возвращает в команду того, кого раньше сняли).
3. Запусти `push.sh` (на вопрос о ключе — Enter). Он привяжет права к аккаунту и в проверке покажет `ТЕГ ✓`.
   Если там написано «привязан к аккаунту (заведён …)» с незнакомой датой — это не тот человек:
   сними его (пункт 6) и разберись.

Порядок важен: пока аккаунта нет, права не привязываются, и логин команды никто не может «занять».
Чтобы у человека был режим команды на сайте и рассылка пушей — его тег нужно добавить в `DEV_TAGS`
(`index.html`) и `DEV` (`notify-game/index.ts`): правка кода, нужен программист.

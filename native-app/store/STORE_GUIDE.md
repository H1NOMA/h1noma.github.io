# КОМИК · путь до сторов — пошагово

Всё, что можно было сделать без твоих учёток, уже в репозитории:
иконки/сплэш (`assets/`), конфиг сборки (`eas.json`, `app.json`), тексты листингов
(`store/listing.md`), удаление аккаунта и пуш-клиент в приложении, серверная функция
рассылки (`../supabase/functions/send-push`). Ниже — что делаешь ты (нужны аккаунты).

## 0. Один раз
```bash
npm i -g eas-cli
eas login                # аккаунт Expo (бесплатный)
cd native-app
eas init                 # привяжет projectId к app.json
```
Аккаунты разработчика: Apple Developer ($99/год), Google Play Console ($25 разово).

## 1. Пробная сборка (без сторов)
```bash
eas build --profile preview --platform android   # .apk на телефон
eas build --profile preview --platform ios       # сборка для симулятора
```
Ссылку на .apk можно кинуть друзьям — поставится напрямую.

## 2. Пуши
- **iOS (APNs):** ничего руками — при первом `eas build -p ios` EAS сам создаст ключ APNs
  в твоём Apple-аккаунте (спросит логин).
- **Android (FCM):** в Firebase Console создай проект → добавь Android-приложение
  `ru.komikdnd.app` → скачай `google-services.json` в `native-app/`, и в `app.json`
  добавь `"android": { "googleServicesFile": "./google-services.json" }`.
  Затем `eas credentials -p android` → загрузить FCM V1 ключ.
- **Сервер рассылки:** `supabase functions deploy send-push --no-verify-jwt`,
  `supabase secrets set PUSH_SECRET=<строка>`. Проверка:
  ```bash
  curl -X POST https://xstrdpoxwbkbumigspdv.supabase.co/functions/v1/send-push \
    -H 'content-type: application/json' \
    -d '{"secret":"<строка>","title":"КОМИК","body":"Тест","gid":""}'
  ```

## 3. Боевые сборки
```bash
eas build --profile production --platform ios
eas build --profile production --platform android   # .aab для Play
```

## 4. Скриншоты
Прогони приложение в симуляторе (`npx expo start` → `i`) и сними:
- iPhone 6.7" (обязательный размер) и iPad 12.9" (раз supportsTablet);
- Android: телефон + 7"/10" планшет.
Что снимать: Новости (рамка сеттинга), Архив (карточка со статблоком), Лист персонажа,
Доска боя, переключатель сеттингов. 4–6 штук достаточно.

## 5. Отправка
```bash
eas submit -p ios        # → App Store Connect → TestFlight → «Отправить на проверку»
eas submit -p android    # → Play Console → внутреннее тестирование → продакшен
```
Тексты, категории, рейтинг и ответы Privacy/Data Safety — готовые в `store/listing.md`.

## 6. Заметки для ревью (уже учтено в приложении)
- Удаление аккаунта: Профиль → «Удалить аккаунт и данные» (требование обоих сторов).
- Вход без почты/пароля (тег) — ревьюеру дать тестовый тег в поле Review Notes.
- Название/иконка без чужих товарных знаков.
- Пуши опциональны, включаются явным тумблером.

## Известные ограничения v1 (честно)
- Вход по тегу без пароля — проще сайта; парольную проверку можно добавить позже.
- Редактор персонажа — базовые поля (полный конструктор рас/классов — в вебе).
- Хронология и музыка ГМа — только в веб-версии.

# Мой GPT — Алиса + Google (чтение)

Существующий GPT (`gpt-6-luna`), команды выхода и ключи памяти `alice:v1:<hash>:history/facts` сохранены. Google работает отдельным фоновым запросом на Vercel. Отправка писем, создание/изменение/удаление событий и документов **не реализованы и запрещены**. Даже голосовое «подтверждаю» не включает запись. Текст письма можно подготовить только в ответе Алисы.

## Настройка

Production environment variables (только в Vercel, не в Git):

- `OPENAI_API_KEY`, `ALICE_WEBHOOK_SECRET` (случайный секрет длиной не менее 32 символов).
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — существующий Upstash Redis.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — OAuth web client.
- `GOOGLE_REDIRECT_URI` = `https://alice-gpt-eta.vercel.app/api/google/callback`.
- Необязательно: `GOOGLE_SETUP_SECRET` — отдельный ключ владельца для формы подключения. По умолчанию применяется существующий `ALICE_WEBHOOK_SECRET`.
- Необязательно: `GOOGLE_TOKEN_ENCRYPTION_KEY` — независимый случайный секрет от 32 символов. Иначе ключ шифрования выводится из `ALICE_WEBHOOK_SECRET` через HKDF с отдельным контекстом. Смена использованного секрета делает старые Google-токены нечитаемыми: потребуется повторная привязка. Память Алисы от этого не меняется.

В Google Cloud включить Calendar, Drive, Docs и Gmail API. В web client разрешить ровно указанный redirect URI. В Data Access объявить:

```
openid
https://www.googleapis.com/auth/calendar.events.readonly
https://www.googleapis.com/auth/drive.metadata.readonly
https://www.googleapis.com/auth/documents.readonly
https://www.googleapis.com/auth/gmail.readonly
```

Доступ к Диску ограничен поиском метаданных; содержимое читается только у Google Docs. Файлы PDF, Word, Sheets и вложения писем не скачиваются. Календарь — основной (`primary`), максимум 20 событий за запрос до 93 дней; поиск Диска — до 10 файлов, Gmail — до 5 писем. Неполные результаты помечаются для модели. Нельзя обещать поиск по всему содержимому Диска.

Google Cloud display name: `alice-gpt-google`; project ID: `feisty-script-514722-d5`.

## Привязка

1. В навыке под авторизованным Яндекс-пользователем сказать «подключи Google». Получить одноразовый десятизначный код (10 минут).
2. Открыть `https://alice-gpt-eta.vercel.app/api/google/connect` кнопкой в Алисе или вручную. Ввести код и ключ настройки владельца **только на этом сайте**, выбрать сервисы.
3. Пройти Google consent в этом же браузере. Ни пароль Google, ни ключи не отправлять в чат. Страница объясняет передачу запрошенных данных OpenAI для ответа.
4. После страницы «Google подключён» спросить «какие встречи завтра», «найди документ …» или «какие непрочитанные письма». После короткого подтверждения сказать «готово». Повторный «готово» возвращает тот же ответ в течение 5 минут.
5. «Статус Google» проверяет наличие сохранённой привязки; это не проверка действительности refresh token. Запрос чтения проверяет реальный доступ.

Устройства без `session.user.user_id` не получают Google-данные. Привязка изолирована по пользователю и навыку. Разные Яндекс-пользователи привязываются отдельно. Перепривязка к другому Google-аккаунту отвергается, чтобы случайно не подменить владельца; смена аккаунта требует административного удаления только его ключа Google-токенов. Для отзыва доступа используйте настройки безопасности Google-аккаунта.

## Безопасность и время ответа

- POST webhook продолжает проверять `ALICE_WEBHOOK_SECRET` в `?key=`. Не публикуйте полный URL, не включайте его в логи или скриншоты. Платформенные access logs могут содержать query; их доступ и retention нужно контролировать отдельно.
- Форма подключения: same-origin POST, CSRF cookie, ключ владельца, ограничение попыток. OAuth: случайный одноразовый state, cookie HttpOnly/Secure/SameSite=Lax, PKCE S256 и TTL 10 минут. Callback не отражает и не журналирует коды/ошибки провайдера.
- AES-256-GCM шифрует токены, pairing/state, результат и краткий контекст Google в Redis. AAD привязывает шифротекст к конкретному ключу пользователя. Refresh token сохраняется при обновлении access token. Ошибка `invalid_grant` требует нового consent.
- Запросы Google проходят только через фиксированный список GET-инструментов, фиксированные HTTPS origins и валидацию аргументов; redirect запрещён. Письма и документы считаются недоверенными данными. Записывающих инструментов и scopes нет.
- Запросы с ключевыми словами Google/календаря/почты/документов запускаются через `waitUntil`; приветствие, выход и память остаются на прежнем пути. Ряд коротких продолжений («прочитай», «открой», «подготовь ответ») использует Google-контекст, если он есть. Для иных неоднозначных продолжений явно называйте сервис/документ/письмо.
- Один активный Google job на пользователя; повтор webhook дедуплицируется. Задача ограничена 42 секундами, Vercel function — 60. Redis foreground calls имеют timeout 700 мс. Ответ Алисе не ждёт Google/OpenAI. Холодный запуск/сеть Vercel всё ещё требуют проверки реального SLA Яндекса 4,5 секунды.
- `waitUntil` не является долговечной очередью. При аварийном завершении/таймауте job истекает, Алиса предлагает повторить запрос. Записывающих действий нет, поэтому повтор не создаёт событий/писем.
- Контекст Google и ответы удаляются по TTL 5 минут; содержимое не попадает в постоянную память. Запросы OpenAI используют `store:false` (это не обещание zero data retention со стороны провайдера).

## Ограничения Google OAuth

External + Testing с этими scopes обычно выдаёт refresh token на 7 дней. Добавьте нужный аккаунт в Test users. Переключение в Production — отдельное решение владельца, а не автоматическая часть установки.

`gmail.readonly` и `drive.metadata.readonly` относятся к restricted scopes, `documents.readonly` и Calendar — sensitive. Для публичного распространения применяются verification и, в зависимости от использования restricted data, требования security assessment. Google предусматривает исключения для личного использования/ограниченной аудитории; наличие исключения и требования конкретного проекта необходимо проверить в консоли. Нельзя обещать, что одного переключения Production достаточно. Приложение не публикуется для посторонних.

Источники: [Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [срок refresh token](https://developers.google.com/identity/protocols/oauth2#expiration), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Docs scopes](https://developers.google.com/workspace/docs/api/auth), [Яндекс: 4,5 секунды](https://yandex.ru/dev/dialogs/alice/doc/ru/response), [Vercel waitUntil](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil).

## Проверка и публикация

`npm ci --ignore-scripts` и `npm test`. Тесты используют только искусственные аккаунты, поддельные токены и mock API, не обращаются к почте/календарю. Проверяются OAuth CSRF/replay/PKCE, изоляция пользователей, refresh, allowlist, память, выход и быстрый ответ с фоновым результатом.

Сначала проверить отдельную ветку/preview. Production-секреты не копировать в preview. После публикации проверить GET health, POST без ключа (403), callback без state (400), страницу подключения, затем реальную привязку и по одному запросу чтения. Не создавать тестовых писем или событий. Для отката восстановить предыдущий deployment; ключи памяти сохраняются.

import { nonce } from '../../lib/store.mjs';
import { begin, config, secureHeaders, setCookie } from '../../lib/google-oauth.mjs';

export default async function handler(req, res) {
  secureHeaders(res);
  // Basic form POSTs under no-referrer send Origin:null in browsers. Keep the
  // same-origin origin check usable, while withholding referrers from Google.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'");
  try {
    config();
    if (req.method === 'POST') {
      const fields = typeof req.body === 'string' ? Object.fromEntries(new URLSearchParams(req.body)) : req.body || {};
      const url = await begin(req, res, fields);
      res.setHeader('Location', url);
      return res.status(303).end();
    }
    if (req.method !== 'GET') return res.status(405).send('Method not allowed');
    const csrf = nonce();
    setCookie(res, '__Host-google-form', csrf);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Мой GPT — подключение Google</title><style>body{font:18px system-ui;max-width:640px;margin:40px auto;padding:24px;line-height:1.6;background:#f6f8fb;color:#162035}label{display:block;margin:18px 0}input:not([type=checkbox]){display:block;padding:12px;width:90%;font:inherit}button{padding:14px 24px;font:inherit;background:#2345ad;color:white;border:0;border-radius:8px}small{display:block}</style>
<h1>Подключение Google к «Мой GPT»</h1><p>Скажите навыку «подключи Google» и введите выданный код. Он действует 10 минут и связывает аккаунт только с этим пользователем Алисы.</p>
<form method="post" action="/api/google/connect"><input type="hidden" name="csrf" value="${csrf}">
<label>Код от Алисы<input name="code" inputmode="numeric" pattern="[0-9 ]{10,20}" required autocomplete="off"></label>
<label>Ключ настройки владельца<input type="password" name="secret" required autocomplete="off"></label>
<small>Используйте GOOGLE_SETUP_SECRET, а если он не настроен — существующий ключ webhook. Не отправляйте его в чат и не вводите на других сайтах.</small>
<label><input type="checkbox" name="calendar" checked> Читать события календаря</label>
<label><input type="checkbox" name="reminders"> Создавать личные напоминания в вашем календаре по вашей просьбе</label>
<label><input type="checkbox" name="docs" checked> Искать файлы на Диске и читать Google Документы</label>
<label><input type="checkbox" name="gmail" checked> Искать и читать письма Gmail</label>
<p>Выбранные сведения будут передаваться OpenAI только для ответа на ваши запросы. Личные напоминания создаются по вашей просьбе без дополнительного подтверждения. Отправка писем и изменение документов отключены.</p>
<p>При статусе приложения Testing Google обычно требует повторного подключения через 7 дней. Отозвать разрешение можно в настройках Google-аккаунта.</p>
<button type="submit">Перейти к согласию Google</button></form></html>`);
  } catch (error) {
    const explanations = {
      csrf: 'Проверка браузера не пройдена. Обновите страницу и заполните форму заново.',
      unauthorized: 'Ключ настройки владельца не совпал с ключом сервера.',
      invalid_pair: 'Код Алисы истёк, уже использован или введён неверно. Скажите навыку «подключи Google» ещё раз.',
      rate_limit: 'Слишком много попыток. Подождите десять минут.',
      no_scopes: 'Выберите хотя бы один сервис.',
      storage_unavailable: 'Хранилище временно недоступно. Повторите подключение.',
      google_not_configured: 'Не заполнены настройки Google на сервере.'
    };
    return res.status(400).send('Подключение не началось. ' + (explanations[error.message] || 'Проверьте настройки сервера и повторите.'));
  }
}

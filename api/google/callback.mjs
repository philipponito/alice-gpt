import { finish, secureHeaders } from '../../lib/google-oauth.mjs';
export default async function handler(req, res) {
  secureHeaders(res);
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    await finish(req, res);
    return res.status(200).send('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Google подключён</title><h1>Google подключён</h1><p>Теперь спросите Алису о календаре, письмах или документах. Для результата фонового поиска скажите «готово». Доступ только для чтения.</p><p>Эту вкладку можно закрыть.</p></html>');
  } catch {
    // Never log authorization codes, provider error descriptions or tokens.
    return res.status(400).send('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Подключение не завершено</title><h1>Подключение не завершено</h1><p>Скажите Алисе «подключи Google» и начните заново в том же браузере. Разрешите все выбранные права. При повторном подключении используйте тот же Google-аккаунт.</p></html>');
  }
}

import { randomUUID } from 'node:crypto';
import { redis, seal, unseal } from './store.mjs';
import { accessToken, SCOPES } from './google-oauth.mjs';

const pendingKey = owner => `alice:reminder:pending:${owner}`;
export function validateReminder(args) {
  if (!args || Object.keys(args).sort().join(',') !== 'title,when' || typeof args.title !== 'string' ||
      !args.title.trim() || args.title.length > 160 || /[\r\n\x00-\x1f]/.test(args.title) ||
      typeof args.when !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(args.when)) throw new Error('invalid_reminder');
  const timestamp = Date.parse(args.when);
  if (!Number.isFinite(timestamp) || timestamp < Date.now() + 60000 || timestamp > Date.now() + 366 * 86400000) throw new Error('invalid_reminder');
  return { title: args.title.trim(), when: args.when, id: randomUUID().replaceAll('-', '') };
}
export async function presentReminder(owner, session, reminder) {
  if (!session) throw new Error('invalid_session');
  const k = pendingKey(owner);
  // Replaying the same response never re-arms a consumed confirmation.
  const [ok] = await redis([['SET', `${k}:shown:${reminder.id}`, '1', 'NX', 'EX', 600]]);
  if (ok) await redis([['SET', k, seal({ ...reminder, session }, k), 'EX', 300]]);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone:'Europe/Moscow', dateStyle:'full', timeStyle:'short' }).format(new Date(reminder.when));
  return `Создать напоминание «${reminder.title}» на ${time} по московскому времени? Уведомления за 30 минут и в указанное время. Скажите «подтверждаю» или «отмена».`;
}
export async function claimReminder(owner, session) {
  const k = pendingKey(owner);
  // Atomically consume once. A confirmation in a different Alice session cannot create it.
  const [raw] = await redis([['GETDEL', k]]);
  if (!raw) return null;
  const item = unseal(raw, k);
  if (!session || item.session !== session) return null;
  return item;
}
export async function cancelReminder(owner) { await redis([['DEL', pendingKey(owner)]]); }
export async function createReminder(owner, item) {
  const token = await accessToken(owner, SCOPES.reminders);
  const start = new Date(item.when), end = new Date(start.getTime() + 15 * 60000);
  const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none', {
    method:'POST', redirect:'error', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ id:item.id, summary:item.title, start:{dateTime:start.toISOString()}, end:{dateTime:end.toISOString()},
      reminders:{useDefault:false, overrides:[{method:'popup',minutes:30},{method:'popup',minutes:0}]} }),
    signal:AbortSignal.timeout(6500)
  });
  if (!r.ok) throw new Error(r.status === 403 ? 'google_permission' : 'reminder_unknown');
  const data = await r.json();
  if (data.id !== item.id) throw new Error('reminder_unknown');
  return 'Напоминание создано. Уведомления установлены за 30 минут и в назначенное время.';
}

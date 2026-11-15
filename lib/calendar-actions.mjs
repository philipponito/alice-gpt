import { randomUUID } from 'node:crypto';
import { redis, seal, unseal } from './store.mjs';
import { accessToken, SCOPES } from './google-oauth.mjs';

const pendingKey = (owner, session) => `alice:calendar:pending:${owner}:${session}`;
const validId = id => typeof id === 'string' && /^[\w-]{1,200}$/.test(id);
const fmt = time => new Intl.DateTimeFormat('ru-RU', { timeZone:'Europe/Moscow', dateStyle:'short', timeStyle:'short' }).format(new Date(time));

export function prepareCalendarAction(kind, ids, when, found) {
  if (!['delete','move'].includes(kind) || !Array.isArray(ids) || !ids.length || ids.length > 5 || new Set(ids).size !== ids.length ||
      ids.some(id => !validId(id)) || !Array.isArray(found) || (kind === 'move' && ids.length !== 1)) throw new Error('invalid_action');
  const events = ids.map(id => found.find(e => e.id === id));
  if (events.some(e => !e || !e.etag || !e.start?.dateTime || !e.end?.dateTime || e.recurringEventId || e.organizer?.self !== true)) throw new Error('unsupported_event');
  if (kind === 'move' && (typeof when !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(when) || !Number.isFinite(Date.parse(when)) || Date.parse(when) < Date.now()+60000)) throw new Error('invalid_time');
  return { id:randomUUID(), kind, when:kind === 'move' ? when : '', events:events.map(e => ({ id:e.id, etag:e.etag, title:String(e.summary || 'Без названия').slice(0,100), start:e.start.dateTime, end:e.end.dateTime, hasGuests:(e.attendees || []).some(a=>!a.self) })) };
}
export async function presentCalendarAction(owner, session, action) {
  if (!session || !/^[\w-]{1,200}$/.test(session)) throw new Error('invalid_session');
  const key=pendingKey(owner,session), shown=`${key}:shown:${action.id}`;
  // Atomically make the displayed proposal available exactly once.
  const [ok]=await redis([['EVAL', "if redis.call('SET',KEYS[1],'1','NX','EX',600) then redis.call('SET',KEYS[2],ARGV[1],'EX',300); return 1 end return 0", 2, shown, key, seal(action,key)]]);
  if (!ok) return 'Это предложение уже было показано. Попросите изменить события заново.';
  const names=action.events.map(e=>`«${e.title}» ${fmt(e.start)}`).join('; ');
  const verb=action.kind==='delete' ? 'Удалить' : `Перенести на ${fmt(action.when)} по Москве`;
  const guests=action.events.some(e=>e.hasGuests) ? ' Участники получат уведомление.' : '';
  return `${verb}: ${names}?${guests} Скажите «подтверждаю» или «отмена».`;
}
export async function claimCalendarAction(owner, session) {
  if (!session || !/^[\w-]{1,200}$/.test(session)) return null;
  const key=pendingKey(owner,session);
  const [raw]=await redis([['GETDEL',key]]);
  return raw ? unseal(raw,key) : null;
}
export async function cancelCalendarAction(owner,session) {
  if (session && /^[\w-]{1,200}$/.test(session)) await redis([['DEL',pendingKey(owner,session)]]);
}
export async function executeCalendarAction(owner, action) {
  const token=await accessToken(owner,SCOPES.reminders), results=[];
  for (const event of action.events) {
    const url=`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(event.id)}?sendUpdates=all`;
    const opts={method:action.kind==='delete'?'DELETE':'PATCH',redirect:'error',headers:{Authorization:`Bearer ${token}`,'If-Match':event.etag},signal:AbortSignal.timeout(5000)};
    if (action.kind==='move') {
      const duration=Date.parse(event.end)-Date.parse(event.start);
      if (!(duration>0 && duration<=7*86400000)) throw new Error('invalid_duration');
      opts.headers['Content-Type']='application/json';
      opts.body=JSON.stringify({start:{dateTime:new Date(action.when).toISOString()},end:{dateTime:new Date(Date.parse(action.when)+duration).toISOString()}});
    }
    try { const r=await fetch(url,opts); results.push({title:event.title,status:r.ok?'done':r.status===412?'changed':'failed'}); }
    catch { results.push({title:event.title,status:'unknown'}); }
  }
  return results;
}

import { randomInt } from 'node:crypto';
import { digest, nonce, equal, redis, seal, unseal, getPrivate, rateLimit } from './store.mjs';

const bindingKey = owner => `alice:voice:binding:${owner}`;
const pendingKey = owner => `alice:voice:pending:${owner}`;
export const voicePendingKey = pendingKey;
const onlineKey = owner => `alice:voice:online:${owner}`;
const lifetime = 30 * 86400;

export async function voicePairing(owner) {
  if (!await rateLimit(`alice:voice:pair-rate:${owner}`, 5, 600)) throw new Error('rate_limit');
  const code = String(randomInt(1000000000, 10000000000));
  const key = `alice:voice:pair:${digest(code)}`;
  const [ok] = await redis([['SET', key, seal({ owner }, key), 'EX', 600, 'NX']]);
  if (!ok) throw new Error('pair_collision');
  return code;
}

export async function bindVoice(fields, ip) {
  if (!await rateLimit(`alice:voice:login-rate:${digest(ip)}`, 10, 600)) throw new Error('rate_limit');
  const setup = process.env.GOOGLE_SETUP_SECRET || process.env.ALICE_WEBHOOK_SECRET;
  if (!setup || !equal(fields.secret, setup)) throw new Error('unauthorized');
  const code = String(fields.code || '').replace(/\s/g, '');
  if (!/^\d{10}$/.test(code)) throw new Error('invalid_pair');
  const key = `alice:voice:pair:${digest(code)}`;
  const [raw] = await redis([['GETDEL', key]]);
  if (!raw) throw new Error('invalid_pair');
  const { owner } = unseal(raw, key);
  const token = nonce(), hash = digest(token), tokenKey = `alice:voice:token:${hash}`;
  // Re-pairing invalidates the previous bridge even if its token has not expired.
  await redis([
    ['SET', tokenKey, seal({ owner }, tokenKey), 'EX', lifetime],
    ['SET', bindingKey(owner), hash, 'EX', lifetime],
    ['DEL', pendingKey(owner), onlineKey(owner)]
  ]);
  return { token, expiresIn: lifetime };
}

export async function voiceOwner(authorization) {
  const token = /^Bearer ([\w-]{43})$/.exec(authorization || '')?.[1];
  if (!token) throw new Error('unauthorized');
  const hash = digest(token), key = `alice:voice:token:${hash}`;
  const record = await getPrivate(key);
  if (!record?.owner) throw new Error('unauthorized');
  const [active] = await redis([['EVAL', `-- voice-renew
if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('EXISTS',KEYS[2])==0 then return 0 end
local ttl=redis.call('TTL',KEYS[2]); local bindingttl=redis.call('TTL',KEYS[1]);
if ttl<tonumber(ARGV[2])-86400 or bindingttl<tonumber(ARGV[2])-86400 then
redis.call('EXPIRE',KEYS[1],ARGV[2]); redis.call('EXPIRE',KEYS[2],ARGV[2]); end
return 1`, 2, bindingKey(record.owner), key, hash, lifetime]]);
  if (active !== 1) throw new Error('unauthorized');
  return record.owner;
}

export async function clearVoicePending(owner) {
  await redis([['DEL', pendingKey(owner)]]);
}

export async function deferVoice(owner, job, now = Date.now()) {
  // One round trip: a recent heartbeat is required, but conversation and speech
  // can temporarily prevent the installed bridge from polling.
  const key = pendingKey(owner);
  const [accepted] = await redis([['EVAL', `-- voice-defer
if not redis.call('GET',KEYS[1]) then return 0 end
redis.call('SET',KEYS[2],ARGV[1],'EX',90); return 1`,
    2, onlineKey(owner), key, seal({ job, created: now }, key)]], 600);
  return accepted === 1;
}

export async function nextVoice(owner, now = Date.now()) {
  const key = pendingKey(owner);
  const [, raw] = await redis([
    ['SET', onlineKey(owner), '1', 'EX', 180], ['GET', key]
  ]);
  if (!raw) return null;
  const pending = unseal(raw, key);
  if (now - pending.created > 90000 || now < pending.created) return null;
  const result = await getPrivate(`alice:google:job:${owner}:${pending.job}`);
  if (result?.status !== 'done' || typeof result.answer !== 'string' || !result.answer.trim()) return null;
  // Claim before returning: a retry after an ambiguous network outcome never
  // speaks twice. The user can still retrieve the result with "готово".
  const claimKey = `alice:voice:claimed:${owner}:${pending.job}`;
  const code = digest(nonce());
  const replyKey = `alice:voice:reply:${owner}:${code}`;
  const [claimed] = await redis([['EVAL', `-- voice-delivery
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
if not redis.call('SET',KEYS[2],'1','NX','EX',300) then return 0 end
redis.call('SET',KEYS[3],ARGV[2],'EX',90);
redis.call('DEL',KEYS[1]); return 1`, 3, key, claimKey, replyKey, raw, seal({ answer: result.answer.slice(0,1000) }, replyKey)]]);
  // text keeps existing installations working while the component is updated.
  return claimed ? { id: pending.job, text: result.answer.slice(0, 1000), reply_code: code } : null;
}

export async function armNativeReply(owner, code) {
  if (!/^[a-f0-9]{64}$/.test(code || '')) throw new Error('invalid_delivery');
  await redis([['SET', `alice:voice:native:${owner}`, code, 'EX', 90]]);
}

export async function takeVoiceReply(owner, code) {
  if(code === undefined) {
    const [result]=await redis([['EVAL',`-- native-reply
local code=redis.call('GET',KEYS[1]); if not code then return false end
redis.call('DEL',KEYS[1]); local raw=redis.call('GETDEL',ARGV[1]..code);
return {code,raw or false}`,1,`alice:voice:native:${owner}`,`alice:voice:reply:${owner}:`]],1500);
    if(!result || !result[1]) return null;
    const item=unseal(result[1],`alice:voice:reply:${owner}:${result[0]}`);
    return typeof item.answer==='string'?item.answer.slice(0,1000):null;
  }
  if (!/^[a-f0-9]{64}$/.test(code)) return null;
  const key = `alice:voice:reply:${owner}:${code}`;
  const [raw] = await redis([['GETDEL', key]], 1500);
  if (!raw) return null;
  const item = unseal(raw,key);
  return typeof item.answer === 'string' ? item.answer.slice(0,1000) : null;
}

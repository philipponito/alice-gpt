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
  // A paired but stopped computer must not suppress the manual fallback.
  const [online] = await redis([['GET', onlineKey(owner)]], 300);
  if (!online) return false;
  const key = pendingKey(owner);
  await redis([['SET', key, seal({ job, created: now }, key), 'EX', 90]], 300);
  return true;
}

export async function nextVoice(owner, now = Date.now()) {
  const key = pendingKey(owner);
  const [, raw] = await redis([
    ['SET', onlineKey(owner), '1', 'EX', 20], ['GET', key]
  ]);
  if (!raw) return null;
  const pending = unseal(raw, key);
  if (now - pending.created > 90000 || now < pending.created) return null;
  const result = await getPrivate(`alice:google:job:${owner}:${pending.job}`);
  if (result?.status !== 'done' || typeof result.answer !== 'string' || !result.answer.trim()) return null;
  // Claim before returning: a retry after an ambiguous network outcome never
  // speaks twice. The user can still retrieve the result with "готово".
  const claimKey = `alice:voice:claimed:${owner}:${pending.job}`;
  const [claimed] = await redis([['EVAL', `-- voice-delivery
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
if not redis.call('SET',KEYS[2],'1','NX','EX',300) then return 0 end
redis.call('DEL',KEYS[1]); return 1`, 2, key, claimKey, raw]]);
  return claimed ? { id: pending.job, text: result.answer.slice(0, 1000) } : null;
}

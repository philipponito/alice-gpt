import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, hkdfSync } from 'node:crypto';

export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const nonce = () => randomBytes(32).toString('base64url');
export function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
}
export async function redis(commands, timeout = 700) {
  const base = process.env.KV_REST_API_URL?.replace(/\/+$/, '');
  if (!base?.startsWith('https://') || !process.env.KV_REST_API_TOKEN) throw new Error('storage_unavailable');
  const r = await fetch(`${base}/pipeline`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands), signal: AbortSignal.timeout(timeout)
  });
  const data = await r.json();
  if (!r.ok || !Array.isArray(data) || data.some(x => x.error)) throw new Error('storage_unavailable');
  return data.map(x => x.result);
}
function key() {
  const secret = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || process.env.ALICE_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) throw new Error('encryption_not_configured');
  return Buffer.from(hkdfSync('sha256', secret, 'alice-gpt:v1', 'google-private-data', 32));
}
export function seal(value, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(x => x.toString('base64url')).join('.');
}
export function unseal(value, context) {
  const [iv, tag, ciphertext] = value.split('.').map(x => Buffer.from(x, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString());
}
export async function getPrivate(keyName) {
  const [raw] = await redis([['GET', keyName]]);
  return raw ? unseal(raw, keyName) : null;
}
export async function putPrivate(keyName, value, ttl) {
  return redis([['SET', keyName, seal(value, keyName), ...(ttl ? ['EX', ttl] : [])]]);
}
export const tokenKey = owner => `alice:google:v1:${owner}:tokens`;
export async function rateLimit(keyName, limit, seconds) {
  const [count] = await redis([['EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n", 1, keyName, seconds]]);
  return Number(count) <= limit;
}

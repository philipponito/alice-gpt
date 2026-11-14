import { randomInt, createHash } from 'node:crypto';
import { digest, nonce, equal, redis, seal, unseal, getPrivate, putPrivate, tokenKey, rateLimit } from './store.mjs';

export const SCOPES = Object.freeze({
  calendar: ['https://www.googleapis.com/auth/calendar.events.readonly'],
  docs: ['https://www.googleapis.com/auth/drive.metadata.readonly', 'https://www.googleapis.com/auth/documents.readonly'],
  gmail: ['https://www.googleapis.com/auth/gmail.readonly']
});
export function config() {
  const redirect = new URL(process.env.GOOGLE_REDIRECT_URI || '');
  if (redirect.protocol !== 'https:' || redirect.pathname !== '/api/google/callback' || redirect.search || redirect.hash ||
      !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new Error('google_not_configured');
  return { redirect: redirect.href, origin: redirect.origin };
}
export function secureHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
}
export function cookie(req, name) {
  return String(req.headers?.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}
export function setCookie(res, name, value, maxAge = 600) {
  res.setHeader('Set-Cookie', `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}
export async function pairing(owner) {
  config();
  if (!await rateLimit(`alice:google:pair-rate:${owner}`, 5, 600)) throw new Error('rate_limit');
  const code = String(randomInt(1000000000, 10000000000));
  const key = `alice:google:pair:${digest(code)}`;
  const [ok] = await redis([['SET', key, seal({ owner }, key), 'EX', 600, 'NX']]);
  if (!ok) throw new Error('pair_collision');
  return code;
}
export async function begin(req, res, fields) {
  const { origin, redirect } = config();
  if (req.headers?.origin !== origin) throw new Error('csrf');
  const csrf = cookie(req, '__Host-google-form');
  if (!csrf || !equal(csrf, fields.csrf)) throw new Error('csrf');
  const ip = String(req.headers?.['x-vercel-forwarded-for'] || req.headers?.['x-forwarded-for'] || 'unknown').split(',')[0];
  if (!await rateLimit(`alice:google:login-rate:${digest(ip)}`, 15, 600)) throw new Error('rate_limit');
  const setupSecret = process.env.GOOGLE_SETUP_SECRET || process.env.ALICE_WEBHOOK_SECRET;
  if (!setupSecret || !equal(fields.secret, setupSecret)) throw new Error('unauthorized');
  const code = String(fields.code || '').replace(/\s/g, '');
  if (!/^\d{10}$/.test(code)) throw new Error('invalid_pair');
  const services = Object.keys(SCOPES).filter(s => fields[s] === 'on');
  if (!services.length) throw new Error('no_scopes');
  const pairKey = `alice:google:pair:${digest(code)}`;
  const [raw] = await redis([['GETDEL', pairKey]]);
  if (!raw) throw new Error('invalid_pair');
  const { owner } = unseal(raw, pairKey);
  const state = nonce(), browser = nonce(), verifier = nonce();
  const stateKey = `alice:google:state:${digest(state)}`;
  const scopes = ['openid', ...services.flatMap(s => SCOPES[s])];
  await putPrivate(stateKey, { owner, browser: digest(browser), verifier, scopes }, 600);
  setCookie(res, '__Host-google-oauth', browser);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirect,
    response_type: 'code', scope: scopes.join(' '), state, access_type: 'offline', prompt: 'consent select_account',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  return url.href;
}
async function exchange(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(7000)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error === 'invalid_grant' ? 'reauthorize' : 'token_exchange_failed');
  if (!data.access_token || data.token_type?.toLowerCase() !== 'bearer') throw new Error('invalid_token');
  return data;
}
export async function finish(req, res) {
  const { redirect } = config();
  const url = new URL(req.url, config().origin);
  const state = url.searchParams.get('state') || '';
  if (!/^[\w-]{43}$/.test(state)) throw new Error('csrf');
  const key = `alice:google:state:${digest(state)}`;
  const pending = await getPrivate(key);
  const browser = cookie(req, '__Host-google-oauth');
  if (!pending || !browser || !equal(pending.browser, digest(browser))) throw new Error('csrf');
  const [claimed] = await redis([['GETDEL', key]]);
  if (!claimed) throw new Error('csrf');
  setCookie(res, '__Host-google-oauth', '', 0);
  if (url.searchParams.has('error')) throw new Error('consent_denied');
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) throw new Error('invalid_code');
  const data = await exchange({ code, code_verifier: pending.verifier, redirect_uri: redirect, grant_type: 'authorization_code' });
  const granted = String(data.scope || '').split(' ');
  if (!pending.scopes.every(s => granted.includes(s))) throw new Error('missing_scopes');
  const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${data.access_token}` }, signal: AbortSignal.timeout(5000)
  });
  const user = await r.json();
  if (!r.ok || typeof user.sub !== 'string') throw new Error('invalid_account');
  const storageKey = tokenKey(pending.owner);
  const previous = await getPrivate(storageKey);
  if (previous && previous.sub !== user.sub) throw new Error('different_account');
  const refresh = data.refresh_token || previous?.refresh;
  if (!refresh) throw new Error('refresh_missing');
  await putPrivate(storageKey, { sub: user.sub, access: data.access_token, refresh, scopes: granted,
    expires: Date.now() + Number(data.expires_in || 3600) * 1000 });
  return pending.owner;
}
export async function accessToken(owner, requiredScopes) {
  const key = tokenKey(owner);
  let value = await getPrivate(key);
  if (!value) throw new Error('not_connected');
  if (!requiredScopes.every(s => value.scopes.includes(s))) throw new Error('missing_scopes');
  if (value.expires > Date.now() + 60000) return value.access;
  // One refresh per principal. Other workers retry on a later request.
  const lockKey = `${key}:refresh-lock`, lock = nonce();
  const [locked] = await redis([['SET', lockKey, lock, 'NX', 'EX', 15]]);
  if (!locked) throw new Error('refresh_busy');
  try {
    value = await getPrivate(key);
    if (!value) throw new Error('not_connected');
    if (value.expires > Date.now() + 60000) return value.access;
    const data = await exchange({ refresh_token: value.refresh, grant_type: 'refresh_token' });
    const next = { ...value, access: data.access_token, refresh: data.refresh_token || value.refresh,
      scopes: data.scope ? data.scope.split(' ') : value.scopes, expires: Date.now() + Number(data.expires_in || 3600) * 1000 };
    // Do not resurrect a connection removed or replaced while refresh was in flight.
    const current = await getPrivate(key);
    if (!current || current.refresh !== value.refresh) throw new Error('connection_changed');
    await putPrivate(key, next);
    if (!requiredScopes.every(s => next.scopes.includes(s))) throw new Error('missing_scopes');
    return next.access;
  } finally {
    await redis([['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, lockKey, lock]]);
  }
}

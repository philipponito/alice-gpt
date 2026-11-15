import { secureHeaders } from '../../lib/google-oauth.mjs';
import { bindVoice } from '../../lib/voice-bridge.mjs';

export default async function handler(req, res) {
  secureHeaders(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  // This endpoint is for the local setup client, never a cross-site form.
  if (req.headers?.origin) return res.status(403).json({ error: 'forbidden' });
  if (!String(req.headers?.['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'json_required' });
  try {
    const ip = String(req.headers?.['x-vercel-forwarded-for'] || req.headers?.['x-forwarded-for'] || 'unknown').split(',')[0];
    return res.status(200).json(await bindVoice(req.body || {}, ip));
  } catch (error) {
    const status = error.message === 'rate_limit' ? 429 : ['unauthorized', 'invalid_pair'].includes(error.message) ? 403 : 503;
    return res.status(status).json({ error: status === 503 ? 'unavailable' : status === 429 ? 'rate_limit' : 'pairing_denied' });
  }
}

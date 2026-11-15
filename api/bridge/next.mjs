import { secureHeaders } from '../../lib/google-oauth.mjs';
import { voiceOwner, nextVoice } from '../../lib/voice-bridge.mjs';

export default async function handler(req, res) {
  secureHeaders(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (req.headers?.origin) return res.status(403).json({ error: 'forbidden' });
  try {
    const owner = await voiceOwner(req.headers?.authorization);
    const delivery = await nextVoice(owner);
    return delivery ? res.status(200).json(delivery) : res.status(204).end();
  } catch (error) {
    return res.status(error.message === 'unauthorized' ? 403 : 503).json({ error: error.message === 'unauthorized' ? 'forbidden' : 'unavailable' });
  }
}

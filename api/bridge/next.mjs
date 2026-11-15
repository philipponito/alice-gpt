import { secureHeaders } from '../../lib/google-oauth.mjs';
import { voiceOwner, nextVoice, armNativeReply } from '../../lib/voice-bridge.mjs';
import { homeHeartbeat, nextHome } from '../../lib/home-actions.mjs';
import { nextQueuedReply } from '../../lib/deferred-reply.mjs';

export default async function handler(req, res) {
  secureHeaders(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (req.headers?.origin) return res.status(403).json({ error: 'forbidden' });
  try {
    const owner = await voiceOwner(req.headers?.authorization);
    if(req.body?.lights === true) {
      await homeHeartbeat(owner);
      if(req.body.ready !== true) return res.status(204).end();
    }
    const queued=await nextQueuedReply(owner);
    if(queued) {
      await armNativeReply(owner,queued.reply_code);
      return res.status(200).json(queued);
    }
    if(req.body?.lights === true) {
      const home=await nextHome(owner);
      if(home) {
        if(home.reply_code) await armNativeReply(owner,home.reply_code);
        return res.status(200).json(home);
      }
    }
    const delivery = await nextVoice(owner);
    if(delivery?.reply_code) await armNativeReply(owner,delivery.reply_code);
    if(delivery)return res.status(200).json(delivery);
    return res.status(204).end();
  } catch (error) {
    return res.status(error.message === 'unauthorized' ? 403 : 503).json({ error: error.message === 'unauthorized' ? 'forbidden' : 'unavailable' });
  }
}

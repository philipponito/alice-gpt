import { secureHeaders } from '../../lib/google-oauth.mjs';
import { voiceOwner } from '../../lib/voice-bridge.mjs';
import { finishHome } from '../../lib/home-actions.mjs';

export default async function handler(req,res) {
  secureHeaders(res);
  if(req.method!=='POST') return res.status(405).json({error:'method_not_allowed'});
  if(req.headers?.origin) return res.status(403).json({error:'forbidden'});
  try {
    const owner=await voiceOwner(req.headers?.authorization);
    await finishHome(owner,req.body?.id,req.body?.state);
    return res.status(204).end();
  } catch(e) {
    return res.status(e.message==='unauthorized'?403:e.message==='invalid_result'?400:503).json({error:'unavailable'});
  }
}

import { waitUntil } from '@vercel/functions';
import { redis, nonce, digest, seal } from './store.mjs';

export const voiceOutbox = owner => `alice:voice:outbox:${owner}`;

export async function nextQueuedReply(owner) {
  const [raw]=await redis([['RPOP',voiceOutbox(owner)]]);
  return raw?JSON.parse(raw):null;
}

export async function awaitConversation(owner,requestId,work,started=Date.now()) {
  let timer;
  const early=await Promise.race([
    work.then(value=>({value})),
    new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(0,2200-(Date.now()-started)));})
  ]);
  clearTimeout(timer);
  if(early) return early.value.reply || early.value;
  waitUntil(work);
  const id=nonce(), key=`alice:google:job:${owner}:${id}`;
  const dedupe=`alice:deferred:request:${owner}:${digest(requestId)}`;
  const [[chosen,automatic]]=await redis([['EVAL',`-- deferred-start
local online=redis.call('GET',KEYS[4]) and 1 or 0;
local previous=redis.call('GET',KEYS[1]); if previous then return {previous,online} end
redis.call('SET',KEYS[1],ARGV[1],'EX',600);
redis.call('SET',KEYS[2],ARGV[1],'EX',600);
redis.call('SET',KEYS[3],ARGV[2],'EX',300); return {ARGV[1],online}`,
    4,dedupe,`alice:google:last:${owner}`,key,`alice:voice:online:${owner}`,id,seal({status:'running'},key)]],1000);
  const publish=(async()=>{
    const outcome=await work;
    if(chosen===id && outcome.forwarded && outcome.forwardedJob) {
      await redis([['EVAL',`-- deferred-forward
if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'EX',600); end
return 1`,1,`alice:google:last:${owner}`,id,outcome.forwardedJob]],2500);
    }
    if(outcome.completion)await outcome.completion;
    if(chosen!==id) return;
    const reply=outcome.reply || outcome;
    const answer=String(reply.response?.text || '').slice(0,1000);
    const speak=automatic===1 && !outcome.forwarded && reply.response?.tts!=='sil <[100]>' && Boolean(answer);
    const code=digest(nonce()), replyKey=`alice:voice:reply:${owner}:${code}`;
    await redis([['EVAL',`-- deferred-publish
if not redis.call('SET',KEYS[1],'1','NX','EX',300) then return 0 end
redis.call('SET',KEYS[2],ARGV[1],'EX',300);
if ARGV[4]=='1' then
redis.call('SET',KEYS[3],ARGV[2],'EX',90);
redis.call('LPUSH',KEYS[4],ARGV[3]); redis.call('EXPIRE',KEYS[4],90); end
return 1`,4,`alice:deferred:published:${owner}:${id}`,key,replyKey,voiceOutbox(owner),
      seal({status:'done',answer},key),seal({answer},replyKey),JSON.stringify({id,reply_code:code}),speak?'1':'0']],2500);
  })().catch(()=>{ /* No secrets or provider text in logs. Manual polling remains available. */ });
  waitUntil(publish);
  return {version:'1.0',response:{text:automatic===1?'Обрабатываю запрос.':'Обрабатываю запрос. Через несколько секунд скажите «готово».',
    ...(automatic===1?{tts:'<speaker audio="alice-sounds-game-ping-1.opus">'}:{}),end_session:false},session_state:{}};
}

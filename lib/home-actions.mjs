import { nonce, digest, redis, seal, unseal } from './store.mjs';

const targets = {room_light:'Свет в комнате',kitchen_light:'Кухонная лампа'};
const readyKey = owner => `alice:home:online:${owner}`;
const pendingKey = owner => `alice:home:pending:${owner}`;
const jobKey = (owner,id) => `alice:home:job:${owner}:${id}`;
const claimKey = (owner,id) => `alice:home:claim:${owner}:${id}`;
const resultKey = (owner,id) => `alice:home:result:${owner}:${id}`;
const deliveryKey = owner => `alice:home:delivery:${owner}`;
const clarificationKey = (owner,session) => `alice:home:clarify:${owner}:${digest(session)}`;

export function directLightIntent(question) {
  const text=question.toLowerCase().replace(/[«»"“”]/g,'#').replace(/[,.!?]/g,'').trim();
  const match=/^(?:алиса\s+)?(?:пожалуйста\s+)?(включи|выключи|зажги|погаси)\s+(?:пожалуйста\s+)?(свет|освещение|розетку|лампу|кухонную лампу|лампу кухонную)(?:\s+(в комнате|в спальне|на кухне|в кухне))?(?:\s+пожалуйста)?$/.exec(text);
  if(!match) return null;
  const kitchen=/кух(?:н|он)/.test(text), location=match[3];
  return {action:['включи','зажги'].includes(match[1])?'on':'off',target:kitchen?'kitchen_light':location||match[2]!=='лампу'?'room_light':'none'};
}

export async function quickHome(owner,question,requestId,session='',messageId) {
  const intent=directLightIntent(question);
  if(intent) return startHome(owner,intent,question,requestId,session,messageId);
  const location=question.toLowerCase().replace(/[,.!?]/g,'').trim();
  const target=/^(?:в комнате|комната|в спальне)$/.test(location)?'room_light':/^(?:на кухне|в кухне|кухня)$/.test(location)?'kitchen_light':null;
  if(!target) return null;
  const key=clarificationKey(owner,session), [raw]=await redis([['GETDEL',key]],1000);
  if(!raw) return null;
  const pending=unseal(raw,key);
  if(!['on','off'].includes(pending.action) || pending.nextMessage!==messageId || Date.now()-pending.created>90000) return null;
  const full=`${pending.action==='on'?'включи':'выключи'} свет ${target==='room_light'?'в комнате':'на кухне'}`;
  return startHome(owner,{action:pending.action,target},full,requestId,session,messageId);
}

export async function startHome(owner, intent, question, requestId, session='', messageId) {
  if (!intent || !['on','off'].includes(intent.action) || !(intent.target==='none'||Object.hasOwn(targets,intent.target))) return 'Поддерживается только включение и выключение света в комнате и кухонной лампы.';
  // Model output alone cannot authorize an action from a quotation or discussion.
  const verb=/^(?:алиса\s+)?(?:пожалуйста\s+)?(включи|выключи|зажги|погаси|выруби|вруби)(?=\s|[,.!?]|$)/i.exec(question.trim())?.[1]?.toLowerCase();
  const action=verb && (['включи','зажги','вруби'].includes(verb)?'on':'off');
  if (action!==intent.action || !/(свет|ламп|освещ)/i.test(question) || /(через|завтра|потом|не сейчас)/i.test(question)) return 'Для управления сейчас назовите действие и свет: например, «выключи свет в комнате».';
  if(intent.target==='none') {
    const key=clarificationKey(owner,session);
    await redis([['SET',key,seal({action,created:Date.now(),nextMessage:Number.isInteger(messageId)?messageId+1:null},key),'EX',90]],1000);
    return 'Где управлять светом: в комнате или на кухне?';
  }
  if ((intent.target==='kitchen_light') !== /кух(?:н|он)/i.test(question)) return 'Уточните, какой свет: в комнате или кухонную лампу.';
  const id=nonce(), key=jobKey(owner,id), dedupe=`alice:home:request:${owner}:${digest(requestId)}`;
  const record={id,action:intent.action,target:intent.target,created:Date.now()};
  const [status]=await redis([['EVAL',`-- home-start
if redis.call('GET',KEYS[1]) then return 'duplicate' end
if not redis.call('GET',KEYS[2]) then return 'offline' end
if redis.call('GET',KEYS[3]) then return 'busy' end
redis.call('SET',KEYS[1],ARGV[1],'EX',120);
redis.call('SET',KEYS[3],ARGV[1],'EX',45);
redis.call('SET',KEYS[4],ARGV[2],'EX',90); return 'queued'`,
    4,dedupe,readyKey(owner),pendingKey(owner),key,id,seal(record,key)]],1000);
  if(status==='offline') return 'Home Assistant сейчас недоступен или ещё не обновлён. Для света через обычную Алису скажите «Алиса, вернись», затем команду света.';
  if(status==='busy') return 'Предыдущая команда света ещё выполняется. Подождите её результат.';
  if(status==='duplicate') return 'Эта команда уже принята; повторно её не выполняю.';
  return 'Передаю команду света в Home Assistant. Озвучу результат после проверки состояния.';
}

export async function nextHome(owner) {
  const [id]=await redis([['GET',pendingKey(owner)]]);
  if(id) {
    const key=jobKey(owner,id);
    const [raw]=await redis([['GET',key]]);
    if(raw) {
      const job=unseal(raw,key);
      if(Date.now()-job.created<45000 && Date.now()>=job.created) {
        const [claimed]=await redis([['EVAL',`-- home-claim
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
if not redis.call('SET',KEYS[2],'1','NX','EX',90) then return 0 end
return 1`,2,pendingKey(owner),claimKey(owner,id),id]]);
        if(claimed) return {kind:'home_action',id:job.id,target:job.target,action:job.action};
      }
    }
  }
  const [delivery]=await redis([['RPOP',deliveryKey(owner)]]);
  return delivery ? JSON.parse(delivery) : null;
}

export async function homeHeartbeat(owner) {
  await redis([['SET',readyKey(owner),'1','EX',30],['SET',`alice:voice:online:${owner}`,'1','EX',180]]);
}

export async function finishHome(owner,id,state) {
  if(!/^[\w-]{43}$/.test(id || '') || !['on','off','unknown','error'].includes(state)) throw new Error('invalid_result');
  const key=jobKey(owner,id);
  const [raw,claimed]=await redis([['GET',key],['GET',claimKey(owner,id)]]);
  if(!raw || !claimed) throw new Error('invalid_result');
  const job=unseal(raw,key);
  if(!Object.hasOwn(targets,job.target) || !['on','off'].includes(job.action)) throw new Error('invalid_result');
  const answer=state===job.action ? `${targets[job.target]}: ${state==='on'?'включено':'выключено'}. Состояние проверено в Home Assistant.`
    : `${targets[job.target]}: не удалось подтвердить изменение. Проверьте устройство; автоматически повторять команду не буду.`;
  const code=digest(nonce()), replyKey=`alice:voice:reply:${owner}:${code}`;
  const [saved]=await redis([['EVAL',`-- home-result
if not redis.call('SET',KEYS[1],'1','NX','EX',90) then return 0 end
redis.call('SET',KEYS[2],ARGV[1],'EX',90);
redis.call('LPUSH',KEYS[3],ARGV[2]); redis.call('EXPIRE',KEYS[3],90);
if redis.call('GET',KEYS[4])==ARGV[3] then redis.call('DEL',KEYS[4]); end
return 1`,
    4,resultKey(owner,id),replyKey,deliveryKey(owner),pendingKey(owner),seal({answer},replyKey),JSON.stringify({id,reply_code:code}),id]]);
  return saved===1;
}

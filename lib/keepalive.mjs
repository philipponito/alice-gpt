import { redis, seal, unseal } from './store.mjs';

const configKey=owner=>`alice:keepalive:config:${owner}`;
const activityKey=owner=>`alice:keepalive:activity:${owner}`;
const issuedKey=owner=>`alice:keepalive:issued:${owner}`;
const confirmedKey=owner=>`alice:keepalive:confirmed:${owner}`;
export const keepaliveOnline=owner=>`alice:keepalive:online:${owner}`;

export async function disableKeepalive(owner) {
  await redis([['DEL',configKey(owner),issuedKey(owner)]],1000);
}

export async function setKeepalive(owner,enabled,now=Date.now()) {
  if(!enabled) {await disableKeepalive(owner);return 'Постоянный режим выключен.';}
  const [ready]=await redis([['GET',keepaliveOnline(owner)]],1000);
  if(!ready)return 'Для постоянного режима нужен работающий Home Assistant с компонентом версии 0.4. Режим пока не включён.';
  const key=configKey(owner);
  await redis([['SET',key,seal({enabled:true,interval:90000},key)],['SET',activityKey(owner),String(now),'EX',86400]],1000);
  return 'Постоянный режим включён: буду пробовать тихо поддерживать навык каждые полторы минуты бездействия. Для отключения скажите «выключи постоянный режим».';
}

export async function noteSkillActivity(owner,refresh=false,now=Date.now()) {
  const commands=[['EVAL',`-- keepalive-activity
local previous=tonumber(redis.call('GET',KEYS[1]) or '0');
if previous<tonumber(ARGV[1]) then redis.call('SET',KEYS[1],ARGV[1],'EX',86400); end
return 1`,1,activityKey(owner),String(now)]];
  if(refresh)commands.push(['SET',confirmedKey(owner),String(now),'EX',86400]);
  await redis(commands,1000);
}

export async function nextKeepalive(owner,now=Date.now()) {
  const key=configKey(owner);
  const [raw,activity,issued]=await redis([['GET',key],['GET',activityKey(owner)],['GET',issuedKey(owner)]]);
  if(!raw)return null;
  const config=unseal(raw,key);
  if(config.enabled!==true || config.interval!==90000 || now-Math.max(Number(activity)||0,Number(issued)||0)<config.interval)return null;
  const [claimed]=await redis([['EVAL',`-- keepalive-issue
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
local last=tonumber(redis.call('GET',KEYS[2]) or '0');
local activity=tonumber(redis.call('GET',KEYS[3]) or '0');
if tonumber(ARGV[2])-math.max(last,activity)<90000 then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'EX',86400); return 1`,3,key,issuedKey(owner),activityKey(owner),raw,String(now)]]);
  return claimed===1?{kind:'keepalive'}:null;
}

export async function keepaliveStatus(owner,now=Date.now()) {
  const key=configKey(owner);
  const [raw,confirmed,online]=await redis([['GET',key],['GET',confirmedKey(owner)],['GET',keepaliveOnline(owner)]],1200);
  if(!raw)return 'Постоянный режим выключен.';
  const config=unseal(raw,key);
  if(config.enabled!==true)return 'Постоянный режим выключен.';
  const age=confirmed?Math.max(0,Math.round((now-Number(confirmed))/1000)):null;
  return `Постоянный режим включён, интервал полторы минуты. ${online?'Home Assistant на связи.':'Home Assistant сейчас не отвечает.'} ${age===null?'Служебное обращение ещё не подтверждено.':`Последнее подтверждённое обращение ${age} секунд назад.`} Это проверка обращений, а не измерение тайм-аута Яндекса.`;
}

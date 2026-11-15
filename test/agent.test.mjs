import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Entire suite uses synthetic accounts and a fake Redis/provider; no live mailbox or calendar.
Object.assign(process.env, {
  ALICE_AGENT_MODE: 'unified', KV_REST_API_URL: 'https://redis.example.test', KV_REST_API_TOKEN: 'fake-redis',
  ALICE_WEBHOOK_SECRET: 'test-only-webhook-secret-00000000000000000000', OPENAI_API_KEY: 'fake-openai',
  GOOGLE_CLIENT_ID: '123456-testclient.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fake-client-secret',
  GOOGLE_REDIRECT_URI: 'https://alice.example.test/api/google/callback'
});
const { seal, unseal, digest, redis, getPrivate, putPrivate, tokenKey } = await import('../lib/store.mjs');
const { pairing, begin, finish, accessToken, SCOPES, config } = await import('../lib/google-oauth.mjs');
const { executeTool, docText, messageText } = await import('../lib/google-tools.mjs');
const { runAgent, startJob, pollJob } = await import('../lib/google-jobs.mjs');
const { searchWeb, runWebAgent, publicSource } = await import('../lib/web-search.mjs');
const { executeCalendarAction } = await import('../lib/calendar-actions.mjs');
const { default: alice } = await import('../api/alice.mjs');
const { default: connect } = await import('../api/google/connect.mjs');
const { default: callback } = await import('../api/google/callback.mjs');
const { voicePairing, bindVoice, voiceOwner, deferVoice, nextVoice, clearVoicePending } = await import('../lib/voice-bridge.mjs');
const { default: voiceNext } = await import('../api/bridge/next.mjs');
const { default: voicePair } = await import('../api/bridge/pair.mjs');
const { startHome, nextHome, finishHome, homeHeartbeat } = await import('../lib/home-actions.mjs');
const { default: homeResult } = await import('../api/bridge/home-result.mjs');
const { setKeepalive, nextKeepalive, noteSkillActivity, keepaliveStatus } = await import('../lib/keepalive.mjs');
const { validateReminder, relativeReminder, presentReminder, claimReminder, createReminder } = await import('../lib/reminders.mjs');
const originalFetch = globalThis.fetch;
let db, expiry, calls, provider, pageProvider, background, redisDelay;
function response(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
function routeReply(route = true, reply = 'Хорошо') {
  return response({output:[{content:[{type:'output_text',text:JSON.stringify({reply, changes:[], google_route:route})}]}]});
}
function cmd(c) {
  const [op, k, ...a] = c;
  if (expiry.get(k) <= Date.now()) { db.delete(k); expiry.delete(k); }
  if (op === 'GET') return db.get(k) ?? null;
  if (op === 'GETDEL') { const value = db.get(k) ?? null; db.delete(k); return value; }
  if (op === 'EXISTS') return db.has(k) ? 1 : 0;
  if (op === 'LPUSH') { const list=db.get(k)||[]; list.unshift(...a);db.set(k,list);return list.length; }
  if (op === 'RPOP') { return db.get(k)?.pop() ?? null; }
  if (op === 'EXPIRE') { expiry.set(k,Date.now()+Number(a[0])*1000);return 1; }
  if (op === 'SET') {
    if (a.includes('NX') && db.has(k)) return null;
    db.set(k, a[0]);
    if (a.includes('EX')) expiry.set(k, Date.now() + Number(a[a.indexOf('EX') + 1]) * 1000);
    return 'OK';
  }
  if (op === 'DEL') { for (const key of [k, ...a]) db.delete(key); return 1; }
  if (op === 'EVAL') {
    const script = k, count = a[0], keys = a.slice(1, 1+count), args = a.slice(1+count);
    if(script.includes('-- native-reply')) {
      const code=cmd(['GETDEL',keys[0]]);
      return code?[code,cmd(['GETDEL',args[0]+code])]:null;
    }
    if(script.includes('-- keepalive-activity')) {
      if(Number(cmd(['GET',keys[0]])||0)<Number(args[0]))cmd(['SET',keys[0],args[0],'EX',86400]);
      return 1;
    }
    if(script.includes('-- keepalive-issue')) {
      if(cmd(['GET',keys[0]])!==args[0])return 0;
      if(Number(args[1])-Math.max(Number(cmd(['GET',keys[1]])||0),Number(cmd(['GET',keys[2]])||0))<90000)return 0;
      cmd(['SET',keys[1],args[1],'EX',86400]);return 1;
    }
    if(script.includes('-- deferred-start')) {
      const online=cmd(['GET',keys[3]])?1:0,previous=cmd(['GET',keys[0]]);
      if(previous)return [previous,online];
      cmd(['SET',keys[0],args[0],'EX',600]);
      cmd(['SET',keys[1],args[0],'EX',600]);
      cmd(['SET',keys[2],args[1],'EX',300]);return [args[0],online];
    }
    if(script.includes('-- deferred-publish')) {
      if(!cmd(['SET',keys[0],'1','NX','EX',300]))return 0;
      cmd(['SET',keys[1],args[0],'EX',300]);
      if(args[3]==='1') {
        cmd(['SET',keys[2],args[1],'EX',90]);cmd(['LPUSH',keys[3],args[2]]);cmd(['EXPIRE',keys[3],90]);
      }
      return 1;
    }
    if(script.includes('-- deferred-forward')) {
      if(cmd(['GET',keys[0]])===args[0])cmd(['SET',keys[0],args[1],'EX',600]);
      return 1;
    }
    if(script.includes('-- home-start')) {
      if(cmd(['GET',keys[0]])) return 'duplicate';
      if(!cmd(['GET',keys[1]])) return 'offline';
      if(cmd(['GET',keys[2]])) return 'busy';
      cmd(['SET',keys[0],args[0],'EX',120]);cmd(['SET',keys[2],args[0],'EX',45]);
      cmd(['SET',keys[3],args[1],'EX',90]);return 'queued';
    }
    if(script.includes('-- home-claim')) {
      if(cmd(['GET',keys[0]])!==args[0] || cmd(['GET',keys[1]])) return 0;
      cmd(['SET',keys[1],'1','EX',90]);return 1;
    }
    if(script.includes('-- home-result')) {
      if(!cmd(['SET',keys[0],'1','NX','EX',90])) return 0;
      if(args[3]!=='silent') {cmd(['SET',keys[1],args[0],'EX',90]);cmd(['LPUSH',keys[2],args[1]]);cmd(['EXPIRE',keys[2],90]);}
      if(cmd(['GET',keys[3]])===args[2]) cmd(['DEL',keys[3]]);
      return 1;
    }
    if (script.includes('-- voice-defer')) {
      if (!cmd(['GET',keys[0]])) return 0;
      cmd(['SET',keys[1],args[0],'EX',90]); return 1;
    }
    if (script.includes('-- voice-renew')) {
      if(cmd(['GET',keys[0]])!==args[0] || !cmd(['GET',keys[1]])) return 0;
      const threshold=Number(args[1])*1000-86400000;
      if(expiry.get(keys[0])-Date.now()<threshold || expiry.get(keys[1])-Date.now()<threshold) {
        for(const key of keys) expiry.set(key,Date.now()+Number(args[1])*1000);
      }
      return 1;
    }
    if (script.includes('-- voice-delivery')) {
      if (cmd(['GET', keys[0]]) !== args[0] || cmd(['GET', keys[1]])) return 0;
      cmd(['SET',keys[2],args[1],'EX',90]);
      cmd(['SET',keys[1],'1','EX',300]); cmd(['DEL',keys[0]]); return 1;
    }
    if (script.includes("'INCR'")) {
      const value = Number(db.get(keys[0]) || 0) + 1; db.set(keys[0], value); return value;
    }
    if (script.includes("redis.call('SET',KEYS[1],'1','NX'")) {
      if (db.has(keys[0])) return 0;
      cmd(['SET',keys[0],'1','EX',600]); cmd(['SET',keys[1],args[0],'EX',300]); return 1;
    }
    if (script.includes('local prev=')) {
      if (args[2] !== 'web' && !db.has(keys[4])) return null;
      const prev = cmd(['GET', keys[0]]) || cmd(['GET', keys[1]]);
      if (prev) return prev;
      cmd(['SET',keys[0],args[0],'EX',600]);cmd(['SET',keys[1],args[0],'EX',55]);
      cmd(['SET',keys[2],args[0],'EX',600]);cmd(['SET',keys[3],args[1],'EX',55]);cmd(['DEL',keys[5]]); return args[0];
    }
    if (db.get(keys[0]) === args[0]) {
      if (keys[1]) cmd(['SET',keys[1],args[1],'EX',300]);
      db.delete(keys[0]); return 1;
    }
    return 0;
  }
  throw new Error(`Unexpected fake Redis operation: ${op}`);
}
function res() {
  return { headers: {}, statusCode: 200, setHeader(k,v) { this.headers[k] = v; },
    status(n) { this.statusCode = n; return this; }, send(v) { this.body = v; return this; },
    json(v) { this.body = v; return this; }, end() { return this; } };
}
function request(question, overrides = {}) {
  return { method: 'POST', url: `/api/alice?key=${process.env.ALICE_WEBHOOK_SECRET}`,
    headers: {}, body: { request: { original_utterance: question, command: question },
      session: { user: { user_id: 'person-1' }, skill_id: 'skill-1', session_id: 'session-1', message_id: 1 } }, ...overrides };
}
const owner = digest('skill-1:user:person-1');
async function tokens(who = owner, overrides = {}) {
  await putPrivate(tokenKey(who), { access: 'fake-access', refresh: 'fake-refresh', sub: 'account-1',
    scopes: ['openid', ...Object.values(SCOPES).flat()], expires: Date.now()+3600000, ...overrides });
}
beforeEach(() => {
  db = new Map(); expiry = new Map(); calls = []; background = []; redisDelay = 0;
  delete process.env.ALICE_GPT_SEARCH;
  globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: p => background.push(p) }) };
  provider = () => { throw new Error('Unexpected external request'); };
  pageProvider = () => response({text:''});
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url); calls.push({ url: href, ...options });
    if (href === 'https://redis.example.test/pipeline') {
      if (redisDelay) await new Promise(resolve=>setTimeout(resolve,redisDelay));
      return response(JSON.parse(options.body).map(c => ({ result: cmd(c) })));
    }
    if(href==='https://scrape.serper.dev/') return pageProvider(href,options);
    return provider(href, options);
  };
});
after(() => { globalThis.fetch = originalFetch; delete globalThis[Symbol.for('@vercel/request-context')]; });


const toolCall=(name,args,id='tool-1')=>response({output:[{type:'function_call',name,arguments:JSON.stringify(args),call_id:id}]});
const textReply=text=>response({output:[{role:'assistant',content:[{type:'output_text',text}]}]});

test('unified agent answers and remembers ordinary dialogue in the same model loop', async()=>{
  let round=0;
  provider=(url,opts)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(opts.body);
    assert.equal(body.text,undefined);assert.equal(body.tool_choice,'auto');
    assert.ok(body.tools.some(x=>x.name==='calendar_events'));
    assert.ok(body.tools.some(x=>x.name==='drive_search'));
    return ++round===1?textReply('Это цитата «Дорогу осилит идущий».'):textReply('Мы обсуждали цитату «Дорогу осилит идущий».');
  };
  let r=res();await alice(request('Скажи известную цитату'),r);assert.match(r.body.response.text,/Дорогу/);
  r=res();await alice(request('Что мы обсуждали?',{body:{...request('').body,request:{original_utterance:'Что мы обсуждали?',command:'Что мы обсуждали?'},session:{...request('').body.session,message_id:2}}}),r);
  assert.match(r.body.response.text,/цитату/);assert.equal(round,2);
});

test('unified agent resolves a follow-up, searches then reads Calendar in one conversation', async()=>{
  process.env.ALICE_GPT_SEARCH='fake-serper';await tokens();let round=0,searches=0,reads=0;
  provider=(url,opts)=>{
    if(url==='https://google.serper.dev/search'){searches++;assert.equal(JSON.parse(opts.body).q,'Дорогу осилит идущий автор');return response({organic:[]});}
    if(url.includes('googleapis.com/calendar/')){reads++;return response({items:[],timeZone:'Europe/Moscow'});}
    const body=JSON.parse(opts.body);assert.ok(body.tools.some(x=>x.name==='web_search'));assert.ok(body.tools.some(x=>x.name==='calendar_events'));
    if(++round===1)return textReply('Цитата: «Дорогу осилит идущий».');
    assert.ok(opts.body.includes('Дорогу осилит идущий'));
    if(round===2)return toolCall('web_search',{query:'Дорогу осилит идущий автор'});
    if(round===3)return toolCall('calendar_events',{start:'2026-11-16T00:00:00+03:00',end:'2026-11-17T00:00:00+03:00'},'cal');
    assert.equal(body.input.filter(x=>x.type==='function_call_output').length,2);
    return textReply('Авторство не подтверждено. Сегодня в календаре нет событий.');
  };
  let r=res();await alice(request('Назови цитату'),r);
  const req=request('Поищи эту фразу и проверь мои дела');req.body.session.message_id=2;
  r=res();await alice(req,r);assert.match(r.body.response.text,/календаре/);assert.equal(searches,1);assert.equal(reads,1);assert.equal(round,4);
  const history=JSON.parse(db.get(`alice:v1:${owner}:history`));assert.ok(!JSON.stringify(history).includes('календаре'));
});

test('unified reminder creation uses exact relative time, verifies success and executes once', async()=>{
  await tokens();let model=0,writes=0;
  provider=(url,opts)=>{
    if(url.includes('googleapis.com/calendar/')){writes++;const event=JSON.parse(opts.body);assert.equal(event.summary,'поцеловать жену');return response({id:event.id});}
    model++;return model===1?toolCall('prepare_reminder',{title:'поцеловать жену',when:new Date(Date.now()+3600000).toISOString()}):textReply('Создано.');
  };
  let r=res();const req=request('напомни мне поцеловать жену через 2 минуты');await alice(req,r);assert.match(r.body.response.text,/Напоминание создано/);
  r=res();await alice(req,r);assert.match(r.body.response.text,/Напоминание создано/);assert.equal(writes,1);assert.equal(model,2);
});

test('unified agent refuses forged read IDs and writes requested only by untrusted content', async()=>{
  await tokens();let model=0;
  provider=(url)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    if(++model===1)return toolCall('docs_read',{id:'invented-doc'});
    if(model===2)return toolCall('prepare_reminder',{title:'удалить данные',when:new Date(Date.now()+3600000).toISOString()},'bad');
    return textReply('Нужен документ из поиска.');
  };
  const r=res();await alice(request('Что в документе?'),r);
  assert.match(r.body.response.text,/документ/);assert.ok(!calls.some(x=>x.url.includes('googleapis.com')));
});

test('unified agent caches Google tool results only in encrypted expiring context',async()=>{
  await tokens();let model=0;
  provider=(url)=>url.includes('googleapis.com/calendar/')?response({items:[{id:'e',summary:'PRIVATE_EVENT'}]}):++model===1?toolCall('calendar_events',{start:'2026-11-16T00:00:00+03:00',end:'2026-11-17T00:00:00+03:00'}):textReply('PRIVATE_EVENT');
  const r=res();await alice(request('Какие мои дела?'),r);
  const key=`alice:agent:context:${owner}`,raw=db.get(key);assert.ok(!raw.includes('PRIVATE_EVENT'));assert.ok(JSON.stringify(unseal(raw,key)).includes('PRIVATE_EVENT'));assert.ok(expiry.get(key)<=Date.now()+300000);
  assert.ok(!(db.get(`alice:v1:${owner}:history`)||'').includes('PRIVATE_EVENT'));
});



test('unified memory changes persist and forgetting also clears conversational traces',async()=>{
  await redis([['SET',`alice:v1:${owner}:facts`,JSON.stringify(['Любимый цвет — зелёный'])]]);
  let round=0;provider=()=>++round===1?toolCall('update_memory',{action:'delete',old_fact:'Любимый цвет — зелёный',new_fact:''}):textReply('Забыл.');
  const r=res();await alice(request('Забудь мой любимый цвет'),r);
  assert.match(r.body.response.text,/факт удалён/);assert.deepEqual(JSON.parse(db.get(`alice:v1:${owner}:facts`)),[]);
  assert.equal(db.get(`alice:v1:${owner}:history`),undefined);
  const k=`alice:agent:context:${owner}`;assert.ok(!JSON.stringify(unseal(db.get(k),k)).includes('зелёный'));
});

test('unified calendar move reads fresh versions, preserves duration and never repeats a PATCH',async()=>{
  await tokens();let round=0,patches=0;
  const start=new Date(Date.now()+86400000),end=new Date(start.getTime()+3600000),when=new Date(start.getTime()+7200000).toISOString();
  provider=(url,opts)=>{
    if(url.includes('googleapis.com/calendar/')) {
      if(opts.method==='GET')return response({items:[{id:'event-one',etag:'v-current',summary:'Позвонить',organizer:{self:true},start:{dateTime:start.toISOString()},end:{dateTime:end.toISOString()}}]});
      patches++;assert.equal(opts.headers['If-Match'],'v-current');assert.equal(Date.parse(JSON.parse(opts.body).end.dateTime)-Date.parse(JSON.parse(opts.body).start.dateTime),3600000);return response({});
    }
    if(++round===1)return toolCall('calendar_events',{start:start.toISOString(),end:new Date(start.getTime()+86400000).toISOString()});
    if(round===2)return toolCall('propose_calendar_change',{kind:'move',ids:['event-one'],when},'move');
    return textReply('Перенёс.');
  };
  const req=request('Перенеси напоминание на два часа позже');let r=res();await alice(req,r);assert.match(r.body.response.text,/перенесено/);
  r=res();await alice(req,r);assert.equal(patches,1);
});

test('unified private content cannot supply an external search query',async()=>{
  await tokens();process.env.ALICE_GPT_SEARCH='fake-serper';let model=0;
  provider=(url,opts)=>{
    const body=opts.body?JSON.parse(opts.body):null;
    if(url.includes('googleapis.com/calendar/'))return response({items:[{id:'one',summary:'PRIVATE_GOOGLE_QUERY'}]});
    if(url==='https://google.serper.dev/search'){assert.equal(body.q,'погода Москва сегодня');return response({organic:[]});}
    assert.equal(url,'https://api.openai.com/v1/responses');
    if(body.text){assert.equal(body.text.format.name,'public_query');assert.ok(!opts.body.includes('PRIVATE_GOOGLE_QUERY'));return textReply(JSON.stringify({query:'погода Москва сегодня'}));}
    if(++model===1)return toolCall('calendar_events',{start:'2026-11-16T00:00:00+03:00',end:'2026-11-17T00:00:00+03:00'});
    if(model===2)return toolCall('web_search',{query:'PRIVATE_GOOGLE_QUERY'},'web');
    return textReply('Встречи проверены; сведения о погоде получены.');
  };
  const r=res();await alice(request('Проверь календарь и погоду в Москве сегодня'),r);assert.match(r.body.response.text,/погоде/);
});

test('unified agent reads a document found in an earlier turn without inventing an ID',async()=>{
  await tokens();let model=0;
  provider=(url)=>{
    if(url.includes('drive/v3/'))return response({files:[{id:'doc-one',name:'План',mimeType:'application/vnd.google-apps.document'}]});
    if(url.includes('docs.googleapis.com/'))return response({title:'План',body:{content:[{paragraph:{elements:[{textRun:{content:'Текст плана'}}]}}]}});
    if(++model===1)return toolCall('drive_search',{query:'План'});
    if(model===2)return textReply('Нашёл документ «План».');
    if(model===3)return toolCall('docs_read',{id:'doc-one'},'read');
    return textReply('В документе: Текст плана.');
  };
  let r=res();await alice(request('Найди документ План'),r);
  const req=request('Прочитай его');req.body.session.message_id=2;r=res();await alice(req,r);assert.match(r.body.response.text,/Текст плана/);
});

test('unified slow response is delivered through the existing bridge without a second model call',async()=>{
  const pair=await bindVoice({code:await voicePairing(owner),secret:process.env.ALICE_WEBHOOK_SECRET},'test-ip');await homeHeartbeat(owner);
  let release,models=0;const held=new Promise(resolve=>{release=resolve;});
  provider=async()=>{models++;await held;return textReply('Готовый ответ единого агента.');};
  const r=res();await alice(request('Объясни принцип работы ракеты'),r);assert.equal(r.body.response.text,'Обрабатываю запрос.');
  release();await Promise.all(background);
  const ready=res();await voiceNext({method:'POST',headers:{authorization:`Bearer ${pair.token}`},body:{lights:true,ready:true}},ready);
  assert.ok(ready.body.reply_code);assert.equal(models,1);
  const answer=res();await alice(request('готовый ответ'),answer);assert.equal(answer.body.response.text,'Готовый ответ единого агента.');
});


test('a verified reminder result survives a subsequent model failure',async()=>{
  await tokens();let model=0,writes=0;
  provider=(url,opts)=>{
    if(url.includes('googleapis.com/calendar/')){writes++;return response({id:JSON.parse(opts.body).id});}
    return ++model===1?toolCall('prepare_reminder',{title:'Позвонить',when:new Date(Date.now()+86400000).toISOString()}):response({error:'provider failed'},503);
  };
  const r=res();await alice(request('Напомни завтра позвонить'),r);assert.match(r.body.response.text,/Напоминание создано/);assert.equal(writes,1);
});

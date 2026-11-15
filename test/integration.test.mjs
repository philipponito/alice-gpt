import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Entire suite uses synthetic accounts and a fake Redis/provider; no live mailbox or calendar.
Object.assign(process.env, {
  KV_REST_API_URL: 'https://redis.example.test', KV_REST_API_TOKEN: 'fake-redis',
  ALICE_WEBHOOK_SECRET: 'test-only-webhook-secret-00000000000000000000', OPENAI_API_KEY: 'fake-openai',
  GOOGLE_CLIENT_ID: '123456-testclient.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fake-client-secret',
  GOOGLE_REDIRECT_URI: 'https://alice.example.test/api/google/callback'
});
const { seal, unseal, digest, redis, getPrivate, putPrivate, tokenKey } = await import('../lib/store.mjs');
const { pairing, begin, finish, accessToken, SCOPES, config } = await import('../lib/google-oauth.mjs');
const { executeTool, docText, messageText } = await import('../lib/google-tools.mjs');
const { runAgent, startJob, pollJob } = await import('../lib/google-jobs.mjs');
const { default: alice } = await import('../api/alice.mjs');
const { default: connect } = await import('../api/google/connect.mjs');
const { default: callback } = await import('../api/google/callback.mjs');
const { validateReminder, presentReminder, claimReminder, createReminder } = await import('../lib/reminders.mjs');
const originalFetch = globalThis.fetch;
let db, expiry, calls, provider, background;
function response(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
function cmd(c) {
  const [op, k, ...a] = c;
  if (expiry.get(k) <= Date.now()) { db.delete(k); expiry.delete(k); }
  if (op === 'GET') return db.get(k) ?? null;
  if (op === 'GETDEL') { const value = db.get(k) ?? null; db.delete(k); return value; }
  if (op === 'EXISTS') return db.has(k) ? 1 : 0;
  if (op === 'SET') {
    if (a.includes('NX') && db.has(k)) return null;
    db.set(k, a[0]);
    if (a.includes('EX')) expiry.set(k, Date.now() + Number(a[a.indexOf('EX') + 1]) * 1000);
    return 'OK';
  }
  if (op === 'DEL') { for (const key of [k, ...a]) db.delete(key); return 1; }
  if (op === 'EVAL') {
    const script = k, count = a[0], keys = a.slice(1, 1+count), args = a.slice(1+count);
    if (script.includes("'INCR'")) {
      const value = Number(db.get(keys[0]) || 0) + 1; db.set(keys[0], value); return value;
    }
    if (script.includes('local prev=')) {
      const prev = cmd(['GET', keys[0]]) || cmd(['GET', keys[1]]);
      if (prev) return prev;
      cmd(['SET',keys[0],args[0],'EX',600]);cmd(['SET',keys[1],args[0],'EX',55]);
      cmd(['SET',keys[2],args[0],'EX',600]);cmd(['SET',keys[3],args[1],'EX',55]); return args[0];
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
  db = new Map(); expiry = new Map(); calls = []; background = [];
  globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: p => background.push(p) }) };
  provider = () => { throw new Error('Unexpected external request'); };
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url); calls.push({ url: href, ...options });
    if (href === 'https://redis.example.test/pipeline') return response(JSON.parse(options.body).map(c => ({ result: cmd(c) })));
    return provider(href, options);
  };
});
after(() => { globalThis.fetch = originalFetch; delete globalThis[Symbol.for('@vercel/request-context')]; });

test('private data is authenticated, encrypted and bound to its user/key', () => {
  const value = seal({ refresh: 'never-visible' }, 'owner-a');
  assert.ok(!value.includes('never-visible'));
  assert.deepEqual(unseal(value, 'owner-a'), { refresh: 'never-visible' });
  assert.throws(() => unseal(value, 'owner-b'));
  const segments = value.split('.'); segments[1] = Buffer.alloc(16).toString('base64url');
  assert.throws(() => unseal(segments.join('.'), 'owner-a'));
});
test('a misplaced client secret cannot be included in the Google authorization URL', () => {
  const previous = process.env.GOOGLE_CLIENT_ID;
  try {
    process.env.GOOGLE_CLIENT_ID = 'GOCSPX-test-only-not-a-real-secret';
    assert.throws(() => config(), /google_not_configured/);
  } finally { process.env.GOOGLE_CLIENT_ID = previous; }
});
test('webhook rejects missing/wrong secrets, exit remains immediate with no external requests', async () => {
  for (const url of ['/api/alice', '/api/alice?key=wrong']) {
    const r = res(); await alice(request('письма', { url }), r); assert.equal(r.statusCode, 403);
  }
  const r = res(); await alice(request('хватит'), r);
  assert.equal(r.body.response.end_session, true); assert.equal(calls.length, 0);
});
test('GPT, fact memory and existing key format remain working', async () => {
  provider = (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(JSON.parse(options.body).model, 'gpt-6-luna');
    return response({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ reply: 'Запомнил.',
      changes: [{ action: 'add', old_fact: '', new_fact: 'Любит чай' }] }) }] }] });
  };
  const r = res(); await alice(request('запомни, я люблю чай'), r);
  assert.equal(r.body.response.text, 'Запомнил.');
  assert.deepEqual(JSON.parse(db.get(`alice:v1:${owner}:facts`)), ['Любит чай']);
  const r2 = res(); await alice(request('покажи память'), r2); assert.match(r2.body.response.text, /Любит чай/);
  const r3 = res(); await alice(request('очисти историю'), r3);
  assert.ok(db.has(`alice:v1:${owner}:facts`)); assert.ok(!db.has(`alice:v1:${owner}:history`));
});
test('application identity alone cannot connect or read Google', async () => {
  const req = request('мои письма'); req.body.session.user = undefined; req.body.session.application = { application_id:'device-1' };
  const r = res(); await alice(req,r); assert.match(r.body.response.text, /войдите/i); assert.equal(calls.length, 0);
});
test('email synonyms are routed to Google rather than ordinary GPT', async () => {
  for (const question of ['мой последний прочитанный имейл', 'последний email', 'проверь е-мейл']) {
    const r = res(); await alice(request(question), r);
    assert.match(r.body.response.text, /Google ещё не подключён/);
  }
});
test('connection page has no secrets or inline scripts and separates reminder permission', async () => {
  const r = res(); await connect({ method:'GET' },r);
  assert.equal(r.statusCode,200); assert.ok(r.headers['Cache-Control'].includes('no-store'));
  assert.equal(r.headers['Referrer-Policy'],'same-origin');
  assert.ok(r.headers['Content-Security-Policy'].includes("form-action 'self' https://accounts.google.com;"));
  assert.match(r.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Lax/);
  assert.ok(!r.body.includes(process.env.ALICE_WEBHOOK_SECRET)); assert.ok(!r.body.includes('<script'));
  assert.ok(SCOPES.reminders[0].endsWith('calendar.events.owned'));
  assert.match(r.body, /name="reminders"/);
});
test('reminder requires session-bound single-use confirmation and creates two popup notifications', async () => {
  await tokens();
  const item = validateReminder({ title:'Позвонить', when:new Date(Date.now()+86400000).toISOString() });
  assert.match(await presentReminder(owner,'session-1',item), /30 минут/);
  const claimed = await claimReminder(owner,'session-1');
  assert.equal(claimed.title,'Позвонить');
  assert.equal(await claimReminder(owner,'session-1'),null);
  await presentReminder(owner,'session-1',item);
  assert.equal(await claimReminder(owner,'session-1'),null);
  provider = (url, opts) => {
    assert.equal(url,'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none');
    assert.equal(opts.method,'POST');
    const event = JSON.parse(opts.body);
    assert.deepEqual(event.reminders.overrides,[{method:'popup',minutes:30},{method:'popup',minutes:0}]);
    assert.equal(event.id,item.id);
    return response({id:item.id});
  };
  assert.match(await createReminder(owner,claimed),/создано/);
});
test('reminder is not confirmed across sessions or with invalid dates', async () => {
  assert.throws(()=>validateReminder({title:'x',when:'y'}));
  const item=validateReminder({title:'x',when:new Date(Date.now()+86400000).toISOString()});
  await presentReminder(owner,'a',item);
  assert.equal(await claimReminder(owner,'b'),null);
  assert.equal(await claimReminder(owner,'a'),null);
});
test('explicit voice confirmation performs one calendar insert even if repeated', async () => {
  await tokens();
  const item=validateReminder({title:'Позвонить Лилии',when:new Date(Date.now()+86400000).toISOString()});
  await presentReminder(owner,'session-1',item);
  let writes=0;
  provider=(url,opts)=>{ assert.equal(opts.method,'POST'); writes++; return response({id:item.id}); };
  const first=res(); await alice(request('подтверждаю'),first);
  assert.match(first.body.response.text,/создано/);
  const again=res(); await alice(request('подтверждаю'),again);
  assert.match(again.body.response.text,/Нет ожидающего/);
  assert.equal(writes,1);
});
async function flow() {
  const code = await pairing(owner), r = res();
  const req = { headers: { origin:'https://alice.example.test', cookie:'__Host-google-form=csrf-test' } };
  const fields = { code, csrf:'csrf-test', secret:process.env.ALICE_WEBHOOK_SECRET, calendar:'on', docs:'on', gmail:'on' };
  const url = new URL(await begin(req,r,fields));
  const cookie = r.headers['Set-Cookie'].split(';')[0];
  return { req, fields, url, cookie, callback: { method:'GET', url:`/api/google/callback?state=${url.searchParams.get('state')}&code=fake-code`, headers:{cookie} } };
}
test('OAuth rejects cross-origin forms, missing cookie and wrong owner key', async () => {
  const code = await pairing(owner);
  const fields = { code, csrf:'x', secret:process.env.ALICE_WEBHOOK_SECRET, calendar:'on' };
  await assert.rejects(begin({headers:{origin:'https://evil.test',cookie:'__Host-google-form=x'}},res(),fields), /csrf/);
  await assert.rejects(begin({headers:{origin:'https://alice.example.test'}},res(),fields), /csrf/);
  await assert.rejects(begin({headers:{origin:'https://alice.example.test',cookie:'__Host-google-form=x'}},res(),{...fields,secret:'bad'}), /unauthorized/);
});
test('pairing is single use; OAuth has offline access, PKCE and nonce', async () => {
  const f = await flow();
  assert.equal(f.url.searchParams.get('access_type'),'offline');
  assert.equal(f.url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(f.url.searchParams.get('state').length,43);
  await assert.rejects(begin(f.req,res(),f.fields), /invalid_pair/);
});
test('callback rejects stolen state without cookie; valid callback is single use and encrypts refresh token', async () => {
  const f = await flow();
  await assert.rejects(finish({...f.callback,headers:{cookie:'__Host-google-oauth=wrong'}},res()), /csrf/);
  provider = (url, opts) => {
    if (url.endsWith('/token')) {
      const p = new URLSearchParams(opts.body); assert.equal(p.get('grant_type'),'authorization_code');
      assert.equal(createHash('sha256').update(p.get('code_verifier')).digest('base64url'),f.url.searchParams.get('code_challenge'));
      return response({ access_token:'new-access',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600,scope:f.url.searchParams.get('scope') });
    }
    assert.equal(url,'https://openidconnect.googleapis.com/v1/userinfo'); return response({sub:'account-1'});
  };
  assert.equal(await finish(f.callback,res()),owner);
  assert.equal((await getPrivate(tokenKey(owner))).refresh,'new-refresh');
  assert.ok(!db.get(tokenKey(owner)).includes('new-refresh'));
  await assert.rejects(finish(f.callback,res()), /csrf/);
});
test('denied consent and missing scopes cannot create a connection', async () => {
  const f = await flow();
  await assert.rejects(finish({...f.callback,url:f.callback.url+'&error=access_denied'},res()),/consent_denied/);
  assert.ok(!db.has(tokenKey(owner)));
  const f2 = await flow();
  provider = () => response({access_token:'x',token_type:'Bearer',scope:'openid'});
  await assert.rejects(finish(f2.callback,res()),/missing_scopes/);
  assert.ok(!db.has(tokenKey(owner)));
});
test('callback cannot silently replace a linked Google account', async () => {
  await tokens(); const f = await flow();
  provider = url => url.endsWith('/token') ? response({access_token:'x',refresh_token:'y',token_type:'Bearer',scope:f.url.searchParams.get('scope')}) : response({sub:'other-account'});
  await assert.rejects(finish(f.callback,res()),/different_account/);
  assert.equal((await getPrivate(tokenKey(owner))).sub,'account-1');
});
test('refresh preserves existing refresh token and invalid_grant is actionable', async () => {
  await tokens(owner,{expires:0});
  provider = (url,opts) => { assert.equal(new URLSearchParams(opts.body).get('grant_type'),'refresh_token');
    return response({access_token:'renewed',token_type:'Bearer',expires_in:3600}); };
  assert.equal(await accessToken(owner,SCOPES.calendar),'renewed');
  assert.equal((await getPrivate(tokenKey(owner))).refresh,'fake-refresh');
  await tokens(owner,{expires:0}); provider = () => response({error:'invalid_grant'},400);
  await assert.rejects(accessToken(owner,SCOPES.calendar),/reauthorize/);
});
test('Google tools reject writes, unknown arguments, URLs-as-IDs and excessive date ranges', async () => {
  for (const [name,args] of [['gmail_send',{to:'x'}],['docs_read',{id:'https://evil.test'}],['gmail_read',{id:'ok',url:'https://evil.test'}],
    ['calendar_events',{start:'2026-01-01T00:00:00Z',end:'2027-01-01T00:00:00Z'}]]) {
    await assert.rejects(executeTool(owner,name,args));
  }
  assert.equal(calls.length,0);
});
test('Google requests use only fixed HTTPS origins, GET and bearer headers', async () => {
  await tokens();
  provider = (url,opts) => { assert.equal(opts.method,'GET'); assert.equal(opts.redirect,'error'); assert.match(opts.headers.Authorization,/^Bearer /);
    assert.ok(url.startsWith('https://www.googleapis.com/drive/v3/files?')); assert.ok(!url.includes('fake-access'));
    return response({files:[{id:'doc-1',name:'План'}],nextPageToken:'more'}); };
  const data = await executeTool(owner,'drive_search',{query:"O'Reilly"});
  assert.equal(data.files[0].name,'План'); assert.equal(data.more,true);
});
test('Google data and scopes are isolated by Alice identity', async () => {
  await tokens(); await assert.rejects(executeTool('other-user','gmail_read',{id:'message-1'}),/not_connected/);
  await tokens(owner,{scopes:SCOPES.calendar});
  await assert.rejects(executeTool(owner,'gmail_read',{id:'message-1'}),/missing_scopes/);
  assert.ok(calls.every(c=>c.url.includes('redis.example.test')));
});
test('Docs includes nested tabs and tables; Gmail reads plaintext MIME without executing HTML', () => {
  const d = docText({title:'Example',tabs:[{documentTab:{body:{content:[{paragraph:{elements:[{textRun:{content:'A'}}]}}]}},childTabs:[{documentTab:{body:{content:[{table:{tableRows:[{tableCells:[{content:[{paragraph:{elements:[{textRun:{content:'B'}}]}}]}]}]}}]}}}]}]});
  assert.equal(d.text,'AB');
  const m = messageText({id:'1',payload:{mimeType:'multipart/alternative',parts:[{mimeType:'text/html',body:{data:Buffer.from('<script>bad</script>').toString('base64url')}},{mimeType:'text/plain',body:{data:Buffer.from('Hello').toString('base64url')}}]}});
  assert.equal(m.text.trim(),'Hello');
});
test('model tool loop returns factual answer and never exposes tokens to the model', async () => {
  await tokens(); let turns = 0;
  provider = (url,opts) => {
    if (url === 'https://api.openai.com/v1/responses') {
      const body = JSON.parse(opts.body); assert.equal(body.store,false); assert.ok(!opts.body.includes('fake-access'));
      turns++;
      return turns === 1 ? response({output:[{type:'function_call',name:'drive_search',arguments:'{"query":"План"}',call_id:'call-1'}]}) :
        response({output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Найден документ План.'}]}]});
    }
    return response({files:[{id:'doc-1',name:'План'}]});
  };
  const result = await runAgent(owner,'Найди документ План',AbortSignal.timeout(1000));
  assert.equal(result.answer,'Найден документ План.'); assert.equal(turns,2);
});
test('background acknowledgement is immediate, duplicate webhook does not duplicate work; result can be polled', async () => {
  await tokens(); let complete;
  provider = () => new Promise(resolve=>{ complete=()=>resolve(response({output:[{content:[{type:'output_text',text:'Встреча завтра.'}]}]})); });
  const start=Date.now();
  const r = res(); await alice(request('мои встречи завтра'),r);
  assert.ok(Date.now()-start<3700); assert.match(r.body.response.text,/готово/);
  await new Promise(resolve=>setImmediate(resolve));
  await startJob(owner,'мои встречи завтра','session-1:1:мои встречи завтра');
  assert.equal(background.length,1);
  assert.match(await pollJob(owner),/Ещё/);
  complete(); await Promise.all(background);
  assert.equal(await pollJob(owner),'Встреча завтра.');
  assert.ok(![...db.values()].some(v=>typeof v==='string'&&v.includes('Встреча завтра')));
});
test('callback failure never reflects codes or provider descriptions', async () => {
  const r=res(); await callback({method:'GET',url:'/api/google/callback?code=private-code&error_description=private-value',headers:{}},r);
  assert.equal(r.statusCode,400); assert.ok(!r.body.includes('private-'));
});

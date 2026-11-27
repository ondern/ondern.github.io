// Worker tests with mocked Turnstile Siteverify, Resend and rate limiter, and an in-memory SQLite stand-in for D1 (real SQL).
// No real network or email.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handle, escapeHtml, clean, rateKey, subnetKey, verifyBase, purge } from '../src/index.js';
import { makeD1 } from './d1-shim.mjs';

const ORIGIN = 'https://nuray.io';
const realFetch = globalThis.fetch;
let calls;
let mocks;

function makeEnv(over = {}) {
  return {
    RESEND_API_KEY: 'test-resend-key',
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    DIGEST_PEPPER: 'test-pepper-0123456789abcdef0123456789abcdef',
    CONTACT_RECIPIENT: 'owner@example.test',
    MAIL_FROM: 'nuray.io <noreply@nuray.io>',
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    DB: makeD1(),
    ...over,
  };
}

beforeEachMocks();
function beforeEachMocks() {
  calls = { siteverify: [], resend: [] };
  mocks = { siteverify: { success: true, hostname: 'nuray.io', action: 'contact' }, siteverifyStatus: 200, resendStatus: [] };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('siteverify')) {
      calls.siteverify.push(init.body);
      if (mocks.siteverifyThrow) throw new Error('network down');
      if (mocks.siteverifyRaw !== undefined) return new Response(mocks.siteverifyRaw, { status: mocks.siteverifyStatus });
      return new Response(JSON.stringify(mocks.siteverify), { status: mocks.siteverifyStatus });
    }
    if (new URL(String(url)).hostname === 'api.resend.com') {
      calls.resend.push({ headers: init.headers, body: JSON.parse(init.body) });
      const gate = mocks.resendGate?.[calls.resend.length - 1];
      if (gate) await gate; // lets a test hold one Resend call open
      const status = mocks.resendStatus[calls.resend.length - 1] ?? 200;
      return new Response(JSON.stringify({ id: 'x' }), { status });
    }
    throw new Error('unexpected fetch ' + url);
  };
}
test.beforeEach(beforeEachMocks);
test.after(() => { globalThis.fetch = realFetch; });

const good = (over = {}) => ({
  name: 'Ada Lovelace', email: 'Ada@Example.org', subject: 'Hello', message: 'A short test message.', lang: 'de',
  token: 'tok', website: '', startedAt: Date.now() - 10000, ...over,
});
const req = (path, body, { origin = ORIGIN, type = 'application/json', raw, headers = {} } = {}) => new Request('https://api.nuray.io' + path, {
  method: 'POST', headers: { 'Content-Type': type, ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': '203.0.113.7', ...headers },
  body: raw ?? JSON.stringify(body),
});
const post = (body, opts) => req('/contact', body, opts);
const body = async (res) => res.json();
const tokenIn = (call) => (call.body.text.match(/#t=([A-Za-z0-9_-]{43})/) || [])[1];
const verify = (env, token, ctx) => handle(req('/contact/verify', { token }), env, ctx);
const resendLink = (env, resend) => handle(req('/contact/resend', { resend }), env);
const kinds = () => calls.resend.map((c) => (c.body.reply_to ? 'owner' : c.body.subject.match(/bestätigen|verify|doğrula/i) ? 'verify' : 'ack'));
const rows = (env, sql) => env.DB.raw.prepare(sql).all();

// Submits a form and returns the answer plus the token from the confirmation mail.
async function submit(env, over) {
  const res = await handle(post(good(over)), env);
  const b = await body(res);
  const last = calls.resend[calls.resend.length - 1];
  return { res, b, token: b.ok && last ? tokenIn(last) : undefined };
}

test('CORS preflight: allowed origins only, on all three paths', async () => {
  for (const path of ['/contact', '/contact/verify', '/contact/resend']) {
    for (const o of ['https://nuray.io', 'https://www.nuray.io']) {
      const res = await handle(new Request('https://api.nuray.io' + path, { method: 'OPTIONS', headers: { Origin: o } }), makeEnv());
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), o);
      assert.equal(res.headers.get('Vary'), 'Origin');
    }
    for (const o of ['https://evil.example', 'http://nuray.io', 'https://nuray.io.evil.example', '']) {
      const res = await handle(new Request('https://api.nuray.io' + path, { method: 'OPTIONS', headers: o ? { Origin: o } : {} }), makeEnv());
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
    }
  }
});

test('POST from a disallowed or missing origin is rejected before any work', async () => {
  for (const path of ['/contact', '/contact/verify', '/contact/resend']) {
    for (const origin of ['https://evil.example', null]) {
      const res = await handle(req(path, good(), { origin }), makeEnv());
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
    }
  }
  assert.equal(calls.siteverify.length + calls.resend.length, 0);
});

test('unknown path 404, other methods 405', async () => {
  assert.equal((await handle(new Request('https://api.nuray.io/other', { method: 'POST' }), makeEnv())).status, 404);
  assert.equal((await handle(new Request('https://api.nuray.io/contact/verify/x', { method: 'POST' }), makeEnv())).status, 404);
  assert.equal((await handle(new Request('https://api.nuray.io/contact/verify', { method: 'GET', headers: { Origin: ORIGIN } }), makeEnv())).status, 405);
  assert.equal((await handle(new Request('https://api.nuray.io/contact', { method: 'GET', headers: { Origin: ORIGIN } }), makeEnv())).status, 405);
});

test('submitting only mails a confirmation link: nothing reaches the owner before the visitor confirms', async () => {
  const env = makeEnv();
  const { res, b, token } = await submit(env);
  assert.equal(res.status, 200);
  assert.equal(b.ok, true);
  assert.equal(b.pending, true);
  assert.match(b.resend, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(kinds(), ['verify']);
  const mail = calls.resend[0].body;
  assert.deepEqual(mail.to, ['ada@example.org']);
  assert.equal(mail.from, 'nuray.io <noreply@nuray.io>');
  assert.equal(mail.reply_to, undefined);
  assert.match(mail.subject, /Bitte bestätigen/);
  assert.match(mail.text, /^\*\*\* /);
  assert.match(mail.text, /https:\/\/nuray\.io\/verify\.html\?lang=de#t=[A-Za-z0-9_-]{43}/);
  assert.ok(mail.html.includes('href="https://nuray.io/verify.html?lang=de#t='));
  assert.ok(token);
  assert.notEqual(token, b.resend, 'the link token and the resend secret differ');
  assert.equal(rows(env, 'SELECT * FROM pending').length, 1);
});

test('the confirmation mail carries no visitor-supplied text and follows the form language', async () => {
  for (const [lang, re] of [['tr', /doğrulayın/], ['en', /verify your email address/i], ['de', /bestätigen/]]) {
    beforeEachMocks();
    await handle(post(good({ lang, name: 'Eve Secretname', subject: 'Subjectmarker', message: 'Private message body marker' })), makeEnv());
    const mail = calls.resend[0].body;
    assert.match(mail.subject, re);
    assert.ok(!/Eve|Secretname|Subjectmarker|marker/.test(mail.html + mail.text), lang);
    assert.equal(mail.headers['Auto-Submitted'], 'auto-generated');
  }
});

test('confirming delivers the message once: owner notification with Reply-To, then a localized acknowledgment', async () => {
  const env = makeEnv();
  const { token } = await submit(env);
  const pending = [];
  const res = await verify(env, token, { waitUntil: (p) => pending.push(p) });
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true });
  await Promise.all(pending);
  assert.deepEqual(kinds(), ['verify', 'owner', 'ack']);
  const [, owner, ack] = calls.resend.map((c) => c.body);
  assert.deepEqual(owner.to, ['owner@example.test']);
  assert.equal(owner.reply_to, 'ada@example.org');
  assert.match(owner.text, /A short test message\./);
  assert.match(owner.text, /confirmed by link/);
  assert.deepEqual(ack.to, ['ada@example.org']);
  assert.equal(ack.reply_to, undefined);
  assert.match(ack.subject, /Vielen Dank/);
  assert.ok(ack.text.startsWith('*** ') && ack.html.indexOf('font-weight:bold') < ack.html.indexOf('<p>'));
  assert.equal(rows(env, 'SELECT * FROM pending').length, 0, 'the message is gone from storage once delivered');
});

test('a link works once: reuse, and two simultaneous clicks, deliver a single message', async () => {
  const env = makeEnv();
  const { token } = await submit(env);
  const [a, b] = await Promise.all([verify(env, token), verify(env, token)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  const lost = a.status === 400 ? a : b;
  assert.equal((await body(lost)).code, 'invalid_token');
  assert.equal(kinds().filter((k) => k === 'owner').length, 1);
  const again = await verify(env, token);
  assert.equal(again.status, 400);
  assert.equal(kinds().filter((k) => k === 'owner').length, 1);
});

test('an expired link delivers nothing; expired rows and counters are purged', async () => {
  const env = makeEnv();
  const { token } = await submit(env);
  assert.equal(rows(env, 'SELECT expires_at - last_sent AS ttl FROM pending')[0].ttl, 900, 'valid for 15 minutes');
  env.DB.raw.exec('UPDATE pending SET expires_at = expires_at - 901');
  const res = await verify(env, token);
  assert.equal(res.status, 400);
  assert.equal((await body(res)).code, 'invalid_token');
  assert.deepEqual(kinds(), ['verify']);
  assert.equal(rows(env, 'SELECT * FROM pending').length, 1, 'still stored until the purge runs');
  env.DB.raw.exec('UPDATE counters SET expires_at = 1');
  await purge(env);
  assert.equal(rows(env, 'SELECT * FROM pending').length, 0);
  assert.equal(rows(env, 'SELECT * FROM counters').length, 0);
  // The hourly cron trigger runs the same purge.
  await submit(env, { email: 'x@example.org' });
  env.DB.raw.exec('UPDATE pending SET expires_at = 1');
  const jobs = [];
  worker.scheduled({}, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
  assert.equal(rows(env, 'SELECT * FROM pending').length, 0);
});

test('guessed, malformed or foreign tokens deliver nothing', async () => {
  const env = makeEnv();
  const { b } = await submit(env);
  const before = calls.resend.length;
  for (const token of [undefined, null, 5, '', 'short', 'A'.repeat(43), 'A'.repeat(44), 'bad token with spaces and symbols!!!!!!!!!!!', b.resend, ['x']]) {
    const res = await handle(req('/contact/verify', token === undefined ? {} : { token }), env);
    assert.equal(res.status, 400, String(token));
    assert.equal((await body(res)).code, 'invalid_token');
  }
  assert.equal((await handle(req('/contact/verify', null, { raw: '[1]' }), env)).status, 400);
  assert.equal((await handle(req('/contact/verify', null, { raw: 'nope' }), env)).status, 400);
  assert.equal((await handle(req('/contact/verify', {}, { type: 'text/plain' }), env)).status, 415);
  assert.equal(calls.resend.length, before);
});

test('only digests of the tokens are stored, and the confirmed message is the one stored for that token', async () => {
  const env = makeEnv();
  const one = await submit(env, { email: 'one@example.org', message: 'Message of the first visitor.' });
  const two = await submit(env, { email: 'two@example.org', message: 'Message of the second visitor.' });
  const dump = JSON.stringify(rows(env, 'SELECT * FROM pending')) + JSON.stringify(rows(env, 'SELECT * FROM counters'));
  for (const s of [one.token, two.token, one.b.resend, two.b.resend]) assert.ok(!dump.includes(s), 'no plain token in storage');
  assert.ok(!JSON.stringify(rows(env, 'SELECT * FROM counters')).match(/@|visitor/), 'counters hold no address or text');
  await verify(env, two.token);
  const owner = calls.resend.map((c) => c.body).find((m) => m.reply_to);
  assert.equal(owner.reply_to, 'two@example.org');
  assert.match(owner.text, /second visitor/);
  assert.ok(!owner.text.includes('first visitor'));
  assert.equal(rows(env, 'SELECT email FROM pending')[0].email, 'one@example.org', 'the other message is untouched');
});

test('a failed owner notification keeps the message: the same link can be used again', async () => {
  const env = makeEnv();
  const { token } = await submit(env);
  mocks.resendStatus = [200, 500];
  assert.equal((await verify(env, token)).status, 502);
  assert.equal(rows(env, 'SELECT used FROM pending')[0].used, 0);
  mocks.resendStatus = [];
  const res = await verify(env, token, { waitUntil: () => {} });
  assert.equal(res.status, 200);
  assert.equal(rows(env, 'SELECT * FROM pending').length, 0);
});

test('a second submission for an address with a live pending message changes nothing, sends no mail and looks like a normal answer', async () => {
  const env = makeEnv();
  const first = await submit(env, { message: 'The first version of my message.' });
  const before = JSON.stringify(rows(env, 'SELECT * FROM pending'));
  const countersBefore = JSON.stringify(rows(env, 'SELECT key, n FROM counters ORDER BY key'));
  const second = await submit(env, { message: 'The second version of my message.' });
  assert.equal(second.res.status, 200);
  assert.deepEqual(Object.keys(second.b).sort(), Object.keys(first.b).sort(), 'same answer shape as a fresh submission');
  assert.notEqual(second.b.resend, first.b.resend);
  assert.equal(calls.resend.length, 1, 'no second mail');
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM pending')), before, 'the pending row is untouched');
  const spent = (sql) => JSON.stringify(rows(env, sql));
  assert.equal(spent("SELECT key, n FROM counters WHERE key LIKE 'addrv:%' OR key LIKE 'verifyday:%' ORDER BY key"), JSON.stringify(JSON.parse(countersBefore).filter((c) => /^(addrv|verifyday):/.test(c.key))), 'address and daily counters are not spent');
  assert.ok(rows(env, "SELECT n FROM counters WHERE key LIKE 'ipv:%'")[0].n === 2, 'the client counter is spent, as for a real submission');
  assert.equal((await resendLink(env, second.b.resend)).status, 400, 'the made-up secret does nothing');
  assert.equal((await verify(env, first.token, { waitUntil: () => {} })).status, 200, 'the first link still works');
  assert.match(calls.resend.map((c) => c.body).find((m) => m.reply_to).text, /first version/);
});

test('once the pending message has expired, a new submission replaces it', async () => {
  const env = makeEnv();
  const first = await submit(env, { message: 'The first version of my message.' });
  env.DB.raw.exec('UPDATE pending SET expires_at = 1');
  const second = await submit(env, { message: 'The second version of my message.' });
  assert.ok(second.token);
  assert.equal(rows(env, 'SELECT * FROM pending').length, 1);
  assert.equal((await verify(env, first.token)).status, 400);
  assert.equal((await verify(env, second.token, { waitUntil: () => {} })).status, 200);
  assert.match(calls.resend.map((c) => c.body).find((m) => m.reply_to).text, /second version/);
});

test('stored hashes depend on the pepper secret', async () => {
  const a = makeEnv({ DIGEST_PEPPER: 'a'.repeat(40) });
  const b = makeEnv({ DIGEST_PEPPER: 'b'.repeat(40) });
  await submit(a);
  await submit(b);
  const hash = (env) => rows(env, 'SELECT email_hash FROM pending')[0].email_hash;
  assert.match(hash(a), /^[0-9a-f]{64}$/);
  assert.notEqual(hash(a), hash(b));
});

test('a claimed message is locked for 60 seconds, then the same link can be used again (Worker died before delivery)', async () => {
  const env = makeEnv();
  const { token } = await submit(env);
  const now = Math.floor(Date.now() / 1000);
  env.DB.raw.prepare('UPDATE pending SET used = ?').run(now - 5);
  assert.equal((await verify(env, token)).status, 400, 'still locked');
  env.DB.raw.prepare('UPDATE pending SET used = ?').run(now - 120);
  assert.equal((await verify(env, token, { waitUntil: () => {} })).status, 200, 'lease expired');
  assert.equal(rows(env, 'SELECT * FROM pending').length, 0);
});

test('new link: 60 seconds apart, at most three mails per message, the old link stops working', async () => {
  const env = makeEnv();
  const { b, token } = await submit(env);
  let res = await resendLink(env, b.resend);
  assert.equal(res.status, 429);
  assert.equal((await body(res)).code, 'rate_limited', 'too soon');
  const age = () => env.DB.raw.exec('UPDATE pending SET last_sent = last_sent - 61');
  age();
  res = await resendLink(env, b.resend);
  assert.equal(res.status, 200);
  const second = tokenIn(calls.resend[calls.resend.length - 1]);
  assert.notEqual(second, token);
  assert.equal((await verify(env, token)).status, 400, 'old link is dead');
  age();
  assert.equal((await resendLink(env, b.resend)).status, 200);
  age();
  res = await resendLink(env, b.resend);
  assert.equal(res.status, 429);
  assert.equal((await body(res)).code, 'resend_limit');
  assert.equal(calls.resend.length, 3);
  assert.equal((await verify(env, second)).status, 400, 'the second link was replaced by the third');
  const third = tokenIn(calls.resend[2]);
  assert.equal((await verify(env, third, { waitUntil: () => {} })).status, 200);
});

test('new link: unknown or malformed secret, expired message, failed mail', async () => {
  const env = makeEnv();
  const { b, token } = await submit(env);
  for (const resend of [undefined, '', 'x', 'A'.repeat(43), token]) {
    const res = await handle(req('/contact/resend', resend === undefined ? {} : { resend }), env);
    assert.equal(res.status, 400, String(resend));
    assert.equal((await body(res)).code, 'invalid_token');
  }
  assert.equal(calls.resend.length, 1);
  env.DB.raw.exec('UPDATE pending SET last_sent = last_sent - 61');
  mocks.resendStatus = [200, 500];
  assert.equal((await resendLink(env, b.resend)).status, 502);
  assert.equal(rows(env, 'SELECT mails FROM pending')[0].mails, 1, 'a failed mail does not count');
  assert.equal((await verify(env, token, { waitUntil: () => {} })).status, 200, 'the old link still works after a failed new one');
  const e2 = makeEnv();
  const s2 = await submit(e2, { email: 'late@example.org' });
  e2.DB.raw.exec('UPDATE pending SET expires_at = 1, last_sent = 1');
  assert.equal((await resendLink(e2, s2.b.resend)).status, 400);
});

test('confirmation mails per address are limited to 5 per day; over the limit the answer looks like success and nothing is sent', async () => {
  const env = makeEnv();
  const from = (i) => ({ headers: { 'CF-Connecting-IP': `198.51.${100 + i}.1` } }); // different networks, so the client and network caps do not interfere
  const expire = () => env.DB.raw.exec('UPDATE pending SET expires_at = 1'); // a live pending message would block the next submission
  for (let i = 0; i < 5; i++) { assert.equal((await handle(post(good({ message: `Message number ${i} here.` }), from(i)), env)).status, 200); expire(); }
  const fresh = await body(await handle(post(good({ email: 'fresh@example.org' }), from(6)), env));
  const res = await handle(post(good({ message: 'Message number six here.' }), from(5)), env);
  assert.equal(res.status, 200);
  const b = await body(res);
  assert.deepEqual(Object.keys(b).sort(), Object.keys(fresh).sort(), 'same answer shape as a real submission');
  assert.match(b.resend, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(calls.resend.length, 6, 'no mail for the address over its limit');
  assert.equal(rows(env, "SELECT n FROM counters WHERE key LIKE 'addrv:%' ORDER BY n DESC")[0].n, 5);
  assert.equal((await resendLink(env, b.resend)).status, 400, 'the made-up secret does nothing');
  assert.equal((await handle(post(good({ email: 'other@example.org' })), env)).status, 200, 'other addresses are not affected');
});

test('daily caps: confirmation mails (checked before Siteverify), delivered messages, acknowledgments', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const setCounter = (env, key, n) => env.DB.raw.prepare('INSERT INTO counters VALUES (?, ?, ?)').run(key, n, Math.floor(Date.now() / 1000) + 3600);
  let env = makeEnv();
  setCounter(env, 'verifyday:' + day, 40);
  let res = await handle(post(good()), env);
  assert.equal(res.status, 429);
  assert.equal((await body(res)).code, 'rate_limited');
  assert.equal(calls.siteverify.length, 0, 'the token was not used up');
  assert.equal(calls.resend.length, 0);

  beforeEachMocks();
  env = makeEnv();
  const { token } = await submit(env);
  setCounter(env, 'ownerday:' + day, 30);
  res = await verify(env, token);
  assert.equal(res.status, 429);
  assert.equal(rows(env, 'SELECT used FROM pending')[0].used, 0, 'the message stays pending, not consumed');
  env.DB.raw.exec("DELETE FROM counters WHERE key LIKE 'ownerday:%'");
  const okJobs = [];
  assert.equal((await verify(env, token, { waitUntil: (p) => okJobs.push(p) })).status, 200, 'works once the cap allows it');
  await Promise.all(okJobs);

  beforeEachMocks();
  env = makeEnv();
  setCounter(env, 'ackday:' + day, 30);
  const s = await submit(env);
  const jobs = [];
  await verify(env, s.token, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
  assert.deepEqual(kinds(), ['verify', 'owner'], 'cap reached: the owner is still notified, no acknowledgment');
});

test('acknowledgment: one per address per 24 hours; a failed one frees the address again', async () => {
  const env = makeEnv();
  const run = async (over) => {
    const s = await submit(env, over);
    const jobs = [];
    await verify(env, s.token, { waitUntil: (p) => jobs.push(p) });
    await Promise.all(jobs);
  };
  await run({ message: 'First message text here.' });
  assert.deepEqual(kinds(), ['verify', 'owner', 'ack']);
  calls.resend.length = 0;
  await run({ message: 'A different second message.' });
  assert.deepEqual(kinds(), ['verify', 'owner'], 'delivered, but no second acknowledgment within 24 hours');
  calls.resend.length = 0;
  await run({ email: 'grace@example.org', message: 'Third message from someone else.' });
  assert.deepEqual(kinds(), ['verify', 'owner', 'ack']);

  beforeEachMocks();
  const e2 = makeEnv();
  mocks.resendStatus = [200, 200, 500];
  const s = await submit(e2);
  const jobs = [];
  assert.equal((await verify(e2, s.token, { waitUntil: (p) => jobs.push(p) })).status, 200, 'a failed acknowledgment does not fail the confirmation');
  await Promise.all(jobs);
  assert.equal(rows(e2, "SELECT n FROM counters WHERE key LIKE 'ack:%'")[0].n, 0, 'the reply slot was released');
});

test('the acknowledgment runs in the background: the answer does not wait for it', async () => {
  const env = makeEnv();
  const { token } = await submit(env);
  let release;
  mocks.resendGate = []; mocks.resendGate[2] = new Promise((r) => { release = r; }); // third Resend call (the acknowledgment)
  const pending = [];
  const res = await Promise.race([verify(env, token, { waitUntil: (p) => pending.push(p) }), new Promise((_, rej) => setTimeout(() => rej(new Error('waited for the acknowledgment')), 1500))]);
  assert.equal(res.status, 200);
  assert.equal(pending.length, 2, 'purge and acknowledgment');
  release();
  await Promise.all(pending);
  assert.deepEqual(kinds(), ['verify', 'owner', 'ack']);
});

test('Siteverify gets secret, token and IP; wrong hostname, failure or wrong action stores and sends nothing', async () => {
  const env = makeEnv();
  let res = await handle(post(good()), env);
  assert.equal(res.status, 200);
  const form = calls.siteverify[0];
  assert.equal(form.get('secret'), 'test-turnstile-secret');
  assert.equal(form.get('response'), 'tok');
  assert.equal(form.get('remoteip'), '203.0.113.7');

  const cases = [
    ['wrong hostname', () => { mocks.siteverify = { success: true, hostname: 'evil.example', action: 'contact' }; }, 400],
    ['rejected', () => { mocks.siteverify = { success: false, 'error-codes': ['invalid-input-response'] }; }, 400],
    ['HTTP 500', () => { mocks.siteverifyStatus = 500; }, 502],
    ['unreachable', () => { mocks.siteverifyThrow = true; }, 502],
    ['not JSON', () => { mocks.siteverifyRaw = '<html>oops</html>'; }, 502],
    ['no hostname', () => { mocks.siteverify = { success: true, action: 'contact' }; }, 400],
    ['empty hostname', () => { mocks.siteverify = { success: true, hostname: '', action: 'contact' }; }, 400],
    ['test-key hostname', () => { mocks.siteverify = { success: true, hostname: 'example.com', action: 'contact' }; }, 400],
    ['lookalike hostname', () => { mocks.siteverify = { success: true, hostname: 'nuray.io.evil.example', action: 'contact' }; }, 400],
    ['hostname not a string', () => { mocks.siteverify = { success: true, hostname: ['nuray.io'], action: 'contact' }; }, 400],
    ['success as string', () => { mocks.siteverify = { success: 'true', hostname: 'nuray.io', action: 'contact' }; }, 400],
    ['other action', () => { mocks.siteverify = { success: true, hostname: 'nuray.io', action: 'other' }; }, 400],
    ['no action', () => { mocks.siteverify = { success: true, hostname: 'nuray.io' }; }, 400],
  ];
  for (const [label, setup, status] of cases) {
    beforeEachMocks();
    setup();
    const e = makeEnv();
    res = await handle(post(good()), e);
    assert.equal(res.status, status, label);
    assert.equal(calls.siteverify.length, 1, label);
    assert.equal(calls.resend.length, 0, label + ': no mail');
    assert.equal(rows(e, 'SELECT * FROM pending').length, 0, label + ': nothing stored');
  }
});

test('no Turnstile token, no storage and no mail: a missing, empty, blank, wrong-type or oversized token is refused before Siteverify', async () => {
  for (const token of [undefined, '', '   ', null, 0, 123, true, {}, [], 't'.repeat(2049)]) {
    const input = good();
    if (token === undefined) delete input.token; else input.token = token;
    const env = makeEnv();
    const res = await handle(post(input), env);
    const b = await body(res);
    assert.equal(res.status, 400, String(token).slice(0, 20));
    assert.equal(b.code, 'validation');
    assert.ok(b.fields.includes('token'));
    assert.equal(rows(env, 'SELECT * FROM pending').length, 0);
  }
  assert.equal(calls.siteverify.length, 0);
  assert.equal(calls.resend.length, 0);
});

test('TURNSTILE_HOSTNAMES: blank entries are ignored, an empty list falls back to the defaults, www is accepted', async () => {
  const run = async (hostname, list) => { beforeEachMocks(); mocks.siteverify = { success: true, hostname, action: 'contact' }; return (await handle(post(good()), makeEnv({ TURNSTILE_HOSTNAMES: list }))).status; };
  assert.equal(await run('www.nuray.io', 'nuray.io, ,www.nuray.io,'), 200);
  assert.equal(await run('NURAY.IO', undefined), 200);
  assert.equal(await run('', 'nuray.io,'), 400);
  assert.equal(await run('nuray.io', ' , '), 200);
  assert.equal(await run('evil.example', ' , '), 400);
});

test('validation: content type, size, JSON, fields, language, length limits', async () => {
  const env = makeEnv();
  assert.equal((await handle(post(good(), { type: 'text/plain' }), env)).status, 415);
  assert.equal((await handle(post(null, { raw: '{not json' }), env)).status, 400);
  assert.equal((await handle(post(null, { raw: JSON.stringify(good({ message: 'x'.repeat(9000) })) }), env)).status, 413);
  const cases = [
    [{ name: '' }, 'name'], [{ name: 'n'.repeat(81) }, 'name'], [{ name: 'A' }, 'name'], [{ name: 'x7#%&' }, 'name'], [{ name: 'Aaaaaaaa' }, 'name'], [{ name: '12345' }, 'name'], [{ email: 'not-an-email' }, 'email'], [{ email: 'a@b' }, 'email'],
    [{ email: 'a b@example.org' }, 'email'], [{ email: 'a..b@example.org' }, 'email'], [{ subject: 's'.repeat(151) }, 'subject'],
    [{ message: 'hi' }, 'message'], [{ message: 'too short' }, 'message'], [{ message: 'Hello!!!!!!!! there' }, 'message'], [{ message: 'x'.repeat(61) }, 'message'], [{ message: 'see http://a.example http://b.example http://c.example' }, 'message'], [{ message: 'm'.repeat(3001) }, 'message'], [{ lang: 'fr' }, 'lang'], [{ token: '' }, 'token'],
    [{ name: 42 }, 'name'],
  ];
  for (const [over, field] of cases) {
    const res = await handle(post(good(over)), env);
    const b = await body(res);
    assert.equal(res.status, 400, JSON.stringify(over).slice(0, 40));
    assert.equal(b.code, 'validation');
    assert.ok(b.fields.includes(field), `${field} in ${b.fields}`);
  }
  assert.equal(calls.resend.length, 0);
  assert.equal(rows(env, 'SELECT * FROM pending').length, 0);
});

test('validation accepts genuine international names, links and punctuation', async () => {
  for (const over of [{ name: 'Önder Nuray' }, { name: "Jean-Luc O'Brien-Müller" }, { name: 'Zeynep Çelik Şahin' }, { name: 'Dr. Ana María' }, { message: 'Please see https://example.org/a and www.example.org... thanks!!' }, { email: 'a.b+c@sub.example.co' }]) {
    const res = await handle(post(good(over)), makeEnv());
    assert.equal(res.status, 200, JSON.stringify(over));
  }
});

test('honeypot returns success without storing or sending anything, and without a resend secret', async () => {
  const env = makeEnv();
  const res = await handle(post(good({ website: 'http://spam.example' })), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true, pending: true });
  assert.equal(calls.siteverify.length + calls.resend.length, 0);
  assert.equal(rows(env, 'SELECT * FROM pending').length, 0);
});

test('minimum fill time and implausible timestamps are rejected; the monotonic elapsedMs is preferred', async () => {
  for (const startedAt of [Date.now() - 500, Date.now() + 60000, Date.now() - 3 * 24 * 3600 * 1000, 'x', undefined]) {
    const res = await handle(post(good({ startedAt })), makeEnv());
    assert.equal((await body(res)).code, 'too_fast');
  }
  const status = async (over) => { beforeEachMocks(); return (await handle(post(good(over)), makeEnv())).status; };
  assert.equal(await status({ startedAt: Date.now() + 10 * 60 * 1000, elapsedMs: 8000 }), 200);
  assert.equal(await status({ startedAt: Date.now() - 3 * 24 * 3600 * 1000, elapsedMs: 8000 }), 200);
  assert.equal(await status({ startedAt: Date.now() - 10000, elapsedMs: 3 * 24 * 3600 * 1000 }), 200);
  assert.equal(await status({ startedAt: Date.now() - 10000, elapsedMs: 500 }), 400);
  assert.equal(await status({ startedAt: Date.now() - 10000, elapsedMs: -5 }), 400);
  assert.equal(await status({ startedAt: Date.now() - 10000, elapsedMs: '9000' }), 200);
  assert.equal(await status({ startedAt: undefined, elapsedMs: undefined }), 400);
});

test('rate limiter denial returns 429 on every endpoint; limiter error fails closed', async () => {
  const denied = makeEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } });
  for (const path of ['/contact', '/contact/verify', '/contact/resend']) assert.equal((await handle(req(path, good()), denied)).status, 429, path);
  const broken = makeEnv({ RATE_LIMITER: { limit: async () => { throw new Error('x'); } } });
  assert.equal((await handle(post(good()), broken)).status, 500);
  assert.equal(calls.resend.length, 0);
});

test('the three endpoints use separate rate-limit keys, and an IPv6 client is limited by its /64', async () => {
  assert.equal(rateKey('203.0.113.7'), '203.0.113.7');
  assert.equal(rateKey('2001:db8:1:2:3:4:5:6'), rateKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
  assert.equal(rateKey('2001:db8:1:2::9'), rateKey('2001:0db8:0001:0002:0:0:0:1'));
  assert.notEqual(rateKey('2001:db8:1:2::9'), rateKey('2001:db8:1:3::9'));
  assert.equal(rateKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(rateKey('::1'), rateKey('0:0:0:0:5:6:7:8'));
  assert.equal(rateKey('fe80::1%eth0'), rateKey('fe80::2'));
  assert.equal(rateKey(''), 'unknown');
  assert.equal(rateKey('1::2::3'), '1::2::3');
  const keys = [];
  const env = makeEnv({ RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: true }; } } });
  await handle(post(good(), { headers: { 'CF-Connecting-IP': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' } }), env);
  await handle(req('/contact/verify', { token: 'x' }, { headers: { 'CF-Connecting-IP': '2001:db8:1:2::1' } }), env);
  await handle(req('/contact/resend', { resend: 'x' }, { headers: { 'CF-Connecting-IP': '2001:db8:1:2::1' } }), env);
  assert.deepEqual(keys.map((k) => k.split(':')[0]), ['contact', 'verify', 'resend']);
  assert.equal(new Set(keys.map((k) => k.split(/^[a-z]+:/)[1])).size, 1, 'same /64, same client part');
});

test('a failing confirmation mail leaves nothing stored and frees the counters, so the visitor can retry', async () => {
  const env = makeEnv();
  mocks.resendStatus = [500];
  assert.equal((await handle(post(good()), env)).status, 502);
  assert.equal(rows(env, 'SELECT * FROM pending').length, 0);
  assert.ok(rows(env, 'SELECT n FROM counters').every((r) => r.n === 0));
  assert.equal((await handle(post(good()), env)).status, 200);
});

test('a D1 outage fails closed: error, no mail, no delivery', async () => {
  const env = makeEnv({ DB: makeD1({ failOn: /./ }) });
  assert.equal((await handle(post(good()), env)).status, 500);
  assert.equal((await verify(env, 'A'.repeat(43))).status, 500);
  assert.equal((await resendLink(env, 'A'.repeat(43))).status, 500);
  assert.equal(calls.resend.length, 0);
});

test('misconfiguration returns a generic 500 and names no secret in the response', async () => {
  for (const missing of ['RESEND_API_KEY', 'TURNSTILE_SECRET_KEY', 'DIGEST_PEPPER', 'CONTACT_RECIPIENT', 'RATE_LIMITER', 'DB']) {
    for (const path of ['/contact', '/contact/verify', '/contact/resend']) {
      const res = await handle(req(path, good()), makeEnv({ [missing]: undefined }));
      assert.equal(res.status, 500, `${missing} ${path}`);
      assert.equal(JSON.stringify(await body(res)), '{"ok":false,"code":"server_error"}');
    }
  }
  for (const MAIL_FROM of ['someone@example.com', 'nuray.io <hello@nuray.io>', '']) {
    assert.equal((await handle(post(good()), makeEnv({ MAIL_FROM }))).status, 500);
  }
  assert.equal((await handle(post(good()), makeEnv({ CONTACT_RECIPIENT: 'not-an-address' }))).status, 500);
  assert.equal(calls.resend.length, 0);
});

test('HTML email escapes user content; header fields lose line breaks', async () => {
  const env = makeEnv();
  const evil = '<script>alert(1)</script> & "quoted"';
  const { token } = await submit(env, { name: 'Eve\r\nAdams', subject: `Hi\r\nBcc: y@example.test ${evil}`, message: `Body ${evil}` });
  await verify(env, token, { waitUntil: () => {} });
  const owner = calls.resend.map((c) => c.body).find((m) => m.reply_to);
  assert.ok(!owner.html.includes('<script>'));
  assert.ok(owner.html.includes('&lt;script&gt;'));
  assert.ok(owner.html.includes('&amp;'));
  assert.ok(!/[\r\n]/.test(owner.subject));
});

test('VERIFY_BASE_URL is ignored unless it points to a local page', () => {
  for (const bad of ['https://evil.example/verify.html', 'http://evil.example/', 'https://localhost.evil.example/', 'http://user:pw@localhost/', 'javascript:alert(1)', 'not a url', 'https://localhost:4173/verify.html']) {
    assert.equal(verifyBase({ VERIFY_BASE_URL: bad }), 'https://nuray.io/verify.html', bad);
  }
  assert.equal(verifyBase({}), 'https://nuray.io/verify.html');
  assert.equal(verifyBase({ VERIFY_BASE_URL: 'http://127.0.0.1:4173/verify.html' }), 'http://127.0.0.1:4173/verify.html');
});

test('a production-looking VERIFY_BASE_URL cannot redirect the confirmation link', async () => {
  await handle(post(good({ lang: 'en' })), makeEnv({ VERIFY_BASE_URL: 'https://evil.example/verify.html' }));
  assert.match(calls.resend[0].body.text, /https:\/\/nuray\.io\/verify\.html\?lang=en#t=[A-Za-z0-9_-]{43}/);
  assert.ok(!calls.resend[0].body.text.includes('evil.example'));
});

test('per-network cap: IPv4 /24 and IPv6 /48 share 6 confirmation mails per 24 hours', async () => {
  assert.equal(subnetKey('203.0.113.7'), '203.0.113.0/24');
  assert.equal(subnetKey('::ffff:203.0.113.9'), '203.0.113.0/24');
  assert.equal(subnetKey('2001:db8:1:2:3::4'), '2001:0db8:0001::/48');
  assert.equal(subnetKey('2001:db8:1:ffff::1'), '2001:0db8:0001::/48');
  const env = makeEnv();
  const at = (i) => ({ headers: { 'CF-Connecting-IP': `203.0.113.${10 + i}` } }); // one network, different clients
  for (let i = 0; i < 6; i++) assert.equal((await handle(post(good({ email: `n${i}@example.org` }), at(i)), env)).status, 200, String(i));
  const res = await handle(post(good({ email: 'n6@example.org' }), at(6)), env);
  assert.equal(res.status, 429);
  assert.equal((await body(res)).code, 'rate_limited');
  assert.equal(calls.resend.length, 6);
  assert.equal((await handle(post(good({ email: 'n7@example.org' }), { headers: { 'CF-Connecting-IP': '198.51.100.1' } }), env)).status, 200, 'other networks are not affected');
});

test('verification link base can be overridden for local development; the token stays in the fragment', async () => {
  await handle(post(good({ lang: 'en' })), makeEnv({ VERIFY_BASE_URL: 'http://localhost:4173/verify.html?contactDev=1' }));
  const url = calls.resend[0].body.text.match(/http:\/\/localhost\S+/)[0];
  const u = new URL(url);
  assert.equal(u.searchParams.get('contactDev'), '1');
  assert.equal(u.searchParams.get('lang'), 'en');
  assert.match(u.hash, /^#t=[A-Za-z0-9_-]{43}$/);
  assert.ok(!u.search.includes('t='));
});

test('no secrets, tokens, addresses or message text are logged', async () => {
  const logged = [];
  const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    mocks.resendStatus = [500];
    await handle(post(good({ message: 'private message text' })), makeEnv());
    mocks.siteverifyStatus = 500;
    await handle(post(good()), makeEnv());
    await handle(post(good()), makeEnv({ RESEND_API_KEY: undefined }));
    await handle(post(good()), makeEnv({ DB: makeD1({ failOn: /./ }) }));
    beforeEachMocks();
    const env = makeEnv();
    const { token } = await submit(env);
    mocks.resendStatus = [200, 500];
    await verify(env, token);
  } finally { console.error = orig; }
  const all = logged.join('\n');
  assert.ok(logged.length > 0);
  for (const s of ['test-resend-key', 'test-turnstile-secret', 'private message text', 'ada@example.org', 'owner@example.test']) assert.ok(!all.includes(s), s);
  assert.ok(!/[A-Za-z0-9_-]{43}/.test(all), 'no token in the log');
});

test('helpers', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(clean('a\u0000b\r\nc'), 'a b c');
  assert.equal(clean('l1\r\nl2\u0007', { multiline: true }), 'l1\nl2');
});

test('one client may start only 3 confirmation mails per day; other clients are not affected', async () => {
  const env = makeEnv();
  for (let i = 0; i < 3; i++) assert.equal((await handle(post(good({ email: `c${i}@example.org` })), env)).status, 200);
  const res = await handle(post(good({ email: 'c3@example.org' })), env);
  assert.equal(res.status, 429);
  assert.equal((await body(res)).code, 'rate_limited');
  assert.equal(calls.resend.length, 3);
  assert.equal((await handle(post(good({ email: 'd@example.org' }), { headers: { 'CF-Connecting-IP': '203.0.113.99' } }), env)).status, 200);
});
test('an unknown token on /contact/verify writes no counter rows', async () => {
  const env = makeEnv();
  const res = await verify(env, 'A'.repeat(43), { waitUntil: () => {} });
  assert.equal(res.status, 400);
  assert.equal(rows(env, 'SELECT * FROM counters').length, 0);
});
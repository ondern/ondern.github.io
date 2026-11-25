// Worker tests with mocked Turnstile Siteverify, Resend and rate limiter. No real network or email.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, escapeHtml, clean } from '../src/index.js';

const ORIGIN = 'https://nuray.io';
const realFetch = globalThis.fetch;
let calls;
let mocks;

function makeEnv(over = {}) {
  return {
    RESEND_API_KEY: 'test-resend-key',
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    CONTACT_RECIPIENT: 'owner@example.test',
    MAIL_FROM: 'nuray.io <noreply@nuray.io>',
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...over,
  };
}

beforeEachMocks();
function beforeEachMocks() {
  calls = { siteverify: [], resend: [] };
  mocks = { siteverify: { success: true, hostname: 'nuray.io' }, siteverifyStatus: 200, resendStatus: [200, 200] };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('siteverify')) {
      calls.siteverify.push(init.body);
      return new Response(JSON.stringify(mocks.siteverify), { status: mocks.siteverifyStatus });
    }
    if (String(url).includes('api.resend.com')) {
      calls.resend.push({ headers: init.headers, body: JSON.parse(init.body) });
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
const post = (body, { origin = ORIGIN, type = 'application/json', raw, headers = {} } = {}) => new Request('https://api.nuray.io/contact', {
  method: 'POST', headers: { 'Content-Type': type, ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': '203.0.113.7', ...headers },
  body: raw ?? JSON.stringify(body),
});
const body = async (res) => res.json();

test('CORS preflight: allowed origins only', async () => {
  for (const o of ['https://nuray.io', 'https://www.nuray.io']) {
    const res = await handle(new Request('https://api.nuray.io/contact', { method: 'OPTIONS', headers: { Origin: o } }), makeEnv());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), o);
    assert.equal(res.headers.get('Vary'), 'Origin');
  }
  for (const o of ['https://evil.example', 'http://nuray.io', 'https://nuray.io.evil.example', '']) {
    const res = await handle(new Request('https://api.nuray.io/contact', { method: 'OPTIONS', headers: o ? { Origin: o } : {} }), makeEnv());
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('POST from a disallowed or missing origin is rejected before any work', async () => {
  for (const origin of ['https://evil.example', null]) {
    const res = await handle(post(good(), { origin }), makeEnv());
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(calls.siteverify.length + calls.resend.length, 0);
});

test('unknown path 404, other methods 405', async () => {
  assert.equal((await handle(new Request('https://api.nuray.io/other', { method: 'POST' }), makeEnv())).status, 404);
  assert.equal((await handle(new Request('https://api.nuray.io/contact', { method: 'GET', headers: { Origin: ORIGIN } }), makeEnv())).status, 405);
});

test('happy path: notification with Reply-To, then localized acknowledgment', async () => {
  const env = makeEnv();
  const res = await handle(post(good()), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(calls.resend.length, 2);
  const [owner, ack] = calls.resend.map((c) => c.body);
  assert.equal(owner.from, 'nuray.io <noreply@nuray.io>');
  assert.deepEqual(owner.to, ['owner@example.test']);
  assert.equal(owner.reply_to, 'ada@example.org');
  assert.match(owner.text, /A short test message\./);
  assert.deepEqual(ack.to, ['ada@example.org']);
  assert.equal(ack.from, 'nuray.io <noreply@nuray.io>');
  assert.match(ack.subject, /Vielen Dank/);
  assert.ok(ack.html && ack.text);
  assert.equal(calls.resend[0].headers.Authorization, 'Bearer test-resend-key');
});

test('acknowledgment follows the form language (tr, en)', async () => {
  for (const [lang, re] of [['tr', /teşekkür/], ['en', /Thank you/]]) {
    beforeEachMocks();
    await handle(post(good({ lang, message: `Message in ${lang} language` })), makeEnv());
    assert.match(calls.resend[1].body.subject, re);
  }
});

test('Siteverify gets secret, token and IP; wrong hostname or failure is rejected', async () => {
  let res = await handle(post(good()), makeEnv());
  assert.equal(res.status, 200);
  const form = calls.siteverify[0];
  assert.equal(form.get('secret'), 'test-turnstile-secret');
  assert.equal(form.get('response'), 'tok');
  assert.equal(form.get('remoteip'), '203.0.113.7');

  beforeEachMocks(); mocks.siteverify = { success: true, hostname: 'evil.example' };
  res = await handle(post(good()), makeEnv());
  assert.equal(res.status, 400); assert.equal((await body(res)).code, 'captcha_failed');

  beforeEachMocks(); mocks.siteverify = { success: false, 'error-codes': ['invalid-input-response'] };
  res = await handle(post(good()), makeEnv());
  assert.equal((await body(res)).code, 'captcha_failed');
  assert.equal(calls.resend.length, 0);

  beforeEachMocks(); mocks.siteverifyStatus = 500;
  res = await handle(post(good()), makeEnv());
  assert.equal(res.status, 502);
  assert.equal(calls.resend.length, 0);
});

test('validation: content type, size, JSON, fields, language, length limits', async () => {
  const env = makeEnv();
  assert.equal((await handle(post(good(), { type: 'text/plain' }), env)).status, 415);
  assert.equal((await handle(post(null, { raw: '{not json' }), env)).status, 400);
  assert.equal((await handle(post(null, { raw: JSON.stringify(good({ message: 'x'.repeat(9000) })) }), env)).status, 413);
  const cases = [
    [{ name: '' }, 'name'], [{ name: 'n'.repeat(101) }, 'name'], [{ email: 'not-an-email' }, 'email'], [{ email: 'a@b' }, 'email'],
    [{ email: 'a b@example.org' }, 'email'], [{ email: 'a..b@example.org' }, 'email'], [{ subject: 's'.repeat(151) }, 'subject'],
    [{ message: 'hi' }, 'message'], [{ message: 'm'.repeat(3001) }, 'message'], [{ lang: 'fr' }, 'lang'], [{ token: '' }, 'token'],
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
});

test('honeypot returns success without sending anything', async () => {
  const res = await handle(post(good({ website: 'http://spam.example' })), makeEnv());
  assert.equal(res.status, 200);
  assert.equal(calls.siteverify.length + calls.resend.length, 0);
});

test('minimum fill time and implausible timestamps are rejected', async () => {
  for (const startedAt of [Date.now() - 500, Date.now() + 60000, Date.now() - 3 * 24 * 3600 * 1000, 'x', undefined]) {
    const res = await handle(post(good({ startedAt })), makeEnv());
    assert.equal((await body(res)).code, 'too_fast');
  }
});

test('rate limiter denial returns 429; limiter error fails closed', async () => {
  let res = await handle(post(good()), makeEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } }));
  assert.equal(res.status, 429);
  res = await handle(post(good()), makeEnv({ RATE_LIMITER: { limit: async () => { throw new Error('x'); } } }));
  assert.equal(res.status, 500);
  assert.equal(calls.resend.length, 0);
});

test('owner notification failure: error, no acknowledgment, retry allowed', async () => {
  const env = makeEnv();
  mocks.resendStatus = [500];
  let res = await handle(post(good()), env);
  assert.equal(res.status, 502);
  assert.equal(calls.resend.length, 1, 'no acknowledgment after failed notification');
  mocks.resendStatus = [200, 200];
  calls.resend.length = 0;
  res = await handle(post(good()), env);
  assert.equal(res.status, 200);
  assert.equal(calls.resend.length, 2);
});

test('acknowledgment failure does not fail the request', async () => {
  mocks.resendStatus = [200, 500];
  const res = await handle(post(good()), makeEnv());
  assert.equal(res.status, 200);
});

test('misconfiguration returns a generic 500 and names no secret in the response', async () => {
  for (const missing of ['RESEND_API_KEY', 'TURNSTILE_SECRET_KEY', 'CONTACT_RECIPIENT', 'RATE_LIMITER']) {
    const res = await handle(post(good()), makeEnv({ [missing]: undefined }));
    assert.equal(res.status, 500);
    assert.equal(JSON.stringify(await body(res)), '{"ok":false,"code":"server_error"}');
  }
  for (const MAIL_FROM of ['someone@example.com', 'nuray.io <hello@nuray.io>', '']) {
    assert.equal((await handle(post(good()), makeEnv({ MAIL_FROM }))).status, 500);
  }
  assert.equal((await handle(post(good()), makeEnv({ CONTACT_RECIPIENT: 'not-an-address' }))).status, 500);
  assert.equal(calls.resend.length, 0);
});

test('HTML email escapes user content; header fields lose line breaks', async () => {
  const evil = '<script>alert(1)</script> & "quoted"';
  await handle(post(good({ name: `Eve\r\nBcc: x@example.test ${evil}`, subject: `Hi\r\nBcc: y@example.test`, message: `Body ${evil}` })), makeEnv());
  const owner = calls.resend[0].body;
  assert.ok(!owner.html.includes('<script>'));
  assert.ok(owner.html.includes('&lt;script&gt;'));
  assert.ok(owner.html.includes('&amp;'));
  assert.ok(!/[\r\n]/.test(owner.subject));
  // The acknowledgment no longer contains any visitor-supplied text.
  assert.ok(!/script|Eve|Bcc/.test(calls.resend[1].body.html + calls.resend[1].body.text));
  // The automated-message notice comes first, emphasized, in every language.
  const ack = calls.resend[1].body;
  assert.ok(ack.text.startsWith('*** ') && ack.html.indexOf('font-weight:bold') < ack.html.indexOf('<p>'));
});

test('no secrets, addresses or message text are logged', async () => {
  const logged = [];
  const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    mocks.resendStatus = [500];
    await handle(post(good({ message: 'private message text' })), makeEnv());
    mocks.siteverifyStatus = 500;
    await handle(post(good()), makeEnv());
    await handle(post(good()), makeEnv({ RESEND_API_KEY: undefined }));
  } finally { console.error = orig; }
  const all = logged.join('\n');
  assert.ok(logged.length > 0);
  for (const s of ['test-resend-key', 'test-turnstile-secret', 'private message text', 'ada@example.org', 'owner@example.test']) assert.ok(!all.includes(s), s);
});

test('helpers', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(clean('a\u0000b\r\nc'), 'a b c');
  assert.equal(clean('l1\r\nl2\u0007', { multiline: true }), 'l1\nl2');
});

test('a repeated submission is stopped by Turnstile (single-use token), not by stored state', async () => {
  const env = makeEnv();
  assert.equal((await handle(post(good()), env)).status, 200);
  const sent = calls.resend.length;
  mocks.siteverify = { success: false, 'error-codes': ['timeout-or-duplicate'] };
  const res = await handle(post(good()), env);
  assert.equal((await body(res)).code, 'captcha_failed');
  assert.equal(calls.resend.length, sent);
});

test('acknowledgment is sent from noreply without Reply-To; owner notification has Reply-To = visitor', async () => {
  await handle(post(good()), makeEnv());
  const [owner, ack] = calls.resend.map((c) => c.body);
  assert.equal(owner.reply_to, 'ada@example.org');
  assert.equal(ack.reply_to, undefined);
  assert.ok(ack.from.includes('noreply@nuray.io'));
});

// Local contact-form development: `npm run dev:contact`, then open http://localhost:4173/?contactDev=1
//
// This runs the REAL Worker code (worker/src/index.js) with MOCKED Turnstile Siteverify, Resend and rate limiter.
// Nothing leaves your machine except Cloudflare's own Turnstile test widget script, which the page loads.
// It proves the browser-to-Worker flow only. It does not prove real Turnstile verification or real email delivery.
import http from 'node:http';
process.env.CONTACT_DEV = '1'; // makes tests/serve.mjs add the local API origin to the page CSP (production files stay untouched)
await import('./serve.mjs');
const { handle } = await import('../worker/src/index.js');
const { makeD1 } = await import('../worker/test/d1-shim.mjs');

const PAGE_ORIGINS = ['http://localhost:4173', 'http://127.0.0.1:4173'];
const hits = new Map();
const env = {
  RESEND_API_KEY: 'mock', TURNSTILE_SECRET_KEY: 'mock', DIGEST_PEPPER: 'dev-only-pepper-0123456789abcdef0123456789', CONTACT_RECIPIENT: 'owner@example.test', MAIL_FROM: 'nuray.io <noreply@nuray.io>',
  DB: makeD1(), // in-memory SQLite stand-in for D1 (real SQL)
  VERIFY_BASE_URL: 'http://localhost:4173/verify.html?contactDev=1', // the confirmation link opens the local page
  RATE_LIMITER: { limit: async ({ key }) => { const now = Date.now(); const a = (hits.get(key) || []).filter((t) => now - t < 60000); a.push(now); hits.set(key, a); return { success: a.length <= 5 }; } },
};
// The Worker's outbound calls are replaced here. No request reaches Cloudflare or Resend.
globalThis.fetch = async (url, init) => {
  if (String(url).includes('siteverify')) { console.log('[MOCK] Turnstile Siteverify accepted any token (not a real verification)'); return new Response(JSON.stringify({ success: true, hostname: 'nuray.io' })); }
  if (new URL(String(url)).hostname === 'api.resend.com') {
    const body = JSON.parse(init.body);
    const link = (body.text.match(/https?:\/\/\S+#t=\S+/) || [])[0];
    console.log(link ? `[MOCK] Resend: would send the confirmation link (nothing is sent): ${link}` : `[MOCK] Resend: would send the ${body.reply_to ? 'owner notification' : 'acknowledgment'} (nothing is sent)`);
    return new Response('{"id":"mock"}', { status: 200 });
  }
  throw new Error('unexpected outbound request ' + url);
};

http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const cors = PAGE_ORIGINS.includes(origin) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' } : {};
  if (!cors['Access-Control-Allow-Origin']) { res.writeHead(403); return res.end(); }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const chunks = []; for await (const c of req) chunks.push(c);
  // The Worker only accepts the production origins, so the local page origin is presented as nuray.io here.
  const headers = { ...req.headers, origin: 'https://nuray.io', 'cf-connecting-ip': '127.0.0.1' };
  const r = await handle(new Request('https://api.nuray.io' + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  const out = { ...cors, 'Content-Type': r.headers.get('Content-Type') || 'application/json', 'X-Contact-Dev-Mock': '1' };
  res.writeHead(r.status, out);
  res.end(await r.text());
}).listen(8787, () => console.log('Local mock API: http://localhost:8787/contact (mocked Turnstile and Resend)\nOpen http://localhost:4173/?contactDev=1'));

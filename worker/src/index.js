// nuray-contact-api: receives contact-form submissions from nuray.io.
// Mail flow: notification to CONTACT_RECIPIENT (Reply-To = visitor), then an acknowledgment from MAIL_FROM (noreply).
// Secrets (RESEND_API_KEY, TURNSTILE_SECRET_KEY, CONTACT_RECIPIENT) exist only as Worker secrets.
// Nothing in this file logs visitor data, addresses, tokens or keys.

const ALLOWED_ORIGINS = ['https://nuray.io', 'https://www.nuray.io'];
const LANGS = ['tr', 'en', 'de'];
const MAX_BODY_BYTES = 8192;
const LIMITS = { name: 100, email: 200, subject: 150, message: 3000 };
const MIN_MESSAGE = 5;
const MIN_FILL_MS = 3000;
const MAX_FILL_MS = 24 * 60 * 60 * 1000;
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND_URL = 'https://api.resend.com/emails';
const EXPECTED_HOSTNAMES = ['nuray.io', 'www.nuray.io'];
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const FROM_RE = /^(?:[^<>@\r\n]{1,60} )?<?noreply@nuray\.io>?$/;

const ACK = {
  en: {
    notice: 'This email was sent automatically from noreply@nuray.io. Please do not reply to this message. Replies sent to this address are not read or processed, and may be rejected by the email system and returned to the sender as undeliverable.',
    subject: 'Thank you for your message',
    lines: () => ['Hello,', 'Thank you for getting in touch with me. I have received your message. Depending on my workload, I will do my best to get back to you as soon as possible.', 'Kind regards,\nÖnder'],
  },
  de: {
    notice: 'Diese E-Mail wurde automatisch von noreply@nuray.io versendet. Bitte antworten Sie nicht auf diese Nachricht. Antworten an diese Adresse werden weder gelesen noch bearbeitet und können vom E-Mail-System abgelehnt und als unzustellbar an den Absender zurückgesendet werden.',
    subject: 'Vielen Dank für Ihre Nachricht',
    lines: () => ['Guten Tag,', 'vielen Dank, dass Sie mit mir Kontakt aufgenommen haben. Ihre Nachricht ist bei mir eingegangen. Je nach Arbeitsaufkommen werde ich mich so bald wie möglich bei Ihnen melden.', 'Mit freundlichen Grüßen\nÖnder'],
  },
  tr: {
    notice: 'Bu e-posta, noreply@nuray.io adresinden otomatik olarak gönderilmiştir. Lütfen bu iletiyi yanıtlamayınız. Bu adrese gönderilen yanıtlar okunmamakta ve işleme alınmamakta olup, e-posta sistemi tarafından kabul edilmeyerek göndericiye teslim edilemeden geri döndürülebilir.',
    subject: 'Mesajınız için teşekkürler',
    lines: () => ['Merhaba,', 'Benimle iletişime geçtiğiniz için teşekkür ederim. Mesajınız bana ulaştı. İş yoğunluğuma bağlı olarak en kısa sürede size geri dönüş yapmaya çalışacağım.', 'Saygılarımla,\nÖnder'],
  },
};

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});
const fail = (status, code, extra = {}, headers = {}) => json(status, { ok: false, code, ...extra }, headers);

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Removes control characters. Single-line fields also lose line breaks (prevents header injection).
export function clean(value, { multiline = false } = {}) {
  let s = String(value).normalize('NFC').replace(/\r\n?/g, '\n');
  s = multiline ? s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '') : s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ');
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
  return s.trim();
}

function corsHeaders(origin) {
  return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
}

// Reads at most `max` bytes of the body; returns null when it is larger.
async function readBounded(request, max) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

function configProblems(env) {
  const bad = [];
  if (!env.RESEND_API_KEY) bad.push('RESEND_API_KEY');
  if (!env.TURNSTILE_SECRET_KEY) bad.push('TURNSTILE_SECRET_KEY');
  if (!env.CONTACT_RECIPIENT || !EMAIL_RE.test(String(env.CONTACT_RECIPIENT).trim())) bad.push('CONTACT_RECIPIENT');
  if (!env.MAIL_FROM || !FROM_RE.test(String(env.MAIL_FROM).trim())) bad.push('MAIL_FROM');
  if (!env.RATE_LIMITER || typeof env.RATE_LIMITER.limit !== 'function') bad.push('RATE_LIMITER');
  return bad;
}

export function validate(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['body'] };
  for (const k of ['name', 'email', 'message', 'lang', 'token']) if (typeof input[k] !== 'string') errors.push(k);
  for (const k of ['subject', 'website']) if (input[k] != null && typeof input[k] !== 'string') errors.push(k);
  if (errors.length) return { errors };
  const v = {
    name: clean(input.name),
    email: clean(input.email).toLowerCase(),
    subject: clean(input.subject || ''),
    message: clean(input.message, { multiline: true }),
    lang: input.lang,
    token: input.token.trim(),
    website: input.website || '',
    startedAt: Number(input.startedAt),
  };
  if (!v.name || v.name.length > LIMITS.name) errors.push('name');
  if (!v.email || v.email.length > LIMITS.email || !EMAIL_RE.test(v.email) || v.email.includes('..')) errors.push('email');
  if (v.subject.length > LIMITS.subject) errors.push('subject');
  if (v.message.length < MIN_MESSAGE || v.message.length > LIMITS.message) errors.push('message');
  if (!LANGS.includes(v.lang)) errors.push('lang');
  if (!v.token || v.token.length > 2048) errors.push('token');
  return { value: v, errors };
}

async function verifyTurnstile(env, token, ip) {
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return { error: true };
  const data = await res.json();
  if (!data || data.success !== true) {
    // Error codes are fixed Cloudflare identifiers (for example "timeout-or-duplicate"), not visitor data.
    const codes = Array.isArray(data?.['error-codes']) ? data['error-codes'].filter((c) => /^[a-z-]{1,60}$/.test(c)) : [];
    console.error('turnstile rejected:', codes.join(',') || 'no-code');
    return { ok: false };
  }
  const hosts = (env.TURNSTILE_HOSTNAMES ? String(env.TURNSTILE_HOSTNAMES).split(',').map((h) => h.trim()) : EXPECTED_HOSTNAMES);
  if (!hosts.includes(data.hostname)) { console.error('turnstile hostname mismatch'); return { ok: false }; }
  return { ok: true };
}

async function sendMail(env, payload) {
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) console.error('resend http status:', res.status); // status only: the body can contain addresses
  return res.ok;
}

function ownerMail(env, v) {
  const subject = `Contact form: ${v.subject || v.name}`.slice(0, 200);
  const text = [`Name: ${v.name}`, `Email: ${v.email}`, `Language: ${v.lang}`, v.subject ? `Subject: ${v.subject}` : null, '', v.message].filter((l) => l !== null).join('\n');
  const html = `<table role="presentation" cellpadding="4" style="font-family:sans-serif;font-size:14px"><tr><td><b>Name</b></td><td>${escapeHtml(v.name)}</td></tr>`
    + `<tr><td><b>Email</b></td><td>${escapeHtml(v.email)}</td></tr><tr><td><b>Language</b></td><td>${escapeHtml(v.lang)}</td></tr>`
    + (v.subject ? `<tr><td><b>Subject</b></td><td>${escapeHtml(v.subject)}</td></tr>` : '')
    + `</table><p style="font-family:sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(v.message)}</p>`;
  return { from: String(env.MAIL_FROM).trim(), to: [String(env.CONTACT_RECIPIENT).trim()], reply_to: v.email, subject, text, html };
}

function ackMail(env, v) {
  const t = ACK[v.lang];
  const lines = t.lines(v.name);
  return {
    from: String(env.MAIL_FROM).trim(), to: [v.email], subject: t.subject, text: [`*** ${t.notice} ***`, ...lines].join('\n\n'),
    html: `<div style="font-family:sans-serif;font-size:14px"><p style="margin:0 0 16px;padding:10px 12px;background:#fff4e5;border-left:4px solid #d97706;font-weight:bold">${escapeHtml(t.notice)}</p>${lines.map((l) => `<p>${escapeHtml(l).replace(/\n/g, '<br>')}</p>`).join('')}</div>`,
    headers: { 'Auto-Submitted': 'auto-replied' },
  };
}

async function handlePost(request, env, origin) {
  const cors = corsHeaders(origin);
  const reply = (status, code, extra) => fail(status, code, extra, cors);

  const bad = configProblems(env);
  if (bad.length) { console.error('contact-api misconfigured:', bad.join(',')); return reply(500, 'server_error'); }

  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) return reply(415, 'bad_request');

  const ip = request.headers.get('CF-Connecting-IP') || '';
  try {
    const { success } = await env.RATE_LIMITER.limit({ key: `contact:${ip || 'unknown'}` });
    if (!success) return reply(429, 'rate_limited');
  } catch (e) { console.error('rate limiter error'); return reply(500, 'server_error'); }

  let raw;
  try { raw = await readBounded(request, MAX_BODY_BYTES); } catch (e) { return reply(400, 'bad_request'); }
  if (raw === null) return reply(413, 'too_large');
  let input;
  try { input = JSON.parse(raw); } catch (e) { return reply(400, 'bad_request'); }

  const { value: v, errors } = validate(input);
  if (errors.length) return reply(400, 'validation', { fields: errors });

  // Honeypot: pretend success so bots learn nothing.
  if (v.website) return json(200, { ok: true }, cors);

  const age = Date.now() - v.startedAt;
  if (!Number.isFinite(v.startedAt) || age < MIN_FILL_MS || age > MAX_FILL_MS) return reply(400, 'too_fast');

  let ts;
  try { ts = await verifyTurnstile(env, v.token, ip); } catch (e) { console.error('siteverify unreachable'); return reply(502, 'server_error'); }
  if (ts.error) { console.error('siteverify http error'); return reply(502, 'server_error'); }
  if (!ts.ok) return reply(400, 'captcha_failed');

  // No KV: a Turnstile token is single-use, so Siteverify rejects a repeated submission of the same form.
  // The page also locks the form while a request is running.
  let ownerOk = false;
  try { ownerOk = await sendMail(env, ownerMail(env, v)); } catch (e) { ownerOk = false; }
  if (!ownerOk) { console.error('owner notification failed'); return reply(502, 'server_error'); }

  // Acknowledgment only after the owner notification succeeded.
  try {
    if (!(await sendMail(env, ackMail(env, v)))) console.error('acknowledgment failed');
  } catch (e) { console.error('acknowledgment error'); }

  return json(200, { ok: true }, cors);
}

export async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/contact') return fail(404, 'not_found');
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin);

  if (request.method === 'OPTIONS') {
    if (!allowed) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: { ...corsHeaders(origin), 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
  }
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', {}, { Allow: 'POST, OPTIONS' });
  if (!allowed) return fail(403, 'forbidden_origin');
  try {
    return await handlePost(request, env, origin);
  } catch (e) {
    console.error('unhandled contact-api error');
    return fail(500, 'server_error', {}, corsHeaders(origin));
  }
}

export default { fetch: (request, env) => handle(request, env) };

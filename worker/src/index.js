// nuray-contact-api: receives contact-form submissions from nuray.io.
// Flow with e-mail verification:
//   POST /contact         validates the form and Turnstile, stores the message in D1 for 15 minutes under the HMAC digest of a random
//                         token and mails the visitor a confirmation link (https://nuray.io/verify.html#t=<token>). Nothing reaches the owner yet.
//   POST /contact/verify  the confirmation page posts the token; the row is consumed atomically (UPDATE ... RETURNING), so a link works
//                         once. Then the notification goes to CONTACT_RECIPIENT (Reply-To = visitor) and a short acknowledgment to the visitor.
//   POST /contact/resend  issues a new link for a pending message (60 s apart, at most 3 mails per message).
// D1 (DB) holds the pending messages (deleted on delivery, on expiry by the purge, every 5 minutes by cron) and counters (daily caps, per-address limits).
// Counter keys contain only HMAC-SHA256 digests (keyed with DIGEST_PEPPER) of addresses and client IPs, never an address or message text.
// Secrets (RESEND_API_KEY, TURNSTILE_SECRET_KEY, CONTACT_RECIPIENT, DIGEST_PEPPER) exist only as Worker secrets.
// Nothing in this file logs visitor data, addresses, tokens or keys.

const ALLOWED_ORIGINS = ['https://nuray.io', 'https://www.nuray.io'];
const LANGS = ['tr', 'en', 'de'];
const MAX_BODY_BYTES = 8192;
const LIMITS = { nameMin: 2, name: 80, email: 254, subject: 150, message: 3000 };
const MIN_MESSAGE = 10;
const MAX_LINKS = 2;
const MAX_REPEAT = 6; // the same character more than 6 times in a row is rejected
const MAX_WORD = 60; // longest allowed run without whitespace (links are not counted)
const NAME_RE = /^\p{L}[\p{L}\p{M} .'’-]*$/u;
const LINK_RE = /(?:https?:\/\/|www\.)\S+/gi;
const hasRepeat = (s) => new RegExp('([^\\s])\\1{' + MAX_REPEAT + ',}', 'u').test(s);
const MIN_FILL_MS = 3000;
const MAX_FILL_MS = 24 * 60 * 60 * 1000;
const VERIFY_TTL_S = 15 * 60; // a confirmation link (and the stored message) lives 15 minutes
const RESEND_COOLDOWN_S = 60; // minimum time between two confirmation mails for one message
const MAX_MAILS_PER_MESSAGE = 3; // first mail plus two new links
const ADDR_VERIFY_MAX = 5; // confirmation mails per address per 24 hours (protects third-party mailboxes and the Resend reputation)
const ADDR_TTL_S = 24 * 60 * 60;
const ACK_DAILY_MAX = 30; // automatic acknowledgments per UTC day in total
const OWNER_DAILY_MAX = 30; // delivered messages per UTC day in total
const VERIFY_DAILY_MAX = 40; // confirmation mails per UTC day in total (the three caps together stay below Resend's 100 mails per day)
const SUBNET_DAILY_MAX = 6; // the same per network (IPv4 /24, IPv6 /48), so rotating addresses inside one network does not multiply the per-client cap
const IP_DAILY_MAX = 3; // confirmation mails started per client (IPv4 address or IPv6 /64) per 24 hours, so one client cannot use up the daily cap
const CLAIM_LEASE_S = 60; // a claimed message (used = claim time) can be claimed again after this long, if the Worker died before delivering it
const DAY_TTL_S = 2 * 24 * 60 * 60;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const VERIFY_URL = 'https://nuray.io/verify.html'; // can be overridden by the VERIFY_BASE_URL variable (local development)
const TURNSTILE_ACTION = 'contact'; // must equal the 'action' option of the widget in js/contact.js
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND_URL = 'https://api.resend.com/emails';
const EXPECTED_HOSTNAMES = ['nuray.io', 'www.nuray.io'];
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const FROM_RE = /^(?:[^<>@\r\n]{1,60} )?<?noreply@nuray\.io>?$/;

const ACK = {
  en: {
    notice: 'This email was sent automatically from noreply@nuray.io. Please do not reply to this message. Replies sent to this address are not read or processed, and may be rejected by the email system and returned to the sender as undeliverable.',
    subject: 'Thank you for your message',
    lines: () => ['Hello,', 'Thank you for getting in touch with me. I have received your message. Depending on my workload, I will do my best to get back to you as soon as possible.', 'Kind regards,'],
  },
  de: {
    notice: 'Diese E-Mail wurde automatisch von noreply@nuray.io versendet. Bitte antworten Sie nicht auf diese Nachricht. Antworten an diese Adresse werden weder gelesen noch bearbeitet und können vom E-Mail-System abgelehnt und als unzustellbar an den Absender zurückgesendet werden.',
    subject: 'Vielen Dank für Ihre Nachricht',
    lines: () => ['Guten Tag,', 'vielen Dank, dass Sie mit mir Kontakt aufgenommen haben. Ihre Nachricht ist bei mir eingegangen. Je nach Arbeitsaufkommen werde ich mich so bald wie möglich bei Ihnen melden.', 'Mit freundlichen Grüßen'],
  },
  tr: {
    notice: 'Bu e-posta, noreply@nuray.io adresinden otomatik olarak gönderilmiştir. Lütfen bu iletiyi yanıtlamayınız. Bu adrese gönderilen yanıtlar okunmamakta ve işleme alınmamakta olup, e-posta sistemi tarafından kabul edilmeyerek göndericiye teslim edilemeden geri döndürülebilir.',
    subject: 'Mesajınız için teşekkürler',
    lines: () => ['Merhaba,', 'Benimle iletişime geçtiğiniz için teşekkür ederim. Mesajınız bana ulaştı. İş yoğunluğuma bağlı olarak en kısa sürede size geri dönüş yapmaya çalışacağım.', 'Saygılarımla,'],
  },
};

// Confirmation mail: fixed text, never any visitor-supplied content (the form must not become a way to send arbitrary text to a third party).
const VERIFY = {
  en: {
    subject: 'Please confirm your email address',
    lines: (url) => ['Hello,', 'Someone used the contact form on nuray.io with this email address. To make sure the address is yours, I need you to confirm it before the message is delivered to me.', 'To confirm, open the link below and click "Confirm email address and send message" on the page. The link can be used only once and is valid for 15 minutes.', url, 'If you did not send a message, you can simply ignore this email. Nothing will be delivered unless you confirm.', 'Kind regards,'],
  },
  de: {
    subject: 'Bitte bestätigen Sie Ihre E-Mail-Adresse',
    lines: (url) => ['Guten Tag,', 'jemand hat mit dieser E-Mail-Adresse das Kontaktformular auf nuray.io benutzt. Damit sichergestellt ist, dass die Adresse Ihnen gehört, benötige ich Ihre Bestätigung, bevor die Nachricht bei mir zugestellt wird.', 'Zum Bestätigen öffnen Sie den folgenden Link und klicken auf der Seite auf „E-Mail-Adresse bestätigen und Nachricht senden“. Der Link kann nur einmal verwendet werden und ist 15 Minuten lang gültig.', url, 'Falls Sie keine Nachricht gesendet haben, können Sie diese E-Mail einfach ignorieren. Ohne Ihre Bestätigung wird nichts zugestellt.', 'Mit freundlichen Grüßen'],
  },
  tr: {
    subject: 'Lütfen e-posta adresinizi doğrulayın',
    lines: (url) => ['Merhaba,', 'nuray.io içerisindeki iletişim formu bu e-posta adresiyle kullanıldı. Adresin size ait olduğundan emin olmak için mesaj bana iletilmeden önce e-posta adresinizi doğrulamanız gerekiyor.', 'Doğrulamak için aşağıdaki bağlantıyı açın ve sayfadaki "E-posta adresini doğrula ve mesajı gönder" düğmesine tıklayın. Bağlantı tek kullanımlıktır ve 15 dakika boyunca geçerlidir.', url, 'Bu mesajı siz göndermediyseniz bu e-postayı yok sayabilirsiniz. E-posta adresiniz doğrulanmadıkça mesaj iletilmez.', 'Saygılarımla,'],
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
  if (typeof env.DIGEST_PEPPER !== 'string' || env.DIGEST_PEPPER.length < 32) bad.push('DIGEST_PEPPER');
  if (!env.CONTACT_RECIPIENT || !EMAIL_RE.test(String(env.CONTACT_RECIPIENT).trim())) bad.push('CONTACT_RECIPIENT');
  if (!env.MAIL_FROM || !FROM_RE.test(String(env.MAIL_FROM).trim())) bad.push('MAIL_FROM');
  if (!env.RATE_LIMITER || typeof env.RATE_LIMITER.limit !== 'function') bad.push('RATE_LIMITER');
  if (!env.DB || typeof env.DB.prepare !== 'function') bad.push('DB');
  return bad;
}

// Loose content checks: reject obvious filler, not unusual but genuine input.
export function nameOk(s) {
  return s.length >= LIMITS.nameMin && s.length <= LIMITS.name && NAME_RE.test(s) && !hasRepeat(s);
}
export function messageOk(s) {
  if (s.length < MIN_MESSAGE || s.length > LIMITS.message || hasRepeat(s)) return false;
  if ((s.match(LINK_RE) || []).length > MAX_LINKS) return false;
  return !s.replace(LINK_RE, ' ').split(/\s+/).some((w) => w.length > MAX_WORD);
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
    elapsedMs: typeof input.elapsedMs === 'number' ? input.elapsedMs : NaN,
  };
  if (!nameOk(v.name)) errors.push('name');
  if (!v.email || v.email.length > LIMITS.email || !EMAIL_RE.test(v.email) || v.email.includes('..')) errors.push('email');
  if (v.subject.length > LIMITS.subject) errors.push('subject');
  if (!messageOk(v.message)) errors.push('message');
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
  // The token must have been issued for one of our own hostnames. A missing hostname never passes, and blank entries in the
  // TURNSTILE_HOSTNAMES variable are ignored (an empty list falls back to the defaults).
  const configured = env.TURNSTILE_HOSTNAMES ? String(env.TURNSTILE_HOSTNAMES).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : [];
  const hosts = configured.length ? configured : EXPECTED_HOSTNAMES;
  const host = typeof data.hostname === 'string' ? data.hostname.trim().toLowerCase() : '';
  if (!host || !hosts.includes(host)) { console.error('turnstile hostname mismatch'); return { ok: false }; }
  // The token must come from our own widget action, so a token minted for another purpose cannot be replayed here.
  if (data.action !== TURNSTILE_ACTION) { console.error('turnstile action mismatch'); return { ok: false }; }
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
  const text = [`Name: ${v.name}`, `Email: ${v.email} (confirmed by link)`, `Language: ${v.lang}`, v.subject ? `Subject: ${v.subject}` : null, '', v.message].filter((l) => l !== null).join('\n');
  const html = `<table role="presentation" cellpadding="4" style="font-family:sans-serif;font-size:14px"><tr><td><b>Name</b></td><td>${escapeHtml(v.name)}</td></tr>`
    + `<tr><td><b>Email</b></td><td>${escapeHtml(v.email)} (confirmed by link)</td></tr><tr><td><b>Language</b></td><td>${escapeHtml(v.lang)}</td></tr>`
    + (v.subject ? `<tr><td><b>Subject</b></td><td>${escapeHtml(v.subject)}</td></tr>` : '')
    + `</table><p style="font-family:sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(v.message)}</p>`;
  return { from: String(env.MAIL_FROM).trim(), to: [String(env.CONTACT_RECIPIENT).trim()], reply_to: v.email, subject, text, html };
}

// VERIFY_BASE_URL is honoured only for a local page (http://localhost or 127.0.0.1). Any other value is ignored, so a wrong
// production variable can never send confirmation links (and their tokens) to a foreign host.
export function verifyBase(env) {
  if (!env.VERIFY_BASE_URL) return VERIFY_URL;
  try {
    const u = new URL(String(env.VERIFY_BASE_URL));
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && !u.username && !u.password) return u.toString();
  } catch (e) { /* fall through */ }
  console.error('VERIFY_BASE_URL ignored');
  return VERIFY_URL;
}

function verifyUrl(env, lang, token) {
  const u = new URL(verifyBase(env));
  u.searchParams.set('lang', lang);
  u.hash = 't=' + token; // in the fragment: never sent to a server, a log or a Referer header
  return u.toString();
}

function verifyMail(env, to, lang, token) {
  const t = VERIFY[lang];
  const url = verifyUrl(env, lang, token);
  const lines = t.lines(url);
  return {
    from: String(env.MAIL_FROM).trim(), to: [to], subject: t.subject, text: [`*** ${ACK[lang].notice} ***`, ...lines].join('\n\n'),
    html: `<div style="font-family:sans-serif;font-size:14px"><p style="margin:0 0 16px;padding:10px 12px;background:#fff4e5;border-left:4px solid #d97706;font-weight:bold">${escapeHtml(ACK[lang].notice)}</p>`
      + lines.map((l) => (l === url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : `<p>${escapeHtml(l)}</p>`)).join('') + '</div>',
    headers: { 'Auto-Submitted': 'auto-generated' },
  };
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

// Rate-limit key per client. IPv6 clients are grouped by their /64 prefix (one subscriber normally controls the whole /64, so
// rotating addresses inside it must not bypass the limit); an IPv4-mapped IPv6 address counts as the IPv4 address.
export function rateKey(ip) {
  if (!ip) return 'unknown';
  const s = String(ip).trim().toLowerCase().split('%')[0];
  if (!s.includes(':')) return s;
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const halves = s.split('::');
  if (halves.length > 2) return s;
  let groups;
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    if (head.length + tail.length > 7) return s;
    groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  } else groups = s.split(':');
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':') + '/64';
}

// Network of a client for the per-network cap: IPv4 /24, IPv6 /48 (derived from the /64 key of rateKey).
export function subnetKey(ip) {
  const k = rateKey(ip);
  const v4 = k.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return v4[1] + '.0/24';
  const v6 = k.match(/^([0-9a-f]{4}:[0-9a-f]{4}:[0-9a-f]{4}):[0-9a-f]{4}\/64$/);
  if (v6) return v6[1] + '::/48';
  return k;
}

// Digest used for stored tokens and counter keys, so that neither a token, an address nor message text appears in a key.
// HMAC-SHA256 keyed with the secret DIGEST_PEPPER: without that secret, a leaked D1 row or counter key cannot be used to test guesses
// ("is this address / token among them?"), which a plain hash of a guessable address would allow.
async function digest(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.DIGEST_PEPPER)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('nuray-contact:' + text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const nowS = () => Math.floor(Date.now() / 1000);
const dayKey = (name) => `${name}:${new Date().toISOString().slice(0, 10)}`;

// 32 random bytes as base64url (43 characters, 256 bits). Only its digest is stored.
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Counters in D1. reserve() raises the counter atomically and answers false (after undoing its own increment) when the limit is reached.
async function reserve(env, key, max, ttlS) {
  const now = nowS();
  const row = await env.DB.prepare(
    'INSERT INTO counters (key, n, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET '
    + 'n = CASE WHEN expires_at <= ? THEN 1 ELSE n + 1 END, expires_at = CASE WHEN expires_at <= ? THEN ? ELSE expires_at END RETURNING n',
  ).bind(key, now + ttlS, now, now, now + ttlS).first();
  if (row && Number(row.n) <= max) return true;
  await release(env, key);
  return false;
}
async function release(env, key) {
  try { await env.DB.prepare('UPDATE counters SET n = MAX(n - 1, 0) WHERE key = ?').bind(key).run(); } catch (e) { console.error('d1 release failed'); }
}
async function peek(env, key) {
  const row = await env.DB.prepare('SELECT n FROM counters WHERE key = ? AND expires_at > ?').bind(key, nowS()).first();
  return row ? Number(row.n) : 0;
}
// Removes expired messages and counters (also run every 5 minutes by the cron trigger). Reading ignores expired rows anyway.
export async function purge(env) {
  try {
    const now = nowS();
    await env.DB.prepare('DELETE FROM pending WHERE expires_at <= ?').bind(now).run();
    await env.DB.prepare('DELETE FROM counters WHERE expires_at <= ?').bind(now).run();
  } catch (e) { console.error('purge failed'); }
}

async function trySend(env, payload) {
  try { return await sendMail(env, payload); } catch (e) { return false; }
}

// Common checks of the three POST endpoints: configuration, content type and per-client rate limit. Returns a Response or null.
async function guard(request, env, reply, limitName) {
  const bad = configProblems(env);
  if (bad.length) { console.error('contact-api misconfigured:', bad.join(',')); return reply(500, 'server_error'); }
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) return reply(415, 'bad_request');
  const ip = request.headers.get('CF-Connecting-IP') || '';
  try {
    const { success } = await env.RATE_LIMITER.limit({ key: `${limitName}:${rateKey(ip)}` });
    if (!success) return reply(429, 'rate_limited');
  } catch (e) { console.error('rate limiter error'); return reply(500, 'server_error'); }
  return null;
}
async function readJson(request) {
  let raw;
  try { raw = await readBounded(request, MAX_BODY_BYTES); } catch (e) { return { status: 400, code: 'bad_request' }; }
  if (raw === null) return { status: 413, code: 'too_large' };
  try { return { input: JSON.parse(raw) }; } catch (e) { return { status: 400, code: 'bad_request' }; }
}

async function handlePost(request, env, origin, ctx) {
  const cors = corsHeaders(origin);
  const reply = (status, code, extra) => fail(status, code, extra, cors);
  const refused = await guard(request, env, reply, 'contact');
  if (refused) return refused;
  const ip = request.headers.get('CF-Connecting-IP') || '';

  const parsed = await readJson(request);
  if (!('input' in parsed)) return reply(parsed.status, parsed.code);

  const { value: v, errors } = validate(parsed.input);
  if (errors.length) return reply(400, 'validation', { fields: errors });

  // Honeypot: pretend success so bots learn nothing (no resend secret is returned).
  if (v.website) return json(200, { ok: true, pending: true }, cors);

  // Fill time. The page sends elapsedMs (a monotonic duration, so a wrong device clock cannot reject a real visitor);
  // pages cached from before that change send only startedAt (a wall-clock time). Both come from the visitor, so this is a speed
  // bump for simple bots, not a security boundary: the Turnstile check below is what keeps bots out.
  const tooFast = Number.isFinite(v.elapsedMs)
    ? v.elapsedMs < MIN_FILL_MS
    : !Number.isFinite(v.startedAt) || Date.now() - v.startedAt < MIN_FILL_MS || Date.now() - v.startedAt > MAX_FILL_MS;
  if (tooFast) return reply(400, 'too_fast');

  // Global daily cap on confirmation mails, looked at before Siteverify so the visitor's token is not used up for nothing.
  const verifyDay = dayKey('verifyday');
  try { if ((await peek(env, verifyDay)) >= VERIFY_DAILY_MAX) return reply(429, 'rate_limited'); } catch (e) { console.error('d1 error'); return reply(500, 'server_error'); }
  let ts;
  try { ts = await verifyTurnstile(env, v.token, ip); } catch (e) { console.error('siteverify unreachable'); return reply(502, 'server_error'); }
  if (ts.error) { console.error('siteverify http error'); return reply(502, 'server_error'); }
  if (!ts.ok) return reply(400, 'captcha_failed');

  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(purge(env));

  // Store the message for 15 minutes and mail the confirmation link. At most one pending message per address.
  // Nothing in the answer may depend on the address (anyone can type any address): when the address has reached its 24-hour limit,
  // or a message for it is still pending (which a new submission must not replace or invalidate), the answer is the same as for a
  // fresh submission, without a mail. Client and network counters stay spent in those cases, exactly as for a real submission.
  const emailHash = await digest(env, 'email:' + v.email);
  const addrKey = 'addrv:' + emailHash;
  const ipKey = 'ipv:' + (await digest(env, 'ip:' + rateKey(ip)));
  const netKey = 'netv:' + (await digest(env, 'net:' + subnetKey(ip)));
  const token = newToken();
  const resend = newToken();
  const tokenHash = await digest(env, 'token:' + token);
  const held = [];
  const releaseAll = async (keys) => { for (const k of keys) await release(env, k); };
  const silent = async () => { await releaseAll(held.filter((k) => k === addrKey || k === verifyDay)); return json(200, { ok: true, pending: true, resend: newToken() }, cors); };
  try {
    for (const [key, max, ttl] of [[ipKey, IP_DAILY_MAX, ADDR_TTL_S], [netKey, SUBNET_DAILY_MAX, ADDR_TTL_S], [verifyDay, VERIFY_DAILY_MAX, DAY_TTL_S]]) {
      if (!(await reserve(env, key, max, ttl))) { await releaseAll(held); return reply(429, 'rate_limited'); }
      held.push(key);
    }
    if (!(await reserve(env, addrKey, ADDR_VERIFY_MAX, ADDR_TTL_S))) return await silent();
    held.push(addrKey);
    const now = nowS();
    const stored = await env.DB.prepare(
      'INSERT INTO pending (token_hash, resend_hash, email_hash, name, email, subject, message, lang, expires_at, last_sent, mails, used) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0) ON CONFLICT(email_hash) DO UPDATE SET token_hash = excluded.token_hash, '
      + 'resend_hash = excluded.resend_hash, name = excluded.name, email = excluded.email, subject = excluded.subject, message = excluded.message, '
      + 'lang = excluded.lang, expires_at = excluded.expires_at, last_sent = excluded.last_sent, mails = 1, used = 0 WHERE pending.expires_at <= ?',
    ).bind(tokenHash, await digest(env, 'token:' + resend), emailHash, v.name, v.email, v.subject, v.message, v.lang, now + VERIFY_TTL_S, now, now).run();
    if (!stored.meta || stored.meta.changes === 0) return await silent();
  } catch (e) {
    console.error('d1 error');
    await releaseAll(held);
    return reply(500, 'server_error');
  }
  if (!(await trySend(env, verifyMail(env, v.email, v.lang, token)))) {
    console.error('verification mail failed');
    try { await env.DB.prepare('DELETE FROM pending WHERE token_hash = ?').bind(tokenHash).run(); } catch (e) { console.error('d1 error'); }
    await releaseAll(held);
    return reply(502, 'server_error');
  }
  return json(200, { ok: true, pending: true, resend }, cors);
}

// The confirmation page posts the token from the link. The message is delivered only here, only for that token, only once.
async function handleVerify(request, env, origin, ctx) {
  const cors = corsHeaders(origin);
  const reply = (status, code, extra) => fail(status, code, extra, cors);
  const refused = await guard(request, env, reply, 'verify');
  if (refused) return refused;
  const parsed = await readJson(request);
  if (!('input' in parsed)) return reply(parsed.status, parsed.code);
  const token = parsed.input && typeof parsed.input === 'object' ? parsed.input.token : undefined;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return reply(400, 'invalid_token');
  const tokenHash = await digest(env, 'token:' + token);

  const ownerDay = dayKey('ownerday');
  let row;
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(purge(env));
  try {
    // Atomic: of two simultaneous requests with the same token only one gets the row. This runs before the daily cap, so an
    // unknown token costs no counter writes (an UPDATE that matches nothing writes no rows).
    row = await env.DB.prepare(
      'UPDATE pending SET used = ? WHERE token_hash = ? AND (used = 0 OR used <= ?) AND expires_at > ? RETURNING name, email, subject, message, lang, email_hash',
    ).bind(nowS(), tokenHash, nowS() - CLAIM_LEASE_S, nowS()).first();
    if (!row) return reply(400, 'invalid_token');
    if (!(await reserve(env, ownerDay, OWNER_DAILY_MAX, DAY_TTL_S))) {
      await env.DB.prepare('UPDATE pending SET used = 0 WHERE token_hash = ?').bind(tokenHash).run();
      return reply(429, 'rate_limited');
    }
  } catch (e) {
    console.error('d1 error');
    return reply(500, 'server_error');
  }

  const v = { name: row.name, email: row.email, subject: row.subject, message: row.message, lang: row.lang };
  if (!(await trySend(env, ownerMail(env, v)))) {
    console.error('owner notification failed');
    try { await env.DB.prepare('UPDATE pending SET used = 0 WHERE token_hash = ?').bind(tokenHash).run(); } catch (e) { console.error('d1 error'); }
    await release(env, ownerDay);
    return reply(502, 'server_error');
  }
  try { await env.DB.prepare('DELETE FROM pending WHERE token_hash = ?').bind(tokenHash).run(); } catch (e) { console.error('d1 error'); }

  // Short automatic acknowledgment, in the background. The address is now confirmed; the per-address (24 h) and daily limits remain
  // to protect the mail quota. Any problem means "no acknowledgment"; the message itself has been delivered.
  const ackKey = 'ack:' + row.email_hash;
  const ackDay = dayKey('ackday');
  const sendAck = async () => {
    let addr = false;
    let day = false;
    try {
      if (!(await reserve(env, ackKey, 1, ADDR_TTL_S))) return;
      addr = true;
      if (!(await reserve(env, ackDay, ACK_DAILY_MAX, DAY_TTL_S))) { await release(env, ackKey); return; }
      day = true;
      if (!(await trySend(env, ackMail(env, v)))) { console.error('acknowledgment failed'); await release(env, ackKey); await release(env, ackDay); }
    } catch (e) {
      console.error('acknowledgment error');
      if (addr) await release(env, ackKey);
      if (day) await release(env, ackDay);
    }
  };
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(sendAck()); else await sendAck();
  return json(200, { ok: true }, cors);
}

// A new confirmation link for a message that is still waiting. The secret comes from the answer to the original submission
// (kept in the page's memory only), so only the browser that passed Turnstile can ask.
async function handleResend(request, env, origin) {
  const cors = corsHeaders(origin);
  const reply = (status, code, extra) => fail(status, code, extra, cors);
  const refused = await guard(request, env, reply, 'resend');
  if (refused) return refused;
  const parsed = await readJson(request);
  if (!('input' in parsed)) return reply(parsed.status, parsed.code);
  const secret = parsed.input && typeof parsed.input === 'object' ? parsed.input.resend : undefined;
  if (typeof secret !== 'string' || !TOKEN_RE.test(secret)) return reply(400, 'invalid_token');
  const resendHash = await digest(env, 'token:' + secret);

  const verifyDay = dayKey('verifyday');
  let addrKey = '';
  let addrReserved = false;
  let dayReserved = false;
  const undo = async () => { if (addrReserved) await release(env, addrKey); if (dayReserved) await release(env, verifyDay); };
  const token = newToken();
  const tokenHash = await digest(env, 'token:' + token);
  let row;
  let updated;
  try {
    const now = nowS();
    row = await env.DB.prepare('SELECT token_hash, email, email_hash, lang, last_sent, mails FROM pending WHERE resend_hash = ? AND used = 0 AND expires_at > ?').bind(resendHash, now).first();
    if (!row) return reply(400, 'invalid_token');
    if (Number(row.mails) >= MAX_MAILS_PER_MESSAGE) return reply(429, 'resend_limit');
    if (now - Number(row.last_sent) < RESEND_COOLDOWN_S) return reply(429, 'rate_limited');
    addrKey = 'addrv:' + row.email_hash;
    if (!(await reserve(env, addrKey, ADDR_VERIFY_MAX, ADDR_TTL_S))) return reply(429, 'address_limit');
    addrReserved = true;
    if (!(await reserve(env, verifyDay, VERIFY_DAILY_MAX, DAY_TTL_S))) { await undo(); return reply(429, 'rate_limited'); }
    dayReserved = true;
    // Atomic: the old link stops working; a parallel request that read the same row finds nothing to update.
    updated = await env.DB.prepare(
      'UPDATE pending SET token_hash = ?, last_sent = ?, mails = mails + 1, expires_at = ? WHERE resend_hash = ? AND token_hash = ? AND used = 0 AND mails < ? AND last_sent <= ? RETURNING mails',
    ).bind(tokenHash, now, now + VERIFY_TTL_S, resendHash, row.token_hash, MAX_MAILS_PER_MESSAGE, now - RESEND_COOLDOWN_S).first();
  } catch (e) {
    console.error('d1 error');
    await undo();
    return reply(500, 'server_error');
  }
  if (!updated) { await undo(); return reply(429, 'rate_limited'); }
  if (!(await trySend(env, verifyMail(env, row.email, row.lang, token)))) {
    console.error('verification mail failed');
    try {
      await env.DB.prepare('UPDATE pending SET token_hash = ?, last_sent = ?, mails = mails - 1 WHERE token_hash = ?').bind(row.token_hash, row.last_sent, tokenHash).run();
    } catch (e) { console.error('d1 error'); }
    await undo();
    return reply(502, 'server_error');
  }
  return json(200, { ok: true }, cors);
}

const ROUTES = { '/contact': handlePost, '/contact/verify': handleVerify, '/contact/resend': handleResend };

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
  if (!route) return fail(404, 'not_found');
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin);

  if (request.method === 'OPTIONS') {
    if (!allowed) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: { ...corsHeaders(origin), 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
  }
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', {}, { Allow: 'POST, OPTIONS' });
  if (!allowed) return fail(403, 'forbidden_origin');
  try {
    return await route(request, env, origin, ctx);
  } catch (e) {
    console.error('unhandled contact-api error');
    return fail(500, 'server_error', {}, corsHeaders(origin));
  }
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  // Cron trigger (every 5 minutes): removes expired pending messages and counters.
  scheduled: (event, env, ctx) => ctx.waitUntil(purge(env)),
};

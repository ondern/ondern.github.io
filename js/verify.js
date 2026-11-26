import { initI18n, t, getLang } from './i18n.js';
import { CONTACT_API_URL } from './config.js';

// Confirmation page of the e-mail link (verify.html#t=<token>). Opening the page does nothing; only the button sends the token to the
// Worker, which delivers the stored message once. The token stays in the URL fragment, so it never reaches a server log or a Referer header.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function main() {
  try { await initI18n(); } catch (e) { /* the page keeps its built-in English text */ }
  const $ = (id) => document.getElementById(id);
  const btn = $('verify-btn');
  const status = $('verify-status');
  const intro = $('verify-intro');
  const home = $('verify-home');
  const token = (location.hash.match(/^#t=([^&]*)$/) || [])[1] || '';
  let statusKey = null;
  let working = false;

  function show(key, kind = 'error') {
    statusKey = key;
    status.textContent = key ? t(key) : '';
    if (key) status.dataset.kind = kind; else delete status.dataset.kind;
  }
  const finish = () => { btn.hidden = true; intro.hidden = true; };
  const syncHome = () => { home.href = `./?lang=${encodeURIComponent(getLang())}`; };
  syncHome();
  document.addEventListener('languagechange', () => {
    syncHome();
    if (statusKey) status.textContent = t(statusKey);
    if (working) btn.textContent = t('verify.working');
  });

  if (!TOKEN_RE.test(token)) { show('verify.invalid'); finish(); return; }

  btn.addEventListener('click', async () => {
    if (working) return;
    working = true;
    btn.disabled = true;
    btn.textContent = t('verify.working');
    btn.setAttribute('aria-busy', 'true');
    show(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res = null;
    let data = null;
    try {
      res = await fetch(`${CONTACT_API_URL}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
        signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      data = await res.json().catch(() => null);
    } catch (err) { /* handled below: res stays null */ } finally { clearTimeout(timer); }
    working = false;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.textContent = t('verify.button');
    if (res && res.ok && data?.ok) {
      show('verify.ok', 'success');
      finish();
      history.replaceState(null, '', location.pathname + location.search); // the token is used up
      return;
    }
    if (data?.code === 'invalid_token') { show('verify.invalid'); finish(); return; }
    if (!res) { show('verify.network'); return; }
    show(data?.code === 'rate_limited' ? 'verify.rate' : 'verify.server');
  });
}
main();

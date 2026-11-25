import { t, getLang } from './i18n.js';
import { CONTACT_API_URL, TURNSTILE_SITE_KEY } from './config.js';

// Cloudflare Turnstile is loaded only when the visitor starts using the form (never on page load).
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const LIMITS = { name: 100, email: 200, subject: 150, messageMin: 5, messageMax: 3000 };
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const FIELD_IDS = { name: 'cf-name', email: 'cf-email', subject: 'cf-subject', message: 'cf-message' };
const SERVER_ERRORS = {
  captcha_failed: 'contact.err.captchaFailed', too_fast: 'contact.err.tooFast', rate_limited: 'contact.err.rate',
  in_progress: 'contact.err.inProgress', too_large: 'contact.err.message', server_error: 'contact.err.server',
};

const isConfigured = () => TURNSTILE_SITE_KEY && !/^REPLACE/i.test(TURNSTILE_SITE_KEY);

export function initContact() {
  const form = document.getElementById('contact-form');
  if (!form) return;
  const $ = (id) => document.getElementById(id);
  const fieldset = form.querySelector('fieldset');
  const submit = $('cf-submit');
  const status = $('cf-status');
  const slot = $('cf-turnstile');
  const state = { widgetId: null, token: '', scriptPromise: null, sending: false, startedAt: Date.now(), statusKey: null, waiters: [] };

  function setStatus(key, kind = 'error') {
    state.statusKey = key;
    status.textContent = key ? t(key) : '';
    if (key) status.dataset.kind = kind; else delete status.dataset.kind;
  }
  function markInvalid(field) {
    const el = $(FIELD_IDS[field]);
    if (!el) return null;
    el.setAttribute('aria-invalid', 'true');
    el.setAttribute('aria-describedby', 'cf-status');
    return el;
  }
  function clearInvalid() {
    form.querySelectorAll('[aria-invalid]').forEach((el) => { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); });
  }
  function setSending(on) {
    state.sending = on;
    fieldset.disabled = on;
    form.setAttribute('aria-busy', String(on));
    submit.dataset.i18n = on ? 'contact.sending' : 'contact.submit';
    submit.textContent = t(submit.dataset.i18n);
  }

  function loadScript() {
    if (window.turnstile) return Promise.resolve();
    if (!state.scriptPromise) {
      state.scriptPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = TURNSTILE_SRC;
        s.async = true;
        s.onload = () => (window.turnstile ? resolve() : reject(new Error('turnstile missing')));
        s.onerror = () => reject(new Error('turnstile load failed'));
        document.head.appendChild(s);
      }).catch((e) => { state.scriptPromise = null; throw e; });
    }
    return state.scriptPromise;
  }
  function gotToken(token) {
    state.token = token;
    state.waiters.splice(0).forEach((w) => w(token));
  }
  function renderWidget() {
    if (state.widgetId !== null || !window.turnstile) return;
    state.widgetId = window.turnstile.render(slot, {
      sitekey: TURNSTILE_SITE_KEY,
      language: getLang(),
      theme: 'auto',
      size: 'flexible',
      appearance: 'always',
      callback: gotToken,
      'expired-callback': () => { state.token = ''; },
      'timeout-callback': () => { state.token = ''; },
      'error-callback': () => {
        state.token = '';
        state.waiters.splice(0).forEach((w) => w(''));
        if (!state.sending) setStatus('contact.err.captchaFailed');
      },
    });
  }
  async function ensureWidget() {
    if (!isConfigured()) throw new Error('not configured');
    await loadScript();
    renderWidget();
  }
  function resetWidget() {
    state.token = '';
    if (state.widgetId !== null && window.turnstile) window.turnstile.reset(state.widgetId);
  }
  function waitForToken(ms) {
    if (state.token) return Promise.resolve(state.token);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), ms);
      state.waiters.push((tok) => { clearTimeout(timer); resolve(tok); });
    });
  }

  function readValues() {
    return { name: $('cf-name').value.trim(), email: $('cf-email').value.trim(), subject: $('cf-subject').value.trim(), message: $('cf-message').value.trim() };
  }
  function validate(v) {
    const bad = [];
    if (!v.name || v.name.length > LIMITS.name) bad.push('name');
    if (!v.email || v.email.length > LIMITS.email || !EMAIL_RE.test(v.email)) bad.push('email');
    if (v.subject.length > LIMITS.subject) bad.push('subject');
    if (v.message.length < LIMITS.messageMin || v.message.length > LIMITS.messageMax) bad.push('message');
    return bad;
  }
  function showFieldErrors(fields) {
    clearInvalid();
    const known = fields.filter((f) => FIELD_IDS[f]);
    if (!known.length) { setStatus('contact.err.server'); return; }
    const first = known.map(markInvalid)[0];
    setStatus(`contact.err.${known[0]}`);
    first?.focus();
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (state.sending) return;
    clearInvalid();
    setStatus(null);
    const values = readValues();
    const invalid = validate(values);
    if (invalid.length) { showFieldErrors(invalid); return; }
    if (!isConfigured()) {
      console.warn('Contact form disabled: TURNSTILE_SITE_KEY in js/config.js is still the placeholder.');
      setStatus('contact.err.unavailable');
      return;
    }

    setSending(true);
    try {
      await ensureWidget();
    } catch (err) {
      setSending(false);
      setStatus('contact.err.captchaLoad');
      return;
    }
    const token = await waitForToken(60000);
    if (!token) {
      setSending(false);
      resetWidget();
      setStatus('contact.err.captcha');
      return;
    }
    const payload = { ...values, lang: getLang(), token, website: $('cf-website').value, startedAt: state.startedAt };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res = null;
    let data = null;
    try {
      res = await fetch(CONTACT_API_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      data = await res.json().catch(() => null);
    } catch (err) {
      setSending(false);
      resetWidget();
      setStatus('contact.err.network');
      return;
    } finally {
      clearTimeout(timer);
    }
    setSending(false);
    resetWidget(); // a Turnstile token can be used only once
    if (res.ok && data?.ok) {
      form.reset();
      state.startedAt = Date.now();
      setStatus('contact.success', 'success');
      return;
    }
    if (data?.code === 'validation') { showFieldErrors(Array.isArray(data.fields) ? data.fields : []); return; }
    setStatus(SERVER_ERRORS[data?.code] || 'contact.err.server');
  }

  form.addEventListener('submit', onSubmit);
  form.querySelectorAll('input, textarea').forEach((el) => el.addEventListener('input', () => {
    if (el.hasAttribute('aria-invalid')) { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
  }));
  // Start loading the security check when the visitor begins to use the form.
  const warmUp = () => { if (isConfigured()) ensureWidget().catch(() => {}); };
  form.addEventListener('focusin', warmUp, { once: true });
  form.addEventListener('pointerdown', warmUp, { once: true });
  // The visible security check loads when the form scrolls into view (never while the page is only loading).
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => { if (entries.some((en) => en.isIntersecting)) { io.disconnect(); warmUp(); } }, { rootMargin: '200px' });
    io.observe(form);
  }
  document.addEventListener('languagechange', () => {
    if (state.statusKey) status.textContent = t(state.statusKey);
    submit.textContent = t(submit.dataset.i18n);
    if (state.widgetId !== null && window.turnstile && !state.sending) {
      window.turnstile.remove(state.widgetId);
      state.widgetId = null;
      state.token = '';
      renderWidget();
    }
  });
}

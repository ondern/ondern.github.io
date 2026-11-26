import { t, getLang } from './i18n.js';
import { CONTACT_API_URL, TURNSTILE_SITE_KEY } from './config.js';

// Cloudflare Turnstile is loaded only when the visitor starts using the form (never on page load).
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
// Keep these content rules identical to worker/src/index.js (the server is authoritative).
const LIMITS = { nameMin: 2, name: 80, email: 254, subject: 150, messageMin: 10, messageMax: 3000 };
const NAME_RE = /^\p{L}[\p{L}\p{M} .'’-]*$/u;
const LINK_RE = /(?:https?:\/\/|www\.)\S+/gi;
const MAX_LINKS = 2;
const MAX_REPEAT = 6;
const MAX_WORD = 60;
const hasRepeat = (s) => new RegExp('([^\\s])\\1{' + MAX_REPEAT + ',}', 'u').test(s);
const nameOk = (s) => s.length >= LIMITS.nameMin && s.length <= LIMITS.name && NAME_RE.test(s) && !hasRepeat(s);
const messageOk = (s) => s.length >= LIMITS.messageMin && s.length <= LIMITS.messageMax && !hasRepeat(s)
  && (s.match(LINK_RE) || []).length <= MAX_LINKS && !s.replace(LINK_RE, ' ').split(/\s+/).some((w) => w.length > MAX_WORD);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const FIELDS = ['name', 'email', 'subject', 'message'];
const FIELD_IDS = { name: 'cf-name', email: 'cf-email', subject: 'cf-subject', message: 'cf-message' };
// Permanent explanations that stay linked to their field (the e-mail field says that the message needs a confirmation by e-mail).
const HINTS = { email: 'cf-email-hint' };
// What is wrong with a value: the i18n key of the message that explains it, or null when the value is fine.
const CHECKS = {
  name: (v) => (!v ? 'contact.err.nameRequired' : nameOk(v) ? null : 'contact.err.name'),
  email: (v) => (!v ? 'contact.err.emailRequired' : v.length > LIMITS.email || !EMAIL_RE.test(v) ? 'contact.err.email' : null),
  subject: (v) => (v.length > LIMITS.subject ? 'contact.err.subject' : null),
  message: (v) => {
    if (!v) return 'contact.err.messageRequired';
    if (v.length < LIMITS.messageMin) return 'contact.err.messageShort';
    if (v.length > LIMITS.messageMax) return 'contact.err.messageLong';
    return messageOk(v) ? null : 'contact.err.message';
  },
};
// Shown when the server refuses a field that the page's own check accepted.
const FALLBACK = { name: 'contact.err.name', email: 'contact.err.email', subject: 'contact.err.subject', message: 'contact.err.message' };
// Messages that belong to the form as a whole. Field problems appear under their fields, security-check problems under the widget.
const SERVER_ERRORS = {
  too_fast: 'contact.err.tooFast', rate_limited: 'contact.err.rate', in_progress: 'contact.err.inProgress', server_error: 'contact.err.server',
  address_limit: 'contact.err.addressLimit',
};

const isConfigured = () => TURNSTILE_SITE_KEY && !/^REPLACE/i.test(TURNSTILE_SITE_KEY);
// A stalled connection must not leave the form locked forever when the Turnstile script never arrives.
const SCRIPT_TIMEOUT_MS = 20000;
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export function initContact() {
  const form = document.getElementById('contact-form');
  if (!form) return;
  const $ = (id) => document.getElementById(id);
  const fieldset = form.querySelector('fieldset');
  const submit = $('cf-submit');
  const status = $('cf-status'); // messages about the form as a whole: summary of field problems, send errors, confirmation
  const tsMsg = $('cf-turnstile-msg'); // messages about the security check (Cloudflare Turnstile), under the widget
  const slot = $('cf-turnstile');
  const resendBtn = $('cf-resend'); // asks for a new confirmation link while the message is waiting
  const state = {
    widgetId: null, token: '', scriptPromise: null, sending: false, startedAt: Date.now(), t0: performance.now(), waiters: [],
    statusKey: null, statusVars: undefined, summary: false, resendSecret: '', resendTimer: null, confirmEmail: '', errors: {}, serverFlagged: new Set(), submitted: false, tsKey: null, tsSticky: false,
  };

  // The instruction to confirm the e-mail address stays visible (no timer): the visitor needs it while switching to the mailbox.
  function setStatus(key, kind = 'error', summary = false, vars) {
    state.statusKey = key;
    state.statusVars = vars;
    state.summary = Boolean(key) && summary;
    status.textContent = key ? t(key, vars) : '';
    if (key) status.dataset.kind = kind; else delete status.dataset.kind;
  }
  // Security-check message under the widget. "Sticky" messages (the server refused the token) stay until the next attempt;
  // the others go away as soon as the widget delivers a token.
  function setTsMsg(key, kind = 'error', sticky = false) {
    state.tsKey = key;
    state.tsSticky = Boolean(key) && sticky;
    tsMsg.textContent = key ? t(key) : '';
    slot.toggleAttribute('data-failed', key === 'contact.err.captchaLoad');
    if (key) tsMsg.dataset.kind = kind; else delete tsMsg.dataset.kind;
  }

  const value = (field) => $(FIELD_IDS[field]).value.trim();
  function showFieldError(field, key) {
    const input = $(FIELD_IDS[field]);
    const msg = $(`cf-${field}-error`);
    if (key) {
      state.errors[field] = key;
      msg.textContent = t(key);
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', (HINTS[field] ? HINTS[field] + ' ' : '') + msg.id);
    } else {
      delete state.errors[field];
      msg.textContent = '';
      input.removeAttribute('aria-invalid');
      if (HINTS[field]) input.setAttribute('aria-describedby', HINTS[field]); else input.removeAttribute('aria-describedby');
    }
  }
  const clearFieldErrors = () => FIELDS.forEach((f) => showFieldError(f, null));
  // Checks every field and shows every problem at once; returns the fields with a problem, in form order.
  function validateAll() {
    state.serverFlagged.clear();
    return FIELDS.filter((f) => { const key = CHECKS[f](value(f)); showFieldError(f, key); return Boolean(key); });
  }
  // The summary above the button disappears as soon as no field has a problem any more.
  const dropSummaryIfFixed = () => { if (state.summary && !Object.keys(state.errors).length) setStatus(null); };
  function showServerValidation(fields) {
    const shown = FIELDS.filter((f) => fields.includes(f));
    shown.forEach((f) => {
      const key = CHECKS[f](value(f));
      if (!key) state.serverFlagged.add(f); // the page found nothing wrong: keep the server's message until the visitor edits the field
      showFieldError(f, key || FALLBACK[f]);
    });
    if (fields.includes('token')) setTsMsg('contact.err.captchaFailed', 'error', true);
    if (shown.length) { setStatus('contact.err.fix', 'error', true); $(FIELD_IDS[shown[0]]).focus(); }
    else if (!fields.includes('token')) setStatus('contact.err.server');
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
        s.onload = () => {
          if (!window.turnstile) { reject(new Error('turnstile missing')); return; }
          resolve();
          try { renderWidget(); } catch (e) { /* the next attempt renders it again */ } // also when the script arrives after the wait gave up
        };
        s.onerror = () => reject(new Error('turnstile load failed'));
        document.head.appendChild(s);
      }).catch((e) => { state.scriptPromise = null; throw e; });
    }
    return state.scriptPromise;
  }
  function gotToken(token) {
    state.token = token;
    if (state.tsKey && !state.tsSticky) setTsMsg(null); // "in progress", "could not load" and "failed" are over
    state.waiters.splice(0).forEach((w) => w(token));
  }
  function renderWidget() {
    if (state.widgetId !== null || !window.turnstile) return;
    state.widgetId = window.turnstile.render(slot, {
      sitekey: TURNSTILE_SITE_KEY,
      action: 'contact', // the Worker rejects tokens issued for any other action
      language: getLang(),
      theme: 'auto',
      size: 'flexible',
      appearance: 'always',
      callback: gotToken,
      'expired-callback': () => { state.token = ''; },
      'timeout-callback': () => { state.token = ''; },
      'error-callback': () => {
        state.token = '';
        setTsMsg('contact.err.captchaFailed', 'error');
        state.waiters.splice(0).forEach((w) => w(''));
      },
    });
  }
  async function ensureWidget() {
    if (!isConfigured()) throw new Error('not configured');
    // The pending script promise is kept on timeout, so a retry waits for the same download instead of adding a second script tag.
    await withTimeout(loadScript(), SCRIPT_TIMEOUT_MS);
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

  // Resend button: a new link for the message that is waiting. It becomes available a minute after the last mail (the Worker enforces
  // the same wait and a maximum of three mails per message).
  const RESEND_WAIT_MS = 60000;
  function hideResend() {
    clearTimeout(state.resendTimer);
    state.resendSecret = '';
    resendBtn.hidden = true;
    resendBtn.disabled = false;
  }
  function holdResend() {
    resendBtn.hidden = false;
    resendBtn.disabled = true;
    clearTimeout(state.resendTimer);
    state.resendTimer = setTimeout(() => { resendBtn.disabled = false; }, RESEND_WAIT_MS);
  }
  // The message is stored for 15 minutes until the visitor opens the link in the confirmation e-mail.
  function showPending(email, secret) {
    hideResend();
    setStatus('contact.success', 'success', false, { email });
    if (typeof secret === 'string' && secret) { state.resendSecret = secret; holdResend(); }
  }
  async function onResend() {
    if (!state.resendSecret || resendBtn.disabled) return;
    resendBtn.disabled = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res = null;
    let data = null;
    try {
      res = await fetch(`${CONTACT_API_URL}/resend`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resend: state.resendSecret }),
        signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      data = await res.json().catch(() => null);
    } catch (err) {
      resendBtn.disabled = false;
      setStatus('contact.err.network');
      return;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok && data?.ok) { setStatus('contact.resendDone', 'success', false, { email: state.confirmEmail }); holdResend(); return; }
    const code = data?.code;
    if (code === 'invalid_token') { hideResend(); setStatus('contact.err.expired'); return; }
    if (code === 'resend_limit') { hideResend(); setStatus('contact.err.resendLimit'); return; }
    if (code === 'address_limit') { hideResend(); setStatus('contact.err.addressLimit'); return; }
    if (code === 'rate_limited') { holdResend(); setStatus('contact.err.resendWait'); return; }
    resendBtn.disabled = false;
    setStatus('contact.err.server');
  }

  async function onSubmit(e) {    e.preventDefault();
    if (state.sending) return;
    state.submitted = true;
    hideResend();
    setStatus(null);
    if (state.tsSticky) setTsMsg(null); // a refusal from the previous attempt; problems the widget reports itself stay visible
    const bad = validateAll();
    if (bad.length) {
      setStatus('contact.err.fix', 'error', true);
      $(FIELD_IDS[bad[0]]).focus();
      return;
    }
    if (!isConfigured()) {
      console.warn('Contact form disabled: TURNSTILE_SITE_KEY in js/config.js is still the placeholder.');
      setStatus('contact.err.unavailable');
      return;
    }
    const values = Object.fromEntries(FIELDS.map((f) => [f, value(f)]));

    setSending(true);
    try {
      await ensureWidget();
    } catch (err) {
      setSending(false);
      setTsMsg('contact.err.captchaLoad', 'error');
      return;
    }
    if (!state.token) setTsMsg('contact.waiting', 'info'); // the challenge is still running (slow link): say so instead of showing nothing
    const token = await waitForToken(60000);
    if (!token) {
      setSending(false);
      resetWidget();
      if (state.tsKey !== 'contact.err.captchaFailed') setTsMsg('contact.err.captcha', 'error'); // keep the widget's own, more specific message
      return;
    }
    const payload = { ...values, lang: getLang(), token, website: $('cf-website').value, startedAt: state.startedAt, elapsedMs: Math.round(performance.now() - state.t0) };
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
      state.confirmEmail = values.email;
      form.reset();
      clearFieldErrors();
      state.submitted = false;
      state.startedAt = Date.now();
      state.t0 = performance.now();
      showPending(values.email, data.resend);
      return;
    }
    if (data?.code === 'validation') { showServerValidation(Array.isArray(data.fields) ? data.fields : []); return; }
    if (data?.code === 'too_large') { showServerValidation(['message']); return; }
    if (data?.code === 'captcha_failed') { setTsMsg('contact.err.captchaFailed', 'error', true); return; }
    setStatus(SERVER_ERRORS[data?.code] || 'contact.err.server');
  }

  form.addEventListener('submit', onSubmit);
  resendBtn.addEventListener('click', onResend);
  const fieldOf = (el) => FIELDS.find((f) => FIELD_IDS[f] === el.id);
  // While a field has a problem, every keystroke re-checks it: the message changes with the problem and disappears once it is fixed.
  form.addEventListener('input', (e) => {
    const f = fieldOf(e.target);
    if (!f) return;
    state.serverFlagged.delete(f);
    if (!state.errors[f]) return;
    showFieldError(f, CHECKS[f](value(f)));
    dropSummaryIfFixed();
  });
  // After a first attempt, leaving a field checks it too (so a field that was fine and has been emptied is flagged).
  form.addEventListener('focusout', (e) => {
    const f = fieldOf(e.target);
    if (!f || !state.submitted || state.sending || state.serverFlagged.has(f)) return;
    showFieldError(f, CHECKS[f](value(f)));
    dropSummaryIfFixed();
  });
  // Start loading the security check when the visitor begins to use the form; if that fails, say so under the widget right away.
  const warmUp = () => { if (isConfigured()) ensureWidget().catch(() => setTsMsg('contact.err.captchaLoad', 'error')); };
  form.addEventListener('focusin', warmUp, { once: true });
  form.addEventListener('pointerdown', warmUp, { once: true });
  // The visible security check loads when the form scrolls into view (never while the page is only loading).
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => { if (entries.some((en) => en.isIntersecting)) { io.disconnect(); warmUp(); } }, { rootMargin: '200px' });
    io.observe(form);
  }
  document.addEventListener('languagechange', () => {
    if (state.statusKey) status.textContent = t(state.statusKey, state.statusVars);
    FIELDS.forEach((f) => { if (state.errors[f]) $(`cf-${f}-error`).textContent = t(state.errors[f]); });
    if (state.tsKey) tsMsg.textContent = t(state.tsKey);
    submit.textContent = t(submit.dataset.i18n);
    if (state.widgetId !== null && window.turnstile && !state.sending) {
      window.turnstile.remove(state.widgetId);
      state.widgetId = null;
      state.token = '';
      renderWidget();
    }
  });
}

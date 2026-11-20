const SUPPORTED = ['en', 'de', 'tr'];
const DEFAULT = 'en';
const cache = {};
let current = DEFAULT;
let dict = {};

export const getLang = () => current;

function pickInitial() {
  const q = new URLSearchParams(location.search).get('lang');
  if (SUPPORTED.includes(q)) return q;
  try {
    const s = localStorage.getItem('lang');
    if (SUPPORTED.includes(s)) return s;
  } catch (e) { /* storage unavailable */ }
  return DEFAULT;
}

async function load(lang) {
  if (!cache[lang]) {
    const res = await fetch(`i18n/${lang}.json`);
    if (!res.ok) throw new Error(`i18n ${lang} ${res.status}`);
    cache[lang] = await res.json();
  }
  return cache[lang];
}

export function t(key, vars) {
  let s = dict[key] ?? cache[DEFAULT]?.[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    const vars = el.hasAttribute('data-year') ? { year: new Date().getFullYear() } : undefined;
    el.textContent = t(key, vars);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((pair) => {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
    });
  });
}

export async function setLang(lang, { persist = true } = {}) {
  if (!SUPPORTED.includes(lang)) lang = DEFAULT;
  if (lang !== DEFAULT) await load(DEFAULT).catch(() => {});
  dict = await load(lang);
  current = lang;
  document.documentElement.lang = lang;
  document.title = t(document.querySelector('title')?.dataset.i18n || 'meta.title');
  const desc = document.querySelector('meta[name="description"]');
  if (desc) {
    desc.setAttribute('content', t('meta.description'));
  }
  applyTranslations();
  document.querySelectorAll('[data-lang-select]').forEach((s) => { s.value = lang; });
  if (persist) {
    try { localStorage.setItem('lang', lang); } catch (e) { /* ignore */ }
    const url = new URL(location.href);
    url.searchParams.set('lang', lang);
    history.replaceState(history.state, '', url);
  }
  document.dispatchEvent(new CustomEvent('languagechange', { detail: { lang } }));
}

export async function initI18n() {
  await setLang(pickInitial(), { persist: false });
  document.querySelectorAll('[data-lang-select]').forEach((sel) => {
    sel.addEventListener('change', () => setLang(sel.value));
  });
}
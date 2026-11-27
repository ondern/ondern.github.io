import { t } from './i18n.js';
import { formatDate } from './ui.js';

const TYPES = ['certification', 'badge', 'learning'];
const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
const isLocalAsset = (u) => typeof u === 'string' && /^assets\/[\w./-]+\.(webp|png|jpe?g)$/i.test(u);
// Month-precision dates (YYYY-MM) compare as strings; a credential is expired once its month has passed.
const isExpired = (i) => !!i.expiresOn && i.expiresOn.slice(0, 7) < new Date().toISOString().slice(0, 7);

const state = { items: [], q: '', provider: '', type: '', sort: 'featured', showAll: false };
const filtersActive = () => !!(state.q.trim() || state.provider || state.type);
const hasFeatured = () => state.items.some((i) => i.featured);
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => { if (v != null) n[k] = v; });
  children.forEach((c) => n.append(c));
  return n;
}

function matches(item) {
  if (state.provider && item.issuer !== state.provider) return false;
  if (state.type && item.type !== state.type) return false;
  const q = state.q.trim().toLocaleLowerCase();
  if (!q) return true;
  return [item.title, item.issuer, item.type, item.notes].filter(Boolean).join(' ').toLocaleLowerCase().includes(q);
}

function compare(a, b) {
  if (state.sort === 'featured') {
    const d = (a.featuredOrder ?? 999) - (b.featuredOrder ?? 999);
    if (d) return d;
    return (b.issuedOn || '').localeCompare(a.issuedOn || '') || a.title.localeCompare(b.title);
  }
  if (state.sort === 'name') return a.title.localeCompare(b.title);
  if (state.sort === 'provider') return a.issuer.localeCompare(b.issuer) || a.title.localeCompare(b.title);
  return (b.issuedOn || '').localeCompare(a.issuedOn || '') || a.title.localeCompare(b.title);
}

function fillSelects() {
  const prov = $('cred-provider');
  const type = $('cred-type');
  const pv = state.provider; const tv = state.type;
  prov.replaceChildren(el('option', { value: '', textContent: t('cred.all') }),
    ...[...new Set(state.items.map((i) => i.issuer))].sort().map((p) => el('option', { value: p, textContent: p })));
  type.replaceChildren(el('option', { value: '', textContent: t('cred.all') }),
    ...TYPES.filter((x) => state.items.some((i) => i.type === x)).map((x) => el('option', { value: x, textContent: t(`cred.type.${x}`) })));
  prov.value = pv; type.value = tv;
}

function showDetail(item) {
  const body = $('cred-dialog-body');
  const rows = [[t('cred.issuer'), item.issuer], [t('cred.type'), t(`cred.type.${item.type}`)]];
  if (item.issuedOn) rows.push([item.type === 'learning' ? t('cred.completed') : t('cred.issued'), formatDate(item.issuedOn)]);
  if (item.expiresOn) rows.push([isExpired(item) ? t('cred.expired') : t('cred.expires'), formatDate(item.expiresOn)]);
  if (item.credentialId) rows.push([t('cred.id'), item.credentialId]);
  if (item.source) rows.push([t('cred.source'), item.source]);
  const dl = el('dl');
  rows.forEach(([k, v]) => dl.append(el('dt', { textContent: k }), el('dd', { textContent: v })));
  const parts = [el('h3', { id: 'cred-dialog-title', tabIndex: -1, textContent: item.title }), dl];
  if (item.notes) parts.push(el('p', { textContent: item.notes }));
  if (item.noteKey === 'completion') parts.push(el('p', { className: 'meta', textContent: t('cred.note.completion') }));
  if (isHttps(item.credentialUrl)) {
    parts.push(el('p', {}, el('a', { href: item.credentialUrl, target: '_blank', rel: 'noopener', textContent: t('cred.verify') })));
  }
  if (item.imageAttribution) parts.push(el('p', { className: 'meta', textContent: item.imageAttribution }));
  const di = item.documentImage;
  if (di && isLocalAsset(di.src)) {
    parts.push(el('figure', { className: 'doc-figure' },
      el('img', { src: di.src, width: di.width, height: di.height, loading: 'lazy', alt: t('cred.imageAlt', { name: item.title }) }),
      el('figcaption', { className: 'meta', textContent: t('cred.imageNote') })));
  }
  body.replaceChildren(...parts);
  const dlg = $('cred-dialog');
  dlg.classList.toggle('wide', Boolean(di && isLocalAsset(di.src))); // larger dialog so certificate text stays readable
  dlg.setAttribute('aria-labelledby', 'cred-dialog-title');
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  // Start at the top (tall certificate images would otherwise scroll the dialog to the Close button).
  dlg.scrollTop = 0;
  document.getElementById('cred-dialog-title').focus({ preventScroll: true });
}

function render() {
  const grid = $('cred-grid');
  const status = $('cred-status');
  grid.setAttribute('aria-label', t('cred.title'));
  if (!state.items.length) { grid.replaceChildren(); status.textContent = t('cred.emptyData'); return; }
  // Default view is the curated selection; searching or filtering looks through everything.
  const curated = hasFeatured() && !state.showAll && !filtersActive();
  const list = state.items.filter((i) => matches(i) && (!curated || i.featured)).sort(compare);
  // Entries hidden on screen stay in the DOM so a printout (also print emulation, where beforeprint may not fire) lists all of them; CSS shows them only in print.
  const shown = new Set(list);
  const all = [...state.items].sort(compare);
  status.textContent = list.length ? t('cred.count', { n: list.length }) : t('cred.empty');
  const toggle = $('cred-toggle');
  toggle.hidden = !hasFeatured() || filtersActive();
  toggle.textContent = state.showAll ? t('cred.showSelected') : t('cred.showAll', { n: state.items.length });
  grid.replaceChildren(...all.map((item) => {
    const btn = el('button', { type: 'button', className: 'card cred-card' });
    btn.setAttribute('aria-label', t('cred.open', { name: item.title }));
    if (isHttps(item.imageUrl)) {
      const img = el('img', { src: item.imageUrl, alt: '', loading: 'lazy', width: 72, height: 72 });
      btn.append(img);
    }
    btn.append(el('span', { className: 'tag', textContent: t(`cred.type.${item.type}`) }),
      el('h3', { textContent: item.title }),
      el('span', { className: 'meta', textContent: [item.issuer, item.issuedOn && formatDate(item.issuedOn), isExpired(item) && t('cred.expiredOn', { date: formatDate(item.expiresOn) })].filter(Boolean).join(' · ') }));
    btn.addEventListener('click', () => showDetail(item));
    return el('li', { className: shown.has(item) ? '' : 'cred-print-only' }, btn);
  }));
}

function valid(i) {
  return i && typeof i.title === 'string' && typeof i.issuer === 'string' && TYPES.includes(i.type);
}

export async function initCredentials() {
  if (!$('cred-grid')) return;
  const status = $('cred-status');
  try {
    const res = await fetch('/data/credentials.json');
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    state.items = (Array.isArray(data.items) ? data.items : []).filter(valid);
  } catch (e) {
    status.textContent = t('cred.error');
    status.classList.add('is-error');
    return;
  }
  fillSelects();
  render();
  $('cred-controls').addEventListener('submit', (e) => e.preventDefault());
  $('cred-search').addEventListener('input', (e) => { state.q = e.target.value; render(); });
  $('cred-provider').addEventListener('change', (e) => { state.provider = e.target.value; render(); });
  $('cred-type').addEventListener('change', (e) => { state.type = e.target.value; render(); });
  $('cred-sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  $('cred-toggle').addEventListener('click', () => { state.showAll = !state.showAll; render(); });
  // Re-render labels in the new language; filter and search state stays intact.
  document.addEventListener('languagechange', () => { fillSelects(); render(); });
}

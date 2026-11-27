export function initTheme() {
  const root = document.documentElement;
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) { /* ignore */ }
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#12151b' : '#f7f9fc');
    });
  });
}
// Floating "back to top" button: shown once the hero section has scrolled out of view (IntersectionObserver, no scroll listener).
export function initBackToTop() {
  const btn = document.querySelector('.back-to-top');
  const hero = document.getElementById('top');
  if (!btn || !hero || !('IntersectionObserver' in window)) return;
  new IntersectionObserver(([en]) => { btn.hidden = en.isIntersecting; }).observe(hero);
}
export function initNav() {
  const btn = document.getElementById('menu-btn');
  const nav = document.getElementById('primary-nav');
  if (!btn || !nav) return;
  const close = () => { nav.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    btn.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) { close(); btn.focus(); }
  });
  // Close the menu when the layout switches to the wide variant (e.g. rotation).
  matchMedia('(min-width: 75.01rem)').addEventListener('change', (e) => { if (e.matches) close(); });

  // Active section via IntersectionObserver (no scroll listeners).
  const links = new Map([...nav.querySelectorAll('a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      links.forEach((a) => a.removeAttribute('aria-current'));
      links.get(en.target.id)?.setAttribute('aria-current', 'true');
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  links.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
}

export function initReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('is-visible')); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-visible'); io.unobserve(en.target); } });
  }, { threshold: 0.12 });
  els.forEach((e) => io.observe(e));
}

// en-GB gives "17 December 2016"; de-DE "17. Dezember 2016"; tr-TR "17 Aralık 2016".
const LOCALES = { en: 'en-GB', de: 'de-DE', tr: 'tr-TR' };

export function formatDate(iso) {
  const monthOnly = /^\d{4}-\d{2}$/.test(iso);
  const d = new Date(monthOnly ? `${iso}-01T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts = monthOnly ? { year: 'numeric', month: 'short' } : { year: 'numeric', month: 'long', day: 'numeric' };
  return new Intl.DateTimeFormat(LOCALES[document.documentElement.lang] || document.documentElement.lang, { ...opts, timeZone: 'UTC' }).format(d);
}
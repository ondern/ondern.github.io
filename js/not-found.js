// Language for the 404 page. The page is a plain static file (it can be opened at any depth), so its three texts live here
// instead of in the i18n files. Order of choice: the language the visitor picked on the site, then the language section of
// the address (/de/..., /tr/...), then the browser language, then English.
(function () {
  var TEXT = {
    en: { title: 'Page not found | Önder Nuray', h1: 'Page not found', p: 'The page you are looking for could not be found. The address may be mistyped, or the page may have been moved or removed.', home: 'Back to the homepage', href: '/' },
    de: { title: 'Seite nicht gefunden | Önder Nuray', h1: 'Seite nicht gefunden', p: 'Die gesuchte Seite wurde nicht gefunden. Möglicherweise wurde die Adresse falsch eingegeben oder die Seite wurde verschoben oder entfernt.', home: 'Zur Startseite', href: '/de/' },
    tr: { title: 'Sayfa bulunamadı | Önder Nuray', h1: 'Sayfa bulunamadı', p: 'Aradığınız sayfa bulunamadı. Adres yanlış yazılmış olabilir ya da sayfa taşınmış veya kaldırılmış olabilir.', home: 'Ana sayfaya dön', href: '/tr/' },
  };
  var lang = null;
  try { var s = localStorage.getItem('lang'); if (TEXT[s]) lang = s; } catch (e) { /* storage unavailable */ }
  if (!lang) { var m = location.pathname.match(/^\/(de|tr)(\/|$)/); if (m) lang = m[1]; }
  if (!lang) { var b = String(navigator.language || '').slice(0, 2).toLowerCase(); if (TEXT[b]) lang = b; }
  if (!lang) lang = 'en';
  var t = TEXT[lang];
  document.documentElement.lang = lang;
  document.title = t.title;
  document.getElementById('nf-title').textContent = t.h1;
  document.getElementById('nf-text').textContent = t.p;
  var home = document.getElementById('nf-home');
  home.textContent = t.home;
  home.setAttribute('href', t.href);
})();

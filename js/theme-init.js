// Runs before first paint (loaded synchronously in <head>) to avoid a theme flash.
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  // Clickjacking guard: GitHub Pages cannot send X-Frame-Options or CSP frame-ancestors (a meta CSP ignores it),
  // so a page shown inside another site's frame hides itself and tries to open in the top window instead.
  // Local previews (localhost) are exempt so editor preview panes keep working.
  var framed = false;
  try { framed = window.self !== window.top; } catch (e) { framed = true; }
  if (framed && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    root.style.setProperty('display', 'none', 'important');
    try { window.top.location.replace(window.self.location.href); } catch (e) { /* blocked by the browser: the page stays hidden */ }
  }
  try {
    var t = localStorage.getItem('theme');
    if (t !== 'light' && t !== 'dark') {
      t = 'light'; // default is always light; the OS theme is not followed
    }
    root.dataset.theme = t;
  } catch (e) {
    root.dataset.theme = 'light';
  }
  // Browser toolbar colour (mobile) follows the page theme; ui.js keeps it in sync when the visitor switches.
  var tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute('content', root.dataset.theme === 'dark' ? '#12151b' : '#f7f9fc');
})();
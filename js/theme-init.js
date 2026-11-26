// Runs before first paint (loaded synchronously in <head>) to avoid a theme flash.
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  try {
    var t = localStorage.getItem('theme');
    if (t !== 'light' && t !== 'dark') {
      t = 'light'; // default is always light; the OS theme is not followed
    }
    root.dataset.theme = t;
  } catch (e) {
    root.dataset.theme = 'light';
  }
})();
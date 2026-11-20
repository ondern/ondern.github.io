import { initI18n } from './i18n.js';
import { initTheme, initNav, initReveal } from './ui.js';
import { initCredentials } from './credentials.js';
import { initGithub } from './github.js';

async function main() {
  initTheme();
  try { await initI18n(); } catch (e) { /* page keeps its built-in English text */ }
  initNav();
  // The contact form is intentionally inactive: it never submits or sends anything.
  document.getElementById('contact-form')?.addEventListener('submit', (e) => e.preventDefault());
  initReveal();
  // Optional data sources: failures are handled inside each module and never block the page.
  initCredentials();
  initGithub();
}

main();

import { initI18n } from './i18n.js';
import { initTheme, initNav, initReveal } from './ui.js';
import { initCredentials } from './credentials.js';
import { initGithub } from './github.js';
import { initContact } from './contact.js';

async function main() {
  initTheme();
  try { await initI18n(); } catch (e) { /* page keeps its built-in English text */ }
  initNav();
  initContact();
  initReveal();
  // Optional data sources: failures are handled inside each module and never block the page.
  initCredentials();
  initGithub();
}

main();

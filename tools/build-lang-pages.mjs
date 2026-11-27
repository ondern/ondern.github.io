// Generates the localized entry pages de/index.html and tr/index.html from index.html and i18n/*.json.
// They give search engines one crawlable URL per language. Run `npm run build:lang` after editing the head of
// index.html or meta.* in i18n/*.json; `npm run test:lang` fails when the generated files are out of date.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const SITE = 'https://nuray.io';
const LOCALES = { de: 'de_DE', tr: 'tr_TR' };
const check = process.argv.includes('--check');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const dict = (l) => JSON.parse(readFileSync(`i18n/${l}.json`, 'utf8'));
const src = readFileSync('index.html', 'utf8');
const en = dict('en');
let bad = 0;

function swap(html, from, to, label) {
  if (!html.includes(from)) { console.error(`build-lang-pages: anchor not found in index.html: ${label}`); process.exit(1); }
  return html.split(from).join(to);
}

for (const [lang, locale] of Object.entries(LOCALES)) {
  const d = dict(lang);
  let h = src;
  h = swap(h, '<html lang="en">', `<html lang="${lang}">`, 'html lang');
  h = swap(h, `>${esc(en['meta.title'])}</title>`, `>${esc(d['meta.title'])}</title>`, 'title');
  h = swap(h, `content="${esc(en['meta.title'])}"`, `content="${esc(d['meta.title'])}"`, 'meta titles');
  h = swap(h, `content="${esc(en['meta.description'])}"`, `content="${esc(d['meta.description'])}"`, 'meta descriptions');
  h = swap(h, `content="${esc(en['hero.photo'])}"`, `content="${esc(d['hero.photo'])}"`, 'og:image:alt');
  h = swap(h, `<link rel="canonical" href="${SITE}/">`, `<link rel="canonical" href="${SITE}/${lang}/">`, 'canonical');
  h = swap(h, `<meta property="og:url" content="${SITE}/">`, `<meta property="og:url" content="${SITE}/${lang}/">`, 'og:url');
  h = swap(h, '<meta property="og:locale" content="en_US">', `<meta property="og:locale" content="${locale}">`, 'og:locale');
  // The page sits one directory deeper: make site-relative asset paths root-relative.
  h = h.replace(/\b(href|src|srcset)="([^"]*)"/g, (m, a, v) => `${a}="${v.replace(/(^|,\s*)(assets|css|js)\//g, '$1/$2/')}"`);
  const file = `${lang}/index.html`;
  if (check) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== h) { console.error(`build-lang-pages: ${file} is out of date (run npm run build:lang)`); bad++; }
  } else {
    mkdirSync(lang, { recursive: true });
    writeFileSync(file, h);
    console.log(`wrote ${file}`);
  }
}
if (check) { if (bad) process.exit(1); console.log('localized pages: PASS'); }

// Verifies translation key parity and that every key used in HTML exists.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { denylistLoaded, findPrivate } from './denylist.mjs';

const langs = ['en', 'de', 'tr'];
const dicts = Object.fromEntries(langs.map((l) => [l, JSON.parse(readFileSync(`i18n/${l}.json`, 'utf8'))]));
let failed = 0;
const fail = (m) => { console.log('FAIL', m); failed++; };

for (const l of ['de', 'tr']) {
  for (const k of Object.keys(dicts.en)) if (!(k in dicts[l])) fail(`${l} missing key ${k}`);
  for (const k of Object.keys(dicts[l])) if (!(k in dicts.en)) fail(`${l} has extra key ${k}`);
  for (const [k, v] of Object.entries(dicts[l])) {
    if (!String(v).trim()) fail(`${l} empty value ${k}`);
    const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join();
    if (ph(v) !== ph(dicts.en[k])) fail(`${l} placeholder mismatch ${k}`);
  }
}
for (const file of ['index.html']) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) if (!(m[1] in dicts.en)) fail(`${file}: unknown key ${m[1]}`);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(';')) if (!(pair.split(':')[1] in dicts.en)) fail(`${file}: unknown attr key ${pair}`);
  }
}
// The static English fallback of the footer notice must match en.json.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
for (const m of readFileSync('index.html', 'utf8').matchAll(/<p [^>]*data-i18n="(footer\.notice)"[^>]*>([^<]*)<\/p>/g)) {
  if (m[2] !== esc(dicts.en[m[1]])) fail('index.html fallback differs from en.json: ' + m[1]);
}
for (const f of ['data/credentials.json', 'data/projects.json']) {
  try { JSON.parse(readFileSync(f, 'utf8')); } catch (e) { fail(`${f} invalid JSON`); }
}
// Credential data integrity and asset hygiene.
const creds = JSON.parse(readFileSync('data/credentials.json', 'utf8')).items;
const seen = new Set();
const referenced = new Set();
for (const i of creds) {
  const id = `${i.issuer}|${i.title}`;
  if (seen.has(id)) fail(`duplicate credential ${id}`); seen.add(id);
  if (!i.title || !i.issuer || !['certification', 'badge', 'learning'].includes(i.type)) fail(`bad required fields: ${i.title}`);
  for (const k of ['issuedOn', 'expiresOn']) if (i[k] && !/^\d{4}-\d{2}(-\d{2})?$/.test(i[k])) fail(`${i.title}: bad ${k}`);
  if (i.issuedOn && i.expiresOn && i.expiresOn < i.issuedOn) fail(`${i.title}: expires before issue`);
  if (i.credentialUrl && !/^https:\/\//.test(i.credentialUrl)) fail(`${i.title}: credentialUrl not https`);
  if (i.documentImage) {
    referenced.add(i.documentImage.src);
    if (!existsSync(i.documentImage.src)) fail(`${i.title}: missing image ${i.documentImage.src}`);
    if (!(i.documentImage.width > 0 && i.documentImage.height > 0)) fail(`${i.title}: image size missing`);
  }
}
const EXACT = ['AWS Certified SysOps Administrator – Associate', 'AWS Certified Solutions Architect – Associate', 'AWS Certified Cloud Practitioner', 'Cisco Certified Design Associate (CCDA)', 'Cisco Certified Network Associate Security (CCNA Security)', 'Cisco Certified Network Associate Routing and Switching (CCNA Routing and Switching)', 'Goethe-Zertifikat A2 / Start Deutsch 2', 'Goethe-Zertifikat A1 / Start Deutsch 1'];
const featuredTitles = creds.filter((i) => i.featured).sort((a, b) => a.featuredOrder - b.featuredOrder).map((i) => i.title);
if (featuredTitles.join('|') !== EXACT.join('|')) fail('featured credentials differ from the requested eight/order: ' + featuredTitles.join(' | '));
const nFeatured = creds.filter((i) => i.featured).length;
if (nFeatured < 1 || nFeatured > 12) fail(`featured credentials should be a short selection (1-12), found ${nFeatured}`);
const htmlImgs = [...readFileSync('index.html', 'utf8').matchAll(/assets\/(?:img|icons)\/[\w./-]+\.(?:webp|svg)/g)].map((m) => m[0]);
for (const f of htmlImgs) if (!existsSync(f)) fail(`missing image referenced by index.html: ${f}`);
const allowed = new Set([...htmlImgs, ...referenced]);
// Skill chips: no duplicate labels within a language.
for (const l of langs) {
  const labels = Object.entries(dicts[l]).filter(([k]) => /^skills\.(it|core)\.\d+$/.test(k)).map(([, v]) => v.toLowerCase());
  const dup = labels.filter((v, i) => labels.indexOf(v) !== i);
  if (dup.length) fail(`duplicate skill labels in ${l}: ${dup.join(', ')}`);
}
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
for (const f of walk('assets/img')) if (!allowed.has(f)) fail(`unreferenced or unexpected image: ${f}`);
// Privacy guard: no birth data or dd.mm.19xx dates in public text files.
const textFiles = [...walk('i18n'), ...walk('data'), ...walk('js'), 'index.html', 'README.md'];
for (const f of textFiles) {
  const t = readFileSync(f, 'utf8');
  const hits = findPrivate(t); if (hits && hits.length) fail(`private word(s) from the local denylist in ${f}`);
  if (/[\w.+-]+@[\w-]+\.[\w.-]+|mailto:/i.test(t)) fail(`email address or mail link in ${f}`);
  if (/\b\d{2}\.\d{2}\.(19[4-9]\d)\b/.test(t) || /Geburtsdatum|Date of birth|Place of birth|Geburtsort/i.test(t)) fail(`possible birth data in ${f}`);
}
// No copy-blocking: it cannot work reliably and harms accessibility.
for (const f of ['css/styles.css', ...walk('js')]) {
  const s = readFileSync(f, 'utf8');
  if (/user-select\s*:\s*none|-webkit-user-select\s*:\s*none|contextmenu|oncopy|addEventListener\(\s*['"](copy|cut|selectstart|dragstart)['"]/.test(s)) fail(`copy-blocking pattern in ${f}`);
}
// Privacy-first: no automatic third-party requests.
for (const f of [...walk('js'), 'index.html']) {
  const s = readFileSync(f, 'utf8');
  if (/api\.github\.com/.test(s)) fail('GitHub API reference in ' + f);
  if (/fetch\(\s*['"`]https?:/.test(s)) fail('absolute-URL fetch in ' + f);
  if (/<script[^>]+src="https?:|<link[^>]+href="https?:\/\/(?!nuray\.io)[^"]*"[^>]*rel="stylesheet"/.test(s)) fail('third-party script or stylesheet in ' + f);
}
if (!denylistLoaded) console.log('NOTE: tests/.private-denylist.txt not found; the private-word check was skipped.');
console.log(failed ? `i18n/data check: ${failed} problem(s)` : `i18n/data check: PASS (${Object.keys(dicts.en).length} keys x 3 languages)`);
process.exit(failed ? 1 : 0);

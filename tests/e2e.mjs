// End-to-end checks using playwright-core with the locally installed Microsoft Edge (Chromium).
// External services are never contacted; fixtures are served locally.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { findPrivate, denylistLoaded } from './denylist.mjs';

const ROOT = process.cwd();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };
const server = http.createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = join(ROOT, p === '' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !existsSync(file) || file.includes('node_modules')) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const results = [];
const record = (name, ok, detail = '') => { results.push([name, ok ? 'PASS' : 'FAIL', detail]); };
const browser = await chromium.launch({ channel: 'msedge' });

const FIXTURE = { items: [
  { title: 'Test Cert Alpha', issuer: 'Issuer One', type: 'certification', issuedOn: '2024-05-01', credentialUrl: 'https://example.com/a' },
  { title: 'Test Badge Beta', issuer: 'Issuer Two', type: 'badge', issuedOn: '2025-01-10' },
  { title: 'Test Course Gamma', issuer: 'Issuer One', type: 'learning', issuedOn: '2023-03-03' },
] };

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 800 }, reducedMotion: opts.reducedMotion, colorScheme: opts.colorScheme, bypassCSP: !!opts.bypassCSP });
  const page = await ctx.newPage();
  page.problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused/i.test(m.text())) page.problems.push(m.text()); });
  page.on('pageerror', (e) => page.problems.push(String(e)));
  page.hosts = new Set();
  page.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol)) page.hosts.add(u.host); });
  if (opts.credentials) await page.route('**/data/credentials.json', (r) => r.fulfill({ json: FIXTURE }));
    if (opts.projects) await page.route('**/data/projects.json', (r) => r.fulfill({ json: { featured: [
    { name: 'demo', snapshot: { description: 'A demo', pushedAt: '2025-01-01T00:00:00Z', retrieved: '2025-01-02' } },
    { name: 'ondern.github.io', snapshot: { description: 'Website', pushedAt: '2025-02-01T00:00:00Z', retrieved: '2025-01-02' } },
    { name: 'old', snapshot: { description: 'Old project', pushedAt: '2020-01-01T00:00:00Z', retrieved: '2025-01-02' } }] } }));
  await page.goto(base + (opts.path || '/'));
  await page.waitForLoadState('networkidle');
  return page;
}
if (!denylistLoaded) console.log('NOTE: tests/.private-denylist.txt not found; the private-word checks are reduced.');
const ONLY = (process.env.E2E_ONLY || '').split('|').filter(Boolean); // optional: run only tests whose name contains one of these fragments
const test = async (name, fn) => { if (ONLY.length && !ONLY.some((s) => name.includes(s))) return; try { const d = await fn(); record(name, true, d || ''); } catch (e) { record(name, false, String(e.message).split('\n')[0]); } };

await test('Page loads without console errors or CSP violations', async () => {
  const p = await newPage(); const probs = p.problems; await p.context().close();
  if (probs.length) throw new Error(probs.join(' | '));
});

await test('Language switch en/de/tr, html lang, persistence, ?lang', async () => {
  const p = await newPage();
  for (const [l, word] of [['de', 'Kontakt'], ['tr', 'İletişim'], ['en', 'Contact']]) {
    await p.selectOption('#lang-select', l);
    await p.waitForFunction((x) => document.documentElement.lang === x, l);
    const txt = await p.textContent('#contact-title');
    if (txt !== word) throw new Error(`${l}: got ${txt}`);
  }
  await p.selectOption('#lang-select', 'de');
  await p.reload(); await p.waitForLoadState('networkidle');
  if ((await p.textContent('#contact-title')) !== 'Kontakt') throw new Error('not persisted');
  await p.goto(base + '/?lang=tr'); await p.waitForLoadState('networkidle');
  if ((await p.getAttribute('html', 'lang')) !== 'tr') throw new Error('?lang ignored');
  await p.context().close();
});

await test('Theme toggle persists; default is light even when the OS prefers dark', async () => {
  const p = await newPage({ colorScheme: 'dark' });
  if ((await p.getAttribute('html', 'data-theme')) !== 'light') throw new Error('default must be light, the OS theme is not followed');
  await p.click('[data-theme-toggle]');
  await p.reload();
  if ((await p.getAttribute('html', 'data-theme')) !== 'dark') throw new Error('choice not persisted');
  await p.context().close();
});

const sizes = [[320, 640], [375, 667], [390, 844], [430, 932], [768, 1024], [1024, 768], [1280, 800], [1440, 900]];
await test('No horizontal overflow, all sizes, portrait + landscape, 3 languages', async () => {
  const bad = [];
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: `/?lang=${lang}` });
    for (const [w, h] of sizes) for (const [vw, vh] of [[w, h], [h, w]]) {
      await p.setViewportSize({ width: vw, height: vh });
      const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (o > 0) bad.push(`${lang} ${vw}x${vh} +${o}px`);
    }
    await p.context().close();
  }
  if (bad.length) throw new Error(bad.join(', '));
  return `${sizes.length * 2 * 3} viewport/language combinations (browser emulation)`;
});

await test('Mobile menu opens, closes on Escape and on link click', async () => {
  const p = await newPage({ viewport: { width: 375, height: 667 } });
  const nav = p.locator('#primary-nav');
  if (await nav.isVisible()) throw new Error('menu should start closed');
  await p.click('#menu-btn');
  if (!(await nav.isVisible()) || (await p.getAttribute('#menu-btn', 'aria-expanded')) !== 'true') throw new Error('did not open');
  await p.keyboard.press('Escape');
  if (await nav.isVisible()) throw new Error('Escape did not close');
  await p.click('#menu-btn'); await p.click('#primary-nav a[href="#skills"]');
  if (await nav.isVisible()) throw new Error('link click did not close');
  await p.context().close();
});

await test('Orientation change keeps language, theme and typed search input', async () => {
  const p = await newPage({ viewport: { width: 390, height: 844 }, path: '/?lang=de' });
  await p.click('[data-theme-toggle]');
  const theme = await p.getAttribute('html', 'data-theme');
  await p.fill('#cred-search', 'Hallo Welt');
  await p.setViewportSize({ width: 844, height: 390 });
  if ((await p.inputValue('#cred-search')) !== 'Hallo Welt') throw new Error('input lost');
  if ((await p.getAttribute('html', 'lang')) !== 'de' || (await p.getAttribute('html', 'data-theme')) !== theme) throw new Error('state lost');
  await p.context().close();
});

await test('Credentials: empty-data state (fixture with no items)', async () => {
  const ctx = await browser.newContext(); const p = await ctx.newPage();
  await p.route('**/data/credentials.json', (r) => r.fulfill({ json: { items: [] } }));
  await p.goto(base + '/'); await p.waitForLoadState('networkidle');
  const s = await p.textContent('#cred-status'); await ctx.close();
  if (!/No credentials have been added/.test(s)) throw new Error(s);
});

await test('Real credentials.json: 8 selected by default, 20 with show-all, expired marked, document images load', async () => {
  const p = await newPage();
  const n = await p.$$eval('#cred-grid .cred-card', (x) => x.length);
  if (n !== 8) throw new Error(`default view should show 8 selected cards, got ${n}`);
  if (!(await p.isVisible('#cred-toggle'))) throw new Error('show-all toggle missing');
  await p.click('#cred-toggle');
  const all = await p.$$eval('#cred-grid .cred-card', (x) => x.length);
  if (all !== 20) throw new Error(`show all: ${all}`);
  const txt = await p.textContent('#cred-grid');
  if (!/Expired Jul 2015/.test(txt)) throw new Error('expired marker missing');
  await p.click('#cred-toggle');
  if ((await p.$$eval('#cred-grid .cred-card', (x) => x.length)) !== 8) throw new Error('toggle back failed');
  for (const name of ['Apple Certified Support Professional 10.6', 'ITIL v3 Foundation', 'VMware Certified Professional (VCP5)', 'Certified Ethical Hacker v9.0 Training', 'Start Deutsch 1', 'Start Deutsch 2']) {
    await p.fill('#cred-search', name);
    await p.click('#cred-grid .cred-card >> nth=0');
    await p.waitForSelector('#cred-dialog img');
    await p.waitForFunction(() => { const i = document.querySelector('#cred-dialog img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 }).catch(() => {});
    const ok = await p.$eval('#cred-dialog img', (i) => i.complete && i.naturalWidth > 0 && i.alt.includes('certificate'));
    if (!ok) throw new Error(`image not loaded/alt missing: ${name}`);
    await p.keyboard.press('Escape');
  }
  // a Credly-backed item exposes its verification link and an expired label
  await p.fill('#cred-search', 'Cloud Practitioner'); await p.click('#cred-grid .cred-card >> nth=0');
  const href = await p.$eval('#cred-dialog a', (a) => a.href);
  const dt = await p.$$eval('#cred-dialog dt', (x) => x.map((e) => e.textContent).join('|'));
  await p.context().close();
  if (!href.startsWith('https://www.credly.com/badges/f6979a76-36ba-4dba-9659-08542e1b238a')) throw new Error(href);
  if (!/Expired/.test(dt)) throw new Error(dt);
});

await test('Real credentials: every link is https and associated with its own title (spot map)', async () => {
  const data = JSON.parse(readFileSync('data/credentials.json', 'utf8')).items;
  const bad = data.filter((i) => i.credentialUrl && !/^https:\/\//.test(i.credentialUrl)).map((i) => i.title);
  const ids = new Map();
  const isCredly = (u) => { try { const h = new URL(u).hostname; return h === 'credly.com' || h.endsWith('.credly.com'); } catch { return false; } };
  for (const i of data) if (i.credentialUrl && isCredly(i.credentialUrl)) { if (ids.has(i.credentialUrl)) bad.push('dup url ' + i.title); ids.set(i.credentialUrl, i.title); }
  if (bad.length) throw new Error(bad.join(', '));
  return `${data.length} credentials, ${[...ids].length} unique Credly URLs`;
});

await test('Profile content: 3 jobs, 2 degrees, portrait image, no placeholders (en/de/tr)', async () => {
  const exp = { en: 'May 2018 – present', de: 'Mai 2018 – heute', tr: 'Mayıs 2018 – Devam ediyor' };
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: `/?lang=${lang}` });
    const jobs = await p.$$eval('#experience .job', (x) => x.length);
    const degrees = await p.$$eval('#education .card', (x) => x.length);
    const first = await p.textContent('#experience .job .meta');
    const body = await p.textContent('body');
    const img = await p.$eval('.portrait', (i) => ({ ok: i.complete && i.naturalWidth > 0, alt: i.alt }));
    await p.context().close();
    if (jobs !== 3 || degrees !== 2) throw new Error(`${lang}: ${jobs} jobs, ${degrees} degrees`);
    if (!first.includes(exp[lang])) throw new Error(`${lang}: dates "${first}"`);
    if (/\[(Placeholder|Platzhalter|Yer tutucu)/i.test(body)) throw new Error(`${lang}: placeholder text still visible`);
    if (!img.ok || !img.alt.includes('Önder Nuray')) throw new Error(`${lang}: portrait ${JSON.stringify(img)}`);
  }
});

await test('Credentials (fixture data): search, filter, sort, dialog, language re-render', async () => {
  const p = await newPage({ credentials: true });
  const titles = () => p.$$eval('#cred-grid h3', (n) => n.map((x) => x.textContent));
  if ((await titles()).length !== 3) throw new Error('expected 3 cards');
  if ((await titles())[0] !== 'Test Badge Beta') throw new Error('date sort wrong');
  await p.fill('#cred-search', 'alpha');
  if ((await titles()).join() !== 'Test Cert Alpha') throw new Error('search wrong');
  await p.fill('#cred-search', ''); await p.selectOption('#cred-provider', 'Issuer One');
  if ((await titles()).length !== 2) throw new Error('provider filter wrong');
  await p.selectOption('#cred-sort', 'name');
  if ((await titles())[0] !== 'Test Cert Alpha') throw new Error('name sort wrong');
  await p.fill('#cred-search', 'zzzz');
  if (!/No credentials match/.test(await p.textContent('#cred-status'))) throw new Error('no-match state missing');
  await p.fill('#cred-search', '');
  await p.click('#cred-grid .cred-card >> nth=0');
  if (!(await p.isVisible('#cred-dialog'))) throw new Error('dialog not open');
  await p.keyboard.press('Escape');
  if (await p.isVisible('#cred-dialog')) throw new Error('Escape did not close dialog');
  await p.selectOption('#lang-select', 'de');
  if ((await p.inputValue('#cred-provider')) !== 'Issuer One') throw new Error('filter reset on language change');
  await p.context().close();
});

await test('Projects and activity come from local data: newest first, website repo excluded, no API', async () => {
  const p = await newPage({ projects: true });
  const t = await p.textContent('#proj-grid'); const a = await p.$$eval('#act-list li a', (n) => n.map((x) => x.textContent));
  const intro = await p.textContent('#act-intro'); const external = [...p.hosts].filter((h) => h !== new URL(base).host);
  await p.context().close();
  if (!/A demo/.test(t) || !/Old project/.test(t)) throw new Error('fixture projects missing');
  if (a.join() !== 'demo,old') throw new Error('activity order/exclusion wrong: ' + a.join());
  if (!/snapshot/.test(intro)) throw new Error('snapshot note missing: ' + intro);
  if (external.length) throw new Error('external hosts contacted: ' + external.join(', '));
});
await test('No automatic third-party requests on load (en/de/tr): only the site\'s own host', async () => {
  const seen = [];
  for (const path of ['/']) for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: path + '?lang=' + lang });
    await p.waitForTimeout(500);
    const external = [...p.hosts].filter((h) => h !== new URL(base).host);
    const n = p.hosts.size;
    await p.context().close();
    if (external.length) throw new Error(path + ' ' + lang + ': ' + external.join(', '));
    seen.push(n);
  }
  return 'only 1 host (localhost) in all 3 page loads';
});
await test('Real projects.json: 4 forks with fork tag, upstream links and local descriptions in en/de/tr', async () => {
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: `/?lang=${lang}` });
    const cards = await p.$$eval('#proj-grid .proj-card', (n) => n.map((c) => ({
      name: c.querySelector('h3').textContent, tag: c.querySelector('.tag')?.textContent,
      links: [...c.querySelectorAll('a')].map((a) => a.href), text: c.textContent })));
    await p.context().close();
    if (cards.map((c) => c.name).join() !== 'keenetic-sdk,Veto,adns,loophole') throw new Error(`${lang}: ${cards.map((c) => c.name)}`);
    const want = { 'keenetic-sdk': ['keenetic/keenetic-sdk', 'Makefile'], Veto: ['ProfessorQuantumUniverse/Veto', 'Kotlin'], adns: ['eyalm2000/adns', 'Kotlin'], loophole: ['eyalm2000/loophole', 'TypeScript'] };
    for (const c of cards) {
      if (!c.tag) throw new Error(`${c.name}: no fork tag`);
      if (!c.links.includes(`https://github.com/${want[c.name][0]}`)) throw new Error(`${c.name}: upstream link missing`);
      if (!c.links.includes(`https://github.com/ondern/${c.name}`)) throw new Error(`${c.name}: own link missing`);
      if (!c.text.includes(want[c.name][1])) throw new Error(`${c.name}: upstream language missing`);
    }
  }
});

await test('Pull requests: real data lists open and merged PRs in en/de/tr, links to github.com, website repo excluded', async () => {
  const data = JSON.parse(readFileSync('data/projects.json', 'utf8'));
  if (!data.pulls.length || data.pulls.some((x) => /^ondern\/ondern\.github\.io$/i.test(x.repo))) throw new Error('data/projects.json: no pulls or website repo present');
  if (data.featured.some((f) => f.name.toLowerCase() === 'ondern.github.io')) throw new Error('website repo listed in projects');
  const labels = { en: ['Pull requests', 'Open', 'Merged'], de: ['Pull Requests', 'Offen', 'Zusammengef\u00fchrt'], tr: ["Pull request'ler", 'A\u00e7\u0131k', 'Birle\u015ftirildi'] };
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: '/?lang=' + lang });
    const info = await p.evaluate(() => ({ visible: !document.getElementById('pr-wrap').hidden, heading: document.querySelector('#pr-wrap h3').textContent,
      items: [...document.querySelectorAll('#pr-list li')].map((li) => ({ href: li.querySelector('a').href, text: li.textContent, rel: li.querySelector('a').rel, target: li.querySelector('a').target })) }));
    await p.context().close();
    if (!info.visible || info.heading !== labels[lang][0]) throw new Error(lang + ': PR section/heading ' + info.heading);
    if (info.items.length !== data.pulls.length) throw new Error(lang + ': item count ' + info.items.length);
    data.pulls.forEach((pr, i) => {
      const it = info.items[i];
      if (it.href !== pr.url || !it.href.startsWith('https://github.com/') || !/noopener/.test(it.rel) || it.target !== '_blank') throw new Error(lang + ': link ' + pr.url);
      if (!it.text.includes(pr.title) || !it.text.includes(pr.repo + '#' + pr.number)) throw new Error(lang + ': text ' + pr.number);
      if (!it.text.includes(labels[lang][pr.state === 'open' ? 1 : 2])) throw new Error(lang + ': status label ' + pr.number);
    });
  }
});
await test('Pull requests: invalid or website-repo entries in the data are ignored; no entries hides the section', async () => {
  const route = (pulls) => ({ featured: [{ name: 'demo', snapshot: { description: 'A demo', pushedAt: '2025-01-01T00:00:00Z', retrieved: '2025-01-02' } }], pulls });
  const bad = [
    { repo: 'a/good', number: 1, title: 'Good <b>title</b>', url: 'https://github.com/a/good/pull/1', state: 'open', updatedAt: '2025-01-01T00:00:00Z' },
    { repo: 'ondern/ondern.github.io', number: 2, title: 'Website', url: 'https://github.com/ondern/ondern.github.io/pull/2', state: 'open' },
    { repo: 'a/evil', number: 3, title: 'Evil link', url: 'https://evil.example/x', state: 'open' },
    { repo: 'a/js', number: 4, title: 'js link', url: 'javascript:alert(1)', state: 'open' },
    { repo: 'a/closed', number: 5, title: 'Closed', url: 'https://github.com/a/closed/pull/5', state: 'closed' },
    { repo: 'bad repo', number: 6, title: 'Bad repo', url: 'https://github.com/a/b/pull/6', state: 'open' },
  ];
  for (const [pulls, expected] of [[bad, ['Good <b>title</b>']], [[], []]]) {
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    await p.route('**/data/projects.json', (r) => r.fulfill({ json: route(pulls) }));
    await p.goto(base + '/?lang=en'); await p.waitForLoadState('networkidle');
    const res = await p.evaluate(() => ({ hidden: document.getElementById('pr-wrap').hidden, titles: [...document.querySelectorAll('#pr-list li a')].map((a) => a.textContent), html: document.getElementById('pr-list').innerHTML }));
    await ctx.close();
    if (res.titles.join('|') !== expected.join('|')) throw new Error('titles: ' + res.titles);
    if (res.hidden !== (expected.length === 0)) throw new Error('hidden state ' + res.hidden);
    if (/<b>/.test(res.html)) throw new Error('title rendered as HTML');
  }
});
await test('Profile links: LinkedIn, GitHub, Credly exact and safe; no mail links', async () => {
  const p = await newPage();
  const links = await p.$$eval('a[href]', (a) => a.map((x) => ({ h: x.getAttribute('href'), t: x.target, r: x.rel })));
  await p.context().close();
  const want = ['https://www.linkedin.com/in/ondernuray/', 'https://github.com/ondern', 'https://www.credly.com/users/ondernuray/badges/credly'];
  for (const w of want) if (!links.some((l) => l.h === w)) throw new Error('missing link ' + w);
  const mail = links.filter((l) => /^mailto:/i.test(l.h)).length;
  if (mail) throw new Error('mail links present: ' + mail);
  const bad = links.filter((l) => l.t === '_blank' && !/noopener/.test(l.r)).map((l) => l.h);
  if (bad.length) throw new Error('target=_blank without noopener: ' + bad.join(', '));
});

await test('Employer descriptions and LinkedIn/GitHub line in en/de/tr', async () => {
  const want = {
    en: { org: 'retail and information technology', more: 'Based on my LinkedIn profile.' },
    de: { org: 'Einzelhandel und Informationstechnologie', more: 'Basierend auf meinem LinkedIn-Profil.' },
    tr: { org: 'Perakende ve bilgi teknolojileri', more: 'LinkedIn profilime dayanır.' },
  };
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: `/?lang=${lang}` });
    const exp = await p.textContent('#experience');
    const links = await p.$$eval('#experience a', (a) => a.map((x) => x.href));
    const body = await p.textContent('body');
    await p.context().close();
    if (!exp.includes(want[lang].org)) throw new Error(`${lang}: employer description missing`);
    if (!exp.includes(want[lang].more)) throw new Error(`${lang}: more-line missing`);
    if (links.length) throw new Error(`${lang}: the experience line must not contain links`);
    const priv = findPrivate(body); if (priv && priv.length) throw new Error(`${lang}: private word visible: ${priv}`);
    if (/B1 zertifiziert|B1 sertifikalı|B1 certified/i.test(body)) throw new Error(`${lang}: B1 must not be described as certified`);
  }
});

await test('Experience descriptions: the three supplied texts, exactly, in en/de/tr; metadata unchanged', async () => {
  const want = {"en":{"1":"I provide end-to-end IT support with a proactive, solution-oriented approach, focusing on resolving technical issues quickly and permanently, keeping systems running without interruption, and maintaining service continuity. I contribute to operational efficiency through process improvement, cross-department coordination, technical project management, IT asset lifecycle management, and vendor management.","2":"I provided end-to-end IT support to approximately 4,700 employees across corporate offices, call centers, and manufacturing facilities. I helped maintain operational continuity through fast troubleshooting, infrastructure management, and VIP user support. I managed the lifecycle of IT assets and improved security and access processes. I also worked on infrastructure projects, technical documentation, and initiatives that supported the reliable operation of production systems.","3":"I provided dedicated IT support to stock exchange and trading floor staff. In high-volume financial environments, I focused on maintaining the availability and performance of critical workstations and specialized trading equipment. I quickly identified hardware failures and worked with IT teams on proactive maintenance, system upgrades, change management, and business continuity, helping to minimize service disruptions."},"de":{"1":"Ich biete IT-Support aus einer Hand mit einer proaktiven, lösungsorientierten Arbeitsweise. Im Mittelpunkt stehen die schnelle und nachhaltige Behebung technischer Probleme, der störungsfreie Betrieb der Systeme und die Sicherung der Servicekontinuität. Durch Prozessverbesserung, bereichsübergreifende Koordination, technisches Projektmanagement, IT-Asset-Lifecycle-Management und Lieferantenmanagement trage ich zur Steigerung der betrieblichen Effizienz bei.","2":"Ich habe rund 4.700 Beschäftigte in Büros, Callcentern und Produktionsstätten umfassend im IT-Bereich unterstützt. Durch schnelle Fehlerbehebung, Infrastrukturmanagement und VIP-Support habe ich zur Sicherung des laufenden Betriebs beigetragen. Ich habe den Lebenszyklus der IT-Assets verwaltet und Sicherheits- und Zugriffsprozesse verbessert. Zudem war ich an Infrastrukturprojekten, technischer Dokumentation und Maßnahmen beteiligt, die den zuverlässigen Betrieb der Produktionssysteme unterstützten.","3":"Ich habe das Personal an Börse und Handelsparkett mit dediziertem IT-Support betreut. In Finanzumfeldern mit hohem Handelsaufkommen lag mein Schwerpunkt darauf, die Verfügbarkeit und Leistung kritischer Arbeitsplätze und spezieller Handelstechnik sicherzustellen. Hardwarefehler habe ich schnell erkannt und gemeinsam mit den IT-Teams vorausschauende Wartung, Systemupgrades, Änderungsmanagement und Geschäftskontinuität koordiniert, um Serviceunterbrechungen zu minimieren."},"tr":{"1":"Proaktif ve çözüm odaklı bir yaklaşımla uçtan uca BT desteği sağlıyor; teknik sorunların hızlı ve kalıcı biçimde giderilmesine, sistemlerin kesintisiz çalışmasına ve hizmet sürekliliğinin korunmasına odaklanıyorum. Süreç iyileştirme, departmanlar arası koordinasyon, teknik proje yönetimi, BT varlıklarının yaşam döngüsü ve tedarikçi yönetimi alanlarında operasyonel verimliliğin artırılmasına katkıda bulunuyorum.","2":"Kurumsal ofisler, çağrı merkezleri ve üretim tesislerinde görev yapan yaklaşık 4.700 çalışana uçtan uca BT desteği sundum. Hızlı sorun giderme, altyapı yönetimi ve VIP kullanıcı desteği aracılığıyla operasyonel sürekliliğin korunmasına katkıda bulundum. BT varlıklarının yaşam döngüsünü yönettim; güvenlik ve erişim süreçlerini geliştirdim. Ayrıca altyapı projeleri, teknik dokümantasyon ve üretim sistemlerinin güvenilir biçimde çalışmasını destekleyen çalışmalarda görev aldım.","3":"Borsa ve işlem salonu personeline özel BT desteği sağladım. Yoğun işlem temposuna sahip finansal ortamlarda kritik iş istasyonları ve özel işlem ekipmanlarının erişilebilirliğini ve performansını korumaya odaklandım. Donanım arızalarını hızla tespit ederek proaktif bakım, sistem yükseltmeleri, değişiklik yönetimi ve iş sürekliliği çalışmalarını BT ekipleriyle koordineli biçimde yürüttüm; hizmet kesintilerinin en aza indirilmesine katkıda bulundum."}};
  const meta = { en: ['An international company in the retail and information technology sectors', 'May 2018 – present', 'Istanbul, Türkiye · Hybrid'] };
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: '/?lang=' + lang });
    const jobs = await p.$$eval('#experience .job', (n) => n.map((j) => ({ desc: j.querySelector('p:not(.meta)').textContent.trim(), meta: j.querySelector('.meta').textContent.replace(/\s+/g, ' ').trim() })));
    await p.context().close();
    if (jobs.length !== 3) throw new Error(lang + ': ' + jobs.length + ' jobs');
    [1, 2, 3].forEach((n, i) => { if (jobs[i].desc !== want[lang][n]) throw new Error(lang + ': description ' + n + ' differs'); });
    if (!/4[.,]700/.test(jobs[1].desc)) throw new Error(lang + ': 4,700 missing');
    if (lang === 'en' && !jobs[0].meta.includes(meta.en[1] + ' · ' + meta.en[2]) && !jobs[0].meta.includes(meta.en[1]) ) throw new Error('metadata changed: ' + jobs[0].meta);
  }
});

await test('Languages: six cards in order, Turkish native without score, Duolingo scores 129/81/13/12/11, local icons, no CEFR claim (en/de/tr)', async () => {
  const names = { en: ['Turkish', 'English', 'German', 'Spanish', 'French', 'Italian'], de: ['Türkisch', 'Englisch', 'Deutsch', 'Spanisch', 'Französisch', 'Italienisch'], tr: ['Türkçe', 'İngilizce', 'Almanca', 'İspanyolca', 'Fransızca', 'İtalyanca'] };
  const levels = { en: ['Native language', 'Professional working proficiency', 'Limited working proficiency', 'Beginner-level proficiency', 'Beginner-level proficiency', 'Beginner-level proficiency'],
    de: ['Muttersprache', 'Gute berufliche Sprachkenntnisse', 'Eingeschränkte berufliche Sprachkenntnisse', 'Grundkenntnisse', 'Grundkenntnisse', 'Grundkenntnisse'],
    tr: ['Ana dil', 'Profesyonel çalışma yetkinliği', 'Sınırlı çalışma yetkinliği', 'Başlangıç düzeyinde yetkinlik', 'Başlangıç düzeyinde yetkinlik', 'Başlangıç düzeyinde yetkinlik'] };
  const note = { en: 'not CEFR levels or exam results', de: 'keine GER-Niveaus oder Prüfungsergebnisse', tr: 'CEFR düzeyi veya sınav sonucu değildir' };
  const scores = [null, '129', '81', '13', '12', '11'];
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: '/?lang=' + lang });
    await p.locator('#skills .lang-list').scrollIntoViewIfNeeded();
    await p.waitForFunction(() => [...document.querySelectorAll('.lang-list img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 5000 }).catch(() => {});
    const cards = await p.$$eval('.lang-card', (n) => n.map((c) => ({
      name: c.querySelector('.lang-name').textContent, level: c.querySelector('.lang-level').textContent,
      score: c.querySelector('.score-value')?.textContent ?? null,
      imgs: [...c.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src'), alt: i.alt, ok: i.complete && i.naturalWidth > 0 })),
      scoreText: c.querySelector('.lang-score')?.textContent.replace(/\s+/g, ' ').trim() ?? '', other: [...c.querySelectorAll('.lang-name, .lang-level, .lang-score')].map((x) => x.textContent).join(' ') })));
    const noteText = await p.textContent('#skills [data-i18n="lang.note"]');
    const duoHref = await p.getAttribute('#skills [data-i18n="lang.note"] a.provider-link', 'href');
    await p.context().close();
    if (cards.length !== 6) throw new Error(lang + ': ' + cards.length + ' cards');
    cards.forEach((c, i) => {
      if (c.name !== names[lang][i]) throw new Error(lang + ': order/name ' + i + ' ' + c.name);
      if (c.level !== levels[lang][i]) throw new Error(lang + ': level ' + c.name + ' ' + c.level);
      if (c.score !== scores[i]) throw new Error(lang + ': score ' + c.name + ' ' + c.score);
      if (i === 0 && (c.score !== null || /\d/.test(c.other))) throw new Error(lang + ': Turkish must have no score');
      if (c.score && !/Duolingo/.test(c.scoreText)) throw new Error(lang + ': score without Duolingo label');
      if (/\b[ABC][12]\b|CEFR|GER/.test(c.other)) throw new Error(lang + ': level code in ' + c.name);
      c.imgs.forEach((im) => { if (im.alt !== '' || !im.ok || !/^assets\/icons\/languages\/[\w-]+\.svg$/.test(im.src)) throw new Error(lang + ': icon problem ' + JSON.stringify(im)); });
      if (c.imgs.length !== (c.score ? 2 : 1)) throw new Error(lang + ': icon count for ' + c.name);
    });
    if (/Professional working|Gute berufliche|Profesyonel çalışma/.test(cards[2].level)) throw new Error(lang + ': German must be limited working proficiency');
    if (noteText.includes(note[lang])) throw new Error(lang + ': disclaimer still present: ' + noteText);
    if (duoHref !== 'https://www.duolingo.com/profile/nryndr?via=share_profile_qr') throw new Error(lang + ': Duolingo link missing');
    if (/verified by Duolingo|von Duolingo (bestätigt|verifiziert)|Duolingo tarafından doğrulan/i.test(noteText)) throw new Error(lang + ': verification claim');
  }
});

await test('About: 17+ years heading and three paragraphs in en/de/tr, anonymous, no stale wording', async () => {
  const want = {
    en: { h: 'IT Support & Infrastructure Professional | 17+ Years of Experience', p: ['IT Support and Infrastructure professional with more than 17 years of experience at an international technology company.', 'I have experience in end-user support, IT infrastructure operations, hardware deployments, IT asset lifecycle management, and vendor coordination. My focus is on resolving complex technical issues, minimizing service disruptions, and improving operational efficiency.', 'I am building on this experience with work in Python, Linux, AWS, and AI-assisted software development to keep growing my technical skills. My goal is to develop practical solutions that automate IT processes, reduce operational workload, and increase efficiency.'] },
    de: { h: 'IT-Support- und Infrastruktur-Profi | 17+ Jahre Erfahrung', p: ['IT-Support- und Infrastruktur-Profi mit über 17 Jahren Erfahrung bei einem internationalen Technologieunternehmen.', 'Ich habe Erfahrung in den Bereichen Endanwender-Support, Betrieb der IT-Infrastruktur, Hardware-Rollouts, IT-Asset-Lifecycle-Management und Lieferantenkoordination. Mein Schwerpunkt liegt darauf, komplexe technische Probleme zu lösen, Serviceunterbrechungen zu minimieren und die betriebliche Effizienz zu steigern.', 'Meine Erfahrung ergänze ich durch Projekte in Python, Linux, AWS und KI-gestützter Softwareentwicklung und baue meine technischen Kompetenzen kontinuierlich aus. Mein Ziel ist es, praxisnahe Lösungen zu entwickeln, die IT-Prozesse automatisieren, den operativen Aufwand senken und die Effizienz steigern.'] },
    tr: { h: 'BT Destek ve Altyapı Profesyoneli | 17+ Yıl Deneyim', p: ['Uluslararası bir teknoloji şirketinde 17 yılı aşkın deneyime sahip bir BT Destek ve Altyapı profesyoneliyim.', 'Son kullanıcı desteği, BT altyapı operasyonları, donanım kurulumları, BT varlık yaşam döngüsü yönetimi ve tedarikçi koordinasyonu alanlarında deneyim sahibiyim. Karmaşık teknik sorunların çözülmesi, hizmet kesintilerinin en aza indirilmesi ve operasyonel verimliliğin artırılması konularına odaklanıyorum.', 'Mevcut deneyimimi Python, Linux, AWS ve yapay zekâ destekli yazılım geliştirme alanlarındaki çalışmalarla destekleyerek teknik yetkinliklerimi geliştirmeye devam ediyorum. Amacım, BT süreçlerini otomatikleştiren, operasyonel iş yükünü azaltan ve verimliliği artıran uygulanabilir çözümler geliştirmek.'] },
  };
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: '/?lang=' + lang });
    const h = await p.textContent('#about h3');
    const paras = await p.$$eval('#about .container > p', (n) => n.map((x) => x.textContent.trim()));
    const all = (await p.textContent('#about')) + ' ' + (await p.getAttribute('meta[name=description]', 'content'));
    await p.context().close();
    if (h.trim() !== want[lang].h) throw new Error(lang + ': heading ' + h);
    if (paras.length !== 3) throw new Error(lang + ': expected 3 paragraphs, got ' + paras.length);
    want[lang].p.forEach((x, i) => { if (paras[i] !== x) throw new Error(lang + ': paragraph ' + i + ': ' + paras[i]); });
    const key = { en: ['end-user support', 'Python, Linux, AWS'], de: ['Lieferantenkoordination', 'Python, Linux, AWS'], tr: ['tedarikçi koordinasyonu', 'Python, Linux, AWS'] }[lang];
    if (!paras[1].includes(key[0]) || !paras[2].includes(key[1])) throw new Error(lang + ': paragraphs 2/3 wrong');
    if (!/17\+/.test(h) || !/17/.test(paras[0])) throw new Error(lang + ': 17+ missing');
    if (/\b(15|16|18|20)\+|\b1[5689] (years|Jahre|yıl)/i.test(all)) throw new Error(lang + ': other experience number');
    const priv = findPrivate(all); if (priv && priv.length) throw new Error(lang + ': private word: ' + priv);
    if (/B1|A2|Goethe/.test(all)) throw new Error(lang + ': language level text belongs in the language card, not About');
  }
});

// Contact form tests. Turnstile and the Worker API are mocked: these tests do NOT prove real email delivery.
const TS_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const API_URL = 'https://api.nuray.io/contact';
const FAKE_TURNSTILE = `window.__ts = { renders: 0, resets: 0, removes: 0, opts: null };
window.turnstile = { render: (el, o) => { window.__ts.renders++; window.__ts.opts = o; setTimeout(() => o.callback('mock-token-' + window.__ts.renders), 30); return 'w' + window.__ts.renders; },
  reset: () => { window.__ts.resets++; setTimeout(() => window.__ts.opts.callback('mock-token-r' + window.__ts.resets), 30); }, remove: () => { window.__ts.removes++; } };`;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
async function contactPage(lang, api, { configured = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.problems = []; p.apiCalls = []; p.hosts = new Set(); p.tsLoaded = 0;
  p.on('console', (m) => { if (/Content Security Policy|Refused/i.test(m.text())) p.problems.push(m.text()); });
  p.on('pageerror', (e) => p.problems.push(String(e)));
  p.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol)) p.hosts.add(u.host); });
  await p.route('**/js/config.js', async (r) => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace(/const PRODUCTION_TURNSTILE_SITE_KEY = '[^']*';/, `const PRODUCTION_TURNSTILE_SITE_KEY = '${configured ? 'test-site-key' : 'REPLACE_WITH_TURNSTILE_SITE_KEY'}';`) }); });
  await p.route(TS_URL + '*', (r) => { p.tsLoaded++; r.fulfill({ contentType: 'text/javascript', body: FAKE_TURNSTILE }); });
  await p.route(API_URL, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    p.apiCalls.push({ headers: r.request().headers(), body: JSON.parse(r.request().postData() || '{}') });
    await api(r);
  });
  await p.goto(base + '/?lang=' + lang);
  await p.waitForLoadState('networkidle');
  return p;
}
const okApi = (r) => r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{"ok":true}' });
const errApi = (status, code, extra = {}) => (r) => r.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify({ ok: false, code, ...extra }) });
async function fillForm(p, over = {}) {
  await p.fill('#cf-name', over.name ?? 'Ada Lovelace');
  await p.fill('#cf-email', over.email ?? 'ada@example.org');
  await p.fill('#cf-subject', over.subject ?? 'Hello');
  await p.fill('#cf-message', over.message ?? 'A short test message.');
}
const PRIVACY_BASE = {
  en: 'Your message is processed through Cloudflare bot protection and the Resend and Zoho email services. Please do not share sensitive personal information.',
  de: 'Ihre Nachricht wird über den Bot-Schutz von Cloudflare sowie die E-Mail-Dienste Resend und Zoho verarbeitet. Bitte teilen Sie keine sensiblen personenbezogenen Daten mit.',
  tr: 'Mesajınız, Cloudflare bot koruması ile Resend ve Zoho e-posta hizmetleri aracılığıyla işlenir. Lütfen hassas kişisel bilgilerinizi paylaşmayın.',
};
const SUCCESS = { en: 'sent a verification link to ada@example.org', de: 'Bestätigungslink an ada@example.org gesendet', tr: 'ada@example.org adresine bir doğrulama bağlantısı gönderdik' };
const EMAIL_HINT = { en: 'a verification link will be sent to your email address', de: 'wird ein Bestätigungslink an Ihre E-Mail-Adresse gesendet', tr: 'e-posta adresinize bir doğrulama bağlantısı gönderilecektir' };
await test('Contact form: active in en/de/tr with the approved disclosure; nothing contacted or stored before interaction', async () => {
  const words = { en: ['Send message', 'Name'], de: ['Nachricht senden', 'Name'], tr: ['Mesajı gönder', 'Ad'] };
  for (const lang of ['en', 'de', 'tr']) {
    const p = await contactPage(lang, okApi);
    const info = await p.evaluate(() => {
      const f = document.getElementById('contact-form');
      return { inSection: !!f.closest('#contact'), action: f.getAttribute('action'), method: f.getAttribute('method'),
        disabled: [...f.querySelectorAll('input, textarea, button')].filter((c) => c.matches(':disabled')).length,
        labels: [...f.querySelectorAll('label')].map((l) => l.textContent.trim()), submitText: document.getElementById('cf-submit').textContent.trim(),
        privacy: document.getElementById('form-privacy').textContent.trim(), hp: { aria: document.querySelector('.hp').getAttribute('aria-hidden'), tab: document.getElementById('cf-website').tabIndex, rect: document.getElementById('cf-website').getBoundingClientRect().right },
        live: document.getElementById('cf-status').getAttribute('role'), hint: document.getElementById('cf-email-hint').textContent, hintId: document.getElementById('cf-email-hint').id, emailDesc: document.getElementById('cf-email').getAttribute('aria-describedby') || '', footer: document.querySelector('footer .footer-notice').textContent,
        storage: { local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookie: document.cookie } };
    });
    const hosts = [...p.hosts]; const ts = p.tsLoaded; const api = p.apiCalls.length; const probs = p.problems; const html = await p.content();
    await p.context().close();
    if (!info.inSection || info.action || info.method) throw new Error(lang + ': form structure');
    if (info.disabled) throw new Error(lang + ': disabled controls');
    if (info.submitText !== words[lang][0] || info.labels[0] !== words[lang][1]) throw new Error(lang + ': labels not localized');
    if (info.privacy !== PRIVACY_BASE[lang]) throw new Error(lang + ': disclosure differs: ' + info.privacy);
    if (!info.hint.includes(EMAIL_HINT[lang]) || info.hintId !== 'cf-email-hint' || !info.emailDesc.split(' ').includes('cf-email-hint')) throw new Error(lang + ': e-mail confirmation hint missing or not linked: ' + JSON.stringify([info.hint, info.emailDesc]));
    if (info.hp.aria !== 'true' || info.hp.tab !== -1 || info.hp.rect > 0) throw new Error(lang + ': honeypot not hidden: ' + JSON.stringify(info.hp));
    if (info.live !== 'status') throw new Error(lang + ': status region missing');
    if (ts || api || hosts.some((h) => h !== new URL(base).host)) throw new Error(lang + ': third-party/API contact before interaction: ' + hosts);
    if (info.storage.local.some((k) => !['lang', 'theme'].includes(k)) || info.storage.session.length || info.storage.cookie) throw new Error(lang + ': storage used');
    if (probs.length) throw new Error(lang + ': CSP/console: ' + probs.join('|'));
    if (/[\w.+-]+@(?!example\.)[\w-]+\.[\w.-]+|mailto:/i.test(html)) throw new Error(lang + ': address in page');
  }
});
await test('Contact form: mocked successful submit (en/de/tr): Turnstile loads on interaction, JSON payload, success message, form reset', async () => {
  for (const lang of ['en', 'de', 'tr']) {
    const p = await contactPage(lang, okApi);
    await p.focus('#cf-name');
    await p.waitForFunction(() => window.__ts && window.__ts.renders === 1);
    const opts = await p.evaluate(() => ({ sitekey: window.__ts.opts.sitekey, language: window.__ts.opts.language }));
    if (opts.sitekey !== 'test-site-key' || opts.language !== lang) throw new Error(lang + ': widget options ' + JSON.stringify(opts));
    await fillForm(p);
    await p.waitForTimeout(3300); // the Worker enforces a minimum fill time
    await p.click('#cf-submit');
    await p.waitForFunction((w) => document.getElementById('cf-status').textContent.includes(w), SUCCESS[lang]);
    const after = await p.evaluate(() => ({ name: document.getElementById('cf-name').value, message: document.getElementById('cf-message').value, kind: document.getElementById('cf-status').dataset.kind, resets: window.__ts.resets, btn: document.getElementById('cf-submit').textContent.trim(), busy: document.getElementById('contact-form').getAttribute('aria-busy'), disabled: document.querySelector('#contact-form fieldset').disabled }));
    const calls = p.apiCalls; const probs = p.problems; await p.context().close();
    if (calls.length !== 1) throw new Error(lang + ': api calls ' + calls.length);
    const b = calls[0].body;
    if (!/^application\/json/.test(calls[0].headers['content-type'])) throw new Error('not JSON');
    if (b.name !== 'Ada Lovelace' || b.email !== 'ada@example.org' || b.subject !== 'Hello' || b.message !== 'A short test message.' || b.lang !== lang || b.token !== 'mock-token-1' || b.website !== '') throw new Error(lang + ': payload ' + JSON.stringify(b));
    if (!(Date.now() - b.startedAt >= 3000) || !(b.elapsedMs >= 3000) || 'idempotencyKey' in b) throw new Error(lang + ': startedAt / elapsedMs / unexpected key');
    if (after.name || after.message || after.kind !== 'success' || after.resets < 1 || after.busy !== 'false' || after.disabled) throw new Error(lang + ': state after success ' + JSON.stringify(after));
    if (probs.length) throw new Error(lang + ': CSP/console: ' + probs.join('|'));
  }
});
await test('Contact form: the confirmation notice stays and follows the language; a new link can be requested after a minute (at most until the Worker says stop)', async () => {
  const SECRET = 'R'.repeat(43);
  const p = await contactPage('en', (r) => r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ ok: true, pending: true, resend: SECRET }) }));
  await p.clock.install(); // the minute and the 15 minutes pass in milliseconds
  const resends = [];
  let answer = { status: 200, body: { ok: true } };
  await p.route('https://api.nuray.io/contact/resend', async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    resends.push(r.request().postDataJSON());
    await r.fulfill({ status: answer.status, headers: CORS, contentType: 'application/json', body: JSON.stringify(answer.body) });
  });
  await p.focus('#cf-name');
  await p.waitForFunction(() => window.__ts && window.__ts.renders === 1);
  await fillForm(p);
  await p.clock.fastForward(4000);
  await p.click('#cf-submit');
  const text = () => p.evaluate(() => ({ s: document.getElementById('cf-status').textContent, kind: document.getElementById('cf-status').dataset.kind, hidden: document.getElementById('cf-resend').hidden, disabled: document.getElementById('cf-resend').disabled }));
  await p.waitForFunction(() => /sent a verification link to ada@example.org/.test(document.getElementById('cf-status').textContent));
  let s = await text();
  if (s.hidden || !s.disabled || s.kind !== 'success') throw new Error('the new-link button must appear but wait a minute: ' + JSON.stringify(s));
  if (!/15 minutes/.test(s.s) || !/spam/.test(s.s)) throw new Error('notice must name the 15 minutes and the spam folder: ' + s.s);
  await p.clock.fastForward(30000);
  s = await text();
  if (!/sent a verification link/.test(s.s) || !s.disabled) throw new Error('the notice must stay (no timer) and the button must still wait: ' + JSON.stringify(s));
  await p.evaluate(() => { const sel = document.querySelector('[data-lang-select]'); sel.value = 'de'; sel.dispatchEvent(new Event('change')); });
  await p.waitForFunction(() => /Bestätigungslink an ada@example.org gesendet/.test(document.getElementById('cf-status').textContent));
  await p.clock.fastForward(31000);
  s = await text();
  if (s.disabled) throw new Error('the button must be available after a minute');
  await p.click('#cf-resend');
  await p.waitForFunction(() => /neuer Bestätigungslink wurde an ada@example.org gesendet/.test(document.getElementById('cf-status').textContent));
  s = await text();
  if (resends.length !== 1 || resends[0].resend !== SECRET || Object.keys(resends[0]).length !== 1) throw new Error('resend request: ' + JSON.stringify(resends));
  if (!s.disabled || s.hidden) throw new Error('after a new link the button waits again: ' + JSON.stringify(s));
  answer = { status: 429, body: { ok: false, code: 'resend_limit' } };
  await p.clock.fastForward(61000);
  await p.click('#cf-resend');
  await p.waitForFunction(() => /keine weiteren Links/.test(document.getElementById('cf-status').textContent));
  s = await text();
  if (!s.hidden) throw new Error('the button must disappear when no more links can be sent');
  const probs = p.problems; await p.context().close();
  if (probs.length) throw new Error('CSP/console: ' + probs.join('|'));
});
await test('Confirmation page: opening the link sends nothing; the button confirms once; invalid or missing tokens, network and server errors show translated messages', async () => {
  const TOKEN = 'T'.repeat(43);
  const open = async (lang, hash, answer) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    p.problems = []; p.posts = [];
    p.on('console', (m) => { if (/Content Security Policy|Refused/i.test(m.text())) p.problems.push(m.text()); });
    p.on('pageerror', (e) => p.problems.push(String(e)));
    await p.route('https://api.nuray.io/contact/verify', async (r) => {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
      p.posts.push(r.request().postDataJSON());
      if (answer === 'abort') return r.abort();
      await r.fulfill({ status: answer.status, headers: CORS, contentType: 'application/json', body: JSON.stringify(answer.body) });
    });
    await p.goto(base + '/verify.html?lang=' + lang + hash);
    await p.waitForLoadState('networkidle');
    return p;
  };
  const state = (p) => p.evaluate(() => ({ s: document.getElementById('verify-status').textContent.trim(), btn: document.getElementById('verify-btn').hidden, dis: document.getElementById('verify-btn').disabled, lang: document.documentElement.lang, title: document.title, h1: document.querySelector('h1').textContent, hash: location.hash, robots: document.querySelector('meta[name=robots]').content }));
  // Success, in each language; nothing is sent when the page opens.
  for (const [lang, ok, btn, h1] of [['en', /^Your message has been sent successfully\.$/, 'Verify Email Address and Send Message', 'Email Address Verified'], ['de', /^Ihre Nachricht wurde erfolgreich gesendet\.$/, 'E-Mail-Adresse bestätigen und Nachricht senden', 'E-Mail-Adresse bestätigt'], ['tr', /^Mesajınız başarıyla gönderildi\.$/, 'E-posta adresini doğrula ve mesajı gönder', 'E-posta adresiniz doğrulandı.']]) {
    const p = await open(lang, '#t=' + TOKEN, { status: 200, body: { ok: true } });
    let s = await state(p);
    if (p.posts.length || s.btn || s.lang !== lang || s.robots !== 'noindex') throw new Error(lang + ': the page must wait for the button: ' + JSON.stringify(s));
    if (await p.textContent('#verify-btn') !== btn) throw new Error(lang + ': button text');
    await p.click('#verify-btn');
    await p.waitForFunction(() => document.getElementById('verify-status').dataset.kind === 'success');
    s = await state(p);
    const posts = p.posts; const probs = p.problems; await p.context().close();
    if (!ok.test(s.s) || s.h1 !== h1 || !s.btn || s.hash) throw new Error(lang + ': after success ' + JSON.stringify(s));
    if (posts.length !== 1 || posts[0].token !== TOKEN || Object.keys(posts[0]).length !== 1) throw new Error(lang + ': request ' + JSON.stringify(posts));
    if (probs.length) throw new Error(lang + ': CSP/console: ' + probs.join('|'));
  }
  // Missing, malformed, unknown or used tokens.
  for (const [hash, answer] of [['', null], ['#t=short', null], ['#t=' + TOKEN + '&x=1', null], ['#t=' + TOKEN, { status: 400, body: { ok: false, code: 'invalid_token' } }]]) {
    const p = await open('en', hash, answer);
    if (answer) await p.click('#verify-btn');
    await p.waitForFunction(() => /invalid, has already been used, or has expired/.test(document.getElementById('verify-status').textContent));
    const s = await state(p); const posts = p.posts.length; await p.context().close();
    if (!s.btn || (answer ? posts !== 1 : posts !== 0)) throw new Error('invalid token (' + hash + '): ' + JSON.stringify([s.btn, posts]));
  }
  // Temporary problems keep the button, so the same link can be tried again.
  for (const [answer, re] of [['abort', /connection failed/], [{ status: 429, body: { ok: false, code: 'rate_limited' } }, /Too many attempts/], [{ status: 502, body: { ok: false, code: 'server_error' } }, /could not be sent/]]) {
    const p = await open('en', '#t=' + TOKEN, answer);
    await p.click('#verify-btn');
    await p.waitForFunction((src) => new RegExp(src).test(document.getElementById('verify-status').textContent), re.source);
    const s = await state(p); await p.context().close();
    if (s.btn || s.dis) throw new Error('the button must stay available after a temporary problem: ' + JSON.stringify(s));
  }
});
await test('Contact form: client validation, server error codes and network failure show translated messages; language change re-translates', async () => {
  const p = await contactPage('en', errApi(429, 'rate_limited'));
  await p.click('#cf-submit');
  if (p.apiCalls.length) throw new Error('invalid form was sent');
  const fieldErrors = () => p.evaluate(() => Object.fromEntries(['name', 'email', 'subject', 'message'].map((f) => [f, document.getElementById('cf-' + f + '-error').textContent.trim()])));
  let errs = await fieldErrors();
  if (!/enter your name/.test(errs.name) || !/enter your email/.test(errs.email) || errs.subject || !/enter your message/.test(errs.message)) throw new Error('an empty form must show every missing field at once: ' + JSON.stringify(errs));
  if ((await p.getAttribute('#cf-name', 'aria-invalid')) !== 'true' || !(await p.evaluate(() => document.activeElement.id === 'cf-name'))) throw new Error('first invalid field not marked/focused');
  await fillForm(p, { email: 'broken' });
  await p.click('#cf-submit');
  errs = await fieldErrors();
  if (errs.name || errs.message || !/valid email/.test(errs.email)) throw new Error('only the email should be flagged: ' + JSON.stringify(errs));
  await fillForm(p);
  await p.click('#cf-submit');
  await p.waitForFunction(() => /Too many attempts/.test(document.getElementById('cf-status').textContent));
  if ((await p.inputValue('#cf-message')) !== 'A short test message.') throw new Error('input lost after error');
  await p.selectOption('#lang-select', 'de');
  await p.waitForFunction(() => /Zu viele Versuche/.test(document.getElementById('cf-status').textContent));
  const removes = await p.evaluate(() => window.__ts.removes);
  if (removes < 1) throw new Error('widget not re-rendered after language change');
  await p.selectOption('#lang-select', 'tr');
  await p.waitForFunction(() => /Çok fazla deneme/.test(document.getElementById('cf-status').textContent));
  // a refused security token is shown under the widget, everything else in the status box
  const codes = [[400, 'captcha_failed', /Sicherheitsprüfung ist fehlgeschlagen|security check failed|doğrulaması başarısız/, '#cf-turnstile-msg'], [502, 'server_error', /gönderilemedi/, '#cf-status'], [409, 'in_progress', /zaten gönderiliyor/, '#cf-status']];
  await p.unroute(API_URL);
  for (const [status, code, re, sel] of codes) {
    await p.route(API_URL, async (r) => { if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS }); await errApi(status, code)(r); });
    await p.click('#cf-submit');
    await p.waitForFunction((s) => document.querySelector(s).textContent.length > 0 && !document.querySelector('#contact-form fieldset').disabled, sel);
    const txt = await p.textContent(sel);
    if (!re.test(txt)) throw new Error(code + ': ' + txt);
    await p.unroute(API_URL);
  }
  await p.route(API_URL, (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.abort()));
  await p.click('#cf-submit');
  await p.waitForFunction(() => /Bağlantı kurulamadı/.test(document.getElementById('cf-status').textContent));
  await p.context().close();
});
await test('Contact form validation: every problem appears at once, small, under its own field; fields update while the visitor corrects them; security-check problems have their own message', async () => {
  const snap = (p) => p.evaluate(() => {
    const f = {};
    for (const name of ['name', 'email', 'subject', 'message']) {
      const input = document.getElementById('cf-' + name); const msg = document.getElementById('cf-' + name + '-error');
      f[name] = { text: msg.textContent.trim(), shown: msg.offsetParent !== null, invalid: input.getAttribute('aria-invalid') === 'true', described: input.getAttribute('aria-describedby'),
        below: msg.previousElementSibling === (name === 'email' ? document.getElementById('cf-email-hint') : input), small: parseFloat(getComputedStyle(msg).fontSize) < parseFloat(getComputedStyle(input).fontSize) };
    }
    return { f, summary: document.getElementById('cf-status').textContent.trim(), ts: document.getElementById('cf-turnstile-msg').textContent.trim(), focus: document.activeElement.id };
  });
  const expectField = (s, name, re, label) => {
    const x = s.f[name];
    if (!re.test(x.text) || !x.shown || !x.invalid || x.described !== (name === 'email' ? 'cf-email-hint ' : '') + 'cf-' + name + '-error' || !x.below || !x.small) throw new Error(label + ': ' + name + ' ' + JSON.stringify(x));
  };
  const expectClean = (s, name, label) => {
    const x = s.f[name];
    if (x.text || x.shown || x.invalid || (name === 'email' ? x.described !== 'cf-email-hint' : x.described)) throw new Error(label + ': ' + name + ' should have no error ' + JSON.stringify(x));
  };
  const setApi = async (page, api) => { await page.unroute(API_URL); await page.route(API_URL, async (r) => { if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS }); await api(r); }); };

  // 1. an empty form: everything that is missing is reported together; nothing is sent
  let p = await contactPage('en', okApi);
  await p.click('#cf-submit');
  let s = await snap(p);
  expectField(s, 'name', /enter your name/, 'empty form'); expectField(s, 'email', /enter your email/, 'empty form'); expectField(s, 'message', /enter your message/, 'empty form');
  expectClean(s, 'subject', 'empty form');
  if (!/highlighted fields/.test(s.summary) || s.focus !== 'cf-name' || p.apiCalls.length) throw new Error('empty form: ' + JSON.stringify({ summary: s.summary, focus: s.focus, calls: p.apiCalls.length }));
  // 2. two different problems at once (invalid email, message too short); typing updates the messages without a new attempt
  await p.fill('#cf-name', 'dsf'); await p.fill('#cf-email', 'sdf'); await p.fill('#cf-subject', 'sdf'); await p.fill('#cf-message', 'sdf');
  s = await snap(p);
  expectClean(s, 'name', 'typed'); expectField(s, 'email', /valid email/, 'typed'); expectClean(s, 'subject', 'typed'); expectField(s, 'message', /too short/, 'typed');
  await p.click('#cf-submit');
  s = await snap(p);
  expectField(s, 'email', /valid email/, 'second attempt'); expectField(s, 'message', /too short/, 'second attempt');
  if (s.focus !== 'cf-email' || p.apiCalls.length) throw new Error('second attempt: focus ' + s.focus + ', calls ' + p.apiCalls.length);
  // 3. corrections update or remove the messages immediately
  await p.fill('#cf-email', 'ada@example.org');
  s = await snap(p);
  expectClean(s, 'email', 'email fixed'); expectField(s, 'message', /too short/, 'email fixed');
  if (!/highlighted fields/.test(s.summary)) throw new Error('the summary must stay while a problem remains');
  await p.fill('#cf-message', '');
  expectField(await snap(p), 'message', /enter your message/, 'message emptied');
  await p.fill('#cf-message', 'This message is long enough now.');
  s = await snap(p);
  for (const name of ['name', 'email', 'subject', 'message']) expectClean(s, name, 'everything fixed');
  if (s.summary) throw new Error('the summary must disappear once every problem is fixed: ' + s.summary);
  // 4. after a first attempt, leaving a field checks it
  await p.fill('#cf-name', ''); await p.focus('#cf-subject');
  expectField(await snap(p), 'name', /enter your name/, 'name emptied and left');
  // 5. a language change re-translates the messages on screen
  await p.selectOption('#lang-select', 'de');
  await p.waitForFunction(() => /Namen/.test(document.getElementById('cf-name-error').textContent), null, { timeout: 5000 }).catch(() => {});
  s = await snap(p);
  if (!/Namen/.test(s.f.name.text)) throw new Error('error not re-translated: ' + s.f.name.text); // the summary was already gone here: only the name field is flagged
  await p.context().close();

  // 6. a security-check problem has its own message under the widget, next to the field problems, never in the form summary
  p = await contactPage('en', okApi);
  await p.unroute(TS_URL + '*');
  await p.route(TS_URL + '*', (r) => r.abort());
  await p.focus('#cf-name');
  await p.waitForFunction(() => /security check could not be loaded/.test(document.getElementById('cf-turnstile-msg').textContent));
  s = await snap(p);
  for (const name of ['name', 'email', 'subject', 'message']) expectClean(s, name, 'security problem only');
  if (s.summary) throw new Error('a security-check problem must not use the form summary: ' + s.summary);
  await p.click('#cf-submit');
  s = await snap(p);
  expectField(s, 'name', /enter your name/, 'both kinds'); expectField(s, 'email', /enter your email/, 'both kinds'); expectField(s, 'message', /enter your message/, 'both kinds');
  if (!/highlighted fields/.test(s.summary) || !/security check could not be loaded/.test(s.ts)) throw new Error('both kinds must be visible together: ' + JSON.stringify({ summary: s.summary, ts: s.ts }));
  if ((await p.evaluate(() => getComputedStyle(document.getElementById('cf-turnstile')).minHeight)) !== '0px') throw new Error('the space kept for a widget that cannot appear must be released');
  await p.context().close();

  // 7. refusals from the server are shown where they belong
  p = await contactPage('en', errApi(400, 'validation', { fields: ['email', 'message'] }));
  await fillForm(p);
  await p.click('#cf-submit');
  await p.waitForFunction(() => document.getElementById('cf-email-error').textContent.length > 0);
  s = await snap(p);
  expectField(s, 'email', /valid email/, 'server validation'); expectField(s, 'message', /meaningful message/, 'server validation'); expectClean(s, 'name', 'server validation');
  if (!/highlighted fields/.test(s.summary) || s.ts) throw new Error('server validation: ' + JSON.stringify({ summary: s.summary, ts: s.ts }));
  await p.focus('#cf-subject'); await p.focus('#cf-name'); // leaving the fields must not remove what the server said
  expectField(await snap(p), 'email', /valid email/, 'server validation after leaving the field');
  await setApi(p, errApi(400, 'validation', { fields: ['token'] }));
  await p.click('#cf-submit');
  await p.waitForFunction(() => document.getElementById('cf-turnstile-msg').textContent.length > 0);
  s = await snap(p);
  for (const name of ['name', 'email', 'subject', 'message']) expectClean(s, name, 'token refused');
  if (s.summary || !/security check failed/.test(s.ts)) throw new Error('a refused token belongs under the widget: ' + JSON.stringify({ summary: s.summary, ts: s.ts }));
  await p.context().close();

  // 8. automated accessibility check of the error state, light and dark, on a phone (not a full audit)
  const axeSrcLocal = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, bypassCSP: true });
    const page = await ctx.newPage();
    await page.addInitScript((sch) => { try { localStorage.setItem('theme', sch); } catch (e) { /* ignore */ } }, scheme);
    await page.route(TS_URL + '*', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_TURNSTILE }));
    await page.goto(base + '/?lang=en'); await page.waitForLoadState('networkidle');
    await page.fill('#cf-name', 'dsf'); await page.fill('#cf-email', 'sdf'); await page.fill('#cf-message', 'sdf');
    await page.click('#cf-submit');
    await page.addScriptTag({ content: axeSrcLocal });
    const res = await page.evaluate(() => axe.run(document.getElementById('contact-form'), { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] }));
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await ctx.close();
    if (res.violations.length) throw new Error(scheme + ' error state: ' + res.violations.map((v) => v.id + ' (' + v.nodes.length + ')').join(', '));
    if (over > 0) throw new Error(scheme + ' error state: horizontal overflow ' + over);
  }
});
await test('Slow connection: a stalled Turnstile script or an unfinished challenge never sends a request, the form unlocks with a message, and a retry works once the script arrives', async () => {
  const open = async (routeTurnstile) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    p.posts = [];
    await p.clock.install(); // timers are driven by the test, so the 20 s and 60 s waits take milliseconds
    await p.route('https://api.nuray.io/contact', async (r) => {
      if (r.request().method() === 'POST') p.posts.push(r.request().postDataJSON());
      await r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{"ok":true}' });
    });
    await p.route('https://challenges.cloudflare.com/**', routeTurnstile);
    await p.goto(base + '/?lang=en', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#contact-form');
    await fillForm(p);
    await p.clock.fastForward(5000); // long enough for the minimum fill time
    return { ctx, p };
  };
  const view = (p) => p.evaluate(() => ({ btn: document.getElementById('cf-submit').textContent.trim(), locked: document.querySelector('#contact-form fieldset').disabled, status: document.getElementById('cf-turnstile-msg').textContent.trim() }));
  // 1. The script request stalls (hung connection).
  let held;
  const a = await open((r) => { held = r; });
  await a.p.click('#cf-submit');
  await a.p.waitForTimeout(300);
  let s = await view(a.p);
  if (!s.locked || !/Sending/.test(s.btn)) throw new Error('expected the sending state while the script loads: ' + JSON.stringify(s));
  await a.p.clock.fastForward(21000);
  await a.p.waitForTimeout(300);
  s = await view(a.p);
  if (s.locked || !/could not be loaded/.test(s.status)) throw new Error('a stalled script must unlock the form with a message: ' + JSON.stringify(s));
  if (a.p.posts.length) throw new Error('a request reached the API without a Turnstile token');
  // 2. The script finally arrives; the visitor retries.
  await held.fulfill({ contentType: 'text/javascript', body: FAKE_TURNSTILE });
  await a.p.waitForTimeout(200);
  await a.p.click('#cf-submit');
  for (let i = 0; i < 25 && !a.p.posts.length; i++) { await a.p.waitForTimeout(100); await a.p.clock.fastForward(100); }
  const scripts = await a.p.evaluate(() => document.querySelectorAll('script[src*="challenges.cloudflare.com"]').length);
  const posts = a.p.posts.slice();
  await a.ctx.close();
  if (posts.length !== 1 || !/^mock-token/.test(posts[0].token)) throw new Error('the retry must send exactly one request that carries a token: ' + JSON.stringify(posts.map((x) => x.token)));
  if (scripts !== 1) throw new Error('the retry added another Turnstile script tag: ' + scripts);
  // 3. The script loads, but the challenge never produces a token.
  const b2 = await open((r) => r.fulfill({ contentType: 'text/javascript', body: 'window.turnstile = { render: () => "w1", reset() {}, remove() {} };' }));
  await b2.p.click('#cf-submit');
  await b2.p.waitForTimeout(400);
  s = await view(b2.p);
  if (!s.locked || !/Security check in progress/.test(s.status)) throw new Error('while the challenge runs the visitor must see that it is in progress: ' + JSON.stringify(s));
  await b2.p.clock.fastForward(61000);
  await b2.p.waitForTimeout(300);
  s = await view(b2.p);
  const sent = b2.p.posts.length;
  await b2.ctx.close();
  if (sent) throw new Error('a request reached the API without a Turnstile token');
  if (s.locked || !/complete the security check/.test(s.status)) throw new Error('an unfinished challenge must unlock the form with a message: ' + JSON.stringify(s));
});
await test('Contact form: placeholder site key shows "unavailable" and sends nothing; failed Turnstile load shows a message', async () => {
  let p = await contactPage('en', okApi, { configured: false });
  await fillForm(p);
  await p.click('#cf-submit');
  if (!/not available right now/.test(await p.textContent('#cf-status'))) throw new Error('unavailable message missing');
  if (p.apiCalls.length || p.tsLoaded) throw new Error('request made with placeholder key');
  await p.context().close();
  p = await contactPage('en', okApi);
  await p.unroute(TS_URL + '*');
  await p.route(TS_URL + '*', (r) => r.abort());
  await fillForm(p);
  await p.click('#cf-submit');
  await p.waitForFunction(() => /security check could not be loaded/.test(document.getElementById('cf-turnstile-msg').textContent));
  if (p.apiCalls.length) throw new Error('request without Turnstile');
  await p.context().close();
});
await test('Contact form source: public values only, no secrets, no recipient, CSP allows only Turnstile and the API host', async () => {
  const cfg = readFileSync('js/config.js', 'utf8');
  if (!/PRODUCTION_CONTACT_API_URL = 'https:\/\/api\.nuray\.io\/contact'/.test(cfg) || !/TURNSTILE_SITE_KEY/.test(cfg)) throw new Error('config constants missing');
  for (const f of ['index.html', 'js/config.js', 'js/contact.js', 'js/app.js', 'i18n/en.json', 'i18n/de.json', 'i18n/tr.json', 'README.md']) {
    const t = readFileSync(f, 'utf8');
    if (/RESEND_API_KEY|TURNSTILE_SECRET|re_[A-Za-z0-9]{16,}|CONTACT_RECIPIENT|mailto:/.test(t)) throw new Error('secret name/value or mail link in ' + f);
  }
  const csp = readFileSync('index.html', 'utf8').match(/Content-Security-Policy" content="([^"]+)"/)[1];
  const want = ["default-src 'none'", "script-src 'self' https://challenges.cloudflare.com", "style-src 'self'", "connect-src 'self' https://api.nuray.io", 'frame-src https://challenges.cloudflare.com', "form-action 'none'", "base-uri 'self'"];
  for (const d of want) if (!csp.includes(d)) throw new Error('CSP missing: ' + d);
  if (/unsafe-/.test(csp) || csp.includes('*')) throw new Error('CSP too loose');
  if (/<script[^>]+src="https?:/.test(readFileSync('index.html', 'utf8'))) throw new Error('static third-party script');
});
await test('Contact config: production values by default; local mode only on localhost with ?contactDev=1, never on nuray.io', async () => {
  const load = async (hostname, search, n) => { globalThis.location = { hostname, search }; return import(pathToFileURL(join(ROOT, 'js/config.js')).href + '?case=' + n); };
  const prodKey = readFileSync('js/config.js', 'utf8').match(/const PRODUCTION_TURNSTILE_SITE_KEY = '([^']+)'/)[1];
  if (prodKey === '1x00000000000000000000AA') throw new Error('the Cloudflare test key must never be the production key');
  const prod = await load('nuray.io', '', 1);
  const spoof = await load('nuray.io', '?contactDev=1', 2);
  const www = await load('www.nuray.io', '?contactDev=1&contactApi=https://evil.example', 3);
  const localDefault = await load('localhost', '', 4);
  const localDev = await load('localhost', '?contactDev=1', 5);
  const lookalike = await load('localhost.evil.example', '?contactDev=1', 6);
  delete globalThis.location;
  for (const c of [prod, spoof, www, localDefault, lookalike]) {
    if (c.CONTACT_LOCAL_DEV || c.CONTACT_API_URL !== 'https://api.nuray.io/contact' || c.TURNSTILE_SITE_KEY !== prodKey) throw new Error('production config changed unexpectedly');
  }
  if (!localDev.CONTACT_LOCAL_DEV || localDev.CONTACT_API_URL !== 'http://localhost:8787/contact') throw new Error('local mode not available');
  if (localDev.TURNSTILE_SITE_KEY !== '1x00000000000000000000AA') throw new Error('local mode must use only the public Turnstile test key');
  if (/localhost/.test(readFileSync('index.html', 'utf8').match(/Content-Security-Policy" content="([^"]+)"/)[1])) throw new Error('production CSP mentions localhost');
});
await test('Contact local dev harness: real Worker code, mocked Turnstile/Resend; browser flow works over real HTTP with CORS', async () => {
  const child = spawn(process.execPath, ['tests/contact-dev.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 50 && !out.includes('Local mock API'); i++) await new Promise((r) => setTimeout(r, 100));
    if (!out.includes('Local mock API')) throw new Error('harness did not start (ports 4173/8787 busy?): ' + out.slice(0, 200));
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    const problems = []; p.on('console', (m) => { if (/Content Security Policy|Refused/i.test(m.text())) problems.push(m.text()); });
    await p.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_TURNSTILE }));
    await p.goto('http://localhost:4173/?contactDev=1&lang=en');
    await p.focus('#cf-name'); await fillForm(p);
    await p.waitForTimeout(3300);
    const resp = p.waitForResponse((r) => r.url() === 'http://localhost:8787/contact' && r.request().method() === 'POST');
    await p.click('#cf-submit');
    const r = await resp;
    await p.waitForFunction(() => /sent a verification link to ada@example.org/.test(document.getElementById('cf-status').textContent));
    if (r.status() !== 200 || r.headers()['x-contact-dev-mock'] !== '1') throw new Error('unexpected API response ' + r.status());
    // Nothing reaches the owner before the link is used.
    if (/would send the owner notification/.test(out)) throw new Error('the owner was notified before the e-mail address was confirmed');
    const link = (out.match(/confirmation link \(nothing is sent\): (\S+)/) || [])[1];
    if (!link || !/^http:\/\/localhost:4173\/verify\.html\?contactDev=1&lang=en#t=[A-Za-z0-9_-]{43}$/.test(link)) throw new Error('confirmation link missing or malformed: ' + link);
    // Opening the link does nothing by itself; the button confirms and delivers the message once.
    const v = await ctx.newPage();
    v.on('console', (m) => { if (/Content Security Policy|Refused/i.test(m.text())) problems.push(m.text()); });
    await v.goto(link);
    await v.waitForSelector('#verify-btn');
    await v.waitForTimeout(400);
    if (/would send the owner notification/.test(out)) throw new Error('opening the link delivered the message');
    await v.click('#verify-btn');
    await v.waitForFunction(() => /Your message has been sent successfully/.test(document.getElementById('verify-status').textContent));
    const hidden = await v.evaluate(() => ({ btn: document.getElementById('verify-btn').hidden, hash: location.hash }));
    await v.goto('about:blank'); // same URL plus a hash would be a same-document navigation without a reload
    await v.goto(link);
    await v.waitForSelector('#verify-btn');
    await v.click('#verify-btn');
    await v.waitForFunction(() => /invalid, has already been used, or has expired/.test(document.getElementById('verify-status').textContent));
    await ctx.close();
    if (!hidden.btn || hidden.hash) throw new Error('the used link must disappear: ' + JSON.stringify(hidden));
    if (problems.length) throw new Error('CSP: ' + problems.join('|'));
    await new Promise((r) => setTimeout(r, 300)); // the acknowledgment is sent right after the answer
    if (out.match(/would send the owner notification/g)?.length !== 1 || !/would send the acknowledgment/.test(out)) throw new Error('expected exactly one owner notification and an acknowledgment after the confirmation');
  } finally { child.kill(); }
  return 'mocked Turnstile/Resend only: no real verification or email';
});
await test('Typography: Google Sans loads locally in en/de/tr (Turkish letters via latin-ext), body 16-18px, line-height 1.5-1.7, readable line length', async () => {
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: '/?lang=' + lang });
    const info = await p.evaluate(async () => {
      await document.fonts.ready;
      const b = getComputedStyle(document.body); const fs = parseFloat(b.fontSize);
      const para = document.querySelector('#about .reveal p'); const cs = getComputedStyle(para); const ctx2 = document.createElement('canvas').getContext('2d'); ctx2.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      const avg = ctx2.measureText(para.textContent).width / para.textContent.length;
      return { family: b.fontFamily, fs, lh: parseFloat(b.lineHeight) / fs, weight: b.fontWeight,
        loaded: [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Google Sans' && f.status === 'loaded').length,
        check: document.fonts.check('400 16px "Google Sans"', document.documentElement.lang === 'tr' ? 'ÖöÜüÇçĞğİıŞş' : 'ÖöÜüß'), bold: document.fonts.check('700 16px "Google Sans"', 'Aa'),
        cpl: para.getBoundingClientRect().width / avg, width: para.getBoundingClientRect().width };
    });
    const hosts = [...p.hosts].filter((h) => h !== new URL(base).host); await p.context().close();
    if (!/^"?Google Sans"?, "?Inter"?, "?Source Sans 3"?, Arial, Helvetica, sans-serif$/.test(info.family)) throw new Error(lang + ': font stack ' + info.family);
    if (info.fs < 16 || info.fs > 18) throw new Error(lang + ': body size ' + info.fs);
    if (info.lh < 1.5 || info.lh > 1.7) throw new Error(lang + ': line-height ' + info.lh);
    if (+info.weight < 400 || +info.weight > 500) throw new Error(lang + ': body weight ' + info.weight);
    if (!info.loaded || !info.check || !info.bold) throw new Error(lang + ': Google Sans not loaded ' + JSON.stringify(info));
    if (lang === 'tr' && info.loaded < 2) throw new Error('tr: latin-ext subset not loaded');
    // Owner decision: section paragraphs span the full column so justified text lines up with the cards (about 82-93 characters per line, above the usual 65-75 guideline).
    if (info.cpl < 60 || info.cpl > 96) throw new Error(lang + ': characters per line ' + Math.round(info.cpl));
    if (hosts.length) throw new Error(lang + ': external font hosts ' + hosts);
  }
});
await test('Typography: if the font files fail to load, text stays visible, layout height stays within 5% and nothing overflows (320 and 1280 px, en/de/tr)', async () => {
  for (const lang of ['en', 'de', 'tr']) for (const width of [320, 1280]) {
    const measure = async (blockFonts) => {
      const ctx = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' }); const p = await ctx.newPage();
      if (blockFonts) await p.route('**/assets/fonts/**', (r) => r.abort());
      await p.goto(base + '/?lang=' + lang); await p.waitForLoadState('networkidle');
      const m = await p.evaluate(() => ({ h: document.documentElement.scrollHeight, over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        loaded: [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Google Sans' && f.status === 'loaded'),
        heading: document.querySelector('#hero-title').getBoundingClientRect().height, family: getComputedStyle(document.body).fontFamily }));
      await ctx.close(); return m;
    };
    const [ok, blocked] = [await measure(false), await measure(true)];
    if (blocked.loaded) throw new Error('font was not blocked');
    if (blocked.over > 0 || ok.over > 0) throw new Error(lang + ' ' + width + ': horizontal overflow ' + blocked.over);
    if (blocked.heading < 20) throw new Error(lang + ' ' + width + ': heading collapsed without the font');
    if (!/Arial/.test(blocked.family) || !/Inter/.test(blocked.family)) throw new Error('fallback stack incomplete');
    const diff = Math.abs(ok.h - blocked.h) / ok.h;
    if (diff > 0.05) throw new Error(lang + ' ' + width + ': page height differs ' + (diff * 100).toFixed(1) + '%');
  }
});
await test('Text enlargement: root font size 200% causes no horizontal overflow or clipped headings/buttons (en/de/tr; 640 px = a 1280 px window at 200%, and 390 px phone)', async () => {
  for (const lang of ['en', 'de', 'tr']) for (const width of [640, 390]) {
    const p = await newPage({ path: '/?lang=' + lang, viewport: { width, height: 800 } });
    await p.evaluate(() => document.documentElement.style.setProperty('font-size', '200%', 'important'));
    await p.waitForTimeout(150);
    const r = await p.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      clipped: [...document.querySelectorAll('h1, h2, h3, .btn, label, #cf-submit')].filter((e) => e.offsetParent && !e.classList.contains('visually-hidden') && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').map((e) => e.id || e.className || e.tagName),
      fs: parseFloat(getComputedStyle(document.body).fontSize) }));
    await p.context().close();
    if (r.fs < 30) throw new Error('root font size not enlarged: ' + r.fs);
    if (r.over > 0) throw new Error(lang + ' ' + width + ': horizontal overflow ' + r.over + 'px');
    if (r.clipped.length) throw new Error(lang + ' ' + width + ': clipped ' + r.clipped);
  }
});
await test('Justified paragraphs: body text is justified with hyphenation on phones, tablets and desktop; short meta lines and narrow cards stay left-aligned; nothing overflows (en/de/tr, 320/390/1280 px)', async () => {
  for (const lang of ['en', 'de', 'tr']) for (const width of [320, 390, 1280]) {
    const p = await newPage({ path: '/?lang=' + lang, viewport: { width, height: 900 } });
    const r = await p.evaluate(() => {
      const al = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null).map((e) => { const c = getComputedStyle(e); return c.textAlign + '/' + c.hyphens; });
      return { about: al('#about .reveal p'), exp: al('#experience .card p:not(.meta)'), notice: al('footer .footer-notice'), meta: al('#experience .card .meta'), lang: al('.lang-card p'), over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    await p.context().close();
    const want = 'justify/auto';
    const bad = (arr, w) => arr.filter((x) => x !== w);
    if (!r.about.length || bad(r.about, want).length) throw new Error(lang + ' ' + width + ': About alignment wrong (expected ' + want + ') ' + r.about);
    if (!r.exp.length || bad(r.exp, want).length) throw new Error(lang + ' ' + width + ': experience text alignment wrong (expected ' + want + ') ' + r.exp);
    if (bad(r.notice, want).length) throw new Error(lang + ' ' + width + ': footer notice alignment wrong (expected ' + want + ')');
    if (r.meta.some((x) => x.startsWith('justify')) || r.lang.some((x) => x.startsWith('justify'))) throw new Error(lang + ' ' + width + ': meta or narrow-card text is justified');
    if (r.over > 0) throw new Error(lang + ' ' + width + ': horizontal overflow ' + r.over);
  }
});
await test('Chip lists are justified: every full row ends at the right edge of the list, the last row keeps natural widths (en/de/tr, 320/390/768/1280 px)', async () => {
  for (const lang of ['en', 'de', 'tr']) for (const width of [320, 390, 768, 1280]) {
    const p = await newPage({ path: '/?lang=' + lang, viewport: { width, height: 900 } });
    const lists = await p.evaluate(() => [...document.querySelectorAll('ul.chips')].map((ul) => {
      const box = ul.getBoundingClientRect(); const rows = new Map();
      [...ul.children].forEach((li) => { const r = li.getBoundingClientRect(); const k = Math.round(r.top); rows.set(k, Math.max(rows.get(k) ?? 0, r.right)); });
      const rights = [...rows.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      return { n: ul.children.length, listRight: box.right, rights, over: ul.scrollWidth - ul.clientWidth };
    }));
    await p.context().close();
    if (lists.length !== 1) throw new Error(lang + ' ' + width + ': expected 1 chip list, found ' + lists.length);
    for (const l of lists) {
      if (l.over > 0) throw new Error(lang + ' ' + width + ': chip list overflows');
      l.rights.slice(0, -1).forEach((r, i) => { if (Math.abs(r - l.listRight) > 1.5) throw new Error(lang + ' ' + width + ': row ' + (i + 1) + ' of ' + l.n + ' chips ends ' + (l.listRight - r).toFixed(1) + 'px from the right edge'); });
      if (l.rights.at(-1) > l.listRight + 1.5) throw new Error(lang + ' ' + width + ': last row sticks out');
    }
  }
});await test('Header menu sits centred between logo and tools on desktop (equal gaps in en/de/tr), one row, no overflow; burger layout below 1200 px is unchanged', async () => {
  for (const lang of ['en', 'de', 'tr']) for (const width of [1201, 1280, 1440, 1920]) {
    const p = await newPage({ path: '/?lang=' + lang, viewport: { width, height: 700 } });
    const r = await p.evaluate(() => { const g = (s) => document.querySelector(s).getBoundingClientRect(); const nav = g('.primary-nav ul'); const br = g('.brand'); const tools = g('.header-tools'); const vw = document.documentElement.clientWidth;
      return { gapL: nav.left - br.right, gapR: tools.left - nav.right, h: g('.site-header').height, over: document.documentElement.scrollWidth - vw }; });
    await p.context().close();
    if (Math.abs(r.gapL - r.gapR) > 2) throw new Error(lang + ' ' + width + ': gaps differ, logo-menu ' + r.gapL.toFixed(1) + ' px, menu-tools ' + r.gapR.toFixed(1) + ' px');
    if (r.gapL < 12 || r.h > 80 || r.over > 0) throw new Error(lang + ' ' + width + ': header cramped, wraps or overflows ' + JSON.stringify(r));
  }
  const p = await newPage({ viewport: { width: 1100, height: 700 } });
  const burger = await p.evaluate(() => ({ btn: getComputedStyle(document.getElementById('menu-btn')).display, nav: getComputedStyle(document.getElementById('primary-nav')).display }));
  await p.context().close();
  if (burger.btn === 'none' || burger.nav !== 'none') throw new Error('burger layout changed at 1100 px: ' + JSON.stringify(burger));
});await test('Target size: every visible button, select, input, textarea, icon link and nav link is at least 24x24 CSS px (desktop and mobile)', async () => {
  for (const [w, h] of [[1280, 800], [390, 800]]) {
    const p = await newPage({ viewport: { width: w, height: h } });
    const small = await p.evaluate(() => [...document.querySelectorAll('button, select, input:not([type=hidden]), textarea, .btn, .icon-link, .primary-nav a, summary')]
      .filter((e) => e.offsetParent !== null && !e.closest('.hp') && !e.closest('[hidden]'))
      .map((e) => ({ n: (e.id || e.className || e.tagName) + '', r: e.getBoundingClientRect() })).filter((x) => x.r.width > 0 && (x.r.width < 24 || x.r.height < 24)).map((x) => x.n + ' ' + Math.round(x.r.width) + 'x' + Math.round(x.r.height)));
    await p.context().close();
    if (small.length) throw new Error(w + 'px: ' + small.join(', '));
  }
});
await test('Forced colours (Windows High Contrast): buttons, icon links and tags keep a visible border', async () => {
  const ctx = await browser.newContext({ forcedColors: 'active', viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage();
  await p.goto(base + '/'); await p.waitForLoadState('networkidle');
  const res = await p.evaluate(() => ['.btn-secondary', '.icon-link', '.icon-btn', '.btn-primary'].map((s) => { const e = document.querySelector(s); const c = getComputedStyle(e); return [s, c.borderTopWidth, c.borderTopStyle]; }));
  await ctx.close();
  for (const [s, wd, st] of res) if (wd === '0px' || st === 'none') throw new Error(s + ' has no border in forced-colours mode');
});
await test('Navigation: "Certifications" label in en/de/tr (desktop and mobile), anchors and sections intact', async () => {
  const want = {
    en: ['About', 'Work Experience', 'Education', 'Skills', 'Certifications and Training', 'Projects', 'Contact'],
    de: ['Über mich', 'Berufserfahrung', 'Ausbildung', 'Kompetenzen', 'Zertifizierungen', 'Projekte', 'Kontakt'],
    tr: ['Hakkımda', 'İş Deneyimi', 'Eğitim', 'Yetkinlikler', 'Sertifikalar ve Eğitimler', 'Projeler', 'İletişim'],
  };
  const hrefs = ['#about', '#experience', '#education', '#skills', '#credentials', '#projects', '#contact'];
  for (const lang of ['en', 'de', 'tr']) {
    for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const p = await newPage({ path: '/?lang=' + lang, viewport: vp });
      const nav = await p.$$eval('#primary-nav a', (a) => a.map((x) => [x.getAttribute('href'), x.textContent.trim()]));
      const missing = await p.evaluate((h) => h.filter((x) => !document.querySelector(x)), hrefs);
      const certCards = await p.$$eval('#credentials #cred-grid > *', (n) => n.length);
      const eduCards = await p.$$eval('#education .card', (n) => n.length);
      const labels = nav.map((n) => n[1]);
      if (nav.map((n) => n[0]).join() !== hrefs.join()) throw new Error(lang + ': nav hrefs ' + nav.map((n) => n[0]));
      if (labels.join('|') !== want[lang].join('|')) throw new Error(lang + ' ' + vp.width + ': nav labels ' + labels.join('|'));
      if (new Set(labels).size !== labels.length) throw new Error(lang + ': duplicate nav labels');
      if (/Credentials|Zertifikate$|Sertifikalar$/.test(labels[4]) && lang === 'en') throw new Error('old label');
      if (missing.length) throw new Error(lang + ': missing section ' + missing);
      if (certCards < 8 || eduCards !== 2) throw new Error(lang + ': content missing: ' + certCards + ' certs, ' + eduCards + ' edu');
      if (vp.width < 600) {
        await p.click('#menu-btn');
        await p.click('#primary-nav a[href="#credentials"]');
        await p.waitForTimeout(400);
        const open = await p.getAttribute('#menu-btn', 'aria-expanded');
        if (open !== 'false') throw new Error(lang + ': menu stayed open');
      } else {
        await p.click('#primary-nav a[href="#credentials"]');
        await p.waitForTimeout(400);
      }
      if (!p.url().endsWith('#credentials')) throw new Error(lang + ': anchor did not navigate ' + p.url());
      const inView = await p.waitForFunction(() => { const r = document.getElementById('credentials').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 && r.top < innerHeight * 0.5; }, null, { timeout: 5000 }).then(() => true, () => false);
      if (!inView) throw new Error(lang + ': credentials section not scrolled into view');
      await p.context().close();
    }
  }
});

await test('Education: logos match universities, LinkedIn + official links, localized degrees (en/de/tr)', async () => {
  const degrees = { en: ["Bachelor's degree in Physics", "Bachelor's degree in Business Administration"], de: ['Bachelorabschluss in Physik', 'Bachelorabschluss in Betriebswirtschaftslehre'], tr: ['Fizik Lisans Derecesi', 'İşletme Lisans Derecesi'] };
  const want = [
    { org: 'Marmara Üniversitesi', logo: 'marmara-logo', li: 'https://www.linkedin.com/school/marmara1883/', web: 'https://www.marmara.edu.tr/', period: '2003–2008' },
    { org: 'Anadolu Üniversitesi', logo: 'anadolu-logo', li: 'https://www.linkedin.com/school/anadoluuniv/', web: 'https://www.anadolu.edu.tr/acikogretim', period: '2004–2009' },
  ];
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: `/?lang=${lang}` });
    await p.locator('#education').scrollIntoViewIfNeeded(); // logos are lazy-loaded
    await p.waitForFunction(() => [...document.querySelectorAll('#education img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 5000 }).catch(() => {});
    const cards = await p.$$eval('#education .card', (n) => n.map((c) => ({
      h3: c.querySelector('h3').textContent, text: c.textContent,
      img: (() => { const i = c.querySelector('img'); return { src: i.getAttribute('src'), alt: i.alt, ok: i.complete && i.naturalWidth > 0 }; })(),
      links: [...c.querySelectorAll('a')].map((a) => ({ h: a.getAttribute('href'), t: a.target, r: a.rel, d: a.getAttribute('aria-describedby') })) })));
    await p.context().close();
    if (cards.length !== 2) throw new Error(`${lang}: ${cards.length} cards`);
    cards.forEach((c, i) => {
      const w = want[i];
      if (c.h3.replace(/\u00ad/g, '') !== degrees[lang][i]) throw new Error(`${lang}: degree "${c.h3}"`);
      if (!c.text.includes(w.org) || !c.text.includes(w.period)) throw new Error(`${lang}: org/period for ${w.org}`);
      if (!c.img.src.includes(w.logo) || !c.img.ok || c.img.alt !== '') throw new Error(`${lang}: logo mapping/alt for ${w.org}: ${JSON.stringify(c.img)}`);
      if (c.links.length !== 2 || c.links[0].h !== w.li || c.links[1].h !== w.web) throw new Error(`${lang}: links for ${w.org}: ${JSON.stringify(c.links)}`);
      if (c.links.some((l) => l.t !== '_blank' || !/noopener/.test(l.r))) throw new Error(`${lang}: link safety`);
      if (!c.links[1].d) throw new Error(`${lang}: official link lacks aria-describedby`);
    });
  }
});

await test('Language cards: the Duolingo score row is pinned to the bottom of its card whatever the text length (en/de/tr; 320 to 1440 px)', async () => {
  for (const lang of ['en', 'de', 'tr']) for (const width of [320, 390, 768, 1024, 1280, 1440]) {
    const p = await newPage({ path: '/?lang=' + lang, viewport: { width, height: 900 } });
    const cards = await p.evaluate(() => {
      // Make one card clearly taller than its neighbours (as the German card was with its long note), so the test does not depend on the current texts.
      const de = document.querySelector('.lang-name[data-i18n="lang.de.name"]').closest('.lang-card');
      const note = document.createElement('p');
      note.className = 'lang-cert';
      note.textContent = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.';
      de.querySelector('.lang-level').after(note);
      return [...document.querySelectorAll('.lang-card')].map((li) => {
        const cs = getComputedStyle(li); const box = li.getBoundingClientRect(); const score = li.querySelector('.lang-score');
        return { name: li.querySelector('.lang-name').textContent, hasScore: Boolean(score), top: Math.round(box.top), height: Math.round(box.height),
          gap: score ? box.bottom - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth) - score.getBoundingClientRect().bottom : null,
          clear: score ? score.getBoundingClientRect().top - li.querySelector('.lang-level').getBoundingClientRect().bottom : null };
      });
    });
    await p.context().close();
    const where = lang + ' ' + width + ' px: ';
    if (cards.length !== 6) throw new Error(where + 'expected 6 language cards, found ' + cards.length);
    for (const c of cards.filter((x) => x.hasScore)) {
      if (Math.abs(c.gap) > 1) throw new Error(where + c.name + ': the score row ends ' + c.gap.toFixed(1) + ' px above the bottom of the card');
      if (c.clear < 4) throw new Error(where + c.name + ': the score row touches the text above it (' + c.clear.toFixed(1) + ' px)');
    }
    // the cards of one row must really differ in content, otherwise this test would prove nothing at this width
    if (width >= 768 && new Set(cards.filter((x) => x.top === cards[1].top).map((x) => x.height)).size < 1) throw new Error(where + 'no card row to compare');
  }
});
await test('Skill chips: 21 unique compact chips per language, German/Turkish labels, not interactive', async () => {
  const sample = { en: 'Network Engineering', de: 'Netzwerk-Engineering', tr: 'Ağ Mühendisliği' };
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: `/?lang=${lang}` });
    const chips = await p.$$eval('#skills .tags li', (n) => n.map((x) => x.textContent.trim()));
    const interactive = await p.$$eval('#skills .tags a, #skills .tags button, #skills .tags [tabindex], #skills .skill-cards a, #skills .skill-cards button, #skills .chips a, #skills .chips button', (n) => n.length);
    const heads = await p.$$eval('#skills h3', (n) => n.map((x) => x.textContent.trim()));
    const body = await p.textContent('body');
    await p.context().close();
    if (heads.length !== 4 || heads.some((x) => !x)) throw new Error(`${lang}: skills headings ${JSON.stringify(heads)}`);
    if (lang !== 'en' && heads.includes('Currently learning and using')) throw new Error(`${lang}: heading not translated`);
    if (/\$\d/.test(body)) throw new Error(`${lang}: stray template token on page`);
    if (chips.length !== 21) throw new Error(`${lang}: ${chips.length} chips`);
    if (new Set(chips.map((c) => c.toLowerCase())).size !== 21) throw new Error(`${lang}: duplicate chip labels`);
    if (!chips.includes(sample[lang])) throw new Error(`${lang}: missing ${sample[lang]}`);
    if (interactive) throw new Error(`${lang}: chips must not be interactive`);
  }
});

await test('Goethe A1/A2: each image belongs to its entry; ID + verification link; birth rows blank; scores visible', async () => {
  const p = await newPage();
  const cases = [['Start Deutsch 2', '1310-AA2A-0002378592', 'goethe-a2'], ['Start Deutsch 1', '1310-ASA1-0002264713', 'goethe-a1']];
  for (const [name, id, file] of cases) {
    await p.fill('#cred-search', name);
    await p.click('#cred-grid .cred-card >> nth=0');
    await p.waitForFunction(() => { const i = document.querySelector('#cred-dialog img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
    const d = await p.$eval('#cred-dialog', (e) => ({ text: e.textContent, src: e.querySelector('img').getAttribute('src'), alt: e.querySelector('img').alt, href: e.querySelector('a')?.href, scroll: e.scrollTop }));
    await p.keyboard.press('Escape');
    if (!d.text.includes(id) || !d.text.includes('Goethe-Institut e.V.')) throw new Error(name + ': text/ID ' + id);
    if (!d.src.includes(file)) throw new Error(name + ': wrong image ' + d.src);
    if (!/^https:\/\/verify\.goethe\.de\//.test(d.href || '')) throw new Error(name + ': verification link ' + d.href);
    if (!/certificate document/.test(d.alt)) throw new Error(name + ': alt ' + d.alt);
    if (d.scroll !== 0) throw new Error(name + ': dialog not opened at the top');
    // pixel checks on the published asset
    const px = await p.evaluate(async (src) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const stat = (x, y, w, h) => { const a = ctx.getImageData(x, y, w, h).data; let min = 255, dark = 0; for (let i = 0; i < a.length; i += 4) { const v = Math.min(a[i], a[i + 1], a[i + 2]); if (v < min) min = v; if (v < 160) dark++; } return { min, dark }; };
      return { w: img.width, h: img.height, birthRows: stat(130, 455, 480, 60), scores: stat(480, 715, 200, 110), name: stat(140, 418, 120, 20), examRow: stat(140, 525, 420, 22) };
    }, '/' + d.src);
    if (px.w !== 905 || px.h !== 1280) throw new Error(name + ': size ' + px.w + 'x' + px.h);
    if (px.birthRows.min < 245) throw new Error(name + ': birth rows not blank (min ' + px.birthRows.min + ')');
    if (px.scores.dark < 150) throw new Error(name + ': scores not visible');
    if (px.name.dark < 30 || px.examRow.dark < 30) throw new Error(name + ': name or exam row missing');
  }
  await p.context().close();
  return 'A1/A2 images mapped correctly; blank birth rows; scores, name and exam rows present';
});

await test('CBT Nuggets item: completion date 17 December 2016 in en/de/tr, learning activity, no verification link', async () => {
  const want = { en: ['17 December 2016', 'Completed', 'Training and learning activity'], de: ['17. Dezember 2016', 'Abgeschlossen', 'Schulung und Lernaktivität'], tr: ['17 Aralık 2016', 'Tamamlandı', 'Eğitim ve öğrenme etkinliği'] };
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: '/?lang=' + lang });
    await p.fill('#cred-search', 'Ethical');
    const card = await p.textContent('#cred-grid .cred-card');
    await p.click('#cred-grid .cred-card >> nth=0');
    await p.waitForFunction(() => { const i = document.querySelector('#cred-dialog img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
    const d = await p.$eval('#cred-dialog', (e) => ({ text: e.textContent, links: e.querySelectorAll('a').length, alt: e.querySelector('img').alt }));
    await p.context().close();
    const [date, label, type] = want[lang];
    if (!card.includes(date)) throw new Error(lang + ': card date missing: ' + card);
    if (!d.text.includes(date) || !d.text.includes(label) || !d.text.includes(type)) throw new Error(lang + ': dialog ' + d.text.slice(0, 160));
    if (!d.text.includes('CBT Nuggets')) throw new Error(lang + ': issuer');
    if (d.links !== 0) throw new Error(lang + ': unexpected link');
    if (lang === 'en' && !/not an exam certification/.test(d.text)) throw new Error('completion note missing');
  }
});

await test('Keyboard: every one of the first 45 tab stops shows a visible focus indicator (light and dark)', async () => {
  for (const scheme of ['light', 'dark']) {
    const p = await newPage({ colorScheme: scheme });
    const bad = []; let n = 0;
    for (let i = 0; i < 45; i++) {
      await p.keyboard.press('Tab');
      const r = await p.evaluate(() => {
        const e = document.activeElement; if (!e || e === document.body) return null;
        const s = getComputedStyle(e); const r = e.getBoundingClientRect();
        return { tag: e.tagName.toLowerCase() + (e.id ? '#' + e.id : ''), outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2, w: r.width, h: r.height };
      });
      if (!r) continue; n++;
      if (r.w > 0 && r.h > 0 && !r.outline) bad.push(r.tag);
    }
    await p.context().close();
    if (n < 20) throw new Error(scheme + ': only ' + n + ' tab stops reached');
    if (bad.length) throw new Error(scheme + ': no visible focus on ' + bad.join(', '));
  }
});

await test('Reduced motion: reveal content visible without animation', async () => {
  const p = await newPage({ reducedMotion: 'reduce' });
  const o = await p.$eval('#about .reveal', (e) => getComputedStyle(e).opacity); await p.context().close();
  if (o !== '1') throw new Error(`opacity ${o}`);
});

await test('Keyboard: skip link is first tab stop', async () => {
  const p = await newPage();
  await p.keyboard.press('Tab');
  if (!(await p.evaluate(() => document.activeElement.classList.contains('skip-link')))) throw new Error('skip link not first');
  await p.context().close();
});

await test('Provider icons: Cloudflare, Resend and Zoho carry a small local icon on the left of the link text in both privacy notices (en/de/tr; 390/768/1280 px); no third-party request, no overflow, hidden in forced-colours mode', async () => {
  const want = { cloudflare: ['Cloudflare', 'https://www.cloudflare.com/'], resend: ['Resend', 'https://resend.com/'], zoho: ['Zoho', 'https://www.zoho.com/'], 'github-pages': ['GitHub Pages', 'https://pages.github.com/'] };
  for (const [provider] of Object.entries(want)) {
    const res = await fetch(base + '/assets/icons/providers/' + provider + '.png');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || bytes.subarray(0, 4).toString('hex') !== '89504e47' || bytes.length > 20000) throw new Error(provider + ': icon file missing, not a PNG or too large');
  }
  for (const lang of ['en', 'de', 'tr']) for (const width of [390, 768, 1280]) {
    const p = await newPage({ path: '/?lang=' + lang, viewport: { width, height: 900 } });
    const info = await p.evaluate(() => {
      const links = [];
      for (const sel of ['#form-privacy', 'footer .footer-notice']) {
        for (const a of document.querySelector(sel).querySelectorAll('a')) {
          const cs = getComputedStyle(a, '::before'); const fs = parseFloat(getComputedStyle(a).fontSize);
          links.push({ sel, text: a.textContent, provider: a.dataset.provider, cls: a.className, href: a.href, target: a.target, rel: a.rel, content: cs.content, display: cs.display,
            w: parseFloat(cs.width) / fs, h: parseFloat(cs.height) / fs, va: parseFloat(cs.verticalAlign) / fs, img: cs.backgroundImage, nowrap: getComputedStyle(a).whiteSpace });
        }
      }
      return { links, over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    const external = [...p.hosts].filter((h) => h !== new URL(base).host);
    await p.context().close();
    const where = lang + ' ' + width + ' px: ';
    if (info.links.length !== 7) throw new Error(where + 'expected 3 provider links in the form notice and 4 in the footer notice, found ' + info.links.length);
    info.links.forEach((l, i) => {
      const provider = ['cloudflare', 'resend', 'zoho', 'cloudflare', 'resend', 'zoho', 'github-pages'][i];
      if (l.provider !== provider || l.text !== want[provider][0] || !/provider-link/.test(l.cls)) throw new Error(where + 'wrong link or order: ' + JSON.stringify(l));
      if (l.href !== want[provider][1] || l.target !== '_blank' || !/noopener/.test(l.rel)) throw new Error(where + provider + ': link target changed: ' + l.href);
      if (l.content !== '""') throw new Error(where + provider + ': the icon must not add text (decorative): ' + l.content);
      if (l.display !== 'inline-block' || Math.abs(l.w - 1.05) > 0.03 || Math.abs(l.h - 1.05) > 0.03) throw new Error(where + provider + ': icon size ' + l.w.toFixed(2) + 'em x ' + l.h.toFixed(2) + 'em');
      if (Math.abs(l.va + 0.2) > 0.03) throw new Error(where + provider + ': icon is not on the text middle line (vertical-align ' + l.va.toFixed(2) + 'em)');
      if (!l.img.includes('/assets/icons/providers/' + provider + '.png')) throw new Error(where + provider + ': wrong icon file ' + l.img);
      if (l.nowrap !== 'nowrap') throw new Error(where + provider + ': icon could be separated from its name');
    });
    if (info.over > 0) throw new Error(where + 'horizontal overflow ' + info.over);
    if (external.length) throw new Error(where + 'third-party hosts contacted: ' + external.join(', '));
  }
  const ctx = await browser.newContext({ forcedColors: 'active', viewport: { width: 1280, height: 900 } });
  const fp = await ctx.newPage();
  await fp.goto(base + '/?lang=en'); await fp.waitForLoadState('networkidle');
  const shown = await fp.evaluate(() => [...document.querySelectorAll('#form-privacy a.provider-link, footer .footer-notice a.provider-link')].map((a) => getComputedStyle(a, '::before').display));
  await ctx.close();
  if (shown.length !== 7 || shown.some((d) => d !== 'none')) throw new Error('forced-colours mode must not reserve a gap for the icons: ' + shown);
});
await test('Footer notice: exact text in en/de/tr (includes the contact-form processing disclosure), no legal page or legal links, legal.html is gone', async () => {
  const want = {"tr":"Bu site, kişisel çevrim içi özgeçmişim ve portföyümdür. Kullanıcı hesabı, ziyaretçi analitiği veya reklam hizmetleri kullanmamaktadır. İletişim formu aracılığıyla gönderilen mesajlar, botlara karşı koruma için Cloudflare; e-posta gönderimi için Resend ve Zoho hizmetleri kullanılarak işlenir. Lütfen mesajlarınızda hassas kişisel bilgilerinizi paylaşmayın. Mesajınız ve e-posta adresiniz yalnızca size yanıt vermek amacıyla kullanılabilir. Bu amaç için gerekli olduğu sürece saklanabilir. Verilerinizin silinmesini talep etmek için iletişim formu üzerinden iletişime geçebilirsiniz. Dil ve tema tercihleriniz tarayıcınızda saklanır. Site GitHub Pages üzerinde barındırılmaktadır; barındırma hizmeti kapsamında teknik istek verileri işlenebilir. Harici bağlantılar, ilgili hizmetlerin kendi web sitelerine yönlendirir.","en":"This site is my personal online CV and portfolio. It does not use user accounts, visitor analytics, or advertising services. Messages sent through the contact form are processed using Cloudflare for bot protection and Resend and Zoho for email delivery. Please do not share sensitive personal information in your messages. Your message and email address may be used solely to reply to you. They may be retained for as long as necessary for that purpose. To request the deletion of your data, you can get in touch through the contact form. Your language and theme preferences are stored in your browser. The site is hosted on GitHub Pages; technical request data may be processed as part of the hosting service. External links lead to the respective services’ own websites.","de":"Diese Website ist mein persönlicher Online-Lebenslauf und mein Portfolio. Sie verwendet keine Benutzerkonten, keine Besucheranalyse und keine Werbedienste. Über das Kontaktformular gesendete Nachrichten werden zum Schutz vor Bots mithilfe von Cloudflare und für den E-Mail-Versand mithilfe von Resend und Zoho verarbeitet. Bitte teilen Sie in Ihren Nachrichten keine sensiblen personenbezogenen Daten mit. Ihre Nachricht und Ihre E-Mail-Adresse dürfen ausschließlich zur Beantwortung Ihrer Anfrage verwendet werden. Sie können so lange gespeichert werden, wie es für diesen Zweck erforderlich ist. Wenn Sie die Löschung Ihrer Daten beantragen möchten, können Sie mich über das Kontaktformular kontaktieren. Ihre Sprach- und Designeinstellungen werden in Ihrem Browser gespeichert. Die Website wird auf GitHub Pages gehostet; im Rahmen des Hostings können technische Anfragedaten verarbeitet werden. Externe Links führen zu den Websites der jeweiligen Anbieter."};
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: '/?lang=' + lang });
    const d = await p.evaluate(() => ({ notice: document.querySelector('footer .footer-notice')?.textContent.trim(), links: [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')), footerLinks: [...document.querySelectorAll('footer a')].map((a) => a.getAttribute('href')) }));
    await p.context().close();
    if (d.notice !== want[lang]) throw new Error(lang + ': notice differs: ' + d.notice);
    if (d.links.some((h) => /legal/i.test(h || ''))) throw new Error(lang + ': link to a legal page remains');
    if (d.footerLinks.join() !== '#top,https://www.cloudflare.com/,https://resend.com/,https://www.zoho.com,https://pages.github.com/') throw new Error(lang + ': unexpected footer links ' + d.footerLinks);
  }
  const res = await fetch(base + '/legal.html');
  if (res.status !== 404) throw new Error('legal.html still served: ' + res.status);
  if (/legal/i.test(readFileSync('sitemap.xml', 'utf8'))) throw new Error('sitemap still lists legal.html');
});

await test('Privacy claims match behaviour: no third-party hosts, no cookies, only lang/theme in localStorage, nothing in sessionStorage', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const hosts = new Set();
  p.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol)) hosts.add(u.host); });
  await p.goto(base + '/'); await p.waitForLoadState('networkidle');
  await p.selectOption('#lang-select', 'de'); await p.click('[data-theme-toggle]');
  await p.fill('#cred-search', 'ITIL'); await p.click('#cred-grid .cred-card >> nth=0'); await p.keyboard.press('Escape');
  await p.fill('#cred-search', 'typed search text');
  await p.reload(); await p.waitForLoadState('networkidle');
  const cookies = await ctx.cookies();
  const keys = await p.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), docCookie: document.cookie }));
  await ctx.close();
  const extra = [...hosts].filter((h) => h !== new URL(base).host);
  if (extra.length) throw new Error('unexpected hosts: ' + extra.join(', '));
  if (cookies.length || keys.docCookie) throw new Error('cookies present');
  if (keys.local.some((k) => !['lang', 'theme'].includes(k))) throw new Error('unexpected localStorage keys: ' + keys.local);
  if (keys.session.length) throw new Error('unexpected sessionStorage keys: ' + keys.session);
  return 'hosts: ' + [...hosts].join(', ') + '; cookies: 0; localStorage: ' + keys.local.join(',') + '; sessionStorage: none';
});

await test('Featured credentials: the exact eight, in the exact order, identical in en/de/tr; expiry labelled', async () => {
  const want = ['AWS Certified SysOps Administrator – Associate', 'AWS Certified Solutions Architect – Associate', 'AWS Certified Cloud Practitioner',
    'Cisco Certified Design Associate (CCDA)', 'Cisco Certified Network Associate Security (CCNA Security)',
    'Cisco Certified Network Associate Routing and Switching (CCNA Routing and Switching)', 'Goethe-Zertifikat A2 / Start Deutsch 2', 'Goethe-Zertifikat A1 / Start Deutsch 1'];
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: '/?lang=' + lang });
    const cards = await p.$$eval('#cred-grid .cred-card', (n) => n.map((c) => ({ title: c.querySelector('h3').textContent, meta: c.querySelector('.meta').textContent })));
    await p.click('#cred-toggle');
    const first8 = await p.$$eval('#cred-grid .cred-card h3', (n) => n.slice(0, 8).map((x) => x.textContent));
    const total = await p.$$eval('#cred-grid .cred-card', (n) => n.length);
    await p.context().close();
    if (cards.map((c) => c.title).join('|') !== want.join('|')) throw new Error(lang + ': default order ' + cards.map((c) => c.title).join(' | '));
    if (first8.join('|') !== want.join('|') || total !== 20) throw new Error(lang + ': show-all order/total ' + total);
    const expiredWord = { en: 'Expired', de: 'Abgelaufen', tr: 'Süresi doldu' }[lang];
    cards.slice(0, 6).forEach((c) => { if (!c.meta.includes(expiredWord)) throw new Error(lang + ': ' + c.title + ' not marked expired: ' + c.meta); });
    cards.slice(6).forEach((c) => { if (c.meta.includes(expiredWord)) throw new Error(lang + ': ' + c.title + ' wrongly marked expired'); });
  }
});

await test('Text stays selectable and copy is not intercepted (no copy blocking)', async () => {
  const p = await newPage();
  await p.click('#about p >> nth=1', { clickCount: 3 });
  const sel = await p.evaluate(() => window.getSelection().toString().length);
  const us = await p.evaluate(() => getComputedStyle(document.body).userSelect);
  const ctxPrevented = await p.evaluate(() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); document.querySelector('#about p').dispatchEvent(e); return e.defaultPrevented; });
  const copyPrevented = await p.evaluate(() => { const e = new Event('copy', { bubbles: true, cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; });
  await p.context().close();
  if (sel < 20) throw new Error('selection failed: ' + sel);
  if (us === 'none') throw new Error('user-select none');
  if (ctxPrevented || copyPrevented) throw new Error('context menu or copy intercepted');
});

// Automated accessibility (axe-core). Automated tools cannot prove WCAG conformance.
const axeSrc = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');
await test('axe-core: no violations (3 languages x light/dark)', async () => {
  const found = [];
  for (const path of ['/']) for (const lang of ['en', 'de', 'tr']) for (const scheme of ['light', 'dark']) {
    const p = await newPage({ path: `${path}?lang=${lang}`, colorScheme: scheme, bypassCSP: true });
    await p.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('is-visible')));
    await p.waitForTimeout(900);
    await p.addScriptTag({ content: axeSrc });
    const r = await p.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] }));
    r.violations.forEach((v) => found.push(`${path} ${lang}/${scheme}: ${v.id} (${v.nodes.length}) ${v.nodes[0].target}`));
    await p.context().close();
  }
  if (found.length) throw new Error(found.slice(0, 6).join(' || '));
  return '6 page/language/theme combinations';
});

await browser.close(); server.close();
for (const [n, r, d] of results) console.log(r + '  ' + n + (d ? '  [' + d + ']' : ''));
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);

// End-to-end checks using playwright-core with the locally installed Microsoft Edge (Chromium).
// External services are never contacted; fixtures are served locally.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';
import { findPrivate, denylistLoaded } from './denylist.mjs';

const ROOT = process.cwd();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.xml': 'application/xml' };
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
const test = async (name, fn) => { try { const d = await fn(); record(name, true, d || ''); } catch (e) { record(name, false, String(e.message).split('\n')[0]); } };

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

await test('Theme toggle persists; follows OS preference initially', async () => {
  const p = await newPage({ colorScheme: 'dark' });
  if ((await p.getAttribute('html', 'data-theme')) !== 'dark') throw new Error('OS dark not honoured');
  await p.click('[data-theme-toggle]');
  await p.reload();
  if ((await p.getAttribute('html', 'data-theme')) !== 'light') throw new Error('choice not persisted');
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
  for (const i of data) if (i.credentialUrl?.includes('credly.com')) { if (ids.has(i.credentialUrl)) bad.push('dup url ' + i.title); ids.set(i.credentialUrl, i.title); }
  if (bad.length) throw new Error(bad.join(', '));
  return `${data.length} credentials, ${[...ids].length} unique Credly URLs`;
});

await test('Profile content: 3 jobs, 2 degrees, portrait image, no placeholders (en/de/tr)', async () => {
  const exp = { en: 'May 2018 – present', de: 'Mai 2018 – heute', tr: 'Mayıs 2018 – devam ediyor' };
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
await test('Real projects.json: 3 forks with fork tag, upstream links and local descriptions in en/de/tr', async () => {
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: `/?lang=${lang}` });
    const cards = await p.$$eval('#proj-grid .proj-card', (n) => n.map((c) => ({
      name: c.querySelector('h3').textContent, tag: c.querySelector('.tag')?.textContent,
      links: [...c.querySelectorAll('a')].map((a) => a.href), text: c.textContent })));
    await p.context().close();
    if (cards.map((c) => c.name).join() !== 'Veto,adns,loophole') throw new Error(`${lang}: ${cards.map((c) => c.name)}`);
    const want = { Veto: ['ProfessorQuantumUniverse/Veto', 'Kotlin'], adns: ['eyalm2000/adns', 'Kotlin'], loophole: ['eyalm2000/loophole', 'TypeScript'] };
    for (const c of cards) {
      if (!c.tag) throw new Error(`${c.name}: no fork tag`);
      if (!c.links.includes(`https://github.com/${want[c.name][0]}`)) throw new Error(`${c.name}: upstream link missing`);
      if (!c.links.includes(`https://github.com/ondern/${c.name}`)) throw new Error(`${c.name}: own link missing`);
      if (!c.text.includes(want[c.name][1])) throw new Error(`${c.name}: upstream language missing`);
    }
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
    en: { org: 'retail and information technology', more: 'More about my career and projects:' },
    de: { org: 'Einzelhandels- und Informationstechnologiesektor', more: 'Mehr zu meinem Werdegang' },
    tr: { org: 'Perakende ve bilgi teknolojileri', more: 'Kariyerim ve projelerim' },
  };
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: `/?lang=${lang}` });
    const exp = await p.textContent('#experience');
    const links = await p.$$eval('#experience a', (a) => a.map((x) => x.href));
    const body = await p.textContent('body');
    await p.context().close();
    if (!exp.includes(want[lang].org)) throw new Error(`${lang}: employer description missing`);
    if (!exp.includes(want[lang].more)) throw new Error(`${lang}: more-line missing`);
    if (!links.includes('https://www.linkedin.com/in/ondernuray/') || !links.includes('https://github.com/ondern')) throw new Error(`${lang}: LinkedIn/GitHub links missing in experience`);
    const priv = findPrivate(body); if (priv && priv.length) throw new Error(`${lang}: private word visible: ${priv}`);
    if (/B1 zertifiziert|B1 sertifikalı|B1 certified/i.test(body)) throw new Error(`${lang}: B1 must not be described as certified`);
  }
});

await test('Experience descriptions: the three supplied texts, exactly, in en/de/tr; metadata unchanged', async () => {
  const want = {"en":{"1":"I deliver end-to-end IT support, combining strong technical troubleshooting skills with a proactive, customer-focused approach to ensure reliable systems and minimal downtime. I drive operational excellence through process improvement, cross-functional collaboration, technical project delivery, and efficient IT asset and vendor management.","2":"Delivered end-to-end IT support to approximately 4,700 employees across corporate offices, call centers, and manufacturing environments, ensuring operational continuity through rapid troubleshooting, infrastructure management, and VIP support. Managed the full IT asset lifecycle, strengthened security and access management, and contributed to infrastructure projects, technical documentation, and reliable production operations.","3":"Delivered dedicated IT support to exchange and trading floor personnel, maintaining the availability and performance of critical workstations and specialized trading equipment in a high-pressure financial environment. Minimized downtime through rapid hardware troubleshooting, proactive maintenance, and close collaboration with IT teams on upgrades, replacements, and business continuity."},"de":{"1":"Ich biete IT-Support aus einer Hand und verbinde fundierte technische Fehleranalyse mit einer proaktiven, kundenorientierten Arbeitsweise, damit Systeme zuverlässig laufen und Ausfallzeiten minimal bleiben. Operative Exzellenz fördere ich durch Prozessverbesserung, bereichsübergreifende Zusammenarbeit, die Umsetzung technischer Projekte sowie ein effizientes Management von IT-Assets und Dienstleistern.","2":"Umfassender IT-Support für rund 4.700 Beschäftigte in Büros, Callcentern und Fertigungsumgebungen; Sicherstellung der Betriebskontinuität durch schnelle Fehlerbehebung, Infrastrukturmanagement und VIP-Support. Verwaltung des gesamten Lebenszyklus der IT-Assets, Stärkung von Sicherheit und Zugriffsverwaltung sowie Beiträge zu Infrastrukturprojekten, technischer Dokumentation und einem zuverlässigen Produktionsbetrieb.","3":"Dedizierter IT-Support für das Personal an Börse und Handelsparkett: Sicherstellung von Verfügbarkeit und Leistung kritischer Arbeitsplätze und spezialisierter Handelstechnik in einem anspruchsvollen Finanzumfeld unter hohem Druck. Ausfallzeiten minimiert durch schnelle Hardware-Fehlerbehebung, vorausschauende Wartung und enge Zusammenarbeit mit IT-Teams bei Upgrades, Austausch und Geschäftskontinuität."},"tr":{"1":"Güçlü teknik sorun giderme becerilerimi proaktif ve müşteri odaklı bir yaklaşımla birleştirerek uçtan uca BT desteği sağlıyorum; böylece sistemlerin güvenilir çalışmasını ve kesintilerin en aza inmesini sağlıyorum. Süreç iyileştirme, departmanlar arası iş birliği, teknik proje yürütme ile verimli BT varlık ve tedarikçi yönetimi aracılığıyla operasyonel mükemmelliği ileriye taşıyorum.","2":"Kurumsal ofisler, çağrı merkezleri ve üretim ortamlarındaki yaklaşık 4.700 çalışana uçtan uca BT desteği sundum; hızlı sorun giderme, altyapı yönetimi ve VIP desteği ile operasyonel sürekliliği sağladım. BT varlıklarının tüm yaşam döngüsünü yönettim, güvenlik ve erişim yönetimini güçlendirdim; altyapı projelerine, teknik dokümantasyona ve güvenilir üretim operasyonlarına katkıda bulundum.","3":"Borsa ve işlem salonu personeline özel BT desteği sağladım; yüksek baskılı bir finans ortamında kritik iş istasyonlarının ve özel işlem ekipmanlarının erişilebilirliğini ve performansını korudum. Hızlı donanım arıza tespiti, proaktif bakım ve yükseltme, değişim ile iş sürekliliği konularında BT ekipleriyle yakın iş birliği sayesinde kesinti süresini en aza indirdim."}};
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
    de: ['Muttersprache', 'Professionelle Arbeitssprachkenntnisse', 'Eingeschränkte Arbeitssprachkenntnisse', 'Anfängerkenntnisse', 'Anfängerkenntnisse', 'Anfängerkenntnisse'],
    tr: ['Ana dil', 'Profesyonel çalışma yetkinliği', 'Sınırlı çalışma yetkinliği', 'Başlangıç düzeyinde yetkinlik', 'Başlangıç düzeyinde yetkinlik', 'Başlangıç düzeyinde yetkinlik'] };
  const note = { en: 'not CEFR levels or exam results', de: 'keine GER-Niveaus oder Prüfungsergebnisse', tr: 'CEFR düzeyi veya sınav sonucu değildir' };
  const scores = [null, '129', '81', '13', '12', '11'];
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: '/?lang=' + lang });
    await p.locator('#skills .lang-list').scrollIntoViewIfNeeded();
    await p.waitForFunction(() => [...document.querySelectorAll('.lang-list img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 5000 }).catch(() => {});
    const cards = await p.$$eval('.lang-card', (n) => n.map((c) => ({
      name: c.querySelector('.lang-name').textContent, level: c.querySelector('.lang-level').textContent,
      score: c.querySelector('.score-value')?.textContent ?? null, cert: c.querySelector('.lang-cert')?.textContent ?? null,
      imgs: [...c.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src'), alt: i.alt, ok: i.complete && i.naturalWidth > 0 })),
      scoreText: c.querySelector('.lang-score')?.textContent.replace(/\s+/g, ' ').trim() ?? '', other: [...c.querySelectorAll('.lang-name, .lang-level, .lang-score')].map((x) => x.textContent).join(' ') })));
    const noteText = await p.textContent('#skills .lang-list + p');
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
    const cert = cards[2].cert || '';
    const certified = cert.split(/[.]\s*/).find((x) => /A2/.test(x)) || '';
    const selfB1 = cert.split(/[.]\s*/).find((x) => /B1/.test(x)) || '';
    if (!certified || /B1/.test(certified)) throw new Error(lang + ': A2 must be the certified level, not B1: ' + cert);
    if (!selfB1 || /A2/.test(selfB1) || !/self-assessed|Selbsteinsch|kendi değerlendirme/.test(selfB1)) throw new Error(lang + ': B1 must be marked as self-assessed: ' + cert);
    if (/Professional working|Professionelle Arbeits|Profesyonel çalışma/.test(cards[2].level)) throw new Error(lang + ': German must be limited working proficiency');
    if (!noteText.includes(note[lang])) throw new Error(lang + ': disclaimer missing: ' + noteText);
    if (/verified by Duolingo|von Duolingo (bestätigt|verifiziert)|Duolingo tarafından doğrulan/i.test(noteText)) throw new Error(lang + ': verification claim');
  }
});

await test('About: 17+ years heading and three paragraphs in en/de/tr, anonymous, no stale wording', async () => {
  const want = {
    en: { h: 'IT Support & Infrastructure Professional | 17+ Years', p: ['IT Support Engineer at an international technology company with 17+ years of experience.', 'Skilled in end-user support, IT infrastructure, hardware deployments, asset lifecycle management, and vendor coordination, with a focus on resolving complex issues, minimizing downtime, and improving operational efficiency.', 'Currently expanding my skills in Python, Linux, AWS, and AI-assisted development to automate processes and build practical solutions that improve IT operations.'] },
    de: { h: 'IT-Support- und Infrastruktur-Profi | 17+ Jahre', p: ['IT-Support-Engineer bei einem internationalen Technologieunternehmen mit 17+ Jahren Erfahrung.'] },
    tr: { h: 'BT Destek ve Altyapı Profesyoneli | 17+ Yıl', p: ['Uluslararası bir teknoloji şirketinde, 17+ yıllık deneyime sahip BT Destek Mühendisiyim.'] },
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
    if (!/17\+/.test(h) || !paras[0].includes('17+')) throw new Error(lang + ': 17+ missing');
    if (/\b(15|16|18|20)\+|\b1[5-9] (years|Jahre|yıl)/i.test(all)) throw new Error(lang + ': other experience number');
    const priv = findPrivate(all); if (priv && priv.length) throw new Error(lang + ': private word: ' + priv);
    if (/B1|A2|Goethe/.test(all)) throw new Error(lang + ': language level text belongs in the language card, not About');
  }
});

await test('Contact form: visible but inactive in en/de/tr (disabled controls, notice, no action, no request, no storage)', async () => {
  const words = { en: ['not active yet', 'Send message', 'Name'], de: ['noch nicht aktiv', 'Nachricht senden', 'Name'], tr: ['henüz etkin değil', 'Mesajı gönder', 'Ad'] };
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: '/?lang=' + lang });
    const post = []; p.on('request', (r) => post.push(r.method() + ' ' + r.url()));
    const info = await p.evaluate(() => {
      const f = document.getElementById('contact-form');
      return { exists: !!f && !!f.closest('#contact'), action: f?.getAttribute('action'), method: f?.getAttribute('method'),
        submitDisabled: document.getElementById('cf-submit')?.disabled, fieldsetDisabled: !!f?.querySelector('fieldset')?.disabled,
        controls: [...f.querySelectorAll('input, textarea, select, button')].map((c) => ({ id: c.id, disabled: c.matches(':disabled') })),
        labels: [...f.querySelectorAll('label')].map((l) => l.textContent.trim()), submitText: document.getElementById('cf-submit').textContent.trim(),
        notice: document.getElementById('form-inactive')?.textContent.trim(), noticeVisible: !!document.getElementById('form-inactive')?.offsetParent,
        honeypot: !!f.querySelector('[name=_gotcha]'), hidden: [...f.querySelectorAll('input[type=hidden]')].length };
    });
    if (!info.exists) throw new Error(lang + ': form missing');
    if (info.action || info.method) throw new Error(lang + ': form has action/method');
    if (!info.submitDisabled || !info.fieldsetDisabled) throw new Error(lang + ': submit/fieldset not disabled');
    if (info.controls.length !== 5 || info.controls.some((c) => !c.disabled)) throw new Error(lang + ': enabled control: ' + JSON.stringify(info.controls));
    if (!info.noticeVisible || !info.notice.includes(words[lang][0])) throw new Error(lang + ': inactive notice missing: ' + info.notice);
    if (!/(transmitted|übermittelt|iletilmez)/.test(info.notice)) throw new Error(lang + ': notice must say nothing is transmitted');
    if (info.submitText !== words[lang][1] || info.labels[0] !== words[lang][2]) throw new Error(lang + ': labels not localized: ' + info.submitText + ' / ' + info.labels);
    if (info.honeypot || info.hidden) throw new Error(lang + ': unexpected hidden/honeypot field');
    // try every way to submit
    await p.locator('#cf-submit').click({ force: true, timeout: 2000 }).catch(() => {});
    await p.locator('#cf-message').focus({ timeout: 1000 }).catch(() => {});
    await p.keyboard.press('Enter');
    const editable = await p.locator('#cf-message').isEditable();
    const fillFailed = await p.fill('#cf-message', 'x', { timeout: 1500 }).then(() => false, () => true);
    const subEvent = await p.evaluate(() => { let n = 0; const f = document.getElementById('contact-form'); f.addEventListener('submit', () => n++); f.requestSubmit(); return { defaultPrevented: n };});
    await p.evaluate(() => document.getElementById('contact-form').submit());
    await p.waitForTimeout(500);
    const url = p.url();
    const keys = await p.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookie: document.cookie, value: document.getElementById('cf-message').value }));
    const html = await p.content();
    await p.context().close();
    if (editable || !fillFailed) throw new Error(lang + ': message field accepts input');
    if (post.length) throw new Error(lang + ': requests after load: ' + post.join(' | '));
    if (url.includes('?') && !url.includes('lang=')) throw new Error(lang + ': navigated: ' + url);
    if (/#?[?&](name|email|message|subject)=/i.test(url)) throw new Error(lang + ': form data in URL');
    if (keys.local.some((k) => !['lang', 'theme'].includes(k)) || keys.session.length || keys.cookie || keys.value) throw new Error(lang + ': storage/value: ' + JSON.stringify(keys));
    if (/[\w.+-]+@(?!example\.)[\w-]+\.[\w.-]+/i.test(html)) throw new Error(lang + ': email address in rendered page');
  }
  // no endpoint, provider or submission logic anywhere in the source
  const files = ['index.html', 'css/styles.css', 'js/app.js', 'js/config.js', 'js/ui.js', 'js/i18n.js', 'js/credentials.js', 'js/github.js', 'i18n/en.json', 'i18n/de.json', 'i18n/tr.json'];
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    if (/formspree|FORM_ENDPOINT|FORM_LIMITS|_gotcha|initContact|\bfetch\(\s*['"`]https?:|XMLHttpRequest|sendBeacon/i.test(t)) throw new Error('submission remnant in ' + f);
  }
  if (existsSync('js/contact.js')) throw new Error('js/contact.js exists');
  if (!/form-action 'none'/.test(readFileSync('index.html', 'utf8'))) throw new Error('CSP form-action none missing');
});

await test('Navigation: "Education & Certificates" label in en/de/tr (desktop and mobile), anchors and sections intact', async () => {
  const want = {
    en: ['About', 'Experience', 'Education', 'Skills', 'Education & Certificates', 'Projects', 'Contact'],
    de: ['Über mich', 'Erfahrung', 'Ausbildung', 'Kenntnisse', 'Ausbildung & Zertifikate', 'Projekte', 'Kontakt'],
    tr: ['Hakkımda', 'Deneyim', 'Eğitim', 'Beceriler', 'Eğitim ve Sertifikalar', 'Projeler', 'İletişim'],
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

await test('Skill chips: 21 unique compact chips per language, German/Turkish labels, not interactive', async () => {
  const sample = { en: 'Network Engineering', de: 'Netzwerkengineering', tr: 'Ağ Mühendisliği' };
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: `/?lang=${lang}` });
    const chips = await p.$$eval('#skills .chips.compact li', (n) => n.map((x) => x.textContent.trim()));
    const interactive = await p.$$eval('#skills .chips a, #skills .chips button, #skills .chips [tabindex]', (n) => n.length);
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
  const want = { en: ['17 December 2016', 'Completed', 'Learning activity'], de: ['17. Dezember 2016', 'Abgeschlossen', 'Lernaktivität'], tr: ['17 Aralık 2016', 'Tamamlandı', 'Öğrenme etkinliği'] };
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

await test('Footer notice: exact text in en/de/tr (states the contact form is inactive), no legal page or legal links, legal.html is gone', async () => {
  const want = {"en":"This site is my personal online CV and portfolio. It does not use user accounts, analytics, or advertising. The contact form is currently inactive and does not submit or transmit any data. Language and theme preferences are stored in your browser. The site is hosted on GitHub Pages, whose hosting provider may process technical request data. External links lead to third-party websites.","de":"Diese Website ist mein persönlicher Online-Lebenslauf und mein Portfolio. Sie verwendet keine Benutzerkonten, Analyse- oder Werbedienste. Das Kontaktformular ist derzeit inaktiv und übermittelt keine Daten. Sprach- und Designeinstellungen werden in Ihrem Browser gespeichert. Die Website wird über GitHub Pages gehostet; der Hosting-Anbieter kann technische Zugriffsdaten verarbeiten. Externe Links führen zu Websites Dritter.","tr":"Bu site kişisel çevrim içi CV ve portföyümdür. Kullanıcı hesabı, analiz veya reklam hizmeti kullanmaz. İletişim formu şu anda etkin değildir ve herhangi bir veri göndermez veya iletmez. Dil ve tema tercihleri tarayıcınızda saklanır. Site GitHub Pages üzerinde barındırılır; barındırma sağlayıcısı teknik istek verilerini işleyebilir. Dış bağlantılar ilgili hizmetlerin kendi sitelerine yönlendirir."};
  for (const lang of ['en', 'de', 'tr']) {
    const p = await newPage({ path: '/?lang=' + lang });
    const d = await p.evaluate(() => ({ notice: document.querySelector('footer .footer-notice')?.textContent.trim(), links: [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')), footerLinks: [...document.querySelectorAll('footer a')].map((a) => a.getAttribute('href')) }));
    await p.context().close();
    if (d.notice !== want[lang]) throw new Error(lang + ': notice differs: ' + d.notice);
    if (d.links.some((h) => /legal/i.test(h || ''))) throw new Error(lang + ': link to a legal page remains');
    if (d.footerLinks.join() !== '#top') throw new Error(lang + ': unexpected footer links ' + d.footerLinks);
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

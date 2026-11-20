import { GITHUB_USER, GITHUB_EXCLUDE } from './config.js';
import { t } from './i18n.js';
import { formatDate } from './ui.js';

// Repository information is read from data/projects.json (stored on this site).
// Nothing here contacts GitHub or any other host when a visitor opens the page.
const $ = (id) => document.getElementById(id);

function node(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  kids.forEach((k) => n.append(k));
  return n;
}

const isGithubUrl = (u) => typeof u === 'string' && u.startsWith('https://github.com/');
const repoUrl = (name) => `https://github.com/${GITHUB_USER}/${encodeURIComponent(name)}`;

function projectCard(entry) {
  const card = node('article', { className: 'card proj-card' }, node('h3', { textContent: entry.name }));
  if (entry.fork) card.append(node('span', { className: 'tag', textContent: t('proj.fork') }));
  card.append(node('p', { textContent: entry.snapshot?.description || t('proj.noDesc') }));
  const up = entry.upstream;
  const bits = [up?.language ? t('proj.upstreamLang', { lang: up.language }) : null,
    entry.snapshot?.pushedAt ? t('proj.updated', { date: formatDate(entry.snapshot.pushedAt) }) : null].filter(Boolean);
  if (bits.length) card.append(node('p', { className: 'meta', textContent: bits.join(' · ') }));
  if (entry.fork && up && isGithubUrl(up.url)) {
    card.append(node('p', { className: 'meta' }, document.createTextNode(`${t('proj.forkOf')} `),
      node('a', { href: up.url, target: '_blank', rel: 'noopener', textContent: up.fullName })));
  }
  card.append(node('a', { href: repoUrl(entry.name), target: '_blank', rel: 'noopener', textContent: t('proj.view') }));
  return node('li', {}, card);
}

export async function initGithub() {
  if (!$('proj-grid')) return;
  let featured = [];
  try {
    const res = await fetch('data/projects.json');
    if (res.ok) featured = ((await res.json()).featured || []).filter((f) => f && /^[\w.-]+$/.test(f.name));
  } catch (e) { /* treated as no featured projects */ }

  const hidden = new Set(GITHUB_EXCLUDE.map((n) => n.toLowerCase()));
  const render = () => {
    $('proj-status').textContent = featured.length ? '' : t('proj.empty');
    $('proj-grid').replaceChildren(...featured.map(projectCard));

    // Recent activity: the same saved snapshot, newest first, without the excluded website repository.
    const recent = featured.filter((f) => f.snapshot?.pushedAt && !hidden.has(f.name.toLowerCase()))
      .sort((a, b) => b.snapshot.pushedAt.localeCompare(a.snapshot.pushedAt)).slice(0, 5);
    const retrieved = featured.map((f) => f.snapshot?.retrieved).filter(Boolean).sort().pop();
    $('act-intro').textContent = retrieved ? t('act.intro', { date: formatDate(retrieved) }) : '';
    $('act-list').replaceChildren(...recent.map((f) => node('li', {},
      node('a', { href: repoUrl(f.name), target: '_blank', rel: 'noopener', textContent: f.fork ? `${f.name} (${t('proj.fork')})` : f.name }),
      node('span', { className: 'meta', textContent: t('proj.updated', { date: formatDate(f.snapshot.pushedAt) }) }))));
  };
  render();
  document.addEventListener('languagechange', render);
}

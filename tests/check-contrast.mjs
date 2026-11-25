// Checks WCAG 2.2 contrast of the colour tokens in css/styles.css (light and dark).
// Text pairs need 4.5:1, essential UI boundaries and focus indicators need 3:1.
// This checks the design tokens only; rendered pages are additionally checked by axe-core in tests/e2e.mjs.
import { readFileSync } from 'node:fs';
const css = readFileSync('css/styles.css', 'utf8');
const block = (re) => { const m = css.match(re); if (!m) throw new Error('token block not found: ' + re); return m[1]; };
const parse = (b) => Object.fromEntries([...b.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
const themes = {
  light: parse(block(/:root\s*\{([^}]*)\}/)),
  dark: { ...parse(block(/:root\s*\{([^}]*)\}/)), ...parse(block(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)) },
};
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const TEXT = [
  ['text', 'bg'], ['text', 'bg-alt'], ['text', 'surface'],
  ['muted', 'bg'], ['muted', 'bg-alt'], ['muted', 'surface'],
  ['accent', 'bg'], ['accent', 'bg-alt'], ['accent', 'surface'],
  ['accent-contrast', 'accent'],
  ['on-primary-container', 'primary-container'], ['on-secondary-container', 'secondary-container'],
  ['on-secondary-container', 'bg'], ['on-primary-container', 'bg-alt'],
  ['danger', 'bg'], ['danger', 'surface'], ['danger', 'bg-alt'],
  ['success', 'bg'], ['success', 'surface'], ['success', 'bg-alt'],
  ['warning', 'bg'], ['warning', 'surface'], ['warning', 'bg-alt'],
];
const UI = [
  ['border-strong', 'bg'], ['border-strong', 'bg-alt'], ['border-strong', 'surface'],
  ['focus', 'bg'], ['focus', 'bg-alt'], ['focus', 'surface'],
  ['danger', 'surface'], ['accent', 'surface'],
];
// Hover states use colour-mix(); recompute them so the mixed backgrounds are checked too.
const mix = (a, b, pa) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * pa + parseInt(b.slice(i, i + 2), 16) * (1 - pa)).toString(16).padStart(2, '0')).join('');
for (const t of Object.values(themes)) {
  t['hover-primary'] = mix(t.accent, t['accent-contrast'], 0.92);
  t['hover-secondary'] = mix(t['secondary-container'], t.accent, 0.88);
}
TEXT.push(['accent-contrast', 'hover-primary'], ['on-secondary-container', 'hover-secondary'], ['on-primary-container', 'primary-container']);
let failed = 0; let checked = 0;
for (const [name, t] of Object.entries(themes)) {
  for (const [list, min, kind] of [[TEXT, 4.5, 'text'], [UI, 3, 'ui']]) {
    for (const [fg, bg] of list) {
      if (!t[fg] || !t[bg]) { console.log(`FAIL ${name}: token missing for ${fg} / ${bg}`); failed++; continue; }
      const r = ratio(t[fg], t[bg]); checked++;
      if (r < min) { console.log(`FAIL ${name} ${kind}: ${fg} ${t[fg]} on ${bg} ${t[bg]} = ${r.toFixed(2)}:1 (needs ${min}:1)`); failed++; }
      else if (process.env.CONTRAST_VERBOSE) console.log(`ok   ${name} ${kind}: ${fg} on ${bg} = ${r.toFixed(2)}:1`);
    }
  }
}
// Font stack requirement: Google Sans first, then Inter, Source Sans 3 and widely available fonts.
if (!/--font:\s*"Google Sans",\s*"Inter",\s*"Source Sans 3",\s*Arial,\s*Helvetica,\s*sans-serif/.test(css)) { console.log('FAIL font stack differs from the approved one'); failed++; }
console.log(failed ? `contrast check: ${failed} problem(s)` : `contrast check: PASS (${checked} token pairs, light and dark)`);
process.exit(failed ? 1 : 0);

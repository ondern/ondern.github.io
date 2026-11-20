// Optional, local-only list of words that must never appear on the site (for example a name that
// must stay private). Put one word per line in tests/.private-denylist.txt. That file is git-ignored and,
// because it starts with a dot, is not published by GitHub Pages. Without it the check is reported as skipped.
import { existsSync, readFileSync } from 'node:fs';

const FILE = 'tests/.private-denylist.txt';
const ALLOWED_PHRASES = [/Amazon Web Services( \(AWS\))?/g]; // credential issuer name, not an employment statement
const words = existsSync(FILE) ? readFileSync(FILE, 'utf8').split(/\r?\n/).map((w) => w.trim()).filter(Boolean) : null;

export const denylistLoaded = Boolean(words && words.length);
export function findPrivate(text) {
  if (!denylistLoaded) return null;
  let t = text;
  for (const a of ALLOWED_PHRASES) t = t.replace(a, '');
  return words.filter((w) => new RegExp('(^|[^\\p{L}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}])', 'u').test(t));
}

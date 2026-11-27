# nuray.io

Static personal portfolio for [nuray.io](https://nuray.io), served by GitHub Pages from the `main` branch root. No framework and no build step. Languages: English (default), German, Turkish.

## Structure

| Path | Purpose |
|---|---|
| `index.html` | The page. English text is the no-JS fallback; translations are applied by JS. |
| `css/styles.css` | Design tokens (light/dark), layout, components. |
| `js/` | ES modules: `i18n`, `ui` (theme, nav, reveal), `credentials`, `github`, `config`. |
| `i18n/{en,de,tr}.json` | All interface text, including the short footer notice. |
| `data/credentials.json`, `data/projects.json` | Owner-maintained data. |
| `CNAME` | Custom domain. Do not remove. |
| `de/`, `tr/` | Generated localized entry pages (own URL, title, description and canonical per language). Do not edit by hand: change `index.html` or `i18n/*.json`, then run `npm run build:lang`. `npm run test:lang` (part of `npm test`) fails if they are out of date. |
| `_config.yml` | Keeps `tests/`, `README.md` and the npm manifests out of the published site. They remain in the public repository. |
| `tests/` | `check-i18n.mjs`, `e2e.mjs`, `serve.mjs` (dev tooling only). |

## Local preview and tests

```
npm install      # dev tooling only (playwright-core, axe-core); nothing here is deployed logic
npm start        # preview at http://localhost:4173 (ES modules need http://, not file://)
npm test         # i18n/data check + browser tests (uses the installed Microsoft Edge)
```

Lighthouse (not a project dependency): start `npm start`, then run
`npx lighthouse@12 http://localhost:4173/ --chrome-flags="--headless=new"` with `CHROME_PATH` pointing to Edge or Chrome.

## Editing content

- **Text and translations:** edit the matching key in all three `i18n/*.json` files. `npm run test:i18n` fails on missing keys, mismatched `{placeholders}`, and if the static English footer notice in `index.html` differs from `en.json`. To add new entries, use `data-i18n` keys.
- **Portrait:** `assets/img/portrait-640.webp` and `portrait-320.webp` (optimized from the LinkedIn profile photo). To change it, replace both files (keep square) and update the `alt` text key `hero.photo` in all three `i18n` files.
- **Featured projects and recent activity:** both come from `data/projects.json`, which is stored on the site; visitors' browsers never call the GitHub API. Each entry has `name` (a repo under github.com/ondern), optional `fork: true`, `upstream` (`fullName`, `url`, `language`) and a `snapshot` (`description`, `pushedAt`, `retrieved`). To refresh, run `gh api repos/ondern/<name> --jq "{description, pushed_at}"` on your computer and copy the values; do not rewrite them as your own claims.
- **Experience and education:** the homepage is a short introduction; full history lives on LinkedIn. Edit the `exp.*` and `edu.*` keys in the three `i18n/*.json` files, and organization names in `index.html`. Employers are intentionally not named on the site; each position uses a neutral description.
- **Maintaining credentials:** add one object per distinct credential to `data/credentials.json` `items`:
  ```json
  {
    "title": "Exact official title",
    "issuer": "Issuing organisation",
    "type": "certification | badge | learning",
    "issuedOn": "YYYY-MM",
    "expiresOn": "YYYY-MM",
    "credentialUrl": "https://… (verification or public badge page)",
    "credentialId": "only if it is needed to verify and is fine to publish",
    "documentImage": { "src": "assets/img/credentials/name.webp", "width": 800, "height": 600 },
    "source": "Credly"
  }
  ```
  Add `"featured": true` to the few credentials that should appear by default; visitors can switch to the full list, and searching or filtering always covers all of them. Only `title`, `issuer` and `type` are required. Dates have month precision; an `expiresOn` in the past is shown as "Expired". Credly's API is for issuing organisations, so there is no authorised automated route for a badge holder; entries come from the owner's profile text and public badge pages. `npm run test:i18n` validates the file, requires every image to exist, rejects unreferenced images under `assets/img`, and flags birth-data patterns in public text files.
- **Certificate images:** only add documents that carry no birth data, home address or similar personal details (some language certificates do), resize them to about 800 px (WebP), and never copy source folders into the repository.
## Contact
The Contact section has a working form next to the LinkedIn, GitHub and Credly links. `js/contact.js` validates the fields, loads Cloudflare Turnstile only when the visitor starts using the form, and sends the message as JSON to the Worker in `worker/` (`CONTACT_API_URL` and the public `TURNSTILE_SITE_KEY` are set in `js/config.js`; the site key is still a placeholder). The Worker verifies the token, limits abuse, and sends the email through Resend; all secrets and the recipient live only in the Worker (see `worker/README.md`). The CSP allows only Turnstile (`script-src`, `frame-src`) and the API host (`connect-src`); `form-action` stays `'none'`. The site shows no email address. The tests mock Turnstile and the API, so they do not prove real email delivery.

### Local contact-form development
`npm run dev:contact` serves the site and a local mock API, then open `http://localhost:4173/?contactDev=1`. The mode works only on `localhost` / `127.0.0.1` with that query parameter; it uses fixed local values (`http://localhost:8787/contact` and Cloudflare's public Turnstile test key), never a URL taken from the address bar, and it is ignored on nuray.io. The local server adds the mock API origin to the page CSP in memory only; `index.html` keeps the production CSP. The mock API runs the real Worker code with mocked Turnstile verification, Resend and rate limiting, so it proves the browser-to-Worker flow but not real bot verification or real email delivery. Without `?contactDev=1` the form uses the production endpoint and, until the real public site key is put in `js/config.js`, shows "The form is not available right now".

## Design system
The look is inspired by Material 3 Expressive and kept deliberately calm: tonal surfaces and container colours, pill-shaped controls that morph to a rounded rectangle when pressed, larger corner radii, and short motion that respects `prefers-reduced-motion`. All values are CSS custom properties at the top of `css/styles.css` (colour roles for light and dark, type scale, spacing, radii, easing). `npm run test:contrast` checks the colour pairs against WCAG 2.2 AA (4.5:1 for text, 3:1 for control borders and focus rings, including hover mixes); axe-core in the e2e tests checks the rendered pages.

Typography uses Google Sans (SIL Open Font License 1.1), self-hosted in `assets/fonts/` with its licence text and a README that records the verification and where the files came from. Fallbacks are Inter and Source Sans 3 (only if installed on the visitor's device), then Arial and Helvetica. Body text is 16-18 px with a 1.65 line height. Google Sans is about as wide as Arial, so a failed font load does not shift the layout.

## Security notes
GitHub Pages cannot set HTTP headers or rate-limit requests. Implemented: a CSP via `<meta>` (no inline scripts or styles; `img-src` limited to the site itself, `connect-src` also allowing the contact API host), DOM text APIs only (no `innerHTML`), `rel="noopener"` on external links, and no third-party scripts, fonts, APIs or analytics on page load (Turnstile loads only after the visitor starts using the contact form), so a normal page load contacts no host other than the site's own (a test enforces this). `<meta>` CSP cannot enforce `frame-ancestors`, so clickjacking protection is not available on this host. Public content can always be copied or scraped; `robots.txt` is a preference, not protection. Stronger controls (WAF, rate limiting, headers) need a CDN such as Cloudflare in front of the site and a DNS change, which requires owner approval.

## Known limitations

- Language variants use `?lang=` on one URL and are rendered by JavaScript. The canonical URL is the base page and no `hreflang` links are published, so search engines will mainly index the English page.
- There is no legal or privacy page. A short footer notice (three languages) states what the site does and does not do; whether this suffices for your situation is a question for local legal advice.
- Tested in Chromium (Edge) only. Firefox, WebKit/Safari, physical devices and screen readers are untested.

## Deployment

Pages serves `main` directly; there is no workflow. Merging to `main` publishes. Rollback: `git revert` the commit and push.

## Recent GitHub activity

The list shows the saved snapshot from `data/projects.json`, newest first, and hides repositories named in `GITHUB_EXCLUDE` (`js/config.js`), currently the website repository. This is display-only: the repository stays public on GitHub. Making it private is a separate GitHub decision that would also stop GitHub Pages on a Free plan.

## Copyright and copying

No licence file exists, so the original text, design and code are "all rights reserved" and this is the default when no licence is chosen. No reuse licence is granted and none was invented. Text stays selectable on purpose: blocking selection, right-click or copy cannot stop copying and would harm accessibility, so the site does not do it (`npm run test:i18n` fails if copy-blocking code is added). Third-party material (issuer and university names and logos, certificate documents, GitHub descriptions) belongs to its owners.

## Optional local privacy denylist

Create `tests/.private-denylist.txt` (git-ignored, one word per line) with words that must never appear on the site, such as a name that must stay private. The tests then fail if one shows up. Keeping the words in that file, not in the tests, stops them from being published. Without the file the check is skipped.

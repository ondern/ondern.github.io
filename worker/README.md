# nuray-contact-api
Cloudflare Worker behind the contact form on nuray.io. It is deployed separately from the
GitHub Pages site and is not published with it.
A message is delivered only after the visitor has confirmed the e-mail address by link. All endpoints accept
`POST` (JSON) from `https://nuray.io` or `https://www.nuray.io` only.
## Flow
1. `POST /contact`: checks origin, content type, body size, fields and language; rate-limits per client (IPv6 by /64 prefix);
   checks the honeypot and minimum fill time; verifies the Turnstile token with Siteverify (hostname and action `contact`);
   then stores the message in D1 for 15 minutes under the SHA-256 of a random token (32 bytes, 256 bit) and mails the visitor
   a confirmation link `https://nuray.io/verify.html?lang=xx#t=<token>` from `MAIL_FROM`. The mail contains fixed text only, never the
   visitor's name, subject or message. The answer is `{ ok: true, pending: true, resend: "<secret>" }`; nothing reaches the owner yet.
   One pending message per address: while it is live, a new submission for the same address changes nothing and sends no mail, but gets the same answer as a normal one (so the answer reveals nothing about the address).
2. `verify.html` (static page): opening the link does nothing. The button posts the token to `POST /contact/verify`.
3. `POST /contact/verify` `{ token }`: consumes the row atomically (`UPDATE ... SET used = <now> WHERE token_hash = ? AND (used = 0 OR
   used <= now - 60) AND expires_at > now RETURNING ...`), so a link works once and only for its own message, even for two simultaneous clicks. Then the
   notification goes to the owner (Reply-To = visitor), the row is deleted, and a short localized acknowledgment follows in the background
   (at most one per address per 24 hours). If the owner mail fails, the row is released again and the same link can be used again.
   An unknown, used, expired or malformed token always gets `400 invalid_token`.
4. `POST /contact/resend` `{ resend }`: a new link for a pending message (the secret comes from the answer of step 1 and lives only in the
   page's memory). At least 60 seconds apart, at most 3 mails per message; the old link stops working and the 15 minutes start again.
Responses are `{ "ok": true }` or `{ "ok": false, "code": "..." }` (`validation`, `captcha_failed`, `too_fast`, `rate_limited`,
`address_limit`, `resend_limit`, `invalid_token`, `server_error`, ...). Messages shown to visitors are translated in the website, not here.
Nothing about visitors is logged.
## Limits (UTC day; all in D1, atomic)
Confirmation mails 40 per day and 5 per address per 24 hours; delivered messages 30 per day; acknowledgments 30 per day. Together they
stay below the Resend free quota of 100 mails per day. Turnstile, the honeypot, the fill time, the Workers rate limiter (separate key per endpoint)
and the zone's WAF rule stay in front of everything. The WAF rule `api-contact-rate-limit` (dashboard only) matches the URI path `/contact`:
change it to "starts with /contact" so that `/contact/verify` and `/contact/resend` are covered as well.
## Configuration
Secrets (Worker Production secrets, never in files): `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`,
`CONTACT_RECIPIENT` (the private notification address) and `DIGEST_PEPPER` (at least 32 random characters; keys the HMAC of stored hashes and counter keys; create it once with `npx wrangler secret put DIGEST_PEPPER`; changing it later only resets pending messages and counters).
Plain variables and bindings are in `wrangler.toml`: `MAIL_FROM`, `TURNSTILE_HOSTNAMES`, the rate limiter `RATE_LIMITER`, the D1 database
`DB` and an hourly cron trigger (removes expired rows; reading ignores them anyway). `VERIFY_BASE_URL` is optional (local development only).
The D1 binding is required: without it the Worker answers 500 instead of running unprotected.
One-time setup in `worker/` (the owner runs it in their own terminal):
1. `npx wrangler d1 create nuray-contact` and put the returned `database_id` into `wrangler.toml`;
2. `npx wrangler d1 execute nuray-contact --remote --file=schema.sql`.
Stored in D1: pending messages (name, address, subject, message, language; tokens only as digests) until delivery or 15 minutes, and
counters whose keys hold digests only. The old KV namespace `CONTACT_KV` is no longer used and can be deleted in the dashboard.
Release order: push the site first (the new form and `verify.html`), then deploy the Worker; an old cached page would show "sent" for a message
that still waits for confirmation.
## Tests
`node --test worker/test/` runs the Worker with mocked Turnstile and Resend and an in-memory SQLite stand-in for D1 (`test/d1-shim.mjs`,
real SQL). These tests do not prove that real email is delivered or that real D1 behaves identically.

# nuray-contact-api

Cloudflare Worker behind the contact form on nuray.io. It is deployed separately from the
GitHub Pages site and is not published with it.

`POST /contact` (JSON) from `https://nuray.io` or `https://www.nuray.io` only:

1. checks origin, content type, body size, fields and language;
2. rate-limits per client IP and checks the honeypot and minimum fill time;
3. verifies the Turnstile token with Siteverify, including the hostname;
4. sends the notification (Reply-To = visitor), then a localized acknowledgment.

Responses are `{ "ok": true }` or `{ "ok": false, "code": "..." }`. Messages shown to visitors
are translated in the website, not here. Nothing about visitors is logged.

## Configuration

Secrets (Worker Production secrets, never in files): `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`,
`CONTACT_RECIPIENT` (the private notification address).

Plain variables and bindings are in `wrangler.toml`: `MAIL_FROM`, `TURNSTILE_HOSTNAMES`,
and the rate limiter `RATE_LIMITER`. No KV is used: a Turnstile token is single-use, so a repeated submission is rejected by Siteverify.

## Tests

`npm run test:worker` runs the Worker with mocked Turnstile and Resend. These tests do not
prove that real email is delivered.

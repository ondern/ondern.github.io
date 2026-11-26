# Security policy

This repository contains the source of [nuray.io](https://nuray.io), a personal portfolio site, and the
Cloudflare Worker behind its contact form (`api.nuray.io`).

## Supported versions

Only the live site and the current `main` branch are maintained. There are no releases or older versions.

## Scope

In scope:

- `https://nuray.io` and `https://www.nuray.io` (static site on GitHub Pages)
- `https://api.nuray.io` (contact-form API: `/contact`, `/contact/verify`, `/contact/resend`)
- The code in this repository

Out of scope:

- Missing HTTP security headers that GitHub Pages does not allow a site to set
- Rate limits, CAPTCHA behaviour or spam that requires no security flaw
- Denial-of-service, load or volume testing
- Social engineering, physical attacks, and findings in third-party services
  (GitHub, Cloudflare, Resend, Zoho) that are not caused by this repository

## Reporting a vulnerability

Please report security issues privately through GitHub:
[Report a vulnerability](https://github.com/ondern/ondern.github.io/security/advisories/new)
(Security tab > Advisories > Report a vulnerability).

Please do not open a public issue or pull request for a security problem, and do not use the
contact form for reports.

A helpful report includes:

- the affected URL or file
- steps to reproduce, or a short proof of concept
- the impact you expect

## What to expect

This is a personal project maintained by one person, so responses are best effort.
I aim to acknowledge a report within 7 days and to keep you informed while it is being fixed.
There is no bug bounty.

## Testing guidelines

When testing, please:

- use only your own data and test messages
- avoid automated scanners and high request volumes
- do not try to send e-mail to third parties through the contact form
- stop and report as soon as you can show the issue

Good-faith research that follows these guidelines is welcome.

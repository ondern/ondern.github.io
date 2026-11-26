# Provider icons

Small icons shown in front of the service names Cloudflare, Resend and Zoho in the privacy notices (form banner and footer).
They are stored here, so visitors' browsers never contact those services to load them.

| File | Taken from (favicon the service itself publishes) | Stored as |
|---|---|---|
| `cloudflare.png` | https://www.cloudflare.com/favicon.ico | 96x96 PNG, trimmed to a square |
| `resend.png` | https://resend.com/static/favicons/favicon-marketing@180x180.png | 96x96 PNG, scaled down |
| `zoho.png` | https://www.zohowebstatic.com/sites/zweb/images/favicon.ico | 48x48 PNG (largest frame of the icon) |

Downloaded on 2026-11-26. The icons are trademarks of their owners (Cloudflare, Inc., Resend, Zoho Corporation). They are used
only to identify the service a link leads to, and the site is not affiliated with or endorsed by them. To refresh an icon, download
the favicon again, decode it to a PNG of the same size and replace the file.

The rules are in `css/styles.css` (`a.provider-link`); `js/i18n.js` adds the class and the `data-provider` attribute to the links.

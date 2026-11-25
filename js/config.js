// Public, non-secret configuration.
export const GITHUB_USER = 'ondern';
// Repositories hidden from the "Recent GitHub activity" list (display only; this does not change repository visibility).
export const GITHUB_EXCLUDE = ['ondern.github.io'];

// Contact form: public values only. The Worker keeps every secret.
const PRODUCTION_CONTACT_API_URL = 'https://api.nuray.io/contact';
// Public Turnstile site key of the nuray-contact-form widget (not a secret).
const PRODUCTION_TURNSTILE_SITE_KEY = '0x4AAAAAAGSG5E3QkDskh-4j';

// Explicit local development mode (see README, "Local contact-form development").
// It is active only on localhost / 127.0.0.1 and only with ?contactDev=1. The two local values are fixed
// constants, so no endpoint can be chosen through the URL, and the production site (nuray.io) can never use them.
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const LOCAL_CONTACT_API_URL = 'http://localhost:8787/contact';
// Cloudflare's documented public Turnstile test key (always passes). It is not the production key.
const LOCAL_TURNSTILE_TEST_KEY = '1x00000000000000000000AA';
export const CONTACT_LOCAL_DEV = LOCAL_HOSTS.includes(location.hostname) && new URLSearchParams(location.search).get('contactDev') === '1';
export const CONTACT_API_URL = CONTACT_LOCAL_DEV ? LOCAL_CONTACT_API_URL : PRODUCTION_CONTACT_API_URL;
export const TURNSTILE_SITE_KEY = CONTACT_LOCAL_DEV ? LOCAL_TURNSTILE_TEST_KEY : PRODUCTION_TURNSTILE_SITE_KEY;

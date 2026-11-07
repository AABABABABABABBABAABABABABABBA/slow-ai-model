// ChadGPT frontend config
// Set these after you deploy each worker. Put this file in /pages/config.js.
// The URLs are PUBLIC — they get sent to anyone who loads the site. Every
// worker enforces origin + session token + rate limit server-side, so a leaked
// URL is useless without a valid session.
window.CHADGPT_CONFIG = Object.freeze({
  // Replace with your deployed worker URLs (no trailing slash):
  chatUrl:  'https://chadgpt-chat.example.workers.dev',
  codeUrl:  'https://chadgpt-code.example.workers.dev',
  imageUrl: 'https://chadgpt-image.example.workers.dev',

  // Cloudflare Turnstile site key (sitekey, not secret). Get it from
  // dashboard.cloudflare.com → Turnstile. Leave blank to skip challenge
  // for local dev — workers still enforce origin + rate limit.
  turnstileSiteKey: '',

  // UI defaults
  defaultModel: 'fast',
  brand: 'ChadGPT',
});

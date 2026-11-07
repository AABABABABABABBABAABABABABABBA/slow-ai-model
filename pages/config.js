// ChadGPT frontend config
// Set these after you deploy each worker. Put this file in /pages/config.js.
// The URLs are PUBLIC — they get sent to anyone who loads the site. Every
// worker enforces origin + session token + rate limit server-side, so a leaked
// URL is useless without a valid session.
window.CHADGPT_CONFIG = Object.freeze({
  chatUrl:  'https://chadgpt-chat.corbyiscool.workers.dev',
  codeUrl:  'https://chadgpt-code.corbyiscool.workers.dev',
  imageUrl: 'https://chadgpt-image.corbyiscool.workers.dev',

  // Set after creating a Turnstile site at dash.cloudflare.com → Turnstile.
  // Empty = no challenge (workers still enforce origin + session binding + rate limit).
  turnstileSiteKey: '',

  defaultModel: 'fast',
  brand: 'ChadGPT',
});

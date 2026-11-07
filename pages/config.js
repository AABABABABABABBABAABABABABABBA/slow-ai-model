// ChadGPT frontend config.
// The worker URLs are hidden server-side (in the Pages Function env). The
// frontend only knows about /api/* on this same origin. Nothing to edit here
// unless you want to swap brand/default model.
window.CHADGPT_CONFIG = Object.freeze({
  apiBase: '/api',
  defaultModel: 'fast',
  brand: 'ChadGPT',
});

// Live crypto prices via CoinGecko (no key for simple/price endpoint).

// Primary: Coinbase public spot price API (no key, no worker hostility).
// Fallback: CoinGecko.

// User alias -> { coinbase: 'BTC', coingecko: 'bitcoin', name: 'Bitcoin' }
const COINS = {
  'btc':         { cb: 'BTC',  cg: 'bitcoin',        name: 'Bitcoin' },
  'bitcoin':     { cb: 'BTC',  cg: 'bitcoin',        name: 'Bitcoin' },
  'eth':         { cb: 'ETH',  cg: 'ethereum',       name: 'Ethereum' },
  'ethereum':    { cb: 'ETH',  cg: 'ethereum',       name: 'Ethereum' },
  'ether':       { cb: 'ETH',  cg: 'ethereum',       name: 'Ethereum' },
  'sol':         { cb: 'SOL',  cg: 'solana',         name: 'Solana' },
  'solana':      { cb: 'SOL',  cg: 'solana',         name: 'Solana' },
  'doge':        { cb: 'DOGE', cg: 'dogecoin',       name: 'Dogecoin' },
  'dogecoin':    { cb: 'DOGE', cg: 'dogecoin',       name: 'Dogecoin' },
  'xrp':         { cb: 'XRP',  cg: 'ripple',         name: 'XRP' },
  'ada':         { cb: 'ADA',  cg: 'cardano',        name: 'Cardano' },
  'cardano':     { cb: 'ADA',  cg: 'cardano',        name: 'Cardano' },
  'ltc':         { cb: 'LTC',  cg: 'litecoin',       name: 'Litecoin' },
  'litecoin':    { cb: 'LTC',  cg: 'litecoin',       name: 'Litecoin' },
  'avax':        { cb: 'AVAX', cg: 'avalanche-2',    name: 'Avalanche' },
  'avalanche':   { cb: 'AVAX', cg: 'avalanche-2',    name: 'Avalanche' },
  'matic':       { cb: 'MATIC',cg: 'polygon-pos',    name: 'Polygon' },
  'polygon':     { cb: 'MATIC',cg: 'polygon-pos',    name: 'Polygon' },
  'link':        { cb: 'LINK', cg: 'chainlink',      name: 'Chainlink' },
  'chainlink':   { cb: 'LINK', cg: 'chainlink',      name: 'Chainlink' },
  'bnb':         { cb: 'BNB',  cg: 'binancecoin',    name: 'BNB' },
  'ton':         { cb: 'TON',  cg: 'the-open-network',name: 'Toncoin' },
  'shib':        { cb: 'SHIB', cg: 'shiba-inu',      name: 'Shiba Inu' },
  'shiba inu':   { cb: 'SHIB', cg: 'shiba-inu',      name: 'Shiba Inu' },
  'dot':         { cb: 'DOT',  cg: 'polkadot',       name: 'Polkadot' },
  'polkadot':    { cb: 'DOT',  cg: 'polkadot',       name: 'Polkadot' },
};

const GENERAL = /\b(crypto(currency)?|coin price)\b/i;

export function detect(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const hits = new Map();
  for (const key of Object.keys(COINS)) {
    if (new RegExp('\\b' + key.replace(/ /g, '\\s+') + '\\b', 'i').test(lower)) {
      const c = COINS[key];
      hits.set(c.cb, c);
    }
  }
  if (!hits.size && GENERAL.test(lower)) {
    hits.set('BTC', COINS.btc); hits.set('ETH', COINS.eth);
  }
  if (!hits.size) return null;
  return { coins: [...hits.values()] };
}

async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ChadGPT/1.0 (+https://chadgpt.pages.dev)', 'Accept': 'application/json' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

export async function fetchContext(hint) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  // Try Coinbase first — one call per coin, fast and no rate limit for workers.
  const coinbaseOut = await Promise.all(hint.coins.map(async c => {
    const d = await fetchJson(`https://api.coinbase.com/v2/prices/${c.cb}-USD/spot`);
    const price = d?.data?.amount ? Number(d.data.amount) : null;
    return price ? { c, price } : null;
  }));
  const hits = coinbaseOut.filter(Boolean);
  if (hits.length) {
    const lines = hits.map(({ c, price }) => {
      const fmt = price.toLocaleString('en-US', { maximumFractionDigits: price < 1 ? 6 : 2 });
      return `- ${c.name} (${c.cb}): $${fmt}`;
    });
    return `Live crypto spot prices from Coinbase as of ${stamp}:\n` + lines.join('\n');
  }
  // Fallback: CoinGecko
  const ids = hint.coins.map(c => c.cg).join(',');
  const d = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
  if (!d) return null;
  const lines = Object.entries(d).map(([k, v]) => {
    const price = (v.usd || 0).toLocaleString('en-US', { maximumFractionDigits: v.usd < 1 ? 6 : 2 });
    const chg = typeof v.usd_24h_change === 'number' ? v.usd_24h_change.toFixed(2) : '?';
    const sign = typeof v.usd_24h_change === 'number' && v.usd_24h_change >= 0 ? '+' : '';
    return `- ${k}: $${price} (24h ${sign}${chg}%)`;
  });
  if (!lines.length) return null;
  return `Live crypto prices from CoinGecko as of ${stamp}:\n` + lines.join('\n');
}

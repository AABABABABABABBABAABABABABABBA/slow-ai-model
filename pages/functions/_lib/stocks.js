// Live stock quotes via Yahoo Finance's public quote endpoint. No key.
// Detects ticker patterns like "AAPL", "$TSLA", or phrases like
// "price of nvidia", "stock price of microsoft".

const QUOTE_URL = (symbols) =>
  `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`;

// Common company name -> ticker aliases so users don't have to type the symbol.
const NAME_TO_TICKER = {
  'apple': 'AAPL', 'microsoft': 'MSFT', 'nvidia': 'NVDA', 'amazon': 'AMZN',
  'google': 'GOOGL', 'alphabet': 'GOOGL', 'meta': 'META', 'facebook': 'META',
  'tesla': 'TSLA', 'netflix': 'NFLX', 'amd': 'AMD', 'intel': 'INTC',
  'coca cola': 'KO', 'coca-cola': 'KO', 'disney': 'DIS', 'walmart': 'WMT',
  'boeing': 'BA', 'nike': 'NKE', 'starbucks': 'SBUX', 'mcdonalds': 'MCD',
  'paypal': 'PYPL', 'visa': 'V', 'mastercard': 'MA', 'jpmorgan': 'JPM',
  'goldman sachs': 'GS', 'cloudflare': 'NET', 'shopify': 'SHOP', 'spotify': 'SPOT',
  'uber': 'UBER', 'airbnb': 'ABNB', 'palantir': 'PLTR', 'snowflake': 'SNOW',
  'oracle': 'ORCL', 'salesforce': 'CRM', 'adobe': 'ADBE', 'reddit': 'RDDT',
  'bitcoin': 'BTC-USD', 'ethereum': 'ETH-USD', 'solana': 'SOL-USD',
  'sp500': '^GSPC', 's&p 500': '^GSPC', 'nasdaq': '^IXIC', 'dow': '^DJI',
};

const CONTEXT_WORDS = /\b(stock|stocks|ticker|share\s+price|stock\s+price|market\s+cap|shares|nasdaq|nyse|wall\s+street|dividend|eps|p\/?e\s+ratio)\b/i;
const DOLLAR_TICKER = /\$([A-Z]{1,5})\b/g;
// Standalone uppercase 2-5 letter words that look like tickers (AAPL, TSLA, META)
const LOOSE_TICKER = /\b([A-Z]{2,5})\b/g;
// Common English all-caps words we should NOT treat as tickers.
const TICKER_STOPWORDS = new Set([
  'I','A','AN','THE','AND','OR','FOR','BUT','NOT','YOU','ARE','WAS','WERE','ONE','TWO','DO','DOES',
  'ON','OFF','IN','OUT','UP','DOWN','TO','AT','BY','AS','IS','AM','PM','IT','ITS','WE','US','OUR',
  'MY','ME','HE','SHE','HIS','HER','HIM','THEY','THEM','THIS','THAT','SO','ALL','GO','OK','OKAY',
  'YES','NO','MAYBE','WHY','HOW','WHO','WHAT','WHEN','WHERE','API','URL','HTTP','HTTPS','HTML','CSS',
  'JS','TS','JSON','XML','AI','ML','CPU','GPU','RAM','SSD','HDD','USA','USD','EUR','GBP','UK','EU',
  'NBA','NFL','NHL','MLB','MVP','ETA','ASAP','FAQ','DIY','LOL','OMG','WTF','BRB','TBD','TLDR','HEY',
]);

export function detect(text) {
  if (!text) return null;
  const tickers = new Set();

  // $TSLA style → always treat as ticker.
  for (const m of text.matchAll(DOLLAR_TICKER)) tickers.add(m[1].toUpperCase());

  // Company name mentions.
  const lower = text.toLowerCase();
  for (const [name, sym] of Object.entries(NAME_TO_TICKER)) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) tickers.add(sym);
  }

  // Loose tickers only count if there's a financial-context word in the message,
  // otherwise "IT", "US", etc. would spam.
  if (CONTEXT_WORDS.test(text)) {
    for (const m of text.matchAll(LOOSE_TICKER)) {
      const t = m[1];
      if (TICKER_STOPWORDS.has(t)) continue;
      tickers.add(t);
    }
  }

  // Cap so a wall of tickers doesn't blow out the request.
  const list = [...tickers].slice(0, 6);
  return list.length ? list : null;
}

export async function fetchContext(tickers) {
  const r = await fetch(QUOTE_URL(tickers), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ChadGPT-Fetcher/1.0; +https://chadgpt-964.pages.dev)',
      'Accept': 'application/json',
    },
  });
  if (!r.ok) return '';
  const j = await r.json().catch(() => null);
  const quotes = j?.quoteResponse?.result || [];
  if (!quotes.length) return '';
  const lines = quotes.map(q => {
    const name = q.shortName || q.longName || q.symbol;
    const price = q.regularMarketPrice;
    const chg = q.regularMarketChange;
    const chgPct = q.regularMarketChangePercent;
    const cur = q.currency || 'USD';
    const arrow = chg > 0 ? '▲' : chg < 0 ? '▼' : '·';
    const chgStr = (chg != null && chgPct != null)
      ? ` ${arrow} ${chg.toFixed(2)} (${chgPct.toFixed(2)}%)` : '';
    const vol = q.regularMarketVolume ? `  vol ${abbr(q.regularMarketVolume)}` : '';
    const mcap = q.marketCap ? `  mcap ${abbr(q.marketCap)}` : '';
    const stamp = q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
    return `- ${q.symbol} (${name}) ${cur} ${price?.toFixed(2) ?? '?'}${chgStr}${vol}${mcap}${stamp ? ' · ' + stamp : ''}`;
  }).join('\n');
  return `## Live quotes (Yahoo Finance)\n${lines}`;
}

function abbr(n) {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

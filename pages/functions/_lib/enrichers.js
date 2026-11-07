// Enrichers: tiny modules that each (1) detect if a user message is about
// their topic and (2) fetch live context that gets prepended before the model
// sees the prompt. Adding a new source = drop another file and add a row here.
//
// Each module exports { detect(text) -> hint|null, fetchContext(hint) -> string }.

import { detectBasketball, fetchNbaContext } from './espn.js';
import * as fortnite from './fortnite.js';
import * as weather from './weather.js';
import * as cryptoMod from './crypto.js';
import * as wikipedia from './wikipedia.js';
import * as pokemon from './pokemon.js';
import * as hackernews from './hackernews.js';
import * as epicfree from './epicfree.js';
import * as dictionary from './dictionary.js';
import * as currency from './currency.js';
import * as worldtime from './worldtime.js';

const sources = [
  { tag: 'nba',        heading: 'NBA (ESPN)',                      detect: detectBasketball,     fetchContext: fetchNbaContext },
  { tag: 'fortnite',   heading: 'Fortnite (fortnite-api.com)',     detect: fortnite.detect,      fetchContext: fortnite.fetchContext },
  { tag: 'weather',    heading: 'Weather (open-meteo)',            detect: weather.detect,       fetchContext: weather.fetchContext },
  { tag: 'crypto',     heading: 'Crypto (Coinbase/CoinGecko)',     detect: cryptoMod.detect,     fetchContext: cryptoMod.fetchContext },
  { tag: 'pokemon',    heading: 'Pokémon (PokéAPI)',               detect: pokemon.detect,       fetchContext: pokemon.fetchContext },
  { tag: 'hn',         heading: 'Hacker News',                     detect: hackernews.detect,    fetchContext: hackernews.fetchContext },
  { tag: 'epicfree',   heading: 'Epic Games free games',           detect: epicfree.detect,      fetchContext: epicfree.fetchContext },
  { tag: 'dict',       heading: 'Dictionary',                      detect: dictionary.detect,    fetchContext: dictionary.fetchContext },
  { tag: 'currency',   heading: 'Currency (open.er-api.com)',      detect: currency.detect,      fetchContext: currency.fetchContext },
  { tag: 'worldtime',  heading: 'World time',                      detect: worldtime.detect,     fetchContext: worldtime.fetchContext },
  // Wikipedia runs LAST as a catch-all for "who/what is X" that nothing else caught.
  { tag: 'wiki',       heading: 'Wikipedia',                       detect: wikipedia.detect,     fetchContext: wikipedia.fetchContext },
];

// Run every detector; for each hit, fetch context in parallel. Returns a
// compact tag string and the merged context ready to prepend.
export async function enrich(text) {
  if (!text) return { tag: 'skip', context: '' };
  const hits = [];
  for (const s of sources) {
    const hint = s.detect(text);
    if (hint) hits.push({ s, hint });
  }
  if (!hits.length) return { tag: 'none', context: '' };

  const results = await Promise.all(hits.map(async ({ s, hint }) => {
    try {
      const ctx = await s.fetchContext(hint);
      return { tag: s.tag, heading: s.heading, ctx: ctx || '' };
    } catch {
      return { tag: s.tag, heading: s.heading, ctx: '' };
    }
  }));

  const parts = [];
  const tags = [];
  for (const r of results) {
    if (r.ctx) {
      parts.push(`## ${r.heading}\n${r.ctx}`);
      tags.push(`${r.tag}:${r.ctx.length}b`);
    } else {
      tags.push(`${r.tag}:empty`);
    }
  }
  return {
    tag: tags.join(','),
    context: parts.join('\n\n'),
  };
}

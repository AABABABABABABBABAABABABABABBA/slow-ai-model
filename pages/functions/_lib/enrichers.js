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
import * as github from './github.js';
import * as apod from './apod.js';
import * as trivia from './trivia.js';
import * as reddit from './reddit.js';
import * as nfl from './nfl.js';
import * as stocks from './stocks.js';
import * as urlReader from './url-reader.js';

const sources = [
  // URL reader runs first — if the user pasted a URL, that's usually the
  // primary subject of their question and we want its content up top.
  { tag: 'url',        heading: 'URL content',                     detect: urlReader.detect,     fetchContext: urlReader.fetchContext },
  { tag: 'nba',        heading: 'NBA (ESPN)',                      detect: detectBasketball,     fetchContext: fetchNbaContext },
  { tag: 'nfl',        heading: 'NFL (ESPN)',                      detect: nfl.detect,           fetchContext: nfl.fetchContext },
  { tag: 'stocks',     heading: 'Stocks (Yahoo Finance)',          detect: stocks.detect,        fetchContext: stocks.fetchContext },
  { tag: 'fortnite',   heading: 'Fortnite (fortnite-api.com)',     detect: fortnite.detect,      fetchContext: fortnite.fetchContext },
  { tag: 'weather',    heading: 'Weather (open-meteo)',            detect: weather.detect,       fetchContext: weather.fetchContext },
  { tag: 'crypto',     heading: 'Crypto (Coinbase/CoinGecko)',     detect: cryptoMod.detect,     fetchContext: cryptoMod.fetchContext },
  { tag: 'pokemon',    heading: 'Pokémon (PokéAPI)',               detect: pokemon.detect,       fetchContext: pokemon.fetchContext },
  { tag: 'hn',         heading: 'Hacker News',                     detect: hackernews.detect,    fetchContext: hackernews.fetchContext },
  { tag: 'epicfree',   heading: 'Epic Games free games',           detect: epicfree.detect,      fetchContext: epicfree.fetchContext },
  { tag: 'dict',       heading: 'Dictionary',                      detect: dictionary.detect,    fetchContext: dictionary.fetchContext },
  { tag: 'currency',   heading: 'Currency (open.er-api.com)',      detect: currency.detect,      fetchContext: currency.fetchContext },
  { tag: 'worldtime',  heading: 'World time',                      detect: worldtime.detect,     fetchContext: worldtime.fetchContext },
  { tag: 'github',     heading: 'GitHub',                          detect: github.detect,        fetchContext: github.fetchContext },
  { tag: 'apod',       heading: 'NASA APOD',                       detect: apod.detect,          fetchContext: apod.fetchContext },
  { tag: 'trivia',     heading: 'Random fact',                     detect: trivia.detect,        fetchContext: trivia.fetchContext },
  { tag: 'reddit',     heading: 'Reddit',                          detect: reddit.detect,        fetchContext: reddit.fetchContext },
  // Wikipedia runs LAST as a catch-all for "who/what is X" that nothing else caught.
  { tag: 'wiki',       heading: 'Wikipedia',                       detect: wikipedia.detect,     fetchContext: wikipedia.fetchContext },
];

// Run every detector; for each hit, fetch context in parallel.
// Each fetch is capped at ENRICH_TIMEOUT_MS so one slow upstream (e.g. a
// hung Wikipedia request) doesn't block the whole chat turn.
// Bumped from 1.5s to 3s to give the URL reader + stocks enough time —
// most news pages take 1-2s to serve full HTML.
const ENRICH_TIMEOUT_MS = 3000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout:${label}`)), ms)),
  ]);
}

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
      const ctx = await withTimeout(s.fetchContext(hint), ENRICH_TIMEOUT_MS, s.tag);
      return { tag: s.tag, heading: s.heading, ctx: ctx || '' };
    } catch (err) {
      const reason = (err?.message || '').startsWith('timeout:') ? 'timeout' : 'err';
      return { tag: s.tag, heading: s.heading, ctx: '', note: reason };
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

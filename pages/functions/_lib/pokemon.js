// PokéAPI (no key). Detects Pokémon-adjacent questions and resolves a name.

const TRIGGERS = /\bpok(e|é)mon\b/i;
const NAME_IN_CONTEXT = /\b(?:about|is|was|the)\s+([a-z][a-z0-9-]{2,24})\b/i;
// A handful of famous names that trigger even without "pokemon" being said.
const FAMOUS = /\b(pikachu|charizard|bulbasaur|squirtle|mewtwo|mew|lugia|ho-oh|rayquaza|arceus|dialga|palkia|giratina|eevee|snorlax|gengar|lucario|greninja|garchomp|dragonite|gyarados|gardevoir|tyranitar|metagross)\b/i;

export function detect(text) {
  if (!text) return null;
  const famous = text.match(FAMOUS);
  const hasKeyword = TRIGGERS.test(text);
  if (!famous && !hasKeyword) return null;
  let name = famous ? famous[1].toLowerCase() : null;
  if (!name) {
    const m = text.match(NAME_IN_CONTEXT);
    if (m) name = m[1].toLowerCase();
  }
  if (!name) return null;
  return { name };
}

async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

export async function fetchContext(hint) {
  const d = await fetchJson(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(hint.name)}`);
  if (!d) return null;
  const types = (d.types || []).map(t => t.type?.name).filter(Boolean).join('/');
  const abilities = (d.abilities || []).map(a => a.ability?.name).filter(Boolean).join(', ');
  const stats = (d.stats || []).slice(0, 6).map(s => `${s.stat?.name}: ${s.base_stat}`).join(', ');
  const h = d.height ? (d.height / 10).toFixed(1) + 'm' : '?';
  const w = d.weight ? (d.weight / 10).toFixed(1) + 'kg' : '?';
  return `PokéAPI · #${d.id} ${d.name} (${types}): height ${h}, weight ${w}. Abilities: ${abilities}. Stats: ${stats}.`;
}

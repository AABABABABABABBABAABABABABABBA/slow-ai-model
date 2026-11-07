// Epic Games Store free games this week (public endpoint, no key).

// Fire on any message that mentions both "free" and ("epic" OR "epic games store").
const FREE = /\bfree\b/i;
const EPIC = /\b(epic\s*games?|epic\s*store|egs)\b/i;

export function detect(text) {
  if (!text) return null;
  if (!(FREE.test(text) && EPIC.test(text))) return null;
  return {};
}

export async function fetchContext() {
  const url = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const d = await r.json();
    const items = d?.data?.Catalog?.searchStore?.elements || [];
    const now = Date.now();
    const current = [];
    const upcoming = [];
    for (const g of items) {
      const promos = g.promotions?.promotionalOffers || [];
      const upPromos = g.promotions?.upcomingPromotionalOffers || [];
      for (const slot of promos) {
        for (const o of (slot.promotionalOffers || [])) {
          const start = Date.parse(o.startDate);
          const end = Date.parse(o.endDate);
          if (start <= now && now <= end && o.discountSetting?.discountPercentage === 0) {
            current.push({ title: g.title, until: o.endDate });
          }
        }
      }
      for (const slot of upPromos) {
        for (const o of (slot.promotionalOffers || [])) {
          upcoming.push({ title: g.title, from: o.startDate, to: o.endDate });
        }
      }
    }
    const lines = [];
    if (current.length) {
      lines.push('Free on Epic Games Store right now:');
      for (const c of current) lines.push(`- ${c.title} (until ${c.until?.slice(0, 16).replace('T', ' ')} UTC)`);
    }
    if (upcoming.length) {
      lines.push('Coming up free on Epic Games Store:');
      for (const u of upcoming) lines.push(`- ${u.title} (from ${u.from?.slice(0, 10)} to ${u.to?.slice(0, 10)})`);
    }
    return lines.join('\n') || null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

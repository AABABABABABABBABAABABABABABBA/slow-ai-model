// Live ESPN NBA data. Public API, no key required.
// Used by /api/chat to inject fresh context when the user asks about basketball.

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const TEAM_URL = (abbr) => `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${abbr}`;
const STANDINGS_URL = 'https://site.web.api.espn.com/apis/v2/sports/basketball/nba/standings?level=0';
const NEWS_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news';

// Team name/nickname -> ESPN 3-letter abbreviation
const TEAM_ABBR = {
  'lakers': 'lal', 'warriors': 'gsw', 'celtics': 'bos', 'bulls': 'chi',
  'heat': 'mia', 'nets': 'bkn', 'knicks': 'nyk', 'sixers': 'phi', '76ers': 'phi', 'philly': 'phi',
  'raptors': 'tor', 'nuggets': 'den', 'timberwolves': 'min', 't-wolves': 'min',
  'grizzlies': 'mem', 'suns': 'phx', 'mavericks': 'dal', 'mavs': 'dal',
  'rockets': 'hou', 'spurs': 'sas', 'kings': 'sac', 'clippers': 'lac',
  'pelicans': 'nop', 'blazers': 'por', 'trail blazers': 'por', 'jazz': 'utah',
  'thunder': 'okc', 'hawks': 'atl', 'hornets': 'cha', 'pistons': 'det',
  'pacers': 'ind', 'bucks': 'mil', 'magic': 'orl', 'wizards': 'wsh',
  'cavaliers': 'cle', 'cavs': 'cle',
};

const GENERAL_HINTS = /\b(nba|basketball|hoops|baller|scoreboard|playoffs|all[- ]?star|dunk|three[- ]pointer|mvp|rookie of the year)\b/i;
const STANDINGS_HINTS = /\b(standings?|conference|division|rankings?|seed(ing)?)\b/i;
const NEWS_HINTS = /\b(news|rumor|rumou?r|trade|signing|injury|injured)\b/i;

export function detectBasketball(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const teams = new Set();
  for (const name of Object.keys(TEAM_ABBR)) {
    const re = new RegExp('\\b' + name.replace(/ /g, '\\s+').replace(/-/g, '[- ]') + '\\b', 'i');
    if (re.test(lower)) teams.add(TEAM_ABBR[name]);
  }
  const general = GENERAL_HINTS.test(lower);
  if (!teams.size && !general) return null;
  return {
    teams: [...teams],
    wantStandings: STANDINGS_HINTS.test(lower),
    wantNews: NEWS_HINTS.test(lower),
  };
}

async function fetchJson(url, timeoutMs = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

function fmtScoreboard(sb) {
  if (!sb?.events?.length) return '';
  const date = sb.day?.date || new Date().toISOString().slice(0, 10);
  const lines = sb.events.slice(0, 15).map(e => {
    const comp = e.competitions?.[0];
    if (!comp) return null;
    const [a, b] = comp.competitors || [];
    if (!a || !b) return null;
    const scoreA = a.score ?? '-';
    const scoreB = b.score ?? '-';
    const status = e.status?.type?.shortDetail || e.status?.type?.description || '';
    const venue = comp.venue?.fullName ? ` @ ${comp.venue.fullName}` : '';
    const away = a.homeAway === 'away' ? a : b;
    const home = a.homeAway === 'home' ? a : b;
    return `${away.team.abbreviation} ${away.score ?? '-'} @ ${home.team.abbreviation} ${home.score ?? '-'} — ${status}${venue}`;
  }).filter(Boolean);
  if (!lines.length) return '';
  return `NBA scoreboard for ${date}:\n` + lines.join('\n');
}

function fmtTeam(abbr, data) {
  if (!data?.team) return '';
  const team = data.team;
  const record = team.record?.items?.[0]?.summary || 'record n/a';
  const standing = team.standingSummary || '';
  const lastDisplay = team.record?.items?.[0]?.stats?.find(s => s.name === 'streak')?.displayValue || '';
  const next = team.nextEvent?.[0];
  let nextStr = '';
  if (next) {
    const comp = next.competitions?.[0];
    const opp = comp?.competitors?.find(c => c.team?.abbreviation?.toLowerCase() !== abbr);
    if (opp) nextStr = ` · Next: ${opp.homeAway === 'home' ? '@ ' : 'vs '}${opp.team.displayName} ${new Date(next.date).toUTCString().slice(5, 22)}`;
  }
  const streak = lastDisplay ? ` · streak ${lastDisplay}` : '';
  return `${team.displayName} (${abbr.toUpperCase()}): ${record} ${standing}${streak}${nextStr}`;
}

function fmtStandings(data) {
  if (!data?.children?.length) return '';
  const lines = [];
  for (const conf of data.children) {
    const confName = conf.name || '';
    const entries = (conf.standings?.entries || []).slice(0, 8);
    lines.push(`${confName}:`);
    for (const e of entries) {
      const team = e.team?.abbreviation || e.team?.name || '?';
      const stats = e.stats || [];
      const w = stats.find(s => s.name === 'wins')?.displayValue || '-';
      const l = stats.find(s => s.name === 'losses')?.displayValue || '-';
      const pct = stats.find(s => s.name === 'winPercent')?.displayValue || '';
      const gb = stats.find(s => s.name === 'gamesBehind')?.displayValue || '';
      lines.push(`  ${team.padEnd(4)} ${w}-${l}  ${pct}${gb ? '  GB ' + gb : ''}`);
    }
  }
  return lines.join('\n');
}

function fmtNews(data) {
  const items = data?.articles?.slice(0, 5) || [];
  if (!items.length) return '';
  return 'Latest NBA news from ESPN:\n' + items.map(a =>
    `- ${a.headline}${a.description ? ' — ' + a.description.slice(0, 160) : ''}`
  ).join('\n');
}

export async function fetchNbaContext(hint) {
  const tasks = [];
  tasks.push(fetchJson(SCOREBOARD_URL).then(fmtScoreboard));
  for (const abbr of (hint.teams || []).slice(0, 3)) {
    tasks.push(fetchJson(TEAM_URL(abbr)).then(d => fmtTeam(abbr, d)));
  }
  if (hint.wantStandings) tasks.push(fetchJson(STANDINGS_URL).then(fmtStandings));
  if (hint.wantNews)     tasks.push(fetchJson(NEWS_URL).then(fmtNews));
  const parts = (await Promise.all(tasks)).filter(Boolean);
  return parts.join('\n\n');
}

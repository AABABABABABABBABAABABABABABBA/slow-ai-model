// Live ESPN NFL data. Public API, no key.

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const TEAM = (abbr) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${abbr}`;
const STANDINGS = 'https://site.web.api.espn.com/apis/v2/sports/football/nfl/standings?level=0';
const NEWS = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news';

const TEAM_ABBR = {
  'patriots': 'ne', 'pats': 'ne', 'bills': 'buf', 'dolphins': 'mia', 'jets': 'nyj',
  'ravens': 'bal', 'bengals': 'cin', 'browns': 'cle', 'steelers': 'pit',
  'texans': 'hou', 'colts': 'ind', 'jaguars': 'jax', 'jags': 'jax', 'titans': 'ten',
  'broncos': 'den', 'chiefs': 'kc', 'raiders': 'lv', 'chargers': 'lac',
  'cowboys': 'dal', 'giants': 'nyg', 'eagles': 'phi', 'commanders': 'wsh',
  'bears': 'chi', 'lions': 'det', 'packers': 'gb', 'vikings': 'min',
  'falcons': 'atl', 'panthers': 'car', 'saints': 'no', 'buccaneers': 'tb', 'bucs': 'tb',
  'cardinals': 'ari', 'rams': 'lar', '49ers': 'sf', 'niners': 'sf', 'seahawks': 'sea',
};

const GENERAL = /\b(nfl|football|super ?bowl|playoffs?|touchdown|td|quarterback|qb|wide receiver|wr|running back|rb)\b/i;
const STAND = /\b(standings?|conference|division|rankings?|seed(ing)?|afc|nfc)\b/i;
const NEWS_RE = /\b(news|rumor|rumou?r|trade|signing|injury|injured|cut|released)\b/i;

export function detect(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const teams = new Set();
  for (const name of Object.keys(TEAM_ABBR)) {
    const re = new RegExp(`\\b${name}\\b`, 'i');
    if (re.test(lower)) teams.add(TEAM_ABBR[name]);
  }
  const general = GENERAL.test(lower);
  const stand = STAND.test(lower);
  const news = NEWS_RE.test(lower);
  if (!teams.size && !general && !stand && !news) return null;
  return { teams: [...teams], general, stand, news };
}

export async function fetchContext(hint) {
  const parts = [];
  const tasks = [];
  tasks.push(fetchScoreboard().catch(() => null));
  for (const abbr of hint.teams.slice(0, 2)) tasks.push(fetchTeam(abbr).catch(() => null));
  if (hint.stand) tasks.push(fetchStandings().catch(() => null));
  if (hint.news) tasks.push(fetchNews().catch(() => null));
  const results = await Promise.all(tasks);
  for (const r of results) if (r) parts.push(r);
  return parts.join('\n\n');
}

function fmtDate(iso) {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  const month = ['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr12 = ((h + 11) % 12) + 1;
  return `${month} ${day}, ${year} at ${hr12}:${m} ${ampm} UTC`;
}

async function fetchScoreboard() {
  const r = await fetch(SCOREBOARD);
  if (!r.ok) return null;
  const j = await r.json();
  const games = (j.events || []).slice(0, 10).map(e => {
    const comp = e.competitions?.[0];
    const away = comp?.competitors?.find(c => c.homeAway === 'away');
    const home = comp?.competitors?.find(c => c.homeAway === 'home');
    const status = comp?.status?.type?.shortDetail || e.status?.type?.description || '';
    return `- ${away?.team?.displayName || '?'} ${away?.score ?? ''} @ ${home?.team?.displayName || '?'} ${home?.score ?? ''} — ${status} (${fmtDate(e.date)})`;
  }).join('\n');
  return games ? `## NFL Scoreboard (today)\n${games}` : '';
}

async function fetchTeam(abbr) {
  const r = await fetch(TEAM(abbr));
  if (!r.ok) return null;
  const j = await r.json();
  const t = j.team;
  if (!t) return null;
  const record = t.record?.items?.[0]?.summary || '';
  const next = t.nextEvent?.[0];
  const nextLine = next ? `Next: ${next.name} — ${fmtDate(next.date)}` : '';
  return `## ${t.displayName} (${record})\n${t.standingSummary || ''}\n${nextLine}`.trim();
}

async function fetchStandings() {
  const r = await fetch(STANDINGS);
  if (!r.ok) return null;
  const j = await r.json();
  const confs = j.children || [];
  const out = [];
  for (const conf of confs) {
    out.push(`### ${conf.name}`);
    for (const div of conf.children || []) {
      out.push(`**${div.name}**`);
      const entries = (div.standings?.entries || []).slice(0, 4);
      for (const e of entries) {
        const w = e.stats?.find(s => s.name === 'wins')?.value ?? '?';
        const l = e.stats?.find(s => s.name === 'losses')?.value ?? '?';
        const tTxt = e.stats?.find(s => s.name === 'ties')?.value;
        const rec = tTxt ? `${w}-${l}-${tTxt}` : `${w}-${l}`;
        out.push(`- ${e.team?.displayName}: ${rec}`);
      }
    }
  }
  return out.length ? `## NFL Standings\n${out.join('\n')}` : '';
}

async function fetchNews() {
  const r = await fetch(NEWS);
  if (!r.ok) return null;
  const j = await r.json();
  const articles = (j.articles || []).slice(0, 5).map(a => `- ${a.headline}${a.description ? ' — ' + a.description.slice(0, 160) : ''}`).join('\n');
  return articles ? `## NFL Headlines\n${articles}` : '';
}

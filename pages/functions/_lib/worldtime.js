// World time — computed locally via Intl.DateTimeFormat (no network call).

const TRIGGERS = /\b(?:what\s+time\s+is\s+it\s+in|time\s+in|current\s+time\s+in)\s+([A-Z][a-zA-Z .\-\/]+)/;
const CITY_TO_TZ = {
  tokyo: 'Asia/Tokyo', london: 'Europe/London', paris: 'Europe/Paris', berlin: 'Europe/Berlin',
  madrid: 'Europe/Madrid', rome: 'Europe/Rome', 'new york': 'America/New_York', nyc: 'America/New_York',
  'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', chicago: 'America/Chicago',
  toronto: 'America/Toronto', vancouver: 'America/Vancouver', sydney: 'Australia/Sydney',
  melbourne: 'Australia/Melbourne', dubai: 'Asia/Dubai', singapore: 'Asia/Singapore',
  seoul: 'Asia/Seoul', 'hong kong': 'Asia/Hong_Kong', shanghai: 'Asia/Shanghai',
  beijing: 'Asia/Shanghai', mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata',
  'mexico city': 'America/Mexico_City', 'sao paulo': 'America/Sao_Paulo',
  cairo: 'Africa/Cairo', nairobi: 'Africa/Nairobi', lagos: 'Africa/Lagos',
  moscow: 'Europe/Moscow', istanbul: 'Europe/Istanbul', amsterdam: 'Europe/Amsterdam',
  'san francisco': 'America/Los_Angeles', seattle: 'America/Los_Angeles',
  denver: 'America/Denver', miami: 'America/New_York', boston: 'America/New_York',
  bangkok: 'Asia/Bangkok', jakarta: 'Asia/Jakarta', manila: 'Asia/Manila',
  taipei: 'Asia/Taipei', kyiv: 'Europe/Kyiv', warsaw: 'Europe/Warsaw',
  athens: 'Europe/Athens', lisbon: 'Europe/Lisbon', dublin: 'Europe/Dublin',
};

export function detect(text) {
  if (!text) return null;
  const m = text.match(TRIGGERS);
  if (!m) return null;
  const city = m[1].trim().replace(/[.?!,]+$/, '').toLowerCase();
  const tz = CITY_TO_TZ[city] || m[1].trim().replace(/ /g, '_');
  return { tz, label: m[1].trim() };
}

export async function fetchContext(hint) {
  try {
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat('en-US', {
      timeZone: hint.tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'short',
    }).format(now);
    return `Current time in ${hint.label} (${hint.tz}): ${dateStr}`;
  } catch { return null; }
}

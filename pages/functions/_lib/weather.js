// Live weather via open-meteo (no key required).
// Default location: Norwood, Ontario, Canada (owner preference).

const TRIGGERS = /\b(weather|forecast|temperature|rain(ing)?|snow(ing)?|sunny|cloudy|storm|humidity|wind|degrees|celsius|fahrenheit|how (hot|cold|warm))\b/i;
const DEFAULT_LOC = { name: 'Norwood', country: 'Canada', latitude: 44.3834, longitude: -77.9833, tz: 'America/Toronto' };

export function detect(text) {
  if (!text || !TRIGGERS.test(text)) return null;
  // Try "in <Place>" or "at <Place>"
  const m = text.match(/\b(?:in|at|for)\s+([A-Z][A-Za-z .\-']+(?:,\s*[A-Z][A-Za-z .\-']+)?)/);
  const location = m ? m[1].replace(/[.?!,]+$/, '').trim() : null;
  return { location };
}

async function fetchJson(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

const WX_CODE = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'depositing rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'heavy showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm w/ hail', 99: 'thunderstorm w/ heavy hail' };

export async function fetchContext(hint) {
  let loc = DEFAULT_LOC;
  if (hint.location) {
    const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(hint.location)}&count=1`);
    const hit = geo?.results?.[0];
    if (hit) loc = { name: hit.name, country: hit.country || '', latitude: hit.latitude, longitude: hit.longitude, tz: hit.timezone || 'UTC' };
  }
  const wx = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&hourly=temperature_2m,precipitation_probability,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=${encodeURIComponent(loc.tz)}`);
  if (!wx?.current) return null;
  const c = wx.current;
  const cond = WX_CODE[c.weather_code] || 'unknown';
  const cur = `Now in ${loc.name}${loc.country ? ', ' + loc.country : ''}: ${Math.round(c.temperature_2m)}°C (feels ${Math.round(c.apparent_temperature)}°C), ${cond}, humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h.`;
  const daily = wx.daily?.time?.slice(0, 3).map((d, i) => {
    const code = WX_CODE[wx.daily.weather_code[i]] || '-';
    return `${d}: ${Math.round(wx.daily.temperature_2m_min[i])}°C → ${Math.round(wx.daily.temperature_2m_max[i])}°C, ${code}, ${wx.daily.precipitation_probability_max[i] || 0}% precip`;
  }) || [];
  return cur + (daily.length ? '\n3-day outlook:\n' + daily.join('\n') : '');
}

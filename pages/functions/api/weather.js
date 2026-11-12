// GET /api/weather?location=<name>   OR   /api/weather   (defaults to Norwood ON)
//
// Returns a structured weather payload the client renders as an inline
// embed. Same open-meteo backend the chat enricher uses, but shaped for
// a card (icon code, 3-day forecast, hourly next-6, geocoded location).
//
// No auth — same endpoint any OAI-compat client can call for context;
// doesn't cost us AI tokens either way.

import { json } from '../_lib/auth.js';

const DEFAULT_LOC = { name: 'Norwood', country: 'Canada', latitude: 44.3834, longitude: -77.9833, tz: 'America/Toronto' };

const WX = {
  0:  { label: 'Clear',               icon: 'sun' },
  1:  { label: 'Mostly clear',        icon: 'sun' },
  2:  { label: 'Partly cloudy',       icon: 'cloud-sun' },
  3:  { label: 'Overcast',            icon: 'cloud' },
  45: { label: 'Fog',                 icon: 'fog' },
  48: { label: 'Rime fog',            icon: 'fog' },
  51: { label: 'Light drizzle',       icon: 'drizzle' },
  53: { label: 'Drizzle',             icon: 'drizzle' },
  55: { label: 'Heavy drizzle',       icon: 'drizzle' },
  61: { label: 'Light rain',          icon: 'rain' },
  63: { label: 'Rain',                icon: 'rain' },
  65: { label: 'Heavy rain',          icon: 'rain' },
  71: { label: 'Light snow',          icon: 'snow' },
  73: { label: 'Snow',                icon: 'snow' },
  75: { label: 'Heavy snow',          icon: 'snow' },
  77: { label: 'Snow grains',         icon: 'snow' },
  80: { label: 'Rain showers',        icon: 'rain' },
  81: { label: 'Heavy showers',       icon: 'rain' },
  82: { label: 'Violent showers',     icon: 'rain' },
  85: { label: 'Snow showers',        icon: 'snow' },
  86: { label: 'Heavy snow showers',  icon: 'snow' },
  95: { label: 'Thunderstorm',        icon: 'storm' },
  96: { label: 'T-storm w/ hail',     icon: 'storm' },
  99: { label: 'T-storm w/ heavy hail', icon: 'storm' },
};

async function j(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('location') || '').trim();

  let loc = DEFAULT_LOC;
  if (q) {
    const geo = await j(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1`);
    const hit = geo?.results?.[0];
    if (hit) loc = { name: hit.name, country: hit.country || '', admin1: hit.admin1 || '', latitude: hit.latitude, longitude: hit.longitude, tz: hit.timezone || 'UTC' };
    else return json({ error: `location "${q}" not found` }, { status: 404 });
  }

  const wx = await j(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day&hourly=temperature_2m,precipitation_probability,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&forecast_days=5&timezone=${encodeURIComponent(loc.tz)}`);
  if (!wx?.current) return json({ error: 'weather upstream unavailable' }, { status: 502 });

  const c = wx.current;
  const code = WX[c.weather_code] || { label: 'Unknown', icon: 'cloud' };

  // Next 6 hourly slices starting from now.
  const nowIso = (wx.current_hour || c.time || '').slice(0, 13);
  const hourStart = Math.max(0, (wx.hourly?.time || []).findIndex((t) => t >= nowIso));
  const hourly = (wx.hourly?.time || []).slice(hourStart, hourStart + 6).map((t, i) => {
    const idx = hourStart + i;
    return {
      time: t,
      temp_c: Math.round(wx.hourly.temperature_2m[idx]),
      precip_pct: wx.hourly.precipitation_probability?.[idx] ?? null,
      icon: (WX[wx.hourly.weather_code[idx]] || { icon: 'cloud' }).icon,
    };
  });

  const daily = (wx.daily?.time || []).slice(0, 5).map((d, i) => {
    const dcode = WX[wx.daily.weather_code[i]] || { label: 'Unknown', icon: 'cloud' };
    return {
      date: d,
      label: dcode.label,
      icon: dcode.icon,
      hi_c: Math.round(wx.daily.temperature_2m_max[i]),
      lo_c: Math.round(wx.daily.temperature_2m_min[i]),
      precip_pct: wx.daily.precipitation_probability_max?.[i] ?? 0,
    };
  });

  return json({
    ok: true,
    location: loc,
    current: {
      temp_c: Math.round(c.temperature_2m),
      feels_c: Math.round(c.apparent_temperature),
      label: code.label,
      icon: code.icon,
      is_day: c.is_day === 1,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: Math.round(c.wind_speed_10m),
    },
    hourly,
    daily,
    fetched_at: Date.now(),
  });
}

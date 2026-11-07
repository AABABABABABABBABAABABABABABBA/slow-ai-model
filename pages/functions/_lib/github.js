// GitHub public API (no auth needed for basic reads, 60/hour unauth rate).

const REPO = /\b(?:github(?:\.com)?[ /]+)?([a-zA-Z0-9][-\w.]{0,38})\/([a-zA-Z0-9][-\w.]{0,100})\b/;
const USER_HINT = /\b(?:github user|gh user|github profile)\s+([a-zA-Z0-9][-\w.]{0,38})\b/i;
const TRIGGER = /\b(github|gh|repo(sitory)?)\b/i;

export function detect(text) {
  if (!text) return null;
  const u = text.match(USER_HINT);
  if (u) return { kind: 'user', login: u[1] };
  const m = text.match(REPO);
  if (m && TRIGGER.test(text)) return { kind: 'repo', owner: m[1], name: m[2] };
  return null;
}

async function fetchJson(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'ChadGPT/1.0 (+https://chadgpt.pages.dev)',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

export async function fetchContext(hint) {
  if (hint.kind === 'repo') {
    const d = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(hint.owner)}/${encodeURIComponent(hint.name)}`);
    if (!d || d.message === 'Not Found') return null;
    return `GitHub · ${d.full_name}: ${d.description || '(no description)'}
⭐ ${d.stargazers_count?.toLocaleString() || 0} · 🍴 ${d.forks_count?.toLocaleString() || 0} · ${d.open_issues_count || 0} open issues
Language: ${d.language || '?'} · License: ${d.license?.spdx_id || d.license?.name || 'none'}
Updated: ${d.updated_at?.slice(0, 10) || '?'} · Default branch: ${d.default_branch}
URL: ${d.html_url}${d.homepage ? '\nHomepage: ' + d.homepage : ''}`;
  }
  if (hint.kind === 'user') {
    const d = await fetchJson(`https://api.github.com/users/${encodeURIComponent(hint.login)}`);
    if (!d || d.message === 'Not Found') return null;
    return `GitHub · @${d.login}${d.name ? ' (' + d.name + ')' : ''}: ${d.bio || '(no bio)'}
Followers ${d.followers} · Following ${d.following} · Public repos ${d.public_repos}
Company: ${d.company || '?'} · Location: ${d.location || '?'}
URL: ${d.html_url}`;
  }
  return null;
}

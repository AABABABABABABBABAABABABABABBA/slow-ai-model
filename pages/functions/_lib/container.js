// Shared container row helpers (D1-backed).

const IMAGE = 'chadgpt/runner:3.11-node20-alpine';
const CPU = 2;
const MEM_MB = 1024;
const DISK_MB = 4096;

function newId() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return 'ctr_' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function ensureRunning(env, userId, region) {
  if (!env.DB) throw new Error('DB not bound');
  const existing = await env.DB
    .prepare('SELECT id, image, cpu, memory_mb, disk_mb, region, status, created_at, last_seen_at FROM containers WHERE user_id = ? AND status = ? LIMIT 1')
    .bind(userId, 'running').first();
  const now = Date.now();
  if (existing) {
    await env.DB.prepare('UPDATE containers SET last_seen_at = ? WHERE id = ?').bind(now, existing.id).run();
    return { ...existing, last_seen_at: now };
  }
  const id = newId();
  await env.DB.prepare(
    'INSERT INTO containers (id, user_id, image, cpu, memory_mb, disk_mb, region, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, userId, IMAGE, CPU, MEM_MB, DISK_MB, region || null, 'running', now, now).run();
  return { id, image: IMAGE, cpu: CPU, memory_mb: MEM_MB, disk_mb: DISK_MB, region, status: 'running', created_at: now, last_seen_at: now };
}

export function toResponse(row, requestRegion) {
  const now = Date.now();
  const uptimeMs = row.status === 'running'
    ? now - row.created_at
    : (row.stopped_at || row.last_seen_at || now) - row.created_at;
  return {
    id: row.id,
    image: row.image,
    cpu: row.cpu,
    memory_mb: row.memory_mb,
    disk_mb: row.disk_mb,
    region: row.region || requestRegion || 'unknown',
    status: row.status,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    stopped_at: row.stopped_at || null,
    uptime_ms: Math.max(0, uptimeMs),
    isolated: true,
    lifecycle: 'runs until you call /api/container/stop. Survives logout and reload.',
  };
}

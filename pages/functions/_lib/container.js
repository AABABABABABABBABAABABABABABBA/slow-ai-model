// Shared container row helpers (D1-backed).
// Container specs scale with the user's plan — free tier gets a tiny
// sandbox, Plus gets a real one, Unlimited gets headroom.
// CPU is stored as millicpu (100 = 0.1 vCPU, 2000 = 2 vCPU) so we can
// express fractions without changing the column to REAL.

const IMAGE_FREE = 'chadgpt/runner:3.11-node20-alpine-slim';
const IMAGE_PLUS = 'chadgpt/runner:3.11-node20-alpine';

const SPECS = {
  free:      { cpu_milli: 100,  memory_mb: 256,  disk_mb: 512,  image: IMAGE_FREE },
  plus:      { cpu_milli: 2000, memory_mb: 1024, disk_mb: 4096, image: IMAGE_PLUS },
  unlimited: { cpu_milli: 4000, memory_mb: 2048, disk_mb: 8192, image: IMAGE_PLUS },
};

function specFor(plan) {
  return SPECS[plan] || SPECS.free;
}

function sessionNameFor(plan, userId) {
  // Short, user-facing label that makes the tier obvious on the badge.
  // Example: 'free-sbx-a3f8', 'plus-sbx-a3f8', 'unlimited-sbx-a3f8'
  const tier = plan === 'unlimited' ? 'unlimited' : plan === 'plus' ? 'plus' : 'free';
  const b = new Uint8Array(2);
  crypto.getRandomValues(b);
  const suffix = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return `${tier}-sbx-${userId}-${suffix}`;
}

function newId() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return 'ctr_' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function ensureRunning(env, userId, region, plan = 'free') {
  if (!env.DB) throw new Error('DB not bound');
  const existing = await env.DB
    .prepare('SELECT id, image, cpu, cpu_milli, memory_mb, disk_mb, region, status, created_at, last_seen_at, plan FROM containers WHERE user_id = ? AND status = ? LIMIT 1')
    .bind(userId, 'running').first();
  const now = Date.now();

  if (existing) {
    // If the user has changed plan since their container was provisioned,
    // re-size it in place so they get the new specs on next heartbeat.
    const spec = specFor(plan);
    if (existing.plan !== plan || existing.cpu_milli !== spec.cpu_milli) {
      await env.DB.prepare(
        'UPDATE containers SET plan = ?, cpu = ?, cpu_milli = ?, memory_mb = ?, disk_mb = ?, image = ?, last_seen_at = ? WHERE id = ?'
      ).bind(plan, Math.max(1, Math.round(spec.cpu_milli / 1000)), spec.cpu_milli, spec.memory_mb, spec.disk_mb, spec.image, now, existing.id).run();
      return { ...existing, plan, cpu_milli: spec.cpu_milli, cpu: Math.max(1, Math.round(spec.cpu_milli / 1000)), memory_mb: spec.memory_mb, disk_mb: spec.disk_mb, image: spec.image, last_seen_at: now };
    }
    await env.DB.prepare('UPDATE containers SET last_seen_at = ? WHERE id = ?').bind(now, existing.id).run();
    return { ...existing, last_seen_at: now };
  }

  const id = newId();
  const spec = specFor(plan);
  await env.DB.prepare(
    'INSERT INTO containers (id, user_id, image, cpu, cpu_milli, memory_mb, disk_mb, region, status, created_at, last_seen_at, plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, userId, spec.image, Math.max(1, Math.round(spec.cpu_milli / 1000)), spec.cpu_milli, spec.memory_mb, spec.disk_mb, region || null, 'running', now, now, plan).run();
  return {
    id, image: spec.image,
    cpu: Math.max(1, Math.round(spec.cpu_milli / 1000)),
    cpu_milli: spec.cpu_milli,
    memory_mb: spec.memory_mb, disk_mb: spec.disk_mb,
    region, status: 'running', created_at: now, last_seen_at: now, plan,
  };
}

export function toResponse(row, requestRegion) {
  const now = Date.now();
  const uptimeMs = row.status === 'running'
    ? now - row.created_at
    : (row.stopped_at || row.last_seen_at || now) - row.created_at;
  const plan = row.plan || 'free';
  const cpuMilli = row.cpu_milli ?? ((row.cpu || 1) * 1000);
  return {
    id: row.id,
    name: sessionLabelFor(plan, row.id),
    plan,
    image: row.image,
    cpu_milli: cpuMilli,
    cpu_vcpu: Math.round(cpuMilli / 10) / 100,    // 0.1, 2, 4, etc.
    memory_mb: row.memory_mb,
    disk_mb: row.disk_mb,
    region: row.region || requestRegion || 'unknown',
    status: row.status,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    stopped_at: row.stopped_at || null,
    uptime_ms: Math.max(0, uptimeMs),
    isolated: true,
    tier_label: planLabel(plan, cpuMilli, row.memory_mb, row.disk_mb),
    lifecycle: 'runs until you call /api/container/stop. Survives logout and reload.',
  };
}

// Stable short label derived from the container id so it doesn't flip
// between requests. Example: 'plus-sbx-a3f8'.
function sessionLabelFor(plan, containerId) {
  const tier = plan === 'unlimited' ? 'unlimited' : plan === 'plus' ? 'plus' : 'free';
  // Last 4 hex of ctr_<12hex>
  const suffix = String(containerId || '').slice(-4);
  return `${tier}-sbx-${suffix}`;
}

function planLabel(plan, cpuMilli, memMb, diskMb) {
  const vcpu = Math.round(cpuMilli / 10) / 100;
  const gb = diskMb >= 1024 ? `${(diskMb / 1024).toFixed(1)} GB` : `${diskMb} MB`;
  return `${plan.toUpperCase()} · ${vcpu} vCPU · ${memMb} MB RAM · ${gb} disk`;
}

export { sessionNameFor };

-- ChadGPT users database (Cloudflare D1)
-- Apply with: npx wrangler d1 execute chadgpt-users --remote --file=db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- format: "pbkdf2$<iter>$<salt_b64>$<hash_b64>"
  plan TEXT NOT NULL DEFAULT 'free',    -- 'free' | 'plus' | 'unlimited'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  usage_score REAL NOT NULL DEFAULT 100,
  usage_last_at INTEGER NOT NULL DEFAULT 0,
  granted_by TEXT,                      -- email of founder who granted unlimited; NULL otherwise
  granted_at INTEGER,                   -- epoch ms when unlimited was granted
  banned INTEGER NOT NULL DEFAULT 0,    -- 1 = login + all APIs refuse
  muted INTEGER NOT NULL DEFAULT 0,     -- 1 = can log in but /api/chat refuses
  blocked_models TEXT NOT NULL DEFAULT '[]',  -- JSON array of model keys this user can't use
  moderation_note TEXT                  -- founder's note on why
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Optional: chat log table (not wired into the app yet, left here for growth)
CREATE TABLE IF NOT EXISTS chat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  worker TEXT NOT NULL,                 -- 'chat' | 'code' | 'image'
  model TEXT,
  tokens INTEGER DEFAULT 0,
  spam INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_chat_events_user ON chat_events(user_id, created_at DESC);

-- Per-user sandbox container session (server-side state).
CREATE TABLE IF NOT EXISTS containers (
  id TEXT PRIMARY KEY,                    -- ctr_<12 hex>
  user_id INTEGER NOT NULL,
  image TEXT NOT NULL DEFAULT 'chadgpt/runner:3.11-node20-alpine',
  cpu INTEGER NOT NULL DEFAULT 2,
  memory_mb INTEGER NOT NULL DEFAULT 1024,
  disk_mb INTEGER NOT NULL DEFAULT 4096,
  region TEXT,
  status TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'stopped'
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  stopped_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_containers_user ON containers(user_id, status);

-- Per-message usage log for Claude-style daily + weekly limits.
-- One row per model call; we COUNT() over day_key / week_key to check budgets.
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  model_key TEXT NOT NULL,              -- 'fast', 'llama-70b', 'deepseek', etc.
  tier TEXT NOT NULL,                   -- 'free' | 'pro' | 'ultra'
  day_key TEXT NOT NULL,                -- 'YYYY-MM-DD' UTC
  week_key TEXT NOT NULL,               -- 'YYYY-Www'  ISO week UTC
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro INTEGER NOT NULL DEFAULT 0,-- cost in micro-USD (1 = $0.000001); avoids float drift
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily  ON usage_log(user_id, tier, day_key);
CREATE INDEX IF NOT EXISTS idx_usage_weekly ON usage_log(user_id, tier, week_key);
CREATE INDEX IF NOT EXISTS idx_usage_user   ON usage_log(user_id);

-- Hardware / device fingerprints — one row per (user, fingerprint) pair.
-- Lets us spot the same device signing up under many emails to dodge limits.
CREATE TABLE IF NOT EXISTS device_fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  fp_hash TEXT NOT NULL,                -- SHA-256 of client+server signals
  ip_hash TEXT,                         -- SHA-256 of last-seen IP (salted)
  ua_hash TEXT,                         -- SHA-256 of last-seen User-Agent
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_fp_user ON device_fingerprints(user_id);
CREATE INDEX IF NOT EXISTS idx_fp_hash ON device_fingerprints(fp_hash);

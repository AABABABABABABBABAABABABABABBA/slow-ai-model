-- ChadGPT users database (Cloudflare D1)
-- Apply with: npx wrangler d1 execute chadgpt-users --remote --file=db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- format: "pbkdf2$<iter>$<salt_b64>$<hash_b64>"
  plan TEXT NOT NULL DEFAULT 'free',    -- 'free' | 'plus'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  usage_score REAL NOT NULL DEFAULT 100,
  usage_last_at INTEGER NOT NULL DEFAULT 0
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

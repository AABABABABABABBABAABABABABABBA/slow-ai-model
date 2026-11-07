-- ChadCode license database schema (D1)
-- Apply with: npx wrangler d1 execute chadcode-license --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,                    -- lic_<hex>
  key_hash TEXT NOT NULL UNIQUE,          -- SHA-256 of raw key; raw key never stored
  plan TEXT NOT NULL DEFAULT 'pro',       -- 'pro' | 'team' | 'founder-grant'
  owner_email TEXT,
  max_devices INTEGER NOT NULL DEFAULT 2,
  transferable INTEGER NOT NULL DEFAULT 0,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER,                     -- NULL = perpetual
  revoked INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_licenses_owner ON licenses(owner_email);

CREATE TABLE IF NOT EXISTS license_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,              -- SHA-256 hex of hardware signals
  hostname TEXT,
  platform TEXT,                          -- darwin-arm64, linux-x64, win32-x64
  bound_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);
CREATE INDEX IF NOT EXISTS idx_devices_license ON license_devices(license_id);
CREATE INDEX IF NOT EXISTS idx_devices_fp      ON license_devices(fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices ON license_devices(license_id, fingerprint);

CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,                  -- 'stable' | 'beta' | 'nightly'
  version TEXT NOT NULL,                  -- semver
  platform TEXT NOT NULL,                 -- darwin-arm64, linux-x64, win32-x64
  url TEXT NOT NULL,                      -- download URL (R2, S3, or wherever)
  sha256 TEXT NOT NULL,                   -- hex of payload
  signature TEXT NOT NULL,                -- ed25519 signature of sha256
  published_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_releases_lookup ON releases(channel, platform, published_at DESC);

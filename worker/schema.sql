-- D1 schema of nuray-contact-api. Safe to run again (IF NOT EXISTS).
-- Run once:  npx wrangler d1 execute nuray-contact --remote --file=schema.sql   (in worker/)

-- A message waiting for the visitor's e-mail confirmation. The link token and the resend secret are stored only as SHA-256 digests.
-- One row per address. While a row is live, a new submission for that address leaves it untouched. `used` is 0, or the Unix time at which the message was claimed for delivery (claimed again only after 60 seconds if delivery never finished). Deleted when delivered; rows past expires_at are never read and
-- are purged (on submissions and hourly by cron). expires_at and last_sent are Unix seconds.
CREATE TABLE IF NOT EXISTS pending (
  token_hash  TEXT PRIMARY KEY,
  resend_hash TEXT NOT NULL UNIQUE,
  email_hash  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  message     TEXT NOT NULL,
  lang        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_sent   INTEGER NOT NULL,
  mails       INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pending_expires ON pending (expires_at);

-- Daily caps and per-address limits (keys hold digests only, never an address). A counter restarts once expires_at has passed.
CREATE TABLE IF NOT EXISTS counters (
  key        TEXT PRIMARY KEY,
  n          INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS counters_expires ON counters (expires_at);

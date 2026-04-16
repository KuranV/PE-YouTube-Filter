-- Individual reports, one row per (channel, IP) pair.
-- The unique index prevents the same IP from reporting the same channel twice.
CREATE TABLE IF NOT EXISTS reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_key     TEXT    NOT NULL,  -- channelId if known, else lower(channelName)
  channel_id      TEXT,
  channel_name    TEXT    NOT NULL,
  channel_url     TEXT    NOT NULL,
  suspected_owner TEXT    NOT NULL,
  source_url      TEXT,
  submitted_at    TEXT    NOT NULL,
  submitter_ip    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_dedup
  ON reports (channel_key, submitter_ip);

-- One row per unique channel, updated on each new report.
CREATE TABLE IF NOT EXISTS channels (
  channel_key     TEXT PRIMARY KEY,
  channel_id      TEXT,
  channel_name    TEXT NOT NULL,
  channel_url     TEXT NOT NULL,
  suspected_owner TEXT NOT NULL,
  source_url      TEXT,
  report_count    INTEGER NOT NULL DEFAULT 1,
  first_reported  TEXT    NOT NULL,
  last_reported   TEXT    NOT NULL,
  pr_created      INTEGER NOT NULL DEFAULT 0
);

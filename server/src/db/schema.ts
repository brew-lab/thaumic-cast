import type { Database } from 'bun:sqlite';

export function initSchema(db: Database): void {
  // Sonos accounts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sonos_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      household_id TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Streams table
  db.exec(`
    CREATE TABLE IF NOT EXISTS streams (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      household_id TEXT,
      group_id TEXT NOT NULL,
      quality TEXT NOT NULL CHECK (quality IN ('low', 'medium', 'high')),
      status TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'active', 'stopped', 'error')),
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sonos_accounts_user_id ON sonos_accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_streams_user_id ON streams(user_id);
    CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status);
  `);
}

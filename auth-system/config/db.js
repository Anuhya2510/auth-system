const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const dbPath = process.env.DB_PATH || './data/auth.db';
const localUrl = `file:${path.resolve(dbPath)}`;
const tursoDatabaseUrl = (process.env.TURSO_DATABASE_URL || process.env.TURSO_DB_URL || '').trim();
const tursoAuthToken = (process.env.TURSO_AUTH_TOKEN || process.env.TURSO_DB_AUTH_TOKEN || '').trim();
const databaseUrl = tursoDatabaseUrl || (!process.env.VERCEL ? localUrl : null);

if (process.env.VERCEL && (!tursoDatabaseUrl || !tursoAuthToken)) {
  throw new Error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Vercel Environment Variables');
}

if (!databaseUrl.startsWith('file:') && !tursoAuthToken) {
  throw new Error('Set TURSO_AUTH_TOKEN when using a remote database');
}

if (databaseUrl.startsWith('file:')) {
  fs.mkdirSync(path.dirname(databaseUrl.slice('file:'.length)), { recursive: true });
}

const db = createClient({
  url: databaseUrl,
  authToken: tursoAuthToken || undefined,
});

let initialization;

async function initDb() {
  if (!initialization) {
    initialization = db
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          email TEXT NOT NULL UNIQUE,
          mobile TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          is_email_verified INTEGER NOT NULL DEFAULT 0,
          is_mobile_verified INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
          `CREATE TABLE IF NOT EXISTS pending_signups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          mobile TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          email_verified INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
          `CREATE TABLE IF NOT EXISTS otps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'login')),
          code_hash TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          used INTEGER NOT NULL DEFAULT 0,
          last_sent_at TEXT NOT NULL DEFAULT (datetime('now')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
          `CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
          'CREATE INDEX IF NOT EXISTS idx_otps_email_purpose ON otps(email, purpose)',
          'CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON password_reset_tokens(user_id)',
        ].map((sql) => ({ sql })),
        'write'
      )
      .then(async () => {
        for (const [table, column, definition] of [
          ['users', 'is_mobile_verified', 'INTEGER NOT NULL DEFAULT 0'],
          ['pending_signups', 'email_verified', 'INTEGER NOT NULL DEFAULT 0'],
        ]) {
          const result = await db.execute(`PRAGMA table_info(${table})`);
          if (!result.rows.some((row) => row.name === column)) {
            await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
          }
        }
      })
      .catch((err) => {
        initialization = null;
        throw err;
      });
  }

  await initialization;
}

module.exports = { db, initDb };

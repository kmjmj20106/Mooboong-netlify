import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const defaultSettings = {
  personalWeeklyHours: 3, teamWeeklyHours: 6, maxContinuousHours: 3,
  advanceWeeks: 4, recurringUntil: '', blockSameDayCancellation: false,
};

export function openDatabase(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'mooboong.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      session TEXT NOT NULL DEFAULT '',
      generation TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      admin INTEGER NOT NULL DEFAULT 0 CHECK(admin IN (0,1)),
      must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      slot TEXT NOT NULL CHECK(slot IN ('vocal','guitar1','guitar2','bass','drums','keyboard')),
      member_id TEXT NOT NULL REFERENCES members(id),
      PRIMARY KEY (team_id,slot)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL REFERENCES members(id),
      team_id INTEGER REFERENCES teams(id),
      type TEXT NOT NULL CHECK(type IN ('personal','team')),
      date TEXT NOT NULL,
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK(end_min > start_min),
      CHECK((type='personal' AND team_id IS NULL) OR (type='team' AND team_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date,start_min,end_min);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      start_min INTEGER NOT NULL CHECK(start_min >= 480 AND start_min % 30 = 0),
      end_min INTEGER NOT NULL CHECK(end_min <= 1440 AND end_min % 30 = 0),
      created_by TEXT NOT NULL REFERENCES members(id),
      CHECK(end_min > start_min)
    );
    CREATE INDEX IF NOT EXISTS events_date ON events(date,start_min,end_min);
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('notice','wiki')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
      author_id TEXT NOT NULL REFERENCES members(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime TEXT NOT NULL, content BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wiki_assets (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      path TEXT NOT NULL, mime TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(post_id,path)
    );
  `);
  const migrate = (table, column, definition) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  migrate('bookings', 'created_by', 'TEXT REFERENCES members(id)');
  migrate('bookings', 'series_id', 'TEXT');
  migrate('bookings', 'recurrence_end', 'TEXT');
  migrate('posts', 'source_url', "TEXT NOT NULL DEFAULT ''");
  migrate('posts', 'document_html', "TEXT NOT NULL DEFAULT ''");
  migrate('posts', 'system_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS posts_system_key ON posts(system_key)');
  for (const [key, value] of Object.entries(defaultSettings)) {
    db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value));
  }
  return db;
}

export async function getSettings(db) {
  const settings = { ...defaultSettings };
  for (const { key, value } of (await db.prepare('SELECT key,value FROM settings').all())) {
    if (Object.hasOwn(defaultSettings, key)) settings[key] = JSON.parse(value);
  }
  return settings;
}

export async function audit(db, actorId, action, details = {}) {
  (await db.prepare('INSERT INTO audit_log(actor_id,action,details) VALUES (?,?,?)')
    .run(actorId ?? null, action, JSON.stringify(details)));
}

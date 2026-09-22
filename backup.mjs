import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, open, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.DATABASE_URL) throw new Error('Supabase 백업은 node transfer-data.mjs export 백업.json을 사용해 주세요.');

const root = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.env.DATA_DIR || resolve(root, 'data'), 'mooboong.sqlite');
const destination = resolve(process.argv[2] || resolve(root, 'backups', `mooboong-${new Date().toISOString().replaceAll(':', '-')}.sqlite`));
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
// Reserve a fresh path; never replace an existing backup or the active database.
const reserved = await open(destination, 'wx', 0o600);
await reserved.close();
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, destination); } finally { db.close(); }
await chmod(destination, 0o600);
const verify = new DatabaseSync(destination, { readOnly: true });
try {
  if (verify.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
} finally { verify.close(); }
console.log(`검증된 백업: ${destination}`);

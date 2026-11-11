const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// Resolve a relative DB_PATH against the repository root, not the current
// working directory. Otherwise the same .env would silently point at different
// files depending on where npm was started from (a Windows failure mode).
const DATA_DIR = process.env.DB_PATH
  ? path.dirname(path.resolve(__dirname, '..', '..', process.env.DB_PATH))
  : path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.DB_PATH
  ? path.resolve(__dirname, '..', '..', process.env.DB_PATH)
  : path.join(DATA_DIR, 'daybook.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function migrate() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  for (const f of files) {
    const applied = db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(f);
    if (!applied) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
      console.log(`[db] applied migration ${f}`);
    }
  }
}

function q(sql, params = []) {
  return db.prepare(sql).all(...params);
}
function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}
function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}
function logActivity(businessId, actorId, entityType, entityId, action, details = '') {
  run(
    'INSERT INTO activity_logs (business_id, actor_id, entity_type, entity_id, action, details) VALUES (?,?,?,?,?,?)',
    [businessId, actorId, entityType, entityId, action, details]
  );
}

module.exports = { db, migrate, q, get, run, logActivity, DB_PATH };

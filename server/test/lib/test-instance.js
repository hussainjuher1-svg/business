/**
 * Disposable Daybook instance for automated tests and validation harnesses.
 *
 * Every harness gets:
 *   - its own temporary SQLite database (never data/daybook.db),
 *   - freshly seeded demo data in that database,
 *   - its own API server on its own port,
 *   - deterministic teardown.
 *
 * Repeated runs therefore start from an identical state and cannot influence
 * each other, the developer's database, or a running preview server.
 */

const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SERVER_DIR = path.join(__dirname, '..', '..');

/** Temp directories created by this process, removed on exit. */
const created = [];

function cleanupAll() {
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
process.on('exit', cleanupAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanupAll(); process.exit(1); });
}

function seedDatabase(dbPath) {
  // seed.js and seed-hvac.js both run migrate() before writing.
  const env = { ...process.env, DB_PATH: dbPath, NODE_NO_WARNINGS: '1' };
  delete env.NODE_ENV; // seeding must never be blocked by a stray production env
  delete env.DAYBOOK_ALLOW_DEMO_SEED;
  for (const script of ['seed.js', 'seed-hvac.js']) {
    execFileSync(process.execPath, [path.join(SERVER_DIR, script)], { env, stdio: 'pipe' });
  }
}

/**
 * @param {{name: string, port: number, env?: object}} opts
 * @returns {Promise<{baseUrl: string, dbPath: string, dir: string, stop: Function, cleanup: Function}>}
 */
async function createInstance({ name, port, env = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `daybook-${name}-`));
  created.push(dir);
  const dbPath = path.join(dir, `${name}.db`);
  seedDatabase(dbPath);

  let child = null;
  let out = '';

  /** Wait until nothing is listening on the port, so a restart cannot race. */
  const waitForFreePort = async () => {
    const net = require('node:net');
    for (let i = 0; i < 60; i++) {
      const free = await new Promise((resolve) => {
        const probe = net.connect({ port, host: '127.0.0.1' });
        probe.once('connect', () => { probe.destroy(); resolve(false); });
        probe.once('error', () => { probe.destroy(); resolve(true); });
        probe.setTimeout(300, () => { probe.destroy(); resolve(true); });
      });
      if (free) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const start = async () => {
    await waitForFreePort();
    out = '';
    child = spawn(process.execPath, [path.join(SERVER_DIR, 'src', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: dbPath,
        NODE_NO_WARNINGS: '1',
        LOGIN_MAX_PER_IP: '100000',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server for ${name} did not start:\n${out.slice(0, 800)}`)), 30000);
      child.stdout.on('data', (d) => {
        out += d;
        if (out.includes('API listening')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on('data', (d) => { out += d; });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server for ${name} exited ${code}:\n${out.slice(0, 800)}`)); });
    });
  };

  await start();

  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    // Wait for the process to actually exit so the port is free for the next run.
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref();
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dbPath,
    dir,
    stop,
    start,
    cleanup: async () => {
      await stop();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      const i = created.indexOf(dir);
      if (i >= 0) created.splice(i, 1);
    },
  };
}

/**
 * Open the instance's database from *this* process.
 *
 * src/db.js binds its connection at require time, so a cached module would keep
 * pointing at whichever database was opened first. Clearing the cache makes the
 * handle follow DB_PATH.
 */
function openDatabase(dbPath) {
  process.env.DB_PATH = dbPath;
  const dbModule = path.join(SERVER_DIR, 'src', 'db.js');
  delete require.cache[require.resolve(dbModule)];
  return require(dbModule);
}

module.exports = { createInstance, seedDatabase, openDatabase };

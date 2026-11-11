/**
 * ISOLATED LOCAL HVAC DATASET — create a throwaway database for local testing.
 *
 * Creates a BRAND-NEW database file containing the fictional HVAC pilot data
 * (Northwind Heating & Air) and nothing else. It never opens, migrates, seeds
 * or overwrites data/daybook.db.
 *
 * Safety rules:
 *   - refuses to run if the target already exists (no overwrite, ever)
 *   - refuses to run against the configured development DB_PATH
 *   - refuses to run in production
 *
 * Usage:
 *   node server/prepare-hvac-dataset.js                 -> data/hvac-eval.db
 *   node server/prepare-hvac-dataset.js path/to/file.db -> that path
 *
 * Then point Daybook at it for a local session:
 *   PowerShell:  $env:DB_PATH="data/hvac-eval.db"; npm start
 *   cmd.exe:     set DB_PATH=data\hvac-eval.db && npm start
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_TARGET = path.join(ROOT, 'data', 'hvac-eval.db');

function resolveTarget(arg) {
  if (!arg) return DEFAULT_TARGET;
  return path.resolve(ROOT, arg);
}

function main() {
  const target = resolveTarget(process.argv[2]);

  // Never run in production.
  if (process.env.NODE_ENV === 'production') {
    console.error('[hvac-dataset] refused: NODE_ENV=production. Demo data must never be created in a production deployment.');
    process.exit(1);
  }

  // Never touch the configured development database.
  const configured = path.resolve(ROOT, process.env.DB_PATH || path.join('data', 'daybook.db'));
  const devDefault = path.resolve(ROOT, 'data', 'daybook.db');
  if (target === configured || target === devDefault) {
    console.error(`[hvac-dataset] refused: ${target} is a development database.`);
    console.error('Choose a separate file, e.g. node server/prepare-hvac-dataset.js data/hvac-eval.db');
    process.exit(1);
  }

  // Never overwrite an existing file.
  if (fs.existsSync(target)) {
    console.error(`[hvac-dataset] refused: ${target} already exists.`);
    console.error('Delete it yourself if you really mean to recreate it, or pick another path.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  console.log(`[hvac-dataset] creating a NEW isolated database: ${target}`);
  console.log('[hvac-dataset] the development database is not opened by this script.');

  const env = { ...process.env, DB_PATH: target, NODE_NO_WARNINGS: '1' };
  delete env.NODE_ENV;

  // seed.js first (migrates + creates the demo businesses the isolation checks
  // need), then seed-hvac.js for the Northwind pilot data.
  for (const script of ['seed.js', 'seed-hvac.js']) {
    console.log(`[hvac-dataset] running ${script}…`);
    execFileSync(process.execPath, [path.join(ROOT, 'server', script)], { env, stdio: 'inherit' });
  }

  console.log('');
  console.log(`[hvac-dataset] done. Fictional data only — no real customer or company data.`);
  console.log(`[hvac-dataset] database : ${target}`);
  console.log('[hvac-dataset] login    : hvac@daybook.local / demo1234  (password change forced on first use)');
  console.log('[hvac-dataset] run with : DB_PATH=' + path.relative(ROOT, target) + ' npm start');
}

main();

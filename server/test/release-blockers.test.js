/**
 * Release-blocker tests.
 *
 * Covers only the four blockers:
 *   1. login rate limiting
 *   2. demo accounts/credentials cannot enter production
 *   3. forced password change for retained demo accounts
 *   4. payment-terms knowledge vs. absent invoice/payment tracking
 *
 * Runs against a real HTTP server and a real seeded database.
 * Does NOT require Ollama: none of these paths touch the model.
 *
 * Run: node --test server/test/release-blockers.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-rb-'));
const DB_PATH = path.join(TMP_DIR, 'rb.db');

// CRITICAL: this process also requires ../src/db for direct assertions, so the
// env var must be set *before* that module is loaded. Without it the tests would
// read (and write!) the developer's real data/daybook.db.
process.env.DB_PATH = DB_PATH;
process.env.NODE_NO_WARNINGS = '1';

let server;
const jars = {};

function jar(name = 'anon') {
  if (!jars[name]) jars[name] = '';
  return {
    async call(method, p, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (jars[name]) headers.Cookie = jars[name];
      const res = await fetch(`${BASE}${p}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) jars[name] = sc.split(';')[0];
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      return { status: res.status, data, retryAfter: res.headers.get('retry-after') };
    },
    reset() { jars[name] = ''; },
  };
}

// The rate limiter counts failures twice: per account and per source address.
// Every test here runs from 127.0.0.1, so the per-IP bucket is raised out of the
// way by default; the tests that exercise it start their own server with a low
// LOGIN_MAX_PER_IP. This is test isolation, not a change to the shipped defaults.
const BASE_ENV = { LOGIN_MAX_PER_IP: '100000' };

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH,
        NODE_NO_WARNINGS: '1',
        OLLAMA_BASE_URL: 'http://127.0.0.1:59999',
        ...BASE_ENV,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout.on('data', (d) => { out += d; if (out.includes('API listening')) resolve(); });
    server.stderr.on('data', (d) => { out += d.toString(); });
    server.on('exit', (c) => reject(new Error(`server exited ${c}: ${out.slice(0, 800)}`)));
    setTimeout(() => reject(new Error(`start timeout: ${out.slice(0, 800)}`)), 20000);
  });
}

/**
 * Clear recorded attempts. The per-IP bucket is shared by every test because
 * they all come from 127.0.0.1, so the tests that measure that bucket must
 * start from zero rather than inheriting the previous test's failures.
 */
function resetAttempts() {
  const { run } = require('../src/db');
  run('DELETE FROM login_attempts');
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => resolve());
    server.kill();
  });
}

test.before(async () => {
  const env = { ...process.env, DB_PATH, NODE_NO_WARNINGS: '1' };
  // seed.js runs migrate() itself, so this is the whole setup.
  execFileSync(process.execPath, [path.join(__dirname, '..', 'seed.js')], { env });
  await startServer();

  // Demo account is forced to rotate, so clear the flag for tests that need a
  // normal session. The forced-change behaviour has its own dedicated tests.
  const { run } = require('../src/db');
  run("UPDATE users SET must_change_password = 0 WHERE email = 'demo@daybook.local'");
});

test.after(async () => {
  await stopServer();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// BLOCKER 1 — login rate limiting
// ---------------------------------------------------------------------------

test('rate limit: repeated bad passwords are blocked with 429', async () => {
  const c = jar('rl1');
  const email = 'ratelimit-target@daybook.local';
  let last;
  for (let i = 0; i < 6; i++) {
    last = await c.call('POST', '/api/auth/login', { email, password: `wrong-${i}` });
  }
  assert.strictEqual(last.status, 429, `expected 429 after repeated failures, got ${last.status}`);
  assert.match(last.data.error, /too many failed sign-in attempts/i);
  assert.ok(Number(last.retryAfter) > 0, 'Retry-After header should be present');
  assert.ok(last.data.retryAfterSeconds > 0, 'body should carry retryAfterSeconds');
});

test('rate limit: the correct password is still refused while locked out', async () => {
  const c = jar('rl2');
  const email = 'demo@daybook.local';
  // Burn the budget for a distinct email so we don't poison other tests.
  const target = 'lockout-test@daybook.local';
  for (let i = 0; i < 6; i++) await c.call('POST', '/api/auth/login', { email: target, password: 'nope' });
  const blocked = await c.call('POST', '/api/auth/login', { email: target, password: 'demo1234' });
  // The account does not exist, but the point is that the limiter answers, not the verifier.
  assert.strictEqual(blocked.status, 429, 'limiter must answer before password verification');
  assert.ok(email);
});

test('rate limit: one source spraying many accounts is blocked by the IP bucket', async () => {
  // Default shipped limits; this server is started with a small per-IP budget.
  await stopServer();
  resetAttempts();
  await startServer({ LOGIN_MAX_PER_IP: '3', LOGIN_MAX_PER_EMAIL: '100000' });
  try {
    const c = jar('ip1');
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const r = await c.call('POST', '/api/auth/login', {
        email: `spray-${i}-${Date.now()}@example.com`, password: 'guess',
      });
      statuses.push(r.status);
    }
    // The first failures reach the verifier (401); once the source exhausts its
    // budget every further attempt is refused without touching the password.
    assert.strictEqual(statuses[0], 401, `first attempt should reach the verifier, got ${statuses}`);
    assert.ok(statuses.filter((x) => x === 401).length >= 3, `budget of 3 should be allowed, got ${statuses}`);
    assert.strictEqual(statuses[statuses.length - 1], 429, `spraying must be blocked, got ${statuses}`);
  } finally {
    await stopServer();
    await startServer();
  }
});

test('rate limit: a spoofed X-Forwarded-For cannot evade the IP bucket', async () => {
  // Without a configured trusted proxy, the header must be ignored entirely,
  // otherwise the per-IP limit is trivially bypassed by a random header value.
  await stopServer();
  resetAttempts();
  await startServer({ LOGIN_MAX_PER_IP: '3', LOGIN_MAX_PER_EMAIL: '100000' });
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i + 1}` },
        body: JSON.stringify({ email: `spoof-${i}-${Date.now()}@example.com`, password: 'guess' }),
      });
      statuses.push(res.status);
      await res.text();
    }
    assert.strictEqual(statuses[0], 401, `first attempt should reach the verifier, got ${statuses}`);
    assert.strictEqual(statuses[statuses.length - 1], 429,
      `rotating a forged X-Forwarded-For must not reset the bucket, got ${statuses}`);
  } finally {
    await stopServer();
    await startServer();
  }
});

test('rate limit: a successful login clears the failure streak', async () => {
  // Use a fresh real account so the demo forced-change flow does not interfere.
  const c = jar('rl3');
  const email = `rl-${Date.now()}@example.com`;
  const reg = await c.call('POST', '/api/auth/register', {
    email, password: 'CorrectHorse42', name: 'RL User', businessName: 'RL Co',
  });
  assert.strictEqual(reg.status, 201);

  // Two failures, then a success.
  await c.call('POST', '/api/auth/login', { email, password: 'bad1' });
  await c.call('POST', '/api/auth/login', { email, password: 'bad2' });
  const ok = await c.call('POST', '/api/auth/login', { email, password: 'CorrectHorse42' });
  assert.strictEqual(ok.status, 200, 'correct password must work');

  // Streak is reset, so several more failures are needed to trip the limiter again.
  const after = await c.call('POST', '/api/auth/login', { email, password: 'bad3' });
  assert.strictEqual(after.status, 401, 'a single failure after success should be a plain 401');
});

test('rate limit: attempts persist across a server restart', async () => {
  const email = 'persist-lock@daybook.local';
  const c = jar('rl4');
  for (let i = 0; i < 6; i++) await c.call('POST', '/api/auth/login', { email, password: 'x' });
  const before = await c.call('POST', '/api/auth/login', { email, password: 'x' });
  assert.strictEqual(before.status, 429);

  await stopServer();
  await startServer();

  const after = await c.call('POST', '/api/auth/login', { email, password: 'x' });
  assert.strictEqual(after.status, 429, 'restart must not reset the limiter');
});

test('rate limit: a different account is unaffected by another account lockout', async () => {
  const c = jar('rl5');
  for (let i = 0; i < 6; i++) await c.call('POST', '/api/auth/login', { email: 'victim@daybook.local', password: 'x' });
  const other = await c.call('POST', '/api/auth/login', { email: `fresh-${Date.now()}@example.com`, password: 'x' });
  assert.strictEqual(other.status, 401, 'unrelated account should still reach the verifier (401, not 429)');
});

// ---------------------------------------------------------------------------
// BLOCKER 2 — demo credentials cannot enter production
// ---------------------------------------------------------------------------

test('production: seed.js refuses to run and writes no demo data', () => {
  const prodDb = path.join(TMP_DIR, 'prod-seed.db');
  let blocked = false;
  let stderr = '';
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'seed.js')], {
      env: { ...process.env, DB_PATH: prodDb, NODE_ENV: 'production', NODE_NO_WARNINGS: '1' },
      stdio: 'pipe',
    });
  } catch (err) {
    blocked = err.status !== 0;
    stderr = String(err.stderr || '');
  }
  assert.ok(blocked, 'seed.js must exit non-zero in production');
  assert.match(stderr, /refused to run|production/i, `stderr should explain: ${stderr}`);

  // Verify no demo users exist in that database.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(prodDb);
  let userRows = [];
  try {
    userRows = db.prepare('SELECT email FROM users').all();
  } catch {
    userRows = []; // table never created => nothing written
  }
  db.close();
  assert.strictEqual(userRows.length, 0, `no users should be created in production, found: ${JSON.stringify(userRows)}`);
});

test('production: seed-hvac.js refuses to run', () => {
  const prodDb = path.join(TMP_DIR, 'prod-hvac.db');
  let blocked = false;
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'seed-hvac.js')], {
      env: { ...process.env, DB_PATH: prodDb, NODE_ENV: 'production', NODE_NO_WARNINGS: '1' },
      stdio: 'pipe',
    });
  } catch (err) {
    blocked = err.status !== 0;
  }
  assert.ok(blocked, 'seed-hvac.js must exit non-zero in production');
});

test('demo accounts are flagged is_demo=1 by the seed', () => {
  const { q } = require('../src/db');
  const demo = q('SELECT email, is_demo FROM users WHERE is_demo = 1 ORDER BY email');
  assert.ok(demo.length >= 2, 'seeded demo accounts must be flagged');
  for (const u of demo) assert.strictEqual(u.is_demo, 1);
  const emails = demo.map((u) => u.email);
  assert.ok(emails.includes('demo@daybook.local'));
  assert.ok(emails.includes('rival@daybook.local'));
  const tech = q("SELECT is_demo FROM users WHERE email = 'tech@daybook.local'")[0];
  assert.strictEqual(tech.is_demo, 1, 'staff demo accounts must be flagged too');
});

test('a real account created by registration is NOT flagged as demo', async () => {
  const c = jar('real1');
  const email = `notdemo-${Date.now()}@example.com`;
  const res = await c.call('POST', '/api/auth/register', {
    email, password: 'GenuinePass99', name: 'Real', businessName: 'Real Co',
  });
  assert.strictEqual(res.status, 201);
  const { get } = require('../src/db');
  const row = get('SELECT is_demo, must_change_password FROM users WHERE email = ?', [email]);
  assert.strictEqual(row.is_demo, 0);
  assert.strictEqual(row.must_change_password, 0, 'real accounts must not be forced to change');
});

test('production startup warns loudly when demo accounts are present', async () => {
  await stopServer();
  let out = '';
  const prodServer = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'production', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prodServer.stdout.on('data', (d) => { out += d; });
  prodServer.stderr.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 2500));
  prodServer.kill();
  await new Promise((r) => setTimeout(r, 300));
  assert.match(out, /demo account\(s\) exist in a PRODUCTION/i, `expected a production warning, got: ${out.slice(0, 500)}`);

  await startServer();
});

// ---------------------------------------------------------------------------
// BLOCKER 3 — forced password change
// ---------------------------------------------------------------------------

test('forced change: a demo account still on the demo password is blocked from business data', async () => {
  const { run, get } = require('../src/db');
  // Simulate the real seeded state (the before() hook cleared it for convenience).
  run("UPDATE users SET must_change_password = 1 WHERE email = 'demo@daybook.local'");

  const c = jar('forced1');
  const login = await c.call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'demo1234' });
  assert.strictEqual(login.status, 200, 'login itself must succeed so the user can change the password');
  assert.strictEqual(login.data.user.mustChangePassword, true, 'login response must advertise the requirement');
  assert.strictEqual(login.data.user.isDemo, true);

  const blocked = await c.call('GET', '/api/dashboard');
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual(blocked.data.code, 'PASSWORD_CHANGE_REQUIRED');

  const blockedKnowledge = await c.call('GET', '/api/knowledge');
  assert.strictEqual(blockedKnowledge.status, 403, 'knowledge must also be gated');

  const blockedChat = await c.call('POST', '/api/assistant/chat', { message: 'hi' });
  assert.strictEqual(blockedChat.status, 403, 'assistant must also be gated');

  // /auth/me stays available so the UI can discover the requirement.
  const me = await c.call('GET', '/api/auth/me');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.data.user.mustChangePassword, true);

  const unchanged = get("SELECT must_change_password FROM users WHERE email = 'demo@daybook.local'");
  assert.strictEqual(unchanged.must_change_password, 1, 'gate must not clear itself');
});

test('forced change: weak or shared-password choices are rejected', async () => {
  const c = jar('forced2');
  await c.call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'demo1234' });

  const cases = ['demo1234', '12345678', 'password123', 'short1', 'aaaaaaaaaaaa', 'onlylowercase'];
  for (const pw of cases) {
    const res = await c.call('POST', '/api/auth/change-password', {
      currentPassword: 'demo1234', newPassword: pw,
    });
    assert.strictEqual(res.status, 400, `"${pw}" must be rejected, got ${res.status}`);
  }
});

test('forced change: wrong current password is rejected', async () => {
  const c = jar('forced3');
  await c.call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'demo1234' });
  const res = await c.call('POST', '/api/auth/change-password', {
    currentPassword: 'not-the-password', newPassword: 'BrandNewPass123',
  });
  assert.strictEqual(res.status, 401);
});

test('forced change: a valid new password clears the gate and unlocks the app', async () => {
  const c = jar('forced4');
  const login = await c.call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'demo1234' });
  assert.strictEqual(login.data.user.mustChangePassword, true);

  const changed = await c.call('POST', '/api/auth/change-password', {
    currentPassword: 'demo1234', newPassword: 'Xk7-quiet-meadow-92',
  });
  assert.strictEqual(changed.status, 200, JSON.stringify(changed.data));

  const dash = await c.call('GET', '/api/dashboard');
  assert.strictEqual(dash.status, 200, 'dashboard must unlock after the change');

  const me = await c.call('GET', '/api/auth/me');
  assert.strictEqual(me.data.user.mustChangePassword, false);

  // The old published password must no longer work.
  const fresh = jar('forced5');
  const old = await fresh.call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'demo1234' });
  assert.strictEqual(old.status, 401, 'the published demo password must stop working');

  const good = await fresh.call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'Xk7-quiet-meadow-92' });
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.data.user.mustChangePassword, false);
});

test('forced change: the change revokes other sessions', async () => {
  const { run } = require('../src/db');
  run("UPDATE users SET must_change_password = 1 WHERE email = 'rival@daybook.local'");

  const sessionA = jar('sessA');
  const sessionB = jar('sessB');
  await sessionA.call('POST', '/api/auth/login', { email: 'rival@daybook.local', password: 'demo1234' });
  await sessionB.call('POST', '/api/auth/login', { email: 'rival@daybook.local', password: 'demo1234' });

  const changed = await sessionA.call('POST', '/api/auth/change-password', {
    currentPassword: 'demo1234', newPassword: 'Rival-new-pass-77',
  });
  assert.strictEqual(changed.status, 200);

  const b = await sessionB.call('GET', '/api/auth/me');
  assert.strictEqual(b.status, 401, "the other session's token must be revoked");
});

test('forced change: boot-time enforcement flags any demo account still on demo1234', () => {
  const { run, get } = require('../src/db');
  run("UPDATE users SET must_change_password = 0, password_hash = ? WHERE email = 'tech@daybook.local'", [
    require('../src/auth').hashPassword('demo1234'),
  ]);
  const demoGuard = require('../src/demo-guard');
  const result = demoGuard.enforceDemoPasswordRotation();
  assert.ok(result.forced >= 1, 'boot enforcement should force a change');
  assert.strictEqual(get("SELECT must_change_password FROM users WHERE email = 'tech@daybook.local'").must_change_password, 1);
});

// ---------------------------------------------------------------------------
// BLOCKER 4 — payment terms vs. no invoice/payment tracking
// ---------------------------------------------------------------------------

test('payment: the assistant states it does not track invoices or payments', async () => {
  const c = jar('pay1');
  const email = `pay-${Date.now()}@example.com`;
  await c.call('POST', '/api/auth/register', { email, password: 'PaymentTest42', name: 'P', businessName: 'Pay Co' });

  // Seed a payment-terms knowledge entry so the "terms" half is answerable.
  await c.call('POST', '/api/knowledge', {
    category: 'policy', title: 'Payment terms',
    content: 'Invoices are due within 14 days. Late payments incur a 2 percent monthly charge.',
  });

  const status = await c.call('POST', '/api/assistant/chat', { message: 'Which customers have unpaid invoices?' });
  assert.strictEqual(status.status, 200, JSON.stringify(status.data).slice(0, 200));
  const answer = String(status.data?.answer || '');
  assert.match(answer, /does not (track|record)|not create invoices|cannot tell you who has paid/i,
    `must disclaim payment tracking, got: ${answer.slice(0, 300)}`);
  // The disclaimer must be the answer, not an appendix to a dump of customer records.
  assert.strictEqual(status.data.mode, 'out-of-scope', 'payment-status questions must not be answered from live records');
  assert.deepStrictEqual(status.data.sources, [], 'no records may be cited as evidence of payment state');
  assert.ok(!/\b(R\d+)\]/.test(answer), `must not dump records: ${answer.slice(0, 200)}`);
});

test('payment: terms questions are answered from knowledge without inventing settlement data', async () => {
  // Terms questions are about what the business WROTE DOWN, so they must not be
  // swept into the "we do not track payments" refusal.
  const { isPaymentTermsOnly } = require('../src/ai/assistant');
  assert.strictEqual(isPaymentTermsOnly('What are our payment terms?'), true);
  assert.strictEqual(isPaymentTermsOnly('When must invoices be paid?'), true);
  assert.strictEqual(isPaymentTermsOnly('Which invoices are unpaid?'), false,
    'a settlement question must not be treated as a terms question');

  const c = jar('pay2');
  const email = `terms-${Date.now()}@example.com`;
  await c.call('POST', '/api/auth/register', { email, password: 'PaymentTest42', name: 'T', businessName: 'Terms Co' });
  await c.call('POST', '/api/knowledge', {
    category: 'policy', title: 'Payment terms',
    content: 'Invoices are due within 14 days. Late payments incur a 2 percent monthly charge.',
  });

  const res = await c.call('POST', '/api/assistant/chat', { message: 'What are our payment terms?' });
  assert.strictEqual(res.status, 200);
  const answer = String(res.data?.answer || '');
  assert.ok(answer.length > 20, `expected a real answer, got ${answer.slice(0, 120)}`);
  assert.ok(!/outstanding balance of|has paid \d|owes \d/i.test(answer), 'must not invent settlement figures');
  assert.notStrictEqual(res.data.mode, 'out-of-scope', 'terms questions are in scope');
  // The stored terms must be reachable as evidence (retrieved chunk or cited source).
  assert.match(JSON.stringify(res.data), /14 days/i,
    'the stored payment terms must be used as evidence');
});

test('payment: no invoice or payment tables exist in the schema', () => {
  const { q } = require('../src/db');
  const tables = q("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name.toLowerCase());
  const forbidden = tables.filter((t) => /invoice|payment(?!_method)|receipt|ledger|balance/.test(t));
  assert.deepStrictEqual(forbidden, [], `schema must not imply invoice tracking: found ${forbidden.join(', ')}`);
});

test('payment: the assistant module never claims to record payments', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai', 'assistant.js'), 'utf8');
  // The exact capability boundary must be present.
  assert.match(src, /does not create invoices/i);
  assert.match(src, /does not[\s\S]{0,40}record payments/i);
});

test('payment: a payment-status question never returns fabricated figures', async () => {
  const c = jar('pay3');
  await c.call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'Xk7-quiet-meadow-92' });
  const res = await c.call('POST', '/api/assistant/chat', { message: 'How much money do we have outstanding from unpaid invoices?' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.data).slice(0, 200));
  const answer = String(res.data?.answer || '');
  assert.match(answer, /does not track|not create invoices|cannot tell you/i,
    `must disclaim, got: ${answer.slice(0, 300)}`);
  // No money figure may appear at all: Daybook holds none, so any number is invented.
  const moneyLike = (answer.match(/\b\d{2,6}\b/g) || []).filter((n) => Number(n) >= 50);
  assert.deepStrictEqual(moneyLike, [], `fabricated figure(s) ${moneyLike.join(', ')} in: ${answer.slice(0, 300)}`);
});

test('payment: the wording is shared, not duplicated ad hoc', () => {
  const engine = require('../src/ai/assistant');
  // Both the refusal path and the no-evidence path must use the same sentence,
  // so the capability boundary cannot drift between two code paths.
  assert.match(engine.PAYMENT_ANSWER, /does not track invoices or payments/i);
  assert.match(engine.PAYMENT_TERMS_NOTE, /does not create invoices/i);
  // The client must not promise invoice tracking either.
  const settings = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'Settings.tsx'), 'utf8');
  assert.match(settings, /does not (create|track)[\s\S]{0,60}invoice/i,
    'the payment-method settings screen must state the limit too');
});

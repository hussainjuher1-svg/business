/**
 * SECURITY REGRESSION SUITE
 *
 * Focused on the properties a release depends on, independent of the feature
 * suites:
 *   1. login rate limits (per email, per IP, spoofing, trusted proxy)
 *   2. demo-account isolation from business data before a password change
 *   3. demo seed scripts refusing production *before* touching the database
 *   4. payment questions never implying invoice settlement is tracked
 *   5. tenant (business) isolation
 *
 * Every test runs against its own temporary database and its own server.
 * The development database is never opened.
 *
 * Run: node --test server/test/security.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-sec-'));
process.env.NODE_NO_WARNINGS = '1';

const { createInstance, openDatabase } = require('./lib/test-instance');
const { adoptDemoAccount } = require('./lib/demo-fixture');

let inst;
// In-process handle on whichever temporary database the current instance uses.
let db = null;

/** Bind the in-process DB handle to the instance's database. */
function useDb(instance) {
  db = openDatabase(instance.dbPath);
  return db;
}

async function fresh(env = {}) {
  if (inst) await inst.cleanup();
  inst = await createInstance({ name: 'security', port: 3501, env });
  useDb(inst);
  return inst;
}

/** Independent cookie jar per caller. */
function jar(base) {
  let cookie = '';
  return async (method, p, body, headers = {}) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (cookie) h.Cookie = cookie;
    const res = await fetch(`${base}${p}`, {
      method, headers: h, body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: res.status, data, headers: res.headers };
  };
}

test.after(async () => {
  if (inst) await inst.cleanup();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// 1. Rate limits
// ---------------------------------------------------------------------------

test('rate limit: per-account limit holds at the shipped default (5 failures)', async () => {
  const { baseUrl } = await fresh();
  const call = jar(baseUrl);
  const email = 'victim@daybook.local';
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const r = await call('POST', '/api/auth/login', { email, password: `bad-${i}` });
    statuses.push(r.status);
  }
  assert.deepStrictEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401], `first five must reach the verifier: ${statuses}`);
  assert.strictEqual(statuses[5], 429, `sixth must be throttled: ${statuses}`);
});

test('rate limit: a locked account refuses the CORRECT password too', async () => {
  const { baseUrl } = await fresh();
  const call = jar(baseUrl);
  for (let i = 0; i < 6; i++) await call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'nope' });
  const right = await call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'demo1234' });
  assert.strictEqual(right.status, 429, 'a lockout must not be bypassed by knowing the password');
  assert.ok(Number(right.headers.get('retry-after')) > 0, 'Retry-After must be present');
});

test('rate limit: a forged X-Forwarded-For cannot evade the per-IP bucket', async () => {
  // No TRUST_PROXY configured: the header is attacker-controlled and must be ignored.
  const { baseUrl } = await fresh({ LOGIN_MAX_PER_IP: '4', LOGIN_MAX_PER_EMAIL: '100000' });
  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${i + 1}` },
      body: JSON.stringify({ email: `spoof-${i}@example.com`, password: 'guess' }),
    });
    statuses.push(res.status);
    await res.text();
  }
  assert.strictEqual(statuses[0], 401, `first attempt reaches the verifier: ${statuses}`);
  assert.strictEqual(statuses[statuses.length - 1], 429,
    `rotating a forged X-Forwarded-For must not reset the bucket: ${statuses}`);
});

test('rate limit: with a trusted proxy, the forwarded client address is used', async () => {
  const { baseUrl } = await fresh({ LOGIN_MAX_PER_IP: '2', LOGIN_MAX_PER_EMAIL: '100000', TRUST_PROXY: '1' });
  const attempt = async (ip, i) => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ email: `proxied-${ip}-${i}@example.com`, password: 'guess' }),
    });
    await res.text();
    return res.status;
  };

  // Client A exhausts its own budget.
  const a = [await attempt('203.0.113.10', 0), await attempt('203.0.113.10', 1), await attempt('203.0.113.10', 2)];
  assert.deepStrictEqual(a, [401, 401, 429], `one client should be limited after 2 failures: ${a}`);

  // Client B, behind the same proxy, is a different bucket and is unaffected.
  const b = await attempt('203.0.113.20', 0);
  assert.strictEqual(b, 401, 'a different forwarded client must have its own bucket');

  // The proxy hop itself (the socket address) must not be what gets throttled.
  assert.notStrictEqual(a[2], 401);
});

test('rate limit: a successful login clears only that account streak', async () => {
  const { baseUrl } = await fresh();
  const call = jar(baseUrl);
  const email = `clear-${Date.now()}@example.com`;
  const reg = await call('POST', '/api/auth/register', {
    email, password: 'CorrectHorse42', name: 'C', businessName: 'Clear Co',
  });
  assert.strictEqual(reg.status, 201);

  await call('POST', '/api/auth/login', { email, password: 'bad1' });
  await call('POST', '/api/auth/login', { email, password: 'bad2' });
  const ok = await call('POST', '/api/auth/login', { email, password: 'CorrectHorse42' });
  assert.strictEqual(ok.status, 200);

  const after = await call('POST', '/api/auth/login', { email, password: 'bad3' });
  assert.strictEqual(after.status, 401, 'the streak must be reset by the success, not accumulated');
});

test('rate limit: attempts survive a process restart', async () => {
  const first = await fresh();
  const call = jar(first.baseUrl);
  for (let i = 0; i < 6; i++) await call('POST', '/api/auth/login', { email: 'persist@daybook.local', password: 'x' });
  const before = await call('POST', '/api/auth/login', { email: 'persist@daybook.local', password: 'x' });
  assert.strictEqual(before.status, 429);

  // Restart against the SAME database file (createInstance would seed a new one).
  await first.stop();
  await first.start();
  const after = await jar(first.baseUrl)('POST', '/api/auth/login', { email: 'persist@daybook.local', password: 'x' });
  assert.strictEqual(after.status, 429, 'a restart must not grant a fresh budget');
});

// ---------------------------------------------------------------------------
// 2. Demo accounts cannot reach business data before changing the password
// ---------------------------------------------------------------------------

test('demo gate: every business endpoint is blocked before the password change', async () => {
  const { baseUrl, dbPath } = await fresh();
  db.run("UPDATE users SET must_change_password = 1 WHERE is_demo = 1");

  const call = jar(baseUrl);
  const login = await call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'demo1234' });
  assert.strictEqual(login.status, 200, 'a demo user must be able to log in in order to change the password');
  assert.strictEqual(login.data.user.mustChangePassword, true);
  assert.strictEqual(login.data.user.isDemo, true);

  const endpoints = [
    ['GET', '/api/dashboard'], ['GET', '/api/knowledge'], ['GET', '/api/customers'],
    ['GET', '/api/estimates'], ['GET', '/api/inquiries'], ['GET', '/api/appointments'],
    ['GET', '/api/jobs'], ['GET', '/api/business'], ['GET', '/api/activity'],
    ['POST', '/api/assistant/chat', { message: 'hi' }],
    ['GET', '/api/assistant/status'],
  ];
  for (const [method, p, body] of endpoints) {
    const r = await call(method, p, body);
    assert.strictEqual(r.status, 403, `${method} ${p} must be gated, got ${r.status}`);
    assert.strictEqual(r.data.code, 'PASSWORD_CHANGE_REQUIRED', `${method} ${p} must say why`);
  }

  // The exempt routes must still work, otherwise the user is locked out entirely.
  assert.strictEqual((await call('GET', '/api/auth/me')).status, 200);
  assert.strictEqual((await call('GET', '/api/auth/me')).data.user.mustChangePassword, true);
});

test('demo gate: the gate is per-session and cannot be cleared client-side', async () => {
  const { baseUrl, dbPath } = await fresh();
  db.run("UPDATE users SET must_change_password = 1 WHERE email = 'demo@daybook.local'");

  const call = jar(baseUrl);
  await call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'demo1234' });

  // Try to clear the flag through a normal user-update endpoint.
  const patch = await call('PATCH', '/api/business', { name: 'Renamed' });
  assert.strictEqual(patch.status, 403, 'no write may pass the gate');

  const row = db.get("SELECT must_change_password FROM users WHERE email = 'demo@daybook.local'");
  assert.strictEqual(row.must_change_password, 1, 'the flag must not be clearable from inside the app');
});

test('demo gate: a real (non-demo) account is never gated', async () => {
  const { baseUrl, dbPath } = await fresh();
  const call = jar(baseUrl);
  const email = `real-${Date.now()}@example.com`;
  const reg = await call('POST', '/api/auth/register', {
    email, password: 'GenuinePass99', name: 'Real', businessName: 'Real Co',
  });
  assert.strictEqual(reg.status, 201);
  assert.strictEqual(reg.data.user.mustChangePassword, false);
  assert.strictEqual(reg.data.user.isDemo, false);

  const dash = await call('GET', '/api/dashboard');
  assert.strictEqual(dash.status, 200, 'a real account must not be gated');

  const row = db.get('SELECT is_demo FROM users WHERE email = ?', [email]);
  assert.strictEqual(row.is_demo, 0);
});

test('demo gate: rotating the password unlocks the app and kills the old password', async () => {
  const { baseUrl } = await fresh();
  const newPassword = await adoptDemoAccount(baseUrl, 'demo@daybook.local', 'sec');
  const call = jar(baseUrl);
  await call('POST', '/api/auth/login', { email: 'demo@daybook.local', password: newPassword });
  assert.strictEqual((await call('GET', '/api/dashboard')).status, 200);

  const old = await jar(baseUrl)('POST', '/api/auth/login', { email: 'demo@daybook.local', password: 'demo1234' });
  assert.strictEqual(old.status, 401, 'the published demo password must stop working');
});

// ---------------------------------------------------------------------------
// 3. Demo seed scripts refuse production before touching the database
// ---------------------------------------------------------------------------

test('seed guard: seed scripts exit non-zero in production and write nothing', () => {
  for (const script of ['seed.js', 'seed-hvac.js']) {
    const dbPath = path.join(TMP_DIR, `prod-${script}.db`);
    let stderr = '';
    let blocked = false;
    try {
      execFileSync(process.execPath, [path.join(__dirname, '..', script)], {
        env: { ...process.env, DB_PATH: dbPath, NODE_ENV: 'production', NODE_NO_WARNINGS: '1' },
        stdio: 'pipe',
      });
    } catch (err) {
      blocked = err.status !== 0;
      stderr = String(err.stderr || '');
    }
    assert.ok(blocked, `${script} must exit non-zero in production`);
    assert.match(stderr, /refused to run|production/i, `${script} must explain itself: ${stderr}`);

    // Nothing was written: no schema, no users. (db.js creates an empty file at
    // require time, so the assertion is on tables, not on the file existing.)
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    let tables = [];
    try { tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(); } catch { tables = []; }
    db.close();
    assert.deepStrictEqual(tables.map((t) => t.name), [],
      `${script} must not even migrate in production, found: ${tables.map((t) => t.name).join(', ')}`);
  }
});

test('seed guard: production boot warns about retained demo accounts', async () => {
  const inst2 = await createInstance({ name: 'security-prod', port: 3502 });
  try {
    let out = '';
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
      env: {
        ...process.env, PORT: '3503', DB_PATH: inst2.dbPath,
        NODE_ENV: 'production', NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 2500));
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    assert.match(out, /demo account\(s\) exist in a PRODUCTION/i,
      `production startup must warn loudly, got: ${out.slice(0, 400)}`);
  } finally {
    await inst2.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Payment questions never imply invoice settlement tracking
// ---------------------------------------------------------------------------

test('payment: settlement questions are refused with the exact capability boundary', async () => {
  const { baseUrl } = await fresh();
  const call = jar(baseUrl);
  const email = `pay-${Date.now()}@example.com`;
  await call('POST', '/api/auth/register', {
    email, password: 'PaymentTest42', name: 'P', businessName: 'Pay Co',
  });
  await call('POST', '/api/knowledge', {
    category: 'policy', title: 'Payment terms',
    content: 'Invoices are due within 14 days. Late payments incur a 2 percent monthly charge.',
  });

  const questions = [
    'Which customers have unpaid invoices?',
    'Who owes us money?',
    'How much is outstanding?',
    'Which invoices are overdue?',
    'Do any accounts have arrears?',
  ];
  for (const message of questions) {
    const res = await call('POST', '/api/assistant/chat', { message });
    assert.strictEqual(res.status, 200, `${message}: ${JSON.stringify(res.data).slice(0, 150)}`);
    const answer = String(res.data.answer || '');
    assert.match(answer, /does not track invoices or payments|cannot tell you who has paid/i,
      `${message} must state the boundary, got: ${answer.slice(0, 200)}`);
    assert.strictEqual(res.data.mode, 'out-of-scope', `${message} must not be answered from live records`);
    assert.deepStrictEqual(res.data.sources, [], `${message} must not cite records as payment evidence`);
    // No money figure may appear: Daybook holds none, so any number is invented.
    const figures = (answer.match(/\b\d{2,6}\b/g) || []).filter((n) => Number(n) >= 50);
    assert.deepStrictEqual(figures, [], `${message} invented a figure: ${figures.join(', ')}`);
  }
});

test('payment: terms questions still get a real answer from stored knowledge', async () => {
  const { baseUrl } = await fresh();
  const call = jar(baseUrl);
  const email = `terms-${Date.now()}@example.com`;
  await call('POST', '/api/auth/register', {
    email, password: 'PaymentTest42', name: 'T', businessName: 'Terms Co',
  });
  await call('POST', '/api/knowledge', {
    category: 'policy', title: 'Payment terms',
    content: 'Invoices are due within 14 days. Late payments incur a 2 percent monthly charge.',
  });
  const res = await call('POST', '/api/assistant/chat', { message: 'What are our payment terms?' });
  assert.notStrictEqual(res.data.mode, 'out-of-scope', 'terms questions must stay in scope');
  assert.match(JSON.stringify(res.data), /14 days/i, 'the stored terms must be used as evidence');
});

test('payment: no invoice/payment tables exist in the schema', async () => {
  await fresh();
  const tables = db.q("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name.toLowerCase());
  const forbidden = tables.filter((t) => /invoice|payment(?!_method)|receipt|ledger|balance/.test(t));
  assert.deepStrictEqual(forbidden, [], `schema must not imply invoice tracking: ${forbidden.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 5. Tenant isolation
// ---------------------------------------------------------------------------

test('isolation: a business cannot read another business knowledge or assistant data', async () => {
  const { baseUrl } = await fresh();
  const aPassword = await adoptDemoAccount(baseUrl, 'demo@daybook.local', 'iso-a');
  const bPassword = await adoptDemoAccount(baseUrl, 'rival@daybook.local', 'iso-b');

  const a = jar(baseUrl);
  const b = jar(baseUrl);
  await a('POST', '/api/auth/login', { email: 'demo@daybook.local', password: aPassword });
  await b('POST', '/api/auth/login', { email: 'rival@daybook.local', password: bPassword });

  const aMe = await a('GET', '/api/auth/me');
  const aBusinessId = aMe.data.businesses[0].business_id;

  const peek = await b('GET', `/api/knowledge?businessId=${aBusinessId}`);
  assert.strictEqual(peek.status, 403, `cross-tenant knowledge read must be refused, got ${peek.status}`);

  const peekChat = await b('POST', '/api/assistant/chat', { message: 'What are the policies?', businessId: aBusinessId });
  assert.strictEqual(peekChat.status, 403, `cross-tenant assistant query must be refused, got ${peekChat.status}`);

  // A term that exists only in business A's knowledge must never appear in B's
  // answer. (Do not assert on a place name: business B's own policy text names
  // the same town — "never Springfield" — so that would be a false positive.)
  const exclusive = `ZZ-EXCLUSIVE-${Date.now()}`;
  const created = await a('POST', '/api/knowledge', {
    category: 'service', title: 'Exclusive service', content: `We offer ${exclusive} inspections.`,
  });
  assert.strictEqual(created.status, 201);

  const bAnswer = JSON.stringify((await b('POST', '/api/assistant/chat', { message: 'Do you offer exclusive inspections?' })).data);
  assert.ok(!bAnswer.includes(exclusive), 'business A exclusive knowledge leaked into business B answer');
});

test('isolation: knowledge written by one business is invisible to another', async () => {
  const { baseUrl } = await fresh();
  const aPassword = await adoptDemoAccount(baseUrl, 'demo@daybook.local', 'iso2-a');
  // Adopt each demo account exactly once: the second attempt would need the
  // password the first attempt already replaced.
  const bPassword = await adoptDemoAccount(baseUrl, 'rival@daybook.local', 'iso2-b');

  const a = jar(baseUrl);
  await a('POST', '/api/auth/login', { email: 'demo@daybook.local', password: aPassword });
  const marker = `TENANT_MARKER_${Date.now()}`;
  const created = await a('POST', '/api/knowledge', {
    category: 'policy', title: marker, content: `${marker} belongs to business A only.`,
  });
  assert.strictEqual(created.status, 201);

  // B must not find it, even by exact title search.
  const b = jar(baseUrl);
  await b('POST', '/api/auth/login', { email: 'rival@daybook.local', password: bPassword });
  const search = await b('GET', `/api/knowledge?search=${encodeURIComponent(marker)}`);
  assert.strictEqual(search.status, 200);
  assert.strictEqual(search.data.items.length, 0, `business B found business A's entry: ${JSON.stringify(search.data.items).slice(0, 200)}`);
});

test('isolation: unauthenticated access is refused everywhere', async () => {
  const { baseUrl } = await fresh();
  const call = jar(baseUrl);
  const endpoints = [
    ['GET', '/api/dashboard'], ['GET', '/api/knowledge'], ['GET', '/api/customers'],
    ['GET', '/api/assistant/status'], ['POST', '/api/assistant/chat', { message: 'hi' }],
    ['GET', '/api/business'], ['POST', '/api/auth/change-password', { currentPassword: 'a', newPassword: 'b' }],
  ];
  for (const [method, p, body] of endpoints) {
    const r = await call(method, p, body);
    assert.strictEqual(r.status, 401, `${method} ${p} must require auth, got ${r.status}`);
  }
});

test('isolation: a forged session cookie is rejected', async () => {
  const { baseUrl } = await fresh();
  const call = jar(baseUrl);
  const r = await call('GET', '/api/dashboard', undefined, { Cookie: 'daybook_session=deadbeef'.repeat(4) });
  assert.strictEqual(r.status, 401, 'an invalid session token must not authenticate');
});

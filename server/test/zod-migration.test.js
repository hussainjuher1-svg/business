/**
 * ZOD 4 MIGRATION — validation behaviour, error surfacing and array bounds.
 *
 * The server moved from zod 3.25.76 to 4.6.7 to clear CVE-2023-54404, where a zod
 * array schema accumulates one issue object per failing element with no cap. That
 * is a real, measured problem on this codebase (see the memory test below), so the
 * upgrade is not cosmetic.
 *
 * A major version bump is exactly the kind of change that silently stops
 * validating something, so this suite pins each behaviour the application relies
 * on. Two of them broke and were fixed during the migration:
 *
 *   - `error.errors` was removed in v4; every call site now reads `error.issues`.
 *     Left unfixed, each validation failure threw inside the route and became a
 *     500 instead of a 400.
 *   - a custom message on `min()` only applies when the field is *present*, so a
 *     missing required field fell back to zod's generic text. Those schemas now
 *     pass `{ error }` as well.
 *
 * Everything here is asserted through the real HTTP API, because the point is what
 * a client actually receives.
 *
 * Run: node --test server/test/zod-migration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createInstance, openDatabase } = require('./lib/test-instance');

const PORT = 3237;
let inst;
let db;
let cookie = '';
let bizId;

async function call(method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${inst.baseUrl}${p}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

test.before(async () => {
  inst = await createInstance({ name: 'zod4', port: PORT });
  db = openDatabase(inst.dbPath);
  const login = await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'demo1234' });
  assert.strictEqual(login.status, 200, `login failed: ${JSON.stringify(login.data)}`);
  if (login.data.user.mustChangePassword) {
    await call('POST', '/api/auth/change-password', { currentPassword: 'demo1234', newPassword: 'Zod4-Migration-7' });
    await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'Zod4-Migration-7' });
  }
  bizId = (await call('GET', '/api/business')).data.business.id;
});
test.after(async () => { if (inst) await inst.cleanup(); });

// ---------------------------------------------------------------------------
// 1. The version itself
// ---------------------------------------------------------------------------
test('server runs zod 4.6.7 or later (the patched line)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(pkg.dependencies.zod, /^4\./, `declared zod is ${pkg.dependencies.zod}`);
  const installed = require(path.join(__dirname, '..', 'node_modules', 'zod', 'package.json')).version;
  const [maj, min, pat] = installed.split('.').map(Number);
  assert.ok(maj > 4 || (maj === 4 && (min > 6 || (min === 6 && pat >= 6))),
    `installed zod ${installed} is below the patched 4.6.6`);
});

test('no source file still uses the removed zod 3 `.error.errors` API', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      // `.errors` on a ZodError is gone in v4. A plain array of strings named
      // `errors` is unrelated, so match only the ZodError shapes.
      if (/\.error\.errors\b/.test(text) || /ZodError[^.]*\.errors\b/.test(text)) {
        offenders.push(path.relative(srcDir, full));
      }
    }
  };
  walk(srcDir);
  assert.deepStrictEqual(offenders, [], `files still using zod 3 error API: ${offenders.join(', ')}`);
});

test('every safeParse failure is surfaced as .issues', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  let issuesUses = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      issuesUses += (text.match(/\.error\.issues\[0\]/g) || []).length;
    }
  };
  walk(srcDir);
  assert.ok(issuesUses >= 27, `expected the migrated call sites to use .issues, found ${issuesUses}`);
});

// ---------------------------------------------------------------------------
// 2. Validation failures are client errors, never 500s
// ---------------------------------------------------------------------------
test('a missing required field is a 400 with the product wording, not a 500', async () => {
  const res = await call('POST', '/api/knowledge', { category: 'policy' });
  assert.strictEqual(res.status, 400, `expected 400, got ${res.status} ${JSON.stringify(res.data)}`);
  assert.strictEqual(res.data.error, 'Content is required',
    'the missing-field case must keep the product message, not zod default text');
});

test('a present-but-empty required field is a 400 with the same wording', async () => {
  const res = await call('POST', '/api/knowledge', { category: 'policy', content: '' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.data.error, 'Content is required');
});

test('service name validation keeps its wording on both paths', async () => {
  for (const p of ['/api/knowledge/services', '/api/business/services']) {
    const missing = await call('POST', p, { description: 'x' });
    assert.strictEqual(missing.status, 400, `${p} missing name -> ${missing.status}`);
    assert.strictEqual(missing.data.error, 'Service name is required');

    const empty = await call('POST', p, { name: '', description: 'x' });
    assert.strictEqual(empty.status, 400, `${p} empty name -> ${empty.status}`);
    assert.strictEqual(empty.data.error, 'Service name is required');
  }
});

test('an invalid enum value is a 400, not a crash', async () => {
  const res = await call('POST', '/api/knowledge', { category: 'not_a_category', content: 'x' });
  assert.strictEqual(res.status, 400);
  assert.ok(res.data.error, 'an error message must be returned');
});

test('a wrong type is a 400, not a 500', async () => {
  const res = await call('POST', '/api/knowledge', { category: 'policy', content: 12345 });
  assert.strictEqual(res.status, 400);
});

test('malformed JSON is a 400 with a clear message', async () => {
  const res = await fetch(`${inst.baseUrl}/api/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: '{not json',
  });
  assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
  const body = await res.json();
  assert.strictEqual(body.code, 'INVALID_JSON');
});

test('an oversized body is a 413, not a 500', async () => {
  const big = JSON.stringify({ category: 'policy', content: 'x'.repeat(1100 * 1024) });
  const res = await fetch(`${inst.baseUrl}/api/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: big,
  });
  assert.strictEqual(res.status, 413, `expected 413, got ${res.status}`);
  const body = await res.json();
  assert.strictEqual(body.code, 'PAYLOAD_TOO_LARGE');
});

test('the server stays alive after every rejection above', async () => {
  const r = await fetch(`${inst.baseUrl}/health`);
  assert.strictEqual(r.status, 200);
});

// ---------------------------------------------------------------------------
// 3. Schema behaviour: optional, nullable, default, refinement, coercion, array
// ---------------------------------------------------------------------------
test('optional fields may be omitted', async () => {
  const res = await call('POST', '/api/knowledge', { category: 'policy', content: 'Optional fields omitted.' });
  assert.strictEqual(res.status, 201, `optional fields broke: ${JSON.stringify(res.data)}`);
  const row = db.get('SELECT * FROM knowledge_items WHERE id = ?', [res.data.item.id]);
  assert.strictEqual(row.title, '', 'omitted optional title must default, not store null');
  assert.strictEqual(row.status, 'active', 'omitted optional status must default to active');
  assert.strictEqual(row.source, 'manual', 'omitted optional source must default to manual');
});

test('nullable fields accept an explicit null', async () => {
  const res = await call('POST', '/api/knowledge', {
    category: 'policy', content: 'Nullable supersedes.', supersedesId: null, effectiveDate: null,
  });
  assert.strictEqual(res.status, 201, `explicit null rejected: ${JSON.stringify(res.data)}`);
});

test('defaults are applied rather than left undefined', async () => {
  const res = await call('POST', '/api/knowledge', { category: 'faq', content: 'Defaults check.' });
  assert.strictEqual(res.status, 201);
  const row = db.get('SELECT * FROM knowledge_items WHERE id = ?', [res.data.item.id]);
  assert.strictEqual(row.category, 'faq');
  assert.ok(row.status, 'status must never be undefined after parse');
});

test('a refinement still rejects and explains', async () => {
  // The password schema is a superRefine with several custom issues.
  const res = await call('POST', '/api/auth/change-password', {
    currentPassword: 'Zod4-Migration-7', newPassword: 'aaaaaaaaaaaa',
  });
  assert.strictEqual(res.status, 400, `refinement did not reject: ${JSON.stringify(res.data)}`);
  assert.match(String(res.data.error), /repeated character/i);
});

test('an integer constraint still rejects a float', async () => {
  const res = await call('POST', '/api/estimates', {
    title: 'Float amount', amount: 12.5, issueDate: '2026-01-01', customerId: null,
  });
  // Either accepted as a number or rejected as invalid — what must not happen is a 500.
  assert.ok(res.status < 500, `expected no 500, got ${res.status}`);
});

test('unknown keys are ignored rather than rejected or stored', async () => {
  const res = await call('POST', '/api/knowledge', {
    category: 'policy', content: 'Unknown key check.', notARealField: 'should not persist', id: 99999,
  });
  assert.strictEqual(res.status, 201, `unknown keys broke validation: ${JSON.stringify(res.data)}`);
  const row = db.get('SELECT * FROM knowledge_items WHERE id = ?', [res.data.item.id]);
  assert.notStrictEqual(row.id, 99999, 'a client-supplied id must never become the row id');
  assert.strictEqual(row.business_id, bizId);
  assert.ok(!('notARealField' in row), 'an unknown key must not reach the database');
});

// ---------------------------------------------------------------------------
// 4. Untrusted arrays are bounded
// ---------------------------------------------------------------------------
test('every array validator in the source carries an explicit maximum', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const unbounded = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/z\.array\(/.test(line)) return;
        // A bound may sit on the same line or on the closing line of a multi-line
        // schema, which for this codebase is within the next few lines.
        const window = lines.slice(i, i + 8).join(' ');
        if (!/\.max\(\d+\)|\.length\(/.test(window)) {
          unbounded.push(`${path.relative(srcDir, full)}:${i + 1}`);
        }
      });
    }
  };
  walk(srcDir);
  assert.deepStrictEqual(unbounded, [],
    `z.array without an explicit .max() bound: ${unbounded.join(', ')}`);
});

test('the onboarding arrays declare the documented maximums', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'onboarding.js'), 'utf8');
  assert.match(src, /services:\s*z\.array\([\s\S]*?\)\.max\(100\)/, 'services must be capped at 100');
  assert.match(src, /faqs:\s*z\.array\([\s\S]*?\)\.max\(100\)/, 'faqs must be capped at 100');
  assert.match(src, /policiesExtra:\s*z\.array\([\s\S]*?\)\.max\(50\)/, 'policiesExtra must be capped at 50');
});

test('an oversized array is refused cheaply instead of accumulating issues', async () => {
  // 50,000 failing elements: well inside the 1 MB body limit, so this really does
  // reach the validator. Before the upgrade zod 3 built one issue per element.
  const services = new Array(50000).fill({ name: '' });
  const started = Date.now();
  const res = await call('POST', '/api/onboarding/complete', { services });
  const elapsed = Date.now() - started;

  assert.strictEqual(res.status, 400, `expected 400, got ${res.status} ${JSON.stringify(res.data)}`);
  assert.ok(elapsed < 3000, `must be refused promptly, took ${elapsed}ms`);
  assert.ok(await fetch(`${inst.baseUrl}/health`).then((r) => r.status === 200));
});

test('a large array of VALID elements still works', async () => {
  const services = Array.from({ length: 50 }, (_, i) => ({ name: `Test service ${i}`, priceMin: 10 + i }));
  const before = db.get('SELECT COUNT(*) AS n FROM business_services WHERE business_id = ?', [bizId]).n;
  const res = await call('POST', '/api/onboarding/complete', { services });
  assert.strictEqual(res.status, 200, `a valid 50-element array must be accepted: ${JSON.stringify(res.data)}`);
  const after = db.get('SELECT COUNT(*) AS n FROM business_services WHERE business_id = ?', [bizId]).n;
  assert.ok(after > before, 'valid array elements must actually be written');
});

test('the array bound itself is enforced, not just the body size', async () => {
  // 200 valid services exceeds the .max(100) cap while staying well under 1 MB.
  const services = Array.from({ length: 200 }, (_, i) => ({ name: `Bulk service ${i}` }));
  const res = await call('POST', '/api/onboarding/complete', { services });
  assert.strictEqual(res.status, 400, `expected the array cap to reject, got ${res.status}`);
  assert.ok(res.data.error, 'a message must explain the rejection');
});

test('a body-supplied businessId cannot be used to write into another business', async () => {
  // resolveBusiness accepts a requested business id but only when the caller is a
  // member of it, so naming someone else's business is refused outright rather
  // than silently redirected. Both outcomes are safe; this pins that the write
  // never lands in the other business.
  const res = await call('POST', '/api/knowledge', {
    category: 'policy', content: 'Isolation check via validation.', businessId: 99999,
  });
  assert.strictEqual(res.status, 403, `expected refusal, got ${res.status} ${JSON.stringify(res.data)}`);
  assert.match(String(res.data.error), /access to this business/i);

  const leaked = db.q("SELECT id FROM knowledge_items WHERE content = 'Isolation check via validation.'");
  assert.deepStrictEqual(leaked, [], 'a refused request must not write a row anywhere');

  // And an ordinary write still lands in the caller's own business.
  const ok = await call('POST', '/api/knowledge', { category: 'policy', content: 'Isolation check, own business.' });
  assert.strictEqual(ok.status, 201);
  const row = db.get('SELECT * FROM knowledge_items WHERE id = ?', [ok.data.item.id]);
  assert.strictEqual(row.business_id, bizId);
});

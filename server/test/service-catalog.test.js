/**
 * SERVICE CATALOG — one canonical management path.
 *
 * There were two ways to manage services:
 *   - POST /api/business/services  (name + description only)
 *   - POST /api/knowledge/services (name, description, pricing, duration)
 * Both wrote the same `business_services` table, so a service created through
 * Business Settings silently lost its pricing and never entered the knowledge
 * index. These tests pin the fix: one implementation, reachable from both
 * addresses, with no loss of fields.
 *
 * The legacy addresses are kept on purpose so existing clients keep working.
 *
 * Run: node --test server/test/service-catalog.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createInstance, openDatabase } = require('./lib/test-instance');

const PORT = 3235;
let inst;
let db;
let cookie = '';
let bizId;

async function call(method, p, body, wantRaw) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${inst.baseUrl}${p}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  if (wantRaw) return res;
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data, headers: res.headers };
}

async function services() {
  const res = await call('GET', '/api/knowledge/services');
  assert.strictEqual(res.status, 200);
  return res.data.services;
}

test.before(async () => {
  inst = await createInstance({ name: 'services', port: PORT });
  db = openDatabase(inst.dbPath);
  const login = await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'demo1234' });
  assert.strictEqual(login.status, 200, `login failed: ${JSON.stringify(login.data)}`);
  if (login.data.user.mustChangePassword) {
    await call('POST', '/api/auth/change-password', { currentPassword: 'demo1234', newPassword: 'Service-Test-11' });
    await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'Service-Test-11' });
  }
  bizId = (await call('GET', '/api/business')).data.business.id;
});
test.after(async () => { if (inst) await inst.cleanup(); });

test('a service created on the legacy path keeps its pricing', async () => {
  const created = await call('POST', '/api/business/services', {
    name: 'Water heater flush', description: 'Flush and inspect',
    priceMin: 129, priceMax: 189, priceNote: 'plus parts', durationMinutes: 60,
  });
  assert.strictEqual(created.status, 201, `create failed: ${JSON.stringify(created.data)}`);
  assert.strictEqual(created.data.price_min, 129, 'pricing must survive the legacy path');
  assert.strictEqual(created.data.price_max, 189);
  assert.strictEqual(created.data.price_note, 'plus parts');
  assert.strictEqual(created.data.duration_minutes, 60);
});

test('both addresses return the same rows', async () => {
  const canonical = await services();
  const legacy = await call('GET', '/api/business/services');
  assert.strictEqual(legacy.status, 200);
  const canonicalIds = canonical.map((s) => s.id).sort((a, b) => a - b);
  const legacyIds = legacy.data.services.map((s) => s.id).sort((a, b) => a - b);
  assert.deepStrictEqual(legacyIds, canonicalIds, 'the two listings must not diverge');
});

test('a service created on one path is editable from the other', async () => {
  const created = await call('POST', '/api/knowledge/services', {
    name: 'Cross path edit', description: 'x', priceMin: 50,
  });
  assert.strictEqual(created.status, 201);

  const patched = await call('PATCH', `/api/business/services/${created.data.id}`, { priceMax: 95 });
  assert.strictEqual(patched.status, 200, `patch failed: ${JSON.stringify(patched.data)}`);
  assert.strictEqual(patched.data.price_max, 95);
  assert.strictEqual(patched.data.price_min, 50, 'an untouched field must not be wiped');

  const row = db.get('SELECT * FROM business_services WHERE id = ?', [created.data.id]);
  assert.strictEqual(row.price_max, 95);
  assert.strictEqual(row.price_min, 50);
});

test('the legacy path is marked deprecated but still works', async () => {
  const res = await call('GET', '/api/business/services', undefined, true);
  assert.strictEqual(res.status, 200, 'existing clients must not break');
  assert.strictEqual(res.headers.get('deprecation'), 'true');
  assert.match(String(res.headers.get('link') || ''), /\/api\/knowledge\/services/,
    'the response must name the canonical replacement');
});

test('deleting on either path removes the row and cannot cross businesses', async () => {
  const created = await call('POST', '/api/knowledge/services', { name: 'Disposable', priceMin: 1 });
  assert.strictEqual(created.status, 201);
  const del = await call('DELETE', `/api/business/services/${created.data.id}`);
  assert.strictEqual(del.status, 200);
  assert.ok(!(await services()).some((s) => s.id === created.data.id), 'the service must be gone');

  // A service belonging to another business must not be deletable.
  const other = db.get('SELECT * FROM business_services WHERE business_id != ? LIMIT 1', [bizId]);
  if (other) {
    await call('DELETE', `/api/business/services/${other.id}`);
    const stillThere = db.get('SELECT * FROM business_services WHERE id = ?', [other.id]);
    assert.ok(stillThere, `service ${other.id} from another business must not be deleted`);
  }
});

test('existing services are not disturbed by the consolidation', async () => {
  const rows = await services();
  assert.ok(rows.length >= 1, 'seed services must still be present');
  for (const s of rows) assert.strictEqual(s.business_id, bizId);
  // Nothing lost its name while the paths were merged.
  for (const s of rows) assert.ok(s.name && s.name.length > 0, `service ${s.id} lost its name`);
});

test('validation is shared, so a nameless service is rejected on both paths', async () => {
  for (const path of ['/api/business/services', '/api/knowledge/services']) {
    const res = await call('POST', path, { description: 'no name' });
    assert.strictEqual(res.status, 400, `${path} must reject a service with no name`);
  }
});

/**
 * KNOWLEDGE SEARCH — normalised multi-term matching.
 *
 * The old implementation was a raw case-insensitive `includes()` on
 * "title + content", which failed whenever the owner's phrasing did not appear
 * contiguously. These tests pin the replacement's contract through the real HTTP
 * API, against a real isolated database.
 *
 * Covered: case, hyphens/punctuation, multi-word phrases, term-in-title vs
 * term-in-content, empty search, and business isolation.
 *
 * Run: node --test server/test/knowledge-search.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createInstance } = require('./lib/test-instance');

const PORT = 3233;
let inst;
let cookie = '';

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

/** Titles returned by the list endpoint for a search term. */
async function search(q) {
  const res = await call('GET', `/api/knowledge?search=${encodeURIComponent(q)}`);
  assert.strictEqual(res.status, 200, `search failed: ${JSON.stringify(res.data)}`);
  return (res.data.items || []).map((i) => i.title);
}

test.before(async () => {
  inst = await createInstance({ name: 'kbsearch', port: PORT });
  const login = await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'demo1234' });
  assert.strictEqual(login.status, 200, `login failed: ${JSON.stringify(login.data)}`);
  if (login.data.user.mustChangePassword) {
    await call('POST', '/api/auth/change-password', { currentPassword: 'demo1234', newPassword: 'Search-Test-42' });
    await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'Search-Test-42' });
  }

  // Fixtures chosen to exercise each rule.
  const items = [
    ['service', 'Heat pump service', 'We service air-source heat pumps, including refrigerant. Seasonal tune up available.'],
    ['pricing', 'Diagnostic pricing', 'The diagnostic fee is 89 USD and is waived if the repair is approved.'],
    ['policy', 'Cancellation & rescheduling', 'Cancellations need 24 hours notice or a 75 USD fee applies.'],
    ['faq', 'Do you offer financing?', 'Financing is available on installations over 3000 USD.'],
    ['warranty', 'Workmanship warranty', 'Labour is warranted for 12 months on repairs.'],
  ];
  for (const [category, title, content] of items) {
    const r = await call('POST', '/api/knowledge', { category, title, content });
    assert.ok(r.status === 200 || r.status === 201, `seed item failed: ${JSON.stringify(r.data)}`);
  }
});
test.after(async () => { if (inst) await inst.cleanup(); });

// ---------------------------------------------------------------------------
test('case-insensitive search', async () => {
  for (const q of ['warranty', 'WARRANTY', 'WaRrAnTy']) {
    const titles = await search(q);
    assert.ok(titles.includes('Workmanship warranty'), `"${q}" should match, got ${JSON.stringify(titles)}`);
  }
});

test('hyphens and punctuation do not have to match exactly', async () => {
  // Stored as "tune up", searched with a hyphen.
  assert.ok((await search('tune-up')).includes('Heat pump service'),
    '"tune-up" must match stored "tune up"');
  // Stored with an ampersand, searched without.
  assert.ok((await search('cancellation rescheduling')).includes('Cancellation & rescheduling'),
    'an ampersand in stored text must not block a plain-word search');
  // Question marks and commas in the query are ignored.
  assert.ok((await search('financing?')).includes('Do you offer financing?'),
    'trailing punctuation in the query must be ignored');
});

test('multi-word phrases match across the field, not as a contiguous string', async () => {
  // This exact case failed before: the phrase never appears verbatim.
  assert.ok((await search('heat pump tune-up')).includes('Heat pump service'),
    'terms may be spread across title and content');
  // Plural in the query, singular in the document.
  assert.ok((await search('diagnostic fees')).includes('Diagnostic pricing'),
    'a plural query term must match the singular stored term');
});

test('a term may appear in the title or the content', async () => {
  // "warranty" is in the TITLE of the entry.
  assert.ok((await search('workmanship')).includes('Workmanship warranty'),
    'title terms must match');
  // "waived" appears only in the CONTENT.
  assert.ok((await search('waived')).includes('Diagnostic pricing'),
    'content-only terms must match');
});

test('an empty search returns everything, not nothing', async () => {
  const all = await search('');
  assert.ok(all.length >= 5, `empty search must not filter anything, got ${all.length}`);
  // An all-stopword query behaves the same way rather than matching nothing.
  const stop = await search('the and of');
  assert.strictEqual(stop.length, all.length, 'a query with no meaningful terms must not filter');
});

test('a term that appears nowhere returns an empty list', async () => {
  assert.deepStrictEqual(await search('zebra unstoppable nonsense'), [],
    'non-matching search must return nothing, not everything');
});

test('search composes with the category filter', async () => {
  const res = await call('GET', '/api/knowledge?search=fee&category=pricing');
  assert.strictEqual(res.status, 200);
  const items = res.data.items || [];
  assert.ok(items.length >= 1, 'expected at least one pricing hit');
  assert.ok(items.every((i) => i.category === 'pricing'),
    `category filter must still apply, got ${JSON.stringify(items.map((i) => i.category))}`);
});

test('business isolation: another business cannot search these entries', async () => {
  // Log in as the second demo business and search for a distinctive term.
  const rival = await fetch(`${inst.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rival@daybook.local', password: 'demo1234' }),
  });
  assert.strictEqual(rival.status, 200, 'rival login failed');
  let rivalCookie = String(rival.headers.get('set-cookie') || '').split(';')[0];
  const rivalBody = await rival.json();
  if (rivalBody.user?.mustChangePassword) {
    await fetch(`${inst.baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: rivalCookie },
      body: JSON.stringify({ currentPassword: 'demo1234', newPassword: 'Rival-Search-42' }),
    });
    const again = await fetch(`${inst.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'rival@daybook.local', password: 'Rival-Search-42' }),
    });
    rivalCookie = String(again.headers.get('set-cookie') || '').split(';')[0];
  }

  for (const q of ['workmanship', 'waived', 'tune-up']) {
    const res = await fetch(`${inst.baseUrl}/api/knowledge?search=${encodeURIComponent(q)}`, {
      headers: { Cookie: rivalCookie },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const titles = (body.items || []).map((i) => i.title);
    assert.ok(!titles.includes('Workmanship warranty'),
      `business B must not see business A's entries for "${q}", got ${JSON.stringify(titles)}`);
    assert.ok(!titles.includes('Diagnostic pricing'), `business B must not see business A pricing for "${q}"`);
  }
});

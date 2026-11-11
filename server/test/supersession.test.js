/**
 * P0 — SUPERSEDED KNOWLEDGE MUST NEVER BE CITED AS CURRENT FACT.
 *
 * A business owner edits their warranty. The old entry stays in the database for
 * audit, but the assistant must not present it as current. These tests pin that
 * behaviour at the retrieval layer, which is the layer that feeds:
 *   - the model prompt (when a model exists), and
 *   - evidence-only answers (when it does not).
 *
 * They also pin the rules that are easy to get wrong:
 *   - a chain A <- B <- C leaves only C current;
 *   - archiving the replacement must NOT revive the policy it replaced;
 *   - superseded rows are retained, not deleted;
 *   - the filter applies with zero embeddings *and* with embeddings present;
 *   - it never crosses a business boundary.
 *
 * Every test uses its own temporary database. data/daybook.db is never opened.
 *
 * Run: node --test server/test/supersession.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createInstance, openDatabase } = require('./lib/test-instance');

const PORT = 3231;

/** Load retrieval against a specific database (module cache follows DB_PATH). */
function loadRetrieval(dbPath) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(path.join('server', 'src'))) delete require.cache[key];
  }
  process.env.DB_PATH = dbPath;
  require(path.join(__dirname, '..', 'src', 'db.js'));
  return require(path.join(__dirname, '..', 'src', 'ai', 'retrieval.js'));
}

let inst;
let db;
test.before(async () => {
  inst = await createInstance({ name: 'supersession', port: PORT });
  db = openDatabase(inst.dbPath);
});
test.after(async () => { if (inst) await inst.cleanup(); });

/** Insert an item directly, so the test controls ids and ordering exactly. */
function addItem(businessId, { category, title, content, supersedesId = null, status = 'active' }) {
  const info = db.run(
    `INSERT INTO knowledge_items (business_id, category, title, content, source, source_detail, status, supersedes_id)
     VALUES (?,?,?,?,'manual','test',?,?)`,
    [businessId, category, title, content, status, supersedesId]
  );
  return Number(info.lastInsertRowid);
}

async function index(retrieval, businessId, id) {
  const item = db.get('SELECT * FROM knowledge_items WHERE id = ?', [id]);
  // skipEmbeddings keeps these tests deterministic and independent of Ollama.
  return retrieval.reindexItem(item, { skipEmbeddings: true });
}

/** Titles returned for a query, most relevant first. */
async function titles(retrieval, businessId, query) {
  const res = await retrieval.searchKnowledge({ businessId, query, limit: 8, minScore: 0 });
  return res.hits.filter((h) => h.sourceType === 'item').map((h) => h.title);
}

// ---------------------------------------------------------------------------
// 1. Old and new warranty versions
// ---------------------------------------------------------------------------
test('superseded warranty is never returned as evidence', async () => {
  const retrieval = loadRetrieval(inst.dbPath);
  const biz = db.get('SELECT id FROM businesses ORDER BY id LIMIT 1').id;

  const oldId = addItem(biz, {
    category: 'warranty', title: 'Warranty (old)',
    content: 'OUTDATED: labour is warranted for 90 days and parts for 12 months.',
  });
  const newId = addItem(biz, {
    category: 'warranty', title: 'Warranty (current)',
    content: 'CURRENT: labour is warranted for 12 months on repairs and 24 months on new installations.',
    supersedesId: oldId,
  });
  await index(retrieval, biz, oldId);
  await index(retrieval, biz, newId);

  const found = await titles(retrieval, biz, 'how long is the labour warranty');
  assert.ok(found.includes('Warranty (current)'), `current entry must be returned, got ${JSON.stringify(found)}`);
  assert.ok(!found.includes('Warranty (old)'),
    `the superseded entry must never be returned as evidence, got ${JSON.stringify(found)}`);

  // The ordering bug from validation: the old one used to rank first.
  const res = await retrieval.searchKnowledge({ businessId: biz, query: 'warranty terms', limit: 8, minScore: 0 });
  const itemHits = res.hits.filter((h) => h.sourceType === 'item');
  assert.notStrictEqual(itemHits[0]?.title, 'Warranty (old)',
    'a superseded entry must never rank first');

  // But the row and its content are retained for audit.
  const row = db.get('SELECT * FROM knowledge_items WHERE id = ?', [oldId]);
  assert.ok(row, 'the superseded row must still exist');
  assert.match(row.content, /90 days/, 'the original text must be preserved');
  const chunks = db.get("SELECT COUNT(*) n FROM knowledge_chunks WHERE source_type='item' AND source_id=?", [oldId]);
  assert.ok(chunks.n > 0, 'superseded content stays indexed for audit, it is only filtered from current fact');
});

test('supersededItemIds reports exactly the replaced items', () => {
  const retrieval = loadRetrieval(inst.dbPath);
  const biz = db.get('SELECT id FROM businesses ORDER BY id LIMIT 1').id;
  const a = addItem(biz, { category: 'faq', title: 'Replace me', content: 'old faq text' });
  const b = addItem(biz, { category: 'faq', title: 'Replacement', content: 'new faq text', supersedesId: a });
  const ids = retrieval.supersededItemIds(biz);
  assert.ok(ids.has(a), 'the replaced item is superseded');
  assert.ok(!ids.has(b), 'the replacement is current');
  assert.strictEqual(retrieval.supersededByMap(biz).get(a), b, 'the replacement is reported as the superseder');
});

// ---------------------------------------------------------------------------
// 2. Multi-level supersession chains
// ---------------------------------------------------------------------------
test('a multi-level chain leaves only the newest entry current', async () => {
  const retrieval = loadRetrieval(inst.dbPath);
  const biz = db.get('SELECT id FROM businesses ORDER BY id LIMIT 1').id;

  const v1 = addItem(biz, { category: 'policy', title: 'Return policy v1', content: 'Return window is 7 days.' });
  const v2 = addItem(biz, { category: 'policy', title: 'Return policy v2', content: 'Return window is 14 days.', supersedesId: v1 });
  const v3 = addItem(biz, { category: 'policy', title: 'Return policy v3', content: 'Return window is 30 days.', supersedesId: v2 });
  for (const id of [v1, v2, v3]) await index(retrieval, biz, id);

  const ids = retrieval.supersededItemIds(biz);
  assert.ok(ids.has(v1) && ids.has(v2), 'both earlier versions are superseded');
  assert.ok(!ids.has(v3), 'only the newest is current');

  const found = await titles(retrieval, biz, 'what is the return window policy');
  assert.ok(found.includes('Return policy v3'), `newest must be returned, got ${JSON.stringify(found)}`);
  assert.ok(!found.includes('Return policy v1'), 'v1 must not surface');
  assert.ok(!found.includes('Return policy v2'), 'v2 must not surface either');

  // All three rows survive for audit.
  const rows = db.q('SELECT id FROM knowledge_items WHERE id IN (?,?,?)', [v1, v2, v3]);
  assert.strictEqual(rows.length, 3, 'no version may be deleted');
});

// ---------------------------------------------------------------------------
// 3. Retrieval with zero embeddings
// ---------------------------------------------------------------------------
test('the rule holds with zero embeddings (full-text only)', async () => {
  const retrieval = loadRetrieval(inst.dbPath);
  const biz = db.get('SELECT id FROM businesses ORDER BY id LIMIT 1').id;
  const before = db.get('SELECT COUNT(*) n FROM knowledge_embeddings WHERE business_id = ?', [biz]).n;

  const res = await retrieval.searchKnowledge({ businessId: biz, query: 'return window policy', limit: 8 });
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM knowledge_embeddings WHERE business_id = ?', [biz]).n, before,
    'this test must not add embeddings');
  const itemTitles = res.hits.filter((h) => h.sourceType === 'item').map((h) => h.title);
  assert.ok(!itemTitles.some((t) => /v1|v2/.test(t)),
    `no superseded version may appear without embeddings, got ${JSON.stringify(itemTitles)}`);
});

// ---------------------------------------------------------------------------
// 4. Retrieval with embeddings
// ---------------------------------------------------------------------------
test('the rule holds when a vector pass is active', async () => {
  const retrieval = loadRetrieval(inst.dbPath);
  const biz = db.get('SELECT id FROM businesses ORDER BY id LIMIT 1').id;

  // Build a chain that is ONLY reachable through the vector path: its wording
  // shares no stem with the query.
  const oldId = addItem(biz, {
    category: 'service_area', title: 'Coverage v1',
    content: 'We travel to Northgate and Westmere only.',
  });
  const newId = addItem(biz, {
    category: 'service_area', title: 'Coverage v2',
    content: 'We travel to Northgate, Westmere and Coldwater.',
    supersedesId: oldId,
  });
  await index(retrieval, biz, oldId);
  await index(retrieval, biz, newId);

  // Hand-write comparable vectors as if an embedding model had produced them.
  // Both chunks get a near-identical vector, so cosine similarity alone would
  // rank the superseded one alongside the current one.
  const model = 'test-embed-model';
  const chunkFor = (id) => db.get(
    "SELECT id FROM knowledge_chunks WHERE source_type='item' AND source_id=? LIMIT 1", [id]).id;
  const writeVec = (chunkId, values) => db.run(
    `INSERT INTO knowledge_embeddings (chunk_id, business_id, model, dim, vector, updated_at)
     VALUES (?,?,?,?,?, datetime('now'))
     ON CONFLICT(chunk_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vector=excluded.vector`,
    [chunkId, biz, model, values.length, Buffer.from(new Float32Array(values).buffer)]
  );
  writeVec(chunkFor(oldId), [0.9, 0.1, 0.1]);
  writeVec(chunkFor(newId), [0.9, 0.1, 0.1]);

  // Stub the embedding client so the vector pass runs without Ollama.
  const ollamaPath = require.resolve(path.join(__dirname, '..', 'src', 'ai', 'ollama.js'));
  const real = require(ollamaPath);
  const stub = {
    ...real,
    embed: async () => ({
      vectors: [Float32Array.from([0.9, 0.1, 0.1]).buffer ? [0.9, 0.1, 0.1] : [0.9, 0.1, 0.1]],
      model,
      requestedModel: model,
      modelSource: 'reported-by-ollama',
      modelMatchesRequest: true,
      dim: 3,
    }),
  };
  require.cache[ollamaPath].exports = stub;

  // Reload retrieval so it picks up the stubbed client.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(path.join('server', 'src', 'ai', 'retrieval.js'))) delete require.cache[key];
  }
  const r2 = require(path.join(__dirname, '..', 'src', 'ai', 'retrieval.js'));

  const res = await r2.searchKnowledge({ businessId: biz, query: 'do you cover Coldwater', limit: 8, minScore: 0 });
  assert.strictEqual(res.usedEmbeddings, true, 'the vector pass must actually have run');
  const itemTitles = res.hits.filter((h) => h.sourceType === 'item').map((h) => h.title);
  assert.ok(itemTitles.includes('Coverage v2'), `current entry must be returned, got ${JSON.stringify(itemTitles)}`);
  assert.ok(!itemTitles.includes('Coverage v1'),
    `a near-identical superseded vector must still be filtered, got ${JSON.stringify(itemTitles)}`);

  // restore
  require.cache[ollamaPath].exports = real;
});

// ---------------------------------------------------------------------------
// 5. Business isolation
// ---------------------------------------------------------------------------
test('supersession in one business cannot hide another business\'s current entry', async () => {
  const retrieval = loadRetrieval(inst.dbPath);
  const businesses = db.q('SELECT id FROM businesses ORDER BY id');
  assert.ok(businesses.length >= 2, 'the seed data must contain at least two businesses');
  const [b1, b2] = businesses;

  // Business 1 supersedes its own warranty.
  const b1old = addItem(b1.id, { category: 'warranty', title: 'B1 warranty old', content: 'B1 labour warranty is 30 days.' });
  const b1new = addItem(b1.id, { category: 'warranty', title: 'B1 warranty current', content: 'B1 labour warranty is 12 months.', supersedesId: b1old });
  await index(retrieval, b1.id, b1old);
  await index(retrieval, b1.id, b1new);

  // Business 2 has a normal, current warranty.
  const b2current = addItem(b2.id, { category: 'warranty', title: 'B2 warranty', content: 'B2 labour warranty is 24 months.' });
  await index(retrieval, b2.id, b2current);

  const b1Titles = await titles(retrieval, b1.id, 'labour warranty');
  assert.ok(!b1Titles.includes('B1 warranty old'), 'business 1 must not see its own superseded entry');
  assert.ok(!b1Titles.includes('B2 warranty'), 'business 1 must never see business 2\'s knowledge');

  const b2Titles = await titles(retrieval, b2.id, 'labour warranty');
  assert.ok(b2Titles.includes('B2 warranty'),
    `business 2's current entry must still be returned, got ${JSON.stringify(b2Titles)}`);
  assert.ok(!b2Titles.includes('B1 warranty old') && !b2Titles.includes('B1 warranty current'),
    'business 2 must never see business 1\'s knowledge');

  // The superseded set is per-business, not global.
  assert.ok(retrieval.supersededItemIds(b1.id).has(b1old));
  assert.ok(!retrieval.supersededItemIds(b2.id).has(b2current));
});

// ---------------------------------------------------------------------------
// 6. Evidence-only assistant answers, and the archive trap
// ---------------------------------------------------------------------------
test('archiving the replacement must not revive the policy it replaced', async () => {
  const retrieval = loadRetrieval(inst.dbPath);
  const biz = db.get('SELECT id FROM businesses ORDER BY id LIMIT 1').id;

  const oldId = addItem(biz, {
    category: 'hours', title: 'Opening hours (winter)',
    content: 'Winter hours are 8am to 4pm Monday to Friday.',
  });
  const newId = addItem(biz, {
    category: 'hours', title: 'Opening hours (summer)',
    content: 'Summer hours are 7am to 6pm Monday to Friday.',
    supersedesId: oldId,
  });
  await index(retrieval, biz, oldId);
  await index(retrieval, biz, newId);

  // Owner archives the replacement.
  db.run("UPDATE knowledge_items SET status='archived' WHERE id=?", [newId]);
  db.run("DELETE FROM knowledge_chunks WHERE source_type='item' AND source_id=?", [newId]);

  // The replaced policy must stay retired: nothing may silently serve it again.
  assert.ok(retrieval.supersededItemIds(biz).has(oldId),
    'the replaced item stays superseded even though its replacement was archived');
  const found = await titles(retrieval, biz, 'what are the opening hours');
  assert.ok(!found.includes('Opening hours (winter)'),
    `the retired policy must NOT be silently restored, got ${JSON.stringify(found)}`);
});

test('evidence-only answers omit superseded knowledge (model offline)', async () => {
  // End-to-end through the HTTP API with no model available: this is the exact
  // path that produced the ranked-first bug during validation.
  const call = async (method, p, body, cookie) => {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${inst.baseUrl}${p}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: res.status, data, cookie: sc ? sc.split(';')[0] : cookie };
  };

  const login = await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'demo1234' });
  assert.strictEqual(login.status, 200, `login failed: ${JSON.stringify(login.data)}`);
  let cookie = login.cookie;
  if (login.data.user.mustChangePassword) {
    const changed = await call('POST', '/api/auth/change-password',
      { currentPassword: 'demo1234', newPassword: 'Supersede-Test-99' }, cookie);
    assert.strictEqual(changed.status, 200, `password change failed: ${JSON.stringify(changed.data)}`);
    const again = await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'Supersede-Test-99' });
    cookie = again.cookie;
  }

  const chat = await call('POST', '/api/assistant/chat', { message: 'What is the labour warranty?' }, cookie);
  assert.strictEqual(chat.status, 200, `chat failed: ${JSON.stringify(chat.data)}`);

  // No model is installed in CI, so this exercises the evidence-only path.
  assert.ok(['model-offline', 'ai-disabled', 'local-model'].includes(chat.data.mode),
    `unexpected mode ${chat.data.mode}`);

  const sourceTitles = (chat.data.sources || []).map((s) => s.title);
  assert.ok(!sourceTitles.some((t) => /outdated|90.day/i.test(String(t))),
    `evidence must not cite the superseded warranty, got ${JSON.stringify(sourceTitles)}`);
  assert.ok(!/\b90[- ]day/i.test(String(chat.data.answer || '')) || /outdated|replaces/i.test(String(chat.data.answer || '')),
    'the answer must not present the retired 90-day terms as current');

  // The replacement is still disclosed as a conflict, so nothing is hidden.
  const conflicts = chat.data.conflicts || [];
  assert.ok(conflicts.every((c) => c.kind !== 'superseded' || c.newerId !== c.olderId),
    'conflict records must not point at themselves');
});

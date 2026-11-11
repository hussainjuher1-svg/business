/**
 * EMBEDDING PROVENANCE — regression tests.
 *
 * The report the business owner reads claims a retrieval configuration was
 * measured. These tests pin the conditions under which `usedEmbeddings` may be
 * true, because a false positive here silently mislabels a full-text run as an
 * embedding run.
 *
 * Rules under test:
 *   1. `usedEmbeddings` is true only when vectors from the CURRENT embedding
 *      model contributed to the ranking.
 *   2. Vectors stored under a different model never count — they are not
 *      comparable, so they are never ranked.
 *   3. An embedding model that returns no identity cannot create "successful"
 *      embedding records.
 *   4. A failed indexing pass records embedded = 0 and an error, never a
 *      success.
 *
 * Every database here is a throwaway file in the OS temp directory; the real
 * development database is never opened.
 *
 * Run: node --test server/test/embedding-provenance.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-embedprov-'));
const STUB_PORT = 11440;

/** Start the stand-in Ollama (its own process; see eval-harness.test.js). */
function startStub(opts = {}) {
  const args = [path.join(__dirname, 'lib', 'ollama-stub.js'), String(STUB_PORT)];
  if (opts.failEmbed) args.push('--fail-embed');
  if (opts.anonymousEmbed) args.push('--anonymous-embed');
  if (opts.embedReady === false) args.push('--no-embed');
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`stub did not start: ${out}`)), 15000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('listening on')) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`stub exited ${c}: ${out}`)); });
  });
}

function stopStub(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
  });
}

/**
 * Load retrieval.js against an isolated database.
 *
 * A fresh module registry per database is required because db.js resolves
 * DB_PATH at import time.
 */
function loadRetrieval(dbPath) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(path.join('server', 'src'))) delete require.cache[key];
  }
  process.env.DB_PATH = dbPath;
  process.env.NODE_NO_WARNINGS = '1';
  const appDb = require(path.join(ROOT, 'server', 'src', 'db.js'));
  appDb.migrate();
  const retrieval = require(path.join(ROOT, 'server', 'src', 'ai', 'retrieval.js'));
  return { db: appDb, retrieval };
}

function makeDb(name) {
  return path.join(TMP, `${name}.db`);
}

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  // Leave no DB_PATH behind for anything that runs later in this process.
  delete process.env.DB_PATH;
});

test('usedEmbeddings is false when no embeddings exist at all', async () => {
  const stub = await startStub();
  try {
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
    process.env.OLLAMA_EMBED_MODEL = 'nomic-embed-text';
    const { db, retrieval } = loadRetrieval(makeDb('empty'));

    const businessId = db.run(
      "INSERT INTO businesses (name, created_at) VALUES ('Test Co', datetime('now'))"
    ).lastInsertRowid;
    db.run(
      `INSERT INTO knowledge_items (business_id, title, content, category)
       VALUES (?,?,?,?)`,
      [businessId, 'Warranty', 'Labour warranty is 12 months.', 'policy']
    );

    const res = await retrieval.searchKnowledge({
      businessId, query: 'how long is the labour warranty', limit: 6,
    });
    assert.strictEqual(res.usedEmbeddings, false,
      'with no vectors stored, embeddings cannot have influenced retrieval');
    assert.strictEqual(res.embedError, null, 'no embedding error occurred; the model answered');
  } finally {
    await stopStub(stub);
  }
});

test('usedEmbeddings is true only when vectors from the current model are ranked', async () => {
  const stub = await startStub();
  try {
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
    process.env.OLLAMA_EMBED_MODEL = 'nomic-embed-text';
    const { db, retrieval } = loadRetrieval(makeDb('current'));
    const businessId = db.run(
      "INSERT INTO businesses (name, created_at) VALUES ('Test Co', datetime('now'))"
    ).lastInsertRowid;

    // Index properly: this stores vectors under the model that answered.
    const idx = await retrieval.indexSource({
      businessId, sourceType: 'item', sourceId: 1,
      title: 'Warranty', text: 'Labour warranty is 12 months.', category: 'policy',
    });
    assert.ok(idx.embedded > 0, 'indexing must store vectors when the model is available');
    assert.strictEqual(idx.embedError, null);

    const res = await retrieval.searchKnowledge({
      businessId, query: 'labour warranty length', limit: 6,
    });
    assert.strictEqual(res.usedEmbeddings, true,
      'vectors for the current model exist, so embeddings contributed to the ranking');
  } finally {
    await stopStub(stub);
  }
});

test('vectors under a DIFFERENT model never count as used embeddings', async () => {
  // This is the stale-index case: the business has embeddings, but they belong to
  // another model and cannot be compared with the query vector. Reporting
  // usedEmbeddings: true here would claim a configuration that never ran.
  const stub = await startStub();
  try {
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
    process.env.OLLAMA_EMBED_MODEL = 'nomic-embed-text';
    const { db, retrieval } = loadRetrieval(makeDb('stale'));
    const businessId = db.run(
      "INSERT INTO businesses (name, created_at) VALUES ('Test Co', datetime('now'))"
    ).lastInsertRowid;

    db.run(
      `INSERT INTO knowledge_items (business_id, title, content, category)
       VALUES (?,?,?,?)`,
      [businessId, 'Warranty', 'Labour warranty is 12 months.', 'policy']
    );
    const chunkId = db.run(
      `INSERT INTO knowledge_chunks (business_id, source_type, source_id, chunk_index, title, text, category, updated_at)
       VALUES (?,?,?,?,?,?,?, datetime('now'))`,
      [businessId, 'item', 1, 0, 'Warranty', 'Labour warranty is 12 months.', 'policy']
    ).lastInsertRowid;
    db.run('INSERT INTO knowledge_chunks_fts (rowid, title, text) VALUES (?,?,?)',
      [chunkId, 'Warranty', 'Labour warranty is 12 months.']);

    // A vector from an OLD model — not the one configured now.
    db.run(
      `INSERT INTO knowledge_embeddings (chunk_id, business_id, model, dim, vector, updated_at)
       VALUES (?,?,?,?,?, datetime('now'))`,
      [chunkId, businessId, 'text-embedding-ada-002', 3, Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer)]
    );

    const res = await retrieval.searchKnowledge({
      businessId, query: 'labour warranty length', limit: 6,
    });
    assert.strictEqual(res.usedEmbeddings, false,
      'vectors from another model are never ranked, so usedEmbeddings must be false');
  } finally {
    await stopStub(stub);
  }
});

test('an unidentified embedding model never creates successful embedding records', async () => {
  const stub = await startStub({ anonymousEmbed: true });
  try {
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
    process.env.OLLAMA_EMBED_MODEL = 'nomic-embed-text';
    const { db, retrieval } = loadRetrieval(makeDb('anonymous'));
    const businessId = db.run(
      "INSERT INTO businesses (name, created_at) VALUES ('Test Co', datetime('now'))"
    ).lastInsertRowid;

    const idx = await retrieval.indexSource({
      businessId, sourceType: 'item', sourceId: 1,
      title: 'Warranty', text: 'Labour warranty is 12 months.', category: 'policy',
    });
    assert.strictEqual(idx.embedded, 0,
      'vectors with no known model must not be recorded as successfully embedded');
    assert.strictEqual(idx.embedError, 'embedding-model-unidentified',
      'the failure must be named, not silently ignored');
    const stored = db.get('SELECT COUNT(*) AS n FROM knowledge_embeddings WHERE business_id = ?', [businessId]).n;
    assert.strictEqual(stored, 0, 'nothing may be stored under an unknown model');

    // And at query time it must not claim embeddings were used.
    const res = await retrieval.searchKnowledge({ businessId, query: 'warranty', limit: 6 });
    assert.strictEqual(res.usedEmbeddings, false);
    assert.strictEqual(res.embedError, 'embedding-model-unidentified');
  } finally {
    await stopStub(stub);
  }
});

test('a failing embedding model records an error and no embeddings', async () => {
  const stub = await startStub({ failEmbed: true });
  try {
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
    process.env.OLLAMA_EMBED_MODEL = 'nomic-embed-text';
    const { db, retrieval } = loadRetrieval(makeDb('failing'));
    const businessId = db.run(
      "INSERT INTO businesses (name, created_at) VALUES ('Test Co', datetime('now'))"
    ).lastInsertRowid;

    const idx = await retrieval.indexSource({
      businessId, sourceType: 'item', sourceId: 1,
      title: 'Warranty', text: 'Labour warranty is 12 months.', category: 'policy',
    });
    assert.strictEqual(idx.embedded, 0, 'a failed embedding pass stores nothing');
    assert.ok(idx.embedError, 'the failure must be recorded');
  } finally {
    await stopStub(stub);
  }
});

test('an unavailable embedding model degrades to full text and says so', async () => {
  // Nothing listening at all: the honest degraded path.
  process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:59997';
  process.env.OLLAMA_EMBED_MODEL = 'nomic-embed-text';
  const ollama = require(path.join(ROOT, 'server', 'src', 'ai', 'ollama.js'));
  ollama.invalidateStatus();

  const { db, retrieval } = loadRetrieval(makeDb('offline'));
  const businessId = db.run(
    "INSERT INTO businesses (name, created_at) VALUES ('Test Co', datetime('now'))"
  ).lastInsertRowid;
  db.run(
    `INSERT INTO knowledge_items (business_id, title, content, category)
     VALUES (?,?,?,?)`,
    [businessId, 'Warranty', 'Labour warranty is 12 months.', 'policy']
  );
  const chunkId = db.run(
    `INSERT INTO knowledge_chunks (business_id, source_type, source_id, chunk_index, title, text, category, updated_at)
     VALUES (?,?,?,?,?,?,?, datetime('now'))`,
    [businessId, 'item', 1, 0, 'Warranty', 'Labour warranty is 12 months.', 'policy']
  ).lastInsertRowid;
  db.run('INSERT INTO knowledge_chunks_fts (rowid, title, text) VALUES (?,?,?)',
    [chunkId, 'Warranty', 'Labour warranty is 12 months.']);

  const res = await retrieval.searchKnowledge({ businessId, query: 'labour warranty', limit: 6 });
  assert.strictEqual(res.usedEmbeddings, false, 'no model, no embedding influence');
  assert.strictEqual(res.embedError, 'embedding-model-unavailable',
    'the degraded path must report WHY embeddings were skipped');
  assert.ok(res.hits.length > 0, 'full-text retrieval must still return the evidence');
});

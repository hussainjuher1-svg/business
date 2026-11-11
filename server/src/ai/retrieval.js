/**
 * Local retrieval system.
 *
 * Design rules enforced here:
 *  - every query is filtered by business_id in SQL, never after ranking;
 *  - retrieval is hybrid: FTS5 BM25 + optional local embeddings (cosine);
 *  - the whole database is never sent to the model, only top-k chunks;
 *  - untrusted text is screened for prompt injection at ingest and at read time;
 *  - stale/superseded knowledge is surfaced as a conflict, not silently dropped.
 */

const { q, get, run } = require('../db');
const ollama = require('./ollama');
const { screen, sanitizeForPrompt } = require('./guard');

const CHUNK_TARGET = 900;
const CHUNK_OVERLAP = 120;
const MAX_CHUNKS_PER_SOURCE = 40;

function vecToBlob(vec) {
  return new Uint8Array(Float32Array.from(vec).buffer);
}
function blobToVec(blob) {
  const buf = Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Split long text into overlapping chunks at paragraph/sentence boundaries. */
function chunkText(text) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_TARGET) return [clean];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  const push = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = '';
  };

  for (const para of paragraphs) {
    if (para.length > CHUNK_TARGET) {
      push();
      // Hard-split very long paragraphs on sentence boundaries.
      const sentences = para.split(/(?<=[.!?])\s+/);
      let buf = '';
      for (const s of sentences) {
        if ((buf + ' ' + s).trim().length > CHUNK_TARGET) {
          const t = buf.trim();
          if (t) chunks.push(t);
          const tail = t.slice(-CHUNK_OVERLAP);
          buf = `${tail} ${s}`;
        } else {
          buf = `${buf} ${s}`.trim();
        }
      }
      const t = buf.trim();
      if (t) chunks.push(t);
      continue;
    }
    if ((current + '\n\n' + para).trim().length > CHUNK_TARGET) {
      const tail = current.trim().slice(-CHUNK_OVERLAP);
      push();
      current = `${tail}\n\n${para}`;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  push();
  return chunks.slice(0, MAX_CHUNKS_PER_SOURCE);
}

// ---------------------------------------------------------------------------
// Index maintenance
// ---------------------------------------------------------------------------

function deleteChunksFor(sourceType, sourceId) {
  const rows = q('SELECT id FROM knowledge_chunks WHERE source_type = ? AND source_id = ?', [sourceType, sourceId]);
  for (const row of rows) {
    run('DELETE FROM knowledge_chunks_fts WHERE rowid = ?', [row.id]);
  }
  run('DELETE FROM knowledge_chunks WHERE source_type = ? AND source_id = ?', [sourceType, sourceId]);
}

/**
 * (Re)build chunks for a knowledge item, document, or the service catalog.
 * Embeddings are generated only when the local embedding model is available;
 * a missing embedding model degrades retrieval to full-text, never to silence.
 */
async function indexSource({ businessId, sourceType, sourceId, title, text, category, embedModel, skipEmbeddings = false }) {
  deleteChunksFor(sourceType, sourceId);

  const pieces = chunkText(text);
  if (pieces.length === 0) return { chunks: 0, embedded: 0, embedError: null };

  const inserted = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const check = screen(piece);
    const info = run(
      `INSERT INTO knowledge_chunks
         (business_id, source_type, source_id, chunk_index, title, text, category, injection_flag, injection_reason, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))`,
      [businessId, sourceType, sourceId, i, title || '', piece, category || 'other', check.flagged ? 1 : 0, check.reasons.join('; ')]
    );
    const id = Number(info.lastInsertRowid);
    run('INSERT INTO knowledge_chunks_fts (rowid, title, text) VALUES (?,?,?)', [id, title || '', piece]);
    inserted.push(id);
  }

  let embedded = 0;
  let embedError = null;
  if (!skipEmbeddings) {
    try {
      const { vectors, model, dim } = await ollama.embed(pieces, embedModel);
      for (let i = 0; i < inserted.length; i++) {
        run(
          `INSERT INTO knowledge_embeddings (chunk_id, business_id, model, dim, vector, updated_at)
           VALUES (?,?,?,?,?, datetime('now'))
           ON CONFLICT(chunk_id) DO UPDATE SET model=excluded.model, dim=excluded.dim,
             vector=excluded.vector, updated_at=datetime('now')`,
          [inserted[i], businessId, model, dim, vecToBlob(vectors[i])]
        );
        embedded++;
      }
    } catch (err) {
      embedError = err.code === 'EMBED_UNAVAILABLE' ? 'embedding-model-unavailable' : 'embedding-failed';
    }
  }

  return { chunks: inserted.length, embedded, embedError };
}

function bumpKnowledgeVersion(businessId) {
  run(
    `INSERT INTO business_knowledge_version (business_id, version, updated_at) VALUES (?, 1, datetime('now'))
     ON CONFLICT(business_id) DO UPDATE SET version = version + 1, updated_at = datetime('now')`,
    [businessId]
  );
  run('DELETE FROM answer_cache WHERE business_id = ?', [businessId]);
  return getKnowledgeVersion(businessId);
}

function getKnowledgeVersion(businessId) {
  const row = get('SELECT version FROM business_knowledge_version WHERE business_id = ?', [businessId]);
  return row?.version || 1;
}

/** Re-index a single knowledge item (called by the knowledge routes). */
async function reindexItem(item, opts = {}) {
  return indexSource({
    businessId: item.business_id,
    sourceType: 'item',
    sourceId: item.id,
    title: item.title,
    text: item.content,
    category: item.category,
    embedModel: opts.embedModel,
    skipEmbeddings: opts.skipEmbeddings,
  });
}

async function reindexDocument(doc, opts = {}) {
  if (!doc.extracted_text) {
    deleteChunksFor('document', doc.id);
    return { chunks: 0, embedded: 0, embedError: null };
  }
  return indexSource({
    businessId: doc.business_id,
    sourceType: 'document',
    sourceId: doc.id,
    title: doc.filename,
    text: doc.extracted_text,
    category: 'other',
    embedModel: opts.embedModel,
    skipEmbeddings: opts.skipEmbeddings,
  });
}

/**
 * The service catalog lives in business_services (real pricing data), so it is
 * indexed as a retrieval source rather than duplicated into a separate store.
 */
async function reindexServiceCatalog(businessId, opts = {}) {
  const services = q('SELECT * FROM business_services WHERE business_id = ? ORDER BY name', [businessId]);
  const lines = services.map((s) => {
    const min = s.price_min;
    const max = s.price_max;
    let price;
    if (min != null && max != null) {
      if (min === 0 && max === 0) price = 'Price: free';
      else if (min === max) price = `Price: ${min}`;
      else price = `Price: ${min}–${max}`;
    } else if (min != null) {
      price = `Starting from ${min}`;
    } else {
      price = 'Price: not specified';
    }
    return [
      `Service: ${s.name}`,
      s.description ? `Description: ${s.description}` : '',
      price,
      s.price_note ? `Pricing note: ${s.price_note}` : '',
      s.duration_minutes ? `Typical duration: ${s.duration_minutes} minutes` : '',
    ].filter(Boolean).join('\n');
  });
  const text = lines.join('\n\n');
  return indexSource({
    businessId,
    sourceType: 'catalog',
    sourceId: businessId,
    title: 'Services and pricing',
    text,
    category: 'service',
    embedModel: opts.embedModel,
    skipEmbeddings: opts.skipEmbeddings,
  });
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing',
  'have', 'has', 'had', 'having', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'about', 'as', 'by', 'from', 'up', 'down',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'can', 'could', 'should',
  'would', 'will', 'shall', 'may', 'might', 'must', 'not', 'no', 'yes', 'please', 'tell',
  'give', 'show', 'list', 'any', 'all', 'some', 'there', 'here', 'much', 'many', 'more',
  'most', 'other', 'into', 'out', 'over', 'under', 'again', 'also', 'just', 'only', 'very',
  's', 't', 'us', 'so', 'such', 'own', 'same', 'too', 'off', 'while', 'during', 'before',
  'after', 'above', 'below', 'between', 'need', 'needs', 'needed', 'want', 'get', 'got',
  // domain noise: these appear in almost every knowledge entry, so they carry no signal
  'business', 'businesses', 'company', 'currently', 'right', 'now', 'say', 'says', 'said',
  'know', 'knows', 'thing', 'things', 'way', 'ways', 'able', 'actually', 'really',
]);

/** Crude suffix stripping so "policies" matches "policy" and "delaying" matches "delay". */
function stem(term) {
  let t = String(term).toLowerCase();
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  return t;
}

/** Stemmed word set for a blob of text. */
function wordSet(text) {
  const set = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length > 1) set.add(stem(w));
  }
  return set;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Build a safe FTS5 MATCH expression from free text (never raw user input).
 * Terms are stemmed and turned into prefix queries so "policies" matches "policy"
 * and "delaying" matches "delay". Everything is quoted to neutralise FTS operators.
 */
function buildFtsQuery(text) {
  const terms = [...new Set(tokenize(text).map(stem))].filter((t) => t.length > 1).slice(0, 24);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

/**
 * Hybrid search over business knowledge for one business.
 * @returns {{hits: Array, usedEmbeddings: boolean, embedError: string|null}}
 */
async function searchKnowledge({ businessId, query: queryText, limit = 8, embedModel, minScore = 0, intentCategories = null }) {
  const ftsQuery = buildFtsQuery(queryText);
  const scores = new Map(); // chunkId -> { fts, vec, row }

  // --- lexical pass ---
  if (ftsQuery) {
    try {
      const rows = q(
        `SELECT c.id, c.business_id, c.source_type, c.source_id, c.title, c.text, c.category,
                c.injection_flag, c.injection_reason, bm25(knowledge_chunks_fts) AS rank
         FROM knowledge_chunks_fts
         JOIN knowledge_chunks c ON c.id = knowledge_chunks_fts.rowid
         WHERE knowledge_chunks_fts MATCH ? AND c.business_id = ?
         ORDER BY rank
         LIMIT 60`,
        [ftsQuery, businessId]
      );
      // SQLite bm25() is negative; more negative = better match.
      const best = rows.length ? Math.max(...rows.map((r) => -r.rank)) : 1;
      for (const r of rows) {
        const rel = Math.max(0, -r.rank);
        scores.set(r.id, { ...r, lexical: best > 0 ? Math.min(1, rel / best) : 0.5, vector: 0 });
      }
    } catch (err) {
      // Malformed query should degrade to vector-only, not crash the assistant.
      console.error('[retrieval] fts error:', err.message);
    }
  }

  // --- semantic pass (optional) ---
  let usedEmbeddings = false;
  let embedError = null;
  try {
    const { vectors, model } = await ollama.embed([queryText], embedModel);
    const queryVec = Float32Array.from(vectors[0]);
    const rows = q(
      `SELECT e.chunk_id, e.vector FROM knowledge_embeddings e
       WHERE e.business_id = ? AND e.model = ?`,
      [businessId, model]
    );
    const hasAny = q('SELECT COUNT(*) AS n FROM knowledge_embeddings WHERE business_id = ?', [businessId]).n;
    if (hasAny > 0) {
      usedEmbeddings = true;
      const sims = rows.map((r) => ({ chunk_id: r.chunk_id, sim: cosine(queryVec, blobToVec(r.vector)) }));
      for (const s of sims) {
        const existing = scores.get(s.chunk_id);
        if (existing) existing.vector = s.sim;
        else {
          const row = get('SELECT * FROM knowledge_chunks WHERE id = ? AND business_id = ?', [s.chunk_id, businessId]);
          if (row) scores.set(row.id, { ...row, rank: 0, lexical: 0, vector: s.sim });
        }
      }
    }
  } catch (err) {
    embedError = err.code === 'EMBED_UNAVAILABLE' ? 'embedding-model-unavailable' : 'embedding-failed';
  }

  const queryTerms = [...new Set(tokenize(queryText))];
  const queryStems = queryTerms.map(stem);

  const hits = [...scores.values()]
    .map((r) => {
      const bodyWords = wordSet(r.text);
      const titleWords = wordSet(r.title);
      const covered = queryTerms.filter((_t, i) => bodyWords.has(queryStems[i]) || titleWords.has(queryStems[i]));
      const titleCovered = queryTerms.filter((_t, i) => titleWords.has(queryStems[i]));
      const coverage = queryTerms.length ? covered.length / queryTerms.length : 0;
      const titleCoverage = queryTerms.length ? titleCovered.length / queryTerms.length : 0;
      const affinity = intentCategories && intentCategories.includes(r.category) ? 1 : 0;
      const lexical = r.lexical || 0;
      const vector = r.vector || 0;
      return {
        chunkId: r.id ?? r.chunk_id,
        sourceType: r.source_type,
        sourceId: r.source_id,
        title: r.title,
        category: r.category,
        text: r.text,
        injectionFlag: !!r.injection_flag,
        injectionReason: r.injection_reason || '',
        lexical,
        vector,
        coverage,
        titleCoverage,
        affinity,
        matchedTerms: covered,
        // Content overlap dominates, so a chunk must genuinely discuss the question.
        score: 0.30 * lexical + 0.22 * vector + 0.28 * coverage + 0.12 * titleCoverage + 0.08 * affinity,
      };
    })
    // Drop anything that shares no stem with the question (unless a very strong
    // semantic match). This is what stopped unrelated policies surfacing.
    .filter((h) => h.coverage > 0 || h.vector >= 0.78)
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Evidence tiers. `weak` may not be cited as support for a factual claim.
  let evidenceTier = 'none';
  if (hits.some((h) => h.coverage >= 0.3)) evidenceTier = 'strong';
  else if (hits.some((h) => h.coverage >= 0.15)) evidenceTier = 'weak';

  return { hits, usedEmbeddings, embedError, queryTerms, evidenceTier };
}

/**
 * Fetch a knowledge item / document by id, scoped to the business.
 * Used to enrich sources with recency + provenance for the answer payload.
 */
function describeSource(businessId, hit) {
  if (hit.sourceType === 'item') {
    const item = get('SELECT * FROM knowledge_items WHERE id = ? AND business_id = ?', [hit.sourceId, businessId]);
    if (!item) return null;
    return {
      kind: 'knowledge',
      id: item.id,
      title: item.title || item.category,
      category: item.category,
      source: item.source,
      sourceDetail: item.source_detail,
      lastUpdated: item.last_updated,
      status: item.status,
      supersedesId: item.supersedes_id,
      snippet: sanitizeForPrompt(hit.text, 400),
      flagged: hit.injectionFlag,
      flaggedReason: hit.injectionReason,
      score: Number(hit.score.toFixed(3)),
    };
  }
  if (hit.sourceType === 'document') {
    const doc = get('SELECT * FROM business_documents WHERE id = ? AND business_id = ?', [hit.sourceId, businessId]);
    if (!doc) return null;
    return {
      kind: 'document',
      id: doc.id,
      title: doc.filename,
      category: 'document',
      source: 'document',
      sourceDetail: doc.filename,
      lastUpdated: doc.last_updated,
      status: 'active',
      snippet: sanitizeForPrompt(hit.text, 400),
      flagged: hit.injectionFlag,
      flaggedReason: hit.injectionReason,
      score: Number(hit.score.toFixed(3)),
    };
  }
  if (hit.sourceType === 'catalog') {
    return {
      kind: 'service_catalog',
      id: null,
      title: 'Services and pricing',
      category: 'service',
      source: 'catalog',
      sourceDetail: 'Business services list',
      lastUpdated: get('SELECT MAX(last_updated) AS d FROM business_services WHERE business_id = ?', [businessId])?.d || null,
      status: 'active',
      snippet: sanitizeForPrompt(hit.text, 400),
      flagged: hit.injectionFlag,
      flaggedReason: hit.injectionReason,
      score: Number(hit.score.toFixed(3)),
    };
  }
  return null;
}

module.exports = {
  chunkText,
  indexSource,
  reindexItem,
  reindexDocument,
  reindexServiceCatalog,
  deleteChunksFor,
  bumpKnowledgeVersion,
  getKnowledgeVersion,
  searchKnowledge,
  describeSource,
  buildFtsQuery,
  tokenize,
  stem,
  wordSet,
  cosine,
  vecToBlob,
  blobToVec,
};

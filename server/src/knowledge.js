/**
 * Business Knowledge Center API.
 *
 * Everything here is business-scoped through resolveBusiness(): a request can only
 * ever read or write the business the authenticated user is a member of.
 */

const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { q, get, run, logActivity } = require('./db');
const { requireAuth, resolveBusiness, requireRole } = require('./auth');
const retrieval = require('./ai/retrieval');
const { extract } = require('./ai/extract');
const { screen } = require('./ai/guard');
const assistantEngine = require('./ai/assistant');

const router = express.Router();

const CATEGORIES = [
  'profile', 'service', 'pricing', 'hours', 'holiday', 'service_area', 'policy',
  'warranty', 'faq', 'staff', 'procedure', 'customer_instruction',
  'communication_guideline', 'other',
];

const CATEGORY_META = [
  { id: 'profile', label: 'Business profile', hint: 'Who you are, what makes you different, your story.', area: 'profile' },
  { id: 'service', label: 'Services', hint: 'What you offer and what is included.', area: 'services' },
  { id: 'pricing', label: 'Pricing & estimate rules', hint: 'Ranges, call-out fees, how you quote.', area: 'pricing' },
  { id: 'hours', label: 'Business hours', hint: 'Opening hours, after-hours policy.', area: 'hours' },
  { id: 'holiday', label: 'Holidays & closures', hint: 'Dates you are closed.', area: 'hours' },
  { id: 'service_area', label: 'Service areas', hint: 'Towns, radius, travel fees.', area: 'service_areas' },
  { id: 'policy', label: 'Policies', hint: 'Cancellation, payment, deposits, access.', area: 'policies' },
  { id: 'warranty', label: 'Warranties & guarantees', hint: 'What you guarantee and for how long.', area: 'policies' },
  { id: 'faq', label: 'FAQs', hint: 'Questions customers ask, with your answers.', area: 'faqs' },
  { id: 'staff', label: 'Staff & responsibilities', hint: 'Who does what.', area: 'staff' },
  { id: 'procedure', label: 'Operating procedures', hint: 'How a job runs, step by step.', area: 'procedures' },
  { id: 'customer_instruction', label: 'Customer instructions', hint: 'What customers should do before you arrive.', area: 'procedures' },
  { id: 'communication_guideline', label: 'Communication guidelines', hint: 'Tone, wording, what never to promise.', area: 'communication' },
  { id: 'other', label: 'Other', hint: 'Anything else worth knowing.', area: 'other' },
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

const itemSchema = z.object({
  category: z.enum(CATEGORIES),
  title: z.string().max(240).optional().default(''),
  content: z.string().min(1, 'Content is required'),
  source: z.enum(['manual', 'onboarding', 'csv_import', 'document', 'seed']).optional().default('manual'),
  sourceDetail: z.string().max(500).optional().default(''),
  effectiveDate: z.string().max(40).nullable().optional(),
  supersedesId: z.number().int().nullable().optional(),
  status: z.enum(['active', 'archived']).optional().default('active'),
});

function settingsFor(businessId) {
  return assistantEngine.getAiSettings(businessId);
}

async function reindex(businessId, fn) {
  const settings = settingsFor(businessId);
  const result = await fn({ embedModel: settings.embedModel || undefined });
  retrieval.bumpKnowledgeVersion(businessId);
  return result;
}

// ---------------------------------------------------------------------------
// Metadata + completeness
// ---------------------------------------------------------------------------

router.get('/categories', requireAuth, resolveBusiness, (req, res) => {
  res.json({ categories: CATEGORY_META });
});

router.get('/', requireAuth, resolveBusiness, (req, res) => {
  const category = req.query.category;
  const search = String(req.query.search || '').toLowerCase();
  const includeArchived = req.query.includeArchived === '1';

  let rows = q(
    `SELECT ki.*, u.name AS updated_by_name,
       (SELECT COUNT(*) FROM knowledge_chunks kc WHERE kc.source_type='item' AND kc.source_id=ki.id) AS chunk_count
     FROM knowledge_items ki LEFT JOIN users u ON u.id = ki.updated_by
     WHERE ki.business_id = ? ${includeArchived ? '' : "AND ki.status = 'active'"}
     ORDER BY ki.category, ki.last_updated DESC`,
    [req.businessId]
  );
  if (category) rows = rows.filter((r) => r.category === category);
  if (search) {
    // Normalised multi-term matching: every meaningful term must appear in the
    // title or the content, in any order, regardless of case or punctuation.
    // Returns null for an empty query, which means "no filtering".
    const matches = retrieval.makeKnowledgeMatcher(search);
    if (matches) rows = rows.filter((r) => matches({ title: r.title, content: r.content }));
  }

  const documents = q(
    `SELECT id, filename, mime, size_bytes, doc_type, text_status, last_updated, created_at,
            length(extracted_text) AS text_length
     FROM business_documents WHERE business_id = ? ORDER BY created_at DESC`,
    [req.businessId]
  );

  // Annotate each entry so the page can distinguish current / archived /
  // superseded without recomputing the graph in the browser. `superseded` is
  // derived from the same helper retrieval uses, so the UI and the assistant can
  // never disagree about which version is current.
  const supersededIds = retrieval.supersededItemIds(req.businessId);
  const supersededBy = retrieval.supersededByMap(req.businessId);
  rows = rows.map((r) => ({
    ...r,
    superseded: supersededIds.has(r.id),
    superseded_by: supersededBy.get(r.id) ?? null,
  }));

  const counts = {};
  for (const c of CATEGORIES) counts[c] = 0;
  for (const row of q(`SELECT category, COUNT(*) AS n FROM knowledge_items WHERE business_id = ? AND status='active' GROUP BY category`, [req.businessId])) {
    counts[row.category] = row.n;
  }

  res.json({
    items: rows,
    supersededCount: rows.filter((r) => r.superseded).length,
    documents,
    counts,
    categories: CATEGORY_META,
    gaps: assistantEngine.computeGaps(req.businessId),
    knowledgeVersion: retrieval.getKnowledgeVersion(req.businessId),
  });
});

router.get('/status', requireAuth, resolveBusiness, async (req, res) => {
  const ollama = require('./ai/ollama');
  const settings = settingsFor(req.businessId);
  const status = await ollama.getStatus(true);
  const embeddingCount = get('SELECT COUNT(*) AS n FROM knowledge_embeddings WHERE business_id = ?', [req.businessId])?.n || 0;
  const chunkCount = get('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE business_id = ?', [req.businessId])?.n || 0;
  res.json({
    ...status,
    settings,
    indexed: { chunks: chunkCount, embeddings: embeddingCount },
    gaps: assistantEngine.computeGaps(req.businessId),
  });
});

// ---------------------------------------------------------------------------
// Items CRUD
// ---------------------------------------------------------------------------

router.post('/', requireAuth, resolveBusiness, requireRole('owner', 'admin'), async (req, res) => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
  const d = parsed.data;

  if (d.supersedesId) {
    const target = get('SELECT id FROM knowledge_items WHERE id = ? AND business_id = ?', [d.supersedesId, req.businessId]);
    if (!target) return res.status(400).json({ error: 'The item you tried to supersede does not belong to this business.' });
  }

  const info = run(
    `INSERT INTO knowledge_items (business_id, category, title, content, source, source_detail, status, supersedes_id, effective_date, last_updated, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), ?)`,
    [req.businessId, d.category, d.title || '', d.content, d.source, d.sourceDetail || '', d.status, d.supersedesId || null, d.effectiveDate || null, req.user.id]
  );
  const id = Number(info.lastInsertRowid);
  const item = get('SELECT * FROM knowledge_items WHERE id = ?', [id]);

  let indexResult = { chunks: 0, embedded: 0, embedError: null };
  if (item.status === 'active') {
    indexResult = await reindex(req.businessId, (opts) => retrieval.reindexItem(item, opts));
  }

  // Superseded entry is archived rather than deleted, so history stays auditable.
  if (d.supersedesId) {
    run(`UPDATE knowledge_items SET status='archived', updated_at=datetime('now') WHERE id = ? AND business_id = ?`, [d.supersedesId, req.businessId]);
    const older = get('SELECT * FROM knowledge_items WHERE id = ?', [d.supersedesId]);
    if (older) await reindex(req.businessId, (opts) => retrieval.reindexItem(older, { ...opts, skipEmbeddings: true }));
  }

  logActivity(req.businessId, req.user.id, 'knowledge', id, 'created', `${d.category}: ${d.title || '(untitled)'}`);
  res.status(201).json({
    item,
    indexed: indexResult,
    injectionWarning: screen(d.content).flagged ? screen(d.content).reasons : [],
  });
});

router.patch('/:id', requireAuth, resolveBusiness, requireRole('owner', 'admin'), async (req, res) => {
  const existing = get('SELECT * FROM knowledge_items WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  if (!existing) return res.status(404).json({ error: 'Knowledge item not found.' });

  const parsed = itemSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
  const d = parsed.data;

  if (d.supersedesId) {
    const target = get('SELECT id FROM knowledge_items WHERE id = ? AND business_id = ?', [d.supersedesId, req.businessId]);
    if (!target) return res.status(400).json({ error: 'The item you tried to supersede does not belong to this business.' });
  }

  const map = { sourceDetail: 'source_detail', effectiveDate: 'effective_date', supersedesId: 'supersedes_id' };
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(d)) {
    sets.push(`${map[k] || k} = ?`);
    params.push(v);
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });
  sets.push("last_updated = datetime('now')", "updated_at = datetime('now')", 'updated_by = ?');
  params.push(req.user.id, existing.id);

  run(`UPDATE knowledge_items SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`, [...params, req.businessId]);
  const item = get('SELECT * FROM knowledge_items WHERE id = ?', [existing.id]);

  let indexResult = { chunks: 0, embedded: 0, embedError: null };
  if (item.status === 'active') {
    indexResult = await reindex(req.businessId, (opts) => retrieval.reindexItem(item, opts));
  } else {
    retrieval.deleteChunksFor('item', item.id);
    retrieval.bumpKnowledgeVersion(req.businessId);
  }

  logActivity(req.businessId, req.user.id, 'knowledge', item.id, 'updated', `${item.category}: ${item.title || '(untitled)'}`);
  res.json({ item, indexed: indexResult });
});

router.delete('/:id', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res) => {
  const existing = get('SELECT * FROM knowledge_items WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  if (!existing) return res.status(404).json({ error: 'Knowledge item not found.' });
  retrieval.deleteChunksFor('item', existing.id);
  run('DELETE FROM knowledge_items WHERE id = ? AND business_id = ?', [existing.id, req.businessId]);
  retrieval.bumpKnowledgeVersion(req.businessId);
  logActivity(req.businessId, req.user.id, 'knowledge', existing.id, 'deleted', existing.title || existing.category);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

router.post('/documents', requireAuth, resolveBusiness, requireRole('owner', 'admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const docType = String(req.body?.docType || 'other').slice(0, 60);

  const result = extract({ buffer: req.file.buffer, filename: req.file.originalname, mime: req.file.mimetype });

  const info = run(
    `INSERT INTO business_documents (business_id, filename, mime, size_bytes, doc_type, extracted_text, text_status, source, last_updated, uploaded_by)
     VALUES (?,?,?,?,?,?,?,?, datetime('now'), ?)`,
    [
      req.businessId,
      String(req.file.originalname || 'document').slice(0, 240),
      req.file.mimetype || '',
      req.file.size || 0,
      docType,
      result.text,
      result.status,
      'upload',
      req.user.id,
    ]
  );
  const doc = get('SELECT * FROM business_documents WHERE id = ?', [Number(info.lastInsertRowid)]);

  let indexed = { chunks: 0, embedded: 0, embedError: null };
  if (doc.text_status === 'extracted') {
    indexed = await reindex(req.businessId, (opts) => retrieval.reindexDocument(doc, opts));
  } else {
    retrieval.bumpKnowledgeVersion(req.businessId);
  }

  const check = screen(result.text);
  logActivity(req.businessId, req.user.id, 'document', doc.id, 'uploaded', doc.filename);
  res.status(201).json({
    document: {
      id: doc.id,
      filename: doc.filename,
      text_status: doc.text_status,
      text_length: (doc.extracted_text || '').length,
      last_updated: doc.last_updated,
    },
    note: result.note,
    indexed,
    injectionWarning: check.flagged ? check.reasons : [],
  });
});

router.get('/documents/:id', requireAuth, resolveBusiness, (req, res) => {
  const doc = get('SELECT * FROM business_documents WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  res.json(doc);
});

router.delete('/documents/:id', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res) => {
  const doc = get('SELECT * FROM business_documents WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  retrieval.deleteChunksFor('document', doc.id);
  run('DELETE FROM business_documents WHERE id = ? AND business_id = ?', [doc.id, req.businessId]);
  retrieval.bumpKnowledgeVersion(req.businessId);
  logActivity(req.businessId, req.user.id, 'document', doc.id, 'deleted', doc.filename);
  res.json({ ok: true });
});

// Re-run extraction + indexing for a document (e.g. after installing an embed model).
router.post('/documents/:id/reindex', requireAuth, resolveBusiness, requireRole('owner', 'admin'), async (req, res) => {
  const doc = get('SELECT * FROM business_documents WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  if (!doc.extracted_text) return res.status(400).json({ error: 'This document has no extracted text to index.' });
  const indexed = await reindex(req.businessId, (opts) => retrieval.reindexDocument(doc, opts));
  res.json({ ok: true, indexed });
});

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

/** Minimal RFC4180-ish CSV parser (handles quotes, escaped quotes, newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text).replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/**
 * Import knowledge items from CSV: category,title,content[,source_detail]
 * Customers import: name,phone,email,address,notes
 */
router.post('/import', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res) => {
  const parsed = z.object({
    kind: z.enum(['knowledge', 'customers']),
    csv: z.string().min(1, 'CSV content is required'),
    dryRun: z.boolean().optional().default(false),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

  const rows = parseCsv(parsed.data.csv);
  if (rows.length < 2) return res.status(400).json({ error: 'CSV needs a header row and at least one data row.' });

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const body = rows.slice(1);
  const errors = [];
  let created = 0;
  const preview = [];

  const idx = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };

  if (parsed.data.kind === 'knowledge') {
    const cCat = idx('category', 'type');
    const cTitle = idx('title', 'name');
    const cContent = idx('content', 'text', 'description', 'answer');
    const cSource = idx('source_detail', 'source', 'note');
    if (cContent === -1) return res.status(400).json({ error: 'CSV must include a "content" column.' });

    for (let r = 0; r < body.length; r++) {
      const cells = body[r];
      const category = (cCat !== -1 ? cells[cCat] : 'other').trim().toLowerCase().replace(/[\s-]+/g, '_') || 'other';
      if (!CATEGORIES.includes(category)) {
        errors.push(`Row ${r + 2}: unknown category "${category}".`);
        continue;
      }
      const content = (cells[cContent] || '').trim();
      if (!content) { errors.push(`Row ${r + 2}: empty content.`); continue; }
      const title = (cTitle !== -1 ? cells[cTitle] : '').trim();
      const sourceDetail = (cSource !== -1 ? cells[cSource] : 'CSV import').trim();
      preview.push({ category, title, content: content.slice(0, 120) });
      if (parsed.data.dryRun) continue;

      const info = run(
        `INSERT INTO knowledge_items (business_id, category, title, content, source, source_detail, status, last_updated, updated_by)
         VALUES (?,?,?,?,'csv_import',?,'active', datetime('now'), ?)`,
        [req.businessId, category, title, content, sourceDetail, req.user.id]
      );
      created++;
      const item = get('SELECT * FROM knowledge_items WHERE id = ?', [Number(info.lastInsertRowid)]);
      // Index synchronously without embeddings here; embeddings are applied by /reindex-all.
      retrieval.indexSource({
        businessId: req.businessId,
        sourceType: 'item',
        sourceId: item.id,
        title: item.title,
        text: item.content,
        category: item.category,
        skipEmbeddings: true,
      }).catch(() => {});
    }
  } else {
    const cName = idx('name', 'customer', 'customer_name');
    const cPhone = idx('phone', 'phone_number', 'mobile');
    const cEmail = idx('email', 'e-mail');
    const cAddress = idx('address');
    const cNotes = idx('notes', 'note');
    if (cName === -1) return res.status(400).json({ error: 'CSV must include a "name" column.' });

    for (let r = 0; r < body.length; r++) {
      const cells = body[r];
      const name = (cells[cName] || '').trim();
      if (!name) { errors.push(`Row ${r + 2}: missing name.`); continue; }
      const phone = cPhone !== -1 ? (cells[cPhone] || '').trim() : '';
      const email = cEmail !== -1 ? (cells[cEmail] || '').trim() : '';
      const address = cAddress !== -1 ? (cells[cAddress] || '').trim() : '';
      const notes = cNotes !== -1 ? (cells[cNotes] || '').trim() : '';
      preview.push({ name, phone, email });
      if (parsed.data.dryRun) continue;

      const existing = phone
        ? get('SELECT id FROM customers WHERE business_id = ? AND phone != \'\' AND phone = ?', [req.businessId, phone])
        : email
          ? get('SELECT id FROM customers WHERE business_id = ? AND lower(email) = lower(?)', [req.businessId, email])
          : null;
      if (existing) { errors.push(`Row ${r + 2}: "${name}" looks like an existing customer; skipped.`); continue; }

      run('INSERT INTO customers (business_id, name, phone, email, address, notes) VALUES (?,?,?,?,?,?)', [
        req.businessId, name, phone, email, address, notes,
      ]);
      created++;
    }
  }

  if (!parsed.data.dryRun) {
    retrieval.bumpKnowledgeVersion(req.businessId);
    logActivity(req.businessId, req.user.id, 'knowledge', 0, 'imported', `${created} ${parsed.data.kind} row(s) from CSV`);
  }

  res.json({
    dryRun: parsed.data.dryRun,
    created,
    total: body.length,
    errors: errors.slice(0, 40),
    preview: preview.slice(0, 15),
  });
});

// Re-embed everything for this business with the configured local model.
router.post('/reindex-all', requireAuth, resolveBusiness, requireRole('owner', 'admin'), async (req, res) => {
  const settings = settingsFor(req.businessId);
  const items = q(`SELECT * FROM knowledge_items WHERE business_id = ? AND status = 'active'`, [req.businessId]);
  const docs = q(`SELECT * FROM business_documents WHERE business_id = ? AND extracted_text != ''`, [req.businessId]);

  let chunks = 0;
  let embedded = 0;
  let embedError = null;

  for (const item of items) {
    const r = await retrieval.reindexItem(item, { embedModel: settings.embedModel || undefined });
    chunks += r.chunks; embedded += r.embedded; embedError = embedError || r.embedError;
  }
  for (const doc of docs) {
    const r = await retrieval.reindexDocument(doc, { embedModel: settings.embedModel || undefined });
    chunks += r.chunks; embedded += r.embedded; embedError = embedError || r.embedError;
  }
  const cat = await retrieval.reindexServiceCatalog(req.businessId, { embedModel: settings.embedModel || undefined });
  chunks += cat.chunks; embedded += cat.embedded; embedError = embedError || cat.embedError;

  retrieval.bumpKnowledgeVersion(req.businessId);
  res.json({ ok: true, chunks, embedded, embedError });
});

// ---------------------------------------------------------------------------
// Service catalog (structured pricing data that the assistant can cite)
// ---------------------------------------------------------------------------

router.get('/services', requireAuth, resolveBusiness, (req, res) => {
  res.json({
    services: q('SELECT * FROM business_services WHERE business_id = ? ORDER BY name', [req.businessId]),
  });
});

/**
 * Canonical service-catalog handlers.
 *
 * These are the ONLY implementation of service management. The older
 * `/api/business/services` path in routes.js delegates here rather than keeping a
 * second, weaker copy: that copy accepted only name+description, so a service
 * created from Business Settings silently lost its pricing. Two writers over one
 * table with different validation is how records get quietly degraded, so there
 * is now one writer.
 */
async function createService(req, res) {
  const parsed = z.object({
    name: z.string().min(1, 'Service name is required'),
    description: z.string().optional().default(''),
    priceMin: z.number().nullable().optional(),
    priceMax: z.number().nullable().optional(),
    priceNote: z.string().optional().default(''),
    durationMinutes: z.number().int().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
  const d = parsed.data;

  const info = run(
    `INSERT INTO business_services (business_id, name, description, price_min, price_max, price_note, duration_minutes, last_updated)
     VALUES (?,?,?,?,?,?,?, datetime('now'))`,
    [req.businessId, d.name, d.description, d.priceMin ?? null, d.priceMax ?? null, d.priceNote, d.durationMinutes ?? null]
  );
  await reindex(req.businessId, (opts) => retrieval.reindexServiceCatalog(req.businessId, opts));
  logActivity(req.businessId, req.user.id, 'service', Number(info.lastInsertRowid), 'created', d.name);
  res.status(201).json(get('SELECT * FROM business_services WHERE id = ?', [Number(info.lastInsertRowid)]));
}

async function updateService(req, res) {
  const existing = get('SELECT * FROM business_services WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  if (!existing) return res.status(404).json({ error: 'Service not found.' });
  const parsed = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    priceMin: z.number().nullable().optional(),
    priceMax: z.number().nullable().optional(),
    priceNote: z.string().optional(),
    durationMinutes: z.number().int().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
  const map = { priceMin: 'price_min', priceMax: 'price_max', priceNote: 'price_note', durationMinutes: 'duration_minutes' };
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(parsed.data)) { sets.push(`${map[k] || k} = ?`); params.push(v); }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });
  sets.push("last_updated = datetime('now')");
  run(`UPDATE business_services SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`, [...params, existing.id, req.businessId]);
  await reindex(req.businessId, (opts) => retrieval.reindexServiceCatalog(req.businessId, opts));
  res.json(get('SELECT * FROM business_services WHERE id = ?', [existing.id]));
}

async function deleteService(req, res) {
  run('DELETE FROM business_services WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  await reindex(req.businessId, (opts) => retrieval.reindexServiceCatalog(req.businessId, opts));
  res.json({ ok: true });
}

const ownerOnly = [requireAuth, resolveBusiness, requireRole('owner', 'admin')];
router.post('/services', ...ownerOnly, createService);
router.patch('/services/:id', ...ownerOnly, updateService);
router.delete('/services/:id', ...ownerOnly, deleteService);

module.exports = router;
module.exports.createService = createService;
module.exports.updateService = updateService;
module.exports.deleteService = deleteService;
module.exports.parseCsv = parseCsv;
module.exports.CATEGORIES = CATEGORIES;

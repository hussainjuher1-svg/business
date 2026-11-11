/**
 * Assistant HTTP API — local-first, evidence-cited, business-scoped.
 *
 * There is no cloud model here. The only inference provider is a locally hosted
 * Ollama instance; when it is unavailable the assistant returns retrieved evidence
 * and says plainly that the model is offline.
 */

const express = require('express');
const { z } = require('zod');
const { q, get, run } = require('./db');
const { requireAuth, resolveBusiness, requireRole } = require('./auth');
const engine = require('./ai/assistant');
const ollama = require('./ai/ollama');
const retrieval = require('./ai/retrieval');

const router = express.Router();

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

router.get('/conversations', requireAuth, resolveBusiness, (req, res) => {
  const rows = q(
    'SELECT * FROM assistant_conversations WHERE business_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 50',
    [req.businessId, req.user.id]
  );
  res.json(rows);
});

router.post('/conversations', requireAuth, resolveBusiness, (req, res) => {
  const info = run('INSERT INTO assistant_conversations (business_id, user_id, title) VALUES (?,?,?)', [
    req.businessId, req.user.id, 'New conversation',
  ]);
  res.status(201).json(get('SELECT * FROM assistant_conversations WHERE id = ?', [Number(info.lastInsertRowid)]));
});

router.get('/conversations/:id/messages', requireAuth, resolveBusiness, (req, res) => {
  const conv = get('SELECT * FROM assistant_conversations WHERE id = ? AND business_id = ? AND user_id = ?', [
    req.params.id, req.businessId, req.user.id,
  ]);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  const rows = q('SELECT * FROM assistant_messages WHERE conversation_id = ? ORDER BY id ASC', [conv.id]).map((m) => ({
    ...m,
    sources: parseJson(m.sources, []),
    gaps: parseJson(m.gaps, []),
    warnings: parseJson(m.warnings, []),
  }));
  res.json(rows);
});

router.delete('/conversations/:id', requireAuth, resolveBusiness, (req, res) => {
  run('DELETE FROM assistant_conversations WHERE id = ? AND business_id = ? AND user_id = ?', [
    req.params.id, req.businessId, req.user.id,
  ]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

router.post('/chat', requireAuth, resolveBusiness, async (req, res, next) => {
  const parsed = z.object({
    message: z.string().min(1, 'Message is required').max(4000, 'Message is too long'),
    conversationId: z.number().int().optional(),
    useCache: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

  const { message } = parsed.data;
  try {
    let convId = parsed.data.conversationId;
    if (convId) {
      const conv = get('SELECT * FROM assistant_conversations WHERE id = ? AND business_id = ? AND user_id = ?', [
        convId, req.businessId, req.user.id,
      ]);
      if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
    } else {
      const info = run('INSERT INTO assistant_conversations (business_id, user_id, title) VALUES (?,?,?)', [
        req.businessId, req.user.id, message.slice(0, 60),
      ]);
      convId = Number(info.lastInsertRowid);
    }

    const prior = q(
      'SELECT role, content FROM assistant_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 40',
      [convId]
    );

    run('INSERT INTO assistant_messages (conversation_id, role, content) VALUES (?,?,?)', [convId, 'user', message]);

    const result = await engine.answer({
      businessId: req.businessId,
      userId: req.user.id,
      question: message,
      history: prior,
      useCache: parsed.data.useCache !== false,
    });

    run(
      `INSERT INTO assistant_messages (conversation_id, role, content, sources, mode, gaps, warnings, latency_ms)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        convId,
        'assistant',
        result.answer,
        JSON.stringify(result.sources || []),
        result.mode || 'unknown',
        JSON.stringify(result.gaps || []),
        JSON.stringify(result.warnings || []),
        result.latencyMs || 0,
      ]
    );
    run("UPDATE assistant_conversations SET updated_at = datetime('now') WHERE id = ?", [convId]);

    res.json({ conversationId: convId, ...result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Status / diagnostics
// ---------------------------------------------------------------------------

router.get('/status', requireAuth, resolveBusiness, async (req, res) => {
  const status = await ollama.getStatus(true);
  const settings = engine.getAiSettings(req.businessId);
  const embeddings = get('SELECT COUNT(*) AS n FROM knowledge_embeddings WHERE business_id = ?', [req.businessId])?.n || 0;
  const chunks = get('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE business_id = ?', [req.businessId])?.n || 0;
  const knowledgeItems = get(
    `SELECT COUNT(*) AS n FROM knowledge_items WHERE business_id = ? AND status = 'active'`,
    [req.businessId]
  )?.n || 0;

  res.json({
    provider: 'ollama',
    localOnly: true,
    model: {
      available: status.available,
      chatModel: settings.chatModel || status.chatModel,
      chatModelReady: status.chatModelReady,
      embedModel: settings.embedModel || status.embedModel,
      embedModelReady: status.embedModelReady,
      installedModels: status.installedModels,
      problem: status.problem,
      baseUrl: status.baseUrl,
    },
    settings,
    knowledge: { items: knowledgeItems, chunks, embeddings },
    gaps: engine.computeGaps(req.businessId),
    latencyMs: 0,
  });
});

router.get('/suggestions', requireAuth, resolveBusiness, (req, res) => {
  const gaps = engine.computeGaps(req.businessId);
  const hasGaps = gaps.length > 0;
  const suggestions = [...engine.PACKAGE_QUESTIONS];
  if (hasGaps) suggestions.push('What information is missing from my knowledge base?');
  res.json({ suggestions, gaps });
});

// ---------------------------------------------------------------------------
// AI settings (per business)
// ---------------------------------------------------------------------------

router.get('/settings', requireAuth, resolveBusiness, (req, res) => {
  res.json(engine.getAiSettings(req.businessId));
});

router.patch('/settings', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res) => {
  const parsed = z.object({
    enabled: z.boolean().optional(),
    chatModel: z.string().max(120).optional(),
    embedModel: z.string().max(120).optional(),
    strictGrounding: z.boolean().optional(),
    cacheEnabled: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
  const d = parsed.data;

  run(
    `INSERT INTO business_ai_settings (business_id, enabled, chat_model, embed_model, strict_grounding, cache_enabled, updated_at)
     VALUES (?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(business_id) DO UPDATE SET
       enabled = COALESCE(?, enabled),
       chat_model = COALESCE(?, chat_model),
       embed_model = COALESCE(?, embed_model),
       strict_grounding = COALESCE(?, strict_grounding),
       cache_enabled = COALESCE(?, cache_enabled),
       updated_at = datetime('now')`,
    [
      req.businessId,
      d.enabled === undefined ? 1 : d.enabled ? 1 : 0,
      d.chatModel ?? '',
      d.embedModel ?? '',
      d.strictGrounding === undefined ? 1 : d.strictGrounding ? 1 : 0,
      d.cacheEnabled === undefined ? 1 : d.cacheEnabled ? 1 : 0,
      d.enabled === undefined ? null : d.enabled ? 1 : 0,
      d.chatModel ?? null,
      d.embedModel ?? null,
      d.strictGrounding === undefined ? null : d.strictGrounding ? 1 : 0,
      d.cacheEnabled === undefined ? null : d.cacheEnabled ? 1 : 0,
    ]
  );
  res.json(engine.getAiSettings(req.businessId));
});

// Clear this business's cached answers.
router.post('/cache/clear', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res) => {
  run('DELETE FROM answer_cache WHERE business_id = ?', [req.businessId]);
  retrieval.bumpKnowledgeVersion(req.businessId);
  res.json({ ok: true });
});

module.exports = router;

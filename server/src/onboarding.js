/**
 * Guided onboarding.
 *
 * The completeness checklist is DERIVED from real business data, never from
 * placeholder values. Nothing here fills a field with invented content — it only
 * reports what is missing and links the owner to where to add it.
 */

const express = require('express');
const { z } = require('zod');
const { q, get, run, logActivity } = require('./db');
const { requireAuth, resolveBusiness, requireRole } = require('./auth');
const engine = require('./ai/assistant');
const retrieval = require('./ai/retrieval');

const router = express.Router();

const AREA_LABELS = {
  profile: 'Business profile',
  services: 'Services',
  pricing: 'Pricing',
  hours: 'Business hours',
  service_areas: 'Service areas',
  policies: 'Policies & warranties',
  faqs: 'FAQs',
  procedures: 'Procedures & customer instructions',
  documents: 'Documents',
  customers: 'Customer records',
  staff: 'Staff & responsibilities',
  other: 'Other knowledge',
};

function count(sql, params) {
  return get(sql, params)?.n || 0;
}

function buildChecklist(businessId) {
  const biz = get('SELECT * FROM businesses WHERE id = ?', [businessId]);
  const items = (category) =>
    count(`SELECT COUNT(*) AS n FROM knowledge_items WHERE business_id = ? AND status='active' AND category = ?`, [businessId, category]);
  const docs = count('SELECT COUNT(*) AS n FROM business_documents WHERE business_id = ?', [businessId]);
  const customers = count('SELECT COUNT(*) AS n FROM customers WHERE business_id = ?', [businessId]);
  const staff = count('SELECT COUNT(*) AS n FROM business_memberships WHERE business_id = ?', [businessId]);
  const services = count('SELECT COUNT(*) AS n FROM business_services WHERE business_id = ?', [businessId]);
  const priced = count(
    'SELECT COUNT(*) AS n FROM business_services WHERE business_id = ? AND (price_min IS NOT NULL OR price_note != \'\')',
    [businessId]
  );
  const knowledgeItems = count(`SELECT COUNT(*) AS n FROM knowledge_items WHERE business_id = ? AND status='active'`, [businessId]);

  const steps = [
    {
      id: 'profile', area: 'profile', label: 'Business basics',
      description: 'Name, phone or email, address and a short description of what you do.',
      complete: !!biz?.name && (!!biz?.phone || !!biz?.email),
      detail: !biz?.phone && !biz?.email ? 'Add a phone number or email in Settings or the Business profile entry.' : '',
      action: 'knowledge:profile',
    },
    {
      id: 'services', area: 'services', label: 'Services you offer',
      description: 'List your services so the assistant can describe them.',
      complete: services > 0 || items('service') > 0,
      detail: services ? `${services} service(s) in your catalog.` : 'No services yet.',
      action: 'knowledge:services',
    },
    {
      id: 'pricing', area: 'pricing', label: 'Pricing rules',
      description: 'Prices, ranges or estimating rules.',
      complete: priced > 0 || items('pricing') > 0,
      detail: priced ? `${priced} service(s) have pricing.` : 'No prices recorded — the assistant will refuse to quote figures.',
      action: 'knowledge:pricing',
    },
    {
      id: 'hours', area: 'hours', label: 'Hours and holidays',
      description: 'When you are open and when you are closed.',
      complete: (!!biz?.hours || items('hours') > 0) && items('holiday') > 0,
      detail: !biz?.hours && items('hours') === 0 ? 'No business hours recorded.' : items('holiday') === 0 ? 'No holidays recorded.' : '',
      action: 'knowledge:hours',
    },
    {
      id: 'service_areas', area: 'service_areas', label: 'Service areas',
      description: 'Where you work and any travel limits.',
      complete: !!biz?.service_areas || items('service_area') > 0,
      detail: '',
      action: 'knowledge:service_area',
    },
    {
      id: 'policies', area: 'policies', label: 'Policies and warranties',
      description: 'Cancellation, payment, deposits and warranty terms.',
      complete: (!!biz?.policies || items('policy') > 0) && items('warranty') > 0,
      detail: items('warranty') === 0 ? 'No warranty information recorded.' : '',
      action: 'knowledge:policy',
    },
    {
      id: 'faqs', area: 'faqs', label: 'Common customer questions',
      description: 'FAQs and what customers should know before booking.',
      complete: items('faq') > 0,
      detail: '',
      action: 'knowledge:faq',
    },
    {
      id: 'procedures', area: 'procedures', label: 'How jobs run',
      description: 'Operating procedures and what customers should prepare.',
      complete: items('procedure') > 0 || items('customer_instruction') > 0,
      detail: '',
      action: 'knowledge:procedure',
    },
    {
      id: 'staff', area: 'staff', label: 'Staff and responsibilities',
      description: 'Who works with you and what they handle.',
      complete: staff > 0 && (items('staff') > 0 || staff > 0),
      detail: staff <= 1 ? 'Only your own account exists — add team members if others handle work.' : '',
      action: 'settings',
    },
    {
      id: 'documents', area: 'documents', label: 'Existing documents',
      description: 'Upload price sheets, contracts or warranty documents you already have.',
      complete: docs > 0,
      detail: '',
      action: 'knowledge:documents',
    },
    {
      id: 'customers', area: 'customers', label: 'Customer records',
      description: 'Import existing customers so live questions have data.',
      complete: customers > 0,
      detail: '',
      action: 'customers',
    },
  ];

  const complete = steps.filter((s) => s.complete).length;
  return {
    steps,
    complete,
    total: steps.length,
    percent: Math.round((complete / steps.length) * 100),
    gaps: engine.computeGaps(businessId),
    stats: { knowledgeItems, documents: docs, customers, staff, services, pricedServices: priced },
  };
}

router.get('/onboarding', requireAuth, resolveBusiness, (req, res) => {
  const state = get('SELECT * FROM onboarding_state WHERE business_id = ?', [req.businessId]);
  let completedSteps = [];
  try {
    completedSteps = JSON.parse(state?.completed_steps || '[]');
  } catch {
    completedSteps = [];
  }
  res.json({
    ...buildChecklist(req.businessId),
    dismissed: !!state?.dismissed,
    acknowledgedSteps: completedSteps,
    areaLabels: AREA_LABELS,
  });
});

router.post('/onboarding/ack', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res) => {
  const parsed = z.object({ step: z.string().max(60) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
  const state = get('SELECT * FROM onboarding_state WHERE business_id = ?', [req.businessId]);
  let steps = [];
  try {
    steps = JSON.parse(state?.completed_steps || '[]');
  } catch {
    steps = [];
  }
  if (!steps.includes(parsed.data.step)) steps.push(parsed.data.step);
  run(
    `INSERT INTO onboarding_state (business_id, completed_steps, updated_at) VALUES (?,?, datetime('now'))
     ON CONFLICT(business_id) DO UPDATE SET completed_steps = excluded.completed_steps, updated_at = datetime('now')`,
    [req.businessId, JSON.stringify(steps)]
  );
  res.json({ ok: true, acknowledgedSteps: steps });
});

router.patch('/onboarding', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res) => {
  const parsed = z.object({ dismissed: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
  run(
    `INSERT INTO onboarding_state (business_id, dismissed, updated_at) VALUES (?,?, datetime('now'))
     ON CONFLICT(business_id) DO UPDATE SET dismissed = excluded.dismissed, updated_at = datetime('now')`,
    [req.businessId, parsed.data.dismissed ? 1 : 0]
  );
  res.json({ ok: true });
});

/**
 * One-shot onboarding save: writes profile fields, services, staff notes and
 * policies in a single owner action. Blank values are skipped, never filled in.
 */
router.post('/onboarding/complete', requireAuth, resolveBusiness, requireRole('owner', 'admin'), async (req, res) => {
  const parsed = z.object({
    profile: z.object({
      description: z.string().max(4000).optional(),
      phone: z.string().max(60).optional(),
      email: z.string().max(200).optional(),
      address: z.string().max(400).optional(),
      hours: z.string().max(1000).optional(),
      serviceAreas: z.string().max(1000).optional(),
      policies: z.string().max(4000).optional(),
      paymentMethods: z.string().max(400).optional(),
    }).optional(),
    services: z.array(z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(1000).optional().default(''),
      priceMin: z.number().nullable().optional(),
      priceMax: z.number().nullable().optional(),
      priceNote: z.string().max(500).optional().default(''),
    })).max(100).optional(),
    faqs: z.array(z.object({ question: z.string().min(1).max(300), answer: z.string().min(1).max(4000) })).max(100).optional(),
    policiesExtra: z.array(z.object({ title: z.string().max(200), content: z.string().min(1).max(4000) })).max(50).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
  const d = parsed.data;

  let updatedProfile = false;
  if (d.profile) {
    const map = {
      phone: 'phone', email: 'email', address: 'address', hours: 'hours',
      serviceAreas: 'service_areas', policies: 'policies', paymentMethods: 'payment_methods',
    };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) {
      const v = d.profile[k];
      if (v !== undefined && String(v).trim() !== '') {
        sets.push(`${col} = ?`);
        params.push(String(v).trim());
      }
    }
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      run(`UPDATE businesses SET ${sets.join(', ')} WHERE id = ?`, [...params, req.businessId]);
      updatedProfile = true;
    }
    if (d.profile.description && d.profile.description.trim()) {
      const info = run(
        `INSERT INTO knowledge_items (business_id, category, title, content, source, source_detail, status, last_updated, updated_by)
         VALUES (?, 'profile', 'Business profile', ?, 'onboarding', 'Onboarding wizard', 'active', datetime('now'), ?)`,
        [req.businessId, d.profile.description.trim(), req.user.id]
      );
      const item = get('SELECT * FROM knowledge_items WHERE id = ?', [Number(info.lastInsertRowid)]);
      await retrieval.reindexItem(item, { skipEmbeddings: true });
    }
  }

  let serviceCount = 0;
  for (const s of d.services || []) {
    run(
      `INSERT INTO business_services (business_id, name, description, price_min, price_max, price_note, last_updated)
       VALUES (?,?,?,?,?,?, datetime('now'))`,
      [req.businessId, s.name.trim(), s.description || '', s.priceMin ?? null, s.priceMax ?? null, s.priceNote || '']
    );
    serviceCount++;
  }
  if (serviceCount) await retrieval.reindexServiceCatalog(req.businessId, { skipEmbeddings: true });

  let faqCount = 0;
  for (const f of d.faqs || []) {
    const info = run(
      `INSERT INTO knowledge_items (business_id, category, title, content, source, source_detail, status, last_updated, updated_by)
       VALUES (?, 'faq', ?, ?, 'onboarding', 'Onboarding wizard', 'active', datetime('now'), ?)`,
      [req.businessId, f.question.trim(), f.answer.trim(), req.user.id]
    );
    const item = get('SELECT * FROM knowledge_items WHERE id = ?', [Number(info.lastInsertRowid)]);
    await retrieval.reindexItem(item, { skipEmbeddings: true });
    faqCount++;
  }

  let policyCount = 0;
  for (const p of d.policiesExtra || []) {
    const info = run(
      `INSERT INTO knowledge_items (business_id, category, title, content, source, source_detail, status, last_updated, updated_by)
       VALUES (?, 'policy', ?, ?, 'onboarding', 'Onboarding wizard', 'active', datetime('now'), ?)`,
      [req.businessId, p.title || 'Policy', p.content, req.user.id]
    );
    const item = get('SELECT * FROM knowledge_items WHERE id = ?', [Number(info.lastInsertRowid)]);
    await retrieval.reindexItem(item, { skipEmbeddings: true });
    policyCount++;
  }

  retrieval.bumpKnowledgeVersion(req.businessId);
  logActivity(req.businessId, req.user.id, 'knowledge', 0, 'onboarding_saved',
    `${serviceCount} service(s), ${faqCount} FAQ(s), ${policyCount} policy entry(ies)`);

  res.json({ ok: true, updatedProfile, serviceCount, faqCount, policyCount, checklist: buildChecklist(req.businessId) });
});

module.exports = router;
module.exports.buildChecklist = buildChecklist;

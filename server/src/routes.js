const express = require('express');
const { z } = require('zod');
const { q, get, run, logActivity } = require('./db');
const { hashPassword, verifyPassword, createSession, destroySession, destroyAllSessions, getMemberships, requireAuth, resolveBusiness, requireRole, setSessionCookie, clearSessionCookie } = require('./auth');
const loginGuard = require('./login-guard');
const demoGuard = require('./demo-guard');

const router = express.Router();

const emailSchema = z.string().email('Invalid email address');

/**
 * Password policy for REAL accounts.
 *
 * Demo accounts are created by the seed scripts with a known password so the
 * pilot can be demonstrated. Those credentials must never be reusable for a
 * genuine business account, so registration refuses them explicitly, along with
 * weak/guessable passwords.
 */
const DEMO_PASSWORDS = new Set([
  'demo1234', 'password', 'password1', 'password123', '12345678', '123456789',
  '1234567890', 'qwerty123', 'letmein1', 'welcome1', 'admin123', 'daybook123',
]);

const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long')
  .superRefine((val, ctx) => {
    if (DEMO_PASSWORDS.has(val.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'That password is a shared demo password and cannot be used for a real account. Choose something unique.',
      });
      return;
    }
    if (/^\d+$/.test(val)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Password cannot be only numbers.' });
      return;
    }
    if (/^(.)\1+$/.test(val)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Password cannot be a single repeated character.' });
      return;
    }
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(val)).length;
    if (classes < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Password must mix at least two of: lowercase letters, uppercase letters, numbers, symbols.',
      });
    }
  });

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ error, ...extra });
}

// ---------- helpers ----------
function businessToday(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
function dateRangeDays(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function paginate(req, rows) {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const offset = Number(req.query.offset) || 0;
  return { data: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

// ---------- auth ----------
router.post('/auth/register', (req, res) => {
  const parsed = z.object({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().min(1, 'Name is required'),
    businessName: z.string().min(1, 'Business name is required'),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const { email, password, name, businessName } = parsed.data;
  const existing = get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existing) return fail(res, 409, 'An account with this email already exists. Try logging in.');
  const info = run('INSERT INTO users (email, password_hash, name) VALUES (?,?,?)', [email.toLowerCase(), hashPassword(password), name]);
  const userId = Number(info.lastInsertRowid);
  const biz = run('INSERT INTO businesses (name) VALUES (?)', [businessName]);
  const businessId = Number(biz.lastInsertRowid);
  run('INSERT INTO business_memberships (business_id, user_id, role) VALUES (?,?,?)', [businessId, userId, 'owner']);
  logActivity(businessId, userId, 'business', businessId, 'created', `Business "${businessName}" created`);
  const token = createSession(userId);
  setSessionCookie(res, token);
  res.status(201).json({
    user: { id: userId, email, name, isDemo: false, mustChangePassword: false },
    businesses: getMemberships(userId),
  });
});

router.post('/auth/login', loginGuard.loginRateLimit, (req, res) => {
  const parsed = z.object({ email: emailSchema, password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const email = parsed.data.email.toLowerCase();
  const user = get('SELECT * FROM users WHERE email = ?', [email]);

  if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
    loginGuard.recordFailure(req, email);
    return fail(res, 401, 'Invalid email or password.');
  }

  loginGuard.recordSuccess(req, email);
  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isDemo: !!user.is_demo,
      mustChangePassword: !!user.must_change_password,
    },
    businesses: getMemberships(user.id),
  });
});

/**
 * Forced password change (release blocker #3).
 * Requires a valid session, verifies the current password, applies the shared
 * policy, revokes all sessions, and issues a fresh one.
 */
router.post('/auth/change-password', requireAuth, (req, res) => {
  const parsed = z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(1, 'New password is required'),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);

  const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) return fail(res, 404, 'Account not found.');

  if (!verifyPassword(parsed.data.currentPassword, user.password_hash)) {
    loginGuard.recordFailure(req, user.email);
    return fail(res, 401, 'Current password is incorrect.');
  }

  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return fail(res, 400, 'New password must be different from the current password.');
  }

  const problem = demoGuard.validateNewPassword(parsed.data.newPassword);
  if (problem) return fail(res, 400, problem);

  run(
    `UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
    [hashPassword(parsed.data.newPassword), user.id]
  );

  // Force re-login everywhere with the new credential.
  destroyAllSessions(user.id);
  const token = createSession(user.id);
  setSessionCookie(res, token);

  res.json({ ok: true, mustChangePassword: false, user: { id: user.id, email: user.email, name: user.name } });
});

router.post('/auth/logout', requireAuth, (req, res) => {
  destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      isDemo: !!req.user.is_demo,
      mustChangePassword: !!req.user.must_change_password,
    },
    businesses: getMemberships(req.user.id),
    environment: demoGuard.isProduction() ? 'production' : 'development',
  });
});

// ---------- businesses / settings ----------
router.get('/business', requireAuth, resolveBusiness, (req, res) => {
  const biz = get('SELECT * FROM businesses WHERE id = ?', [req.businessId]);
  const services = q('SELECT * FROM business_services WHERE business_id = ? ORDER BY name', [req.businessId]);
  const members = q(
    `SELECT u.id, u.name, u.email, m.role FROM business_memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = ? ORDER BY u.name`,
    [req.businessId]
  );
  res.json({ business: biz, services, members, role: req.role });
});

router.patch('/business', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res) => {
  const allowed = ['name', 'phone', 'email', 'address', 'hours', 'policies', 'payment_methods', 'service_areas', 'currency', 'timezone'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) { sets.push(`${k} = ?`); params.push(String(req.body[k])); }
  }
  if (!sets.length) return fail(res, 400, 'No editable fields provided.');
  sets.push("updated_at = datetime('now')");
  params.push(req.businessId);
  run(`UPDATE businesses SET ${sets.join(', ')} WHERE id = ?`, params);
  logActivity(req.businessId, req.user.id, 'business', req.businessId, 'updated', 'Business settings updated');
  res.json(get('SELECT * FROM businesses WHERE id = ?', [req.businessId]));
});

// ---------- service catalog (legacy paths, retained for compatibility) ----------
//
// These paths are kept so an installed copy or an existing bookmark does not
// break, but they are no longer a separate implementation. They delegate to the
// canonical handlers in knowledge.js, which means a service created here now gets
// the same validation, the same pricing fields and the same reindexing as one
// created from the Services & pricing tab.
//
// The old version accepted only name+description, so anything created through
// Business Settings lost its pricing and never entered the knowledge index —
// a silent data-quality bug, not just a stylistic inconsistency.
//
// We deliberately did NOT delete these routes: removing them would break clients
// mid-flight. Deprecation is signalled through headers instead, and a single
// implementation means the two paths can no longer disagree.
function markDeprecated(res, canonical) {
  res.set('Deprecation', 'true');
  res.set('Link', `<${canonical}>; rel="successor-version"`);
}

router.post('/business/services', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res, next) => {
  markDeprecated(res, '/api/knowledge/services');
  const knowledge = require('./knowledge');
  knowledge.createService(req, res).catch(next);
});

router.patch('/business/services/:id', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res, next) => {
  markDeprecated(res, '/api/knowledge/services');
  const knowledge = require('./knowledge');
  knowledge.updateService(req, res).catch(next);
});

router.delete('/business/services/:id', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res, next) => {
  markDeprecated(res, '/api/knowledge/services');
  const knowledge = require('./knowledge');
  knowledge.deleteService(req, res).catch(next);
});

// Expose the canonical list at the legacy address too, so a client that lists
// services here sees exactly the same rows as the Services & pricing tab.
router.get('/business/services', requireAuth, resolveBusiness, (req, res) => {
  markDeprecated(res, '/api/knowledge/services');
  res.json({ services: q('SELECT * FROM business_services WHERE business_id = ? ORDER BY name', [req.businessId]) });
});

// ---------- staff ----------
router.post('/business/staff', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res) => {
  const parsed = z.object({
    email: emailSchema,
    name: z.string().min(1),
    role: z.enum(['owner', 'admin', 'staff']).default('staff'),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  let user = get('SELECT * FROM users WHERE email = ?', [parsed.data.email.toLowerCase()]);
  if (!user) {
    const info = run('INSERT INTO users (email, password_hash, name) VALUES (?,?,?)', [parsed.data.email.toLowerCase(), hashPassword(cryptoRandom()), parsed.data.name]);
    user = get('SELECT * FROM users WHERE id = ?', [Number(info.lastInsertRowid)]);
  }
  const existing = get('SELECT id FROM business_memberships WHERE business_id = ? AND user_id = ?', [req.businessId, user.id]);
  if (existing) return fail(res, 409, 'This user is already a member of your business.');
  run('INSERT INTO business_memberships (business_id, user_id, role) VALUES (?,?,?)', [req.businessId, user.id, parsed.data.role]);
  logActivity(req.businessId, req.user.id, 'staff', user.id, 'added', `${user.email} (${parsed.data.role})`);
  res.status(201).json({ id: user.id, email: user.email, name: user.name, role: parsed.data.role });
});

function cryptoRandom() {
  return require('node:crypto').randomBytes(16).toString('hex');
}

router.patch('/business/staff/:userId', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res) => {
  const parsed = z.object({ role: z.enum(['owner', 'admin', 'staff']) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  run('UPDATE business_memberships SET role = ? WHERE business_id = ? AND user_id = ?', [parsed.data.role, req.businessId, req.params.userId]);
  res.json({ ok: true });
});

router.delete('/business/staff/:userId', requireAuth, resolveBusiness, requireRole('owner', 'admin'), (req, res) => {
  if (Number(req.params.userId) === req.user.id) return fail(res, 400, 'You cannot remove yourself.');
  run('DELETE FROM business_memberships WHERE business_id = ? AND user_id = ?', [req.businessId, req.params.userId]);
  res.json({ ok: true });
});

// ---------- customers ----------
router.get('/customers', requireAuth, resolveBusiness, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  let rows = q('SELECT * FROM customers WHERE business_id = ? ORDER BY name COLLATE NOCASE', [req.businessId]);
  if (search) rows = rows.filter((c) => [c.name, c.phone, c.email].join(' ').toLowerCase().includes(search));
  res.json(paginate(req, rows));
});

router.post('/customers', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    name: z.string().min(1, 'Customer name is required'),
    phone: z.string().optional().default(''),
    email: z.string().optional().default(''),
    address: z.string().optional().default(''),
    notes: z.string().optional().default(''),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const d = parsed.data;
  // duplicate warning: same phone or email already exists
  const dup = get(
    `SELECT id, name, phone, email FROM customers WHERE business_id = ? AND ((phone != '' AND phone = ?) OR (email != '' AND lower(email) = lower(?))) LIMIT 1`,
    [req.businessId, d.phone, d.email]
  );
  const info = run('INSERT INTO customers (business_id, name, phone, email, address, notes) VALUES (?,?,?,?,?,?)',
    [req.businessId, d.name, d.phone, d.email, d.address, d.notes]);
  const id = Number(info.lastInsertRowid);
  logActivity(req.businessId, req.user.id, 'customer', id, 'created', d.name);
  res.status(201).json({ customer: get('SELECT * FROM customers WHERE id = ?', [id]), possibleDuplicate: dup || null });
});

router.get('/customers/:id', requireAuth, resolveBusiness, (req, res) => {
  const customer = get('SELECT * FROM customers WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  if (!customer) return fail(res, 404, 'Customer not found.');
  const inquiries = q('SELECT * FROM inquiries WHERE customer_id = ? ORDER BY created_at DESC', [customer.id]);
  const estimates = q('SELECT * FROM estimates WHERE customer_id = ? ORDER BY created_at DESC', [customer.id]);
  const appointments = q('SELECT * FROM appointments WHERE customer_id = ? ORDER BY starts_at DESC', [customer.id]);
  const jobs = q('SELECT * FROM jobs WHERE customer_id = ? ORDER BY created_at DESC', [customer.id]);
  const followUps = q('SELECT * FROM follow_ups WHERE customer_id = ? ORDER BY due_date', [customer.id]);
  const activity = q('SELECT * FROM activity_logs WHERE business_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 50', [req.businessId, 'customer', customer.id]);
  res.json({ customer, inquiries, estimates, appointments, jobs, followUps, activity });
});

router.patch('/customers/:id', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    name: z.string().min(1).optional(),
    phone: z.string().optional(), email: z.string().optional(),
    address: z.string().optional(), notes: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const sets = Object.keys(parsed.data).map((k) => `${k} = ?`);
  if (!sets.length) return fail(res, 400, 'No fields to update.');
  sets.push("updated_at = datetime('now')");
  run(`UPDATE customers SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`, [...Object.values(parsed.data), req.params.id, req.businessId]);
  logActivity(req.businessId, req.user.id, 'customer', Number(req.params.id), 'updated', Object.keys(parsed.data).join(', '));
  res.json(get('SELECT * FROM customers WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]));
});

router.delete('/customers/:id', requireAuth, resolveBusiness, (req, res) => {
  run('DELETE FROM customers WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  res.json({ ok: true });
});

// ---------- inquiries ----------
const INQUIRY_STATUSES = ['new', 'needs_response', 'in_progress', 'estimate_requested', 'converted', 'not_proceeding', 'archived'];
router.get('/inquiries', requireAuth, resolveBusiness, (req, res) => {
  const search = (req.query.search || '').toLowerCase().trim();
  const status = req.query.status;

  // Assignment filter. `assignedTo=none` means "nobody owns this yet"; a numeric
  // value means "show me that person's work". An unrecognised value is a client
  // error rather than a silent no-op, because silently returning everything would
  // look like the filter worked.
  const assignedToRaw = req.query.assignedTo;
  let assignment = 'any';
  let assignedToId = null;
  if (assignedToRaw !== undefined && assignedToRaw !== '') {
    if (String(assignedToRaw).toLowerCase() === 'none') {
      assignment = 'none';
    } else if (/^\d+$/.test(String(assignedToRaw))) {
      assignment = 'id';
      assignedToId = Number(assignedToRaw);
    } else {
      return fail(res, 400, 'assignedTo must be "none" or a staff id.');
    }
  }

  let rows = q(`SELECT i.*, c.name AS customer_name FROM inquiries i LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.business_id = ? ORDER BY i.created_at DESC`, [req.businessId]);

  // Filters compose: assignment AND status AND search, then pagination.
  if (assignment === 'none') rows = rows.filter((r) => r.assigned_to === null || r.assigned_to === undefined);
  else if (assignment === 'id') rows = rows.filter((r) => r.assigned_to === assignedToId);
  if (status) rows = rows.filter((r) => r.status === status);
  if (search) {
    rows = rows.filter((r) => [r.contact_name, r.phone, r.email, r.subject, r.message, r.customer_name]
      .join(' ').toLowerCase().includes(search));
  }

  const page = paginate(req, rows);
  res.json({
    ...page,
    // Echo the resolved filter so a UI can show what is actually applied.
    filters: { assignedTo: assignment === 'id' ? assignedToId : assignment, status: status || null, search: search || null },
  });
});

router.post('/inquiries', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    contactName: z.string().min(1, 'Contact name is required'),
    phone: z.string().optional().default(''),
    email: z.string().optional().default(''),
    source: z.string().optional().default('manual'),
    subject: z.string().optional().default(''),
    message: z.string().optional().default(''),
    customerId: z.number().int().nullable().optional(),
    assignedTo: z.number().int().nullable().optional(),
    followUpDate: z.string().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const d = parsed.data;
  const info = run(`INSERT INTO inquiries (business_id, customer_id, contact_name, phone, email, source, subject, message, status, assigned_to, follow_up_date)
    VALUES (?,?,?,?,?,?,?,?, 'new', ?, ?)`,
    [req.businessId, d.customerId || null, d.contactName, d.phone, d.email, d.source, d.subject, d.message, d.assignedTo || null, d.followUpDate || null]);
  const id = Number(info.lastInsertRowid);
  logActivity(req.businessId, req.user.id, 'inquiry', id, 'created', d.subject || d.contactName);
  res.status(201).json(get('SELECT * FROM inquiries WHERE id = ?', [id]));
});

router.get('/inquiries/:id', requireAuth, resolveBusiness, (req, res) => {
  const row = get('SELECT * FROM inquiries WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  if (!row) return fail(res, 404, 'Inquiry not found.');
  const activity = q('SELECT * FROM activity_logs WHERE business_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 50', [req.businessId, 'inquiry', row.id]);
  res.json({ inquiry: row, activity });
});

router.patch('/inquiries/:id', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    contactName: z.string().min(1).optional(),
    phone: z.string().optional(), email: z.string().optional(),
    source: z.string().optional(), subject: z.string().optional(), message: z.string().optional(),
    status: z.enum(INQUIRY_STATUSES).optional(),
    customerId: z.number().int().nullable().optional(),
    assignedTo: z.number().int().nullable().optional(),
    followUpDate: z.string().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const map = { contactName: 'contact_name', customerId: 'customer_id', assignedTo: 'assigned_to', followUpDate: 'follow_up_date' };
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    sets.push(`${map[k] || k} = ?`); params.push(v);
  }
  if (!sets.length) return fail(res, 400, 'No fields to update.');
  sets.push("updated_at = datetime('now')");
  run(`UPDATE inquiries SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`, [...params, req.params.id, req.businessId]);
  logActivity(req.businessId, req.user.id, 'inquiry', Number(req.params.id), 'updated', Object.keys(parsed.data).join(', '));
  res.json(get('SELECT * FROM inquiries WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]));
});

router.post('/inquiries/:id/convert', requireAuth, resolveBusiness, (req, res) => {
  const inquiry = get('SELECT * FROM inquiries WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  if (!inquiry) return fail(res, 404, 'Inquiry not found.');
  let customerId = inquiry.customer_id;
  if (!customerId) {
    const info = run('INSERT INTO customers (business_id, name, phone, email) VALUES (?,?,?,?)',
      [req.businessId, inquiry.contact_name, inquiry.phone, inquiry.email]);
    customerId = Number(info.lastInsertRowid);
    logActivity(req.businessId, req.user.id, 'customer', customerId, 'created_from_inquiry', inquiry.contact_name);
  }
  run(`UPDATE inquiries SET customer_id = ?, status = 'converted', updated_at = datetime('now') WHERE id = ? AND business_id = ?`, [customerId, inquiry.id, req.businessId]);
  logActivity(req.businessId, req.user.id, 'inquiry', inquiry.id, 'converted', `Customer #${customerId}`);
  res.json({ inquiry: get('SELECT * FROM inquiries WHERE id = ?', [inquiry.id]), customerId });
});

router.delete('/inquiries/:id', requireAuth, resolveBusiness, (req, res) => {
  run('DELETE FROM inquiries WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  res.json({ ok: true });
});

// ---------- estimates ----------
const ESTIMATE_STATUSES = ['draft', 'sent', 'awaiting_response', 'follow_up_needed', 'accepted', 'declined', 'expired'];
router.get('/estimates', requireAuth, resolveBusiness, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  const status = req.query.status;
  let rows = q(`SELECT e.*, c.name AS customer_name FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
    WHERE e.business_id = ? ORDER BY e.created_at DESC`, [req.businessId]);
  if (status) rows = rows.filter((r) => r.status === status);
  if (search) rows = rows.filter((r) => [r.title, r.description, r.customer_name].join(' ').toLowerCase().includes(search));
  res.json(paginate(req, rows));
});

router.post('/estimates', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional().default(''),
    amount: z.number().nullable().optional(),
    currency: z.string().optional(),
    customerId: z.number().int().nullable().optional(),
    inquiryId: z.number().int().nullable().optional(),
    issueDate: z.string().nullable().optional(),
    validUntil: z.string().nullable().optional(),
    followUpDate: z.string().nullable().optional(),
    notes: z.string().optional().default(''),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const d = parsed.data;
  const biz = get('SELECT currency FROM businesses WHERE id = ?', [req.businessId]);
  const info = run(`INSERT INTO estimates (business_id, customer_id, inquiry_id, title, description, amount, currency, status, issue_date, valid_until, follow_up_date, notes)
    VALUES (?,?,?,?,?,?,?, 'draft', ?, ?, ?, ?)`,
    [req.businessId, d.customerId || null, d.inquiryId || null, d.title, d.description, d.amount ?? null, d.currency || biz?.currency || 'USD', d.issueDate || null, d.validUntil || null, d.followUpDate || null, d.notes]);
  const id = Number(info.lastInsertRowid);
  logActivity(req.businessId, req.user.id, 'estimate', id, 'created', d.title);
  res.status(201).json(get('SELECT * FROM estimates WHERE id = ?', [id]));
});

router.get('/estimates/:id', requireAuth, resolveBusiness, (req, res) => {
  const row = get('SELECT * FROM estimates WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  if (!row) return fail(res, 404, 'Estimate not found.');
  const activity = q('SELECT * FROM activity_logs WHERE business_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 50', [req.businessId, 'estimate', row.id]);
  res.json({ estimate: row, activity });
});

router.patch('/estimates/:id', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    title: z.string().min(1).optional(), description: z.string().optional(),
    amount: z.number().nullable().optional(), currency: z.string().optional(),
    status: z.enum(ESTIMATE_STATUSES).optional(),
    customerId: z.number().int().nullable().optional(), inquiryId: z.number().int().nullable().optional(),
    issueDate: z.string().nullable().optional(), validUntil: z.string().nullable().optional(),
    followUpDate: z.string().nullable().optional(), notes: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const map = { customerId: 'customer_id', inquiryId: 'inquiry_id', issueDate: 'issue_date', validUntil: 'valid_until', followUpDate: 'follow_up_date' };
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(parsed.data)) { sets.push(`${map[k] || k} = ?`); params.push(v); }
  if (!sets.length) return fail(res, 400, 'No fields to update.');
  sets.push("updated_at = datetime('now')");
  run(`UPDATE estimates SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`, [...params, req.params.id, req.businessId]);
  logActivity(req.businessId, req.user.id, 'estimate', Number(req.params.id), 'updated', Object.keys(parsed.data).join(', '));
  res.json(get('SELECT * FROM estimates WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]));
});

router.delete('/estimates/:id', requireAuth, resolveBusiness, (req, res) => {
  run('DELETE FROM estimates WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  res.json({ ok: true });
});

// ---------- appointments ----------
const APPT_STATUSES = ['scheduled', 'confirmation_needed', 'confirmed', 'completed', 'cancelled', 'rescheduled'];
router.get('/appointments', requireAuth, resolveBusiness, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  const status = req.query.status;
  let rows = q(`SELECT a.*, c.name AS customer_name FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
    WHERE a.business_id = ? ORDER BY a.starts_at ASC`, [req.businessId]);
  if (status) rows = rows.filter((r) => r.status === status);
  if (search) rows = rows.filter((r) => [r.title, r.location, r.customer_name].join(' ').toLowerCase().includes(search));
  res.json(paginate(req, rows));
});

router.post('/appointments', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    title: z.string().min(1, 'Title is required'),
    startsAt: z.string().min(1, 'Start date/time is required'),
    endsAt: z.string().nullable().optional(),
    customerId: z.number().int().nullable().optional(),
    jobId: z.number().int().nullable().optional(),
    location: z.string().optional().default(''),
    instructions: z.string().optional().default(''),
    assignedTo: z.number().int().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const d = parsed.data;
  const info = run(`INSERT INTO appointments (business_id, customer_id, job_id, title, starts_at, ends_at, location, instructions, status, assigned_to)
    VALUES (?,?,?,?,?,?,?,?, 'scheduled', ?)`,
    [req.businessId, d.customerId || null, d.jobId || null, d.title, d.startsAt, d.endsAt || null, d.location, d.instructions, d.assignedTo || null]);
  const id = Number(info.lastInsertRowid);
  logActivity(req.businessId, req.user.id, 'appointment', id, 'created', d.title);
  res.status(201).json(get('SELECT * FROM appointments WHERE id = ?', [id]));
});

router.patch('/appointments/:id', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    title: z.string().min(1).optional(), startsAt: z.string().optional(), endsAt: z.string().nullable().optional(),
    status: z.enum(APPT_STATUSES).optional(),
    customerId: z.number().int().nullable().optional(), jobId: z.number().int().nullable().optional(),
    location: z.string().optional(), instructions: z.string().optional(),
    assignedTo: z.number().int().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const map = { startsAt: 'starts_at', endsAt: 'ends_at', customerId: 'customer_id', jobId: 'job_id', assignedTo: 'assigned_to' };
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(parsed.data)) { sets.push(`${map[k] || k} = ?`); params.push(v); }
  if (!sets.length) return fail(res, 400, 'No fields to update.');
  sets.push("updated_at = datetime('now')");
  run(`UPDATE appointments SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`, [...params, req.params.id, req.businessId]);
  logActivity(req.businessId, req.user.id, 'appointment', Number(req.params.id), 'updated', Object.keys(parsed.data).join(', '));
  res.json(get('SELECT * FROM appointments WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]));
});

router.delete('/appointments/:id', requireAuth, resolveBusiness, (req, res) => {
  run('DELETE FROM appointments WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  res.json({ ok: true });
});

// ---------- jobs ----------
const JOB_STATUSES = ['not_started', 'scheduled', 'in_progress', 'waiting', 'completed', 'cancelled'];
router.get('/jobs', requireAuth, resolveBusiness, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  const status = req.query.status;
  let rows = q(`SELECT j.*, c.name AS customer_name FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
    WHERE j.business_id = ? ORDER BY j.created_at DESC`, [req.businessId]);
  if (status) rows = rows.filter((r) => r.status === status);
  if (search) rows = rows.filter((r) => [r.title, r.description, r.customer_name].join(' ').toLowerCase().includes(search));
  res.json(paginate(req, rows));
});

router.post('/jobs', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional().default(''),
    customerId: z.number().int().nullable().optional(),
    inquiryId: z.number().int().nullable().optional(),
    estimateId: z.number().int().nullable().optional(),
    scheduledDate: z.string().nullable().optional(),
    assignedTo: z.number().int().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const d = parsed.data;
  const info = run(`INSERT INTO jobs (business_id, customer_id, inquiry_id, estimate_id, title, description, status, scheduled_date, assigned_to)
    VALUES (?,?,?,?,?,?, 'not_started', ?, ?)`,
    [req.businessId, d.customerId || null, d.inquiryId || null, d.estimateId || null, d.title, d.description, d.scheduledDate || null, d.assignedTo || null]);
  const id = Number(info.lastInsertRowid);
  logActivity(req.businessId, req.user.id, 'job', id, 'created', d.title);
  res.status(201).json(get('SELECT * FROM jobs WHERE id = ?', [id]));
});

router.patch('/jobs/:id', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    title: z.string().min(1).optional(), description: z.string().optional(),
    status: z.enum(JOB_STATUSES).optional(),
    customerId: z.number().int().nullable().optional(), inquiryId: z.number().int().nullable().optional(),
    estimateId: z.number().int().nullable().optional(),
    scheduledDate: z.string().nullable().optional(), assignedTo: z.number().int().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const map = { customerId: 'customer_id', inquiryId: 'inquiry_id', estimateId: 'estimate_id', scheduledDate: 'scheduled_date', assignedTo: 'assigned_to' };
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(parsed.data)) { sets.push(`${map[k] || k} = ?`); params.push(v); }
  if (!sets.length) return fail(res, 400, 'No fields to update.');
  sets.push("updated_at = datetime('now')");
  run(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`, [...params, req.params.id, req.businessId]);
  logActivity(req.businessId, req.user.id, 'job', Number(req.params.id), 'updated', Object.keys(parsed.data).join(', '));
  res.json(get('SELECT * FROM jobs WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]));
});

router.delete('/jobs/:id', requireAuth, resolveBusiness, (req, res) => {
  run('DELETE FROM jobs WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  res.json({ ok: true });
});

// ---------- follow-ups ----------
router.get('/follow-ups', requireAuth, resolveBusiness, (req, res) => {
  const status = req.query.status;
  let rows = q(`SELECT f.*, c.name AS customer_name FROM follow_ups f LEFT JOIN customers c ON c.id = f.customer_id
    WHERE f.business_id = ? ORDER BY f.due_date ASC`, [req.businessId]);
  if (status) rows = rows.filter((r) => r.status === status);
  res.json(paginate(req, rows));
});

router.post('/follow-ups', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    title: z.string().min(1, 'Title is required'),
    dueDate: z.string().min(1, 'Due date is required'),
    notes: z.string().optional().default(''),
    customerId: z.number().int().nullable().optional(),
    inquiryId: z.number().int().nullable().optional(),
    estimateId: z.number().int().nullable().optional(),
    jobId: z.number().int().nullable().optional(),
    assignedTo: z.number().int().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const d = parsed.data;
  const info = run(`INSERT INTO follow_ups (business_id, customer_id, inquiry_id, estimate_id, job_id, title, notes, due_date, assigned_to, status)
    VALUES (?,?,?,?,?,?,?,?,?, 'open')`,
    [req.businessId, d.customerId || null, d.inquiryId || null, d.estimateId || null, d.jobId || null, d.title, d.notes, d.dueDate, d.assignedTo || null]);
  const id = Number(info.lastInsertRowid);
  logActivity(req.businessId, req.user.id, 'follow_up', id, 'created', d.title);
  res.status(201).json(get('SELECT * FROM follow_ups WHERE id = ?', [id]));
});

router.patch('/follow-ups/:id', requireAuth, resolveBusiness, (req, res) => {
  const parsed = z.object({
    title: z.string().min(1).optional(), notes: z.string().optional(),
    dueDate: z.string().optional(), status: z.enum(['open', 'completed', 'rescheduled']).optional(),
    assignedTo: z.number().int().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0].message);
  const map = { dueDate: 'due_date', assignedTo: 'assigned_to' };
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(parsed.data)) { sets.push(`${map[k] || k} = ?`); params.push(v); }
  if (parsed.data.status === 'completed') { sets.push("completed_at = datetime('now')"); }
  if (!sets.length) return fail(res, 400, 'No fields to update.');
  sets.push("updated_at = datetime('now')");
  run(`UPDATE follow_ups SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`, [...params, req.params.id, req.businessId]);
  logActivity(req.businessId, req.user.id, 'follow_up', Number(req.params.id), 'updated', Object.keys(parsed.data).join(', '));
  res.json(get('SELECT * FROM follow_ups WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]));
});

router.delete('/follow-ups/:id', requireAuth, resolveBusiness, (req, res) => {
  run('DELETE FROM follow_ups WHERE id = ? AND business_id = ?', [req.params.id, req.businessId]);
  res.json({ ok: true });
});

// ---------- dashboard ----------
router.get('/dashboard', requireAuth, resolveBusiness, (req, res) => {
  const biz = get('SELECT * FROM businesses WHERE id = ?', [req.businessId]);
  const today = businessToday(biz?.timezone);
  const tomorrow = new Date(new Date(today).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const weekStart = dateRangeDays(7)[0];

  const newInquiries = q(`SELECT * FROM inquiries WHERE business_id = ? AND status IN ('new','needs_response') ORDER BY created_at DESC`, [req.businessId]);
  const pendingEstimates = q(`SELECT e.*, c.name AS customer_name FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
    WHERE e.business_id = ? AND e.status IN ('sent','awaiting_response','follow_up_needed') ORDER BY e.follow_up_date ASC`, [req.businessId]);
  const overdueFollowUps = q(`SELECT f.*, c.name AS customer_name FROM follow_ups f LEFT JOIN customers c ON c.id = f.customer_id
    WHERE f.business_id = ? AND f.status = 'open' AND date(f.due_date) < date(?) ORDER BY f.due_date ASC`, [req.businessId, today]);
  const dueTodayFollowUps = q(`SELECT f.*, c.name AS customer_name FROM follow_ups f LEFT JOIN customers c ON c.id = f.customer_id
    WHERE f.business_id = ? AND f.status = 'open' AND date(f.due_date) = date(?) ORDER BY f.due_date ASC`, [req.businessId, today]);
  const unconfirmedAppts = q(`SELECT a.*, c.name AS customer_name FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
    WHERE a.business_id = ? AND a.status IN ('scheduled','confirmation_needed') AND date(a.starts_at) >= date(?) ORDER BY a.starts_at ASC`, [req.businessId, today]);
  const todayAppts = q(`SELECT a.*, c.name AS customer_name FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
    WHERE a.business_id = ? AND date(a.starts_at) = date(?) ORDER BY a.starts_at ASC`, [req.businessId, today]);
  const upcomingAppts = q(`SELECT a.*, c.name AS customer_name FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
    WHERE a.business_id = ? AND date(a.starts_at) > date(?) AND a.status NOT IN ('cancelled','completed') ORDER BY a.starts_at ASC LIMIT 10`, [req.businessId, today]);
  const activeJobs = q(`SELECT j.*, c.name AS customer_name FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
    WHERE j.business_id = ? AND j.status IN ('not_started','scheduled','in_progress','waiting') ORDER BY j.scheduled_date ASC`, [req.businessId]);
  const todayJobs = q(`SELECT j.*, c.name AS customer_name FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
    WHERE j.business_id = ? AND date(j.scheduled_date) = date(?) AND j.status NOT IN ('completed','cancelled') ORDER BY j.created_at ASC`, [req.businessId, today]);
  const weekInquiries = q(`SELECT * FROM inquiries WHERE business_id = ? AND date(created_at) >= date(?) ORDER BY created_at DESC`, [req.businessId, weekStart]);

  // ---- Overdue estimate follow-ups ----
  //
  // Deliberately NOT "expired". An expired estimate has passed `valid_until`;
  // an overdue follow-up is one the owner planned to chase and has not chased
  // yet, whatever its validity. Conflating the two would nag about quotes that
  // were already sent to the customer for a decision.
  //
  //   pending statuses (not accepted/declined/expired)
  //   AND follow_up_date is non-null          <- nothing scheduled, nothing overdue
  //   AND follow_up_date < the business-local current date
  //
  // The comparison uses the business-local 'today' for the same reason every
  // other date on this dashboard does: a business east of UTC is already
  // tomorrow while the server is still on yesterday.
  const overdueEstimateFollowUps = q(
    `SELECT e.*, c.name AS customer_name
       FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
      WHERE e.business_id = ?
        AND e.status IN ('sent','awaiting_response','follow_up_needed')
        AND e.follow_up_date IS NOT NULL
        AND date(e.follow_up_date) < date(?)
      ORDER BY e.follow_up_date ASC`,
    [req.businessId, today]
  );

  // Estimates past their validity that are still pending. Reported separately so
  // an expired quote is never counted as an overdue follow-up.
  const expiredEstimates = q(
    `SELECT e.*, c.name AS customer_name
       FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
      WHERE e.business_id = ?
        AND e.status IN ('sent','awaiting_response','follow_up_needed')
        AND e.valid_until IS NOT NULL
        AND date(e.valid_until) < date(?)
      ORDER BY e.valid_until ASC`,
    [req.businessId, today]
  );

  // ---- Unassigned, still-actionable inquiries ----
  //
  // "Actionable" excludes anything already resolved, so the count reflects work
  // that someone still has to pick up.
  const ACTIONABLE_INQUIRY_STATUSES = ['new', 'needs_response', 'in_progress', 'estimate_requested'];
  const unassignedInquiries = q(
    `SELECT i.* FROM inquiries i
      WHERE i.business_id = ?
        AND i.assigned_to IS NULL
        AND i.status IN (${ACTIONABLE_INQUIRY_STATUSES.map(() => '?').join(',')})
      ORDER BY i.created_at ASC`,
    [req.businessId, ...ACTIONABLE_INQUIRY_STATUSES]
  );

  const attention = [];
  // One entry per underlying problem. The pending-estimate loop below skips an
  // estimate that is already listed as overdue, so the same quote cannot appear
  // twice under two different headings.
  const overdueEstimateIds = new Set(overdueEstimateFollowUps.map((e) => e.id));
  const unassignedInquiryIds = new Set(unassignedInquiries.map((i) => i.id));

  for (const i of newInquiries) {
    // An unassigned inquiry is surfaced by the unassigned block below with a more
    // useful title; listing it here too would be the same problem twice.
    if (unassignedInquiryIds.has(i.id)) continue;
    attention.push({ type: 'inquiry', id: i.id, title: `New inquiry: ${i.contact_name}`, detail: i.subject || i.message?.slice(0, 80) || '', date: i.created_at, link: `/inquiries/${i.id}` });
  }

  for (const e of overdueEstimateFollowUps) {
    attention.push({
      type: 'estimate_follow_up_overdue',
      id: e.id,
      title: `Overdue estimate follow-up: ${e.title}`,
      detail: `${e.customer_name ? `Customer: ${e.customer_name} · ` : ''}was due ${String(e.follow_up_date).slice(0, 10)}`,
      date: e.follow_up_date,
      link: '/work/estimates',
    });
  }

  for (const e of pendingEstimates) {
    if (overdueEstimateIds.has(e.id)) continue;
    attention.push({ type: 'estimate', id: e.id, title: `Estimate awaiting follow-up: ${e.title}`, detail: e.customer_name ? `Customer: ${e.customer_name}` : '', date: e.follow_up_date || e.created_at, link: '/work/estimates' });
  }

  for (const i of unassignedInquiries) {
    attention.push({
      type: 'inquiry_unassigned',
      id: i.id,
      title: `Unassigned inquiry: ${i.contact_name}`,
      detail: i.subject || i.message?.slice(0, 80) || 'Nobody is handling this yet.',
      date: i.created_at,
      link: '/inquiries',
    });
  }
  for (const f of overdueFollowUps) attention.push({ type: 'follow_up', id: f.id, title: `Overdue follow-up: ${f.title}`, detail: f.customer_name ? `Customer: ${f.customer_name}` : '', date: f.due_date, link: `/work/follow-ups` });
  for (const a of unconfirmedAppts) attention.push({ type: 'appointment', id: a.id, title: `Unconfirmed appointment: ${a.title}`, detail: a.customer_name ? `Customer: ${a.customer_name}` : '', date: a.starts_at, link: `/work/appointments` });

  const nextSteps = [];
  // Counts here must partition the work, not double it. An overdue estimate is
  // already "pending", so counting it in both lines would tell the owner there is
  // more to do than there is. The overdue line claims its estimates; the pending
  // line reports only the remainder.
  const notOverduePendingEstimates = pendingEstimates.filter((e) => !overdueEstimateIds.has(e.id));
  // Same split for inquiries: an unassigned inquiry is also a new one.
  const assignedNewInquiries = newInquiries.filter((i) => !unassignedInquiryIds.has(i.id));

  if (assignedNewInquiries.length) nextSteps.push({ text: `Respond to ${assignedNewInquiries.length} new ${assignedNewInquiries.length === 1 ? 'inquiry' : 'inquiries'}`, link: '/inquiries' });
  if (notOverduePendingEstimates.length) nextSteps.push({ text: `Follow up on ${notOverduePendingEstimates.length} pending ${notOverduePendingEstimates.length === 1 ? 'estimate' : 'estimates'}`, link: '/work/estimates' });
  if (overdueEstimateFollowUps.length) nextSteps.push({ text: `Chase ${overdueEstimateFollowUps.length} overdue estimate ${overdueEstimateFollowUps.length === 1 ? 'follow-up' : 'follow-ups'}`, link: '/work/estimates' });
  if (unassignedInquiries.length) nextSteps.push({ text: `Assign ${unassignedInquiries.length} unassigned ${unassignedInquiries.length === 1 ? 'inquiry' : 'inquiries'}`, link: '/inquiries' });
  if (overdueFollowUps.length) nextSteps.push({ text: `Complete ${overdueFollowUps.length} overdue follow-up${overdueFollowUps.length === 1 ? '' : 's'}`, link: '/work/follow-ups' });
  if (dueTodayFollowUps.length) nextSteps.push({ text: `${dueTodayFollowUps.length} follow-up${dueTodayFollowUps.length === 1 ? '' : 's'} due today`, link: '/work/follow-ups' });
  if (unconfirmedAppts.length) nextSteps.push({ text: `Confirm ${unconfirmedAppts.length} upcoming appointment${unconfirmedAppts.length === 1 ? '' : 's'}`, link: '/work/appointments' });
  if (activeJobs.length) nextSteps.push({ text: `Review ${activeJobs.length} active job${activeJobs.length === 1 ? '' : 's'}`, link: '/work/jobs' });
  if (!nextSteps.length) nextSteps.push({ text: 'All caught up. Nothing needs attention right now.', link: '/today' });

  res.json({
    today, tomorrow, business: biz,
    attention, nextSteps,
    todayAppointments: todayAppts, upcomingAppointments: upcomingAppts,
    todayJobs, activeJobs,
    counts: {
      newInquiries: newInquiries.length,
      pendingEstimates: pendingEstimates.length,
      overdueFollowUps: overdueFollowUps.length,
      dueTodayFollowUps: dueTodayFollowUps.length,
      unconfirmedAppointments: unconfirmedAppts.length,
      activeJobs: activeJobs.length,
      weekInquiries: weekInquiries.length,
      totalCustomers: get('SELECT COUNT(*) AS n FROM customers WHERE business_id = ?', [req.businessId])?.n || 0,
      // New operational metrics. Each is a database count, not a client-side
      // derived figure, so the number on screen is the number in the rows.
      overdueEstimateFollowUps: overdueEstimateFollowUps.length,
      expiredEstimates: expiredEstimates.length,
      unassignedInquiries: unassignedInquiries.length,
    },
    // The underlying rows, so a screen can list them without a second request.
    overdueEstimateFollowUps,
    expiredEstimates,
    unassignedInquiries,
    weekInquiries,
  });
});

module.exports = router;

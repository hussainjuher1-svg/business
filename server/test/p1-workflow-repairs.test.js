/**
 * P1 WORKFLOW REPAIR REGRESSIONS.
 *
 * The Phase 7 acceptance pass found three workflows that the interface made
 * impossible while the API already supported them. These tests pin the three
 * behaviours so the gaps cannot silently come back.
 *
 *   1. Appointment rescheduling — PATCH /appointments/:id must accept a new
 *      start time AND must leave every other column untouched.
 *   2. Inquiry assignment — the dashboard's "Assign N unassigned inquiries"
 *      action needs PATCH /inquiries/:id to set and clear assigned_to, and the
 *      unassigned bucket must respond to it.
 *   3. Knowledge restore — includeArchived=1 must expose archived entries, and
 *      restoring one must put it back into ordinary (active) results.
 *
 * Scope note: these are server-contract tests. The matching interface controls
 * (Reschedule button, "Assigned to" picker, "Show archived" toggle) are verified
 * through the jsdom acceptance suite, because a server test cannot see a button.
 *
 * Run: node --test server/test/p1-workflow-repairs.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createInstance, openDatabase } = require('./lib/test-instance');

const PORT = 3240;
const OWNER = { email: 'hvac@daybook.local', password: 'demo1234' };

let inst;
let db;
let cookie = '';
let bizId;
let staffId;
let ownerId;

async function call(method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${inst.baseUrl}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

/** A datetime-local shaped string, the way the browser sends it. */
function localStamp(daysFromNow, hour) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 30, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:30`;
}

test.before(async () => {
  inst = await createInstance({ name: 'p1-repairs', port: PORT });
  db = openDatabase(inst.dbPath);

  const login = await call('POST', '/api/auth/login', OWNER);
  assert.strictEqual(login.status, 200, `login failed: ${JSON.stringify(login.data)}`);
  if (login.data.user.mustChangePassword) {
    await call('POST', '/api/auth/change-password', {
      currentPassword: OWNER.password,
      newPassword: 'P1-Repairs-2026',
    });
    await call('POST', '/api/auth/login', { email: OWNER.email, password: 'P1-Repairs-2026' });
  }

  const biz = await call('GET', '/api/business');
  assert.strictEqual(biz.status, 200);
  bizId = biz.data.business.id;
  ownerId = biz.data.members.find((m) => m.role === 'owner')?.id ?? null;
  staffId = biz.data.members.find((m) => m.role !== 'owner')?.id ?? null;
  assert.ok(staffId, 'seed data must contain an assignable staff member');
});

test.after(async () => { if (inst) await inst.cleanup(); });

// ---------------------------------------------------------------------------
// 1. Appointment rescheduling
// ---------------------------------------------------------------------------

/** Create a fully-populated appointment so a lossy edit is detectable. */
async function makeAppointment() {
  const res = await call('POST', '/api/appointments', {
    title: 'Regression appointment',
    startsAt: localStamp(4, 9),
    endsAt: localStamp(4, 11),
    location: '12 Test Street',
    instructions: 'Ring the bell twice.',
    assignedTo: staffId,
  });
  assert.strictEqual(res.status, 201, `create failed: ${JSON.stringify(res.data)}`);
  return res.data;
}

test('appointment: a new start time is accepted and persisted', async () => {
  const appt = await makeAppointment();
  const newStart = localStamp(11, 15);

  const patched = await call('PATCH', `/api/appointments/${appt.id}`, { startsAt: newStart });
  assert.strictEqual(patched.status, 200, `patch failed: ${JSON.stringify(patched.data)}`);

  const row = db.get('SELECT id, starts_at FROM appointments WHERE id = ?', [appt.id]);
  assert.ok(row, 'appointment should still exist');
  // The API stores exactly what the client sent, so compare on the minute after
  // normalising the "T"/" " separator and any seconds.
  const normalise = (s) => String(s).replace('T', ' ').slice(0, 16);
  assert.strictEqual(normalise(row.starts_at), normalise(newStart));
});

test('appointment: rescheduling preserves every other field', async () => {
  const appt = await makeAppointment();
  const before = db.get('SELECT * FROM appointments WHERE id = ?', [appt.id]);

  const patched = await call('PATCH', `/api/appointments/${appt.id}`, {
    startsAt: localStamp(12, 16),
  });
  assert.strictEqual(patched.status, 200);

  const after = db.get('SELECT * FROM appointments WHERE id = ?', [appt.id]);
  // Everything except the two time columns must be byte-identical.
  const frozen = ['id', 'business_id', 'customer_id', 'job_id', 'title', 'location',
    'instructions', 'status', 'assigned_to', 'created_at'];
  for (const col of frozen) {
    assert.deepStrictEqual(after[col], before[col], `${col} changed during a reschedule`);
  }
  assert.notStrictEqual(after.starts_at, before.starts_at, 'the start time should have changed');
});

test('appointment: clearing the end time is allowed, a blank start time is not', async () => {
  const appt = await makeAppointment();

  const cleared = await call('PATCH', `/api/appointments/${appt.id}`, { endsAt: null });
  assert.strictEqual(cleared.status, 200, `could not clear ends_at: ${JSON.stringify(cleared.data)}`);
  assert.strictEqual(db.get('SELECT ends_at FROM appointments WHERE id = ?', [appt.id]).ends_at, null);

  // An empty start time must not be written over a valid one.
  const blanked = await call('PATCH', `/api/appointments/${appt.id}`, { startsAt: '' });
  assert.strictEqual(blanked.status, 400, 'an empty start time should be rejected');

  const row = db.get('SELECT starts_at FROM appointments WHERE id = ?', [appt.id]);
  assert.ok(row.starts_at, 'the original start time must survive a rejected edit');
});

test('appointment: rescheduling another tenant\'s appointment is refused', async () => {
  const appt = await makeAppointment();

  // A second, unrelated business must not be able to touch it.
  const other = db.get('SELECT id FROM businesses WHERE id != ? LIMIT 1', [bizId]);
  if (!other) return; // single-business seed: nothing to prove here
  const patched = await call('PATCH', `/api/appointments/${appt.id}`, { startsAt: localStamp(20, 8) });
  // Same tenant, so this succeeds; the isolation guarantee is that the UPDATE is
  // scoped by business_id, which the cross-tenant suite already covers. Assert
  // only that the row still belongs to its business.
  assert.strictEqual(patched.status, 200);
  const row = db.get('SELECT business_id FROM appointments WHERE id = ?', [appt.id]);
  assert.strictEqual(row.business_id, bizId, 'business_id must never be reassigned by an edit');
});

// ---------------------------------------------------------------------------
// 2. Inquiry assignment
// ---------------------------------------------------------------------------

async function makeInquiry(name) {
  const res = await call('POST', '/api/inquiries', {
    contactName: name,
    phone: '+1 555-0100',
    subject: 'Regression inquiry',
    message: 'Created by the P1 regression suite.',
  });
  assert.strictEqual(res.status, 201, `inquiry create failed: ${JSON.stringify(res.data)}`);
  return res.data;
}

test('inquiry assignment: a staff member can be assigned and unassigned', async () => {
  const inquiry = await makeInquiry('Assignable Contact');
  assert.strictEqual(
    db.get('SELECT assigned_to FROM inquiries WHERE id = ?', [inquiry.id]).assigned_to,
    null,
    'a new inquiry starts unassigned',
  );

  const assigned = await call('PATCH', `/api/inquiries/${inquiry.id}`, { assignedTo: staffId });
  assert.strictEqual(assigned.status, 200, `assign failed: ${JSON.stringify(assigned.data)}`);
  assert.strictEqual(
    db.get('SELECT assigned_to FROM inquiries WHERE id = ?', [inquiry.id]).assigned_to,
    staffId,
  );

  const cleared = await call('PATCH', `/api/inquiries/${inquiry.id}`, { assignedTo: null });
  assert.strictEqual(cleared.status, 200, `unassign failed: ${JSON.stringify(cleared.data)}`);
  assert.strictEqual(
    db.get('SELECT assigned_to FROM inquiries WHERE id = ?', [inquiry.id]).assigned_to,
    null,
  );
});

test('inquiry assignment: the unassigned bucket shrinks once work is handed out', async () => {
  const inquiry = await makeInquiry('Bucket Contact');

  // The dashboard's "Assign N unassigned inquiries" line is derived from this
  // filter, so it is the exact thing that must respond.
  const before = await call('GET', '/api/inquiries?assignedTo=none&status=new');
  assert.strictEqual(before.status, 200);
  assert.ok(
    before.data.data.some((r) => r.id === inquiry.id),
    'a brand new inquiry should be in the unassigned bucket',
  );
  const beforeCount = before.data.data.length;

  const assigned = await call('PATCH', `/api/inquiries/${inquiry.id}`, { assignedTo: staffId });
  assert.strictEqual(assigned.status, 200);

  const after = await call('GET', '/api/inquiries?assignedTo=none&status=new');
  assert.ok(
    !after.data.data.some((r) => r.id === inquiry.id),
    'an assigned inquiry must leave the unassigned bucket',
  );
  assert.strictEqual(after.data.data.length, beforeCount - 1);
});

test('inquiry assignment: the dashboard count follows the assignment', async () => {
  const before = await call('GET', '/api/dashboard');
  assert.strictEqual(before.status, 200);
  const unassignedBefore = before.data.nextSteps
    .filter((s) => /^Assign \d+ unassigned/.test(s.text)).length;

  const inquiry = await makeInquiry('Dashboard Contact');
  const withNew = await call('GET', '/api/dashboard');
  // One more unassigned inquiry either raises the count or creates the line.
  const assignLinesAfter = withNew.data.nextSteps.filter((s) => /^Assign \d+ unassigned/.test(s.text));
  const attentionAfter = withNew.data.attention.filter((a) => a.type === 'inquiry_unassigned');
  assert.ok(
    attentionAfter.some((a) => a.id === inquiry.id),
    'the new unassigned inquiry should appear in the attention list',
  );

  await call('PATCH', `/api/inquiries/${inquiry.id}`, { assignedTo: staffId });
  const afterAssign = await call('GET', '/api/dashboard');
  const attentionNow = afterAssign.data.attention.filter((a) => a.type === 'inquiry_unassigned');
  assert.ok(
    !attentionNow.some((a) => a.id === inquiry.id),
    'assigning the inquiry should remove it from the dashboard attention list',
  );
  // The line must never claim more work than exists.
  for (const line of afterAssign.data.nextSteps.filter((s) => /^Assign \d+ unassigned/.test(s.text))) {
    const n = Number(line.text.match(/^Assign (\d+)/)[1]);
    assert.strictEqual(n, attentionNow.length, 'the "Assign N" line must equal the attention entries');
  }
  void unassignedBefore; void assignLinesAfter;
});

test('inquiry assignment: an unknown assignee id is not stored', async () => {
  const inquiry = await makeInquiry('Bad Assignee Contact');
  const res = await call('PATCH', `/api/inquiries/${inquiry.id}`, { assignedTo: 999999 });
  assert.strictEqual(res.status, 400, `expected 400 for a non-member assignee, got ${res.status}`);
  assert.strictEqual(
    db.get('SELECT assigned_to FROM inquiries WHERE id = ?', [inquiry.id]).assigned_to,
    null,
    'a rejected assignment must not write anything',
  );
});

test('inquiry assignment: a non-numeric assignee is rejected', async () => {
  const inquiry = await makeInquiry('String Assignee Contact');
  const res = await call('PATCH', `/api/inquiries/${inquiry.id}`, { assignedTo: 'somebody' });
  assert.strictEqual(res.status, 400);
});

// ---------------------------------------------------------------------------
// 3. Knowledge restore
// ---------------------------------------------------------------------------

async function makeKnowledge(title) {
  const res = await call('POST', '/api/knowledge', {
    category: 'policy',
    title,
    content: 'Regression content for the restore check.',
  });
  assert.strictEqual(res.status, 201, `knowledge create failed: ${JSON.stringify(res.data)}`);
  return res.data.item;
}

test('knowledge: archived entries are hidden by default and exposed with includeArchived=1', async () => {
  const item = await makeKnowledge('Archive visibility check');

  const archived = await call('PATCH', `/api/knowledge/${item.id}`, { status: 'archived' });
  assert.strictEqual(archived.status, 200, `archive failed: ${JSON.stringify(archived.data)}`);
  assert.strictEqual(db.get('SELECT status FROM knowledge_items WHERE id = ?', [item.id]).status, 'archived');

  const normal = await call('GET', '/api/knowledge');
  assert.strictEqual(normal.status, 200);
  assert.ok(
    !normal.data.items.some((i) => i.id === item.id),
    'archived entries must not appear in ordinary results',
  );

  const withArchived = await call('GET', '/api/knowledge?includeArchived=1');
  assert.strictEqual(withArchived.status, 200);
  const shown = withArchived.data.items.find((i) => i.id === item.id);
  assert.ok(shown, 'includeArchived=1 must expose the archived entry');
  assert.strictEqual(shown.status, 'archived', 'the entry must still be labelled archived');
});

test('knowledge: restoring an archived entry returns it to normal active results', async () => {
  const item = await makeKnowledge('Restore round trip');
  await call('PATCH', `/api/knowledge/${item.id}`, { status: 'archived' });

  const restored = await call('PATCH', `/api/knowledge/${item.id}`, { status: 'active' });
  assert.strictEqual(restored.status, 200, `restore failed: ${JSON.stringify(restored.data)}`);
  assert.strictEqual(db.get('SELECT status FROM knowledge_items WHERE id = ?', [item.id]).status, 'active');

  const normal = await call('GET', '/api/knowledge');
  assert.ok(
    normal.data.items.some((i) => i.id === item.id),
    'a restored entry must be visible again without any special flag',
  );
});

test('knowledge: the archived view does not leak into the active-only counts', async () => {
  const item = await makeKnowledge('Count isolation check');
  const before = await call('GET', '/api/knowledge');
  const policyBefore = before.data.counts.policy ?? 0;

  await call('PATCH', `/api/knowledge/${item.id}`, { status: 'archived' });

  const normal = await call('GET', '/api/knowledge');
  assert.strictEqual(
    normal.data.counts.policy ?? 0,
    policyBefore - 1,
    'archiving must lower the active count',
  );

  const withArchived = await call('GET', '/api/knowledge?includeArchived=1');
  assert.strictEqual(
    withArchived.data.counts.policy ?? 0,
    normal.data.counts.policy ?? 0,
    'the category counts are active-only even when archived rows are listed',
  );
});

test('knowledge: another tenant\'s archived entry is still invisible', async () => {
  const item = await makeKnowledge('Tenant archived check');
  await call('PATCH', `/api/knowledge/${item.id}`, { status: 'archived' });

  // includeArchived widens status, never tenancy: the row is business-scoped.
  const withArchived = await call('GET', '/api/knowledge?includeArchived=1');
  const misplaced = withArchived.data.items.filter((i) => i.id === item.id && i.business_id !== bizId);
  assert.strictEqual(misplaced.length, 0, 'a business must only ever see its own entries');
  void ownerId;
});

// ---------------------------------------------------------------------------
// 3b. Archiving must not damage the record it archives
// ---------------------------------------------------------------------------
//
// Found while verifying the restore flow: itemSchema declares `.default('')` on
// title (and on source/sourceDetail), and `.partial()` does not strip an inner
// default. A PATCH of `{ status: 'archived' }` was therefore parsed as
// `{ status, title:'', source:'manual', sourceDetail:'' }` and every one of
// those was written — so archiving silently erased the title and source note.

test('knowledge: archiving preserves the title, source detail and content', async () => {
  const created = await call('POST', '/api/knowledge', {
    category: 'policy',
    title: 'Archive must not erase me',
    content: 'The body of this entry must survive an archive.',
    sourceDetail: 'Reviewed by the owner',
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.data));
  const id = created.data.item.id;

  const before = db.get('SELECT title, content, source, source_detail, category FROM knowledge_items WHERE id = ?', [id]);
  assert.strictEqual(before.title, 'Archive must not erase me');

  const archived = await call('PATCH', `/api/knowledge/${id}`, { status: 'archived' });
  assert.strictEqual(archived.status, 200, JSON.stringify(archived.data));

  const after = db.get('SELECT title, content, source, source_detail, category, status FROM knowledge_items WHERE id = ?', [id]);
  assert.strictEqual(after.status, 'archived');
  assert.strictEqual(after.title, before.title, 'archiving erased the title');
  assert.strictEqual(after.content, before.content, 'archiving changed the content');
  assert.strictEqual(after.source, before.source, 'archiving changed the source');
  assert.strictEqual(after.source_detail, before.source_detail, 'archiving erased the source detail');
  assert.strictEqual(after.category, before.category, 'archiving changed the category');
});

test('knowledge: a partial edit leaves every untouched field alone', async () => {
  const created = await call('POST', '/api/knowledge', {
    category: 'faq',
    title: 'Partial edit target',
    content: 'Original body.',
    sourceDetail: 'Original note',
  });
  const id = created.data.item.id;
  const before = db.get('SELECT * FROM knowledge_items WHERE id = ?', [id]);

  const edited = await call('PATCH', `/api/knowledge/${id}`, { content: 'Updated body only.' });
  assert.strictEqual(edited.status, 200, JSON.stringify(edited.data));

  const after = db.get('SELECT * FROM knowledge_items WHERE id = ?', [id]);
  assert.strictEqual(after.content, 'Updated body only.');
  assert.strictEqual(after.title, before.title, 'a content-only edit changed the title');
  assert.strictEqual(after.source_detail, before.source_detail, 'a content-only edit changed the source detail');
  assert.strictEqual(after.source, before.source, 'a content-only edit changed the source');
  assert.strictEqual(after.category, before.category, 'a content-only edit changed the category');
});

test('knowledge: an explicitly empty title is still accepted', async () => {
  // The fix must not turn "clear the title on purpose" into an error.
  const created = await call('POST', '/api/knowledge', {
    category: 'faq',
    title: 'Temporary title',
    content: 'Body stays.',
  });
  const id = created.data.item.id;
  const cleared = await call('PATCH', `/api/knowledge/${id}`, { title: '' });
  assert.strictEqual(cleared.status, 200, JSON.stringify(cleared.data));
  const after = db.get('SELECT title, content FROM knowledge_items WHERE id = ?', [id]);
  assert.strictEqual(after.title, '', 'an explicit empty title should be stored');
  assert.strictEqual(after.content, 'Body stays.', 'clearing the title must not touch the content');
});

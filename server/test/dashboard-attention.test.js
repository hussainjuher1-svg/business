/**
 * DASHBOARD ATTENTION + INQUIRY FILTERING.
 *
 * Two things are easy to get subtly wrong here, so both are pinned:
 *
 *  1. "Overdue estimate follow-up" is NOT "expired estimate". An overdue
 *     follow-up is one the owner scheduled and has not chased. An expired
 *     estimate has passed `valid_until`. Counting the second as the first nags
 *     about quotes already sitting with the customer.
 *  2. Attention items must not repeat. The same estimate used to be able to
 *     appear both as "awaiting follow-up" and as a generic estimate entry.
 *
 * Dates are computed from the business-local "today" the dashboard returns, so
 * these tests stay correct in any timezone.
 *
 * Run: node --test server/test/dashboard-attention.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createInstance, openDatabase } = require('./lib/test-instance');

const PORT = 3234;
let inst;
let db;
let cookie = '';
let bizId;
let staffId;

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

/** Shift an ISO date (YYYY-MM-DD) by n days. */
function shift(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function dashboard() {
  const res = await call('GET', '/api/dashboard');
  assert.strictEqual(res.status, 200, `dashboard failed: ${JSON.stringify(res.data)}`);
  return res.data;
}

test.before(async () => {
  inst = await createInstance({ name: 'attention', port: PORT });
  db = openDatabase(inst.dbPath);

  const login = await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'demo1234' });
  assert.strictEqual(login.status, 200, `login failed: ${JSON.stringify(login.data)}`);
  if (login.data.user.mustChangePassword) {
    await call('POST', '/api/auth/change-password', { currentPassword: 'demo1234', newPassword: 'Attention-Test-7' });
    await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'Attention-Test-7' });
  }
  const biz = await call('GET', '/api/business');
  bizId = biz.data.business.id;
  staffId = biz.data.members.find((m) => m.role !== 'owner')?.id ?? null;
  assert.ok(staffId, 'seed data must contain an assignable staff member');
});
test.after(async () => { if (inst) await inst.cleanup(); });

// ---------------------------------------------------------------------------
// Overdue estimate follow-ups
// ---------------------------------------------------------------------------
test('an overdue estimate follow-up is counted; a future one is not', async () => {
  const today = (await dashboard()).today;

  const make = (title, followUpDate, validUntil) => call('POST', '/api/estimates', {
    title, amount: 500, issueDate: today, followUpDate, validUntil,
  });

  const overdue = await make('Overdue chase', shift(today, -3), shift(today, 30));
  const future = await make('Future chase', shift(today, 3), shift(today, 30));
  assert.strictEqual(overdue.status, 201);
  assert.strictEqual(future.status, 201);

  // An estimate only becomes pending once it has been sent.
  for (const id of [overdue.data.id, future.data.id]) {
    await call('PATCH', `/api/estimates/${id}`, { status: 'sent' });
  }

  const d = await dashboard();
  const ids = (d.overdueEstimateFollowUps || []).map((e) => e.id);
  assert.ok(ids.includes(overdue.data.id), 'the past-due follow-up must be listed');
  assert.ok(!ids.includes(future.data.id), 'a future follow-up must not be listed');

  // The count and the list agree.
  assert.strictEqual(d.counts.overdueEstimateFollowUps, (d.overdueEstimateFollowUps || []).length);
});

test('an expired estimate is NOT an overdue follow-up', async () => {
  const today = (await dashboard()).today;

  // Expired, but the chase date is still in the future (or absent).
  const created = await call('POST', '/api/estimates', {
    title: 'Expired but not overdue', amount: 800,
    issueDate: shift(today, -40), validUntil: shift(today, -10), followUpDate: shift(today, 5),
  });
  assert.strictEqual(created.status, 201);
  await call('PATCH', `/api/estimates/${created.data.id}`, { status: 'sent' });

  const d = await dashboard();
  const overdueIds = (d.overdueEstimateFollowUps || []).map((e) => e.id);
  const expiredIds = (d.expiredEstimates || []).map((e) => e.id);

  assert.ok(!overdueIds.includes(created.data.id),
    'an expired estimate with a future follow-up date is not an overdue follow-up');
  assert.ok(expiredIds.includes(created.data.id),
    'it must still be reported, under expiredEstimates');
  assert.strictEqual(d.counts.expiredEstimates, expiredIds.length);
});

test('an estimate with no follow-up date is never overdue', async () => {
  const today = (await dashboard()).today;
  const created = await call('POST', '/api/estimates', {
    title: 'No chase scheduled', amount: 300, issueDate: shift(today, -30), validUntil: shift(today, 30),
  });
  assert.strictEqual(created.status, 201);
  await call('PATCH', `/api/estimates/${created.data.id}`, { status: 'sent' });

  const d = await dashboard();
  assert.ok(!(d.overdueEstimateFollowUps || []).some((e) => e.id === created.data.id),
    'nothing scheduled means nothing can be overdue');
});

test('accepted and declined estimates are never overdue', async () => {
  const today = (await dashboard()).today;
  for (const status of ['accepted', 'declined', 'expired']) {
    const created = await call('POST', '/api/estimates', {
      title: `Settled ${status}`, amount: 100,
      issueDate: shift(today, -20), followUpDate: shift(today, -10),
    });
    await call('PATCH', `/api/estimates/${created.data.id}`, { status });
    const d = await dashboard();
    assert.ok(!(d.overdueEstimateFollowUps || []).some((e) => e.id === created.data.id),
      `${status} estimates are resolved and must not be chased`);
  }
});

test('overdue uses the business-local date, not UTC', async () => {
  // A business far east of UTC is already on the next calendar day. A follow-up
  // dated "tomorrow UTC" is therefore already today, not overdue; one dated
  // "yesterday UTC" is overdue in both. The dashboard's own `today` is the
  // authority, and every comparison must use it.
  const d = await dashboard();
  const today = d.today;
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/, 'the dashboard must report a business-local date');

  for (const e of d.overdueEstimateFollowUps || []) {
    assert.ok(String(e.follow_up_date).slice(0, 10) < today,
      `overdue entry ${e.id} must be strictly before ${today}`);
  }
});

// ---------------------------------------------------------------------------
// Unassigned inquiries
// ---------------------------------------------------------------------------
test('unassigned actionable inquiries are counted; resolved and assigned ones are not', async () => {
  const unassigned = await call('POST', '/api/inquiries', {
    contactName: 'Unassigned Person', phone: '+1 555-202-0001', source: 'phone',
    subject: 'Nobody owns this', message: 'Please help.',
  });
  const assigned = await call('POST', '/api/inquiries', {
    contactName: 'Assigned Person', phone: '+1 555-202-0002', source: 'phone',
    subject: 'Owned', message: 'Assigned already.',
  });
  const resolved = await call('POST', '/api/inquiries', {
    contactName: 'Resolved Person', phone: '+1 555-202-0003', source: 'phone',
    subject: 'Done and dusted', message: 'Already handled.',
  });
  assert.strictEqual(unassigned.status, 201);

  await call('PATCH', `/api/inquiries/${assigned.data.id}`, { assignedTo: staffId });
  await call('PATCH', `/api/inquiries/${resolved.data.id}`, { status: 'converted' });

  const d = await dashboard();
  const ids = (d.unassignedInquiries || []).map((i) => i.id);
  assert.ok(ids.includes(unassigned.data.id), 'the unassigned, actionable inquiry must be listed');
  assert.ok(!ids.includes(assigned.data.id), 'an assigned inquiry must not be listed');
  assert.ok(!ids.includes(resolved.data.id), 'a converted inquiry is no longer actionable');
  assert.strictEqual(d.counts.unassignedInquiries, ids.length);
});

// ---------------------------------------------------------------------------
// No duplicate attention entries
// ---------------------------------------------------------------------------
test('the same underlying problem is never listed twice', async () => {
  const d = await dashboard();
  const seen = new Set();
  for (const a of d.attention || []) {
    const key = `${a.type}:${a.id}`;
    assert.ok(!seen.has(key), `duplicate attention entry ${key}`);
    seen.add(key);
  }

  // An estimate must not also appear under the generic estimate heading.
  const overdueIds = new Set((d.overdueEstimateFollowUps || []).map((e) => e.id));
  const generic = (d.attention || []).filter((a) => a.type === 'estimate').map((a) => a.id);
  for (const id of generic) {
    assert.ok(!overdueIds.has(id), `estimate ${id} appears both as overdue and as generic pending`);
  }

  // Nor may an unassigned inquiry also appear under "new inquiry".
  const unassignedIds = new Set((d.unassignedInquiries || []).map((i) => i.id));
  const newInquiryIds = (d.attention || []).filter((a) => a.type === 'inquiry').map((a) => a.id);
  for (const id of newInquiryIds) {
    assert.ok(!unassignedIds.has(id), `inquiry ${id} appears both as unassigned and as new`);
  }
});

test('next-steps counts partition the work instead of double-counting it', async () => {
  const d = await dashboard();
  const steps = (d.nextSteps || []).map((x) => x.text);
  const overdue = d.counts.overdueEstimateFollowUps;

  // Read the numbers back out of the sentences and check they add up rather than
  // overlapping. An overdue estimate is also "pending", so before the fix the
  // same quote appeared in both lines.
  const num = (re) => {
    const m = steps.join(' | ').match(re);
    return m ? Number(m[1]) : 0;
  };
  const chase = num(/Chase (\d+) overdue estimate/);
  const pending = num(/Follow up on (\d+) pending estimate/);

  assert.strictEqual(chase, overdue, 'the overdue line must report the overdue set');
  assert.ok(chase + pending <= d.counts.pendingEstimates,
    `chase(${chase}) + pending(${pending}) must not exceed the pending total (${d.counts.pendingEstimates})`);
  if (overdue > 0) {
    assert.strictEqual(chase + pending, d.counts.pendingEstimates,
      'every pending estimate must be counted exactly once across the two lines');
  }

  const assign = num(/Assign (\d+) unassigned/);
  const respond = num(/Respond to (\d+) new/);
  assert.strictEqual(assign, d.counts.unassignedInquiries);

  // The two inquiry lines cover different, overlapping sets: "unassigned" spans
  // every actionable status, "new" spans only new/needs_response. An inquiry that
  // is both must be counted once, under "unassigned" only. Reconstruct the
  // overlap from the rows and check the arithmetic closes.
  const unassignedIds = new Set((d.unassignedInquiries || []).map((i) => i.id));
  const newUnassigned = (d.attention || [])
    .filter((a) => a.type === 'inquiry' && unassignedIds.has(a.id)).length;
  assert.strictEqual(newUnassigned, 0,
    'no inquiry may be listed as both unassigned and new');
  assert.strictEqual(respond + (d.counts.newInquiries - respond),
    d.counts.newInquiries,
    'sanity: the new-inquiry total is internally consistent');
  assert.ok(respond <= d.counts.newInquiries,
    `respond(${respond}) cannot exceed the new-inquiry total (${d.counts.newInquiries})`);
});

test('attention items carry the required shapes and links', async () => {
  const d = await dashboard();
  for (const a of d.attention || []) {
    assert.ok(a.type && a.id && a.title, `attention item missing fields: ${JSON.stringify(a)}`);
    assert.ok(typeof a.link === 'string' && a.link.startsWith('/'), `attention item needs a link: ${JSON.stringify(a)}`);
  }
  const overdue = (d.attention || []).filter((a) => a.type === 'estimate_follow_up_overdue');
  for (const a of overdue) assert.match(a.title, /overdue/i, 'the title must say it is overdue');
  const unassigned = (d.attention || []).filter((a) => a.type === 'inquiry_unassigned');
  for (const a of unassigned) assert.match(a.title, /unassigned/i);
});

// ---------------------------------------------------------------------------
// Inquiry filtering
// ---------------------------------------------------------------------------
test('assignedTo=none returns only unassigned inquiries', async () => {
  const res = await call('GET', '/api/inquiries?assignedTo=none');
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.data.length > 0, 'expected at least one unassigned inquiry');
  for (const row of res.data.data) {
    assert.ok(row.assigned_to === null || row.assigned_to === undefined,
      `inquiry ${row.id} is assigned to ${row.assigned_to}`);
  }
  assert.strictEqual(res.data.filters.assignedTo, 'none');
});

test('assignedTo=<staffId> returns only that person\'s inquiries', async () => {
  const mine = await call('POST', '/api/inquiries', {
    contactName: 'Mine To Handle', phone: '+1 555-303-0001', source: 'email',
    subject: 'For the technician', message: 'Assigned to staff.',
  });
  await call('PATCH', `/api/inquiries/${mine.data.id}`, { assignedTo: staffId });

  const res = await call('GET', `/api/inquiries?assignedTo=${staffId}`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.data.length > 0, 'expected at least one assigned inquiry');
  for (const row of res.data.data) assert.strictEqual(row.assigned_to, staffId);
  assert.ok(res.data.data.some((r) => r.id === mine.data.id), 'the assigned inquiry must be present');
  assert.strictEqual(res.data.filters.assignedTo, staffId);
});

test('assignment filter composes with status, search and pagination', async () => {
  const unassignedOpen = await call('POST', '/api/inquiries', {
    contactName: 'Compose Target', phone: '+1 555-303-0002', source: 'web',
    subject: 'Boiler making a knocking noise', message: 'Knocking sound from the boiler.',
  });
  assert.strictEqual(unassignedOpen.status, 201);

  // assignment + search
  const search = await call('GET', '/api/inquiries?assignedTo=none&search=knocking');
  const ids = search.data.data.map((r) => r.id);
  assert.ok(ids.includes(unassignedOpen.data.id), 'search must narrow within the unassigned set');
  for (const row of search.data.data) {
    assert.ok(row.assigned_to === null || row.assigned_to === undefined);
    assert.match(`${row.subject} ${row.message}`.toLowerCase(), /knocking/);
  }

  // assignment + status
  await call('PATCH', `/api/inquiries/${unassignedOpen.data.id}`, { status: 'estimate_requested' });
  const byStatus = await call('GET', '/api/inquiries?assignedTo=none&status=estimate_requested');
  assert.ok(byStatus.data.data.every((r) => r.status === 'estimate_requested' && r.assigned_to === null),
    'status filter must compose with assignment filter');
  assert.ok(byStatus.data.data.some((r) => r.id === unassignedOpen.data.id));

  // assignment + pagination
  const page1 = await call('GET', '/api/inquiries?assignedTo=none&limit=1&offset=0');
  const page2 = await call('GET', '/api/inquiries?assignedTo=none&limit=1&offset=1');
  assert.strictEqual(page1.data.data.length, 1);
  assert.strictEqual(page1.data.limit, 1);
  assert.ok(page1.data.total >= 2, 'need at least two unassigned inquiries for this check');
  assert.notStrictEqual(page1.data.data[0].id, page2.data.data[0].id,
    'consecutive pages must not repeat a row');
  assert.ok(page1.data.total === page2.data.total, 'total must describe the filtered set, not the page');
});

test('an invalid assignedTo value is rejected, not silently ignored', async () => {
  const res = await call('GET', '/api/inquiries?assignedTo=whoever');
  assert.strictEqual(res.status, 400, 'a bad filter must be an error, not a no-op');
  assert.match(String(res.data.error), /assignedTo/i);
});

test('filters never cross a business boundary', async () => {
  const d = await dashboard();
  for (const row of [...(d.unassignedInquiries || []), ...(d.overdueEstimateFollowUps || [])]) {
    assert.strictEqual(row.business_id, bizId, `row ${row.id} leaked from another business`);
  }
  const res = await call('GET', '/api/inquiries?assignedTo=none');
  for (const row of res.data.data) assert.strictEqual(row.business_id, bizId);
});

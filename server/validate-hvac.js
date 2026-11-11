/**
 * PILOT VALIDATION HARNESS — runs 30 assistant questions against the fictional
 * HVAC demo business and checks each answer against the database.
 *
 * This is a validation instrument, not a unit test: it prints a full transcript
 * with pass/fail per assertion so a human can audit what actually happened.
 *
 * ISOLATION: runs against its own temporary database and its own server on
 * port 3201. The development database (data/daybook.db) is never opened,
 * seeded, or modified by this harness.
 *
 * Run: node server/validate-hvac.js
 */
const { createInstance } = require('./test/lib/test-instance');

const PORT = 3201;
let BASE = `http://127.0.0.1:${PORT}`;
let cookie = '';

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const ask = (message, conversationId) =>
  api('POST', '/api/assistant/chat', { message, conversationId });

// The question bank lives in one place so the deterministic harness and the
// real-model evaluation runner cannot drift apart.
const { CASES } = require('./validate-hvac-cases');

function checkCase(c, res) {
  // `res` is already the parsed response body ({answer, sources, mode, ...}).
  const answer = res?.answer || '';
  const sources = res?.sources || [];
  const failures = [];
  const notFound = (re) => !re.test(answer);

  for (const re of c.must || []) {
    if (notFound(re)) failures.push(`missing required ${re}`);
  }
  for (const re of c.mustNot || []) {
    if (re.test(answer)) failures.push(`contains forbidden ${re}`);
  }
  if (c.expectSources && sources.length === 0) failures.push('no sources cited');
  if (/undefined|\[object Object\]|NaN/.test(answer)) failures.push('malformed answer');
  if (!answer || answer.trim().length < 5) failures.push('empty answer');
  return { answer, sources, failures };
}

async function main() {
  const instance = await createInstance({ name: 'validate-hvac', port: PORT });
  BASE = instance.baseUrl;
  console.log(`Test database: ${instance.dbPath}`);

  // The seeded demo account is gated behind a forced password change
  // (release blocker #3). Rotate it the way the product requires, then log in.
  const { adoptDemoAccount } = require('./test/lib/demo-fixture');
  const hvacPassword = await adoptDemoAccount(BASE, 'hvac@daybook.local', 'hvac');
  const login = await api('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: hvacPassword });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.data)}`);

  const status = await api('GET', '/api/assistant/status');

  // Resolve the live customer count so case 19 asserts truth, not a fixture.
  const dash = await api('GET', '/api/dashboard');
  const liveCustomers = dash.data?.counts?.totalCustomers;
  for (const c of CASES) {
    if (c.id === 19) {
      c.must = [new RegExp(`\\b${liveCustomers}\\b`)];
      c.label = `must state the live count (${liveCustomers})`;
    }
  }
  const lines = [];
  const log = (s = '') => { lines.push(s); console.log(s); };

  log('='.repeat(78));
  log('DAYBOOK PILOT VALIDATION — FICTIONAL HVAC BUSINESS');
  log('='.repeat(78));
  log(`Business: ${login.data.businesses[0]?.business_name}`);
  log(`Local model available: ${status.data?.model?.available}  (provider: ${status.data?.provider})`);
  log(`Model problem: ${status.data?.model?.problem || 'none'}`);
  log('');

  let pass = 0;
  let fail = 0;
  const failures = [];
  const modes = {};

  for (const c of CASES) {
    let res = await ask(c.q);
    if (c.followUpTo) {
      const first = await ask(c.followUpTo);
      res = await api('POST', '/api/assistant/chat', {
        message: c.q, conversationId: first.data?.conversationId,
      });
    }

    const { answer, sources, failures: f } = checkCase(c, res.data || {});
    const mode = res.data?.mode || 'error';
    modes[mode] = (modes[mode] || 0) + 1;

    if (f.length === 0) { pass++; log(`PASS  [${String(c.id).padStart(2)}] ${c.group.padEnd(11)} ${c.q}`); }
    else {
      fail++;
      failures.push({ id: c.id, q: c.q, failures: f, answer });
      log(`FAIL  [${String(c.id).padStart(2)}] ${c.group.padEnd(11)} ${c.q}`);
      for (const x of f) log(`        · ${x}`);
    }
    log(`        mode=${mode} sources=${sources.length}${sources.length ? ` titles=${sources.slice(0, 3).map((s) => (s.title || '').slice(0, 30)).join(' | ')}` : ''}`);
    if (process.env.VERBOSE) log(`        answer: ${answer.replace(/\n+/g, ' ').slice(0, 400)}`);
    log('');
  }

  log('='.repeat(78));
  log(`RESULT: ${pass} passed, ${fail} failed, of ${CASES.length} questions`);
  log(`Answer modes observed: ${JSON.stringify(modes)}`);
  log('='.repeat(78));

  if (failures.length) {
    log('');
    log('FAILURE DETAIL');
    log('-'.repeat(78));
    for (const f of failures) {
      log(`[${f.id}] ${f.q}`);
      for (const x of f.failures) log(`   · ${x}`);
      log(`   answer: ${f.answer.replace(/\n+/g, ' ').slice(0, 600)}`);
      log('');
    }
  }

  await instance.cleanup();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(2);
});

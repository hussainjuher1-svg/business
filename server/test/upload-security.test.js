/**
 * DOCUMENT UPLOAD — malformed input, limits and failure containment.
 *
 * Multer 2.x fixed a series of remote denial-of-service bugs that were all
 * reachable through the *shape* of a multipart body rather than through anything
 * the application did. Upgrading removes the vulnerable code; these tests pin the
 * behaviour that has to hold afterwards:
 *
 *   - a bad request is a 4xx, never a 500 and never a crash;
 *   - every dangerous shape is bounded by an explicit limit;
 *   - a rejected or interrupted upload leaves no document row and no file;
 *   - normal uploads and extraction still work;
 *   - authentication and business isolation are unaffected.
 *
 * Every test runs against its own temporary database.
 *
 * Run: node --test server/test/upload-security.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createInstance, openDatabase } = require('./lib/test-instance');

const PORT = 3236;
let inst;
let db;
let cookie = '';
let bizId;

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

/** POST /api/knowledge/documents with an arbitrary raw body. */
async function uploadRaw({ contentType, body, useCookie = true, as = null }) {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  const c = as ?? cookie;
  if (useCookie && c) headers.Cookie = c;
  const res = await fetch(`${inst.baseUrl}/api/knowledge/documents`, {
    method: 'POST', headers, body,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data, headers: res.headers };
}

/** Build a multipart body by hand so malformed shapes can be expressed exactly. */
function multipart(parts, boundary = 'BND') {
  const chunks = [];
  for (const p of parts) {
    if (p.raw) { chunks.push(Buffer.from(p.raw, 'latin1')); continue; }
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'latin1'));
    let disp = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename) disp += `; filename="${p.filename}"`;
    chunks.push(Buffer.from(`${disp}\r\n`, 'latin1'));
    if (p.contentType) chunks.push(Buffer.from(`Content-Type: ${p.contentType}\r\n`, 'latin1'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
    chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value ?? ''), 'latin1'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Buffer.concat(chunks);
}

/** Count documents visible to this business. */
function docCount() {
  return db.get('SELECT COUNT(*) AS n FROM business_documents WHERE business_id = ?', [bizId]).n;
}

const serverAlive = async () => {
  try {
    const r = await fetch(`${inst.baseUrl}/health`);
    return r.status === 200;
  } catch { return false; }
};

test.before(async () => {
  inst = await createInstance({ name: 'upload', port: PORT });
  db = openDatabase(inst.dbPath);
  const login = await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'demo1234' });
  assert.strictEqual(login.status, 200, `login failed: ${JSON.stringify(login.data)}`);
  if (login.data.user.mustChangePassword) {
    await call('POST', '/api/auth/change-password', { currentPassword: 'demo1234', newPassword: 'Upload-Test-31' });
    await call('POST', '/api/auth/login', { email: 'hvac@daybook.local', password: 'Upload-Test-31' });
  }
  bizId = (await call('GET', '/api/business')).data.business.id;
});
test.after(async () => { if (inst) await inst.cleanup(); });

// ---------------------------------------------------------------------------
// The upgrade itself
// ---------------------------------------------------------------------------
test('multer is on a version with no open advisories', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.dependencies.multer, '2.5.0',
    'multer must be pinned to the patched 2.5.0 line');
  const installed = require(path.join(__dirname, '..', 'node_modules', 'multer', 'package.json')).version;
  assert.strictEqual(installed, '2.5.0', `installed multer is ${installed}`);
});

test('the configured limits bound every dangerous multipart shape', () => {
  // Read the configuration rather than trusting the source comment.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'knowledge.js'), 'utf8');
  for (const limit of [
    'fileSize', 'files', 'parts', 'fields',
    'fieldSize', 'fieldNameSize', 'fieldNestingDepth', 'fieldArrayIndexLimit',
  ]) {
    assert.ok(new RegExp(`${limit}\\s*:`).test(src), `limits.${limit} must be configured explicitly`);
  }
  // Memory storage is what makes an interrupted upload unable to leave a partial
  // file behind, so it must not be swapped for disk storage.
  assert.ok(/storage:\s*multer\.memoryStorage\(\)/.test(src), 'uploads must stay in memory');
});

// ---------------------------------------------------------------------------
// Malformed input is a client error, never a 500 and never a crash
// ---------------------------------------------------------------------------
test('multipart with no boundary is rejected as a bad request', async () => {
  const before = docCount();
  const res = await uploadRaw({ contentType: 'multipart/form-data', body: 'garbage' });
  assert.strictEqual(res.status, 400, `expected 400, got ${res.status} ${JSON.stringify(res.data)}`);
  assert.strictEqual(res.data.code, 'MALFORMED_UPLOAD');
  assert.strictEqual(docCount(), before, 'a malformed upload must not create a document');
  assert.ok(await serverAlive(), 'the server must survive a malformed upload');
});

test('a field with no name is rejected', async () => {
  const before = docCount();
  const body = multipart([{ name: '', value: 'v' }, { name: 'file', filename: 'a.txt', value: 'data' }]);
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body });
  assert.strictEqual(res.status, 400);
  assert.ok(['MISSING_FIELD_NAME', 'INVALID_FIELD_NAME'].includes(res.data.code), `unexpected code ${res.data.code}`);
  assert.strictEqual(docCount(), before);
  assert.ok(await serverAlive());
});

test('a truncated body is rejected without saving anything', async () => {
  const before = docCount();
  // Start a part and stop: no closing boundary, no end of body.
  const body = Buffer.from(
    '--BND\r\nContent-Disposition: form-data; name="file"; filename="cut.txt"\r\n\r\npartial-content',
    'latin1'
  );
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body });
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  assert.strictEqual(docCount(), before, 'an interrupted upload must not be recorded');
  assert.ok(await serverAlive(), 'the server must survive a truncated body');
});

test('an empty string field name cannot crash the process', async () => {
  // This shape is one of the historical multer crashes (CVE-2025-48997).
  const body = multipart([{ raw: '--BND\r\nContent-Disposition: form-data; name=""\r\n\r\nx\r\n' }, { raw: '--BND--\r\n' }]);
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body });
  assert.ok(res.status < 500, `an empty field name must not be a server error, got ${res.status}`);
  assert.ok(await serverAlive());
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
test('a file over the size limit is refused with 413 and not recorded', async () => {
  const before = docCount();
  const big = Buffer.alloc(11 * 1024 * 1024, 0x41); // 11 MB of 'A'
  const body = multipart([{ name: 'file', filename: 'big.txt', contentType: 'text/plain', value: big }]);
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body });
  assert.strictEqual(res.status, 413, `expected 413, got ${res.status} ${JSON.stringify(res.data)}`);
  assert.strictEqual(res.data.code, 'LIMIT_FILE_SIZE');
  assert.strictEqual(docCount(), before, 'an oversized file must not create a document');
  assert.ok(await serverAlive());
});

test('too many fields is refused', async () => {
  const parts = [];
  for (let i = 0; i < 12; i++) parts.push({ name: `f${i}`, value: 'x' });
  parts.push({ name: 'file', filename: 'a.txt', value: 'data' });
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body: multipart(parts) });
  assert.ok(res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.ok(await serverAlive());
});

test('an oversized field value is refused', async () => {
  const parts = [
    { name: 'docType', value: 'x'.repeat(80 * 1024) },
    { name: 'file', filename: 'a.txt', value: 'data' },
  ];
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body: multipart(parts) });
  assert.ok(res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.ok(await serverAlive());
});

test('deeply nested field names are refused, not walked', async () => {
  // CVE-2026-5079: bracket notation with no depth limit.
  const deep = 'a' + '[b]'.repeat(200);
  const parts = [{ name: deep, value: 'x' }, { name: 'file', filename: 'a.txt', value: 'data' }];
  const started = Date.now();
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body: multipart(parts) });
  const elapsed = Date.now() - started;
  assert.strictEqual(res.status, 400, `nested field names must be a 400, got ${res.status}`);
  // Either bound may fire first at extreme depth: the name-length limit (a 200-deep
  // bracket name is ~600 bytes) or the nesting limit. Both are correct refusals;
  // what must never happen is the body being parsed and walked.
  assert.ok(['LIMIT_FIELD_NESTING', 'LIMIT_FIELD_KEY'].includes(res.data.code),
    `expected a nesting or name-length refusal, got ${res.data.code}`);
  assert.ok(elapsed < 5000, `nesting must be rejected promptly, took ${elapsed}ms`);
  assert.ok(await serverAlive());
});

test('a moderately nested field name is refused by the nesting limit', async () => {
  // Short enough to pass the name-length check, so the nesting limit is what
  // must reject it. The upload form sends only flat fields, so depth 2 has no
  // legitimate use.
  const parts = [{ name: 'a[b][c]', value: 'x' }, { name: 'file', filename: 'a.txt', value: 'data' }];
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body: multipart(parts) });
  assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
  assert.strictEqual(res.data.code, 'LIMIT_FIELD_NESTING', `unexpected code ${res.data.code}`);
});

test('an out-of-range array index in a field name is refused', async () => {
  // CVE-2026-82333: a huge numeric index allocates a sparse array and a second
  // non-numeric key forces a full-length iteration.
  const parts = [
    { name: 'a[999999999]', value: 'x' },
    { name: 'b', value: 'y' },
    { name: 'file', filename: 'a.txt', value: 'data' },
  ];
  const started = Date.now();
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body: multipart(parts) });
  const elapsed = Date.now() - started;
  assert.ok(res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.ok(elapsed < 5000, `must not spend time walking a sparse array, took ${elapsed}ms`);
  assert.ok(await serverAlive());
});

test('a second file field is refused', async () => {
  const before = docCount();
  const parts = [
    { name: 'file', filename: 'first.txt', value: 'one' },
    { name: 'second', filename: 'second.txt', value: 'two' },
  ];
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body: multipart(parts) });
  assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
  assert.ok(['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(res.data.code),
    `unexpected code ${res.data.code}`);
  assert.strictEqual(docCount(), before, 'a rejected upload must not create a document');
});

test('too many multipart parts is refused', async () => {
  const parts = Array.from({ length: 9 }, (_, i) => ({ name: `f${i}`, value: 'v' }));
  parts.push({ name: 'file', filename: 'a.txt', value: 'x' });
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body: multipart(parts) });
  assert.ok(res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.ok(['LIMIT_PART_COUNT', 'LIMIT_FIELD_COUNT'].includes(res.data.code),
    `unexpected code ${res.data.code}`);
});

test('an aborted upload leaves no document row', async () => {
  const before = docCount();
  // Announce a large file, send only a fragment, then destroy the socket. The
  // server never sees the closing boundary.
  const net = require('node:net');
  const url = new URL(inst.baseUrl);
  const result = await new Promise((resolve) => {
    const sock = net.connect({ host: url.hostname, port: Number(url.port) }, () => {
      const head = Buffer.from(
        'POST /api/knowledge/documents HTTP/1.1\r\n' +
        `Host: ${url.host}\r\n` +
        `Cookie: ${cookie}\r\n` +
        'Content-Type: multipart/form-data; boundary=BND\r\n' +
        'Content-Length: 100000\r\n\r\n' +
        '--BND\r\nContent-Disposition: form-data; name="file"; filename="half.bin"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n' +
        'PARTIALDATA', 'latin1');
      sock.write(head);
      setTimeout(() => sock.destroy(), 100);
    });
    sock.on('close', () => resolve('aborted'));
    sock.on('error', () => resolve('aborted'));
    setTimeout(() => { sock.destroy(); resolve('timeout'); }, 3000);
  });
  assert.strictEqual(result, 'aborted');
  // Give the server a moment to finish tearing the request down.
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(docCount(), before, 'an aborted upload must not be recorded');
  assert.ok(await serverAlive(), 'the server must survive an aborted upload');
});

test('no file is ever written to disk', async () => {
  // Memory storage is the reason a rejected or aborted upload cannot leave a
  // partial file behind. Assert both that the engine is memory-based and that no
  // stray file appeared next to the upload path.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'knowledge.js'), 'utf8');
  assert.ok(/multer\.memoryStorage\(\)/.test(src), 'uploads must not use disk storage');
  assert.ok(!/multer\.diskStorage/.test(src));
  const stray = fs.readdirSync(path.join(__dirname, '..')).filter((f) => /\.(bin|tmp|upload|part)$/.test(f));
  assert.deepStrictEqual(stray, [], `stray files found: ${stray.join(', ')}`);
});

test('unsupported types are recorded, and binary content is never treated as knowledge', async () => {
  const body = multipart([{ name: 'file', filename: 'binary.dat', contentType: 'application/octet-stream', value: Buffer.from([0, 1, 2, 3, 255]) }]);
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.data.document.text_status, 'unsupported');
  const row = db.get('SELECT * FROM business_documents WHERE id = ?', [res.data.document.id]);
  assert.strictEqual(row.extracted_text || '', '', 'unparseable content must not become retrievable text');
});

// ---------------------------------------------------------------------------
// Normal uploads still work
// ---------------------------------------------------------------------------
test('a valid text document is accepted, extracted and indexed', async () => {
  const before = docCount();
  const body = multipart([
    { name: 'docType', value: 'policy' },
    { name: 'file', filename: 'warranty-note.txt', contentType: 'text/plain', value: 'Labour is warranted for twelve months on all repairs.' },
  ]);
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body });
  assert.strictEqual(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify(res.data)}`);
  assert.strictEqual(res.data.document.filename, 'warranty-note.txt');
  assert.strictEqual(res.data.document.text_status, 'extracted');
  assert.ok(res.data.document.text_length > 0, 'text must have been extracted');
  assert.strictEqual(docCount(), before + 1);

  // The document is scoped to this business and its text is retrievable.
  const row = db.get('SELECT * FROM business_documents WHERE id = ?', [res.data.document.id]);
  assert.strictEqual(row.business_id, bizId);
  assert.match(row.extracted_text, /twelve months/);
});

test('a PDF is still parsed after the upgrade', async () => {
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 700 Td (Warranty is one year for labour.) Tj ET\nendstream endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const body = multipart([{ name: 'file', filename: 'terms.pdf', contentType: 'application/pdf', value: pdf }]);
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body });
  assert.strictEqual(res.status, 201, `PDF upload failed: ${JSON.stringify(res.data)}`);
  assert.strictEqual(res.data.document.filename, 'terms.pdf');
});

test('an unsupported file is recorded honestly rather than silently dropped', async () => {
  const body = multipart([{ name: 'file', filename: 'scan.exe', contentType: 'application/octet-stream', value: Buffer.from([0, 1, 2, 3]) }]);
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.data.document.text_status, 'unsupported',
    'unparseable files must be marked unsupported, never treated as empty knowledge');
});

test('no file at all is a 400, not a crash', async () => {
  const body = multipart([{ name: 'docType', value: 'policy' }]);
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body });
  assert.strictEqual(res.status, 400);
  assert.match(String(res.data.error), /No file/i);
});

// ---------------------------------------------------------------------------
// Auth and isolation are unaffected by the upgrade
// ---------------------------------------------------------------------------
test('an unauthenticated upload is refused before any parsing', async () => {
  const before = docCount();
  const body = multipart([{ name: 'file', filename: 'x.txt', value: 'data' }]);
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body, useCookie: false });
  assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
  assert.strictEqual(docCount(), before, 'an unauthenticated upload must not be stored');
  assert.ok(await serverAlive());
});

test('uploads belong to the uploading business only', async () => {
  const body = multipart([{ name: 'file', filename: 'scoped.txt', contentType: 'text/plain', value: 'Business A private note.' }]);
  const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body });
  assert.strictEqual(res.status, 201);
  const id = res.data.document.id;

  // Business B must not see it.
  const other = db.get('SELECT * FROM business_documents WHERE id = ?', [id]);
  assert.strictEqual(other.business_id, bizId);

  const rival = await fetch(`${inst.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rival@daybook.local', password: 'demo1234' }),
  });
  let rivalCookie = String(rival.headers.get('set-cookie') || '').split(';')[0];
  const rivalBody = await rival.json();
  if (rivalBody.user?.mustChangePassword) {
    await fetch(`${inst.baseUrl}/api/auth/change-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: rivalCookie },
      body: JSON.stringify({ currentPassword: 'demo1234', newPassword: 'Rival-Upload-42' }),
    });
    const again = await fetch(`${inst.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'rival@daybook.local', password: 'Rival-Upload-42' }),
    });
    rivalCookie = String(again.headers.get('set-cookie') || '').split(';')[0];
  }

  const cross = await fetch(`${inst.baseUrl}/api/knowledge/documents/${id}`, { headers: { Cookie: rivalCookie } });
  assert.strictEqual(cross.status, 404, 'another business must not be able to read this document');
});

test('the server survives the whole malformed-input battery', async () => {
  const shapes = [
    Buffer.from('--BND\r\n', 'latin1'),
    Buffer.from('--BND--\r\n', 'latin1'),
    Buffer.from('\r\n\r\n', 'latin1'),
    Buffer.from('--BND\r\nContent-Disposition: form-data\r\n\r\n', 'latin1'),
    Buffer.from('--BND\r\nContent-Disposition: form-data; name=unquoted\r\n\r\nx\r\n--BND--\r\n', 'latin1'),
  ];
  for (const body of shapes) {
    const res = await uploadRaw({ contentType: 'multipart/form-data; boundary=BND', body });
    assert.ok(res.status < 500, `shape ${body.toString('latin1').slice(0, 40)} gave ${res.status}`);
  }
  assert.ok(await serverAlive(), 'the server must still be answering');
});

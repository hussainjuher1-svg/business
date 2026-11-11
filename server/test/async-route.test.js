/**
 * ASYNC ROUTE WRAPPER — a rejected promise must reach error middleware.
 *
 * Express 4 does not inspect a handler's return value. An `async` handler that
 * throws produces an unhandled rejection, and on Node 20+ that terminates the
 * process. This is not theoretical: the test below starts a real server with an
 * unwrapped async route and asserts the server process dies.
 *
 * The document-upload route is async and does its real work (extract, index,
 * database writes) *after* the multipart body has been accepted, so a failure
 * there is reachable by an ordinary client. Without a wrapper it is a remote
 * denial of service.
 *
 * Run: node --test server/test/async-route.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const express = require(path.join(__dirname, '..', 'node_modules', 'express'));
const { asyncRoute } = require('../src/upload-errors');

/** HTTP GET that never throws, and times out rather than hanging the suite. */
function request(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ status: 'TIMEOUT' }); });
  });
}

/** Start an app on an ephemeral port and return { port, close }. */
function serve(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

function appWith(routes) {
  const app = express();
  for (const [p, handler] of routes) app.get(p, handler);
  app.use((err, req, res, next) => res.status(500).json({ handled: err.message }));
  return app;
}

test('the wrapper routes a rejected promise to error middleware', async () => {
  const app = appWith([['/throw', asyncRoute(async () => { throw new Error('async boom'); })]]);
  const srv = await serve(app);
  try {
    const res = await request(srv.port, '/throw');
    assert.strictEqual(res.status, 500, `expected the error middleware to run, got ${res.status}`);
    assert.match(res.body, /async boom/, 'the original error must reach the handler');
  } finally { await srv.close(); }
});

test('the wrapper routes a synchronous throw to error middleware', async () => {
  const app = appWith([['/sync', asyncRoute(() => { throw new Error('sync boom'); })]]);
  const srv = await serve(app);
  try {
    const res = await request(srv.port, '/sync');
    assert.strictEqual(res.status, 500);
    assert.match(res.body, /sync boom/);
  } finally { await srv.close(); }
});

test('the wrapper preserves a rejection that carries a code', async () => {
  const app = appWith([['/typed', asyncRoute(async () => {
    const e = new Error('typed boom');
    e.code = 'LIMIT_FIELD_NESTING';
    throw e;
  })]]);
  const srv = await serve(app);
  try {
    const res = await request(srv.port, '/typed');
    assert.strictEqual(res.status, 500);
    assert.match(res.body, /typed boom/);
  } finally { await srv.close(); }
});

test('the wrapper does not change a successful response', async () => {
  const app = appWith([['/ok', asyncRoute(async (req, res) => { res.json({ ok: true }); })]]);
  const srv = await serve(app);
  try {
    const res = await request(srv.port, '/ok');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
  } finally { await srv.close(); }
});

test('the wrapper passes a non-async handler straight through', async () => {
  const app = appWith([['/plain', asyncRoute((req, res) => { res.json({ plain: true }); })]]);
  const srv = await serve(app);
  try {
    const res = await request(srv.port, '/plain');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { plain: true });
  } finally { await srv.close(); }
});

test('an UNWRAPPED async throw kills the process — which is why the wrapper exists', async () => {
  // Run the unwrapped case in a child process so the crash cannot take the test
  // runner with it. The child reports how the server died.
  const { spawnSync } = require('node:child_process');
  const script = `
    const express = require(${JSON.stringify(path.join(__dirname, '..', 'node_modules', 'express'))});
    const http = require('node:http');
    process.on('unhandledRejection', (e) => {
      console.log('UNHANDLED:' + e.message);
      process.exit(9);
    });
    const app = express();
    app.get('/unwrapped', async () => { throw new Error('unwrapped boom'); });
    app.use((err, req, res, next) => res.status(500).json({ handled: err.message }));
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const req = http.get({ host: '127.0.0.1', port, path: '/unwrapped' }, (res) => {
        console.log('RESPONSE:' + res.statusCode);
        process.exit(0);
      });
      req.on('error', () => { console.log('CONNECTION_FAILED'); process.exit(0); });
      req.setTimeout(2000, () => { console.log('HUNG'); process.exit(0); });
    });
  `;
  const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
  const combined = `${out.stdout}\n${out.stderr}`;

  assert.ok(/UNHANDLED:unwrapped boom/.test(combined),
    `the unwrapped route was expected to raise an unhandled rejection, got: ${combined.slice(0, 300)}`);
  assert.strictEqual(out.status, 9,
    'the child was expected to die from the unhandled rejection, which is the failure mode the wrapper prevents');
  assert.ok(!/RESPONSE:500/.test(combined),
    'error middleware must NOT be reached for an unwrapped async throw');
});

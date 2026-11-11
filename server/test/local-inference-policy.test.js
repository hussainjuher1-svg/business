/**
 * LOCAL-ONLY INFERENCE POLICY — regression tests.
 *
 * Two guarantees, both enforced centrally in `server/src/ai/ollama.js` so that
 * every caller (normal assistant requests AND the evaluation runner) inherits
 * them:
 *
 *   1. Daybook contacts a model only on loopback. Any other endpoint is
 *      rejected *before* a network request is made — never redirected, never
 *      silently replaced by a fallback.
 *   2. A model identity is only ever what Ollama reported. An exact tag match
 *      is required, and a missing/id-less response is never back-filled with
 *      the name we asked for.
 *
 * Nothing here needs Ollama installed: the point is that the guarded code path
 * cannot open a socket at all.
 *
 * Run: node --test server/test/local-inference-policy.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const ROOT = require('node:path').join(__dirname, '..', '..');
const ollama = require(require('node:path').join(ROOT, 'server', 'src', 'ai', 'ollama.js'));

// ---------------------------------------------------------------------------
// 1. Endpoint allow-list
// ---------------------------------------------------------------------------

test('endpoint policy: only loopback is allowed', () => {
  const allowed = [
    'http://127.0.0.1:11434',
    'http://localhost:11434',
    'http://[::1]:11434',
    'http://127.0.0.5:11434',   // still 127.0.0.0/8
    'http://127.0.0.1:11435',   // loopback on another port
    'http://127.0.0.1:11434/',  // trailing slash is not a path
  ];
  for (const url of allowed) {
    const verdict = ollama.validateEndpoint(url);
    assert.strictEqual(verdict.ok, true, `should be allowed: ${url} (${verdict.error?.message})`);
  }

  const rejected = [
    ['https://127.0.0.1:11434', 'https'],
    ['http://192.168.1.50:11434', 'LAN'],
    ['http://10.0.0.7:11434', 'LAN'],
    ['http://172.16.0.9:11434', 'LAN'],
    ['http://8.8.8.8:11434', 'public IP'],
    ['http://ollama.example.com:11434', 'public DNS'],
    ['http://box.local:11434', 'mDNS'],
    ['http://0.0.0.0:11434', 'wildcard bind'],
    ['http://[::ffff:8.8.8.8]:11434', 'mapped public IP'],
    ['ftp://127.0.0.1:11434', 'scheme'],
    ['http://user:pass@127.0.0.1:11434', 'credentials'],
    ['http://127.0.0.1:11434/api', 'path'],
    ['not a url', 'garbage'],
    ['', 'empty'],
  ];
  for (const [url, why] of rejected) {
    const verdict = ollama.validateEndpoint(url);
    assert.strictEqual(verdict.ok, false, `must be rejected (${why}): ${url}`);
    assert.ok(verdict.error && verdict.error.message, `rejection must carry a message: ${url}`);
    // The message must name the loopback-only rule, so the user can act on it.
    assert.match(verdict.error.message, /loopback|local machine|local Ollama/i,
      `message must explain the rule: ${url}`);
  }
});

test('endpoint policy: rejected endpoints never open a socket', async () => {
  const remote = 'http://192.168.1.50:11434';

  // Count every attempt to leave the process.
  let fetchCalls = 0;
  let connectCalls = 0;
  const realFetch = globalThis.fetch;
  const realConnect = net.connect;
  const realCreateConnection = net.Socket.prototype.connect;
  globalThis.fetch = (...args) => { fetchCalls += 1; return realFetch(...args); };
  net.connect = (...args) => { connectCalls += 1; return realConnect(...args); };
  net.Socket.prototype.connect = function (...args) { connectCalls += 1; return realCreateConnection.apply(this, args); };

  const saved = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = remote;
  try {
    if (typeof ollama.invalidateStatus === 'function') ollama.invalidateStatus();

    // getStatus() must report the rejection instead of probing.
    const status = await ollama.getStatus(true);
    assert.strictEqual(status.endpointRejected, true, 'getStatus must report a rejected endpoint');
    assert.strictEqual(status.available, false);
    assert.match(status.problem, /loopback|local machine/i);

    // chat() and embed() must throw typed errors.
    await assert.rejects(() => ollama.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] }), (err) => {
      assert.strictEqual(err.code, 'MODEL_UNAVAILABLE');
      assert.match(err.message, /loopback|local machine/i);
      return true;
    });
    await assert.rejects(() => ollama.embed(['hello']), (err) => {
      assert.strictEqual(err.code, 'EMBED_UNAVAILABLE');
      return true;
    });

    assert.strictEqual(fetchCalls, 0, `a rejected endpoint must make 0 HTTP requests, saw ${fetchCalls}`);
    assert.strictEqual(connectCalls, 0, `a rejected endpoint must open 0 sockets, saw ${connectCalls}`);
  } finally {
    globalThis.fetch = realFetch;
    net.connect = realConnect;
    net.Socket.prototype.connect = realCreateConnection;
    if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = saved;
    if (typeof ollama.invalidateStatus === 'function') ollama.invalidateStatus();
  }
});

test('endpoint policy: baseUrl() throws instead of falling back', () => {
  const saved = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = 'https://api.example.com:443';
  try {
    assert.throws(() => ollama.baseUrl(), (err) => {
      assert.strictEqual(err.name, 'OllamaEndpointError');
      assert.ok(err.message.length > 0);
      return true;
    });
    // The non-throwing reporting form still describes the problem.
    assert.match(ollama.endpointProblem() || '', /loopback|local machine|local Ollama/i);
    // ...and names the literal configured value, so the message is actionable.
    assert.strictEqual(ollama.baseUrlRaw(), 'https://api.example.com:443');
  } finally {
    if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = saved;
  }
});

test('endpoint policy: the app and the preflight share one validator', () => {
  // A preflight that validated differently could pass a config the app rejects.
  // Both must call the same function.
  const fs = require('node:fs');
  const path = require('node:path');
  const checker = fs.readFileSync(path.join(ROOT, 'server', 'check-ollama.js'), 'utf8');
  assert.match(checker, /ollama\.validateEndpoint\(/,
    'check-ollama.js must use the central validator, not its own copy');
  assert.ok(!/function isLoopback/.test(checker),
    'check-ollama.js must not keep a second, divergent loopback test');
});

// ---------------------------------------------------------------------------
// 2. Exact model identity
// ---------------------------------------------------------------------------

test('model identity: the exact tag is required', () => {
  const cases = [
    // [requested, reported, expected, why]
    ['llama3.2:3b', 'llama3.2:3b', true, 'exact tag'],
    ['llama3.2:1b', 'llama3.2:3b', false, 'different size tag'],
    ['llama3.2:3b', 'llama3.2:1b', false, 'different size tag (reversed)'],
    ['llama3.2:3b', 'llama3.2:latest', false, 'latest is not an explicit tag'],
    ['llama3.2:3b', 'llama3.2', false, 'untagged name is not the explicit tag'],
    // An untagged request means ":latest" and nothing else — never a wildcard.
    ['llama3.2', 'llama3.2:latest', true, 'untagged request means :latest'],
    ['llama3.2', 'llama3.2:1b', false, 'untagged request must not match another tag'],
    ['nomic-embed-text', 'nomic-embed-text:latest', true, 'untagged embed model means :latest'],
    ['nomic-embed-text', 'nomic-embed-text:123', false, 'explicit tag mismatch'],
    ['qwen2.5:3b', 'llama3.2:3b', false, 'different family'],
    ['llama3.2:3b', 'llama3.2:3b-instruct-q4_K_M', false, 'derived tag is not the tag'],
  ];
  // modelMatches(installedOrReported, requested)
  for (const [requested, reported, expected, why] of cases) {
    assert.strictEqual(ollama.modelMatches(reported, requested), expected,
      `reported ${reported} vs requested ${requested} (${why}) should be ${expected}`);
  }
});

test('model identity: splitModelRef and near-miss reporting', () => {
  assert.deepStrictEqual(ollama.splitModelRef('llama3.2:3b'), { base: 'llama3.2', tag: '3b' });
  assert.deepStrictEqual(ollama.splitModelRef('llama3.2'), { base: 'llama3.2', tag: '' });

  // When only a near-miss is installed, the runner should be able to say which.
  const others = ollama.otherTagsOf(['llama3.2:1b', 'llama3.2:3b', 'nomic-embed-text:latest'], 'llama3.2:3b');
  assert.deepStrictEqual(others.sort(), ['llama3.2:1b'],
    'a different size of the right family is reported as the near miss');
  // A different family is not a near miss.
  assert.deepStrictEqual(ollama.otherTagsOf(['nomic-embed-text:latest'], 'llama3.2:3b'), []);
});

test('model identity: a missing id is never replaced with the requested name', async () => {
  // Point at a local server that answers in Ollama's shape but OMITS the model
  // field, and refuses nothing. The client must not invent an identity.
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/chat') {
        res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }));
      } else if (req.url === '/api/embed') {
        res.end(JSON.stringify({ model: undefined, embeddings: [[0.1, 0.2, 0.3]] }));
      } else {
        res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b' }, { name: 'nomic-embed-text:latest' }] }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const saved = process.env.OLLAMA_BASE_URL;
  const savedChat = process.env.OLLAMA_CHAT_MODEL;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OLLAMA_CHAT_MODEL = 'llama3.2:3b';
  try {
    const chat = await ollama.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(chat.model, null, 'an omitted model id must stay null, not become the requested name');
    assert.notStrictEqual(chat.model, 'llama3.2:3b', 'the requested name must never be attributed');
    assert.strictEqual(chat.requestedModel, 'llama3.2:3b');
    assert.strictEqual(chat.modelSource, 'missing');
    assert.notStrictEqual(chat.modelMatchesRequest, true, 'an unknown identity must never assert a match');

    const emb = await ollama.embed(['hello']);
    assert.strictEqual(emb.model, null, 'an omitted embedding model id must stay null');
    assert.strictEqual(emb.modelSource, 'missing');
  } finally {
    if (saved === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = saved;
    if (savedChat === undefined) delete process.env.OLLAMA_CHAT_MODEL; else process.env.OLLAMA_CHAT_MODEL = savedChat;
    await new Promise((r) => server.close(r));
    if (typeof ollama.invalidateStatus === 'function') ollama.invalidateStatus();
  }
});

// ---------------------------------------------------------------------------
// 3. Redirects are refused
//
// `redirect: 'error'` closes the last way out of the loopback ring: a local
// server that answers 302 to another host. Following it would let the endpoint
// check be bypassed by something already trusted.
// ---------------------------------------------------------------------------

test('redirects: every Ollama call refuses to follow one', async () => {
  const http = require('node:http');

  // Listener B — the redirect TARGET. It must receive nothing.
  let targetHits = 0;
  const target = http.createServer((req, res) => {
    targetHits += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [], message: { content: 'LEAKED' }, embeddings: [[9, 9]] }));
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;

  // Listener A — the configured endpoint. It redirects everything to B.
  const redirect = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}${req.url}` });
    res.end();
  });
  await new Promise((r) => redirect.listen(0, '127.0.0.1', r));
  const redirectPort = redirect.address().port;

  const savedUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${redirectPort}`;
  try {
    ollama.invalidateStatus();

    // Every surface, not just chat: the redirect must be refused identically.
    const status = await ollama.getStatus(true);
    assert.strictEqual(status.available, false, 'a redirected status check must not succeed');
    assert.strictEqual(status.redirectRefused, true, 'status must report the refused redirect');
    assert.match(status.problem, /redirect/i, 'the problem must name the redirect');

    await assert.rejects(
      () => ollama.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] }),
      (err) => {
        assert.strictEqual(err.code, 'MODEL_UNAVAILABLE');
        assert.match(err.message, /redirect/i, 'chat must refuse the redirect by name');
        return true;
      }
    );

    await assert.rejects(
      () => ollama.embed(['hello']),
      (err) => {
        assert.strictEqual(err.code, 'EMBED_UNAVAILABLE');
        assert.match(err.message, /redirect/i, 'embeddings must refuse the redirect by name');
        return true;
      }
    );

    // THE POINT OF THE TEST: the redirect target was never contacted.
    assert.strictEqual(targetHits, 0,
      `the redirect target must receive zero requests, received ${targetHits}`);
  } finally {
    if (savedUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = savedUrl;
    ollama.invalidateStatus();
    await new Promise((r) => redirect.close(r));
    await new Promise((r) => target.close(r));
  }
});

test('redirects: the client has exactly one fetch call and it refuses redirects', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(ROOT, 'server', 'src', 'ai', 'ollama.js'), 'utf8');

  const fetchCalls = src.match(/\bfetch\(/g) || [];
  assert.strictEqual(fetchCalls.length, 1,
    `expected a single guarded fetch call, found ${fetchCalls.length} — a second call could bypass the guard`);
  assert.match(src, /redirect:\s*'error'/, 'the guarded fetch must refuse redirects');
  // Every endpoint must be reached through it, never by a bare fetch.
  assert.strictEqual((src.match(/guardedFetch\(/g) || []).length, 4,
    'three call sites plus the helper definition must use guardedFetch');
});

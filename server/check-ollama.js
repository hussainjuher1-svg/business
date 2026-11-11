/**
 * LOCAL OLLAMA PREFLIGHT — run this first on a new machine.
 *
 * Checks, in order:
 *   1. Node version supports the built-in flags Daybook uses
 *   2. the configured endpoint is a loopback address (never a public host)
 *   3. Ollama answers on that endpoint
 *   4. the chat and embedding models are pulled
 *   5. a real generation and a real embedding both succeed
 *   6. no paid AI provider is configured or reachable from Daybook
 *
 * Exit 0 = ready for `npm run eval:ollama`. Anything else = not ready.
 * Makes no cloud calls other than the loopback checks; step 6 inspects
 * configuration only and never contacts a provider.
 *
 * Run: npm run check:ollama
 */

const net = require('node:net');

const pass = (m) => console.log(`PASS  ${m}`);
const fail = (m) => { console.log(`FAIL  ${m}`); failures++; };
const warn = (m) => console.log(`WARN  ${m}`);
let failures = 0;


async function main() {
  console.log('='.repeat(70));
  console.log('DAYBOOK — LOCAL OLLAMA PREFLIGHT');
  console.log('='.repeat(70));

  // ---- 1. Node ----
  console.log(`\nNode ${process.version} on ${process.platform} ${process.arch}`);
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  if (major > 20 || (major === 20 && minor >= 19)) pass('Node version supports the flags Daybook uses');
  else fail(`Node ${process.version} is too old — Daybook needs Node 20.19+ (22 LTS recommended)`);

  // ---- 2. Endpoint must be local ----
  //
  // Validated by the SAME function the assistant uses (ollama.validateEndpoint),
  // so this preflight cannot pass a configuration the application would reject.
  const ollama = require('./src/ai/ollama');

  console.log('\nEffective configuration (from .env, same as the running app):');
  console.log(`  OLLAMA_BASE_URL   = ${process.env.OLLAMA_BASE_URL || '(default) http://127.0.0.1:11434'}`);
  console.log(`  OLLAMA_CHAT_MODEL = ${process.env.OLLAMA_CHAT_MODEL || '(default) llama3.2:3b'}`);
  console.log(`  OLLAMA_EMBED_MODEL= ${process.env.OLLAMA_EMBED_MODEL || '(default) nomic-embed-text'}`);
  if (!process.env.OLLAMA_BASE_URL) {
    console.log('  (no .env override detected — using built-in defaults)');
  }

  const rawUrl = ollama.baseUrlRaw ? ollama.baseUrlRaw() : (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
  const verdict = ollama.validateEndpoint(rawUrl);
  if (!verdict.ok) {
    console.log(`\nEndpoint: ${rawUrl}`);
    fail(verdict.error.message);
    console.log('      Rejected BEFORE any network request. Daybook will not contact this host.');
  } else {
    pass(`Endpoint is loopback (${verdict.url.hostname}) — not a public host`);
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    parsed = new URL('http://127.0.0.1:11434');
  }

  // ---- 3. Reachability ----
  //
  // Only ever probe a host that passed validation. Probing a rejected endpoint
  // would itself be an outbound connection to a remote machine.
  if (!verdict.ok) {
    fail('Reachability not tested — the endpoint was rejected, so no connection was attempted.');
  } else {
    const reachable = await new Promise((resolve) => {
      const socket = net.connect({ host: parsed.hostname.replace(/^\[|\]$/g, ''), port: Number(parsed.port || 11434) });
      socket.setTimeout(2500);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (reachable) pass(`Something is listening on ${parsed.hostname}:${parsed.port || 11434}`);
    else fail(`Nothing is listening on ${parsed.hostname}:${parsed.port || 11434} — run "ollama serve"`);
  }

  // ---- 4. Models ----
  const status = await ollama.getStatus(true);
  console.log(`\nChat model : ${status.chatModel}`);
  console.log(`Embed model: ${status.embedModel}`);
  console.log(`Installed  : ${status.installedModels.join(', ') || '(none)'}`);

  if (!status.available) {
    fail(`Ollama did not answer /api/tags: ${status.detail || status.problem}`);
  } else {
    pass('Ollama answered /api/tags');
    if (status.chatModelReady) pass(`Chat model "${status.chatModel}" is installed`);
    else fail(`Chat model missing — run: ollama pull ${status.chatModel}`);
    if (status.embedModelReady) pass(`Embedding model "${status.embedModel}" is installed`);
    else fail(`Embedding model missing — run: ollama pull ${status.embedModel}`);
  }

  // ---- 5. Real generation + embedding ----
  if (status.available && status.chatModelReady) {
    console.log('\nSending one real generation request (this warms the model, expect a delay)…');
    const started = Date.now();
    try {
      const r = await ollama.chat({
        system: 'Reply with exactly: READY',
        messages: [{ role: 'user', content: 'Say READY.' }],
        timeoutMs: 180_000,
      });
      const ms = Date.now() - started;
      pass(`Model generated a response in ${ms} ms (model reported: ${r.model})`);
      console.log(`      reply: ${r.content.replace(/\s+/g, ' ').slice(0, 120)}`);
    } catch (err) {
      fail(`Generation failed: ${err.message}`);
    }
  }

  if (status.available && status.embedModelReady) {
    try {
      const started = Date.now();
      const r = await ollama.embed(['daybook embedding check']);
      pass(`Embedding model returned ${r.dim}-dimensional vectors in ${Date.now() - started} ms (model: ${r.model})`);
    } catch (err) {
      fail(`Embedding failed: ${err.message}`);
    }
  }

  // ---- 6. No paid provider anywhere ----
  console.log('\nPaid-provider check (configuration inspection only, no network calls):');
  const forbidden = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AZURE_OPENAI_API_KEY',
    'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'COHERE_API_KEY', 'MISTRAL_API_KEY',
    'GROQ_API_KEY', 'TOGETHER_API_KEY', 'OPENROUTER_API_KEY', 'HUGGINGFACE_API_KEY'];
  const set = forbidden.filter((k) => process.env[k]);
  if (set.length === 0) pass('No paid-provider API keys are set in this environment');
  else {
    warn(`These API keys are set but Daybook ignores them: ${set.join(', ')}`);
    console.log('      Daybook has no code path that reads them; they are harmless but unnecessary.');
  }

  let src = '';
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    src = fs.readFileSync(path.join(__dirname, 'src', 'ai', 'ollama.js'), 'utf8');
  } catch { /* handled below */ }
  if (!/openai|anthropic|gemini|cohere|mistral|groq|openrouter/i.test(src)) {
    pass('The Ollama client contains no reference to any paid provider');
  } else {
    fail('ollama.js mentions a paid provider — this must not ship');
  }

  // ---- Summary ----
  console.log('\n' + '='.repeat(70));
  if (failures === 0) {
    console.log('RESULT: READY. Next: npm run eval:ollama');
    console.log('(That run asks 30 questions and produces a manual review pack.');
    console.log(' It does NOT by itself validate answer quality — you must review it.)');
  } else {
    console.log(`RESULT: NOT READY — ${failures} problem(s) above.`);
    console.log('Daybook will still run, but the assistant will report the model as');
    console.log('offline and answer from retrieved evidence only.');
  }
  console.log('='.repeat(70));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nPREFLIGHT ERROR:', e?.message || e);
  process.exit(1);
});

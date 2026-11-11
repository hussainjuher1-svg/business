/**
 * Local inference via Ollama.
 *
 * HARD RULE: this file is the ONLY place in Daybook that talks to a model, and it
 * only ever talks to a locally-hosted Ollama server. There is no paid provider, no
 * API key, and no silent fallback — if the local model is unavailable we report
 * that plainly and the caller degrades to deterministic evidence instead of
 * inventing an answer.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_CHAT_MODEL = 'llama3.2:3b';
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

/**
 * LOCAL-ONLY ENFORCEMENT.
 *
 * The endpoint is restricted here, in the one module that contacts a model, so
 * every caller is covered — the running application, the status check, the
 * evaluation runner, and anything added later. Validating only in a preflight
 * script would leave the actual assistant free to talk to a remote host.
 *
 * Only loopback destinations are allowed:
 *   http://127.0.0.1:11434   http://localhost:11434   http://[::1]:11434
 *
 * Everything else is rejected before a single byte is sent: public hostnames,
 * LAN addresses, public IPs, and any https:// endpoint.
 *
 * Rejection is a hard configuration error. Daybook never silently redirects to
 * a permitted host and never falls back to another provider.
 */

class OllamaEndpointError extends Error {
  constructor(message, { rawUrl, hostname, code = 'OLLAMA_ENDPOINT_REJECTED' } = {}) {
    super(message);
    this.name = 'OllamaEndpointError';
    this.code = code;
    this.rawUrl = rawUrl;
    this.hostname = hostname;
  }
}

/** Hostnames that always mean "this machine". */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  // The whole 127.0.0.0/8 block is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Validate a candidate endpoint.
 * @returns {{ok: true, url: URL} | {ok: false, error: OllamaEndpointError}}
 */
function validateEndpoint(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      error: new OllamaEndpointError(
        `OLLAMA_BASE_URL is not a valid URL: "${rawUrl}". ` +
          'It must be http://127.0.0.1:11434 (the local Ollama server).',
        { rawUrl, code: 'OLLAMA_ENDPOINT_INVALID' }
      ),
    };
  }

  const reject = (why) => ({
    ok: false,
    error: new OllamaEndpointError(
      `OLLAMA_BASE_URL is not a local Ollama endpoint: "${rawUrl}" — ${why}. ` +
        'Daybook only talks to an Ollama server on this machine ' +
        '(http://127.0.0.1:11434, http://localhost:11434 or http://[::1]:11434). ' +
        'It will not contact a remote model, and it will not fall back to a paid provider.',
      { rawUrl, hostname: url.hostname }
    ),
  });

  if (url.protocol === 'https:') {
    return reject('https means a remote or proxied endpoint');
  }
  if (url.protocol !== 'http:') {
    return reject(`protocol "${url.protocol}" is not supported`);
  }
  if (!isLoopbackHostname(url.hostname)) {
    return reject(`"${url.hostname}" is not a loopback address`);
  }
  // A URL with credentials or a path is not a base URL.
  if (url.username || url.password) {
    return reject('it contains credentials');
  }
  if (url.pathname && url.pathname !== '/') {
    return reject(`it contains a path ("${url.pathname}")`);
  }
  return { ok: true, url };
}

/**
 * The configured endpoint, validated. Throws OllamaEndpointError when the
 * configuration is not a loopback address. Never returns a substitute.
 */
function baseUrl() {
  const raw = (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const verdict = validateEndpoint(raw);
  if (!verdict.ok) throw verdict.error;
  return raw;
}

/**
 * The one way this module is allowed to talk to the network.
 *
 * Redirects are refused outright (`redirect: 'error'`). Following one would let
 * a local server hand the request to any host it liked — including a remote
 * inference provider — which would defeat the loopback-only rule every caller
 * depends on. A redirect is reported as a configuration problem, never followed.
 */
async function guardedFetch(url, init) {
  try {
    return await fetch(url, { ...init, redirect: 'error' });
  } catch (err) {
    // Node reports a blocked redirect as a generic "fetch failed" whose cause
    // carries the real reason ("unexpected redirect"), so inspect the chain.
    const message = [err?.message, err?.cause?.message, err?.cause?.code].filter(Boolean).join(' ');
    if (/redirect/i.test(message) || err?.cause?.code === 'ERR_FETCH_REDIRECT') {
      const e = new Error(
        'The Ollama endpoint redirected the request. Daybook does not follow redirects: '
        + 'a redirect could send your data to a host other than the local model. '
        + 'Point OLLAMA_BASE_URL directly at http://127.0.0.1:11434.'
      );
      e.code = 'OLLAMA_REDIRECT_REFUSED';
      e.redirectRefused = true;
      throw e;
    }
    throw err;
  }
}

/** The literal configured value, without validation. For error messages only. */
function baseUrlRaw() {
  return (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Non-throwing form, for reporting configuration problems without crashing. */
function endpointProblem() {
  const raw = (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const verdict = validateEndpoint(raw);
  return verdict.ok ? null : verdict.error.message;
}

/**
 * Resolve the base URL for a network call. Any endpoint error is converted to a
 * typed MODEL_UNAVAILABLE/EMBED_UNAVAILABLE failure by the caller's error
 * handling, so the assistant reports a configuration problem and degrades to
 * deterministic evidence — it never quietly uses something else.
 */
function requireBaseUrl() {
  return baseUrl();
}

function defaultChatModel() {
  return process.env.OLLAMA_CHAT_MODEL || DEFAULT_CHAT_MODEL;
}
function defaultEmbedModel() {
  return process.env.OLLAMA_EMBED_MODEL || DEFAULT_EMBED_MODEL;
}

const STATUS_TTL_MS = 10_000;
let statusCache = { at: 0, value: null };

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function unreachableMessage() {
  const raw = (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return (
    `The local AI model is not reachable at ${raw}. ` +
    'Daybook never sends your data to a paid cloud provider, so it will not ' +
    'substitute one. Start Ollama (run "ollama serve") and make sure the model is ' +
    'pulled, then try again.'
  );
}

/**
 * MODEL IDENTITY.
 *
 * Ollama model references are `name[:tag]`. Getting this wrong is not cosmetic:
 * treating `llama3.2:1b` as satisfying a request for `llama3.2:3b` would run a
 * completely different model than the one being evaluated, and the results
 * would be attributed to the wrong thing.
 *
 * Rules:
 *   - a TAGGED request (`llama3.2:3b`) requires an exact tag match
 *   - an UNTAGGED request (`nomic-embed-text`) means `:latest`, and ONLY
 *     `:latest` — it does not mean "any tag of that name"
 *   - names never match across different bases
 */
function splitModelRef(name) {
  const value = String(name || '').trim();
  const i = value.lastIndexOf(':');
  if (i === -1) return { base: value, tag: '' };
  return { base: value.slice(0, i), tag: value.slice(i + 1) };
}

/**
 * @param {string} installed a name reported by /api/tags
 * @param {string} requested the configured model
 * @returns {boolean} true when `installed` is exactly the requested model
 */
function modelMatches(installed, requested) {
  const want = splitModelRef(requested);
  if (!want.base) return false;
  const have = splitModelRef(installed);
  if (have.base !== want.base) return false;
  if (want.tag) return have.tag === want.tag;
  // Untagged request == :latest. Deliberate, not a wildcard.
  return have.tag === 'latest';
}

/** Names of installed models that share a base name but not the requested tag. */
function otherTagsOf(installedModels, requested) {
  const want = splitModelRef(requested);
  return installedModels.filter((n) => {
    const have = splitModelRef(n);
    return have.base === want.base && !modelMatches(n, requested);
  });
}

/**
 * Inspect the local Ollama server. Returns a plain description of what is and is
 * not available so the UI can tell the owner the truth.
 */
async function getStatus(force = false) {
  const now = Date.now();
  if (!force && statusCache.value && now - statusCache.at < STATUS_TTL_MS) {
    return statusCache.value;
  }

  const rawBase = (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const result = {
    provider: 'ollama',
    baseUrl: rawBase,
    available: false,
    chatModel: defaultChatModel(),
    embedModel: defaultEmbedModel(),
    chatModelReady: false,
    embedModelReady: false,
    installedModels: [],
    problem: '',
    checkedAt: new Date().toISOString(),
  };

  // Configuration errors are reported, never worked around. No request is made.
  const problem = endpointProblem();
  if (problem) {
    result.available = false;
    result.endpointRejected = true;
    result.problem = problem;
    result.detail = 'Rejected before any network request.';
    statusCache = { at: now, value: result };
    return result;
  }

  const t = withTimeout(2500);
  try {
    const res = await guardedFetch(`${baseUrl()}/api/tags`, { signal: t.signal });
    if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];
    result.installedModels = models.map((m) => m.name).filter(Boolean);
    result.available = true;

    const has = (want) => !!want && result.installedModels.some((n) => modelMatches(n, want));

    result.chatModelReady = has(result.chatModel);
    result.embedModelReady = has(result.embedModel);
    // Reported so the UI/CLI can explain a near-miss instead of just "missing".
    result.chatModelOtherTags = otherTagsOf(result.installedModels, result.chatModel);
    result.embedModelOtherTags = otherTagsOf(result.installedModels, result.embedModel);

    const nearMiss = (want, others) =>
      others.length
        ? ` Found ${others.map((n) => `"${n}"`).join(', ')} instead — a different tag is a different model, so it is not used.`
        : '';

    if (!result.chatModelReady) {
      result.problem =
        `Local model "${result.chatModel}" is not installed. Run: ollama pull ${result.chatModel}` +
        nearMiss(result.chatModel, result.chatModelOtherTags);
    } else if (!result.embedModelReady) {
      result.problem =
        `Local embedding model "${result.embedModel}" is not installed. Run: ollama pull ${result.embedModel}` +
        nearMiss(result.embedModel, result.embedModelOtherTags);
    }
  } catch (err) {
    result.available = false;
    // A refused redirect is a configuration problem, not an unreachable server.
    result.problem = err?.redirectRefused ? err.message : unreachableMessage();
    result.detail = err?.name === 'AbortError' ? 'Connection timed out.' : String(err?.message || err);
    if (err?.redirectRefused) {
      result.redirectRefused = true;
      result.chatModelReady = false;
      result.embedModelReady = false;
    }
  } finally {
    t.done();
  }

  statusCache = { at: now, value: result };
  return result;
}

/**
 * Single chat completion against the local model.
 * Throws a typed error when the model cannot be used — callers must handle it.
 */
async function chat({ model, system, messages, temperature = 0.1, timeoutMs = 120_000 }) {
  const chosen = model || defaultChatModel();

  // Validate the destination BEFORE opening a connection. A rejected endpoint
  // is a typed failure, never a redirect.
  let origin;
  try {
    origin = requireBaseUrl();
  } catch (err) {
    const wrapped = new Error(err.message);
    wrapped.code = 'MODEL_UNAVAILABLE';
    wrapped.detail = err.code || 'OLLAMA_ENDPOINT_REJECTED';
    wrapped.endpointRejected = true;
    throw wrapped;
  }

  const t = withTimeout(timeoutMs);
  try {
    const res = await guardedFetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: t.signal,
      body: JSON.stringify({
        model: chosen,
        stream: false,
        options: { temperature, num_ctx: 8192 },
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Local model error (${res.status})${body ? `: ${body.slice(0, 300)}` : ''}`);
      err.code = 'MODEL_ERROR';
      throw err;
    }
    const data = await res.json();
    const content = data?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      const err = new Error('The local model returned an empty response.');
      err.code = 'MODEL_EMPTY';
      throw err;
    }
    // Never substitute the requested name for what the model actually reported.
    // A missing identifier is recorded as missing, so callers cannot present a
    // guess as a verified model identity.
    const reported = typeof data?.model === 'string' && data.model.trim() ? data.model.trim() : null;
    return {
      content: content.trim(),
      model: reported,
      requestedModel: chosen,
      modelSource: reported ? 'reported-by-ollama' : 'missing',
      modelMatchesRequest: reported ? modelMatches(reported, chosen) : null,
    };
  } catch (err) {
    if (err?.redirectRefused) {
      // Keep the caller-facing code stable (so the assistant degrades to
      // evidence-only answers) while preserving the real reason.
      const wrapped = new Error(err.message);
      wrapped.code = 'MODEL_UNAVAILABLE';
      wrapped.detail = 'OLLAMA_REDIRECT_REFUSED';
      wrapped.redirectRefused = true;
      throw wrapped;
    }
    if (err.code) throw err;
    const wrapped = new Error(
      err?.name === 'AbortError'
        ? 'The local model took too long to respond and the request was cancelled.'
        : unreachableMessage()
    );
    wrapped.code = 'MODEL_UNAVAILABLE';
    wrapped.detail = String(err?.message || err);
    throw wrapped;
  } finally {
    t.done();
  }
}

/**
 * Embed a batch of texts with the local embedding model.
 * Returns null when embeddings are unavailable — retrieval then relies on
 * full-text search alone rather than silently degrading quality claims.
 */
async function embed(texts, model) {
  const chosen = model || defaultEmbedModel();
  if (!Array.isArray(texts) || texts.length === 0) return { vectors: [], model: chosen, dim: 0 };

  let origin;
  try {
    origin = requireBaseUrl();
  } catch (err) {
    const wrapped = new Error(err.message);
    wrapped.code = 'EMBED_UNAVAILABLE';
    wrapped.detail = err.code || 'OLLAMA_ENDPOINT_REJECTED';
    wrapped.endpointRejected = true;
    throw wrapped;
  }

  const t = withTimeout(60_000);
  try {
    const res = await guardedFetch(`${origin}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: t.signal,
      body: JSON.stringify({ model: chosen, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Embedding model error (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const data = await res.json();
    const embeddings = Array.isArray(data?.embeddings) ? data.embeddings : [];
    if (embeddings.length !== texts.length) {
      throw new Error('Embedding model returned an unexpected number of vectors.');
    }
    const reported = typeof data?.model === 'string' && data.model.trim() ? data.model.trim() : null;
    return {
      vectors: embeddings,
      model: reported,
      requestedModel: chosen,
      modelSource: reported ? 'reported-by-ollama' : 'missing',
      modelMatchesRequest: reported ? modelMatches(reported, chosen) : null,
      dim: embeddings[0]?.length || 0,
    };
  } catch (err) {
    if (err?.redirectRefused) {
      const wrapped = new Error(err.message);
      wrapped.code = 'EMBED_UNAVAILABLE';
      wrapped.detail = 'OLLAMA_REDIRECT_REFUSED';
      wrapped.redirectRefused = true;
      throw wrapped;
    }
    const wrapped = new Error(
      err?.name === 'AbortError' ? 'The local embedding model timed out.' : unreachableMessage()
    );
    wrapped.code = 'EMBED_UNAVAILABLE';
    wrapped.detail = String(err?.message || err);
    throw wrapped;
  } finally {
    t.done();
  }
}

module.exports = {
  getStatus,
  chat,
  embed,
  baseUrl,
  baseUrlRaw,
  guardedFetch,
  endpointProblem,
  validateEndpoint,
  isLoopbackHostname,
  modelMatches,
  splitModelRef,
  otherTagsOf,
  OllamaEndpointError,
  defaultChatModel,
  defaultEmbedModel,
  invalidateStatus: () => { statusCache = { at: 0, value: null }; },
};

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

function baseUrl() {
  return (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
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
  return (
    `The local AI model is not reachable at ${baseUrl()}. ` +
    'Daybook never sends your data to a paid cloud provider, so it will not ' +
    'substitute one. Start Ollama (run "ollama serve") and make sure the model is ' +
    'pulled, then try again.'
  );
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

  const result = {
    provider: 'ollama',
    baseUrl: baseUrl(),
    available: false,
    chatModel: defaultChatModel(),
    embedModel: defaultEmbedModel(),
    chatModelReady: false,
    embedModelReady: false,
    installedModels: [],
    problem: '',
    checkedAt: new Date().toISOString(),
  };

  const t = withTimeout(2500);
  try {
    const res = await fetch(`${baseUrl()}/api/tags`, { signal: t.signal });
    if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];
    result.installedModels = models.map((m) => m.name).filter(Boolean);
    result.available = true;

    const has = (want) =>
      !!want &&
      result.installedModels.some((n) => n === want || n.startsWith(`${want}:`) || n.split(':')[0] === want.split(':')[0]);

    result.chatModelReady = has(result.chatModel);
    result.embedModelReady = has(result.embedModel);
    if (!result.chatModelReady) {
      result.problem = `Local model "${result.chatModel}" is not installed. Run: ollama pull ${result.chatModel}`;
    } else if (!result.embedModelReady) {
      result.problem = `Local embedding model "${result.embedModel}" is not installed. Run: ollama pull ${result.embedModel}`;
    }
  } catch (err) {
    result.available = false;
    result.problem = unreachableMessage();
    result.detail = err?.name === 'AbortError' ? 'Connection timed out.' : String(err?.message || err);
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
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/api/chat`, {
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
    return { content: content.trim(), model: data?.model || chosen };
  } catch (err) {
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

  const t = withTimeout(60_000);
  try {
    const res = await fetch(`${baseUrl()}/api/embed`, {
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
    return { vectors: embeddings, model: data?.model || chosen, dim: embeddings[0]?.length || 0 };
  } catch (err) {
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
  defaultChatModel,
  defaultEmbedModel,
  invalidateStatus: () => { statusCache = { at: 0, value: null }; },
};

/**
 * STAND-IN for the Ollama HTTP API — TEST PLUMBING ONLY.
 *
 * This is not a model. It has no weights, does no inference, and returns canned
 * text. It exists so the evaluation runner's plumbing can be exercised on a
 * machine without Ollama installed. Any output produced while this stub is
 * running is labelled STUB and must never be reported as model validation.
 *
 * Runs as its own process (execFileSync blocks the event loop, so an in-process
 * server could never answer).
 *
 * Usage: node server/test/lib/ollama-stub.js [port] [--no-embed] [--no-chat]
 */

const http = require('node:http');

const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a)) || 11434);
const hasEmbed = !args.includes('--no-embed');
const hasChat = !args.includes('--no-chat');

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.url === '/api/tags') {
    const models = [];
    if (hasChat) models.push({ name: 'llama3.2:3b' });
    if (hasEmbed) models.push({ name: 'nomic-embed-text:latest' });
    return send(200, { models });
  }
  if (req.url === '/api/embed') {
    return send(200, { model: 'nomic-embed-text', embeddings: [[0.01, 0.02, 0.03]] });
  }
  if (req.url === '/api/chat') {
    return send(200, {
      model: 'llama3.2:3b',
      message: { role: 'assistant', content: 'STUB ANSWER — not a real model response.' },
    });
  }
  return send(404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[ollama-stub] listening on 127.0.0.1:${port} (chat=${hasChat} embed=${hasEmbed})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

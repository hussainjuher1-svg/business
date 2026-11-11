/**
 * Prompt-injection screening for untrusted text.
 *
 * Business documents, customer notes and inquiry messages are attacker-controlled
 * input once they enter the knowledge base. We never treat them as instructions.
 * This module flags suspicious content at ingest time (so the owner can see it)
 * and again at retrieval time (so a flagged chunk can be excluded or clearly
 * quarantined before it reaches the model).
 */

const PATTERNS = [
  { reason: 'instruction override attempt', re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|directions?)\b/i },
  { reason: 'role/persona switch attempt', re: /\b(you are now|from now on|act as|pretend to be|switch to)\b[^.\n]{0,40}\b(assistant|system|admin|developer|dan|jailbreak|unrestricted)\b/i },
  { reason: 'system prompt extraction attempt', re: /\b(reveal|show|print|repeat|output|leak)\b[^.\n]{0,30}\b(system prompt|system message|initial instructions|your instructions|hidden prompt)\b/i },
  { reason: 'credential exfiltration attempt', re: /\b(api[_\s-]?key|secret|password|token|credentials?)\b[^.\n]{0,40}\b(reveal|print|show|send|email|post|upload|share)\b/i },
  { reason: 'cross-business access attempt', re: /\b(other|another|different|all)\b[^.\n]{0,20}\bbusiness(es)?\b[^.\n]{0,40}\b(data|records?|customers?|information)\b/i },
  { reason: 'fake system/tool directive', re: /(^|\n)\s*(system|assistant|developer|tool)\s*[:>]/i },
  { reason: 'instruction-hierarchy injection', re: /\b(new|updated|real|actual)\s+(system\s+)?instructions?\s*[:\-]/i },
  { reason: 'embedding of fake tool call', re: /<\|?(im_start|im_end|endoftext|system|tool)\|?>/i },
  { reason: 'data-exfiltration URL', re: /\b(https?:\/\/)[^\s]*\b(webhook|collect|exfil|pastebin|ngrok)\b/i },
];

function screen(text) {
  if (!text || typeof text !== 'string') return { flagged: false, reasons: [] };
  const reasons = [];
  for (const { reason, re } of PATTERNS) {
    if (re.test(text)) reasons.push(reason);
  }
  return { flagged: reasons.length > 0, reasons };
}

/**
 * Neutralise untrusted retrieved text before it is placed in a prompt.
 * We keep the content (the owner may legitimately need it) but strip the
 * structural markers that let injected text impersonate system directives.
 */
function sanitizeForPrompt(text, maxChars = 1200) {
  if (!text) return '';
  let out = String(text)
    .replace(/\u0000/g, '')
    .replace(/<\|?[a-z_]+\|?>/gi, '')
    .replace(/(^|\n)\s*(system|assistant|developer|tool)\s*[:>]/gi, '\n$1(quoted line) ')
    .replace(/```+/g, "'''")
    .trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}

/**
 * Wrap untrusted evidence so the model is told explicitly that it is data,
 * not instruction. Paired with a system prompt that forbids following it.
 */
function asEvidence(label, text, maxChars = 900) {
  const body = sanitizeForPrompt(text, maxChars);
  return `<evidence source="${label.replace(/["<>]/g, '')}">\n${body}\n</evidence>`;
}

module.exports = { screen, sanitizeForPrompt, asEvidence };

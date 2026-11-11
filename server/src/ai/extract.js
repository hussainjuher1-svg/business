/**
 * Text extraction for uploaded business documents.
 *
 * Deliberately dependency-free and conservative: we only claim a document was
 * "extracted" when we genuinely produced text. Anything we cannot parse is marked
 * 'unsupported' rather than being silently treated as empty knowledge.
 */

const MAX_TEXT_CHARS = 400_000;

function cleanText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function isMostlyBinary(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 2048));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

/**
 * Extract readable text from a Word .docx (a ZIP containing word/document.xml).
 * Implemented inline with zlib so no extra dependency is required.
 */
function extractDocxText(buf) {
  const zlib = require('node:zlib');
  // Walk ZIP central directory to find word/document.xml.
  const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  let found = null;
  while ((offset = buf.indexOf(sig, offset)) !== -1) {
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (name === 'word/document.xml') {
      found = { method, compSize, localOffset };
      break;
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  if (!found) return null;

  const lh = found.localOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const lNameLen = buf.readUInt16LE(lh + 26);
  const lExtraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + lNameLen + lExtraLen;
  const raw = buf.subarray(dataStart, dataStart + found.compSize);
  let xmlBuf;
  if (found.method === 0) xmlBuf = raw;
  else if (found.method === 8) xmlBuf = zlib.inflateRawSync(raw);
  else return null;

  const xml = xmlBuf.toString('utf8');
  const withBreaks = xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n');
  const text = withBreaks.replace(/<[^>]+>/g, '');
  return decodeEntities(text);
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * PDF text extraction, best-effort. Pulls text out of uncompressed content
 * streams and simple Flate-compressed streams. Scanned/image-only PDFs will
 * return '' and are reported as 'unsupported' — we never invent content.
 */
function extractPdfText(buf) {
  const zlib = require('node:zlib');
  const parts = [];
  const text = buf.toString('latin1');

  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(text)) !== null) {
    let chunk = Buffer.from(m[1], 'latin1');
    if (chunk.length < 2) continue;
    if (chunk[0] === 0x78) {
      try {
        chunk = zlib.inflateSync(chunk);
      } catch {
        continue;
      }
    }
    const content = chunk.toString('latin1');
    if (!/(TJ|Tj)\b/.test(content)) continue;

    // Collect text show operators: (literal) Tj and [(a)(b)] TJ
    const showRe = /\((?:\\.|[^\\)])*\)/g;
    const strings = content.match(showRe);
    if (!strings) continue;
    const line = strings
      .map((s) => s.slice(1, -1).replace(/\\([()\\])/g, '$1'))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (line) parts.push(line);
  }
  return parts.join('\n');
}

/**
 * @returns {{ text: string, status: 'extracted'|'unsupported'|'empty', note: string }}
 */
function extract({ buffer, filename, mime }) {
  const name = String(filename || '').toLowerCase();
  const type = String(mime || '').toLowerCase();

  if (!buffer || buffer.length === 0) {
    return { text: '', status: 'empty', note: 'The file is empty.' };
  }

  const isTexty =
    type.startsWith('text/') ||
    type.includes('json') ||
    type.includes('csv') ||
    /\.(txt|md|markdown|csv|tsv|json|log)$/.test(name);

  if (isTexty) {
    if (isMostlyBinary(buffer)) {
      return { text: '', status: 'unsupported', note: 'File looks like binary content despite a text file name.' };
    }
    const t = cleanText(buffer.toString('utf8'));
    return t
      ? { text: t, status: 'extracted', note: '' }
      : { text: '', status: 'empty', note: 'No readable text found in the file.' };
  }

  if (name.endsWith('.docx') || type.includes('wordprocessingml')) {
    try {
      const t = cleanText(extractDocxText(buffer) || '');
      return t
        ? { text: t, status: 'extracted', note: '' }
        : { text: '', status: 'unsupported', note: 'Could not find readable text in this .docx file.' };
    } catch {
      return { text: '', status: 'unsupported', note: 'This .docx file could not be read.' };
    }
  }

  if (name.endsWith('.pdf') || type === 'application/pdf') {
    try {
      const t = cleanText(extractPdfText(buffer));
      if (t.length >= 20) return { text: t, status: 'extracted', note: '' };
      return {
        text: '',
        status: 'unsupported',
        note: 'This PDF appears to be scanned or image-based, so no text could be read. Daybook will not guess its contents — paste the text in manually if you need the assistant to use it.',
      };
    } catch {
      return { text: '', status: 'unsupported', note: 'This PDF could not be read.' };
    }
  }

  if (name.endsWith('.doc') || type === 'application/msword') {
    return {
      text: '',
      status: 'unsupported',
      note: 'Legacy .doc files are not supported. Save as .docx, .pdf or .txt and re-upload.',
    };
  }

  return {
    text: '',
    status: 'unsupported',
    note: `Unsupported file type${mime ? ` (${mime})` : ''}. Supported: .txt, .md, .csv, .json, .pdf (text-based), .docx`,
  };
}

module.exports = { extract, cleanText, MAX_TEXT_CHARS };

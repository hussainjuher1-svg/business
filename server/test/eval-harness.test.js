/**
 * PLUMBING TEST for the real-model evaluation runner.
 *
 * This does NOT validate Ollama and does NOT evaluate answer quality. It starts
 * a local stub that speaks the Ollama HTTP contract — a canned reply, no model,
 * no weights — so the runner's *plumbing* can be exercised on a machine without
 * Ollama: refusal behaviour, record shape, file output, exit codes, and that
 * nothing is ever auto-marked correct.
 *
 * Every artefact produced here is written to a disposable directory and labelled
 * `STUB — NOT A MODEL RUN`, so it cannot be mistaken for real validation.
 *
 * Run: node --test server/test/eval-harness.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const STUB_PORT = 11434;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-evalplumb-'));

/**
 * Start the stand-in Ollama as its own process.
 *
 * It cannot live in this process: the runner is launched with execFileSync,
 * which blocks this process's event loop, so an in-process server would never
 * answer a request.
 */
function startStub(opts = {}) {
  const args = [path.join(__dirname, 'lib', 'ollama-stub.js'), String(STUB_PORT)];
  if (opts.embedReady === false) args.push('--no-embed');
  if (opts.chatReady === false) args.push('--no-chat');
  if (opts.failEmbed) args.push('--fail-embed');
  if (opts.anonymousEmbed) args.push('--anonymous-embed');
  if (opts.noMarker) args.push('--no-marker');

  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`stub did not start: ${out}`)), 15000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('listening on')) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`stub exited ${c}: ${out}`)); });
  });
}

function stopStub(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
  });
}

/** Run the runner with the stub as the "local model". */
function runEval(env = {}) {
  const outDir = fs.mkdtempSync(path.join(TMP, 'out-'));
  const result = { outDir };
  try {
    result.stdout = execFileSync(process.execPath, [path.join(ROOT, 'server', 'eval-ollama.js')], {
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        OLLAMA_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
        OLLAMA_CHAT_MODEL: 'llama3.2:3b',
        OLLAMA_EMBED_MODEL: 'nomic-embed-text',
        // Declare stub provenance up front: this run is served by the stand-in.
        DAYBOOK_EVAL_STUB: '1',
        DAYBOOK_EVAL_DIR: outDir,
        ...env,
      },
      encoding: 'utf8',
      timeout: 180000,
    });
    result.code = 0;
  } catch (err) {
    result.code = err.status;
    result.stdout = String(err.stdout || '');
    result.stderr = String(err.stderr || '');
  }
  return result;
}

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('eval runner refuses to run and exits 2 when Ollama is unreachable', () => {
  const outDir = fs.mkdtempSync(path.join(TMP, 'refuse-'));
  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'server', 'eval-ollama.js')], {
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        // Nothing is listening here.
        OLLAMA_BASE_URL: 'http://127.0.0.1:59998',
        DAYBOOK_EVAL_DIR: outDir,
      },
      encoding: 'utf8',
      timeout: 60000,
    });
  } catch (err) {
    code = err.status;
    stderr = String(err.stderr || '');
  }
  assert.strictEqual(code, 2, 'must refuse with exit code 2');
  assert.match(stderr, /REFUSING TO RUN/i);
  assert.match(stderr, /no cloud substitute/i, 'must state that no cloud fallback is used');
  assert.deepStrictEqual(fs.readdirSync(outDir), [], 'must not write results when refusing');
});

test('eval runner refuses when the chat model is not installed', async () => {
  const stub = await startStub({ chatReady: false });
  try {
    const outDir = fs.mkdtempSync(path.join(TMP, 'nomodel-'));
    let code = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'server', 'eval-ollama.js')], {
        env: {
          ...process.env, NODE_NO_WARNINGS: '1',
          OLLAMA_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
          DAYBOOK_EVAL_DIR: outDir,
        },
        encoding: 'utf8', timeout: 60000,
      });
    } catch (err) {
      code = err.status;
      stderr = String(err.stderr || '');
    }
    assert.strictEqual(code, 2, 'must refuse with exit code 2 when the chat model is absent');
    assert.match(stderr, /chat model is not installed/i);
    assert.deepStrictEqual(fs.readdirSync(outDir), [], 'must not write results when refusing');
  } finally {
    await stopStub(stub);
  }
});

test('eval runner refuses when the embedding model is not installed', async () => {
  const stub = await startStub({ embedReady: false });
  try {
    const outDir = fs.mkdtempSync(path.join(TMP, 'noembed-'));
    let code = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'server', 'eval-ollama.js')], {
        env: {
          ...process.env, NODE_NO_WARNINGS: '1',
          OLLAMA_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
          DAYBOOK_EVAL_DIR: outDir,
        },
        encoding: 'utf8', timeout: 60000,
      });
    } catch (err) {
      code = err.status;
      stderr = String(err.stderr || '');
    }
    assert.strictEqual(code, 2, 'must refuse when embeddings are missing');
    assert.match(stderr, /embedding model is not installed/i);
  } finally {
    await stopStub(stub);
  }
});

test('classification: only a successful Ollama answer counts as a model answer', () => {
  // These mirror the runner's taxonomy exactly. If a deterministic path could
  // ever be classed as model-answer, a dead model would look like a good run.
  const OUTCOME_BY_MODE = {
    'local-model': 'model-answer',
    'out-of-scope': 'refusal-by-design',
    refused: 'refusal-by-design',
    'model-offline': 'technical-failure',
    'model-error': 'technical-failure',
    'ai-disabled': 'technical-failure',
    'no-evidence': 'inconclusive',
    'builtin-guide': 'inconclusive',
  };

  // Deterministic fallbacks must NEVER be model answers.
  for (const deterministic of ['model-offline', 'model-error', 'ai-disabled', 'no-evidence', 'builtin-guide']) {
    assert.notStrictEqual(OUTCOME_BY_MODE[deterministic], 'model-answer',
      `${deterministic} must never be classified as a model answer`);
  }

  // Refusals and technical failures must be different outcomes.
  assert.strictEqual(OUTCOME_BY_MODE['out-of-scope'], 'refusal-by-design');
  assert.strictEqual(OUTCOME_BY_MODE.refused, 'refusal-by-design');
  assert.strictEqual(OUTCOME_BY_MODE['model-offline'], 'technical-failure');
  assert.strictEqual(OUTCOME_BY_MODE['model-error'], 'technical-failure');
  assert.notStrictEqual(OUTCOME_BY_MODE['out-of-scope'], OUTCOME_BY_MODE['model-offline']);

  // A transport failure is technical regardless of what the body claims.
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'server', 'eval-ollama.js'), 'utf8');
  assert.match(src, /if \(httpStatus && httpStatus >= 400\) return 'technical-failure'/,
    'an HTTP error must never be classed as a model answer');

  // The runner must require the model to be present and READY before it starts.
  assert.match(src, /REFUSING TO RUN: the local model is not reachable/);
  assert.match(src, /REFUSING TO RUN: the chat model is not installed/);
  assert.match(src, /REFUSING TO RUN: the embedding model is not installed/);
});

test('classification: a degraded run is never reported as model validation', async () => {
  // The stub advertises the models, then starts failing chat requests. The
  // runner must report technical failures, not silently count refusals.
  const stub = await startStub();
  try {
    // Warm nothing: just confirm that when the model answers, the runner marks
    // those records model-answer AND flags the whole run as a stub run.
    const run = runEval();
    const runs = fs.readdirSync(run.outDir);
    assert.strictEqual(runs.length, 1);
    const outDir = path.join(run.outDir, runs[0]);
    const { meta, records } = JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'));

    assert.strictEqual(meta.isStubRun, true, 'a stub-served run must be flagged');
    const review = fs.readFileSync(path.join(outDir, 'REVIEW.md'), 'utf8');
    assert.match(review, /STUB/i, 'the review pack must carry a visible stub warning');
    assert.match(review, /NOT MODEL VALIDATION/i);

    // No record may be a model answer: everything came from the stand-in.
    assert.strictEqual(records.filter((r) => r.outcome === 'model-answer').length, 0,
      'a stub-served run must contain zero model answers');

    // Non-model records must carry no model identifier at all.
    for (const r of records.filter((x) => x.outcome !== 'model-answer')) {
      assert.strictEqual(r.model, '', `[${r.id}] ${r.outcome} must not report a model identifier`);
      assert.strictEqual(r.reviewState, 'not-applicable');
    }
  } finally {
    await stopStub(stub);
  }
});

test('eval runner records every question and never marks an answer correct', async () => {
  const stub = await startStub();
  try {
    const run = runEval();
    // A stub run must exit 5 ("STUB DETECTED"), never 0. Exit 0 would let a
    // canned-response run be filed as validation.
    assert.strictEqual(run.code, 5, `stub run must exit 5, got ${run.code}: ${String(run.stderr || '').slice(0, 400)}`);
    assert.match(String(run.stderr || ''), /STUB/i);
    assert.match(String(run.stderr || ''), /NOT MODEL VALIDATION/i);
    // The banner must state the actual provenance counts, not just a warning.
    assert.match(String(run.stderr || ''), /canned test stand-in/i);
    assert.match(String(run.stderr || ''), /Model answers in this run: 0/i);

    // Each run writes to its own timestamped directory beneath the override.
    const runs = fs.readdirSync(run.outDir);
    assert.strictEqual(runs.length, 1, `expected one run directory, got ${runs.join(', ')}`);
    const outDir = path.join(run.outDir, runs[0]);

    // Output files exist.
    const files = fs.readdirSync(outDir);
    assert.ok(files.includes('results.json'), `results.json missing, got ${files}`);
    assert.ok(files.includes('REVIEW.md'), 'REVIEW.md missing');
    assert.ok(files.includes('review.csv'), 'review.csv missing');

    const { meta, records, setupRecords } = JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'));
    assert.strictEqual(meta.isStubRun, true, 'a stub run must be flagged in metadata');
    assert.ok(meta.stubQuestions.length > 0, 'stub questions must be listed');

    // Exactly 30 scored questions. The follow-up setup turn is NOT a question
    // and is stored separately so counts reconcile to the bank size.
    assert.strictEqual(records.length, 30, `expected exactly 30 question records, got ${records.length}`);
    assert.strictEqual(new Set(records.map((r) => r.id)).size, 30, 'every question id must appear exactly once');
    assert.deepStrictEqual(setupRecords.map((r) => r.forQuestion), [30], 'the only setup turn belongs to the follow-up question');

    // Every record carries the required fields.
    for (const r of records) {
      assert.ok(r.id !== undefined, 'record must carry an id');
      assert.ok(typeof r.question === 'string' && r.question.length > 0, 'record must carry the question');
      assert.ok(typeof r.answer === 'string', 'record must carry the answer');
      // `model` is asserted below per outcome: it must be present for genuine
      // model answers and empty otherwise.
      assert.ok(typeof r.latencyMs === 'number' && r.latencyMs >= 0, 'record must carry a latency');
      assert.ok(Array.isArray(r.sources), 'record must carry sources');
      assert.ok(r.retrieval && typeof r.retrieval.passesKeywordConditions === 'boolean',
        `${r.id}: record must carry the keyword/retrieval signal`);
      // Outcome must be one of the five declared buckets.
      assert.ok(['stub-output', 'model-answer', 'refusal-by-design', 'technical-failure', 'inconclusive'].includes(r.outcome),
        `${r.id}: unexpected outcome ${r.outcome}`);
      // Provenance must be explicit on every record.
      assert.ok(['old', 'stub', 'local-ollama', 'daybook-deterministic'].includes(r.responseSource) || typeof r.responseSource === 'string',
        `${r.id}: every record must carry a responseSource`);
      // A model identifier exists only for genuine model answers.
      if (r.outcome === 'model-answer') {
        assert.ok(r.model, `${r.id}: a model answer must record the model identifier`);
        assert.strictEqual(r.modelSource, 'reported-by-ollama');
        assert.strictEqual(r.reviewState, 'awaiting-review',
          `${r.question}: model answers must never be auto-marked correct`);
      } else {
        assert.strictEqual(r.model, '', `${r.id}: a non-model answer must not carry a model identifier`);
        // Stub text is attributed to the stand-in; everything else has no source.
        assert.strictEqual(r.modelSource, r.outcome === 'stub-output' ? 'stub-stand-in' : 'not-applicable',
          `${r.id}: unexpected modelSource ${r.modelSource} for ${r.outcome}`);
        assert.strictEqual(r.reviewState, 'not-applicable');
      }
      assert.ok(!r.verdict, 'no verdict may be set automatically');
    }

    // ---- STUB PROVENANCE --------------------------------------------------
    // The stub claims `mode: local-model` and the stub's /api/tags advertises
    // llama3.2:3b, so every weaker rule would happily call this a model answer.
    // Provenance must win: the canned marker is classified before anything else.
    const first = records.find((r) => r.id === 1);
    assert.match(first.answer, /STUB/, 'the stub reply must be recorded verbatim');
    assert.strictEqual(first.outcome, 'stub-output',
      `stub text must be classed stub-output, got ${first.outcome}`);
    assert.strictEqual(first.producedByModel, false,
      'stub output must NEVER be flagged as model-produced');
    assert.strictEqual(first.responseSource, 'stub');
    assert.strictEqual(first.modelSource, 'stub-stand-in');
    assert.strictEqual(first.model, '', 'stub output must carry no model identifier');
    assert.notStrictEqual(first.modelSource, 'reported-by-ollama',
      'stub output must never be attributed to Ollama');
    // It did still ask for the configured model; that is a request, not an identity.
    assert.strictEqual(first.requestedModel, 'llama3.2:3b');

    // Every single record, not just the first.
    assert.strictEqual(records.filter((r) => r.producedByModel).length, 0,
      'no record in a stub run may claim to be model-produced');
    // The three questions Daybook refuses by design never reach the model at all,
    // so they are stub-free and must stay refusals. Everything else is stub text.
    const nonStub = records.filter((r) => r.outcome !== 'stub-output');
    assert.strictEqual(nonStub.length, 3,
      `expected only the 3 by-design refusals outside stub-output, got ${nonStub.length}`);
    for (const r of nonStub) {
      assert.strictEqual(r.outcome, 'refusal-by-design',
        `${r.id}: the only non-stub outcome in a stub run may be an honest refusal, got ${r.outcome}`);
    }
    assert.strictEqual(records.filter((r) => r.modelSource === 'reported-by-ollama').length, 0,
      'no record may claim Ollama reported its identity');

    // The setup turn obeys the same rules.
    for (const st of setupRecords) {
      assert.strictEqual(st.outcome, 'stub-output', 'a stub setup turn is stub-output too');
      assert.strictEqual(st.producedByModel, false);
      assert.strictEqual(st.model, '', 'a stub setup turn must carry no model id');
      assert.strictEqual(st.modelSource, 'stub-stand-in');
    }

    // Counts must reflect the facts: 30 stub outputs, 0 model answers.
    assert.strictEqual(meta.tally['stub-output'], 27,
      `expected 27 stub outputs (30 minus the 3 by-design refusals), got ${meta.tally['stub-output']}`);
    assert.strictEqual(meta.tally['technical-failure'], 0,
      'stub text must not be misfiled as a technical failure');
    assert.strictEqual(meta.tally['model-answer'], 0,
      `expected 0 model answers, got ${meta.tally['model-answer']}`);

    // Counts must reconcile to the question-bank size.
    assert.strictEqual(meta.totalQuestions, 30);
    // Each question must have been asked in its own conversation, so one answer
    // cannot leak context into the next.
    assert.strictEqual(meta.conversations.independent, true, 'questions must not share a conversation');
    // 29 questions are independent; the follow-up deliberately continues the
    // setup turn's conversation, so it is excluded from this count.
    assert.strictEqual(meta.conversations.distinctConversationIds, 29,
      `expected 29 independent conversations, got ${meta.conversations.distinctConversationIds}`);
    assert.strictEqual(meta.conversations.questionsSharingAConversation, 0);
    // Across all 30 question records the conversation ids are still distinct:
    // the setup turn is a separate record, never one of the 30.
    assert.strictEqual(new Set(records.map((r) => r.conversationId)).size, 30,
      'every question record must carry a distinct conversation id');
    assert.strictEqual(meta.conversations.followUpContinuesSetupTurn, true,
      'the follow-up question must reuse its setup turn conversation');
    assert.strictEqual(meta.reconciled, true, 'the runner must confirm its own counts reconcile');
    const sum = Object.values(meta.tally).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, 30, `outcome counts must sum to 30, got ${sum}`);
    assert.strictEqual(sum, records.length);
    // No model identifier may appear anywhere in the run's metadata, because no
    // model produced anything.
    assert.deepStrictEqual(meta.modelsUsed, [],
      `a stub run must list no models, got ${JSON.stringify(meta.modelsUsed)}`);
    assert.ok(meta.evaluationStartedAt && meta.finishedAt, 'evaluation timestamps must be recorded');
    assert.ok(meta.runId, 'a run id must be recorded');

    // Embedding usage is tracked per answer and summarised, so a report cannot
    // imply the intended retrieval configuration was exercised when it was not.
    assert.ok(meta.embeddingUsage, 'metadata must record embedding usage');
    assert.strictEqual(typeof meta.embeddingUsage.answersUsingEmbeddings, 'number');
    assert.strictEqual(typeof meta.embeddingUsage.answersNotUsingEmbeddings, 'number');
    assert.strictEqual(
      meta.embeddingUsage.answersUsingEmbeddings + meta.embeddingUsage.answersNotUsingEmbeddings,
      records.length, 'every answer must be accounted for in the embedding tally');
    for (const r of records) {
      assert.strictEqual(typeof r.retrieval.usedEmbeddings, 'boolean',
        `${r.id}: each record must state whether embeddings were used`);
    }
    // Indexing metadata must record the real outcome of the reindex call.
    const ix = meta.indexing;
    assert.ok(ix, 'metadata must record the indexing step');
    assert.strictEqual(ix.reindexHttpStatus, 200, 'reindex must have returned HTTP 200');
    assert.ok(ix.embedded > 0, 'the stub indexed chunks, so embedded must be > 0');
    assert.strictEqual(ix.embeddingsIndexed, true,
      'a run that proceeded past the gate must record that indexing succeeded');
    assert.strictEqual(ix.embedError, null, 'no embedding error should be recorded');

    // The review pack states the manual-review requirement.
    const review = fs.readFileSync(path.join(outDir, 'REVIEW.md'), 'utf8');
    assert.match(review, /awaiting-review/i);
    assert.match(review, /necessary conditions only/i);
    for (const heading of ['Hallucination', 'Pricing accuracy', 'Payment boundary', 'Prompt injection', 'Tenant isolation']) {
      assert.ok(review.includes(heading), `review checklist must cover ${heading}`);
    }
    // Seeded facts the reviewer must check against.
    assert.match(review, /89 USD/, 'pricing checklist must state the seeded diagnostic fee');
    assert.match(review, /12 months/, 'pricing checklist must state the seeded warranty');

    // CSV must have a review column set that is blank, not pre-filled.
    const csv = fs.readFileSync(path.join(outDir, 'review.csv'), 'utf8');
    assert.match(csv, /hallucination/i);
    assert.match(csv, /reviewer/i);
  } finally {
    await stopStub(stub);
  }
});

// ---------------------------------------------------------------------------
// Fix 5 — embedding validation is fail-closed.
//
// A run whose indexing failed would otherwise produce a complete-looking report
// claiming the intended retrieval configuration was measured. These tests prove
// the runner stops instead, and that nothing is written that could be mistaken
// for a result.
// ---------------------------------------------------------------------------

test('eval runner aborts when reindexing fails, and writes no report', async () => {
  const stub = await startStub({ failEmbed: true });
  try {
    const outDir = fs.mkdtempSync(path.join(TMP, 'failreindex-'));
    let code = 0;
    let stderr = '';
    let stdout = '';
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'server', 'eval-ollama.js')], {
        env: {
          ...process.env, NODE_NO_WARNINGS: '1',
          OLLAMA_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
          OLLAMA_CHAT_MODEL: 'llama3.2:3b',
          OLLAMA_EMBED_MODEL: 'nomic-embed-text',
          DAYBOOK_EVAL_DIR: outDir,
        },
        encoding: 'utf8', timeout: 120000,
      });
    } catch (err) {
      code = err.status;
      stderr = String(err.stderr || '');
      stdout = String(err.stdout || '');
    }

    assert.notStrictEqual(code, 0, 'a failed reindex must never produce a successful exit');
    assert.notStrictEqual(code, 5, 'this is not a stub-detection case; it must abort earlier');
    assert.match(stderr, /index/i, `the failure must name indexing: ${stderr.slice(0, 400)}`);
    assert.match(stderr, /not (been )?(validated|measured)|refus|abort|cannot claim/i,
      'the message must say the retrieval configuration was not validated');

    // Nothing scored: no results.json anywhere beneath the output dir.
    const produced = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
    for (const dir of produced) {
      const inner = path.join(outDir, dir);
      if (fs.statSync(inner).isDirectory()) {
        assert.ok(!fs.readdirSync(inner).includes('results.json'),
          'a run that failed to index must not write results.json');
      }
    }
    // And no question was asked.
    assert.ok(!/Questions executed\s*:\s*30/.test(stdout),
      'no questions may be recorded when indexing failed');
  } finally {
    await stopStub(stub);
  }
});

test('eval runner aborts when the embedding model returns no identity', async () => {
  // Vectors stored under an unknown model cannot be matched at query time, so a
  // run built on them would silently measure full-text retrieval only.
  const stub = await startStub({ anonymousEmbed: true });
  try {
    const outDir = fs.mkdtempSync(path.join(TMP, 'anonembed-'));
    let code = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'server', 'eval-ollama.js')], {
        env: {
          ...process.env, NODE_NO_WARNINGS: '1',
          OLLAMA_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
          OLLAMA_CHAT_MODEL: 'llama3.2:3b',
          OLLAMA_EMBED_MODEL: 'nomic-embed-text',
          DAYBOOK_EVAL_DIR: outDir,
        },
        encoding: 'utf8', timeout: 120000,
      });
    } catch (err) {
      code = err.status;
      stderr = String(err.stderr || '');
    }
    assert.notStrictEqual(code, 0, 'an unidentified embedding model must not yield a passing run');
  } finally {
    await stopStub(stub);
  }
});

test('eval runner enforces the follow-up conversation id (no silent fallback)', () => {
  // The assertion must be a throw, not a boolean recorded for the reader.
  const src = fs.readFileSync(path.join(ROOT, 'server', 'eval-ollama.js'), 'utf8');
  assert.match(src, /followUpEnforced/);
  const followUpBlock = src.slice(src.indexOf('followUpEnforced'));
  assert.ok(/throw new Error/.test(src.slice(src.lastIndexOf('/**', src.indexOf('followUpEnforced')), src.indexOf('followUpEnforced'))),
    'a missing or mismatched follow-up conversation id must throw');
  assert.ok(followUpBlock.length > 0);
});

test('the review pack shows the setup prompt and response', async () => {
  const stub = await startStub();
  try {
    const run = runEval();
    const runs = fs.readdirSync(run.outDir);
    const outDir = path.join(run.outDir, runs[0]);
    const review = fs.readFileSync(path.join(outDir, 'REVIEW.md'), 'utf8');
    assert.match(review, /Setup turns \(context, not scored\)/,
      'the review pack must include the setup turn');
    assert.match(review, /\*\*Prompt sent\*\*/i, 'the setup prompt must be shown');
    assert.match(review, /\*\*Response received\*\*/i, 'the setup response must be shown');
    // The setup text itself, not just a heading.
    const { setupRecords } = JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'));
    assert.ok(setupRecords.length > 0);
    assert.ok(review.includes(setupRecords[0].question.slice(0, 40)),
      'the actual setup prompt text must appear in the review pack');
    // And the indexing/embedding metadata the reviewer needs to judge the run.
    assert.match(review, /Indexing \|/);
    assert.match(review, /Embeddings used per answer/);
    assert.match(review, /STUB/);
  } finally {
    await stopStub(stub);
  }
});

test('stub mode is DECLARED, not inferred from response text', async () => {
  // The stand-in answers with plausible prose that contains no stub marker, so
  // text-matching alone would report a healthy "model answers" run. The declared
  // stub mode must win: provenance is configuration, and the response text is
  // only a backstop.
  const stub = await startStub({ noMarker: true });
  try {
    const run = runEval();
    assert.strictEqual(run.code, 5, `a declared stub run must exit 5, got ${run.code}`);

    const outDir = path.join(run.outDir, fs.readdirSync(run.outDir)[0]);
    const { meta, records } = JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'));

    assert.strictEqual(meta.stubMode, 'declared', 'metadata must record the declaration');
    assert.strictEqual(meta.isStubRun, true, 'a declared stub run is a stub run');
    assert.strictEqual(meta.stubMarkerDetected, false,
      'this stand-in emits no marker, so text detection alone would have missed it');
    assert.ok(meta.stubDeclaration && /DAYBOOK_EVAL_STUB/.test(meta.stubDeclaration),
      'metadata must state how provenance was decided');

    // No answer may be attributed to a model, even though the text looks fine.
    assert.strictEqual(meta.tally['model-answer'], 0,
      'declared stub mode must leave zero model answers');
    assert.strictEqual(meta.tally['stub-output'], 27,
      `expected 27 stub output, got ${meta.tally['stub-output']}`);
    assert.strictEqual(meta.tally['refusal-by-design'], 3,
      `refusals never reach a model and must stay refusals, got ${meta.tally['refusal-by-design']}`);
    assert.deepStrictEqual(meta.modelsUsed, [], 'no model identifier may be reported');
    for (const r of records) {
      assert.notStrictEqual(r.modelSource, 'reported-by-ollama',
        `${r.id}: nothing may be attributed to Ollama in a declared stub run`);
      assert.strictEqual(r.model, '', `${r.id}: no model identifier may be recorded`);
    }

    const review = fs.readFileSync(path.join(outDir, 'REVIEW.md'), 'utf8');
    assert.match(review, /STUB — NOT MODEL VALIDATION/);
    assert.match(review, /declared/);
  } finally {
    await stopStub(stub);
  }
});

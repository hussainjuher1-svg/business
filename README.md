# Daybook

Daybook is a business-management platform for small service businesses with a **local-only AI assistant** ("Ask Daybook") that answers from the owner's own business knowledge and live Daybook records.

No paid AI APIs. No API keys. No silent cloud fallback. No fabricated data.

## What it does

- **Today** — Needs Your Attention, Happening Today, Your Next Steps (all from live data)
- **Inquiries** — create, search, filter, assign, track status, convert to customer
- **Customers** — full records with related inquiries, estimates, appointments, jobs, follow-ups, activity history
- **Work** — Estimates, Appointments, Jobs, Follow-ups
- **Knowledge** — the Business Knowledge Center (see below)
- **Settings** — business profile, staff & roles, local AI configuration
- **Ask Daybook** — answers with cited sources, flags gaps and conflicts, drafts editable messages

## The local AI rule

Daybook talks to **one** inference provider: an Ollama server running locally.

```
server/src/ai/ollama.js   ← the ONLY file that contacts a model
```

- If that server is unreachable or the model is not pulled, Daybook **says so plainly** and falls back to showing the retrieved evidence it did find. It never substitutes a paid provider, and it never fakes a generated answer.
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are deliberately **not** supported. Setting them does nothing.
- The application stays fully usable while the model is offline: all records, search, and knowledge management keep working.

### Setting up Ollama

```bash
# install from https://ollama.com, then:
ollama serve
ollama pull llama3.2:3b        # chat model
ollama pull nomic-embed-text   # embeddings (optional but recommended)
```

Configure via `.env` (see `.env.example`) or per-business in **Settings → Local AI**.

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama endpoint |
| `OLLAMA_CHAT_MODEL` | `llama3.2:3b` | Generation model |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embedding model |

`llama3.2:3b` is ~2 GB and runs on a laptop CPU. Any Ollama chat model works.

> **Deployment note:** if Daybook is hosted on a remote server, that server cannot reach `localhost` Ollama on the owner's machine. Local-only AI means Daybook is designed to run where Ollama runs (owner's machine or their own LAN/host). It needs no internet connection to answer questions.

## Business Knowledge Center

Everything the assistant may treat as a business fact lives here, scoped to one business.

**Categories:** business profile, services, pricing & estimate rules, business hours, holidays, service areas, policies, warranties, FAQs, staff & responsibilities, operating procedures, customer instructions, communication guidelines, other.

**Three ways to get knowledge in:**
1. **Manual entry** — per category, with a source note.
2. **Document upload** — `.txt`, `.md`, `.csv`, `.json`, text-based `.pdf`, `.docx` (max 10 MB). Text is extracted and chunked. Scanned/image-only PDFs and legacy `.doc` are reported as *unsupported* rather than silently treated as empty.
3. **CSV import** — `category,title,content` for knowledge; `name,phone,email,address,notes` for customers. Preview before importing; invalid rows are rejected with row numbers.

**Provenance:** every entry stores its `source` (manual / onboarding / csv_import / document / seed), a free-text `source_detail`, and `last_updated` + who changed it. Answers surface these.

**Accuracy controls:**
- An entry can **supersede** an older one; the older is archived and shown as outdated rather than silently winning.
- Two active entries with the same title but different content are reported as a **conflict**.
- Deleting or archiving an entry removes its retrieval chunks immediately.

## How retrieval works

```
question
  → intents (knowledge categories + which operational tools apply)
  → hybrid search over ONE business only:
       FTS5 BM25 (stemmed prefix terms)  +  local Ollama embeddings (cosine)
       re-ranked by term coverage, title coverage, category affinity
  → only chunks that genuinely overlap the question become citable evidence
  → bounded operational queries (SQL) for live records
  → local model, strictly grounded, or deterministic evidence if it is offline
```

Key properties:

- **Business isolation is enforced in SQL.** Every retrieval query filters `business_id`; there is no post-hoc filtering.
- **Never the whole database.** Top-k chunks only (default 6), plus the specific records the question needs (max 4 tool calls).
- **Exact numbers come from SQL**, not from the model. Counts, totals and dates are pre-computed and handed over as facts to cite.
- **Relevance gating.** Weakly-matching chunks are dropped so the model cannot be nudged into a plausible-but-unsupported answer.
- **Cache** applies only to repeated *knowledge-only* questions, keyed by a knowledge version that increments on every change. Operational/personal questions are never cached.

## Security

- **Prompt injection:** untrusted text (documents, customer notes, inquiry messages) is screened at ingest and at read time against injection patterns. Flagged chunks are quarantined — stored for owner review, excluded from answers — and every prompt states that evidence is data, never instruction.
- **Cross-business isolation:** tested both ways. A member of business A cannot read business B's knowledge through chat or by passing a foreign `businessId` (403).
- **Role enforcement:** only `owner`/`admin` can write knowledge, upload documents, import CSVs, or change AI settings.
- **No credential exposure:** the system prompt is never echoed, and there is no cloud key to leak.

## Architecture

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Vite + Tailwind |
| Backend | Node.js + Express (`/api`) |
| Database | SQLite via `node:sqlite` (WAL), file `data/daybook.db` |
| Full-text | SQLite FTS5 (`unicode61`) |
| Vectors | float32 BLOBs, cosine in-process |
| Auth | httpOnly session cookie, scrypt hashing, server-side role checks |
| AI | Ollama (local) only |

```
server/src/
  ai/ollama.js       local provider + availability status
  ai/retrieval.js    chunking, indexing, hybrid search, scoring
  ai/operations.js   SQL tools for live records (business-scoped)
  ai/guard.js        prompt-injection screening/sanitising
  ai/extract.js      text extraction (txt/md/csv/json/pdf/docx)
  ai/assistant.js    the engine: intents → evidence → grounded answer
  knowledge.js       Knowledge Center API (CRUD, upload, CSV import)
  onboarding.js      guided setup + completeness checklist
  assistant.js       assistant HTTP API
```

## Quick start

```bash
npm install
npm --prefix server install
npm --prefix client install

npm run db:migrate
npm run db:seed

npm run dev      # API on :3001, frontend on :5173
# or: npm run build && npm start   (API serves the built client on :3001)
```

Demo logins (all seed data is clearly labelled **Demo Data**):

| Account | Email | Password |
|---|---|---|
| Business A (main demo) | `demo@daybook.local` | `demo1234` |
| Staff member | `tech@daybook.local` | `demo1234` |
| Business B (isolation test) | `rival@daybook.local` | `demo1234` |

Business A ships with ~20 knowledge entries across every category, 4 priced services, an uploaded price sheet, an outdated+superseding policy pair, a deliberately hostile document, a prompt-injection customer inquiry, and live customers/inquiries/estimates/appointments/jobs/follow-ups. Business B exists only to prove isolation.

## Testing

```bash
npm test
```

33 tests against the real HTTP API and a real seeded database. They are written to fail on fabrication or leakage, and cover:

- business FAQ, pricing and policy accuracy
- live operational questions (pending estimates, today's appointments, what is delaying a job, weekly summary)
- follow-up questions in a conversation
- outdated / superseded / conflicting knowledge
- missing information — must say so instead of inventing
- **every number in a non-model answer must be traceable to a cited source**
- cross-business isolation in both directions + foreign `businessId` attempts
- unauthenticated access (401) and role enforcement (403)
- prompt injection from documents *and* from customer notes
- document upload, unsupported-file honesty, CSV import (incl. duplicate skipping), retrieval after upload, and removal after delete
- **model disconnection**: with Ollama pointed at a closed port, answers must report `model-offline` and must never impersonate a model
- a static assertion that no paid provider endpoint or key exists in the assistant

Run tests with Ollama **stopped** to verify the offline path, and again with it running to exercise grounded generation.

## Environment

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (3001) | API port |
| `NODE_ENV` | No | `production` for secure cookies |
| `DB_PATH` | No | SQLite path (default `./data/daybook.db`) |
| `OLLAMA_BASE_URL` | No | Local Ollama endpoint |
| `OLLAMA_CHAT_MODEL` | No | Chat model name |
| `OLLAMA_EMBED_MODEL` | No | Embedding model name |

## Operational notes

- Migrations run automatically on start (`server/migrations/`, tracked in `schema_migrations`).
- Seed is idempotent.
- Backup: copy `data/daybook.db` (WAL mode — copy `-wal`/`-shm` too, or checkpoint first).
- Changing the embedding model requires **Settings → Local AI → Re-index knowledge**.
- Embeddings are optional. Without them retrieval still works via FTS5; the assistant warns that semantic search is unavailable.

-- Daybook Knowledge Center + local AI (Ollama) schema
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Business knowledge items (the owner-authored knowledge base)
-- Every row is scoped to a single business and carries provenance + recency.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'profile','service','pricing','hours','holiday','service_area','policy',
    'warranty','faq','staff','procedure','customer_instruction',
    'communication_guideline','other'
  )),
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  -- provenance: where this fact came from, so answers can cite it honestly
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','onboarding','csv_import','document','seed')),
  source_detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  -- conflict handling: an item can explicitly supersede an older one
  supersedes_id INTEGER REFERENCES knowledge_items(id) ON DELETE SET NULL,
  effective_date TEXT,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_business ON knowledge_items(business_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_items(business_id, category);
CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_items(business_id, status);

-- ---------------------------------------------------------------------------
-- Uploaded business documents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  doc_type TEXT NOT NULL DEFAULT 'other',
  extracted_text TEXT NOT NULL DEFAULT '',
  text_status TEXT NOT NULL DEFAULT 'pending' CHECK (text_status IN ('pending','extracted','unsupported','empty')),
  source TEXT NOT NULL DEFAULT 'upload',
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_business ON business_documents(business_id);

-- ---------------------------------------------------------------------------
-- Chunks: the single unit of retrieval. Generated from items + documents.
-- Business id is denormalised here so every retrieval query can filter on it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('item','document','catalog')),
  source_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  -- prompt-injection screening result, recorded at ingest time
  injection_flag INTEGER NOT NULL DEFAULT 0,
  injection_reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_business ON knowledge_chunks(business_id);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON knowledge_chunks(source_type, source_id);

-- Full-text index. Kept as a standalone FTS5 table with rowid = knowledge_chunks.id
-- so sync is explicit and predictable (no external-content triggers).
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
  title,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Local embeddings produced by a configurable Ollama embedding model.
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_embeddings_business ON knowledge_embeddings(business_id);

-- ---------------------------------------------------------------------------
-- Per-business AI configuration (local-only by design)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_ai_settings (
  business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  chat_model TEXT NOT NULL DEFAULT '',
  embed_model TEXT NOT NULL DEFAULT '',
  strict_grounding INTEGER NOT NULL DEFAULT 1,
  cache_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bumped whenever knowledge changes, so cached answers can be invalidated.
CREATE TABLE IF NOT EXISTS business_knowledge_version (
  business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cache for repeated, non-sensitive knowledge-only answers.
-- Rows referencing operational/personal records are never stored here.
CREATE TABLE IF NOT EXISTS answer_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  knowledge_version INTEGER NOT NULL,
  embed_model TEXT NOT NULL DEFAULT '',
  answer_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_answer_cache_key ON answer_cache(business_id, question_key, knowledge_version, embed_model);

-- ---------------------------------------------------------------------------
-- Assistant message enrichment: evidence, mode, gaps, timing
-- ---------------------------------------------------------------------------
ALTER TABLE assistant_messages ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
ALTER TABLE assistant_messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'knowledge';
ALTER TABLE assistant_messages ADD COLUMN gaps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE assistant_messages ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]';
ALTER TABLE assistant_messages ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Onboarding state (steps are also derivable from data; this records intent)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onboarding_state (
  business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  completed_steps TEXT NOT NULL DEFAULT '[]',
  dismissed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Pricing detail on services (needed for honest pricing answers)
-- ---------------------------------------------------------------------------
ALTER TABLE business_services ADD COLUMN price_min REAL;
ALTER TABLE business_services ADD COLUMN price_max REAL;
ALTER TABLE business_services ADD COLUMN price_note TEXT NOT NULL DEFAULT '';
ALTER TABLE business_services ADD COLUMN duration_minutes INTEGER;
ALTER TABLE business_services ADD COLUMN last_updated TEXT NOT NULL DEFAULT (datetime('now'));

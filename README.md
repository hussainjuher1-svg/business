# Daybook

Daybook is a simple, intelligent business-management platform for small service businesses. It gives owners one place to see **what needs attention, what is happening today, and what to do next** — plus an integrated AI assistant ("Ask Daybook") that answers from real business records.

## What it does

- **Today** — Needs Your Attention, Happening Today, Your Next Steps (all from live data)
- **Inquiries** — create, search, filter, assign, track status, convert to customer
- **Customers** — full records with related inquiries, estimates, appointments, jobs, follow-ups, activity history, duplicate warnings
- **Work** — Estimates, Appointments, Jobs, Follow-ups (create, link, update status, complete/reschedule)
- **Settings** — business profile, services, staff & roles (Owner / Admin / Staff)
- **Ask Daybook** — business FAQ, Daybook help, live business intelligence, summaries, recommendations, editable message drafts (never auto-sent)

## Architecture

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS |
| Backend | Node.js + Express (REST API under `/api`) |
| Database | SQLite (persistent local pilot) via `node:sqlite` — file `data/daybook.db` |
| Auth | Session-based (httpOnly cookie, scrypt password hashing), server-side role checks, business-level data isolation |
| AI | Provider-independent server-side integration (OpenAI or Anthropic when keys are set; otherwise a built-in assistant that answers from real DB records) |

All business-owned records are scoped by `business_id` and every endpoint enforces membership + role on the server.

## Quick start

```bash
# 1. Install
npm install
npm --prefix server install
npm --prefix client install

# 2. Database (migrations + demo seed)
npm run db:migrate
npm run db:seed

# 3. Run (API on :3001 + frontend on :5173)
npm run dev
```

Open http://localhost:5173 and log in with the demo account:

- **Email:** `demo@daybook.local`
- **Password:** `demo1234`

> All seed records are clearly labelled "Demo" — they are demonstration data, not real customer activity.

Or create your own account via **Create account** (creates a new business with you as Owner).

## Production build

```bash
npm run build          # builds client/dist
npm start              # serves API + built client on :3001
```

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default 3001) | API port |
| `NODE_ENV` | No | Set to `production` for secure cookies |
| `DB_PATH` | No | SQLite file path (default `./data/daybook.db`) |
| `OPENAI_API_KEY` | No | Enables OpenAI LLM for the assistant |
| `ANTHROPIC_API_KEY` | No | Enables Anthropic LLM for the assistant |
| `AI_MODEL` | No | Override model name |

Without an AI key, the assistant still works fully — it answers from real database records using its built-in engine. No fake numbers are ever generated.

## Database

- Schema: `server/migrations/001_init.sql` (users, businesses, memberships, sessions, customers, inquiries, estimates, appointments, jobs, follow_ups, activity_logs, business_services, assistant_conversations/messages)
- Migrations run automatically on server start (`server/src/migrate.js` tracks applied files in `schema_migrations`)
- Seed: `server/seed.js` (idempotent; skips if demo data exists)
- Backup: copy `data/daybook.db` (SQLite WAL mode — also copy `-wal`/`-shm` or checkpoint first). For a hosted multi-business product, migrate to PostgreSQL — the schema is portable.

## Deployment notes

- Frontend dev server proxies `/api` to the API; production build is served by the API itself.
- For multi-instance hosting, move sessions to a shared store and SQLite to PostgreSQL.
- Set `NODE_ENV=production` and serve behind HTTPS so secure cookies work.

## Testing

End-to-end workflows verified against the running API: register → create customer → create inquiry → update status → convert → create estimate → create/complete follow-up → create appointment → create/update job → dashboard reflects changes → assistant answers from live data → cross-business access denied → data persists after restart.

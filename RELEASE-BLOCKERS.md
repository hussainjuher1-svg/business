# Daybook — Release Blocker Report

**Date:** 2026-11-11
**Branch:** `arena/8cbb0540-business`
**Scope:** the four release blockers only. No new features, no redesign.

> **Release readiness is NOT claimed.** Real AI generation remains unvalidated:
> Ollama is not installed in this sandbox, `127.0.0.1:11434` refuses
> connections, and no model weights are reachable. Every result below was
> produced by the **deterministic evidence path**, never by a language model.
> Nothing in this report measures model output quality.

---

## 1. Summary

| # | Blocker | Status | Tests |
|---|---|---|---|
| 1 | Login rate limiting | **Fixed** | 5 |
| 2 | Demo accounts/credentials cannot enter production | **Fixed** | 3 |
| 3 | Forced password change for retained demo accounts | **Fixed** | 6 |
| 4 | Payment terms vs. no invoice tracking | **Fixed** | 5 |
| — | Tenant isolation regression | **Intact** | 3 |

Two further defects were found by the new tests and fixed in the same pass:

- **`X-Forwarded-For` bypass (blocker 1).** The limiter read the header
  directly, so a client could send a random value per request and never be
  throttled. The header is now only honoured when `TRUST_PROXY` is configured,
  in which case Express resolves `req.ip` from the trusted side.
- **Payment disclaimer bypass (blocker 4).** "Which customers have unpaid
  invoices?" matched the live-customer tool, so it returned a customer list
  instead of the capability boundary — implying Daybook knew something about
  settlement it does not. Settlement questions are now decided before any
  evidence branch.

---

## 2. Blocker 1 — Login rate limiting

**Behaviour.** Two independent SQLite-backed buckets: 5 failures per account per
15 minutes, 20 per source address per 15 minutes. The limiter answers *before*
password verification, so knowing the password does not defeat a lockout.
Returns HTTP `429` with a `Retry-After` header, `retryAfterSeconds` and `scope`.
A successful login clears that account's streak. Attempts persist across a
restart. Env-tunable: `LOGIN_MAX_PER_EMAIL`, `LOGIN_MAX_PER_IP`,
`LOGIN_WINDOW_MINUTES`, `LOGIN_LOCKOUT_MINUTES`, `LOGIN_IP_LOCKOUT_MINUTES`.

The per-IP backstop is deliberately *narrower* than the per-account lockout: it
is released after a short quiet spell so one person mistyping a password cannot
freeze a shared office IP for 15 minutes.

**Verified**

| Test | Result |
|---|---|
| 5 failures allowed, 6th returns 429 | pass |
| Locked account refuses the **correct** password | pass |
| Forged `X-Forwarded-For` cannot reset the bucket | pass |
| With `TRUST_PROXY`, the forwarded client address is used per client | pass |
| Success clears only that account's streak | pass |
| Attempts survive a process restart | pass |

---

## 3. Blocker 2 — Demo credentials cannot enter production

**Behaviour.** `server/seed.js` and `server/seed-hvac.js` call
`assertSeedingAllowed()` **before `migrate()`**, so in `NODE_ENV=production`
they exit non-zero and write nothing — not even schema. `DAYBOOK_ALLOW_DEMO_SEED=true`
overrides this for a throwaway staging box only. A production boot that finds
retained demo accounts logs a loud warning naming them. Every account the seeds
create or recognise is flagged `is_demo=1`.

**Verified.** Both scripts exit non-zero in production with an explicit message,
and the resulting database contains **zero tables** (asserted on
`sqlite_master`, not on file existence — `db.js` creates an empty file at
require time). Production boot emits:
`WARNING: N demo account(s) exist in a PRODUCTION deployment (...). Delete them before real use.`

---

## 4. Blocker 3 — Forced password change

**Behaviour.** New columns `is_demo`, `must_change_password`,
`password_changed_at`. On boot, any demo account that still verifies `demo1234`
is flagged. A flagged session is blocked from **every** `/api` route except
`auth/me`, `auth/change-password`, `auth/logout`, `auth/login`,
`auth/register`, with `403 PASSWORD_CHANGE_REQUIRED` and a reason. The change
requires the current password, forbids reuse, applies the shared policy
(≥10 chars, blocklist, not all-numeric, not one repeated character, ≥2 character
classes), then revokes **all** sessions and issues one fresh session. The
published `demo1234` stops working afterwards.

**Verified**

| Test | Result |
|---|---|
| All 11 business endpoints return 403 before the change | pass |
| `auth/me` stays reachable so the UI can discover the requirement | pass |
| The flag cannot be cleared through an app write endpoint | pass |
| A real registered account is never gated | pass |
| Rotation unlocks the app and kills the old password | pass |
| The change revokes other sessions | pass |
| Boot-time enforcement flags a demo account back on `demo1234` | pass |

---

## 5. Blocker 4 — Payment terms vs. no invoice tracking

**Finding.** Grepping the schema confirms **no invoice, payment, receipt ledger
or balance table exists**. The mismatch was purely a knowledge-vs-capability
wording problem. Because the capability genuinely does not exist, the fix is
honesty, not new functionality.

**Behaviour.** One shared sentence lives in `server/src/ai/assistant.js`:

> "I can tell you what your payment terms say, and I can show estimate status —
> but Daybook does not track invoices or payments, so I cannot tell you who has
> paid, what is outstanding, or how old a debt is. Payment terms are recorded as
> business knowledge; invoice and payment records live in your accounting
> system."

Settlement questions are answered with it and cite **no** sources. Terms
questions ("What are our payment terms?") remain in scope and are answered from
stored knowledge. The distinction is explicit: an invoice/billing word combined
with a settlement word means settlement state; a bare "overdue" does not, so
"which follow-ups are overdue?" still works. `Settings → Payment methods` carries
the same boundary.

**Verified.** Five settlement phrasings each return the boundary, mode
`out-of-scope`, zero sources and **no money figure** (any number would be
invented, since no such data exists). Terms questions still reach stored
knowledge. The schema contains no payment table.

---

## 6. Test isolation (rework in this pass)

Every automated test and standalone harness now runs against **its own temporary
database and its own server**, and every caller gets its own cookie jar.

| Harness | Test database | Port |
|---|---|---|
| `npm test` → `assistant.test.js` | `$TMPDIR/daybook-test-*/test.db` | 3101 |
| `npm test` → `release-blockers.test.js` | `$TMPDIR/daybook-rb-*/rb.db` | 3210 |
| `npm test` → `security.test.js` | `$TMPDIR/daybook-sec-*/…` (`security-*`) | 3501, 3502 |
| `validate:hvac` | `$TMPDIR/daybook-validate-hvac-*/validate-hvac.db` | 3201 |
| `audit:pilot` | `$TMPDIR/daybook-audit-pilot-*/audit-pilot.db` | 3301 |
| `verify:persistence` | `$TMPDIR/daybook-persist-*/persist.db` | 3401 |

Shared helpers: `server/test/lib/test-instance.js` (temp DB, seed, spawn,
restart, cleanup) and `server/test/lib/demo-fixture.js` (performs the forced
password rotation the product requires, instead of bypassing the gate).

`verify-persistence.sh` previously read the **live** `data/daybook.db` directly
and inserted a marker row into it. It now builds its own database, and also
proves a pre-restart session cookie still works after a hard `SIGKILL`.

Passwords are never logged. `DAYBOOK_DEMO_PASSWORD` may be supplied to point a
harness at an already-rotated database; it is read from the environment and
never printed, and no new default password was introduced.

---

## 7. Commands executed and actual results

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | **76 tests, 76 pass, 0 fail** (assistant 33 + blockers 24 + security 19) |
| 2 | `npm run test:security` | **19 pass, 0 fail** |
| 3 | `npm run test:blockers` | **24 pass, 0 fail** |
| 4 | `npm run validate:hvac` | **30 passed, 0 failed** — modes `{model-offline: 27, out-of-scope: 2, refused: 1}` |
| 5 | `npm run audit:pilot` | **48 passed, 0 failed** |
| 6 | `npm run verify:persistence` | **ALL CHECKS PASSED** (13/13, real `SIGKILL` restart) |
| 7 | `node server/seed.js` with `NODE_ENV=production` | exits 1, `refused to run`, **0 tables written** |
| 8 | `node server/seed-hvac.js` with `NODE_ENV=production` | exits 1, `refused to run`, 0 tables written |
| 9 | `git diff --check` | clean, exit 0 |
| 10 | Repeat runs (×2) of security/hvac/audit | identical every time: 19/19, 30/30, 48/48 |

**Mutation checks** (each fix was removed to confirm the tests actually catch it):

| Fix removed | Failing tests |
|---|---|
| `X-Forwarded-For` handling reverted to reading the header | 1 (`a forged X-Forwarded-For cannot evade the per-IP bucket`) |
| Early payment-settlement gate disabled | 1 (`settlement questions are refused with the exact capability boundary`) |
| Password-change gate disabled | 2 (`every business endpoint is blocked…`, `the gate is per-session…`) |

All three were restored and the suite returned to green.

---

## 8. Development database protection

`data/daybook.db` was fingerprinted (all 31 table row counts + every user's
`is_demo` / `must_change_password`) **before** the validation run and again after
all seven harness runs.

**Result: no harness touched it.** The only deltas across the entire session are
`login_attempts 3 → 4` and `sessions 2 → 3`, both from my own deliberate live
`curl` login against the preview server to confirm the gate is active in the
running app. No table content, no user row, and no password hash changed. The
database was **not** restored, reseeded or modified as a substitute for
isolation.

---

## 9. Files changed

**New**
- `server/src/login-guard.js` — persistent login throttling
- `server/src/demo-guard.js` — seeding guard, demo marking, password policy
- `server/migrations/003_release_blockers.sql` — `is_demo`, `must_change_password`, `password_changed_at`, `login_attempts`
- `server/test/lib/test-instance.js` — disposable instance helper
- `server/test/lib/demo-fixture.js` — forced-rotation fixture
- `server/test/release-blockers.test.js` — 24 tests
- `server/test/security.test.js` — 19 tests
- `RELEASE-BLOCKERS.md` — this report

**Modified**
- `server/src/routes.js` — rate-limited login, `POST /auth/change-password`, flags on `/auth/me`
- `server/src/index.js` — global password-change gate, `TRUST_PROXY`, boot enforcement
- `server/src/auth.js` — session flags, `destroyAllSessions`
- `server/src/ai/assistant.js` — payment capability boundary, settlement predicate
- `server/seed.js`, `server/seed-hvac.js` — production guard, demo marking
- `server/validate-hvac.js`, `server/audit-pilot.js`, `server/verify-persistence.sh` — isolated instances
- `server/test/assistant.test.js` — rotates demo passwords instead of assuming them
- `client/src/pages/Auth.tsx` — `ChangePassword` screen
- `client/src/pages/Settings.tsx` — payment-tracking scope note
- `client/src/api.ts` — optional `isDemo` / `mustChangePassword`
- `package.json` — `test` now runs all three suites; added `test:blockers`, `test:security`
- `PILOT-READINESS.md` — amendment noting which findings are now fixed

---

## 10. Remaining failures

**None in the executed suites.** 76/76, 30/30, 48/48, 13/13.

---

## 11. Must be tested locally (requires Ollama)

Nothing above exercised a model. The four blockers touch no model path, so their
fixes are independent of Ollama — but the following are **unverified** and must
not be claimed:

1. Whether a real model answer still respects the payment boundary once the
   model *is* reachable. The deterministic paths are tested; the model path is
   prompt-governed and untested.
2. Whether the payment paragraph survives model paraphrasing without drifting
   into an implied capability.
3. Retrieval ranking quality on paraphrase-heavy questions (unchanged by this
   work, still unmeasured).
4. Any end-to-end latency or model-quality claim.

To run locally: install Ollama, `ollama pull` the configured chat model, then
`npm run validate:hvac` and `npm run audit:pilot` — both print which mode
produced each answer, so `model-offline` must disappear for the run to count as
model coverage.

---

## 12. Not done (deliberately)

No invoice/payment tracking was built — the blocker was the false promise, not
the missing feature. No UI redesign, no new AI features, and no changes outside
the four blockers. Email verification, HTTPS enforcement, and multi-business
switching in the UI remain open and are listed in `PILOT-READINESS.md` §9.

# Design proposal — manual customer communication log

**Status: proposal only. Not implemented, by explicit instruction.**

This document describes how a manual record of customer contact could be added
in a later pass. It is deliberately scoped to *recording* conversations a person
already had. Nothing here sends a message.

## Why

Daybook records what happened operationally (inquiries, estimates, jobs,
appointments) but not the conversations around them. When a customer says "I
called about this last Tuesday", there is nowhere to put that fact and nowhere
to read it back. The practical consequences:

- a colleague picking up an inquiry cannot see that someone already phoned;
- there is no honest answer to "when did we last speak to this customer?";
- an estimate chasing cycle has no memory of the chase, only its outcome.

## Why manual only

Sending needs credentials, provider agreements, delivery webhooks, bounce
handling, consent and retention rules, and a failure mode where the software
says "sent" and nothing arrived. That is a substantially different product from
an operations notebook. This proposal adds the notebook and leaves delivery to
the phone, the mailbox and the person.

## Data model

One new table. No changes to existing tables, so existing records are untouched.

```sql
CREATE TABLE communications (
  id                  INTEGER PRIMARY KEY,
  business_id         INTEGER NOT NULL REFERENCES businesses(id),
  customer_id         INTEGER REFERENCES customers(id),
  inquiry_id          INTEGER REFERENCES inquiries(id),
  estimate_id         INTEGER REFERENCES estimates(id),
  job_id              INTEGER REFERENCES jobs(id),
  channel             TEXT NOT NULL,        -- call | email | sms | in_person | other
  direction           TEXT NOT NULL,        -- inbound | outbound
  occurred_at         TEXT NOT NULL,        -- when the conversation happened
  summary             TEXT NOT NULL,        -- what was said, in the owner's words
  outcome             TEXT,                 -- free text: what was agreed
  follow_up_needed    INTEGER NOT NULL DEFAULT 0,
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT
);
CREATE INDEX idx_comms_business_time ON communications(business_id, occurred_at DESC);
CREATE INDEX idx_comms_customer      ON communications(business_id, customer_id);
```

Design notes:

- **`occurred_at` is separate from `created_at`.** People write things up later.
  Collapsing the two makes the log lie about when a conversation happened.
- **All the links are optional but at least one of `customer_id` and `inquiry_id`
  should be present.** Enforced in the route, not as a CHECK, so a record does not
  become un-editable if a linked row is later removed.
- **`channel` and `direction` are closed sets** validated with zod, matching how
  `inquiries.status` is already handled. `other` exists so the model does not
  force a wrong choice.
- **`summary` is required.** A log entry with no content is noise.
- No `body_html`, no `recipients`, no `provider_message_id`: those only make sense
  once sending exists.

## Authoring and edit rights

Consistent with the rest of the app:

- any member with access to the business may add an entry;
- the author, an admin, or the owner may edit or delete one;
- deletes are soft (`deleted_at`) so an audit trail survives, matching how
  knowledge entries keep superseded versions.

## API

```
GET    /api/communications?customerId=&inquiryId=&estimateId=&jobId=&channel=&limit=&offset=
POST   /api/communications
PATCH  /api/communications/:id
DELETE /api/communications/:id
```

Every handler resolves `business_id` from the session and filters on it, exactly
like the existing routes; a caller cannot choose whose log they read.

## UI

1. **A "History" section on the customer page**, newest first, with a compact
   inline form: channel, direction, when, what was said. Defaulting `occurred_at`
   to now and `direction` to outbound makes the common case two clicks.
2. **A "Log a conversation" action beside an inquiry or estimate**, which
   pre-fills the link so the entry attaches itself to the work.
3. **A single line on the dashboard**: "Last contact 6 days ago" on the customer,
   shown only when a record exists. Absence of a record must read as "no contact
   logged", never as "no contact happened".
4. **No backfill.** Existing activity history stays where it is; importing it into
   the new table would fabricate conversations nobody actually recorded.

## Deliberate non-goals

- no email/SMS sending, templates, or provider APIs;
- no automatic capture from calls or the mailbox;
- no attachments;
- no reminders derived from the log — follow-ups already exist and should not be
  duplicated;
- no assistant integration in the first version. Once a log exists it becomes
  attractive to retrieve, but customer conversations are far more sensitive than
  policy text and deserve their own review before being fed to a model.

## Risks

| Risk | Mitigation |
| --- | --- |
| Becomes a free-text dumping ground | Required `summary`, closed channel set, link to a real record |
| Feels like a CRM and invites scope creep | Explicit non-goals above; review before adding the first sending feature |
| Sensitive content stored indefinitely | Needs a retention decision before implementation; out of scope here |
| Duplicates follow-ups | A `follow_up_needed` flag on an entry should create nothing; the existing follow-up flow stays authoritative |

## Rough effort

Schema and migration: small. CRUD routes with tenant scoping and tests: small.
Customer-page section and inline form: moderate. The design questions
(retention, who may delete, whether it ever enters retrieval) are the real work
and should be settled before any code is written.

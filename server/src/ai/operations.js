/**
 * Live operational context for the assistant.
 *
 * All numbers come from SQL. The model is never asked to compute, count, or
 * remember anything — it receives already-computed facts with record ids so it
 * can cite them. Every query is scoped to the authenticated business.
 */

const { q, get } = require('../db');

function businessToday(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const OPEN_JOB_STATUSES = ['not_started', 'scheduled', 'in_progress', 'waiting'];
const PENDING_ESTIMATE_STATUSES = ['sent', 'awaiting_response', 'follow_up_needed'];

/** Distinct, cheap intent detection used to decide which tools to run. */
const INTENT_RULES = [
  { name: 'attention', re: /\b(attention|priorit\w*|focus|what should i|next steps?|most important|overdue|behind|caught up)\b/i },
  { name: 'inquiries', re: /\b(inquir\w*|enquir\w*|leads?|new contacts?|respond\w*|response|unanswered|waiting)\b/i },
  { name: 'estimates', re: /\b(estimates?|quotes?|quotations?|pricing pending|pending estimates?|accepted|declined)\b/i },
  { name: 'appointments', re: /\b(appointments?|bookings?|booked|schedul\w*|calendar|visits?)\b/i },
  { name: 'jobs', re: /\b(jobs?|work in progress|delay\w*|blocked|stuck|on site|install\w*|projects?)\b/i },
  { name: 'followups', re: /\b(follow[- ]?ups?|chase|check back|reminders?|due today)\b/i },
  { name: 'customers', re: /\b(customers?|clients?|how many customers|who is|contact details)\b/i },
  { name: 'summary', re: /\b(summar\w*|overview|this week|weekly|activity|how are we|performance|recap|reports?)\b/i },
  { name: 'staff', re: /\b(staff|team|who is working|assign\w*|responsib\w*|employees?|technicians?)\b/i },
  { name: 'comms', re: /\b(communications?|updates?|contacted|last spoke|conversations?|history|messages?)\b/i },
];

function detectIntents(text, previousUserTurns = []) {
  const combined = [text, ...previousUserTurns.slice(-1)].join(' ');
  const found = INTENT_RULES.filter((r) => r.re.test(combined)).map((r) => r.name);

  // Follow-up questions ("what about tomorrow?") often carry no keywords.
  const isShortFollowUp = text.trim().split(/\s+/).length <= 6;
  if (found.length === 0 && isShortFollowUp && previousUserTurns.length) {
    const prev = INTENT_RULES.filter((r) => r.re.test(previousUserTurns[previousUserTurns.length - 1] || '')).map((r) => r.name);
    return [...new Set([...prev, 'attention'])];
  }
  // No operational intent detected: the caller decides whether to fall back to
  // knowledge retrieval only, or to a general attention/summary sweep.
  return [...new Set(found)];
}

function src(kind, id, title, extra = {}) {
  return { kind: 'record', recordType: kind, id, title, ...extra };
}

// ---------------------------------------------------------------------------
// Individual tools. Each returns { data, sources, facts } where `facts` are
// pre-computed statements we are allowed to state with certainty.
// ---------------------------------------------------------------------------

function toolAttention(businessId, today) {
  const newInquiries = q(
    `SELECT i.*, c.name AS customer_name FROM inquiries i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.business_id = ? AND i.status IN ('new','needs_response') ORDER BY i.created_at ASC`,
    [businessId]
  );
  const staleInquiries = q(
    `SELECT i.* FROM inquiries i
     WHERE i.business_id = ? AND i.status IN ('new','needs_response','in_progress')
       AND datetime(i.created_at) < datetime('now', '-3 days')
     ORDER BY i.created_at ASC`,
    [businessId]
  );
  const overdueFollowUps = q(
    `SELECT f.*, c.name AS customer_name FROM follow_ups f LEFT JOIN customers c ON c.id = f.customer_id
     WHERE f.business_id = ? AND f.status = 'open' AND date(f.due_date) < date(?) ORDER BY f.due_date ASC`,
    [businessId, today]
  );
  const dueTodayFollowUps = q(
    `SELECT f.*, c.name AS customer_name FROM follow_ups f LEFT JOIN customers c ON c.id = f.customer_id
     WHERE f.business_id = ? AND f.status = 'open' AND date(f.due_date) = date(?) ORDER BY f.due_date ASC`,
    [businessId, today]
  );
  const pendingEstimates = q(
    `SELECT e.*, c.name AS customer_name FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
     WHERE e.business_id = ? AND e.status IN ('sent','awaiting_response','follow_up_needed')
     ORDER BY COALESCE(e.follow_up_date, e.issue_date) ASC`,
    [businessId]
  );
  const expiringEstimates = q(
    `SELECT e.*, c.name AS customer_name FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
     WHERE e.business_id = ? AND e.status IN ('sent','awaiting_response','follow_up_needed')
       AND e.valid_until IS NOT NULL AND date(e.valid_until) <= date(?, '+7 days')
       AND date(e.valid_until) >= date(?)`,
    [businessId, today, today]
  );
  const unconfirmedAppts = q(
    `SELECT a.*, c.name AS customer_name FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
     WHERE a.business_id = ? AND a.status IN ('scheduled','confirmation_needed')
       AND date(a.starts_at) >= date(?) ORDER BY a.starts_at ASC LIMIT 20`,
    [businessId, today]
  );
  const waitingJobs = q(
    `SELECT j.*, c.name AS customer_name FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
     WHERE j.business_id = ? AND j.status = 'waiting' ORDER BY j.updated_at ASC`,
    [businessId]
  );

  const data = { newInquiries, staleInquiries, overdueFollowUps, dueTodayFollowUps, pendingEstimates, expiringEstimates, unconfirmedAppts, waitingJobs };
  const sources = [
    ...newInquiries.slice(0, 5).map((i) => src('inquiry', i.id, `Inquiry from ${i.contact_name}`)),
    ...overdueFollowUps.slice(0, 5).map((f) => src('follow_up', f.id, f.title)),
    ...pendingEstimates.slice(0, 5).map((e) => src('estimate', e.id, e.title)),
    ...unconfirmedAppts.slice(0, 5).map((a) => src('appointment', a.id, a.title)),
    ...waitingJobs.slice(0, 5).map((j) => src('job', j.id, j.title)),
  ];

  const facts = [];
  if (newInquiries.length) facts.push(`${newInquiries.length} inquiry/inquiries are new or need a response${staleInquiries.length ? ` (${staleInquiries.length} older than 3 days)` : ''}.`);
  if (overdueFollowUps.length) facts.push(`${overdueFollowUps.length} follow-up(s) are overdue, the oldest due ${overdueFollowUps[0].due_date}.`);
  if (dueTodayFollowUps.length) facts.push(`${dueTodayFollowUps.length} follow-up(s) are due today.`);
  if (pendingEstimates.length) facts.push(`${pendingEstimates.length} estimate(s) are awaiting a customer response.`);
  if (expiringEstimates.length) facts.push(`${expiringEstimates.length} estimate(s) expire within 7 days.`);
  if (unconfirmedAppts.length) facts.push(`${unconfirmedAppts.length} upcoming appointment(s) are not confirmed.`);
  if (waitingJobs.length) facts.push(`${waitingJobs.length} job(s) are on hold/waiting.`);
  if (!facts.length) facts.push('Nothing in the live records currently needs urgent attention.');

  return { data, sources, facts };
}

function toolInquiries(businessId) {
  const rows = q(
    `SELECT i.*, c.name AS customer_name, u.name AS assignee FROM inquiries i
     LEFT JOIN customers c ON c.id = i.customer_id
     LEFT JOIN users u ON u.id = i.assigned_to
     WHERE i.business_id = ? ORDER BY i.created_at DESC LIMIT 25`,
    [businessId]
  );
  const counts = q(
    `SELECT status, COUNT(*) AS n FROM inquiries WHERE business_id = ? GROUP BY status`,
    [businessId]
  );
  const facts = counts.map((c) => `${c.n} inquiry/inquiries with status "${c.status}".`);
  if (!rows.length) facts.push('No inquiries recorded yet.');
  return {
    data: { recentInquiries: rows, statusCounts: counts },
    sources: rows.slice(0, 8).map((i) => src('inquiry', i.id, `Inquiry from ${i.contact_name}`, { status: i.status })),
    facts,
  };
}

function toolEstimates(businessId, today) {
  const pending = q(
    `SELECT e.*, c.name AS customer_name FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
     WHERE e.business_id = ? AND e.status IN ('sent','awaiting_response','follow_up_needed')
     ORDER BY COALESCE(e.follow_up_date, e.issue_date) ASC`,
    [businessId]
  );
  const accepted = q(
    `SELECT e.*, c.name AS customer_name FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
     WHERE e.business_id = ? AND e.status = 'accepted' ORDER BY e.updated_at DESC LIMIT 10`,
    [businessId]
  );
  const summary = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
            SUM(CASE WHEN amount IS NOT NULL AND status IN ('sent','awaiting_response','follow_up_needed') THEN amount ELSE 0 END) AS pending_value,
            COUNT(DISTINCT CASE WHEN amount IS NOT NULL AND status IN ('sent','awaiting_response','follow_up_needed') THEN id END) AS pending_priced_count
     FROM estimates WHERE business_id = ?`,
    [businessId]
  );
  const facts = [];
  if (pending.length) {
    facts.push(`${pending.length} estimate(s) are awaiting a response:`);
    for (const e of pending.slice(0, 8)) {
      const bits = [
        `"${e.title}"`,
        e.customer_name ? `customer ${e.customer_name}` : 'no customer linked',
        e.amount != null ? `quoted ${e.amount} ${e.currency || ''}`.trim() : 'no amount recorded',
        `status ${e.status}`,
      ];
      if (e.issue_date) bits.push(`issued ${String(e.issue_date).slice(0, 10)}`);
      if (e.valid_until) bits.push(`valid until ${String(e.valid_until).slice(0, 10)}`);
      if (e.follow_up_date) bits.push(`follow up ${String(e.follow_up_date).slice(0, 10)}`);
      facts.push(`• ${bits.join(', ')}.`);
    }
  }
  if (summary?.pending_value) {
    facts.push(`Those priced pending estimates total ${summary.pending_value} in quoted value across ${summary.pending_priced_count} estimate(s).`);
  }
  if (accepted.length) facts.push(`${accepted.length} recently accepted estimate(s).`);
  if (!pending.length) facts.push('No estimates are currently pending a response.');
  return {
    data: { pendingEstimates: pending, recentlyAccepted: accepted, estimateSummary: summary },
    sources: pending.slice(0, 8).map((e) => src('estimate', e.id, e.title, { status: e.status, amount: e.amount })),
    facts,
  };
}

function toolAppointments(businessId, today) {
  const todayAppts = q(
    `SELECT a.*, c.name AS customer_name, u.name AS assignee FROM appointments a
     LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN users u ON u.id = a.assigned_to
     WHERE a.business_id = ? AND date(a.starts_at) = date(?) AND a.status != 'cancelled' ORDER BY a.starts_at ASC`,
    [businessId, today]
  );
  const upcoming = q(
    `SELECT a.*, c.name AS customer_name, u.name AS assignee FROM appointments a
     LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN users u ON u.id = a.assigned_to
     WHERE a.business_id = ? AND date(a.starts_at) > date(?) AND a.status NOT IN ('cancelled','completed')
     ORDER BY a.starts_at ASC LIMIT 15`,
    [businessId, today]
  );
  const facts = [];
  facts.push(
    todayAppts.length
      ? `${todayAppts.length} appointment(s) on ${today}: ${todayAppts.map((a) => `${String(a.starts_at).slice(11, 16)} ${a.title}${a.customer_name ? ` (${a.customer_name})` : ''} [${a.status}]`).join('; ')}.`
      : `No appointments are scheduled for ${today}.`
  );
  if (upcoming.length) {
    const next = upcoming[0];
    facts.push(`The next appointment is "${next.title}" on ${String(next.starts_at).slice(0, 16)}${next.customer_name ? ` with ${next.customer_name}` : ''}.`);
  }
  return {
    data: { todayAppointments: todayAppts, upcomingAppointments: upcoming },
    sources: [...todayAppts, ...upcoming].slice(0, 8).map((a) => src('appointment', a.id, a.title, { status: a.status, startsAt: a.starts_at })),
    facts,
  };
}

function toolJobs(businessId) {
  const open = q(
    `SELECT j.*, c.name AS customer_name, u.name AS assignee FROM jobs j
     LEFT JOIN customers c ON c.id = j.customer_id LEFT JOIN users u ON u.id = j.assigned_to
     WHERE j.business_id = ? AND j.status IN ('not_started','scheduled','in_progress','waiting')
     ORDER BY COALESCE(j.scheduled_date, j.created_at) ASC`,
    [businessId]
  );
  const recentlyCompleted = q(
    `SELECT j.*, c.name AS customer_name FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
     WHERE j.business_id = ? AND j.status = 'completed' ORDER BY j.updated_at DESC LIMIT 10`,
    [businessId]
  );
  const facts = [];
  const waiting = open.filter((j) => j.status === 'waiting');
  if (waiting.length) {
    facts.push(
      `${waiting.length} job(s) are marked waiting/on hold: ${waiting
        .map((j) => `"${j.title}"${j.customer_name ? ` (${j.customer_name})` : ''} waiting since ${String(j.updated_at).slice(0, 10)}`)
        .join('; ')}.`
    );
  }
  const inProgress = open.filter((j) => j.status === 'in_progress');
  if (inProgress.length) facts.push(`${inProgress.length} job(s) are in progress.`);
  if (open.length) facts.push(`${open.length} job(s) are open in total.`);
  else facts.push('There are no open jobs right now.');
  return {
    data: { openJobs: open, recentlyCompletedJobs: recentlyCompleted },
    sources: open.slice(0, 8).map((j) => src('job', j.id, j.title, { status: j.status })),
    facts,
  };
}

function toolFollowUps(businessId, today) {
  const open = q(
    `SELECT f.*, c.name AS customer_name FROM follow_ups f LEFT JOIN customers c ON c.id = f.customer_id
     WHERE f.business_id = ? AND f.status = 'open' ORDER BY f.due_date ASC`,
    [businessId]
  );
  const overdue = open.filter((f) => String(f.due_date).slice(0, 10) < today);
  const dueToday = open.filter((f) => String(f.due_date).slice(0, 10) === today);
  const facts = [];
  if (overdue.length) facts.push(`${overdue.length} follow-up(s) overdue: ${overdue.slice(0, 6).map((f) => `"${f.title}" due ${String(f.due_date).slice(0, 10)}`).join('; ')}.`);
  if (dueToday.length) facts.push(`${dueToday.length} follow-up(s) due today.`);
  if (!open.length) facts.push('No open follow-ups.');
  return {
    data: { openFollowUps: open, overdueFollowUps: overdue, dueTodayFollowUps: dueToday },
    sources: open.slice(0, 8).map((f) => src('follow_up', f.id, f.title, { dueDate: f.due_date })),
    facts,
  };
}

function toolCustomers(businessId, queryText) {
  const total = get('SELECT COUNT(*) AS n FROM customers WHERE business_id = ?', [businessId])?.n || 0;
  const terms = String(queryText || '').split(/\s+/).filter((t) => t.length > 2).slice(0, 6);
  let matches = [];
  if (terms.length) {
    const like = terms.map(() => '(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.address LIKE ?)').join(' AND ');
    const params = [];
    for (const t of terms) params.push(`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`);
    matches = q(
      `SELECT c.* FROM customers c WHERE c.business_id = ? AND ${like} ORDER BY c.name LIMIT 10`,
      [businessId, ...params]
    );
  }
  const facts = [`${total} customer(s) on record.`];
  if (matches.length) facts.push(`The question matches ${matches.length} customer record(s): ${matches.map((m) => m.name).join(', ')}.`);
  return {
    data: { customerCount: total, matchingCustomers: matches },
    sources: matches.slice(0, 5).map((c) => src('customer', c.id, c.name)),
    facts,
  };
}

function toolSummary(businessId, today, weekStart) {
  const week = {
    newInquiries: get(`SELECT COUNT(*) AS n FROM inquiries WHERE business_id = ? AND date(created_at) >= date(?)`, [businessId, weekStart])?.n || 0,
    newCustomers: get(`SELECT COUNT(*) AS n FROM customers WHERE business_id = ? AND date(created_at) >= date(?)`, [businessId, weekStart])?.n || 0,
    estimatesSent: get(`SELECT COUNT(*) AS n FROM estimates WHERE business_id = ? AND date(COALESCE(issue_date, created_at)) >= date(?)`, [businessId, weekStart])?.n || 0,
    estimatesAccepted: get(`SELECT COUNT(*) AS n FROM estimates WHERE business_id = ? AND status = 'accepted' AND date(updated_at) >= date(?)`, [businessId, weekStart])?.n || 0,
    acceptedValue: get(`SELECT SUM(amount) AS v FROM estimates WHERE business_id = ? AND status = 'accepted' AND date(updated_at) >= date(?)`, [businessId, weekStart])?.v || 0,
    appointmentsHeld: get(`SELECT COUNT(*) AS n FROM appointments WHERE business_id = ? AND date(starts_at) BETWEEN date(?) AND date(?) AND status != 'cancelled'`, [businessId, weekStart, today])?.n || 0,
    jobsCompleted: get(`SELECT COUNT(*) AS n FROM jobs WHERE business_id = ? AND status = 'completed' AND date(updated_at) >= date(?)`, [businessId, weekStart])?.n || 0,
    followUpsCompleted: get(`SELECT COUNT(*) AS n FROM follow_ups WHERE business_id = ? AND status = 'completed' AND date(COALESCE(completed_at, updated_at)) >= date(?)`, [businessId, weekStart])?.n || 0,
  };
  const activity = q(
    `SELECT a.action, a.entity_type, a.details, a.created_at, u.name AS actor FROM activity_logs a
     LEFT JOIN users u ON u.id = a.actor_id WHERE a.business_id = ?
     ORDER BY a.created_at DESC LIMIT 20`,
    [businessId]
  );
  const facts = [
    `This week (since ${weekStart}) there were ${week.newInquiries} new inquiry/inquiries and ${week.newCustomers} new customer(s).`,
    `${week.estimatesSent} estimate(s) issued, ${week.estimatesAccepted} accepted${week.acceptedValue ? ` worth ${week.acceptedValue}` : ''}.`,
    `${week.appointmentsHeld} appointment(s) in the period, ${week.jobsCompleted} job(s) completed, ${week.followUpsCompleted} follow-up(s) completed.`,
  ];
  return {
    data: { weekTotals: week, recentActivity: activity, period: { weekStart, today } },
    sources: [],
    facts,
  };
}

function toolStaff(businessId) {
  const members = q(
    `SELECT u.id, u.name, u.email, m.role FROM business_memberships m
     JOIN users u ON u.id = m.user_id WHERE m.business_id = ? ORDER BY u.name`,
    [businessId]
  );
  const load = q(
    `SELECT u.name AS assignee,
       (SELECT COUNT(*) FROM jobs j WHERE j.business_id = ? AND j.assigned_to = u.id AND j.status IN ('not_started','scheduled','in_progress','waiting')) AS open_jobs,
       (SELECT COUNT(*) FROM appointments a WHERE a.business_id = ? AND a.assigned_to = u.id AND date(a.starts_at) >= date('now') AND a.status NOT IN ('cancelled','completed')) AS upcoming_appointments,
       (SELECT COUNT(*) FROM follow_ups f WHERE f.business_id = ? AND f.assigned_to = u.id AND f.status = 'open') AS open_follow_ups
     FROM business_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.business_id = ? ORDER BY u.name`,
    [businessId, businessId, businessId, businessId]
  );
  const unassignedJobs = get(
    `SELECT COUNT(*) AS n FROM jobs WHERE business_id = ? AND assigned_to IS NULL AND status IN ('not_started','scheduled','in_progress','waiting')`,
    [businessId]
  )?.n || 0;
  const facts = [`${members.length} team member(s) on record.`];
  for (const l of load) {
    if (l.open_jobs || l.upcoming_appointments || l.open_follow_ups) {
      facts.push(`${l.assignee}: ${l.open_jobs} open job(s), ${l.upcoming_appointments} upcoming appointment(s), ${l.open_follow_ups} open follow-up(s).`);
    }
  }
  if (unassignedJobs) facts.push(`${unassignedJobs} open job(s) have no assignee.`);
  return {
    data: { teamMembers: members, workload: load, unassignedJobs },
    sources: members.map((m) => src('staff', m.id, m.name, { role: m.role })),
    facts,
  };
}

function toolComms(businessId) {
  const recent = q(
    `SELECT a.*, u.name AS actor FROM activity_logs a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.business_id = ? ORDER BY a.created_at DESC LIMIT 25`,
    [businessId]
  );
  const waiting = q(
    `SELECT i.*, c.name AS customer_name FROM inquiries i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.business_id = ? AND i.status IN ('new','needs_response')
       AND datetime(i.created_at) < datetime('now','-2 days') ORDER BY i.created_at ASC`,
    [businessId]
  );
  const facts = [];
  if (waiting.length) {
    facts.push(
      `${waiting.length} contact(s) have been waiting more than 2 days for a reply: ${waiting
        .slice(0, 6)
        .map((w) => `${w.contact_name} (${String(w.created_at).slice(0, 10)})`)
        .join(', ')}.`
    );
  } else {
    facts.push('No contacts have been waiting more than 2 days for a reply.');
  }
  return {
    data: { recentActivity: recent, customersAwaitingReply: waiting },
    sources: waiting.slice(0, 6).map((w) => src('inquiry', w.id, `Reply pending: ${w.contact_name}`)),
    facts,
  };
}

function toolSpecificCustomer(businessId, customerId) {
  const customer = get('SELECT * FROM customers WHERE id = ? AND business_id = ?', [customerId, businessId]);
  if (!customer) return null;
  const inquiries = q('SELECT * FROM inquiries WHERE business_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 10', [businessId, customerId]);
  const estimates = q('SELECT * FROM estimates WHERE business_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 10', [businessId, customerId]);
  const appointments = q('SELECT * FROM appointments WHERE business_id = ? AND customer_id = ? ORDER BY starts_at DESC LIMIT 10', [businessId, customerId]);
  const jobs = q('SELECT * FROM jobs WHERE business_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 10', [businessId, customerId]);
  const followUps = q('SELECT * FROM follow_ups WHERE business_id = ? AND customer_id = ? ORDER BY due_date DESC LIMIT 10', [businessId, customerId]);
  const facts = [
    `Customer ${customer.name}${customer.phone ? `, phone ${customer.phone}` : ''}${customer.email ? `, email ${customer.email}` : ''}.`,
    `${inquiries.length} inquiry/inquiries, ${estimates.length} estimate(s), ${appointments.length} appointment(s), ${jobs.length} job(s), ${followUps.length} follow-up(s) on record (most recent 10 each).`,
  ];
  return {
    customer,
    data: { customer, inquiries, estimates, appointments, jobs, followUps },
    sources: [src('customer', customer.id, customer.name)],
    facts,
  };
}

/**
 * Build the operational context for a question.
 * @param {object} opts
 * @param {number} opts.businessId
 * @param {string} opts.timezone
 * @param {string} opts.question
 * @param {string[]} opts.previousUserTurns
 */
function gatherOperationalContext({ businessId, timezone, question, previousUserTurns = [], intents: intentsOverride = null }) {
  const biz = get('SELECT * FROM businesses WHERE id = ?', [businessId]);
  const today = businessToday(timezone || biz?.timezone);
  const weekStart = shiftDate(today, -6);
  const intents = intentsOverride || detectIntents(question, previousUserTurns);

  const tools = {
    attention: () => toolAttention(businessId, today),
    inquiries: () => toolInquiries(businessId),
    estimates: () => toolEstimates(businessId, today),
    appointments: () => toolAppointments(businessId, today),
    jobs: () => toolJobs(businessId),
    followups: () => toolFollowUps(businessId, today),
    customers: () => toolCustomers(businessId, question),
    summary: () => toolSummary(businessId, today, weekStart),
    staff: () => toolStaff(businessId),
    comms: () => toolComms(businessId),
  };

  // Cap tool fan-out so a single question never means "dump the database".
  const ordered = ['attention', 'inquiries', 'estimates', 'appointments', 'jobs', 'followups', 'customers', 'summary', 'staff', 'comms'];
  const chosen = ordered.filter((n) => intents.includes(n)).slice(0, 4);

  const data = {};
  const sources = [];
  const facts = [];
  const toolsUsed = [];

  for (const name of chosen) {
    try {
      const result = tools[name]();
      if (!result) continue;
      toolsUsed.push(name);
      Object.assign(data, result.data);
      facts.push(...result.facts);
      for (const s of result.sources) {
        if (!sources.some((x) => x.recordType === s.recordType && x.id === s.id)) sources.push(s);
      }
    } catch (err) {
      console.error(`[assistant] tool ${name} failed:`, err.message);
    }
  }

  // If the question names a specific customer, pull that record too.
  const customerMatch = q(
    'SELECT id, name FROM customers WHERE business_id = ? AND length(name) > 2 ORDER BY length(name) DESC LIMIT 200',
    [businessId]
  ).find((c) => {
    const first = String(c.name).split(/\s+/)[0];
    return first.length > 2 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(question);
  });
  if (customerMatch) {
    const specific = toolSpecificCustomer(businessId, customerMatch.id);
    if (specific) {
      toolsUsed.push('customer_detail');
      data.customerDetail = specific.data;
      facts.push(...specific.facts);
      for (const s of specific.sources) {
        if (!sources.some((x) => x.recordType === s.recordType && x.id === s.id)) sources.push(s);
      }
    }
  }

  return {
    business: biz,
    today,
    weekStart,
    intents,
    toolsUsed,
    data,
    sources,
    facts,
    counts: {
      customers: data.customerCount ?? get('SELECT COUNT(*) AS n FROM customers WHERE business_id = ?', [businessId])?.n ?? 0,
    },
  };
}

module.exports = { gatherOperationalContext, detectIntents, businessToday, shiftDate, toolSpecificCustomer };

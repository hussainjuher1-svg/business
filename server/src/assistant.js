const express = require('express');
const { z } = require('zod');
const { q, get, run } = require('./db');
const { requireAuth, resolveBusiness } = require('./auth');

const router = express.Router();

function businessToday(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function gatherContext(businessId) {
  const biz = get('SELECT * FROM businesses WHERE id = ?', [businessId]);
  const today = businessToday(biz?.timezone);
  const weekStart = new Date(new Date(today).getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const services = q('SELECT * FROM business_services WHERE business_id = ? ORDER BY name', [businessId]);
  const newInquiries = q(`SELECT * FROM inquiries WHERE business_id = ? AND status IN ('new','needs_response') ORDER BY created_at DESC`, [businessId]);
  const weekInquiries = q(`SELECT * FROM inquiries WHERE business_id = ? AND date(created_at) >= date(?) ORDER BY created_at DESC`, [businessId, weekStart]);
  const pendingEstimates = q(`SELECT e.*, c.name AS customer_name FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
    WHERE e.business_id = ? AND e.status IN ('sent','awaiting_response','follow_up_needed') ORDER BY e.follow_up_date ASC`, [businessId]);
  const overdueFollowUps = q(`SELECT f.*, c.name AS customer_name FROM follow_ups f LEFT JOIN customers c ON c.id = f.customer_id
    WHERE f.business_id = ? AND f.status = 'open' AND date(f.due_date) < date(?) ORDER BY f.due_date ASC`, [businessId, today]);
  const todayFollowUps = q(`SELECT f.*, c.name AS customer_name FROM follow_ups f LEFT JOIN customers c ON c.id = f.customer_id
    WHERE f.business_id = ? AND f.status = 'open' AND date(f.due_date) = date(?) ORDER BY f.due_date ASC`, [businessId, today]);
  const todayAppts = q(`SELECT a.*, c.name AS customer_name FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
    WHERE a.business_id = ? AND date(a.starts_at) = date(?) ORDER BY a.starts_at ASC`, [businessId, today]);
  const upcomingAppts = q(`SELECT a.*, c.name AS customer_name FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
    WHERE a.business_id = ? AND date(a.starts_at) >= date(?) AND a.status NOT IN ('cancelled','completed') ORDER BY a.starts_at ASC LIMIT 10`, [businessId, today]);
  const activeJobs = q(`SELECT j.*, c.name AS customer_name FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
    WHERE j.business_id = ? AND j.status IN ('not_started','scheduled','in_progress','waiting') ORDER BY j.scheduled_date ASC`, [businessId]);
  const counts = {
    customers: get('SELECT COUNT(*) AS n FROM customers WHERE business_id = ?', [businessId])?.n || 0,
  };
  return { biz, today, weekStart, services, newInquiries, weekInquiries, pendingEstimates, overdueFollowUps, todayFollowUps, todayAppts, upcomingAppts, activeJobs, counts };
}

function fmtDate(s) {
  if (!s) return '—';
  return String(s).slice(0, 10);
}
function fmtDateTime(s) {
  if (!s) return '—';
  return String(s).replace('T', ' ').slice(0, 16);
}

// ---------- rule-based assistant (always works, uses real DB data) ----------
function ruleBasedAnswer(message, ctx) {
  const m = message.toLowerCase();
  const { biz, today, weekStart, services, newInquiries, weekInquiries, pendingEstimates, overdueFollowUps, todayFollowUps, todayAppts, upcomingAppts, activeJobs, counts } = ctx;
  const bizName = biz?.name || 'your business';

  const has = (...words) => words.some((w) => m.includes(w));

  // Help
  if (has('how do i', 'how to', 'how can i', 'explain how', 'help me use', 'how does')) {
    if (has('customer')) return `To add a customer: go to **Customers** in the left menu, click **New customer**, enter their name, phone, email and notes, then save. Daybook will warn you if the phone or email already exists so you can avoid duplicates.`;
    if (has('estimate')) return `To create an estimate: go to **Work → Estimates**, click **New estimate**, link it to a customer (and an inquiry if you have one), enter the amount, description, issue and validity dates, then save. You can later mark it Sent, Awaiting Response, Follow-up Needed, Accepted or Declined.`;
    if (has('inquiry', 'inquiries')) return `To record an inquiry: go to **Inquiries**, click **New inquiry**, enter the contact name, phone/email, source (phone, website, email, referral, manual), subject and message, then save. You can assign it to a team member, set a follow-up date, change its status, and convert it into a customer when appropriate.`;
    if (has('follow-up', 'follow up', 'followup')) return `To schedule a follow-up: go to **Work → Follow-ups**, click **New follow-up**, link it to a customer, inquiry, estimate or job, set a due date and assign responsibility. Overdue follow-ups appear on your Today dashboard automatically.`;
    if (has('appointment')) return `To schedule an appointment: go to **Work → Appointments**, click **New appointment**, link it to a customer, pick the date, time and duration, add location/instructions, assign staff if needed, then save.`;
    if (has('job')) return `To create a job: go to **Work → Jobs**, click **New job**, link it to a customer (and inquiry/estimate if relevant), add a description, scheduled date and assignee, then update its status as work progresses.`;
    return `Here's how Daybook works:\n\n• **Today** — what needs attention, what's happening today, and your next steps.\n• **Inquiries** — record and respond to new inquiries.\n• **Customers** — your customer list with full history.\n• **Work** — estimates, appointments, jobs and follow-ups in one place.\n• **Settings** — business info, services, staff and permissions.\n\nTry asking me something specific, like "How do I add a customer?" or "What needs my attention today?"`;
  }

  // FAQ
  if (has('service', 'offer', 'what do you do', 'what does')) {
    if (!services.length && !biz?.service_areas) return `I don't have any services listed for ${bizName} yet. You can add them in **Settings → Services** and I'll be able to answer from that information.`;
    const list = services.map((s) => `• ${s.name}${s.description ? ` — ${s.description}` : ''}`).join('\n');
    return `${bizName} offers:\n${list || 'No services listed yet.'}${biz?.service_areas ? `\n\nService areas: ${biz.service_areas}` : ''}`;
  }
  if (has('area', 'cover', 'location', 'where')) {
    return biz?.service_areas ? `${bizName} covers: ${biz.service_areas}` : `I don't have service-area information for ${bizName} yet. Add it in **Settings** under Service areas.`;
  }
  if (has('hour', 'open', 'close', 'when are')) {
    return biz?.hours ? `${bizName} business hours:\n${biz.hours}` : `I don't have business hours for ${bizName} yet. Add them in **Settings** under Business hours.`;
  }
  if (has('cancel', 'policy', 'policies')) {
    return biz?.policies ? `${bizName} policies:\n${biz.policies}` : `I don't have policy information for ${bizName} yet. Add it in **Settings** under Business policies.`;
  }
  if (has('payment', 'pay', 'accept')) {
    return biz?.payment_methods ? `${bizName} accepts: ${biz.payment_methods}` : `I don't have payment-method information for ${bizName} yet. Add it in **Settings** under Payment methods.`;
  }
  if (has('contact', 'phone', 'email address', 'reach')) {
    const bits = [];
    if (biz?.phone) bits.push(`Phone: ${biz.phone}`);
    if (biz?.email) bits.push(`Email: ${biz.email}`);
    if (biz?.address) bits.push(`Address: ${biz.address}`);
    return bits.length ? `${bizName} contact information:\n${bits.join('\n')}` : `I don't have contact information for ${bizName} yet. Add it in **Settings**.`;
  }

  // Drafting
  if (has('draft', 'write a', 'compose', 'message to', 'follow up with', 'follow-up message', 'reminder')) {
    if (has('estimate')) {
      const e = pendingEstimates[0];
      if (!e) return `There are no pending estimates waiting for follow-up right now, so there's nothing to draft.`;
      return `Here's a draft you can edit before sending (nothing has been sent):\n\n---\nHi ${e.customer_name || 'there'},\n\nI wanted to follow up on the estimate for "${e.title}"${e.amount != null ? ` (${e.amount} ${e.currency || ''})` : ''} we sent on ${fmtDate(e.issue_date || e.created_at)}. Please let us know if you have any questions or would like to proceed.\n\nThank you,\n${bizName}\n---\n\nSource: estimate "${e.title}" (status: ${e.status}).`;
    }
    if (has('appointment', 'confirm')) {
      const a = upcomingAppts.find((x) => x.status !== 'confirmed') || upcomingAppts[0];
      if (!a) return `There are no upcoming appointments to confirm right now.`;
      return `Here's a draft you can edit before sending (nothing has been sent):\n\n---\nHi ${a.customer_name || 'there'},\n\nJust confirming your appointment on ${fmtDateTime(a.starts_at)}${a.location ? ` at ${a.location}` : ''}. Please reply to confirm, or let us know if you need to reschedule.\n\nThank you,\n${bizName}\n---\n\nSource: appointment "${a.title}" on ${fmtDateTime(a.starts_at)}.`;
    }
    if (has('inquiry', 'respond', 'response', 'reply')) {
      const i = newInquiries[0];
      if (!i) return `There are no new inquiries waiting for a response right now.`;
      return `Here's a draft you can edit before sending (nothing has been sent):\n\n---\nHi ${i.contact_name},\n\nThank you for getting in touch${i.subject ? ` about "${i.subject}"` : ''}. We received your inquiry and will get back to you shortly. ${i.message ? `You mentioned: "${String(i.message).slice(0, 120)}"` : ''}\n\nThank you,\n${bizName}\n---\n\nSource: inquiry from ${i.contact_name} (${i.source}).`;
    }
    return `I can draft: an inquiry response, an estimate follow-up, or an appointment confirmation. For example, try "Draft an estimate follow-up" or "Draft an appointment confirmation". Drafts are editable and never sent automatically.`;
  }

  // Summaries / attention
  if (has('attention', 'what needs', 'what should i do', 'next step', 'priority', 'first')) {
    const lines = [];
    if (newInquiries.length) lines.push(`• ${newInquiries.length} new ${newInquiries.length === 1 ? 'inquiry needs' : 'inquiries need'} a response (latest: ${newInquiries[0].contact_name}).`);
    if (pendingEstimates.length) lines.push(`• ${pendingEstimates.length} ${pendingEstimates.length === 1 ? 'estimate is' : 'estimates are'} awaiting follow-up (e.g. "${pendingEstimates[0].title}").`);
    if (overdueFollowUps.length) lines.push(`• ${overdueFollowUps.length} overdue follow-up${overdueFollowUps.length === 1 ? '' : 's'} (e.g. "${overdueFollowUps[0].title}" due ${fmtDate(overdueFollowUps[0].due_date)}).`);
    if (todayFollowUps.length) lines.push(`• ${todayFollowUps.length} follow-up${todayFollowUps.length === 1 ? '' : 's'} due today.`);
    const unconfirmed = upcomingAppts.filter((a) => a.status !== 'confirmed');
    if (unconfirmed.length) lines.push(`• ${unconfirmed.length} upcoming appointment${unconfirmed.length === 1 ? '' : 's'} still need${unconfirmed.length === 1 ? 's' : ''} confirmation.`);
    if (!lines.length) return `Good news — nothing needs your attention right now. No new inquiries, pending estimates, overdue follow-ups or unconfirmed appointments.`;
    return `Here's what needs your attention today (${today}):\n\n${lines.join('\n')}\n\nI recommend starting with the oldest item in each list. Open the Today dashboard for links to each record.`;
  }

  if (has('inquir', 'enquir')) {
    if (has('week', 'this week', 'arrived', 'how many')) {
      return `Inquiries received from ${weekStart} to ${today}: ${weekInquiries.length}.\n\n${weekInquiries.length ? weekInquiries.map((i) => `• ${i.contact_name} — ${i.subject || 'No subject'} (${i.status}, ${fmtDate(i.created_at)})`).join('\n') : 'No inquiries were recorded in that period.'}`;
    }
    if (has('response', 'waiting', 'need', 'pending', 'new')) {
      if (!newInquiries.length) return `No inquiries are currently waiting for a response.`;
      return `${newInquiries.length} ${newInquiries.length === 1 ? 'inquiry needs' : 'inquiries need'} a response:\n\n${newInquiries.map((i) => `• ${i.contact_name} — ${i.subject || 'No subject'} (source: ${i.source}, ${fmtDate(i.created_at)})`).join('\n')}`;
    }
    return `You have ${weekInquiries.length} ${weekInquiries.length === 1 ? 'inquiry' : 'inquiries'} recorded this week (${weekStart} to ${today}), and ${newInquiries.length} waiting for a response. Ask me "Which inquiries need a response?" for details.`;
  }

  if (has('estimate')) {
    if (!pendingEstimates.length) return `No estimates are currently awaiting follow-up.`;
    return `${pendingEstimates.length} ${pendingEstimates.length === 1 ? 'estimate is' : 'estimates are'} awaiting follow-up:\n\n${pendingEstimates.map((e) => `• "${e.title}" — ${e.customer_name ? `customer: ${e.customer_name}` : 'no customer linked'}${e.amount != null ? `, ${e.amount} ${e.currency || ''}` : ''} (status: ${e.status}${e.follow_up_date ? `, follow up by ${fmtDate(e.follow_up_date)}` : ''})`).join('\n')}`;
  }

  if (has('appointment', 'schedule', 'today')) {
    if (has('today') || has('schedule') || has('appointment')) {
      if (!todayAppts.length && !upcomingAppts.length) return `No appointments are scheduled for today (${today}) or coming up.`;
      const t = todayAppts.length ? `Today (${today}):\n${todayAppts.map((a) => `• ${fmtDateTime(a.starts_at)} — ${a.title}${a.customer_name ? ` (${a.customer_name})` : ''} [${a.status}]`).join('\n')}` : `No appointments today (${today}).`;
      const u = upcomingAppts.length ? `\n\nComing up:\n${upcomingAppts.map((a) => `• ${fmtDateTime(a.starts_at)} — ${a.title}${a.customer_name ? ` (${a.customer_name})` : ''} [${a.status}]`).join('\n')}` : '';
      return `${t}${u}`;
    }
  }

  if (has('follow-up', 'follow up', 'followup', 'overdue')) {
    if (has('overdue')) {
      if (!overdueFollowUps.length) return `No overdue follow-ups. You're all caught up.`;
      return `${overdueFollowUps.length} overdue follow-up${overdueFollowUps.length === 1 ? '' : 's'}:\n\n${overdueFollowUps.map((f) => `• "${f.title}" — due ${fmtDate(f.due_date)}${f.customer_name ? ` (${f.customer_name})` : ''}`).join('\n')}`;
    }
    const all = [...overdueFollowUps, ...todayFollowUps];
    if (!all.length) return `No open follow-ups are overdue or due today.`;
    return `Open follow-ups needing action:\n\n${all.map((f) => `• "${f.title}" — due ${fmtDate(f.due_date)}${f.customer_name ? ` (${f.customer_name})` : ''}`).join('\n')}`;
  }

  if (has('job', 'work', 'workload', 'summary', 'summarize', 'overview')) {
    const lines = [
      `Daily summary for ${bizName} — ${today}:`,
      `• New inquiries waiting: ${newInquiries.length}`,
      `• Estimates awaiting follow-up: ${pendingEstimates.length}`,
      `• Overdue follow-ups: ${overdueFollowUps.length} · Due today: ${todayFollowUps.length}`,
      `• Appointments today: ${todayAppts.length}`,
      `• Active jobs: ${activeJobs.length}`,
      `• Total customers on record: ${counts.customers}`,
    ];
    if (activeJobs.length) lines.push(`\nActive jobs:\n${activeJobs.map((j) => `• ${j.title} [${j.status}]${j.customer_name ? ` (${j.customer_name})` : ''}`).join('\n')}`);
    return lines.join('\n');
  }

  if (has('customer', 'waiting for update', 'update')) {
    const waiting = newInquiries.filter((i) => !i.customer_id);
    if (!waiting.length) return `No customers are currently waiting for an update based on open inquiries.`;
    return `${waiting.length} ${waiting.length === 1 ? 'contact is' : 'contacts are'} waiting for an update (open inquiries with no linked customer yet):\n\n${waiting.map((i) => `• ${i.contact_name} — ${i.subject || 'No subject'} (${fmtDate(i.created_at)})`).join('\n')}`;
  }

  if (has('hello', 'hi', 'hey')) return `Hello! I'm the Daybook Assistant for ${bizName}. I can tell you what needs attention, summarize inquiries, estimates, appointments and follow-ups, answer business questions, or draft a message for you. What would you like to know?`;

  return `I can help with:\n• "What needs my attention today?"\n• "Summarize my pending inquiries"\n• "Which estimates need follow-up?"\n• "What appointments are coming up?"\n• "Which follow-ups are overdue?"\n• Business questions like "What services do we offer?" or "What are our business hours?"\n• "Draft an estimate follow-up"\n• "Explain how to use Daybook"\n\nWhat would you like to do?`;
}

// ---------- optional LLM (OpenAI / Anthropic) ----------
async function llmAnswer(message, ctx, history) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
  const provider = process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  if (!provider) return null;
  const model = process.env.AI_MODEL || (provider === 'openai' ? 'gpt-4o-mini' : 'claude-3-5-haiku-latest');
  const contextJson = JSON.stringify({
    business: { name: ctx.biz?.name, hours: ctx.biz?.hours, policies: ctx.biz?.policies, payment_methods: ctx.biz?.payment_methods, service_areas: ctx.biz?.service_areas, phone: ctx.biz?.phone, email: ctx.biz?.email },
    services: ctx.services,
    today: ctx.today,
    newInquiries: ctx.newInquiries.map((i) => ({ name: i.contact_name, subject: i.subject, status: i.status, date: i.created_at })),
    weekInquiryCount: ctx.weekInquiries.length,
    pendingEstimates: ctx.pendingEstimates.map((e) => ({ title: e.title, customer: e.customer_name, amount: e.amount, status: e.status })),
    overdueFollowUps: ctx.overdueFollowUps.map((f) => ({ title: f.title, due: f.due_date })),
    todayAppointments: ctx.todayAppts.map((a) => ({ title: a.title, at: a.starts_at, status: a.status })),
    upcomingAppointments: ctx.upcomingAppointments.map((a) => ({ title: a.title, at: a.starts_at, status: a.status })),
    activeJobs: ctx.activeJobs.map((j) => ({ title: j.title, status: j.status })),
  });
  const system = `You are the Daybook Assistant for a small service business. Answer using ONLY the provided business data. Never invent records, numbers, or business facts. If information is missing, say so. Distinguish facts from suggestions. Keep answers concise and actionable. Today is ${ctx.today}.`;
  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: `${system}\n\nBusiness data (JSON):\n${contextJson}` },
            ...history.slice(-6),
            { role: 'user', content: message },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI API error ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || null;
    } else {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model, max_tokens: 1024, system: `${system}\n\nBusiness data (JSON):\n${contextJson}`,
          messages: [...history.slice(-6), { role: 'user', content: message }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API error ${res.status}`);
      const data = await res.json();
      return data.content?.[0]?.text || null;
    }
  } catch (err) {
    console.error('[assistant] LLM error:', err.message);
    return null;
  }
}

// ---------- routes ----------
router.get('/conversations', requireAuth, resolveBusiness, (req, res) => {
  const rows = q('SELECT * FROM assistant_conversations WHERE business_id = ? AND user_id = ? ORDER BY updated_at DESC', [req.businessId, req.user.id]);
  res.json(rows);
});

router.post('/conversations', requireAuth, resolveBusiness, (req, res) => {
  const info = run('INSERT INTO assistant_conversations (business_id, user_id, title) VALUES (?,?,?)', [req.businessId, req.user.id, 'New conversation']);
  res.status(201).json(get('SELECT * FROM assistant_conversations WHERE id = ?', [Number(info.lastInsertRowid)]));
});

router.get('/conversations/:id/messages', requireAuth, resolveBusiness, (req, res) => {
  const conv = get('SELECT * FROM assistant_conversations WHERE id = ? AND business_id = ? AND user_id = ?', [req.params.id, req.businessId, req.user.id]);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  res.json(q('SELECT * FROM assistant_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC', [conv.id]));
});

router.post('/chat', requireAuth, resolveBusiness, async (req, res) => {
  const parsed = z.object({
    message: z.string().min(1, 'Message is required'),
    conversationId: z.number().int().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
  const { message } = parsed.data;
  let convId = parsed.data.conversationId;
  if (!convId) {
    const info = run('INSERT INTO assistant_conversations (business_id, user_id, title) VALUES (?,?,?)', [req.businessId, req.user.id, message.slice(0, 60)]);
    convId = Number(info.lastInsertRowid);
  } else {
    const conv = get('SELECT * FROM assistant_conversations WHERE id = ? AND business_id = ? AND user_id = ?', [convId, req.businessId, req.user.id]);
    if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  }
  run('INSERT INTO assistant_messages (conversation_id, role, content) VALUES (?,?,?)', [convId, 'user', message]);
  const history = q('SELECT role, content FROM assistant_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC LIMIT 20', [convId]);
  const ctx = gatherContext(req.businessId);
  let answer = await llmAnswer(message, ctx, history);
  let mode = 'llm';
  if (!answer) {
    answer = ruleBasedAnswer(message, ctx);
    mode = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY ? 'llm-unavailable-fallback' : 'built-in';
  }
  run('INSERT INTO assistant_messages (conversation_id, role, content) VALUES (?,?,?)', [convId, 'assistant', answer]);
  run("UPDATE assistant_conversations SET updated_at = datetime('now') WHERE id = ?", [convId]);
  res.json({ conversationId: convId, answer, mode });
});

router.get('/status', requireAuth, resolveBusiness, (req, res) => {
  const llm = process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  res.json({ llmProvider: llm, model: process.env.AI_MODEL || (llm ? 'default' : null), mode: llm ? 'llm' : 'built-in' });
});

module.exports = router;

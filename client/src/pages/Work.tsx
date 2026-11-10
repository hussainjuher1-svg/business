import React, { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '../api';
import { Loading, ErrorBox, Empty, Modal, Field, StatusBadge } from '../components/ui';

type Tab = 'estimates' | 'appointments' | 'jobs' | 'follow-ups';

const EST_STATUSES = ['draft', 'sent', 'awaiting_response', 'follow_up_needed', 'accepted', 'declined', 'expired'];
const APPT_STATUSES = ['scheduled', 'confirmation_needed', 'confirmed', 'completed', 'cancelled', 'rescheduled'];
const JOB_STATUSES = ['not_started', 'scheduled', 'in_progress', 'waiting', 'completed', 'cancelled'];

export default function Work() {
  const [tab, setTab] = useState<Tab>('estimates');
  const [customers, setCustomers] = useState<any[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api.get<{ data: any[] }>('/customers').then((r) => setCustomers(r.data)).catch(() => {});
  }, []);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'estimates', label: 'Estimates' },
    { id: 'appointments', label: 'Appointments' },
    { id: 'jobs', label: 'Jobs' },
    { id: 'follow-ups', label: 'Follow-ups' },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Work</h1>
        <p className="text-sm text-stone-500">Estimates, appointments, jobs and follow-ups.</p>
      </div>
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-stone-200 bg-white p-1">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold ${tab === t.id ? 'bg-teal-800 text-white' : 'text-stone-600 hover:bg-stone-100'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'estimates' && <Estimates customers={customers} refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
      {tab === 'appointments' && <Appointments customers={customers} refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
      {tab === 'jobs' && <Jobs customers={customers} refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
      {tab === 'follow-ups' && <FollowUps customers={customers} refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
    </div>
  );
}

function useList(path: string, refreshKey: number) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<{ data: any[] }>(path);
      setRows(res.data);
    } catch (e: any) {
      setError(e.message || 'Could not load.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [refreshKey]);
  return { rows, loading, error, load };
}

function ListShell({ loading, error, emptyTitle, emptyHint, children }: any) {
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  if (!children?.length) return <Empty title={emptyTitle} hint={emptyHint} />;
  return <div className="card divide-y divide-stone-100">{children}</div>;
}

// ---------- Estimates ----------
function Estimates({ customers, refreshKey, onChanged }: any) {
  const { rows, loading, error } = useList('/estimates', refreshKey);
  const [showForm, setShowForm] = useState(false);
  async function setStatus(id: number, status: string) {
    await api.patch(`/estimates/${id}`, { status });
    onChanged();
  }
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><button className="btn-primary" onClick={() => setShowForm(true)}>+ New estimate</button></div>
      <ListShell loading={loading} error={error} emptyTitle="No estimates yet" emptyHint="Create your first estimate and track it through to accepted or declined.">
        {rows.map((r: any) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{r.title} {r.amount != null && <span className="text-stone-500">· {r.amount} {r.currency}</span>}</p>
              <p className="truncate text-xs text-stone-500">{r.customer_name ? `Customer: ${r.customer_name} · ` : ''}Issued: {fmtDate(r.issue_date)} · Valid until: {fmtDate(r.valid_until)}</p>
            </div>
            <div className="flex items-center gap-2">
              <select value={r.status} onChange={(e) => setStatus(r.id, e.target.value)} className="max-w-[200px] py-1.5 text-xs">
                {EST_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
              <StatusBadge status={r.status} />
            </div>
          </div>
        ))}
      </ListShell>
      {showForm && <EstimateForm customers={customers} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); onChanged(); }} />}
    </div>
  );
}

function EstimateForm({ customers, onClose, onSaved }: any) {
  const [form, setForm] = useState({ title: '', description: '', amount: '', customerId: '', issueDate: '', validUntil: '', followUpDate: '', notes: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/estimates', {
        title: form.title, description: form.description,
        amount: form.amount ? Number(form.amount) : null,
        customerId: form.customerId ? Number(form.customerId) : null,
        issueDate: form.issueDate || null, validUntil: form.validUntil || null,
        followUpDate: form.followUpDate || null, notes: form.notes,
      });
      onSaved();
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  }
  return (
    <Modal title="New estimate" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Field label="Title *"><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount"><input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
          <Field label="Customer"><select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}><option value="">None</option>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Issue date"><input type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} /></Field>
          <Field label="Valid until"><input type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} /></Field>
          <Field label="Follow-up by"><input type="date" value={form.followUpDate} onChange={(e) => setForm({ ...form, followUpDate: e.target.value })} /></Field>
        </div>
        <Field label="Description"><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field label="Internal notes"><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save estimate'}</button></div>
      </form>
    </Modal>
  );
}

// ---------- Appointments ----------
function Appointments({ customers, refreshKey, onChanged }: any) {
  const { rows, loading, error } = useList('/appointments', refreshKey);
  const [showForm, setShowForm] = useState(false);
  async function setStatus(id: number, status: string) {
    await api.patch(`/appointments/${id}`, { status });
    onChanged();
  }
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><button className="btn-primary" onClick={() => setShowForm(true)}>+ New appointment</button></div>
      <ListShell loading={loading} error={error} emptyTitle="No appointments yet" emptyHint="Schedule appointments and confirm them before they happen.">
        {rows.map((r: any) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{r.title}</p>
              <p className="truncate text-xs text-stone-500">{fmtDateTime(r.starts_at)}{r.customer_name ? ` · ${r.customer_name}` : ''}{r.location ? ` · ${r.location}` : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <select value={r.status} onChange={(e) => setStatus(r.id, e.target.value)} className="max-w-[220px] py-1.5 text-xs">
                {APPT_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
              <StatusBadge status={r.status} />
            </div>
          </div>
        ))}
      </ListShell>
      {showForm && <AppointmentForm customers={customers} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); onChanged(); }} />}
    </div>
  );
}

function AppointmentForm({ customers, onClose, onSaved }: any) {
  const [form, setForm] = useState({ title: '', startsAt: '', endsAt: '', customerId: '', location: '', instructions: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/appointments', {
        title: form.title, startsAt: form.startsAt, endsAt: form.endsAt || null,
        customerId: form.customerId ? Number(form.customerId) : null,
        location: form.location, instructions: form.instructions,
      });
      onSaved();
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  }
  return (
    <Modal title="New appointment" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Field label="Title *"><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts at *"><input required type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></Field>
          <Field label="Ends at"><input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></Field>
        </div>
        <Field label="Customer"><select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}><option value="">None</option>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Location"><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>
        <Field label="Instructions"><textarea rows={2} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save appointment'}</button></div>
      </form>
    </Modal>
  );
}

// ---------- Jobs ----------
function Jobs({ customers, refreshKey, onChanged }: any) {
  const { rows, loading, error } = useList('/jobs', refreshKey);
  const [showForm, setShowForm] = useState(false);
  async function setStatus(id: number, status: string) {
    await api.patch(`/jobs/${id}`, { status });
    onChanged();
  }
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><button className="btn-primary" onClick={() => setShowForm(true)}>+ New job</button></div>
      <ListShell loading={loading} error={error} emptyTitle="No jobs yet" emptyHint="Create jobs from your work and track their progress simply.">
        {rows.map((r: any) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{r.title}</p>
              <p className="truncate text-xs text-stone-500">{r.customer_name ? `Customer: ${r.customer_name} · ` : ''}Scheduled: {fmtDate(r.scheduled_date)}</p>
            </div>
            <div className="flex items-center gap-2">
              <select value={r.status} onChange={(e) => setStatus(r.id, e.target.value)} className="max-w-[200px] py-1.5 text-xs">
                {JOB_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
              <StatusBadge status={r.status} />
            </div>
          </div>
        ))}
      </ListShell>
      {showForm && <JobForm customers={customers} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); onChanged(); }} />}
    </div>
  );
}

function JobForm({ customers, onClose, onSaved }: any) {
  const [form, setForm] = useState({ title: '', description: '', customerId: '', scheduledDate: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/jobs', {
        title: form.title, description: form.description,
        customerId: form.customerId ? Number(form.customerId) : null,
        scheduledDate: form.scheduledDate || null,
      });
      onSaved();
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  }
  return (
    <Modal title="New job" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Field label="Title *"><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer"><select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}><option value="">None</option>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Scheduled date"><input type="date" value={form.scheduledDate} onChange={(e) => setForm({ ...form, scheduledDate: e.target.value })} /></Field>
        </div>
        <Field label="Description"><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save job'}</button></div>
      </form>
    </Modal>
  );
}

// ---------- Follow-ups ----------
function FollowUps({ customers, refreshKey, onChanged }: any) {
  const { rows, loading, error } = useList('/follow-ups', refreshKey);
  const [showForm, setShowForm] = useState(false);
  async function complete(id: number) {
    await api.patch(`/follow-ups/${id}`, { status: 'completed' });
    onChanged();
  }
  async function reschedule(id: number) {
    const d = prompt('New due date (YYYY-MM-DD):');
    if (!d) return;
    await api.patch(`/follow-ups/${id}`, { dueDate: d, status: 'rescheduled' });
    onChanged();
  }
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><button className="btn-primary" onClick={() => setShowForm(true)}>+ New follow-up</button></div>
      <ListShell loading={loading} error={error} emptyTitle="No follow-ups yet" emptyHint="Follow-ups keep you from forgetting anyone. Overdue ones appear on Today.">
        {rows.map((r: any) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{r.title}</p>
              <p className="truncate text-xs text-stone-500">Due: {fmtDate(r.due_date)}{r.customer_name ? ` · ${r.customer_name}` : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={r.status} />
              {r.status !== 'completed' && (
                <>
                  <button className="btn-secondary !px-3 !py-1.5 text-xs" onClick={() => complete(r.id)}>Complete</button>
                  <button className="btn-secondary !px-3 !py-1.5 text-xs" onClick={() => reschedule(r.id)}>Reschedule</button>
                </>
              )}
            </div>
          </div>
        ))}
      </ListShell>
      {showForm && <FollowUpForm customers={customers} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); onChanged(); }} />}
    </div>
  );
}

function FollowUpForm({ customers, onClose, onSaved }: any) {
  const [form, setForm] = useState({ title: '', dueDate: '', customerId: '', notes: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/follow-ups', {
        title: form.title, dueDate: form.dueDate, notes: form.notes,
        customerId: form.customerId ? Number(form.customerId) : null,
      });
      onSaved();
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  }
  return (
    <Modal title="New follow-up" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Field label="Title *"><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Due date *"><input required type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field>
          <Field label="Customer"><select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}><option value="">None</option>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        </div>
        <Field label="Notes"><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save follow-up'}</button></div>
      </form>
    </Modal>
  );
}

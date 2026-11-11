import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { Loading, ErrorBox, Empty, Modal, Field, StatusBadge } from '../components/ui';

const STATUSES = ['new', 'needs_response', 'in_progress', 'estimate_requested', 'converted', 'not_proceeding', 'archived'];
const SOURCES = ['phone', 'website', 'email', 'referral', 'manual'];

export default function Inquiries() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState<any | null>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  // People this inquiry can be handed to. Loaded from /business, the same
  // membership list Settings shows, so there is no second source of truth.
  const [members, setMembers] = useState<any[]>([]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (status) params.set('status', status);
      const res = await api.get<{ data: any[] }>(`/inquiries?${params.toString()}`);
      setRows(res.data);
      const c = await api.get<{ data: any[] }>('/customers');
      setCustomers(c.data);
      const b = await api.get<{ members: any[] }>('/business');
      setMembers(b.members || []);
    } catch (e: any) {
      setError(e.message || 'Could not load inquiries.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setTimeout(load, 400); return () => clearTimeout(t); }, [search, status]);

  async function openDetail(id: number) {
    try {
      const d = await api.get<any>(`/inquiries/${id}`);
      setDetail(d);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function changeStatus(id: number, s: string) {
    try {
      await api.patch(`/inquiries/${id}`, { status: s });
      load();
      if (detail) openDetail(id);
    } catch (e: any) { setError(e.message); }
  }

  async function assign(id: number, assignedTo: string) {
    try {
      // An empty choice means "nobody owns this yet", which the API models as NULL.
      await api.patch(`/inquiries/${id}`, { assignedTo: assignedTo ? Number(assignedTo) : null });
      load();
      openDetail(id);
    } catch (e: any) { setError(e.message); }
  }

  async function convert(id: number) {
    try {
      await api.post(`/inquiries/${id}/convert`);
      load();
      openDetail(id);
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">Inquiries</h1>
          <p className="text-sm text-stone-500">Every inquiry, in one place.</p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>+ New inquiry</button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input placeholder="Search inquiries…" value={search} onChange={(e) => setSearch(e.target.value)} className="sm:max-w-xs" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:max-w-[200px]">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
      </div>

      {error && <ErrorBox message={error} />}
      {loading ? <Loading /> : rows.length === 0 ? (
        <Empty title="No inquiries found" hint="Record your first inquiry with the New inquiry button. It will appear here and on your Today dashboard." />
      ) : (
        <div className="card divide-y divide-stone-100">
          {rows.map((r) => (
            <button key={r.id} onClick={() => openDetail(r.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-stone-50">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{r.subject || r.contact_name}</p>
                <p className="truncate text-xs text-stone-500">{r.contact_name} · {r.source} · {fmtDate(r.created_at)}</p>
              </div>
              <StatusBadge status={r.status} />
            </button>
          ))}
        </div>
      )}

      {showForm && <InquiryForm customers={customers} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); load(); }} />}

      {detail && (
        <Modal title="Inquiry details" onClose={() => setDetail(null)}>
          <div className="space-y-3">
            <div className="flex items-center gap-2"><StatusBadge status={detail.inquiry.status} /><span className="text-xs text-stone-500">{detail.inquiry.source} · {fmtDate(detail.inquiry.created_at)}</span></div>
            <div>
              <p className="text-sm font-bold text-ink">{detail.inquiry.subject || 'No subject'}</p>
              <p className="text-sm text-stone-600">{detail.inquiry.contact_name}</p>
              <p className="text-sm text-stone-600">{detail.inquiry.phone} {detail.inquiry.email}</p>
              {detail.inquiry.message && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-sm text-ink">{detail.inquiry.message}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <select value={detail.inquiry.status} onChange={(e) => changeStatus(detail.inquiry.id, e.target.value)} className="max-w-[220px]">
                {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
              {detail.inquiry.status !== 'converted' && <button className="btn-secondary" onClick={() => convert(detail.inquiry.id)}>Convert to customer</button>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs font-bold uppercase tracking-wide text-stone-500" htmlFor="inquiry-assigned">Assigned to</label>
              <select
                id="inquiry-assigned"
                value={detail.inquiry.assigned_to ? String(detail.inquiry.assigned_to) : ''}
                onChange={(e) => assign(detail.inquiry.id, e.target.value)}
                className="max-w-[220px]"
              >
                <option value="">Unassigned</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            {detail.activity?.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-stone-500">History</h3>
                <ul className="space-y-1 text-xs text-stone-600">
                  {detail.activity.map((a: any) => <li key={a.id}>{fmtDate(a.created_at)} — {a.action} {a.details ? `(${a.details})` : ''}</li>)}
                </ul>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function InquiryForm({ customers, onClose, onSaved }: { customers: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ contactName: '', phone: '', email: '', source: 'manual', subject: '', message: '', customerId: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/inquiries', { ...form, customerId: form.customerId ? Number(form.customerId) : null });
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="New inquiry" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Field label="Contact name *"><input required value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Source"><select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
          <Field label="Linked customer"><select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}><option value="">None</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        </div>
        <Field label="Subject"><input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
        <Field label="Message"><textarea rows={4} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save inquiry'}</button></div>
      </form>
    </Modal>
  );
}

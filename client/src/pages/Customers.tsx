import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { Loading, ErrorBox, Empty, Modal, Field, StatusBadge } from '../components/ui';

export default function Customers() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState<any | null>(null);
  const [dupWarning, setDupWarning] = useState<any>(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      const res = await api.get<{ data: any[] }>(`/customers?${params.toString()}`);
      setRows(res.data);
    } catch (e: any) {
      setError(e.message || 'Could not load customers.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setTimeout(load, 400); return () => clearTimeout(t); }, [search]);

  async function openDetail(id: number) {
    try {
      const d = await api.get<any>(`/customers/${id}`);
      setDetail(d);
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">Customers</h1>
          <p className="text-sm text-stone-500">Your customer list with full history.</p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>+ New customer</button>
      </div>

      <input placeholder="Search customers…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
      {error && <ErrorBox message={error} />}
      {loading ? <Loading /> : rows.length === 0 ? (
        <Empty title="No customers yet" hint="Add your first customer with the New customer button. Daybook warns about possible duplicates by phone or email." />
      ) : (
        <div className="card divide-y divide-stone-100">
          {rows.map((r) => (
            <button key={r.id} onClick={() => openDetail(r.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-stone-50">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{r.name}</p>
                <p className="truncate text-xs text-stone-500">{r.phone} {r.email}</p>
              </div>
              <span className="text-xs text-stone-400">{fmtDate(r.created_at)}</span>
            </button>
          ))}
        </div>
      )}

      {showForm && <CustomerForm onClose={() => setShowForm(false)} onSaved={(dup) => { setShowForm(false); setDupWarning(dup); load(); }} />}

      {detail && (
        <Modal title={detail.customer.name} onClose={() => setDetail(null)}>
          <div className="space-y-4">
            <div className="text-sm text-stone-600">
              <p>{detail.customer.phone} {detail.customer.email}</p>
              {detail.customer.address && <p>{detail.customer.address}</p>}
              {detail.customer.notes && <p className="mt-1 whitespace-pre-wrap rounded-lg bg-stone-50 p-3">{detail.customer.notes}</p>}
            </div>
            <Section title="Inquiries" items={detail.inquiries} render={(i: any) => <><span className="font-medium">{i.subject || i.contact_name}</span> <StatusBadge status={i.status} /></>} />
            <Section title="Estimates" items={detail.estimates} render={(e: any) => <><span className="font-medium">{e.title}</span> <StatusBadge status={e.status} /></>} />
            <Section title="Appointments" items={detail.appointments} render={(a: any) => <><span className="font-medium">{a.title}</span> <StatusBadge status={a.status} /></>} />
            <Section title="Jobs" items={detail.jobs} render={(j: any) => <><span className="font-medium">{j.title}</span> <StatusBadge status={j.status} /></>} />
            <Section title="Follow-ups" items={detail.followUps} render={(f: any) => <><span className="font-medium">{f.title}</span> <StatusBadge status={f.status} /></>} />
            {detail.activity?.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-stone-500">Activity</h3>
                <ul className="space-y-1 text-xs text-stone-600">
                  {detail.activity.map((a: any) => <li key={a.id}>{fmtDate(a.created_at)} — {a.action} {a.details ? `(${a.details})` : ''}</li>)}
                </ul>
              </div>
            )}
          </div>
        </Modal>
      )}

      {dupWarning && (
        <Modal title="Possible duplicate" onClose={() => setDupWarning(null)}>
          <p className="text-sm text-ink">A customer with the same phone or email already exists: <strong>{dupWarning.name}</strong> ({dupWarning.phone} {dupWarning.email}). Your new customer was still saved. Please check for duplicates and merge manually if needed.</p>
          <div className="mt-4 flex justify-end"><button className="btn-primary" onClick={() => setDupWarning(null)}>OK</button></div>
        </Modal>
      )}
    </div>
  );
}

function Section({ title, items, render }: { title: string; items: any[]; render: (i: any) => React.ReactNode }) {
  if (!items?.length) return null;
  return (
    <div>
      <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-stone-500">{title} ({items.length})</h3>
      <ul className="space-y-1">
        {items.map((i) => <li key={i.id} className="flex items-center justify-between gap-2 rounded-lg bg-stone-50 px-3 py-1.5 text-sm text-ink">{render(i)}</li>)}
      </ul>
    </div>
  );
}

function CustomerForm({ onClose, onSaved }: { onClose: () => void; onSaved: (dup: any) => void }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '', notes: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const res = await api.post<any>('/customers', form);
      onSaved(res.possibleDuplicate);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="New customer" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Field label="Name *"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        </div>
        <Field label="Address"><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
        <Field label="Notes"><textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save customer'}</button></div>
      </form>
    </Modal>
  );
}

import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Loading, ErrorBox, Field } from '../components/ui';

export default function Settings() {
  const [data, setData] = useState<any | null>(null);
  const [form, setForm] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [newService, setNewService] = useState({ name: '', description: '' });
  const [newStaff, setNewStaff] = useState({ email: '', name: '', role: 'staff' });

  async function load() {
    setLoading(true);
    setError('');
    try {
      const d = await api.get<any>('/business');
      setData(d);
      setForm(d.business || {});
    } catch (e: any) {
      setError(e.message || 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaved('');
    setError('');
    try {
      const updated = await api.patch<any>('/business', form);
      setData({ ...data, business: updated });
      setSaved('Settings saved.');
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function addService(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post('/business/services', newService);
      setNewService({ name: '', description: '' });
      load();
    } catch (err: any) { setError(err.message); }
  }

  async function addStaff(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post('/business/staff', newStaff);
      setNewStaff({ email: '', name: '', role: 'staff' });
      load();
    } catch (err: any) { setError(err.message); }
  }

  async function changeRole(userId: number, role: string) {
    try {
      await api.patch(`/business/staff/${userId}`, { role });
      load();
    } catch (err: any) { setError(err.message); }
  }

  async function removeStaff(userId: number) {
    if (!confirm('Remove this staff member from your business?')) return;
    try {
      await api.del(`/business/staff/${userId}`);
      load();
    } catch (err: any) { setError(err.message); }
  }

  if (loading) return <Loading />;
  if (!data) return <ErrorBox message={error || 'Could not load settings.'} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Settings</h1>
        <p className="text-sm text-stone-500">Business information, services, staff and permissions. The assistant uses this as its business knowledge.</p>
      </div>
      {error && <ErrorBox message={error} />}
      {saved && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{saved}</div>}

      <form onSubmit={save} className="card space-y-3 p-5">
        <h2 className="text-base font-bold text-ink">Business profile</h2>
        <Field label="Business name"><input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone"><input value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><input value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        </div>
        <Field label="Address"><input value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
        <Field label="Business hours"><textarea rows={2} value={form.hours || ''} onChange={(e) => setForm({ ...form, hours: e.target.value })} placeholder="e.g. Mon–Fri 8:00–17:00" /></Field>
        <Field label="Service areas"><textarea rows={2} value={form.service_areas || ''} onChange={(e) => setForm({ ...form, service_areas: e.target.value })} /></Field>
        <Field label="Business policies"><textarea rows={3} value={form.policies || ''} onChange={(e) => setForm({ ...form, policies: e.target.value })} placeholder="Cancellation policy, terms, etc." /></Field>
        <Field label="Payment methods"><input value={form.payment_methods || ''} onChange={(e) => setForm({ ...form, payment_methods: e.target.value })} placeholder="e.g. Cash, card, bank transfer" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Currency"><input value={form.currency || ''} onChange={(e) => setForm({ ...form, currency: e.target.value })} /></Field>
          <Field label="Timezone"><input value={form.timezone || ''} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="e.g. UTC, Asia/Dhaka" /></Field>
        </div>
        <div className="flex justify-end"><button className="btn-primary" type="submit">Save settings</button></div>
      </form>

      <section className="card space-y-3 p-5">
        <h2 className="text-base font-bold text-ink">Services</h2>
        {data.services?.length === 0 && <p className="text-sm text-stone-500">No services listed yet. Add them so the assistant can answer "What services do we offer?"</p>}
        <ul className="space-y-2">
          {data.services?.map((s: any) => (
            <li key={s.id} className="flex items-center justify-between rounded-lg bg-stone-50 px-3 py-2">
              <div><p className="text-sm font-semibold text-ink">{s.name}</p>{s.description && <p className="text-xs text-stone-500">{s.description}</p>}</div>
              <button className="btn-danger" onClick={async () => { await api.del(`/business/services/${s.id}`); load(); }}>Remove</button>
            </li>
          ))}
        </ul>
        <form onSubmit={addService} className="flex flex-col gap-2 sm:flex-row">
          <input placeholder="Service name" value={newService.name} onChange={(e) => setNewService({ ...newService, name: e.target.value })} required />
          <input placeholder="Description" value={newService.description} onChange={(e) => setNewService({ ...newService, description: e.target.value })} />
          <button className="btn-secondary" type="submit">Add service</button>
        </form>
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="text-base font-bold text-ink">Staff &amp; permissions</h2>
        <p className="text-xs text-stone-500">Roles: Owner (full access), Admin (manage settings &amp; staff), Staff (day-to-day records). Permissions are enforced on the server.</p>
        <ul className="space-y-2">
          {data.members?.map((m: any) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-stone-50 px-3 py-2">
              <div><p className="text-sm font-semibold text-ink">{m.name}</p><p className="text-xs text-stone-500">{m.email}</p></div>
              <div className="flex items-center gap-2">
                <select value={m.role} onChange={(e) => changeRole(m.id, e.target.value)} className="max-w-[140px] py-1.5 text-xs">
                  <option value="owner">Owner</option><option value="admin">Admin</option><option value="staff">Staff</option>
                </select>
                <button className="btn-danger" onClick={() => removeStaff(m.id)}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
        <form onSubmit={addStaff} className="flex flex-col gap-2 sm:flex-row">
          <input placeholder="Name" value={newStaff.name} onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })} required />
          <input placeholder="Email" type="email" value={newStaff.email} onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })} required />
          <select value={newStaff.role} onChange={(e) => setNewStaff({ ...newStaff, role: e.target.value })} className="sm:max-w-[140px]">
            <option value="staff">Staff</option><option value="admin">Admin</option><option value="owner">Owner</option>
          </select>
          <button className="btn-secondary" type="submit">Add staff</button>
        </form>
      </section>
    </div>
  );
}

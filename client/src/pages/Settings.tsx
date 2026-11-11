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
        <p className="text-sm text-stone-500">
          Business information, staff and permissions. Detailed business knowledge (FAQs, policies, pricing rules, documents) lives in the
          <strong> Knowledge</strong> section — that is what the assistant cites.
        </p>
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

      <AiSettings />

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


function AiSettings() {
  const [status, setStatus] = useState<any>(null);
  const [form, setForm] = useState<any>({ chatModel: '', embedModel: '', enabled: true, strictGrounding: true, cacheEnabled: true });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    try {
      const d = await api.get<any>('/assistant/status');
      setStatus(d);
      setForm({
        chatModel: d.settings?.chatModel || '',
        embedModel: d.settings?.embedModel || '',
        enabled: d.settings?.enabled ?? true,
        strictGrounding: d.settings?.strictGrounding ?? true,
        cacheEnabled: d.settings?.cacheEnabled ?? true,
      });
    } catch {
      setStatus(null);
    }
  }
  useEffect(() => { load(); }, []);

  async function save(patch: any) {
    setBusy(true);
    setMsg('');
    try {
      await api.patch('/assistant/settings', patch);
      setMsg('AI settings saved.');
      await load();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function reindex(clearCache: boolean) {
    setBusy(true);
    setMsg('');
    try {
      if (clearCache) {
        await api.post('/assistant/cache/clear', {});
        setMsg('Cached answers cleared.');
      } else {
        const r = await api.post<any>('/knowledge/reindex-all', {});
        setMsg(`Re-indexed ${r.chunks} chunk(s), embedded ${r.embedded}.${r.embedError ? ` Embedding note: ${r.embedError}` : ''}`);
      }
      await load();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  const installed: string[] = status.model?.installedModels || [];

  return (
    <section className="card space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-ink">Local AI (Ollama)</h2>
          <p className="text-xs text-stone-500">
            Daybook only talks to a model running on your own machine. There is no paid API, no key, and no silent fallback.
          </p>
        </div>
        <span className={`badge ${status.model?.available ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}>
          {status.model?.available ? 'Ollama reachable' : 'Ollama offline'}
        </span>
      </div>

      <div className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
        <p>Endpoint: <span className="font-mono">{status.model?.baseUrl}</span></p>
        <p>Indexed locally: {status.knowledge?.chunks || 0} chunk(s), {status.knowledge?.embeddings || 0} embedding(s), {status.knowledge?.items || 0} knowledge entr{(status.knowledge?.items || 0) === 1 ? 'y' : 'ies'}.</p>
        {status.model?.problem && <p className="mt-1 text-amber-800">{status.model.problem}</p>}
        {installed.length > 0 && <p className="mt-1">Installed models: {installed.join(', ')}</p>}
      </div>
      {installed.length === 0 && status.model?.available && (
        <p className="text-xs text-amber-800">Ollama is reachable but has no models installed. Run: <span className="font-mono">ollama pull llama3.2:3b</span></p>
      )}

      {msg && <p className="text-xs font-semibold text-teal-800">{msg}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Chat model">
          <input
            value={form.chatModel}
            onChange={(e) => setForm({ ...form, chatModel: e.target.value })}
            placeholder={status.model?.chatModel || 'llama3.2:3b'}
          />
        </Field>
        <Field label="Embedding model">
          <input
            value={form.embedModel}
            onChange={(e) => setForm({ ...form, embedModel: e.target.value })}
            placeholder={status.model?.embedModel || 'nomic-embed-text'}
          />
        </Field>
      </div>

      <div className="space-y-1.5">
        {[
          ['enabled', 'Use the local model for answers', 'When off, you still get retrieved evidence but no generated wording.'],
          ['strictGrounding', 'Strict grounding', 'Prefer "I do not have that information" over any guess.'],
          ['cacheEnabled', 'Cache repeated knowledge-only answers', 'Operational and personal questions are never cached.'],
        ].map(([key, label, hint]) => (
          <label key={key} className="flex items-start gap-2 text-sm font-normal normal-case tracking-normal text-ink">
            <input
              type="checkbox"
              className="mt-0.5 !w-auto"
              checked={!!form[key]}
              onChange={(e) => { setForm({ ...form, [key]: e.target.checked }); save({ [key]: e.target.checked }); }}
            />
            <span>
              <span className="font-semibold">{label}</span>
              <span className="block text-xs text-stone-500">{hint}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <button className="btn-secondary" disabled={busy} onClick={() => reindex(true)}>Clear answer cache</button>
        <button className="btn-secondary" disabled={busy} onClick={() => reindex(false)}>Re-index knowledge</button>
        <button className="btn-primary" disabled={busy} onClick={() => save(form)}>Save AI settings</button>
      </div>
      <p className="text-[11px] text-stone-400">
        Changing the embedding model requires re-indexing. Model names are passed to your local Ollama instance only.
      </p>
    </section>
  );
}

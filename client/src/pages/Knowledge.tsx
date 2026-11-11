import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Loading, ErrorBox, Field, Modal } from '../components/ui';

interface Item {
  id: number;
  category: string;
  title: string;
  content: string;
  source: string;
  source_detail: string;
  status: string;
  last_updated: string;
  updated_by_name?: string;
  supersedes_id?: number | null;
  chunk_count?: number;
}
interface Doc {
  id: number;
  filename: string;
  text_status: string;
  text_length?: number;
  size_bytes: number;
  last_updated: string;
  doc_type?: string;
}
interface Category { id: string; label: string; hint: string; area: string }
interface Gap { label: string; hint: string; area: string }

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Entered manually',
  onboarding: 'Onboarding wizard',
  csv_import: 'CSV import',
  document: 'From document',
  seed: 'Demo data',
};

function fmt(s?: string) {
  if (!s) return '—';
  return String(s).slice(0, 10);
}

export default function Knowledge() {
  const [items, setItems] = useState<Item[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Item | null>(null);
  const [creating, setCreating] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [aiStatus, setAiStatus] = useState<any>(null);
  const [tab, setTab] = useState<'items' | 'documents' | 'services' | 'setup'>('items');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const d = await api.get<any>('/knowledge');
      setItems(d.items);
      setDocs(d.documents);
      setCategories(d.categories);
      setCounts(d.counts);
      setGaps(d.gaps);
    } catch (e: any) {
      setError(e.message || 'Could not load the knowledge center.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    api.get<any>('/assistant/status').then(setAiStatus).catch(() => setAiStatus(null));
  }, []);

  const filtered = useMemo(() => {
    let rows = items;
    if (activeCategory !== 'all') rows = rows.filter((i) => i.category === activeCategory);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((i) => `${i.title} ${i.content}`.toLowerCase().includes(q));
    }
    return rows;
  }, [items, activeCategory, search]);

  async function remove(item: Item) {
    if (!confirm(`Delete "${item.title || item.category}"? The assistant will no longer use it.`)) return;
    try {
      await api.del(`/knowledge/${item.id}`);
      setNotice('Entry deleted.');
      load();
    } catch (e: any) { setError(e.message); }
  }

  async function archive(item: Item) {
    try {
      await api.patch(`/knowledge/${item.id}`, { status: item.status === 'active' ? 'archived' : 'active' });
      setNotice(item.status === 'active' ? 'Entry archived — the assistant ignores it now.' : 'Entry restored.');
      load();
    } catch (e: any) { setError(e.message); }
  }

  if (loading) return <Loading text="Loading your knowledge base…" />;

  const hasModelIssue = aiStatus && !aiStatus.model?.available;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Business Knowledge</h1>
        <p className="text-sm text-stone-500">
          Everything here is what the assistant is allowed to use. It never invents business facts — if something is missing, it says so.
        </p>
      </div>

      {error && <ErrorBox message={error} />}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" onClick={() => setNotice('')}>
          {notice}
        </div>
      )}

      {hasModelIssue && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Local AI model not available</p>
          <p className="mt-1 text-xs">{aiStatus.model.problem}</p>
          <p className="mt-1 text-xs text-amber-800">
            Your knowledge is still fully searchable and the assistant will show retrieved evidence instead of guessing. Daybook never switches to a paid provider.
          </p>
        </div>
      )}

      {gaps.length > 0 && (
        <div className="card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-ink">Missing information ({gaps.length})</h2>
              <p className="text-xs text-stone-500">These gaps limit what the assistant can answer. Nothing is filled in for you.</p>
            </div>
            <button className="btn-secondary !px-3 !py-1.5 text-xs" onClick={() => setTab('setup')}>Guided setup</button>
          </div>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {gaps.map((g) => (
              <li key={g.area + g.label} className="rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2">
                <p className="text-sm font-semibold text-ink">{g.label}</p>
                <p className="text-xs text-stone-600">{g.hint}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-stone-300 bg-white p-1">
          {([
            ['items', `Knowledge (${items.length})`],
            ['documents', `Documents (${docs.length})`],
            ['services', 'Services & pricing'],
            ['setup', 'Guided setup'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${tab === id ? 'bg-teal-800 text-white' : 'text-stone-600 hover:bg-stone-100'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <button className="btn-secondary text-xs" onClick={() => setShowImport(true)}>Import CSV</button>
          <button className="btn-primary text-xs" onClick={() => { setEditing(null); setCreating(true); }}>Add knowledge</button>
        </div>
      </div>

      {tab === 'items' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              placeholder="Search your knowledge…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs"
            />
            <select value={activeCategory} onChange={(e) => setActiveCategory(e.target.value)} className="max-w-[220px]">
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({counts[c.id] || 0})
                </option>
              ))}
            </select>
            <span className="text-xs text-stone-500">{filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'}</span>
          </div>

          {filtered.length === 0 && (
            <div className="card px-6 py-12 text-center">
              <p className="text-sm font-semibold text-ink">No knowledge entries here yet</p>
              <p className="mt-1 text-sm text-stone-500">Add what you want the assistant to know about your business.</p>
            </div>
          )}

          <ul className="space-y-2">
            {filtered.map((item) => (
              <li key={item.id} className={`card p-4 ${item.status === 'archived' ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-bold text-ink">{item.title || '(untitled)'}</p>
                      <span className="badge bg-stone-200 text-stone-700">{categories.find((c) => c.id === item.category)?.label || item.category}</span>
                      {item.status === 'archived' && <span className="badge bg-stone-300 text-stone-700">Archived</span>}
                      {item.supersedes_id && <span className="badge bg-indigo-100 text-indigo-900">Replaces #{item.supersedes_id}</span>}
                    </div>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-stone-600">{item.content}</p>
                    <p className="mt-2 text-[11px] text-stone-500">
                      Source: {SOURCE_LABEL[item.source] || item.source}
                      {item.source_detail ? ` · ${item.source_detail}` : ''} · Updated {fmt(item.last_updated)}
                      {item.updated_by_name ? ` by ${item.updated_by_name}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => { setEditing(item); setCreating(false); }}>Edit</button>
                    <button className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => archive(item)}>
                      {item.status === 'active' ? 'Archive' : 'Restore'}
                    </button>
                    <button className="btn-danger" onClick={() => remove(item)}>Delete</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'documents' && <Documents docs={docs} onChange={load} onError={setError} onNotice={setNotice} />}
      {tab === 'services' && <Services onError={setError} onNotice={setNotice} />}
      {tab === 'setup' && <SetupGuide gaps={gaps} categories={categories} onError={setError} onNotice={setNotice} onDone={load} />}

      {(creating || editing) && (
        <ItemEditor
          item={editing}
          categories={categories}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={(msg) => { setCreating(false); setEditing(null); setNotice(msg); load(); }}
          onError={setError}
        />
      )}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onDone={(msg) => { setShowImport(false); setNotice(msg); load(); }} onError={setError} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ItemEditor({
  item, categories, onClose, onSaved, onError,
}: {
  item: Item | null;
  categories: Category[];
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState({
    category: item?.category || 'faq',
    title: item?.title || '',
    content: item?.content || '',
    source_detail: item?.source_detail || '',
  });
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (item) {
        await api.patch(`/knowledge/${item.id}`, {
          category: form.category, title: form.title, content: form.content, sourceDetail: form.source_detail,
        });
        onSaved('Knowledge updated. The assistant will use the new version immediately.');
      } else {
        const res = await api.post<any>('/knowledge', {
          category: form.category, title: form.title, content: form.content,
          source: 'manual', sourceDetail: form.source_detail,
        });
        const warn = res?.injectionWarning?.length
          ? ' Note: this entry contains text that looks like instructions to the AI; it was flagged and will not be obeyed.'
          : '';
        onSaved(`Knowledge added and indexed.${warn}`);
      }
    } catch (err: any) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={item ? 'Edit knowledge' : 'Add knowledge'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <Field label="Category">
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Title">
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Cancellation policy" />
        </Field>
        <Field label="Content">
          <textarea
            rows={8}
            required
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            placeholder="Write the actual information. Be specific — the assistant quotes this to answer questions."
          />
        </Field>
        <Field label="Source / note (optional)">
          <input
            value={form.source_detail}
            onChange={(e) => setForm({ ...form, source_detail: e.target.value })}
            placeholder="e.g. Owner policy reviewed Jan 2026"
          />
        </Field>
        <p className="text-[11px] text-stone-500">
          Daybook records who changed this and when. Only facts you write here are used — nothing is generated for you.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || !form.content.trim()}>
            {saving ? 'Saving…' : item ? 'Save changes' : 'Add knowledge'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function Documents({ docs, onChange, onError, onNotice }: { docs: Doc[]; onChange: () => void; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [docType, setDocType] = useState('pricing');
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<any>(null);

  async function upload(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('docType', docType);
      const res = await api.upload<any>('/knowledge/documents', form);
      if (res.document.text_status === 'extracted') {
        onNotice(`"${res.document.filename}" uploaded and indexed (${res.indexed?.chunks || 0} chunk(s)).`);
      } else {
        onNotice(`"${res.document.filename}" uploaded, but no text could be read. ${res.note || ''}`);
      }
      onChange();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function view(doc: Doc) {
    try {
      setPreview(await api.get<any>(`/knowledge/documents/${doc.id}`));
    } catch (e: any) { onError(e.message); }
  }

  async function remove(doc: Doc) {
    if (!confirm(`Delete "${doc.filename}"?`)) return;
    try {
      await api.del(`/knowledge/documents/${doc.id}`);
      onNotice('Document deleted.');
      onChange();
    } catch (e: any) { onError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-3 p-5">
        <h2 className="text-base font-bold text-ink">Upload a business document</h2>
        <p className="text-xs text-stone-500">
          Supported: .txt, .md, .csv, .json, text-based .pdf, .docx. Scanned PDFs are rejected rather than guessed at. Max 10 MB.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Document type">
            <select value={docType} onChange={(e) => setDocType(e.target.value)}>
              <option value="pricing">Pricing / price sheet</option>
              <option value="policy">Policy / terms</option>
              <option value="warranty">Warranty</option>
              <option value="procedure">Procedure / checklist</option>
              <option value="contract">Contract / agreement</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <div className="flex-1">
            <Field label="File">
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.csv,.json,.pdf,.docx,text/plain,application/pdf"
                disabled={busy}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
                className="file:mr-3 file:rounded-md file:border-0 file:bg-teal-800 file:px-3 file:py-1.5 file:text-white"
              />
            </Field>
          </div>
        </div>
        {busy && <p className="text-xs text-stone-500">Extracting text and indexing…</p>}
      </div>

      {docs.length === 0 ? (
        <div className="card px-6 py-10 text-center text-sm text-stone-500">
          No documents uploaded yet. Upload a price sheet or warranty document so the assistant can cite it.
        </div>
      ) : (
        <ul className="space-y-2">
          {docs.map((d) => (
            <li key={d.id} className="card flex flex-wrap items-center justify-between gap-2 p-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{d.filename}</p>
                <p className="text-xs text-stone-500">
                  {d.doc_type ? `${d.doc_type} · ` : ''}
                  {Math.round((d.size_bytes || 0) / 1024)} KB · updated {fmt(d.last_updated)} ·{' '}
                  <span className={
                    d.text_status === 'extracted' ? 'text-emerald-700'
                      : d.text_status === 'unsupported' ? 'text-amber-700' : 'text-stone-500'
                  }>
                    {d.text_status === 'extracted' ? `indexed (${d.text_length || 0} chars)` : d.text_status.replace(/_/g, ' ')}
                  </span>
                </p>
              </div>
              <div className="flex gap-1.5">
                <button className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => view(d)}>View text</button>
                <button className="btn-danger" onClick={() => remove(d)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {preview && (
        <Modal title={preview.filename} onClose={() => setPreview(null)}>
          <p className="mb-2 text-xs text-stone-500">Stored text — this is exactly what the assistant can retrieve.</p>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs text-stone-700">
            {preview.extracted_text || '(no text extracted)'}
          </pre>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Services({ onError, onNotice }: { onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [services, setServices] = useState<any[]>([]);
  const [form, setForm] = useState({ name: '', description: '', priceMin: '', priceMax: '', priceNote: '', durationMinutes: '' });
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const d = await api.get<any>('/knowledge/services');
      setServices(d.services);
    } catch (e: any) { onError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/knowledge/services', {
        name: form.name,
        description: form.description,
        priceMin: form.priceMin === '' ? null : Number(form.priceMin),
        priceMax: form.priceMax === '' ? null : Number(form.priceMax),
        priceNote: form.priceNote,
        durationMinutes: form.durationMinutes === '' ? null : Number(form.durationMinutes),
      });
      setForm({ name: '', description: '', priceMin: '', priceMax: '', priceNote: '', durationMinutes: '' });
      onNotice('Service added. The assistant can now describe and price it.');
      load();
    } catch (e: any) { onError(e.message); } finally { setSaving(false); }
  }

  async function remove(s: any) {
    if (!confirm(`Remove "${s.name}"?`)) return;
    try { await api.del(`/knowledge/services/${s.id}`); onNotice('Service removed.'); load(); } catch (e: any) { onError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h2 className="text-base font-bold text-ink">Services &amp; pricing</h2>
        <p className="text-xs text-stone-500">
          This is the only place the assistant gets prices from. Leave a price blank rather than guessing — it will say the price is not recorded.
        </p>
        <ul className="mt-3 space-y-2">
          {services.map((s) => (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-stone-50 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{s.name}</p>
                {s.description && <p className="text-xs text-stone-600">{s.description}</p>}
                <p className="mt-0.5 text-xs text-stone-500">
                  {s.price_min != null || s.price_max != null
                    ? `Price: ${s.price_min ?? '?'}${s.price_max != null ? `–${s.price_max}` : ''}`
                    : 'Price not recorded'}
                  {s.price_note ? ` · ${s.price_note}` : ''}
                  {s.duration_minutes ? ` · ${s.duration_minutes} min` : ''}
                </p>
              </div>
              <button className="btn-danger" onClick={() => remove(s)}>Remove</button>
            </li>
          ))}
          {services.length === 0 && <li className="px-3 py-6 text-center text-sm text-stone-500">No services recorded yet.</li>}
        </ul>
      </div>

      <form onSubmit={add} className="card space-y-3 p-5">
        <h3 className="text-sm font-bold text-ink">Add a service</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Duration (minutes)"><input type="number" min="0" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })} /></Field>
        </div>
        <Field label="Description"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Price from"><input type="number" min="0" step="0.01" value={form.priceMin} onChange={(e) => setForm({ ...form, priceMin: e.target.value })} /></Field>
          <Field label="Price to"><input type="number" min="0" step="0.01" value={form.priceMax} onChange={(e) => setForm({ ...form, priceMax: e.target.value })} /></Field>
        </div>
        <Field label="Pricing note"><input value={form.priceNote} onChange={(e) => setForm({ ...form, priceNote: e.target.value })} placeholder="e.g. includes first 30 minutes" /></Field>
        <div className="flex justify-end"><button className="btn-primary" type="submit" disabled={saving}>Add service</button></div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SetupGuide({
  gaps, categories, onError, onNotice, onDone,
}: { gaps: Gap[]; categories: Category[]; onError: (m: string) => void; onNotice: (m: string) => void; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ description: '', hours: '', serviceAreas: '', policies: '', paymentMethods: '' });
  const [service, setService] = useState({ name: '', priceMin: '', priceMax: '', priceNote: '', description: '' });
  const [services, setServices] = useState<any[]>([]);
  const [faq, setFaq] = useState({ question: '', answer: '' });
  const [faqs, setFaqs] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  const steps = ['Business basics', 'Services & prices', 'Policies & coverage', 'Common questions', 'Finish'];

  async function submit() {
    setSaving(true);
    try {
      const res = await api.post<any>('/onboarding/complete', {
        profile: form,
        services,
        faqs,
      });
      onNotice(`Saved. ${res.serviceCount} service(s), ${res.faqCount} FAQ(s) added.`);
      onDone();
      setStep(4);
    } catch (e: any) { onError(e.message); } finally { setSaving(false); }
  }

  return (
    <div className="card space-y-4 p-5">
      <div>
        <h2 className="text-base font-bold text-ink">Guided setup</h2>
        <p className="text-xs text-stone-500">
          Fill in only what is true for your business. Blank fields stay blank — Daybook will not invent them.
        </p>
      </div>

      <div className="flex flex-wrap gap-1">
        {steps.map((s, i) => (
          <button
            key={s}
            onClick={() => setStep(i)}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${step === i ? 'bg-teal-800 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}
          >
            {i + 1}. {s}
          </button>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-3">
          <Field label="What does your business do?">
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="A short honest description in your own words." />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Business hours"><input value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} placeholder="Mon–Fri 8:00–17:00" /></Field>
            <Field label="Payment methods"><input value={form.paymentMethods} onChange={(e) => setForm({ ...form, paymentMethods: e.target.value })} placeholder="Cash, card" /></Field>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Service name"><input value={service.name} onChange={(e) => setService({ ...service, name: e.target.value })} /></Field>
            <Field label="Description"><input value={service.description} onChange={(e) => setService({ ...service, description: e.target.value })} /></Field>
            <Field label="Price from"><input type="number" value={service.priceMin} onChange={(e) => setService({ ...service, priceMin: e.target.value })} /></Field>
            <Field label="Price to"><input type="number" value={service.priceMax} onChange={(e) => setService({ ...service, priceMax: e.target.value })} /></Field>
          </div>
          <Field label="Pricing note"><input value={service.priceNote} onChange={(e) => setService({ ...service, priceNote: e.target.value })} /></Field>
          <button
            type="button"
            className="btn-secondary"
            disabled={!service.name.trim()}
            onClick={() => {
              setServices([...services, { ...service }]);
              setService({ name: '', priceMin: '', priceMax: '', priceNote: '', description: '' });
            }}
          >
            Add to list
          </button>
          {services.length > 0 && (
            <ul className="space-y-1">
              {services.map((s, i) => (
                <li key={i} className="flex justify-between rounded bg-stone-50 px-3 py-1.5 text-sm">
                  <span>{s.name} {s.priceMin ? `· from ${s.priceMin}` : ''}</span>
                  <button className="text-xs text-red-600" onClick={() => setServices(services.filter((_, j) => j !== i))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <Field label="Service areas"><input value={form.serviceAreas} onChange={(e) => setForm({ ...form, serviceAreas: e.target.value })} placeholder="Towns or radius you cover" /></Field>
          <Field label="Policies (cancellation, deposits, payments)">
            <textarea rows={4} value={form.policies} onChange={(e) => setForm({ ...form, policies: e.target.value })} />
          </Field>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <Field label="Question customers ask"><input value={faq.question} onChange={(e) => setFaq({ ...faq, question: e.target.value })} /></Field>
          <Field label="Your answer"><textarea rows={3} value={faq.answer} onChange={(e) => setFaq({ ...faq, answer: e.target.value })} /></Field>
          <button
            type="button"
            className="btn-secondary"
            disabled={!faq.question.trim() || !faq.answer.trim()}
            onClick={() => { setFaqs([...faqs, { ...faq }]); setFaq({ question: '', answer: '' }); }}
          >
            Add FAQ
          </button>
          {faqs.length > 0 && (
            <ul className="space-y-1">
              {faqs.map((f, i) => (
                <li key={i} className="flex justify-between rounded bg-stone-50 px-3 py-1.5 text-sm">
                  <span className="truncate">{f.question}</span>
                  <button className="ml-2 shrink-0 text-xs text-red-600" onClick={() => setFaqs(faqs.filter((_, j) => j !== i))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {step === 4 && (
        <div className="space-y-2">
          <p className="text-sm text-stone-600">
            Saved. Remaining gaps are listed on the Knowledge page — the assistant will tell you when it does not know something instead of guessing.
          </p>
          {gaps.length > 0 && (
            <ul className="list-inside list-disc text-xs text-stone-500">
              {gaps.slice(0, 6).map((g) => <li key={g.label}>{g.label} — {g.hint}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="flex justify-between border-t border-stone-200 pt-3">
        <button className="btn-secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        <div className="flex gap-2">
          {step < 3 && <button className="btn-secondary" onClick={() => setStep(step + 1)}>Next</button>}
          <button className="btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : 'Save everything'}
          </button>
        </div>
      </div>
      <p className="text-[11px] text-stone-400">
        Categories available for manual entries: {categories.map((c) => c.label).join(', ')}.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ImportModal({ onClose, onDone, onError }: { onClose: () => void; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [kind, setKind] = useState<'knowledge' | 'customers'>('knowledge');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const sample = kind === 'knowledge'
    ? 'category,title,content\nfaq,Do you work weekends?,Yes — Saturday mornings only.\npricing,Call-out fee,75 USD including the first 30 minutes.'
    : 'name,phone,email,address,notes\nJane Doe,555-0100,jane@example.com,1 Main St,VIP customer';

  async function run(dryRun: boolean) {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.post<any>('/knowledge/import', { kind, csv, dryRun });
      setResult(res);
      if (!dryRun) onDone(`Imported ${res.created} record(s) from CSV.`);
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal title="Import from CSV" onClose={onClose}>
      <div className="space-y-3">
        <Field label="What are you importing?">
          <select value={kind} onChange={(e) => { setKind(e.target.value as any); setResult(null); }}>
            <option value="knowledge">Business knowledge</option>
            <option value="customers">Customer records</option>
          </select>
        </Field>
        <Field label="Paste CSV">
          <textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={sample} className="font-mono text-xs" />
        </Field>
        <button className="text-xs font-semibold text-teal-800 underline" onClick={() => setCsv(sample)}>Use sample format</button>

        {result && (
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs">
            <p className="font-semibold text-ink">{result.dryRun ? 'Preview' : 'Imported'}: {result.created} of {result.total} row(s)</p>
            {result.errors?.length > 0 && (
              <ul className="mt-1 max-h-32 overflow-auto text-amber-800">
                {result.errors.map((e: string, i: number) => <li key={i}>• {e}</li>)}
              </ul>
            )}
            {result.preview?.length > 0 && (
              <ul className="mt-1 max-h-32 overflow-auto text-stone-600">
                {result.preview.map((p: any, i: number) => (
                  <li key={i}>• {p.title || p.name} {p.category ? `(${p.category})` : ''}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-secondary" disabled={busy || !csv.trim()} onClick={() => run(true)}>Preview</button>
          <button className="btn-primary" disabled={busy || !csv.trim()} onClick={() => run(false)}>Import</button>
        </div>
      </div>
    </Modal>
  );
}

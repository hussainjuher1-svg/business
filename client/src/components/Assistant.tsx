import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Source {
  label: string;
  kind: string;
  recordType?: string;
  id?: number | null;
  title: string;
  category?: string;
  source?: string;
  lastUpdated?: string;
  status?: string | null;
  snippet?: string;
  score?: number;
}
interface Gap { label: string; area: string; hint?: string }
interface Conflict { kind: string; title: string; detail: string; explanation?: string }
interface Msg {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  gaps?: Gap[];
  warnings?: string[];
  conflicts?: Conflict[];
  mode?: string;
  latencyMs?: number;
}

const DEFAULT_SUGGESTIONS = [
  'What services do we provide?',
  'What are our business policies?',
  'Which estimates are still pending?',
  'What appointments do we have today?',
  'What should I prioritize today?',
  'What information is missing from my knowledge base?',
];

/** Mode labels are deliberately blunt about where an answer came from. */
function modeLabel(mode?: string) {
  switch (mode) {
    case 'local-model': return { text: 'Local AI model', tone: 'bg-emerald-100 text-emerald-900' };
    case 'model-offline': return { text: 'Model offline · retrieved evidence only', tone: 'bg-amber-100 text-amber-900' };
    case 'model-error': return { text: 'Model error · retrieved evidence only', tone: 'bg-amber-100 text-amber-900' };
    case 'ai-disabled': return { text: 'AI disabled · evidence only', tone: 'bg-stone-200 text-stone-700' };
    case 'no-evidence': return { text: 'No evidence found', tone: 'bg-rose-100 text-rose-900' };
    case 'builtin-guide': return { text: 'Daybook guide (verified)', tone: 'bg-sky-100 text-sky-900' };
    default: return { text: mode || 'Unknown', tone: 'bg-stone-200 text-stone-700' };
  }
}

function renderContent(text: string) {
  const lines = text.split('\n');
  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed">
      {lines.map((line, i) => {
        const parts = line.split(/(\*\*[^*]+\*\*|\[[KDR]\d+\])/g);
        return (
          <div key={i}>
            {parts.map((p, j) => {
              if (p.startsWith('**') && p.endsWith('**')) return <strong key={j}>{p.slice(2, -2)}</strong>;
              if (/^\[[KDR]\d+\]$/.test(p)) {
                return (
                  <span key={j} className="mx-0.5 rounded bg-teal-50 px-1 text-[10px] font-bold text-teal-800">
                    {p.slice(1, -1)}
                  </span>
                );
              }
              return <React.Fragment key={j}>{p}</React.Fragment>;
            })}
            {i < lines.length - 1 && <br />}
          </div>
        );
      })}
    </div>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  if (!sources || sources.length === 0) return null;
  return (
    <div className="mt-2 border-t border-stone-200 pt-2">
      <button onClick={() => setOpen(!open)} className="text-[11px] font-semibold text-teal-800 hover:underline">
        {open ? 'Hide' : 'Show'} sources ({sources.length})
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1">
          {sources.map((s, i) => (
            <li key={i} className="rounded border border-stone-200 bg-stone-50 p-1.5">
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-teal-100 px-1 text-[10px] font-bold text-teal-900">{s.label}</span>
                <span className="text-[11px] font-semibold text-ink">{s.title}</span>
                <span className="text-[10px] uppercase text-stone-500">
                  {s.kind === 'record' ? s.recordType : s.source || s.category || s.kind}
                </span>
              </div>
              {s.snippet && <p className="mt-1 line-clamp-3 text-[11px] text-stone-600">{s.snippet}</p>}
              {s.lastUpdated && <p className="mt-0.5 text-[10px] text-stone-400">Updated {String(s.lastUpdated).slice(0, 10)}</p>}
              {s.status && <p className="text-[10px] text-stone-400">Status: {s.status}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Assistant({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [convId, setConvId] = useState<number | undefined>(undefined);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [suggestions, setSuggestions] = useState<string[]>(DEFAULT_SUGGESTIONS);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api.get<any>('/assistant/status').then(setStatus).catch(() => setStatus(null));
    api.get<any>('/assistant/suggestions').then((r) => setSuggestions(r.suggestions || DEFAULT_SUGGESTIONS)).catch(() => {});
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || sending) return;
    setError('');
    setMessages((m) => [...m, { role: 'user', content }]);
    setInput('');
    setSending(true);
    try {
      const res = await api.post<any>('/assistant/chat', { message: content, conversationId: convId });
      setConvId(res.conversationId);
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: res.answer,
          sources: res.sources,
          gaps: res.gaps,
          warnings: res.warnings,
          conflicts: res.conflicts,
          mode: res.mode,
          latencyMs: res.latencyMs,
        },
      ]);
      if (res.mode === 'model-offline' || res.mode === 'model-error') {
        api.get<any>('/assistant/status').then(setStatus).catch(() => {});
      }
    } catch (e: any) {
      setError(e.message || 'Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  }

  if (!open) return null;

  const modelProblem = status && (!status.model?.available || !status.model?.chatModelReady);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-lg flex-col bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-stone-200 px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-ink">Ask Daybook</h2>
              <p className="text-xs text-stone-500">
                Local AI · answers cite your own knowledge and live records
              </p>
            </div>
            <button onClick={onClose} className="rounded-lg px-2 py-1 text-stone-500 hover:bg-stone-100" aria-label="Close assistant">✕</button>
          </div>
          {modelProblem && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
              <span className="font-semibold">Local model unavailable.</span> {status.model.problem}
              <span className="block text-amber-800">You will still get retrieved evidence, never a guess or a paid API.</span>
            </div>
          )}
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto bg-stone-50 px-4 py-3">
          {messages.length === 0 && (
            <div className="rounded-xl border border-stone-200 bg-white p-3">
              <p className="text-sm font-semibold text-ink">I answer from your business knowledge and live Daybook records.</p>
              <p className="mt-1 text-xs text-stone-600">
                Every answer shows its sources. If I do not know something, I will say so rather than invent it.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {suggestions.slice(0, 6).map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-full border border-stone-300 bg-white px-2.5 py-1 text-[11px] text-ink hover:bg-stone-100">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[92%] rounded-2xl px-3 py-2 ${
                  m.role === 'user' ? 'bg-teal-800 text-white' : 'border border-stone-200 bg-white text-ink'
                }`}
              >
                {renderContent(m.content)}

                {m.role === 'assistant' && (
                  <>
                    {m.warnings && m.warnings.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {m.warnings.map((w, j) => (
                          <p key={j} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">{w}</p>
                        ))}
                      </div>
                    )}

                    {m.conflicts && m.conflicts.length > 0 && (
                      <div className="mt-2 rounded border border-indigo-200 bg-indigo-50 px-2 py-1.5">
                        <p className="text-[11px] font-semibold text-indigo-900">Conflicting or outdated knowledge</p>
                        {m.conflicts.map((c, j) => (
                          <p key={j} className="text-[11px] text-indigo-800">{c.detail} {c.explanation || ''}</p>
                        ))}
                      </div>
                    )}

                    {m.gaps && m.gaps.length > 0 && (
                      <div className="mt-2 rounded border border-stone-200 bg-stone-50 px-2 py-1.5">
                        <p className="text-[11px] font-semibold text-stone-700">Missing information</p>
                        {m.gaps.slice(0, 4).map((g, j) => (
                          <p key={j} className="text-[11px] text-stone-600">
                            <span className="font-semibold">{g.label}</span>{g.hint ? ` — ${g.hint}` : ''}
                          </p>
                        ))}
                      </div>
                    )}

                    <Sources sources={m.sources || []} />

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className={`badge text-[10px] ${modeLabel(m.mode).tone}`}>{modeLabel(m.mode).text}</span>
                      {typeof m.latencyMs === 'number' && m.latencyMs > 0 && (
                        <span className="text-[10px] text-stone-400">{m.latencyMs} ms</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}

          {sending && (
            <div className="flex items-center gap-2 text-xs text-stone-500">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-stone-300 border-t-teal-800" />
              Searching your knowledge and live records…
            </div>
          )}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</div>}
          <div ref={bottomRef} />
        </div>

        <form className="border-t border-stone-200 p-3" onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your business…"
              aria-label="Message"
              disabled={sending}
            />
            <button type="submit" disabled={sending || !input.trim()} className="btn-primary">Send</button>
          </div>
          <p className="mt-1 text-[11px] text-stone-400">
            Facts come from your knowledge base and records. Drafts are never sent automatically.
          </p>
        </form>
      </div>
    </div>
  );
}

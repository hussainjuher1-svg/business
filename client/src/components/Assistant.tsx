import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Msg { role: 'user' | 'assistant'; content: string }

const SUGGESTIONS = [
  'What needs my attention today?',
  'Summarize my pending inquiries',
  'Which estimates need follow-up?',
  'What appointments are coming up?',
  'Explain how to use Daybook',
];

function renderContent(text: string) {
  // Simple markdown-ish rendering: bold, line breaks, bullet lists
  const lines = text.split('\n');
  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed">
      {lines.map((line, i) => {
        const parts = line.split(/(\*\*[^*]+\*\*)/g);
        return (
          <div key={i}>
            {parts.map((p, j) =>
              p.startsWith('**') && p.endsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : <React.Fragment key={j}>{p}</React.Fragment>
            )}
            {i < lines.length - 1 && <br />}
          </div>
        );
      })}
    </div>
  );
}

export default function Assistant({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [convId, setConvId] = useState<number | undefined>(undefined);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{ role: 'assistant', content: "Hi, I'm the Daybook Assistant. I can tell you what needs attention, summarize inquiries, estimates, appointments and follow-ups, answer business questions, or draft a message. What would you like to know?" }]);
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || sending) return;
    setError('');
    setMessages((m) => [...m, { role: 'user', content }]);
    setInput('');
    setSending(true);
    try {
      const res = await api.post<{ conversationId: number; answer: string; mode: string }>('/assistant/chat', { message: content, conversationId: convId });
      setConvId(res.conversationId);
      setMode(res.mode);
      setMessages((m) => [...m, { role: 'assistant', content: res.answer }]);
    } catch (e: any) {
      setError(e.message || 'Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
          <div>
            <h2 className="text-base font-bold text-ink">Ask Daybook</h2>
            <p className="text-xs text-stone-500">Your business assistant{mode ? ` · ${mode === 'llm' ? 'AI model' : 'built-in'}` : ''}</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-stone-500 hover:bg-stone-100" aria-label="Close assistant">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-stone-50">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${m.role === 'user' ? 'bg-teal-800 text-white' : 'bg-white border border-stone-200 text-ink'}`}>
                {renderContent(m.content)}
              </div>
            </div>
          ))}
          {sending && <p className="text-xs text-stone-500">Thinking…</p>}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</div>}
          <div ref={bottomRef} />
        </div>

        {messages.length <= 1 && (
          <div className="border-t border-stone-200 px-4 py-2">
            <p className="mb-1 text-xs font-semibold text-stone-500">Try asking:</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-stone-300 bg-white px-3 py-1 text-xs text-ink hover:bg-stone-100">{s}</button>
              ))}
            </div>
          </div>
        )}

        <form className="border-t border-stone-200 p-3" onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <div className="flex gap-2">
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about your business…" className="flex-1" aria-label="Message" />
            <button type="submit" disabled={sending || !input.trim()} className="btn-primary">Send</button>
          </div>
          <p className="mt-1 text-[11px] text-stone-400">Answers come from your real Daybook records. Drafts are never sent automatically.</p>
        </form>
      </div>
    </div>
  );
}

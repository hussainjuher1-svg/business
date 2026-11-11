import React, { useEffect, useState } from 'react';
import { api, AuthResponse, User } from './api';
import Auth from './pages/Auth';
import Today from './pages/Today';
import Inquiries from './pages/Inquiries';
import Customers from './pages/Customers';
import Work from './pages/Work';
import Settings from './pages/Settings';
import Knowledge from './pages/Knowledge';
import Assistant from './components/Assistant';
import { Loading, ErrorBox } from './components/ui';

type Page = 'today' | 'inquiries' | 'customers' | 'work' | 'knowledge' | 'settings';

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'today', label: 'Today', icon: '◉' },
  { id: 'inquiries', label: 'Inquiries', icon: '✉' },
  { id: 'customers', label: 'Customers', icon: '◎' },
  { id: 'work', label: 'Work', icon: '▣' },
  { id: 'knowledge', label: 'Knowledge', icon: '❖' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [businesses, setBusinesses] = useState<any[]>([]);
  const [page, setPage] = useState<Page>('today');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<AuthResponse>('/auth/me')
      .then((r) => { setUser(r.user); setBusinesses(r.businesses); })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  async function logout() {
    try { await api.post('/auth/logout'); } catch {}
    setUser(null);
    setBusinesses([]);
  }

  if (checking) return <Loading text="Checking your session…" />;
  if (!user) return <Auth onAuth={(r) => { setUser(r.user); setBusinesses(r.businesses); }} />;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <p className="text-lg font-extrabold tracking-tight text-ink">Daybook</p>
            <span className="hidden text-xs text-stone-500 sm:block">{businesses[0]?.business_name || ''}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setAssistantOpen(true)} className="btn-primary !px-3 !py-2 text-sm">Ask Daybook</button>
            <span className="hidden text-sm text-stone-600 sm:block">{user.name}</span>
            <button onClick={logout} className="btn-secondary !px-3 !py-2 text-sm">Log out</button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-2">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setPage(n.id)} className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold ${page === n.id ? 'bg-teal-800 text-white' : 'text-stone-600 hover:bg-stone-100'}`}>
              <span className="mr-1.5">{n.icon}</span>{n.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 pb-24">
        {error && <div className="mb-4"><ErrorBox message={error} /></div>}
        {page === 'today' && <Today go={(p) => setPage(p as Page)} />}
        {page === 'inquiries' && <Inquiries />}
        {page === 'customers' && <Customers />}
        {page === 'work' && <Work />}
        {page === 'knowledge' && <Knowledge />}
        {page === 'settings' && <Settings />}
      </main>

      <button onClick={() => setAssistantOpen(true)} className="fixed bottom-4 right-4 z-40 rounded-full bg-teal-800 px-5 py-3 text-sm font-bold text-white shadow-lg hover:bg-teal-900" aria-label="Open assistant">
        Ask Daybook
      </button>

      <Assistant open={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}

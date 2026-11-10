import React, { useState } from 'react';
import { api, AuthResponse } from '../api';
import { ErrorBox } from '../components/ui';

export default function Auth({ onAuth }: { onAuth: (a: AuthResponse) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', businessName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.post<AuthResponse>(mode === 'login' ? '/auth/login' : '/auth/register', form);
      onAuth(res);
    } catch (err: any) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p className="text-3xl font-extrabold tracking-tight text-ink">Daybook</p>
          <p className="mt-1 text-sm text-stone-500">One simple place to see what needs attention, what is happening today, and what to do next.</p>
        </div>
        <form onSubmit={submit} className="card space-y-3 p-6">
          <div className="flex rounded-lg bg-stone-100 p-1">
            <button type="button" onClick={() => setMode('login')} className={`flex-1 rounded-md py-2 text-sm font-semibold ${mode === 'login' ? 'bg-white shadow text-ink' : 'text-stone-500'}`}>Log in</button>
            <button type="button" onClick={() => setMode('register')} className={`flex-1 rounded-md py-2 text-sm font-semibold ${mode === 'register' ? 'bg-white shadow text-ink' : 'text-stone-500'}`}>Create account</button>
          </div>
          {error && <ErrorBox message={error} />}
          {mode === 'register' && (
            <>
              <div><label>Your name</label><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div><label>Business name</label><input required value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} /></div>
            </>
          )}
          <div><label>Email</label><input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><label>Password</label><input required type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="At least 8 characters" /></div>
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account & business'}</button>
          <p className="text-center text-xs text-stone-400">Demo account: demo@daybook.local / demo1234 (after running the seed)</p>
        </form>
      </div>
    </div>
  );
}

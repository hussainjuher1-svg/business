import React, { useState } from 'react';
import { api, AuthResponse } from '../api';
import { ErrorBox } from '../components/ui';

/**
 * Forced password change screen for retained demo accounts.
 * Blocks the app until the published demo password has been replaced.
 */
function ChangePassword({ onDone, onLogout }: { onDone: (a: AuthResponse) => void; onLogout: () => void }) {
  const [form, setForm] = useState({ currentPassword: 'demo1234', newPassword: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const mismatch = form.confirm.length > 0 && form.newPassword !== form.confirm;
  const tooShort = form.newPassword.length > 0 && form.newPassword.length < 10;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch || tooShort) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/change-password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
      const me = await api.get<any>('/auth/me');
      onDone({ user: me.user, businesses: me.businesses });
    } catch (err: any) {
      setError(err.message || 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p className="text-3xl font-extrabold tracking-tight text-ink">Daybook</p>
          <p className="mt-1 text-sm text-stone-500">Password change required</p>
        </div>
        <form onSubmit={submit} className="card space-y-3 p-6">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p className="font-semibold">This is a demo account.</p>
            <p className="mt-1">
              It is still using the published demo password, so Daybook will not show business data until you
              choose a new one. This account is flagged as demo and must not hold real customer information.
            </p>
          </div>
          {error && <ErrorBox message={error} />}
          <div>
            <label>Current password</label>
            <input required type="password" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
          </div>
          <div>
            <label>New password</label>
            <input required type="password" value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} placeholder="At least 10 characters" />
            {tooShort && <p className="mt-1 text-[11px] text-red-700">At least 10 characters.</p>}
          </div>
          <div>
            <label>Confirm new password</label>
            <input required type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
            {mismatch && <p className="mt-1 text-[11px] text-red-700">Passwords do not match.</p>}
          </div>
          <p className="text-[11px] text-stone-500">
            Must mix at least two of: lowercase, uppercase, numbers, symbols. Shared demo passwords are rejected.
          </p>
          <button className="btn-primary w-full" disabled={busy || mismatch || tooShort || !form.newPassword}>
            {busy ? 'Saving…' : 'Set new password'}
          </button>
          <button type="button" className="btn-secondary w-full" onClick={onLogout}>Log out instead</button>
        </form>
      </div>
    </div>
  );
}

export default function Auth({ onAuth }: { onAuth: (a: AuthResponse) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', businessName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mustChange, setMustChange] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.post<AuthResponse>(mode === 'login' ? '/auth/login' : '/auth/register', form);
      if (res.user?.mustChangePassword) {
        setMustChange(true);
        return;
      }
      onAuth(res);
    } catch (err: any) {
      // 429 = rate limited; the server message already explains the wait.
      setError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try { await api.post('/auth/logout'); } catch {}
    setMustChange(false);
    setForm({ email: '', password: '', name: '', businessName: '' });
  }

  if (mustChange) return <ChangePassword onDone={onAuth} onLogout={logout} />;

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
          <div>
            <label>Password</label>
            <input
              required
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder={mode === 'register' ? 'At least 10 characters' : ''}
            />
          </div>
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account & business'}</button>
          <p className="text-center text-xs text-stone-400">
            Demo accounts (created by the seed scripts) must change their password before use.
          </p>
        </form>
      </div>
    </div>
  );
}

const BASE = '/api';

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`) as Error & { status?: number; data?: any };
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => req<T>(path),
  post: <T>(path: string, body?: any) => req<T>(path, { method: 'POST', body: JSON.stringify(body || {}) }),
  patch: <T>(path: string, body?: any) => req<T>(path, { method: 'PATCH', body: JSON.stringify(body || {}) }),
  del: <T>(path: string) => req<T>(path, { method: 'DELETE' }),
  /** multipart upload (documents) — deliberately does not set Content-Type */
  upload: async <T>(path: string, form: FormData): Promise<T> => {
    const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'include', body: form });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) {
      const err = new Error(data?.error || `Upload failed (${res.status})`) as Error & { status?: number; data?: any };
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data as T;
  },
};

export interface User { id: number; email: string; name: string }
export interface Membership { business_id: number; role: string; business_name: string; timezone: string; currency: string }
export interface AuthResponse { user: User; businesses: Membership[] }

export function fmtDate(s?: string | null) {
  if (!s) return '—';
  return String(s).slice(0, 10);
}
export function fmtDateTime(s?: string | null) {
  if (!s) return '—';
  return String(s).replace('T', ' ').slice(0, 16);
}
export function statusLabel(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
export function statusColor(s: string) {
  const map: Record<string, string> = {
    new: 'bg-teal-100 text-teal-900',
    needs_response: 'bg-amber-100 text-amber-900',
    in_progress: 'bg-sky-100 text-sky-900',
    estimate_requested: 'bg-indigo-100 text-indigo-900',
    converted: 'bg-emerald-100 text-emerald-900',
    not_proceeding: 'bg-stone-200 text-stone-700',
    archived: 'bg-stone-200 text-stone-500',
    draft: 'bg-stone-200 text-stone-700',
    sent: 'bg-sky-100 text-sky-900',
    awaiting_response: 'bg-amber-100 text-amber-900',
    follow_up_needed: 'bg-orange-100 text-orange-900',
    accepted: 'bg-emerald-100 text-emerald-900',
    declined: 'bg-red-100 text-red-800',
    expired: 'bg-stone-200 text-stone-500',
    scheduled: 'bg-sky-100 text-sky-900',
    confirmation_needed: 'bg-amber-100 text-amber-900',
    confirmed: 'bg-emerald-100 text-emerald-900',
    completed: 'bg-emerald-100 text-emerald-900',
    cancelled: 'bg-red-100 text-red-800',
    rescheduled: 'bg-indigo-100 text-indigo-900',
    not_started: 'bg-stone-200 text-stone-700',
    waiting: 'bg-amber-100 text-amber-900',
    open: 'bg-amber-100 text-amber-900',
  };
  return map[s] || 'bg-stone-200 text-stone-700';
}

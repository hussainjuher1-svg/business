import React, { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '../api';
import { Loading, ErrorBox, Empty, StatusBadge } from '../components/ui';

interface Dashboard {
  today: string;
  business: any;
  attention: any[];
  nextSteps: any[];
  todayAppointments: any[];
  upcomingAppointments: any[];
  todayJobs: any[];
  activeJobs: any[];
  counts: any;
}

/**
 * Human labels for attention types. The API sends stable machine keys so a client
 * can branch on them; the badge must not show those keys to an owner. An unknown
 * type falls back to the raw key rather than rendering nothing, so a new server
 * type is visible instead of silently blank.
 */
const ATTENTION_LABEL: Record<string, string> = {
  inquiry: 'New inquiry',
  inquiry_unassigned: 'Unassigned',
  estimate: 'Estimate',
  estimate_follow_up_overdue: 'Overdue follow-up',
  follow_up: 'Follow-up',
  appointment: 'Appointment',
};

export default function Today({ go }: { go: (page: string) => void }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const d = await api.get<Dashboard>('/dashboard');
      setData(d);
    } catch (e: any) {
      setError(e.message || 'Could not load your dashboard.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  if (loading) return <Loading text="Loading your day…" />;
  if (error) return <div className="space-y-3"><ErrorBox message={error} /><button className="btn-secondary" onClick={load}>Retry</button></div>;
  if (!data) return <Empty title="Nothing to show yet" />;

  const c = data.counts;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Today</h1>
        <p className="text-sm text-stone-500">{data.business?.name} · {data.today}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'New inquiries', value: c.newInquiries, page: 'inquiries' },
          { label: 'Pending estimates', value: c.pendingEstimates, page: 'work' },
          { label: 'Overdue follow-ups', value: c.overdueFollowUps, page: 'work' },
          { label: 'Unconfirmed appts', value: c.unconfirmedAppointments, page: 'work' },
          { label: 'Active jobs', value: c.activeJobs, page: 'work' },
          { label: 'Inquiries this week', value: c.weekInquiries, page: 'inquiries' },
        ].map((s) => (
          <button key={s.label} onClick={() => go(s.page)} className="card p-3 text-left hover:border-teal-700">
            <p className="text-2xl font-extrabold text-ink">{s.value}</p>
            <p className="text-xs text-stone-500">{s.label}</p>
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-3 text-base font-bold text-ink">Needs your attention</h2>
          {data.attention.length === 0 ? (
            <p className="text-sm text-stone-500">Nothing needs attention right now. You're all caught up.</p>
          ) : (
            <ul className="space-y-2">
              {data.attention.map((a, i) => (
                <li key={i} className="flex items-start justify-between gap-3 rounded-lg border border-stone-100 bg-stone-50 px-3 py-2">
                  <div>
                    <p className="text-sm font-semibold text-ink">{a.title}</p>
                    {a.detail && <p className="text-xs text-stone-500">{a.detail}</p>}
                    <p className="text-xs text-stone-400">{fmtDateTime(a.date)}</p>
                  </div>
                  <span className={`badge ${a.type === 'estimate_follow_up_overdue' ? 'bg-red-100 text-red-900' : 'bg-amber-100 text-amber-900'}`}>
                    {ATTENTION_LABEL[a.type] || a.type}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-5">
          <h2 className="mb-3 text-base font-bold text-ink">Happening today</h2>
          {data.todayAppointments.length === 0 && data.todayJobs.length === 0 ? (
            <p className="text-sm text-stone-500">No appointments or jobs scheduled for today.</p>
          ) : (
            <div className="space-y-3">
              {data.todayAppointments.map((a) => (
                <div key={`a-${a.id}`} className="rounded-lg border border-stone-100 bg-stone-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink">{a.title}</p>
                    <StatusBadge status={a.status} />
                  </div>
                  <p className="text-xs text-stone-500">{fmtDateTime(a.starts_at)}{a.customer_name ? ` · ${a.customer_name}` : ''}{a.location ? ` · ${a.location}` : ''}</p>
                </div>
              ))}
              {data.todayJobs.map((j) => (
                <div key={`j-${j.id}`} className="rounded-lg border border-stone-100 bg-stone-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink">{j.title}</p>
                    <StatusBadge status={j.status} />
                  </div>
                  <p className="text-xs text-stone-500">Job{j.customer_name ? ` · ${j.customer_name}` : ''}</p>
                </div>
              ))}
            </div>
          )}
          {data.upcomingAppointments.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-bold text-ink">Coming up</h3>
              <ul className="space-y-1.5">
                {data.upcomingAppointments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between text-sm">
                    <span className="text-ink">{fmtDateTime(a.starts_at)} — {a.title}</span>
                    <StatusBadge status={a.status} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      <section className="card p-5">
        <h2 className="mb-3 text-base font-bold text-ink">Your next steps</h2>
        <ul className="space-y-2">
          {data.nextSteps.map((s, i) => (
            <li key={i} className="flex items-center gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-800 text-xs font-bold text-white">{i + 1}</span>
              <button onClick={() => go(s.link.includes('inquiries') ? 'inquiries' : s.link.includes('work') ? 'work' : 'today')} className="text-left text-sm font-medium text-ink hover:text-teal-800 hover:underline">
                {s.text}
              </button>
            </li>
          ))}
        </ul>
        <button onClick={load} className="btn-secondary mt-4">Refresh</button>
      </section>
    </div>
  );
}

import React from 'react';
import { statusColor, statusLabel } from '../api';

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${statusColor(status)}`}>{statusLabel(status)}</span>;
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return <div className="flex items-center justify-center py-16 text-sm text-stone-500"><span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-teal-800" />{text}</div>;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-12 text-center">
      <p className="text-base font-semibold text-ink">{title}</p>
      {hint && <p className="mt-1 max-w-md text-sm text-stone-500">{hint}</p>}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{message}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink">{title}</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-stone-500 hover:bg-stone-100" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label>{label}</label>{children}</div>;
}

'use client';

import { ReactNode } from 'react';

/** Shared fetch wrapper owned by the page so every panel reports connection state the same way. */
export type Request = (url: string, init?: RequestInit) => Promise<Record<string, unknown>>;

export const ratingColor = (rating: number) => {
  if (rating < 400) return '#9ca3af';
  if (rating < 800) return '#a8814f';
  if (rating < 1200) return '#35c46a';
  if (rating < 1600) return '#39bfd2';
  if (rating < 2000) return '#4f8cff';
  if (rating < 2400) return '#d66ef0';
  if (rating < 2800) return '#ffb340';
  return '#ff5667';
};

export const formatTime = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

export const formatDuration = (seconds: number | null) => (seconds === null ? '—' : formatTime(seconds));

export function formatRemaining(until: number) {
  const minutes = Math.max(0, Math.round((until - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

export function Panel({ badge, children }: { badge?: string; children: ReactNode }) {
  return (
    <div className="relative rounded-[2rem] border border-white/10 bg-[#11182b]/95 p-6 shadow-2xl shadow-black/30 backdrop-blur sm:p-9">
      {badge && <div className="absolute -right-2 -top-3 rotate-2 rounded-full bg-[#c8ff46] px-3 py-1 font-mono text-[11px] font-bold text-[#0b1020]">{badge}</div>}
      {children}
    </div>
  );
}

export function PrimaryButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`w-full rounded-2xl bg-[#c8ff46] py-4 text-base font-extrabold text-[#0b1020] transition hover:-translate-y-0.5 hover:bg-[#ddff8a] disabled:translate-y-0 disabled:opacity-50 ${props.className ?? ''}`}>{children}</button>;
}

export function GhostButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`w-full rounded-2xl border border-white/10 py-3.5 text-sm font-bold text-slate-300 transition hover:border-white/25 disabled:opacity-40 ${props.className ?? ''}`}>{children}</button>;
}

export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified
    ? <span className="rounded-full bg-[#c8ff46]/10 px-2.5 py-1 text-[10px] font-bold text-[#c8ff46]">✓ VERIFIED</span>
    : <span className="rounded-full bg-white/5 px-2.5 py-1 text-[10px] font-bold text-slate-500">UNVERIFIED</span>;
}

export function StakeBadge({ stake }: { stake: number }) {
  const hot = stake > 1.15;
  return <span className={`rounded-full px-2.5 py-1 font-mono text-[11px] font-bold ${hot ? 'bg-[#ff5667]/10 text-[#ff5667]' : 'bg-white/5 text-slate-400'}`}>판돈 ×{stake.toFixed(2)}</span>;
}

export function PlayerCard({ label, name, rating, active, bot, connected = true, note }:
{ label: string; name: string; rating: number; active?: boolean; bot?: boolean; connected?: boolean; note?: string }) {
  return <div className="flex min-h-60 flex-col justify-between p-7 sm:p-9 lg:min-h-[430px]">
    <div className="flex items-center justify-between"><span className="font-mono text-xs tracking-[.2em] text-slate-500">{label}</span>{(active || !connected) && <span className={`rounded-full px-2 py-1 text-[10px] ${connected ? 'bg-[#c8ff46]/10 text-[#c8ff46]' : 'bg-amber-400/10 text-amber-300'}`}>{connected ? 'CONNECTED' : 'RECONNECTING'}</span>}</div>
    <div className="py-10 text-center"><div className="mx-auto grid h-24 w-24 place-items-center rounded-[1.8rem] border border-white/10 bg-white/[.04] text-3xl font-black" style={{ color: ratingColor(rating) }}>{bot ? 'AI' : name.slice(0, 2).toUpperCase()}</div><h3 className="mt-6 break-all text-2xl font-bold">{name}</h3><p className="mt-2 font-mono text-sm" style={{ color: ratingColor(rating) }}>{rating} RATING</p></div>
    <p className="text-center text-xs text-slate-600">{note ?? (bot ? '실제 대전 기록 기반 봇' : 'AtCoder profile verified')}</p>
  </div>;
}

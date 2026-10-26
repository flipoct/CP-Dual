'use client';

import { ReactNode } from 'react';

/** Shared fetch wrapper owned by the page so every panel reports connection state the same way. */
export type Request = (url: string, init?: RequestInit) => Promise<Record<string, unknown>>;

/** AtCoder's own rating ladder, read from the token block. */
export const ratingColor = (rating: number) => {
  if (rating < 400) return 'var(--color-rank-grey)';
  if (rating < 800) return 'var(--color-rank-brown)';
  if (rating < 1200) return 'var(--color-rank-green)';
  if (rating < 1600) return 'var(--color-rank-cyan)';
  if (rating < 2000) return 'var(--color-rank-blue)';
  if (rating < 2400) return 'var(--color-rank-violet)';
  if (rating < 2800) return 'var(--color-rank-yellow)';
  return 'var(--color-rank-red)';
};

export const formatTime = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

export const formatDuration = (seconds: number | null) => (seconds === null ? '—' : formatTime(seconds));

export function formatRemaining(until: number) {
  const minutes = Math.max(0, Math.round((until - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

export function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="relative rounded-[2rem] border border-edge-2 bg-raised p-6 sm:p-9">
      {children}
    </div>
  );
}

export function PrimaryButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`w-full rounded-2xl bg-signal py-4 text-base font-extrabold text-signal-ink transition hover:-translate-y-0.5 hover:bg-signal-bright disabled:translate-y-0 disabled:opacity-50 ${props.className ?? ''}`}>{children}</button>;
}

export function GhostButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`w-full rounded-2xl border border-edge py-3.5 text-sm font-bold text-ink-2 transition hover:border-edge-2 disabled:opacity-40 ${props.className ?? ''}`}>{children}</button>;
}

export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified
    ? <span className="rounded-full bg-signal/10 px-2.5 py-1 text-xs font-bold text-signal">인증됨</span>
    : <span className="rounded-full bg-lift-2 px-2.5 py-1 text-xs font-bold text-ink-4">미인증</span>;
}

export function StakeBadge({ stake }: { stake: number }) {
  const hot = stake > 1.15;
  return <span className={`rounded-full px-2.5 py-1 font-mono text-[11px] font-bold ${hot ? 'bg-danger/10 text-danger' : 'bg-lift-2 text-ink-3'}`}>판돈 ×{stake.toFixed(2)}</span>;
}

export function PlayerCard({ label, name, rating, active, bot, connected = true, note }:
{ label: string; name: string; rating: number; active?: boolean; bot?: boolean; connected?: boolean; note?: string }) {
  return <div className="flex min-h-60 flex-col justify-between p-7 sm:p-9 lg:min-h-[430px]">
    <div className="flex items-center justify-between"><span className="text-sm text-ink-3">{label}</span>{(active || !connected) && <span className={`rounded-full px-2 py-1 text-xs ${connected ? 'bg-signal/10 text-signal' : 'bg-warn/10 text-warn'}`}>{connected ? '접속 중' : '재연결 중'}</span>}</div>
    <div className="py-10 text-center"><div className="mx-auto grid h-24 w-24 place-items-center rounded-[1.8rem] border border-edge bg-lift text-3xl font-black" style={{ color: ratingColor(rating) }}>{bot ? 'AI' : name.slice(0, 2).toUpperCase()}</div><h3 className="mt-6 break-all text-2xl font-bold">{name}</h3><p className="mt-2 font-mono text-sm" style={{ color: ratingColor(rating) }}>{rating} 레이팅</p></div>
    <p className="text-center text-xs text-ink-4">{note ?? (bot ? '실제 대전 기록 기반 봇' : 'AtCoder 프로필 확인됨')}</p>
  </div>;
}

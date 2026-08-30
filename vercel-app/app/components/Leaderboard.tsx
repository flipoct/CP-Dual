'use client';

import { useEffect, useState } from 'react';
import { GhostButton, ratingColor, Request } from '@/app/components/ui';

type Row = {
  rank: number; handle: string; duel_rating: number; peak_rating: number; atcoder_rating: number;
  wins: number; losses: number; draws: number; best_streak: number; rated_matches: number;
};

type You = Row & { rank: number | null; matchesToRank: number };

export function Leaderboard({ handle, request, onBack, onOpenProfile }: {
  handle: string | null; request: Request; onBack: () => void; onOpenProfile: (handle: string) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [you, setYou] = useState<You | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await request(`/api/leaderboard${handle ? `?handle=${encodeURIComponent(handle)}` : ''}`);
        if (cancelled) return;
        setRows(data.rows as Row[]);
        setYou((data.you as You | null) ?? null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '랭킹을 불러오지 못했습니다.');
      }
    })();
    return () => { cancelled = true; };
  }, [handle, request]);

  return <section className="relative mx-auto max-w-4xl px-5 pb-20 pt-4 sm:px-8">
    <p className="font-mono text-xs tracking-[.2em] text-[#c8ff46]">SEASON LEADERBOARD</p>
    <h1 className="mt-2 text-4xl font-black tracking-tight">듀얼 레이팅 랭킹</h1>
    <p className="mt-3 max-w-xl text-sm leading-6 text-slate-500">AtCoder 레이팅이 정확도라면 듀얼 레이팅은 속도입니다. 인증된 플레이어끼리의 레이팅 매치 3판부터 랭킹에 오릅니다.</p>

    {you && <div className="mt-7 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#c8ff46]/20 bg-[#c8ff46]/[.06] px-6 py-5">
      <div>
        <p className="font-mono text-xs tracking-[.2em] text-[#c8ff46]">YOU</p>
        <p className="mt-1 text-xl font-bold">{you.handle}</p>
        <p className="mt-1 text-xs text-slate-400">{you.wins}승 {you.losses}패 {you.draws}무 · 최고 {you.peak_rating}</p>
      </div>
      <div className="text-right">
        <p className="font-mono text-3xl font-black text-[#c8ff46]">{you.duel_rating}</p>
        <p className="mt-1 text-xs text-slate-400">{you.rank ? `${you.rank}위` : `랭킹까지 ${you.matchesToRank}판`}</p>
      </div>
    </div>}

    <div className="mt-6 overflow-hidden rounded-2xl border border-white/10">
      <table className="w-full text-left text-sm">
        <thead className="bg-white/[.03] font-mono text-[11px] uppercase tracking-widest text-slate-500">
          <tr><th className="px-4 py-3">#</th><th className="px-4 py-3">handle</th><th className="px-4 py-3 text-right">duel</th><th className="hidden px-4 py-3 text-right sm:table-cell">atcoder</th><th className="px-4 py-3 text-right">W-L-D</th></tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows?.map((row) => <tr key={row.handle} className={row.handle === handle ? 'bg-[#c8ff46]/[.05]' : ''}>
            <td className="px-4 py-3 font-mono text-slate-500">{row.rank}</td>
            <td className="px-4 py-3"><button className="font-bold hover:text-[#c8ff46]" onClick={() => onOpenProfile(row.handle)}>{row.handle}</button></td>
            <td className="px-4 py-3 text-right font-mono font-bold text-[#c8ff46]">{row.duel_rating}</td>
            <td className="hidden px-4 py-3 text-right font-mono sm:table-cell" style={{ color: ratingColor(row.atcoder_rating) }}>{row.atcoder_rating || '—'}</td>
            <td className="px-4 py-3 text-right font-mono text-slate-400">{row.wins}-{row.losses}-{row.draws}</td>
          </tr>)}
          {rows && !rows.length && <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-500">아직 랭킹에 오른 플레이어가 없습니다. 첫 번째가 되어보세요.</td></tr>}
          {!rows && !error && <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-600">불러오는 중…</td></tr>}
        </tbody>
      </table>
    </div>
    {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
    <GhostButton className="mt-7" onClick={onBack}>돌아가기</GhostButton>
  </section>;
}

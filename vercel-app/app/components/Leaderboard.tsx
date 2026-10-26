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
    <h1 className="mt-2 text-4xl font-black tracking-tight">듀얼 레이팅 랭킹</h1>
    <p className="mt-3 max-w-xl text-sm leading-6 text-ink-4">AtCoder 레이팅이 정확도라면 듀얼 레이팅은 속도입니다. 인증된 플레이어끼리의 레이팅 매치 3판부터 랭킹에 오릅니다.</p>

    {you && <div className="mt-7 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-signal/20 bg-signal/[.06] px-6 py-5">
      <div>
        <p className="text-sm text-ink-3">내 기록</p>
        <p className="mt-1 text-xl font-bold">{you.handle}</p>
        <p className="mt-1 text-xs text-ink-3">{you.wins}승 {you.losses}패 {you.draws}무 · 최고 {you.peak_rating}</p>
      </div>
      <div className="text-right">
        <p className="font-mono text-3xl font-black text-signal">{you.duel_rating}</p>
        <p className="mt-1 text-xs text-ink-3">{you.rank ? `${you.rank}위` : `랭킹까지 ${you.matchesToRank}판`}</p>
      </div>
    </div>}

    <div className="mt-6 overflow-hidden rounded-2xl border border-edge">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-edge-2 bg-lift text-sm font-bold text-ink-2">
          <tr><th className="px-4 py-3">순위</th><th className="px-4 py-3">핸들</th><th className="px-4 py-3 text-right">듀얼</th><th className="hidden px-4 py-3 text-right sm:table-cell">AtCoder</th><th className="px-4 py-3 text-right">전적</th></tr>
        </thead>
        <tbody className="divide-y divide-edge">
          {rows?.map((row) => <tr key={row.handle} className={row.handle === handle ? 'bg-signal/[.05]' : ''}>
            <td className="px-4 py-3 font-mono text-ink-4">{row.rank}</td>
            <td className="px-4 py-3"><button className="font-bold hover:text-signal" onClick={() => onOpenProfile(row.handle)}>{row.handle}</button></td>
            <td className="px-4 py-3 text-right font-mono font-bold text-signal">{row.duel_rating}</td>
            <td className="hidden px-4 py-3 text-right font-mono sm:table-cell" style={{ color: ratingColor(row.atcoder_rating) }}>{row.atcoder_rating || '—'}</td>
            <td className="px-4 py-3 text-right font-mono text-ink-3">{row.wins}-{row.losses}-{row.draws}</td>
          </tr>)}
          {rows && !rows.length && <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-ink-4">아직 랭킹에 오른 플레이어가 없습니다. 첫 번째가 되어보세요.</td></tr>}
          {!rows && !error && <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-ink-4">불러오는 중…</td></tr>}
        </tbody>
      </table>
    </div>
    {error && <p className="mt-4 text-sm text-danger">{error}</p>}
    <GhostButton className="mt-7" onClick={onBack}>돌아가기</GhostButton>
  </section>;
}

'use client';

import { useEffect, useState } from 'react';
import { formatDuration, GhostButton, ratingColor, Request } from '@/app/components/ui';

type Profile = {
  player: { handle: string; duel_rating: number; peak_rating: number; atcoder_rating: number; wins: number; losses: number; draws: number; streak: number; best_streak: number; rated_matches: number };
  played: number;
  winRate: number;
  speed: Array<{ bucket: string; samples: number; medianSeconds: number | null; globalMedianSeconds: number | null; deltaPercent: number | null }>;
  slots: Array<{ slot: string; wins: number; losses: number; draws: number; played: number; winRate: number }>;
  revenge: Array<{ problemId: string; title: string; rating: number; opponent: string; lostAt: number; url: string }>;
  revengeCleared: number;
  hardestWin: { title: string; rating: number; problemId: string } | null;
  recent: Array<{ opponent: string; bot: boolean; mode: string; result: string; rated: boolean; delta: number; ratingAfter: number; stake: number; problem: { id: string; title: string; rating: number }; durationSeconds: number; at: number }>;
};

const resultLabel: Record<string, string> = { win: '승', loss: '패', draw: '무' };
const modeLabel: Record<string, string> = { live: '실시간', bot: '봇', async: '도전장' };

export function ProfileView({ handle, request, onBack }: { handle: string; request: Request; onBack: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');

  // Remounted by the parent when the handle changes, so state starts clean.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await request(`/api/profile?handle=${encodeURIComponent(handle)}`);
        if (!cancelled) setProfile(data as unknown as Profile);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '전적을 불러오지 못했습니다.');
      }
    })();
    return () => { cancelled = true; };
  }, [handle, request]);

  const speedRows = profile?.speed.filter((row) => row.samples > 0) ?? [];
  const trueWall = speedRows.find((row) => (row.deltaPercent ?? 0) > 15);

  return <section className="relative mx-auto max-w-4xl px-5 pb-20 pt-4 sm:px-8">
    <h1 className="mt-2 break-all text-4xl font-black tracking-tight">{handle}</h1>

    {error && <p className="mt-6 rounded-xl border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>}
    {!profile && !error && <p className="mt-8 text-sm text-ink-4">불러오는 중…</p>}

    {profile && <>
      <div className="mt-7 grid gap-3 sm:grid-cols-4">
        <Stat label="듀얼 레이팅" value={String(profile.player.duel_rating)} accent note={`최고 ${profile.player.peak_rating}`} />
        <Stat label="전적" value={`${profile.player.wins}-${profile.player.losses}-${profile.player.draws}`} note={`승률 ${profile.winRate}%`} />
        <Stat label="연승" value={String(profile.player.streak)} note={`최다 ${profile.player.best_streak}연승`} />
        <Stat label="AtCoder" value={String(profile.player.atcoder_rating || '—')} color={ratingColor(profile.player.atcoder_rating)} note={`레이팅전 ${profile.player.rated_matches}판`} />
      </div>

      <h2 className="mt-12 text-xl font-bold">난이도별 체감 속도</h2>
      <p className="mt-2 text-sm leading-6 text-ink-4">이긴 대전의 풀이 시간을 전체 플레이어 중앙값과 비교합니다. 왼쪽으로 갈수록 빠릅니다.</p>
      {trueWall && <p className="mt-3 rounded-xl border border-warn/20 bg-warn/10 px-4 py-3 text-sm text-warn">{trueWall.bucket} 구간에서 평균보다 {trueWall.deltaPercent}% 느립니다. 실질적인 벽은 여기입니다.</p>}
      <div className="mt-5 space-y-2.5">
        {speedRows.length ? speedRows.map((row) => {
          const delta = row.deltaPercent ?? 0;
          const width = Math.min(50, Math.abs(delta) / 2);
          return <div key={row.bucket} className="flex items-center gap-3 text-sm">
            <span className="w-24 shrink-0 font-mono text-xs text-ink-4">{row.bucket}</span>
            <div className="relative h-6 flex-1 overflow-hidden rounded-lg bg-lift">
              <div className="absolute inset-y-0 left-1/2 w-px bg-edge-2" />
              <div className={`absolute inset-y-1 rounded ${delta <= 0 ? 'bg-signal/70' : 'bg-danger/70'}`}
                style={delta <= 0 ? { right: '50%', width: `${width}%` } : { left: '50%', width: `${width}%` }} />
            </div>
            <span className={`w-28 shrink-0 text-right font-mono text-xs ${delta <= 0 ? 'text-signal' : 'text-danger'}`}>
              {delta <= 0 ? '' : '+'}{delta}% · {formatDuration(row.medianSeconds)}
            </span>
          </div>;
        }) : <p className="text-sm text-ink-4">아직 표본이 없습니다. 몇 판 이겨보세요.</p>}
      </div>

      <h2 className="mt-12 text-xl font-bold">콘테스트 슬롯별 승률</h2>
      <p className="mt-2 text-sm leading-6 text-ink-4">ABC-D, ARC-C처럼 문제가 놓인 자리를 기준으로 묶었습니다.</p>
      <div className="mt-5 flex flex-wrap gap-3">
        {profile.slots.length ? profile.slots.map((slot) => <div key={slot.slot} className="min-w-24 rounded-2xl border border-edge bg-lift px-4 py-3 text-center">
          <p className="text-sm text-ink-3">{slot.slot}번 자리</p>
          <p className={`mt-1 text-2xl font-black ${slot.winRate >= 50 ? 'text-signal' : 'text-danger'}`}>{slot.winRate}%</p>
          <p className="mt-1 text-[11px] text-ink-4">{slot.played}판</p>
        </div>) : <p className="text-sm text-ink-4">아직 기록이 없습니다.</p>}
      </div>

      <h2 className="mt-12 text-xl font-bold">설욕 대기열</h2>
      <p className="mt-2 text-sm leading-6 text-ink-4">패배한 문제 중 아직 AC하지 못한 것들입니다. 지금까지 {profile.revengeCleared}문제를 설욕했습니다.</p>
      <div className="mt-5 space-y-2">
        {profile.revenge.length ? profile.revenge.map((item) => <a key={item.problemId} href={item.url} target="_blank" rel="noreferrer"
          className="flex items-center justify-between gap-4 rounded-2xl border border-edge bg-lift px-5 py-4 transition hover:border-signal/40">
          <div className="min-w-0">
            <p className="truncate font-bold">{item.title}</p>
            <p className="mt-1 text-xs text-ink-4">{item.problemId} · {item.opponent} 에게 패배</p>
          </div>
          <span className="shrink-0 font-mono text-sm" style={{ color: ratingColor(item.rating) }}>{item.rating}</span>
        </a>) : <p className="text-sm text-ink-4">밀린 복수가 없습니다. 훌륭합니다.</p>}
      </div>

      <h2 className="mt-12 text-xl font-bold">최근 대전</h2>
      <div className="mt-5 space-y-2">
        {profile.recent.length ? profile.recent.map((item, index) => <div key={`${item.at}-${index}`} className="flex items-center justify-between gap-4 rounded-2xl border border-edge bg-lift px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-sm"><b className={item.result === 'win' ? 'text-signal' : item.result === 'loss' ? 'text-danger' : 'text-ink-2'}>{resultLabel[item.result]}</b> · vs {item.opponent}</p>
            <p className="mt-1 truncate text-xs text-ink-4">{modeLabel[item.mode] ?? item.mode} · {item.problem.title} ({item.problem.rating}) · {item.durationSeconds ? formatDuration(item.durationSeconds) : '미해결'}</p>
          </div>
          <span className={`shrink-0 font-mono text-sm ${item.delta > 0 ? 'text-signal' : item.delta < 0 ? 'text-danger' : 'text-ink-4'}`}>
            {item.rated ? `${item.delta > 0 ? '+' : ''}${item.delta}` : '연습'}
          </span>
        </div>) : <p className="text-sm text-ink-4">아직 대전 기록이 없습니다.</p>}
      </div>
    </>}

    <GhostButton className="mt-10" onClick={onBack}>돌아가기</GhostButton>
  </section>;
}

function Stat({ label, value, note, accent, color }: { label: string; value: string; note?: string; accent?: boolean; color?: string }) {
  return <div className={`rounded-2xl border px-5 py-4 ${accent ? 'border-signal/25 bg-signal/[.06]' : 'border-edge bg-lift'}`}>
    <p className="text-sm text-ink-3">{label}</p>
    <p className="mt-1.5 text-2xl font-black" style={{ color: color ?? (accent ? 'var(--color-signal)' : undefined) }}>{value}</p>
    {note && <p className="mt-1 text-[11px] text-ink-4">{note}</p>}
  </div>;
}

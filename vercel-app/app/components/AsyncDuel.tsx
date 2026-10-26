'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDuration, formatRemaining, formatTime, GhostButton, PrimaryButton, ratingColor, Request, StakeBadge } from '@/app/components/ui';

export type DuelPayload = {
  challenge: {
    code: string; host: string; hostRating: number; pick: number; languages: string[];
    accepted: boolean; expiresAt: number; mine: boolean; isHost: boolean;
  };
  match: null | {
    id: string; mode: string; code: string | null; rated: boolean; expiresAt: number | null;
    you: { handle: string; rating: number; stake: number; startedAt: number | null; solvedAt: number | null; elapsedSeconds: number | null; done: boolean };
    opponent: { handle: string; rating: number; stake: number; started: boolean; finished: boolean; elapsedSeconds: number | null };
    range: number[];
    problem: { id: string; title: string; rating: number; language: string; url: string };
    winner: string | null;
    status: string;
    result: { delta: number; ratingAfter: number; rated: boolean } | null;
  };
};

export function AsyncDuel({ code, token, identity, handle, rating, pick, languages, request, onExit }: {
  code: string; token: string; identity: string; handle: string | null; rating: number;
  pick: number; languages: string[]; request: Request; onExit: () => void;
}) {
  const [payload, setPayload] = useState<DuelPayload | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  const url = `/api/challenge?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`;
  const load = useCallback(async () => {
    try {
      const data = await request(url);
      setPayload(data as unknown as DuelPayload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '도전장을 불러오지 못했습니다.');
    }
  }, [url, request]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await request(url);
        if (!cancelled) setPayload(data as unknown as DuelPayload);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '도전장을 불러오지 못했습니다.');
      }
    })();
    return () => { cancelled = true; };
  }, [url, request]);

  const match = payload?.match ?? null;
  const live = Boolean(payload) && (!payload?.challenge.accepted || match?.status === 'playing');
  useEffect(() => {
    if (!live) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => void load(), 5000);
    return () => { window.clearInterval(clock); window.clearInterval(poll); };
  }, [live, load]);

  const act = async (action: 'accept' | 'start' | 'giveup') => {
    setBusy(true); setError('');
    try {
      const data = await request('/api/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, code, token, identity, handle, rating, pick, languages }),
      });
      setPayload(data as unknown as DuelPayload);
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : '요청에 실패했습니다.');
    } finally { setBusy(false); }
  };

  const shareUrl = useMemo(() => (typeof location === 'undefined' ? '' : `${location.origin}/?duel=${code}`), [code]);
  const copy = () => { void navigator.clipboard?.writeText(shareUrl); setCopied(true); window.setTimeout(() => setCopied(false), 2000); };

  const header = <div className="mb-7 flex items-end justify-between gap-4">
    <div>
      <h1 className="text-3xl font-black tracking-tight">도전장 <span className="font-mono text-signal">{code}</span></h1>
    </div>
    {payload && <span className="shrink-0 text-right text-xs text-ink-4">{formatRemaining(payload.challenge.expiresAt)} 남음</span>}
  </div>;

  const shell = (children: React.ReactNode) => <section className="relative mx-auto max-w-3xl px-5 pb-20 pt-4 sm:px-8">
    {header}
    {children}
    {error && <p role="alert" className="mt-4 rounded-xl border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>}
    <GhostButton className="mt-7" onClick={onExit}>홈으로</GhostButton>
  </section>;

  if (!payload) return shell(<p className="text-sm text-ink-4">불러오는 중…</p>);
  const { challenge } = payload;

  // Waiting for someone to accept.
  if (!challenge.accepted) {
    if (challenge.isHost) {
      return shell(<div className="rounded-[2rem] border border-edge bg-panel p-8">
        <h2 className="mt-3 text-2xl font-bold">링크를 보내면 승부가 시작됩니다</h2>
        <p className="mt-3 text-sm leading-6 text-ink-3">상대는 24시간 안에 아무 때나 들어와서 같은 문제를 풀면 됩니다. 동시에 접속할 필요가 없습니다.</p>
        <div className="mt-6 flex items-center gap-2 rounded-2xl border border-edge bg-field p-2">
          <code className="min-w-0 flex-1 truncate px-3 py-2 font-mono text-sm text-ink-2">{shareUrl}</code>
          <button onClick={copy} className="shrink-0 rounded-xl bg-signal px-4 py-2 text-sm font-bold text-signal-ink">{copied ? '복사됨' : '복사'}</button>
        </div>
        <p className="mt-5 text-xs text-ink-4">내 선택 난이도 {challenge.pick} · 문제는 상대가 수락할 때 두 사람 모두 안 푼 것으로 뽑힙니다.</p>
      </div>);
    }
    return shell(<div className="rounded-[2rem] border border-signal/20 bg-panel p-8">
      <h2 className="mt-3 text-2xl font-bold"><span style={{ color: ratingColor(challenge.hostRating) }}>{challenge.host}</span> 님이 도전장을 보냈습니다</h2>
      <p className="mt-3 text-sm leading-6 text-ink-3">수락하면 두 사람 모두 풀지 않은 문제가 뽑힙니다. 각자 시작 버튼을 누른 순간부터 자기 시계가 돌아가고, 더 빨리 AC한 쪽이 이깁니다.</p>
      <p className="mt-5 text-sm text-ink-4">상대 선택 난이도 <b className="text-ink-2">{challenge.pick}</b> · 내 선택 난이도 <b className="text-ink-2">{pick}</b></p>
      {handle
        ? <PrimaryButton className="mt-7" disabled={busy} onClick={() => void act('accept')}>{busy ? '문제 뽑는 중…' : '도전 수락'}</PrimaryButton>
        : <p className="mt-7 rounded-xl border border-warn/20 bg-warn/10 px-4 py-3 text-sm text-warn">먼저 홈에서 AtCoder 닉네임을 확인해주세요.</p>}
    </div>);
  }

  if (!match) return shell(<p className="rounded-2xl border border-edge bg-lift px-5 py-6 text-sm text-ink-3">이미 다른 사람이 수락한 도전장입니다.</p>);

  // Accepted, but this player has not started their own clock yet.
  if (!match.you.startedAt) {
    return shell(<div className="rounded-[2rem] border border-edge bg-panel p-8 text-center">
      <h2 className="mt-3 text-2xl font-black">vs {match.opponent.handle}</h2>
      <p className="mt-4 text-sm leading-6 text-ink-3">시작을 누르면 문제가 공개되고 <b className="text-ink">내 시계</b>가 돌아갑니다. 상대의 시계와는 별개이니 편한 때 시작하세요.</p>
      <p className="mt-4 text-xs text-ink-4">{match.opponent.started ? '상대는 이미 시작했습니다.' : '상대는 아직 시작하지 않았습니다.'}</p>
      <div className="mt-6 flex justify-center gap-2"><StakeBadge stake={match.you.stake} />{match.rated && <span className="rounded-full bg-signal/10 px-2.5 py-1 text-xs font-bold text-signal">레이팅 반영</span>}</div>
      <PrimaryButton className="mt-7" disabled={busy} onClick={() => void act('start')}>{busy ? '시작하는 중…' : '지금 시작하기'}</PrimaryButton>
    </div>);
  }

  const elapsed = match.you.solvedAt && match.you.startedAt
    ? Math.round((match.you.solvedAt - match.you.startedAt) / 1000)
    : Math.max(0, Math.floor((now - match.you.startedAt) / 1000));
  const finished = match.status === 'finished';
  const win = match.winner === match.you.handle;

  return shell(<>
    <div className="overflow-hidden rounded-[2rem] border border-edge bg-panel p-7 sm:p-9">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="rounded-full bg-signal/10 px-3 py-1 text-xs text-signal">난이도 <span className="font-mono">{match.problem.rating}</span></span>
        <span className="font-mono text-3xl font-bold tabular-nums">{formatTime(elapsed)}</span>
      </div>
      <h2 className="mt-8 text-3xl font-black leading-tight">{match.problem.title}</h2>
      <p className="mt-3 text-sm text-ink-4">{match.problem.id}, 선택 범위 {match.range[0]}부터 {match.range[1]}까지</p>

      {!finished && <>
        <a href={match.problem.url} target="_blank" rel="noreferrer" className="mt-7 block rounded-2xl bg-signal py-4 text-center font-extrabold text-signal-ink transition hover:-translate-y-0.5 hover:bg-signal-bright">AtCoder에서 문제 열기 ↗</a>
        <GhostButton className="mt-3" disabled={busy} onClick={() => void load()}>✓ 풀었어요 · AC 확인</GhostButton>
        <button onClick={() => void act('giveup')} disabled={busy} className="mt-5 w-full py-2 text-xs font-bold text-danger hover:text-danger">이번 판 포기</button>
      </>}
    </div>

    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      <TimeCard label="내 시간" handle={match.you.handle} rating={match.you.rating}
        value={match.you.solvedAt ? formatDuration(match.you.elapsedSeconds) : match.you.done ? '포기' : formatTime(elapsed)} live={!match.you.solvedAt && !finished} />
      <TimeCard label="상대" handle={match.opponent.handle} rating={match.opponent.rating}
        value={finished ? (match.opponent.elapsedSeconds ? formatDuration(match.opponent.elapsedSeconds) : '미해결')
          : match.opponent.finished ? '완료 · 시간 비공개' : match.opponent.started ? '푸는 중' : '아직 시작 안 함'} />
    </div>

    {finished && <div className="mt-5 rounded-2xl border border-edge bg-lift px-6 py-6 text-center">
      <h3 className={`mt-3 text-4xl font-black ${match.winner === 'draw' ? 'text-ink' : win ? 'text-signal' : 'text-danger'}`}>
        {match.winner === 'draw' ? 'DRAW' : win ? 'VICTORY' : 'DEFEAT'}
      </h3>
      {match.result?.rated
        ? <p className="mt-3 text-sm text-ink-3">듀얼 레이팅 <b className={match.result.delta >= 0 ? 'text-signal' : 'text-danger'}>{match.result.delta >= 0 ? '+' : ''}{match.result.delta}</b> → {match.result.ratingAfter}</p>
        : <p className="mt-3 text-sm text-ink-4">양쪽 모두 핸들 인증을 마치면 레이팅이 걸립니다.</p>}
    </div>}
  </>);
}

function TimeCard({ label, handle, rating, value, live }: { label: string; handle: string; rating: number; value: string; live?: boolean }) {
  return <div className="rounded-2xl border border-edge bg-lift px-5 py-4">
    <div className="flex items-center justify-between">
      <span className="text-sm text-ink-3">{label}</span>
      {live && <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />}
    </div>
    <p className="mt-2 truncate font-bold" style={{ color: ratingColor(rating) }}>{handle}</p>
    <p className="mt-1 font-mono text-xl tabular-nums">{value}</p>
  </div>;
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatTime, GhostButton, PrimaryButton, ratingColor, Request } from '@/app/components/ui';

type ProblemView = {
  id?: string; contestId?: string; title?: string; difficulty: number; points: number; url?: string;
};

type Report = {
  score: { points: number; timeSeconds: number; solved: number };
  elapsedSeconds: number;
  standing: { rank: number; total: number; performance: number; beat: number };
  performance: number | null;
  perProblem: Array<{
    id: string; title: string; difficulty: number; points: number; url?: string;
    solved: boolean; seconds: number | null; penalties: number; sampleCount: number;
    performance: number | null; expectedSolveRate: number | null; yourSolveChance: number;
  }>;
};

export type Contest = {
  id: string; handle: string; rating: number; range: number[]; durationSeconds: number;
  status: 'preparing' | 'ready' | 'running' | 'finished';
  startedAt: number | null; endsAt: number | null;
  problems: ProblemView[]; remainingContests: number; settling: boolean; report: Report | null;
};

export function VirtualContest({ token, identity, handle, rating, request, onBack }: {
  token: string; identity: string; handle: string | null; rating: number; request: Request; onBack: () => void;
}) {
  const [contest, setContest] = useState<Contest | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [low, setLow] = useState(() => Math.max(0, Math.round((rating || 800) / 100) * 100 - 400));
  const [high, setHigh] = useState(() => Math.min(3600, Math.round((rating || 800) / 100) * 100 + 600));
  const [count, setCount] = useState(5);
  const [minutes, setMinutes] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => 0);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const data = await request('/api/virtual', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, token, identity, handle, rating }),
    });
    setContest((data.contest as Contest) ?? null);
    return data;
  }, [request, token, identity, handle, rating]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await request(`/api/virtual?token=${encodeURIComponent(token)}`);
        if (!cancelled) setContest((data.contest as Contest) ?? null);
      } catch { /* 아래에서 다시 시도합니다 */ }
      finally { if (!cancelled) setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [request, token]);

  // Preparation walks through one source contest per call so no request times out.
  useEffect(() => {
    if (contest?.status !== 'preparing') return;
    let cancelled = false;
    void (async () => {
      try { await post({ action: 'prepare', id: contest.id }); }
      catch (prepareError) {
        if (!cancelled) setError(prepareError instanceof Error ? prepareError.message : '문제 데이터를 준비하지 못했습니다.');
      }
    })();
    return () => { cancelled = true; };
  }, [contest?.status, contest?.remainingContests, contest?.id, post]);

  useEffect(() => {
    if (contest?.status !== 'running' && !contest?.settling) return;
    const id = contest.id;
    const kick = window.setTimeout(() => setNow(Date.now()), 0);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => { void post({ action: 'start', id }).catch(() => {}); }, 15_000);
    return () => { window.clearTimeout(kick); window.clearInterval(clock); window.clearInterval(poll); };
  }, [contest?.status, contest?.settling, contest?.id, post]);

  const act = async (body: Record<string, unknown>, failure: string) => {
    setBusy(true); setError('');
    try { await post(body); }
    catch (actError) { setError(actError instanceof Error ? actError.message : failure); }
    finally { setBusy(false); }
  };

  const shell = (children: React.ReactNode) => <section className="relative mx-auto max-w-4xl px-5 pb-20 pt-4 sm:px-8">
    <p className="font-mono text-xs tracking-[.2em] text-[#c8ff46]">VIRTUAL CONTEST</p>
    <h1 className="mt-2 text-4xl font-black tracking-tight">가상 대회</h1>
    {children}
    {error && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-300">{error}</p>}
    <GhostButton className="mt-8" onClick={onBack}>돌아가기</GhostButton>
  </section>;

  if (!loaded) return shell(<p className="mt-8 text-sm text-slate-600">불러오는 중…</p>);

  if (!contest || contest.status === 'finished') {
    return shell(<>
      {contest?.report && <FinishedReport contest={contest} />}
      <h2 className="mt-12 text-xl font-bold">{contest ? '새 대회 열기' : '나만의 대회를 구성하세요'}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-500">고른 난이도 구간에서 아직 안 푼 문제만 뽑아 대회를 만듭니다. 같은 문제를 실제로 푼 사람들의 기록으로 가상 참가자를 만들어, 당신의 퍼포먼스를 계산합니다.</p>

      <div className="mt-7 rounded-[2rem] border border-white/10 bg-[#11182b] p-6 sm:p-8">
        <label className="flex items-end justify-between"><span><b className="block">난이도 하한</b><small className="text-slate-500">가장 쉬운 문제</small></span><strong className="font-mono text-2xl text-[#c8ff46]">{low}</strong></label>
        <input type="range" min="0" max="3500" step="100" value={low} className="rating-range mt-4 w-full"
          onChange={(event) => { const value = Number(event.target.value); setLow(value); if (value >= high) setHigh(Math.min(3600, value + 100)); }} />

        <label className="mt-7 flex items-end justify-between"><span><b className="block">난이도 상한</b><small className="text-slate-500">가장 어려운 문제</small></span><strong className="font-mono text-2xl text-[#c8ff46]">{high}</strong></label>
        <input type="range" min="100" max="3600" step="100" value={high} className="rating-range mt-4 w-full"
          onChange={(event) => { const value = Number(event.target.value); setHigh(value); if (value <= low) setLow(Math.max(0, value - 100)); }} />

        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          <label><span className="flex items-end justify-between"><b>문제 수</b><strong className="font-mono text-lg text-[#c8ff46]">{count}</strong></span>
            <input type="range" min="3" max="8" step="1" value={count} onChange={(event) => setCount(Number(event.target.value))} className="rating-range mt-3 w-full" /></label>
          <label><span className="flex items-end justify-between"><b>제한 시간</b><strong className="font-mono text-lg text-[#c8ff46]">{minutes}분</strong></span>
            <input type="range" min="20" max="300" step="10" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} className="rating-range mt-3 w-full" /></label>
        </div>

        <p className="mt-6 text-xs leading-5 text-slate-500">배점은 쉬운 문제부터 100점씩 올라갑니다. 순위는 AtCoder와 같이 총점 우선, 동점이면 마지막 정답 시각(오답 1회당 5분 가산)으로 정합니다.</p>
        {handle
          ? <PrimaryButton className="mt-6" disabled={busy} onClick={() => act({ action: 'create', low, high, count, durationMinutes: minutes }, '대회를 만들지 못했습니다.')}>
            {busy ? '문제 뽑는 중…' : '대회 만들기'}</PrimaryButton>
          : <p className="mt-6 rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-300">먼저 홈에서 AtCoder 닉네임을 확인해주세요.</p>}
      </div>
    </>);
  }

  if (contest.status === 'preparing') {
    const total = contest.remainingContests + 1;
    return shell(<div className="mt-8 rounded-[2rem] border border-white/10 bg-[#11182b] p-8 text-center">
      <div className="mx-auto grid h-24 w-24 place-items-center rounded-full border border-[#c8ff46]/20 bg-[#c8ff46]/5">
        <div className="h-14 w-14 animate-spin rounded-full border-2 border-transparent border-t-[#c8ff46] border-r-[#c8ff46]/40" />
      </div>
      <p className="mt-7 font-mono text-xs tracking-[.22em] text-[#c8ff46]">BUILDING THE FIELD</p>
      <h2 className="mt-3 text-2xl font-bold">가상 참가자를 만들고 있습니다</h2>
      <p className="mt-3 text-sm leading-6 text-slate-400">뽑힌 문제들이 실제로 출제된 대회를 찾아, 그때 참가자들이 문제별로 몇 분 걸렸는지 수집하는 중입니다. 남은 대회 {contest.remainingContests}개.</p>
      <p className="mt-2 text-xs text-slate-600">한 번 수집하면 다음부터는 즉시 시작됩니다.</p>
      <div className="mx-auto mt-6 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-[#c8ff46] transition-all duration-500" style={{ width: `${Math.round(100 / total)}%` }} />
      </div>
    </div>);
  }

  if (contest.status === 'ready') {
    return shell(<div className="mt-8 rounded-[2rem] border border-[#c8ff46]/20 bg-[#11182b] p-8">
      <p className="font-mono text-xs tracking-[.2em] text-[#c8ff46]">READY</p>
      <h2 className="mt-3 text-2xl font-black">{contest.problems.length}문제 · {Math.round(contest.durationSeconds / 60)}분</h2>
      <p className="mt-3 text-sm leading-6 text-slate-400">시작을 누르면 문제가 공개되고 시계가 돌아갑니다. 문제는 AtCoder에서 평소처럼 풀면 되고, 정답 여부는 제출 기록에서 자동으로 확인합니다.</p>
      <div className="mt-6 flex flex-wrap gap-2">
        {contest.problems.map((problem, index) => <span key={index} className="rounded-xl border border-white/10 bg-white/[.03] px-4 py-2 font-mono text-xs">
          <b className="text-[#c8ff46]">{problem.points}점</b> <span style={{ color: ratingColor(problem.difficulty) }}>난이도 {problem.difficulty}</span>
        </span>)}
      </div>
      <PrimaryButton className="mt-8" disabled={busy} onClick={() => act({ action: 'start', id: contest.id }, '시작하지 못했습니다.')}>
        {busy ? '시작하는 중…' : '지금 시작하기'}</PrimaryButton>
    </div>);
  }

  // `now` is filled by the clock effect; until its first tick show the full duration.
  const remaining = contest.endsAt && now ? Math.max(0, Math.round((contest.endsAt - now) / 1000)) : contest.durationSeconds;
  const report = contest.report;
  return shell(<>
    <div className="mt-7 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[.035] px-6 py-5">
      <div>
        <p className="font-mono text-xs tracking-[.2em] text-slate-500">TIME LEFT</p>
        <p className={`mt-1 font-mono text-4xl font-black tabular-nums ${remaining < 300 ? 'text-[#ff5667]' : ''}`}>{formatTime(remaining)}</p>
      </div>
      <div className="text-right">
        <p className="font-mono text-xs tracking-[.2em] text-slate-500">SCORE</p>
        <p className="mt-1 font-mono text-2xl font-bold">{report?.score.points ?? 0}점 <span className="text-sm text-slate-500">({report?.score.solved ?? 0}/{contest.problems.length})</span></p>
      </div>
      <div className="text-right">
        <p className="font-mono text-xs tracking-[.2em] text-slate-500">LIVE RANK</p>
        <p className="mt-1 font-mono text-2xl font-bold text-[#c8ff46]">{report ? `${report.standing.rank}위` : '—'}
          <span className="ml-2 text-sm text-slate-500">/ {report?.standing.total ?? 0}</span></p>
      </div>
    </div>

    <div className="mt-4 space-y-2">
      {contest.problems.map((problem) => {
        const detail = report?.perProblem.find((entry) => entry.id === problem.id);
        return <a key={problem.id} href={problem.url} target="_blank" rel="noreferrer"
          className={`flex items-center justify-between gap-4 rounded-2xl border px-5 py-4 transition ${detail?.solved ? 'border-[#c8ff46]/40 bg-[#c8ff46]/[.06]' : 'border-white/10 bg-white/[.03] hover:border-white/25'}`}>
          <div className="min-w-0">
            <p className="truncate font-bold">{detail?.solved && <span className="mr-2 text-[#c8ff46]">✓</span>}{problem.title}</p>
            <p className="mt-1 text-xs text-slate-500">{problem.points}점 · 난이도 {problem.difficulty}
              {detail?.solved && ` · ${formatTime(detail.seconds ?? 0)}${detail.penalties ? ` (오답 ${detail.penalties})` : ''}`}</p>
          </div>
          <span className="shrink-0 font-mono text-sm" style={{ color: ratingColor(problem.difficulty) }}>↗</span>
        </a>;
      })}
    </div>

    <div className="mt-5 flex flex-col gap-3 sm:flex-row">
      <GhostButton disabled={busy} onClick={() => act({ action: 'start', id: contest.id }, '갱신하지 못했습니다.')}>✓ 지금 채점 새로고침</GhostButton>
      <GhostButton disabled={busy} onClick={() => act({ action: 'finish', id: contest.id }, '종료하지 못했습니다.')}>대회 종료하고 결과 보기</GhostButton>
    </div>
    <p className="mt-3 text-center text-xs leading-5 text-slate-600">15초마다 자동으로 채점합니다. 모두 풀거나 시간이 끝나면 자동 종료됩니다.<br />
      AtCoder에서 AC를 받아도 채점 데이터(AtCoder Problems)에 올라오기까지 <b className="text-slate-400">최대 몇 분</b> 걸립니다.
      바로 안 보여도 정상이고, 기록되는 시간은 실제 AC 시각 기준이라 손해는 없습니다.</p>
  </>);
}

function FinishedReport({ contest }: { contest: Contest }) {
  const report = contest.report;
  if (!report) return null;
  return <div className="mt-8 rounded-[2rem] border border-white/10 bg-[#11182b] p-8">
    <p className="font-mono text-xs tracking-[.3em] text-slate-500">CONTEST COMPLETE</p>
    <div className="mt-5 flex flex-wrap items-end gap-8">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-widest text-slate-500">performance</p>
        <p className="mt-1 text-5xl font-black" style={{ color: ratingColor(report.performance ?? 0) }}>{report.performance ?? '—'}</p>
      </div>
      <div>
        <p className="font-mono text-[11px] uppercase tracking-widest text-slate-500">rank</p>
        <p className="mt-1 text-3xl font-black">{report.standing.rank}<span className="text-lg text-slate-500"> / {report.standing.total}</span></p>
      </div>
      <div>
        <p className="font-mono text-[11px] uppercase tracking-widest text-slate-500">score</p>
        <p className="mt-1 text-3xl font-black">{report.score.points}<span className="text-lg text-slate-500">점 · {report.score.solved}솔브</span></p>
      </div>
    </div>
    <p className="mt-4 text-sm text-slate-400">가상 참가자 {report.standing.total - 1}명 중 {report.standing.beat}명을 이겼습니다.</p>
    {contest.settling && <p className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-xs leading-5 text-amber-300">
      아직 확정 전입니다. 종료 직전에 받은 AC가 채점 데이터에 늦게 올라올 수 있어, 10분 동안 계속 다시 확인합니다.</p>}

    <table className="mt-7 w-full text-left text-sm">
      <thead className="font-mono text-[11px] uppercase tracking-widest text-slate-500">
        <tr><th className="py-2">문제</th><th className="py-2 text-right">난이도</th><th className="py-2 text-right">내 시간</th><th className="py-2 text-right">문제별 perf</th><th className="hidden py-2 text-right sm:table-cell">표본</th></tr>
      </thead>
      <tbody className="divide-y divide-white/5">
        {report.perProblem.map((entry) => <tr key={entry.id}>
          <td className="py-3">
            <a href={entry.url} target="_blank" rel="noreferrer" className="font-bold hover:text-[#c8ff46]">{entry.solved && <span className="mr-1.5 text-[#c8ff46]">✓</span>}{entry.title}</a>
            <span className="ml-2 text-xs text-slate-600">{entry.points}점</span>
          </td>
          <td className="py-3 text-right font-mono" style={{ color: ratingColor(entry.difficulty) }}>{entry.difficulty}</td>
          <td className="py-3 text-right font-mono">{entry.solved ? formatTime(entry.seconds ?? 0) : '—'}</td>
          <td className="py-3 text-right font-mono font-bold" style={{ color: entry.performance ? ratingColor(entry.performance) : undefined }}>
            {entry.performance ?? (entry.solved ? <span className="text-xs font-normal text-slate-600" title="풀이 시간이 레이팅과 무관한 문제입니다">판별 불가</span> : '—')}</td>
          <td className="hidden py-3 text-right font-mono text-xs text-slate-600 sm:table-cell">{entry.sampleCount}</td>
        </tr>)}
      </tbody>
    </table>
    <p className="mt-4 text-xs leading-5 text-slate-600">문제별 perf는 &quot;그 문제를 딱 이만큼 걸려서 푸는 사람의 레이팅&quot;입니다. 같은 문제를 실제 대회에서 푼 사람들의 기록에서, 직전 정답과의 간격으로 계산했습니다.
      쉬운 문제는 레이팅과 상관없이 다들 비슷한 시간이 걸려서 역산이 불가능합니다 — 그런 경우 <b className="text-slate-500">판별 불가</b>로 표시하고, 관측된 레이팅 구간 밖으로는 추정하지 않습니다.</p>
  </div>;
}

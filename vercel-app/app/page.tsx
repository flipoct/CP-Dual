'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AsyncDuel } from '@/app/components/AsyncDuel';
import { Leaderboard } from '@/app/components/Leaderboard';
import { ProfileView } from '@/app/components/ProfileView';
import { VirtualContest } from '@/app/components/VirtualContest';
import { VerificationStatus, VerifyPanel } from '@/app/components/VerifyPanel';
import { formatTime, GhostButton, PlayerCard, PrimaryButton, ratingColor, StakeBadge, VerifiedBadge } from '@/app/components/ui';
import { stakeFor } from '@/lib/elo';

type Player = { handle: string; rating: number; rated: boolean };
type StatementLanguage = 'en' | 'ja';
type Match = {
  id: string;
  mode: string;
  rated: boolean;
  you: { handle: string; rating: number; stake: number };
  opponent: { handle: string; rating: number; bot: boolean; connected: boolean; stake: number; forfeitAt: number | null };
  range: number[];
  problem: { id: string; title: string; rating: number; language: StatementLanguage; url: string };
  startedAt: number;
  botFinishAt: number | null;
  reroll: { you: boolean; opponent: boolean };
  winner: string | null;
  status: string;
  result: { delta: number; ratingAfter: number; rated: boolean } | null;
};

type Stage = 'checkin' | 'ready' | 'searching' | 'match';
type View = 'home' | 'leaderboard' | 'profile' | 'duel' | 'virtual';
type StoredSession = { token: string; player: Player | null; pick: number; statementLanguages?: StatementLanguage[]; stage: Stage; match?: Match | null };

const SESSION_KEY = 'cp-dual-session-v1';
const IDENTITY_KEY = 'cp-dual-identity-v1';

const STATEMENT_LANGUAGE_OPTIONS: Array<{ value: StatementLanguage; label: string; short: string }> = [
  { value: 'en', label: 'English', short: '영어' },
  { value: 'ja', label: '日本語', short: '일본어' },
];

const statementLanguageLabel = (language: StatementLanguage) => STATEMENT_LANGUAGE_OPTIONS.find((option) => option.value === language)?.short ?? '일본어';

export default function Home() {
  const [handle, setHandle] = useState('');
  const [player, setPlayer] = useState<Player | null>(null);
  const [pick, setPick] = useState(800);
  const [statementLanguages, setStatementLanguages] = useState<StatementLanguage[]>(['en', 'ja']);
  const [stage, setStage] = useState<Stage>('checkin');
  const [view, setView] = useState<View>('home');
  const [profileHandle, setProfileHandle] = useState<string | null>(null);
  const [duelCode, setDuelCode] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [identity, setIdentity] = useState('');
  const [verification, setVerification] = useState<VerificationStatus | null>(null);
  const [showVerify, setShowVerify] = useState(false);
  const [match, setMatch] = useState<Match | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchSeconds, setSearchSeconds] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [nowMs, setNowMs] = useState(0);
  const [showSurrenderConfirm, setShowSurrenderConfirm] = useState(false);
  const [acMessage, setAcMessage] = useState('');
  const [restoring, setRestoring] = useState(true);
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected');

  const request = useCallback(async (url: string, init?: RequestInit) => {
    try {
      const response = await fetch(url, init);
      const raw = await response.text();
      if (!raw) throw new Error(response.ok ? '서버가 빈 응답을 반환했습니다.' : `매칭 서버 오류 (${response.status})`);
      let data: Record<string, unknown>;
      try { data = JSON.parse(raw) as Record<string, unknown>; }
      catch { throw new Error(response.ok ? '서버 응답 형식이 올바르지 않습니다.' : `매칭 서버 오류 (${response.status})`); }
      if (!response.ok) throw new Error(String(data.error ?? '요청에 실패했습니다.'));
      setConnection('connected');
      return data;
    } catch (requestError) {
      setConnection('reconnecting');
      throw requestError;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      let storedIdentity = localStorage.getItem(IDENTITY_KEY);
      if (!storedIdentity) { storedIdentity = crypto.randomUUID(); localStorage.setItem(IDENTITY_KEY, storedIdentity); }
      setIdentity(storedIdentity);

      const code = new URLSearchParams(location.search).get('duel')?.trim().toUpperCase() ?? '';
      if (code) { setDuelCode(code); setView('duel'); }

      let saved: StoredSession | null = null;
      try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as StoredSession | null; }
      catch { localStorage.removeItem(SESSION_KEY); }
      if (!saved?.token) {
        if (!cancelled) { setToken(crypto.randomUUID()); setRestoring(false); }
        return;
      }
      setToken(saved.token); setPlayer(saved.player); setHandle(saved.player?.handle ?? ''); setPick(saved.pick ?? 800);
      setStatementLanguages(saved.statementLanguages?.length ? saved.statementLanguages : ['en', 'ja']); setMatch(saved.match ?? null);
      try {
        let data = await request(`/api/match?token=${encodeURIComponent(saved.token)}`);
        if (data.status !== 'matched' && saved.stage === 'searching' && saved.player) {
          data = await request('/api/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'join', token: saved.token, handle: saved.player.handle, rating: saved.player.rating, languages: saved.statementLanguages?.length ? saved.statementLanguages : ['en', 'ja'], pick: saved.pick, identity: storedIdentity }) });
        }
        if (cancelled) return;
        if (data.status === 'matched') { setMatch(data.match as Match); setStage('match'); }
        else setStage(saved.stage === 'searching' && saved.player ? 'searching' : saved.player ? 'ready' : 'checkin');
      } catch {
        if (!cancelled) { setStage(saved.match ? 'match' : saved.player ? saved.stage : 'checkin'); setError('연결이 복구되면 자동으로 매치에 다시 접속합니다.'); }
      } finally { if (!cancelled) setRestoring(false); }
    };
    void restore();
    return () => { cancelled = true; };
  }, [request]);

  useEffect(() => {
    if (restoring || !token) return;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token, player, pick, statementLanguages, stage, match } satisfies StoredSession));
  }, [token, player, pick, statementLanguages, stage, match, restoring]);

  // Handle ownership status follows whichever handle is checked in.
  useEffect(() => {
    if (!player || !identity) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await request(`/api/verify?handle=${encodeURIComponent(player.handle)}&identity=${encodeURIComponent(identity)}`);
        if (!cancelled) setVerification(data as unknown as VerificationStatus);
      } catch { /* 인증 상태는 다음 진입에서 다시 확인합니다 */ }
    })();
    return () => { cancelled = true; };
  }, [player, identity, request]);

  useEffect(() => {
    if (restoring || !token || stage !== 'searching' || view !== 'home') return;
    const started = Date.now();
    const poll = async () => {
      try {
        const data = await request(`/api/match?token=${token}`);
        if (data.status === 'matched') { setMatch(data.match as Match); setStage('match'); }
      } catch { /* 다음 폴링에서 재시도 */ }
    };
    const timer = window.setInterval(() => { setSearchSeconds(Math.floor((Date.now() - started) / 1000)); void poll(); }, 1000);
    return () => window.clearInterval(timer);
  }, [stage, token, restoring, view, request]);

  useEffect(() => {
    if (restoring || !token || stage !== 'match' || !match) return;
    const poll = async () => {
      setElapsed(Math.floor((Date.now() - match.startedAt) / 1000));
      try {
        const data = await request(`/api/match?token=${token}`);
        if (data.match) setMatch(data.match as Match);
      } catch { /* 네트워크 복구 대기 */ }
    };
    void poll();
    const pollTimer = window.setInterval(() => void poll(), 5000);
    const clockTimer = window.setInterval(() => {
      const tick = Date.now();
      setNowMs(tick);
      setElapsed(Math.floor((tick - match.startedAt) / 1000));
    }, 1000);
    return () => { window.clearInterval(pollTimer); window.clearInterval(clockTimer); };
  }, [stage, match?.id, match?.startedAt, token, restoring, request]);

  const resetSession = (keepPlayer: boolean) => {
    const nextPlayer = keepPlayer ? player : null;
    setToken(crypto.randomUUID()); setMatch(null); setElapsed(0); setSearchSeconds(0);
    setShowSurrenderConfirm(false); setError(''); setPlayer(nextPlayer); setAcMessage('');
    if (!keepPlayer) setHandle('');
    setStage(nextPlayer ? 'ready' : 'checkin');
    setView('home');
  };

  const goHome = () => { setView('home'); setDuelCode(null); history.replaceState(null, '', location.pathname); };

  const toggleStatementLanguage = (language: StatementLanguage) => {
    setStatementLanguages((current) => current.includes(language)
      ? current.length === 1 ? current : current.filter((item) => item !== language)
      : [...current, language]);
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const data = await request(`/api/player?handle=${encodeURIComponent(handle.trim())}`) as unknown as Player;
      setPlayer(data); setPick(Math.max(100, Math.min(3600, Math.round((data.rating || 800) / 100) * 100))); setStage('ready');
    } catch (err) { setError(err instanceof Error ? err.message : '확인에 실패했습니다.'); }
    finally { setBusy(false); }
  };

  const post = (body: Record<string, unknown>) => request('/api/match', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const join = async () => {
    if (!player) return; setBusy(true); setError('');
    try {
      const data = await post({ action: 'join', token, handle: player.handle, rating: player.rating, languages: statementLanguages, pick, identity });
      if (data.status === 'matched') { setMatch(data.match as Match); setStage('match'); } else { setSearchSeconds(0); setStage('searching'); }
    } catch (err) { setError(err instanceof Error ? err.message : '매칭을 시작하지 못했습니다.'); }
    finally { setBusy(false); }
  };

  const matchBot = async () => {
    if (!player) return; setBusy(true); setError('');
    try {
      const data = await post({ action: 'bot', token, handle: player.handle, rating: player.rating, languages: statementLanguages, pick, identity });
      setMatch(data.match as Match); setStage('match');
    } catch (err) { setError(err instanceof Error ? err.message : '봇 매칭에 실패했습니다.'); }
    finally { setBusy(false); }
  };

  const createChallenge = async () => {
    if (!player) return; setBusy(true); setError('');
    try {
      const data = await request('/api/challenge', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', token, handle: player.handle, rating: player.rating, languages: statementLanguages, pick, identity }),
      });
      const code = (data.challenge as { code: string }).code;
      setDuelCode(code); setView('duel');
      history.replaceState(null, '', `?duel=${code}`);
    } catch (err) { setError(err instanceof Error ? err.message : '도전장을 만들지 못했습니다.'); }
    finally { setBusy(false); }
  };

  const cancel = async () => { await fetch(`/api/match?token=${token}`, { method: 'DELETE' }); setStage('ready'); setSearchSeconds(0); };

  const matchAction = async (action: 'reroll' | 'reroll_decline' | 'surrender', failure: string) => {
    if (!match) return; setBusy(true); setError('');
    try {
      const data = await post({ action, token, matchId: match.id });
      setMatch(data.match as Match); setShowSurrenderConfirm(false);
    } catch (err) { setError(err instanceof Error ? err.message : failure); }
    finally { setBusy(false); }
  };

  const checkAc = async () => {
    if (!match) return; setBusy(true); setError(''); setAcMessage('');
    try {
      const data = await request(`/api/match?token=${encodeURIComponent(token)}`);
      if (data.match) setMatch(data.match as Match);
      if (!(data.match as Match | undefined)?.winner) setAcMessage('아직 AC가 확인되지 않았습니다. AtCoder에서 AC를 받은 직후라면 잠시 후 다시 눌러주세요.');
    } catch (err) { setError(err instanceof Error ? err.message : 'AC 확인에 실패했습니다.'); }
    finally { setBusy(false); }
  };

  const outcome = useMemo(() => {
    if (!match?.winner) return null;
    if (match.winner === 'draw') return { title: '동시 AC!', sub: '이번 승부는 무승부입니다.', win: false };
    const win = match.winner === match.you.handle;
    return { title: win ? 'VICTORY' : 'DEFEAT', sub: `${match.winner} 님이 승리했습니다.`, win };
  }, [match]);

  const stake = player ? stakeFor(pick, player.rating) : 1;
  // Guard against a stale status left over from a previously checked-in handle.
  const verified = Boolean(player && verification?.verified && verification.handle === player.handle);
  const verificationOf = player && verification?.handle === player.handle ? verification : null;

  return (
    <main className="min-h-screen overflow-hidden bg-[#0b1020] text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_15%_10%,rgba(74,102,255,.13),transparent_34%),radial-gradient(circle_at_86%_70%,rgba(200,255,70,.08),transparent_28%)]" />
      <nav className="relative mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-6 sm:px-8">
        <button onClick={goHome} className="flex items-center gap-3" aria-label="CP Dual 홈">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#c8ff46] font-black text-[#0b1020] shadow-[0_0_24px_rgba(200,255,70,.18)]">CP</span>
          <span className="text-lg font-bold tracking-tight">CP Dual</span>
        </button>
        <div className="flex items-center gap-2">
          <button onClick={() => setView('virtual')} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:border-white/25 hover:text-white">가상 대회</button>
          <button onClick={() => setView('leaderboard')} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:border-white/25 hover:text-white">랭킹</button>
          {player && <button onClick={() => { setProfileHandle(player.handle); setView('profile'); }} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:border-white/25 hover:text-white">내 전적</button>}
          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[.04] px-3 py-1.5 text-xs text-slate-400 sm:flex">
            <i className={`h-1.5 w-1.5 animate-pulse rounded-full ${connection === 'connected' ? 'bg-[#c8ff46]' : 'bg-amber-400'}`} /> {restoring ? 'RESTORING' : connection === 'connected' ? 'LIVE' : 'RECONNECTING'}
          </div>
        </div>
      </nav>

      {view === 'leaderboard' && <Leaderboard handle={player?.handle ?? null} request={request} onBack={goHome}
        onOpenProfile={(target) => { setProfileHandle(target); setView('profile'); }} />}

      {view === 'profile' && profileHandle && <ProfileView key={profileHandle} handle={profileHandle} request={request}
        onBack={() => setView(player && profileHandle !== player.handle ? 'leaderboard' : 'home')} />}

      {view === 'virtual' && <VirtualContest token={token} identity={identity} handle={player?.handle ?? null}
        rating={player?.rating ?? 0} request={request} onBack={goHome} />}

      {view === 'duel' && duelCode && <AsyncDuel code={duelCode} token={token} identity={identity}
        handle={player?.handle ?? null} rating={player?.rating ?? 0} pick={pick} languages={statementLanguages}
        request={request} onExit={goHome} />}

      {view === 'home' && stage !== 'match' && (
        <section className="relative mx-auto grid min-h-[calc(100vh-88px)] max-w-6xl items-center gap-12 px-5 pb-20 sm:px-8 lg:grid-cols-[1.05fr_.95fr] lg:gap-20">
          <div>
            <p className="mb-5 font-mono text-xs font-bold uppercase tracking-[.24em] text-[#c8ff46]">1 vs 1 · first accepted wins</p>
            <h1 className="max-w-3xl text-5xl font-black leading-[.98] tracking-[-.055em] sm:text-7xl">문제 하나.<br />승자는 한 명.</h1>
            <p className="mt-7 max-w-xl text-base leading-7 text-slate-400 sm:text-lg sm:leading-8">실력대에 맞는 AtCoder 문제로 지금 바로 승부하세요. 같은 문제, 같은 순간, 먼저 AC를 받는 사람이 승리합니다.</p>
            <div className="mt-10 flex gap-8 text-sm text-slate-500">
              <span><b className="mb-1 block text-lg text-white">01</b>난이도 베팅</span>
              <span><b className="mb-1 block text-lg text-white">02</b>매칭 또는 도전장</span>
              <span><b className="mb-1 block text-lg text-white">03</b>먼저 AC</span>
            </div>
          </div>

          <div className="relative rounded-[2rem] border border-white/10 bg-[#11182b]/95 p-6 shadow-2xl shadow-black/30 backdrop-blur sm:p-9">
            <div className="absolute -right-2 -top-3 rotate-2 rounded-full bg-[#c8ff46] px-3 py-1 font-mono text-[11px] font-bold text-[#0b1020]">QUICK MATCH</div>
            {stage === 'checkin' && <>
              <p className="text-xs font-bold tracking-widest text-slate-500">CHALLENGER CHECK-IN</p>
              <h2 className="mt-3 text-2xl font-bold">AtCoder 닉네임을 입력하세요</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">프로필과 현재 레이팅을 확인합니다. 비밀번호는 필요하지 않아요.</p>
              <form onSubmit={verify} className="mt-8">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500" htmlFor="handle">AtCoder handle</label>
                <div className="mt-2 flex rounded-2xl border border-white/10 bg-[#090e1b] p-2 focus-within:border-[#c8ff46]/60">
                  <input id="handle" autoComplete="off" value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="tourist" className="min-w-0 flex-1 bg-transparent px-3 py-3 text-lg outline-none placeholder:text-slate-700" />
                  <button disabled={busy || !handle.trim()} className="rounded-xl bg-[#c8ff46] px-5 font-bold text-[#0b1020] transition hover:bg-[#ddff8a] active:scale-[.98] disabled:opacity-40">{busy ? '확인 중' : '확인'}</button>
                </div>
              </form>
            </>}

            {stage === 'ready' && player && <>
              <div className="flex items-center justify-between border-b border-white/10 pb-6">
                <div>
                  <p className="text-xs text-slate-500">READY PLAYER</p>
                  <h2 className="mt-1 flex items-center gap-2 text-2xl font-bold">{player.handle}</h2>
                  <button onClick={() => setShowVerify(true)} className="mt-2 inline-flex items-center gap-2 text-left">
                    <VerifiedBadge verified={verified} />
                    {!verified && <span className="text-[11px] text-slate-500 underline">인증하고 레이팅 켜기</span>}
                  </button>
                </div>
                <div className="text-right"><p className="text-xs text-slate-500">RATING</p><b className="text-2xl" style={{ color: ratingColor(player.rating) }}>{player.rating}</b></div>
              </div>

              {showVerify && <div className="mt-6"><VerifyPanel handle={player.handle} identity={identity} status={verificationOf}
                request={request} onStatus={setVerification} onClose={() => setShowVerify(false)} /></div>}

              <label htmlFor="pick" className="mt-7 flex items-end justify-between"><span><b className="block">난이도 베팅</b><small className="text-slate-500">높게 부를수록 얻는 것도 잃는 것도 커집니다</small></span><strong className="font-mono text-3xl text-[#c8ff46]">{pick}</strong></label>
              <input id="pick" type="range" min="100" max="3600" step="100" value={pick} onChange={(event) => setPick(Number(event.target.value))} className="rating-range mt-5 w-full" />
              <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-slate-600"><span>100</span><StakeBadge stake={stake} /><span>3600</span></div>
              <p className="mt-3 text-xs leading-5 text-slate-500">내 레이팅 {player.rating || 800} 대비 {pick >= (player.rating || 800) ? '높은' : '낮은'} 난이도 · 승패에 걸리는 듀얼 레이팅이 <b className="text-slate-300">×{stake.toFixed(2)}</b> 배가 됩니다.</p>

              <fieldset className="mt-7">
                <legend><b className="block">읽을 수 있는 문제 언어</b><small className="text-slate-500">상대와 공통으로 선택한 공식 지문만 출제됩니다</small></legend>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {STATEMENT_LANGUAGE_OPTIONS.map((option) => {
                    const selected = statementLanguages.includes(option.value);
                    return <button key={option.value} type="button" aria-pressed={selected} onClick={() => toggleStatementLanguage(option.value)} className={`rounded-2xl border px-4 py-3.5 text-sm font-bold transition ${selected ? 'border-[#c8ff46]/50 bg-[#c8ff46]/10 text-[#c8ff46]' : 'border-white/10 bg-[#090e1b] text-slate-500 hover:border-white/20'}`}><span className="mr-2">{selected ? '✓' : '○'}</span>{option.label}</button>;
                  })}
                </div>
              </fieldset>
              <PrimaryButton className="mt-8" onClick={join} disabled={busy}>온라인 매칭 시작 →</PrimaryButton>
              <GhostButton className="mt-3" onClick={createChallenge} disabled={busy}>도전장 링크 만들기 · 24시간 비동기</GhostButton>
              <GhostButton className="mt-3" onClick={() => setView('virtual')} disabled={busy}>가상 대회 열기 · 내 난이도 구간으로</GhostButton>
              <button onClick={() => resetSession(false)} className="mt-3 w-full py-2 text-sm text-slate-500 hover:text-white">닉네임 변경</button>
            </>}

            {stage === 'searching' && player && <div className="py-3 text-center">
              <div className="mx-auto grid h-28 w-28 place-items-center rounded-full border border-[#c8ff46]/20 bg-[#c8ff46]/5"><div className="h-16 w-16 animate-spin rounded-full border-2 border-transparent border-t-[#c8ff46] border-r-[#c8ff46]/40" /></div>
              <p className="mt-7 font-mono text-xs tracking-[.22em] text-[#c8ff46]">SEARCHING · {formatTime(searchSeconds)}</p>
              <h2 className="mt-3 text-2xl font-bold">도전자를 찾고 있습니다</h2>
              <p className="mt-2 text-sm text-slate-500">{player.handle} · 베팅 {pick} · {statementLanguages.map(statementLanguageLabel).join('·')}</p>
              {searchSeconds >= 10 && <>
                <GhostButton className="mt-7" onClick={createChallenge} disabled={busy}>도전장 링크로 친구 부르기</GhostButton>
                <PrimaryButton className="mt-3" onClick={matchBot} disabled={busy}>봇과 바로 시작하기</PrimaryButton>
              </>}
              <button onClick={cancel} className="mt-3 w-full py-3 text-sm text-slate-500 hover:text-white">매칭 취소</button>
            </div>}
            {error && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-300">{error}</p>}
          </div>
        </section>
      )}

      {view === 'home' && stage === 'match' && match && (
        <section className="relative mx-auto max-w-6xl px-5 pb-16 pt-7 sm:px-8">
          <div className="mb-6 flex items-end justify-between">
            <div>
              <p className="font-mono text-xs tracking-[.2em] text-[#c8ff46]">MATCH #{match.id.slice(0, 6).toUpperCase()}</p>
              <h1 className="mt-2 text-3xl font-black tracking-tight">DUEL IN PROGRESS</h1>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <StakeBadge stake={match.you.stake} />
                <span className={`rounded-full px-2.5 py-1 font-mono text-[11px] font-bold ${match.rated ? 'bg-[#c8ff46]/10 text-[#c8ff46]' : 'bg-white/5 text-slate-500'}`}>{match.rated ? 'RATED' : '연습 · 무평점'}</span>
              </div>
            </div>
            <div className="font-mono text-3xl font-bold tabular-nums sm:text-4xl">{formatTime(elapsed)}</div>
          </div>

          <div className="grid overflow-hidden rounded-[2rem] border border-white/10 bg-[#11182b] lg:grid-cols-[1fr_1.16fr_1fr]">
            <PlayerCard label="YOU" name={match.you.handle} rating={match.you.rating} active note={verified ? 'AtCoder 소유 인증됨' : '미인증 · 레이팅 미반영'} />
            <div className="relative border-y border-white/10 bg-[#0d1425] p-7 lg:border-x lg:border-y-0 sm:p-9">
              <div className="flex items-center justify-between"><span className="rounded-full bg-[#c8ff46]/10 px-3 py-1 font-mono text-xs text-[#c8ff46]">RATING {match.problem.rating} · {statementLanguageLabel(match.problem.language)}</span><span className="font-mono text-xs text-slate-600">{match.problem.id.toUpperCase()}</span></div>
              <p className="mt-9 text-xs font-bold tracking-widest text-slate-500">TODAY&apos;S PROBLEM</p>
              <h2 className="mt-3 min-h-20 text-3xl font-black leading-tight">{match.problem.title}</h2>
              <p className="mt-4 text-sm text-slate-500">베팅 범위 {match.range[0]}—{match.range[1]} · 두 플레이어 모두 미해결</p>
              <a href={match.problem.url} target="_blank" rel="noreferrer" className="mt-8 block rounded-2xl bg-[#c8ff46] py-4 text-center font-extrabold text-[#0b1020] transition hover:-translate-y-0.5 hover:bg-[#ddff8a]">AtCoder에서 문제 열기 ↗</a>
              <button onClick={checkAc} disabled={busy || Boolean(match.winner)} className="mt-3 w-full rounded-2xl border border-[#c8ff46]/30 bg-[#c8ff46]/10 py-3.5 text-sm font-extrabold text-[#c8ff46] hover:bg-[#c8ff46]/15 disabled:opacity-40">{busy ? 'AC 확인 중…' : '✓ 풀었어요 · AC 확인'}</button>
              {acMessage && <p role="status" className="mt-2 text-center text-xs leading-5 text-amber-300">{acMessage}</p>}
              <button onClick={() => matchAction('reroll', '문제를 다시 뽑지 못했습니다.')} disabled={busy || match.reroll.you || Boolean(match.winner)} className="mt-3 w-full rounded-2xl border border-white/10 py-3.5 text-sm font-bold text-slate-300 hover:border-white/25 disabled:opacity-40">{match.reroll.you ? '상대 수락 대기 중…' : match.reroll.opponent ? '다음 문제로 넘어가기 수락' : '↻ 다음 문제 제안'}</button>
              <p className="mt-3 text-center text-xs text-slate-600">양쪽이 동의하면 타이머와 문제가 초기화됩니다.</p>
              <button onClick={() => setShowSurrenderConfirm(true)} disabled={Boolean(match.winner)} className="mt-5 w-full py-2 text-xs font-bold text-red-400/70 hover:text-red-300 disabled:opacity-30">깃발을 내리고 항복</button>
            </div>
            <PlayerCard label={match.opponent.bot ? 'BOT' : 'OPPONENT'} name={match.opponent.handle} rating={match.opponent.rating} bot={match.opponent.bot} connected={match.opponent.connected} />
          </div>

          <div className="mt-5 flex flex-col items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[.035] px-5 py-4 text-sm text-slate-400 sm:flex-row">
            {!match.winner && !match.opponent.bot && !match.opponent.connected && match.opponent.forfeitAt
              ? <span className="text-amber-300"><i className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />상대 재연결 대기 중 · {formatTime(Math.max(0, Math.ceil((match.opponent.forfeitAt - (nowMs || match.opponent.forfeitAt)) / 1000)))} 후 자동 승리</span>
              : <span><i className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[#c8ff46]" />AtCoder 제출 내역에서 AC를 자동 확인합니다</span>}
          </div>
          {error && <p className="mt-4 text-center text-sm text-red-300">{error}</p>}

          {match.reroll.opponent && !match.reroll.you && !match.winner && <div className="fixed inset-0 z-20 grid place-items-center bg-[#070b15]/80 p-5 backdrop-blur-md"><div role="alertdialog" aria-modal="true" aria-labelledby="reroll-title" className="w-full max-w-md rounded-[2rem] border border-[#c8ff46]/20 bg-[#11182b] p-8 text-center shadow-2xl"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#c8ff46]/10 text-2xl text-[#c8ff46]">↻</div><p className="mt-5 font-mono text-xs tracking-[.2em] text-[#c8ff46]">NEW REQUEST</p><h2 id="reroll-title" className="mt-2 text-2xl font-black">상대가 다음 문제를 제안했습니다</h2><p className="mt-3 text-sm leading-6 text-slate-400">수락하면 새 문제가 뽑히고 타이머가 함께 초기화됩니다.</p><div className="mt-7 grid grid-cols-2 gap-3"><button onClick={() => matchAction('reroll_decline', '요청을 거절하지 못했습니다.')} disabled={busy} className="rounded-2xl border border-white/10 py-3.5 font-bold text-slate-300 hover:border-white/25">거절</button><button onClick={() => matchAction('reroll', '문제를 다시 뽑지 못했습니다.')} disabled={busy} className="rounded-2xl bg-[#c8ff46] py-3.5 font-extrabold text-[#0b1020]">수락</button></div></div></div>}

          {showSurrenderConfirm && !match.winner && <div className="fixed inset-0 z-20 grid place-items-center bg-[#070b15]/80 p-5 backdrop-blur-md"><div role="alertdialog" aria-modal="true" aria-labelledby="surrender-title" className="w-full max-w-md rounded-[2rem] border border-red-400/20 bg-[#11182b] p-8 text-center shadow-2xl"><p className="font-mono text-xs tracking-[.2em] text-red-400">SURRENDER</p><h2 id="surrender-title" className="mt-3 text-2xl font-black">정말 항복할까요?</h2><p className="mt-3 text-sm text-slate-400">즉시 상대의 승리로 기록되며 되돌릴 수 없습니다.</p><div className="mt-7 grid grid-cols-2 gap-3"><button onClick={() => setShowSurrenderConfirm(false)} disabled={busy} className="rounded-2xl border border-white/10 py-3.5 font-bold text-slate-300">계속 풀기</button><button onClick={() => matchAction('surrender', '항복 처리에 실패했습니다.')} disabled={busy} className="rounded-2xl bg-red-500 py-3.5 font-extrabold text-white">항복하기</button></div></div></div>}

          {outcome && <div className="fixed inset-0 z-20 grid place-items-center bg-[#070b15]/85 p-5 backdrop-blur-md"><div className="w-full max-w-lg rounded-[2rem] border border-white/10 bg-[#11182b] p-9 text-center shadow-2xl">
            <p className="font-mono text-xs tracking-[.3em] text-slate-500">MATCH COMPLETE</p>
            <h2 className={`mt-5 text-6xl font-black tracking-[-.06em] ${outcome.win ? 'text-[#c8ff46]' : 'text-white'}`}>{outcome.title}</h2>
            <p className="mt-4 text-slate-400">{outcome.sub}</p>
            {match.result?.rated
              ? <p className="mt-4 text-sm text-slate-300">듀얼 레이팅 <b className={match.result.delta >= 0 ? 'text-[#c8ff46]' : 'text-[#ff5667]'}>{match.result.delta >= 0 ? '+' : ''}{match.result.delta}</b> → <b>{match.result.ratingAfter}</b> <span className="text-slate-500">(판돈 ×{match.you.stake.toFixed(2)})</span></p>
              : <p className="mt-4 text-sm text-slate-500">{match.opponent.bot ? '봇 연습 경기는 레이팅에 반영되지 않습니다.' : '양쪽 모두 핸들 인증을 마치면 레이팅이 걸립니다.'}</p>}
            <PrimaryButton className="mt-8" onClick={() => resetSession(true)}>새 매치 시작</PrimaryButton>
            {player && <GhostButton className="mt-3" onClick={() => { setProfileHandle(player.handle); setView('profile'); }}>내 전적 보기</GhostButton>}
          </div></div>}
        </section>
      )}
    </main>
  );
}

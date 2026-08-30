import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/http';
import { normalizeStatementLanguages, pickProblem, StatementLanguage } from '@/lib/atcoder';
import { challengeExpiry, findAsyncMatch, findChallenge, newChallengeCode, resolveAsyncMatch } from '@/lib/challenge';
import { stakeFor } from '@/lib/elo';
import { isValidHandle } from '@/lib/identity';
import { ensureTables, finishMatch, isVerified, publicMatch, upsertPlayer } from '@/lib/match-db';

// pg needs the Node runtime, and every handler reads live request state.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const badRequest = (message: string) => NextResponse.json({ error: message }, { status: 400 });
const notFound = () => NextResponse.json({ error: '도전장을 찾을 수 없거나 만료되었습니다.' }, { status: 404 });

type ChallengeBody = {
  action?: string; code?: string; token?: string; handle?: string;
  rating?: number; pick?: number; languages?: string[]; identity?: string;
};

function readPlayer(body: ChallengeBody) {
  const handle = body.handle?.trim() ?? '';
  const pick = Number(body.pick);
  if (!body.token || !isValidHandle(handle) || !Number.isFinite(pick)) return null;
  return {
    token: body.token,
    handle,
    identity: body.identity?.trim() ?? '',
    rating: Number.isFinite(body.rating) ? Number(body.rating) : 0,
    pick: Math.max(100, Math.min(3600, Math.round(pick / 100) * 100)),
    languages: normalizeStatementLanguages(body.languages),
  };
}

async function describe(code: string, token: string) {
  const challenge = await findChallenge(code);
  if (!challenge) return null;
  const row = challenge.match_id ? await findAsyncMatch(challenge.code) : null;
  const resolved = row ? await resolveAsyncMatch(row, Date.now()) : null;
  const mine = resolved ? resolved.p1_token === token || resolved.p2_token === token : challenge.host_token === token;
  return {
    challenge: {
      code: challenge.code, host: challenge.host_handle, hostRating: challenge.host_rating,
      pick: challenge.pick, languages: normalizeStatementLanguages(challenge.languages),
      accepted: Boolean(challenge.match_id), expiresAt: challenge.expires_at, mine,
      isHost: challenge.host_token === token,
    },
    match: resolved && mine ? await publicMatch(resolved, token) : null,
  };
}

async function handleGet(request: NextRequest) {
  await ensureTables();
  const code = request.nextUrl.searchParams.get('code')?.trim().toUpperCase() ?? '';
  const token = request.nextUrl.searchParams.get('token') ?? '';
  if (code) {
    const payload = await describe(code, token);
    return payload ? NextResponse.json(payload) : notFound();
  }
  if (!token) return badRequest('잘못된 요청입니다.');
  // Every async duel this browser is part of, newest first.
  const rows = await db.prepare(`SELECT m.code, m.p1_handle, m.p2_handle, m.status, m.winner, m.expires_at, m.started_at,
      m.p1_token, m.problem_title, m.problem_rating
    FROM matches m WHERE m.mode = 'async' AND (m.p1_token = ? OR m.p2_token = ?) ORDER BY m.started_at DESC LIMIT 20`)
    .bind(token, token).all<{
      code: string; p1_handle: string; p2_handle: string; status: string; winner: string | null;
      expires_at: number | null; started_at: number; p1_token: string; problem_title: string; problem_rating: number;
    }>();
  const open = await db.prepare('SELECT code, pick, expires_at FROM challenges WHERE host_token = ? AND match_id IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 10')
    .bind(token, Date.now()).all<{ code: string; pick: number; expires_at: number }>();
  return NextResponse.json({
    open: open.results,
    duels: rows.results.map((row) => ({
      code: row.code, opponent: row.p1_token === token ? row.p2_handle : row.p1_handle,
      status: row.status, winner: row.winner, expiresAt: row.expires_at,
      problem: { title: row.problem_title, rating: row.problem_rating },
    })),
  });
}

async function handlePost(request: NextRequest) {
  await ensureTables();
  const body = await request.json() as ChallengeBody;
  const now = Date.now();

  if (body.action === 'create') {
    const host = readPlayer(body);
    if (!host) return badRequest('잘못된 요청입니다.');
    await db.prepare('DELETE FROM challenges WHERE match_id IS NULL AND expires_at < ?').bind(now).run();
    await upsertPlayer(host.handle, host.rating);
    const code = await newChallengeCode();
    await db.prepare(`INSERT INTO challenges(code, host_handle, host_rating, host_identity, host_token, pick, languages, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(code, host.handle, host.rating, host.identity, host.token, host.pick, host.languages.join(','), now, challengeExpiry(now)).run();
    return NextResponse.json(await describe(code, host.token));
  }

  if (body.action === 'accept') {
    const guest = readPlayer(body);
    const code = body.code?.trim().toUpperCase() ?? '';
    if (!guest || !code) return badRequest('잘못된 요청입니다.');
    const challenge = await findChallenge(code);
    if (!challenge || challenge.expires_at < now) return notFound();
    if (challenge.match_id) return NextResponse.json(await describe(code, guest.token));
    if (challenge.host_handle === guest.handle) return badRequest('자기 자신에게는 도전할 수 없습니다.');
    const common = normalizeStatementLanguages(challenge.languages).filter((item) => guest.languages.includes(item));
    if (!common.length) return badRequest('호스트와 읽을 수 있는 지문 언어가 겹치지 않습니다.');
    const problemLanguage = common[Math.floor(Math.random() * common.length)] as StatementLanguage;
    const low = Math.min(challenge.pick, guest.pick); const high = Math.max(challenge.pick, guest.pick);
    const problem = await pickProblem([challenge.host_handle, guest.handle], low, high, problemLanguage);
    const [hostVerified, guestVerified] = await Promise.all([
      isVerified(challenge.host_handle, challenge.host_identity),
      isVerified(guest.handle, guest.identity),
    ]);
    await upsertPlayer(guest.handle, guest.rating);
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO matches(id,p1_token,p2_token,p1_handle,p2_handle,p1_rating,p2_rating,p1_language,p2_language,
        p1_pick,p2_pick,problem_id,problem_title,problem_rating,problem_language,contest_id,started_at,p1_last_seen,p2_last_seen,
        mode,code,expires_at,rated,p1_identity,p2_identity,p1_stake,p2_stake,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,'async',?,?,?,?,?,?,?,'playing')`)
        .bind(id, challenge.host_token, guest.token, challenge.host_handle, guest.handle, challenge.host_rating, guest.rating,
          challenge.languages, guest.languages.join(','), challenge.pick, guest.pick, problem.id, problem.title,
          problem.difficulty, problem.language, problem.contest_id, now, code, challengeExpiry(now),
          hostVerified && guestVerified ? 1 : 0, challenge.host_identity, guest.identity,
          stakeFor(challenge.pick, challenge.host_rating), stakeFor(guest.pick, guest.rating)),
      db.prepare('UPDATE challenges SET match_id = ?, expires_at = ? WHERE code = ?').bind(id, challengeExpiry(now), code),
    ]);
    return NextResponse.json(await describe(code, guest.token));
  }

  const code = body.code?.trim().toUpperCase() ?? '';
  const token = body.token ?? '';
  if (!code || !token) return badRequest('잘못된 요청입니다.');
  const row = await findAsyncMatch(code);
  if (!row || (row.p1_token !== token && row.p2_token !== token)) return notFound();
  const side = row.p1_token === token ? 'p1' : 'p2';

  if (body.action === 'start') {
    if (row.status !== 'playing') return NextResponse.json(await describe(code, token));
    if (!(side === 'p1' ? row.p1_started_at : row.p2_started_at)) {
      await db.prepare(`UPDATE matches SET ${side}_started_at = ? WHERE id = ? AND ${side}_started_at IS NULL`).bind(now, row.id).run();
    }
    return NextResponse.json(await describe(code, token));
  }

  if (body.action === 'giveup') {
    if (row.status === 'playing') {
      // Conceding is immediate, exactly like surrendering a live match.
      await db.prepare(`UPDATE matches SET ${side}_started_at = COALESCE(${side}_started_at, ?), ${side}_done = 1 WHERE id = ?`).bind(now, row.id).run();
      await finishMatch(row, side === 'p1' ? row.p2_handle : row.p1_handle, now);
    }
    return NextResponse.json(await describe(code, token));
  }
  return badRequest('지원하지 않는 요청입니다.');
}

export const GET = (request: NextRequest) => guard(() => handleGet(request));

export const POST = (request: NextRequest) => guard(() => handlePost(request));

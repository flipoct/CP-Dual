import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/http';
import { acceptedSince, botSolveSeconds, normalizeStatementLanguages, pickProblem, StatementLanguage } from '@/lib/atcoder';
import { stakeFor } from '@/lib/elo';
import { isValidHandle } from '@/lib/identity';
import {
  empiricalBotSolveSeconds, ensureTables, finishMatch, FORFEIT_AFTER_MS, isVerified,
  MatchRow, publicMatch, recordSolveSample, upsertPlayer,
} from '@/lib/match-db';

// pg needs the Node runtime, and every handler reads live request state.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const badRequest = (message: string) => NextResponse.json({ error: message }, { status: 400 });

/** Async duels are addressed by their own code, so they never shadow the live match slot. */
async function findMatch(token: string) {
  return db.prepare("SELECT * FROM matches WHERE (p1_token = ? OR p2_token = ?) AND mode != 'async' ORDER BY started_at DESC LIMIT 1")
    .bind(token, token).first<MatchRow>();
}

type JoinBody = {
  action?: string; token?: string; handle?: string; rating?: number;
  languages?: string[]; pick?: number; matchId?: string; identity?: string;
};

function readJoin(body: JoinBody) {
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

async function handleGet(request: NextRequest) {
  await ensureTables();
  const token = request.nextUrl.searchParams.get('token') ?? '';
  const row = await findMatch(token);
  if (!row) return NextResponse.json({ status: 'searching' });
  const now = Date.now();
  const isP1 = row.p1_token === token;
  if (row.p1_last_seen === 0 && row.p2_last_seen === 0) {
    await db.prepare('UPDATE matches SET p1_last_seen = ?, p2_last_seen = ? WHERE id = ?').bind(now, now, row.id).run();
    row.p1_last_seen = now; row.p2_last_seen = now;
  } else {
    await db.prepare(`UPDATE matches SET ${isP1 ? 'p1_last_seen' : 'p2_last_seen'} = ? WHERE id = ?`).bind(now, row.id).run();
    if (isP1) row.p1_last_seen = now; else row.p2_last_seen = now;
  }
  if (row.status === 'playing') {
    const [p1Accepted, p2Accepted] = await Promise.all([
      acceptedSince(row.p1_handle, row.problem_id, row.p1_started_at ?? row.started_at),
      row.p2_token ? acceptedSince(row.p2_handle, row.problem_id, row.p2_started_at ?? row.started_at) : Promise.resolve(null),
    ]);
    if (p1Accepted) row.p1_solved_at = p1Accepted.at;
    if (p2Accepted) row.p2_solved_at = p2Accepted.at;
    if (p1Accepted || p2Accepted) {
      await db.prepare('UPDATE matches SET p1_solved_at = COALESCE(p1_solved_at, ?), p2_solved_at = COALESCE(p2_solved_at, ?) WHERE id = ?')
        .bind(p1Accepted?.at ?? null, p2Accepted?.at ?? null, row.id).run();
    }
    let winner: string | null = null;
    if (p1Accepted || p2Accepted) {
      if (p1Accepted && p2Accepted) {
        // AtCoder only exposes second granularity, so break exact ties on submission id.
        const diff = p1Accepted.at - p2Accepted.at || p1Accepted.id - p2Accepted.id;
        winner = diff === 0 ? 'draw' : diff < 0 ? row.p1_handle : row.p2_handle;
      } else winner = p1Accepted ? row.p1_handle : row.p2_handle;
    }
    else if (!row.p2_token && row.bot_finish_at && now >= row.bot_finish_at) winner = row.p2_handle;
    else if (row.p2_token) {
      const opponentLastSeen = isP1 ? row.p2_last_seen : row.p1_last_seen;
      if (now - opponentLastSeen >= FORFEIT_AFTER_MS) winner = isP1 ? row.p1_handle : row.p2_handle;
    }
    if (winner) {
      const settled = await finishMatch(row, winner, now);
      if (settled) {
        if (p1Accepted) await recordSolveSample(row, 'p1', p1Accepted.at);
        if (p2Accepted) await recordSolveSample(row, 'p2', p2Accepted.at);
      }
    }
  }
  return NextResponse.json({ status: 'matched', match: await publicMatch(row, token) });
}

async function handleDelete(request: NextRequest) {
  await ensureTables();
  const token = request.nextUrl.searchParams.get('token') ?? '';
  await db.prepare('DELETE FROM queue WHERE token = ?').bind(token).run();
  return NextResponse.json({ ok: true });
}

async function handlePost(request: NextRequest) {
  await ensureTables();
  const body = await request.json() as JoinBody;
  const now = Date.now();

  if (body.action === 'join') {
    const join = readJoin(body);
    if (!join) return badRequest('잘못된 요청입니다.');
    const existing = await findMatch(join.token);
    if (existing) return NextResponse.json({ status: 'matched', match: await publicMatch(existing, join.token) });
    const serializedLanguages = join.languages.join(',');
    const verified = await isVerified(join.handle, join.identity);
    await upsertPlayer(join.handle, join.rating);
    await db.prepare('DELETE FROM queue WHERE joined_at < ?').bind(now - 120_000).run();
    const queued = await db.prepare('SELECT * FROM queue WHERE token != ? AND handle != ? ORDER BY joined_at ASC LIMIT 50')
      .bind(join.token, join.handle)
      .all<{ token: string; handle: string; rating: number; language: string; pick: number; identity: string | null }>();
    const opponent = queued.results.find((candidate) => normalizeStatementLanguages(candidate.language).some((item) => join.languages.includes(item)));
    if (!opponent) {
      await db.prepare(`INSERT INTO queue(token, handle, rating, language, pick, joined_at, identity) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET handle = EXCLUDED.handle, rating = EXCLUDED.rating, language = EXCLUDED.language,
          pick = EXCLUDED.pick, joined_at = EXCLUDED.joined_at, identity = EXCLUDED.identity`)
        .bind(join.token, join.handle, join.rating, serializedLanguages, join.pick, now, join.identity).run();
      return NextResponse.json({ status: 'searching' });
    }
    const low = Math.min(opponent.pick, join.pick); const high = Math.max(opponent.pick, join.pick);
    const commonLanguages = normalizeStatementLanguages(opponent.language).filter((item) => join.languages.includes(item));
    const problemLanguage = commonLanguages[Math.floor(Math.random() * commonLanguages.length)] as StatementLanguage;
    const problem = await pickProblem([opponent.handle, join.handle], low, high, problemLanguage);
    const opponentVerified = await isVerified(opponent.handle, opponent.identity ?? '');
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare('DELETE FROM queue WHERE token IN (?, ?)').bind(opponent.token, join.token),
      db.prepare(`INSERT INTO matches(id,p1_token,p2_token,p1_handle,p2_handle,p1_rating,p2_rating,p1_language,p2_language,
        p1_pick,p2_pick,problem_id,problem_title,problem_rating,problem_language,contest_id,started_at,p1_last_seen,p2_last_seen,
        mode,rated,p1_identity,p2_identity,p1_stake,p2_stake,p1_started_at,p2_started_at,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'live',?,?,?,?,?,?,?,'playing')`)
        .bind(id, opponent.token, join.token, opponent.handle, join.handle, opponent.rating, join.rating,
          opponent.language, serializedLanguages, opponent.pick, join.pick, problem.id, problem.title, problem.difficulty,
          problem.language, problem.contest_id, now, now, now,
          verified && opponentVerified ? 1 : 0, opponent.identity ?? '', join.identity,
          stakeFor(opponent.pick, opponent.rating), stakeFor(join.pick, join.rating), now, now),
    ]);
    const row = await findMatch(join.token);
    return NextResponse.json({ status: 'matched', match: await publicMatch(row!, join.token) });
  }

  if (body.action === 'bot') {
    const join = readJoin(body);
    if (!join) return badRequest('잘못된 요청입니다.');
    const existing = await findMatch(join.token);
    if (existing) return NextResponse.json({ status: 'matched', match: await publicMatch(existing, join.token) });
    const serializedLanguages = join.languages.join(',');
    const botPick = Math.max(100, Math.min(3600, join.pick + (Math.floor(Math.random() * 5) - 2) * 100));
    const botRating = Math.max(0, join.rating);
    const low = Math.min(join.pick, botPick); const high = Math.max(join.pick, botPick);
    const problemLanguage = join.languages[Math.floor(Math.random() * join.languages.length)];
    const problem = await pickProblem([join.handle], low, high, problemLanguage);
    await upsertPlayer(join.handle, join.rating);
    const id = crypto.randomUUID();
    const solveSeconds = await empiricalBotSolveSeconds(problem.difficulty, botRating, () => botSolveSeconds(problem.difficulty, botRating));
    const finishAt = now + solveSeconds * 1000;
    await db.batch([
      db.prepare('DELETE FROM queue WHERE token = ?').bind(join.token),
      db.prepare(`INSERT INTO matches(id,p1_token,p2_token,p1_handle,p2_handle,p1_rating,p2_rating,p1_language,p2_language,
        p1_pick,p2_pick,problem_id,problem_title,problem_rating,problem_language,contest_id,started_at,p1_last_seen,p2_last_seen,
        bot_finish_at,mode,rated,p1_identity,p1_stake,p2_stake,p1_started_at,p2_started_at,status)
        VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'bot',0,?,?,?,?,?,'playing')`)
        .bind(id, join.token, join.handle, `DualBot ${botRating}`, join.rating, botRating, serializedLanguages, serializedLanguages,
          join.pick, botPick, problem.id, problem.title, problem.difficulty, problem.language, problem.contest_id, now, now, now,
          finishAt, join.identity, stakeFor(join.pick, join.rating), 1, now, now),
    ]);
    const row = await findMatch(join.token);
    return NextResponse.json({ status: 'matched', match: await publicMatch(row!, join.token) });
  }

  if (body.action === 'reroll' && body.token && body.matchId) {
    const token = body.token;
    const row = await db.prepare('SELECT * FROM matches WHERE id = ?').bind(body.matchId).first<MatchRow>();
    if (!row || (row.p1_token !== token && row.p2_token !== token)) return NextResponse.json({ error: '매치를 찾을 수 없습니다.' }, { status: 404 });
    const column = row.p1_token === token ? 'p1_reroll' : 'p2_reroll';
    await db.prepare(`UPDATE matches SET ${column} = 1 WHERE id = ?`).bind(row.id).run();
    if (!row.p2_token || (column === 'p1_reroll' ? row.p2_reroll : row.p1_reroll)) {
      const commonLanguages = normalizeStatementLanguages(row.p1_language).filter((item) => normalizeStatementLanguages(row.p2_language).includes(item));
      const problemLanguage = (commonLanguages[Math.floor(Math.random() * commonLanguages.length)] ?? 'ja') as StatementLanguage;
      const problem = await pickProblem([row.p1_handle, ...(row.p2_token ? [row.p2_handle] : [])],
        Math.min(row.p1_pick, row.p2_pick), Math.max(row.p1_pick, row.p2_pick), problemLanguage, row.problem_id);
      const solveSeconds = row.p2_token ? null : await empiricalBotSolveSeconds(problem.difficulty, row.p2_rating, () => botSolveSeconds(problem.difficulty, row.p2_rating));
      const finishAt = solveSeconds === null ? null : now + solveSeconds * 1000;
      await db.prepare(`UPDATE matches SET problem_id=?,problem_title=?,problem_rating=?,problem_language=?,contest_id=?,
        started_at=?,p1_last_seen=?,p2_last_seen=?,bot_finish_at=?,p1_reroll=0,p2_reroll=0,winner=NULL,
        p1_started_at=?,p2_started_at=?,p1_solved_at=NULL,p2_solved_at=NULL,status='playing' WHERE id=?`)
        .bind(problem.id, problem.title, problem.difficulty, problem.language, problem.contest_id, now, now, now, finishAt, now, now, row.id).run();
    }
    const updated = await findMatch(token);
    return NextResponse.json({ status: 'matched', match: await publicMatch(updated!, token) });
  }

  if (body.action === 'reroll_decline' && body.token && body.matchId) {
    const token = body.token;
    const row = await db.prepare('SELECT * FROM matches WHERE id = ?').bind(body.matchId).first<MatchRow>();
    if (!row || (row.p1_token !== token && row.p2_token !== token)) return NextResponse.json({ error: '매치를 찾을 수 없습니다.' }, { status: 404 });
    await db.prepare('UPDATE matches SET p1_reroll = 0, p2_reroll = 0 WHERE id = ?').bind(row.id).run();
    const updated = await findMatch(token);
    return NextResponse.json({ status: 'matched', match: await publicMatch(updated!, token) });
  }

  if (body.action === 'surrender' && body.token && body.matchId) {
    const token = body.token;
    const row = await db.prepare('SELECT * FROM matches WHERE id = ?').bind(body.matchId).first<MatchRow>();
    if (!row || (row.p1_token !== token && row.p2_token !== token)) return NextResponse.json({ error: '매치를 찾을 수 없습니다.' }, { status: 404 });
    if (row.status === 'playing') await finishMatch(row, row.p1_token === token ? row.p2_handle : row.p1_handle, now);
    const updated = await findMatch(token);
    return NextResponse.json({ status: 'matched', match: await publicMatch(updated!, token) });
  }
  return badRequest('지원하지 않는 요청입니다.');
}

export const GET = (request: NextRequest) => guard(() => handleGet(request));

export const DELETE = (request: NextRequest) => guard(() => handleDelete(request));

export const POST = (request: NextRequest) => guard(() => handlePost(request));

import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/http';
import { isValidHandle } from '@/lib/identity';
import { db } from '@/lib/db';
import { ensureTables, upsertPlayer } from '@/lib/match-db';
import {
  buildProblemSet, buildReport, findVirtual, latestVirtual, MAX_PROBLEMS, MIN_PROBLEMS,
  parseProblems, pendingContests, prepareNext, readAttempts, VirtualRow,
} from '@/lib/virtual-contest';

// Ingesting a contest fans out to dozens of AtCoder requests.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** How long a finished result keeps re-checking for late-indexed submissions. */
const RESULT_SETTLE_MS = 10 * 60 * 1000;

const badRequest = (message: string) => NextResponse.json({ error: message }, { status: 400 });
const notFound = () => NextResponse.json({ error: '가상 대회를 찾을 수 없습니다.' }, { status: 404 });

type Body = {
  action?: string; id?: string; token?: string; handle?: string; identity?: string;
  rating?: number; low?: number; high?: number; count?: number; durationMinutes?: number;
};

async function view(row: VirtualRow) {
  const problems = parseProblems(row);
  const now = Date.now();
  const running = Boolean(row.status === 'running' && row.started_at);
  const endsAt = row.started_at ? row.started_at + row.duration_seconds * 1000 : null;
  const expired = Boolean(running && endsAt && now >= endsAt);
  // AtCoder Problems indexes submissions minutes after the fact, so a result that
  // has just been frozen keeps being re-derived until the crawler has caught up.
  const settling = Boolean(row.status === 'finished' && row.finished_at && now - row.finished_at < RESULT_SETTLE_MS);
  const cutoff = row.status === 'finished' ? (row.finished_at ?? now) : expired && endsAt ? endsAt : now;

  let report = row.result ? JSON.parse(row.result) : null;
  if (running || settling) {
    const attempts = await readAttempts(row, problems, cutoff);
    const elapsed = Math.max(0, Math.round((cutoff - (row.started_at ?? cutoff)) / 1000));
    report = await buildReport(row, attempts, elapsed);
    const finished = expired || attempts.length === problems.length;
    if (running && finished) {
      await db.prepare("UPDATE virtual_contests SET status = 'finished', finished_at = ?, result = ? WHERE id = ? AND status = 'running'")
        .bind(cutoff, JSON.stringify(report), row.id).run();
      row.status = 'finished';
      row.finished_at = cutoff;
    } else if (settling) {
      await db.prepare("UPDATE virtual_contests SET result = ? WHERE id = ? AND status = 'finished'")
        .bind(JSON.stringify(report), row.id).run();
    }
  }

  return {
    id: row.id,
    handle: row.handle,
    rating: row.rating,
    range: [row.low, row.high],
    durationSeconds: row.duration_seconds,
    status: row.status,
    startedAt: row.started_at,
    endsAt,
    // Problem titles stay hidden until the clock starts.
    problems: row.status === 'preparing' || row.status === 'ready'
      ? problems.map((problem) => ({ points: problem.points, difficulty: problem.difficulty }))
      : problems.map((problem) => ({
        ...problem,
        url: `https://atcoder.jp/contests/${problem.contestId}/tasks/${problem.id}`,
      })),
    remainingContests: row.status === 'preparing' ? (await pendingContests(problems)).length : 0,
    // Recomputed after the block above, so the request that ends a contest already
    // tells the client to keep polling through the settle window.
    settling: Boolean(row.status === 'finished' && row.finished_at && Date.now() - row.finished_at < RESULT_SETTLE_MS),
    report,
  };
}

async function handleGet(request: NextRequest) {
  await ensureTables();
  const token = request.nextUrl.searchParams.get('token') ?? '';
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!token) return badRequest('잘못된 요청입니다.');
  const row = id ? await findVirtual(id, token) : await latestVirtual(token);
  if (!row) return NextResponse.json({ contest: null });
  return NextResponse.json({ contest: await view(row) });
}

async function handlePost(request: NextRequest) {
  await ensureTables();
  const body = await request.json() as Body;
  const token = body.token ?? '';
  if (!token) return badRequest('잘못된 요청입니다.');

  if (body.action === 'create') {
    const handle = body.handle?.trim() ?? '';
    if (!isValidHandle(handle)) return badRequest('닉네임 형식을 확인해주세요.');
    const low = Math.max(0, Math.min(3600, Math.round(Number(body.low) / 100) * 100));
    const high = Math.max(low + 100, Math.min(3600, Math.round(Number(body.high) / 100) * 100));
    const count = Math.max(MIN_PROBLEMS, Math.min(MAX_PROBLEMS, Math.round(Number(body.count) || 5)));
    const durationSeconds = Math.max(20, Math.min(300, Math.round(Number(body.durationMinutes) || 100))) * 60;
    const rating = Number.isFinite(body.rating) ? Number(body.rating) : 0;

    const problems = await buildProblemSet(handle, low, high, count);
    await upsertPlayer(handle, rating);
    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO virtual_contests(id, token, identity, handle, rating, low, high, duration_seconds,
      problems, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,'preparing',?)`)
      .bind(id, token, body.identity?.trim() ?? '', handle, rating, low, high, durationSeconds,
        JSON.stringify(problems), Date.now()).run();
    const row = await findVirtual(id, token);
    return NextResponse.json({ contest: await view(row!) });
  }

  const id = body.id ?? '';
  if (!id) return badRequest('잘못된 요청입니다.');
  const row = await findVirtual(id, token);
  if (!row) return notFound();

  if (body.action === 'prepare') {
    const progress = await prepareNext(row);
    return NextResponse.json({ contest: await view(row), progress });
  }

  if (body.action === 'start') {
    if (row.status === 'preparing') return badRequest('아직 문제 데이터를 준비하고 있습니다.');
    if (row.status === 'ready') {
      const now = Date.now();
      await db.prepare("UPDATE virtual_contests SET status = 'running', started_at = ? WHERE id = ? AND status = 'ready'")
        .bind(now, row.id).run();
      row.status = 'running';
      row.started_at = now;
    }
    return NextResponse.json({ contest: await view(row) });
  }

  if (body.action === 'finish') {
    if (row.status === 'running' && row.started_at) {
      const now = Date.now();
      const attempts = await readAttempts(row, parseProblems(row), now);
      const report = await buildReport(row, attempts, Math.round((now - row.started_at) / 1000));
      await db.prepare("UPDATE virtual_contests SET status = 'finished', finished_at = ?, result = ? WHERE id = ? AND status = 'running'")
        .bind(now, JSON.stringify(report), row.id).run();
      row.status = 'finished';
      row.finished_at = now;
      row.result = JSON.stringify(report);
    }
    return NextResponse.json({ contest: await view(row) });
  }

  return badRequest('지원하지 않는 요청입니다.');
}

export const GET = (request: NextRequest) => guard(() => handleGet(request));
export const POST = (request: NextRequest) => guard(() => handlePost(request));

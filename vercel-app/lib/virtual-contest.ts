import { fetchSubmissions, getContestParticipants, getProblemIndex, getSolvedSet, PoolProblem } from '@/lib/atcoder';
import { ingestContest, isContestIngested, loadSamples, problemPerformance } from '@/lib/contest-stats';
import { db } from '@/lib/db';
import {
  Attempt, pointsFor, scoreOf, simulateField, solveProbability, standingFor, VirtualProblem,
} from '@/lib/performance';

export const MIN_PROBLEMS = 3;
export const MAX_PROBLEMS = 8;
export const FIELD_SIZE = 1200;
/** A real ABC's entrant ratings stand in for the field of a custom contest. */
const FIELD_SOURCE_CONTEST = 'abc300';
const FIELD_CACHE_KEY = 'virtual-field-ratings';
const FIELD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type VirtualRow = {
  id: string; token: string; identity: string; handle: string; rating: number;
  low: number; high: number; duration_seconds: number; problems: string;
  status: string; created_at: number; started_at: number | null; finished_at: number | null; result: string | null;
};

export type VirtualProblemRef = { id: string; contestId: string; title: string; difficulty: number; points: number };

export async function getFieldRatings() {
  const cached = await db.prepare('SELECT value, updated_at FROM app_cache WHERE key = ?')
    .bind(FIELD_CACHE_KEY).first<{ value: string; updated_at: number }>();
  if (cached && Date.now() - cached.updated_at < FIELD_TTL_MS) return JSON.parse(cached.value) as number[];
  const participants = await getContestParticipants(FIELD_SOURCE_CONTEST);
  const step = Math.max(1, Math.floor(participants.length / FIELD_SIZE));
  const ratings = participants.filter((_, index) => index % step === 0).map((entry) => entry.rating);
  await db.prepare('INSERT INTO app_cache(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at')
    .bind(FIELD_CACHE_KEY, JSON.stringify(ratings), Date.now()).run();
  return ratings;
}

/**
 * Picks problems spread evenly across the chosen rating range, skipping anything
 * the player has already solved so the contest is genuinely unseen.
 */
export async function buildProblemSet(handle: string, low: number, high: number, count: number) {
  const [index, solved] = await Promise.all([getProblemIndex(), getSolvedSet(handle)]);
  const pool = [...index.values()].filter((problem) =>
    problem.difficulty >= low && problem.difficulty <= high && !solved.has(problem.id));
  if (pool.length < count) throw new Error('선택한 난이도 범위에 아직 풀지 않은 문제가 충분하지 않습니다.');

  const chosen: PoolProblem[] = [];
  const used = new Set<string>();
  for (let slot = 0; slot < count; slot += 1) {
    // Aim at evenly spaced difficulties, then take the closest problem still free.
    const target = count === 1 ? (low + high) / 2 : low + (high - low) * (slot / (count - 1));
    const candidates = pool.filter((problem) => !used.has(problem.id))
      .sort((a, b) => Math.abs(a.difficulty - target) - Math.abs(b.difficulty - target))
      .slice(0, 12);
    if (!candidates.length) throw new Error('문제를 충분히 고르지 못했습니다.');
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    used.add(picked.id);
    chosen.push(picked);
  }
  chosen.sort((a, b) => a.difficulty - b.difficulty);
  return chosen.map((problem, order) => ({
    id: problem.id, contestId: problem.contest_id, title: problem.title,
    difficulty: problem.difficulty, points: pointsFor(order),
  } satisfies VirtualProblemRef));
}

export function parseProblems(row: VirtualRow) {
  return JSON.parse(row.problems) as VirtualProblemRef[];
}

/** Source contests whose solve-time samples are still missing. */
export async function pendingContests(problems: VirtualProblemRef[]) {
  const contests = [...new Set(problems.map((problem) => problem.contestId))];
  const flags = await Promise.all(contests.map(isContestIngested));
  return contests.filter((_, index) => !flags[index]);
}

/** Ingests one missing contest per call so a single request stays inside its limit. */
export async function prepareNext(row: VirtualRow) {
  const problems = parseProblems(row);
  const pending = await pendingContests(problems);
  if (!pending.length) {
    if (row.status === 'preparing') {
      await db.prepare("UPDATE virtual_contests SET status = 'ready' WHERE id = ? AND status = 'preparing'").bind(row.id).run();
      row.status = 'ready';
    }
    return { done: true, remaining: 0, ingested: null as string | null };
  }
  const target = pending[0];
  await ingestContest(target);
  const left = await pendingContests(problems);
  if (!left.length) {
    await db.prepare("UPDATE virtual_contests SET status = 'ready' WHERE id = ? AND status = 'preparing'").bind(row.id).run();
    row.status = 'ready';
  }
  return { done: left.length === 0, remaining: left.length, ingested: target };
}

async function loadVirtualProblems(problems: VirtualProblemRef[]) {
  const [index, samples] = await Promise.all([getProblemIndex(), loadSamples(problems.map((problem) => problem.id))]);
  return problems.flatMap((problem) => {
    const pooled = index.get(problem.id);
    if (!pooled) return [];
    return [{ problem: pooled, points: problem.points, samples: samples.get(problem.id) ?? [] } satisfies VirtualProblem];
  });
}

/** The player's own attempts, read from their real AtCoder submissions. */
export async function readAttempts(row: VirtualRow, problems: VirtualProblemRef[], until: number) {
  if (!row.started_at) return [] as Attempt[];
  const submissions = await fetchSubmissions(row.handle, Math.floor(row.started_at / 1000) - 2, { fresh: true });
  if (!submissions) return [] as Attempt[];
  const ids = new Set(problems.map((problem) => problem.id));
  const within = submissions.filter((submission) =>
    ids.has(submission.problem_id) && submission.epoch_second * 1000 <= until);
  const attempts: Attempt[] = [];
  for (const problem of problems) {
    const mine = within.filter((submission) => submission.problem_id === problem.id)
      .sort((a, b) => a.epoch_second - b.epoch_second);
    const accepted = mine.find((submission) => submission.result === 'AC');
    if (!accepted) continue;
    attempts.push({
      problemId: problem.id,
      seconds: Math.max(1, Math.round((accepted.epoch_second * 1000 - row.started_at) / 1000)),
      penalties: mine.filter((submission) => submission.result !== 'AC' && submission.epoch_second < accepted.epoch_second).length,
    });
  }
  return attempts;
}

export type VirtualReport = Awaited<ReturnType<typeof buildReport>>;

export async function buildReport(row: VirtualRow, attempts: Attempt[], elapsedSeconds: number) {
  const refs = parseProblems(row);
  const [virtualProblems, field] = await Promise.all([loadVirtualProblems(refs), getFieldRatings()]);
  const rivals = simulateField(virtualProblems, field, row.duration_seconds, row.id);
  const mine = scoreOf(attempts, virtualProblems);
  const standing = standingFor(mine, rivals);
  const samples = new Map(virtualProblems.map((entry) => [entry.problem.id, entry]));

  const perProblem = refs.map((ref) => {
    const entry = samples.get(ref.id);
    const attempt = attempts.find((item) => item.problemId === ref.id);
    const solvedBy = rivals.length
      ? rivals.filter((rival) => rival.points >= ref.points).length / rivals.length
      : null;
    return {
      ...ref,
      solved: Boolean(attempt),
      seconds: attempt?.seconds ?? null,
      penalties: attempt?.penalties ?? 0,
      sampleCount: entry?.samples.length ?? 0,
      // What rating typically needs exactly this long on this problem.
      performance: attempt && entry ? problemPerformance(entry.samples, attempt.seconds) : null,
      expectedSolveRate: solvedBy,
      yourSolveChance: Math.round(solveProbability(row.rating, ref.difficulty) * 100),
    };
  });

  return {
    score: mine,
    elapsedSeconds,
    standing,
    perProblem,
    // A contest performance is only meaningful once something is solved.
    performance: mine.solved ? standing.performance : null,
  };
}

export async function findVirtual(id: string, token: string) {
  const row = await db.prepare('SELECT * FROM virtual_contests WHERE id = ? AND token = ?').bind(id, token).first<VirtualRow>();
  return row;
}

export async function latestVirtual(token: string) {
  return db.prepare('SELECT * FROM virtual_contests WHERE token = ? ORDER BY created_at DESC LIMIT 1').bind(token).first<VirtualRow>();
}

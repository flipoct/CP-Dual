import { db } from '@/lib/db';

type Problem = { id: string; contest_id: string; title: string };
type Model = { difficulty?: number; slope?: number; intercept?: number; variance?: number; discrimination?: number };
export type Submission = { id: number; epoch_second: number; problem_id: string; result: string; language: string };

export type StatementLanguage = 'en' | 'ja';

export function normalizeStatementLanguages(value: unknown): StatementLanguage[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const normalized = values.filter((item): item is StatementLanguage => item === 'en' || item === 'ja');
  return normalized.length ? [...new Set(normalized)] : ['en', 'ja'];
}

const DATA = 'https://kenkoooo.com/atcoder/resources';
const API = 'https://kenkoooo.com/atcoder/atcoder-api/v3';
const PROFILE = 'https://atcoder.jp/users';
const USER_AGENT = 'CP-Dual/1.0';
/** The AtCoder Problems dumps change at most daily; six hours is plenty fresh. */
const DUMP_CACHE = { next: { revalidate: 21_600 } } as RequestInit;

export const isBotHandle = (handle: string) => handle.startsWith('DualBot') || handle === 'CP_DUAL_BOT';

export async function getPlayer(handle: string) {
  const response = await fetch(`${PROFILE}/${encodeURIComponent(handle)}/history/json`, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error('존재하지 않는 AtCoder 닉네임입니다.');
  const history = (await response.json()) as Array<{ NewRating?: number }>;
  const rating = history.length ? history[history.length - 1].NewRating ?? 0 : 0;
  return { handle, rating, rated: history.length > 0 };
}

/** Raw profile HTML, used to read the affiliation field during handle verification. */
export async function getProfileHtml(handle: string) {
  const response = await fetch(`${PROFILE}/${encodeURIComponent(handle)}`, { headers: { 'User-Agent': USER_AGENT }, cache: 'no-store' });
  if (!response.ok) throw new Error('AtCoder 프로필을 불러오지 못했습니다.');
  return response.text();
}

export async function fetchSubmissions(handle: string, fromSecond: number, options?: { fresh?: boolean }) {
  const response = await fetch(`${API}/user/submissions?user=${encodeURIComponent(handle)}&from_second=${Math.max(0, Math.floor(fromSecond))}`,
    options?.fresh ? { cache: 'no-store' } : undefined);
  if (!response.ok) return null;
  return (await response.json()) as Submission[];
}

/**
 * Solved sets are expensive (up to eight paginated calls per handle), so they are
 * cached in D1 and refreshed incrementally from the last submission we have seen.
 */
export async function getSolvedSet(handle: string) {
  if (isBotHandle(handle)) return new Set<string>();
  const cached = await db.prepare('SELECT problem_ids, cursor FROM solved_cache WHERE handle = ?')
    .bind(handle).first<{ problem_ids: string; cursor: number }>();
  const solved = new Set<string>(cached ? (JSON.parse(cached.problem_ids) as string[]) : []);
  let cursor = cached?.cursor ?? 0;
  for (let page = 0; page < 8; page += 1) {
    const rows = await fetchSubmissions(handle, cursor);
    if (!rows) break;
    for (const row of rows) if (row.result === 'AC') solved.add(row.problem_id);
    if (rows.length) cursor = Math.max(...rows.map((row) => row.epoch_second)) + 1;
    if (rows.length < 500) break;
  }
  await db.prepare(`INSERT INTO solved_cache(handle, problem_ids, cursor, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(handle) DO UPDATE SET problem_ids = EXCLUDED.problem_ids, cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`)
    .bind(handle, JSON.stringify([...solved]), cursor, Date.now()).run();
  return solved;
}

function hasGuaranteedBilingualStatement(contestId: string) {
  const match = /^(abc|arc|agc)(\d+)$/.exec(contestId);
  if (!match) return false;
  const contestNumber = Number(match[2]);
  return match[1] === 'abc' ? contestNumber >= 100
    : match[1] === 'arc' ? contestNumber >= 100
      : contestNumber >= 50;
}

export type PoolProblem = {
  id: string; contest_id: string; title: string; difficulty: number;
  /** AtCoder Problems' fitted log-time model, used only when real samples are too sparse. */
  slope: number; intercept: number; variance: number;
};
let pool: { problems: PoolProblem[]; builtAt: number } | null = null;
const POOL_TTL_MS = 6 * 60 * 60 * 1000;

/** Trimmed, in-isolate problem index so a match never re-parses the full dumps. */
export async function getProblemPool() {
  if (pool && Date.now() - pool.builtAt < POOL_TTL_MS) return pool.problems;
  const [problemsResponse, modelsResponse] = await Promise.all([
    // Both dumps sit just under the 2MB Data Cache entry limit, so a cold instance
    // reads them from the cache instead of pulling them off kenkoooo again.
    fetch(`${DATA}/problems.json`, DUMP_CACHE),
    fetch(`${DATA}/problem-models.json`, DUMP_CACHE),
  ]);
  if (!problemsResponse.ok || !modelsResponse.ok) throw new Error('문제 데이터를 불러오지 못했습니다.');
  const problems = (await problemsResponse.json()) as Problem[];
  const models = (await modelsResponse.json()) as Record<string, Model>;
  const trimmed = problems.flatMap((problem) => {
    if (!problem.id.startsWith(`${problem.contest_id}_`)) return [];
    if (!hasGuaranteedBilingualStatement(problem.contest_id)) return [];
    const model = models[problem.id];
    if (model?.difficulty === undefined) return [];
    return [{
      id: problem.id, contest_id: problem.contest_id, title: problem.title, difficulty: Math.round(model.difficulty),
      slope: model.slope ?? -0.0005, intercept: model.intercept ?? 7, variance: model.variance ?? 0.35,
    }];
  });
  pool = { problems: trimmed, builtAt: Date.now() };
  return trimmed;
}

export async function pickProblem(handles: string[], low: number, high: number, language: StatementLanguage, exclude?: string) {
  const [problems, ...solvedSets] = await Promise.all([getProblemPool(), ...handles.map(getSolvedSet)]);
  const candidates = problems.filter((problem) => problem.difficulty >= low && problem.difficulty <= high
    && problem.id !== exclude && solvedSets.every((set) => !set.has(problem.id)));
  if (!candidates.length) throw new Error('선택한 공식 지문이 있고 두 플레이어가 풀지 않은 문제가 해당 범위에 없습니다.');
  const problem = candidates[Math.floor(Math.random() * candidates.length)];
  return { ...problem, language };
}

export type AcceptedSubmission = { at: number; id: number; language: string };

/** First AC for the problem after `since`, plus the attempts that led up to it. */
export async function acceptedSince(handle: string, problemId: string, since: number) {
  if (isBotHandle(handle)) return null;
  // Match timestamps are stored in milliseconds, while AtCoder Problems expects
  // Unix seconds. Keep a tiny cushion for submissions on the start boundary.
  const rows = await fetchSubmissions(handle, Math.floor(since / 1000) - 2, { fresh: true });
  if (!rows) return null;
  const accepted = rows.filter((row) => row.problem_id === problemId && row.result === 'AC')
    .sort((a, b) => a.epoch_second - b.epoch_second || a.id - b.id)[0];
  return accepted ? { at: accepted.epoch_second * 1000, id: accepted.id, language: accepted.language } as AcceptedSubmission : null;
}

export async function hasAccepted(handle: string, problemId: string, since: number) {
  return (await acceptedSince(handle, problemId, since))?.at ?? null;
}

/** `abc300_d` becomes slot `D`. Used to profile which contest slot a player keeps losing on. */
export function contestSlot(problemId: string) {
  const suffix = problemId.split('_').pop() ?? '';
  if (/^[a-z]$/.test(suffix)) return suffix.toUpperCase();
  if (/^\d+$/.test(suffix)) return String.fromCharCode(64 + Number(suffix));
  return '?';
}

export function contestSeries(contestId: string) {
  return (/^(abc|arc|agc)/.exec(contestId)?.[1] ?? '').toUpperCase() || 'OTHER';
}

export function botSolveSeconds(difficulty: number, botRating: number) {
  // Used only while there are not enough real CP Dual solve samples.
  const ratingGap = difficulty - botRating;
  const averageMinutes = Math.max(0.75, Math.min(80, 12 * Math.pow(2.3, ratingGap / 400)));
  return Math.round(averageMinutes * 60 * (0.9 + Math.random() * 0.2));
}

/** Every problem in the duel pool, keyed by id. */
export async function getProblemIndex() {
  const problems = await getProblemPool();
  return new Map(problems.map((problem) => [problem.id, problem]));
}

export type ContestInfo = { id: string; start_epoch_second: number; duration_second: number; title: string };
let contestIndex: { map: Map<string, ContestInfo>; builtAt: number } | null = null;

export async function getContest(contestId: string) {
  if (!contestIndex || Date.now() - contestIndex.builtAt >= POOL_TTL_MS) {
    const response = await fetch(`${DATA}/contests.json`, DUMP_CACHE);
    if (!response.ok) throw new Error('콘테스트 정보를 불러오지 못했습니다.');
    const contests = (await response.json()) as ContestInfo[];
    contestIndex = { map: new Map(contests.map((contest) => [contest.id, contest])), builtAt: Date.now() };
  }
  return contestIndex.map.get(contestId) ?? null;
}

export type ContestParticipant = { handle: string; rating: number };

/**
 * Public final standings metadata for a rated contest. `standings/json` needs a
 * login, but `results/json` is open and carries every entrant's rating going in.
 */
export async function getContestParticipants(contestId: string) {
  const response = await fetch(`https://atcoder.jp/contests/${contestId}/results/json`, {
    headers: { 'User-Agent': USER_AGENT }, cache: 'no-store',
  });
  if (!response.ok) throw new Error('콘테스트 결과를 불러오지 못했습니다.');
  const rows = (await response.json()) as Array<{ IsRated: boolean; OldRating: number; UserScreenName: string }>;
  return rows.filter((row) => row.IsRated && row.OldRating > 0)
    .map((row) => ({ handle: row.UserScreenName, rating: row.OldRating } satisfies ContestParticipant));
}

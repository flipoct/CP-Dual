import { fetchSubmissions, getContest, getContestParticipants, PoolProblem } from '@/lib/atcoder';
import { db } from '@/lib/db';

/**
 * How a per-problem solve time is measured: the gap between this problem's first
 * AC and the solver's previous AC in the same contest. Two kinds of sample are
 * thrown away, because both understate or distort the real time on the problem.
 */
export const EXCLUDE_REVISIT = 'revisit';
export const EXCLUDE_TOO_FAST = 'too_fast';

/** Below this share of the band median a gap cannot be a genuine read-think-code cycle. */
export const TOO_FAST_RATIO = 0.2;
export const ABSOLUTE_FLOOR_SECONDS = 20;
/** Rating window used when comparing a sample against its peers. */
export const BAND_RADIUS = 300;
/** Fewer neighbours than this and the median is not a trustworthy yardstick. */
export const MIN_PEERS_FOR_RATIO = 5;

export const RATING_BANDS = [[0, 800], [800, 1200], [1200, 1600], [1600, 2000], [2000, 2400], [2400, 4000]] as const;
const USERS_PER_BAND = 10;

export type TimeSample = {
  problem_id: string; contest_id: string; handle: string; rating: number;
  delta_seconds: number; penalties: number; excluded: number; exclude_reason: string | null;
};

const median = (values: number[]) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;

/** Splits one contestant's in-contest submissions into per-problem gaps. */
function timelineOf(submissions: Array<{ problem_id: string; epoch_second: number; result: string }>, startedAt: number) {
  const firstAc = new Map<string, number>();
  for (const submission of submissions) {
    if (submission.result !== 'AC') continue;
    const current = firstAc.get(submission.problem_id);
    if (current === undefined || submission.epoch_second < current) firstAc.set(submission.problem_id, submission.epoch_second);
  }
  const ordered = [...firstAc.entries()].sort((a, b) => a[1] - b[1]);
  let previous = startedAt;
  return ordered.map(([problemId, acAt]) => {
    const touches = submissions.filter((submission) => submission.problem_id === problemId).map((submission) => submission.epoch_second);
    const sample = {
      problemId,
      deltaSeconds: acAt - previous,
      penalties: submissions.filter((submission) =>
        submission.problem_id === problemId && submission.result !== 'AC' && submission.epoch_second < acAt).length,
      // They had already submitted to this problem before their previous AC, so the
      // gap covers only the second sitting. The true effort is unknown either way.
      revisited: Math.min(...touches) < previous,
    };
    previous = acAt;
    return sample;
  });
}

async function fetchInBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(...await Promise.all(items.slice(index, index + size).map(run)));
  }
  return results;
}

export async function isContestIngested(contestId: string) {
  const row = await db.prepare('SELECT contest_id FROM contest_ingests WHERE contest_id = ?').bind(contestId).first();
  return Boolean(row);
}

/**
 * Samples real contestants across the rating range and stores every problem's
 * solve gaps. One pass covers the whole contest, so the cache warms quickly.
 */
export async function ingestContest(contestId: string) {
  if (await isContestIngested(contestId)) return { contestId, cached: true, samples: 0 };
  const contest = await getContest(contestId);
  if (!contest) throw new Error(`${contestId} 콘테스트 정보를 찾을 수 없습니다.`);
  const participants = await getContestParticipants(contestId);
  const endsAt = contest.start_epoch_second + contest.duration_second;

  const picks: Array<{ handle: string; rating: number }> = [];
  for (const [low, high] of RATING_BANDS) {
    const band = participants.filter((entry) => entry.rating >= low && entry.rating < high)
      .sort((a, b) => a.rating - b.rating);
    const take = Math.min(USERS_PER_BAND, band.length);
    for (let index = 0; index < take; index += 1) {
      picks.push(band[Math.floor((index + 0.5) * band.length / take)]);
    }
  }

  const collected = await fetchInBatches(picks, 6, async (entry) => {
    const submissions = await fetchSubmissions(entry.handle, contest.start_epoch_second);
    if (!submissions) return [];
    const inContest = submissions.filter((submission) =>
      submission.problem_id.startsWith(`${contestId}_`) && submission.epoch_second < endsAt);
    return timelineOf(inContest, contest.start_epoch_second).map((sample) => ({
      problem_id: sample.problemId, contest_id: contestId, handle: entry.handle, rating: entry.rating,
      delta_seconds: sample.deltaSeconds, penalties: sample.penalties,
      excluded: sample.revisited ? 1 : 0, exclude_reason: sample.revisited ? EXCLUDE_REVISIT : null,
    } satisfies TimeSample));
  });
  const samples = collected.flat();

  // The too-fast test compares each gap with peers at a similar rating on the same
  // problem, so a strong player's genuinely quick solve is never mistaken for one.
  for (const sample of samples) {
    if (sample.excluded) continue;
    const peers = samples.filter((other) => other.problem_id === sample.problem_id && !other.excluded
      && Math.abs(other.rating - sample.rating) <= BAND_RADIUS);
    // A median over two or three neighbours is too noisy to condemn a sample by,
    // so a thin peer group falls back to the absolute floor alone.
    const peerMedian = peers.length >= MIN_PEERS_FOR_RATIO ? median(peers.map((peer) => peer.delta_seconds)) : null;
    const floor = Math.max(ABSOLUTE_FLOOR_SECONDS, peerMedian === null ? 0 : peerMedian * TOO_FAST_RATIO);
    if (sample.delta_seconds < floor) { sample.excluded = 1; sample.exclude_reason = EXCLUDE_TOO_FAST; }
  }

  if (samples.length) {
    await db.batch(samples.map((sample) => db.prepare(
      `INSERT INTO problem_time_samples(problem_id, contest_id, handle, rating, delta_seconds, penalties, excluded, exclude_reason)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(problem_id, handle) DO NOTHING`)
      .bind(sample.problem_id, sample.contest_id, sample.handle, sample.rating, sample.delta_seconds,
        sample.penalties, sample.excluded, sample.exclude_reason)));
  }
  await db.prepare('INSERT INTO contest_ingests(contest_id, sampled_users, sample_count, ingested_at) VALUES (?,?,?,?) ON CONFLICT(contest_id) DO NOTHING')
    .bind(contestId, picks.length, samples.length, Date.now()).run();
  return { contestId, cached: false, samples: samples.length, excluded: samples.filter((sample) => sample.excluded).length };
}

export type ProblemSamples = { rating: number; delta_seconds: number; penalties: number };

export async function loadSamples(problemIds: string[]) {
  if (!problemIds.length) return new Map<string, ProblemSamples[]>();
  const rows = await db.prepare(
    `SELECT problem_id, rating, delta_seconds, penalties FROM problem_time_samples
     WHERE excluded = 0 AND problem_id = ANY(?)`)
    .bind(problemIds).all<{ problem_id: string } & ProblemSamples>();
  const grouped = new Map<string, ProblemSamples[]>();
  for (const row of rows.results) {
    grouped.set(row.problem_id, [...(grouped.get(row.problem_id) ?? []),
      { rating: row.rating, delta_seconds: row.delta_seconds, penalties: row.penalties }]);
  }
  return grouped;
}

/** Median solve gap per rating band, the curve every other estimate is read off. */
export function bandMedians(samples: ProblemSamples[]) {
  return RATING_BANDS.map(([low, high]) => {
    const inBand = samples.filter((sample) => sample.rating >= low && sample.rating < high);
    return { low, high, centre: (low + Math.min(high, 3200)) / 2, count: inBand.length, median: median(inBand.map((sample) => sample.delta_seconds)) };
  });
}

/** Log-normal fallback from AtCoder Problems' fitted model, for problems we have no samples for. */
export function modelledSeconds(problem: PoolProblem, rating: number) {
  return Math.max(30, Math.exp(problem.slope * rating + problem.intercept));
}

/**
 * Forces the band curve to fall as rating rises. Only unusually strong players
 * clear a problem far above their rating, so a thin low band reads faster than it
 * should; pool-adjacent-violators averages those inversions away.
 */
function isotonicDecreasing(points: Array<{ rating: number; log: number; weight: number }>) {
  const blocks = points.map((point) => ({ rating: point.rating, log: point.log, weight: point.weight }));
  for (let index = 0; index < blocks.length - 1;) {
    if (blocks[index].log >= blocks[index + 1].log) { index += 1; continue; }
    const weight = blocks[index].weight + blocks[index + 1].weight;
    const merged = (blocks[index].log * blocks[index].weight + blocks[index + 1].log * blocks[index + 1].weight) / weight;
    blocks[index] = { ...blocks[index], log: merged, weight };
    blocks[index + 1] = { ...blocks[index + 1], log: merged, weight };
    index = index > 0 ? index - 1 : 0;
  }
  return blocks;
}

/** Bands needed before the curve is worth inverting at all. */
export const MIN_CURVE_BANDS = 3;
/**
 * The slowest band must take at least this much more log-time than the fastest.
 * On a trivial problem everyone spends the same few minutes reading and typing,
 * so the curve is flat and no solve time can imply a rating.
 */
export const MIN_CURVE_LOG_RANGE = 0.35;

/**
 * The rating whose typical solver would need exactly this long — a per-problem
 * performance. Read off the band-median curve, interpolated in log-time.
 * Returns null when the samples cannot support an answer.
 */
export function problemPerformance(samples: ProblemSamples[], seconds: number) {
  const points = isotonicDecreasing(bandMedians(samples)
    .filter((band) => band.count >= 3 && band.median !== null)
    .map((band) => ({ rating: band.centre, log: Math.log(band.median as number), weight: band.count }))
    .sort((a, b) => a.rating - b.rating));
  if (points.length < MIN_CURVE_BANDS) return null;

  const first = points[0];
  const last = points[points.length - 1];
  if (first.log - last.log < MIN_CURVE_LOG_RANGE) return null;

  // Outside the ratings we actually observed there is no evidence to read, so the
  // estimate stops at the edge of the data rather than extrapolating a slope.
  const target = Math.log(Math.max(1, seconds));
  if (target >= first.log) return Math.round(first.rating);
  if (target <= last.log) return Math.round(last.rating);

  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (left.log === right.log) continue;
    if (target > left.log || target < right.log) continue;
    const ratio = (target - left.log) / (right.log - left.log);
    return Math.round(left.rating + ratio * (right.rating - left.rating));
  }
  return null;
}

import { PoolProblem } from '@/lib/atcoder';
import { BAND_RADIUS, modelledSeconds, ProblemSamples } from '@/lib/contest-stats';

/**
 * AtCoder Problems fits every problem with the same two-parameter logistic, so the
 * chance a given rating solves a problem comes free with the difficulty estimate.
 */
export const DISCRIMINATION = 0.004479398673070138;

export function solveProbability(rating: number, difficulty: number) {
  return 1 / (1 + Math.exp(-DISCRIMINATION * (rating - difficulty)));
}

/** AtCoder's own win-probability curve, base 6 rather than the usual Elo 10. */
function winProbability(mine: number, theirs: number) {
  return 1 / (1 + 6 ** ((theirs - mine) / 400));
}

/** Expected finishing position of a player of this rating against the given field. */
export function expectedRank(rating: number, field: number[]) {
  let total = 0.5;
  for (const other of field) total += winProbability(other, rating);
  return total;
}

/** The rating whose expected rank equals the rank actually achieved. */
export function performanceForRank(rank: number, field: number[]) {
  let low = 0;
  let high = 5000;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    if (expectedRank(middle, field) > rank) low = middle; else high = middle;
  }
  return Math.round((low + high) / 2);
}

/** Deterministic per-run generator so a contest's field never changes between polls. */
export function seededRandom(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws a solve time for this rating, preferring real samples from nearby ratings. */
function sampleSeconds(problem: PoolProblem, samples: ProblemSamples[], rating: number, random: () => number) {
  for (const radius of [BAND_RADIUS, BAND_RADIUS * 2, BAND_RADIUS * 4, Infinity]) {
    const nearby = samples.filter((sample) => Math.abs(sample.rating - rating) <= radius);
    if (nearby.length >= 3) {
      const picked = nearby[Math.floor(random() * nearby.length)];
      return { seconds: picked.delta_seconds, penalties: picked.penalties, modelled: false };
    }
  }
  // No usable observations: fall back to the fitted log-normal.
  const sigma = Math.sqrt(problem.variance);
  const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return { seconds: Math.max(30, modelledSeconds(problem, rating) * Math.exp(sigma * normal)), penalties: 0, modelled: true };
}

export type VirtualProblem = { problem: PoolProblem; points: number; samples: ProblemSamples[] };
export type Attempt = { problemId: string; seconds: number; penalties: number };

export const PENALTY_SECONDS = 300;

export function scoreOf(attempts: Attempt[], problems: VirtualProblem[]) {
  const points = attempts.reduce((total, attempt) =>
    total + (problems.find((entry) => entry.problem.id === attempt.problemId)?.points ?? 0), 0);
  const lastAc = attempts.reduce((latest, attempt) => Math.max(latest, attempt.seconds), 0);
  const penalty = attempts.reduce((total, attempt) => total + attempt.penalties, 0) * PENALTY_SECONDS;
  return { points, timeSeconds: lastAc + penalty, solved: attempts.length };
}

/** AtCoder ordering: more points first, then the earlier finishing time. */
function ranksBetter(a: { points: number; timeSeconds: number }, b: { points: number; timeSeconds: number }) {
  return a.points !== b.points ? a.points - b.points > 0 : a.timeSeconds < b.timeSeconds;
}

export type Rival = { rating: number; points: number; timeSeconds: number; solved: number };

/**
 * Runs the whole virtual field through the contest: each rival solves a problem
 * with its IRT probability, spends a real sampled amount of time on it, and stops
 * when the clock runs out. Difficulty order stands in for the reading order.
 */
export function simulateField(problems: VirtualProblem[], field: number[], durationSeconds: number, seed: string) {
  const random = seededRandom(seed);
  const ordered = [...problems].sort((a, b) => a.problem.difficulty - b.problem.difficulty);
  return field.map((rating) => {
    let elapsed = 0;
    const attempts: Attempt[] = [];
    for (const entry of ordered) {
      if (random() > solveProbability(rating, entry.problem.difficulty)) continue;
      const draw = sampleSeconds(entry.problem, entry.samples, rating, random);
      elapsed += draw.seconds;
      if (elapsed > durationSeconds) break;
      attempts.push({ problemId: entry.problem.id, seconds: elapsed, penalties: draw.penalties });
    }
    return { rating, ...scoreOf(attempts, problems) } satisfies Rival;
  });
}

export type Standing = { rank: number; total: number; performance: number; beat: number };

/** Slots a real result into the simulated standings and reads off the performance. */
export function standingFor(result: { points: number; timeSeconds: number }, rivals: Rival[]) {
  const ahead = rivals.filter((rival) => ranksBetter(rival, result)).length;
  const rank = ahead + 1;
  const field = rivals.map((rival) => rival.rating);
  return {
    rank,
    total: rivals.length + 1,
    performance: performanceForRank(rank, field),
    beat: rivals.length - ahead,
  } satisfies Standing;
}

/** Points follow the ABC convention: 100 per step up the difficulty order. */
export function pointsFor(index: number) {
  return (index + 1) * 100;
}

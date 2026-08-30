import { db } from '@/lib/db';
import { contestSlot, getSolvedSet } from '@/lib/atcoder';
import { getPlayerRow, LEADERBOARD_MIN_MATCHES } from '@/lib/match-db';

export const DIFFICULTY_BUCKETS = [
  { key: '~799', low: 0, high: 799 },
  { key: '800~1199', low: 800, high: 1199 },
  { key: '1200~1599', low: 1200, high: 1599 },
  { key: '1600~1999', low: 1600, high: 1999 },
  { key: '2000~2399', low: 2000, high: 2399 },
  { key: '2400~', low: 2400, high: 100_000 },
];

const bucketOf = (rating: number) => DIFFICULTY_BUCKETS.find((bucket) => rating >= bucket.low && rating <= bucket.high) ?? DIFFICULTY_BUCKETS[0];
const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;

type ResultRow = {
  match_id: string; mode: string; opponent: string; opponent_bot: number; result: string;
  rated: number; stake: number; delta: number; rating_after: number; problem_id: string;
  problem_title: string; problem_rating: number; contest_id: string; duration_seconds: number; created_at: number;
};

export async function getLeaderboard(handle: string | null) {
  const top = await db.prepare(`SELECT handle, duel_rating, peak_rating, atcoder_rating, wins, losses, draws,
      best_streak, rated_matches FROM players WHERE rated_matches >= ? ORDER BY duel_rating DESC, wins DESC LIMIT 50`)
    .bind(LEADERBOARD_MIN_MATCHES).all<{
      handle: string; duel_rating: number; peak_rating: number; atcoder_rating: number;
      wins: number; losses: number; draws: number; best_streak: number; rated_matches: number;
    }>();
  const rows = top.results.map((row, index) => ({ rank: index + 1, ...row }));
  if (!handle) return { rows, you: null };
  const you = await getPlayerRow(handle);
  const ahead = await db.prepare('SELECT COUNT(*) AS ahead FROM players WHERE rated_matches >= ? AND duel_rating > ?')
    .bind(LEADERBOARD_MIN_MATCHES, you.duel_rating).first<{ ahead: number }>();
  return {
    rows,
    you: {
      rank: you.rated_matches >= LEADERBOARD_MIN_MATCHES ? (ahead?.ahead ?? 0) + 1 : null,
      matchesToRank: Math.max(0, LEADERBOARD_MIN_MATCHES - you.rated_matches),
      ...you,
    },
  };
}

/**
 * Everything the profile screen needs: duel record, how fast the player is
 * relative to every other duellist, which contest slot keeps beating them, and
 * the problems they lost on and still have not solved.
 */
export async function getProfile(handle: string) {
  const [player, history, samples] = await Promise.all([
    getPlayerRow(handle),
    db.prepare('SELECT * FROM match_results WHERE handle = ? ORDER BY created_at DESC LIMIT 200').bind(handle).all<ResultRow>(),
    db.prepare('SELECT problem_rating, duration_seconds FROM solve_samples ORDER BY solved_at DESC LIMIT 4000')
      .all<{ problem_rating: number; duration_seconds: number }>(),
  ]);
  const results = history.results;

  const globalByBucket = new Map<string, number[]>();
  for (const sample of samples.results) {
    if (sample.duration_seconds <= 0) continue;
    const key = bucketOf(sample.problem_rating).key;
    globalByBucket.set(key, [...(globalByBucket.get(key) ?? []), sample.duration_seconds]);
  }

  const mineByBucket = new Map<string, number[]>();
  for (const row of results) {
    if (row.result !== 'win' || row.duration_seconds <= 0) continue;
    const key = bucketOf(row.problem_rating).key;
    mineByBucket.set(key, [...(mineByBucket.get(key) ?? []), row.duration_seconds]);
  }

  const speed = DIFFICULTY_BUCKETS.map((bucket) => {
    const mine = median(mineByBucket.get(bucket.key) ?? []);
    const global = median(globalByBucket.get(bucket.key) ?? []);
    return {
      bucket: bucket.key,
      samples: (mineByBucket.get(bucket.key) ?? []).length,
      medianSeconds: mine,
      globalMedianSeconds: global,
      // Negative means faster than the field.
      deltaPercent: mine && global ? Math.round(((mine - global) / global) * 100) : null,
    };
  });

  const slots = new Map<string, { slot: string; wins: number; losses: number; draws: number }>();
  for (const row of results) {
    const slot = contestSlot(row.problem_id);
    const entry = slots.get(slot) ?? { slot, wins: 0, losses: 0, draws: 0 };
    if (row.result === 'win') entry.wins += 1; else if (row.result === 'loss') entry.losses += 1; else entry.draws += 1;
    slots.set(slot, entry);
  }
  const slotStats = [...slots.values()].map((entry) => ({
    ...entry,
    played: entry.wins + entry.losses + entry.draws,
    winRate: Math.round((entry.wins / Math.max(1, entry.wins + entry.losses + entry.draws)) * 100),
  })).sort((a, b) => a.slot.localeCompare(b.slot));

  const lost = results.filter((row) => row.result !== 'win');
  const solved = lost.length ? await getSolvedSet(handle) : new Set<string>();
  const seen = new Set<string>();
  const revenge = lost.filter((row) => {
    if (solved.has(row.problem_id) || seen.has(row.problem_id)) return false;
    seen.add(row.problem_id);
    return true;
  }).slice(0, 12).map((row) => ({
    problemId: row.problem_id, title: row.problem_title, rating: row.problem_rating,
    opponent: row.opponent, lostAt: row.created_at,
    url: `https://atcoder.jp/contests/${row.contest_id}/tasks/${row.problem_id}`,
  }));

  const solvedLosses = results.filter((row) => row.result !== 'win' && solved.has(row.problem_id)).length;
  const hardestWin = results.filter((row) => row.result === 'win')
    .sort((a, b) => b.problem_rating - a.problem_rating)[0] ?? null;

  return {
    player,
    played: player.wins + player.losses + player.draws,
    winRate: Math.round((player.wins / Math.max(1, player.wins + player.losses + player.draws)) * 100),
    speed,
    slots: slotStats,
    revenge,
    revengeCleared: solvedLosses,
    hardestWin: hardestWin && { title: hardestWin.problem_title, rating: hardestWin.problem_rating, problemId: hardestWin.problem_id },
    recent: results.slice(0, 10).map((row) => ({
      opponent: row.opponent, bot: Boolean(row.opponent_bot), mode: row.mode, result: row.result,
      rated: Boolean(row.rated), delta: row.delta, ratingAfter: row.rating_after, stake: row.stake,
      problem: { id: row.problem_id, title: row.problem_title, rating: row.problem_rating },
      durationSeconds: row.duration_seconds, at: row.created_at,
    })),
  };
}

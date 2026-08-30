import { db } from '@/lib/db';
import { BASE_DUEL_RATING, DuelOutcome, ratingDelta } from '@/lib/elo';

export const DISCONNECTED_AFTER_MS = 15_000;
export const FORFEIT_AFTER_MS = DISCONNECTED_AFTER_MS + 60_000;
export const ASYNC_DUEL_TTL_MS = 24 * 60 * 60 * 1000;
export const LEADERBOARD_MIN_MATCHES = 3;

export type MatchMode = 'live' | 'bot' | 'async';

/** Postgres can add columns conditionally, so schema drift heals in one statement each. */
function addMissingColumns(table: string, columns: Record<string, string>) {
  return Object.entries(columns).map(([name, declaration]) =>
    db.prepare(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${declaration}`));
}

let schemaReady: Promise<void> | null = null;

async function createSchema() {
  await db.batch([
    // Serverless instances start concurrently; the lock keeps two of them from
    // racing on CREATE TABLE and tripping a duplicate type error.
    db.prepare('SELECT pg_advisory_xact_lock(704912)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS queue (
      token TEXT PRIMARY KEY, handle TEXT NOT NULL, rating BIGINT NOT NULL,
      language TEXT NOT NULL DEFAULT 'any', pick BIGINT NOT NULL, joined_at BIGINT NOT NULL,
      identity TEXT NOT NULL DEFAULT '')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY, p1_token TEXT NOT NULL, p2_token TEXT, p1_handle TEXT NOT NULL, p2_handle TEXT NOT NULL,
      p1_rating BIGINT NOT NULL, p2_rating BIGINT NOT NULL, p1_language TEXT NOT NULL DEFAULT 'any',
      p2_language TEXT NOT NULL DEFAULT 'any', p1_pick BIGINT NOT NULL, p2_pick BIGINT NOT NULL,
      problem_id TEXT NOT NULL, problem_title TEXT NOT NULL, problem_rating BIGINT NOT NULL,
      problem_language TEXT NOT NULL DEFAULT 'ja', contest_id TEXT NOT NULL,
      started_at BIGINT NOT NULL, p1_last_seen BIGINT NOT NULL DEFAULT 0, p2_last_seen BIGINT NOT NULL DEFAULT 0,
      bot_finish_at BIGINT, p1_reroll BIGINT NOT NULL DEFAULT 0,
      p2_reroll BIGINT NOT NULL DEFAULT 0, winner TEXT, status TEXT NOT NULL DEFAULT 'playing')`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_queue_joined_at ON queue(joined_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_matches_p1_token ON matches(p1_token)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_matches_p2_token ON matches(p2_token)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS solve_samples (
      sample_key TEXT PRIMARY KEY, problem_id TEXT NOT NULL, problem_rating BIGINT NOT NULL,
      player_rating BIGINT NOT NULL, rating_gap BIGINT NOT NULL, duration_seconds BIGINT NOT NULL,
      solved_at BIGINT NOT NULL)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_solve_samples_rating_gap ON solve_samples(rating_gap)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS players (
      handle TEXT PRIMARY KEY, duel_rating BIGINT NOT NULL DEFAULT ${BASE_DUEL_RATING},
      peak_rating BIGINT NOT NULL DEFAULT ${BASE_DUEL_RATING}, atcoder_rating BIGINT NOT NULL DEFAULT 0,
      wins BIGINT NOT NULL DEFAULT 0, losses BIGINT NOT NULL DEFAULT 0, draws BIGINT NOT NULL DEFAULT 0,
      streak BIGINT NOT NULL DEFAULT 0, best_streak BIGINT NOT NULL DEFAULT 0,
      rated_matches BIGINT NOT NULL DEFAULT 0, last_played BIGINT NOT NULL DEFAULT 0)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_players_duel_rating ON players(duel_rating DESC)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS match_results (
      result_key TEXT PRIMARY KEY, match_id TEXT NOT NULL, mode TEXT NOT NULL, handle TEXT NOT NULL,
      opponent TEXT NOT NULL, opponent_bot BIGINT NOT NULL DEFAULT 0, result TEXT NOT NULL,
      rated BIGINT NOT NULL DEFAULT 0, stake DOUBLE PRECISION NOT NULL DEFAULT 1, delta BIGINT NOT NULL DEFAULT 0,
      rating_after BIGINT NOT NULL DEFAULT ${BASE_DUEL_RATING}, problem_id TEXT NOT NULL,
      problem_title TEXT NOT NULL, problem_rating BIGINT NOT NULL, contest_id TEXT NOT NULL,
      duration_seconds BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_match_results_handle ON match_results(handle, created_at DESC)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_match_results_match ON match_results(match_id)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS verified_handles (
      handle TEXT PRIMARY KEY, identity TEXT NOT NULL, verified_at BIGINT NOT NULL)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_verified_identity ON verified_handles(identity)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS verification_challenges (
      identity TEXT NOT NULL, handle TEXT NOT NULL, code TEXT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY (identity, handle))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS challenges (
      code TEXT PRIMARY KEY, host_handle TEXT NOT NULL, host_rating BIGINT NOT NULL,
      host_identity TEXT NOT NULL, host_token TEXT NOT NULL, pick BIGINT NOT NULL,
      languages TEXT NOT NULL, match_id TEXT, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_challenges_host ON challenges(host_handle)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS solved_cache (
      handle TEXT PRIMARY KEY, problem_ids TEXT NOT NULL, cursor BIGINT NOT NULL, updated_at BIGINT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS app_cache (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS contest_ingests (
      contest_id TEXT PRIMARY KEY, sampled_users BIGINT NOT NULL, sample_count BIGINT NOT NULL,
      ingested_at BIGINT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS problem_time_samples (
      problem_id TEXT NOT NULL, contest_id TEXT NOT NULL, handle TEXT NOT NULL, rating BIGINT NOT NULL,
      delta_seconds BIGINT NOT NULL, penalties BIGINT NOT NULL DEFAULT 0,
      excluded BIGINT NOT NULL DEFAULT 0, exclude_reason TEXT,
      PRIMARY KEY (problem_id, handle))`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_time_samples_problem ON problem_time_samples(problem_id) WHERE excluded = 0'),
    db.prepare(`CREATE TABLE IF NOT EXISTS virtual_contests (
      id TEXT PRIMARY KEY, token TEXT NOT NULL, identity TEXT NOT NULL DEFAULT '', handle TEXT NOT NULL,
      rating BIGINT NOT NULL DEFAULT 0, low BIGINT NOT NULL, high BIGINT NOT NULL,
      duration_seconds BIGINT NOT NULL, problems TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'preparing',
      created_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT, result TEXT)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_virtual_token ON virtual_contests(token, created_at DESC)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_virtual_handle ON virtual_contests(handle, created_at DESC)'),
    ...addMissingColumns('queue', { identity: "TEXT NOT NULL DEFAULT ''", language: "TEXT NOT NULL DEFAULT 'any'" }),
    ...addMissingColumns('matches', {
      // Kept so a database created by an earlier release heals itself.
      p1_language: "TEXT NOT NULL DEFAULT 'any'",
      p2_language: "TEXT NOT NULL DEFAULT 'any'",
      problem_language: "TEXT NOT NULL DEFAULT 'ja'",
      p1_last_seen: 'BIGINT NOT NULL DEFAULT 0',
      p2_last_seen: 'BIGINT NOT NULL DEFAULT 0',
      bot_finish_at: 'BIGINT',
      p1_reroll: 'BIGINT NOT NULL DEFAULT 0',
      p2_reroll: 'BIGINT NOT NULL DEFAULT 0',
      winner: 'TEXT',
      status: "TEXT NOT NULL DEFAULT 'playing'",
      mode: "TEXT NOT NULL DEFAULT 'live'",
      code: 'TEXT',
      expires_at: 'BIGINT',
      rated: 'BIGINT NOT NULL DEFAULT 0',
      p1_identity: 'TEXT',
      p2_identity: 'TEXT',
      p1_stake: 'DOUBLE PRECISION NOT NULL DEFAULT 1',
      p2_stake: 'DOUBLE PRECISION NOT NULL DEFAULT 1',
      p1_started_at: 'BIGINT',
      p2_started_at: 'BIGINT',
      p1_solved_at: 'BIGINT',
      p2_solved_at: 'BIGINT',
      p1_done: 'BIGINT NOT NULL DEFAULT 0',
      p2_done: 'BIGINT NOT NULL DEFAULT 0',
    }),
  ]);
}

export function ensureTables() {
  // Runs once per isolate; every route awaits the same promise.
  schemaReady ??= createSchema().catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

export async function recordSolveSample(row: MatchRow, player: 'p1' | 'p2', solvedAt: number) {
  if (player === 'p2' && !row.p2_token) return;
  const playerRating = player === 'p1' ? row.p1_rating : row.p2_rating;
  const startedAt = (player === 'p1' ? row.p1_started_at : row.p2_started_at) ?? row.started_at;
  const durationSeconds = Math.max(1, Math.round((solvedAt - startedAt) / 1000));
  await db.prepare(`INSERT INTO solve_samples
    (sample_key, problem_id, problem_rating, player_rating, rating_gap, duration_seconds, solved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sample_key) DO NOTHING`)
    .bind(`${row.id}:${player}`, row.problem_id, row.problem_rating, playerRating,
      row.problem_rating - playerRating, durationSeconds, solvedAt).run();
}

export async function empiricalBotSolveSeconds(difficulty: number, botRating: number, fallback: () => number) {
  const gap = difficulty - botRating;
  const result = await db.prepare(`SELECT duration_seconds FROM solve_samples
    WHERE rating_gap BETWEEN ? AND ? ORDER BY solved_at DESC LIMIT 100`)
    .bind(gap - 200, gap + 200).all<{ duration_seconds: number }>();
  const samples = result.results.map((row) => row.duration_seconds).filter((value) => value > 0).sort((a, b) => a - b);
  if (samples.length < 5) return fallback();
  const median = samples[Math.floor(samples.length / 2)];
  return Math.max(30, Math.round(median * (0.9 + Math.random() * 0.2)));
}

export type PlayerRow = {
  handle: string; duel_rating: number; peak_rating: number; atcoder_rating: number;
  wins: number; losses: number; draws: number; streak: number; best_streak: number;
  rated_matches: number; last_played: number;
};

export async function upsertPlayer(handle: string, atcoderRating: number) {
  await db.prepare(`INSERT INTO players(handle, atcoder_rating, last_played) VALUES (?, ?, ?)
    ON CONFLICT(handle) DO UPDATE SET atcoder_rating = excluded.atcoder_rating, last_played = excluded.last_played`)
    .bind(handle, atcoderRating, Date.now()).run();
}

export async function getPlayerRow(handle: string) {
  const row = await db.prepare('SELECT * FROM players WHERE handle = ?').bind(handle).first<PlayerRow>();
  return row ?? {
    handle, duel_rating: BASE_DUEL_RATING, peak_rating: BASE_DUEL_RATING, atcoder_rating: 0,
    wins: 0, losses: 0, draws: 0, streak: 0, best_streak: 0, rated_matches: 0, last_played: 0,
  } satisfies PlayerRow;
}

export async function isVerified(handle: string, identity: string) {
  if (!identity) return false;
  const row = await db.prepare('SELECT identity FROM verified_handles WHERE handle = ?').bind(handle).first<{ identity: string }>();
  return row?.identity === identity;
}

function outcomeFor(handle: string, winner: string): DuelOutcome {
  return winner === 'draw' ? 'draw' : winner === handle ? 'win' : 'loss';
}

function nextStreak(current: number, outcome: DuelOutcome) {
  return outcome === 'win' ? Math.max(0, current) + 1 : outcome === 'loss' ? 0 : current;
}

/**
 * Applies the duel rating change and writes both players' history rows.
 * Only ever called by the request that flipped the match to `finished`.
 */
export async function settleMatch(row: MatchRow, winner: string, now: number) {
  const sides = [
    { key: 'p1' as const, handle: row.p1_handle, stake: row.p1_stake ?? 1, solvedAt: row.p1_solved_at, startedAt: row.p1_started_at ?? row.started_at, opponent: row.p2_handle, bot: !row.p2_token },
    { key: 'p2' as const, handle: row.p2_handle, stake: row.p2_stake ?? 1, solvedAt: row.p2_solved_at, startedAt: row.p2_started_at ?? row.started_at, opponent: row.p1_handle, bot: false },
  ].filter((side) => side.key === 'p1' || Boolean(row.p2_token));

  const players = Object.fromEntries(await Promise.all(sides.map(async (side) => [side.handle, await getPlayerRow(side.handle)] as const)));
  const rated = Boolean(row.rated) && sides.length === 2;
  const statements = [];

  for (const side of sides) {
    const outcome = outcomeFor(side.handle, winner);
    const me = players[side.handle];
    const opponentRating = row.p2_token ? players[side.opponent].duel_rating : Math.max(BASE_DUEL_RATING, row.p2_rating);
    const delta = rated ? ratingDelta(me.duel_rating, opponentRating, outcome, side.stake) : 0;
    const ratingAfter = me.duel_rating + delta;
    const durationSeconds = side.solvedAt ? Math.max(1, Math.round((side.solvedAt - side.startedAt) / 1000)) : 0;
    statements.push(
      db.prepare(`UPDATE players SET duel_rating = ?, peak_rating = GREATEST(peak_rating, ?),
        wins = wins + ?, losses = losses + ?, draws = draws + ?, streak = ?, best_streak = GREATEST(best_streak, ?),
        rated_matches = rated_matches + ?, last_played = ? WHERE handle = ?`)
        .bind(ratingAfter, ratingAfter, outcome === 'win' ? 1 : 0, outcome === 'loss' ? 1 : 0, outcome === 'draw' ? 1 : 0,
          nextStreak(me.streak, outcome), nextStreak(me.streak, outcome), rated ? 1 : 0, now, side.handle),
      db.prepare(`INSERT INTO match_results(result_key, match_id, mode, handle, opponent, opponent_bot,
        result, rated, stake, delta, rating_after, problem_id, problem_title, problem_rating, contest_id,
        duration_seconds, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(result_key) DO NOTHING`)
        .bind(`${row.id}:${side.handle}`, row.id, row.mode ?? 'live', side.handle, side.opponent, side.bot ? 1 : 0,
          outcome, rated ? 1 : 0, side.stake, delta, ratingAfter, row.problem_id, row.problem_title,
          row.problem_rating, row.contest_id, durationSeconds, now),
    );
  }
  // Players must exist before the UPDATE statements above can touch them.
  await Promise.all(sides.map((side) => upsertPlayer(side.handle, side.key === 'p1' ? row.p1_rating : row.p2_rating)));
  await db.batch(statements);
}

/** Flips the match to finished exactly once, then settles ratings for the winner. */
export async function finishMatch(row: MatchRow, winner: string, now: number) {
  const update = await db.prepare("UPDATE matches SET winner = ?, status = 'finished', p1_reroll = 0, p2_reroll = 0 WHERE id = ? AND status = 'playing'")
    .bind(winner, row.id).run();
  row.winner = winner;
  row.status = 'finished';
  if (update.meta.changes !== 1) return false;
  await settleMatch(row, winner, now);
  return true;
}

export type MatchRow = {
  id: string; p1_token: string; p2_token: string | null; p1_handle: string; p2_handle: string;
  p1_rating: number; p2_rating: number; p1_language: string; p2_language: string;
  p1_pick: number; p2_pick: number; problem_id: string;
  problem_title: string; problem_rating: number; problem_language: string; contest_id: string; started_at: number;
  p1_last_seen: number; p2_last_seen: number;
  bot_finish_at: number | null; p1_reroll: number; p2_reroll: number; winner: string | null; status: string;
  mode: MatchMode; code: string | null; expires_at: number | null; rated: number;
  p1_identity: string | null; p2_identity: string | null; p1_stake: number; p2_stake: number;
  p1_started_at: number | null; p2_started_at: number | null;
  p1_solved_at: number | null; p2_solved_at: number | null;
  p1_done: number; p2_done: number;
};

export async function publicMatch(row: MatchRow, token: string) {
  const isP1 = row.p1_token === token;
  const mode: MatchMode = row.mode ?? (row.p2_token ? 'live' : 'bot');
  const opponentLastSeen = isP1 ? row.p2_last_seen : row.p1_last_seen;
  const opponentIsBot = !row.p2_token;
  const opponentConnected = mode === 'async' || opponentIsBot || Date.now() - opponentLastSeen < DISCONNECTED_AFTER_MS;
  const youHandle = isP1 ? row.p1_handle : row.p2_handle;
  const opponentHandle = isP1 ? row.p2_handle : row.p1_handle;
  const youStartedAt = (isP1 ? row.p1_started_at : row.p2_started_at) ?? (mode === 'async' ? null : row.started_at);
  const opponentStartedAt = (isP1 ? row.p2_started_at : row.p1_started_at) ?? (mode === 'async' ? null : row.started_at);
  const youSolvedAt = isP1 ? row.p1_solved_at : row.p2_solved_at;
  const opponentSolvedAt = isP1 ? row.p2_solved_at : row.p1_solved_at;
  const finished = row.status === 'finished';
  const elapsed = (solvedAt: number | null, startedAt: number | null) =>
    solvedAt && startedAt ? Math.max(1, Math.round((solvedAt - startedAt) / 1000)) : null;

  const results = finished
    ? await db.prepare('SELECT handle, result, delta, rating_after, rated FROM match_results WHERE match_id = ?')
      .bind(row.id).all<{ handle: string; result: string; delta: number; rating_after: number; rated: number }>()
    : null;
  const mine = results?.results.find((entry) => entry.handle === youHandle) ?? null;

  return {
    id: row.id,
    mode,
    code: row.code,
    rated: Boolean(row.rated),
    expiresAt: row.expires_at,
    you: {
      handle: youHandle, rating: isP1 ? row.p1_rating : row.p2_rating, language: isP1 ? row.p1_language : row.p2_language,
      stake: isP1 ? row.p1_stake ?? 1 : row.p2_stake ?? 1, startedAt: youStartedAt,
      solvedAt: youSolvedAt, elapsedSeconds: elapsed(youSolvedAt, youStartedAt),
      done: Boolean(isP1 ? row.p1_done : row.p2_done),
    },
    opponent: {
      handle: opponentHandle,
      rating: isP1 ? row.p2_rating : row.p1_rating,
      language: isP1 ? row.p2_language : row.p1_language,
      bot: opponentIsBot,
      connected: opponentConnected,
      stake: isP1 ? row.p2_stake ?? 1 : row.p1_stake ?? 1,
      started: Boolean(opponentStartedAt),
      finished: Boolean(isP1 ? row.p2_done : row.p1_done),
      // An async opponent's time stays hidden until the duel is over.
      elapsedSeconds: mode !== 'async' || finished ? elapsed(opponentSolvedAt, opponentStartedAt) : null,
      forfeitAt: opponentConnected || opponentIsBot ? null : opponentLastSeen + FORFEIT_AFTER_MS,
    },
    range: [Math.min(row.p1_pick, row.p2_pick), Math.max(row.p1_pick, row.p2_pick)],
    problem: {
      id: row.problem_id, title: row.problem_title, rating: row.problem_rating, language: row.problem_language,
      url: `https://atcoder.jp/contests/${row.contest_id}/tasks/${row.problem_id}?lang=${row.problem_language}`,
    },
    startedAt: youStartedAt ?? row.started_at,
    botFinishAt: row.bot_finish_at,
    reroll: { you: Boolean(isP1 ? row.p1_reroll : row.p2_reroll), opponent: Boolean(isP1 ? row.p2_reroll : row.p1_reroll) },
    winner: row.winner,
    status: row.status,
    result: mine ? { delta: mine.delta, ratingAfter: mine.rating_after, rated: Boolean(mine.rated) } : null,
  };
}

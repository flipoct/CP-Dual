import { db } from '@/lib/db';
import { acceptedSince } from '@/lib/atcoder';
import { ASYNC_DUEL_TTL_MS, finishMatch, MatchRow, recordSolveSample } from '@/lib/match-db';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type ChallengeRow = {
  code: string; host_handle: string; host_rating: number; host_identity: string; host_token: string;
  pick: number; languages: string; match_id: string | null; created_at: number; expires_at: number;
};

export async function newChallengeCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
    const clash = await db.prepare('SELECT code FROM challenges WHERE code = ?').bind(code).first();
    if (!clash) return code;
  }
  throw new Error('도전장 코드를 생성하지 못했습니다. 잠시 후 다시 시도해주세요.');
}

export async function findChallenge(code: string) {
  return db.prepare('SELECT * FROM challenges WHERE code = ?').bind(code.toUpperCase()).first<ChallengeRow>();
}

export async function findAsyncMatch(code: string) {
  return db.prepare("SELECT * FROM matches WHERE code = ? AND mode = 'async'").bind(code.toUpperCase()).first<MatchRow>();
}

const elapsedOf = (solvedAt: number | null, startedAt: number | null) =>
  solvedAt && startedAt ? Math.max(1, solvedAt - startedAt) : Number.POSITIVE_INFINITY;

/**
 * Async duels compare each player's own clock instead of wall-clock order, so a
 * side is only judged once it has finished, given up, or run out of time.
 */
export async function resolveAsyncMatch(row: MatchRow, now: number) {
  if (row.status !== 'playing') return row;
  const sides = [
    { key: 'p1' as const, handle: row.p1_handle, startedAt: row.p1_started_at, solvedAt: row.p1_solved_at, done: Boolean(row.p1_done) },
    { key: 'p2' as const, handle: row.p2_handle, startedAt: row.p2_started_at, solvedAt: row.p2_solved_at, done: Boolean(row.p2_done) },
  ];
  const accepted = await Promise.all(sides.map((side) =>
    side.done || !side.startedAt ? Promise.resolve(null) : acceptedSince(side.handle, row.problem_id, side.startedAt)));

  const updates: string[] = [];
  const values: unknown[] = [];
  accepted.forEach((result, index) => {
    if (!result) return;
    const side = sides[index];
    side.solvedAt = result.at; side.done = true;
    if (side.key === 'p1') { row.p1_solved_at = result.at; row.p1_done = 1; } else { row.p2_solved_at = result.at; row.p2_done = 1; }
    updates.push(`${side.key}_solved_at = ?`, `${side.key}_done = 1`);
    values.push(result.at);
  });
  if (updates.length) await db.prepare(`UPDATE matches SET ${updates.join(', ')} WHERE id = ?`).bind(...values, row.id).run();

  const expired = Boolean(row.expires_at && now >= row.expires_at);
  if (!expired && !sides.every((side) => side.done)) return row;

  const [p1, p2] = sides.map((side) => elapsedOf(side.solvedAt, side.startedAt));
  const winner = p1 === p2 ? 'draw' : p1 < p2 ? row.p1_handle : row.p2_handle;
  const settled = await finishMatch(row, winner, now);
  if (settled) {
    if (row.p1_solved_at) await recordSolveSample(row, 'p1', row.p1_solved_at);
    if (row.p2_solved_at) await recordSolveSample(row, 'p2', row.p2_solved_at);
  }
  return row;
}

export function challengeExpiry(now: number) {
  return now + ASYNC_DUEL_TTL_MS;
}

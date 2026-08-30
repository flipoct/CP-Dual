export const BASE_DUEL_RATING = 1200;
export const K_FACTOR = 32;

/** Unrated AtCoder accounts report 0. Treat them as a beginner baseline instead. */
export function referenceRating(atcoderRating: number) {
  return atcoderRating > 0 ? atcoderRating : 800;
}

export function expectedScore(mine: number, theirs: number) {
  return 1 / (1 + 10 ** ((theirs - mine) / 400));
}

/**
 * The difficulty a player picks is their bet. Choosing well above your own
 * rating multiplies both the reward and the damage.
 */
export function stakeFor(pick: number, atcoderRating: number) {
  const gap = pick - referenceRating(atcoderRating);
  const raw = 1 + gap / 600;
  return Math.min(2.5, Math.max(0.5, Math.round(raw * 20) / 20));
}

export function stakeLabel(stake: number) {
  return `×${stake.toFixed(2).replace(/0$/, '')}`;
}

export type DuelOutcome = 'win' | 'loss' | 'draw';

export function ratingDelta(myDuelRating: number, opponentDuelRating: number, outcome: DuelOutcome, stake: number) {
  const score = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;
  const delta = K_FACTOR * stake * (score - expectedScore(myDuelRating, opponentDuelRating));
  // Never round a decisive result down to nothing.
  if (outcome === 'win') return Math.max(1, Math.round(delta));
  if (outcome === 'loss') return Math.min(-1, Math.round(delta));
  return Math.round(delta);
}

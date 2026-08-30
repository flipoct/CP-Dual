# CP-Dual

Competitive programming duels and virtual contests built on AtCoder.

**https://cp-dual.vercel.app**

Pick a difficulty, get a problem neither player has solved, and race to the first AC.
CP-Dual reads results straight from your public AtCoder submissions — it never asks
for a password. The interface is in Korean.

---

## Modes

**Live duel** — Queue up and get matched with another player. Both sides pick a
difficulty; the problem is drawn from the range between them, in a statement
language you both read. First AC wins. Disconnecting forfeits after a grace period.

**Async challenge** — Create a link, send it to a friend, and they can take it any
time within 24 hours. Each side runs its own clock from the moment they press start,
and the shorter time wins, so you never have to be online together.

**Virtual contest** — Choose a difficulty range, a problem count and a time limit.
CP-Dual assembles a contest from problems you have not solved, then simulates a
field of ~1,400 rivals to place you in the standings and compute a performance.

**Bot practice** — An unrated solo match against a pace estimated from real solve
times.

## Handle verification

Rated play requires proving you own the handle. CP-Dual issues a one-time code, you
paste it into your AtCoder profile's *Affiliation* field, and it reads the public
profile page back. No credentials are involved, and the code can be removed
afterwards. Matches between two verified players are rated; everything else is
practice.

## Duel rating

A separate Elo (base 1200, K=32) that measures speed rather than accuracy — a
different skill from your AtCoder rating, and the gap between the two is part of the
fun. The difficulty you pick before a match is also your stake: choosing well above
your own rating multiplies both the reward and the damage, from ×0.5 up to ×2.5.

## How the virtual contest is scored

This is the part with real machinery behind it.

### Per-problem solve times

For every source contest, CP-Dual samples ~60 real entrants spread across six rating
bands and reconstructs their timeline from public submissions. A problem's solve time
is the **gap between its first AC and the solver's previous AC** in that contest.

Two kinds of sample are discarded:

- **Revisits** — the solver had already submitted to the problem before their
  previous AC, so the gap only covers their second sitting.
- **Implausibly fast solves** — under 20% of what similarly-rated solvers
  (±300 rating) needed. Someone who thought about a problem, moved on, and returned
  to type it up in a minute is not evidence about that problem's difficulty.

The 20% threshold was chosen from the data: across 551 samples, the 1st percentile of
the ratio to the band median was 0.31, and exactly one sample fell below 0.20.

### Solve probability

`problem-models.json` from AtCoder Problems carries IRT parameters, with a
discrimination shared across all problems, so

```
P(solve | rating R) = 1 / (1 + exp(-0.004479 × (R − difficulty)))
```

comes for free — no extra requests, and by construction a problem of difficulty D is
solved by rating D exactly half the time.

### The simulated field

Rival ratings are taken from a real ABC's entrant list. Each rival attempts the
problems in difficulty order, solving each with its IRT probability and spending a
time sampled from real solvers near their own rating, until the clock runs out.
Standings follow AtCoder's rules: total score first, then last-AC time with five
minutes added per wrong answer.

Performance then uses AtCoder's own formula — the rating `R` whose expected rank
equals the rank achieved:

```
E[rank](R) = 0.5 + Σ 1 / (1 + 6^((R − rⱼ) / 400))
```

### Per-problem performance

The band medians form a curve of solve time against rating. It is forced to be
monotonically decreasing first (pool-adjacent-violators), because only unusually
strong players clear a problem far above their rating and a thin low band otherwise
reads faster than it should. Your time is then inverted against that curve.

**When the answer would be invented, CP-Dual says so instead.** On an easy problem
everyone spends the same few minutes reading and typing, so the curve is flat and no
time implies a rating. Fewer than three usable bands, or a curve whose slowest band
is under 1.4× its fastest, reports *판별 불가* — and the estimate is never
extrapolated beyond the ratings actually observed.

### Known limitations

- The first problem a sampler solved has no preceding AC, so its gap is measured
  from the contest start and includes reading the whole problem set. The bias is
  consistent within a problem, so comparisons across ratings still hold.
- Hard problems have thin samples (often 20–50). The sample count is shown in the
  results table so you can weigh it.
- AtCoder Problems indexes submissions minutes after the fact. Scores use your real
  AC timestamp, so nothing is lost, but a result can take a few minutes to appear —
  finished contests keep re-checking for ten minutes.
- Solving nothing yields a rank but no performance, since every such entrant ties.

## Stack

Next.js on Vercel, Postgres (Neon) via `pg`. Tables are created and migrated at
runtime by `ensureTables()` in [`lib/match-db.ts`](vercel-app/lib/match-db.ts) —
there is no separate migration step.

```
vercel-app/
  app/api/          match · challenge · virtual · verify · leaderboard · profile · player
  app/components/   client UI
  lib/atcoder.ts    AtCoder + AtCoder Problems access, problem pool, solved-set cache
  lib/contest-stats.ts  contest sampling, outlier rules, per-problem performance
  lib/performance.ts    IRT, field simulation, AtCoder performance formula
  lib/virtual-contest.ts  virtual contest lifecycle
  lib/elo.ts        duel rating and stakes
  lib/db.ts         Postgres adapter
```

## Running locally

```bash
cd vercel-app
npm install
cp .env.example .env.local   # point DATABASE_URL at a Postgres instance
npm run dev
```

The schema is created on the first request. `PGPOOL_MAX` caps the connection pool
when your database has a tight connection limit.

## Data sources

Problem metadata, difficulty estimates and submission history come from
[AtCoder Problems](https://kenkoooo.com/atcoder/) by kenkoooo. Ratings, profiles and
contest results come from [AtCoder](https://atcoder.jp/). Everything CP-Dual reads is
public; contest standings with per-task times are not, which is why solve times are
reconstructed from submission history instead.

CP-Dual is not affiliated with AtCoder.

## License

MIT — see [LICENSE](LICENSE).

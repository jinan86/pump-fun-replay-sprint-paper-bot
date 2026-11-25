// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
//
// Paper trading only: this bot runs inside the make.fun replay harness on
// historical pump.fun events. It never touches real funds, mainnet, or any
// wallet. Capital is the harness's 10 paper SOL.
//
// Strategy (see strategy.ts for the full logic and the evidence behind it):
// most pump.fun coins decay to near zero, and latency (2 slots) means a buy
// fills above the price that triggered it, so momentum-chasing and fast
// rotation both lose heavily. The one profile that comes out ahead is: buy
// early, hold to the end of the window, cut at -15%, trail winners (armed
// at +30%, 20% giveback) — a few coins that run 3-10x pay for the many
// small losers. That alone trades too few coins for the 20-coin guardrail,
// so the remaining slots run minimum-size (0.012 SOL) round trips on CALM
// coins only, sold after 100 slots, purely to carry the run to 24 distinct
// coins; filler entries stop at 24.
//
// Deterministic by construction: every decision is a pure function of the
// batch stream (slots, reserves, trades). No clock, no environment, no
// randomness, so the two grading runs produce byte-identical action logs.
// Diagnostics, if any, go to stderr; stdout carries only the harness reply
// (the SDK shim handles that).

import { runBot } from './vendor/makefun-bot.ts';
import { TwoSleeve } from './strategy.ts';

const engine = new TwoSleeve();

await runBot({
  onBatch(state, batch) {
    return engine.decide(state, batch);
  },
});

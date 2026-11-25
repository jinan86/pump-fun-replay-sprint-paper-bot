# Pump.fun Replay Sprint — Paper Bot, Real Ranking

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/jinan86/pump-fun-replay-sprint-paper-bot/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/jinan86/pump-fun-replay-sprint-paper-bot/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition on make.fun. It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity, scored by net PnL after all fees. Paper money only — it never touches real funds, mainnet, or any wallet.

## Strategy

Two sleeves (see `strategy.ts` for the full logic and the evidence behind it):

- **Core (max 3 slots):** buy early on tapes that are mostly buys, size up to 0.15 SOL by pyramiding into strength, hold to the end of the window (or until the curve completes), cut at −15%, and trail winners (armed at +30%, 20% giveback). No take-profit: a few coins that run 3–10x pay for the many small losers.
- **Filler (remaining slots):** minimum-size (0.012 SOL) round trips on CALM coins only (price moved < 3% over the last 10 slots, recent tape not net selling), sold after 100 slots / +25% / −15%, whichever comes first. Fillers exist only to carry the run to 24 distinct coins (buffer above the 20-coin guardrail); filler entries stop at 24.

The entry scan is fast by construction: an incrementally maintained candidate list (freshest-first, exactly the order a per-batch stable sort produces) plus a skip of the entry scan entirely when no order is possible (positions full, or core full + filler target reached). Trading behaviour is byte-identical to the naive version — verified by A/B grade-local runs in the build session.

## Layout

- `main.ts` — entrypoint (Node 22, no build step): wires the strategy into the harness shim.
- `strategy.ts` — the two-sleeve strategy.
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim, copied unchanged from the competition kit.

## Run locally

```sh
node main.ts   # the harness speaks agent-fun/replay/v2 on stdin/stdout
```

Grade it with the kit's local grader (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).

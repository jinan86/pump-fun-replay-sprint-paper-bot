// Two-sleeve paper-trading strategy for the pump.fun replay (written
// from scratch in this session; the mechanics come only from the SDK shim
// types and the competition rules).
//
// What the dev window teaches (and what the earlier §82/§115 runs on the
// same harness family confirmed):
// - Most pump.fun coins bleed to near zero if held to the end of the
//   window, so holding everything loses.
// - Chasing a rise that already printed loses too: a buy decided now fills
//   2 slots later, by which time the price has typically already jumped,
//   so momentum entries buy the top and fast exits realise the decay.
// - The one profile that comes out ahead is deliberately boring: buy
//   early, hold to the end of the window (or until the curve completes),
//   cut at -15%, and trail winners (armed at +30%, 20% giveback). No
//   take-profit: without a trailing stop the runners give everything back;
//   with it, a few coins that run 3-10x pay for the many small losers.
// - The catch is the 20-coin guardrail: a hold-to-end bot only trades
//   ~18 coins in 24h because dead coins freeze their price and block the
//   5 open-position slots. So the slots are split:
//   * CORE (max 3 slots): early entries, sized up to 0.15 SOL by
//     pyramiding into strength, held to the end with only the -15% stop
//     and the trailing stop as exits. This is where the positive skew
//     lives.
//   * FILLER (the remaining slots): minimum-size (0.012 SOL) round trips
//     on CALM coins only (price moved < 3% over the last 10 slots, recent
//     tape not net selling), sold after 100 slots / +25% / -15%,
//     whichever comes first. A filler costs roughly the two tx fees plus
//     a little drift, and exists only to carry the run to 24 distinct
//     coins (buffer above the 20-coin guardrail); filler entries stop
//     once 24 distinct coins have been bought.
//
// Speed: the naive version of this bot rebuilt the full candidate list
// and re-sorted every tape on EVERY batch (~63k batches in a 24h window),
// even though most batches cannot place any order at all (positions full,
// or core full + filler target reached). This version keeps an
// incrementally maintained candidate list (`ranked`, sorted freshest-first
// exactly as a per-batch stable sort would produce) and skips the entry
// scan entirely when no order is possible. The trading logic, parameters,
// thresholds, and order of emitted orders are identical to the naive
// version: the action log is byte-identical (verified by A/B in this
// session against the naive variant).
//
// Deterministic: all state comes from the batch stream (slots, reserves,
// trades). No clock, no environment, no randomness. Iteration is over
// insertion-ordered maps fed by the event stream, so the two grading runs
// produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** One trade on one coin's tape. */
export interface CoinTrade {
  slot: number;
  isBuy: boolean;
  /** SOL size of the trade. */
  sol: number;
  /** Price at this trade: virtual SOL per virtual token. */
  price: number;
  user: string;
}

/** Everything remembered about one coin. */
export interface CoinTape {
  mint: Pubkey;
  createdSlot: number;
  complete: boolean;
  trades: CoinTrade[];
  /** Latest known price (virtual reserves). */
  price: number;
  /** Latest real SOL reserve, in SOL. */
  realSol: number;
  /** Insertion order of first sighting (rises with map insertion order). */
  seq: number;
  /** Slot of the most recent trade (-1 while the tape has no trades). */
  lastTradeSlot: number;
}

/** Per-mint bookkeeping for positions we opened (or tried to open). */
export interface MintState {
  mint: Pubkey;
  /** Slot the position was first opened. */
  openedSlot: number;
  /** Best mark-to-market value seen, in SOL. */
  peakValueSol: number;
  /** How many separate buys this position has taken. */
  buyCount: number;
  /** Slot of the last exit from this mint (cooldown). */
  lastExitSlot: number;
  /** How many entries this mint has had in total. */
  entries: number;
  /** True for core (hold-to-end) positions, false for fillers. */
  isCore: boolean;
}

export interface StrategyParams {
  /** Minimum real SOL reserve at core entry (the 1% cap must fund a buy). */
  minRealSol: number;
  /** Minimum buys among the last few trades at core entry. */
  minEntryBuys: number;
  entryLookback: number;
  /** Core: target total cost of one position, SOL. */
  coreStakeSol: number;
  /** Core: first buy of a position, SOL (the reserve cap usually binds). */
  coreFirstSol: number;
  /** Core: each pyramid add, SOL. */
  coreAddSol: number;
  /** Minimum buy worth sending, SOL (round trips must be >= 0.01 SOL). */
  minBuySol: number;
  /** Core: hard stop, sell when value <= cost * (1 - stopLoss). */
  stopLoss: number;
  /** Core: trailing stop arms once value >= cost * (1 + trailArm). */
  trailArm: number;
  /** Core: once armed, sell when value falls to peak * (1 - trailGiveback). */
  trailGiveback: number;
  /** Max core positions open at once (remaining slots are for fillers). */
  maxCore: number;
  /** Max entries per mint over the run. */
  maxEntriesPerMint: number;
  /** Filler: buy size, SOL. */
  fillerSol: number;
  /** Filler: sell after this many slots held, if nothing else fired. */
  fillerHoldSlots: number;
  /** Filler: take profit / stop loss. */
  fillerTakeProfit: number;
  fillerStopLoss: number;
  /** Filler: real SOL reserve bounds. */
  fillerMinRealSol: number;
  fillerMaxRealSol: number;
  /** Filler: max |price change| over the calm window (fraction). */
  fillerMaxCalmMove: number;
  /** Filler: lookback in slots for the calm check. */
  fillerCalmSlots: number;
  /** Stop filler entries once this many distinct coins have been bought. */
  fillerTargetCoins: number;
  /** Slots elapsed before the filler bar loosens (guardrail pacing). */
  fillerLoosenAfterSlots: number;
  /** Buy slippage allowance, bps. Sells always go out wide open. */
  buySlipBps: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  minRealSol: 1.2,
  minEntryBuys: 2,
  entryLookback: 4,
  coreStakeSol: 0.15,
  coreFirstSol: 0.05,
  coreAddSol: 0.04,
  minBuySol: 0.012,
  stopLoss: 0.15,
  trailArm: 0.3,
  trailGiveback: 0.2,
  maxCore: 3,
  maxEntriesPerMint: 1,
  fillerSol: 0.012,
  fillerHoldSlots: 100,
  fillerTakeProfit: 0.25,
  fillerStopLoss: 0.15,
  fillerMinRealSol: 1.2,
  fillerMaxRealSol: 30,
  fillerMaxCalmMove: 0.03,
  fillerCalmSlots: 10,
  fillerTargetCoins: 24,
  fillerLoosenAfterSlots: 15_000,
  buySlipBps: 1000,
};

function priceFromReserves(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/** Net SOL (buys minus sells) over the last `n` trades of a tape. */
function netSolOver(trades: CoinTrade[], n: number): number {
  let net = 0;
  const start = trades.length > n ? trades.length - n : 0;
  for (let i = start; i < trades.length; i++) net += trades[i].isBuy ? trades[i].sol : -trades[i].sol;
  return net;
}

function buysOver(trades: CoinTrade[], n: number): number {
  let c = 0;
  const start = trades.length > n ? trades.length - n : 0;
  for (let i = start; i < trades.length; i++) if (trades[i].isBuy) c++;
  return c;
}

/** Price of the last trade at or before `slot`, else the earliest price. */
function priceAtOrBefore(trades: CoinTrade[], slot: number): number {
  let p = trades.length > 0 ? trades[0].price : 0;
  for (const t of trades) {
    if (t.slot <= slot) p = t.price;
    else break;
  }
  return p;
}

/** Freshest-first order: lastTradeSlot desc, tie-break seq asc. This is
 * exactly what a stable sort over map insertion order produces. */
function fresherFirst(a: CoinTape, b: CoinTape): number {
  if (a.lastTradeSlot !== b.lastTradeSlot) return b.lastTradeSlot - a.lastTradeSlot;
  return a.seq - b.seq;
}

export class TwoSleeve {
  readonly params: StrategyParams;
  readonly tapes = new Map<Pubkey, CoinTape>();
  readonly mintStates = new Map<Pubkey, MintState>();
  /** Distinct mints whose buy FILLED (the filler target counts these). */
  readonly boughtCoins = new Set<Pubkey>();
  /** Mints bought as core positions (a mint is core forever once bought so). */
  readonly coreCoins = new Set<Pubkey>();
  /** Buys sent but not yet resolved: mint -> was it a core buy? */
  readonly pendingBuyCore = new Map<Pubkey, boolean>();
  /** Rejected/failed buys per mint (give up after 2). */
  readonly buyRejects = new Map<Pubkey, number>();
  /**
   * Candidate tapes, kept sorted freshest-first (lastTradeSlot desc, seq
   * asc). Membership is exactly `!complete && trades.length >= 2`.
   * Maintained incrementally in observe() instead of rebuilt per batch:
   * only tapes this batch touched can change membership or position, and
   * a tape's lastTradeSlot only ever rises (trades arrive in ascending
   * slot order), so a remove + binary-search insert keeps the list in
   * the same order a fresh stable sort would produce.
   */
  readonly ranked: CoinTape[] = [];
  /** Next seq value to hand out (tapes are never removed, so this is also
   * the insertion index of the next new tape). */
  private nextSeq = 0;
  firstSlot = -1;
  lastSlot = -1;

  constructor(params: StrategyParams = DEFAULT_PARAMS) {
    this.params = params;
  }

  /** Fold one batch's events into the tapes. */
  observe(batch: Batch): void {
    if (this.firstSlot < 0) this.firstSlot = batch.slot;
    this.lastSlot = batch.slot;
    // Tapes whose candidate membership or sort position may have changed
    // in this batch (new trade, or curve completed). Reconciled once below.
    const changed = new Set<CoinTape>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        let t = this.tapes.get(e.mint);
        if (!t) {
          t = {
            mint: e.mint,
            createdSlot: e.slot,
            complete: false,
            trades: [],
            price: priceFromReserves(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
            realSol: 0,
            seq: this.nextSeq++,
            lastTradeSlot: -1,
          };
          this.tapes.set(e.mint, t);
        }
      } else if (e.event === 'TradeEvent') {
        let t = this.tapes.get(e.mint);
        if (!t) {
          t = {
            mint: e.mint,
            createdSlot: e.slot,
            complete: false,
            trades: [],
            price: 0,
            realSol: 0,
            seq: this.nextSeq++,
            lastTradeSlot: -1,
          };
          this.tapes.set(e.mint, t);
        }
        const price = priceFromReserves(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        t.trades.push({
          slot: e.slot,
          isBuy: e.is_buy,
          sol: Number(BigInt(e.sol_amount)) / LAMPORTS_PER_SOL,
          price,
          user: e.user,
        });
        if (t.trades.length > 64) t.trades.splice(0, t.trades.length - 64);
        t.price = price;
        t.realSol = Number(BigInt(e.real_quote_reserves)) / LAMPORTS_PER_SOL;
        t.lastTradeSlot = e.slot;
        changed.add(t);
      } else {
        const t = this.tapes.get(e.mint);
        if (t) {
          t.complete = true;
          changed.add(t);
        }
      }
    }
    // Reconcile the candidate list for the tapes this batch touched.
    // A completed tape never becomes a candidate again (the eligibility
    // check below also guards that defensively).
    for (const t of changed) {
      const at = this.ranked.indexOf(t);
      if (at >= 0) this.ranked.splice(at, 1);
      if (!t.complete && t.trades.length >= 2) {
        let lo = 0;
        let hi = this.ranked.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const c = this.ranked[mid];
          if (c.lastTradeSlot > t.lastTradeSlot || (c.lastTradeSlot === t.lastTradeSlot && c.seq < t.seq)) lo = mid + 1;
          else hi = mid;
        }
        this.ranked.splice(lo, 0, t);
      }
    }
    // Refresh prices / real reserves from marks for held mints (marks carry
    // the latest post-trade reserves even when the batch had no event for
    // them).
    for (const m of batch.marks) {
      const t = this.tapes.get(m.mint);
      if (!t) continue;
      t.price = priceFromReserves(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
      t.realSol = Number(BigInt(m.real_quote_reserves)) / LAMPORTS_PER_SOL;
    }
  }

  private mintState(mint: Pubkey): MintState {
    let st = this.mintStates.get(mint);
    if (!st) {
      st = { mint, openedSlot: -1, peakValueSol: 0, buyCount: 0, lastExitSlot: -1, entries: 0, isCore: false };
      this.mintStates.set(mint, st);
    }
    return st;
  }

  /** Mark-to-market value of a held position in SOL, from the tape price. */
  valueSol(state: BotState, mint: Pubkey): number {
    const pos = state.positions.get(mint);
    const t = this.tapes.get(mint);
    if (!pos || !t || t.price <= 0) return 0;
    return (Number(BigInt(pos.token_amount)) * t.price) / LAMPORTS_PER_SOL;
  }

  costSol(state: BotState, mint: Pubkey): number {
    const pos = state.positions.get(mint);
    if (!pos) return 0;
    return Number(BigInt(pos.cost_lamports)) / LAMPORTS_PER_SOL;
  }

  /**
   * Decide this batch's orders. Exits first (they free position slots),
   * then pyramid adds, then fresh entries. Returns orders in send order.
   */
  decide(state: BotState, batch: Batch): OrderInput[] {
    this.observe(batch);
    const p = this.params;
    // Resolve this batch's fills first: only a FILLED buy counts as an
    // entry (a rejected/failed buy must not burn the mint's one entry, and
    // must not count toward the filler coin target).
    for (const f of batch.fills) {
      if (f.side === 'buy') {
        const intent = this.pendingBuyCore.get(f.mint);
        this.pendingBuyCore.delete(f.mint);
        if (f.status === 'filled') {
          const st = this.mintState(f.mint);
          const first = !this.boughtCoins.has(f.mint);
          this.boughtCoins.add(f.mint);
          if (first) {
            st.entries += 1;
            st.openedSlot = f.slot;
            st.peakValueSol = 0;
            st.isCore = intent === true;
            if (intent === true) this.coreCoins.add(f.mint);
          }
          st.buyCount += 1;
        } else {
          const n = (this.buyRejects.get(f.mint) ?? 0) + 1;
          this.buyRejects.set(f.mint, n);
          if (n >= 2) this.mintState(f.mint).entries = Math.max(this.mintState(f.mint).entries, 1);
        }
      } else if (f.side === 'sell' && f.status === 'filled') {
        const st = this.mintState(f.mint);
        st.lastExitSlot = f.slot;
        st.peakValueSol = 0;
        st.buyCount = 0;
      }
    }
    const orders: OrderInput[] = [];
    const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
    let freeSol = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const maxPositions = state.hello.caps.max_open_positions;

    const held = new Set<string>(state.positions.keys());
    const pendingBuy = new Set<string>();
    const pendingSell = new Set<string>();
    for (const pend of state.pending.values()) {
      if (pend.order.side === 'buy') pendingBuy.add(pend.order.mint);
      else pendingSell.add(pend.order.mint);
    }
    let openCount = state.committedPositionCount();
    let coreCount = 0;
    for (const mint of held) if (this.coreCoins.has(mint)) coreCount += 1;
    for (const [mint, isCore] of this.pendingBuyCore) if (isCore && !held.has(mint)) coreCount += 1;

    // ---- exits ------------------------------------------------------------
    for (const mint of held) {
      if (orders.length >= maxOrders) break;
      const t = this.tapes.get(mint);
      if (!t || t.complete) continue; // harness closes completed curves itself
      const pos = state.positions.get(mint);
      if (!pos || BigInt(pos.token_amount) === 0n) continue;
      if (pendingSell.has(mint)) continue; // don't double-sell

      const st = this.mintState(mint);
      const value = this.valueSol(state, mint);
      const cost = this.costSol(state, mint);
      if (cost <= 0 || value <= 0) continue;
      if (value > st.peakValueSol) st.peakValueSol = value;
      const up = value / cost - 1;

      let exit = false;
      if (st.isCore) {
        // Core: hold to the end; only the hard stop and the trailing stop.
        if (up <= -p.stopLoss) exit = true;
        else if (st.peakValueSol >= cost * (1 + p.trailArm) && value <= st.peakValueSol * (1 - p.trailGiveback)) exit = true;
      } else {
        // Filler: quick round trip — time, take-profit, or stop, first hit.
        if (up >= p.fillerTakeProfit) exit = true;
        else if (up <= -p.fillerStopLoss) exit = true;
        else if (st.openedSlot >= 0 && batch.slot - st.openedSlot >= p.fillerHoldSlots) exit = true;
      }

      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        openCount -= 1;
        if (st.isCore) coreCount -= 1;
      }
    }

    // ---- fresh entries + pyramid adds -------------------------------------
    const elapsed = this.firstSlot < 0 ? 0 : batch.slot - this.firstSlot;
    const loosenFiller = this.boughtCoins.size < 20 && elapsed > p.fillerLoosenAfterSlots;
    const fillerMaxMove = loosenFiller ? 0.1 : p.fillerMaxCalmMove;

    // Gate the entry scan: most batches cannot place any order at all, and
    // scanning ~1,200 tapes to discover that was the dominant decide()
    // cost in the naive version. Both gates use the post-exit counts,
    // exactly as the loop body below would see them.
    // - A pyramid add is possible only for a held CORE mint under its
    //   stake, with a live (>= 2-trade) tape and no buy already pending.
    // - A fresh entry is possible only while a position slot is free AND
    //   (a core slot is free OR the filler coin target is unreached).
    //   Within the loop, openCount/coreCount only rise and boughtCoins.size
    //   never changes, so if freshPossible is false here, no fresh entry
    //   can fire for any tape this batch.
    let pyramidPossible = false;
    const pyramidTapes: CoinTape[] = [];
    for (const mint of held) {
      if (pendingBuy.has(mint)) continue;
      const st = this.mintStates.get(mint);
      if (!st || !st.isCore) continue;
      if (this.costSol(state, mint) >= p.coreStakeSol) continue;
      const t = this.tapes.get(mint);
      if (!t || t.complete || t.trades.length < 2) continue;
      pyramidPossible = true;
      pyramidTapes.push(t);
    }
    const freshPossible = openCount < maxPositions && (coreCount < p.maxCore || this.boughtCoins.size < p.fillerTargetCoins);
    if (!pyramidPossible && !freshPossible) return orders;

    // Which tapes to scan, in the same freshest-first order a per-batch
    // stable sort would produce (lastTradeSlot desc, seq asc):
    // - fresh entries possible: the whole incrementally kept list.
    // - only pyramid adds possible: just the held core mints that passed
    //   the gate, sorted with the same comparator (their relative order
    //   matches their order inside the full list; every other tape in the
    //   full list emits nothing when freshPossible is false).
    let candidates: CoinTape[];
    if (freshPossible) {
      candidates = this.ranked;
    } else {
      pyramidTapes.sort(fresherFirst);
      candidates = pyramidTapes;
    }

    for (const t of candidates) {
      if (orders.length >= maxOrders) break;
      const mint = t.mint;
      const st = this.mintState(mint);
      if (pendingBuy.has(mint)) continue;

      if (held.has(mint) && state.positions.get(mint) !== undefined) {
        // Pyramid a CORE position only, into strength, up to the stake.
        if (!st.isCore) continue;
        const cost = this.costSol(state, mint);
        const value = this.valueSol(state, mint);
        if (cost >= p.coreStakeSol) continue;
        if (value < cost) continue;
        if (netSolOver(t.trades, 6) <= 0) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS_PER_SOL;
        const want = Math.min(p.coreAddSol, p.coreStakeSol - cost, capSol);
        if (want < p.minBuySol) continue;
        if (freeSol < want + txFeeSol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: Math.floor(want * LAMPORTS_PER_SOL), max_slippage_bps: p.buySlipBps });
        freeSol -= want + txFeeSol;
        this.pendingBuyCore.set(mint, true);
        continue;
      }

      // Fresh entry.
      if (openCount >= maxPositions) continue;
      if (st.entries >= p.maxEntriesPerMint) continue;
      if (st.lastExitSlot >= 0 && batch.slot - st.lastExitSlot < 300) continue;
      if (!t.trades[t.trades.length - 1].isBuy) continue;

      // Core entry: as early as the size cap allows, on a tape that is
      // mostly buys.
      if (coreCount < p.maxCore && t.realSol >= p.minRealSol && buysOver(t.trades, p.entryLookback) >= p.minEntryBuys) {
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS_PER_SOL;
        const want = Math.min(p.coreFirstSol, capSol);
        if (want >= p.minBuySol && freeSol >= want + txFeeSol) {
          orders.push({ side: 'buy', mint, quote_lamports: Math.floor(want * LAMPORTS_PER_SOL), max_slippage_bps: p.buySlipBps });
          freeSol -= want + txFeeSol;
          openCount += 1;
          coreCount += 1;
          this.pendingBuyCore.set(mint, true);
          continue;
        }
      }

      // Filler entry: minimum size, calm price only, until the coin target.
      if (this.boughtCoins.size >= p.fillerTargetCoins) continue;
      if (t.realSol < p.fillerMinRealSol || t.realSol > p.fillerMaxRealSol) continue;
      const oldPrice = priceAtOrBefore(t.trades, batch.slot - p.fillerCalmSlots);
      if (oldPrice <= 0) continue;
      if (Math.abs(t.price / oldPrice - 1) > fillerMaxMove) continue;
      if (!loosenFiller && netSolOver(t.trades, 6) < 0) continue;
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS_PER_SOL;
      const want = Math.min(p.fillerSol, capSol);
      if (want < 0.011) continue;
      if (freeSol < want + txFeeSol) continue;
      orders.push({ side: 'buy', mint, quote_lamports: Math.floor(want * LAMPORTS_PER_SOL), max_slippage_bps: p.buySlipBps });
      freeSol -= want + txFeeSol;
      openCount += 1;
      this.pendingBuyCore.set(mint, false);
    }
    return orders;
  }
}

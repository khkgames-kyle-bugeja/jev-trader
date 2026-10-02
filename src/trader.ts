import { existsSync } from "node:fs";
import { config } from "./config";
import { EventLog } from "./event-log";
import { Market, type Book, type Fill, type Quote, type QuoteResult, type Side } from "./market";
import type { Action, Decision, Model, TradeState } from "./model";
import { TradeFeed, type MakerFill, type TradePrint } from "./trades";
import { expirePaperOrders, matchPaperFills, type PaperOrder } from "./paper";
import { pauseReason } from "./risk";

export interface BlockEvent {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: { action: Action; probabilities: Record<Action, number>; upIn10: number; latencyMs: number; late: boolean } | null;
  /** Operational pause; distinct from an inference that missed the block. */
  pauseReason: string | null;
  /** The order this block put on the book. */
  quote: Quote | null;
  /** Receipt of an explicit cancellation sent on a risk stop. */
  cancel: { status: Quote["status"]; orderIds: number[]; txHash: string | null; gasMon: number } | null;
  /** Maker fills that landed in this block (aggregated), attached when the trade logs for it arrive. */
  fill: Fill | null;
  /** Our size known to be resting on the book after this block's order. */
  resting: { bidMon: number; askMon: number };
  position: { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number };
  totals: Totals;
}

/** Per-block latency: the book read, and read + decide + send end to end. */
export interface Timing { readMs: number; loopMs: number }

export interface Totals {
  blocks: number;
  decisions: number;
  quotes: number;
  fills: number;
  reverted: number;
  lateBlocks: number;
  jevUsd: number;
  gasMon: number;
  gasUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlMon: number;
  pnlPct: number;
}

interface Resting { side: Side; price: number; size: number; block: number }

/**
 * Every block: read the book, ask the model buy or sell, and post one post-only limit order on
 * that side (`quoteInsideTicks` inside the touch), cancelling whatever we had resting. One request
 * in flight; a block that arrives while the previous one is still running is emitted as late.
 *
 * Live sends are fire-and-forget: the block event carries the quote as `sent`; its receipt
 * (`placed` with an order id, or `reverted`) is applied when it turns up on a later block. Fills
 * come from the Trade log feed: a taker hit one of our resting orders. Dry runs simulate both:
 * the order rests for one block and fills when a real print crosses its price.
 */
export class Trader {
  readonly history: BlockEvent[] = [];
  private eventLog = new EventLog("data/events.jsonl", config.maxEventLogMb * 1024 * 1024);
  private mids: number[] = [];
  private busy = false;
  private pendingLateBlocks: number[] = [];
  private lastBook: Book | null = null;
  private trades: TradeFeed | null = null;
  /** Live orders known to be resting on-chain (from receipts). */
  private orders = new Map<number, Resting>();
  /** Paper orders remain available to delayed log polls after replacement. */
  private paperOrders = new Map<number, PaperOrder>();
  /** Live quotes sent but not yet confirmed; they may become resting orders, so they count toward the cap. */
  private inflight = new Map<string, Quote>();
  private cancelInFlight = false;
  private cancelRequested = false;
  private simId = 0;
  private position = { mon: 0, costUsd: 0 }; // signed inventory and its cost basis
  private totals: Totals = { blocks: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 };

  constructor(
    private market: Market,
    private model: Model,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
    private onQuote: (block: number, quote: Quote) => void = () => {},
  ) {}

  /** Call once the market params are known. Without it `trades` in the state is all zeros and no fills are ever seen. */
  attachTradeFeed(sizeDec: number) {
    this.trades = new TradeFeed({ market: config.market, url: config.readRpcUrl, sizeDec, maker: this.market.address });
  }

  async onBlock(block: number) {
    this.totals.blocks++;
    this.confirmPending(block); // off the hot path: receipts for earlier blocks' sends
    if (this.totals.blocks % config.refreshBlocks === 0) this.market.refresh().catch(() => {}); // fee estimate + margin + vault check
    if (this.busy) {
      this.totals.lateBlocks++;
      this.pendingLateBlocks.push(block);
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      const book = await this.market.readBook();
      const readMs = performance.now() - t0;
      this.lastBook = book;
      this.mids.push(book.mid);
      if (this.mids.length > 400) this.mids.shift();
      this.trades?.poll(block).then(() => this.harvest()); // off the hot path: eth_getLogs for prints (and our fills) since the last poll

      const reason = this.riskReason(block, book);
      if (reason) {
        await this.cancelOnPause(block);
        this.emit(block, book, null, null, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) }, reason);
        return;
      }
      if (performance.now() - t0 > config.maxPreSendMs) {
        await this.cancelOnPause(block);
        this.emit(block, book, null, null, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) }, "pre-send latency budget");
        return;
      }

      const decision = await this.model.decide(this.buildState(block, book));
      const wanted: Side = decision.action === "sell" ? "sell" : "buy";
      // A blocked model call is not converted into an unrequested trade on the opposite side.
      const side: Side | null = this.allowed(wanted, book) ? wanted : null;
      this.totals.decisions++;
      if (this.model.name !== "mock") this.totals.jevUsd += (decision.inputTokens / 1e6) * config.jevUsdPerMTok;

      // A new head, stop file, fill or receipt may have changed safety during inference.
      const preSendReason = this.riskReason(block, book) ||
        (performance.now() - t0 > config.maxPreSendMs ? "pre-send latency budget" : null);
      if (preSendReason || !side) {
        const why = preSendReason ?? "inventory or margin limit";
        await this.cancelOnPause(block);
        this.emit(block, book, decision, null, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) }, why);
        return;
      }

      let quote: Quote | null = null;
      if (side) {
        const cancel = [...this.orders.keys()].filter((id) => id > 0); // simulated orders have negative ids
        quote = await this.market.send(block, side, config.tradeSizeMon, book, cancel, side !== wanted,
          t0 + config.maxPreSendMs,
          () => !this.cancelRequested && !existsSync("data/PAUSE") && !this.riskReason(block, book) && this.allowed(side, book));
        this.totals.quotes++;
        if (quote.status === "sim") {
          for (const o of this.paperOrders.values()) if (o.expiresBlock === undefined) o.expiresBlock = block;
          const id = --this.simId;
          this.paperOrders.set(id, { id, side, price: quote.price, size: quote.size, placedBlock: block });
        } else if (quote.txHash) {
          this.inflight.set(quote.txHash, quote);
        }
      }
      this.emit(block, book, decision, quote, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) });
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
      await this.cancelOnPause(block);
      if (this.lastBook) this.emit(block, this.lastBook, null, null, false, undefined, "book, model or send error");
    } finally {
      // A later head can arrive while this block's RPC/model work is still in flight.
      // Publish the completed block first, then the skipped heads, never in reverse order.
      if (this.lastBook) for (const skipped of this.pendingLateBlocks.splice(0)) this.emit(skipped, this.lastBook, null, null, true);
      else this.pendingLateBlocks.length = 0;
      this.busy = false;
    }
  }

  /** One eth_getTransactionReceipt per in-flight tx, in parallel with this block's decision. */
  private confirmPending(block: number) {
    this.market.pollPending(block).then((results) => {
      for (const r of results) this.applyQuoteResult(r);
      if (this.cancelRequested && this.orders.size) void this.cancelOnPause(block);
    }).catch(() => {});
  }

  private applyQuoteResult({ block, quote, canceled }: QuoteResult) {
    if (quote.txHash) this.inflight.delete(quote.txHash);
    if (quote.cancelOnly) this.cancelInFlight = false;
    this.totals.gasMon += quote.gasMon; // charged on reverts too
    this.totals.gasUsd += quote.gasMon * (this.lastBook?.mid ?? 0); // approximate conversion at receipt time
    if (quote.status === "reverted") this.totals.reverted++;
    for (const id of canceled) this.orders.delete(id);
    if (!quote.cancelOnly && quote.status === "placed" && quote.orderId !== null) this.orders.set(quote.orderId, { side: quote.side, price: quote.price, size: quote.size, block });
    const e = this.history.find((h) => h.block === block);
    if (e && quote.cancelOnly) e.cancel = { status: quote.status, orderIds: quote.cancel, txHash: quote.txHash, gasMon: quote.gasMon };
    else if (e) e.quote = quote;
    this.onQuote(block, quote);
  }

  private riskReason(block: number, book: Book) {
    if (this.market.safetyHaltReason) return this.market.safetyHaltReason;
    if (this.cancelRequested && (this.orders.size || this.inflight.size || this.cancelInFlight)) return "canceling live orders";
    if (this.market.wallet && (!Number.isFinite(this.market.marginUpdatedAt) ||
      Date.now() - this.market.marginUpdatedAt > config.maxMarginAgeMs)) return "stale margin balance";
    const reason = pauseReason({
      block, book, paused: existsSync("data/PAUSE"),
      pnlUsd: this.totals.realizedUsd + this.unrealizedUsd(book.mid) - this.totals.gasUsd - this.totals.jevUsd,
      gasMon: this.totals.gasMon + [...this.inflight.values()].reduce((sum, q) => sum + q.gasMon, 0),
      nextGasMon: this.market.estimatedQuoteGasMon,
    }, config);
    if (!reason && this.cancelRequested) this.cancelRequested = false; // no pending or resting orders remain
    return reason;
  }

  /** A risk pause stops new quotes AND attempts to remove all known resting live orders. */
  private async cancelOnPause(block: number) {
    if (this.market.wallet) this.cancelRequested = true;
    if (!this.market.wallet || !this.orders.size || this.cancelInFlight || this.market.safetyHaltReason) return;
    this.cancelInFlight = true; // claim the slot BEFORE the first await (gas estimation)
    try {
      const cancellation = await this.market.cancelResting(block, [...this.orders.keys()]);
      if (cancellation?.txHash) {
        this.inflight.set(cancellation.txHash, cancellation);
      } else this.cancelInFlight = false;
    } catch (e) {
      this.cancelInFlight = false;
      console.error(`block ${block}: failed to cancel resting orders:`, (e as Error).message);
    }
  }

  /** After each trade-log poll: apply our maker fills (live) or simulate them against the new prints (dry run). */
  private harvest() {
    if (!this.trades) return;
    const prints = this.trades.drainPrints();
    const fills: Fill[] = this.market.wallet ? this.liveFills(this.trades.drainFills()) : this.simFills(prints);
    if (!fills.length) return;
    const byBlock = new Map<number, Fill[]>();
    for (const f of fills) {
      this.applyFill(f);
      const b = (f as Fill & { block: number }).block;
      byBlock.set(b, [...(byBlock.get(b) ?? []), f]);
    }
    for (const [block, fs] of byBlock) {
      const fill = aggregate(fs);
      const e = this.history.find((h) => h.block === block);
      if (e) e.fill = fill;
      this.onFill(block, fill);
    }
  }

  private liveFills(raw: MakerFill[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const f of raw) {
      const o = this.orders.get(f.orderId);
      if (f.updatedSize <= 0) this.orders.delete(f.orderId);
      else if (o) o.size = f.updatedSize;
      out.push({ side: f.side, size: f.size, price: f.price, txHash: f.txHash, orderId: f.orderId, simulated: false, block: f.block });
    }
    return out;
  }

  /**
   * A simulated order placed at block N is on the book from N+1. A taker sell printing at or below
   * our bid (or a taker buy at or above our ask) would have taken us first: fill up to the print's size.
   */
  private simFills(prints: TradePrint[]): (Fill & { block: number })[] {
    const out = matchPaperFills(this.paperOrders, prints).map((f) => ({
      ...f, txHash: null, simulated: true,
    }));
    expirePaperOrders(this.paperOrders, this.trades?.lastBlock ?? 0);
    return out;
  }

  private restingMon(side: Side) {
    let mon = 0;
    for (const o of this.orders.values()) if (o.side === side) mon += o.size;
    for (const o of this.paperOrders.values()) if (o.side === side && o.expiresBlock === undefined) mon += o.size;
    for (const q of this.inflight.values()) if (q.side === side) mon += q.size;
    return mon;
  }

  /** Would this order, and everything already resting on its side, keep us inside the cap and (live) inside margin funds? */
  private allowed(side: Side, book: Book) {
    const size = config.tradeSizeMon;
    const exposure = side === "buy" ? this.position.mon + this.restingMon("buy") + size : this.position.mon - this.restingMon("sell") - size;
    if (Math.abs(exposure) > config.maxPositionMon) return false;
    if (!this.market.wallet) return true;
    // Kuru debits margin when an order is placed, so the balance already excludes what is resting.
    return side === "buy" ? this.market.margin.usdc >= size * book.ask : this.market.margin.mon >= size;
  }

  private buildState(block: number, book: Book): TradeState {
    const m = this.mids, n = m.length, H = config.horizonBlocks;
    const ret = (k: number) => (n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0);
    const sampled = m.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0); // every 5th block, newest included
    const lvl = (l: [number, number]) => `${l[0].toFixed(6)} x ${round(l[1], 1)}`;
    const empty = { count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null };
    const depth: TradeState["depth"] = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + "bps"] = { bid: round(v.bid, 1), ask: round(v.ask, 1) };
    return {
      market: "MON-USDC",
      block,
      horizonBlocks: H,
      blockMs: 300,
      mid: book.mid,
      spreadBps: round(book.spreadBps, 2),
      bookImbalance: round(book.imbalance, 3),
      depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
      recentMids: sampled.map((x) => x.toFixed(6)).join(" "),
      trades: this.trades ? this.trades.summary(H, block) : empty,
      recentTrades: (this.trades?.recent(10) ?? []).map((t) => `${t.block} ${t.side} ${round(t.size, 1)} @ ${t.price.toFixed(6)}`),
      allowed: { buy: this.allowed("buy", book), sell: this.allowed("sell", book) },
    };
  }

  private applyFill(f: Fill) {
    if (f.size <= 0) return;
    const signed = f.side === "buy" ? f.size : -f.size;
    const p = this.position;
    if (p.mon === 0 || Math.sign(p.mon) === Math.sign(signed)) {
      p.costUsd += signed * f.price; // adding to position
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(p.mon)) * Math.sign(signed);
      const entry = p.costUsd / p.mon;
      this.totals.realizedUsd += -closing * (f.price - entry); // closing part realizes pnl
      p.costUsd += closing * entry;
      const remainder = signed - closing;
      p.costUsd += remainder * f.price; // any flip opens the other way
    }
    p.mon += signed;
    if (Math.abs(p.mon) < 1e-9) { p.mon = 0; p.costUsd = 0; }
    this.totals.fills++;
  }

  private entryPrice() { return this.position.mon ? this.position.costUsd / this.position.mon : null; }
  private unrealizedUsd(mid: number) { return this.position.mon ? this.position.mon * (mid - this.entryPrice()!) : 0; }

  private emit(block: number, book: Book, decision: Decision | null, quote: Quote | null, late: boolean, timing?: Timing, reason: string | null = null) {
    const t = this.totals;
    const unrealized = this.unrealizedUsd(book.mid);
    t.pnlUsd = t.realizedUsd + unrealized - t.gasUsd - t.jevUsd;
    t.pnlMon = t.pnlUsd / book.mid;
    t.pnlPct = (t.pnlUsd / config.bankrollUsd) * 100;
    const size = Math.abs(this.position.mon);
    const event: BlockEvent = {
      block, ts: Date.now(), mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: round(book.spreadBps, 2),
      pauseReason: reason,
      decision: late
        ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }
        : decision && { action: decision.action, probabilities: decision.probabilities, upIn10: decision.upIn10, latencyMs: Math.round(decision.latencyMs), late: false },
      quote,
      cancel: null,
      fill: null,
      resting: { bidMon: round(this.restingMon("buy"), 1), askMon: round(this.restingMon("sell"), 1) },
      position: {
        side: this.position.mon > 0 ? "long" : this.position.mon < 0 ? "short" : "flat",
        size, entryPrice: this.entryPrice(), unrealizedUsd: round(unrealized, 4), unrealizedMon: round(unrealized / book.mid, 4),
      },
      totals: { ...t, jevUsd: round(t.jevUsd, 6), gasMon: round(t.gasMon, 6), gasUsd: round(t.gasUsd, 6), realizedUsd: round(t.realizedUsd, 4), pnlUsd: round(t.pnlUsd, 4), pnlMon: round(t.pnlMon, 4), pnlPct: round(t.pnlPct, 3) },
    };
    this.history.push(event);
    if (this.history.length > config.historySize) this.history.shift();
    this.eventLog.append(event);
    this.onEvent(event, timing);
  }
}

/** Several fills in one block become one: total size, size-weighted price, the side with more size. */
function aggregate(fills: Fill[]): Fill {
  const buy = fills.filter((f) => f.side === "buy").reduce((s, f) => s + f.size, 0);
  const sell = fills.filter((f) => f.side === "sell").reduce((s, f) => s + f.size, 0);
  const side: Side = buy >= sell ? "buy" : "sell";
  const same = fills.filter((f) => f.side === side);
  const size = same.reduce((s, f) => s + f.size, 0);
  const price = same.reduce((s, f) => s + f.size * f.price, 0) / size;
  return { side, size: round(size, 4), price, txHash: same[0]!.txHash, orderId: same[0]!.orderId, simulated: same[0]!.simulated };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

import { describe, expect, test } from "bun:test";
import { Trader, type BlockEvent } from "../src/trader";
import type { Market, Book, Quote, QuoteResult } from "../src/market";
import type { Model } from "../src/model";
import { config } from "../src/config";

const book: Book = {
  block: 100, bid: 1, ask: 1.001, mid: 1.0005, spreadBps: 10,
  imbalance: 0, levels: { bids: [[1, 1000]], asks: [[1.001, 1000]] },
  depthBps: { "10": { bid: 1000, ask: 1000 } },
};

function harness(opts: { book?: Book; readBook?: () => Promise<Book>; modelName?: string; wallet?: boolean; marginUsdc?: number; marginMon?: number; marginAgeMs?: number; modelDelayMs?: number; liveQuote?: boolean } = {}) {
  let sends = 0;
  let cancels = 0;
  let calls = 0;
  const receipts: QuoteResult[] = [];
  const events: BlockEvent[] = [];
  const market = {
    address: opts.wallet ? "0x0000000000000000000000000000000000000001" : null,
    wallet: opts.wallet ? {} : null,
    margin: { usdc: opts.marginUsdc ?? 0, mon: opts.marginMon ?? 0 },
    marginUpdatedAt: Date.now() - (opts.marginAgeMs ?? 0),
    safetyHaltReason: null,
    estimatedQuoteGasMon: 0,
    readBook: opts.readBook ?? (async () => opts.book ?? book),
    pollPending: async () => receipts.splice(0),
    cancelResting: async (block: number, ids: number[]): Promise<Quote> => {
      cancels++;
      return { side: "buy", size: 0, price: 0, txHash: "0x123", gasMon: 0.01,
        cancel: ids, status: "sent", orderId: null, capped: false, cancelOnly: true };
    },
    send: async (block: number, side: "buy" | "sell", size: number, _book: Book, _cancel: number[], capped: boolean): Promise<Quote> => {
      sends++;
      return { side, size, price: side === "buy" ? book.bid : book.ask, txHash: opts.liveQuote ? "0xabc" : null,
        gasMon: opts.liveQuote ? 0.1 : 0, cancel: [], status: opts.liveQuote ? "sent" : "sim", orderId: null, capped };
    },
  } as unknown as Market;
  const model = {
    name: opts.modelName ?? "mock",
    decide: async () => {
      calls++;
      if (opts.modelDelayMs) await Bun.sleep(opts.modelDelayMs);
      return { action: "buy" as const, probabilities: { buy: 0.9, sell: 0.1, hold: 0 }, upIn10: 0.9, latencyMs: 5, inputTokens: 1_000_000 };
    },
  } as Model;
  const trader = new Trader(market, model, (e) => events.push(e));
  return { trader, events, receipts, get sends() { return sends; }, get cancels() { return cancels; }, get calls() { return calls; } };
}

describe("trading loop safety", () => {
  test("one-quote live canary pauses before a second model call or broadcast", async () => {
    const previous = config.maxSessionQuotes;
    try {
      config.maxSessionQuotes = 1;
      const h = harness({ wallet: true, marginUsdc: 1000, liveQuote: true });
      await h.trader.onBlock(100);
      await h.trader.onBlock(101);
      expect(h.sends).toBe(1);
      expect(h.calls).toBe(1);
      expect(h.events[1]?.pauseReason).toBe("session quote limit");
      expect(h.events[1]?.quote).toBeNull();
    } finally { config.maxSessionQuotes = previous; }
  });

  test("a paused in-flight quote is canceled as soon as its order receipt arrives", async () => {
    let spread = 10;
    const h = harness({ wallet: true, marginUsdc: 1000, liveQuote: true,
      readBook: async () => ({ ...book, spreadBps: spread }) });
    await h.trader.onBlock(100);
    expect(h.sends).toBe(1);
    spread = 101;
    await h.trader.onBlock(101);
    expect(h.cancels).toBe(0); // no order ID before the first receipt
    h.receipts.push({ block: 100, canceled: [], quote: { ...h.events[0]!.quote!, status: "placed", orderId: 77 } });
    await h.trader.onBlock(102);
    await Bun.sleep(0);
    expect(h.cancels).toBe(1);
    expect(h.sends).toBe(1);
  });

  test("a pending quote placed during an older cancellation is canceled immediately afterward", async () => {
    let spread = 10;
    const h = harness({ wallet: true, marginUsdc: 1000, liveQuote: true,
      readBook: async () => ({ ...book, spreadBps: spread }) });
    (h.trader as unknown as { orders: Map<number, unknown> }).orders.set(12, { side: "buy", price: 1, size: 200, block: 99 });
    await h.trader.onBlock(100);
    spread = 101;
    await h.trader.onBlock(101);
    expect(h.cancels).toBe(1);
    h.receipts.push({ block: 100, canceled: [], quote: { ...h.events[0]!.quote!, status: "placed", orderId: 77 } });
    await h.trader.onBlock(102);
    expect(h.cancels).toBe(1); // the old cancellation still holds the slot
    h.receipts.push({ block: 101, canceled: [12], quote: { side: "buy", size: 0, price: 0,
      txHash: "0x123", gasMon: 0.01, cancel: [12], status: "placed", orderId: null, capped: false, cancelOnly: true } });
    await h.trader.onBlock(103);
    await Bun.sleep(0);
    expect(h.cancels).toBe(2);
    expect(h.sends).toBe(1);
  });

  test("book-read failure does not leave a known live quote without a cancellation attempt", async () => {
    const h = harness({ wallet: true, readBook: async () => { throw new Error("RPC unavailable"); } });
    (h.trader as unknown as { orders: Map<number, unknown> }).orders.set(321, { side: "sell", price: 1, size: 200, block: 99 });
    await h.trader.onBlock(100);
    expect(h.cancels).toBe(1);
    expect(h.sends).toBe(0);
  });

  test("stale live margin rejects a quote before running inference", async () => {
    const h = harness({ wallet: true, marginAgeMs: 20_000 });
    await h.trader.onBlock(100);
    expect(h.events[0]?.pauseReason).toBe("stale margin balance");
    expect(h.calls).toBe(0);
    expect(h.sends).toBe(0);
  });

  test("a model decision that misses the pre-send budget is not transmitted", async () => {
    const previous = config.maxPreSendMs;
    try {
      config.maxPreSendMs = 10;
      const h = harness({ modelDelayMs: 30 });
      await h.trader.onBlock(100);
      expect(h.events[0]?.pauseReason).toBe("pre-send latency budget");
      expect(h.calls).toBe(1);
      expect(h.sends).toBe(0);
    } finally {
      config.maxPreSendMs = previous;
    }
  });

  test("a book read that misses the pre-send budget does not invoke Jev", async () => {
    const previous = config.maxPreSendMs;
    try {
      config.maxPreSendMs = 1;
      const h = harness({ modelName: "jev-latest", readBook: async () => { await Bun.sleep(5); return book; } });
      await h.trader.onBlock(100);
      expect(h.events[0]?.pauseReason).toBe("pre-send latency budget");
      expect(h.calls).toBe(0);
      expect(h.sends).toBe(0);
      expect(h.events[0]?.totals.jevUsd).toBe(0);
    } finally { config.maxPreSendMs = previous; }
  });

  test("risk pause attempts cancellation once, not a replacement quote every block", async () => {
    const h = harness({ wallet: true, book: { ...book, spreadBps: 101 } });
    (h.trader as unknown as { orders: Map<number, unknown> }).orders.set(123, { side: "buy", price: 1, size: 200, block: 99 });
    await h.trader.onBlock(100);
    await h.trader.onBlock(101);
    expect(h.cancels).toBe(1);
    expect(h.sends).toBe(0);
    expect(h.events[0]?.pauseReason).toBe("spread limit");
    expect(h.events[0]?.quote).toBeNull();
  });

  test("slow book reads never publish a later block before the active block", async () => {
    let release!: (book: Book) => void;
    const waiting = new Promise<Book>((resolve) => { release = resolve; });
    const h = harness({ readBook: () => waiting });
    const active = h.trader.onBlock(100);
    await h.trader.onBlock(101);
    expect(h.events).toHaveLength(0);
    release(book);
    await active;
    expect(h.events.map((e) => e.block)).toEqual([100, 101]);
    expect(h.events[1]?.decision?.late).toBe(true);
  });

  test("a wide spread stops the model and any quote, with an explicit reason", async () => {
    const h = harness({ book: { ...book, spreadBps: 101 } });
    await h.trader.onBlock(100);
    expect(h.calls).toBe(0);
    expect(h.sends).toBe(0);
    expect(h.events[0]?.pauseReason).toBe("spread limit");
    expect(h.events[0]?.decision).toBeNull();
  });

  test("no opposite-side trade is placed when the model's side lacks margin", async () => {
    const h = harness({ wallet: true, marginUsdc: 0, marginMon: 1000 });
    await h.trader.onBlock(100);
    expect(h.calls).toBe(1);
    expect(h.sends).toBe(0);
    expect(h.events[0]?.decision?.action).toBe("buy");
    expect(h.events[0]?.pauseReason).toBe("inventory or margin limit");
  });

  test("mock inference is free in reporting; Jev estimate reduces reported P&L", async () => {
    const mock = harness();
    const jev = harness({ modelName: "jev-latest" });
    await mock.trader.onBlock(100);
    await jev.trader.onBlock(100);
    expect(mock.events[0]?.totals.jevUsd).toBe(0);
    expect(mock.events[0]?.totals.pnlUsd).toBe(0);
    expect(jev.events[0]?.totals.jevUsd).toBe(0.042);
    expect(jev.events[0]?.totals.pnlUsd).toBe(-0.042);
  });
});

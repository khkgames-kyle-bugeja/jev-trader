import { describe, expect, test } from "bun:test";
import { Trader, type BlockEvent } from "../src/trader";
import type { Market, Book, Quote } from "../src/market";
import type { Model } from "../src/model";

const book: Book = {
  block: 100, bid: 1, ask: 1.001, mid: 1.0005, spreadBps: 10,
  imbalance: 0, levels: { bids: [[1, 1000]], asks: [[1.001, 1000]] },
  depthBps: { "10": { bid: 1000, ask: 1000 } },
};

function harness(opts: { book?: Book; readBook?: () => Promise<Book>; modelName?: string; wallet?: boolean; marginUsdc?: number; marginMon?: number } = {}) {
  let sends = 0;
  let calls = 0;
  const events: BlockEvent[] = [];
  const market = {
    address: opts.wallet ? "0x0000000000000000000000000000000000000001" : null,
    wallet: opts.wallet ? {} : null,
    margin: { usdc: opts.marginUsdc ?? 0, mon: opts.marginMon ?? 0 },
    estimatedQuoteGasMon: 0,
    readBook: opts.readBook ?? (async () => opts.book ?? book),
    pollPending: async () => [],
    send: async (block: number, side: "buy" | "sell", size: number, _book: Book, _cancel: number[], capped: boolean): Promise<Quote> => {
      sends++;
      return { side, size, price: side === "buy" ? book.bid : book.ask, txHash: null, gasMon: 0, cancel: [], status: "sim", orderId: null, capped };
    },
  } as unknown as Market;
  const model = {
    name: opts.modelName ?? "mock",
    decide: async () => {
      calls++;
      return { action: "buy" as const, probabilities: { buy: 0.9, sell: 0.1, hold: 0 }, upIn10: 0.9, latencyMs: 5, inputTokens: 1_000_000 };
    },
  } as Model;
  const trader = new Trader(market, model, (e) => events.push(e));
  return { trader, events, get sends() { return sends; }, get calls() { return calls; } };
}

describe("trading loop safety", () => {
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

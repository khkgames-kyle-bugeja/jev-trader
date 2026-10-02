import { describe, expect, test } from "bun:test";
import { expirePaperOrders, matchPaperFills, type PaperOrder } from "../src/paper";
import { pauseReason, type RiskState } from "../src/risk";
import { QUESTIONS } from "../src/model";
import type { Book } from "../src/market";

const paper = (side: "buy" | "sell" = "buy"): Map<number, PaperOrder> => new Map([
  [-1, { id: -1, side, price: 1, size: 200, placedBlock: 10, expiresBlock: 11 }],
  [-2, { id: -2, side, price: 1, size: 200, placedBlock: 11 }],
]);

describe("paper fills", () => {
  test("never claims a same-price print or a print on placement block", () => {
    const orders = paper();
    expect(matchPaperFills(orders, [
      { block: 10, side: "sell", price: 0.9, size: 100 },
      { block: 11, side: "sell", price: 1, size: 100 },
    ])).toEqual([]);
    expect(orders.get(-1)?.size).toBe(200);
  });

  test("attributes delayed prints to the old quote until its replacement block, not the new one", () => {
    const orders = paper();
    expect(matchPaperFills(orders, [{ block: 11, side: "sell", price: 0.99, size: 70 }])).toEqual([
      { block: 11, orderId: -1, side: "buy", price: 1, size: 70 },
    ]);
    expirePaperOrders(orders, 10);
    expect(orders.has(-1)).toBe(true);
    expirePaperOrders(orders, 11);
    expect(orders.has(-1)).toBe(false);
  });

  test("caps fills at print size and order size and ignores expired orders", () => {
    const orders = paper("sell");
    expect(matchPaperFills(orders, [
      { block: 12, side: "buy", price: 1.01, size: 250 },
      { block: 13, side: "buy", price: 1.02, size: 100 },
    ])).toEqual([{ block: 12, orderId: -2, side: "sell", price: 1, size: 200 }]);
  });
});

const book = { block: 100, bid: 1, ask: 1.001, mid: 1.0005, spreadBps: 10 } as Book;
const state: RiskState = { block: 100, book, gasMon: 0, nextGasMon: 0.035, pnlUsd: 0, paused: false };
const limits = { maxBookAgeBlocks: 2, maxSpreadBps: 100, maxSessionGasMon: 1, maxSessionLossUsd: 10 };

describe("risk limits", () => {
  test("accepts a healthy book and the exact gas budget", () => {
    expect(pauseReason(state, limits)).toBeNull();
    expect(pauseReason({ ...state, gasMon: 0.965 }, limits)).toBeNull();
  });
  test("halts on manual pause, stale/invalid books, wide spread, loss and next gas", () => {
    expect(pauseReason({ ...state, paused: true }, limits)).toContain("manual pause");
    expect(pauseReason({ ...state, block: 103 }, limits)).toBe("stale book");
    expect(pauseReason({ ...state, book: { ...book, ask: 0 } }, limits)).toBe("invalid book");
    expect(pauseReason({ ...state, book: { ...book, spreadBps: 101 } }, limits)).toBe("spread limit");
    expect(pauseReason({ ...state, pnlUsd: -10 }, limits)).toBe("loss limit");
    expect(pauseReason({ ...state, gasMon: 0.97 }, limits)).toBe("gas limit");
  });
});

test("Jev is instructed to choose a resting maker quote, not an immediate taker order", () => {
  expect(QUESTIONS.direction.instructions.goal).toContain("post-only limit order");
  expect(QUESTIONS.direction.instructions.timing).toContain("may land in a later block");
  expect(QUESTIONS.direction.criteria.buy).toContain("conditional on being filled");
});

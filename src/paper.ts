import type { Side } from "./market";
import type { TradePrint } from "./trades";

export interface PaperOrder {
  id: number;
  side: Side;
  price: number;
  size: number;
  placedBlock: number;
  /** The replacement quote was sent in this block; prints in that block may still hit the old order. */
  expiresBlock?: number;
}

export interface PaperFill {
  block: number;
  orderId: number;
  side: Side;
  price: number;
  size: number;
}

/**
 * Paper fills are deliberately conservative: a taker must print strictly through the quote.
 * At the same price we have no evidence that a hypothetical order had queue priority.
 * Keep expired orders until the log feed catches up, so delayed polling cannot erase a fill.
 * This is still an approximation, not a backtest or proof that an order would have filled.
 */
export function matchPaperFills(orders: Map<number, PaperOrder>, prints: TradePrint[]): PaperFill[] {
  const fills: PaperFill[] = [];
  for (const p of prints) {
    let remaining = p.size;
    for (const [id, o] of orders) {
      if (remaining <= 0) break;
      if (p.block <= o.placedBlock || (o.expiresBlock !== undefined && p.block > o.expiresBlock) || o.size <= 0) continue;
      const through = o.side === "buy" ? p.side === "sell" && p.price < o.price : p.side === "buy" && p.price > o.price;
      if (!through) continue;
      const size = Math.min(o.size, remaining);
      o.size -= size;
      remaining -= size;
      if (o.size <= 1e-9) orders.delete(id);
      fills.push({ block: p.block, orderId: id, side: o.side, price: o.price, size });
    }
  }
  return fills;
}

export function expirePaperOrders(orders: Map<number, PaperOrder>, lastPolledBlock: number) {
  for (const [id, o] of orders) {
    if (o.expiresBlock !== undefined && lastPolledBlock >= o.expiresBlock) orders.delete(id);
  }
}

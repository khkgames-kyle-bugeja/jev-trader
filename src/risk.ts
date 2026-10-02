import type { Book } from "./market";

export interface RiskLimits {
  maxBookAgeBlocks: number;
  maxSpreadBps: number;
  maxSessionGasMon: number;
  maxSessionLossUsd: number;
}

export interface RiskState {
  block: number;
  book: Book;
  gasMon: number;
  nextGasMon: number;
  pnlUsd: number;
  paused: boolean;
}

/** A reason to skip a quote, or null when a new quote is permitted. Limits reset on process restart. */
export function pauseReason(state: RiskState, limits: RiskLimits): string | null {
  if (state.paused) return "manual pause (data/PAUSE)";
  const { book, block } = state;
  if (!Number.isFinite(book.mid) || !Number.isFinite(book.bid) || !Number.isFinite(book.ask) ||
      book.bid <= 0 || book.ask <= book.bid || book.mid <= 0 ||
      !Number.isFinite(book.spreadBps) || book.spreadBps < 0) return "invalid book";
  // Public read RPCs may return a newer block than the head feed sampled moments earlier.
  if (!Number.isInteger(book.block) || Math.abs(block - book.block) > limits.maxBookAgeBlocks)
    return "stale book";
  if (book.spreadBps > limits.maxSpreadBps) return "spread limit";
  if (!Number.isFinite(state.pnlUsd) || state.pnlUsd <= -limits.maxSessionLossUsd) return "loss limit";
  if (!Number.isFinite(state.gasMon) || !Number.isFinite(state.nextGasMon) ||
      state.gasMon + state.nextGasMon > limits.maxSessionGasMon) return "gas limit";
  return null;
}

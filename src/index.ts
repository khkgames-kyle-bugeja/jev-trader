import { config } from "./config";
import { startBlockFeed } from "./chain";
import { Market } from "./market";
import { createModel } from "./model";
import { Trader } from "./trader";
import { log10 } from "./book";
import { startServer } from "./server";
import { ethers } from "ethers";
import { armLiveSession } from "./live-guard";

if (!config.dryRun && !config.enableLiveTrading) {
  throw new Error("Live trading requires ENABLE_LIVE_TRADING=true as well as PRIVATE_KEY and DRY_RUN=false. Keep DRY_RUN=true while testing.");
}
for (const [key, value] of Object.entries({
  TRADE_SIZE_MON: config.tradeSizeMon, MAX_POSITION_MON: config.maxPositionMon,
  BANKROLL_USD: config.bankrollUsd, MAX_BOOK_AGE_BLOCKS: config.maxBookAgeBlocks,
  MAX_SPREAD_BPS: config.maxSpreadBps, MAX_SESSION_GAS_MON: config.maxSessionGasMon,
  MAX_SESSION_QUOTES: config.maxSessionQuotes,
  MAX_SESSION_LOSS_USD: config.maxSessionLossUsd, JEV_USD_PER_MTOK: config.jevUsdPerMTok,
  MAX_PRE_SEND_MS: config.maxPreSendMs, MAX_MARGIN_AGE_MS: config.maxMarginAgeMs,
  MAX_EVENT_LOG_MB: config.maxEventLogMb, RPC_TIMEOUT_MS: config.rpcTimeoutMs,
})) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive finite number`);
}
if (!Number.isInteger(config.maxBookAgeBlocks) || !Number.isInteger(config.quoteInsideTicks) || config.quoteInsideTicks < 0)
  throw new Error("MAX_BOOK_AGE_BLOCKS must be a positive integer and QUOTE_INSIDE_TICKS a nonnegative integer");
if (!Number.isInteger(config.maxSessionQuotes)) throw new Error("MAX_SESSION_QUOTES must be a positive integer");

if (!config.dryRun) {
  const wallet = new ethers.Wallet(config.privateKey!);
  const marker = armLiveSession(config.liveStateDir, { chainId: config.chainId, market: config.market, wallet: wallet.address });
  console.log(`Live restart protection armed at ${marker}; never delete it before manual on-chain reconciliation`);
}

const market = new Market();
await market.init();
const model = createModel();
let previousPause: string | null = null;

const server = startServer(
  { model: model.name, wallet: market.address, dryRun: config.dryRun, market: config.market, startedAt: Date.now() },
  () => trader.history,
);
const trader = new Trader(
  market,
  model,
  (e, t) => {
    server.broadcast(e, t);
    if (e.pauseReason !== previousPause) {
      console.log(e.pauseReason ? `#${e.block} PAUSED: ${e.pauseReason}` : `#${e.block} RESUMED`);
      previousPause = e.pauseReason;
    }
    if (e.decision && !e.decision.late) {
      const p = e.decision.probabilities;
      const q = e.quote;
      const quote = !q ? " NO QUOTE (cap or funds on both sides)" : ` ${q.side.toUpperCase()} ${q.size} @ ${q.price.toFixed(6)}${q.capped ? " capped" : ""}${q.status === "sim" ? " (sim)" : ` cancel ${q.cancel.length} ${q.txHash}`}`;
      console.log(`#${e.block} ${e.mid.toFixed(6)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} ${e.decision.latencyMs}ms${quote} pnl $${e.totals.pnlUsd}${t ? ` · read ${t.readMs}ms loop ${t.loopMs}ms` : ""}`);
    }
  },
  (block, fill) => {
    server.broadcastFill(block, fill);
    console.log(`#${block} FILL ${fill.side} ${fill.size} @ ${fill.price.toFixed(6)}${fill.simulated ? " (sim)" : ` order ${fill.orderId} ${fill.txHash}`}`);
  },
  (block, quote) => {
    if (quote.cancelOnly) {
      server.broadcastCancel(block, quote);
      console.log(`#${block} CANCEL ${quote.status.toUpperCase()} ${quote.cancel.length} orders gas ${quote.gasMon.toFixed(6)} MON ${quote.txHash}`);
    } else {
      server.broadcastQuote(block, quote);
      if (quote.status !== "placed") console.log(`#${block} ${quote.status.toUpperCase()} ${quote.side} @ ${quote.price.toFixed(6)} gas ${quote.gasMon.toFixed(6)} MON ${quote.txHash}`);
    }
  },
);
trader.attachTradeFeed(log10(market.params.sizePrecision));

const publicReadRpc = /^https:\/\/rpc[123]?\.monad\.xyz\/?$/.test(config.readRpcUrl);
console.log(`jev-trader · model=${model.name} · post-only ${config.quoteInsideTicks} tick inside the touch · horizon ${config.horizonBlocks} blocks · ${config.dryRun ? "DRY RUN" : `wallet ${market.address}`} · market ${config.market} · read ${publicReadRpc ? config.readRpcUrl : "configured private RPC"} · ${config.serverHost}:${config.port}`);
startBlockFeed((block) => trader.onBlock(block));

# jev-trader

One decision every Monad block. A TypeSafe Jev model watches the Kuru MON-USDC order book and answers buy or sell every ~300 ms. When risk limits permit, the bot posts a post-only limit order on that side, one tick inside the touch, replacing the last one. Maker orders can earn the spread when filled, but fills are not guaranteed and adverse selection, gas, and inference costs can outweigh it. A small server streams every block to the dashboard.

## Run

    cp .env.example .env
    bun install
    bun run start

With no `PRIVATE_KEY` it dry-runs: real book, real decisions, simulated fills. Set `MODEL=jev` and `TYPESAFE_AI_API_KEY` to use Jev; the default `mock` is a momentum heuristic stand-in.

### Safety-first fork changes

This fork is **paper-first**, not a profitable or production-ready strategy:

- Jev's question now describes the **actual maker quote**, uncertain fills, inventory and quote gas. It no longer describes an immediate-or-cancel order that crosses the spread.
- Paper fills require a trade print **strictly through** our price. Same-price prints are not credited because we cannot establish queue priority. Replaced paper orders are kept until the log poll catches up. This is still only an approximation of fills.
- New quoting pauses if the book is invalid/stale, the spread is too wide, or session loss/gas limits are reached. `touch data/PAUSE` stops **new** quotes on the next processed block; `rm data/PAUSE` resumes. This does **not** cancel existing live orders. The dashboard distinguishes `PAUSED` from `LATE`. If inventory or margin blocks the model's side, it does not silently trade the opposite side.
- P&L includes approximate Jev token spend and gas converted to USD at receipt-time mid. The mock is not charged Jev spend. See `.env.example` for limits and pricing assumptions.
- **Live transactions require explicit `DRY_RUN=false` and `ENABLE_LIVE_TRADING=true` with `PRIVATE_KEY`.** Do not turn this on yet for unattended use: live order, position and budget reconciliation across restarts is not implemented. Session budgets reset on restart, and the wallet must be isolated and tightly funded.

Run `bun run test` and `bun run typecheck` before making changes. The backend exposes the API on port 3000; to run the dashboard separately, see `web/README.md`. Never paste a private key into Git or a shared computer. A read-only smoke test on October 2, 2026 observed ~0.4-1.1 s public-RPC book reads, so a 300 ms every-block quote is **not guaranteed** with this setup. Blocks skipped while the loop is busy are reported as `late`; history and SSE preserve block order.

## Endpoints

Original upstream deployment (not this fork; inspect its current `/` response for model and dry-run status): https://jev-trader-production.up.railway.app

- `GET /` snapshot: model, wallet, dryRun, latest block event
- `GET /history` last 1000 block events
- `GET /events` SSE: `snapshot` on connect, then one `block` event per block, plus a `fill` event whenever a live order's receipt lands

Every event (see `src/trader.ts` for types):

    {
      "block": 105488269, "ts": 1789593630676,
      "mid": 0.022636, "bestBid": 0.022628, "bestAsk": 0.022644, "spreadBps": 7.07,
      "decision": { "action": "buy", "probabilities": { "buy": 0.77, "sell": 0.23, "hold": 0 }, "upIn10": 0.77, "latencyMs": 81, "late": false },
      "quote": { "side": "buy", "price": 0.022629, "size": 200, "txHash": "0x…", "gasMon": 0.0357, "cancel": [100295801], "status": "sent", "orderId": null, "capped": false },
      "fill": null,
      "resting": { "bidMon": 200, "askMon": 200 },
      "position": { "side": "short", "size": 200, "entryPrice": 0.022633, "unrealizedUsd": -0.0006, "unrealizedMon": -0.027 },
      "totals": { "blocks": 3, "decisions": 3, "quotes": 3, "fills": 1, "reverted": 0, "lateBlocks": 0, "jevUsd": 0.000004, "gasMon": 0.107, "gasUsd": 0.0024, "realizedUsd": 0, "pnlUsd": -0.003, "pnlMon": -0.13, "pnlPct": -0.003 }
    }

On eligible blocks the model is asked which maker quote is better over `HORIZON_BLOCKS` (default 100, ~30 s) and answers `buy` or `sell`. `quote` is a post-only limit order of `TRADE_SIZE_MON` on that side, `QUOTE_INSIDE_TICKS` inside the touch (clamped to the touch when the spread is too tight), in one `batchUpdate` that also cancels everything we had resting (`cancel`). An operational stop has `pauseReason` and no decision or quote; an overlapping inference has `decision.late: true` and no quote. If the model's side violates the position cap or lacks margin, the decision is reported with no quote and `pauseReason` explains why. `resting` is our size known to be on the book after this block. The legacy `upIn10` field equals the buy probability, not a calibrated prediction of price direction.

Live sends are fired and forgotten, so the `block` event carries the **intent**: `status: "sent"`, `gasMon` is `gasLimit x (last known base fee + priority)`. Monad charges the gas limit, so that is the real cost whether the order lands or not. The receipt arrives a block or two later as its own SSE event:

    event: quote
    data: { "block": 105488269, "quote": { …, "status": "placed", "orderId": 100295812, "gasMon": 0.0357 } }

`status` becomes `placed` (with the order id) or `reverted` (the book moved through the price before the tx landed, or a cancelled order had already filled). No receipt after 10 blocks gives `lost`. Fills are not in our own transactions: someone else's taker order hits our resting one, and the Trade log for it arrives via the same `eth_getLogs` poll that feeds the model. Each block with fills gets its own SSE event, and `position`, `realizedUsd` and `fills` update then:

    event: fill
    data: { "block": 105488271, "fill": { "side": "buy", "size": 200, "price": 0.022629, "txHash": "0x…", "orderId": 100295812, "simulated": false } }

`txHash` is the taker's transaction. In a dry run the quote is `status: "sim"`: the order rests for one block and a real print crossing its price fills it (`simulated: true`).

## Layout

    src/config.ts   env
    src/chain.ts    block feed (WebSocket newHeads + polling backstop, newest block only), raw RPC
    src/book.ts     one-eth_call order book reader (decodes getL2Book, merges the AMM vault)
    src/market.ts   Kuru: read book, hand-encoded batchUpdate (cancel + post-only place), margin deposits, local nonce, async confirmation
    src/model.ts    Model interface, JevModel (AI SDK experimental_evaluate), MockModel
    src/trader.ts   the loop: one in flight, hold when late, position and P&L accounting
    src/server.ts   Bun.serve: snapshot, history, SSE

## The 300 ms budget

A decision and an order have to fit in one block, so the hot loop makes exactly two RPC round trips:
one `eth_call` for the book (~18 ms on the public RPC, `READ_RPC_URL`) and one `eth_sendRawTransaction`
(`RPC_URL`), which returns as soon as the tx is accepted. Nothing else is on the path — no
`eth_estimateGas` (Monad charges gas on the limit, so the limit is hardcoded or derived once at
startup), no `eth_sendRawTransactionSync` (it blocks until the tx is Proposed), no gas price lookup
(static type-2 fees: `MAX_FEE_GWEI` cap, 2 gwei priority; the effective price is base + priority).
Receipts, the fee estimate and the vault check run off the hot path on later blocks. Measured in a
dry run with the mock model: read p50 18 ms, whole loop p50 100 ms (80 ms of it the mock's inference stand-in).

    bun run scripts/bench-read.ts     # book reader vs the SDK: exactness and latency
    bun run scripts/dry-encode.ts     # signs a buy and a sell offline, asserts the calldata matches the SDK

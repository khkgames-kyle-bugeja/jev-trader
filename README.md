# jev-trader (safety-first fork)

An experimental TypeSafe Jev + Kuru MON-USDC market-making bot on Monad. It reads a live order book, chooses a **post-only maker bid or ask**, and streams decisions to a dashboard. **It has no proven trading edge.** Maker fills are uncertain; gas, adverse selection and model costs can exceed any captured spread. The default is a **no-key, no-transaction paper run**.

## Accounts and funding

| Mode | What you need |
| --- | --- |
| Mock paper trading | [Bun](https://bun.com/docs/installation) and an internet connection; no account, wallet, token or API key. |
| Jev paper trading | A [TypeSafe account and API key](https://console.typesafe.ai/keys); check [official Jev pricing](https://docs.typesafe.ai/models). Keep `DRY_RUN=true`, leave `PRIVATE_KEY` blank, set `MODEL=jev` and `TYPESAFE_AI_API_KEY`. |
| Future live use | A new dedicated wallet, such as [MetaMask from its official download page](https://metamask.io/download), configured for [Monad mainnet](https://docs.monad.xyz/guides/add-monad-to-wallet/mainnet) (chain ID 143). Native **MON** pays wallet gas and funds sell-side Kuru margin; the correct mainnet **USDC** funds buy-side Kuru margin. The [Kuru MON-USDC market](https://www.kuru.io/markets/0x065c9d28e428a0db40191a54d33d5b7c71a9c394/trade) has a minimum **200 MON** order. [Kuru's verified addresses](https://docs.kuru.io/contracts/Contract-addresses) and [Monad's token list](https://docs.monad.xyz/developer-essentials/network-information/tokens-and-bridges) identify USDC at `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`. An optional dedicated RPC account, such as [Alchemy](https://www.alchemy.com/) or [QuickNode](https://www.quicknode.com/chains/monad), may improve latency; [compare official providers](https://docs.monad.xyz/tooling-and-infra/rpc-providers). No separate Kuru login is needed by this bot. |

**Do not fund a live wallet for this bot yet.** We have not tested a funded live wallet or demonstrated profitability. If you are studying the requirements: one minimum-size **ask** needs at least 200 MON **in Kuru margin**; one minimum-size **bid** needs approximately `200 × current ask` USDC **in Kuru margin**. The wallet separately needs MON for gas, including cancellation/reverts, and TypeSafe usage is separate. At the sample defaults, the bot's startup **wallet gas-reserve guard** is 1.8 MON (1 MON session cap plus two 1,000,000-gas cancellation allowances at the 400 gwei cap); this is a code prerequisite, **not a suggested deposit or maximum loss**. The read-only preflight calculates it from your settings. `MARGIN_MON=600` and `MARGIN_USDC=20` in `.env.example` are optional **auto-deposit targets**, not recommended funding amounts. Auto-deposit is **off** by default. Never send funds to a contract or token address based only on a pasted address: confirm it against the official links and the bot's read-only preflight.

## Run a paper session

```sh
git clone https://github.com/khkgames-kyle-bugeja/jev-trader.git
cd jev-trader
cp .env.example .env
bun install
bun run preflight  # reads official market parameters; no key or transaction
bun run test
bun run typecheck
bun run start      # backend API at http://localhost:3000
```

The dashboard is a separate Next.js application; see `web/README.md`. The original author's [public deployment](https://jev-trader-production.up.railway.app/) is **not this fork**; inspect its `/` response before trusting its model or dry-run status. To inspect a dedicated wallet and its Kuru margin balances **without its private key**, run `WALLET_ADDRESS=0xYourPublicAddress bun run preflight`. It does not approve, deposit or trade.

## Safety controls and limitations

- `MODEL=mock` is a deterministic stand-in. `MODEL=jev` sends real decisions to TypeSafe. The prompt describes the actual maker quote, not an immediate taker fill.
- Paper fills require a real print **strictly through** the hypothetical quote; equal-price prints do not claim queue priority. Delayed logs retain replaced quotes until the feed catches up. This remains an approximation, **not a backtest**.
- The bot rejects invalid/stale books, wide spreads, stale live margin data, excessive session loss/gas and decisions that miss `MAX_PRE_SEND_MS` (default **750 ms paper**, **200 ms live**). JSON-RPC requests time out after `RPC_TIMEOUT_MS` (default 2 seconds). Pending quote gas is reserved at the **configured maximum fee**, not merely the last observed price, then replaced by actual receipt cost. **Emergency cancellations can exceed `MAX_SESSION_GAS_MON`**; it is a conservative quote-admission control, not a guaranteed all-in cost cap. It never silently switches to the opposite side when the model's side is blocked. See `.env.example` for limits. Session limits reset after a manual restart, not at midnight.
- `touch data/PAUSE` stops new quotes on the next processed block. In live mode, it **attempts to cancel known resting orders** via `batchCancelOrders`; wait for a cancellation receipt and independently check on-chain state. If a transaction has an uncertain outcome, the bot **halts further sends** and requires manual reconciliation. A pause does not magically revoke unknown orders or pending transactions.
- Live mode needs `PRIVATE_KEY`, `DRY_RUN=false`, `ENABLE_LIVE_TRADING=true` and an **existing absolute `LIVE_STATE_DIR` on a private persistent volume owned by the bot user (`chmod 700`)**. Known temporary paths such as `/tmp` are rejected; persistence of an arbitrary volume still requires operator verification. A private marker is created *before* startup work; any subsequent live start refuses to run until an operator reconciles orders, pending transactions, inventory and balances. **Do not delete the marker merely to make the bot start.** This is fail-closed restart protection, **not automatic recovery**. Never run two copies for one wallet, put a primary wallet key in `.env`, commit secrets, or use an ephemeral directory for `LIVE_STATE_DIR`.
- The live API binds to **127.0.0.1** by default; it has **no authentication**. Do not change `SERVER_HOST` to expose it publicly without an authenticated private gateway. Paper mode retains public binding for local demo previews.
- Startup deposits are **disabled** unless `AUTO_DEPOSIT_MARGIN=true` is explicitly set. That setting can move MON/USDC from the wallet into Kuru margin and performs exact-amount (not unlimited) USDC approval. The bot pins live use to the verified Monad MON-USDC market, official margin account and USDC token.
- P&L includes estimated Jev spend and gas converted to USD at receipt-time midpoint. It excludes other possible costs and is **not a verified statement**. The mock does not incur Jev charges. `JEV_USD_PER_MTOK` is an indicative input; verify provider pricing yourself.
- In our October 2, 2026 sandbox test, warm public-RPC reads took about **0.4-1.1 seconds**. A 300 ms quote cadence is therefore **not achievable here**. Use `/metrics` to measure your own p50/p95/p99 and a suitably located low-latency RPC. A latency budget skips a late quote rather than disguising it as an in-block fill.
- Run `bun run bench:rpc` from the intended host to compare four official public read endpoints. `RPC_CANDIDATES=https://your-dedicated-rpc` tests your own provider instead. A sub-200 ms **read** p95 is necessary but not sufficient: model inference and the send RPC also take time.
- `data/events.jsonl` rotates to one `.1` archive when it reaches `MAX_EVENT_LOG_MB` (20 MB by default). The in-memory `/history` window remains separate.

**Live operation still requires an operator and funded-wallet testing.** On-chain per-wallet open orders cannot be enumerated directly from the pinned Kuru SDK/ABI; its relevant event owners are not indexed. This fork deliberately refuses to auto-resume a prior live session. Treat restart recovery, any unknown pre-existing orders, provider outages, and strategy profitability as unresolved before meaningful funding.

## API and layout

- `GET /` snapshot (model, wallet, dry-run, most recent event).
- `GET /health` feed freshness, last block and pause state; `ready` means recent feed activity, **not permission to fund or trade**.
- `GET /metrics` rolling 1,000-sample read/loop latency percentiles and recent totals.
- `GET /history` last 1,000 block events; `GET /events` SSE events: `snapshot`, `block`, `quote`, `cancel`, `fill`, `ping`.
- `src/chain.ts`: WebSocket heads and HTTP polling backstop. `src/book.ts`: batched read/decode of Kuru book and optional vault. `src/market.ts`: live quote, receipt and cancel transactions. `src/trader.ts`: serialized decisions, risk and inventory. `src/paper.ts`: conservative simulated fills. `src/live-guard.ts`: one-run marker. `src/server.ts`: read-only feed and health endpoints.

A `quote` event describes **intent** until a receipt changes it to `placed`, `reverted` or `lost`. A `cancel` event describes a risk-stop cancellation, not a new quote. A `fill` event comes from another user's taker transaction; in dry-run it is simulated. Paused blocks have `pauseReason`; skipped overlapping heads have `decision.late: true`. The legacy `upIn10` field equals buy probability, **not a calibrated direction prediction**.

```sh
bun run scripts/bench-read.ts   # book reader vs SDK latency/exactness
bun run scripts/dry-encode.ts   # offline calldata comparison, no broadcast
```

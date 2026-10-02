import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { config } from "../src/config";
import { readBook } from "../src/book";

// Read-only: no wallet, approvals or transactions. Keep sample count small for public RPCs.
const defaults = ["https://rpc.monad.xyz", "https://rpc1.monad.xyz", "https://rpc2.monad.xyz", "https://rpc3.monad.xyz"];
const urls = [...new Set((process.env.RPC_CANDIDATES ?? defaults.join(",")).split(",").map((s) => s.trim()).filter(Boolean))];
if (!urls.length || urls.some((s) => !s.startsWith("https://"))) throw new Error("RPC_CANDIDATES must contain HTTPS RPC URLs separated by commas");
const samples = Math.max(1, Math.min(20, Number(process.env.RPC_SAMPLES ?? 8)));
if (!Number.isInteger(samples)) throw new Error("RPC_SAMPLES must be an integer");
const provider = new ethers.providers.StaticJsonRpcProvider(config.readRpcUrl, config.chainId);
const params = await Kuru.ParamFetcher.getMarketParams(provider, config.market);
const at = (x: number[], p: number) => x.sort((a, b) => a - b)[Math.ceil(p * x.length) - 1];
for (const url of urls) {
  const times: number[] = [];
  const errors: string[] = [];
  for (let i = 0; i < samples + 1; i++) {
    const t = performance.now();
    try {
      await readBook(url, config.market, params, { timeoutMs: 3500 });
      if (i > 0) times.push(Math.round(performance.now() - t)); // first call warms TLS
    } catch (e) { errors.push((e as Error).message.slice(0, 100)); }
  }
  const result = { url, samples: times.length, failures: errors.length,
    p50Ms: times.length ? at([...times], 0.5) : null,
    p95Ms: times.length ? at([...times], 0.95) : null,
    likelyFits200MsPreSendBudget: times.length === samples && at([...times], 0.95)! < 200,
    error: errors[0] ?? null };
  console.log(JSON.stringify(result));
}
console.log("These are READ latencies only; model inference, signing and send RPC add time. Run from the actual host/region you intend to use.");

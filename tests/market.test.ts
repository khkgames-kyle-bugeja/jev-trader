import { expect, test } from "bun:test";
import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { Market } from "../src/market";
import { config } from "../src/config";

test("risk-stop cancellation calls batchCancelOrders with the expected order IDs", () => {
  const market = new Market(); // no init, wallet funding or RPC call
  const data = market.encodeCancel([123, 456]);
  const decoded = new ethers.utils.Interface(OrderBookAbi.abi).parseTransaction({ data });
  expect(decoded.functionFragment.name).toBe("batchCancelOrders");
  expect(decoded.args[0].map((id: number | ethers.BigNumber) => Number(id.toString()))).toEqual([123, 456]);
});

test("live gas reservations use the max fee cap instead of sampled gas price", () => {
  const market = new Market();
  (market as any).wallet = { address: "0x0000000000000000000000000000000000000001" };
  expect(market.estimatedQuoteGasMon).toBeCloseTo(config.gasLimitFallback * config.maxFeeGwei / 1e9, 8);
});

test("deadline expiry during signing rejects a quote before broadcast", async () => {
  const market = new Market();
  (market as any).wallet = { address: "0x0000000000000000000000000000000000000001",
    signTransaction: async () => { await Bun.sleep(5); return "0xdead"; } };
  (market as any).quotePrice = () => 1;
  (market as any).buildTx = () => ({ nonce: 0 });
  const original = globalThis.fetch;
  let broadcasts = 0;
  globalThis.fetch = (async () => { broadcasts++; throw new Error("unexpected RPC"); }) as typeof fetch;
  try {
    await expect(market.send(20, "buy", 200, {} as any, [], false, performance.now() + 1, () => true))
      .rejects.toThrow("pre-broadcast latency budget");
    expect(broadcasts).toBe(0);
  } finally { globalThis.fetch = original; }
});

test("a receipt-loss halt during signing blocks broadcast and serializes nonce resync", async () => {
  const market = new Market();
  let release!: (signed: string) => void;
  const signing = new Promise<string>((resolve) => { release = resolve; });
  (market as any).wallet = { address: "0x0000000000000000000000000000000000000001", signTransaction: () => signing };
  (market as any).quotePrice = () => 1;
  (market as any).buildTx = () => ({ nonce: 0 });
  (market as any).pending.set("0xold", { block: 10, gasLimit: ethers.BigNumber.from(350_000),
    quote: { side: "buy", size: 200, price: 1, txHash: "0xold", gasMon: 0.14, cancel: [], status: "sent", orderId: null, capped: false } });
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    methods.push(body.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
      result: body.method === "eth_getTransactionCount" ? "0x8" : null }));
  }) as typeof fetch;
  try {
    const send = market.send(20, "buy", 200, {} as any, [], false);
    const poll = market.pollPending(20); // exceeds the prior order's receipt deadline
    await Bun.sleep(0);
    release("0xdead");
    await expect(send).rejects.toThrow("Live send blocked");
    await poll;
    expect(methods).not.toContain("eth_sendRawTransaction");
    expect((market as any).nonce).toBe(8);
  } finally { globalThis.fetch = original; }
});

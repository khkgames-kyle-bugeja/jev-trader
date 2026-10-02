import { config } from "./config";
import type { Fill, Quote } from "./market";
import type { BlockEvent, Timing } from "./trader";

interface Meta { model: string; wallet: string | null; dryRun: boolean; market: string; startedAt: number }

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

/** GET / snapshot · GET /history recent blocks · GET /events SSE stream (`snapshot`, `block`, `quote`, `fill`, `ping`) */
export function startServer(meta: Meta, history: () => BlockEvent[]) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const timings: Timing[] = [];
  const percentiles = (values: number[]) => {
    if (!values.length) return { p50: null, p95: null, p99: null };
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
  };
  const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => {
    try { c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { clients.delete(c); }
  };
  setInterval(() => clients.forEach((c) => send(c, "ping", Date.now())), 15_000);

  Bun.serve({
    port: config.port,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (pathname === "/") return json({ ...meta, latest: history().at(-1) ?? null });
      if (pathname === "/health") {
        const latest = history().at(-1);
        const ageMs = latest ? Date.now() - latest.ts : null;
        return json({ ready: ageMs !== null && ageMs < 5000, dryRun: meta.dryRun,
          lastBlock: latest?.block ?? null, ageMs, pauseReason: latest?.pauseReason ?? null });
      }
      if (pathname === "/metrics") return json({ sampleCount: timings.length,
        readMs: percentiles(timings.map((t) => t.readMs)),
        loopMs: percentiles(timings.map((t) => t.loopMs)),
        totals: history().at(-1)?.totals ?? null });
      if (pathname === "/history") return json(history());
      if (pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) { clients.add(c); send(c, "snapshot", { ...meta, history: history() }); },
          cancel(c) { clients.delete(c); },
        });
        return new Response(stream, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      return json({ error: "not found" }, 404);
    },
  });

  const broadcast = (type: string, data: unknown) => clients.forEach((c) => send(c, type, data));
  return {
    broadcast: (e: BlockEvent, timing?: Timing) => {
      if (timing) {
        timings.push(timing);
        if (timings.length > 1000) timings.shift();
      }
      broadcast("block", e);
    },
    /** A quote's receipt landed: placed (with order id) or reverted, and the real gas. */
    broadcastQuote: (block: number, quote: Quote) => broadcast("quote", { block, quote }),
    /** Risk-stop cancellation receipt, never a newly posted order. */
    broadcastCancel: (block: number, quote: Quote) => broadcast("cancel", { block, quote }),
    /** A taker hit one of our resting orders in `block`. */
    broadcastFill: (block: number, fill: Fill) => broadcast("fill", { block, fill }),
  };
}

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armLiveSession } from "../src/live-guard";

const identity = { chainId: 143, market: "0xmarket", wallet: "0xwallet" };

test("live sessions require a durable absolute directory", () => {
  expect(() => armLiveSession(undefined, identity)).toThrow("absolute LIVE_STATE_DIR");
  expect(() => armLiveSession("relative/path", identity)).toThrow("absolute LIVE_STATE_DIR");
  expect(() => armLiveSession("/not-an-existing-jev-volume", identity)).toThrow("existing directory");
});

test("arming creates a private marker and blocks any automatic restart", () => {
  mkdirSync("data", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "data", "jev-live-test-"));
  try {
    const file = armLiveSession(dir, identity);
    const data = JSON.parse(readFileSync(file, "utf8"));
    expect(data.wallet).toBe("0xwallet");
    expect(data.chainId).toBe(143);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => armLiveSession(dir, identity)).toThrow("Live restart blocked");
    expect(() => armLiveSession(dir, { ...identity, wallet: "0xother" })).toThrow("Live restart blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insecure and temporary state paths cannot arm a live session", () => {
  mkdirSync("data", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "data", "jev-live-public-"));
  const temp = mkdtempSync(join(tmpdir(), "jev-live-temp-"));
  try {
    chmodSync(dir, 0o777);
    expect(() => armLiveSession(dir, identity)).toThrow("mode 0700");
    expect(() => armLiveSession(temp, identity)).toThrow("temporary filesystem");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

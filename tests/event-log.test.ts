import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/event-log";

test("rotates the JSONL event log and keeps only one prior segment", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-events-test-"));
  const file = join(dir, "events.jsonl");
  try {
    const log = new EventLog(file, 90);
    for (let i = 0; i < 20; i++) log.append({ block: i, note: "test" });
    expect(existsSync(file + ".1")).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(90);
    expect(statSync(file + ".1").size).toBeLessThanOrEqual(90);
    const current = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    expect(current.at(-1).block).toBe(19);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

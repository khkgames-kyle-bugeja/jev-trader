import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Two bounded JSONL files: current and one rotated archive. In-memory SSE history is separate. */
export class EventLog {
  private size: number;
  constructor(private file: string, private maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("MAX_EVENT_LOG_MB must be positive");
    mkdirSync(dirname(file), { recursive: true });
    this.size = existsSync(file) ? statSync(file).size : 0;
  }

  append(event: unknown) {
    const line = JSON.stringify(event) + "\n";
    const bytes = Buffer.byteLength(line);
    if (this.size && this.size + bytes > this.maxBytes) {
      rmSync(this.file + ".1", { force: true });
      renameSync(this.file, this.file + ".1");
      this.size = 0;
    }
    appendFileSync(this.file, line);
    this.size += bytes;
  }
}

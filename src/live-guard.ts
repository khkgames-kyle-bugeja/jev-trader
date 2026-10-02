import { closeSync, existsSync, fsyncSync, lstatSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface LiveSessionIdentity { chainId: number; market: string; wallet: string }

/**
 * A durable single-run tripwire, NOT order reconciliation. It must be armed before
 * deposits or transactions. An existing marker prevents automatic live restarts.
 * An operator must inspect the wallet's orders, pending txs and balances before
 * intentionally removing it. The directory MUST be a persistent private volume.
 */
export function armLiveSession(dir: string | undefined, identity: LiveSessionIdentity): string {
  if (!dir || !isAbsolute(dir)) throw new Error("Live mode requires an absolute LIVE_STATE_DIR on a persistent private volume");
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new Error(`LIVE_STATE_DIR must be an existing directory: ${dir}`);
  const realDir = realpathSync(dir);
  if (["/tmp", "/var/tmp", "/dev/shm", "/run"].some((p) => realDir === p || realDir.startsWith(p + "/")))
    throw new Error("LIVE_STATE_DIR cannot be under a known temporary filesystem");
  const st = statSync(realDir);
  if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
    throw new Error("LIVE_STATE_DIR must be owned by the current user with mode 0700");
  const file = join(realDir, "jev-live-session.json");
  const record = { ...identity, armedAt: new Date().toISOString(), warning: "Do not delete until on-chain orders, pending transactions and inventory have been reconciled." };
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(record, null, 2) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const dirFd = openSync(realDir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Live restart blocked by ${file}. Reconcile all orders, pending transactions and balances manually before any new live session.`);
    throw e;
  }
  return file;
}

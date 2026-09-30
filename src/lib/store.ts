// The console's checkpoint store: one shared CheckpointStore for the whole
// server process, kept on globalThis so it survives Next.js dev hot-reloads.
//
// Every change is appended to a tamper-evident audit log
// (.aegis/audit.jsonl by default), and on startup the store is rebuilt from
// it, so history survives restarts.

import { join } from "node:path";
import { AuditLog } from "../../core/audit";
import { CheckpointStore } from "../../core/checkpoints";

function createStore(): CheckpointStore {
  const store = new CheckpointStore();
  const path = join(process.env.AEGIS_DATA_DIR ?? ".aegis", "audit.jsonl");
  try {
    const log = new AuditLog(path);
    store.restore(log.latestCheckpoints());
    store.onEvent((event, checkpoint) => {
      try {
        log.append(event, checkpoint);
      } catch (e) {
        console.error(`[aegis] could not write audit log: ${(e as Error).message}`);
      }
    });
  } catch (e) {
    // e.g. a read-only filesystem on a hosted demo, or a tampered log.
    console.error(`[aegis] audit log disabled: ${(e as Error).message}`);
  }
  return store;
}

const g = globalThis as unknown as { __aegisStore?: CheckpointStore };
export const store = (g.__aegisStore ??= createStore());

// The console's state: one shared CheckpointStore plus the earned-trust
// grants, kept on globalThis so they survive Next.js dev hot-reloads.
//
// Every change is appended to a tamper-evident audit log
// (.aegis/audit.jsonl by default), and on startup both are rebuilt from it,
// so history survives restarts.

import { join } from "node:path";
import { AuditLog, type TrustEvent } from "../../core/audit";
import { CheckpointStore } from "../../core/checkpoints";
import { DEFAULT_MIN_APPROVALS, suggestTrust, type TrustGrant } from "../../core/trust";

interface ConsoleState {
  store: CheckpointStore;
  grants: TrustGrant[];
  log?: AuditLog;
}

function createState(): ConsoleState {
  const state: ConsoleState = { store: new CheckpointStore(), grants: [] };
  const path = join(process.env.AEGIS_DATA_DIR ?? ".aegis", "audit.jsonl");
  try {
    const log = new AuditLog(path);
    state.log = log;
    state.store.restore(log.latestCheckpoints());
    state.grants = log.latestGrants();
    state.store.onEvent((event, checkpoint) => {
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
  return state;
}

const g = globalThis as unknown as { __aegisState?: ConsoleState };
const state = (g.__aegisState ??= createState());

export const store = state.store;

const minApprovals = Number(process.env.AEGIS_TRUST_MIN_APPROVALS ?? DEFAULT_MIN_APPROVALS);

export const trust = {
  grants: () => state.grants,
  suggestions: () => suggestTrust(store.list(), state.grants, { minApprovals }),

  // Accept a suggestion. Recomputed here, never taken from the browser, so
  // a grant can only ever match what humans actually approved.
  grant(key: string): TrustGrant | undefined {
    const s = trust.suggestions().find((x) => x.key === key);
    if (!s) return undefined;
    const grant: TrustGrant = { ...s, id: crypto.randomUUID(), grantedAt: Date.now() };
    state.grants.push(grant);
    record("trust-granted", grant);
    return grant;
  },

  revoke(id: string): TrustGrant | undefined {
    const grant = state.grants.find((x) => x.id === id && !x.revokedAt);
    if (!grant) return undefined;
    grant.revokedAt = Date.now();
    record("trust-revoked", grant);
    return grant;
  },
};

function record(event: TrustEvent, grant: TrustGrant) {
  try {
    state.log?.appendTrust(event, grant);
  } catch (e) {
    console.error(`[aegis] could not write audit log: ${(e as Error).message}`);
  }
}

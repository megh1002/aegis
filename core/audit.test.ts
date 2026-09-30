import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, verifyAudit } from "./audit";
import { CheckpointStore } from "./checkpoints";
import type { Verdict } from "./types";

const escalate: Verdict = { decision: "escalate", matchedRules: ["r"], explanation: "Needs a human." };
const allow: Verdict = { decision: "allow", matchedRules: ["r"], explanation: "Allowed." };

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), "aegis-audit-")), "audit.jsonl");
  const log = new AuditLog(path);
  const store = new CheckpointStore();
  store.onEvent((event, c) => log.append(event, c));
  return { path, log, store };
}

function runSomeActions(store: CheckpointStore) {
  store.create({ action: { agent: "a", tool: "read_logs" }, verdict: allow, readOnly: true });
  const held = store.create({
    action: { agent: "a", tool: "scale_service", params: { service: "api", replicas: 20 } },
    verdict: escalate,
  });
  store.decide(held.checkpoint.id, "approved", { service: "api", replicas: 5 });
  store.recordResult(held.checkpoint.id, { ok: true, summary: "Scaled api to 5." });
}

describe("Audit log", () => {
  it("records every event, in order, and verifies", () => {
    const { path, log, store } = setup();
    runSomeActions(store);
    expect(log.entries().map((e) => e.event)).toEqual(["created", "created", "decided", "executed"]);
    expect(verifyAudit(readFileSync(path, "utf8"))).toEqual({ ok: true, entries: 4 });
  });

  it("keeps the human's edit and what actually ran", () => {
    const { log, store } = setup();
    runSomeActions(store);
    const last = log.entries().at(-1)!.checkpoint;
    expect(last.action.params?.replicas).toBe(20);
    expect(last.edit?.changes).toEqual([{ key: "replicas", from: 20, to: 5 }]);
    expect(last.execution?.summary).toBe("Scaled api to 5.");
  });

  it("detects a changed line", () => {
    const { path, store } = setup();
    runSomeActions(store);
    // Someone rewrites history: the human "rejected" instead of approved.
    const lines = readFileSync(path, "utf8").split("\n");
    lines[2] = lines[2].replace('"status":"approved"', '"status":"rejected"');
    writeFileSync(path, lines.join("\n"));
    expect(verifyAudit(readFileSync(path, "utf8"))).toMatchObject({ ok: false, line: 3, problem: /changed/ });
  });

  it("detects a deleted line", () => {
    const { path, store } = setup();
    runSomeActions(store);
    const lines = readFileSync(path, "utf8").split("\n");
    lines.splice(1, 1);
    writeFileSync(path, lines.join("\n"));
    expect(verifyAudit(readFileSync(path, "utf8"))).toMatchObject({ ok: false, line: 2 });
  });

  it("refuses to keep writing onto a tampered log", () => {
    const { path, store } = setup();
    runSomeActions(store);
    writeFileSync(path, readFileSync(path, "utf8").replace("Scaled api to 5.", "Scaled api to 50."));
    expect(() => new AuditLog(path)).toThrow(/failed verification/);
  });

  it("rebuilds the store after a restart", () => {
    const { path, store } = setup();
    runSomeActions(store);
    const restarted = new CheckpointStore();
    restarted.restore(new AuditLog(path).latestCheckpoints());
    expect(restarted.list()).toHaveLength(2);
    expect(restarted.list().find((c) => c.edit)?.execution?.ok).toBe(true);
  });
});

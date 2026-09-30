// The audit log: a permanent, append-only record of every checkpoint event,
// one JSON line per event, written to a file.
//
// Tamper-evident: each entry stores the hash of the entry before it, and its
// own hash covers that. Change, delete or reorder any past line and every
// hash after it stops matching, so `verifyAudit` points at the first broken
// line. (It detects tampering; it can't prevent someone deleting the file.)

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Checkpoint, CheckpointEvent } from "./checkpoints";

export interface AuditEntry {
  seq: number;
  at: number;
  event: CheckpointEvent;
  checkpoint: Checkpoint;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function hashOf(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

export type VerifyResult =
  | { ok: true; entries: number }
  | { ok: false; line: number; problem: string };

export function verifyAudit(text: string): VerifyResult {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let prevHash = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { ok: false, line: i + 1, problem: "not valid JSON" };
    }
    const { hash, ...rest } = entry;
    if (entry.seq !== i + 1) return { ok: false, line: i + 1, problem: `expected entry #${i + 1}, found #${entry.seq}` };
    if (entry.prevHash !== prevHash) return { ok: false, line: i + 1, problem: "doesn't link to the entry before it" };
    if (hashOf(rest) !== hash) return { ok: false, line: i + 1, problem: "contents were changed after writing" };
    prevHash = hash;
  }
  return { ok: true, entries: lines.length };
}

export class AuditLog {
  private seq = 0;
  private prevHash = GENESIS;

  constructor(private path: string) {
    if (!existsSync(path)) return;
    const check = verifyAudit(readFileSync(path, "utf8"));
    if (!check.ok) {
      // Refuse to keep writing onto a chain that's already broken.
      throw new Error(`Audit log ${path} failed verification at line ${check.line}: ${check.problem}`);
    }
    const last = this.entries().at(-1);
    if (last) {
      this.seq = last.seq;
      this.prevHash = last.hash;
    }
  }

  append(event: CheckpointEvent, checkpoint: Checkpoint) {
    const body = { seq: this.seq + 1, at: Date.now(), event, checkpoint, prevHash: this.prevHash };
    const entry: AuditEntry = { ...body, hash: hashOf(body) };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    this.seq = entry.seq;
    this.prevHash = entry.hash;
  }

  entries(): AuditEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  }

  // The latest state of every checkpoint, for rebuilding the store on restart.
  latestCheckpoints(): Checkpoint[] {
    const latest = new Map<string, Checkpoint>();
    for (const e of this.entries()) latest.set(e.checkpoint.id, e.checkpoint);
    return [...latest.values()];
  }
}

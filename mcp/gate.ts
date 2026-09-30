// A gate is where the proxy asks "may this action run?". The real one talks
// to the Aegis console over HTTP. Tests use an in-memory one.

import { CheckpointStore, type Change, type Checkpoint, type NewCheckpoint } from "../core/checkpoints";
import type { Params } from "../core/types";

export interface GateResult {
  approved: boolean;
  // Shown to the agent when the action doesn't run.
  reason: string;
  checkpointId?: string;
  // Set when a human approved a changed version: run these params instead.
  params?: Params;
  changes?: Change[];
}

export interface WaitOptions {
  // The agent cancelled its request.
  signal?: AbortSignal;
  // Called while a human is deciding, so the proxy can tell the agent it's still waiting.
  onWaiting?: (waitedMs: number) => void;
}

export interface ExecutionResult {
  ok: boolean;
  summary: string;
}

export interface Gate {
  submit(request: NewCheckpoint, options?: WaitOptions): Promise<GateResult>;
  // After an approved action runs, record what happened.
  reportResult(checkpointId: string, result: ExecutionResult): Promise<void>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

function finalResult(c: Pick<Checkpoint, "id" | "status" | "verdict" | "edit">): GateResult {
  if (c.status !== "approved") return { approved: false, reason: explain(c.status, c.verdict.explanation), checkpointId: c.id };
  return { approved: true, reason: c.verdict.explanation, checkpointId: c.id, params: c.edit?.params, changes: c.edit?.changes };
}

function explain(status: string, explanation: string): string {
  switch (status) {
    case "rejected": return `A human rejected this action. (${explanation})`;
    case "expired": return `No human approved this in time, so it did not run. (${explanation})`;
    default: return `Not approved (${status}).`;
  }
}

/* ---------- the real gate: the Aegis console over HTTP ---------- */

export class ConsoleGate implements Gate {
  constructor(
    private baseUrl: string,
    private opts: { apiKey?: string; pollMs?: number; timeoutMs?: number } = {},
  ) {}

  private headers() {
    return {
      "Content-Type": "application/json",
      ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
    };
  }

  async submit(request: NewCheckpoint, { signal, onWaiting }: WaitOptions = {}): Promise<GateResult> {
    const timeoutMs = request.timeoutMs ?? this.opts.timeoutMs;

    // Fail closed: if Aegis can't record the action, the action doesn't run.
    // No record means no oversight, even for actions the policy allows.
    let created: { checkpoint: Checkpoint };
    try {
      const res = await fetch(`${this.baseUrl}/api/checkpoints`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ ...request, timeoutMs }),
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      created = await res.json();
    } catch (e) {
      return {
        approved: false,
        reason: `Aegis console unreachable at ${this.baseUrl} (${(e as Error).message}). Blocked, because Aegis fails closed.`,
      };
    }

    let checkpoint = created.checkpoint;
    const started = Date.now();
    const pollMs = this.opts.pollMs ?? 1000;
    // Safety net in case the console never answers: stop a little after
    // the checkpoint's own deadline and treat it as not approved.
    const giveUpAt = started + (timeoutMs ?? 5 * 60_000) + 10_000;

    while (checkpoint.status === "pending") {
      if (signal?.aborted) return { approved: false, reason: "The agent cancelled the request.", checkpointId: checkpoint.id };
      if (Date.now() > giveUpAt) return { approved: false, reason: "Timed out waiting for Aegis.", checkpointId: checkpoint.id };
      onWaiting?.(Date.now() - started);
      await sleep(pollMs, signal);
      try {
        const res = await fetch(`${this.baseUrl}/api/checkpoints/${checkpoint.id}`, { headers: this.headers(), signal });
        if (res.ok) checkpoint = (await res.json()).checkpoint;
      } catch {
        // The console blipped; keep waiting until the deadline.
      }
    }

    return finalResult(checkpoint);
  }

  async reportResult(checkpointId: string, result: ExecutionResult) {
    try {
      await fetch(`${this.baseUrl}/api/checkpoints/${checkpointId}/result`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(result),
      });
    } catch {
      // The action already ran; a missing result note must not break the agent.
    }
  }
}

/* ---------- an in-memory gate, for tests ---------- */

export type HumanAnswer = "approved" | "rejected" | "no answer" | { approvedWith: Params };

export class MemoryGate implements Gate {
  constructor(
    public store = new CheckpointStore(),
    // Decides escalated checkpoints, standing in for a human.
    private human: (c: Checkpoint) => HumanAnswer = () => "no answer",
  ) {}

  async submit(request: NewCheckpoint): Promise<GateResult> {
    const { checkpoint } = this.store.create(request);
    if (checkpoint.status === "pending") {
      const answer = this.human(checkpoint);
      if (answer === "no answer") {
        return { approved: false, reason: explain("expired", checkpoint.verdict.explanation), checkpointId: checkpoint.id };
      }
      const result =
        typeof answer === "string"
          ? this.store.decide(checkpoint.id, answer)
          : this.store.decide(checkpoint.id, "approved", answer.approvedWith);
      if (!result.ok) throw new Error(result.error);
    }
    return finalResult(this.store.get(checkpoint.id)!);
  }

  async reportResult(checkpointId: string, result: ExecutionResult) {
    this.store.recordResult(checkpointId, result);
  }
}

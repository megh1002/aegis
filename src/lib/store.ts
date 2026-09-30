// The console's checkpoint store: one shared CheckpointStore for the whole
// server process. Kept on globalThis so it survives Next.js dev hot-reloads.
//
// In memory for now: restarting the console clears history. A permanent
// audit log is milestone M3.

import { CheckpointStore } from "../../core/checkpoints";

const g = globalThis as unknown as { __aegisStore?: CheckpointStore };
export const store = (g.__aegisStore ??= new CheckpointStore());

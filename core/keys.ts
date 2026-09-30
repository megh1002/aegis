// Argument names that say *what* a tool acts on and *where*. The proxy uses
// them to find an action's target and environment; the checkpoint store uses
// them to stop a human edit from changing what or where an action runs.
export const TARGET_KEYS = ["target", "service", "resource", "name"];
export const ENV_KEYS = ["environment", "env"];
export const IDENTITY_KEYS = new Set([...TARGET_KEYS, ...ENV_KEYS]);

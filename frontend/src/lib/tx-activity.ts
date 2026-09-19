/**
 * Transaction activity: every write that goes through useTx is tracked here so the global toast stack (TxToasts)
 * and the buttons can show where it is. Phases:
 *   preparing  – switching network / simulating (our side, ~0.5 s)
 *   signing    – the wallet prompt is open, waiting for the user
 *   confirming – sent; waiting for the receipt (a few seconds on X Layer)
 *   success | error
 */
export type TxPhase = "idle" | "preparing" | "signing" | "confirming" | "success" | "error";

export interface TxActivity {
  id: number;
  /** i18n key + vars naming the action ("tx.fn.optIn"). */
  label: { key: string; vars?: Record<string, string | number> };
  phase: TxPhase;
  hash?: `0x${string}`;
  error?: Error;
  startedAt: number;
  updatedAt: number;
}

type Listener = () => void;

let items: TxActivity[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

// ---- pure reducers (tested) ----

export function addActivity(list: TxActivity[], a: TxActivity, max = 5): TxActivity[] {
  return [...list.filter((x) => x.id !== a.id), a].slice(-max);
}

export function patchActivity(list: TxActivity[], id: number, patch: Partial<TxActivity>, now: number): TxActivity[] {
  return list.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: now } : x));
}

/** Finished entries leave after `ttlMs`; in-flight ones stay. */
export function pruneActivity(list: TxActivity[], now: number, ttlMs = { success: 5000, error: 9000 }): TxActivity[] {
  return list.filter((x) =>
    x.phase === "success" ? now - x.updatedAt < ttlMs.success : x.phase === "error" ? now - x.updatedAt < ttlMs.error : true,
  );
}

// ---- store ----

export const txActivity = {
  start(label: TxActivity["label"]): number {
    const now = Date.now();
    const id = nextId++;
    items = addActivity(items, { id, label, phase: "preparing", startedAt: now, updatedAt: now });
    emit();
    return id;
  },
  update(id: number, patch: Partial<TxActivity>): void {
    const cur = items.find((x) => x.id === id);
    if (!cur) return;
    if (Object.entries(patch).every(([k, v]) => cur[k as keyof TxActivity] === v)) return;
    items = patchActivity(items, id, patch, Date.now());
    emit();
  },
  dismiss(id: number): void {
    items = items.filter((x) => x.id !== id);
    emit();
  },
  prune(): void {
    const next = pruneActivity(items, Date.now());
    if (next.length !== items.length) {
      items = next;
      emit();
    }
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  snapshot(): TxActivity[] {
    return items;
  },
};

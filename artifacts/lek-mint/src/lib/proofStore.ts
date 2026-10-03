import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Proof } from "@workspace/api-client-react";

/**
 * Offline-first wallet storage backed by IndexedDB.
 *
 * Stores:
 *  - proofs:        the ecash proofs the user owns (keyed by secret)
 *  - mintRequests:  pending/known mint (deposit) requests so an in-flight
 *                   mint flow survives reloads
 *  - blindings:     blinding data for outputs we've sent to the mint but not
 *                   yet unblinded (crash recovery for issue/swap/upgrade)
 *  - history:       lightweight local activity log
 */

export interface StoredMintRequest {
  id: string;
  btcAddress: string;
  createdAt: string;
  /** Last known status string from the mint */
  status: string;
  /** Set once tokens for this request have been issued and stored */
  completed: boolean;
}

export interface StoredBlinding {
  /** B_ hex — primary key; matches the output sent to the mint */
  B_: string;
  secret: string;
  r: string;
  amount: number;
  keysetId: string;
  /** What operation these outputs belong to (issue/swap/upgrade) + context id */
  context: string;
  createdAt: string;
}

export interface HistoryEntry {
  id?: number;
  type: "mint" | "send" | "receive" | "redeem" | "upgrade" | "swap";
  amount: number;
  detail?: string;
  /**
   * For "send" entries: the full bearer token string, persisted durably
   * BEFORE the backing proofs are removed, so a crash or accidental
   * navigation never loses the funds.
   */
  token?: string;
  createdAt: string;
}

interface WalletDB extends DBSchema {
  proofs: { key: string; value: Proof };
  mintRequests: { key: string; value: StoredMintRequest };
  blindings: { key: string; value: StoredBlinding };
  history: {
    key: number;
    value: HistoryEntry;
    indexes: { byDate: string };
  };
}

let dbPromise: Promise<IDBPDatabase<WalletDB>> | null = null;

function getDB(): Promise<IDBPDatabase<WalletDB>> {
  if (!dbPromise) {
    dbPromise = openDB<WalletDB>("lek-wallet", 1, {
      upgrade(db) {
        db.createObjectStore("proofs", { keyPath: "secret" });
        db.createObjectStore("mintRequests", { keyPath: "id" });
        db.createObjectStore("blindings", { keyPath: "B_" });
        const history = db.createObjectStore("history", {
          keyPath: "id",
          autoIncrement: true,
        });
        history.createIndex("byDate", "createdAt");
      },
    });
  }
  return dbPromise;
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to any wallet mutation (for React state refresh). */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const l of listeners) l();
}

// ---------- proofs ----------

export async function getAllProofs(): Promise<Proof[]> {
  const db = await getDB();
  return db.getAll("proofs");
}

export async function getBalance(): Promise<number> {
  const proofs = await getAllProofs();
  return proofs.reduce((sum, p) => sum + p.amount, 0);
}

export async function addProofs(proofs: Proof[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("proofs", "readwrite");
  await Promise.all(proofs.map((p) => tx.store.put(p)));
  await tx.done;
  notify();
}

/** Remove proofs by their secrets (after spending/sending them). */
export async function removeProofs(secrets: string[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("proofs", "readwrite");
  await Promise.all(secrets.map((s) => tx.store.delete(s)));
  await tx.done;
  notify();
}

// ---------- mint requests ----------

export async function saveMintRequest(req: StoredMintRequest): Promise<void> {
  const db = await getDB();
  await db.put("mintRequests", req);
  notify();
}

export async function getMintRequests(): Promise<StoredMintRequest[]> {
  const db = await getDB();
  const all = await db.getAll("mintRequests");
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getPendingMintRequest(): Promise<StoredMintRequest | undefined> {
  const all = await getMintRequests();
  return all.find((r) => !r.completed);
}

export async function deleteMintRequest(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("mintRequests", id);
  notify();
}

// ---------- blindings (crash recovery) ----------

export async function saveBlindings(items: StoredBlinding[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("blindings", "readwrite");
  await Promise.all(items.map((b) => tx.store.put(b)));
  await tx.done;
}

export async function getAllBlindings(): Promise<StoredBlinding[]> {
  const db = await getDB();
  return db.getAll("blindings");
}
export async function getBlindingsByContext(context: string): Promise<StoredBlinding[]> {
  const db = await getDB();
  const all = await db.getAll("blindings");
  return all.filter((b) => b.context === context);
}

/** Look up saved blindings by their blinded points (escrow redelivery). */
export async function getBlindingsByBValues(bValues: string[]): Promise<StoredBlinding[]> {
  const db = await getDB();
  const found = await Promise.all(bValues.map((b) => db.get("blindings", b)));
  return found.filter((b): b is StoredBlinding => b !== undefined);
}

export async function deleteBlindings(bValues: string[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("blindings", "readwrite");
  await Promise.all(bValues.map((b) => tx.store.delete(b)));
  await tx.done;
}

// ---------- history ----------

export async function addHistory(entry: Omit<HistoryEntry, "id">): Promise<void> {
  const db = await getDB();
  await db.add("history", entry as HistoryEntry);
  notify();
}

export async function getHistory(limit = 50): Promise<HistoryEntry[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("history", "byDate");
  return all.reverse().slice(0, limit);
}

/** Read-only, consistent backup; never spends, deletes, or changes any store. */
export async function getWalletBackup() {
  const db = await getDB();
  const tx = db.transaction(["proofs", "mintRequests", "blindings", "history"], "readonly");
  const [proofs, mintRequests, blindings, history] = await Promise.all([
    tx.objectStore("proofs").getAll(),
    tx.objectStore("mintRequests").getAll(),
    tx.objectStore("blindings").getAll(),
    tx.objectStore("history").getAll(),
  ]);
  await tx.done;
  return { proofs, mintRequests, blindings, history };
}

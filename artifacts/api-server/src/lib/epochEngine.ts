import { db, epochsTable, keysetsTable } from "@workspace/db";
import type { Epoch } from "@workspace/db";
import { asc, desc, eq, sql } from "drizzle-orm";
import { buildNewKeyset } from "./keysetManager";
import { logger } from "./logger";
import { operationMode } from "./operationMode";

/**
 * Difficulty-pegged epoch engine.
 *
 * R_t = max(R_{t-1}, (D_t / max(1, S_t)) / C_0)
 *   D_t = network difficulty, S_t = block subsidy (sats),
 *   C_0 = D_0 / max(1, S_0) at mint inception  =>  R_0 = 1.
 *
 * All rate math is exact integer arithmetic on bigints:
 *   difficulty is scaled by 1e4 (matches numeric(40,4) storage),
 *   rates are scaled by 1e12 (matches numeric(40,12) storage).
 * Candidate rate: R = (D_t_s4 * max(1,S_0)) * 1e12 / (max(1,S_t) * D_0_s4)
 * — the 1e4 difficulty scaling cancels.
 *
 * High-Water Mark: a new epoch (and keyset) is created ONLY when the
 * candidate exceeds the stored rate. Difficulty drops or flat retargets
 * leave the current epoch/keyset untouched.
 */

const MEMPOOL_API_BASE = process.env.MEMPOOL_API_BASE ?? "https://mempool.space/api";
/**
 * Postgres advisory lock key serializing ALL keyset/epoch transitions
 * (difficulty-driven epoch rolls AND admin security rotations). Both
 * transactions take this xact-scoped lock first, so concurrent transitions
 * can never interleave and leave two active keysets behind.
 */
export const KEYSET_TRANSITION_LOCK_KEY = 0x1e4_5e7; // arbitrary, app-unique
const POLL_INTERVAL_MS = 10 * 60 * 1000; // difficulty changes every ~2 weeks
export const RATE_SCALE = 12; // decimal places
const RATE_SCALE_N = 10n ** 12n;
const DIFF_SCALE = 4;

/** Parse a decimal string (e.g. "123.4567") into a bigint scaled by 10^scale. */
export function parseDecimalScaled(value: string, scale: number): bigint {
  const [wholeRaw, fracRaw = ""] = value.trim().split(".");
  const negative = wholeRaw!.startsWith("-");
  const whole = wholeRaw!.replace("-", "") || "0";
  const frac = (fracRaw + "0".repeat(scale)).slice(0, scale);
  const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt(frac || "0");
  return negative ? -result : result;
}

/** Format a bigint scaled by 10^scale back into a decimal string. */
export function formatScaled(value: bigint, scale: number): string {
  const s = 10n ** BigInt(scale);
  const whole = value / s;
  const frac = (value % s).toString().padStart(scale, "0");
  return `${whole}.${frac}`;
}

/** Block subsidy in sats at a given height (halving every 210k blocks). */
export function subsidyAtHeight(height: number): number {
  const halvings = Math.floor(height / 210_000);
  if (halvings >= 33) {
    return 0;
  }
  return Math.floor(50_0000_0000 / 2 ** halvings);
}

interface ChainState {
  difficulty: string; // decimal string
  height: number;
  subsidySats: number;
}

export async function fetchChainState(): Promise<ChainState> {
  const res = await fetch(`${MEMPOOL_API_BASE}/v1/blocks`);
  if (!res.ok) {
    throw new Error(`mempool.space blocks -> HTTP ${res.status}`);
  }
  const blocks = (await res.json()) as Array<{ height: number; difficulty: number }>;
  const tip = blocks[0];
  if (!tip) {
    throw new Error("mempool.space returned no blocks");
  }
  return {
    difficulty: tip.difficulty.toFixed(DIFF_SCALE),
    height: tip.height,
    subsidySats: subsidyAtHeight(tip.height),
  };
}

export async function getGenesisEpoch(): Promise<Epoch | null> {
  const [row] = await db.select().from(epochsTable).orderBy(asc(epochsTable.id)).limit(1);
  return row ?? null;
}

export async function getCurrentEpoch(): Promise<Epoch | null> {
  const [row] = await db.select().from(epochsTable).orderBy(desc(epochsTable.id)).limit(1);
  return row ?? null;
}

export class EpochChangedError extends Error {
  constructor() {
    super("The epoch rate changed while processing this request; please retry");
  }
}

/**
 * Bind a precomputed epoch valuation to the transaction's locked snapshot.
 * MUST be called inside the transaction AFTER assertKeysetsFresh (which takes
 * the keyset-transition advisory lock shared) — re-reads the current epoch
 * under that lock and throws EpochChangedError if a rollover committed
 * between the preflight conversion and the lock acquisition. Without this, a
 * redeem/swap/issue could spend or sign at a stale rate.
 */
export async function assertEpochCurrent(
  tx: { select: typeof db.select },
  expectedEpochId: number,
): Promise<void> {
  const [row] = await tx.select().from(epochsTable).orderBy(desc(epochsTable.id)).limit(1);
  if (!row || row.id !== expectedEpochId) {
    throw new EpochChangedError();
  }
}

export async function getEpochByKeysetId(keysetId: string): Promise<Epoch | null> {
  const [row] = await db.select().from(epochsTable).where(eq(epochsTable.keysetId, keysetId)).limit(1);
  return row ?? null;
}

/**
 * Candidate rate for current chain state, scaled by 1e12.
 * R = (D_t * max(1, S_0)) / (max(1, S_t) * D_0)
 */
function candidateRateScaled(genesis: Epoch, state: ChainState): bigint {
  const d0 = parseDecimalScaled(genesis.difficulty, DIFF_SCALE);
  const dt = parseDecimalScaled(state.difficulty, DIFF_SCALE);
  const s0 = BigInt(Math.max(1, genesis.subsidySats));
  const st = BigInt(Math.max(1, state.subsidySats));
  return (dt * s0 * RATE_SCALE_N) / (st * d0);
}

/**
 * First-boot initialization: records the genesis epoch (R_0 = 1) and its
 * keyset. C_0 is implicitly D_0 / max(1, S_0) from the genesis row.
 */
export async function ensureGenesis(): Promise<void> {
  const existing = await getGenesisEpoch();
  if (existing) {
    return;
  }
  const state = await fetchChainState();
  const keyset = buildNewKeyset(1);
  await db.transaction(async (tx) => {
    const [epoch] = await tx
      .insert(epochsTable)
      .values({
        keysetId: keyset.id,
        rateIndex: formatScaled(RATE_SCALE_N, RATE_SCALE), // 1.000000000000
        difficulty: state.difficulty,
        subsidySats: state.subsidySats,
      })
      .returning();
    await tx.insert(keysetsTable).values({
      id: keyset.id,
      unit: "lek",
      active: true,
      epochId: epoch!.id,
      encryptedKeys: keyset.encryptedKeys,
    });
  });
  logger.info(
    { difficulty: state.difficulty, subsidySats: state.subsidySats, keysetId: keyset.id },
    "Genesis epoch recorded (R_0 = 1)",
  );
}

/**
 * One poll cycle: recompute the candidate rate; if it exceeds the HWM,
 * create a new epoch + keyset and atomically shift the active flag.
 */
export async function checkEpochOnce(): Promise<void> {
  const [genesis, current] = await Promise.all([getGenesisEpoch(), getCurrentEpoch()]);
  if (!genesis || !current) {
    await ensureGenesis(); // retry genesis init until it succeeds
    return;
  }
  const state = await fetchChainState();
  const candidate = candidateRateScaled(genesis, state);
  const currentRate = parseDecimalScaled(current.rateIndex, RATE_SCALE);
  if (candidate <= currentRate) {
    return; // HWM holds — keyset rolls over unchanged
  }
  const keyset = buildNewKeyset(current.id + 1);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${KEYSET_TRANSITION_LOCK_KEY})`);
    // Re-check under the lock: if another transition (epoch roll in another
    // process, or an admin rotation) happened since we read `current`, skip
    // this cycle — the next poll re-evaluates against fresh state.
    const [latest] = await tx.select().from(epochsTable).orderBy(desc(epochsTable.id)).limit(1);
    if (!latest || latest.id !== current.id) {
      return;
    }
    const [epoch] = await tx
      .insert(epochsTable)
      .values({
        keysetId: keyset.id,
        rateIndex: formatScaled(candidate, RATE_SCALE),
        difficulty: state.difficulty,
        subsidySats: state.subsidySats,
      })
      .returning();
    await tx.update(keysetsTable).set({ active: false }).where(eq(keysetsTable.active, true));
    await tx.insert(keysetsTable).values({
      id: keyset.id,
      unit: "lek",
      active: true,
      epochId: epoch!.id,
      encryptedKeys: keyset.encryptedKeys,
    });
  });
  logger.info(
    { newRate: formatScaled(candidate, RATE_SCALE), keysetId: keyset.id },
    "New epoch: rate index rose above HWM, keyset rotated",
  );
}

/**
 * Cross-epoch value conversion: V_out = floor(sum_k(V_k * R_current / R_k)).
 * Each term is computed exactly at 1e12 precision; the floored total is the
 * payout and the fractional remainder is the dust that accrues to the
 * treasury (solvency buffer).
 */
/**
 * Resolve each proof's vintage epoch rate and convert the set to `toRate`.
 * THE single entry point for valuing proofs at the current epoch — swap,
 * redeem, and upgrade must all go through this so no spend path can burn
 * old-epoch proofs at stale face value. Throws when a proof's keyset has no
 * epoch (never guess a rate).
 */
export async function convertProofsToRate(
  proofs: Array<{ id: string; amount: number }>,
  toRate: string,
): Promise<{ faceTotal: number; value: number; dust: string; hasVintage: boolean }> {
  const rateByKeyset = new Map<string, string>();
  const items: Array<{ amount: number; fromRate: string }> = [];
  for (const proof of proofs) {
    let fromRate = rateByKeyset.get(proof.id);
    if (!fromRate) {
      const epoch = await getEpochByKeysetId(proof.id);
      if (!epoch) {
        throw new NoEpochForKeysetError(proof.id);
      }
      fromRate = epoch.rateIndex;
      rateByKeyset.set(proof.id, fromRate);
    }
    items.push({ amount: proof.amount, fromRate });
  }
  const faceTotal = proofs.reduce((sum, p) => sum + p.amount, 0);
  const { value, dust } = convertValueMulti(items, toRate);
  const hasVintage = [...rateByKeyset.values()].some((r) => r !== toRate);
  return { faceTotal, value, dust, hasVintage };
}

export class NoEpochForKeysetError extends Error {
  constructor(keysetId: string) {
    super(`No epoch found for keyset ${keysetId}`);
  }
}

export const ZERO_DUST = `0.${"0".repeat(RATE_SCALE)}`;

/** Exact addition of two RATE_SCALE decimal strings (dust bookkeeping). */
export function addDustAmounts(a: string, b: string): string {
  return formatScaled(
    parseDecimalScaled(a, RATE_SCALE) + parseDecimalScaled(b, RATE_SCALE),
    RATE_SCALE,
  );
}

export function convertValueMulti(
  items: Array<{ amount: number; fromRate: string }>,
  toRate: string,
): { value: number; dust: string } {
  const rc = parseDecimalScaled(toRate, RATE_SCALE);
  let totalScaled = 0n; // sum of V_k * Rc / Rk, scaled by 1e12
  for (const item of items) {
    const rk = parseDecimalScaled(item.fromRate, RATE_SCALE);
    if (rk <= 0n) {
      throw new Error("Invalid source epoch rate");
    }
    totalScaled += (BigInt(item.amount) * rc * RATE_SCALE_N) / rk;
  }
  const value = totalScaled / RATE_SCALE_N;
  const dustScaled = totalScaled % RATE_SCALE_N;
  return { value: Number(value), dust: formatScaled(dustScaled, RATE_SCALE) };
}

let epochPollRunning = false;
let epochTimer: ReturnType<typeof setInterval> | undefined;
let epochCycle: Promise<void> | undefined;

export function startEpochEngine(): void {
  if (operationMode !== "active" || epochTimer) return;
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Epoch engine started");
  epochTimer = setInterval(() => {
    if (epochPollRunning) {
      return;
    }
    epochPollRunning = true;
    epochCycle = checkEpochOnce()
      .catch((err) => { logger.warn({ err }, "Epoch check failed; will retry"); })
      .finally(() => { epochPollRunning = false; });
  }, POLL_INTERVAL_MS);
}

export async function stopEpochEngine(): Promise<void> {
  clearInterval(epochTimer);
  epochTimer = undefined;
  await epochCycle;
}

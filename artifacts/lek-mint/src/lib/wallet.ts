import type {
  BlindedMessage,
  BlindSignature,
  Proof,
} from "@workspace/api-client-react";
import {
  blindMessage,
  generateSecret,
  unblindSignature,
  verifyDleq,
  type BlindingData,
} from "./cashuCrypto";
import { encodeToken, type TokenV3 } from "./tokenCodec";

/**
 * High-level wallet helpers on top of the BDHKE primitives.
 *
 * The mint issues denominations in powers of two, 1 .. 16384 leks.
 */

export const MAX_DENOMINATION = 16384;

export const UNIT = "lek";

/**
 * Split an amount into mint denominations (powers of two, capped at 16384).
 * Greedy: repeat 16384 while the remainder allows, then binary decomposition.
 */
export function splitAmount(amount: number): number[] {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`Cannot split non-positive amount: ${amount}`);
  }
  const parts: number[] = [];
  let remaining = amount;
  while (remaining >= MAX_DENOMINATION) {
    parts.push(MAX_DENOMINATION);
    remaining -= MAX_DENOMINATION;
  }
  for (let bit = 0; remaining > 0; bit++) {
    if (remaining & 1) parts.push(2 ** bit);
    remaining >>= 1;
  }
  return parts.sort((a, b) => b - a);
}

export interface OutputsWithBlindings {
  outputs: BlindedMessage[];
  blindings: (BlindingData & { amount: number; keysetId: string })[];
}

/**
 * Create blinded outputs totaling `amount` in the given keyset.
 * Keep the returned blindings private — they are needed to unblind.
 */
export function createBlindedOutputs(
  amount: number,
  keysetId: string,
): OutputsWithBlindings {
  const denominations = splitAmount(amount);
  const blindings = denominations.map((denom) => {
    const data = blindMessage(generateSecret());
    return { ...data, amount: denom, keysetId };
  });
  const outputs: BlindedMessage[] = blindings.map((b) => ({
    id: b.keysetId,
    amount: b.amount,
    B_: b.B_,
  }));
  return { outputs, blindings };
}

export class DleqVerificationError extends Error {
  constructor(message = "The mint's signature failed DLEQ verification") {
    super(message);
  }
}

/**
 * Unblind the mint's blind signatures into spendable proofs.
 *
 * `keysByAmount` maps denomination -> mint pubkey hex for the keyset the
 * outputs were created in (from GET /api/keys or /api/keys?keyset_id=..).
 * Signatures are matched to blindings by array order (the mint signs outputs
 * in request order), with amounts cross-checked.
 * Every signature's DLEQ proof is verified; throws DleqVerificationError on
 * any failure — do NOT store proofs in that case.
 */
export function unblindSignatures(
  signatures: BlindSignature[],
  blindings: OutputsWithBlindings["blindings"],
  keysByAmount: Record<string, string>,
): Proof[] {
  if (signatures.length !== blindings.length) {
    throw new Error(
      `Signature count (${signatures.length}) does not match outputs (${blindings.length})`,
    );
  }
  return signatures.map((sig, i) => {
    const blinding = blindings[i];
    if (sig.amount !== blinding.amount) {
      throw new Error(
        `Signature amount mismatch at index ${i}: ${sig.amount} != ${blinding.amount}`,
      );
    }
    const mintPubkey = keysByAmount[String(sig.amount)];
    if (!mintPubkey) {
      throw new Error(`No mint pubkey published for denomination ${sig.amount}`);
    }
    if (!sig.dleq || !verifyDleq(blinding.B_, sig.C_, mintPubkey, sig.dleq)) {
      throw new DleqVerificationError();
    }
    const C = unblindSignature(sig.C_, blinding.r, mintPubkey);
    return { id: sig.id, amount: sig.amount, secret: blinding.secret, C };
  });
}

export function sumProofs(proofs: Proof[]): number {
  return proofs.reduce((sum, p) => sum + p.amount, 0);
}

export interface ProofSelection {
  /** Proofs to hand over / spend */
  send: Proof[];
  /** true when an exact subset was found — can send fully offline */
  exact: boolean;
  /** Total of `send`; equals amount when exact */
  total: number;
}

export class InsufficientBalanceError extends Error {
  constructor(
    public requested: number,
    public available: number,
  ) {
    super(`Insufficient balance: need ${requested}, have ${available}`);
  }
}

/**
 * Select proofs to cover `amount`.
 *
 * Tries to find an exact-sum subset first (fully offline send). If none
 * exists, returns the smallest over-shooting selection — the caller must
 * swap online to get exact change before sending.
 */
export function selectProofs(proofs: Proof[], amount: number): ProofSelection {
  const available = sumProofs(proofs);
  if (amount <= 0 || !Number.isInteger(amount)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  if (available < amount) {
    throw new InsufficientBalanceError(amount, available);
  }

  // Exact subset via subset-sum DP over amounts (amounts are small powers of 2)
  const sorted = [...proofs].sort((a, b) => b.amount - a.amount);
  const exact = findExactSubset(sorted, amount);
  if (exact) {
    return { send: exact, exact: true, total: amount };
  }

  // Greedy minimal overshoot: take largest-first until covered
  const send: Proof[] = [];
  let total = 0;
  for (const p of sorted) {
    if (total >= amount) break;
    send.push(p);
    total += p.amount;
  }
  // Drop any proof whose removal keeps total >= amount (tighten selection)
  for (let i = send.length - 1; i >= 0; i--) {
    if (total - send[i].amount >= amount) {
      total -= send[i].amount;
      send.splice(i, 1);
    }
  }
  return { send, exact: total === amount, total };
}

function findExactSubset(sortedDesc: Proof[], target: number): Proof[] | null {
  // DP over reachable sums; capped to keep memory bounded for large wallets.
  if (target > 1_000_000 || sortedDesc.length > 512) {
    // Fall back to greedy exactness check only
    let total = 0;
    const pick: Proof[] = [];
    for (const p of sortedDesc) {
      if (total + p.amount <= target) {
        pick.push(p);
        total += p.amount;
        if (total === target) return pick;
      }
    }
    return total === target ? pick : null;
  }
  const from = new Map<number, { prev: number; proof: Proof }>();
  from.set(0, { prev: -1, proof: null as unknown as Proof });
  let sums = [0];
  for (const p of sortedDesc) {
    const next: number[] = [];
    for (const s of sums) {
      const ns = s + p.amount;
      if (ns <= target && !from.has(ns)) {
        from.set(ns, { prev: s, proof: p });
        if (ns === target) {
          // reconstruct
          const picked: Proof[] = [];
          let cur = target;
          while (cur !== 0) {
            const step = from.get(cur)!;
            picked.push(step.proof);
            cur = step.prev;
          }
          return picked;
        }
        next.push(ns);
      }
    }
    sums = sums.concat(next);
  }
  return null;
}

export interface MeltSwapPlan {
  /** The exact amount that will be burned. */
  amount: number;
  /** Blinded outputs to send to /swap: melt denominations FIRST, then change. */
  outputs: BlindedMessage[];
  /** Blindings in the same order as `outputs` (needed to unblind). */
  blindings: OutputsWithBlindings["blindings"];
  /** How many of the leading outputs/proofs belong to the melt amount. */
  meltOutputCount: number;
}

/**
 * Plan the swap for a non-exact melt: build blinded outputs for exactly
 * `amount` (to be burned) followed by the change (selection.total - amount).
 * The mint signs outputs in request order, so the first `meltOutputCount`
 * signatures/proofs are the melt denominations.
 */
export function planMeltSwap(
  selection: ProofSelection,
  amount: number,
  keysetId: string,
): MeltSwapPlan {
  const changeAmount = selection.total - amount;
  if (changeAmount <= 0) {
    throw new Error(
      `planMeltSwap requires an over-shooting selection (total ${selection.total}, amount ${amount})`,
    );
  }
  const melt = createBlindedOutputs(amount, keysetId);
  const change = createBlindedOutputs(changeAmount, keysetId);
  return {
    amount,
    outputs: [...melt.outputs, ...change.outputs],
    blindings: [...melt.blindings, ...change.blindings],
    meltOutputCount: melt.outputs.length,
  };
}

/**
 * Split the unblinded swap proofs into the proofs to burn and the change to
 * keep, per the plan's ordering. Throws if the melt slice does not sum to
 * EXACTLY the planned amount — the caller must never burn a different amount.
 */
export function partitionMeltProofs(
  plan: MeltSwapPlan,
  newProofs: Proof[],
): { meltProofs: Proof[]; changeProofs: Proof[] } {
  const meltProofs = newProofs.slice(0, plan.meltOutputCount);
  const changeProofs = newProofs.slice(plan.meltOutputCount);
  const meltTotal = sumProofs(meltProofs);
  if (meltTotal !== plan.amount) {
    throw new Error(
      `Melt partition mismatch: sliced proofs sum to ${meltTotal}, expected ${plan.amount}. Aborting burn.`,
    );
  }
  return { meltProofs, changeProofs };
}

/**
 * Split proofs into those from the ACTIVE keyset and those from older
 * (vintage) keysets. Vintage proofs must be upgraded before melting —
 * burning them at face value forfeits the R_current/R_vintage appreciation.
 */
export function partitionProofsByKeyset(
  proofs: Proof[],
  activeKeysetId: string,
): { active: Proof[]; vintage: Proof[] } {
  const active: Proof[] = [];
  const vintage: Proof[] = [];
  for (const p of proofs) {
    (p.id === activeKeysetId ? active : vintage).push(p);
  }
  return { active, vintage };
}

export class RateDataIncompleteError extends Error {
  constructor(keysetId: string) {
    super(
      `No epoch rate data for keyset ${keysetId} — cannot value these tokens honestly. Go online and refresh.`,
    );
  }
}

export interface UpgradePlan {
  /** Face value of the vintage proofs being upgraded. */
  oldValue: number;
  /** floor(sum V_k * R_current / R_k) — what the mint will sign. */
  newValue: number;
  /** Blinded outputs (active keyset) totaling newValue, for POST /mint/upgrade. */
  outputs: BlindedMessage[];
  /** Blindings in output order (needed to unblind). */
  blindings: OutputsWithBlindings["blindings"];
}

/**
 * Plan an epoch upgrade for vintage proofs: value them with the SAME rate
 * math the mint uses (projectUpgradeValue) and build the blinded outputs to
 * send to POST /mint/upgrade. Throws RateDataIncompleteError if any proof's
 * keyset has no published epoch rate — never guesses a value.
 *
 * Shared by the Update tab and the melt flow (which upgrades vintage proofs
 * before burning so users are always paid the current rate).
 */
export function planUpgrade(
  vintageProofs: Proof[],
  epochs: { keysetId: string; rateIndex: string }[],
  currentRateIndex: string,
  activeKeysetId: string,
): UpgradePlan {
  if (vintageProofs.length === 0) {
    throw new Error("planUpgrade requires at least one vintage proof");
  }
  const rateByKeyset = new Map(epochs.map((e) => [e.keysetId, e.rateIndex]));
  const proofsByKeyset: { amount: number; rateIndex: string }[] = [];
  for (const p of vintageProofs) {
    const rateIndex = rateByKeyset.get(p.id);
    if (!rateIndex) {
      throw new RateDataIncompleteError(p.id);
    }
    proofsByKeyset.push({ amount: p.amount, rateIndex });
  }
  const newValue = projectUpgradeValue(proofsByKeyset, currentRateIndex);
  if (newValue <= 0) {
    throw new Error("Upgrade would yield 0 value");
  }
  const { outputs, blindings } = createBlindedOutputs(newValue, activeKeysetId);
  return { oldValue: sumProofs(vintageProofs), newValue, outputs, blindings };
}

/** Build a V3 token string for a set of proofs. */
export function buildToken(mintUrl: string, proofs: Proof[], memo?: string): string {
  const token: TokenV3 = {
    token: [{ mint: mintUrl, proofs }],
    unit: UNIT,
    ...(memo ? { memo } : {}),
  };
  return encodeToken(token);
}

/**
 * The mint URL to embed in tokens / show for external Cashu wallets.
 * Points at the public API base of this mint.
 */
export function getMintUrl(): string {
  const origin = window.location.origin;
  return `${origin}/api`;
}

/**
 * Projected value of proofs under the current rate index (upgrade preview).
 * V_out = floor(sum_k V_k * R_current / R_k), computed with high-precision
 * decimal strings (12 fractional digits) to match the mint's math.
 */
export function projectUpgradeValue(
  proofsByKeyset: { amount: number; rateIndex: string }[],
  currentRateIndex: string,
): number {
  const SCALE = 10n ** 12n;
  const rCur = parseDecimal12(currentRateIndex);
  let acc = 0n;
  for (const { amount, rateIndex } of proofsByKeyset) {
    const rK = parseDecimal12(rateIndex);
    if (rK === 0n) continue;
    acc += (BigInt(amount) * rCur * SCALE) / rK;
  }
  return Number(acc / SCALE);
}

/** Parse a decimal string with up to 12 fractional digits into a scaled bigint. */
function parseDecimal12(value: string): bigint {
  const [whole, frac = ""] = value.split(".");
  const fracPadded = (frac + "000000000000").slice(0, 12);
  return BigInt(whole || "0") * 10n ** 12n + BigInt(fracPadded || "0");
}

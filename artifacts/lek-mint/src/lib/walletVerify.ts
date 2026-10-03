import { getActiveKeys, getEpochs, getKeysets, upgradeTokens, type Proof } from "@workspace/api-client-react";
import { hashToCurveFromSecretString } from "./cashuCrypto";
import {
  getAllProofs,
  addProofs,
  removeProofs,
  addHistory,
  saveBlindings,
  deleteBlindings,
} from "./proofStore";
import { planUpgrade, unblindSignatures, sumProofs, getMintUrl } from "./wallet";
import { toast } from "sonner";

/**
 * Startup wallet verification.
 *
 * Browser storage is shared per domain, so tokens left behind by another app
 * on the same domain (or stale tokens from earlier sessions) can show up as
 * a real-looking balance even though they are unspendable at this mint.
 *
 * On app load (once per page load, non-blocking) this module:
 *  1. flags proofs whose keyset this mint does not know ("foreign"),
 *  2. batch-checks the rest against the mint's NUT-07 state endpoint and
 *     flags already-spent ones ("stale"),
 *  3. auto-updates old-epoch (vintage) proofs to the current epoch using the
 *     same shared planning/durability logic as the Update tab and melt flow.
 *
 * Flagged proofs are NEVER deleted automatically — the Wallet tab shows them
 * separately with a confirm-to-remove action.
 */

export type VerificationStatus = "idle" | "checking" | "verified" | "unavailable";

export interface VerificationState {
  status: VerificationStatus;
  /** Proofs whose keyset this mint doesn't know — not from this mint. */
  foreign: Proof[];
  /** Proofs from a known keyset that the mint reports as already spent. */
  stale: Proof[];
  /** Proofs from a revoked keyset (security rotation) — permanently invalid. */
  revoked: Proof[];
  checkedAt: string | null;
}

let state: VerificationState = { status: "idle", foreign: [], stale: [], revoked: [], checkedAt: null };

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeVerification(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVerificationState(): VerificationState {
  return state;
}

function setState(next: Partial<VerificationState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Secrets of all currently flagged (unspendable-here) proofs. */
export function getFlaggedSecrets(): Set<string> {
  return new Set([...state.foreign, ...state.stale, ...state.revoked].map((p) => p.secret));
}

/**
 * Filter proofs to those not flagged as unspendable-here. Spend flows (send,
 * melt, update) MUST select from this, so a flagged proof can never enter a
 * selection or upgrade plan. Before/without verification it is a no-op.
 */
export function filterSpendable<T extends { secret: string }>(proofs: T[]): T[] {
  const flagged = getFlaggedSecrets();
  return flagged.size > 0 ? proofs.filter((p) => !flagged.has(p.secret)) : proofs;
}

/**
 * Authoritative keyset inventory (includes ALL historical keysets, unlike
 * /epochs which could lag). Foreign detection must use this: misflagging a
 * valid keyset as foreign would offer users a delete button for real funds.
 *
 * Uses the mint's /keysets endpoint (not NUT-02 /v1/keysets) because it
 * carries the `revoked` flag: revoked proofs are permanently invalid, while
 * plain inactive (historical) keysets remain redeemable. `active: false`
 * alone can NOT distinguish the two.
 */
async function fetchKeysetInventory(): Promise<{ known: Set<string>; revoked: Set<string> }> {
  const data = await getKeysets();
  const known = new Set(data.keysets.map((k) => k.id));
  const revoked = new Set(data.keysets.filter((k) => k.revoked).map((k) => k.id));
  if (known.size === 0) throw new Error("mint reported no keysets");
  return { known, revoked };
}

/** Batch NUT-07 checkstate against this mint. Returns the set of SPENT Ys. */
async function checkSpentYs(ys: string[]): Promise<Set<string>> {
  const spent = new Set<string>();
  const BATCH = 500;
  for (let i = 0; i < ys.length; i += BATCH) {
    const batch = ys.slice(i, i + BATCH);
    const res = await fetch(`${getMintUrl()}/v1/checkstate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Ys: batch }),
    });
    if (!res.ok) throw new Error(`checkstate failed: ${res.status}`);
    const data: { states: { Y: string; state: string }[] } = await res.json();
    for (const s of data.states) {
      if (s.state === "SPENT") spent.add(s.Y);
    }
  }
  return spent;
}

/**
 * Auto-update vintage proofs to the current epoch. Value-preserving and
 * durable: new proofs are stored BEFORE the old ones are retired. On any
 * failure the vintage proofs stay untouched (the Update tab still works).
 */
async function autoUpgradeVintage(
  vintage: Proof[],
  epochs: { keysetId: string; rateIndex: string }[],
  currentRateIndex: string,
  activeKeysetId: string,
  keysByAmount: Record<string, string>,
): Promise<void> {
  const plan = planUpgrade(vintage, epochs, currentRateIndex, activeKeysetId);

  const context = `auto-upgrade-${Date.now()}`;
  const blindingsWithContext = plan.blindings.map((b) => ({
    ...b,
    context,
    createdAt: new Date().toISOString(),
  }));
  await saveBlindings(blindingsWithContext);

  try {
    const data = await upgradeTokens({ proofs: vintage, outputs: plan.outputs });
    const newProofs = unblindSignatures(data.signatures, blindingsWithContext, keysByAmount);

    // Durability ordering: store new proofs first, then retire the old ones.
    await addProofs(newProofs);
    await removeProofs(vintage.map((p) => p.secret));
    await deleteBlindings(blindingsWithContext.map((b) => b.B_));
    await addHistory({
      type: "upgrade",
      amount: data.newValue,
      detail: `Auto-updated from ${data.oldValue} on load`,
      createdAt: new Date().toISOString(),
    });
    toast.success(
      `Updated ${data.oldValue.toLocaleString()} old-epoch leks to ${data.newValue.toLocaleString()} at today's rate.`,
    );
  } catch (err) {
    // Nothing was removed — the vintage proofs are untouched. A 409 means
    // another tab already updated them; the caller re-checks in that case.
    await deleteBlindings(blindingsWithContext.map((b) => b.B_)).catch(() => {});
    throw err;
  }
}

let started = false;

/**
 * Kick off the startup check once per page load. Safe to call from multiple
 * components. Non-blocking: the app stays fully usable while (or if) it runs.
 */
export function ensureStartupCheck(): void {
  if (started) return;
  started = true;
  void runCheck();
}

/** Re-run verification (e.g. after cleanup or a 409 race with another tab). */
export async function runCheck(): Promise<void> {
  setState({ status: "checking" });
  try {
    const [keysData, epochsData, inventory] = await Promise.all([
      getActiveKeys(),
      getEpochs(),
      fetchKeysetInventory(),
    ]);
    const knownKeysets = inventory.known;
    knownKeysets.add(keysData.keysetId);

    const proofs = await getAllProofs();
    const foreign = proofs.filter((p) => !knownKeysets.has(p.id));

    // Proofs from revoked keysets are permanently invalid (security
    // rotation) — flag them separately; never count, select, or upgrade them.
    const revoked = proofs.filter((p) => knownKeysets.has(p.id) && inventory.revoked.has(p.id));
    const revokedSecrets = new Set(revoked.map((p) => p.secret));

    // Spent check for proofs this mint could still honor.
    const candidates = proofs.filter((p) => knownKeysets.has(p.id) && !revokedSecrets.has(p.secret));
    const yBySecret = new Map(candidates.map((p) => [p.secret, hashToCurveFromSecretString(p.secret).toHex(true)]));
    const spentYs = await checkSpentYs([...yBySecret.values()]);
    const stale = candidates.filter((p) => spentYs.has(yBySecret.get(p.secret)!));

    setState({ foreign, stale, revoked });

    // Auto-update old-epoch proofs. Skip flagged ones, and skip (leave
    // untouched, unflagged) any known keyset that has no published epoch
    // rate yet — never guess a value, and never treat it as foreign.
    const flagged = new Set(stale.map((p) => p.secret));
    const ratedKeysets = new Set(
      (epochsData.epochs ?? []).filter((e) => e.keysetId && e.rateIndex).map((e) => e.keysetId),
    );
    const vintage = candidates.filter(
      (p) => p.id !== keysData.keysetId && !flagged.has(p.secret) && ratedKeysets.has(p.id),
    );
    if (vintage.length > 0 && epochsData.currentRateIndex && epochsData.epochs) {
      try {
        await autoUpgradeVintage(
          vintage,
          epochsData.epochs
            .filter((e) => !!e.keysetId && !!e.rateIndex)
            .map((e) => ({ keysetId: e.keysetId!, rateIndex: e.rateIndex! })),
          epochsData.currentRateIndex,
          keysData.keysetId,
          keysData.keys,
        );
      } catch (err: any) {
        console.error("Auto-update of old-epoch leks failed:", err);
        if (err?.status === 409) {
          // Another tab (or an earlier run) already spent these proofs at the
          // mint — re-run the check so they get flagged/cleaned correctly.
          started = true;
          await runCheckSpentOnly(knownKeysets, inventory.revoked);
        } else {
          toast.error(
            "Couldn't auto-update your old-epoch leks. They're untouched — you can update them on the Update tab.",
          );
        }
      }
    }

    setState({ status: "verified", checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Wallet verification unavailable:", err);
    // Offline or mint unreachable — keep last-known state, mark unverified.
    setState({ status: "unavailable" });
  }
}

/** Lightweight re-check of spent state only (after a 409 race). */
async function runCheckSpentOnly(knownKeysets: Set<string>, revokedIds: Set<string>): Promise<void> {
  const proofs = await getAllProofs();
  const revoked = proofs.filter((p) => knownKeysets.has(p.id) && revokedIds.has(p.id));
  const candidates = proofs.filter((p) => knownKeysets.has(p.id) && !revokedIds.has(p.id));
  const yBySecret = new Map(candidates.map((p) => [p.secret, hashToCurveFromSecretString(p.secret).toHex(true)]));
  const spentYs = await checkSpentYs([...yBySecret.values()]);
  const stale = candidates.filter((p) => spentYs.has(yBySecret.get(p.secret)!));
  setState({ stale, revoked, foreign: proofs.filter((p) => !knownKeysets.has(p.id)) });
}

/** User-confirmed cleanup: remove flagged proofs from browser storage. */
export async function removeFlaggedProofs(kind: "foreign" | "stale" | "revoked"): Promise<number> {
  const targets = kind === "foreign" ? state.foreign : kind === "stale" ? state.stale : state.revoked;
  if (targets.length === 0) return 0;
  const amount = sumProofs(targets);
  await removeProofs(targets.map((p) => p.secret));
  setState(kind === "foreign" ? { foreign: [] } : kind === "stale" ? { stale: [] } : { revoked: [] });
  return amount;
}

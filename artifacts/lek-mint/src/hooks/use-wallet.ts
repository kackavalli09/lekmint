import { useEffect, useState } from "react";
import { getHistory, getAllProofs, type HistoryEntry } from "@/lib/proofStore";
import { subscribe } from "@/lib/proofStore";
import {
  ensureStartupCheck,
  getVerificationState,
  getFlaggedSecrets,
  subscribeVerification,
  type VerificationState,
} from "@/lib/walletVerify";
import type { Proof } from "@workspace/api-client-react";

export function useWalletStore() {
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [verification, setVerification] = useState<VerificationState>(getVerificationState());

  useEffect(() => {
    const refresh = async () => {
      const all = await getAllProofs();
      const hist = await getHistory(50);
      setProofs(all);
      setHistory(hist);
    };

    refresh();
    ensureStartupCheck();
    const unsubStore = subscribe(refresh);
    const unsubVerify = subscribeVerification(() => setVerification(getVerificationState()));
    return () => {
      unsubStore();
      unsubVerify();
    };
  }, []);

  // Headline balance counts only tokens not flagged as foreign/stale by the
  // startup verification. Before/without verification, all stored tokens count
  // (offline-first: last-known state, surfaced as "unverified" in the UI).
  const flagged = getFlaggedSecrets();
  const spendableProofs = flagged.size > 0 ? proofs.filter((p) => !flagged.has(p.secret)) : proofs;
  const balance = spendableProofs.reduce((sum, p) => sum + p.amount, 0);

  return { balance, proofs, spendableProofs, history, verification };
}

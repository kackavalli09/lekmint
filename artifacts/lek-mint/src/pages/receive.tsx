import { useState, useRef } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { 
  useGetActiveKeys,
  useGetEpochs,
  useSwapTokens,
  useCheckEscrow,
  useClaimEscrow
} from "@workspace/api-client-react";
import { 
  addProofs,
  addHistory,
  saveBlindings,
  getBlindingsByContext,
  getBlindingsByBValues,
  deleteBlindings
} from "@/lib/proofStore";
import { 
  createBlindedOutputs,
  unblindSignatures,
  sumProofs,
  partitionProofsByKeyset,
  projectUpgradeValue,
  RateDataIncompleteError
} from "@/lib/wallet";
import { getMintUrl } from "@/lib/wallet";
import { hashToCurveFromSecretString } from "@/lib/cashuCrypto";
import { decodeToken } from "@/lib/tokenCodec";
import { toast } from "sonner";
import { formatAmount } from "@/lib/utils";

interface CheckResult {
  kind: "spendable" | "escrow" | "recovery" | "partial" | "spent";
  amountLeks: number;
  faceAmount: number;
}

export default function ReceivePage() {
  const [tokenStr, setTokenStr] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  
  const { data: keysData } = useGetActiveKeys();
  const { data: epochsData } = useGetEpochs();
  const swapTokens = useSwapTokens();
  const checkEscrow = useCheckEscrow();
  const claimEscrow = useClaimEscrow();

  const swapTokensRef = useRef(swapTokens.mutate);
  swapTokensRef.current = swapTokens.mutate;
  const checkEscrowRef = useRef(checkEscrow.mutateAsync);
  checkEscrowRef.current = checkEscrow.mutateAsync;
  const claimEscrowRef = useRef(claimEscrow.mutateAsync);
  claimEscrowRef.current = claimEscrow.mutateAsync;

  /**
   * A token can be "already spent" because an external wallet swapped it at
   * face value after an epoch rate change — in that case the mint escrowed
   * the appreciation for whoever holds the original proofs. Claim it here.
   * Returns true when an escrow was claimed (success toast shown).
   */
  const tryClaimEscrow = async (
    proofs: { id: string; amount: number; secret: string; C: string; r?: string }[],
    keysetId: string,
    keys: Record<string, string>,
    variant: "spent" | "bonus" = "spent",
  ): Promise<boolean> => {
    try {
      const check = await checkEscrowRef.current({ data: { proofs } });
      if (!check.available || check.amountLeks <= 0) return false;
      const { outputs, blindings } = createBlindedOutputs(check.amountLeks, keysetId);
      const blindingsWithContext = blindings.map(b => ({
        ...b,
        context: `escrow-${Date.now()}`,
        createdAt: new Date().toISOString()
      }));
      await saveBlindings(blindingsWithContext);
      const result = await claimEscrowRef.current({ data: { proofs, outputs } });
      let usedBlindings = blindingsWithContext;
      if (result.redelivered && result.outputs) {
        // The mint already processed this claim earlier (e.g. a crash before
        // we stored the proofs) and redelivered the ORIGINAL signatures.
        // Unblind with the blindings saved during that first attempt.
        const saved = await getBlindingsByBValues(result.outputs.map(o => o.B_));
        if (saved.length !== result.outputs.length) {
          throw new Error("Escrow was claimed from a different browser — its blindings are not stored here.");
        }
        // Order blindings to match the redelivered outputs/signatures.
        const byB = new Map(saved.map(b => [b.B_, b]));
        usedBlindings = result.outputs.map(o => byB.get(o.B_)!) as typeof blindingsWithContext;
        await deleteBlindings(blindingsWithContext.map(b => b.B_));
      }
      const newProofs = unblindSignatures(result.signatures, usedBlindings, keys);
      await addProofs(newProofs);
      await deleteBlindings(usedBlindings.map(b => b.B_));
      await addHistory({ type: "receive", amount: result.amountLeks, createdAt: new Date().toISOString() });
      setTokenStr("");
      toast.success(
        variant === "bonus"
          ? `Bonus: ${formatAmount(result.amountLeks)} extra leks of held-back upgrade value came with this token — credited to your wallet!`
          : `This token was already swapped by an external wallet, but ${formatAmount(result.amountLeks)} leks of epoch appreciation were held for you — credited to your wallet!`
      );
      return true;
    } catch (err) {
      console.error("Escrow claim failed:", err);
      return false;
    }
  };

  /** Decode a token and value it at the current epoch rate (mint's math). */
  const projectTokenValue = (proofs: { id: string; amount: number; secret: string; C: string }[]): number => {
    if (!keysData) throw new Error("Mint keys not available.");
    const { active, vintage } = partitionProofsByKeyset(proofs, keysData.keysetId);
    let totalAmount = sumProofs(active);
    if (vintage.length > 0) {
      if (!epochsData?.epochs || !epochsData.currentRateIndex) {
        throw new Error("Epoch rate data not loaded yet — try again in a moment.");
      }
      const rateByKeyset = new Map(epochsData.epochs.map(e => [e.keysetId, e.rateIndex]));
      const items = vintage.map(p => {
        const rateIndex = rateByKeyset.get(p.id);
        if (!rateIndex) throw new RateDataIncompleteError(p.id);
        return { amount: p.amount, rateIndex };
      });
      totalAmount += projectUpgradeValue(items, epochsData.currentRateIndex);
    }
    return totalAmount;
  };

  /**
   * Check what a pasted token is worth WITHOUT spending it: current value at
   * today's rate if unspent, or — if an external wallet already swapped it at
   * face value — the escrowed appreciation still claimable here.
   */
  const handleCheck = async () => {
    if (!tokenStr.trim()) {
      toast.error("Enter a token string");
      return;
    }
    setIsChecking(true);
    setCheckResult(null);
    try {
      const decoded = decodeToken(tokenStr);
      if (decoded.unit !== "lek") throw new Error("Only 'lek' unit tokens are supported.");
      const proofs = decoded.token.flatMap(t => t.proofs);
      const faceAmount = sumProofs(proofs);
      if (faceAmount <= 0) throw new Error("Token contains no value.");

      // NUT-07 checkstate: spent or not, without revealing anything else.
      const ys = proofs.map(p => hashToCurveFromSecretString(p.secret).toHex(true));
      const stateRes = await fetch(`${getMintUrl()}/v1/checkstate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Ys: ys }),
      });
      if (!stateRes.ok) throw new Error("Could not reach the mint to check the token.");
      const stateData: { states: { state: string }[] } = await stateRes.json();
      const spentCount = stateData.states.filter(s => s.state === "SPENT").length;

      if (spentCount === 0) {
        setCheckResult({ kind: "spendable", amountLeks: projectTokenValue(proofs), faceAmount });
      } else if (spentCount < proofs.length) {
        // Mixed set: escrow only ever exists for a COMPLETE spent set, so
        // don't misreport this as fully spent or fully claimable.
        setCheckResult({ kind: "partial", amountLeks: 0, faceAmount });
      } else {
        const escrow = await checkEscrowRef.current({ data: { proofs } });
        if (escrow.available && escrow.amountLeks > 0) {
          setCheckResult({
            kind: escrow.redeliverable ? "recovery" : "escrow",
            amountLeks: escrow.amountLeks,
            faceAmount,
          });
        } else {
          setCheckResult({ kind: "spent", amountLeks: 0, faceAmount });
        }
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Invalid token string.");
    } finally {
      setIsChecking(false);
    }
  };

  const handleReceive = async () => {
    if (!tokenStr.trim()) {
      toast.error("Enter a token string");
      return;
    }
    
    if (!keysData) {
      toast.error("Mint keys not available. Go online to receive tokens.");
      return;
    }

    setIsProcessing(true);
    try {
      const decoded = decodeToken(tokenStr);
      if (decoded.unit !== "lek") {
        throw new Error("Only 'lek' unit tokens are supported.");
      }
      
      const allProofsToReceive = decoded.token.flatMap(t => t.proofs);
      const faceAmount = sumProofs(allProofsToReceive);
      
      if (faceAmount <= 0) {
        throw new Error("Token contains no value.");
      }

      // Value old-epoch proofs at the current rate (same math as the mint)
      // so receiving credits the upgraded value instead of forfeiting it.
      const totalAmount = projectTokenValue(allProofsToReceive);
      if (totalAmount <= 0) {
        throw new Error("Token value rounds to 0 leks at the current rate.");
      }

      const context = `receive-${Date.now()}`;
      const { outputs, blindings } = createBlindedOutputs(totalAmount, keysData.keysetId);
      
      const blindingsWithContext = blindings.map(b => ({
        ...b,
        context,
        createdAt: new Date().toISOString()
      }));
      
      await saveBlindings(blindingsWithContext);

      swapTokensRef.current(
        { data: { inputs: allProofsToReceive, outputs } },
        {
          onSuccess: async (data) => {
            try {
              const newProofs = unblindSignatures(data.signatures, blindingsWithContext, keysData.keys);
              
              await addProofs(newProofs);
              await deleteBlindings(blindingsWithContext.map(b => b.B_));
              await addHistory({ type: "receive", amount: totalAmount, createdAt: new Date().toISOString() });
              
              setTokenStr("");
              toast.success(`Successfully received ${formatAmount(totalAmount)} leks!`);
              // If this token came from an external wallet that face-value
              // swapped old-epoch leks, the mint held the upgrade in escrow
              // keyed to this token's outputs (linkable via the DLEQ r each
              // proof carries). Auto-claim it so the receiver gets full value.
              if (allProofsToReceive.some((p) => typeof (p as { r?: string }).r === "string")) {
                await tryClaimEscrow(allProofsToReceive, keysData.keysetId, keysData.keys, "bonus");
              }
            } catch (err) {
              console.error(err);
              toast.error("Failed to unblind receive signatures.");
            } finally {
              setIsProcessing(false);
            }
          },
          onError: async (err: any) => {
            console.error(err);
            if (err?.status === 409) {
              // The proofs are spent — but if an external wallet swapped them
              // at face value, the epoch appreciation is escrowed for us.
              const claimed = await tryClaimEscrow(allProofsToReceive, keysData.keysetId, keysData.keys);
              if (!claimed) {
                toast.error("This token has already been spent. Ecash tokens can only be redeemed once.");
              }
            } else {
              toast.error("Failed to receive token. Check your connection and try again.");
            }
            setIsProcessing(false);
          }
        }
      );

    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Invalid token string.");
      setIsProcessing(false);
    }
  };

  return (
    <Layout>
      <div className="max-w-md mx-auto mt-8">
        <h1 className="text-3xl font-bold mb-6">Receive Leks</h1>
        
        <Card className="shadow-none border-border">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Paste Token</label>
                <Textarea 
                  placeholder="cashuA... or cashuB..." 
                  value={tokenStr} 
                  onChange={e => { setTokenStr(e.target.value); setCheckResult(null); }}
                  className="min-h-[120px] font-mono text-xs resize-none"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Receiving swaps the bearer token with the mint to ensure it cannot be double-spent. This requires an active internet connection.
                </p>
              </div>
              {checkResult && (
                <div className="rounded-lg border bg-muted/50 p-4 text-sm leading-relaxed" data-testid="check-result">
                  {checkResult.kind === "spendable" && (
                    <>
                      This token is unspent and worth{" "}
                      <span className="font-semibold">{formatAmount(checkResult.amountLeks)} leks</span> at the
                      current epoch rate
                      {checkResult.amountLeks !== checkResult.faceAmount && (
                        <> (face value {formatAmount(checkResult.faceAmount)})</>
                      )}
                      . Press Receive to credit it to your wallet.
                    </>
                  )}
                  {checkResult.kind === "escrow" && (
                    <>
                      An external wallet already swapped this token at face value, but{" "}
                      <span className="font-semibold">{formatAmount(checkResult.amountLeks)} leks</span> of epoch
                      appreciation are held for whoever holds this original token. Press Receive to credit them
                      to your wallet — this can happen exactly once.
                    </>
                  )}
                  {checkResult.kind === "recovery" && (
                    <>
                      The {formatAmount(checkResult.amountLeks)} leks held back for this token were already
                      claimed. If that claim was interrupted in <em>this</em> browser, pressing Receive recovers
                      it; no new value is created, and it cannot be claimed from another device.
                    </>
                  )}
                  {checkResult.kind === "partial" && (
                    <>
                      Part of this token has already been spent. The unspent part cannot be received as a whole
                      token, and no held-back value exists for a partially spent set.
                    </>
                  )}
                  {checkResult.kind === "spent" && (
                    <>This token has already been spent and carries no held-back value.</>
                  )}
                </div>
              )}
              <Button 
                className="w-full font-bold h-12" 
                onClick={handleReceive}
                disabled={isProcessing || !tokenStr.trim()}
              >
                {isProcessing ? "Processing..." : "Receive"}
              </Button>
              <Button
                variant="outline"
                className="w-full h-10"
                onClick={handleCheck}
                disabled={isChecking || isProcessing || !tokenStr.trim()}
                data-testid="button-check-value"
              >
                {isChecking ? "Checking..." : "Check value without receiving"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Checking shows what the token is worth at today's rate — including value held back for you when an
                external wallet swapped it at face value after a rate change — without spending it.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}

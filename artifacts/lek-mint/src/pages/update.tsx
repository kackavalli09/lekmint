import { useState, useRef, useMemo } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { 
  useGetActiveKeys,
  useGetEpochs,
  useUpgradeTokens 
} from "@workspace/api-client-react";
import { 
  getAllProofs,
  removeProofs,
  addProofs,
  addHistory,
  saveBlindings,
  deleteBlindings
} from "@/lib/proofStore";
import { 
  planUpgrade,
  unblindSignatures,
  projectUpgradeValue,
  sumProofs,
  RateDataIncompleteError
} from "@/lib/wallet";
import { filterSpendable } from "@/lib/walletVerify";
import { formatAmount } from "@/lib/utils";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

export default function UpdatePage() {
  const [isProcessing, setIsProcessing] = useState(false);
  
  const { data: keysData } = useGetActiveKeys();
  const { data: epochsData } = useGetEpochs();
  const upgradeTokens = useUpgradeTokens();
  const queryClient = useQueryClient();

  const [localProofs, setLocalProofs] = useState<any[]>([]);
  const [fetchTrigger, setFetchTrigger] = useState(0);

  useMemo(() => {
    getAllProofs().then((p) => setLocalProofs(filterSpendable(p)));
  }, [fetchTrigger]);

  const upgradeTokensRef = useRef(upgradeTokens.mutate);
  upgradeTokensRef.current = upgradeTokens.mutate;

  const currentEpochId = epochsData?.currentEpochId;
  const currentRateIndex = epochsData?.currentRateIndex;

  const proofsToUpdate = useMemo(() => {
    if (!currentEpochId || !epochsData?.epochs) return [];
    
    // Find proofs from older epochs
    const currentKeysetId = epochsData.epochs.find(e => e.id === currentEpochId)?.keysetId;
    if (!currentKeysetId) return [];

    return localProofs.filter(p => p.id !== currentKeysetId);
  }, [localProofs, currentEpochId, epochsData]);

  const totalOldValue = useMemo(() => sumProofs(proofsToUpdate), [proofsToUpdate]);

  // Strict rate mapping: if any token's keyset isn't in the epoch data we
  // cannot honestly value it (and the mint would reject it anyway), so we
  // surface "rate data incomplete" instead of guessing.
  const { projectedNewValue, rateDataIncomplete } = useMemo(() => {
    if (!currentRateIndex || !epochsData?.epochs || proofsToUpdate.length === 0) {
      return { projectedNewValue: 0, rateDataIncomplete: false };
    }
    const proofsByKeyset: { amount: number; rateIndex: string }[] = [];
    for (const p of proofsToUpdate) {
      const epoch = epochsData.epochs.find(e => e.keysetId === p.id);
      if (!epoch?.rateIndex) {
        return { projectedNewValue: 0, rateDataIncomplete: true };
      }
      proofsByKeyset.push({ amount: p.amount, rateIndex: epoch.rateIndex });
    }
    return {
      projectedNewValue: projectUpgradeValue(proofsByKeyset, currentRateIndex),
      rateDataIncomplete: false,
    };
  }, [proofsToUpdate, currentRateIndex, epochsData]);

  const handleUpdate = async () => {
    if (proofsToUpdate.length === 0) {
      toast.error("No tokens to update");
      return;
    }
    if (!keysData || !currentRateIndex) {
      toast.error("Mint keys or epoch data not available. Go online.");
      return;
    }
    if (rateDataIncomplete) {
      toast.error("Rate data is incomplete for some tokens. Go online and retry.");
      return;
    }

    setIsProcessing(true);
    try {
      // Shared upgrade planning (same helper the melt flow uses): strict
      // rate mapping + blinded outputs for the projected value.
      let plan;
      try {
        plan = planUpgrade(
          proofsToUpdate,
          epochsData?.epochs ?? [],
          currentRateIndex,
          keysData.keysetId,
        );
      } catch (err) {
        if (err instanceof RateDataIncompleteError) {
          toast.error("Rate data is incomplete for some tokens. Go online and retry.");
        } else {
          toast.error(err instanceof Error ? err.message : "Failed to plan the update.");
        }
        setIsProcessing(false);
        return;
      }
      const { outputs, blindings } = plan;

      const context = `upgrade-${Date.now()}`;
      
      const blindingsWithContext = blindings.map(b => ({
        ...b,
        context,
        createdAt: new Date().toISOString()
      }));
      
      await saveBlindings(blindingsWithContext);

      upgradeTokensRef.current(
        { data: { proofs: proofsToUpdate, outputs } },
        {
          onSuccess: async (data) => {
            try {
              const newProofs = unblindSignatures(data.signatures, blindingsWithContext, keysData.keys);
              
              // Store the new proofs BEFORE retiring the old ones — a crash
              // mid-sequence leaves at worst stale spent proofs, never lost funds.
              await addProofs(newProofs);
              await removeProofs(proofsToUpdate.map(p => p.secret));
              await deleteBlindings(blindingsWithContext.map(b => b.B_));
              await addHistory({ 
                type: "upgrade", 
                amount: data.newValue, 
                detail: `Updated from ${data.oldValue}`,
                createdAt: new Date().toISOString() 
              });
              
              setFetchTrigger(t => t + 1);
              toast.success(`Successfully updated to ${formatAmount(data.newValue)} leks!`);
            } catch (err) {
              console.error(err);
              toast.error("Failed to unblind update signatures.");
            } finally {
              setIsProcessing(false);
            }
          },
          onError: (err) => {
            console.error(err);
            toast.error("Failed to update tokens.");
            setIsProcessing(false);
          }
        }
      );

    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to start update.");
      setIsProcessing(false);
    }
  };

  return (
    <Layout>
      <div className="max-w-md mx-auto mt-8">
        <h1 className="text-3xl font-bold mb-6">Update Leks</h1>
        
        <Card className="shadow-none border-border">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground mb-6">
              When mining difficulty increases, older Leks represent less embodied energy relative to the current network hash rate. You can update them to the current epoch's denomination.
            </p>

            <div className="space-y-6">
              <div className="bg-muted p-4 rounded-xl space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-muted-foreground">Current Epoch</span>
                  <span className="font-bold">{currentEpochId ?? "..."}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-muted-foreground">Rate Index</span>
                  <span className="font-mono text-sm">{currentRateIndex ?? "..."}</span>
                </div>
              </div>

              <div className="border border-border p-4 rounded-xl space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium">Eligible for Update</span>
                  <span className="font-bold">{formatAmount(totalOldValue)} leks</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium">Projected New Value</span>
                  <span className="font-bold text-green-600 dark:text-green-400">
                    {rateDataIncomplete ? "—" : `${formatAmount(projectedNewValue)} leks`}
                  </span>
                </div>
                {rateDataIncomplete && (
                  <p className="text-xs text-muted-foreground">
                    Rate data is incomplete for some of your tokens. Go online and refresh to see the projected value.
                  </p>
                )}
              </div>

              <Button 
                className="w-full font-bold h-12" 
                onClick={handleUpdate}
                disabled={isProcessing || proofsToUpdate.length === 0 || projectedNewValue <= 0}
              >
                {isProcessing ? "Processing..." : "Update Tokens"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}

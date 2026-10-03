import { useState, useRef } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { 
  useRecoverTokens,
  useRecoverSwap,
  useGetActiveKeys,
  type BlindSignature
} from "@workspace/api-client-react";
import { 
  addProofs,
  addHistory,
  getBlindingsByContext,
  getAllBlindings,
  getWalletBackup,
  deleteBlindings,
  type StoredBlinding
} from "@/lib/proofStore";
import { unblindSignatures } from "@/lib/wallet";
import { formatAmount } from "@/lib/utils";
import { toast } from "sonner";

export default function RecoverPage() {
  const [btcAddress, setBtcAddress] = useState("");
  const [isSwapRecovering, setIsSwapRecovering] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  
  const { data: keysData } = useGetActiveKeys();
  const recoverTokens = useRecoverTokens();
  const recoverSwap = useRecoverSwap();

  const recoverSwapRef = useRef(recoverSwap.mutateAsync);
  recoverSwapRef.current = recoverSwap.mutateAsync;

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const stores = await getWalletBackup();
      const backup = {
        format: "lek-wallet-backup",
        version: 1,
        origin: window.location.origin,
        createdAt: new Date().toISOString(),
        ...stores,
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], {
        type: "application/json",
      }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `lek-wallet-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success("Backup download requested. Store it securely; it contains token secrets.");
    } catch {
      toast.error("Could not export the local wallet. Browser tokens have not been changed.");
    } finally {
      setIsExporting(false);
    }
  };

  /**
   * Replay every pending swap/upgrade blinding against POST /swap/recover.
   * The mint redelivers the signatures it already issued (idempotent, keyed
   * by B_); B_ values it never signed come back null — those operations
   * never committed, so the original proofs are untouched.
   */
  const handleSwapRecover = async () => {
    if (!keysData) {
      toast.error("Mint keys not available. Go online to recover tokens.");
      return;
    }
    setIsSwapRecovering(true);
    try {
      const all = await getAllBlindings();
      // Mint-issuance blindings are handled by the deposit-address flow below.
      const pending = all.filter((b) => !b.context.startsWith("mint-"));
      if (pending.length === 0) {
        toast.info("No pending swap or update operations to recover.");
        return;
      }

      // Group by operation context so each interrupted operation is
      // recovered (and reported) as a unit.
      const byContext = new Map<string, StoredBlinding[]>();
      for (const b of pending) {
        const list = byContext.get(b.context) ?? [];
        list.push(b);
        byContext.set(b.context, list);
      }

      let recoveredTotal = 0;
      let neverCommitted = 0;
      for (const [, blindings] of byContext) {
        const data = await recoverSwapRef.current({
          data: { outputs: blindings.map((b) => b.B_) },
        });
        const found: BlindSignature[] = [];
        const foundBlindings: StoredBlinding[] = [];
        data.signatures.forEach((sig, i) => {
          if (sig) {
            found.push(sig);
            foundBlindings.push(blindings[i]);
          }
        });
        if (found.length === 0) {
          // The mint never signed these: the operation never happened, the
          // input proofs are still spendable. Safe to discard the blindings.
          await deleteBlindings(blindings.map((b) => b.B_));
          neverCommitted++;
          continue;
        }
        const proofs = unblindSignatures(found, foundBlindings, keysData.keys);
        const amount = proofs.reduce((sum, p) => sum + p.amount, 0);
        // Store the recovered proofs BEFORE deleting the blindings.
        await addProofs(proofs);
        await deleteBlindings(foundBlindings.map((b) => b.B_));
        await addHistory({
          type: "swap",
          amount,
          detail: "recovered",
          createdAt: new Date().toISOString(),
        });
        recoveredTotal += amount;
      }

      if (recoveredTotal > 0) {
        toast.success(`Recovered ${recoveredTotal.toLocaleString()} leks from interrupted operations!`);
      }
      if (neverCommitted > 0) {
        toast.info(
          `${neverCommitted} pending operation${neverCommitted > 1 ? "s" : ""} never reached the mint — your original tokens are unaffected.`,
        );
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || "Swap recovery failed. Try again while online.");
    } finally {
      setIsSwapRecovering(false);
    }
  };

  const recoverTokensRef = useRef(recoverTokens.mutate);
  recoverTokensRef.current = recoverTokens.mutate;

  const handleRecover = () => {
    if (!btcAddress.trim()) {
      toast.error("Enter a valid Bitcoin address");
      return;
    }
    if (!keysData) {
      toast.error("Mint keys not available. Go online to recover tokens.");
      return;
    }

    recoverTokensRef.current(
      { data: { btcAddress: btcAddress.trim() } },
      {
        onSuccess: async (data) => {
          if (!data.signatures || data.signatures.length === 0) {
            toast.error("No un-delivered signatures found for this address.");
            return;
          }

          try {
            const context = `mint-${data.request.id}`;
            const storedBlindings = await getBlindingsByContext(context);
            
            if (storedBlindings.length === 0) {
              toast.error("No local blinding data found to complete recovery.");
              return;
            }

            const proofs = unblindSignatures(data.signatures, storedBlindings, keysData.keys);
            
            await addProofs(proofs);
            await deleteBlindings(storedBlindings.map(b => b.B_));
            await addHistory({ 
              type: "mint", 
              amount: data.request.netAmountSats || 0, 
              detail: "recovered",
              createdAt: new Date().toISOString() 
            });
            
            setBtcAddress("");
            toast.success(`Successfully recovered ${formatAmount(data.request.netAmountSats || 0)} leks!`);
          } catch (err: any) {
            console.error(err);
            toast.error(err.message || "Failed to unblind recovered signatures.");
          }
        },
        onError: (err) => {
          console.error(err);
          toast.error("Recovery failed. Check the address and try again.");
        }
      }
    );
  };

  return (
    <Layout>
      <div className="max-w-md mx-auto mt-8">
        <h1 className="text-3xl font-bold mb-6">Recover Leks</h1>

        <Card className="shadow-none border-border mb-6">
          <CardContent className="pt-6">
            <h2 className="text-lg font-semibold mb-2">Local wallet backup</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Export this browser's proofs, pending requests, recovery blindings and history,
              even when the mint is offline. This does not send or remove tokens.
              The unencrypted file contains money-bearing secrets: keep it private.
              This is a recovery backup, not a transfer token; automatic import is not provided.
            </p>
            <Button
              className="w-full"
              variant="outline"
              onClick={handleExport}
              disabled={isExporting}
              data-testid="button-export-wallet-backup"
            >
              {isExporting ? "Exporting..." : "Export Local Backup"}
            </Button>
          </CardContent>
        </Card>

        <Card className="shadow-none border-border mb-6">
          <CardContent className="pt-6">
            <h2 className="text-lg font-semibold mb-2">Interrupted swap or update</h2>
            <p className="text-sm text-muted-foreground mb-6">
              If the browser crashed while sending, receiving, updating or melting, the mint may have already signed your new tokens. This replays the pending operations saved on this device and recovers those tokens.
            </p>
            <Button
              className="w-full font-bold h-12"
              onClick={handleSwapRecover}
              disabled={isSwapRecovering}
              data-testid="button-recover-swap"
            >
              {isSwapRecovering ? "Recovering..." : "Recover Interrupted Operations"}
            </Button>
          </CardContent>
        </Card>

        <h2 className="text-lg font-semibold mb-2">Interrupted deposit</h2>
        <Card className="shadow-none border-border">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground mb-6">
              If a minting operation was interrupted, enter the deposit Bitcoin address to recover your tokens. Note: you must still have the local blinding data from the original browser session.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Deposit Bitcoin Address</label>
                <Input 
                  type="text" 
                  placeholder="bc1q..." 
                  value={btcAddress} 
                  onChange={e => setBtcAddress(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
              <Button 
                className="w-full font-bold h-12" 
                onClick={handleRecover}
                disabled={recoverTokens.isPending || !btcAddress.trim()}
              >
                {recoverTokens.isPending ? "Recovering..." : "Attempt Recovery"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}

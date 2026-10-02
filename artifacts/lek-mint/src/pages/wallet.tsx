import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useWalletStore } from "@/hooks/use-wallet";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { useGetEpochs } from "@workspace/api-client-react";
import { projectUpgradeValue, sumProofs } from "@/lib/wallet";
import { removeFlaggedProofs } from "@/lib/walletVerify";
import { formatAmount } from "@/lib/utils";
import { AlertTriangle, WifiOff } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

/** User-facing labels for local activity entries. */
const HISTORY_LABELS: Record<string, string> = {
  mint: "Mint",
  send: "Send",
  receive: "Receive",
  redeem: "Redeem",
  upgrade: "Update",
  swap: "Swap",
};

export default function WalletPage() {
  const { balance, spendableProofs, history, verification } = useWalletStore();
  // Offline-tolerant: if this query fails, we simply show face value only.
  const { data: epochsData } = useGetEpochs();
  const [removing, setRemoving] = useState(false);

  const handleRemoveFlagged = async (kind: "foreign" | "stale" | "revoked") => {
    setRemoving(true);
    try {
      const amount = await removeFlaggedProofs(kind);
      toast.success(`Removed ${formatAmount(amount)} leks of unspendable tokens from this browser.`);
    } catch (err) {
      console.error(err);
      toast.error("Failed to remove the flagged tokens.");
    } finally {
      setRemoving(false);
    }
  };

  /**
   * Projected value of all held tokens at the current epoch's rate index.
   * null when the rate data isn't available (offline) or nothing is held.
   */
  const projectedValue = useMemo(() => {
    const currentRateIndex = epochsData?.currentRateIndex;
    if (!currentRateIndex || !epochsData?.epochs || spendableProofs.length === 0) return null;
    const proofsByKeyset: { amount: number; rateIndex: string }[] = [];
    for (const p of spendableProofs) {
      const epoch = epochsData.epochs.find((e) => e.keysetId === p.id);
      // Strict: if any held token's keyset isn't in the epoch data, we can't
      // value the wallet honestly — hide the projection instead of guessing.
      if (!epoch?.rateIndex) return null;
      proofsByKeyset.push({ amount: p.amount, rateIndex: epoch.rateIndex });
    }
    return projectUpgradeValue(proofsByKeyset, currentRateIndex);
  }, [spendableProofs, epochsData]);

  const showProjected = projectedValue !== null && projectedValue !== balance;

  return (
    <Layout>
      <div className="flex flex-col items-center justify-center py-8 md:py-16 space-y-4">
        <h1 className="text-5xl sm:text-7xl md:text-8xl font-bold tracking-tighter">
          {formatAmount(balance)}
        </h1>
        <p className="text-xl text-muted-foreground uppercase tracking-widest font-medium">
          Leks
        </p>
        {verification.status === "unavailable" && (
          <p
            className="text-xs text-muted-foreground flex items-center gap-1.5"
            data-testid="wallet-unverified-hint"
          >
            <WifiOff className="w-3.5 h-3.5" />
            Unverified — the mint couldn't be reached, showing last-known tokens.
          </p>
        )}
        {showProjected && (
          <p className="text-sm text-muted-foreground text-center">
            Currently worth{" "}
            <span className="font-semibold text-foreground">
              {formatAmount(projectedValue)} leks
            </span>{" "}
            at this epoch&apos;s rate ·{" "}
            <Link href="/update" className="underline underline-offset-2 hover:text-foreground">
              Update
            </Link>{" "}
            to convert
          </p>
        )}
      </div>

      {(verification.foreign.length > 0 || verification.stale.length > 0 || verification.revoked.length > 0) && (
        <div className="mb-8 space-y-3" data-testid="wallet-flagged-section">
          {verification.foreign.length > 0 && (
            <div className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="flex-1 text-sm text-amber-900 dark:text-amber-200 leading-relaxed">
                <strong className="font-semibold">
                  {formatAmount(sumProofs(verification.foreign))} leks aren't from this mint.
                </strong>{" "}
                These tokens were saved in your browser by a different app on this domain. They
                can't be spent here and are not counted in your balance.
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={removing}
                    onClick={() => handleRemoveFlagged("foreign")}
                    data-testid="remove-foreign-button"
                  >
                    Remove them from this browser
                  </Button>
                </div>
              </div>
            </div>
          )}
          {verification.revoked.length > 0 && (
            <div className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="flex-1 text-sm text-amber-900 dark:text-amber-200 leading-relaxed">
                <strong className="font-semibold">
                  {formatAmount(sumProofs(verification.revoked))} leks are from retired keys.
                </strong>{" "}
                The mint rotated its keys for security, which permanently voided tokens signed by
                the old keys. These can't be spent or updated and are not counted in your balance.
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={removing}
                    onClick={() => handleRemoveFlagged("revoked")}
                    data-testid="remove-revoked-button"
                  >
                    Remove them from this browser
                  </Button>
                </div>
              </div>
            </div>
          )}
          {verification.stale.length > 0 && (
            <div className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="flex-1 text-sm text-amber-900 dark:text-amber-200 leading-relaxed">
                <strong className="font-semibold">
                  {formatAmount(sumProofs(verification.stale))} leks were already spent.
                </strong>{" "}
                The mint reports these tokens as used (for example by another browser tab or an
                external wallet). They can't be spent again and are not counted in your balance.
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={removing}
                    onClick={() => handleRemoveFlagged("stale")}
                    data-testid="remove-stale-button"
                  >
                    Remove them from this browser
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-12">
        <h2 className="text-lg font-semibold mb-4">Activity Log</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No local activity yet.</p>
        ) : (
          <div className="space-y-3">
            {history.map((entry) => (
              <Card key={entry.id} className="overflow-hidden bg-transparent border-border shadow-none">
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <div className="font-medium">{HISTORY_LABELS[entry.type] ?? entry.type}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {format(new Date(entry.createdAt), "MMM d, yyyy h:mm a")}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {entry.type === "send" && entry.token && (
                      <CopyButton value={entry.token} />
                    )}
                    <div className={`font-semibold ${entry.type === "mint" || entry.type === "receive" || entry.type === "upgrade" ? "text-green-600 dark:text-green-400" : ""}`}>
                      {entry.type === "send" || entry.type === "redeem" ? "-" : "+"}
                      {formatAmount(entry.amount)} leks
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

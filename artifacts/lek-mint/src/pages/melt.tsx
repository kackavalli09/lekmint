import { useState, useRef, useEffect, useMemo } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AmountInput } from "@/components/ui/amount-input";
import { Clock, TrendingUp, RefreshCw } from "lucide-react";
import {
  useGetActiveKeys,
  useGetEpochs,
  useGetMeltQuote,
  getGetMeltQuoteQueryKey,
  useSwapTokens,
  useRedeemTokens,
  useUpgradeTokens,
  type Proof,
} from "@workspace/api-client-react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  getAllProofs,
  removeProofs,
  addProofs,
  addHistory,
  saveBlindings,
  deleteBlindings,
  subscribe,
} from "@/lib/proofStore";
import {
  selectProofs,
  planMeltSwap,
  partitionMeltProofs,
  partitionProofsByKeyset,
  planUpgrade,
  unblindSignatures,
  sumProofs,
} from "@/lib/wallet";
import { filterSpendable } from "@/lib/walletVerify";
import { formatAmount } from "@/lib/utils";
import { toast } from "sonner";
import { useWalletStore } from "@/hooks/use-wallet";

/** Loose mainnet BTC address shape check (server does authoritative parsing). */
/** Trim trailing zeros from a rate index string: "1.000000000000" -> "1", "1.500000" -> "1.5". */
function formatRateIndex(rate: string): string {
  if (!rate.includes(".")) return rate;
  return rate.replace(/0+$/, "").replace(/\.$/, "");
}

function looksLikeMainnetAddress(address: string): boolean {
  const a = address.trim();
  return (
    /^bc1[ac-hj-np-z02-9]{11,87}$/i.test(a) ||
    /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a)
  );
}

export default function MeltPage() {
  const [address, setAddress] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [meltedAmount, setMeltedAmount] = useState<number | null>(null);
  const [paidTo, setPaidTo] = useState("");

  const { balance } = useWalletStore();
  const { data: keysData } = useGetActiveKeys();
  const { data: epochsData } = useGetEpochs();

  // Track local proofs so we can detect vintage (old-epoch) proofs that must
  // be upgraded before burning — melting them at face value would silently
  // forfeit the R_current/R_vintage appreciation.
  const [localProofs, setLocalProofs] = useState<Proof[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      getAllProofs().then((p) => {
        if (!cancelled) setLocalProofs(filterSpendable(p));
      });
    };
    refresh();
    const unsubscribe = subscribe(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const vintageInfo = useMemo(() => {
    if (!keysData?.keysetId) return null;
    const { vintage } = partitionProofsByKeyset(localProofs, keysData.keysetId);
    if (vintage.length === 0) return null;
    const faceValue = sumProofs(vintage);
    let projectedValue: number | null = null;
    if (epochsData?.currentRateIndex && epochsData.epochs) {
      try {
        projectedValue = planUpgrade(
          vintage,
          epochsData.epochs,
          epochsData.currentRateIndex,
          keysData.keysetId,
        ).newValue;
      } catch {
        projectedValue = null;
      }
    }
    return { faceValue, projectedValue };
  }, [localProofs, keysData, epochsData]);

  // Live BTC estimate for the entered amount. Computed SERVER-side with the
  // exact same formula the operator payout queue uses (see /melt/quote), so
  // the number shown here can never disagree with the queue.
  const quoteAmount = parseInt(amountStr);
  const quoteEnabled = Number.isFinite(quoteAmount) && quoteAmount > 0;
  const quoteParams = { amountLeks: quoteEnabled ? quoteAmount : 1 };
  const { data: quote, isFetching: quoteFetching } = useGetMeltQuote(quoteParams, {
    query: {
      enabled: quoteEnabled,
      placeholderData: keepPreviousData,
      staleTime: 30_000,
      queryKey: getGetMeltQuoteQueryKey(quoteParams),
    },
  });
  const swapTokens = useSwapTokens();
  const redeemTokens = useRedeemTokens();
  const upgradeTokens = useUpgradeTokens();

  const swapTokensRef = useRef(swapTokens.mutate);
  swapTokensRef.current = swapTokens.mutate;
  const redeemTokensRef = useRef(redeemTokens.mutate);
  redeemTokensRef.current = redeemTokens.mutate;
  const upgradeTokensRef = useRef(upgradeTokens.mutateAsync);
  upgradeTokensRef.current = upgradeTokens.mutateAsync;

  /**
   * Upgrade all vintage (old-epoch) proofs to the current keyset BEFORE any
   * burn, so the user is credited the full R_current/R_vintage appreciation.
   * Returns the refreshed proof list. Follows the wallet durability rule:
   * new proofs are stored before the old ones are removed.
   */
  const upgradeVintageProofs = async (proofs: Proof[]): Promise<Proof[]> => {
    if (!keysData) throw new Error("Mint keys not available. Go online to melt.");
    const { vintage } = partitionProofsByKeyset(proofs, keysData.keysetId);
    if (vintage.length === 0) return proofs;
    if (!epochsData?.currentRateIndex || !epochsData.epochs) {
      throw new Error("Epoch rate data not available. Go online and retry.");
    }

    const plan = planUpgrade(
      vintage,
      epochsData.epochs,
      epochsData.currentRateIndex,
      keysData.keysetId,
    );

    const context = `melt-upgrade-${Date.now()}`;
    const blindingsWithContext = plan.blindings.map((b) => ({
      ...b,
      context,
      createdAt: new Date().toISOString(),
    }));
    await saveBlindings(blindingsWithContext);

    const data = await upgradeTokensRef.current({
      data: { proofs: vintage, outputs: plan.outputs },
    });
    const newProofs = unblindSignatures(data.signatures, blindingsWithContext, keysData.keys);

    // Durability ordering: store new proofs first, then retire the old ones.
    await addProofs(newProofs);
    await removeProofs(vintage.map((p) => p.secret));
    await deleteBlindings(blindingsWithContext.map((b) => b.B_));
    await addHistory({
      type: "upgrade",
      amount: data.newValue,
      detail: `Updated from ${data.oldValue} before melting`,
      createdAt: new Date().toISOString(),
    });
    toast.info(
      `Updated ${formatAmount(data.oldValue)} old-epoch leks to ${formatAmount(data.newValue)} at the current rate before melting.`,
    );

    return filterSpendable(await getAllProofs());
  };

  /**
   * Burn the given proofs at the mint. Local proofs are removed ONLY after
   * the server confirms the burn — a failed request never touches the wallet.
   */
  const doRedeem = (proofs: Proof[], amount: number, btcAddress: string) => {
    redeemTokensRef.current(
      { data: { proofs, btcAddress } },
      {
        onSuccess: async (data) => {
          await addHistory({
            type: "redeem",
            amount: data.redeemedAmount,
            detail: `Payout to ${btcAddress}`,
            createdAt: new Date().toISOString(),
          });
          await removeProofs(proofs.map((p) => p.secret));
          setMeltedAmount(data.redeemedAmount);
          setPaidTo(btcAddress);
          setIsProcessing(false);
          toast.success("Leks melted — payout queued for the next batch.");
        },
        onError: (err: any) => {
          console.error(err);
          if (err?.status === 409) {
            toast.error(
              "One or more of your proofs were already spent at the mint. Try the Recover tab to clean up your wallet.",
            );
          } else if (err?.status === 400) {
            toast.error(err?.data?.error || "The mint rejected the request.");
          } else {
            toast.error("Failed to melt. Check your connection and try again.");
          }
          setIsProcessing(false);
        },
      },
    );
  };

  const handleMelt = async () => {
    const amount = parseInt(amountStr);
    const btcAddress = address.trim();
    if (!btcAddress || !looksLikeMainnetAddress(btcAddress)) {
      toast.error("Enter a valid on-chain BTC address (bc1…, 1…, or 3…).");
      return;
    }
    if (!amount || amount <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    if (amount > balance) {
      toast.error("Insufficient balance");
      return;
    }

    setIsProcessing(true);
    try {
      // Step 1: never burn vintage proofs at face value — upgrade them to
      // the current epoch first so the estimate shown (at R_current) matches
      // what the payout queue will owe for the proofs actually burned.
      // Never select proofs flagged as unspendable-here (foreign/stale).
      let proofs = filterSpendable(await getAllProofs());
      proofs = await upgradeVintageProofs(proofs);

      const selection = selectProofs(proofs, amount);

      if (selection.exact) {
        doRedeem(selection.send, amount, btcAddress);
        return; // wait for mutation callback
      }

      // No exact subset — swap online for exact denominations first, so we
      // never burn more than the requested amount.
      if (!keysData) {
        toast.error("Mint keys not available. Go online to melt.");
        setIsProcessing(false);
        return;
      }

      const context = `melt-swap-${Date.now()}`;
      const plan = planMeltSwap(selection, amount, keysData.keysetId);

      const allBlindings = plan.blindings.map((b) => ({
        ...b,
        context,
        createdAt: new Date().toISOString(),
      }));

      await saveBlindings(allBlindings);

      swapTokensRef.current(
        { data: { inputs: selection.send, outputs: plan.outputs } },
        {
          onSuccess: async (data) => {
            try {
              const newProofs = unblindSignatures(data.signatures, allBlindings, keysData.keys);

              // Shared partition logic (also exercised by the e2e test):
              // melt denominations first, then change. Throws if the melt
              // slice does not sum to exactly `amount` — never over-burns.
              const { meltProofs: proofsToMelt } = partitionMeltProofs(plan, newProofs);

              // Durability ordering: store ALL new proofs first, only then
              // retire the old (now mint-spent) inputs. A crash mid-sequence
              // leaves at worst stale spent proofs, never lost funds. The
              // melt proofs stay in the wallet until the burn is confirmed.
              await addProofs(newProofs);
              await removeProofs(selection.send.map((p) => p.secret));
              await deleteBlindings(allBlindings.map((b) => b.B_));

              doRedeem(proofsToMelt, amount, btcAddress);
            } catch (err) {
              console.error(err);
              toast.error("Failed to unblind swap signatures.");
              setIsProcessing(false);
            }
          },
          onError: (err) => {
            console.error(err);
            toast.error("Failed to prepare exact denominations for melting.");
            setIsProcessing(false);
          },
        },
      );
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to melt leks.");
      setIsProcessing(false);
    }
  };

  const handleReset = () => {
    setAddress("");
    setAmountStr("");
    setMeltedAmount(null);
    setPaidTo("");
  };

  return (
    <Layout>
      <div className="max-w-md mx-auto mt-8">
        <h1 className="text-3xl font-bold mb-6">Melt Leks to BTC</h1>

        {meltedAmount === null ? (
          <Card className="shadow-none border-border">
            <CardContent className="pt-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">BTC payout address</label>
                  <Input
                    placeholder="bc1…"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    className="font-mono text-sm"
                  />
                  <div className="mt-1 text-xs text-muted-foreground">
                    On-chain BTC address you control. Payouts settle in batches — double-check it.
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Amount to melt</label>
                  <AmountInput
                    placeholder="0"
                    value={amountStr}
                    onValueChange={setAmountStr}
                  />
                  <div className="mt-1 text-xs text-muted-foreground flex justify-between">
                    <span>Available: {formatAmount(balance)} leks</span>
                    <button
                      type="button"
                      onClick={() => setAmountStr(balance.toString())}
                      className="hover:underline"
                    >
                      Max
                    </button>
                  </div>
                </div>

                {vintageInfo && (
                  <div
                    className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded-md p-3 text-xs text-amber-900 dark:text-amber-200 leading-relaxed flex gap-2.5"
                    data-testid="melt-vintage-notice"
                  >
                    <RefreshCw className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      <strong className="font-semibold">
                        {formatAmount(vintageInfo.faceValue)} of your leks are from an older
                        epoch.
                      </strong>{" "}
                      They will be updated automatically before melting
                      {vintageInfo.projectedValue !== null ? (
                        <>
                          {" "}
                          — worth{" "}
                          <strong className="font-semibold">
                            {formatAmount(vintageInfo.projectedValue)} leks
                          </strong>{" "}
                          at today's rate — so you're never paid out below the current rate.
                        </>
                      ) : (
                        <> so you're never paid out below the current rate.</>
                      )}{" "}
                      You can also update them yourself on the Update tab.
                    </span>
                  </div>
                )}

                {quoteEnabled && quote && (
                  <div
                    className="border rounded-md p-3 space-y-1.5"
                    data-testid="melt-estimate"
                  >
                    <div className={`space-y-1 text-xs ${quoteFetching ? "opacity-60" : ""}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          Value at issuance rate {formatRateIndex(quote.rateIndex)}
                        </span>
                        <span className="font-medium">{formatAmount(quote.estimatedGrossSats)} sats</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Melt fee (deducted)</span>
                        <span className="font-medium">− {formatAmount(quote.estimatedFeeSats)} sats</span>
                      </div>
                      <div className="flex items-center justify-between" data-testid="melt-network-fee">
                        <span className="text-muted-foreground">
                          Network transfer fee (deducted
                          {quote.networkFee.source === "live"
                            ? `, live: ${quote.networkFee.satPerVb} sat/vB`
                            : `, fallback rate: ${quote.networkFee.satPerVb} sat/vB`}
                          )
                        </span>
                        <span className="font-medium">− {formatAmount(quote.estimatedNetworkFeeSats)} sats</span>
                      </div>
                      <div className="flex items-center justify-between border-t pt-1.5 mt-1.5 text-sm">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                          <TrendingUp className="w-3.5 h-3.5" />
                          Estimated BTC payout
                        </span>
                        <span className="font-semibold">≈ {formatAmount(quote.estimatedNetSats)} sats</span>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      The network transfer fee is deducted from your payout, separately from the
                      melt fee. It's an estimate and may change with network conditions before
                      your batch settles.
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <strong className="text-foreground/80 font-medium">Estimate only:</strong>{" "}
                      the final BTC amount is recalculated from the issuance rate and melt fee
                      schedule when the operator prepares your payout batch.
                    </div>
                  </div>
                )}

                <div className="text-sm text-muted-foreground bg-muted/50 border p-3 rounded-md leading-relaxed flex gap-2.5">
                  <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    Melting burns your leks immediately, but the BTC payout is{" "}
                    <strong className="text-foreground font-semibold">not instant</strong>: payouts
                    are settled later in batches from cold storage.
                  </span>
                </div>

                <Button
                  className="w-full font-bold h-12"
                  onClick={handleMelt}
                  disabled={isProcessing || !amountStr || parseInt(amountStr) <= 0 || !address.trim()}
                >
                  {isProcessing ? "Processing..." : "Melt to BTC"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="shadow-none border-border overflow-hidden">
            <div className="bg-muted p-4 text-center border-b border-border">
              <div className="text-sm font-medium uppercase tracking-widest text-muted-foreground mb-1">
                Melted
              </div>
              <div className="text-xl font-bold">{formatAmount(meltedAmount)} Leks</div>
            </div>
            <CardContent className="pt-6 flex flex-col items-center space-y-6">
              <div className="w-full space-y-2">
                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Payout address
                </label>
                <code className="block bg-background border px-3 py-2.5 rounded-lg text-xs overflow-x-auto whitespace-nowrap">
                  {paidTo}
                </code>
              </div>

              <div className="text-sm text-center text-muted-foreground bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 p-3 rounded-md w-full leading-relaxed">
                Your leks are burned and the payout is queued. BTC arrives with the next
                operator batch from cold storage — there is no instant withdrawal.
              </div>

              <Button variant="ghost" className="w-full" onClick={handleReset}>
                Melt More
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}

import { useState, useRef } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AmountInput } from "@/components/ui/amount-input";
import { formatAmount } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { QRCodeSVG } from "qrcode.react";
import { 
  useGetActiveKeys,
  useSwapTokens 
} from "@workspace/api-client-react";
import { 
  getAllProofs,
  removeProofs,
  addProofs,
  addHistory,
  saveBlindings,
  getBlindingsByContext,
  deleteBlindings
} from "@/lib/proofStore";
import { 
  selectProofs, 
  buildToken, 
  getMintUrl, 
  createBlindedOutputs,
  unblindSignatures
} from "@/lib/wallet";
import { filterSpendable } from "@/lib/walletVerify";
import { toast } from "sonner";
import { useWalletStore } from "@/hooks/use-wallet";

export default function SendPage() {
  const [amountStr, setAmountStr] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const { balance } = useWalletStore();
  const { data: keysData } = useGetActiveKeys();
  const swapTokens = useSwapTokens();

  const swapTokensRef = useRef(swapTokens.mutate);
  swapTokensRef.current = swapTokens.mutate;

  const handleSend = async () => {
    const amount = parseInt(amountStr);
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
      // Never select proofs flagged as unspendable-here (foreign/stale).
      const proofs = filterSpendable(await getAllProofs());
      const selection = selectProofs(proofs, amount);

      if (selection.exact) {
        // Fully offline exact send.
        // Persist the token to durable history BEFORE removing the proofs so a
        // crash between the two steps can never lose the funds.
        const v3Token = buildToken(getMintUrl(), selection.send, "Lek Mint Offline Send");
        await addHistory({ type: "send", amount, token: v3Token, createdAt: new Date().toISOString() });
        await removeProofs(selection.send.map(p => p.secret));
        setToken(v3Token);
        toast.success("Token generated successfully!");
      } else {
        // Need online swap for exact change
        if (!keysData) {
          toast.error("Mint keys not available for online swap. Go online to sync.");
          setIsProcessing(false);
          return;
        }

        const context = `swap-${Date.now()}`;
        
        // We need outputs for the exact amount we want to send, AND outputs for the change.
        const changeAmount = selection.total - amount;
        
        const sendOutputsResult = createBlindedOutputs(amount, keysData.keysetId);
        const changeOutputsResult = createBlindedOutputs(changeAmount, keysData.keysetId);
        
        const allBlindings = [
          ...sendOutputsResult.blindings,
          ...changeOutputsResult.blindings
        ].map(b => ({
          ...b,
          context,
          createdAt: new Date().toISOString()
        }));
        
        await saveBlindings(allBlindings);
        
        const allOutputs = [
          ...sendOutputsResult.outputs,
          ...changeOutputsResult.outputs
        ];

        swapTokensRef.current(
          { data: { inputs: selection.send, outputs: allOutputs } },
          {
            onSuccess: async (data) => {
              try {
                const newProofs = unblindSignatures(data.signatures, allBlindings, keysData.keys);
                
                // The mint signs outputs in the exact order we sent them.
                // So the first `sendOutputsResult.outputs.length` signatures are the send proofs.
                const proofsToSend = newProofs.slice(0, sendOutputsResult.outputs.length);
                const proofsToKeep = newProofs.slice(sendOutputsResult.outputs.length);
                
                const v3Token = buildToken(getMintUrl(), proofsToSend, "Lek Mint Swapped Send");

                // Durability ordering: store the new change proofs and the send
                // token FIRST, only then retire the old (now mint-spent) proofs.
                // A crash mid-sequence leaves at worst stale spent proofs, never
                // lost funds.
                await addProofs(proofsToKeep);
                await addHistory({ type: "send", amount, token: v3Token, createdAt: new Date().toISOString() });
                await removeProofs(selection.send.map(p => p.secret));
                await deleteBlindings(allBlindings.map(b => b.B_));

                setToken(v3Token);
                toast.success("Token generated via swap successfully!");
              } catch (err) {
                console.error(err);
                toast.error("Failed to unblind swap signatures.");
              } finally {
                setIsProcessing(false);
              }
            },
            onError: (err) => {
              console.error(err);
              toast.error("Failed to swap tokens for exact change.");
              setIsProcessing(false);
            }
          }
        );
        return; // wait for mutation callback
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to create send token.");
    }
    setIsProcessing(false);
  };

  const handleReset = () => {
    setAmountStr("");
    setToken(null);
  };

  return (
    <Layout>
      <div className="max-w-md mx-auto mt-8">
        <h1 className="text-3xl font-bold mb-6">Send Leks</h1>
        
        {!token ? (
          <Card className="shadow-none border-border">
            <CardContent className="pt-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Amount to send</label>
                  <AmountInput
                    placeholder="0"
                    value={amountStr}
                    onValueChange={setAmountStr}
                  />
                  <div className="mt-1 text-xs text-muted-foreground flex justify-between">
                    <span>Available: {formatAmount(balance)} leks</span>
                    <button type="button" onClick={() => setAmountStr(balance.toString())} className="hover:underline">Max</button>
                  </div>
                </div>
                <Button 
                  className="w-full font-bold h-12" 
                  onClick={handleSend}
                  disabled={isProcessing || !amountStr || parseInt(amountStr) <= 0}
                >
                  {isProcessing ? "Processing..." : "Create Token"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="shadow-none border-border overflow-hidden">
            <div className="bg-muted p-4 text-center border-b border-border">
              <div className="text-sm font-medium uppercase tracking-widest text-muted-foreground mb-1">Send Token</div>
              <div className="text-xl font-bold">{formatAmount(amountStr)} Leks</div>
            </div>
            <CardContent className="pt-8 flex flex-col items-center space-y-6">
              <div className="bg-white p-4 rounded-xl">
                <QRCodeSVG value={token} size={200} />
              </div>
              
              <div className="w-full space-y-2">
                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Token String</label>
                <div className="flex gap-2">
                  <Input readOnly value={token} className="font-mono text-xs" />
                  <CopyButton value={token} />
                </div>
              </div>

              <div className="text-sm text-center text-muted-foreground bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 p-3 rounded-md w-full">
                This token is bearer cash. Anyone with this string can claim the funds.
              </div>

              <Button variant="ghost" className="w-full" onClick={handleReset}>
                Send Another
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}

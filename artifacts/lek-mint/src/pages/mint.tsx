import { useEffect, useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AmountInput } from "@/components/ui/amount-input";
import { formatAmount } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { QRCodeSVG } from "qrcode.react";
import { 
  useCreateMintRequest, 
  useGetMintRequestStatus, 
  getGetMintRequestStatusQueryKey,
  useGetActiveKeys,
  useIssueTokens 
} from "@workspace/api-client-react";
import { 
  saveMintRequest, 
  getPendingMintRequest, 
  saveBlindings, 
  getBlindingsByContext,
  addProofs,
  addHistory,
  deleteMintRequest,
  deleteBlindings
} from "@/lib/proofStore";
import { createBlindedOutputs, unblindSignatures } from "@/lib/wallet";
import { toast } from "sonner";

export default function MintPage() {
  const [amountSats, setAmountSats] = useState<string>("");
  const [pendingReqId, setPendingReqId] = useState<string | null>(null);
  
  const createMintReq = useCreateMintRequest();
  const issueTokens = useIssueTokens();
  const { data: keysData } = useGetActiveKeys();
  const queryClient = useQueryClient();

  useEffect(() => {
    getPendingMintRequest().then((req) => {
      if (req && !req.completed) {
        setPendingReqId(req.id);
      }
    });
  }, []);

  const { data: reqStatus, refetch: refetchStatus } = useGetMintRequestStatus(
    pendingReqId ?? "",
    { query: { enabled: !!pendingReqId, refetchInterval: 5000, queryKey: getGetMintRequestStatusQueryKey(pendingReqId ?? "") } }
  );

  const issueTokensRef = useRef(issueTokens.mutate);
  issueTokensRef.current = issueTokens.mutate;

  const handleIssue = async () => {
    if (!reqStatus || reqStatus.status !== "confirmed" || !keysData) return;
    
    try {
      // The mint issues leks at the CURRENT epoch rate (floor(netSats × rate));
      // the server tells us the exact issuable amount via expectedLeks.
      const netAmountLeks = reqStatus.expectedLeks;
      if (!netAmountLeks) {
        toast.error("Mint request confirmed but missing issuable amount.");
        return;
      }

      // Check if we already created blindings for this context to avoid double-issuing if we crash
      const context = `mint-${reqStatus.id}`;
      let storedBlindings = await getBlindingsByContext(context);
      
      let outputs;
      if (storedBlindings.length > 0) {
        outputs = storedBlindings.map(b => ({
          id: b.keysetId,
          amount: b.amount,
          B_: b.B_
        }));
      } else {
        const result = createBlindedOutputs(netAmountLeks, keysData.keysetId);
        const blindingsToStore = result.blindings.map(b => ({
          ...b,
          context,
          createdAt: new Date().toISOString()
        }));
        await saveBlindings(blindingsToStore);
        storedBlindings = blindingsToStore;
        outputs = result.outputs;
      }

      issueTokensRef.current(
        { data: { requestId: reqStatus.id, outputs } },
        {
          onSuccess: async (data) => {
            try {
              const proofs = unblindSignatures(data.signatures, storedBlindings, keysData.keys);
              await addProofs(proofs);
              await deleteBlindings(storedBlindings.map(b => b.B_));
              await deleteMintRequest(reqStatus.id);
              await addHistory({ type: "mint", amount: netAmountLeks, createdAt: new Date().toISOString() });
              
              setPendingReqId(null);
              toast.success(`Successfully minted ${formatAmount(netAmountLeks)} leks!`);
            } catch (err) {
              console.error(err);
              toast.error("Failed to unblind signatures.");
            }
          },
          onError: (err) => {
            console.error(err);
            toast.error("Failed to issue tokens from mint.");
          }
        }
      );
    } catch (err) {
      console.error(err);
      toast.error("Failed to create blinded outputs.");
    }
  };

  useEffect(() => {
    if (reqStatus?.status === "confirmed") {
      handleIssue();
    }
  }, [reqStatus?.status]);

  const handleCreateRequest = () => {
    const amt = amountSats ? parseInt(amountSats) : undefined;
    createMintReq.mutate(
      { data: { amountSats: amt } },
      {
        onSuccess: async (data) => {
          await saveMintRequest({
            id: data.id,
            btcAddress: data.btcAddress,
            status: data.status,
            completed: false,
            createdAt: new Date().toISOString()
          });
          setPendingReqId(data.id);
        },
        onError: (err: any) => {
          if (err?.status === 503) {
            toast.error("Minting is temporarily unavailable — the mint has no deposit wallet configured. Please try again later.");
          } else {
            toast.error("Failed to create deposit request.");
          }
        }
      }
    );
  };

  const handleCancel = async () => {
    if (pendingReqId) {
      await deleteMintRequest(pendingReqId);
      setPendingReqId(null);
    }
  };

  return (
    <Layout>
      <div className="max-w-md mx-auto mt-8">
        <h1 className="text-3xl font-bold mb-6">Mint Leks</h1>
        
        {!pendingReqId ? (
          <Card className="shadow-none border-border">
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground mb-6">
                Generate a new Bitcoin deposit address. Leks are pegged to Bitcoin mining difficulty — a unit of embodied energy cost.
              </p>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Expected Deposit (sats, optional)</label>
                  <AmountInput
                    placeholder="e.g. 100,000"
                    value={amountSats}
                    onValueChange={setAmountSats}
                  />
                </div>
                <Button 
                  className="w-full font-bold h-12" 
                  onClick={handleCreateRequest}
                  disabled={createMintReq.isPending}
                >
                  {createMintReq.isPending ? "Generating..." : "Generate Deposit Address"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : reqStatus ? (
          <Card className="shadow-none border-border overflow-hidden">
            <div className="bg-muted p-4 text-center border-b border-border">
              <div className="text-sm font-medium uppercase tracking-widest text-muted-foreground mb-1">Status</div>
              <div className="text-xl font-bold capitalize">
                {reqStatus.status.replace("_", " ")}
              </div>
            </div>
            <CardContent className="pt-8 flex flex-col items-center space-y-6">
              <div className="bg-white p-4 rounded-xl">
                <QRCodeSVG value={reqStatus.btcAddress} size={200} />
              </div>
              
              <div className="w-full space-y-2">
                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Deposit Address</label>
                <div className="flex gap-2">
                  <Input readOnly value={reqStatus.btcAddress} className="font-mono text-sm" />
                  <CopyButton value={reqStatus.btcAddress} />
                </div>
              </div>

              {reqStatus.minConfirmations && (
                <div className="w-full text-center text-sm text-muted-foreground bg-muted p-3 rounded-md">
                  Requires {reqStatus.minConfirmations} confirmation{reqStatus.minConfirmations > 1 ? 's' : ''}.
                  {reqStatus.confirmations !== undefined && reqStatus.confirmations !== null && (
                    <span className="block mt-1 font-medium text-foreground">
                      Current: {reqStatus.confirmations} / {reqStatus.minConfirmations}
                    </span>
                  )}
                </div>
              )}

              <Button variant="ghost" className="text-destructive w-full" onClick={handleCancel}>
                Cancel Request
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="text-center text-muted-foreground p-8">
            Loading request...
          </div>
        )}
      </div>
    </Layout>
  );
}

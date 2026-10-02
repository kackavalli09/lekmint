import { useGetFeeConfig, useUpdateFeeConfig, getGetFeeConfigQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Card, CardHeader, CardTitle, CardContent, CardDescription, Button, Input, Label } from "@/components/ui/core";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect, useState } from "react";
import { formatSats, digitsOnly } from "@/lib/utils";
import { AmountInput } from "@/components/ui/amount-input";
import { Loader2, Save, Calculator, ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronUp } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

const feeSchema = z.object({
  fixedFeeSats: z.coerce.number().min(0, "Must be >= 0"),
  percentageFeeBps: z.coerce.number().min(0, "Must be >= 0").max(10000, "Max 10000 (100%)"),
  minThresholdSats: z.coerce.number().min(0, "Must be >= 0")
});
type FeeValues = z.infer<typeof feeSchema>;

/** Same formula as the server: 0 below threshold, else fixed + bps, capped. */
function previewFee(amount: number, values: FeeValues): number {
  if (amount < values.minThresholdSats) return 0;
  const fee = values.fixedFeeSats + Math.round((amount * values.percentageFeeBps) / 10_000);
  return Math.min(fee, amount);
}

interface FeeSectionProps {
  kind: "mint" | "melt";
  initial: FeeValues | null;
  updatedAt?: string;
  onSave: (payload: Record<string, number | null>, reset?: (v: FeeValues) => void) => void;
  saving: boolean;
  /** Melt only: false when melt fees currently inherit the mint values. */
  configured?: boolean;
}

function FeeSection({ kind, initial, updatedAt, onSave, saving, configured }: FeeSectionProps) {
  const isMint = kind === "mint";
  const [previewAmount, setPreviewAmount] = useState<string>("1000000");
  const form = useForm<FeeValues>({
    resolver: zodResolver(feeSchema),
    defaultValues: initial ?? { fixedFeeSats: 0, percentageFeeBps: 0, minThresholdSats: 0 },
  });

  useEffect(() => {
    if (initial) form.reset(initial);
  }, [initial, form]);

  const onSubmit = (values: FeeValues) => {
    const payload = isMint
      ? values
      : {
          meltFixedFeeSats: values.fixedFeeSats,
          meltPercentageFeeBps: values.percentageFeeBps,
          meltMinThresholdSats: values.minThresholdSats,
        };
    onSave(payload as Record<string, number | null>, (v) => form.reset(v));
  };

  const resetToMintDefaults = () => {
    onSave({ meltFixedFeeSats: null, meltPercentageFeeBps: null, meltMinThresholdSats: null });
  };

  const formValues = form.watch();
  const rawPreview = parseInt(digitsOnly(previewAmount) || "0", 10) || 0;
  const computedFee = previewFee(rawPreview, formValues);
  const netAmount = rawPreview - computedFee;
  const noun = isMint ? "deposit" : "payout";
  const tid = (s: string) => `${s}-${kind}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {isMint ? (
          <ArrowDownToLine className="w-5 h-5 text-accent" />
        ) : (
          <ArrowUpFromLine className="w-5 h-5 text-accent" />
        )}
        <h2 className="text-xl font-semibold tracking-tight">
          {isMint ? "Mint fees (deposits)" : "Melt fees (BTC payouts)"}
        </h2>
        {!isMint && configured !== undefined && (
          <span
            className={`text-xs px-2 py-0.5 rounded-full border ${
              configured
                ? "bg-accent/10 text-accent border-accent/30"
                : "bg-muted text-muted-foreground border-border"
            }`}
            data-testid="badge-melt-config-state"
          >
            {configured ? "Custom" : "Inheriting mint fees"}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="border-border shadow-sm">
          <CardHeader>
            <CardTitle>Fee Model</CardTitle>
            <CardDescription>
              {isMint
                ? "Charged when a BTC deposit is converted into leks."
                : "Charged when leks are redeemed for a BTC payout."}
              {updatedAt ? ` Last updated: ${new Date(updatedAt).toLocaleString()}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <FormField
                  control={form.control}
                  name="fixedFeeSats"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Fixed Fee (sats)</FormLabel>
                      <FormControl>
                        <AmountInput
                          name={field.name}
                          ref={field.ref}
                          onBlur={field.onBlur}
                          value={field.value}
                          onValueChange={field.onChange}
                          data-testid={tid("input-fixed-fee")}
                        />
                      </FormControl>
                      <FormDescription>Flat base fee charged per {noun}.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="percentageFeeBps"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Percentage Fee (bps)</FormLabel>
                      <FormControl>
                        <AmountInput
                          name={field.name}
                          ref={field.ref}
                          onBlur={field.onBlur}
                          value={field.value}
                          onValueChange={field.onChange}
                          data-testid={tid("input-percent-fee")}
                        />
                      </FormControl>
                      <FormDescription>Variable fee in basis points (100 bps = 1%).</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="minThresholdSats"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Minimum Threshold (sats)</FormLabel>
                      <FormControl>
                        <AmountInput
                          name={field.name}
                          ref={field.ref}
                          onBlur={field.onBlur}
                          value={field.value}
                          onValueChange={field.onChange}
                          data-testid={tid("input-min-threshold")}
                        />
                      </FormControl>
                      <FormDescription>
                        {isMint ? "Deposits" : "Payouts"} below this amount pay exactly 0 fees.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  disabled={saving || !form.formState.isDirty}
                  className="w-full"
                  data-testid={tid("button-save-fees")}
                >
                  {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  <Save className="w-4 h-4 mr-2" />
                  Save {isMint ? "Mint" : "Melt"} Fees
                </Button>
                {!isMint && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={saving || configured === false}
                    onClick={resetToMintDefaults}
                    data-testid="button-melt-use-mint-defaults"
                  >
                    Use mint fees for melts
                  </Button>
                )}
              </form>
            </Form>
          </CardContent>
        </Card>

        <Card className="border-border shadow-sm bg-muted/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calculator className="w-5 h-5 text-accent" />
              Live Preview
            </CardTitle>
            <CardDescription>
              Simulate these parameters against a hypothetical {noun}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label>Hypothetical {isMint ? "Deposit" : "Payout"} (sats)</Label>
              <AmountInput
                value={previewAmount}
                onValueChange={setPreviewAmount}
                className="font-mono text-lg"
                data-testid={tid("input-preview-amount")}
              />
            </div>

            <div className="rounded-md border bg-card divide-y">
              <div className="flex justify-between items-center p-4">
                <span className="text-sm font-medium text-muted-foreground">
                  {isMint ? "Gross Deposit" : "Gross Payout"}
                </span>
                <span className="font-mono">{formatSats(rawPreview)}</span>
              </div>
              <div className="flex justify-between items-center p-4">
                <span className="text-sm font-medium text-muted-foreground">Calculated Fee</span>
                <span className="font-mono text-destructive">-{formatSats(computedFee)}</span>
              </div>
              <div className="flex justify-between items-center p-4 bg-muted/20">
                <span className="text-sm font-bold text-foreground">
                  {isMint ? "Net Issuance" : "Net BTC Payout"}
                </span>
                <span className="font-mono font-bold text-green-600 text-lg">
                  {formatSats(netAmount)} {isMint ? "leks" : "sats"}
                </span>
              </div>
            </div>

            {rawPreview < formValues.minThresholdSats && (
              <div className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 p-3 rounded border border-amber-200 dark:border-amber-900/50">
                Note: {isMint ? "Deposit" : "Payout"} is below the minimum threshold (
                {formatSats(formValues.minThresholdSats)}). No fees are applied.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function Fees() {
  const { token, logout } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [mintFeesOpen, setMintFeesOpen] = useState(true);
  const [meltFeesOpen, setMeltFeesOpen] = useState(true);

  const { data: config, isLoading, error } = useGetFeeConfig({
    query: { enabled: !!token, retry: false, queryKey: getGetFeeConfigQueryKey() }
  });

  const updateFee = useUpdateFeeConfig();

  useEffect(() => {
    if (error && [401, 403, 503].includes((error as any).status)) {
      logout();
    }
  }, [error, logout]);

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;
  }

  const save = (label: string) => (payload: Record<string, number | null>) => {
    updateFee.mutate({ data: payload }, {
      onSuccess: (data) => {
        toast({ title: `${label} fee configuration updated` });
        queryClient.setQueryData(getGetFeeConfigQueryKey(), data);
      },
      onError: (err: any) => {
        toast({ title: "Update failed", description: err?.data?.error || err.message, variant: "destructive" });
      }
    });
  };

  return (
    <div className="space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-primary">Fee Configuration</h1>
        <p className="text-muted-foreground mt-2">
          Mint fees apply to incoming BTC deposits; melt fees apply to outgoing BTC payouts.
          The two components are configured independently.
        </p>
      </div>

      <Collapsible open={mintFeesOpen} onOpenChange={setMintFeesOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Mint Fees</h2>
          {mintFeesOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-8">
            <FeeSection
              kind="mint"
              initial={config ? {
                fixedFeeSats: config.fixedFeeSats,
                percentageFeeBps: config.percentageFeeBps,
                minThresholdSats: config.minThresholdSats,
              } : null}
              updatedAt={config?.updatedAt}
              onSave={save("Mint")}
              saving={updateFee.isPending}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={meltFeesOpen} onOpenChange={setMeltFeesOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Melt Fees</h2>
          {meltFeesOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-8">
            <FeeSection
              kind="melt"
              initial={config ? {
                fixedFeeSats: config.meltFixedFeeSats,
                percentageFeeBps: config.meltPercentageFeeBps,
                minThresholdSats: config.meltMinThresholdSats,
              } : null}
              updatedAt={config?.updatedAt}
              onSave={save("Melt")}
              saving={updateFee.isPending}
              configured={config?.meltConfigured}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

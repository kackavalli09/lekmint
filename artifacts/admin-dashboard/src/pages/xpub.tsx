import { useUpdateXpub, useGetMintSettings, getGetMintSettingsQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Card, CardHeader, CardTitle, CardContent, CardDescription, Button, Input, Badge } from "@/components/ui/core";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState } from "react";
import { Loader2, AlertTriangle, KeyRound, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatAmount } from "@/lib/utils";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

const xpubSchema = z.object({
  xpub: z.string().min(1, "xpub/zpub is required")
});

export default function Xpub() {
  const { token } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [successResult, setSuccessResult] = useState<any>(null);
  const [configOpen, setConfigOpen] = useState(true);

  const { data: settings } = useGetMintSettings({
    query: { enabled: !!token, retry: false, queryKey: getGetMintSettingsQueryKey() }
  });

  const updateXpub = useUpdateXpub();

  const form = useForm<z.infer<typeof xpubSchema>>({
    resolver: zodResolver(xpubSchema),
    defaultValues: { xpub: "" }
  });

  const onSubmit = (values: z.infer<typeof xpubSchema>) => {
    if (!confirmSubmit) {
      setConfirmSubmit(true);
      return;
    }

    updateXpub.mutate({ data: values }, {
      onSuccess: (data) => {
        toast({ title: "XPUB updated successfully" });
        setSuccessResult(data);
        form.reset();
        setConfirmSubmit(false);
        queryClient.invalidateQueries({ queryKey: getGetMintSettingsQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Update failed", description: err?.data?.error || err.message, variant: "destructive" });
        setConfirmSubmit(false);
      }
    });
  };

  return (
    <div className="space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-primary">XPUB Management</h1>
        <p className="text-muted-foreground mt-2">Configure the master public key for generating deposit addresses.</p>
      </div>

      <Collapsible open={configOpen} onOpenChange={setConfigOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">XPUB Configuration</h2>
          {configOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-8">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 space-y-6">
                <Card className="border-border shadow-sm border-destructive/20">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-destructive">
                      <AlertTriangle className="w-5 h-5" />
                      Critical Operation
                    </CardTitle>
                    <CardDescription>
                      Changing the XPUB modifies where all user deposits are sent. Ensure this matches an offline wallet you control.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Form {...form}>
                      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                        <FormField
                          control={form.control}
                          name="xpub"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Extended Public Key (xpub / zpub)</FormLabel>
                              <FormControl>
                                <Input {...field} placeholder="xpub..." className="font-mono text-xs" data-testid="input-xpub" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        {confirmSubmit && (
                          <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive-foreground">
                            <p className="font-bold mb-2">Are you absolutely sure?</p>
                            <p>This action takes effect immediately for all new mint requests.</p>
                          </div>
                        )}

                        <div className="flex gap-4">
                          {confirmSubmit && (
                            <Button 
                              type="button" 
                              variant="outline" 
                              onClick={() => setConfirmSubmit(false)}
                            >
                              Cancel
                            </Button>
                          )}
                          <Button 
                            type="submit" 
                            variant={confirmSubmit ? "destructive" : "default"}
                            disabled={updateXpub.isPending}
                            data-testid="button-submit-xpub"
                          >
                            {updateXpub.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                            {confirmSubmit ? "Confirm & Update XPUB" : "Submit XPUB"}
                          </Button>
                        </div>
                      </form>
                    </Form>
                  </CardContent>
                </Card>

                {successResult && (
                  <Card className="border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900/50 shadow-sm animate-in fade-in">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-green-700 dark:text-green-500">
                        <CheckCircle2 className="w-5 h-5" />
                        Verification Details
                      </CardTitle>
                      <CardDescription className="text-green-700/80 dark:text-green-500/80">
                        Please verify these derived addresses against your wallet.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="text-muted-foreground block mb-1">Derivation Path</span>
                          <code className="bg-background px-2 py-1 rounded border">{successResult.derivationPath}</code>
                        </div>
                        <div>
                          <span className="text-muted-foreground block mb-1">Next Index</span>
                          <code className="bg-background px-2 py-1 rounded border">{successResult.nextIndex}</code>
                        </div>
                      </div>
                      <div>
                        <span className="text-muted-foreground text-sm block mb-2">Sample Addresses</span>
                        <div className="space-y-2">
                          {successResult.sampleAddresses?.map((addr: string, i: number) => (
                            <div key={i} className="font-mono text-xs p-2 bg-background border rounded flex items-center gap-3">
                              <span className="text-muted-foreground shrink-0">m/{(successResult.nextIndex ?? 0) + i}</span>
                              <span>{addr}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>

              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <KeyRound className="w-5 h-5 text-muted-foreground" />
                      Current Status
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex justify-between items-center py-2 border-b">
                      <span className="text-sm font-medium text-muted-foreground">Configured</span>
                      {settings?.xpubConfigured ? (
                        <Badge variant="default" className="bg-green-600 hover:bg-green-700">Yes</Badge>
                      ) : (
                        <Badge variant="destructive">No</Badge>
                      )}
                    </div>
                    <div className="flex justify-between items-center py-2 border-b">
                      <span className="text-sm font-medium text-muted-foreground">Current Index</span>
                      <span className="font-mono text-sm">{settings?.derivationIndexCounter != null ? formatAmount(settings.derivationIndexCounter) : '—'}</span>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

import {
  useGetMintSettings,
  useUpdateMintSettings,
  getGetMintSettingsQueryKey,
  useGetAdminKeysets,
  getGetAdminKeysetsQueryKey,
  useRotateKeyset,
  useGetSocialLinks,
  useUpdateSocialLinks,
  getGetSocialLinksQueryKey,
  useGetEmailSettings,
  useUpdateEmailSettings,
  useSendTestEmail,
  getGetEmailSettingsQueryKey,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Card, CardHeader, CardTitle, CardContent, CardDescription, Button, Input, Badge } from "@/components/ui/core";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { formatAmount } from "@/lib/utils";
import { AmountInput } from "@/components/ui/amount-input";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect, useState } from "react";
import { Loader2, Save, Settings as SettingsIcon, KeyRound, AlertTriangle, ChevronDown, ChevronUp, Share2, Mail, Send } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

const settingsSchema = z.object({
  minConfirmations: z.coerce.number().min(1, "Must be >= 1").max(100, "Max 100")
});

const emailSchema = z.object({
  smtpUser: z.string().email("Must be a valid email (e.g. postmaster@lekmint.cash)").or(z.literal("")).optional(),
  smtpPass: z.string().optional(),
  operatorEmail: z.string().email("Must be a valid email").or(z.literal("")).optional(),
});

const NJUMP_PREFIX = "https://njump.me/";

const socialSchema = z.object({
  contactXUrl: z.string().url("Must be a valid URL").or(z.literal("")).optional(),
  contactNostrNpub: z.string().regex(/^(npub1[a-z0-9]{6,})?$/, "Must be a valid npub (e.g. npub1…)").optional(),
  contactEmail: z.string().email("Must be a valid email").or(z.literal("")).optional(),
});

function npubToUrl(npub: string | null | undefined): string | null {
  if (!npub) return null;
  return `${NJUMP_PREFIX}${npub.trim()}`;
}

function urlToNpub(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith(NJUMP_PREFIX)) return url.slice(NJUMP_PREFIX.length);
  return url;
}

export default function Settings() {
  const { token, logout } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [generalOpen, setGeneralOpen] = useState(true);
  const [socialOpen, setSocialOpen] = useState(true);
  const [emailOpen, setEmailOpen] = useState(true);
  const [dangerOpen, setDangerOpen] = useState(true);

  const { data: settings, isLoading, error } = useGetMintSettings({
    query: { enabled: !!token, retry: false, queryKey: getGetMintSettingsQueryKey() }
  });

  const updateSettings = useUpdateMintSettings();
  const { data: socialData } = useGetSocialLinks({ query: { enabled: !!token, queryKey: getGetSocialLinksQueryKey() } });
  const updateSocial = useUpdateSocialLinks();

  const { data: keysetsData } = useGetAdminKeysets({
    query: { enabled: !!token, retry: false, queryKey: getGetAdminKeysetsQueryKey() }
  });
  const rotateKeyset = useRotateKeyset();
  const [rotateConfirm, setRotateConfirm] = useState("");
  const ROTATE_PHRASE = "ROTATE AND VOID";

  const onRotate = () => {
    rotateKeyset.mutate({ data: { confirm: rotateConfirm } }, {
      onSuccess: (data) => {
        setRotateConfirm("");
        toast({
          title: "Keys rotated",
          description: `New keyset ${data.newKeysetId} is live. ${data.revokedKeysetIds.length} old keyset(s) revoked — all tokens signed by them are now void.`
        });
        queryClient.invalidateQueries({ queryKey: getGetAdminKeysetsQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Rotation failed", description: err?.data?.error || err.message, variant: "destructive" });
      }
    });
  };

  useEffect(() => {
    if (error && [401, 403, 503].includes((error as any).status)) {
      logout();
    }
  }, [error, logout]);

  const form = useForm<z.infer<typeof settingsSchema>>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      minConfirmations: 1
    }
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        minConfirmations: settings.minConfirmations
      });
    }
  }, [settings, form]);

  const { data: emailData } = useGetEmailSettings({ query: { enabled: !!token, queryKey: getGetEmailSettingsQueryKey() } });
  const updateEmail = useUpdateEmailSettings();
  const testEmail = useSendTestEmail();

  const emailForm = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema),
    defaultValues: { smtpUser: "", smtpPass: "", operatorEmail: "" },
  });

  useEffect(() => {
    if (emailData) {
      emailForm.reset({
        smtpUser: emailData.smtpUser ?? "",
        smtpPass: "",
        operatorEmail: emailData.operatorEmail ?? "",
      });
    }
  }, [emailData, emailForm]);

  const onSaveEmail = (values: z.infer<typeof emailSchema>) => {
    const data: Record<string, string> = {};
    if (values.smtpUser !== (emailData?.smtpUser ?? "")) data.smtpUser = values.smtpUser ?? "";
    if (values.smtpPass) data.smtpPass = values.smtpPass; // omit when blank — keeps current password
    if (values.operatorEmail !== (emailData?.operatorEmail ?? "")) data.operatorEmail = values.operatorEmail ?? "";
    if (Object.keys(data).length === 0) {
      toast({ title: "No changes to save" });
      return;
    }
    updateEmail.mutate({ data }, {
      onSuccess: (resp) => {
        toast({ title: "Email settings updated" });
        queryClient.setQueryData(getGetEmailSettingsQueryKey(), resp);
        emailForm.reset({ smtpUser: resp.smtpUser ?? "", smtpPass: "", operatorEmail: resp.operatorEmail ?? "" });
      },
      onError: (err: any) => {
        toast({ title: "Update failed", description: err?.data?.error || err.message, variant: "destructive" });
      },
    });
  };

  const onClearPassword = () => {
    updateEmail.mutate({ data: { smtpPass: "" } }, {
      onSuccess: (resp) => {
        toast({
          title: "Saved password cleared",
          description: resp.smtpPassSet
            ? "Now using the MAILGUN_SMTP_PASS secret."
            : "No password configured — email is disabled until one is set.",
        });
        queryClient.setQueryData(getGetEmailSettingsQueryKey(), resp);
        emailForm.reset({ smtpUser: resp.smtpUser ?? "", smtpPass: "", operatorEmail: resp.operatorEmail ?? "" });
      },
      onError: (err: any) => {
        toast({ title: "Clear failed", description: err?.data?.error || err.message, variant: "destructive" });
      },
    });
  };

  const onTestEmail = () => {
    testEmail.mutate(undefined, {
      onSuccess: (resp) => {
        toast({ title: "Test email sent", description: `Delivered to ${resp.to} — check the inbox.` });
      },
      onError: (err: any) => {
        toast({ title: "Test email failed", description: err?.data?.error || err.message, variant: "destructive" });
      },
    });
  };

  const socialForm = useForm<z.infer<typeof socialSchema>>({
    resolver: zodResolver(socialSchema),
    defaultValues: { contactXUrl: "", contactNostrNpub: "", contactEmail: "" },
  });

  useEffect(() => {
    if (socialData) {
      socialForm.reset({
        contactXUrl: socialData.contactXUrl ?? "",
        contactNostrNpub: urlToNpub(socialData.contactNostrUrl),
        contactEmail: socialData.contactEmail ?? "",
      });
    }
  }, [socialData, socialForm]);

  const onSaveSocial = (values: z.infer<typeof socialSchema>) => {
    updateSocial.mutate(
      {
        data: {
          contactXUrl: values.contactXUrl || null,
          contactNostrUrl: npubToUrl(values.contactNostrNpub),
          contactEmail: values.contactEmail || null,
        },
      },
      {
        onSuccess: (data) => {
          toast({ title: "Social links updated" });
          queryClient.setQueryData(getGetSocialLinksQueryKey(), data);
        },
        onError: (err: any) => {
          toast({ title: "Update failed", description: err?.data?.error || err.message, variant: "destructive" });
        },
      },
    );
  };

  const onSubmit = (values: z.infer<typeof settingsSchema>) => {
    updateSettings.mutate({ data: values }, {
      onSuccess: (data) => {
        toast({ title: "Settings updated" });
        queryClient.setQueryData(getGetMintSettingsQueryKey(), data);
      },
      onError: (err: any) => {
        toast({ title: "Update failed", description: err?.data?.error || err.message, variant: "destructive" });
      }
    });
  };

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-primary">Mint Settings</h1>
        <p className="text-muted-foreground mt-2">Operational settings for deposit confirmation and security.</p>
      </div>

      <Collapsible open={generalOpen} onOpenChange={setGeneralOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">General Settings</h2>
          {generalOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-8">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <Card className="border-border shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <SettingsIcon className="w-5 h-5" />
                    General Parameters
                  </CardTitle>
                  <CardDescription>
                    Last updated: {settings?.updatedAt ? new Date(settings.updatedAt).toLocaleString() : 'Never'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                      <FormField
                        control={form.control}
                        name="minConfirmations"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Minimum Confirmations</FormLabel>
                            <FormControl>
                              <AmountInput
                                name={field.name}
                                ref={field.ref}
                                onBlur={field.onBlur}
                                value={field.value}
                                onValueChange={field.onChange}
                                data-testid="input-min-conf"
                              />
                            </FormControl>
                            <FormDescription>Number of on-chain Bitcoin confirmations required before allowing tokens to be issued.</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button 
                        type="submit" 
                        disabled={updateSettings.isPending || !form.formState.isDirty} 
                        className="w-full"
                        data-testid="button-save-settings"
                      >
                        {updateSettings.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        <Save className="w-4 h-4 mr-2" />
                        Save Settings
                      </Button>
                    </form>
                  </Form>
                </CardContent>
              </Card>

              <Card className="border-border shadow-sm">
                <CardHeader>
                  <CardTitle>System Status</CardTitle>
                  <CardDescription>Read-only environment flags.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex justify-between items-center py-3 border-b">
                    <span className="text-sm font-medium text-muted-foreground">XPUB Configured</span>
                    {settings?.xpubConfigured ? (
                      <Badge variant="default" className="bg-green-600 hover:bg-green-700">Ready</Badge>
                    ) : (
                      <Badge variant="destructive">Pending Setup</Badge>
                    )}
                  </div>
                  <div className="flex justify-between items-center py-3 border-b">
                    <span className="text-sm font-medium text-muted-foreground">Derivation Index</span>
                    <span className="font-mono text-sm">{formatAmount(settings?.derivationIndexCounter ?? 0)}</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={socialOpen} onOpenChange={setSocialOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Social &amp; Contact Links</h2>
          {socialOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-8">
            <Card className="border-border shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Share2 className="w-5 h-5" />
                  Public Contact Links
                </CardTitle>
                <CardDescription>
                  These appear in the footer of the public wallet site. Leave blank to hide an icon.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...socialForm}>
                  <form onSubmit={socialForm.handleSubmit(onSaveSocial)} className="space-y-4">
                    <FormField
                      control={socialForm.control}
                      name="contactXUrl"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>X (Twitter) URL</FormLabel>
                          <FormControl>
                            <Input placeholder="https://x.com/yourprofile" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={socialForm.control}
                      name="contactNostrNpub"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Nostr (npub)</FormLabel>
                          <FormControl>
                            <Input placeholder="npub1…" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={socialForm.control}
                      name="contactEmail"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Contact Email</FormLabel>
                          <FormControl>
                            <Input placeholder="hello@lekmint.cash" type="email" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type="submit"
                      disabled={updateSocial.isPending || !socialForm.formState.isDirty}
                      className="w-full"
                    >
                      {updateSocial.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      <Save className="w-4 h-4 mr-2" />
                      Save Links
                    </Button>
                  </form>
                </Form>
              </CardContent>
            </Card>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={emailOpen} onOpenChange={setEmailOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Email</h2>
          {emailOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-8">
            <Card className="border-border shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mail className="w-5 h-5" />
                  Outbound Email (Mailgun SMTP)
                </CardTitle>
                <CardDescription>
                  Used for operator alerts. Values saved here override the environment secrets;
                  leave a field blank to fall back to the secret.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...emailForm}>
                  <form onSubmit={emailForm.handleSubmit(onSaveEmail)} className="space-y-4">
                    <FormField
                      control={emailForm.control}
                      name="smtpUser"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>SMTP Username</FormLabel>
                          <FormControl>
                            <Input placeholder="postmaster@lekmint.cash" {...field} data-testid="input-smtp-user" />
                          </FormControl>
                          <FormDescription>
                            {emailData?.sources.user === "env" && "Currently using the MAILGUN_SMTP_USER secret."}
                            {emailData?.sources.user === "db" && "Saved in admin settings."}
                            {emailData?.sources.user === null && "Not configured."}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={emailForm.control}
                      name="smtpPass"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>SMTP Password</FormLabel>
                          <FormControl>
                            <Input
                              type="password"
                              placeholder={emailData?.smtpPassSet ? "••••••••  (set — leave blank to keep)" : "Not set"}
                              autoComplete="new-password"
                              {...field}
                              data-testid="input-smtp-pass"
                            />
                          </FormControl>
                          <FormDescription>
                            Stored encrypted; never displayed.
                            {emailData?.sources.pass === "env" && " Currently using the MAILGUN_SMTP_PASS secret."}
                            {emailData?.sources.pass === "db" && (
                              <>
                                {" Saved in admin settings. "}
                                <button
                                  type="button"
                                  className="underline text-destructive hover:opacity-80"
                                  onClick={onClearPassword}
                                  disabled={updateEmail.isPending}
                                  data-testid="button-clear-smtp-pass"
                                >
                                  Clear saved password (revert to secret)
                                </button>
                              </>
                            )}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={emailForm.control}
                      name="operatorEmail"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Operator Email</FormLabel>
                          <FormControl>
                            <Input type="email" placeholder="you@example.com" {...field} data-testid="input-operator-email" />
                          </FormControl>
                          <FormDescription>
                            Where alerts and test emails are delivered.
                            {emailData?.sources.operatorEmail === "env" && " Currently using the OPERATOR_EMAIL secret."}
                            {emailData?.sources.operatorEmail === "db" && " Saved in admin settings."}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="flex gap-3">
                      <Button
                        type="submit"
                        disabled={updateEmail.isPending}
                        className="flex-1"
                        data-testid="button-save-email"
                      >
                        {updateEmail.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        <Save className="w-4 h-4 mr-2" />
                        Save Email Settings
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={testEmail.isPending || !emailData?.smtpPassSet}
                        onClick={onTestEmail}
                        data-testid="button-test-email"
                      >
                        {testEmail.isPending
                          ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          : <Send className="w-4 h-4 mr-2" />}
                        Send test email
                      </Button>
                    </div>
                  </form>
                </Form>
              </CardContent>
            </Card>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={dangerOpen} onOpenChange={setDangerOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-destructive">Danger Zone</h2>
          {dangerOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-8">
            <Card className="border-destructive/50 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <KeyRound className="w-5 h-5" />
                  Rotate Signing Keys
                </CardTitle>
                <CardDescription>
                  Issues a brand-new signing keyset at the current exchange rate and permanently revokes every
                  previous keyset. <span className="font-semibold text-destructive">ALL tokens signed by the old
                  keys — in every wallet, everywhere — become worthless immediately.</span> There is no grace
                  period and no undo. Use this only to void tokens left in circulation after a database reset or
                  suspected key compromise.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Type <span className="font-mono font-semibold">{ROTATE_PHRASE}</span> to confirm you understand
                    this voids all outstanding tokens.
                  </p>
                  <div className="flex gap-3">
                    <Input
                      value={rotateConfirm}
                      onChange={(e) => setRotateConfirm(e.target.value)}
                      placeholder={ROTATE_PHRASE}
                      className="max-w-xs font-mono"
                      data-testid="input-rotate-confirm"
                    />
                    <Button
                      variant="destructive"
                      disabled={rotateConfirm !== ROTATE_PHRASE || rotateKeyset.isPending}
                      onClick={onRotate}
                      data-testid="button-rotate-keyset"
                    >
                      {rotateKeyset.isPending
                        ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        : <AlertTriangle className="w-4 h-4 mr-2" />}
                      Rotate keys &amp; void old tokens
                    </Button>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2">Keyset history</h3>
                  <div className="space-y-2">
                    {(keysetsData?.keysets ?? []).map((k) => (
                      <div key={k.id} className="flex items-center justify-between py-2 border-b text-sm" data-testid={`keyset-row-${k.id}`}>
                        <span className="font-mono">{k.id}</span>
                        <span className="text-muted-foreground">created {new Date(k.createdAt).toLocaleString()}</span>
                        {k.revokedAt ? (
                          <Badge variant="destructive">Revoked {new Date(k.revokedAt).toLocaleString()}</Badge>
                        ) : k.active ? (
                          <Badge variant="default" className="bg-green-600 hover:bg-green-700">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Historical</Badge>
                        )}
                      </div>
                    ))}
                    {keysetsData && keysetsData.keysets.length === 0 && (
                      <p className="text-sm text-muted-foreground">No keysets yet.</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

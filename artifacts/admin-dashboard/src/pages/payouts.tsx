import {
  useGetPayouts,
  getGetPayoutsQueryKey,
  useMarkPayoutsPaid,
  useCorrectPayoutPaidAmount,
  getPayouts,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Card, CardHeader, CardTitle, CardContent, Button } from "@/components/ui/core";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { formatLeks, formatSats, formatAmount } from "@/lib/utils";
import { useState, useEffect, useMemo } from "react";
import { Loader2, ChevronLeft, ChevronRight, Banknote, Download, CheckCheck, AlertTriangle, ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { buildTrezorCsv, buildDetailedCsv } from "@/lib/payoutCsv";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

const LIMIT = 20;
type StatusFilter = "pending" | "paid" | "all";

export default function Payouts() {
  const { token, logout } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [offset, setOffset] = useState(0);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [queueOpen, setQueueOpen] = useState(true);
  // Selection carries the full row (not just the id) so the exported CSV and
  // the mark-paid request are always built from the exact same set, even when
  // the selection spans pages that are no longer loaded.
  const [selected, setSelected] = useState<
    Map<number, { btcAddress: string; amountLeks: number; estimatedBtcSats: number | null }>
  >(new Map());

  const params = {
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    limit: LIMIT,
    offset,
  };

  const { data, isLoading, error, isFetching } = useGetPayouts(params, {
    query: {
      enabled: !!token,
      placeholderData: keepPreviousData,
      queryKey: getGetPayoutsQueryKey(params),
    },
  });

  const markPaid = useMarkPayoutsPaid();
  const correctPayout = useCorrectPayoutPaidAmount();

  /** Replace a settled payout's estimated value with the actual on-chain
   * amount the operator knows (clears the estimate flag in the audit). */
  const correctPaidAmount = (id: number, current: number | null) => {
    const raw = window.prompt(
      "Actual total sats paid for this payout (recipient amount + network fee):",
      current != null ? String(current) : "",
    );
    if (raw === null) return;
    const sats = Number(raw.trim());
    if (!Number.isSafeInteger(sats) || sats < 0) {
      toast({ variant: "destructive", title: "Enter a whole, non-negative sats amount" });
      return;
    }
    correctPayout.mutate(
      { id, data: { paidAmountSats: sats } },
      {
        onSuccess: () => {
          toast({ title: `Payout #${id} corrected to ${formatSats(sats)} sats` });
          queryClient.invalidateQueries({ queryKey: getGetPayoutsQueryKey(params) });
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not correct payout",
            description: err?.data?.error || err?.message,
          });
        },
      },
    );
  };

  useEffect(() => {
    if (error && [401, 403, 503].includes((error as any).status)) {
      logout();
    }
  }, [error, logout]);

  const total = data?.total || 0;
  const entries = data?.entries || [];
  const hasMore = offset + LIMIT < total;

  const pendingOnPage = useMemo(
    () => entries.filter((e) => e.status === "pending"),
    [entries],
  );
  const allPageSelected =
    pendingOnPage.length > 0 && pendingOnPage.every((e) => selected.has(e.id));
  // The batch: exactly the selected rows, across all pages.
  const batchRows = Array.from(selected, ([id, row]) => ({ id, ...row }));
  const selectedTotal = batchRows.reduce((acc, e) => acc + e.amountLeks, 0);
  const selectedTotalSats = batchRows.reduce((acc, e) => acc + (e.estimatedBtcSats ?? 0), 0);

  const toggleAllOnPage = () => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (allPageSelected) {
        pendingOnPage.forEach((e) => next.delete(e.id));
      } else {
        pendingOnPage.forEach((e) =>
          next.set(e.id, {
            btcAddress: e.btcAddress,
            amountLeks: e.amountLeks,
            estimatedBtcSats: e.estimatedBtcSats,
          }),
        );
      }
      return next;
    });
  };

  const toggleOne = (entry: {
    id: number;
    btcAddress: string;
    amountLeks: number;
    estimatedBtcSats: number | null;
  }) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(entry.id)) next.delete(entry.id);
      else
        next.set(entry.id, {
          btcAddress: entry.btcAddress,
          amountLeks: entry.amountLeks,
          estimatedBtcSats: entry.estimatedBtcSats,
        });
      return next;
    });
  };

  const changeFilter = (f: StatusFilter) => {
    setStatusFilter(f);
    setOffset(0);
    setSelected(new Map());
  };

  const downloadCsv = (csv: string, name: string) => {
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Rows to export: the selected batch, or all pending on the page.
   * ALWAYS rehydrated from one fresh server snapshot so every amount in a
   * single export shares the same rate index and network-fee estimate —
   * selections can span pages fetched minutes apart, and estimates float. */
  const exportRows = async () => {
    const wantedIds = batchRows.length > 0 ? batchRows.map((r) => r.id) : pendingOnPage.map((e) => e.id);
    if (wantedIds.length === 0) {
      toast({ title: "Nothing to export", description: "No pending payouts on this page.", variant: "destructive" });
      return null;
    }
    let fresh;
    try {
      fresh = await getPayouts({ status: "pending", limit: 500, offset: 0 });
    } catch (err: any) {
      toast({
        title: "Export failed",
        description: err?.data?.error || err?.message || "Could not refresh payout estimates.",
        variant: "destructive",
      });
      return null;
    }
    const byId = new Map(fresh.entries.map((e) => [e.id, e]));
    const rows = wantedIds.flatMap((id) => {
      const e = byId.get(id);
      return e ? [{ id: e.id, btcAddress: e.btcAddress, amountLeks: e.amountLeks, estimatedBtcSats: e.estimatedBtcSats }] : [];
    });
    const missing = wantedIds.length - rows.length;
    if (missing > 0) {
      toast({
        title: `${missing} selected payout${missing === 1 ? " is" : "s are"} no longer pending`,
        description: "They were left out of the export. Refresh the page to see current statuses.",
        variant: "destructive",
      });
    }
    if (rows.length === 0) return null;
    return rows;
  };

  const exportTrezorCsv = async () => {
    const rows = await exportRows();
    if (!rows) return;
    let built;
    try {
      built = buildTrezorCsv(rows);
    } catch (err: any) {
      toast({
        title: "Export failed",
        description: err?.message || "Could not build the Trezor CSV.",
        variant: "destructive",
      });
      return;
    }
    const { csv, included, skipped } = built;
    if (included === 0) {
      toast({
        title: "Nothing exportable",
        description: "No rows have a computable BTC estimate right now.",
        variant: "destructive",
      });
      return;
    }
    downloadCsv(csv, `payout-batch-trezor-${new Date().toISOString().slice(0, 10)}.csv`);
    if (skipped.length > 0) {
      toast({
        title: `${skipped.length} row${skipped.length === 1 ? "" : "s"} left out`,
        description:
          "Rows without a computable BTC estimate were excluded from the Trezor file — they would break the import. Check them individually.",
        variant: "destructive",
      });
    }
  };

  const exportDetailedCsv = async () => {
    const rows = await exportRows();
    if (!rows) return;
    downloadCsv(buildDetailedCsv(rows), `payout-batch-detailed-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const onMarkPaid = () => {
    const ids = batchRows.map((r) => r.id);
    if (ids.length === 0) return;
    markPaid.mutate(
      { data: { ids } },
      {
        onSuccess: (res) => {
          toast({
            title: `${res.settledCount} payout${res.settledCount === 1 ? "" : "s"} marked paid`,
            description: `${formatLeks(res.settledTotalLeks)} leks settled.`,
          });
          setSelected(new Map());
          queryClient.invalidateQueries();
        },
        onError: (err: any) => {
          toast({
            title: "Failed to mark payouts paid",
            description: err?.data?.error || err.message,
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-primary">Payout Queue</h1>
        <p className="text-muted-foreground mt-2">
          Melted leks awaiting BTC settlement. Export a batch for PSBT construction, then mark it paid once broadcast.
        </p>
      </div>

      <div
        className="flex gap-3 items-start rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 p-4 text-sm leading-relaxed"
        data-testid="banner-btc-estimate-warning"
      >
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          <strong className="font-semibold">BTC amounts are not frozen at melt time.</strong>{" "}
          Estimates below are recalculated on every load from the current issuance rate
          {data?.rateIndex ? ` (rate index ${data.rateIndex})` : ""} and expected transfer fees,
          and remain subject to change until the batch settles. Export the CSV at the moment you
          prepare the batch so the sats amounts reflect the rate in force.
        </span>
      </div>

      <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Summary</h2>
          {summaryOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Card className="border-border shadow-sm">
                <CardContent className="pt-6">
                  <div className="text-sm text-muted-foreground">Pending payouts</div>
                  <div className="text-2xl font-bold mt-1" data-testid="text-pending-count">{data?.pendingCount ?? "—"}</div>
                </CardContent>
              </Card>
              <Card className="border-border shadow-sm">
                <CardContent className="pt-6">
                  <div className="text-sm text-muted-foreground">Pending total (leks)</div>
                  <div className="text-2xl font-bold mt-1 text-destructive" data-testid="text-pending-total">
                    {data ? formatLeks(data.pendingTotalLeks) : "—"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1" data-testid="text-pending-total-sats">
                    {data?.pendingTotalEstimatedSats != null
                      ? `≈ ${formatSats(data.pendingTotalEstimatedSats)} sats (est., subject to change)`
                      : ""}
                  </div>
                </CardContent>
              </Card>
              <Card className="border-border shadow-sm">
                <CardContent className="pt-6">
                  <div className="text-sm text-muted-foreground">Selected for batch</div>
                  <div className="text-2xl font-bold mt-1" data-testid="text-selected-total">
                    {selected.size} · {formatLeks(selectedTotal)}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1" data-testid="text-selected-total-sats">
                    {selected.size > 0 ? `≈ ${formatSats(selectedTotalSats)} sats (est.)` : ""}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={queueOpen} onOpenChange={setQueueOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Payout Queue</h2>
          {queueOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-6">
            <Card className="border-border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between border-b bg-muted/20">
                <CardTitle className="text-base flex items-center gap-2">
                  <Banknote className="w-4 h-4 text-accent" />
                  Payouts
                </CardTitle>
                <div className="flex items-center gap-2">
                  {(["pending", "paid", "all"] as StatusFilter[]).map((f) => (
                    <Button
                      key={f}
                      variant={statusFilter === f ? "default" : "outline"}
                      size="sm"
                      onClick={() => changeFilter(f)}
                      data-testid={`filter-${f}`}
                    >
                      {f.charAt(0).toUpperCase() + f.slice(1)}
                    </Button>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="flex items-center gap-2 p-4 border-b bg-muted/10">
                  <Button
                    size="sm"
                    onClick={onMarkPaid}
                    disabled={selected.size === 0 || markPaid.isPending}
                    data-testid="button-mark-paid"
                  >
                    {markPaid.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <CheckCheck className="w-4 h-4 mr-2" />
                    )}
                    Mark {selected.size > 0 ? `${selected.size} ` : ""}as Paid
                  </Button>
                  <Button variant="outline" size="sm" onClick={exportTrezorCsv} data-testid="button-export-csv">
                    <Download className="w-4 h-4 mr-2" />
                    Export for Trezor {selected.size > 0 ? "(selected)" : "(page)"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={exportDetailedCsv} data-testid="button-export-detailed-csv">
                    <Download className="w-4 h-4 mr-2" />
                    Detailed CSV
                  </Button>
                </div>
                <div className="px-4 py-3 border-b text-xs text-muted-foreground leading-relaxed" data-testid="text-trezor-guide">
                  <strong className="text-foreground/80 font-medium">Trezor Suite import:</strong>{" "}
                  open your BTC account → Send → the import icon in the send form → upload the
                  Trezor file. Amounts arrive in BTC with currency preset; the network fee is chosen in
                  Trezor at broadcast time. Before signing, verify the recipient count and total match
                  the batch here, then mark the batch paid once broadcast. The Detailed CSV is for your
                  bookkeeping only — don't import it.
                </div>

                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead className="w-[44px]">
                        <Checkbox
                          checked={allPageSelected}
                          onCheckedChange={toggleAllOnPage}
                          disabled={pendingOnPage.length === 0}
                          aria-label="Select all pending on page"
                          data-testid="checkbox-select-all"
                        />
                      </TableHead>
                      <TableHead className="w-[70px]">ID</TableHead>
                      <TableHead>BTC Address</TableHead>
                      <TableHead className="text-right">Amount (Leks)</TableHead>
                      <TableHead className="text-right">Est. BTC (sats)</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Requested</TableHead>
                      <TableHead>Settled</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading && !entries.length ? (
                      <TableRow>
                        <TableCell colSpan={8} className="h-32 text-center">
                          <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    ) : entries.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                          No payouts found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      entries.map((entry) => (
                        <TableRow key={entry.id} className="hover:bg-muted/30" data-testid={`row-payout-${entry.id}`}>
                          <TableCell>
                            {entry.status === "pending" && (
                              <Checkbox
                                checked={selected.has(entry.id)}
                                onCheckedChange={() => toggleOne(entry)}
                                aria-label={`Select payout ${entry.id}`}
                                data-testid={`checkbox-payout-${entry.id}`}
                              />
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">#{entry.id}</TableCell>
                          <TableCell className="font-mono text-xs break-all max-w-[280px]">{entry.btcAddress}</TableCell>
                          <TableCell className="text-right font-semibold">{formatLeks(entry.amountLeks)}</TableCell>
                          <TableCell className="text-right" data-testid={`text-est-sats-${entry.id}`}>
                            {entry.status === "paid" && entry.paidAmountSats != null ? (
                              <span className="inline-flex items-center gap-1 justify-end">
                                <span title={entry.paidAmountIsEstimate
                                  ? "Settlement-time quote, not verified on-chain data. Click the pencil to enter the actual paid amount."
                                  : "Actual paid amount (operator-confirmed)"}>
                                  {entry.paidAmountIsEstimate ? "≈ " : ""}{formatSats(entry.paidAmountSats)}
                                </span>
                                {entry.paidAmountIsEstimate && (
                                  <button
                                    className="text-muted-foreground hover:text-foreground"
                                    title="Enter the actual sats paid on-chain"
                                    onClick={() => correctPaidAmount(entry.id, entry.paidAmountSats)}
                                    data-testid={`button-correct-${entry.id}`}
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                )}
                              </span>
                            ) : entry.estimatedBtcSats != null ? (
                              <span title="Recalculated at the current issuance rate and expected transfer fees — subject to change until settlement">
                                ≈ {formatSats(entry.estimatedBtcSats)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {entry.status === "pending" ? (
                              <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-400">pending</Badge>
                            ) : (
                              <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-400">paid</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">{new Date(entry.createdAt).toLocaleString()}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {entry.settledAt ? new Date(entry.settledAt).toLocaleString() : "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>

                <div className="flex items-center justify-between p-4 border-t bg-muted/20">
                  <div className="text-sm text-muted-foreground">
                    Showing {formatAmount(Math.min(offset + 1, total))}-{formatAmount(Math.min(offset + LIMIT, total))} of {formatAmount(total)}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOffset(Math.max(0, offset - LIMIT))}
                      disabled={offset === 0 || isFetching}
                    >
                      <ChevronLeft className="w-4 h-4 mr-1" />
                      Prev
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOffset(offset + LIMIT)}
                      disabled={!hasMore || isFetching}
                    >
                      Next
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
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

import {
  useGetSupplyLog,
  getGetSupplyLogQueryKey,
  useGetEscrowSummary,
  getGetEscrowSummaryQueryKey,
  useListEscrows,
  getListEscrowsQueryKey,
  useReleaseEscrow,
  useRebaseSupplyEra,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Card, CardHeader, CardTitle, CardContent, Button } from "@/components/ui/core";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatSats, formatLeks, formatAmount } from "@/lib/utils";
import { useState, useEffect } from "react";
import { Loader2, ChevronLeft, ChevronRight, Activity, Lock, Copy, Unlock, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

const LIMIT = 20;

export default function Supply() {
  const { token, logout } = useAuth();
  const [offset, setOffset] = useState(0);
  const [escrowOpen, setEscrowOpen] = useState(true);
  const [snapshotsOpen, setSnapshotsOpen] = useState(true);
  const [rebaseMessage, setRebaseMessage] = useState<string | null>(null);

  const { data: escrows } = useGetEscrowSummary({ query: { enabled: !!token, queryKey: getGetEscrowSummaryQueryKey() } });
  const { data: escrowList } = useListEscrows({ query: { enabled: !!token, queryKey: getListEscrowsQueryKey() } });
  const queryClient = useQueryClient();
  const releaseEscrow = useReleaseEscrow();
  const rebaseSupplyEra = useRebaseSupplyEra();
  const [releaseTokens, setReleaseTokens] = useState<Record<number, string>>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const handleRebaseEra = () => {
    setRebaseMessage(null);
    rebaseSupplyEra.mutate(undefined, {
      onSuccess: (result) => {
        setRebaseMessage(result.message);
        queryClient.invalidateQueries({ queryKey: getGetSupplyLogQueryKey() });
      },
      onError: () => {
        setRebaseMessage("Request failed — check the server logs.");
      },
    });
  };

  const handleRelease = (id: number) => {
    releaseEscrow.mutate(
      { id },
      {
        onSuccess: (result) => {
          setReleaseTokens((prev) => ({ ...prev, [id]: result.token }));
          queryClient.invalidateQueries({ queryKey: getListEscrowsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetEscrowSummaryQueryKey() });
        },
      }
    );
  };

  const handleCopy = async (id: number, tokenStr: string) => {
    await navigator.clipboard.writeText(tokenStr);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
  };

  const { data, isLoading, error, isFetching } = useGetSupplyLog(
    { limit: LIMIT, offset },
    { query: { enabled: !!token, placeholderData: keepPreviousData, queryKey: getGetSupplyLogQueryKey({ limit: LIMIT, offset }) } }
  );

  useEffect(() => {
    if (error && [401, 403, 503].includes((error as any).status)) {
      logout();
    }
  }, [error, logout]);

  const total = data?.total || 0;
  const entries = data?.entries || [];
  const hasMore = offset + LIMIT < total;

  return (
    <div className="space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-primary">Supply Audit Log</h1>
        <p className="text-muted-foreground mt-2">
          Historical snapshots of total issued supply and reserve backing. BTC balance uses the
          same definition as the Overview's "BTC Held": net credited deposits minus settled melt
          payouts, captured at the moment of each snapshot.
        </p>
      </div>

      <Collapsible open={escrowOpen} onOpenChange={setEscrowOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Appreciation Escrow</h2>
          {escrowOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-6">
            <Card className="border-border shadow-sm">
              <CardHeader className="border-b bg-muted/20">
                <CardTitle className="text-base flex items-center gap-2">
                  <Lock className="w-4 h-4 text-accent" />
                  Escrow Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <p className="text-sm text-muted-foreground mb-4">
                  Epoch appreciation held for senders whose external wallets swapped old-epoch tokens at face value.
                  Claimed when the original token is pasted into the site wallet — the mint keeps none of it.
                </p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Unclaimed</div>
                    <div className="text-xl font-bold">{formatLeks(escrows?.unclaimedTotalLeks ?? 0)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Unclaimed Count</div>
                    <div className="text-xl font-bold">{formatAmount(escrows?.unclaimedCount ?? 0)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Claimed</div>
                    <div className="text-xl font-bold">{formatLeks(escrows?.claimedTotalLeks ?? 0)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Claimed Count</div>
                    <div className="text-xl font-bold">{formatAmount(escrows?.claimedCount ?? 0)}</div>
                  </div>
                </div>
                {(escrowList?.escrows?.length ?? 0) > 0 && (
                  <div className="mt-6">
                    <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Individual escrows</div>
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/10">
                          <TableHead className="w-[60px]">ID</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead className="text-right">Held (Leks)</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {escrowList!.escrows.map((row) => {
                          const releasedToken = releaseTokens[row.id] ?? row.releasedToken ?? null;
                          return (
                            <TableRow key={row.id} className="hover:bg-muted/30">
                              <TableCell className="text-muted-foreground">#{row.id}</TableCell>
                              <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                              <TableCell className="text-right font-semibold">{formatLeks(row.amountLeks)}</TableCell>
                              <TableCell>
                                {row.claimable ? (
                                  <span className="text-amber-600">Unclaimed</span>
                                ) : releasedToken ? (
                                  <span className="text-blue-600">Released by operator</span>
                                ) : (
                                  <span className="text-muted-foreground">Claimed by token holder</span>
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                {row.claimable ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleRelease(row.id)}
                                    disabled={releaseEscrow.isPending}
                                    data-testid={`button-release-escrow-${row.id}`}
                                  >
                                    <Unlock className="w-3.5 h-3.5 mr-1" />
                                    Release
                                  </Button>
                                ) : releasedToken ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleCopy(row.id, releasedToken)}
                                    data-testid={`button-copy-escrow-token-${row.id}`}
                                  >
                                    <Copy className="w-3.5 h-3.5 mr-1" />
                                    {copiedId === row.id ? "Copied!" : "Copy token"}
                                  </Button>
                                ) : null}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    <p className="text-xs text-muted-foreground mt-3">
                      Releasing an escrow issues its held-back leks as a token string — copy it and paste into the site
                      wallet's Receive tab. The token stays retrievable here (Copy token) so it is never lost.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={snapshotsOpen} onOpenChange={setSnapshotsOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Supply Snapshots</h2>
          {snapshotsOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-6">
            <Card className="border-border shadow-sm">
              <CardHeader className="flex flex-col gap-3 border-b bg-muted/20">
                <div className="flex flex-row items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Activity className="w-4 h-4 text-accent" />
                    Historical Snapshots
                  </CardTitle>
                  <div className="text-sm font-mono text-muted-foreground">
                    {formatAmount(total)} total records
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    If snapshots recorded before the most recent key rotation show inflated
                    issued/redeemed figures, use this one-time correction to rebase them so
                    the era starts at zero. Pre-rotation rows are not changed. Safe to run
                    again — a second call reports nothing to do.
                  </p>
                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRebaseEra}
                      disabled={rebaseSupplyEra.isPending}
                      data-testid="button-rebase-supply-era"
                    >
                      {rebaseSupplyEra.isPending
                        ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
                      Rebase Era Snapshots
                    </Button>
                    {rebaseMessage && (
                      <span className="text-xs text-muted-foreground font-mono break-all">{rebaseMessage}</span>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead className="w-[80px]">ID</TableHead>
                      <TableHead>Snapshot Time</TableHead>
                      <TableHead className="text-right">Issued (Leks)</TableHead>
                      <TableHead className="text-right">Redeemed (Leks)</TableHead>
                      <TableHead className="text-right">BTC Balance (Sats)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading && !entries.length ? (
                      <TableRow>
                        <TableCell colSpan={5} className="h-32 text-center">
                          <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    ) : entries.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                          No audit records found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      entries.map((entry) => (
                        <TableRow key={entry.id} className="hover:bg-muted/30">
                          <TableCell className="text-muted-foreground">#{entry.id}</TableCell>
                          <TableCell>{new Date(entry.snapshotAt).toLocaleString()}</TableCell>
                          <TableCell className="text-right text-blue-600 font-medium">{formatLeks(entry.totalLeksIssued)}</TableCell>
                          <TableCell className="text-right text-destructive">{formatLeks(entry.totalLeksRedeemed)}</TableCell>
                          <TableCell className="text-right font-semibold">{formatSats(entry.btcBalanceSats)}</TableCell>
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

import { useGetAdminStats, getGetAdminStatsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/core";
import { formatSats, formatLeks, formatAmount } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useEffect, useState } from "react";
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend 
} from "recharts";
import { Loader2, Activity, Users, Bitcoin, Coins, Receipt, ArrowRightLeft, ChevronDown, ChevronUp, Wallet, Flame, ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

function SectionHeader({ title, open }: { title: string; open: boolean }) {
  return (
    <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
      <h2 className="text-lg font-semibold tracking-tight text-primary">{title}</h2>
      {open
        ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
        : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
    </CollapsibleTrigger>
  );
}

// Correct K/M scaling for sats: 1M = 1,000,000 sats.
function formatSatsAxis(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return `${val}`;
}

const MINT_COLOR = "hsl(var(--accent))";
const MELT_COLOR = "hsl(0 72% 51%)";

function ActivityChart({ data }: { data: { date: string; minted: number; melted: number }[] }) {
  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Mint & Melt Volume
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[350px] w-full">
          {data.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="date"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  dy={10}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={formatSatsAxis}
                  dx={-10}
                />
                <RechartsTooltip
                  contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '6px' }}
                  itemStyle={{ color: 'hsl(var(--foreground))', fontFamily: 'var(--font-mono)' }}
                  formatter={(value: number, name: string) => [formatSats(value) + ' sats', name]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="minted"
                  name="Minted"
                  stroke={MINT_COLOR}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 6, fill: MINT_COLOR }}
                />
                <Line
                  type="monotone"
                  dataKey="melted"
                  name="Melted"
                  stroke={MELT_COLOR}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 6, fill: MELT_COLOR }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
              No data available
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Overview() {
  const { token, logout } = useAuth();
  const [metricsOpen, setMetricsOpen] = useState(true);
  const [chartOpen, setChartOpen] = useState(true);
  
  const { data: stats, isLoading, error } = useGetAdminStats({
    query: {
      enabled: !!token,
      retry: false,
      queryKey: getGetAdminStatsQueryKey(),
    }
  });

  useEffect(() => {
    if (error && [401, 403, 503].includes((error as any).status)) {
      logout();
    }
  }, [error, logout]);

  if (isLoading) {
    return (
      <div className="h-[50vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!stats) return null;

  const audit = stats.audit;
  const treasury = stats.treasury;
  const dustSourceLabels: Record<string, string> = {
    issue: "Issuance rounding",
    upgrade: "Upgrade rounding",
    swap: "Swap rounding",
    swap_forfeit: "Swap unclaimed value",
    redeem: "Redeem rounding",
  };

  const statCards = [
    {
      title: "Live Treasury Balance",
      value: treasury.liveBalanceSats !== null ? formatSats(treasury.liveBalanceSats) : "—",
      label: "SATS",
      icon: Wallet,
      color: "text-emerald-600",
      sub: treasury.fetchedAt
        ? `on-chain, ${treasury.addressCount} addresses, read ${new Date(treasury.fetchedAt).toLocaleTimeString()}${treasury.stale ? " (stale)" : ""}`
        : "live read unavailable",
    },
    {
      title: "BTC Held (Ledger Net)",
      value: formatSats(stats.btcHeldNetSats),
      label: "SATS",
      icon: Bitcoin,
      color: "text-green-600",
      sub:
        "net deposits − melt payouts" +
        (stats.metricsBaselineAt ? ", this era (since key reset)" : "") +
        (stats.priorEraBtcNetSats !== null
          ? ` · prior era: ${formatSats(stats.priorEraBtcNetSats)}`
          : ""),
    },
    {
      title: "Leks in Circulation",
      value: formatLeks(stats.leksInCirculation),
      label: "LEK",
      icon: Coins,
      color: "text-blue-600"
    },
    {
      title: "Minted",
      value: formatSats(stats.totalBtcNetSats),
      label: "SATS",
      icon: ArrowRightLeft,
      color: "text-sky-600",
      sub: `${formatAmount(stats.mintCount)} deposits credited (net of fees)`,
    },
    {
      title: "Melted (Paid Out)",
      value: formatSats(stats.meltPaidSats),
      label: "SATS",
      icon: Flame,
      color: "text-orange-600",
      sub: `${formatAmount(stats.meltPaidCount)} payouts settled` +
        (stats.meltPendingCount > 0
          ? ` · ${formatAmount(stats.meltPendingCount)} pending (≈${formatSats(stats.meltPendingEstimatedSats ?? 0)} sats)`
          : ""),
    },
    {
      title: "Pending Issuance",
      value: formatLeks(stats.leksPendingIssuance),
      label: "LEK",
      icon: ArrowRightLeft,
      color: "text-amber-600",
      sub: "confirmed deposits awaiting token issuance",
    },
    {
      title: "Fees Collected",
      value: formatSats(stats.totalFeesCollectedSats),
      label: "SATS",
      icon: Receipt,
      color: "text-accent"
    },
    {
      title: "Funded Addresses",
      value: formatAmount(stats.fundedAddresses),
      label: "ADDRESSES",
      icon: Users,
      color: "text-purple-600",
      sub: "deposit addresses that received BTC (not unique users)",
    },
    {
      title: "Treasury Dust",
      value: parseFloat(stats.treasuryDust).toFixed(4),
      label: "LEK",
      icon: Activity,
      color: "text-slate-600",
      sub: stats.treasuryDustBySource
        .map((d) => `${dustSourceLabels[d.source] ?? d.source}: ${parseFloat(d.total).toFixed(4)}`)
        .join(" · ") || undefined,
    }
  ];

  // API contract: daily series arrive oldest-first (chronological).
  // Dates are UTC calendar days — format in UTC so operators west of UTC
  // don't see every label shifted back a day.
  const fmtDate = (d: string) =>
    new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const meltByDate = new Map((stats.dailyMeltVolume || []).map(d => [d.date, d.amountSats]));
  const activityData = (stats.dailyMintVolume || []).map(d => ({
    date: fmtDate(d.date),
    minted: d.amountSats,
    melted: meltByDate.get(d.date) ?? 0,
  }));

  return (
    <div className="space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-primary">System Overview</h1>
        <p className="text-muted-foreground mt-2">Real-time telemetry for the Lek Mint operations.</p>
        {stats.metricsBaselineAt && (
          <p className="text-xs text-muted-foreground mt-1">
            Metrics since key reset on {new Date(stats.metricsBaselineAt).toLocaleString()}
          </p>
        )}
      </div>

      <Card
        className={`border shadow-sm ${
          audit.ok === true
            ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30"
            : audit.ok === false
              ? "border-red-300 bg-red-50 dark:bg-red-950/30"
              : "border-border bg-muted/20"
        }`}
        data-testid="audit-banner"
      >
        <CardContent className="py-4">
          <div className="flex items-start gap-3">
            {audit.ok === true && <ShieldCheck className="w-5 h-5 text-emerald-600 mt-0.5 shrink-0" />}
            {audit.ok === false && <ShieldAlert className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />}
            {audit.ok === null && <ShieldQuestion className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />}
            <div className="min-w-0">
              <div className="font-semibold text-sm">
                {audit.ok === true && "Treasury audit: everything checks out"}
                {audit.ok === false && "Treasury audit: reserve shortfall"}
                {audit.ok === null && "Treasury audit: live balance unavailable"}
              </div>
              <div className="text-xs text-muted-foreground mt-1 space-x-3">
                <span>
                  Backing needed for circulating leks{stats.meltPendingCount > 0 ? " + pending melts" : ""}:{" "}
                  <span className="font-mono">{formatSats(audit.requiredReserveSats)}</span> sats
                </span>
                <span>
                  Ledger expects on deposit addresses:{" "}
                  <span className="font-mono">{formatSats(audit.expectedReserveSats)}</span> sats
                </span>
                {audit.approximate && (
                  <span>≈ approximate: payout values are settlement-time quotes, not on-chain transaction data</span>
                )}
                {audit.actualBalanceSats !== null && (
                  <span>
                    Actual on-chain: <span className="font-mono">{formatSats(audit.actualBalanceSats)}</span> sats
                    {audit.discrepancySats !== null && audit.discrepancySats !== 0 && (
                      <> ({audit.discrepancySats > 0 ? "+" : ""}{formatSats(audit.discrepancySats)} vs expected)</>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Collapsible open={metricsOpen} onOpenChange={setMetricsOpen}>
        <SectionHeader title="Key Metrics" open={metricsOpen} />
        <CollapsibleContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-6">
            {statCards.map((stat, i) => (
              <Card key={i} className="border-border shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    {stat.title}
                  </CardTitle>
                  <stat.icon className={`w-4 h-4 ${stat.color}`} />
                </CardHeader>
                <CardContent>
                  <div className="flex items-baseline gap-2">
                    <div className="text-2xl font-bold font-mono tracking-tight text-primary" data-testid={`stat-${stat.title.toLowerCase().replace(/[\s()]+/g, '-').replace(/-+$/, '')}`}>
                      {stat.value}
                    </div>
                    <div className="text-xs font-semibold text-muted-foreground">{stat.label}</div>
                  </div>
                  {stat.sub && (
                    <div className="text-xs text-muted-foreground mt-1">{stat.sub}</div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={chartOpen} onOpenChange={setChartOpen}>
        <SectionHeader title="30-Day Activity" open={chartOpen} />
        <CollapsibleContent>
          <div className="pb-6">
            <ActivityChart data={activityData} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

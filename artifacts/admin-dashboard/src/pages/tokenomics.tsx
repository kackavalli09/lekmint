import { useGetEpochs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/core";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Coins, Calendar, HardDrive, ChevronDown, ChevronUp } from "lucide-react";
import { formatSats } from "@/lib/utils";
import { useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from "recharts";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

export default function Tokenomics() {
  const { data, isLoading } = useGetEpochs();
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [chartOpen, setChartOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;
  }

  if (!data) return null;

  const chartData = [...data.epochs].reverse().map(e => ({
    epoch: `Ep ${e.id}`,
    rateIndex: parseFloat(e.rateIndex),
    difficulty: parseFloat(e.difficulty)
  }));

  return (
    <div className="space-y-2 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-primary">Tokenomics Monitor</h1>
        <p className="text-muted-foreground mt-2">Read-only view of difficulty-pegged issuance dynamics.</p>
      </div>

      <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Summary</h2>
          {summaryOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Current Epoch</CardTitle>
                  <Calendar className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold font-mono text-primary">{data.currentEpochId ?? '—'}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Base Unit</CardTitle>
                  <Coins className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold tracking-tight uppercase text-primary">{data.unit}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Genesis Calibration (C₀)</CardTitle>
                  <HardDrive className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-lg font-bold font-mono truncate text-primary">{data.genesisCalibration ?? '—'}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Current Rate Index (R_t)</CardTitle>
                  <Coins className="w-4 h-4 text-accent" />
                </CardHeader>
                <CardContent>
                  <div className="text-lg font-bold font-mono truncate text-accent">{data.currentRateIndex ?? '—'}</div>
                </CardContent>
              </Card>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={chartOpen} onOpenChange={setChartOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Rate Index Progression</h2>
          {chartOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-6">
            <Card className="border-border shadow-sm">
              <CardHeader>
                <CardDescription>Evolution of the purchasing power peg over historical epochs.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[300px] w-full mt-4">
                  {chartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                        <XAxis dataKey="epoch" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} dy={10} />
                        <YAxis 
                          yAxisId="left" 
                          stroke="hsl(var(--accent))" 
                          fontSize={12} tickLine={false} axisLine={false} dx={-10}
                          domain={['auto', 'auto']}
                        />
                        <RechartsTooltip 
                          contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '6px' }}
                          itemStyle={{ fontFamily: 'var(--font-mono)' }}
                        />
                        <Line yAxisId="left" type="stepAfter" dataKey="rateIndex" stroke="hsl(var(--accent))" strokeWidth={2} dot={{ r: 3 }} name="Rate Index" />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-muted-foreground">No epoch data</div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left group">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Epoch History</h2>
          {historyOpen
            ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-6">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Epoch ID</TableHead>
                      <TableHead>Started At</TableHead>
                      <TableHead>Keyset ID</TableHead>
                      <TableHead>Difficulty</TableHead>
                      <TableHead>Rate Index</TableHead>
                      <TableHead className="text-right">Subsidy (sats)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.epochs.map((epoch) => (
                      <TableRow key={epoch.id}>
                        <TableCell className="font-medium">{epoch.id}</TableCell>
                        <TableCell>{new Date(epoch.startedAt).toLocaleString()}</TableCell>
                        <TableCell className="text-muted-foreground truncate max-w-[150px]">{epoch.keysetId}</TableCell>
                        <TableCell>{epoch.difficulty}</TableCell>
                        <TableCell className="text-accent font-semibold">{epoch.rateIndex}</TableCell>
                        <TableCell className="text-right">{formatSats(epoch.subsidySats)}</TableCell>
                      </TableRow>
                    ))}
                    {data.epochs.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No historical epochs found</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

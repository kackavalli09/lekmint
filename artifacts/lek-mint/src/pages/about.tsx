import { Layout } from "@/components/layout";
import { Bitcoin, Ban, EyeOff } from "lucide-react";
import threeLeksImage from "@/assets/three-leks.png";

export default function AboutPage() {
  return (
    <Layout>
      <div className="max-w-2xl mx-auto mt-8 space-y-14">
        {/* Bitcoin is a breakthrough */}
        <section>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tighter mb-6">
            The lek is an elastic currency unit indexed to Bitcoin's block subsidy and network difficulty.
          </h1>
          <p className="text-muted-foreground leading-relaxed mb-4">
            Bitcoin's difficulty adjustment is the most reliable macroeconomic oracle in existence:
            it tracks the aggregate thermodynamic effort required to produce absolute scarcity. Since
            Bitcoin's supply is strictly capped, its price must absorb all market volatility. The lek
            extracts this difficulty metric and applies it to an elastic money stock instead.
          </p>
          <p className="text-muted-foreground leading-relaxed mb-4">
            Every time Bitcoin's difficulty adjusts upward — or when a halving occurs — the number
            of leks represented by a Satoshi ticks up linearly, as long as the most recent
            high-water mark is exceeded. The exchange rate between a Satoshi and a lek never goes
            down. Leks of arbitrarily old vintages are perennially honoured, exchanged by the mint
            for a higher number of current leks.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            By indexing directly to the block subsidy and network difficulty, the lek translates
            Bitcoin's thermodynamic manufacturing cost into a stable currency. It is a unit of
            account pegged not to failing fiat regimes, but to the baseline energy of the real
            economy.
          </p>
        </section>

        {/* Portrait */}
        <section>
          <div className="rounded-xl overflow-hidden border">
            <img
              src={threeLeksImage}
              alt="Left to right: Alexander the Great, Gjergj Kastrioti Skanderbeg, Ahmet Zogu"
              className="w-full"
            />
          </div>
          <div className="mt-3 text-center">
            <p className="text-sm text-muted-foreground italic">The three Leks</p>
            <p className="text-xs text-muted-foreground italic mt-0.5">
              Left to right: Alexander the Great, Gjergj Kastrioti Skanderbeg, Ahmet Zogu
            </p>
          </div>
        </section>

        {/* Non-fiat alternative */}
        <section>
          <h2 className="text-2xl font-bold mb-3">A non-fiat alternative</h2>
          <p className="text-muted-foreground leading-relaxed mb-6">
            Most "stable" tokens are IOUs on a bank account. The lek is not pegged to any
            fiat currency and touches no banking system at any point in its life.
          </p>
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="border rounded-xl p-5">
              <Bitcoin className="w-4 h-4 text-primary mb-2" />
              <h3 className="font-semibold text-sm mb-1.5">Backed by real BTC</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Every lek in circulation is backed by bitcoin held in cold storage.
                No fractional anything.
              </p>
            </div>
            <div className="border rounded-xl p-5">
              <Ban className="w-4 h-4 text-primary mb-2" />
              <h3 className="font-semibold text-sm mb-1.5">No fiat rails</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                No dollars, no banks, no payment processors. BTC in, BTC out —
                nothing else.
              </p>
            </div>
            <div className="border rounded-xl p-5">
              <EyeOff className="w-4 h-4 text-primary mb-2" />
              <h3 className="font-semibold text-sm mb-1.5">Quiet by default</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Chaumian blind signatures mean the mint cannot see balances,
                identities, or who pays whom.
              </p>
            </div>
          </div>
        </section>
      </div>
    </Layout>
  );
}

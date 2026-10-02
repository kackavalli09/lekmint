import { Layout } from "@/components/layout";
import {
  Layers,
  Zap,
  ShieldOff,
  Eye,
  Lock,
  XCircle,
} from "lucide-react";

const merchantBenefits = [
  {
    icon: Layers,
    title: "Wholesale batching",
    body: "The mint charges no transaction fees, so you can accept lots of tiny payments throughout the day — even sub-cent sales — without each one creating friction or cost. If you want to move funds to cold storage later, even daily, you can do that once and pay a single Bitcoin network fee.",
  },
  {
    icon: Zap,
    title: "Fast Bitcoin settlement",
    body: "The mint responds in under a second, so you can accept Bitcoin payments without waiting for a block confirmation or dealing with Lightning routing failures.",
  },
  {
    icon: ShieldOff,
    title: "No channel management",
    body: "You do not need to manage Lightning channels, balance liquidity, or run extra monitoring infrastructure. A standard, secure Bitcoin address is enough — setup stays simple and does not require specialised IT knowledge.",
  },
  {
    icon: Lock,
    title: "Set-and-forget pricing",
    body: "Because the lek is designed to track a steadier economic baseline, a coffee priced in leks today should stay close to the same lek price next year. That helps protect your margins from both fiat inflation and raw Bitcoin volatility.",
  },
];

const ecashBenefits = [
  {
    icon: Eye,
    title: "Frictionless customer experience",
    body: "The lek works like a digital bearer instrument: the customer does not need to create an account, pass KYC, or link a bank account before paying. If they hold leks, they can scan and pay instantly.",
  },
  {
    icon: XCircle,
    title: "No chargebacks",
    body: "Once a lek is swapped at the mint, settlement is final. No insufficient-funds errors, no clawbacks, and no fraudulent chargeback disputes.",
  },
  {
    icon: Eye,
    title: "Commercial confidentiality",
    body: "Competitors, suppliers, or customers cannot analyse the blockchain to make educated guesses about your revenue or vendors. Chaumian eCash anonymises transaction history, keeping your business activity confidential.",
  },
  {
    icon: Lock,
    title: "More control over payments",
    body: "No payment processor can arbitrarily freeze your POS terminal, put a hold on your funds, or de-platform your business.",
  },
];

export default function WhyLekPage() {
  return (
    <Layout>
      <div className="max-w-2xl mx-auto mt-8 space-y-14">
        {/* Intro */}
        <section>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tighter mb-6">
            Why merchants may want to accept lek payments
          </h1>
          <p className="text-muted-foreground leading-relaxed">
            The lek is designed to make small, everyday payments easier for
            merchants — combining the speed of instant settlement with the
            simplicity of a standard Bitcoin address and the privacy guarantees
            of Chaumian eCash.
          </p>
        </section>

        {/* Practical benefits */}
        <section>
          <h2 className="text-2xl font-bold mb-4">Practical advantages</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {merchantBenefits.map((item) => (
              <div key={item.title} className="border rounded-xl p-5">
                <item.icon className="w-4 h-4 text-primary mb-2" />
                <h3 className="font-semibold text-sm mb-1.5">{item.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Cashu benefits */}
        <section>
          <h2 className="text-2xl font-bold mb-3">
            The Chaumian eCash edge
          </h2>
          <p className="text-muted-foreground leading-relaxed mb-6">
            The lek also inherits the core advantages of Cashu — a
            battle-tested Chaumian eCash protocol — which can help with
            privacy, control, and smoother checkout.
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            {ecashBenefits.map((item) => (
              <div key={item.title} className="border rounded-xl p-5">
                <item.icon className="w-4 h-4 text-primary mb-2" />
                <h3 className="font-semibold text-sm mb-1.5">{item.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="border rounded-xl p-6 bg-muted/20">
          <h2 className="text-xl font-bold mb-2">Ready to get started?</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Head to the <strong>Mint</strong> tab to deposit BTC and receive
            your first leks. Paste the mint URL into any Cashu-compatible
            wallet to start accepting payments — no account required.
          </p>
        </section>
      </div>
    </Layout>
  );
}

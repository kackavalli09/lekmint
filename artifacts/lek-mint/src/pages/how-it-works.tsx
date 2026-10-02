import { Layout } from "@/components/layout";
import { FileSignature, Globe, ArrowRightLeft, Check, X } from "lucide-react";

const lifecycle = [
  {
    step: "1",
    title: "Deposit BTC",
    body: "Generate a deposit address on the Mint tab and send bitcoin to it. The address is derived from the mint's cold-wallet xpub, so funds route straight to cold storage — no hot wallet ever holds them.",
  },
  {
    step: "2",
    title: "Leks are issued",
    body: "Once your deposit confirms on-chain, leks are issued one-for-one against the net sats deposited, under the current epoch's keyset. The difficulty peg lives in the epochs: each epoch fixes a rate tied to Bitcoin mining difficulty, so a lek always represents the same slice of embodied energy cost.",
  },
  {
    step: "3",
    title: "Hold and spend as ecash",
    body: "Your tokens live in this browser wallet, or in any Cashu wallet you paste the mint URL into. Send and receive them like cash — the mint signs them blind and never learns who holds what. When difficulty changes and a new epoch begins, older tokens are automatically valued at the current rate whenever they move — receiving, spending, and melting all apply it, and the Update tab remains as an explicit option. Holding tokens in an external Cashu wallet after a rate change? External wallets transact at face value — the appreciation is held safely for you, and pasting the original token into this wallet credits the difference automatically.",
  },
  {
    step: "4",
    title: "Redeem back to BTC",
    body: "Redeemed leks are verified, marked spent, and destroyed, which shrinks the supply. BTC settlement then happens outside the mint software: the operator pays out in batches from cold storage, signed offline as PSBTs. There are no instant, automatic payouts.",
  },
];

const coldWalletCards = [
  {
    icon: FileSignature,
    title: "PSBT batches",
    body: "Outgoing payments are built as Partially Signed Bitcoin Transactions (BIP-174), signed on an offline machine, and broadcast in batches.",
  },
  {
    icon: Globe,
    title: "On-chain only",
    body: "This mint runs on the Bitcoin main chain. Every sat deposited is real money — there is no testnet mode.",
  },
  {
    icon: ArrowRightLeft,
    title: "Deposits are one-way",
    body: "Once BTC lands in cold storage it stays there until a batched redemption pays it out. There are no instant withdrawals.",
  },
];

const canDo = [
  "Issue new tokens when a BTC deposit confirms, at the published epoch rate",
  "Verify tokens cryptographically and reject double-spends",
  "Publish epoch rates so old tokens can be updated to the current denomination",
  "Verify and destroy redeemed tokens, shrinking the recorded supply",
];

const cannotDo = [
  "See your balance, your identity, or who pays whom — blind signatures hide all of it",
  "Freeze, censor, or claw back tokens once they are issued",
  "Redirect deposits — addresses derive deterministically from the cold-wallet xpub",
];

export default function HowItWorksPage() {
  return (
    <Layout>
      <div className="max-w-2xl mx-auto mt-8 space-y-14">
        {/* Lifecycle */}
        <section>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tighter mb-6">
            The lifecycle of a lek
          </h1>
          <div className="space-y-4">
            {lifecycle.map((item) => (
              <div key={item.step} className="border rounded-xl p-5 flex gap-4">
                <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm shrink-0">
                  {item.step}
                </div>
                <div>
                  <h3 className="font-semibold mb-1">{item.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Cashu in one paragraph */}
        <section>
          <h2 className="text-2xl font-bold mb-3">Cashu, in one paragraph</h2>
          <p className="text-muted-foreground leading-relaxed">
            Cashu is Chaumian ecash: when you mint, your wallet sends the mint a blinded
            message, and the mint signs it without ever seeing what it signed. The result
            is a bearer token — whoever holds it, owns it, and the mint cannot connect the
            token it signed to the token that comes back. Every signature carries a DLEQ
            proof (NUT-12) so your wallet can verify the mint signed honestly. The mint
            keeps exactly one record: a list of spent tokens, so nothing can be spent twice.
            No accounts, no history, no surveillance.
          </p>
        </section>

        {/* No accounts */}
        <section>
          <h2 className="text-2xl font-bold mb-3">No accounts, no sign-in</h2>
          <p className="text-muted-foreground leading-relaxed">
            There is nothing to register and nothing to log into. Your wallet is created
            in this browser and your tokens are stored locally on your device — the mint
            never knows they are yours. Treat them like cash in your pocket: if you clear
            this browser's storage, they are gone. If a mint or update operation is
            interrupted, the Recover tab can re-claim tokens from pending requests.
          </p>
        </section>

        {/* Cold wallet cards */}
        <section>
          <h2 className="text-2xl font-bold mb-3">Cold-wallet mint</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {coldWalletCards.map((card) => (
              <div key={card.title} className="border rounded-xl p-5">
                <card.icon className="w-4 h-4 text-primary mb-2" />
                <h3 className="font-semibold text-sm mb-1.5">{card.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Can and cannot */}
        <section>
          <h2 className="text-2xl font-bold mb-4">What the mint can and cannot do</h2>
          <div className="space-y-2.5 mb-6">
            {canDo.map((item) => (
              <div key={item} className="flex gap-3 items-start">
                <Check className="w-4 h-4 text-green-600 dark:text-green-500 mt-0.5 shrink-0" />
                <p className="text-sm text-muted-foreground leading-relaxed">{item}</p>
              </div>
            ))}
          </div>
          <div className="space-y-2.5">
            {cannotDo.map((item) => (
              <div key={item} className="flex gap-3 items-start">
                <X className="w-4 h-4 text-red-600 dark:text-red-500 mt-0.5 shrink-0" />
                <p className="text-sm text-muted-foreground leading-relaxed">{item}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </Layout>
  );
}

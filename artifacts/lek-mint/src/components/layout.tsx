import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useTheme } from "@/hooks/use-theme";
import { Moon, Sun, AlertTriangle, Mail } from "lucide-react";
import { getMintUrl } from "@/lib/wallet";
import { TestingWarning } from "@/components/ui/testing-warning";
import { useGetSocialLinks } from "@workspace/api-client-react";
import lekmint4 from "@/assets/lekmint4.png";

// Nostr ostrich SVG icon (minimal inline)
function NostrIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-.5 14.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3.5-5c0 1.1-.9 2-2 2h-2c-1.1 0-2-.9-2-2V8c0-1.1.9-2 2-2h2c1.1 0 2 .9 2 2v3.5z" />
    </svg>
  );
}

// X (Twitter) icon
function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

// Simple ostrich/nostr icon using text emoji fallback styled as SVG shape
function NostrOstrichIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      {/* ostrich silhouette simplified */}
      <ellipse cx="50" cy="62" rx="18" ry="22" />
      <ellipse cx="50" cy="32" rx="10" ry="12" />
      <rect x="47" y="43" width="6" height="12" />
      <ellipse cx="60" cy="26" rx="5" ry="3" />
      <rect x="38" y="82" width="7" height="14" rx="3" />
      <rect x="55" y="82" width="7" height="14" rx="3" />
    </svg>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { theme, setTheme } = useTheme();
  const [location] = useLocation();

  const tabs = [
    { name: "Wallet", path: "/" },
    { name: "Mint", path: "/mint" },
    { name: "Send", path: "/send" },
    { name: "Receive", path: "/receive" },
    { name: "Melt", path: "/melt" },
    { name: "Recover", path: "/recover" },
    { name: "Update", path: "/update" },
    { name: "About", path: "/about" },
    { name: "Why Lek", path: "/why-lek" },
    { name: "How it works", path: "/how-it-works" },
  ];

  // Auto-scroll the active tab into view on narrow screens.
  const activeTabRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: "smooth",
    });
  }, [location]);

  const mintUrl = getMintUrl();
  const [copiedUrl, setCopiedUrl] = useState(false);

  const copyMintUrl = async () => {
    try {
      await navigator.clipboard.writeText(mintUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch (e) {
      console.error(e);
    }
  };

  const { data: social } = useGetSocialLinks();

  const hasSocial =
    social && (social.contactXUrl || social.contactNostrUrl || social.contactEmail);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col font-sans">
      <header className="border-b bg-background">
        <div className="max-w-3xl w-full mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-1.5 hover:opacity-80 transition-opacity">
              <img src={lekmint4} alt="Lek Mint" className="w-8 h-8 object-contain rounded-xl" />
              <span className="font-bold text-lg tracking-tight">Lek Mint</span>
            </Link>
            <span className="text-[10px] uppercase tracking-widest border px-2 py-0.5 rounded text-muted-foreground ml-1 font-semibold hidden sm:inline-block">
              On-chain
            </span>
          </div>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="w-8 h-8 flex items-center justify-center rounded-xl border hover:bg-muted transition-colors"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>
      <div className="flex-1 w-full max-w-3xl mx-auto px-4 flex flex-col">
        {/* HERO */}
        <div className="pt-6 pb-4 text-center flex flex-col items-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border bg-muted/30 text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-primary" />
            Cashu ecash · Backed by on-chain BTC
          </div>

          {/* Logo + wordmark */}
          <div className="flex flex-col items-center mb-4 gap-0">
            <img
              src={lekmint4}
              alt="Lek Mint logo"
              className="w-30 h-30 md:w-36 md:h-36 object-contain"
            />
            <h1 className="text-[36px] font-bold tracking-tighter leading-tight">
              Lek
            </h1>
          </div>

          <p className="text-muted-foreground text-sm md:text-base max-w-lg mx-auto leading-relaxed">
            A money layer on top of Bitcoin. Deposit real BTC, hold lek pegged to mining difficulty — a claim on real energy cost. No banks, no fiat rails, no exchange rates.
          </p>
        </div>

        {/* TABS */}
        <div className="mb-6 w-full overflow-x-auto pb-2">
          <nav className="flex w-max mx-auto p-1 bg-muted rounded-full">
            {tabs.map((tab) => {
              const isActive = location === tab.path;
              return (
                <Link
                  key={tab.name}
                  href={tab.path}
                  ref={isActive ? activeTabRef : undefined}
                  className={`px-4 sm:px-5 py-2 rounded-full text-xs sm:text-sm font-medium transition-all ${
                    isActive
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab.name}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* MINT URL BOX */}
        <div className="mb-4">
          <div className="bg-secondary/30 border rounded-xl p-4 flex flex-col gap-2.5">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
              Mint URL — Paste this into your Cashu wallet
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-background border px-3 py-2.5 rounded-lg text-xs md:text-sm text-muted-foreground overflow-x-auto whitespace-nowrap">
                {mintUrl}
              </code>
              <button
                onClick={copyMintUrl}
                className="bg-primary text-primary-foreground px-4 py-2.5 rounded-lg text-xs md:text-sm font-semibold hover:opacity-90 transition-opacity whitespace-nowrap"
              >
                {copiedUrl ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        </div>

        {/* RED WARNING BANNER */}
        <div className="mb-8">
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex gap-3 text-red-700 dark:text-red-400">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="text-sm leading-relaxed">
              <strong className="font-semibold">On-chain.</strong> Every sat is real money. Deposits are one-way; redemptions settle in batches from cold storage.
            </div>
          </div>
        </div>

        {/* MAIN CONTENT */}
        <main className="flex-1 pb-16 flex flex-col">
          <TestingWarning />
          {children}
        </main>
      </div>
      <footer className="border-t mt-auto">
        {/* Social / contact row */}
        {hasSocial && (
          <div className="max-w-3xl mx-auto px-4 pt-6 pb-2 text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-4">Contact</p>
          </div>
        )}
        {hasSocial && (
          <div className="max-w-3xl mx-auto px-4 pb-6 flex items-center justify-center gap-6">
            {social.contactXUrl && (
              <a
                href={social.contactXUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="X (Twitter)"
                title="X (Twitter)"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <XIcon className="w-5 h-5" />
              </a>
            )}
            {social.contactNostrUrl && (
              <a
                href={social.contactNostrUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Nostr"
                title="Nostr"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <NostrOstrichIcon className="w-5 h-5" />
              </a>
            )}
            {social.contactEmail && (
              <a
                href={`mailto:${social.contactEmail}`}
                aria-label="Email"
                title="Email"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Mail className="w-5 h-5" />
              </a>
            )}
          </div>
        )}
        <div className="max-w-3xl mx-auto px-4 py-4 text-center text-muted-foreground text-xs border-t border-border/50">
          On-chain only mint · Cold-wallet PSBT (BIP-174) · v{__APP_VERSION__}
        </div>
      </footer>
    </div>
  );
}

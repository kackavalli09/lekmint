import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Lock, LayoutDashboard, Settings2, Wallet, Coins, History, Banknote, Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { TestingWarning } from "@/components/ui/testing-warning";

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  const { logout } = useAuth();

  const nav = [
    { label: "Overview", href: "/", icon: LayoutDashboard },
    { label: "Fee Config", href: "/fees", icon: Settings2 },
    { label: "Mint Settings", href: "/settings", icon: Settings2 },
    { label: "XPUB Management", href: "/xpub", icon: Wallet },
    { label: "Tokenomics", href: "/tokenomics", icon: Coins },
    { label: "Supply Audit Log", href: "/supply", icon: History },
    { label: "Payout Queue", href: "/payouts", icon: Banknote },
  ];

  return (
    <>
      <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
        {nav.map((item) => {
          const isActive = location === item.href;
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className="block" onClick={onNavigate}>
              <div
                className={cn(
                  "flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t shrink-0">
        <button
          onClick={logout}
          className="flex w-full items-center gap-3 px-3 py-2 text-sm font-medium rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          data-testid="button-lock"
        >
          <Lock className="w-4 h-4 shrink-0" />
          Lock Session
        </button>
      </div>
    </>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-64 border-r bg-card flex-col shrink-0">
        <div className="h-16 flex items-center px-6 border-b shrink-0">
          <div className="flex items-center gap-2 text-primary font-bold tracking-widest uppercase">
            <div className="w-3 h-3 bg-accent rounded-sm" />
            Lek Mint Ops
          </div>
        </div>
        <NavItems />
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden relative min-w-0">
        {/* Mobile header */}
        <div className="md:hidden flex items-center h-14 px-4 border-b bg-card shrink-0 gap-3">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <button
                aria-label="Open navigation"
                className="w-8 h-8 flex items-center justify-center rounded-md border hover:bg-muted transition-colors"
              >
                <Menu className="w-4 h-4" />
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0 flex flex-col">
              <div className="h-14 flex items-center px-6 border-b shrink-0">
                <div className="flex items-center gap-2 text-primary font-bold tracking-widest uppercase">
                  <div className="w-3 h-3 bg-accent rounded-sm" />
                  Lek Mint Ops
                </div>
              </div>
              <NavItems onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>
          <span className="font-bold tracking-widest uppercase text-sm text-primary">Lek Mint Ops</span>
        </div>

        <div className="absolute inset-0 md:top-0 top-14 overflow-y-auto p-4 md:p-8">
          <div className="max-w-6xl mx-auto">
            <TestingWarning />
            {children}
          </div>
          <footer className="mt-8 pb-4 text-center text-xs text-muted-foreground/50">
            v{__APP_VERSION__}
          </footer>
        </div>
      </main>
    </div>
  );
}

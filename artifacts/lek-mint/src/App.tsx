import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ServiceStatusBanner } from '@/components/service-status-banner';
import { Route, Switch, Redirect, Router as WouterRouter } from 'wouter';

import NotFound from '@/pages/not-found';
import WalletPage from '@/pages/wallet';
import MintPage from '@/pages/mint';
import SendPage from '@/pages/send';
import ReceivePage from '@/pages/receive';
import MeltPage from '@/pages/melt';
import RecoverPage from '@/pages/recover';
import UpdatePage from '@/pages/update';
import AboutPage from '@/pages/about';
import HowItWorksPage from '@/pages/how-it-works';
import WhyLekPage from '@/pages/why-lek';

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={WalletPage} />
      <Route path="/mint" component={MintPage} />
      <Route path="/send" component={SendPage} />
      <Route path="/receive" component={ReceivePage} />
      <Route path="/melt" component={MeltPage} />
      <Route path="/recover" component={RecoverPage} />
      <Route path="/update" component={UpdatePage} />
      {/* Legacy URL — keep old bookmarks working */}
      <Route path="/upgrade">
        <Redirect to="/update" />
      </Route>
      <Route path="/about" component={AboutPage} />
      <Route path="/how-it-works" component={HowItWorksPage} />
      <Route path="/why-lek" component={WhyLekPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <ServiceStatusBanner />
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

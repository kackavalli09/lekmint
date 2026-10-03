import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ServiceStatusBanner } from '@/components/service-status-banner';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, Redirect } from 'wouter';
import { AuthProvider, useAuth } from '@/lib/auth';
import { Layout } from '@/components/layout';

import Login from '@/pages/login';
import Overview from '@/pages/overview';
import Fees from '@/pages/fees';
import Settings from '@/pages/settings';
import Xpub from '@/pages/xpub';
import Tokenomics from '@/pages/tokenomics';
import Supply from '@/pages/supply';
import Payouts from '@/pages/payouts';

const queryClient = new QueryClient();

function ProtectedRoute({ component: Component }: { component: any }) {
  const { isReady, token } = useAuth();
  
  if (!isReady) return null;
  if (!token) return <Redirect to="/login" />;
  
  return (
    <Layout>
      <Component />
    </Layout>
  );
}

function Router() {
  const { isReady, token } = useAuth();

  if (!isReady) return null;

  return (
    <Switch>
      <Route path="/login">
        {token ? <Redirect to="/" /> : <Login />}
      </Route>
      
      <Route path="/" component={() => <ProtectedRoute component={Overview} />} />
      <Route path="/fees" component={() => <ProtectedRoute component={Fees} />} />
      <Route path="/settings" component={() => <ProtectedRoute component={Settings} />} />
      <Route path="/xpub" component={() => <ProtectedRoute component={Xpub} />} />
      <Route path="/tokenomics" component={() => <ProtectedRoute component={Tokenomics} />} />
      <Route path="/supply" component={() => <ProtectedRoute component={Supply} />} />
      <Route path="/payouts" component={() => <ProtectedRoute component={Payouts} />} />
      
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <ServiceStatusBanner />
            <Router />
          </WouterRouter>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

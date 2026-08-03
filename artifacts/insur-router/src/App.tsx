import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Shell } from '@/components/layout/Shell';

import Dashboard from '@/pages/Dashboard';
import ApplicationsList from '@/pages/ApplicationsList';
import ApplicationNew from '@/pages/ApplicationNew';
import ApplicationDetail from '@/pages/ApplicationDetail';
import ProvidersList from '@/pages/ProvidersList';
import ProviderEdit from '@/pages/ProviderEdit';
import Worklist from '@/pages/Worklist';
import ServiceWorklist from '@/pages/ServiceWorklist';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/worklist" component={Worklist} />
        <Route path="/service" component={ServiceWorklist} />
        <Route path="/applications" component={ApplicationsList} />
        <Route path="/applications/new" component={ApplicationNew} />
        <Route path="/applications/:id" component={ApplicationDetail} />
        <Route path="/providers" component={ProvidersList} />
        <Route path="/providers/new" component={ProviderEdit} />
        <Route path="/providers/:id/edit" component={ProviderEdit} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, '') || ""}>
        <Router />
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;

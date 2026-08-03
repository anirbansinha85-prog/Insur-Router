import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Shell } from '@/components/layout/Shell';
import { ShowroomProvider } from '@/lib/showroom';

import Leads from '@/pages/Leads';
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

function NotFound() {
  return (
    <div className="py-24 text-center">
      <h1 className="text-2xl font-bold text-slate-900">Not found</h1>
      <p className="text-slate-500 text-sm mt-2">No such screen in DDMS.</p>
    </div>
  );
}

function Router() {
  return (
    <Shell>
      <Switch>
        {/* Enquiries at the root: a lead nobody answers never becomes a deal to
            insure or a bike to service, so it is where the day starts. */}
        <Route path="/" component={Leads} />
        <Route path="/worklist" component={Worklist} />
        <Route path="/service" component={ServiceWorklist} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, '') || ''}>
        {/* Showroom scope wraps the router, so switching outlet in the header
            carries across every screen rather than each page keeping its own. */}
        <ShowroomProvider>
          <Router />
        </ShowroomProvider>
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;

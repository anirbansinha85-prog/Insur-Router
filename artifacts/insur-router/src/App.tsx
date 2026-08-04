import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import {
  useGetCurrentUser,
  useLogout,
  type SessionUser,
} from '@workspace/api-client-react';
import { Shell } from '@/components/layout/Shell';

import SignIn from '@/pages/SignIn';
import Dashboard from '@/pages/Dashboard';
import ApplicationsList from '@/pages/ApplicationsList';
import ApplicationNew from '@/pages/ApplicationNew';
import ApplicationDetail from '@/pages/ApplicationDetail';
import ProvidersList from '@/pages/ProvidersList';
import ProviderEdit from '@/pages/ProviderEdit';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Nothing renders until we know who is asking.
 *
 * A 401 from /auth/me is the ordinary answer for a signed-out visitor rather
 * than an error, so it is handled here instead of surfacing as a failed request
 * on every screen. The same gate DDMS has had since OBJ-3; InsurRouter only got
 * one in OBJ-8, and until then its screens showed every dealership's work to
 * anybody who could reach the API.
 */
function Gate() {
  const qc = useQueryClient();
  const logout = useLogout();
  const { data: user, isLoading, isError } = useGetCurrentUser({
    query: { queryKey: ['/api/auth/me'], retry: false },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <div className="text-sm text-slate-400">Loading…</div>
      </div>
    );
  }

  if (isError || !user) return <SignIn />;

  const signOut = () =>
    logout.mutate(undefined, {
      // Clear rather than refetch: everything cached belongs to the owner who
      // is leaving, and the next person to sign in must not see any of it.
      onSuccess: () => qc.clear(),
    });

  return (
    <Shell user={user as SessionUser} onSignOut={signOut}>
      <Switch>
        <Route path="/" component={Dashboard} />
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
        <Gate />
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import SignIn from '@/pages/SignIn';
import { Workspace } from '@/pages/Workspace';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import {
  useGetCurrentUser,
  useLogout,
  type SessionUser,
} from '@workspace/api-client-react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Nothing renders until we know who is asking.
 *
 * A 401 from /auth/me is the ordinary answer for a signed-out visitor rather
 * than an error, so it is handled here instead of every ingest source failing
 * on its own.
 */
function Gate() {
  const qc = useQueryClient();
  const logout = useLogout();
  const { data: user, isLoading, isError } = useGetCurrentUser({
    query: { queryKey: ['/api/auth/me'], retry: false },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (isError || !user) return <SignIn />;

  const signOut = () =>
    logout.mutate(undefined, {
      // Clear rather than refetch: a half-reviewed draft belongs to the person
      // who was signed in, and the next one must not inherit it.
      onSuccess: () => qc.clear(),
    });

  return (
    <Switch>
      <Route path="/">
        <Workspace user={user as SessionUser} onSignOut={signOut} />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, '') || ""}>
          <Gate />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import {
  useGetCurrentUser,
  useLogout,
  type SessionUser,
} from '@workspace/api-client-react';
import { Shell } from '@/components/layout/Shell';
import { ShowroomProvider } from '@/lib/showroom';

import SignIn from '@/pages/SignIn';
import Leads from '@/pages/Leads';
import Worklist from '@/pages/Worklist';
import ServiceWorklist from '@/pages/ServiceWorklist';
import Registrations from '@/pages/Registrations';

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

/**
 * Nothing renders until we know who is asking.
 *
 * A 401 from /auth/me is the ordinary answer for a signed-out visitor, not an
 * error — so it is handled here rather than surfacing as a failed request on
 * every screen. Rendering the console shell first and the sign-in form second
 * would also flash one owner's chrome at somebody who may belong to another.
 */
function Gate() {
  const queryClient = useQueryClient();
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
      onSuccess: () => queryClient.clear(),
    });

  return (
    <ShowroomProvider>
      <Shell user={user as SessionUser} onSignOut={signOut}>
        <Switch>
          {/* Enquiries at the root: a lead nobody answers never becomes a deal
              to insure or a bike to service, so it is where the day starts. */}
          <Route path="/" component={Leads} />
          <Route path="/worklist" component={Worklist} />
          <Route path="/registrations" component={Registrations} />
          <Route path="/service" component={ServiceWorklist} />
          <Route component={NotFound} />
        </Switch>
      </Shell>
    </ShowroomProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, '') || ''}>
        <Gate />
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;

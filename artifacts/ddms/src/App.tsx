import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import {
  useGetCurrentUser,
  useLogout,
  type SessionUser,
} from '@workspace/api-client-react';
import { Shell } from '@/components/layout/Shell';
import { ShowroomProvider } from '@/lib/showroom';
import { NotYours, ROUTE_MODULE, mayOpen } from '@/lib/permitted';

import SignIn from '@/pages/SignIn';
import Queue from '@/pages/Queue';
import Overview from '@/pages/Overview';
import Numbers from '@/pages/Numbers';
import Learned from '@/pages/Learned';
import Channels from '@/pages/Channels';
import Runs from '@/pages/Runs';
import Books from '@/pages/Books';
import Invoice from '@/pages/Invoice';
import Leads from '@/pages/Leads';
import Worklist from '@/pages/Worklist';
import ServiceWorklist from '@/pages/ServiceWorklist';
import Registrations from '@/pages/Registrations';
import Spares from '@/pages/Spares';
import Case from "@/pages/Case"
import Journal from "@/pages/Journal"
import Dossier from '@/pages/Dossier';
import Outbox from '@/pages/Outbox';
import Invoices from './pages/Invoices';
import Receivables from '@/pages/Receivables';
import Inventory from '@/pages/Inventory';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * A screen, or the reason it is not yours.
 *
 * The server refuses either way; this only decides whether the refusal is
 * legible. Rendering the page and letting its queries 403 produced four
 * zeroes and an empty state, which reads as "your dealership has none of
 * these" — a false claim about somebody's own business.
 */
function guard(user: SessionUser, path: string, screen: React.ReactNode) {
  return mayOpen(user, path) ? screen : <NotYours user={user} module={ROUTE_MODULE[path]!} />;
}

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

  const u = user as SessionUser

  return (
    <ShowroomProvider>
      <Shell user={u} onSignOut={signOut}>
        <Switch>
          {/* The queue is the root, since OBJ-15. Enquiries held it before,
              on the argument that a lead nobody answers never becomes a deal
              to insure or a bike to service — which is still true, and is now
              an argument for the queue: it holds those leads *and* everything
              else waiting on a person, in the order they should be done.

              Not module-gated. The queue spans every module and scopes itself
              by what this role may read, so there is no single module to refuse
              it on, and it is the one screen that is never the wrong door. An
              empty queue is a true answer. */}
          <Route path="/"><Queue /></Route>
          <Route path="/queue"><Queue /></Route>
          {/* The other half of what this product is, and deliberately not the
              root. The queue is the right first screen for the person doing
              the work, which is most of the logins; an owner arrives here from
              the first item in the sidebar. Swapping the two by role would
              mean the same URL showing two different screens, which is worse
              than either choice.

              Not module-gated, for the same reason the queue is not: it spans
              every module and narrows itself to what the role may read, so
              there is no single module to refuse it on. What somebody may not
              read is named on the page rather than counted as zero. */}
          <Route path="/overview"><Overview /></Route>
          {/* Readable by everybody, editable by an owner or a manager — the
              numbers explain what is on somebody's screen, and hiding them
              would make the queue's order look arbitrary. The refusal to edit
              is on the row policies, not on this route. */}
          <Route path="/numbers"><Numbers permissions={u.permissions ?? []} /></Route>
          {/* Same reasoning as the numbers: readable by everybody, because it
              explains what is on their queue, and only an owner or a manager
              may answer the one question it asks. */}
          <Route path="/learned"><Learned permissions={u.permissions ?? []} /></Route>
          {/* Readable by everybody so the Outbox's refusals make sense, and
              writable by an owner or a manager. Connecting a number is not a
              visibility question — it decides what this product may say to
              customers on the dealership's behalf. */}
          <Route path="/channels"><Channels permissions={u.permissions ?? []} /></Route>
          {/* Readable by everybody, and read-only for everybody. A run is
              opened and closed by the thing doing the running; a person
              editing what an unattended process recorded about itself is the
              one change that would make the whole table worthless. */}
          <Route path="/runs"><Runs /></Route>
          {/* Gated on the ledger module — RECEIVABLE, because that is what a
              role needs to see money here and the accounts are where it ends
              up. A second LEDGER module would be a second answer to one
              question. */}
          <Route path="/books">{guard(u, "/books", <Books />)}</Route>
          {/* A journal is a new voucher rather than an edit, so it is its own
              screen. /books still has no edit control and will not get one. */}
          <Route path="/journal">{guard(u, "/books", <Journal />)}</Route>
          <Route path="/enquiries">{guard(u, "/enquiries", <Leads />)}</Route>
          <Route path="/worklist">{guard(u, "/worklist", <Worklist />)}</Route>
          <Route path="/registrations">{guard(u, "/registrations", <Registrations />)}</Route>
          <Route path="/service">{guard(u, "/service", <ServiceWorklist />)}</Route>
          <Route path="/spares">{guard(u, "/spares", <Spares />)}</Route>
          <Route path="/receivables">{guard(u, "/receivables", <Receivables />)}</Route>
          <Route path="/inventory">{guard(u, "/inventory", <Inventory />)}</Route>
          {/* The only screen where DDMS proposes to speak for the dealership,
              which is why it is its own place rather than a panel on a row. */}
          <Route path="/invoices">{guard(u, "/invoices", <Invoices />)}</Route>
          {/* The document itself, printable. Gated on DEAL like the list it is
              reached from — a technician closing job cards has no business
              seeing what a customer paid. */}
          <Route path="/invoices/:id">{guard(u, "/invoices", <Invoice />)}</Route>
          <Route path="/outbox">{guard(u, "/outbox", <Outbox />)}</Route>
          {/* Not in the sidebar: you arrive here from the search box or from a
              row, never by browsing. It is a lens on one record, not a screen. */}
          {/* One record on its own page, opened in a new tab from any worklist.
              A real URL rather than a modal: a manager working a handover keeps
              six open, comes back to one, and pastes one to somebody. */}
          <Route path="/case/:module/:recordKey" component={Case} />
          <Route path="/who/:entityId" component={Dossier} />
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

-- Row-level security for the DDMS request path.
--
-- Until this file existed, isolation was enforced entirely in application code:
-- every tenant-scoped query carried a `where owner_id = ...` that somebody had
-- to remember to write. That works right up until one query is written without
-- it, and then the failure is silent — a screen quietly showing another
-- dealership's customers, with nothing in the logs to say so.
--
-- What this does about it:
--
--   1. A second Postgres role, `ddms_app`, which owns nothing and has
--      `nobypassrls`. RLS applies to it, unlike the `postgres` role the server
--      has been connecting as.
--   2. Deny by default. Every table already had RLS enabled with no policies,
--      so `ddms_app` starts able to read nothing at all. Each policy below is
--      an explicit, auditable grant.
--   3. Scope from the session, not from the query. Policies resolve the owner
--      through `app.current_owner_id()`, which reads the session token the
--      request set on the connection.
--
-- The token is what makes this more than bookkeeping. `ddms_app` has **no
-- grants at all** on `users` or `sessions` — it cannot read a token hash, so it
-- cannot invent one. `app.current_owner_id()` is `security definer` and reads
-- those tables on its behalf, returning only the owner id. Holding the
-- `ddms_app` credentials therefore gets you exactly as far as holding no
-- session: zero rows.
--
-- **Three roles, not one.** Two jobs happen with nobody signed in — working out
-- who is signing in, and syncing every dealership on a timer — and neither can
-- be scoped by a session. They ran on the table owner for want of anywhere else
-- to run, which kept a bypassrls credential in the server's environment long
-- after the request path had stopped needing one. `ddms_login` and
-- `ddms_worker` are those two jobs, each holding only the tables it touches.
-- See *The other two connections* below.
--
-- Idempotent. Run it as the table owner:  pnpm run db:rls

-- ── The helper schema ───────────────────────────────────────────────────────
-- Kept out of `public` so nothing here is mistaken for application data, and so
-- `grant ... on all tables in schema public` can never accidentally include it.

create schema if not exists app;
revoke all on schema app from public;

/*
 * Which owner is asking.
 *
 * `security definer` on purpose: this reads `sessions` and `users`, and the
 * whole design depends on the calling role NOT being able to read those itself.
 * A role that could read `sessions.token_hash` could set the GUC to any value
 * it liked, and every policy below would hand it that owner's data.
 *
 * `set search_path` is not decoration — without it a caller could create a
 * `sessions` table in a schema earlier on their path and have this function
 * read that instead.
 *
 * Returns null when there is no session, no valid session, or a deactivated
 * user. Null makes every policy below false, which is the correct answer to
 * "who is this" when nobody has said.
 */
/*
 * The user behind this session, if there is one and they still work here.
 *
 * Every helper below resolves through this rather than repeating the join, and
 * it is where the departure check lives. `lib/session.ts` refuses a departed
 * employee at sign-in and on every request; this makes the same refusal true at
 * the database, which is the standard OBJ-7 set — *isolation enforced by the
 * database, not only by application code*. Without it, holding a session row
 * for somebody who left in February still read their branch's rows, and the
 * only thing stopping that was code remembering to check.
 *
 * **An absent employee row is not a departure.** A staff master that has not
 * synced yet, or a code the dealership has retired, must not lock anybody out:
 * the mirror revokes on a positive statement that somebody left, never on the
 * absence of evidence. Same rule as the TypeScript side, deliberately.
 */
create or replace function app.session_user_id()
  returns integer
  language sql
  stable
  security definer
  set search_path = pg_catalog, public, pg_temp
as $$
  select u.id
    from public.sessions s
    join public.users u on u.id = s.user_id
    left join public.dms_employees e
      on e.emp_code = u.emp_code
     and e.showroom_id = u.showroom_id
   where s.token_hash = nullif(current_setting('app.session_token', true), '')
     and s.expires_at > now()
     and u.is_active
     and (e.emp_code is null or e.is_active = 'Y')
   limit 1
$$;

create or replace function app.current_owner_id()
  returns integer
  language sql
  stable
  security definer
  set search_path = pg_catalog, public, pg_temp
as $$
  select u.owner_id from public.users u where u.id = app.session_user_id()
$$;

/*
 * The owner's outlets, and the things that hang off them.
 *
 * These exist so a policy reads as one comparison rather than three nested
 * subqueries. They are `security definer` for the same reason as above and
 * `stable` so Postgres evaluates them once per statement rather than once per
 * row — on a worklist that is the difference between one query and a thousand.
 */
create or replace function app.owned_showroom_ids()
  returns setof integer
  language sql
  stable
  security definer
  set search_path = pg_catalog, public, pg_temp
as $$
  select s.id from public.showrooms s where s.owner_id = app.current_owner_id()
$$;

create or replace function app.owned_dms_account_ids()
  returns setof integer
  language sql
  stable
  security definer
  set search_path = pg_catalog, public, pg_temp
as $$
  select a.id
    from public.showroom_dms_accounts a
   where a.showroom_id in (select app.owned_showroom_ids())
$$;

/*
 * Applications the owner holds.
 *
 * `showroom_id` is nullable, and a null is deliberately **not** owned by
 * anybody: making an unattributed application visible to whoever asked first
 * would be worse than making it visible to nobody.
 *
 * That used to be a standing condition — hand, OCR and scrape applications had
 * no showroom, and were reachable only because InsurRouter ran on a connection
 * this role's policies did not apply to. Since OBJ-8 it is a failure state
 * instead: every create path takes the outlet from the session, so a null here
 * means something went in without one, and the row is invisible to everybody
 * including whoever created it. `db:seed-applications` reports the count.
 */
create or replace function app.owned_application_ids()
  returns setof integer
  language sql
  stable
  security definer
  set search_path = pg_catalog, public, pg_temp
as $$
  select a.id
    from public.applications a
   where a.showroom_id in (select app.owned_showroom_ids())
$$;

/*
 * The role this session's user holds, and the outlets they may look at.
 *
 * Added for OBJ-14, when a dealership's staff got their own logins. Both are
 * `security definer` for the same reason `current_owner_id` is: they read
 * `users`, which `ddms_app` has no grants on at all.
 *
 * **These narrow and cannot widen.** `visible_showroom_ids` returns the
 * employee's one outlet when they have one, and the owner's whole set when they
 * do not — so it is always a subset of `owned_showroom_ids`. Every policy below
 * ANDs it onto the owner predicate rather than ORing, which means the worst a
 * mistake in this layer can do is hide a row from somebody entitled to it. The
 * reverse is not reachable.
 *
 * Salesforce's model runs the same way in the opposite direction: a private
 * baseline, and every later layer can only grant. Here the baseline is the
 * owner's whole group and every later layer can only take away. The point in
 * both is that the direction of a mistake is safe.
 */
create or replace function app.current_role()
  returns text
  language sql
  stable
  security definer
  set search_path = pg_catalog, public, pg_temp
as $$
  select u.role from public.users u where u.id = app.session_user_id()
$$;

create or replace function app.visible_showroom_ids()
  returns setof integer
  language sql
  stable
  security definer
  set search_path = pg_catalog, public, pg_temp
as $$
  with me as (
    select u.owner_id, u.showroom_id, u.role
      from public.users u
     where u.id = app.session_user_id()
  )
  select s.id
    from public.showrooms s, me
   where s.owner_id = me.owner_id
     and (
       -- An owner or a manager looks across the group. Anybody else is scoped
       -- to the outlet they work at, and a null there means the account was
       -- never tied to one, which is treated as the whole group rather than as
       -- nothing: a login with no outlet is an administrative account, not a
       -- locked one.
       me.role in ('OWNER', 'MANAGER')
       or me.showroom_id is null
       or s.id = me.showroom_id
     )
$$;

/*
 * Whether this session's role may read a module at all.
 *
 * The same table as `lib/dms/access.ts`, written twice on purpose. The
 * TypeScript copy is what the routes and the sidebar consult so a refusal can
 * be explained; this copy is what makes the refusal *true* — a service
 * advisor's connection reads zero rows from the ledger whatever the application
 * code does. Two copies of a table this small, each doing a different job, is a
 * better trade than one copy that only one of the two layers can see.
 */
create or replace function app.can_read(module text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog, public, pg_temp
as $$
  select case app.current_role()
    when 'OWNER'           then true
    when 'MANAGER'         then true
    when 'SALES_EXEC'      then module in ('DEAL', 'ENQUIRY', 'VEHICLE', 'OUTBOX')
    when 'SERVICE_ADVISOR' then module in ('JOB_CARD', 'PART', 'OUTBOX')
    when 'RTO_AGENT'       then module in ('REGISTRATION', 'OUTBOX')
    when 'ACCOUNTS'        then module in ('RECEIVABLE', 'DEAL', 'OUTBOX')
    when 'TECHNICIAN'      then module in ('JOB_CARD')
    else false
  end
$$;

/*
 * Whether this session administers the platform rather than a dealership.
 *
 * Insurers and OCR engines are the same rows for every dealership, so no
 * dealer's session may write them: an owner editing an insurer's endpoint would
 * be editing it for every other owner too. But somebody has to, and until now
 * that somebody was the connection that bypasses RLS.
 *
 * `PLATFORM_ADMIN` is deliberately not a dealership role. `app.can_read()`
 * returns false for it on every module, so the account that can edit reference
 * data can read no customer, deal or policy anywhere. The two jobs are separate
 * logins on purpose — an owner who is also the operator holds both, and each
 * session does one of them.
 */
create or replace function app.is_platform_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(app.current_role() = 'PLATFORM_ADMIN', false)
$$;

-- ── Policies ────────────────────────────────────────────────────────────────
-- `drop policy if exists` before each so re-running this file replaces rather
-- than fails. Every policy names `ddms_app` explicitly: a policy `to public`
-- would also apply to any role added later, which is not a decision this file
-- should be making on someone else's behalf.

-- The owner tier. Read-only from here — DDMS displays the group identity and
-- the outlet list; it does not administer them.
drop policy if exists owners_own on public.owners;
create policy owners_own on public.owners
  for select to ddms_app
  using (id = app.current_owner_id());

drop policy if exists showrooms_own on public.showrooms;
create policy showrooms_own on public.showrooms
  for select to ddms_app
  using (owner_id = app.current_owner_id());

drop policy if exists dms_accounts_own on public.showroom_dms_accounts;
create policy dms_accounts_own on public.showroom_dms_accounts
  for select to ddms_app
  using (showroom_id in (select app.owned_showroom_ids()));

-- The mirror. Written by sync, which runs inside a request when the owner
-- presses Sync, so these need insert and update as well as select. No delete:
-- a record that vanishes from the DMS is marked `disappeared_at`, never
-- removed, because "it used to be there" is itself the signal.
drop policy if exists dms_deals_own on public.dms_deals;
create policy dms_deals_own on public.dms_deals
  for all to ddms_app
  -- Read across the owner's outlets, so the cross-branch findings still
  -- work for whoever may see this module at all. Write only where the
  -- person actually works.
  using (showroom_id in (select app.owned_showroom_ids()) and app.can_read('DEAL'))
  with check (showroom_id in (select app.visible_showroom_ids()) and app.can_read('DEAL'));

drop policy if exists dms_job_cards_own on public.dms_job_cards;
create policy dms_job_cards_own on public.dms_job_cards
  for all to ddms_app
  -- Read across the owner's outlets, so the cross-branch findings still
  -- work for whoever may see this module at all. Write only where the
  -- person actually works.
  using (showroom_id in (select app.owned_showroom_ids()) and app.can_read('JOB_CARD'))
  with check (showroom_id in (select app.visible_showroom_ids()) and app.can_read('JOB_CARD'));

drop policy if exists dms_enquiries_own on public.dms_enquiries;
create policy dms_enquiries_own on public.dms_enquiries
  for all to ddms_app
  -- Read across the owner's outlets, so the cross-branch findings still
  -- work for whoever may see this module at all. Write only where the
  -- person actually works.
  using (showroom_id in (select app.owned_showroom_ids()) and app.can_read('ENQUIRY'))
  with check (showroom_id in (select app.visible_showroom_ids()) and app.can_read('ENQUIRY'));

drop policy if exists dms_employees_own on public.dms_employees;
create policy dms_employees_own on public.dms_employees
  for all to ddms_app
  using (showroom_id in (select app.owned_showroom_ids()))
  with check (showroom_id in (select app.owned_showroom_ids()));

drop policy if exists dms_registrations_own on public.dms_registrations;
create policy dms_registrations_own on public.dms_registrations
  for all to ddms_app
  -- Read across the owner's outlets, so the cross-branch findings still
  -- work for whoever may see this module at all. Write only where the
  -- person actually works.
  using (showroom_id in (select app.owned_showroom_ids()) and app.can_read('REGISTRATION'))
  with check (showroom_id in (select app.visible_showroom_ids()) and app.can_read('REGISTRATION'));

/*
 * Parts stock, and the one policy that is read across outlets rather than at
 * one of them. The scope is still the owner's showrooms — `owned_showroom_ids`
 * is the same helper every other policy uses — because "the part is in the
 * other branch" is only a useful answer when the other branch is yours.
 */
drop policy if exists dms_part_stock_own on public.dms_part_stock;
create policy dms_part_stock_own on public.dms_part_stock
  for all to ddms_app
  -- Read across the owner's outlets, so the cross-branch findings still
  -- work for whoever may see this module at all. Write only where the
  -- person actually works.
  using (showroom_id in (select app.owned_showroom_ids()) and app.can_read('PART'))
  with check (showroom_id in (select app.visible_showroom_ids()) and app.can_read('PART'));

/*
 * The entity graph. Scoped on `owner_id` directly rather than through
 * `owned_showroom_ids`, because an entity belongs to the owner and not to any
 * one of their outlets — a customer who buys at Saraswati and services at
 * Deccan is one row, and that is the whole reason the table exists.
 */
drop policy if exists entities_own on public.entities;
create policy entities_own on public.entities
  for all to ddms_app
  using (owner_id = app.current_owner_id())
  with check (owner_id = app.current_owner_id());

drop policy if exists entity_links_own on public.entity_links;
create policy entity_links_own on public.entity_links
  for all to ddms_app
  using (owner_id = app.current_owner_id())
  with check (owner_id = app.current_owner_id());

/*
 * The decision log. Insert and select only — no update, no delete, and the
 * grants below match. It is the record of who decided what, and a record that
 * can be edited after the fact answers a different question from the one it was
 * written to answer.
 */
drop policy if exists decision_log_own on public.decision_log;
create policy decision_log_own on public.decision_log
  for all to ddms_app
  using (owner_id = app.current_owner_id())
  with check (owner_id = app.current_owner_id());

-- Receivables and the vehicle floor. Same shape as every other mirror: the
-- policy is on the showroom, the showroom list comes from the session, and a
-- query here with no tenant filter comes back empty rather than coming back
-- with the other dealership's ledger.
drop policy if exists dms_receivables_own on public.dms_receivables;
create policy dms_receivables_own on public.dms_receivables
  for all to ddms_app
  -- Read across the owner's outlets, so the cross-branch findings still
  -- work for whoever may see this module at all. Write only where the
  -- person actually works.
  using (showroom_id in (select app.owned_showroom_ids()) and app.can_read('RECEIVABLE'))
  with check (showroom_id in (select app.visible_showroom_ids()) and app.can_read('RECEIVABLE'));

drop policy if exists dms_vehicle_stock_own on public.dms_vehicle_stock;
create policy dms_vehicle_stock_own on public.dms_vehicle_stock
  for all to ddms_app
  -- Read across the owner's outlets, so the cross-branch findings still
  -- work for whoever may see this module at all. Write only where the
  -- person actually works.
  using (showroom_id in (select app.owned_showroom_ids()) and app.can_read('VEHICLE'))
  with check (showroom_id in (select app.visible_showroom_ids()) and app.can_read('VEHICLE'));

/*
 * The event log. Insert and select only, like the decision log and for the same
 * reason: it is the record of what changed, and a record that can be rewritten
 * afterwards is answering a different question from the one it was written to
 * answer. It is also the *source* of current state — the newest row per record
 * is the state — so an update here would not merely lose history, it would
 * silently change what every rule believes is true now.
 */
drop policy if exists record_events_own on public.record_events;
create policy record_events_own on public.record_events
  for all to ddms_app
  using (owner_id = app.current_owner_id())
  with check (owner_id = app.current_owner_id());

/*
 * Outbound messages. Select, insert and update — a draft is composed, then
 * approved, then sent, and each of those is an update to the same row.
 *
 * No delete, deliberately and unlike `entities`. A message somebody decided not
 * to send is `CANCELLED`, not absent: "we chose not to contact this customer"
 * and "nobody ever drafted anything" are different facts about a dealership,
 * and only one of them can be defended later. The grants below match, so a
 * `delete from outbound_messages` on the request path fails at the database
 * rather than relying on nobody writing one.
 */
drop policy if exists outbound_messages_own on public.outbound_messages;
create policy outbound_messages_own on public.outbound_messages
  for all to ddms_app
  using (owner_id = app.current_owner_id())
  with check (owner_id = app.current_owner_id());

/*
 * The dealership's own numbers.
 *
 * Read by anybody in the group — the numbers explain what is on their screen,
 * and hiding them would make the queue's order look arbitrary. Written only by
 * an owner or a showroom manager, which is the same pair `seesEveryOutlet`
 * names in the route: the two roles whose judgement covers the whole
 * dealership rather than one part of it.
 *
 * Two policies rather than one, for the same reason `providers` has two:
 * permissive policies OR together, so select passes on the first and the write
 * verbs can only pass on the second.
 */
drop policy if exists dealer_policy_read on public.dealer_policy;
create policy dealer_policy_read on public.dealer_policy
  for select to ddms_app
  using (owner_id = app.current_owner_id());

drop policy if exists dealer_policy_write on public.dealer_policy;
create policy dealer_policy_write on public.dealer_policy
  for all to ddms_app
  using (owner_id = app.current_owner_id() and app.current_role() in ('OWNER', 'MANAGER'))
  with check (owner_id = app.current_owner_id() and app.current_role() in ('OWNER', 'MANAGER'));

-- The scheduler reads them too: the detector and the rules classify on the
-- dealership's thresholds, and a log that disagreed with the screen it came
-- from would be worse than no log. Read-only — nothing unattended sets policy.
drop policy if exists dealer_policy_worker on public.dealer_policy;
create policy dealer_policy_worker on public.dealer_policy
  for select to ddms_worker using (true);

drop policy if exists insurer_panel_own on public.insurer_panel_entries;
create policy insurer_panel_own on public.insurer_panel_entries
  for select to ddms_app
  using (dms_account_id in (select app.owned_dms_account_ids()));

-- The application pipeline. `with check` on insert is what stops the action
-- button writing a row into somebody else's tenant: the showroom id it carries
-- must be one this session actually owns, whatever the request body said.
--
-- Read across the group, write only to the outlet you are at — the same
-- asymmetry as every mirror table above, and it arrived here in OBJ-8 when
-- InsurRouter got a sign-in. An insurance desk reasonably looks at the group's
-- whole book; nobody reasonably creates a policy against a branch they do not
-- work at.
--
-- Gated on `DEAL` because that is what an application is: the insurance side of
-- a vehicle somebody bought. It carries the customer's Aadhaar number, their
-- address and their date of birth, and a technician closing job cards has no
-- reason to hold any of that. Owners, managers, sales and accounts do.
drop policy if exists applications_own on public.applications;
create policy applications_own on public.applications
  for all to ddms_app
  using (showroom_id in (select app.owned_showroom_ids()) and app.can_read('DEAL'))
  with check (showroom_id in (select app.visible_showroom_ids()) and app.can_read('DEAL'));

drop policy if exists submission_logs_own on public.submission_logs;
create policy submission_logs_own on public.submission_logs
  for all to ddms_app
  using (application_id in (select app.owned_application_ids()))
  with check (application_id in (select app.owned_application_ids()));

drop policy if exists policies_own on public.policies;
create policy policies_own on public.policies
  for select to ddms_app
  using (application_id in (select app.owned_application_ids()));

-- Reference data belonging to nobody. Insurers and OCR engines are the same
-- rows for every dealership, so scoping them would be a lie about what they
-- are. Every session may read them; only a platform administrator may write
-- them, because a write here lands on every other dealership's screen too.
--
-- Two policies rather than one `for all`, and the pair is the point: permissive
-- policies OR together, so `select` passes on the first and `insert`/`update`
-- can only pass on the second. A single `for all using (app.is_platform_admin())`
-- would have made insurers unreadable to everybody who is not the operator.
drop policy if exists providers_readable on public.providers;
create policy providers_readable on public.providers
  for select to ddms_app
  using (true);

drop policy if exists providers_admin on public.providers;
create policy providers_admin on public.providers
  for all to ddms_app
  using (app.is_platform_admin())
  with check (app.is_platform_admin());

drop policy if exists ocr_engines_readable on public.ocr_engines;
create policy ocr_engines_readable on public.ocr_engines
  for select to ddms_app
  using (true);

drop policy if exists ocr_engines_admin on public.ocr_engines;
create policy ocr_engines_admin on public.ocr_engines
  for all to ddms_app
  using (app.is_platform_admin())
  with check (app.is_platform_admin());

-- ── The other two connections ───────────────────────────────────────────────
--
-- `ddms_app` answers requests, and it cannot do the two jobs that happen with
-- nobody signed in: work out *who* is signing in, and sync every dealership on
-- a timer. Both used to run on the table owner, which is how a credential that
-- bypasses RLS and can read every password hash stayed in the server's
-- environment long after the request path had stopped needing it.
--
-- So: one role per job, each holding the smallest set of tables that job
-- touches, and none of them able to bypass anything.
--
--   ddms_login   users, sessions, and the staff master the departure check
--                reads. No customer, deal, policy or application — the
--                credential that can see password hashes can see nothing else.
--   ddms_worker  the mirror and the graph, every tenant, because that is what
--                syncing on a timer *is*, plus read-only sight of the
--                applications a deal's state is defined against, plus the
--                outbox and the decision log — because since OBJ-16 the rules
--                run here and rules draft. No users and no sessions: it still
--                knows nothing about people, and it still cannot decide that
--                anything may leave.
--
-- Neither is scoped by a session, and neither pretends to be. Their scope is
-- the table list below, which is a thing somebody can read in one place.

drop policy if exists users_login on public.users;
create policy users_login on public.users
  for all to ddms_login
  using (true)
  with check (true);

drop policy if exists sessions_login on public.sessions;
create policy sessions_login on public.sessions
  for all to ddms_login
  using (true)
  with check (true);

-- The departure check joins the staff master, so sign-in needs to read it.
-- Select only: this role must never be able to mark somebody as having left.
drop policy if exists dms_employees_login on public.dms_employees;
create policy dms_employees_login on public.dms_employees
  for select to ddms_login
  using (true);

-- The scheduler. Every tenant by definition, so `true` rather than a session
-- predicate — and the honesty of that depends entirely on the grant list
-- further down being short.
drop policy if exists mirror_worker on public.dms_deals;
create policy mirror_worker on public.dms_deals
  for all to ddms_worker using (true) with check (true);

drop policy if exists mirror_worker on public.dms_job_cards;
create policy mirror_worker on public.dms_job_cards
  for all to ddms_worker using (true) with check (true);

drop policy if exists mirror_worker on public.dms_enquiries;
create policy mirror_worker on public.dms_enquiries
  for all to ddms_worker using (true) with check (true);

drop policy if exists mirror_worker on public.dms_employees;
create policy mirror_worker on public.dms_employees
  for all to ddms_worker using (true) with check (true);

drop policy if exists mirror_worker on public.dms_registrations;
create policy mirror_worker on public.dms_registrations
  for all to ddms_worker using (true) with check (true);

drop policy if exists mirror_worker on public.dms_part_stock;
create policy mirror_worker on public.dms_part_stock
  for all to ddms_worker using (true) with check (true);

drop policy if exists mirror_worker on public.dms_receivables;
create policy mirror_worker on public.dms_receivables
  for all to ddms_worker using (true) with check (true);

drop policy if exists mirror_worker on public.dms_vehicle_stock;
create policy mirror_worker on public.dms_vehicle_stock
  for all to ddms_worker using (true) with check (true);

drop policy if exists graph_worker on public.entities;
create policy graph_worker on public.entities
  for all to ddms_worker using (true) with check (true);

drop policy if exists graph_worker on public.entity_links;
create policy graph_worker on public.entity_links
  for all to ddms_worker using (true) with check (true);

drop policy if exists events_worker on public.record_events;
create policy events_worker on public.record_events
  for all to ddms_worker using (true) with check (true);

drop policy if exists tenancy_worker on public.owners;
create policy tenancy_worker on public.owners
  for select to ddms_worker using (true);

drop policy if exists tenancy_worker on public.showrooms;
create policy tenancy_worker on public.showrooms
  for select to ddms_worker using (true);

drop policy if exists tenancy_worker on public.showroom_dms_accounts;
create policy tenancy_worker on public.showroom_dms_accounts
  for select to ddms_worker using (true);

/*
 * And the two the scheduler needs to *read* but must never write.
 *
 * This was not in the first version of this file, and the scheduler told me so:
 * derived-state detection rebuilds the same projections the screens use, and a
 * deal's state is defined against our insurance record — AHEAD, BEHIND,
 * IN_SYNC are statements about the DMS's policy number versus ours. Without
 * these the detector failed on every pass with a permission error, which is a
 * better failure than a wrong event but is still a failure.
 *
 * `for select` only, and stated plainly because it widens what a leak of this
 * credential would reach: the scheduler can read a customer's application, and
 * cannot create, alter or delete one. It still holds nothing about people —
 * no users, no sessions — and nothing anybody decided: not the decision log,
 * not the outbox.
 */
drop policy if exists applications_worker on public.applications;
create policy applications_worker on public.applications
  for select to ddms_worker using (true);

drop policy if exists policies_worker on public.policies;
create policy policies_worker on public.policies
  for select to ddms_worker using (true);

/*
 * And the outbox, because since OBJ-16 the scheduler drafts.
 *
 * This is the second widening of this role and it is the one that changes what
 * it *is*: `ddms_worker` no longer only mirrors, it proposes. A rule running
 * with nobody signed in composes a message about a certificate that has sat in
 * a drawer since March, and writes it here as a draft.
 *
 * What has not changed is what may leave. `authoriseSend()` is the only thing
 * that writes `sent_at`, and it refuses every customer-facing message without a
 * person however it was drafted. The grant below lets the scheduler *ask*; it
 * does not let it answer. No delete, like `ddms_app`: a draft decided against is
 * CANCELLED, because "we chose not to contact this customer" and "nobody ever
 * drafted anything" are different facts.
 *
 * The decision log follows for the same reason — a send, held or otherwise, is
 * recorded, and `user_id` null is what says a rule did it (R-60). Insert only:
 * a record of who decided what is answering a different question if the thing
 * that writes it can also edit it.
 */
drop policy if exists outbound_worker on public.outbound_messages;
create policy outbound_worker on public.outbound_messages
  for all to ddms_worker using (true) with check (true);

drop policy if exists decision_log_worker on public.decision_log;
create policy decision_log_worker on public.decision_log
  for all to ddms_worker using (true) with check (true);

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Policies decide which rows; grants decide which tables and verbs. Both are
-- needed, and neither substitutes for the other — a table with a permissive
-- policy and no grant is still unreadable, which is the direction of failure
-- worth having.

grant usage on schema public to ddms_app;
grant usage on schema app to ddms_app;

grant execute on function app.session_user_id()       to ddms_app;
grant execute on function app.current_owner_id()      to ddms_app;
grant execute on function app.owned_showroom_ids()    to ddms_app;
grant execute on function app.owned_dms_account_ids() to ddms_app;
grant execute on function app.owned_application_ids() to ddms_app;

grant execute on function app.current_role()          to ddms_app;
grant execute on function app.visible_showroom_ids()  to ddms_app;
grant execute on function app.can_read(text)          to ddms_app;
grant execute on function app.is_platform_admin()     to ddms_app;

grant select on
  public.owners,
  public.showrooms,
  public.showroom_dms_accounts,
  public.insurer_panel_entries,
  public.policies,
  public.providers,
  public.ocr_engines
to ddms_app;

grant select, insert on public.decision_log to ddms_app;
grant select, insert on public.record_events to ddms_app;

-- Update but not delete: a draft moves DRAFT → APPROVED → SENT in place, and a
-- message that was decided against is CANCELLED rather than removed.
grant select, insert, update on public.outbound_messages to ddms_app;

grant select, insert, update on
  public.dms_deals,
  public.dms_job_cards,
  public.dms_enquiries,
  public.dms_employees,
  public.dms_registrations,
  public.dms_part_stock,
  public.dms_receivables,
  public.dms_vehicle_stock,
  public.entities,
  public.entity_links,
  public.applications,
  public.submission_logs
to ddms_app;

-- Delete included, and only here: resetting a number to the product's default
-- removes the row rather than writing the default down, so that a later change
-- to our default actually reaches a dealership that never had an opinion.
grant select, insert, update, delete on public.dealer_policy to ddms_app;

-- `serial` columns draw from a sequence, and a role that may insert but may not
-- touch the sequence gets "permission denied for sequence" on every insert.
/*
 * The graph is rebuilt wholesale rather than reconciled — see the note on
 * `entities` — so this is the one pair the request path may delete from.
 * Deliberately granted by name rather than added to the block above, so that
 * "which tables can this role delete from" stays a one-line answer.
 */
grant delete on public.entities, public.entity_links to ddms_app;

-- Reference data: readable by every session, writable only by the platform
-- policies above. The grant is what allows the verb at all; the policy is what
-- decides whose session it works for. Both are needed and neither is enough.
grant insert, update on public.providers, public.ocr_engines to ddms_app;

grant usage, select on all sequences in schema public to ddms_app;

-- ── The login role's grants ─────────────────────────────────────────────────
-- Deliberately the shortest list in this file. This credential is the one that
-- can see a password hash, so every table it does *not* have is a table that a
-- leak of it cannot reach.

grant usage on schema public to ddms_login;

grant select on public.users to ddms_login;
-- Column-level, because `update` on the whole row would let this credential
-- rewrite a password hash or hand somebody a different role. Sign-in stamps
-- when somebody last signed in; that is all it may write.
--
-- `updated_at` is in the list because the schema carries `$onUpdate` on it, so
-- drizzle writes it alongside whatever you asked for. Granting only
-- `last_login_at` made every sign-in fail with *permission denied for table
-- users* — which is the right kind of failure to have, but the wrong answer.
grant update (last_login_at, updated_at) on public.users to ddms_login;

grant select, insert, update, delete on public.sessions to ddms_login;
grant select on public.dms_employees to ddms_login;
grant usage, select on sequence public.sessions_id_seq to ddms_login;

-- ── The worker role's grants ────────────────────────────────────────────────
-- Every tenant's mirror, and nothing else. No users, no sessions, no
-- applications, no decision log, no outbound messages: the scheduler pulls from
-- the dealer's system and writes what it pulled, and has never had a reason to
-- touch anything a person decided.

grant usage on schema public to ddms_worker;

grant select on
  public.owners,
  public.showrooms,
  public.showroom_dms_accounts
to ddms_worker;

grant select, insert, update on
  public.dms_deals,
  public.dms_job_cards,
  public.dms_enquiries,
  public.dms_employees,
  public.dms_registrations,
  public.dms_part_stock,
  public.dms_receivables,
  public.dms_vehicle_stock,
  public.entities,
  public.entity_links
to ddms_worker;

grant select, insert on public.record_events to ddms_worker;

-- Read-only, and only because a deal's derived state is a statement about the
-- insurance record. See the policy above.
grant select on public.applications, public.policies to ddms_worker;

-- The outbox, since OBJ-16. Update but not delete, exactly as `ddms_app` has
-- it. What a draft may *do* is still `authoriseSend()`'s to decide.
grant select, insert, update on public.outbound_messages to ddms_worker;
grant select, insert on public.decision_log to ddms_worker;
grant select on public.dealer_policy to ddms_worker;

-- Same reason as `ddms_app`: the entity graph is rebuilt wholesale rather than
-- reconciled, so these two are the only tables the worker may delete from.
grant delete on public.entities, public.entity_links to ddms_worker;

grant usage, select on all sequences in schema public to ddms_worker;

/*
 * The two tables these roles must never touch.
 *
 * Explicit rather than relying on the default, because the default is what a
 * later `grant ... on all tables in schema public` would quietly overwrite.
 * Everything above rests on `ddms_app` being unable to read a session token,
 * and on the scheduler having no reason to know that people exist.
 *
 * `ddms_login` is the one role deliberately absent from this list — reading
 * those two tables is its entire job, and the grants above are the whole of
 * what it may do anywhere else.
 */
revoke all on public.users    from ddms_app;
revoke all on public.sessions from ddms_app;
revoke all on public.users    from ddms_worker;
revoke all on public.sessions from ddms_worker;

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
create or replace function app.current_owner_id()
  returns integer
  language sql
  stable
  security definer
  set search_path = pg_catalog, public, pg_temp
as $$
  select u.owner_id
    from public.sessions s
    join public.users u on u.id = s.user_id
   where s.token_hash = nullif(current_setting('app.session_token', true), '')
     and s.expires_at > now()
     and u.is_active
   limit 1
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
 * anybody. Applications created by hand, by OCR or by a portal scrape predate
 * the owner tier and have no showroom to attribute them to; making them visible
 * to whoever asked first would be worse than making them visible to nobody.
 * They remain reachable through InsurRouter, which does not run on this role.
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
  using (showroom_id in (select app.owned_showroom_ids()))
  with check (showroom_id in (select app.owned_showroom_ids()));

drop policy if exists dms_job_cards_own on public.dms_job_cards;
create policy dms_job_cards_own on public.dms_job_cards
  for all to ddms_app
  using (showroom_id in (select app.owned_showroom_ids()))
  with check (showroom_id in (select app.owned_showroom_ids()));

drop policy if exists dms_enquiries_own on public.dms_enquiries;
create policy dms_enquiries_own on public.dms_enquiries
  for all to ddms_app
  using (showroom_id in (select app.owned_showroom_ids()))
  with check (showroom_id in (select app.owned_showroom_ids()));

drop policy if exists dms_employees_own on public.dms_employees;
create policy dms_employees_own on public.dms_employees
  for all to ddms_app
  using (showroom_id in (select app.owned_showroom_ids()))
  with check (showroom_id in (select app.owned_showroom_ids()));

drop policy if exists dms_registrations_own on public.dms_registrations;
create policy dms_registrations_own on public.dms_registrations
  for all to ddms_app
  using (showroom_id in (select app.owned_showroom_ids()))
  with check (showroom_id in (select app.owned_showroom_ids()));

/*
 * Parts stock, and the one policy that is read across outlets rather than at
 * one of them. The scope is still the owner's showrooms — `owned_showroom_ids`
 * is the same helper every other policy uses — because "the part is in the
 * other branch" is only a useful answer when the other branch is yours.
 */
drop policy if exists dms_part_stock_own on public.dms_part_stock;
create policy dms_part_stock_own on public.dms_part_stock
  for all to ddms_app
  using (showroom_id in (select app.owned_showroom_ids()))
  with check (showroom_id in (select app.owned_showroom_ids()));

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

drop policy if exists insurer_panel_own on public.insurer_panel_entries;
create policy insurer_panel_own on public.insurer_panel_entries
  for select to ddms_app
  using (dms_account_id in (select app.owned_dms_account_ids()));

-- The application pipeline. `with check` on insert is what stops the action
-- button writing a row into somebody else's tenant: the showroom id it carries
-- must be one this session actually owns, whatever the request body said.
drop policy if exists applications_own on public.applications;
create policy applications_own on public.applications
  for all to ddms_app
  using (showroom_id in (select app.owned_showroom_ids()))
  with check (showroom_id in (select app.owned_showroom_ids()));

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
-- are. Read-only: an operator changing engine priority does it from VeloDocs,
-- which runs on the owner connection.
drop policy if exists providers_readable on public.providers;
create policy providers_readable on public.providers
  for select to ddms_app
  using (true);

drop policy if exists ocr_engines_readable on public.ocr_engines;
create policy ocr_engines_readable on public.ocr_engines
  for select to ddms_app
  using (true);

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Policies decide which rows; grants decide which tables and verbs. Both are
-- needed, and neither substitutes for the other — a table with a permissive
-- policy and no grant is still unreadable, which is the direction of failure
-- worth having.

grant usage on schema public to ddms_app;
grant usage on schema app to ddms_app;

grant execute on function app.current_owner_id()      to ddms_app;
grant execute on function app.owned_showroom_ids()    to ddms_app;
grant execute on function app.owned_dms_account_ids() to ddms_app;
grant execute on function app.owned_application_ids() to ddms_app;

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
  public.entities,
  public.entity_links,
  public.applications,
  public.submission_logs
to ddms_app;

-- `serial` columns draw from a sequence, and a role that may insert but may not
-- touch the sequence gets "permission denied for sequence" on every insert.
/*
 * The graph is rebuilt wholesale rather than reconciled — see the note on
 * `entities` — so this is the one pair the request path may delete from.
 * Deliberately granted by name rather than added to the block above, so that
 * "which tables can this role delete from" stays a one-line answer.
 */
grant delete on public.entities, public.entity_links to ddms_app;

grant usage, select on all sequences in schema public to ddms_app;

/*
 * The two tables this role must never touch.
 *
 * Explicit rather than relying on the default, because the default is what a
 * later `grant ... on all tables in schema public` would quietly overwrite.
 * Everything above rests on `ddms_app` being unable to read a session token.
 */
revoke all on public.users    from ddms_app;
revoke all on public.sessions from ddms_app;

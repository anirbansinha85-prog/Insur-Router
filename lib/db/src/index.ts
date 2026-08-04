/**
 * The database handle.
 *
 * `db` is deliberately not a plain drizzle instance any more — it resolves to
 * the caller's request scope when there is one, and to the pooled owner
 * connection when there is not. `scope.ts` explains why, and `sql/rls.sql`
 * explains what the scope buys.
 */

export {
  db,
  ownerDb,
  loginDb,
  workerDb,
  pool,
  withSessionScope,
  withWorkerScope,
  inSessionScope,
  isAppRoleConfigured,
  requireAppRoleConfigured,
  refuseOwnerCredential,
  type Db,
} from "./scope";

export * from "./schema";
export * from "./password";

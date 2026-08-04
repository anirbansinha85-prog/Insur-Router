import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ownersTable } from "./owners";
import { showroomsTable } from "./showrooms";

/**
 * A person who can log in.
 *
 * Every user belongs to exactly one owner, and that is the whole point: it is
 * where tenant scope comes from. Until now `showroomId` arrived in the request,
 * which meant any caller with the shared service key could read any owner's
 * customers by changing a number in a URL. A session makes the scope something
 * the caller *is* rather than something they *claim*.
 *
 * `passwordHash` is scrypt with a per-user salt, from node:crypto — no
 * dependency, and deliberately not a plain SHA: the cost parameter is the point
 * of a password hash.
 */
export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => ownersTable.id, { onDelete: "cascade" }),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    /** `scrypt$<saltHex>$<hashHex>` — the algorithm travels with the value. */
    passwordHash: text("password_hash").notNull(),
    /**
     * What this person does, and therefore what they may see.
     *
     * `OWNER` and `MANAGER` are DDMS's own. The rest are the dealer's own role
     * names, mirrored in `dms_employees.role` — using their vocabulary rather
     * than inventing a parallel one means a login's role and the role on the
     * work it is assigned are the same string, and cannot drift.
     */
    role: text("role", {
      enum: [
        "OWNER",
        "MANAGER",
        "SALES_EXEC",
        "SERVICE_ADVISOR",
        "RTO_AGENT",
        "ACCOUNTS",
        "TECHNICIAN",
        // Not a dealership role. Whoever runs the platform, and the only role
        // that may write the rows every dealership shares — insurers and OCR
        // engines. It reads no dealership module at all; see `access.ts` and
        // `app.is_platform_admin()`.
        "PLATFORM_ADMIN",
      ],
    })
      .notNull()
      .default("OWNER"),
    /**
     * The dealer's own employee code for this person, when they are one.
     *
     * This is the join that makes *my work* mean anything: the same code is
     * already on the enquiries, registration files and job cards they are
     * responsible for. Null for an owner, who is not an employee of the
     * dealership in the DMS's sense and has no code in the staff master.
     *
     * **A login is never created from this.** The mirror may only ever revoke —
     * see the departure check in `lib/session.ts`. A name appearing in a staff
     * master must not become an account.
     */
    empCode: text("emp_code"),
    /**
     * The outlet this person works at. Null means every outlet the owner holds.
     *
     * A narrowing, never a widening: `app.visible_showroom_ids()` returns this
     * one when set and the owner's whole set when not, and the first is always
     * a subset of the second.
     */
    showroomId: integer("showroom_id").references(() => showroomsTable.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("users_owner_idx").on(t.ownerId)],
).enableRLS();

/**
 * A logged-in session.
 *
 * Server-side rather than a self-contained token, because a session that cannot
 * be revoked is a credential you cannot take back. Logging out, deactivating a
 * user or a suspected leak all become one DELETE.
 *
 * The token itself is never stored — only its SHA-256. Someone who reads this
 * table cannot use what they find, which matters because the thing it protects
 * is customers' KYC.
 */
export const sessionsTable = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
).enableRLS();

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
export type Session = typeof sessionsTable.$inferSelect;

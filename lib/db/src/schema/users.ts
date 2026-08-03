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
     * OWNER sees every showroom the owner holds. MANAGER is scoped further in
     * a later objective; today both see the whole group, and saying so is
     * better than implying a restriction that does not exist.
     */
    role: text("role", { enum: ["OWNER", "MANAGER"] }).notNull().default("OWNER"),
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

/**
 * InsurRouter's landing figures.
 *
 * Behind a session since OBJ-8, and the counts below carry no owner filter of
 * their own on purpose: inside a scope they are already the signed-in owner's,
 * because `applications` is scoped by policy. Before that they were every
 * dealership's, added together, on a screen that said "your applications".
 */

import { Router, type IRouter } from "express";
import { eq, count, sql } from "drizzle-orm";
import { requireModule, requireUser, sessionScope } from "../lib/session";
import {
  db,
  applicationsTable,
  providersTable,
  policiesTable,
} from "@workspace/db";
import {
  GetDashboardStatsResponse,
  GetRecentApplicationsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.use("/dashboard", requireUser, sessionScope, requireModule("DEAL"));

router.get("/dashboard/stats", async (_req, res): Promise<void> => {
  // Total and status counts
  const statusCounts = await db
    .select({
      status: applicationsTable.status,
      count: count(),
    })
    .from(applicationsTable)
    .groupBy(applicationsTable.status);

  const counts: Record<string, number> = {};
  for (const row of statusCounts) {
    counts[row.status] = Number(row.count);
  }

  const totalRow = await db
    .select({ total: count() })
    .from(applicationsTable);
  const total = Number(totalRow[0]?.total ?? 0);

  const policiesRow = await db
    .select({ total: count() })
    .from(policiesTable);
  const policiesIssued = Number(policiesRow[0]?.total ?? 0);

  // Provider breakdown
  const breakdown = await db
    .select({
      providerName: providersTable.name,
      count: count(applicationsTable.id),
      completed: sql<number>`COUNT(CASE WHEN ${applicationsTable.status} = 'completed' THEN 1 END)`,
    })
    .from(applicationsTable)
    .innerJoin(
      providersTable,
      eq(applicationsTable.providerId, providersTable.id),
    )
    .groupBy(providersTable.name)
    .orderBy(sql`count(${applicationsTable.id}) DESC`);

  res.json(
    GetDashboardStatsResponse.parse({
      total,
      draft: counts["draft"] ?? 0,
      submitting: counts["submitting"] ?? 0,
      completed: counts["completed"] ?? 0,
      failed: counts["failed"] ?? 0,
      policiesIssued,
      providerBreakdown: breakdown.map((b) => ({
        providerName: b.providerName,
        count: Number(b.count),
        completed: Number(b.completed),
      })),
    }),
  );
});

router.get("/dashboard/recent", async (_req, res): Promise<void> => {
  const recent = await db
    .select({
      id: applicationsTable.id,
      ownerName: applicationsTable.ownerFullName,
      vehicleMake: applicationsTable.vehicleMake,
      vehicleModel: applicationsTable.vehicleModel,
      providerName: providersTable.name,
      status: applicationsTable.status,
      executionMode: applicationsTable.executionMode,
      createdAt: applicationsTable.createdAt,
    })
    .from(applicationsTable)
    .leftJoin(
      providersTable,
      eq(applicationsTable.providerId, providersTable.id),
    )
    .orderBy(sql`${applicationsTable.createdAt} DESC`)
    .limit(10);

  res.json(
    GetRecentApplicationsResponse.parse(
      recent.map((r) => ({ ...r, providerName: r.providerName ?? null })),
    ),
  );
});

export default router;

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, providersTable } from "@workspace/db";
import {
  CreateProviderBody,
  UpdateProviderBody,
  GetProviderParams,
  UpdateProviderParams,
  DeleteProviderParams,
  ListProvidersResponse,
  GetProviderResponse,
  CreateProviderResponse,
  UpdateProviderResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/providers", async (_req, res): Promise<void> => {
  const providers = await db
    .select()
    .from(providersTable)
    .orderBy(providersTable.name);
  res.json(ListProvidersResponse.parse(providers));
});

router.post("/providers", async (req, res): Promise<void> => {
  const parsed = CreateProviderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [provider] = await db
    .insert(providersTable)
    .values(parsed.data)
    .returning();
  res.status(201).json(CreateProviderResponse.parse(provider));
});

router.get("/providers/:id", async (req, res): Promise<void> => {
  const params = GetProviderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [provider] = await db
    .select()
    .from(providersTable)
    .where(eq(providersTable.id, params.data.id));
  if (!provider) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }
  res.json(GetProviderResponse.parse(provider));
});

router.patch("/providers/:id", async (req, res): Promise<void> => {
  const params = UpdateProviderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateProviderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [provider] = await db
    .update(providersTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(providersTable.id, params.data.id))
    .returning();
  if (!provider) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }
  res.json(UpdateProviderResponse.parse(provider));
});

router.delete("/providers/:id", async (req, res): Promise<void> => {
  const params = DeleteProviderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [provider] = await db
    .delete(providersTable)
    .where(eq(providersTable.id, params.data.id))
    .returning();
  if (!provider) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;

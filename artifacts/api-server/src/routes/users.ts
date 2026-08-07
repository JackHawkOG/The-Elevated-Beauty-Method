import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetMeResponse,
  UpdateMeBody,
  UpdateMeResponse,
} from "@workspace/api-zod";
import { requireAuth, jitProvisionUser } from "../middlewares/requireAuth";

const router = Router();

// GET /users/me
router.get("/users/me", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.clerkId, req.userId!)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(GetMeResponse.parse({ ...user, createdAt: user.createdAt?.toISOString() }));
});

// PATCH /users/me
router.patch("/users/me", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateMeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updateData: Partial<{ displayName: string; bio: string }> = {};
  if (parsed.data.displayName !== undefined) updateData.displayName = parsed.data.displayName;
  if (parsed.data.bio !== undefined) updateData.bio = parsed.data.bio;

  const [updated] = await db.update(usersTable)
    .set(updateData)
    .where(eq(usersTable.clerkId, req.userId!))
    .returning();

  if (!updated) { res.status(404).json({ error: "User not found" }); return; }

  res.json(UpdateMeResponse.parse({ ...updated, createdAt: updated.createdAt?.toISOString() }));
});

export default router;

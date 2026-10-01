import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  GetMeResponse,
  UpdateMeBody,
  UpdateMeResponse,
  GetBeautyMethodResponse,
  SaveBeautyDiagnosticBody,
  SaveBeautyDiagnosticResponse,
} from "@workspace/api-zod";
import { requireAuth, jitProvisionUser } from "../middlewares/requireAuth";
import { buildBeautyMethod } from "../lib/beauty-method";

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
    .set({ ...updateData, profileVersion: sql`gen_random_uuid()::text` })
    .where(and(
      eq(usersTable.clerkId, req.userId!),
      eq(usersTable.profileVersion, parsed.data.profileVersion),
    ))
    .returning();

  if (!updated) {
    const [current] = await db.select().from(usersTable).where(eq(usersTable.clerkId, req.userId!)).limit(1);
    if (!current) { res.status(404).json({ error: "User not found" }); return; }
    res.status(409).json({
      error: "Your profile has changed since you started editing. Review the latest saved details before trying again.",
      currentProfile: GetMeResponse.parse({ ...current, createdAt: current.createdAt.toISOString() }),
    });
    return;
  }

  res.json(UpdateMeResponse.parse({ ...updated, createdAt: updated.createdAt?.toISOString() }));
});

router.get("/users/me/beauty-method", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.clerkId, req.userId!)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const diagnostic = user.skinType && user.undertone && user.featureNeeds?.length && user.lifeStage && user.visibilityGoal
    ? { skinType: user.skinType, undertone: user.undertone, featureNeeds: user.featureNeeds, lifeStage: user.lifeStage, visibilityGoal: user.visibilityGoal }
    : null;
  res.json(GetBeautyMethodResponse.parse(buildBeautyMethod(diagnostic)));
});

router.put("/users/me/beauty-method", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const parsed = SaveBeautyDiagnosticBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [updated] = await db.update(usersTable)
    .set(parsed.data)
    .where(eq(usersTable.clerkId, req.userId!))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(SaveBeautyDiagnosticResponse.parse(buildBeautyMethod(parsed.data)));
});

export default router;

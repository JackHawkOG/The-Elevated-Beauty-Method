import { Router } from "express";
import { db, radiantAuditsTable, radiantAuditHistoryTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { GetRadiantAuditResponse, GetRadiantAuditHistoryResponse, SaveRadiantAuditBody, SaveRadiantAuditResponse } from "@workspace/api-zod";
import { requireAuth, jitProvisionUser } from "../middlewares/requireAuth";

const router = Router();

function response(audit: typeof radiantAuditsTable.$inferSelect) {
  return {
    routineChecks: audit.routineChecks,
    valuesChecks: audit.valuesChecks,
    beautyTrend: audit.beautyTrend,
    masteryGoal: audit.masteryGoal,
    researchTime: audit.researchTime,
    routineScore: audit.routineChecks.length,
    valuesScore: audit.valuesChecks.length,
    completedAt: audit.completedAt.toISOString(),
  };
}

router.get("/users/me/radiant-audit", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const [audit] = await db.select().from(radiantAuditsTable)
    .where(eq(radiantAuditsTable.clerkId, req.userId!)).limit(1);
  res.json(GetRadiantAuditResponse.parse(audit ? response(audit) : null));
});

router.get("/users/me/radiant-audit/history", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const history = await db.select().from(radiantAuditHistoryTable)
    .where(eq(radiantAuditHistoryTable.clerkId, req.userId!))
    .orderBy(desc(radiantAuditHistoryTable.id));
  res.json(GetRadiantAuditHistoryResponse.parse(history.map(entry => ({
    id: entry.id,
    ...response(entry),
  }))));
});

router.put("/users/me/radiant-audit", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const parsed = SaveRadiantAuditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please review the Audit answers and try again." });
    return;
  }
  const { routineChecks, valuesChecks, beautyTrend, masteryGoal, researchTime } = parsed.data;
  if (new Set(routineChecks).size !== routineChecks.length ||
      new Set(valuesChecks).size !== valuesChecks.length ||
      !beautyTrend.trim() || !masteryGoal.trim() || !researchTime.trim()) {
    res.status(400).json({ error: "Please complete the written answers and choose each check only once." });
    return;
  }
  if (!req.dbUserId) {
    res.status(503).json({ error: "Your account is not ready yet. Please try again." });
    return;
  }
  const answers = {
    routineChecks,
    valuesChecks,
    beautyTrend: beautyTrend.trim(),
    masteryGoal: masteryGoal.trim(),
    researchTime: researchTime.trim(),
  };
  // Inserting first serializes simultaneous first saves via the account PK.
  // Lock the current row before archiving it so overlapping retakes cannot lose a snapshot.
  const { saved, inserted } = await db.transaction(async tx => {
    const [first] = await tx.insert(radiantAuditsTable)
      .values({ clerkId: req.userId!, ...answers })
      .onConflictDoNothing({ target: radiantAuditsTable.clerkId })
      .returning();
    if (first) return { saved: first, inserted: true };

    const [previous] = await tx.select().from(radiantAuditsTable)
      .where(eq(radiantAuditsTable.clerkId, req.userId!)).for("update");
    if (!previous) throw new Error("Audit disappeared during retake");
    await tx.insert(radiantAuditHistoryTable).values({
      clerkId: previous.clerkId,
      routineChecks: previous.routineChecks,
      valuesChecks: previous.valuesChecks,
      beautyTrend: previous.beautyTrend,
      masteryGoal: previous.masteryGoal,
      researchTime: previous.researchTime,
      completedAt: previous.completedAt,
    });
    const [updated] = await tx.update(radiantAuditsTable)
      .set({ ...answers, completedAt: new Date() })
      .where(eq(radiantAuditsTable.clerkId, req.userId!))
      .returning();
    return { saved: updated, inserted: false };
  });
  if (!saved) {
    res.status(503).json({ error: "We couldn't save your Audit. Please try again." });
    return;
  }
  res.json(SaveRadiantAuditResponse.parse({
    audit: response(saved),
    completionKind: inserted ? "first_time" : "retake",
  }));
});

export default router;
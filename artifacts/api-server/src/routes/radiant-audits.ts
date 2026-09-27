import { Router } from "express";
import { db, radiantAuditsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetRadiantAuditResponse, SaveRadiantAuditBody, SaveRadiantAuditResponse } from "@workspace/api-zod";
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
  // Let the unique account key decide which save is first, even across concurrent requests.
  const [inserted] = await db.insert(radiantAuditsTable)
    .values({ clerkId: req.userId!, ...answers })
    .onConflictDoNothing({ target: radiantAuditsTable.clerkId })
    .returning();
  const saved = inserted ?? (await db.update(radiantAuditsTable)
    .set({ ...answers, completedAt: new Date() })
    .where(eq(radiantAuditsTable.clerkId, req.userId!))
    .returning())[0];
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
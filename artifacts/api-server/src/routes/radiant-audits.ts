import { Router } from "express";
import { isDeepStrictEqual } from "node:util";
import { db, radiantAuditsTable, radiantAuditHistoryTable, radiantAuditSubmissionsTable, radiantAuditDraftsTable } from "@workspace/db";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { DeleteRadiantAuditHistoryEntryParams, GetRadiantAuditResponse, GetRadiantAuditHistoryResponse, GetRadiantAuditDraftResponse, SaveRadiantAuditDraftBody, SaveRadiantAuditDraftResponse, SaveRadiantAuditBody, SaveRadiantAuditResponse } from "@workspace/api-zod";
import { requireAuth, jitProvisionUser } from "../middlewares/requireAuth";

const router = Router();
const draftLifetimeMs = 24 * 60 * 60 * 1000;
function draftOwnerMatches(req: { userId?: string; get(name: string): string | undefined }): boolean {
  return !!req.userId && req.get("x-audit-draft-owner") === req.userId;
}

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

router.get("/users/me/radiant-audit/draft", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const [draft] = await db.select().from(radiantAuditDraftsTable)
    .where(and(eq(radiantAuditDraftsTable.clerkId, req.userId!), gt(radiantAuditDraftsTable.expiresAt, new Date())));
  res.json(GetRadiantAuditDraftResponse.parse(draft
    ? ("discardedAt" in (draft.answers as object)
      ? draft.answers : { ...(draft.answers as object), updatedAt: draft.updatedAt.toISOString() })
    : null));
});

router.put("/users/me/radiant-audit/draft", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  if (!draftOwnerMatches(req)) {
    res.status(409).json({ error: "The signed-in account changed. Reload your Audit." });
    return;
  }
  const parsed = SaveRadiantAuditDraftBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please review your draft answers." });
    return;
  }
  const saved = await db.transaction(async tx => {
    // Serialize a draft write with submission so a pre-submission editor cannot
    // resurrect answers after another device commits the completed Audit.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.userId!}))`);
    const [current] = await tx.select({ completedAt: radiantAuditsTable.completedAt })
      .from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, req.userId!));
    if (req.get("x-audit-draft-baseline") !== (current?.completedAt.toISOString() ?? "none")) return false;
    await tx.delete(radiantAuditDraftsTable).where(lte(radiantAuditDraftsTable.expiresAt, new Date()));
    const now = new Date();
    await tx.insert(radiantAuditDraftsTable).values({
      clerkId: req.userId!,
      answers: parsed.data,
      expiresAt: new Date(now.getTime() + draftLifetimeMs),
      updatedAt: now,
    }).onConflictDoUpdate({
      target: radiantAuditDraftsTable.clerkId,
      set: { answers: parsed.data, expiresAt: new Date(now.getTime() + draftLifetimeMs), updatedAt: now },
    });
    return true;
  });
  if (!saved) {
    res.status(409).json({ error: "Your Audit was saved on another device. Reload before editing a new draft." });
    return;
  }
  res.json(SaveRadiantAuditDraftResponse.parse(parsed.data));
});

router.delete("/users/me/radiant-audit/draft", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  if (!draftOwnerMatches(req)) {
    res.status(409).json({ error: "The signed-in account changed. Reload your Audit." });
    return;
  }
  // Retain only a short-lived deletion marker, not the written answers.
  // Other browsers use it to reject their older local copies.
  const discardedAt = new Date();
  await db.insert(radiantAuditDraftsTable).values({
    clerkId: req.userId!,
    answers: { discardedAt: discardedAt.toISOString() },
    expiresAt: new Date(discardedAt.getTime() + draftLifetimeMs),
    updatedAt: discardedAt,
  }).onConflictDoUpdate({
    target: radiantAuditDraftsTable.clerkId,
    set: { answers: { discardedAt: discardedAt.toISOString() }, expiresAt: new Date(discardedAt.getTime() + draftLifetimeMs), updatedAt: discardedAt },
  });
  res.sendStatus(204);
});

router.delete("/users/me/radiant-audit", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const deleted = await db.transaction(async tx => {
    const [removed] = await tx.delete(radiantAuditsTable)
      .where(eq(radiantAuditsTable.clerkId, req.userId!))
      .returning({ clerkId: radiantAuditsTable.clerkId });
    if (removed) await tx.delete(radiantAuditSubmissionsTable)
      .where(eq(radiantAuditSubmissionsTable.clerkId, req.userId!));
    return removed;
  });
  if (!deleted) {
    res.status(404).json({ error: "Current Audit not found." });
    return;
  }
  res.sendStatus(204);
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

router.delete("/users/me/radiant-audit/history", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  await db.transaction(async tx => {
    await tx.delete(radiantAuditHistoryTable)
      .where(eq(radiantAuditHistoryTable.clerkId, req.userId!));
    await tx.delete(radiantAuditSubmissionsTable)
      .where(eq(radiantAuditSubmissionsTable.clerkId, req.userId!));
  });
  res.sendStatus(204);
});

router.delete("/users/me/radiant-audit/history/:id", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const rawId = req.params.id;
  const parsed = DeleteRadiantAuditHistoryEntryParams.safeParse(req.params);
  if (typeof rawId !== "string" || !/^[1-9]\d*$/.test(rawId) ||
      !parsed.success || !Number.isSafeInteger(parsed.data.id)) {
    res.status(400).json({ error: "Invalid submission ID." });
    return;
  }
  const deleted = await db.transaction(async tx => {
    const [removed] = await tx.delete(radiantAuditHistoryTable)
      .where(and(
        eq(radiantAuditHistoryTable.id, parsed.data.id),
        eq(radiantAuditHistoryTable.clerkId, req.userId!),
      ))
      .returning({ id: radiantAuditHistoryTable.id });
    if (removed) await tx.delete(radiantAuditSubmissionsTable)
      .where(eq(radiantAuditSubmissionsTable.clerkId, req.userId!));
    return removed;
  });
  if (!deleted) {
    res.status(404).json({ error: "Earlier submission not found." });
    return;
  }
  res.sendStatus(204);
});

router.put("/users/me/radiant-audit", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const parsed = SaveRadiantAuditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please review the Audit answers and try again." });
    return;
  }
  const { submissionId, routineChecks, valuesChecks, beautyTrend, masteryGoal, researchTime } = parsed.data;
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
  const outcome = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.userId!}))`);
    if (submissionId) {
      // The unique key serializes concurrent attempts, including an attempt whose
      // first response was lost after commit.
      const [reserved] = await tx.insert(radiantAuditSubmissionsTable)
        .values({ clerkId: req.userId!, submissionId, answers })
        .onConflictDoNothing()
        .returning({ submissionId: radiantAuditSubmissionsTable.submissionId });
      if (!reserved) {
        const [existing] = await tx.select().from(radiantAuditSubmissionsTable)
          .where(and(
            eq(radiantAuditSubmissionsTable.clerkId, req.userId!),
            eq(radiantAuditSubmissionsTable.submissionId, submissionId),
          ));
        if (!existing?.result) throw new Error("Committed Audit submission has no result");
        if (!isDeepStrictEqual(existing.answers, answers)) return { conflict: true as const };
        await tx.delete(radiantAuditDraftsTable).where(eq(radiantAuditDraftsTable.clerkId, req.userId!));
        return { result: SaveRadiantAuditResponse.parse(existing.result) };
      }
    }
    const [first] = await tx.insert(radiantAuditsTable)
      .values({ clerkId: req.userId!, ...answers })
      .onConflictDoNothing({ target: radiantAuditsTable.clerkId })
      .returning();
    let saved = first;
    if (!first) {
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
      [saved] = await tx.update(radiantAuditsTable)
        .set({ ...answers, completedAt: new Date() })
        .where(eq(radiantAuditsTable.clerkId, req.userId!))
        .returning();
    }
    if (!saved) throw new Error("Audit disappeared during save");
    const result = SaveRadiantAuditResponse.parse({
      audit: response(saved),
      completionKind: first ? "first_time" : "retake",
    });
    if (submissionId) {
      await tx.update(radiantAuditSubmissionsTable).set({ result })
        .where(and(
          eq(radiantAuditSubmissionsTable.clerkId, req.userId!),
          eq(radiantAuditSubmissionsTable.submissionId, submissionId),
        ));
    }
    await tx.delete(radiantAuditDraftsTable).where(eq(radiantAuditDraftsTable.clerkId, req.userId!));
    return { result };
  });
  if ("conflict" in outcome) {
    res.status(409).json({ error: "This submission ID was already used with different answers." });
    return;
  }
  res.json(outcome.result);
});

export default router;
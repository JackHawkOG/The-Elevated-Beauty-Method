import { Router } from "express";
import { clerkClient } from "@clerk/express";
import { pool } from "@workspace/db";
import {
  GetMembershipReviewEmailPreferenceResponse,
  UpdateMembershipReviewEmailPreferenceBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { lockReviewEmail, membershipReviewUrl } from "../lib/membership-review-email";

const router = Router();
router.all("/membership/review-email-preference", requireAuth, async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  if (req.method !== "GET" && req.method !== "PUT") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const user = await clerkClient.users.getUser(req.userId!);
    if (user.publicMetadata.role !== "owner") {
      res.status(403).json({ error: "Owner access required" });
      return;
    }
    const available = Boolean(membershipReviewUrl());
    if (req.method === "GET") {
      const result = await pool.query<{ enabled: boolean }>("SELECT enabled FROM membership_review_email_preferences WHERE clerk_id = $1", [req.userId]);
      res.json(GetMembershipReviewEmailPreferenceResponse.parse({ enabled: result.rows[0]?.enabled ?? false, available }));
      return;
    }
    const body = UpdateMembershipReviewEmailPreferenceBody.strict().safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Choose whether to enable outage emails" });
      return;
    }
    const primary = user.emailAddresses.find(email => email.id === user.primaryEmailAddressId);
    if (body.data.enabled && primary?.verification?.status !== "verified") {
      res.status(400).json({ error: "Verify your primary account email before enabling outage emails" });
      return;
    }
    if (body.data.enabled && !available) {
      res.status(503).json({ error: "The published membership review link is not configured" });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockReviewEmail(client);
      await client.query(`INSERT INTO membership_review_email_preferences (clerk_id, enabled)
        VALUES ($1, $2) ON CONFLICT (clerk_id) DO UPDATE SET enabled = EXCLUDED.enabled`, [req.userId, body.data.enabled]);
      if (!body.data.enabled) {
        await client.query(`UPDATE membership_review_email_deliveries SET status = 'suppressed', recipient = NULL, review_url = NULL
          WHERE clerk_id = $1 AND status = 'pending'`, [req.userId]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    res.json(GetMembershipReviewEmailPreferenceResponse.parse({ enabled: body.data.enabled, available }));
  } catch {
    req.log.warn("Could not verify or save owner outage email preference");
    res.status(503).json({ error: "Owner email preferences are unavailable. Try again later." });
  }
});
export default router;
import { Router, type Request, type Response } from "express";
import { db, pool, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { clerkClient } from "@clerk/express";
import { GetConfirmedMembershipCountsResponse, GetMembershipCheckoutCleanupAlertsResponse, GetMembershipReconciliationAlertsResponse, GetMembershipReviewNotificationsResponse, RetryMembershipCheckoutCleanupParams, RetryMembershipCheckoutCleanupResponse } from "@workspace/api-zod";
import { requireAuth, jitProvisionUser } from "../middlewares/requireAuth";
import { getStripeSync, getUncachableStripeClient } from "../lib/stripeClient";
import { isSubscriptionEnded, reconcileSubscription, scheduledCancellationTimestamp, unresolvedReconciliationAlerts, outstandingReviewNotifications } from "../lib/membership-reconciliation";
import { GetMyMembershipResponse } from "@workspace/api-zod";
import { queueCheckoutExpiration, recoverCheckoutExpiration, overdueCheckoutExpirations, retryQueuedCheckoutExpiration } from "../lib/membership-checkout-expirations";
import { lockMembershipCapacity, hasFoundingCapacity, confirmCheckout, restorePaidCheckout, expireCheckout, checkoutExpiry } from "../lib/membership-reservations";
import { reconcileUntrackedPaidSessions } from "../lib/membership-paid-recovery";
import { pendingMembershipInvoiceHistory } from "../lib/membership-invoice-history";
import { GetPendingMembershipInvoiceHistoryQueryParams, GetPendingMembershipInvoiceHistoryResponse } from "@workspace/api-zod";
import membershipReviewEmailRouter from "./membership-review-email";

const router = Router();
router.use(membershipReviewEmailRouter);
const OPENS = Date.parse("2026-10-01T14:00:00Z"); // 9 AM Central (CDT)
const CLOSES = Date.parse("2026-10-08T05:00:00Z"); // exclusive; Oct 7 at 11:59 PM Central

function phase(now = Date.now()): "upcoming" | "open" | "closed" {
  return now < OPENS ? "upcoming" : now >= CLOSES ? "closed" : "open";
}

async function reconcileStaleReservations(): Promise<void> {
  const pending = await pool.query<{ stripe_session_id: string }>(
    "SELECT stripe_session_id FROM membership_checkouts WHERE status = 'pending' AND created_at < now() - interval '31 minutes' AND stripe_session_id IS NOT NULL",
  );
  if (!pending.rows.length) return;
  const stripe = await getUncachableStripeClient();
  for (const row of pending.rows) {
    const session = await stripe.checkout.sessions.retrieve(row.stripe_session_id);
    if (session.status === "expired") {
      const client = await pool.connect();
      try {
        await expireCheckout(client, session.id);
      } finally {
        client.release();
      }
    } else if (session.status === "complete" && session.payment_status === "paid" && typeof session.subscription === "string") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await confirmCheckout(client, session.id, session.subscription);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }
}

async function availability() {
  await reconcileStaleReservations();
  const client = await pool.connect();
  try {
    return await hasFoundingCapacity(client);
  } finally {
    client.release();
  }
}

router.get("/membership/offer", async (_req, res): Promise<void> => {
  res.json({ phase: phase(), foundingAvailable: await availability(), foundingPrice: 24, standardPrice: 48 });
});

router.get("/membership/me", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  const result = await pool.query<{ kind: string; status: string; stripe_subscription_id: string | null; stripe_session_id: string | null }>(
    "SELECT kind, status, stripe_subscription_id, stripe_session_id FROM membership_checkouts WHERE clerk_id = $1 AND status IN ('pending', 'confirmed', 'forfeited') ORDER BY CASE WHEN status IN ('pending', 'confirmed') THEN 0 ELSE 1 END, id DESC LIMIT 1",
    [req.userId],
  );
  const row = result.rows[0];
  if (!row) {
    res.json(GetMyMembershipResponse.parse({ membership: null }));
    return;
  }
  if (row.status !== "confirmed") {
    res.json(GetMyMembershipResponse.parse({ membership: { kind: row.kind, status: row.status, cancellationDate: null } }));
    return;
  }
  if (!row.stripe_subscription_id) throw new Error("Confirmed membership has no Stripe subscription");
  const stripe = await getUncachableStripeClient();
  const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
  if (isSubscriptionEnded(subscription)) {
    // Keep the access tier and founding-place bookkeeping in step with the displayed status.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await reconcileSubscription(client, row.stripe_subscription_id, stripe);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.json(GetMyMembershipResponse.parse({ membership: { kind: row.kind, status: "forfeited", cancellationDate: null } }));
    return;
  }
  const end = scheduledCancellationTimestamp(subscription);
  res.json(GetMyMembershipResponse.parse({
    membership: { kind: row.kind, status: row.status, cancellationDate: end === null ? null : new Date(end * 1000).toISOString(), checkoutSessionId: row.stripe_session_id ?? null },
  }));
});

router.get("/membership/confirmed-counts", requireAuth, async (req, res): Promise<void> => {
  let role: unknown;
  try {
    role = (await clerkClient.users.getUser(req.userId!)).publicMetadata.role;
  } catch (error) {
    req.log.error({ err: error }, "Could not verify membership counts access");
    res.status(503).json({ error: "Unable to verify owner access" });
    return;
  }
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  const result = await pool.query<{ founding: number; standard: number }>(
    `SELECT
      COUNT(DISTINCT clerk_id) FILTER (WHERE kind = 'founding')::int AS founding,
      COUNT(DISTINCT clerk_id) FILTER (WHERE kind = 'standard')::int AS standard
     FROM membership_checkouts WHERE status = 'confirmed'`,
  );
  res.json(GetConfirmedMembershipCountsResponse.parse(result.rows[0]));
});

router.get("/membership/checkout-cleanup-alerts", requireAuth, async (req, res): Promise<void> => {
  let role: unknown;
  try {
    role = (await clerkClient.users.getUser(req.userId!)).publicMetadata.role;
  } catch (error) {
    req.log.error({ err: error }, "Could not verify checkout cleanup alert access");
    res.status(503).json({ error: "Unable to verify staff access" });
    return;
  }
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "Staff access required" });
    return;
  }
  res.json(GetMembershipCheckoutCleanupAlertsResponse.parse(await overdueCheckoutExpirations()));
});

router.post("/membership/checkout-cleanup-alerts/:sessionId/retry", requireAuth, async (req, res): Promise<void> => {
  const params = RetryMembershipCheckoutCleanupParams.safeParse(req.params);
  if (!params.success || !/^cs_[A-Za-z0-9_]+$/.test(params.data.sessionId)) {
    res.status(400).json({ error: "Invalid checkout session ID" });
    return;
  }
  let role: unknown;
  try {
    role = (await clerkClient.users.getUser(req.userId!)).publicMetadata.role;
  } catch (error) {
    req.log.error({ err: error }, "Could not verify checkout cleanup retry access");
    res.status(503).json({ error: "Unable to verify staff access" });
    return;
  }
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "Staff access required" });
    return;
  }
  try {
    const result = await retryQueuedCheckoutExpiration(params.data.sessionId, getUncachableStripeClient, true);
    if (result === "not_queued") {
      res.status(404).json({ error: "This checkout is no longer queued for overdue cleanup." });
    } else if (result === "busy") {
      res.status(409).json({ error: "Cleanup is already in progress for this checkout. Refresh the alert shortly." });
    } else {
      res.json(RetryMembershipCheckoutCleanupResponse.parse({ resolved: true }));
    }
  } catch (error) {
    req.log.error({ err: error, stripeSessionId: params.data.sessionId }, "Staff checkout cleanup retry failed");
    res.status(503).json({ error: "Cleanup retry failed. The alert remains queued; try again later." });
  }
});

router.get("/membership/reconciliation-alerts", requireAuth, async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  let role: unknown;
  try {
    role = (await clerkClient.users.getUser(req.userId!)).publicMetadata.role;
  } catch (error) {
    req.log.error({ err: error }, "Could not verify billing review alert access");
    res.status(503).json({ error: "Unable to verify staff access" });
    return;
  }
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "Staff access required" });
    return;
  }
  res.json(GetMembershipReconciliationAlertsResponse.parse(await unresolvedReconciliationAlerts()));
});

router.get("/membership/pending-invoice-history", requireAuth, async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  let role: unknown;
  try {
    role = (await clerkClient.users.getUser(req.userId!)).publicMetadata.role;
  } catch (error) {
    req.log.error({ err: error }, "Could not verify invoice history review access");
    res.status(503).json({ error: "Unable to verify staff access" });
    return;
  }
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "Staff access required" });
    return;
  }
  const params = GetPendingMembershipInvoiceHistoryQueryParams.safeParse(req.query);
  if (!params.success || (params.data.after !== undefined && !Number.isSafeInteger(params.data.after))) {
    res.status(400).json({ error: "Invalid page cursor" });
    return;
  }
  try {
    res.json(GetPendingMembershipInvoiceHistoryResponse.parse(await pendingMembershipInvoiceHistory(params.data.after)));
  } catch (error) {
    req.log.error({ err: error }, "Could not read pending membership invoice history");
    res.status(503).json({ error: "Pending invoice history is unavailable. Try again later." });
  }
});

router.get("/membership/review-notifications", requireAuth, async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  let role: unknown;
  try {
    role = (await clerkClient.users.getUser(req.userId!)).publicMetadata.role;
  } catch (error) {
    req.log.error({ err: error }, "Could not verify billing notification access");
    res.status(503).json({ error: "Unable to verify owner access" });
    return;
  }
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  res.json(GetMembershipReviewNotificationsResponse.parse(await outstandingReviewNotifications()));
});

router.post("/membership/checkout", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const kind = req.body?.kind;
  if (kind !== "founding" && kind !== "standard") {
    res.status(400).json({ error: "Choose a valid membership." });
    return;
  }
  if (phase() === "upcoming" || (kind === "founding" && phase() !== "open")) {
    res.status(409).json({ error: "This enrollment option is not open." });
    return;
  }
  const client = await pool.connect();
  let createdSessionId: string | undefined;
  let checkoutStripe: Stripe | undefined;
  try {
    await reconcileStaleReservations();
    await reconcileUntrackedPaidSessions(req.userId);
    await client.query("BEGIN");
    // Serializes checkouts across all server instances, including simultaneous last-place requests.
    await lockMembershipCapacity(client);
    const existing = await client.query<{ kind: string; status: string; stripe_session_id: string | null }>(
      "SELECT kind, status, stripe_session_id FROM membership_checkouts WHERE clerk_id = $1 AND status IN ('pending', 'confirmed') LIMIT 1",
      [req.userId],
    );
    if (existing.rowCount) {
      if (existing.rows[0].kind !== kind) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "You have a different membership checkout in progress. Finish it or wait for it to expire before changing plans." });
        return;
      }
      if (existing.rows[0].status === "pending" && existing.rows[0].stripe_session_id) {
        const session = await (await getUncachableStripeClient()).checkout.sessions.retrieve(existing.rows[0].stripe_session_id);
        if (session.status === "open" && session.url) {
          await client.query("ROLLBACK");
          res.json({ url: session.url });
          return;
        }
      }
      await client.query("ROLLBACK");
      res.status(409).json({ error: "You already have a membership or a checkout in progress." });
      return;
    }
    if (kind === "founding" && !(await hasFoundingCapacity(client))) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "All 50 Founding Member places are claimed or reserved." });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.clerkId, req.userId!)).limit(1);
    if (!user) throw new Error("Account not found");
    const stripe = await getUncachableStripeClient();
    checkoutStripe = stripe;
    const key = kind === "founding" ? "founding_2026" : "standard_2026";
    const prices = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 10 });
    const expected = kind === "founding" ? 2400 : 4800;
    const price = prices.data.find(p => p.unit_amount === expected && p.currency === "usd" && p.recurring?.interval === "month");
    if (!price) throw new Error(`Stripe ${kind} monthly price is not configured`);
    const customer = await stripe.customers.create({ email: user.email, metadata: { clerkId: user.clerkId } });
    const reservation = await client.query<{ id: string }>(
      "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_customer_id) VALUES ($1, $2, 'pending', $3) RETURNING id",
      [user.clerkId, kind, customer.id],
    );
    const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
    if (!domain) throw new Error("Checkout return domain is not configured");
    const base = `https://${domain}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      payment_method_types: ["card"],
      line_items: [{ price: price.id, quantity: 1 }],
      expires_at: checkoutExpiry(),
      client_reference_id: user.clerkId,
      metadata: { reservationId: reservation.rows[0].id, membershipCheckout: "true" },
      subscription_data: { metadata: { reservationId: reservation.rows[0].id } },
      // A fragment keeps the private correlation out of HTTP requests/referrers.
      // The client removes it before sending the confirmed-return event.
      success_url: `${base}/membership?checkout=success#checkout_session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/membership?checkout=cancel`,
    }, { idempotencyKey: `membership-${reservation.rows[0].id}` });
    createdSessionId = session.id;
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    await client.query("UPDATE membership_checkouts SET stripe_session_id = $1 WHERE id = $2", [session.id, reservation.rows[0].id]);
    await client.query("COMMIT");
    res.json({ url: session.url });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      req.log.error({ err: rollbackError }, "Could not roll back membership checkout");
    }
    if (createdSessionId && checkoutStripe) {
      try {
        await queueCheckoutExpiration(createdSessionId);
      } catch (queueError) {
        req.log.error({ err: queueError, stripeSessionId: createdSessionId }, "Could not queue checkout expiration");
      }
      try {
        await recoverCheckoutExpiration(createdSessionId, checkoutStripe);
      } catch (expirationError) {
        req.log.error({ err: expirationError, stripeSessionId: createdSessionId }, "Could not expire checkout after reservation failure");
      }
    }
    req.log.error({ err: error }, "Could not create membership checkout");
    res.status(503).json({ error: "Checkout is unavailable right now. Please try again." });
  } finally {
    client.release();
  }
});

router.post("/membership/portal", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const row = await pool.query<{ stripe_customer_id: string }>(
    "SELECT stripe_customer_id FROM membership_checkouts WHERE clerk_id = $1 AND status = 'confirmed' ORDER BY id DESC LIMIT 1",
    [req.userId],
  );
  if (!row.rows[0]?.stripe_customer_id) {
    res.status(404).json({ error: "No active membership found." });
    return;
  }
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
  if (!domain) throw new Error("Portal return domain is not configured");
  const stripe = await getUncachableStripeClient();
  const configurations = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  let configuration = configurations.data.find(c =>
    c.features.subscription_cancel?.enabled && c.features.subscription_cancel.mode === "at_period_end"
    && c.features.payment_method_update?.enabled && !c.features.subscription_update?.enabled,
  );
  if (!configuration) configuration = await stripe.billingPortal.configurations.create({
    business_profile: { headline: "Manage your Elevated Method membership" },
    features: {
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      payment_method_update: { enabled: true },
      subscription_update: { enabled: false },
    },
  });
  const session = await stripe.billingPortal.sessions.create({
    customer: row.rows[0].stripe_customer_id,
    return_url: `https://${domain}/membership`,
    configuration: configuration.id,
  });
  res.json({ url: session.url });
});

export async function handleMembershipWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers["stripe-signature"];
  if (!signature || Array.isArray(signature) || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Invalid webhook request" });
    return;
  }
  try {
    // Sync verifies Stripe's signature before we inspect or act on the event.
    await (await getStripeSync()).processWebhook(req.body, signature);
    const event = JSON.parse(req.body.toString()) as Stripe.Event;
    const object = event.data.object;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const firstDelivery = await client.query(
        "INSERT INTO membership_webhook_events (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id",
        [event.id],
      );
      if (!firstDelivery.rowCount) {
        await client.query("COMMIT");
        res.json({ received: true });
        return;
      }
      if (event.type === "checkout.session.completed" && object.object === "checkout.session") {
        const session = object as Stripe.Checkout.Session;
        if (session.payment_status === "paid" && session.subscription && typeof session.subscription === "string") {
          if (!(await confirmCheckout(client, session.id, session.subscription))) {
            await restorePaidCheckout(client, await getUncachableStripeClient(), session.id);
          }
        }
      } else if (event.type === "checkout.session.expired" && object.object === "checkout.session") {
        await expireCheckout(client, object.id);
      } else if (event.type.startsWith("customer.subscription.") && object.object === "subscription") {
        await reconcileSubscription(client, object.id, await getUncachableStripeClient());
      } else if ((event.type === "invoice.payment_failed" || event.type === "invoice.payment_succeeded") && object.object === "invoice") {
        const invoice = object as Stripe.Invoice;
        const subscription = invoice.parent?.subscription_details?.subscription;
        const id = typeof subscription === "string" ? subscription : subscription?.id;
        if (id) await reconcileSubscription(client, id, await getUncachableStripeClient());
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.json({ received: true });
  } catch (error) {
    req.log.error({ err: error }, "Stripe webhook failed");
    res.status(400).json({ error: "Webhook processing failed" });
  }
}

export default router;

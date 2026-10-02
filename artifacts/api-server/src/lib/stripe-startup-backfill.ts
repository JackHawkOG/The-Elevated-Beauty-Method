import type Stripe from "stripe";
import type { StripeSync } from "stripe-replit-sync";

type StartupSync = Pick<StripeSync, "syncBackfill" | "getAccountId" | "upsertCustomers">;

function missingCustomer(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return;
  const candidate = error as { type?: unknown; code?: unknown; param?: unknown; message?: unknown; statusCode?: unknown };
  if (candidate.type !== "StripeInvalidRequestError" || candidate.code !== "resource_missing" ||
      candidate.param !== "customer" || candidate.statusCode !== 400 || typeof candidate.message !== "string") return;
  return /^No such customer: '(cus_[A-Za-z0-9]+)'$/.exec(candidate.message)?.[1];
}

// The sync library lists payment methods for cached, non-deleted customers.
// If a deletion webhook was missed, refresh the verified Stripe tombstone via
// the library's own upsert API, then retry the full backfill (never skip it).
export async function syncStripeStartupBackfill(
  sync: StartupSync,
  retrieveCustomer: (id: string) => Promise<Stripe.Customer | Stripe.DeletedCustomer>,
  reportRepair: (customerId: string) => void,
) {
  const repaired = new Set<string>();
  for (;;) {
    try {
      return await sync.syncBackfill({ object: "all" });
    } catch (error) {
      const id = missingCustomer(error);
      // Keep authentication, outages, other missing resources and repeated
      // failures fatal. Bound retries even if the cache contains many stale IDs.
      if (!id || repaired.has(id) || repaired.size >= 10) throw error;
      const customer = await retrieveCustomer(id);
      if (customer.id !== id || !customer.deleted || customer.object !== "customer") throw error;
      const accountId = await sync.getAccountId();
      await sync.upsertCustomers([customer], accountId);
      repaired.add(id);
      reportRepair(id);
    }
  }
}
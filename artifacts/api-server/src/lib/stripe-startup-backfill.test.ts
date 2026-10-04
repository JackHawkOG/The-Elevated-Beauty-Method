import { expect, test, vi } from "vitest";
import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";
import { syncStripeStartupBackfill } from "./stripe-startup-backfill";

const missing = (id = "cus_deleted") => Object.assign(new Error(`No such customer: '${id}'`), {
  type: "StripeInvalidRequestError", code: "resource_missing", param: "customer", statusCode: 400,
});
const deleted = (id = "cus_deleted") => ({ id, object: "customer" as const, deleted: true as const });
function fixtures() {
  const sync = {
    syncBackfill: vi.fn().mockResolvedValue({}),
    getAccountId: vi.fn().mockResolvedValue("acct_current"),
    upsertCustomers: vi.fn().mockResolvedValue([]),
  };
  const retrieve = vi.fn().mockResolvedValue(deleted());
  const report = vi.fn();
  return { sync, retrieve, report };
}

test("normal backfill does not retrieve or change cached customers", async () => {
  const { sync, retrieve, report } = fixtures();
  await syncStripeStartupBackfill(sync, retrieve, report);
  expect(sync.syncBackfill).toHaveBeenCalledExactlyOnceWith({ object: "all" });
  expect(retrieve).not.toHaveBeenCalled();
  expect(sync.upsertCustomers).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

test("verified deletion uses library upsert and completes full backfill before returning", async () => {
  const { sync, retrieve, report } = fixtures();
  sync.syncBackfill.mockRejectedValueOnce(missing());
  await syncStripeStartupBackfill(sync, retrieve, report);
  expect(retrieve).toHaveBeenCalledExactlyOnceWith("cus_deleted");
  expect(sync.upsertCustomers).toHaveBeenCalledExactlyOnceWith([deleted()], "acct_current");
  expect(sync.syncBackfill).toHaveBeenCalledTimes(2);
  expect(sync.upsertCustomers.mock.invocationCallOrder[0]).toBeLessThan(sync.syncBackfill.mock.invocationCallOrder[1]);
  expect(report).toHaveBeenCalledExactlyOnceWith("cus_deleted");
});

test("two verified stale customers are repaired before full backfill succeeds", async () => {
  const { sync, retrieve, report } = fixtures();
  sync.syncBackfill
    .mockRejectedValueOnce(missing("cus_first"))
    .mockRejectedValueOnce(missing("cus_second"));
  retrieve.mockImplementation(async (id: string) => deleted(id));
  await syncStripeStartupBackfill(sync, retrieve, report);
  expect(sync.syncBackfill).toHaveBeenCalledTimes(3);
  for (const call of sync.syncBackfill.mock.calls) expect(call).toEqual([{ object: "all" }]);
  expect(sync.upsertCustomers.mock.calls).toEqual([
    [[deleted("cus_first")], "acct_current"],
    [[deleted("cus_second")], "acct_current"],
  ]);
  expect(report.mock.calls).toEqual([["cus_first"], ["cus_second"]]);
});

test("account lookup failure cannot write a verified deletion into an unknown account", async () => {
  const { sync, retrieve, report } = fixtures();
  sync.syncBackfill.mockRejectedValueOnce(missing());
  const outage = new Error("Stripe account lookup unavailable");
  sync.getAccountId.mockRejectedValueOnce(outage);
  await expect(syncStripeStartupBackfill(sync, retrieve, report)).rejects.toBe(outage);
  expect(sync.upsertCustomers).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  expect(sync.syncBackfill).toHaveBeenCalledOnce();
});

test("a real Stripe outage after a successful cache repair still blocks startup", async () => {
  const { sync, retrieve, report } = fixtures();
  const outage = Object.assign(new Error("Stripe unavailable"), { statusCode: 503 });
  sync.syncBackfill.mockRejectedValueOnce(missing()).mockRejectedValueOnce(outage);
  await expect(syncStripeStartupBackfill(sync, retrieve, report)).rejects.toBe(outage);
  expect(sync.upsertCustomers).toHaveBeenCalledOnce();
  expect(sync.syncBackfill).toHaveBeenCalledTimes(2);
});

test.each([
  new Error("connection unavailable"),
  Object.assign(missing(), { code: "api_key_expired" }),
  Object.assign(missing(), { param: "price" }),
  Object.assign(missing(), { statusCode: 503 }),
  Object.assign(missing(), { message: "No such customer: 'unknown'" }),
])("unrelated backfill errors stay fatal without customer changes: %s", async error => {
  const { sync, retrieve, report } = fixtures();
  sync.syncBackfill.mockRejectedValueOnce(error);
  await expect(syncStripeStartupBackfill(sync, retrieve, report)).rejects.toBe(error);
  expect(retrieve).not.toHaveBeenCalled();
  expect(sync.upsertCustomers).not.toHaveBeenCalled();
});

test.each([
  { id: "cus_deleted", object: "customer", deleted: false },
  { id: "cus_deleted", object: "customer", deleted: "true" },
  { id: "cus_deleted", object: "invoice", deleted: true },
  deleted("cus_different"),
])("existing or mismatched customer cannot be marked deleted: %j", async customer => {
  const { sync, retrieve, report } = fixtures();
  const error = missing();
  sync.syncBackfill.mockRejectedValueOnce(error);
  retrieve.mockResolvedValueOnce(customer);
  await expect(syncStripeStartupBackfill(sync, retrieve, report)).rejects.toBe(error);
  expect(sync.upsertCustomers).not.toHaveBeenCalled();
});

test("failed deletion verification or cache repair is not swallowed", async () => {
  for (const stage of ["retrieve", "upsert"] as const) {
    const { sync, retrieve, report } = fixtures();
    sync.syncBackfill.mockRejectedValueOnce(missing());
    const error = new Error(`${stage} unavailable`);
    if (stage === "retrieve") retrieve.mockRejectedValueOnce(error);
    else sync.upsertCustomers.mockRejectedValueOnce(error);
    await expect(syncStripeStartupBackfill(sync, retrieve, report)).rejects.toBe(error);
    expect(sync.syncBackfill).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  }
});

test("the same missing customer cannot trigger an infinite retry", async () => {
  const { sync, retrieve, report } = fixtures();
  const error = missing();
  sync.syncBackfill.mockRejectedValue(error);
  await expect(syncStripeStartupBackfill(sync, retrieve, report)).rejects.toBe(error);
  expect(sync.syncBackfill).toHaveBeenCalledTimes(2);
  expect(sync.upsertCustomers).toHaveBeenCalledOnce();
});

test("multiple stale customers are repaired individually with a bounded retry budget", async () => {
  const { sync, retrieve, report } = fixtures();
  let count = 0;
  sync.syncBackfill.mockImplementation(async () => { throw missing(`cus_deleted${count++}`); });
  retrieve.mockImplementation(async (id: string) => deleted(id));
  await expect(syncStripeStartupBackfill(sync, retrieve, report)).rejects.toThrow("cus_deleted10");
  expect(sync.syncBackfill).toHaveBeenCalledTimes(11);
  expect(retrieve).toHaveBeenCalledTimes(10);
  expect(sync.upsertCustomers).toHaveBeenCalledTimes(10);
});

test("real library payment-method sweep skips a verified tombstone and resumes later resources", async () => {
  // Keep all I/O isolated. Exercise the installed library's orchestration,
  // payment-method sweep and customer upsert rather than mocking their result.
  const sync = new StripeSync({
    stripeSecretKey: "sk_test_placeholder",
    stripeWebhookSecret: "",
    poolConfig: {},
  });
  const customer = { id: "cus_stale", object: "customer", livemode: false, deleted: false };
  let cachedCustomer: { id: string; deleted?: boolean } = customer;
  const history = [{ id: "in_history", customer: customer.id, paid: true }];
  const originalHistory = structuredClone(history);
  const query = vi.spyOn(sync.postgresClient.pool, "query").mockImplementation(
    (async (text: string, values?: unknown[]) => {
      if (text.includes('select id from "stripe"."customers"')) {
        expect(text).toContain("COALESCE(deleted, false) <> true");
        return { rows: cachedCustomer.deleted ? [] : [{ id: cachedCustomer.id }] };
      }
      if (text.includes('INSERT INTO "stripe"."customers"')) {
        expect(values?.[2]).toBe("acct_current");
        cachedCustomer = JSON.parse(String(values?.[0]));
        return { rows: [cachedCustomer] };
      }
      throw new Error(`Unexpected database operation: ${text}`);
    }) as typeof sync.postgresClient.pool.query,
  );
  vi.spyOn(sync, "getAccountId").mockResolvedValue("acct_current");
  vi.spyOn(sync, "getCurrentAccount").mockResolvedValue(null);
  const otherStages = [
    "syncProducts", "syncPrices", "syncPlans", "syncCustomers",
    "syncSubscriptions", "syncSubscriptionSchedules", "syncInvoices",
    "syncCharges", "syncSetupIntents", "syncPaymentIntents", "syncTaxIds",
    "syncCreditNotes", "syncDisputes", "syncEarlyFraudWarnings",
    "syncRefunds", "syncCheckoutSessions",
  ] as const;
  for (const stage of otherStages) vi.spyOn(sync, stage).mockResolvedValue({ synced: 0 });
  const error = new Stripe.errors.StripeInvalidRequestError({
    message: `No such customer: '${customer.id}'`,
    code: "resource_missing", param: "customer", statusCode: 400,
  });
  const list = vi.spyOn(sync.stripe.paymentMethods, "list").mockImplementation(
    (() => ({
      async *[Symbol.asyncIterator]() { throw error; },
    })) as unknown as typeof sync.stripe.paymentMethods.list,
  );
  const retrieve = vi.fn().mockResolvedValue(deleted(customer.id));
  const report = vi.fn();
  const backfill = vi.spyOn(sync, "syncBackfill");
  const upsert = vi.spyOn(sync, "upsertCustomers");
  try {
    await syncStripeStartupBackfill(sync, retrieve, report);
    expect(backfill).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledExactlyOnceWith({ limit: 100, customer: customer.id });
    expect(retrieve).toHaveBeenCalledExactlyOnceWith(customer.id);
    expect(upsert).toHaveBeenCalledExactlyOnceWith([deleted(customer.id)], "acct_current");
    expect(sync.syncInvoices).toHaveBeenCalledTimes(2);
    expect(sync.syncPaymentIntents).toHaveBeenCalledOnce();
    expect(sync.syncCheckoutSessions).toHaveBeenCalledOnce();
    expect(cachedCustomer).toEqual(deleted(customer.id));
    expect(history).toEqual(originalHistory);
    expect(query).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledExactlyOnceWith(customer.id);
  } finally {
    vi.restoreAllMocks();
    await sync.postgresClient.pool.end();
  }
});
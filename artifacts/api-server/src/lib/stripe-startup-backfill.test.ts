import { expect, test, vi } from "vitest";
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
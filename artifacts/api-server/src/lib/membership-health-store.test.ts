import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(), download: vi.fn(), save: vi.fn(), file: vi.fn(), bucket: vi.fn(),
}));
vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket = mocks.bucket;
  },
}));
import { independentSweepHealthStore } from "./membership-health-store";

const failure = { consecutiveFailures: 3, firstFailedAt: "2026-10-01T14:00:00Z", lastFailedAt: "2026-10-01T14:30:00Z" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PRIVATE_OBJECT_DIR", "/test-bucket/private");
  vi.stubEnv("NODE_ENV", "production");
  const bucket = { file: mocks.file };
  mocks.bucket.mockReturnValue(bucket);
  mocks.file.mockImplementation((name: string) => ({
    name, bucket, getMetadata: mocks.metadata, download: mocks.download, save: mocks.save,
  }));
  mocks.metadata.mockResolvedValue([{ generation: "42" }]);
  mocks.download.mockResolvedValue([Buffer.from(JSON.stringify(failure))]);
  mocks.save.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

test("private production record is read at a pinned generation and updated conditionally", async () => {
  expect(await independentSweepHealthStore.read()).toEqual(failure);
  expect(mocks.file).toHaveBeenCalledWith("private/operational-health/production/membership-sweep.json", { generation: "42" });
  await independentSweepHealthStore.update(() => null);
  expect(mocks.save).toHaveBeenCalledWith("null", {
    resumable: false, preconditionOpts: { ifGenerationMatch: "42" },
    metadata: { contentType: "application/json", cacheControl: "no-store" },
  });
});

test("development has a different record and creates a missing blob only if still absent", async () => {
  vi.stubEnv("NODE_ENV", "development");
  mocks.metadata.mockRejectedValue(Object.assign(new Error("missing"), { code: 404 }));
  expect(await independentSweepHealthStore.update(() => failure)).toEqual(failure);
  expect(mocks.file).toHaveBeenCalledWith("private/operational-health/development/membership-sweep.json");
  expect(mocks.save).toHaveBeenCalledWith(JSON.stringify(failure), expect.objectContaining({
    preconditionOpts: { ifGenerationMatch: 0 },
  }));
});

test("generation conflicts reread state; missing old generations never imply recovery", async () => {
  mocks.download.mockRejectedValueOnce(Object.assign(new Error("old generation removed"), { code: 404 }));
  mocks.save.mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: 412 }));
  await independentSweepHealthStore.update(() => null);
  expect(mocks.metadata).toHaveBeenCalledTimes(3);
  expect(mocks.save).toHaveBeenCalledTimes(2);
});

test("storage outage, invalid configuration and malformed bytes are explicit failures", async () => {
  mocks.metadata.mockRejectedValueOnce(new Error("storage offline"));
  await expect(independentSweepHealthStore.read()).rejects.toThrow("storage offline");
  mocks.download.mockResolvedValueOnce([Buffer.from('{"customer":"not permitted"}')]);
  await expect(independentSweepHealthStore.read()).rejects.toThrow("Invalid sweep health record");
  vi.stubEnv("PRIVATE_OBJECT_DIR", "");
  await expect(independentSweepHealthStore.read()).rejects.toThrow("not configured");
});
import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@clerk/express", () => ({ clerkClient: { users: { getUser: mocks.getUser } } }));
import { createReviewEmailSender, membershipReviewUrl, ownerRecipient } from "./membership-review-email";
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

test("the email is generic and the only link is the protected review page", async () => {
  const proxy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  const send = createReviewEmailSender(proxy);
  expect(await send("owner@example.invalid", "https://example.invalid/membership", "membership-review/fixed")).toBe("accepted");
  const payload = proxy.mock.calls[0]![2]!;
  expect(proxy).toHaveBeenCalledWith("resend", "/emails", expect.anything());
  expect(payload.headers["Idempotency-Key"]).toBe("membership-review/fixed");
  expect(payload.body.to).toEqual(["owner@example.invalid"]);
  expect(payload.body.text).toContain("not evidence of a member payment problem");
  expect(payload.body.text).toContain("https://example.invalid/membership");
  expect(JSON.stringify(payload.body)).not.toMatch(/sub_|cus_|in_|clerk|invoice|amount|failed_months/i);
  expect(Object.keys(payload.body).sort()).toEqual(["from", "subject", "text", "to"]);
});
test.each([400, 429, 500, 503])("provider %s responses are retryable with the durable key", async status => {
  const send = createReviewEmailSender(vi.fn().mockResolvedValue(new Response("private provider details", { status })));
  expect(await send("owner@example.invalid", "https://example.invalid/membership", "fixed")).toBe("failed");
});
test("network errors and a timeout report ambiguity without throwing provider details", async () => {
  expect(await createReviewEmailSender(vi.fn().mockRejectedValue(new Error("private")))("owner@example.invalid", "https://example.invalid/membership", "fixed")).toBe("failed");
  vi.useFakeTimers();
  const result = createReviewEmailSender(vi.fn(() => new Promise<Response>(() => {})))("owner@example.invalid", "https://example.invalid/membership", "fixed");
  await vi.advanceTimersByTimeAsync(20000);
  expect(await result).toBe("failed");
});
test("delivery checks current owner role and primary email verification", async () => {
  for (const [role, verified, expected] of [["member", "verified", null], ["admin", "verified", null], ["owner", "unverified", null], ["owner", "verified", { email: "owner@example.invalid" }]] as const) {
    mocks.getUser.mockResolvedValue({ publicMetadata: { role }, primaryEmailAddressId: "primary", emailAddresses: [{ id: "primary", emailAddress: "owner@example.invalid", verification: { status: verified } }] });
    expect(await ownerRecipient("fixture")).toEqual(expected);
  }
  mocks.getUser.mockRejectedValue(new Error("Clerk unavailable"));
  await expect(ownerRecipient("fixture")).rejects.toThrow();
});
test("review links use the configured published HTTPS origin and no credentials or query parameters", () => {
  vi.stubEnv("BILLING_REVIEW_APP_URL", "https://example.invalid");
  expect(membershipReviewUrl()).toBe("https://example.invalid/membership");
  for (const invalid of ["", "http://example.invalid", "https://user:password@example.invalid", "https://example.invalid?token=private"]) {
    vi.stubEnv("BILLING_REVIEW_APP_URL", invalid);
    expect(membershipReviewUrl()).toBeNull();
  }
});